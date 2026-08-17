//! Deck categories, tags and folders: everything schema v8 (Plan 8, Task 1) carved out of a
//! deck's fixed five-word zone and its bare gallery listing.
//!
//! Shaped like [`crate::deck`] and [`crate::collection`]: pure functions over a `Connection`,
//! testable without a Tauri app, wrapped in `async` commands that run on the blocking pool.
//! Writes take `AppState.db` and answer [`crate::db::BUSY`] rather than waiting.
//!
//! Three tables, three different relationships to "the deck":
//!
//! * **Categories** and **tags** are *of* one deck (`deck_id NOT NULL`) — a category names a
//!   pile within a deck, a tag is a per-deck label a deck card can carry. Every write to
//!   either goes through [`crate::deck::touch_deck`], so the gallery's "recently edited"
//!   order moves the same way a card add or a rename does.
//! * **Folders** are not of any deck at all — they file decks the way a filesystem directory
//!   files files, and `decks.folder_id` is `ON DELETE SET NULL` rather than the CASCADE every
//!   category and tag write takes. No folder write touches a deck's `updated_at`, and three of
//!   the four record nothing in `deck_audit` (which is `deck_id NOT NULL` — creating, renaming
//!   or moving a folder changes no deck, so there is no deck to name). **[`delete_folder`] is
//!   the exception**: SET NULL re-files every deck in the folder and in the sub-folders that
//!   CASCADE with it, so it writes one `folder` row per deck it un-filed. The `folder` audit
//!   *kind* is not about folder CRUD even there: it records a **deck being filed**, and the
//!   other two writers of it are `deck::update_deck` and `deck::set_folder`.
//!
//! Every category and tag write records one [`crate::deck_audit`] row inside its own
//! transaction, so a refused write leaves no history. The `tag` kind covers two events and
//! `card_id` is what tells them apart: a card wearing a label (`set_card_tag`, `card_id` set)
//! and the label itself being made, renamed or deleted (`card_id` NULL, and an `action` verb —
//! without one a delete would read as a labelling).
//!
//! **Two of these writes reallocate, and the rest deliberately do not.** `is_active` is what
//! decides whether a card is allocated for at all ([`crate::deck::allocate_deck`]'s own doc),
//! so [`set_category_active`] changes what this deck has reserved without touching a single
//! card — and [`delete_category`] does too, by taking cards away or moving them somewhere with
//! a different flag. Both call the allocator inside their own transaction, the way every card
//! write in [`crate::deck`] does. A rename, a reorder and every tag write change what a pile
//! is *called* and nothing about what is in it, so they claim exactly what they claimed
//! before; running the allocator there would be a rebuild of every claim over a write that
//! changed none of them.

use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
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
///
/// `pub`, not private: [`crate::deck::category_of_deck`] draws the same distinction for every
/// card write, and two spellings of one refusal is two sentences a reader could meet for one
/// mistake.
pub const CATEGORY_WRONG_DECK: &str = "That category belongs to a different deck.";

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

/// How far [`move_folder`]'s cycle walk will climb before it calls the chain a cycle.
///
/// [`crate::deck::folder_path`]'s `MAX_DEPTH`, kept separately because the two answer to
/// different things: that one gives up and reports the path it read, this one refuses the
/// write. Deep enough that no filing anyone does by hand reaches it.
const MAX_FOLDER_DEPTH: usize = 64;

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
    /// Who made this pile: `'auto'` — the app, filing a card it had to invent a column for —
    /// or `'user'`, the reader pressing "New category". Schema v15; the four seeded zones
    /// count as the reader's.
    ///
    /// **It is what TypeScript draws an *empty* pile from.** An empty auto pile is hidden (a
    /// Ramp column with no ramp in it is a heading about nothing) and an empty user pile is
    /// always drawn, until they delete it. Rust supplies the fact; TS draws the conclusion —
    /// CLAUDE.md's boundary — and this crate has no opinion at all about who gets drawn.
    ///
    /// **A stored fact rather than a name comparison, and that is the whole point.**
    /// [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) is `(deck_id, name)`, so
    /// [`category_for_name`] *finds* a pile the reader made rather than making a second one —
    /// which means their own "Ramp" keeps `'user'` forever, even once the app starts filing
    /// ramp spells into it. Deciding from the name instead would flip that pile to hidden the
    /// first time it emptied, and "Ramp", "Draw", "Removal" and "Land" are exactly what a
    /// person calls their own piles.
    ///
    /// No CHECK, and no `valid_…` fence beside `valid_variant`: this is never a caller's value.
    /// Four INSERTs inside this crate write it — [`category_for_name`], [`create_category`],
    /// [`ensure_predefined_categories`] and [`crate::deck::duplicate_deck`] — and no command
    /// parameter reaches it, so there is nothing untrusted to refuse.
    pub origin: String,
    /// Copies filed here **in the one `variant` the caller asked by**, `sum(quantity)` and not
    /// a row count — two different printings at 2 and 3 copies read 5, not 2.
    ///
    /// This is the number a *list* row wants: a panel drawing the deck's columns is drawing the
    /// list the reader is editing, and a heading that counted the other one would be counting
    /// cards that are not on screen. It is **not** the number a delete confirmation wants — see
    /// [`DeckCategoryRow::card_count_all_variants`], and read both docs before using either.
    pub card_count: i64,
    /// Copies filed here **across every [`crate::schema::DECK_VARIANTS`]**, live and theory
    /// together — the number a destructive confirmation has to quote.
    ///
    /// A category is not per-variant. `deck_cards.category_id` is `ON DELETE CASCADE`, so
    /// deleting one takes its rows out of **both** lists, and the move arm of
    /// [`delete_category`] moves both for the same reason ("The move covers both variants" is
    /// already that command's contract). A dialog quoting [`DeckCategoryRow::card_count`]
    /// therefore understates what it is about to do on any theory-enabled deck — measured on
    /// the fake's seeded deck 4, where a "Ramp" offering to move 2 cards moved 7.
    ///
    /// It **understates the destructive arm in particular** (`move_to = None`), which is the
    /// shape that made this worth a schema-to-webview change rather than a note: a control that
    /// lies about its scope lies in the direction of the reader pressing it.
    pub card_count_all_variants: i64,
    /// Unit price × copies at the marketplace the read was given, summed over the same
    /// `variant`. `None` when nothing filed here has a price there — `deck.rs`'s own
    /// `unit_price` expression verbatim, [`crate::sorting::printing_price_by_finish_expr`], and
    /// never `cards.price_usd`, which is that same chain precomputed for the search's sort and
    /// is the column this crate does not sum. SQL's `sum()` already skips NULL terms, which is what
    /// makes an all-unpriced category (or an empty one) read `None` rather than `Some(0.0)`
    /// with no extra branch: a sum of zero NULL-or-priced rows is NULL either way.
    ///
    /// **Two marketplaces can differ by more than a conversion**, and not by a rounding: a
    /// category holding printings one of them has never listed sums *fewer cards* there, and
    /// `sum()` skipping the NULLs is what keeps that honest about a smaller population rather
    /// than quietly inventing prices for it.
    pub total_price: Option<f64>,
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
    /// scoped to the one `variant` the caller asked by — exactly as that field is.
    ///
    /// The two have to agree, and briefly did not: [`crate::deck::get_deck`] threaded its
    /// variant into [`list_categories`] and not into [`list_tags`], so a Theory read came back
    /// with Theory category counts beside **Live** tag counts. Nothing drew the number yet, so
    /// nothing was visibly wrong; the contract was, which is the cheaper thing to fix.
    /// A write's own readback still uses [`READBACK_VARIANT`] — a rename carries no variant of
    /// its own, and `live` is the one the editor opens on.
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

/// A deck variant the schema knows, refused in words rather than as a CHECK failure — the
/// same discipline `collection::valid_finish` applies to the finish enum, over
/// [`crate::schema::DECK_VARIANTS`].
///
/// `pub(crate)`: every card command in [`crate::deck`] opens with it too. It lives here
/// because `deck_categories` and `deck_tags` are this module's, and one definition of "is
/// that a variant" is what keeps the two modules' refusals identical.
pub(crate) fn valid_variant(variant: &str) -> Result<&str, String> {
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
/// **Why a deck can be missing them at all**: the v8 migration's own backfill seeds these for
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
        // **`'user'`, spelled out rather than left to the column's DEFAULT** — every write site
        // says its own answer, so which of the three made a pile is readable at the code. The
        // four seeded zones are the reader's for the reason [`DeckCategoryRow::origin`] gives:
        // a deck's rules zones are piles nobody has to earn, and an empty Sideboard is a place
        // to put a card rather than a heading about nothing.
        conn.execute(
            "INSERT INTO deck_categories
                (deck_id, name, kind, is_active, sort_order, origin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 'user', unixepoch(), unixepoch())",
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
fn category_select(marketplace: crate::sorting::Marketplace) -> String {
    format!(
        "SELECT cat.id, cat.deck_id, cat.name, cat.kind, cat.is_active,
            cat.sort_order, cat.origin,
            coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                       WHERE dc.category_id = cat.id AND dc.variant = ?2), 0),
            (SELECT sum(dc.quantity * ({price}))
               FROM deck_cards dc LEFT JOIN cards c ON c.id = dc.card_id
              WHERE dc.category_id = cat.id AND dc.variant = ?2),
            coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                       WHERE dc.category_id = cat.id), 0)
       FROM deck_categories cat",
        price = crate::sorting::printing_price_by_finish_expr(marketplace)
    )
}

fn category_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckCategoryRow> {
    Ok(DeckCategoryRow {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        name: r.get(2)?,
        kind: r.get(3)?,
        is_active: r.get(4)?,
        sort_order: r.get(5)?,
        origin: r.get(6)?,
        card_count: r.get(7)?,
        total_price: r.get(8)?,
        // No `?2` in this one's subquery, and that is the whole of the difference: the CASCADE
        // this number exists to describe does not know what variant anybody is looking at.
        card_count_all_variants: r.get(9)?,
    })
}

/// The marketplace a **write's own readback** quotes: the stored setting.
///
/// [`READBACK_VARIANT`]'s counterpart, and the opposite answer to it, because the two facts
/// are different. A rename carries no variant of its own, so the readback names the one the
/// editor opens on; it carries no marketplace either, but there *is* a right answer for that
/// one — the setting the reader is looking at the deck through. A fixed default here would
/// hand the panel a TCGplayer total the moment a Cardmarket user renamed a column.
fn readback_marketplace(conn: &Connection) -> crate::sorting::Marketplace {
    crate::sorting::Marketplace::from_id(&crate::marketplace::stored(conn))
}

fn read_category(
    conn: &Connection,
    id: i64,
    variant: &str,
) -> Result<Option<DeckCategoryRow>, String> {
    conn.query_row(
        &format!(
            "{} WHERE cat.id = ?1",
            category_select(readback_marketplace(conn))
        ),
        params![id, variant],
        category_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every category of one deck, in display order, in the variant asked for.
///
/// **A pure read** — it does not call [`ensure_predefined_categories`], and never has since
/// the write it would need is [`crate::deck::create_deck`]'s job now (via the v8 migration for
/// every deck that predates it, and via `create_deck` for every one made since). That is what
/// lets [`deck_category_list`] answer off `db_read` like every other list in this app, rather
/// than contending for the write mutex — CLAUDE.md's two-connection split — on every deck open.
pub fn list_categories(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<DeckCategoryRow>, String> {
    let variant = valid_variant(variant)?;
    let sql = format!(
        "{} WHERE cat.deck_id = ?1 ORDER BY cat.sort_order, cat.id",
        category_select(marketplace)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], category_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Find a category by name, or make one — a **new one is always `kind = 'main'`**, but the
/// lookup is by name alone and will happily answer with a predefined category. The add path's
/// "find its card category or create it"; unlike [`create_category`], which refuses a name
/// already taken, this is meant to be handed the same name over and over and answer the same
/// id every time.
///
/// **The lookup cannot be narrowed to `kind = 'main'`, and this is the trap.**
/// [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) is `(deck_id, name)` — one name
/// per deck, whatever its kind — so a `kind = 'main'` lookup would miss the deck's predefined
/// `Sideboard` and then fail the INSERT below on a UNIQUE violation rather than answering an
/// id. Finding it is the only thing this function *can* do.
///
/// So a caller whose computed name collides with a predefined one files the card into that
/// predefined category. For `Commander`, `Sideboard` and `Companion` that is arguably what the
/// reader meant. For **`Maybeboard` it is not**: that one is seeded `is_active = 0`, so a card
/// filed there counts toward nothing at all — not the deck's size, not its copy limits, not
/// its legality, and the allocator reserves no copy for it. A card can vanish from every
/// number the editor shows without vanishing from the deck.
///
/// The one caller that computes a name is [`crate::deck::add_card`]'s `categoryName` arm, fed
/// by TypeScript's `autoCategoryFor`. **That rule is where the collision has to be settled** —
/// it is domain logic, and the answer ("never return a predefined name", or "return
/// `Maybeboard` only when the reader asked for it") is a product decision this module cannot
/// make on its own. Nothing here refuses the collision, because refusing would break the
/// legitimate case of a reader dragging a card onto their own Sideboard.
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
    // **`'auto'`, and only on this branch** — the one the app reaches when it had to invent a
    // column for a card it was filing. The lookup above is what makes that safe to record as a
    // fact: a pile the *reader* made is found rather than re-made, so it keeps its `'user'`
    // forever even once the add path starts filing cards into it. That is the case a
    // name-matching rule gets wrong and this gets right for free —
    // `category_for_name_leaves_an_existing_user_pile_alone` is the pin.
    conn.query_row(
        "INSERT INTO deck_categories (deck_id, name, kind, is_active, sort_order, origin,
                                       created_at, updated_at)
         VALUES (?1, ?2, 'main', 1, ?3, 'auto', unixepoch(), unixepoch())
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
    // **`'user'`: this is the reader pressing "New category"**, which is the whole of what
    // separates this function from [`category_for_name`]. A pile made here draws whether or not
    // anything is in it — it was created with intent, and an empty one is where the next card
    // of that kind goes.
    let id: i64 = tx
        .query_row(
            "INSERT INTO deck_categories (deck_id, name, kind, is_active, sort_order, origin,
                                           created_at, updated_at)
             VALUES (?1, ?2, 'main', 1, ?3, 'user', unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, name, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let audit_id = record_category(&tx, deck_id, &json!({ "action": "create", "name": name }))?;
    // Nothing is in it yet, so the pile itself is the whole of the change.
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Categories {
            restore: vec![],
            patch: vec![],
            delete: vec![id],
            default_category_id: None,
        }],
        vec![crate::deck_undo::Op::Categories {
            restore: category_step_row(&tx, id)?,
            patch: vec![],
            delete: vec![],
            default_category_id: None,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_category(conn, id, READBACK_VARIANT)?.ok_or_else(|| CATEGORY_GONE.to_owned())
}

/// One `category`-kind history row, with the four constants every caller here would otherwise
/// repeat. A category change is about no card and moves no copies, so `card_id` is NULL and
/// `delta` is 0 at every one of the six call sites — the payload's `action` is the whole of
/// what differs.
fn record_category(
    tx: &Connection,
    deck_id: i64,
    payload: &serde_json::Value,
) -> Result<i64, String> {
    crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::CATEGORY,
        None,
        payload,
        0,
    )
}

/// One undo step for a category or tag write, with the two `Step::new` lines every caller here
/// would otherwise repeat.
fn record_category_step(
    tx: &Connection,
    audit_id: i64,
    deck_id: i64,
    undo: Vec<crate::deck_undo::Op>,
    redo: Vec<crate::deck_undo::Op>,
) -> Result<(), String> {
    crate::deck_undo::record_step(
        tx,
        audit_id,
        deck_id,
        &crate::deck_undo::Step::new(undo, redo),
    )
}

/// One category as a step carries it, in the one-element list the ops take.
///
/// A vector rather than the row, because a category that has gone (a delete's *redo* side asks
/// about one that will not be there) is an empty list rather than an error — the op then
/// restores nothing, which is exactly right.
fn category_step_row(
    tx: &Connection,
    id: i64,
) -> Result<Vec<crate::deck_undo::CategoryRow>, String> {
    Ok(crate::deck_undo::read_category(tx, id)?
        .into_iter()
        .collect())
}

/// The same for a tag.
fn tag_step_row(tx: &Connection, id: i64) -> Result<Vec<crate::deck_undo::TagRow>, String> {
    Ok(crate::deck_undo::read_tag(tx, id)?.into_iter().collect())
}

/// One `tag`-kind history row **about the label itself** — created, renamed or deleted. No
/// card, and an `action` verb: see the module doc for why the two halves of this kind share it.
fn record_tag(tx: &Connection, deck_id: i64, payload: &serde_json::Value) -> Result<i64, String> {
    crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::TAG,
        None,
        payload,
        0,
    )
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
    let before = category_step_row(&tx, id)?;
    tx.execute(
        "UPDATE deck_categories SET name = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, name],
    )
    .map_err(|e| e.to_string())?;
    let audit_id = record_category(
        &tx,
        deck_id,
        &json!({ "action": "rename", "name": name, "previousName": current_name }),
    )?;
    // `patch`, never `restore`: the row is there and its columns go back. A restore would
    // insert a second pile the moment its id had been reused — the two lists are two intents.
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Categories {
            restore: vec![],
            patch: before,
            delete: vec![],
            default_category_id: None,
        }],
        vec![crate::deck_undo::Op::Categories {
            restore: vec![],
            patch: category_step_row(&tx, id)?,
            delete: vec![],
            default_category_id: None,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_category(conn, id, READBACK_VARIANT)?.ok_or_else(|| CATEGORY_GONE.to_owned())
}

/// Flip `is_active`. Every category answers to this, `commander` included — see
/// [`DeckCategoryRow::is_active`]'s doc for why there is no kind check here at all.
///
/// **Reallocates.** This is the one write in this module that changes what the deck has
/// reserved without touching a card: `is_active` is the whole of what
/// [`crate::deck::allocate_deck`] allocates *for*, so switching a category off hands its
/// copies back to every other deck and switching one on claims them.
pub fn set_category_active(
    conn: &Connection,
    id: i64,
    is_active: bool,
) -> Result<DeckCategoryRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The name comes back with the deck id for the history's sake: a row that said only
    // "deactivated category 41" is a row nobody can read once the panel is closed.
    let category: Option<(i64, String)> = tx
        .query_row(
            "SELECT deck_id, name FROM deck_categories WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (deck_id, name) = category.ok_or_else(|| CATEGORY_GONE.to_owned())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    let before = category_step_row(&tx, id)?;
    tx.execute(
        "UPDATE deck_categories SET is_active = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![id, is_active],
    )
    .map_err(|e| e.to_string())?;
    // Two verbs rather than one with a boolean, because that is what the change *is* — and a
    // renderer that had to read `{"active": false}` to write "switched off" would be deriving
    // the sentence from a field whose name is about state rather than about what happened.
    let action = if is_active { "activate" } else { "deactivate" };
    let audit_id = record_category(&tx, deck_id, &json!({ "action": action, "name": name }))?;
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Categories {
            restore: vec![],
            patch: before,
            delete: vec![],
            default_category_id: None,
        }],
        vec![crate::deck_undo::Op::Categories {
            restore: vec![],
            patch: category_step_row(&tx, id)?,
            delete: vec![],
            default_category_id: None,
        }],
    )?;
    crate::deck::allocate_deck(&tx, deck_id)?;
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
    // **Every pile, both sides.** The history row is a bare `{"action":"reorder"}` — it names no
    // category *and no order*, deliberately, because the drawer records changes rather than
    // state — so this is the one write whose reversal the audit log cannot even begin to
    // describe. `read_categories` is in id order and each row carries its own `sort_order`.
    let before = crate::deck_undo::read_categories(&tx, deck_id)?;
    for (order, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE deck_categories SET sort_order = ?3, updated_at = unixepoch()
              WHERE id = ?1 AND deck_id = ?2",
            params![id, deck_id, order as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    // A reorder names no category, because every one of them moved: there is no "from" and no
    // "to" that is about one pile, and listing the whole order would be storing the state
    // rather than the change.
    let audit_id = record_category(&tx, deck_id, &json!({ "action": "reorder" }))?;
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Categories {
            restore: vec![],
            patch: before,
            delete: vec![],
            default_category_id: None,
        }],
        vec![crate::deck_undo::Op::Categories {
            restore: vec![],
            patch: crate::deck_undo::read_categories(&tx, deck_id)?,
            delete: vec![],
            default_category_id: None,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    list_categories(conn, deck_id, READBACK_VARIANT, readback_marketplace(conn))
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
///
/// **It also puts the deck back on Auto when the pile it deletes was the deck's default**
/// ([`crate::deck::AUTO_CATEGORY`]) — the clean-up an `ON DELETE SET NULL` would do for free on
/// a nullable column, and `decks.default_category_id` is deliberately not one. The two sites
/// that stand in for that key are this one and [`crate::deck::duplicate_deck`]'s remap.
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
    // Counted **before** anything moves or cascades, and in copies rather than rows — two
    // printings at 2 and 3 is 5 cards, which is what the confirm dialog warned about and the
    // only part of a deleted category a reader cannot get back. Both variants, because the
    // CASCADE takes both: a category is not variant-scoped, and a theory row filed here dies
    // with it exactly as a live one does.
    let cards: i64 = tx
        .query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards WHERE category_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // **The undo step's "before", and the single largest thing the audit log could not
    // describe.** That row records `{"action":"delete","name":"Ramp","cards":7}` — a *count* of
    // what the CASCADE took, which its own comment calls "the only part of a deleted category a
    // reader cannot get back". These are the cards themselves.
    //
    // Four cells, not two: **both variants of the deleted pile and both of the target**, because
    // the move arm folds on `DECK_CARD_GRAIN` into whatever the target already held. Without the
    // target's own two, undoing a delete-with-move would put the deleted pile back and leave the
    // folded copies in the target as well — the deck would gain cards by being un-deleted.
    let mut cells = vec![
        crate::deck_undo::Cell::pile(crate::schema::DECK_VARIANTS[0], id),
        crate::deck_undo::Cell::pile(crate::schema::DECK_VARIANTS[1], id),
    ];
    if let Some(target) = move_to_category_id {
        cells.push(crate::deck_undo::Cell::pile(
            crate::schema::DECK_VARIANTS[0],
            target,
        ));
        cells.push(crate::deck_undo::Cell::pile(
            crate::schema::DECK_VARIANTS[1],
            target,
        ));
    }
    let cards_before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    let category_before = category_step_row(&tx, id)?;
    let default_before: i64 = tx
        .query_row(
            "SELECT default_category_id FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
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
    // **What an `ON DELETE SET NULL` would have done, done by hand** — and the reason it has to
    // be is at the v16 step: `decks.default_category_id` holds a sentinel (`0` is Auto) rather
    // than a nullable reference, so it carries no foreign key and nothing in the DDL notices
    // this row going. Left undone, the deck would keep filing every unnamed add at an id with no
    // pile behind it, which is a card written to a `category_id` the FK on `deck_cards` refuses:
    // the reader's next quick add fails, on a deck whose settings still read the deleted name.
    //
    // Before the DELETE, so it is one predicate on this deck rather than a scan, and in this
    // transaction, so a rolled-back delete leaves the deck pointing where it did.
    tx.execute(
        "UPDATE decks SET default_category_id = ?2
          WHERE id = ?1 AND default_category_id = ?3",
        params![deck_id, crate::deck::AUTO_CATEGORY, id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM deck_categories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let audit_id = record_category(
        &tx,
        deck_id,
        &json!({ "action": "delete", "name": name, "cards": cards }),
    )?;
    // **Order is load-bearing on both sides**, and in opposite directions.
    //
    // Undo: the pile comes back *first*, because `deck_cards.category_id` is a real foreign key
    // and the cards have nowhere to land until it exists. If its rowid has been taken since,
    // `restore_category` files it under a fresh id and every cell below is rewritten through the
    // remap — which is also why `default_category_id` rides on this op rather than on a
    // `Op::Deck`: the number it stores has to move with the pile.
    //
    // Redo: the cards go *first*, because a `deck_categories` delete CASCADEs whatever is still
    // filed under the pile — and what the redo puts in those cells is the post-delete state,
    // which has nothing in the deleted pile at all.
    // Both read after the delete: the cells that survive it (the target's folded rows, and
    // nothing at all under the deleted pile), and whatever the deck's default actually became —
    // which is `AUTO_CATEGORY` only when it had been pointing at the pile that just went, and
    // otherwise is untouched. Forcing Auto here would reset a default the reader had set to a
    // different pile entirely, on redo, for no reason.
    let cards_after = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    let default_after: i64 = tx
        .query_row(
            "SELECT default_category_id FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![
            crate::deck_undo::Op::Categories {
                restore: category_before,
                patch: vec![],
                delete: vec![],
                default_category_id: Some(default_before),
            },
            crate::deck_undo::Op::Cards {
                scope: cells.clone(),
                rows: cards_before,
            },
        ],
        vec![
            crate::deck_undo::Op::Cards {
                scope: cells,
                rows: cards_after,
            },
            crate::deck_undo::Op::Categories {
                restore: vec![],
                patch: vec![],
                delete: vec![id],
                default_category_id: Some(default_after),
            },
        ],
    )?;
    // Reallocates for [`set_category_active`]'s reason at one remove: the cards either left
    // the deck with the category (the CASCADE) or landed under one whose `is_active` may
    // differ from the one they came from. Either way this deck wants something different
    // than it did a statement ago.
    crate::deck::allocate_deck(&tx, deck_id)?;
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

/// Every tag of one deck, alphabetically, with its counts in the variant asked for —
/// [`list_categories`]'s signature, for [`DeckTagRow::card_count`]'s reason: the two lists
/// come back from one read and must be counted over one list of cards.
pub fn list_tags(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<DeckTagRow>, String> {
    let variant = valid_variant(variant)?;
    let sql = format!("{TAG_SELECT} WHERE t.deck_id = ?1 ORDER BY t.name");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], tag_row)
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
    let audit_id = record_tag(
        &tx,
        deck_id,
        &json!({ "action": "create", "tag": name, "previous": null }),
    )?;
    // Nothing wears it yet, so the label itself is the whole of the change.
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Tags {
            restore: vec![],
            patch: vec![],
            delete: vec![id],
            carriers: vec![],
        }],
        vec![crate::deck_undo::Op::Tags {
            restore: tag_step_row(&tx, id)?,
            patch: vec![],
            delete: vec![],
            carriers: vec![],
        }],
    )?;
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
    // The old name travels with the deck id, for the history: `previous` is what makes a
    // rename readable, and this statement is the last moment the old name exists.
    let tag: Option<(i64, String)> = tx
        .query_row(
            "SELECT deck_id, name FROM deck_tags WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (deck_id, previous) = tag.ok_or_else(|| TAG_GONE.to_owned())?;
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
    // The colour as well as the name. The history row carries only the two names — a recolour
    // shares the `rename` verb because the palette token never appears in a sentence — so this
    // is the second thing an audit-log reversal would have got wrong, quietly.
    let before = tag_step_row(&tx, id)?;
    tx.execute(
        "UPDATE deck_tags SET name = ?2, color = ?3, updated_at = unixepoch() WHERE id = ?1",
        params![id, name, color],
    )
    .map_err(|e| e.to_string())?;
    // `rename` covers a recolour too, which is the honest simplification: the colour is a
    // token from a fixed palette and never appears in a history line, so a second verb would
    // name a distinction no reader could see.
    let audit_id = record_tag(
        &tx,
        deck_id,
        &json!({ "action": "rename", "tag": name, "previous": previous }),
    )?;
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Tags {
            restore: vec![],
            patch: before,
            delete: vec![],
            carriers: vec![],
        }],
        vec![crate::deck_undo::Op::Tags {
            restore: vec![],
            patch: tag_step_row(&tx, id)?,
            delete: vec![],
            carriers: vec![],
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_tag(conn, id)?.ok_or_else(|| TAG_GONE.to_owned())
}

/// Delete a tag. `deck_cards.tag_id` is `ON DELETE SET NULL`, so every card carrying it is
/// left in place, untagged — deleting a tag must never delete a card. Like
/// [`crate::deck::delete_deck`], an id that resolves to nothing is a success: the caller
/// wanted that tag gone, and it is gone (and touches no deck, having none left to touch).
pub fn delete_tag(conn: &Connection, id: i64) -> Result<(), String> {
    // Read rather than `owning_deck`, because the history needs the name as well as the owner
    // — and this is the last statement in which either is knowable.
    let tag: Option<(i64, String)> = conn
        .query_row(
            "SELECT deck_id, name FROM deck_tags WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((deck_id, name)) = tag else {
        return Ok(());
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    // **The label, and every card wearing it.** `deck_cards.tag_id` is `ON DELETE SET NULL`, so
    // the DELETE below silently un-labels N cards and the history row says only that a tag went
    // — `auditText` renders "N cards untagged" from a count. Undo has to put the label back
    // *and* put it back on those cards, which is the only place either fact still exists.
    let before = tag_step_row(&tx, id)?;
    let carriers = crate::deck_undo::read_carriers(&tx, id)?;
    tx.execute("DELETE FROM deck_tags WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    // `previous` is null: this row is about the label, and the label it is about is `tag`.
    // `previous` carries the *former* name of a renamed one and nothing else, so filling it
    // here would make a delete read as a rename that went nowhere.
    let audit_id = record_tag(
        &tx,
        deck_id,
        &json!({ "action": "delete", "tag": name, "previous": null }),
    )?;
    // The carriers ride on the same op as the restore, so they are written after it and can be
    // rewritten through the remap when the label comes back under a fresh id. On the redo side
    // there are none: the delete's own `SET NULL` is what clears them again.
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Tags {
            restore: before,
            patch: vec![],
            delete: vec![],
            carriers,
        }],
        vec![crate::deck_undo::Op::Tags {
            restore: vec![],
            patch: vec![],
            delete: vec![id],
            carriers: vec![],
        }],
    )?;
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
    finish: Option<&str>,
    tag_id: Option<i64>,
) -> Result<(), String> {
    let variant = valid_variant(variant)?;
    // Addresses the row and is never written: since schema v18 a pile can hold the regular copy
    // and the foil as two rows, and a label belongs to one of them.
    let finish = crate::deck::normalise_finish(finish)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The new label's own name, gathered by the ownership fence rather than by a second query:
    // the fence has to read the row anyway, and the history needs the word rather than the id.
    let applied: Option<String> = match tag_id {
        Some(tag) => {
            let row: Option<(i64, String)> = tx
                .query_row(
                    "SELECT deck_id, name FROM deck_tags WHERE id = ?1",
                    params![tag],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            match row {
                Some((d, name)) if d == deck_id => Some(name),
                Some(_) => return Err(TAG_WRONG_DECK.to_owned()),
                None => return Err(TAG_GONE.to_owned()),
            }
        }
        None => None,
    };
    crate::deck::touch_deck(&tx, deck_id)?;
    // The card's name and the label it is wearing *now*, read before the UPDATE replaces one
    // of them. This is also the "is there a row" fence — `DECK_CARD_GRAIN` exactly, so at most
    // one row can match, and a stale editor is refused here rather than by an UPDATE that
    // touched nothing.
    let card: Option<(String, Option<String>)> = tx
        .query_row(
            "SELECT dc.name, t.name
               FROM deck_cards dc LEFT JOIN deck_tags t ON t.id = dc.tag_id
              WHERE dc.deck_id = ?1 AND dc.card_id = ?2 AND dc.category_id = ?3
                AND dc.variant = ?4 AND coalesce(dc.finish, '') = coalesce(?5, '')",
            params![deck_id, card_id, category_id, variant, finish],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (card_name, previous) = card.ok_or_else(|| CARD_NOT_IN_CATEGORY.to_owned())?;
    // The whole row, not just its label. The history carries the two tag *names* and `previous`
    // is `null` for an untagged card — indistinguishable from a card wearing a tag called
    // nothing — while the step carries the id the column actually held.
    let cells = vec![crate::deck_undo::Cell::card(variant, category_id, card_id)];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    tx.execute(
        "UPDATE deck_cards SET tag_id = ?6, updated_at = unixepoch()
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
            AND coalesce(finish, '') = coalesce(?5, '')",
        params![deck_id, card_id, category_id, variant, finish, tag_id],
    )
    .map_err(|e| e.to_string())?;
    // `card_id` set is what marks this the *card's* half of the `tag` kind, and `tag: null` is
    // how a row says the card wears nothing now — clearing a label is as much a change as
    // applying one, and `previous` is the only place the label it lost is written down.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::TAG,
        Some((card_id, &card_name)),
        &json!({ "tag": applied, "previous": previous }),
        0,
    )?;
    crate::deck_undo::record_cells(&tx, audit_id, deck_id, cells, before, None)?;
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
///
/// **The walk has a hop budget**, [`crate::deck::folder_path`]'s reasoning applied to the one
/// place it matters most. This walk is what *keeps* the tree acyclic, so it cannot assume it —
/// and it runs inside `spawn_blocking` **while holding the app-wide write lock**, so a
/// `parent_id` cycle that arrived some other way (a hand-edited database, a restored backup)
/// would not hang this one command: it would deadlock every write in the app for the life of
/// the process. Exceeding the budget is answered as a cycle, which is the only thing a chain
/// that long can be.
pub fn move_folder(
    conn: &Connection,
    id: i64,
    parent_id: Option<i64>,
) -> Result<DeckFolderRow, String> {
    if let Some(start) = parent_id {
        let mut cursor = Some(start);
        let mut hops = 0usize;
        while let Some(candidate) = cursor {
            if candidate == id {
                return Err(FOLDER_CYCLE.to_owned());
            }
            hops += 1;
            if hops > MAX_FOLDER_DEPTH {
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
///
/// **This is the one folder write that records history**, and it is the exception that proves
/// the rule the other three follow: create, rename and move change a folder and no deck, so
/// there is no `deck_audit.deck_id` to file a row under. A delete changes N decks' `folder_id`,
/// and their ids are exactly the ones that changed — so each gets the same
/// [`crate::deck::record_filed`] row that [`crate::deck::set_folder`] writes when the user
/// re-files one deck by hand. Without it this is the single "a deck changed and nothing
/// recorded it" hole in the app.
///
/// **The decks are read before the `DELETE`**, which is the whole of the ordering: afterwards
/// their `folder_id` is already NULL and there is nothing left to say which they were. The
/// recursive term collects the sub-folders `parent_id`'s CASCADE will take too, because their
/// decks are un-filed by the same statement — `UNION`, never `UNION ALL`, so a `parent_id`
/// cycle that arrived from outside this module terminates instead of running forever under the
/// write lock ([`move_folder`]'s hop budget, wearing its other face).
///
/// **`decks.updated_at` is deliberately not moved.** The gallery sorts by it
/// (`deck::list_decks`), and a folder delete would otherwise throw every deck that was in it to
/// the front of the gallery. `set_folder` does move it, and the asymmetry is the point: there
/// the user acted on that one deck and it is meant to rise.
///
/// # It records history and **no undo step**, which is the one place those two part company
///
/// Every other write in this module and in [`crate::deck`] records both. This one cannot, and
/// the reason is structural rather than a gap left open:
///
/// * [`crate::deck_undo`]'s cursor is **per deck** — `deck_undo.deck_id` — so a step can only
///   ever be undone from the editor of the one deck it is filed under. This press changes N
///   decks at once and belongs to none of them.
/// * Putting one deck's `folder_id` back means putting the **folder row** back, and
///   `decks.folder_id` is a real `REFERENCES deck_folders(id)`: restoring the id alone is a
///   foreign-key failure, not a partial success. So an honest reversal has to resurrect the
///   whole deleted subtree — a shared thing, for a step filed under one deck, which the other
///   N−1 decks' cursors would then be able to undo again.
///
/// Undoing this belongs to a folder-level undo in the sidebar, where the unit of the press is.
/// Until there is one, the audit rows say what happened and the reader re-files by hand — which
/// is the same standing [`crate::deck::delete_deck`] has, and for the same reason: a write made
/// from the gallery is not an edit to the deck anybody has open.
pub fn delete_folder(conn: &Connection, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let unfiled: Vec<i64> = {
        let mut stmt = tx
            .prepare(
                "WITH RECURSIVE subtree(id) AS (
                     SELECT ?1
                     UNION
                     SELECT f.id FROM deck_folders f JOIN subtree s ON f.parent_id = s.id
                 )
                 SELECT d.id FROM decks d
                  WHERE d.folder_id IN (SELECT id FROM subtree)
                  ORDER BY d.id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<Vec<i64>>>()
            .map_err(|e| e.to_string())?
    };
    tx.execute("DELETE FROM deck_folders WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    for deck_id in unfiled {
        crate::deck::record_filed(&tx, deck_id, None)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a user's problem, the
/// write itself answers [`crate::db::BUSY`] when the database is busy.
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
    marketplace: Option<String>,
) -> Result<Vec<DeckCategoryRow>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        list_categories(
            &crate::sync::lock_db_read(&state),
            deck_id,
            &variant,
            marketplace,
        )
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
    variant: String,
) -> Result<Vec<DeckTagRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_tags(&crate::sync::lock_db_read(&state), deck_id, &variant)
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
            set_card_tag(c, deck_id, &card_id, category_id, &variant, None, tag_id)
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

    /// The marketplace a test that is **not about prices** reads through —
    /// [`crate::deck`]'s constant, kept per module.
    const ANY_MARKET: crate::sorting::Marketplace = crate::sorting::Marketplace::Tcgplayer;

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
        // A category that already exists for `commander`, under a name a user chose — the v8
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
        let rows = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
        assert_eq!(
            rows.len(),
            0,
            "list_categories must not write — a deck with no categories reads back none"
        );

        ensure_predefined_categories(&conn, deck_id).unwrap();
        let rows = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
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

    // -- origin (schema v15) ----------------------------------------------------------------

    /// One category's stored `origin`, read straight off the table rather than off a
    /// [`DeckCategoryRow`] — what the column holds is the fact, and the DTO is a copy of it.
    fn origin_of(conn: &Connection, id: i64) -> String {
        conn.query_row(
            "SELECT origin FROM deck_categories WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The add path invents a column, so the column is the app's: `'auto'`.
    ///
    /// If this were `'user'` every functional bucket would draw the moment a deck was filed —
    /// a wall of empty Removal/Ramp/Draw headings over three cards, which is the thing the
    /// column exists to prevent.
    #[test]
    fn category_for_name_makes_an_auto_pile() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");

        let id = category_for_name(&conn, deck_id, "Removal").unwrap();

        assert_eq!(origin_of(&conn, id), "auto");
    }

    /// **The whole reason this is a stored fact and not a name comparison.**
    ///
    /// [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) is `(deck_id, name)`, so a
    /// reader who makes their own "Ramp" and later adds a ramp spell has that spell filed into
    /// *their* pile — [`category_for_name`] finds before it creates. The find arm must therefore
    /// touch nothing: were it to write `'auto'` over what it found, or were the drawing rule
    /// reading the name instead, their deliberate pile would silently start hiding itself the
    /// first time they emptied it. That is exactly the case the reader called out as intentional.
    #[test]
    fn category_for_name_leaves_an_existing_user_pile_alone() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let mine = create_category(&conn, deck_id, "Ramp").unwrap();
        assert_eq!(origin_of(&conn, mine.id), "user", "the reader made it");

        let found = category_for_name(&conn, deck_id, "Ramp").unwrap();

        assert_eq!(found, mine.id, "the add path files into the pile they made");
        assert_eq!(
            origin_of(&conn, mine.id),
            "user",
            "and filing a card into it must not turn their pile into an app-made one"
        );
    }

    /// "New category" is a deliberate act, so the pile is the reader's and draws empty.
    #[test]
    fn create_category_makes_a_user_pile() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");

        let row = create_category(&conn, deck_id, "Flex slots").unwrap();

        assert_eq!(row.origin, "user", "on the row the command answers with");
        assert_eq!(origin_of(&conn, row.id), "user", "and in the table");
    }

    /// The four seeded zones count as the reader's, so an empty Sideboard keeps its heading.
    ///
    /// They are nobody's *deliberate* act, which is what makes this worth stating: the rule is
    /// not "did a person type this name" but "may this pile be hidden when it empties", and a
    /// deck's rules zones may not — an empty Sideboard is where the next sideboard card goes.
    /// (Which of the four draw empty is TypeScript's decision on top of this; Commander and
    /// Companion are conditional there for reasons that are about formats, not provenance.)
    #[test]
    fn the_predefined_seed_is_user_made() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");

        ensure_predefined_categories(&conn, deck_id).unwrap();

        let rows = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
        assert_eq!(rows.len(), 4);
        for row in rows {
            assert_eq!(
                row.origin, "user",
                "{} is a rules zone and is never hidden for being empty",
                row.name
            );
        }
    }

    // -- card_count / total_price -----------------------------------------------------------

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

        let live = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
        let commander_live = live.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(commander_live.card_count, 5, "copies, not rows: 2 + 3");

        let theory = list_categories(&conn, deck_id, "theory", ANY_MARKET).unwrap();
        let commander_theory = theory.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(
            commander_theory.card_count, 7,
            "the theory variant is a separate count"
        );
    }

    /// The number a delete confirmation has to quote, and the reason it is a second field.
    ///
    /// The two counts are deliberately made to **differ** — 5 live, 7 theory — because a fixture
    /// where they happen to agree proves nothing at all here: that is exactly the shape every
    /// test had while the confirmation was undercounting, and it is why the bug reached a
    /// reviewer rather than a suite.
    #[test]
    fn card_count_all_variants_counts_both_lists_where_card_count_counts_one() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        crate::schema::tests::seed_card(&conn, "bolt-m10", "m10", "146");
        deck_card(&conn, deck_id, "bolt-lea", cat, 2);
        deck_card(&conn, deck_id, "bolt-m10", cat, 3);
        deck_card_variant(&conn, deck_id, "bolt-lea", cat, "theory", 7);

        for (variant, scoped) in [("live", 5), ("theory", 7)] {
            let rows = list_categories(&conn, deck_id, variant, ANY_MARKET).unwrap();
            let row = rows.iter().find(|c| c.id == cat).unwrap();
            assert_eq!(row.card_count, scoped, "{variant}: the one list asked for");
            assert_eq!(
                row.card_count_all_variants, 12,
                "{variant}: both lists, and the same answer whichever one was asked by — a \
                 category is not per-variant",
            );
        }
    }

    /// The claim the field exists to make true: **what the number quotes is what the delete
    /// takes.** `deck_cards.category_id` is `ON DELETE CASCADE`, so the destructive arm reaches
    /// both lists, and a dialog quoting `card_count` would have promised 5 while taking 12.
    #[test]
    fn deleting_a_category_takes_the_copies_card_count_all_variants_quoted() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Ramp");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 5);
        deck_card_variant(&conn, deck_id, "bolt-lea", cat, "theory", 7);

        let quoted = list_categories(&conn, deck_id, "live", ANY_MARKET)
            .unwrap()
            .iter()
            .find(|c| c.id == cat)
            .unwrap()
            .card_count_all_variants;
        assert_eq!(quoted, 12);

        delete_category(&conn, cat, None).unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT coalesce(sum(quantity), 0) FROM deck_cards WHERE deck_id = ?1",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "all {quoted} copies went, across both lists");
    }

    /// The heading's figure is `unit_price × copies` summed, and a card the marketplace does not
    /// quote is skipped rather than counted at zero.
    ///
    /// **A foil-only printing is not one of those**, and that is what this pins beyond the
    /// arithmetic: it has no nonfoil price anywhere, so while the deck priced its rows at the
    /// literal `'nonfoil'` a Secret Lair in a pile was silently left out of the pile's own total.
    #[test]
    fn total_price_sums_unit_price_times_copies_and_skips_unpriced_cards() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        priced_card(&conn, "priced", "2.00");
        priced_card_both(
            &conn,
            "foil-only",
            r#"{"usd":null,"usd_foil":"1.50","eur":null,"eur_foil":"1.20"}"#,
        );
        crate::schema::tests::seed_card(&conn, "unpriced", "lea", "162");
        deck_card(&conn, deck_id, "priced", cat, 3);
        deck_card(&conn, deck_id, "foil-only", cat, 2);
        deck_card(&conn, deck_id, "unpriced", cat, 5);

        let rows = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
        let row = rows.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(
            row.total_price,
            Some(9.0),
            "3 copies at $2.00 and 2 at the foil-only printing's $1.50, the unpriced card skipped"
        );
    }

    #[test]
    fn total_price_is_none_when_nothing_in_the_category_has_a_price() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        crate::schema::tests::seed_card(&conn, "unpriced", "lea", "162");
        deck_card(&conn, deck_id, "unpriced", cat, 4);

        let rows = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
        let row = rows.iter().find(|c| c.id == cat).unwrap();
        assert_eq!(row.total_price, None);

        // And an empty category beside it: nothing filed, nothing priced, same answer.
        let empty = category(&conn, deck_id, "companion", "Companion");
        let rows = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
        let row = rows.iter().find(|c| c.id == empty).unwrap();
        assert_eq!(row.card_count, 0);
        assert_eq!(row.total_price, None);
    }

    /// A `cards` row carrying more than one currency, written out so two marketplaces have
    /// something to disagree about.
    fn priced_card_both(conn: &Connection, id: &str, prices: &str) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                 prices, raw)
             VALUES (?1, 'o-' || ?1, ?1, 'lea', '161', 'en', 'normal', ?2, '{}')",
            params![id, prices],
        )
        .unwrap();
    }

    /// Rows in `marketplace_prices` — [`crate::collection`]'s helper, kept per module.
    fn seed_feed(conn: &Connection, rows: &[(&str, &str, &str, f64)]) {
        for (marketplace, card_id, finish, price) in rows {
            conn.execute(
                "INSERT OR REPLACE INTO marketplace_prices
                    (marketplace, card_id, finish, price) VALUES (?1,?2,?3,?4)",
                params![marketplace, card_id, finish, price],
            )
            .unwrap();
        }
    }

    /// One total, from the marketplace the read was given — and **legitimately taken over
    /// fewer cards** on some of them: `sum()` skips NULLs, so a printing a shop does not quote
    /// drops out of its figure while staying in another's. Never converted, never filled in
    /// from a neighbour; each number describes one marketplace.
    #[test]
    fn the_category_total_sums_the_marketplace_it_was_asked_for_and_skips_what_it_cannot_quote() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        priced_card_both(&conn, "both", r#"{"usd":"2.00","eur":"1.50"}"#);
        // Etched-only: a dollar price through `usd_etched`, and no euro key of any kind,
        // because `eur_etched` does not exist in Scryfall's data.
        priced_card_both(
            &conn,
            "etched",
            r#"{"usd":"5.00","usd_etched":"25.00","eur":null}"#,
        );
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "both", "nonfoil", 1.00),
                // and no `cardkingdom` row for `etched`.
                ("manapool", "both", "nonfoil", 3.00),
                ("manapool", "etched", "nonfoil", 4.00),
            ],
        );
        deck_card(&conn, deck_id, "both", cat, 3);
        deck_card(&conn, deck_id, "etched", cat, 2);

        let total = |marketplace| {
            list_categories(&conn, deck_id, "live", marketplace)
                .unwrap()
                .iter()
                .find(|c| c.id == cat)
                .unwrap()
                .total_price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(
            total(Tcgplayer),
            Some(3.0 * 2.00 + 2.0 * 5.00),
            "both printings have a nonfoil TCGplayer price"
        );
        assert_eq!(
            total(Cardmarket),
            Some(3.0 * 1.50),
            "and only one of them has a Cardmarket one"
        );
        assert_eq!(
            total(Cardkingdom),
            Some(3.0 * 1.00),
            "the feed lists one of the two, and the other is skipped rather than borrowed"
        );
        assert_eq!(total(Manapool), Some(3.0 * 3.00 + 2.0 * 4.00));
    }

    /// A category every one of whose cards is unpriced at the chosen marketplace reads `None`
    /// there while reading a real number at another. The totals are independent, and none of
    /// them stands in for another.
    #[test]
    fn a_category_priced_at_one_marketplace_has_no_total_at_the_others() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        priced_card(&conn, "usd-only", "2.00");
        deck_card(&conn, deck_id, "usd-only", cat, 4);

        let total = |marketplace| {
            list_categories(&conn, deck_id, "live", marketplace)
                .unwrap()
                .iter()
                .find(|c| c.id == cat)
                .unwrap()
                .total_price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(total(Tcgplayer), Some(8.0));
        for elsewhere in [Cardmarket, Cardkingdom, Manapool] {
            assert_eq!(
                total(elsewhere),
                None,
                "{elsewhere:?}: never 0.00, and never converted"
            );
        }
    }

    /// A write's readback has no marketplace of its own, so it quotes the **stored** setting —
    /// the one the reader is looking at the deck through. A fixed default here would hand the
    /// panel a TCGplayer total the moment a Cardmarket user renamed a column.
    #[test]
    fn a_category_readback_quotes_the_stored_marketplace() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Ramp");
        priced_card_both(&conn, "both", r#"{"usd":"2.00","eur":"1.50"}"#);
        deck_card(&conn, deck_id, "both", cat, 3);

        assert_eq!(
            rename_category(&conn, cat, "Acceleration")
                .unwrap()
                .total_price,
            Some(6.0),
            "a database nobody has told quotes TCGplayer"
        );

        crate::marketplace::store(&conn, "cardmarket").unwrap();
        assert_eq!(
            rename_category(&conn, cat, "Ramp").unwrap().total_price,
            Some(4.5)
        );
    }

    /// The hand-mirrored wire contract for the category row, pinned so a field added here and
    /// never mirrored in `src/lib/ipc.ts` fails the suite rather than rendering `undefined`.
    #[test]
    fn category_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(DeckCategoryRow {
            id: 3,
            deck_id: 7,
            name: "Ramp".to_owned(),
            kind: "custom".to_owned(),
            is_active: true,
            sort_order: 2,
            origin: "auto".to_owned(),
            card_count: 5,
            card_count_all_variants: 12,
            total_price: Some(41.5),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "deckId": 7, "name": "Ramp", "kind": "custom", "isActive": true,
                "sortOrder": 2, "origin": "auto", "cardCount": 5,
                "cardCountAllVariants": 12, "totalPrice": 41.5
            })
        );
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

    /// The walk that *keeps* the tree acyclic cannot assume it is, and this is the case that
    /// proves the hop budget rather than the `candidate == id` arm: a cycle written straight
    /// into the table, between two folders neither of which is the one being moved. The walk
    /// from the proposed parent therefore never meets `id` and would climb for ever — inside
    /// `spawn_blocking`, holding the app-wide write lock, so it is every write in the app that
    /// stops rather than this one command.
    #[test]
    fn deck_folder_move_gives_up_on_a_cycle_it_did_not_write() {
        let conn = conn();
        let a = create_folder(&conn, None, "A").unwrap();
        let b = create_folder(&conn, Some(a.id), "B").unwrap();
        let moving = create_folder(&conn, None, "C").unwrap();
        // Corruption this module cannot produce: a hand-edited database, a restored backup.
        conn.execute(
            "UPDATE deck_folders SET parent_id = ?2 WHERE id = ?1",
            params![a.id, b.id],
        )
        .unwrap();

        let err = move_folder(&conn, moving.id, Some(a.id)).unwrap_err();

        assert_eq!(err, FOLDER_CYCLE, "a sentence, not a hang");
        let unchanged: Option<i64> = conn
            .query_row(
                "SELECT parent_id FROM deck_folders WHERE id = ?1",
                params![moving.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(unchanged, None, "and the refused move wrote nothing");
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

    /// The one "a deck changed and nothing recorded it" hole this table exists to have none of.
    ///
    /// Two decks, one filed in the folder being deleted and one in a sub-folder that CASCADEs
    /// away with it, so the recursive term is what puts the second row in the history at all.
    /// A third deck outside the folder is the control: SET NULL never touched it, so it has
    /// nothing to record. Each row is the same `folder`/`move` shape `set_folder` writes when
    /// the user re-files one deck by hand, with `folder: null` for the root.
    #[test]
    fn deck_folder_delete_records_every_deck_it_un_files() {
        let conn = conn();
        let root = create_folder(&conn, None, "Standard").unwrap();
        let child = create_folder(&conn, Some(root.id), "Aggro").unwrap();
        let filed = deck(&conn, "Burn");
        let nested = deck(&conn, "Prowess");
        let elsewhere = deck(&conn, "Control");
        crate::deck::set_folder(&conn, filed, Some(root.id)).unwrap();
        crate::deck::set_folder(&conn, nested, Some(child.id)).unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        delete_folder(&conn, root.id).unwrap();

        let rows: Vec<(i64, String, String)> = conn
            .prepare("SELECT deck_id, kind, payload FROM deck_audit ORDER BY deck_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows.iter().map(|r| r.0).collect::<Vec<_>>(),
            vec![filed, nested],
            "one row per deck un-filed, and none for the deck that was never in the folder"
        );
        for (_, kind, payload) in &rows {
            assert_eq!(kind, crate::deck_audit::FOLDER);
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(payload).unwrap(),
                serde_json::json!({ "action": "move", "folder": null }),
                "filed nowhere is null, never the empty string"
            );
        }

        // And an empty folder records nothing, because nothing changed.
        let empty = create_folder(&conn, None, "Unused").unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();
        delete_folder(&conn, empty.id).unwrap();
        let after: i64 = conn
            .query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 0);
        assert!(elsewhere > 0, "the control deck exists and was left alone");
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

        set_card_tag(
            &conn,
            deck_id,
            "bolt-lea",
            cat,
            "live",
            None,
            Some(removal.id),
        )
        .unwrap();
        assert_eq!(tag_of(&conn), Some(removal.id));

        // Setting a second tag replaces the first — never both.
        set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", None, Some(ramp.id)).unwrap();
        assert_eq!(tag_of(&conn), Some(ramp.id));

        set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", None, None).unwrap();
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
            None,
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
        let err = set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", None, None).unwrap_err();
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
        set_card_tag(&conn, deck_id, "bolt-lea", cat, "live", None, Some(tag.id)).unwrap();
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
