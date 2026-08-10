//! Deck categories, tags and folders: everything schema v7 (Plan 8, Task 1) carved out of a
//! deck's fixed five-word zone and its bare gallery listing.
//!
//! Shaped like [`crate::deck`] and [`crate::collection`]: pure functions over a `Connection`,
//! testable without a Tauri app, wrapped in `async` commands that run on the blocking pool.
//! Writes take `AppState.db` and answer [`crate::collection::BUSY`] rather than waiting.
//!
//! Three tables, three different relationships to "the deck":
//!
//! * **Categories** and **tags** are *of* one deck (`deck_id NOT NULL`) — a category names a
//!   pile within a deck, a tag is a per-deck label a deck card can carry. Every write to
//!   either goes through [`crate::deck::touch_deck`], so the gallery's "recently edited"
//!   order moves the same way a card add or a rename does.
//! * **Folders** are not of any deck at all — they file decks the way a filesystem directory
//!   files files, and `decks.folder_id` is `ON DELETE SET NULL` rather than the CASCADE every
//!   category and tag write takes. A folder write therefore touches no deck's `updated_at`
//!   and records nothing in `deck_audit` (which is `deck_id NOT NULL` — a folder edit has no
//!   deck to name).
//!
//! **This module does not call [`crate::deck::allocate_deck`].** Moving a card's category can
//! change whether it counts toward anything (an `is_active` flag decides that now, the way a
//! fixed zone word used to), which the allocator would need to know about — but the allocator
//! is still reading `deck_cards.zone`, a column schema v7 removed, and re-pointing it onto
//! categories is Task 3's job. Wiring these writes to reallocate is Task 3's to add once that
//! landing exists to call into; until then a card that changes which category it is filed
//! under does not change what any deck has reserved.

use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;

/// What an *adjustment* to a category says when the id it names is not there — the same
/// asymmetry [`crate::collection::GONE`] draws against a delete that finds nothing.
pub const CATEGORY_GONE: &str = "That category is not there any more.";

/// What [`create_category`] and [`rename_category`] say when the name they were asked to
/// take is already spoken for. [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) —
/// `deck_id, name` — is the unique index behind this: a caller that skipped this check would
/// hit a raw "UNIQUE constraint failed" instead.
pub const CATEGORY_NAME_TAKEN: &str = "This deck already has a category with that name.";

/// What [`delete_category`] says when `moveToCategoryId` names a category of a *different*
/// deck. Nothing in the DDL stops that INSERT — `deck_cards.category_id` only requires the
/// category to exist, not that it belongs to the same deck as the row being moved — so this
/// is the fence, not a CHECK.
const CATEGORY_WRONG_DECK: &str = "That category belongs to a different deck.";

/// What [`delete_category`] says when asked to move a category's cards into itself. Nothing
/// downstream would fail loudly: the fold's `INSERT … SELECT … WHERE category_id = ?1` would
/// select the very rows about to be re-inserted at the same id, and the delete that follows
/// (`DELETE FROM deck_cards WHERE category_id = ?1`) would then remove the rows the fold just
/// wrote. Refused before either statement runs, in words rather than as a quiet no-op that
/// happens to end with an empty category.
const CATEGORY_SELF_MOVE: &str = "A category cannot be moved into itself.";

/// What [`rename_category`] and [`delete_category`] say when asked to touch a category whose
/// `kind` is not `'main'` — built from the category's own current `name` rather than a fixed
/// string, because [`rename_category`] refusing to change that very name is what guarantees it
/// still reads "Commander" (or "Sideboard", "Companion", "Maybeboard") whichever of the four
/// asked. `is_active` carries no such guard: see its own doc on [`DeckCategoryRow`].
fn predefined_refusal(name: &str) -> String {
    format!("{name} is required by this deck's rules — it can be emptied but not removed.")
}

/// What an *adjustment* to a tag says when the id it names is not there.
pub const TAG_GONE: &str = "That tag is not there any more.";

/// [`CATEGORY_NAME_TAKEN`]'s twin for [`DECK_TAG_GRAIN`](crate::schema::DECK_TAG_GRAIN).
pub const TAG_NAME_TAKEN: &str = "This deck already has a tag with that name.";

/// [`CATEGORY_WRONG_DECK`]'s twin: what [`set_card_tag`] says when the `tagId` it was handed
/// belongs to a deck other than the card's own. A tag is per-deck by
/// [`DECK_TAG_GRAIN`](crate::schema::DECK_TAG_GRAIN); nothing in `deck_cards.tag_id`'s FK
/// stops a caller from naming one that resolves but belongs elsewhere.
const TAG_WRONG_DECK: &str = "That tag belongs to a different deck.";

/// What [`set_card_tag`] says when the `(deckId, cardId, categoryId, variant)` it was handed
/// does not resolve to a row — [`crate::deck::card_gone`]'s reason, generalised: a category
/// replaced the fixed zone word, but a stale editor pointing at a row that moved or was
/// stepped to zero is exactly as possible as it always was.
pub const CARD_NOT_IN_CATEGORY: &str = "That card is not in this deck's category any more.";

/// What an *adjustment* to a folder says when the id it names is not there.
pub const FOLDER_GONE: &str = "That folder is not there any more.";

/// What [`move_folder`] says when the proposed parent is the folder itself or one of its own
/// descendants. `deck_folders.parent_id` is `ON DELETE CASCADE` on itself — a cycle here is
/// not merely a confusing tree, it is a graph SQLite's recursive CASCADE would walk forever
/// the day the folder (or an ancestor of it) is deleted.
pub const FOLDER_CYCLE: &str = "A folder cannot be moved inside itself.";

/// The variant a category or tag write reads its own row back with, when the command that
/// changed it carries no variant of its own to ask by (`create`, `rename`, `setActive`,
/// `reorder`, every tag write). `schema::DECK_VARIANTS[0]` spelled out rather than indexed,
/// because a rename is a fact about the category itself and not about one variant's card
/// list — "live" is simply the one the editor opens on by default.
const READBACK_VARIANT: &str = "live";

/// One category of one deck, with the two numbers that are read at the same moment a category
/// panel would want them rather than in a second round trip.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCategoryRow {
    pub id: i64,
    pub deck_id: i64,
    pub name: String,
    pub kind: String,
    /// Settable on **every** category, `commander` included — deactivating it is a legal (if
    /// unwise) thing for a user to do, and the validation engine will report a missing
    /// commander, which is the honest cost. Nothing here refuses it: the only kind-based
    /// refusal in this module is [`predefined_refusal`], and it never reaches this field.
    pub is_active: bool,
    pub sort_order: i64,
    /// Copies filed here, `sum(quantity)` and **not** a row count — two different printings
    /// at 2 and 3 copies read 5, not 2 — scoped to the one `variant` the caller asked by.
    pub card_count: i64,
    /// Nonfoil `usd` × copies, summed over the same `variant`. `None` when nothing filed here
    /// has a price, `deck.rs`'s own `unit_price_usd` expression verbatim
    /// (`CAST(json_extract(prices, '$.usd') AS REAL)`) — never `cards.price_usd`, which is a
    /// display fallback chain and must not be summed. SQL's `sum()` already skips NULL terms,
    /// which is what makes an all-unpriced category (or an empty one) read `None` rather than
    /// `Some(0.0)` with no extra branch: a sum of zero NULL-or-priced rows is NULL either way.
    pub total_price_usd: Option<f64>,
}

/// One tag of one deck.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTagRow {
    pub id: i64,
    pub deck_id: i64,
    pub name: String,
    pub color: String,
    /// Copies carrying this tag, `sum(quantity)` for [`DeckCategoryRow::card_count`]'s reason,
    /// scoped to [`READBACK_VARIANT`] — [`list_tags`] takes no variant of its own to scope by.
    pub card_count: i64,
}

/// One folder. Flat rows; the tree is the reader's to build from `parent_id`, the way
/// `deck_folders` itself has no notion of depth.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckFolderRow {
    pub id: i64,
    pub parent_id: Option<i64>,
    pub name: String,
    pub sort_order: i64,
}

/// A tag name and colour, and how many decks have picked it — [`tag_suggestions`]'s row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagSuggestion {
    pub name: String,
    pub color: String,
}

/// A name good enough for a category, a tag or a folder — trimmed, non-empty.
/// [`crate::deck::valid_name`]'s discipline, generalised to the three more places a blank
/// string would end up on a tile no one can read. `what` is what the refusal names.
fn valid_name<'a>(name: &'a str, what: &str) -> Result<&'a str, String> {
    let name = name.trim();
    (!name.is_empty())
        .then_some(name)
        .ok_or_else(|| format!("{what} needs a name."))
}

/// A tag colour good enough to store — non-empty, and nothing more. `deck_tags.color` carries
/// no CHECK: it names a token from the app's fixed palette (schema.rs's own words), and
/// picking from that palette is the webview's job, not this module's — the boundary CLAUDE.md
/// draws between Rust's data plumbing and TypeScript's domain logic.
fn valid_color(color: &str) -> Result<&str, String> {
    let color = color.trim();
    (!color.is_empty())
        .then_some(color)
        .ok_or_else(|| "A tag needs a colour.".to_owned())
}

/// A deck variant the schema knows, refused in words — [`crate::deck::valid_zone`]'s
/// discipline over [`crate::schema::DECK_VARIANTS`] instead of `CATEGORY_KINDS`.
fn valid_variant(variant: &str) -> Result<&str, String> {
    crate::schema::DECK_VARIANTS
        .contains(&variant)
        .then_some(variant)
        .ok_or_else(|| {
            format!(
                "`{variant}` is not a deck variant. Use one of: {}.",
                crate::schema::DECK_VARIANTS.join(", ")
            )
        })
}

/// Whether the row named `id` in `table` — always a literal table name from this module, never
/// a caller-supplied string, so building the statement with `format!` carries no injection risk
/// — belongs to `deck_id`. `None` when the row is not there at all, distinct from `Some` of the
/// wrong deck, because [`delete_category`]'s move target and [`set_card_tag`]'s tag id each
/// need to tell "gone" from "not yours" apart to answer the right sentence.
fn owning_deck(conn: &Connection, table: &str, id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        &format!("SELECT deck_id FROM {table} WHERE id = ?1"),
        params![id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------

/// Create the four non-`main` predefined categories a deck is missing, and leave the ones it
/// already has untouched. Safe to call on any deck, as many times as asked.
///
/// **Why a deck can be missing them at all**: the v7 migration's own backfill seeds these for
/// every deck that existed *at* the migration (including one with no cards — a second pass
/// added there for exactly that legacy shape), but a deck made afterwards needs the same four
/// rows made for it too. [`crate::deck::create_deck`] is that call site.
///
/// Idempotent by construction — each of the four kinds is checked before it is inserted, so a
/// second call finds all four already there and writes nothing.
///
/// A deck that does not exist is left alone rather than answering an error, the same tolerance
/// [`crate::deck::delete_deck`] shows a stale id.
///
/// **Must be called inside the caller's transaction, and never opens one of its own.** It was
/// briefly called from [`list_categories`] on every read, which is what first justified this —
/// a read is not the place four INSERTs can be interrupted between and leave a deck with two
/// or three of its four predefined categories rather than zero or all. It stopped being called
/// from there (`deck_category_list` now answers straight off `db_read`, never the write
/// connection: CLAUDE.md's two-connection split is measured to matter, and a deck-open that
/// contended for the app-wide write mutex behind an ~80 s ingest was exactly the stall that
/// split exists to prevent) — but the same hazard is true of any caller, so the rule stands:
/// running this outside a transaction risks a half-seeded deck if it is ever interrupted
/// between two of the four INSERTs, and the fix is never "wrap it internally," because a
/// caller that already opened its own transaction (`create_deck`) must not have this open a
/// second, nested one — `unchecked_transaction` does not nest.
pub fn ensure_predefined_categories(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let deck_exists: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM decks WHERE id = ?1)",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !deck_exists {
        return Ok(());
    }

    let mut next_order: i64 = conn
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM deck_categories WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    for (kind, name, is_active) in crate::schema::PREDEFINED_CATEGORIES {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deck_categories WHERE deck_id = ?1 AND kind = ?2)",
                params![deck_id, kind],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            continue;
        }
        conn.execute(
            "INSERT INTO deck_categories
                (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch(), unixepoch())",
            params![deck_id, name, kind, is_active, next_order],
        )
        .map_err(|e| e.to_string())?;
        next_order += 1;
    }
    Ok(())
}

/// Every column of a [`DeckCategoryRow`] but `deck_id`'s WHERE clause, which each caller below
/// supplies — [`crate::deck::DECK_SELECT`]'s shape. `?2` (the variant) is bound by every
/// caller; `?1` is whichever id the appended clause filters by.
const CATEGORY_SELECT: &str = "SELECT cat.id, cat.deck_id, cat.name, cat.kind, cat.is_active,
            cat.sort_order,
            coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                       WHERE dc.category_id = cat.id AND dc.variant = ?2), 0),
            (SELECT sum(dc.quantity * CAST(json_extract(c.prices, '$.usd') AS REAL))
               FROM deck_cards dc LEFT JOIN cards c ON c.id = dc.card_id
              WHERE dc.category_id = cat.id AND dc.variant = ?2)
       FROM deck_categories cat";

fn category_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckCategoryRow> {
    Ok(DeckCategoryRow {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        is_active: r.get(4)?,
        sort_order: r.get(5)?,
        card_count: r.get(6)?,
        total_price_usd: r.get(7)?,
    })
}

fn read_category(
    conn: &Connection,
    id: i64,
    variant: &str,
) -> Result<Option<DeckCategoryRow>, String> {
    conn.query_row(
        &format!("{CATEGORY_SELECT} WHERE cat.id = ?1"),
        params![id, variant],
        category_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every category of one deck, in display order, in the variant asked for.
///
/// **A pure read** — it does not call [`ensure_predefined_categories`], and never has since
/// the write it would need is [`crate::deck::create_deck`]'s job now (via the v7 migration for
/// every deck that predates it, and via `create_deck` for every one made since). That is what
/// lets [`deck_category_list`] answer off `db_read` like every other list in this app, rather
/// than contending for the write mutex — CLAUDE.md's two-connection split — on every deck open.
pub fn list_categories(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<DeckCategoryRow>, String> {
    let variant = valid_variant(variant)?;
    let sql = format!("{CATEGORY_SELECT} WHERE cat.deck_id = ?1 ORDER BY cat.sort_order, cat.id");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], category_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Find a `kind = 'main'` category by name, or make one. The add path's "find its card
/// category or create it" — unlike [`create_category`], which refuses a name already taken,
/// this is meant to be handed the same name over and over and answer the same id every time.
///
/// Deliberately takes no lock of its own and opens no transaction: it is a helper for a
/// caller that already has both (the way [`crate::deck::printing_of`] is), never a command in
/// its own right — it is not in this module's `#[tauri::command]` list.
pub fn category_for_name(conn: &Connection, deck_id: i64, name: &str) -> Result<i64, String> {
    let name = valid_name(name, "A category")?;
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND name = ?2",
            params![deck_id, name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(id);
    }
    let next_order: i64 = conn
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM deck_categories WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    conn.query_row(
        "INSERT INTO deck_categories (deck_id, name, kind, is_active, sort_order,
                                       created_at, updated_at)
         VALUES (?1, ?2, 'main', 1, ?3, unixepoch(), unixepoch())
         RETURNING id",
        params![deck_id, name, next_order],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Make a new `kind = 'main'` category. Refuses a name the deck already has —
/// [`category_for_name`]'s opposite number, for the command a user presses "New category" on.
pub fn create_category(
    conn: &Connection,
    deck_id: i64,
    name: &str,
) -> Result<DeckCategoryRow, String> {
    let name = valid_name(name, "A category")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deck_categories WHERE deck_id = ?1 AND name = ?2)",
            params![deck_id, name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Err(CATEGORY_NAME_TAKEN.to_owned());
    }
    // After the duplicate check, not before: a refused create should not move `updated_at`
    // and resort the gallery over a write that never happened — `deck::swap_printing`'s
    // same-printing guard runs before its transaction for the same reason.
    crate::deck::touch_deck(&tx, deck_id)?;
    let next_order: i64 = tx
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM deck_categories WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id: i64 = tx
        .query_row(
            "INSERT INTO deck_categories (deck_id, name, kind, is_active, sort_order,
                                           created_at, updated_at)
             VALUES (?1, ?2, 'main', 1, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, name, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_category(conn, id, READBACK_VARIANT)?.ok_or_else(|| CATEGORY_GONE.to_owned())
}

/// Rename a `kind = 'main'` category. Refuses a predefined one
/// ([`predefined_refusal`]) and a name the deck already has ([`CATEGORY_NAME_TAKEN`]).
pub fn rename_category(conn: &Connection, id: i64, name: &str) -> Result<DeckCategoryRow, String> {
    let name = valid_name(name, "A category")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (deck_id, current_name, kind): (i64, String, String) = tx
        .query_row(
            "SELECT deck_id, name, kind FROM deck_categories WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| CATEGORY_GONE.to_owned())?;
    if kind != "main" {
        return Err(predefined_refusal(&current_name));
    }
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deck_categories
                            WHERE deck_id = ?1 AND name = ?2 AND id <> ?3)",
            params![deck_id, name, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Err(CATEGORY_NAME_TAKEN.to_owned());
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    tx.execute(
        "UPDATE deck_categories SET name = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, name],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_category(conn, id, READBACK_VARIANT)?.ok_or_else(|| CATEGORY_GONE.to_owned())
}

/// Flip `is_active`. Every category answers to this, `commander` included — see
/// [`DeckCategoryRow::is_active`]'s doc for why there is no kind check here at all.
pub fn set_category_active(
    conn: &Connection,
    id: i64,
    is_active: bool,
) -> Result<DeckCategoryRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let deck_id: Option<i64> = tx
        .query_row(
            "SELECT deck_id FROM deck_categories WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let deck_id = deck_id.ok_or_else(|| CATEGORY_GONE.to_owned())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    tx.execute(
        "UPDATE deck_categories SET is_active = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, is_active],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_category(conn, id, READBACK_VARIANT)?.ok_or_else(|| CATEGORY_GONE.to_owned())
}

/// Write `sort_order` from position in `ids`. An id that does not belong to `deck_id` — the
/// wrong deck, or gone entirely — matches no row in the `WHERE id = ?1 AND deck_id = ?2` guard
/// and is silently skipped rather than refusing the whole reorder over one stale entry.
pub fn reorder_categories(
    conn: &Connection,
    deck_id: i64,
    ids: &[i64],
) -> Result<Vec<DeckCategoryRow>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    for (order, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE deck_categories SET sort_order = ?3, updated_at = unixepoch()
              WHERE id = ?1 AND deck_id = ?2",
            params![id, deck_id, order as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    list_categories(conn, deck_id, READBACK_VARIANT)
}

/// Delete a `kind = 'main'` category — refuses a predefined one, [`predefined_refusal`] again.
///
/// **`moveToCategoryId: Some(id)` moves the cards first, in the same transaction**, folding on
/// [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) — `deck_id, variant, category_id,
/// card_id` — so a `live`-variant row and a `theory`-variant row of the same printing fold
/// into their own matching row in the target and never into each other. `None` leaves the
/// `ON DELETE CASCADE` on `deck_cards.category_id` to take the cards with the category, which
/// is the DDL's own comment on that column: "deleting a category deletes the cards filed under
/// it, which is what the confirm dialog says it will do."
///
/// One command for both, because the confirm dialog offers both and a caller that had to do
/// the move and the delete as two round trips could lose the cards between them if the second
/// one failed.
pub fn delete_category(
    conn: &Connection,
    id: i64,
    move_to_category_id: Option<i64>,
) -> Result<(), String> {
    if move_to_category_id == Some(id) {
        return Err(CATEGORY_SELF_MOVE.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (deck_id, name, kind): (i64, String, String) = tx
        .query_row(
            "SELECT deck_id, name, kind FROM deck_categories WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| CATEGORY_GONE.to_owned())?;
    if kind != "main" {
        return Err(predefined_refusal(&name));
    }
    if let Some(target) = move_to_category_id {
        match owning_deck(&tx, "deck_categories", target)? {
            Some(d) if d == deck_id => {}
            Some(_) => return Err(CATEGORY_WRONG_DECK.to_owned()),
            None => return Err(CATEGORY_GONE.to_owned()),
        }
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    if let Some(target) = move_to_category_id {
        // `deck::move_card`'s INSERT … SELECT … ON CONFLICT shape verbatim, over categories
        // instead of zones. The `DO UPDATE` touches only `quantity`/`updated_at`: a row the
        // target already holds keeps its own `tag_id` and `needs_review`, never the moved
        // row's — the same "the existing row wins a fold" rule `move_card`'s comment names.
        let sql = format!(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, tag_id, quantity, needs_review, created_at, updated_at)
             SELECT deck_id, ?2, variant, card_id, set_code, collector_number, lang, name,
                    tag_id, quantity, needs_review, unixepoch(), unixepoch()
               FROM deck_cards WHERE category_id = ?1
             ON CONFLICT({grain}) DO UPDATE SET
                quantity = deck_cards.quantity + excluded.quantity,
                updated_at = unixepoch()",
            grain = crate::schema::DECK_CARD_GRAIN
        );
        tx.execute(&sql, params![id, target])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM deck_cards WHERE category_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM deck_categories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------------------

const TAG_SELECT: &str = "SELECT t.id, t.deck_id, t.name, t.color,
            coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                       WHERE dc.tag_id = t.id AND dc.variant = ?2), 0)
       FROM deck_tags t";

fn tag_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckTagRow> {
    Ok(DeckTagRow {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        name: r.get(2)?,
        color: r.get(3)?,
        card_count: r.get(4)?,
    })
}

fn read_tag(conn: &Connection, id: i64) -> Result<Option<DeckTagRow>, String> {
    conn.query_row(
        &format!("{TAG_SELECT} WHERE t.id = ?1"),
        params![id, READBACK_VARIANT],
        tag_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every tag of one deck, alphabetically. `card_count` reads [`READBACK_VARIANT`] — this
/// command carries no variant of its own to scope by, the way [`list_categories`]'s does.
pub fn list_tags(conn: &Connection, deck_id: i64) -> Result<Vec<DeckTagRow>, String> {
    let sql = format!("{TAG_SELECT} WHERE t.deck_id = ?1 ORDER BY t.name");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, READBACK_VARIANT], tag_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Make a new tag. Refuses a name the deck already has, [`create_category`]'s rule.
pub fn create_tag(
    conn: &Connection,
    deck_id: i64,
    name: &str,
    color: &str,
) -> Result<DeckTagRow, String> {
    let name = valid_name(name, "A tag")?;
    let color = valid_color(color)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deck_tags WHERE deck_id = ?1 AND name = ?2)",
            params![deck_id, name],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Err(TAG_NAME_TAKEN.to_owned());
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    let id: i64 = tx
        .query_row(
            "INSERT INTO deck_tags (deck_id, name, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, name, color],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_tag(conn, id)?.ok_or_else(|| TAG_GONE.to_owned())
}

/// Rename and/or recolour a tag. Refuses a name the deck already has under a different id.
pub fn update_tag(
    conn: &Connection,
    id: i64,
    name: &str,
    color: &str,
) -> Result<DeckTagRow, String> {
    let name = valid_name(name, "A tag")?;
    let color = valid_color(color)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let deck_id: Option<i64> = tx
        .query_row(
            "SELECT deck_id FROM deck_tags WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let deck_id = deck_id.ok_or_else(|| TAG_GONE.to_owned())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deck_tags WHERE deck_id = ?1 AND name = ?2 AND id <> ?3)",
            params![deck_id, name, id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        return Err(TAG_NAME_TAKEN.to_owned());
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    tx.execute(
        "UPDATE deck_tags SET name = ?2, color = ?3, updated_at = unixepoch() WHERE id = ?1",
        params![id, name, color],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_tag(conn, id)?.ok_or_else(|| TAG_GONE.to_owned())
}

/// Delete a tag. `deck_cards.tag_id` is `ON DELETE SET NULL`, so every card carrying it is
/// left in place, untagged — deleting a tag must never delete a card. Like
/// [`crate::deck::delete_deck`], an id that resolves to nothing is a success: the caller
/// wanted that tag gone, and it is gone (and touches no deck, having none left to touch).
pub fn delete_tag(conn: &Connection, id: i64) -> Result<(), String> {
    let Some(deck_id) = owning_deck(conn, "deck_tags", id)? else {
        return Ok(());
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    tx.execute("DELETE FROM deck_tags WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Every tag name and colour ever used, across every deck, most-used first. **Global** —
/// unlike [`list_tags`], this takes no deck id at all: a tag is per-deck data
/// (`DECK_TAG_GRAIN`), but the palette a "New tag" dialog offers to autocomplete from is a
/// property of the app's whole history, not of the one deck the dialog happens to be open on.
///
/// Grouped on `(name, color)` rather than `name` alone: the schema does not force every deck
/// to pick the same colour for a name, only [`create_tag`]/[`update_tag`]'s own discipline
/// (and the fixed palette the webview offers) makes that true in practice. Grouping on the
/// pair is exact either way — when every deck agrees, as expected, one group is one name.
pub fn tag_suggestions(conn: &Connection) -> Result<Vec<TagSuggestion>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT name, color FROM deck_tags GROUP BY name, color ORDER BY count(*) DESC, name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(TagSuggestion {
                name: r.get(0)?,
                color: r.get(1)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Set (or clear) the one tag a deck card carries. **A card carries 0 or 1 tags** — the whole
/// of that rule is the `tag_id` column itself; nothing here enforces it beyond writing to it.
///
/// Identifies the row by `(deckId, cardId, categoryId, variant)` —
/// [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) exactly, so at most one row can match.
/// A `tagId` that resolves to a different deck's tag is refused before anything is written
/// ([`TAG_WRONG_DECK`]); a row that no longer matches — moved, folded, stepped to zero since
/// the editor last read it — answers [`CARD_NOT_IN_CATEGORY`], `deck::card_gone`'s reason.
pub fn set_card_tag(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: i64,
    variant: &str,
    tag_id: Option<i64>,
) -> Result<(), String> {
    let variant = valid_variant(variant)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(tag) = tag_id {
        match owning_deck(&tx, "deck_tags", tag)? {
            Some(d) if d == deck_id => {}
            Some(_) => return Err(TAG_WRONG_DECK.to_owned()),
            None => return Err(TAG_GONE.to_owned()),
        }
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    let changed = tx
        .execute(
            "UPDATE deck_cards SET tag_id = ?5, updated_at = unixepoch()
              WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
            params![deck_id, card_id, category_id, variant, tag_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(CARD_NOT_IN_CATEGORY.to_owned());
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------------------

fn folder_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckFolderRow> {
    Ok(DeckFolderRow {
        id: r.get(0)?,
        parent_id: r.get(1)?,
        name: r.get(2)?,
        sort_order: r.get(3)?,
    })
}

fn read_folder(conn: &Connection, id: i64) -> Result<Option<DeckFolderRow>, String> {
    conn.query_row(
        "SELECT id, parent_id, name, sort_order FROM deck_folders WHERE id = ?1",
        params![id],
        folder_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every folder there is, flat. No deck scoping — a folder belongs to no deck, it files them.
pub fn list_folders(conn: &Connection) -> Result<Vec<DeckFolderRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, parent_id, name, sort_order FROM deck_folders ORDER BY sort_order, id")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], folder_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Make a new folder under `parentId` (root, if `None`). No uniqueness rule on the name —
/// unlike a category or a tag, `deck_folders` carries no grain constant and no unique index
/// on `(parent_id, name)`, so two sibling folders may share a name.
pub fn create_folder(
    conn: &Connection,
    parent_id: Option<i64>,
    name: &str,
) -> Result<DeckFolderRow, String> {
    let name = valid_name(name, "A folder")?;
    // `IS`, not `=`: `parent_id` is nullable (root), and `=` never matches a bound NULL.
    let next_order: i64 = conn
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM deck_folders WHERE parent_id IS ?1",
            params![parent_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let id: i64 = conn
        .query_row(
            "INSERT INTO deck_folders (parent_id, name, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![parent_id, name, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

pub fn rename_folder(conn: &Connection, id: i64, name: &str) -> Result<DeckFolderRow, String> {
    let name = valid_name(name, "A folder")?;
    let changed = conn
        .execute(
            "UPDATE deck_folders SET name = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, name],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(FOLDER_GONE.to_owned());
    }
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

/// Move a folder under a new parent (root, if `None`). **Refuses a cycle**: walks `parent_id`
/// upward from the *proposed* parent, and if that walk ever meets `id` — immediately, if
/// `parentId` names `id` itself — refuses rather than writing a loop `parent_id`'s own
/// `ON DELETE CASCADE` would otherwise walk forever the day one of them is deleted.
pub fn move_folder(
    conn: &Connection,
    id: i64,
    parent_id: Option<i64>,
) -> Result<DeckFolderRow, String> {
    if let Some(start) = parent_id {
        let mut cursor = Some(start);
        while let Some(candidate) = cursor {
            if candidate == id {
                return Err(FOLDER_CYCLE.to_owned());
            }
            cursor = conn
                .query_row(
                    "SELECT parent_id FROM deck_folders WHERE id = ?1",
                    params![candidate],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
        }
    }
    let changed = conn
        .execute(
            "UPDATE deck_folders SET parent_id = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, parent_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(FOLDER_GONE.to_owned());
    }
    read_folder(conn, id)?.ok_or_else(|| FOLDER_GONE.to_owned())
}

/// Delete a folder. **Does not delete the decks in it** — `decks.folder_id` is
/// `ON DELETE SET NULL`, so they surface at the root, filed nowhere, still exactly as they
/// were. Sub-folders go with it: `deck_folders.parent_id` is `ON DELETE CASCADE` on itself.
/// Like [`crate::deck::delete_deck`], an id that resolves to nothing is a success.
pub fn delete_folder(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM deck_folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// Run `f` with the write connection, or answer [`crate::collection::BUSY`] —
/// [`crate::deck::with_write`]'s definition, kept per-module the way
/// [`crate::collection`]'s own copy is.
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(crate::collection::BUSY.to_owned()),
    }
}

/// What a write here says when its worker thread died under it — never a user's problem, the
/// write itself answers [`crate::collection::BUSY`] when the database is busy.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck's categories, tags or folders could not be written: {e}")
}

/// The category panel. **Read-only connection** — see [`list_categories`]'s doc: it backfills
/// nothing any more, so this never needs to contend for the write mutex.
#[tauri::command]
pub async fn deck_category_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
) -> Result<Vec<DeckCategoryRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_categories(&crate::sync::lock_db_read(&state), deck_id, &variant)
    })
    .await
    .map_err(|e| format!("the deck's categories could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_category_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    name: String,
) -> Result<DeckCategoryRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_category(c, deck_id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<DeckCategoryRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| rename_category(c, id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_set_active(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    is_active: bool,
) -> Result<DeckCategoryRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_category_active(c, id, is_active))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    ids: Vec<i64>,
) -> Result<Vec<DeckCategoryRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_categories(c, deck_id, &ids))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_category_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    move_to_category_id: Option<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_category(c, id, move_to_category_id))
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only** connection, like every list in this module.
#[tauri::command]
pub async fn deck_tag_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<DeckTagRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_tags(&crate::sync::lock_db_read(&state), deck_id)
    })
    .await
    .map_err(|e| format!("the deck's tags could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_tag_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    name: String,
    color: String,
) -> Result<DeckTagRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_tag(c, deck_id, &name, &color))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_tag_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
    color: String,
) -> Result<DeckTagRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| update_tag(c, id, &name, &color))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_tag_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_tag(c, id)))
        .await
        .map_err(unfinished)?
}

/// **Read-only**, and the one command in this module with no deck id at all — see
/// [`tag_suggestions`]'s doc.
#[tauri::command]
pub async fn deck_tag_suggestions(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<TagSuggestion>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        tag_suggestions(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the tag palette could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_card_set_tag(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    tag_id: Option<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            set_card_tag(c, deck_id, &card_id, category_id, &variant, tag_id)
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only**, like every list in this module.
#[tauri::command]
pub async fn deck_folder_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DeckFolderRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_folders(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck folders could not be read: {e}"))?
}

#[tauri::command]
pub async fn deck_folder_create(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    name: String,
) -> Result<DeckFolderRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_folder(c, parent_id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_folder_rename(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    name: String,
) -> Result<DeckFolderRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| rename_folder(c, id, &name))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_folder_move(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    parent_id: Option<i64>,
) -> Result<DeckFolderRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| move_folder(c, id, parent_id))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_folder_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_folder(c, id)))
        .await
        .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::tests::{category, deck, deck_card};

    fn conn() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn
    }

    /// A `cards` row carrying a nonfoil `usd` price — [`crate::schema::tests::seed_card`] does
    /// not set `prices`, and the total-price tests need a printing that has one.
    fn priced_card(conn: &Connection, id: &str, usd: &str) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                 prices, raw)
             VALUES (?1, 'o-' || ?1, 'Lightning Bolt', 'lea', '161', 'en', 'normal', ?2, '{}')",
            params![id, format!(r#"{{"usd":"{usd}"}}"#)],
        )
        .unwrap();
    }

    /// [`deck_card`] always writes the `live` variant (the DDL's own default); this is that
    /// same insert with the variant spelled out, for the tests that need `theory` too.
    fn deck_card_variant(
        conn: &Connection,
        deck_id: i64,
        card_id: &str,
        category_id: i64,
        variant: &str,
        quantity: i64,
    ) -> i64 {
        conn.query_row(
            "INSERT INTO deck_cards
                (deck_id,category_id,variant,card_id,set_code,collector_number,lang,name,
                 quantity,created_at,updated_at)
             VALUES (?1,?2,?3,?4,'lea','161','en','Lightning Bolt',?5,unixepoch(),unixepoch())
             RETURNING id",
            params![deck_id, category_id, variant, card_id, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn updated_at(conn: &Connection, deck_id: i64) -> i64 {
        conn.query_row(
            "SELECT updated_at FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// `unixepoch()` has one-second resolution, so every "did this touch the deck" test moves
    /// the clock back rather than waiting on it — `deck.rs`'s own trick.
    fn backdate(conn: &Connection, deck_id: i64) {
        conn.execute(
            "UPDATE decks SET updated_at = 0 WHERE id = ?1",
            params![deck_id],
        )
        .unwrap();
    }

    // -- ensure_predefined_categories -----------------------------------------------------

    #[test]
    fn ensure_predefined_categories_backfills_a_deck_that_has_none() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");

        let before: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            before, 0,
            "a legacy or freshly created deck starts with none"
        );

        ensure_predefined_categories(&conn, deck_id).unwrap();

        let mut stmt = conn
            .prepare("SELECT kind, is_active FROM deck_categories WHERE deck_id = ?1 ORDER BY kind")
            .unwrap();
        let rows: Vec<(String, bool)> = stmt
            .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("commander".to_owned(), true),
                ("companion".to_owned(), true),
                ("maybe".to_owned(), false),
                ("side".to_owned(), true),
            ],
            "every non-main predefined kind, with maybe alone inactive"
        );
    }

    #[test]
    fn ensure_predefined_categories_is_idempotent() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        ensure_predefined_categories(&conn, deck_id).unwrap();
        ensure_predefined_categories(&conn, deck_id).unwrap();
        ensure_predefined_categories(&conn, deck_id).unwrap();

        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 4, "a second and third call must write nothing new");
    }

    #[test]
    fn ensure_predefined_categories_leaves_an_already_seeded_kind_alone() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        // A category that already exists for `commander`, under a name a user chose — the v7
        // migration's own backfill would have named it "Commander", but nothing here should
        // assume that and overwrite a name (or an is_active) the row already carries.
        let existing = category(&conn, deck_id, "commander", "General");
        conn.execute(
            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
            params![existing],
        )
        .unwrap();

        ensure_predefined_categories(&conn, deck_id).unwrap();

        let (name, is_active): (String, bool) = conn
            .query_row(
                "SELECT name, is_active FROM deck_categories WHERE deck_id = ?1 AND kind = 'commander'",
                params![deck_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            name, "General",
            "an existing row's name must not be touched"
        );
        assert!(!is_active, "nor its is_active flag");
        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1 AND kind = 'commander'",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "and no second commander row must appear beside it");
    }

    // -- list_categories / category_for_name ----------------------------------------------

    #[test]
    fn list_categories_is_a_pure_read_and_does_not_seed_anything() {
        let conn = conn();
        // `deck()` inserts straight into `decks`, bypassing both `deck::create_deck` and the
        // migration — exactly the shape a bare row has before either has run.
        let deck_id = deck(&conn, "Burn");
        let rows = list_categories(&conn, deck_id, "live").unwrap();
        assert_eq!(
            rows.len(),
            0,
            "list_categories must not write — a deck with no categories reads back none"
        );

        ensure_predefined_categories(&conn, deck_id).unwrap();
        let rows = list_categories(&conn, deck_id, "live").unwrap();
        assert_eq!(
            rows.len(),
            4,
            "once seeded (by whatever called ensure_predefined_categories), the read finds them"
        );
    }

    #[test]
    fn category_for_name_finds_before_it_creates() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");

        let first = category_for_name(&conn, deck_id, "Removal").unwrap();
        let second = category_for_name(&conn, deck_id, "Removal").unwrap();
        assert_eq!(first, second, "the same name must answer the same id");

        let n: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE deck_id = ?1 AND name = 'Removal'",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 1, "a second call must not create a second row");

        let kind: String = conn
            .query_row(
                "SELECT kind FROM deck_categories WHERE id = ?1",
                params![first],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            kind, "main",
            "a category made this way is always kind = main"
        );
    }

    // -- card_count / total_price_usd -------------------------------------------------------

    #[test]
    fn card_count_is_copies_not_rows_and_scoped_to_the_asked_variant() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        crate::schema::tests::seed_card(&conn, "bolt-m10", "m10", "146");
        // Two different printings in `live`, 2 and 3 copies: a row count would read 2.
        deck_card(&conn, deck_id, "bolt-lea", cat, 2);
        deck_card(&conn, deck_id, "bolt-m10", cat, 3);
        // A `theory` copy that must not leak into the `live` count.
        deck_card_variant(&conn, deck_id, "bolt-lea", cat, "theory", 7);

        let live = list_categories(&conn, deck_id, "live").unwrap();
        let commander_live = live.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(commander_live.card_count, 5, "copies, not rows: 2 + 3");

        let theory = list_categories(&conn, deck_id, "theory").unwrap();
        let commander_theory = theory.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(
            commander_theory.card_count, 7,
            "the theory variant is a separate count"
        );
    }

    #[test]
    fn total_price_usd_sums_nonfoil_usd_times_copies_and_skips_unpriced_cards() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        priced_card(&conn, "priced", "2.00");
        crate::schema::tests::seed_card(&conn, "unpriced", "lea", "162");
        deck_card(&conn, deck_id, "priced", cat, 3);
        deck_card(&conn, deck_id, "unpriced", cat, 5);

        let rows = list_categories(&conn, deck_id, "live").unwrap();
        let row = rows.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(
            row.total_price_usd,
            Some(6.0),
            "3 copies at $2.00, the unpriced card skipped"
        );
    }

    #[test]
    fn total_price_usd_is_none_when_nothing_in_the_category_has_a_price() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        crate::schema::tests::seed_card(&conn, "unpriced", "lea", "162");
        deck_card(&conn, deck_id, "unpriced", cat, 4);

        let rows = list_categories(&conn, deck_id, "live").unwrap();
        let row = rows.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(row.total_price_usd, None);

        // And an empty category beside it: nothing filed, nothing priced, same answer.
        let empty = category(&conn, deck_id, "companion", "Companion");
        let rows = list_categories(&conn, deck_id, "live").unwrap();
        let row = rows.iter().find(|c| c.id == empty).unwrap();
        assert_eq!(row.card_count, 0);
        assert_eq!(row.total_price_usd, None);
    }

    // -- Rule 1: a predefined category cannot be renamed or deleted; is_active can be set --

    #[test]
    fn a_predefined_category_cannot_be_renamed() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cmdr = category(&conn, deck_id, "commander", "Commander");
        let err = rename_category(&conn, cmdr, "General").unwrap_err();
        assert_eq!(
            err,
            "Commander is required by this deck's rules — it can be emptied but not removed."
        );
    }

    #[test]
    fn a_predefined_category_cannot_be_deleted() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let side = category(&conn, deck_id, "side", "Sideboard");
        let err = delete_category(&conn, side, None).unwrap_err();
        assert_eq!(
            err,
            "Sideboard is required by this deck's rules — it can be emptied but not removed."
        );
        let still_there: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE id = ?1",
                params![side],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still_there, 1);
    }

    #[test]
    fn is_active_is_settable_on_every_category_including_commander() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cmdr = category(&conn, deck_id, "commander", "Commander");
        let main = category(&conn, deck_id, "main", "Main deck");

        let row = set_category_active(&conn, cmdr, false).unwrap();
        assert!(!row.is_active, "deactivating Commander is refused nowhere");

        let row = set_category_active(&conn, main, false).unwrap();
        assert!(!row.is_active);
    }

    #[test]
    fn deck_category_create_refuses_a_duplicate_name() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        create_category(&conn, deck_id, "Removal").unwrap();
        let err = create_category(&conn, deck_id, "Removal").unwrap_err();
        assert_eq!(err, CATEGORY_NAME_TAKEN);
    }

    #[test]
    fn deck_category_rename_refuses_a_duplicate_name() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        create_category(&conn, deck_id, "Removal").unwrap();
        let counters = create_category(&conn, deck_id, "Counters").unwrap();
        let err = rename_category(&conn, counters.id, "Removal").unwrap_err();
        assert_eq!(err, CATEGORY_NAME_TAKEN);
    }

    #[test]
    fn deck_category_rename_writes_the_new_name() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let counters = create_category(&conn, deck_id, "Counters").unwrap();

        let returned = rename_category(&conn, counters.id, "Proliferate").unwrap();
        assert_eq!(returned.name, "Proliferate");

        let stored: String = conn
            .query_row(
                "SELECT name FROM deck_categories WHERE id = ?1",
                params![counters.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            stored, "Proliferate",
            "the row itself must carry the new name"
        );
    }

    // -- Rule 2: deck_category_delete's move-or-cascade ------------------------------------

    #[test]
    fn deck_category_delete_with_a_move_target_folds_cards_per_variant() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let from = category(&conn, deck_id, "main", "Creatures");
        let to = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        // The target already holds this printing in `live` — the fold must sum into it.
        deck_card(&conn, deck_id, "bolt-lea", to, 2);
        deck_card(&conn, deck_id, "bolt-lea", from, 3);
        // And a `theory` copy in the source with nothing to fold into.
        deck_card_variant(&conn, deck_id, "bolt-lea", from, "theory", 5);

        delete_category(&conn, from, Some(to)).unwrap();

        let gone: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE id = ?1",
                params![from],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0, "the source category itself is deleted");

        let live_qty: i64 = conn
            .query_row(
                "SELECT quantity FROM deck_cards
                  WHERE deck_id = ?1 AND card_id = 'bolt-lea' AND category_id = ?2 AND variant = 'live'",
                params![deck_id, to],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            live_qty, 5,
            "2 already there + 3 moved in, folded on the grain"
        );

        let theory_qty: i64 = conn
            .query_row(
                "SELECT quantity FROM deck_cards
                  WHERE deck_id = ?1 AND card_id = 'bolt-lea' AND category_id = ?2 AND variant = 'theory'",
                params![deck_id, to],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            theory_qty, 5,
            "the theory copy moved on its own, never folded into live"
        );
    }

    #[test]
    fn deck_category_delete_with_no_move_target_lets_the_cascade_take_the_cards() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Creatures");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 3);

        delete_category(&conn, cat, None).unwrap();

        let cards: i64 = conn
            .query_row("SELECT count(*) FROM deck_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            cards, 0,
            "no move target: the CASCADE takes the cards with the category"
        );
    }

    #[test]
    fn deck_category_delete_refuses_a_move_target_from_a_different_deck() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let from = category(&conn, deck_a, "main", "Creatures");
        let other_deck_target = category(&conn, deck_b, "main", "Main deck");

        let err = delete_category(&conn, from, Some(other_deck_target)).unwrap_err();
        assert_eq!(err, CATEGORY_WRONG_DECK);
        let still_there: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE id = ?1",
                params![from],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still_there, 1, "the refused delete must write nothing");
    }

    #[test]
    fn deck_category_delete_refuses_moving_a_category_into_itself() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Creatures");
        let err = delete_category(&conn, cat, Some(cat)).unwrap_err();
        assert_eq!(err, CATEGORY_SELF_MOVE);
    }

    #[test]
    fn deck_category_reorder_writes_sort_order_from_position() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let a = category(&conn, deck_id, "main", "A");
        let b = category(&conn, deck_id, "main", "B");
        let c = category(&conn, deck_id, "main", "C");

        // `list_categories` — what `reorder_categories` reads back with — is a pure read and
        // seeds nothing, so this deck's answer is exactly the three rows reordered, in order.
        let rows = reorder_categories(&conn, deck_id, &[c, a, b]).unwrap();
        let order: Vec<i64> = rows.iter().map(|r| r.id).collect();
        assert_eq!(order, vec![c, a, b]);
    }

    // -- Rule 3: deck_folder_move refuses a cycle -------------------------------------------

    #[test]
    fn deck_folder_move_refuses_a_cycle() {
        let conn = conn();
        let root = create_folder(&conn, None, "Standard").unwrap();
        let child = create_folder(&conn, Some(root.id), "Aggro").unwrap();
        let grandchild = create_folder(&conn, Some(child.id), "Burn").unwrap();

        let err = move_folder(&conn, root.id, Some(grandchild.id)).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);

        let unchanged = read_folder(&conn, root.id).unwrap().unwrap();
        assert_eq!(
            unchanged.parent_id, None,
            "the refused move must write nothing"
        );
    }

    #[test]
    fn deck_folder_move_refuses_moving_a_folder_into_itself_directly() {
        let conn = conn();
        let root = create_folder(&conn, None, "Standard").unwrap();
        let err = move_folder(&conn, root.id, Some(root.id)).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);
    }

    #[test]
    fn deck_folder_rename_writes_the_new_name() {
        let conn = conn();
        let folder = create_folder(&conn, None, "Standard").unwrap();

        let returned = rename_folder(&conn, folder.id, "Modern").unwrap();
        assert_eq!(returned.name, "Modern");

        let stored: String = conn
            .query_row(
                "SELECT name FROM deck_folders WHERE id = ?1",
                params![folder.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "Modern", "the row itself must carry the new name");
    }

    #[test]
    fn deck_folder_move_moves_to_a_new_parent_and_then_back_to_root() {
        let conn = conn();
        let standard = create_folder(&conn, None, "Standard").unwrap();
        let eternal = create_folder(&conn, None, "Eternal").unwrap();
        let burn = create_folder(&conn, Some(standard.id), "Burn").unwrap();

        let moved = move_folder(&conn, burn.id, Some(eternal.id)).unwrap();
        assert_eq!(
            moved.parent_id,
            Some(eternal.id),
            "the returned row must carry the new parent"
        );
        let stored: Option<i64> = conn
            .query_row(
                "SELECT parent_id FROM deck_folders WHERE id = ?1",
                params![burn.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, Some(eternal.id), "and so must the row itself");

        let moved_to_root = move_folder(&conn, burn.id, None).unwrap();
        assert_eq!(
            moved_to_root.parent_id, None,
            "moving to root is `None`, not a special id"
        );
        let stored: Option<i64> = conn
            .query_row(
                "SELECT parent_id FROM deck_folders WHERE id = ?1",
                params![burn.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, None, "the row itself must be un-parented too");
    }

    #[test]
    fn deck_folder_list_reads_the_tree_shape_and_order() {
        let conn = conn();
        let eternal = create_folder(&conn, None, "Eternal").unwrap();
        let standard = create_folder(&conn, None, "Standard").unwrap();
        // Two children of the same parent, so there is a sibling order to check — `sort_order`
        // is scoped per parent (`create_folder`'s own `WHERE parent_id IS ?1`), so `list_folders`'
        // flat `ORDER BY sort_order, id` does not by itself group a parent with its children;
        // what it guarantees is checked per level below rather than as one global sequence.
        let modern = create_folder(&conn, Some(standard.id), "Modern").unwrap();
        let legacy = create_folder(&conn, Some(standard.id), "Legacy").unwrap();

        let rows = list_folders(&conn).unwrap();
        assert_eq!(rows.len(), 4);
        let by_id = |id: i64| rows.iter().find(|r| r.id == id).unwrap();

        // Shape: every row carries its own parent, which is the whole of what "the tree" is
        // built from — no separate lookup needed to place a folder.
        assert_eq!(by_id(eternal.id).parent_id, None);
        assert_eq!(by_id(standard.id).parent_id, None);
        assert_eq!(by_id(modern.id).parent_id, Some(standard.id));
        assert_eq!(by_id(legacy.id).parent_id, Some(standard.id));

        // Order: siblings in creation order, within each parent.
        let root_order: Vec<i64> = rows
            .iter()
            .filter(|r| r.parent_id.is_none())
            .map(|r| r.id)
            .collect();
        assert_eq!(root_order, vec![eternal.id, standard.id]);
        let child_order: Vec<i64> = rows
            .iter()
            .filter(|r| r.parent_id == Some(standard.id))
            .map(|r| r.id)
            .collect();
        assert_eq!(child_order, vec![modern.id, legacy.id]);
    }

    #[test]
    fn deck_folder_delete_keeps_its_decks_and_cascades_its_subfolders() {
        let conn = conn();
        let root = create_folder(&conn, None, "Standard").unwrap();
        let child = create_folder(&conn, Some(root.id), "Aggro").unwrap();
        let deck_id = deck(&conn, "Burn");
        conn.execute(
            "UPDATE decks SET folder_id = ?2 WHERE id = ?1",
            params![deck_id, root.id],
        )
        .unwrap();

        delete_folder(&conn, root.id).unwrap();

        let folder_id: Option<i64> = conn
            .query_row(
                "SELECT folder_id FROM decks WHERE id = ?1",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            folder_id, None,
            "the deck surfaces at the root, not deleted"
        );

        let child_gone: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_folders WHERE id = ?1",
                params![child.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            child_gone, 0,
            "the sub-folder cascades away with its parent"
        );
    }

    // -- Rule 4: deck_tag_suggestions is global ---------------------------------------------

    #[test]
    fn deck_tag_suggestions_is_global_and_ordered_by_use_then_name() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let deck_c = deck(&conn, "Midrange");
        create_tag(&conn, deck_a, "Removal", "red").unwrap();
        create_tag(&conn, deck_b, "Removal", "red").unwrap();
        create_tag(&conn, deck_c, "Removal", "red").unwrap();
        create_tag(&conn, deck_a, "Ramp", "green").unwrap();
        create_tag(&conn, deck_b, "Ramp", "green").unwrap();
        create_tag(&conn, deck_a, "Draw", "blue").unwrap();

        let suggestions = tag_suggestions(&conn).unwrap();
        let names: Vec<&str> = suggestions.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["Removal", "Ramp", "Draw"],
            "used by 3 decks, then 2, then 1 — ties broken by name"
        );
    }

    #[test]
    fn deck_tag_create_refuses_a_duplicate_name() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        create_tag(&conn, deck_id, "Removal", "red").unwrap();
        let err = create_tag(&conn, deck_id, "Removal", "blue").unwrap_err();
        assert_eq!(err, TAG_NAME_TAKEN);
    }

    #[test]
    fn deck_tag_update_writes_the_new_name_and_color() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let tag = create_tag(&conn, deck_id, "Removal", "red").unwrap();

        let returned = update_tag(&conn, tag.id, "Interaction", "blue").unwrap();
        assert_eq!(returned.name, "Interaction");
        assert_eq!(returned.color, "blue");

        let (stored_name, stored_color): (String, String) = conn
            .query_row(
                "SELECT name, color FROM deck_tags WHERE id = ?1",
                params![tag.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            stored_name, "Interaction",
            "the row itself must carry the new name"
        );
        assert_eq!(stored_color, "blue", "and the new colour");
    }

    // -- Rule 5: a card carries 0 or 1 tags --------------------------------------------------

    #[test]
    fn a_card_carries_zero_or_one_tags() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 4);
        let removal = create_tag(&conn, deck_id, "Removal", "red").unwrap();
        let ramp = create_tag(&conn, deck_id, "Ramp", "green").unwrap();

        let tag_of = |conn: &Connection| -> Option<i64> {
            conn.query_row(
                "SELECT tag_id FROM deck_cards WHERE deck_id = ?1 AND card_id = 'bolt-lea'",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap()
        };

        set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", Some(removal.id)).unwrap();
        assert_eq!(tag_of(&conn), Some(removal.id));

        // Setting a second tag replaces the first — never both.
        set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", Some(ramp.id)).unwrap();
        assert_eq!(tag_of(&conn), Some(ramp.id));

        set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", None).unwrap();
        assert_eq!(tag_of(&conn), None);
    }

    #[test]
    fn set_card_tag_refuses_a_tag_from_a_different_deck() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let cat = category(&conn, deck_a, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_a, "bolt-lea", cat, 4);
        let other_deck_tag = create_tag(&conn, deck_b, "Removal", "red").unwrap();

        let err = set_card_tag(
            &conn,
            deck_a,
            "bolt-lea",
            cat,
            "live",
            Some(other_deck_tag.id),
        )
        .unwrap_err();
        assert_eq!(err, TAG_WRONG_DECK);
    }

    #[test]
    fn set_card_tag_refuses_a_card_not_in_that_category() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        let err = set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", None).unwrap_err();
        assert_eq!(err, CARD_NOT_IN_CATEGORY);
    }

    // -- Rule 6: every write touches the deck the gallery sorts by -------------------------

    #[test]
    fn every_category_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");

        backdate(&conn, deck_id);
        let cat = create_category(&conn, deck_id, "Removal").unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "create moved the deck");

        backdate(&conn, deck_id);
        rename_category(&conn, cat.id, "Interaction").unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "so does rename");

        backdate(&conn, deck_id);
        set_category_active(&conn, cat.id, false).unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "and setActive");

        backdate(&conn, deck_id);
        reorder_categories(&conn, deck_id, &[cat.id]).unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "and reorder");

        backdate(&conn, deck_id);
        delete_category(&conn, cat.id, None).unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "and delete");
    }

    #[test]
    fn every_tag_and_card_tag_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 4);

        backdate(&conn, deck_id);
        let tag = create_tag(&conn, deck_id, "Removal", "red").unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "tag create moved the deck");

        backdate(&conn, deck_id);
        update_tag(&conn, tag.id, "Interaction", "red").unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "so does tag update");

        backdate(&conn, deck_id);
        set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", Some(tag.id)).unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "and tagging a card");

        backdate(&conn, deck_id);
        delete_tag(&conn, tag.id).unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "and tag delete");
    }

    #[test]
    fn a_stale_deck_id_answers_gone_and_writes_nothing() {
        let conn = conn();
        let err = create_category(&conn, 999_999, "Removal").unwrap_err();
        assert_eq!(err, crate::deck::GONE);
        let n: i64 = conn
            .query_row("SELECT count(*) FROM deck_categories", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }
}
