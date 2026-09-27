//! Deck categories, labels and folders: everything schema v8 (Plan 8, Task 1) carved out of a
//! deck's fixed five-word zone and its bare gallery listing.
//!
//! Shaped like [`crate::deck`] and [`crate::collection`]: pure functions over a `Connection`,
//! testable without a Tauri app, wrapped in `async` commands that run on the blocking pool.
//! Writes take `AppState.db` and answer [`crate::db::BUSY`] rather than waiting.
//!
//! Three tables, three different relationships to "the deck":
//!
//! * **Categories** are *of* one deck (`deck_id NOT NULL`) — a category names a pile within a
//!   deck. Every write to one goes through [`crate::deck::touch_deck`], so the gallery's
//!   "recently edited" order moves the same way a card add or a rename does.
//! * **Labels** were that too until schema v21 made them one app-wide row each, and the
//!   `deck_id` the three writes take is now the deck the reader was *standing in* rather than
//!   the one the label belongs to. **It is optional**: [`create_label`], [`update_label`] and
//!   [`delete_label`] each take `Option<i64>`, because the Appearance panel in Settings edits
//!   the app-wide list with no deck open. A deckless call does the label write and nothing
//!   else — no `touch_deck`, no `deck_audit` row, no undo step — and the trade that makes is
//!   pinned by `a_deckless_label_write_records_no_audit_and_no_undo`.
//! * **Folders** are not of any deck at all — they file decks the way a filesystem directory
//!   files files, and `decks.folder_id` is `ON DELETE SET NULL` rather than the CASCADE every
//!   category and label write takes. No folder write touches a deck's `updated_at`, and three
//!   of the four record nothing in `deck_audit` (which is `deck_id NOT NULL` — creating, renaming
//!   or moving a folder changes no deck, so there is no deck to name). **[`delete_folder`] is
//!   the exception**: SET NULL re-files every deck in the folder and in the sub-folders that
//!   CASCADE with it, so it writes one `folder` row per deck it un-filed. The `folder` audit
//!   *kind* is not about folder CRUD even there: it records a **deck being filed**, and the
//!   other two writers of it are `deck::update_deck` and `deck::set_folder`.
//!
//! Every category write, and every label write **that names a deck**, records one
//! [`crate::deck_audit`] row inside its own transaction, so a refused write leaves no history.
//! (`deck_audit.deck_id` is `NOT NULL`, which is the other half of why a deckless label write
//! records nothing: there is no row it could write.) The `label` kind covers two events and
//! `card_id` is what tells them apart: a card wearing a label (`set_card_label`, `card_id` set)
//! and the label itself being made, renamed or deleted (`card_id` NULL, and an `action` verb —
//! without one a delete would read as a labelling).
//!
//! **No write here reallocates any more, and two of them used to.** `is_active` decided whether
//! a card was allocated *for*, so [`set_category_active`] and [`delete_category`] each rebuilt
//! this deck's claims inside their own transaction, the way every card write in
//! [`crate::deck`] did. Schema v25 dropped `deck_allocations`: what a deck holds is where its
//! collection rows physically sit, and switching a pile off changes what the deck *counts*
//! without moving a single card. The rule the old note was making — that a rename and a reorder
//! change what a pile is called and nothing about what is in it — now covers every write in the
//! module.

#[cfg(not(target_family = "wasm"))]
use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// What an *adjustment* to a category says when the id it names is not there — the same
/// asymmetry [`crate::collection::GONE`] draws against a delete that finds nothing.
pub const CATEGORY_GONE: &str = "That category is not there any more.";

/// What [`create_category`] and [`rename_category`] say when the name they were asked to
/// take is already spoken for. [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) —
/// `deck_id, variant, name` since user schema v53 — is the unique index behind this: a caller
/// that skipped this check would hit a raw "UNIQUE constraint failed" instead.
///
/// **"This list", not "this deck"**, because that is the scope the grain holds: a theory pile
/// may share a name with a live one, and a reader who meets this sentence on the Theory tab has
/// collided with another *theory* pile.
pub const CATEGORY_NAME_TAKEN: &str = "This list already has a category with that name.";

/// What [`delete_category`] says when `moveToCategoryId` names a category of a *different*
/// deck. Nothing in the DDL stops that INSERT — `deck_cards.category_id` only requires the
/// category to exist, not that it belongs to the same deck as the row being moved — so this
/// is the fence, not a CHECK.
///
/// `pub`, not private: [`crate::deck::category_of_deck`] draws the same distinction for every
/// card write, and two spellings of one refusal is two sentences a reader could meet for one
/// mistake.
pub const CATEGORY_WRONG_DECK: &str = "That category belongs to a different deck.";

/// What a write says when the pile it was handed is this deck's but belongs to the **other
/// list** (user schema v53, issue #561). A deck's Theory and Actual lists are two versions of
/// the deck with a pile set each, and a `deck_cards` row filed under the other list's pile would
/// draw a column on one tab out of a card on the other. Nothing in the DDL can say so — the
/// foreign key asks only that the pile exist, and `variant` is on both tables with no key
/// between them — so this sentence is the fence, beside [`CATEGORY_WRONG_DECK`] and for its
/// reason: "not yours" and "not this list's" are two mistakes a stale editor can make.
pub const CATEGORY_WRONG_LIST: &str = "That category belongs to the other list.";

/// What [`reorder_categories`] says when the ids it was handed are piles of **both** lists. The
/// two lists order their piles independently since user schema v53, so a list naming both is
/// not an order anybody drew — it is two panels' state stitched together, and writing positions
/// out of it would interleave one list's `sort_order` with the other's.
pub const CATEGORY_MIXED_LISTS: &str = "Those categories belong to two different lists.";

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

/// What an *adjustment* to a label says when the id it names is not there.
pub const LABEL_GONE: &str = "That label is not there any more.";

/// [`CATEGORY_NAME_TAKEN`]'s twin for [`DECK_LABEL_GRAIN`](crate::schema::DECK_LABEL_GRAIN) —
/// and it says **app-wide** where the category one says "this deck", because since schema v21
/// that is the difference between the two grains. The name it refuses is refused by
/// `label_name_key`'s comparison rather than by the word: `removal` collides with `Removal`, and
/// so does a `Café` spelled with a combining accent against one spelled without.
///
/// The sentence names the way out, because a reader who typed a name that exists has not made
/// a mistake — they have found the label they wanted and are one press away from using it.
pub const LABEL_NAME_TAKEN: &str =
    "A label with that name already exists. Pick it from the list instead of making a second one.";

/// What [`set_card_label`] says when the `(deckId, cardId, categoryId, variant)` it was handed
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

/// One category of one list of one deck, with the two numbers that are read at the same moment
/// a category panel would want them rather than in a second round trip.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCategoryRow {
    pub id: i64,
    pub deck_id: i64,
    /// Which list the pile belongs to — `live` (drawn as *Actual*) or `theory` — one of
    /// [`crate::schema::DECK_VARIANTS`] (user schema v53, issue #561).
    ///
    /// **A pile belongs to exactly one list**, and every other field here is that list's own:
    /// each list has its four predefined zones, its own `is_active`, its own `sort_order`, its
    /// own names. The two lists are separate versions of the deck and the theory diff is the only
    /// thing that reads across them, which is why no write here reaches the other list's piles
    /// and why a card write refuses a pile of the other list ([`CATEGORY_WRONG_LIST`]).
    pub variant: String,
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
    /// [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) is `(deck_id, variant, name)`,
    /// so [`category_for_name`] *finds* a pile the reader made rather than making a second one —
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
    /// Copies filed here, `sum(quantity)` and not a row count — two different printings at 2 and
    /// 3 copies read 5, not 2.
    ///
    /// **It is also the number a delete confirmation quotes**, and until user schema v53 it was
    /// not: a pile was shared by both lists, so this counted the one list asked by while the
    /// CASCADE took both, and a sibling `card_count_all_variants` carried the other number. A pile
    /// holds one list's cards now, so the two always agreed and the second field went. The
    /// subquery still names `dc.variant = cat.variant` — the fence every card write holds, read
    /// back rather than assumed, so a row some older build filed across the lists is not counted
    /// on a tab that does not draw it.
    pub card_count: i64,
    /// Unit price × copies at the marketplace the read was given, summed over the same rows
    /// [`DeckCategoryRow::card_count`] counts. `None` when nothing filed here has a price there — `deck.rs`'s own
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

/// One label **in use in one list of one deck** — what [`list_labels`] answers.
///
/// It carried a `deck_id` until schema v21 and does not any more, because there is no such
/// fact: a label is one app-wide row ([`DECK_LABEL_GRAIN`](crate::schema::DECK_LABEL_GRAIN)) and
/// what a deck has is not a list of labels but a list of *cards*, some of which wear one. So
/// this row is a label **and** a fact about the deck the caller asked by — which is why the two
/// arguments are not symmetric and why `deck_label_list` cannot answer a label nothing is wearing.
/// [`GlobalLabel`] is the other half: every label there is, including those.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckLabelRow {
    pub id: i64,
    pub name: String,
    pub color: String,
    /// Copies carrying this label, `sum(quantity)` for [`DeckCategoryRow::card_count`]'s reason,
    /// scoped to the one `variant` the caller asked by — exactly as that field is.
    ///
    /// The two have to agree, and briefly did not: [`crate::deck::get_deck`] threaded its
    /// variant into [`list_categories`] and not into [`list_labels`], so a Theory read came back
    /// with Theory category counts beside **Live** label counts. Nothing drew the number yet, so
    /// nothing was visibly wrong; the contract was, which is the cheaper thing to fix.
    /// A label write's own readback is a [`GlobalLabel`] and needs no variant at all.
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

/// One label as a thing in itself — [`list_all_labels`]'s row, and what every label *write*
/// answers.
///
/// **No deck in it, and that is the whole shape of the feature.** A label is one row the app
/// owns; the two counts say how far its reach goes, which is the fact a reader needs before
/// recolouring or deleting one. Both span every deck and both variants, deliberately: the
/// question these numbers answer is "what else moves if I change this", and an answer scoped to
/// the deck on screen would understate it in exactly the way that matters.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalLabel {
    pub id: i64,
    pub name: String,
    pub color: String,
    /// Copies wearing it anywhere — `sum(quantity)`, [`DeckCategoryRow::card_count`]'s unit.
    pub card_count: i64,
    /// Decks with at least one card wearing it. `0` for a label made and never used, which is
    /// the one row `deck_label_list` can never answer and this list always can.
    pub deck_count: i64,
}

/// A name good enough for a category, a label or a folder — trimmed, non-empty.
/// [`crate::deck::valid_name`]'s discipline, generalised to the three more places a blank
/// string would end up on a tile no one can read. `what` is what the refusal names.
pub(crate) fn valid_name<'a>(name: &'a str, what: &str) -> Result<&'a str, String> {
    let name = name.trim();
    (!name.is_empty())
        .then_some(name)
        .ok_or_else(|| format!("{what} needs a name."))
}

/// A label colour good enough to store — non-empty, and nothing more. `deck_labels.color` carries
/// no CHECK: it names a token from the app's fixed palette (schema.rs's own words), and
/// picking from that palette is the webview's job, not this module's — the boundary CLAUDE.md
/// draws between Rust's data plumbing and TypeScript's domain logic.
pub(crate) fn valid_color(color: &str) -> Result<&str, String> {
    let color = color.trim();
    (!color.is_empty())
        .then_some(color)
        .ok_or_else(|| "A label needs a colour.".to_owned())
}

/// A deck variant the schema knows, refused in words rather than as a CHECK failure — the
/// same discipline `collection::valid_finish` applies to the finish enum, over
/// [`crate::schema::DECK_VARIANTS`].
///
/// `pub(crate)`: every card command in [`crate::deck`] opens with it too. It lives here
/// because `deck_categories` and `deck_labels` are this module's, and one definition of "is
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

/// The deck and the list a pile belongs to, or `None` when it is not there at all — distinct
/// from `Some` of the wrong deck or the wrong list, because [`delete_category`]'s move target and
/// [`reorder_categories`]' ids each need to tell "gone", "not yours" and — since user schema
/// v53 — "not this list's" ([`CATEGORY_WRONG_LIST`]) apart to answer the right sentence.
///
/// It replaced an `owning_deck(conn, table, id)` that answered the deck alone and served labels
/// too until schema v21 took the deck off a label; the pile was its last caller.
pub(crate) fn pile_owner(conn: &Connection, id: i64) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "SELECT deck_id, variant FROM deck_categories WHERE id = ?1",
        params![id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The position a new pile takes in one list: one past the last. Scoped to `(deck, variant)`
/// since user schema v53, because each list orders its own piles and a pile made on the Theory
/// tab should land at the end of *that* tab rather than after every live pile too.
fn next_sort_order(conn: &Connection, deck_id: i64, variant: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT coalesce(max(sort_order), -1) + 1 FROM deck_categories
          WHERE deck_id = ?1 AND variant = ?2",
        params![deck_id, variant],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------------------

/// Create the four non-`main` predefined categories one list of a deck is missing, and leave the
/// ones it already has untouched. Safe to call on any deck, as many times as asked.
///
/// **Per list since user schema v53** (issue #561): each list has its own Commander, Sideboard,
/// Companion and Maybeboard, so a Sideboard switched off on the Theory tab stays on on the
/// Actual one. [`crate::deck::create_deck`] seeds `live` always and `theory` when the deck is
/// born with a plan; [`crate::deck::update_deck`] seeds `theory` when the plan is switched on.
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
pub fn ensure_predefined_categories(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<(), String> {
    let variant = valid_variant(variant)?;
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

    let mut next_order = next_sort_order(conn, deck_id, variant)?;

    for (kind, name, is_active) in crate::schema::PREDEFINED_CATEGORIES {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deck_categories
                                WHERE deck_id = ?1 AND variant = ?2 AND kind = ?3)",
                params![deck_id, variant, kind],
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
                (deck_id, variant, name, kind, is_active, sort_order, origin,
                 created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'user', unixepoch(), unixepoch())",
            params![deck_id, variant, name, kind, is_active, next_order],
        )
        .map_err(|e| e.to_string())?;
        next_order += 1;
    }
    Ok(())
}

/// Every column of a [`DeckCategoryRow`] but the WHERE clause, which each caller below
/// supplies — [`crate::deck::DECK_SELECT`]'s shape.
///
/// **The counts are read in the pile's own list, `dc.variant = cat.variant`**, where until user
/// schema v53 they were read in a variant the caller bound. A pile belongs to one list now, so
/// the question "in which list do I count" has one answer and it is on the row — which is also
/// what lets a write's readback ([`read_category`]) count a theory pile's theory cards without
/// a variant of its own to ask by.
fn category_select(marketplace: crate::sorting::Marketplace) -> String {
    format!(
        "SELECT cat.id, cat.deck_id, cat.variant, cat.name, cat.kind, cat.is_active,
            cat.sort_order, cat.origin,
            coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                       WHERE dc.category_id = cat.id AND dc.variant = cat.variant), 0),
            (SELECT sum(dc.quantity * ({price}))
               FROM deck_cards dc LEFT JOIN cards c ON c.id = dc.card_id
              WHERE dc.category_id = cat.id AND dc.variant = cat.variant)
       FROM deck_categories cat",
        price = crate::sorting::printing_price_by_finish_expr(marketplace)
    )
}

fn category_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckCategoryRow> {
    Ok(DeckCategoryRow {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        variant: r.get(2)?,
        name: r.get(3)?,
        kind: r.get(4)?,
        is_active: r.get(5)?,
        sort_order: r.get(6)?,
        origin: r.get(7)?,
        card_count: r.get(8)?,
        total_price: r.get(9)?,
    })
}

/// The marketplace a **write's own readback** quotes: the stored setting.
///
/// A rename carries no marketplace of its own, but there *is* a right answer for one — the
/// setting the reader is looking at the deck through. A fixed default here would hand the panel
/// a TCGplayer total the moment a Cardmarket user renamed a column. (The variant needs no such
/// answer: since user schema v53 a pile's counts are read in its own list, see
/// [`category_select`].)
fn readback_marketplace(conn: &Connection) -> crate::sorting::Marketplace {
    crate::sorting::Marketplace::from_id(&crate::marketplace::stored(conn))
}

fn read_category(conn: &Connection, id: i64) -> Result<Option<DeckCategoryRow>, String> {
    conn.query_row(
        &format!(
            "{} WHERE cat.id = ?1",
            category_select(readback_marketplace(conn))
        ),
        params![id],
        category_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every category of one list of one deck, in display order.
///
/// **Only that list's piles** since user schema v53 (issue #561) — `variant` scoped only the
/// counts before, and every pile was drawn on both tabs, so a pile made on the Theory tab
/// appeared on the Actual one as an empty heading the reader had made on purpose.
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
        "{} WHERE cat.deck_id = ?1 AND cat.variant = ?2 ORDER BY cat.sort_order, cat.id",
        category_select(marketplace)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], category_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Find a category of one list by name, or make one there — a **new one is always
/// `kind = 'main'`**, but the lookup is by name alone and will happily answer with a predefined
/// category.
///
/// **`variant` is the list being written** (user schema v53, issue #561): a card filed into the
/// theory list lands in the theory list's pile of that name, made there if the plan has none,
/// and never in the live list's — the two lists keep separate piles. The add path's
/// "find its card category or create it"; unlike [`create_category`], which refuses a name
/// already taken, this is meant to be handed the same name over and over and answer the same
/// id every time.
///
/// **The lookup cannot be narrowed to `kind = 'main'`, and this is the trap.**
/// [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) is `(deck_id, variant, name)` —
/// one name per list, whatever its kind — so a `kind = 'main'` lookup would miss the list's
/// predefined `Sideboard` and then fail the INSERT below on a UNIQUE violation rather than
/// answering an id. Finding it is the only thing this function *can* do.
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
pub fn category_for_name(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    name: &str,
) -> Result<i64, String> {
    let variant = valid_variant(variant)?;
    let name = valid_name(name, "A category")?;
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND variant = ?2 AND name = ?3",
            params![deck_id, variant, name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(id);
    }
    let next_order = next_sort_order(conn, deck_id, variant)?;
    // **`'auto'`, and only on this branch** — the one the app reaches when it had to invent a
    // column for a card it was filing. The lookup above is what makes that safe to record as a
    // fact: a pile the *reader* made is found rather than re-made, so it keeps its `'user'`
    // forever even once the add path starts filing cards into it. That is the case a
    // name-matching rule gets wrong and this gets right for free —
    // `category_for_name_leaves_an_existing_user_pile_alone` is the pin.
    conn.query_row(
        "INSERT INTO deck_categories (deck_id, variant, name, kind, is_active, sort_order,
                                       origin, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'main', 1, ?4, 'auto', unixepoch(), unixepoch())
         RETURNING id",
        params![deck_id, variant, name, next_order],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// The pile in list `variant` that stands for pile `source` of the other list — found, or made
/// there as a copy of it. The one rule the theory switch and "copy Actual into the plan" share
/// for carrying a card across the lists (user schema v53, issue #561), where until then both
/// simply kept the card's `category_id`, because the two lists shared one pile set.
///
/// **Matched by kind for a predefined zone and by name for everything else**, and the
/// difference is the two unique indexes: a list holds at most one pile of each non-`main` kind
/// (`idx_deck_categories_kind`) and one pile of each name (`idx_deck_categories_grain`). So a
/// live Sideboard lands in the plan's Sideboard whatever it is called, and a live "Ramp" in the
/// plan's "Ramp" — including one the reader made on the Theory tab themselves, which is found and
/// never made twice. A predefined zone the plan somehow lacks is looked for by name next, so a
/// plan whose `main` pile happens to hold that name is used rather than colliding with it.
///
/// **A pile made here copies the source's kind, `is_active`, `sort_order` and `origin`** — a copy
/// has the same shape as its original, [`crate::deck::duplicate_deck`]'s rule for this column,
/// so an `auto` pile the app invented stays hidden when empty on the other tab too. It is one of
/// the writers [`DeckCategoryRow::origin`] names, and like `duplicate_deck` it copies rather than
/// deciding.
///
/// Takes the caller's transaction and records nothing: both callers file a step whose pile diff
/// (`deck_undo::push_made_categories`) is what undoes the piles this made.
pub(crate) fn counterpart_in(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    source: i64,
) -> Result<i64, String> {
    let variant = valid_variant(variant)?;
    let (name, kind, is_active, sort_order, origin): (String, String, bool, i64, String) = conn
        .query_row(
            "SELECT name, kind, is_active, sort_order, origin FROM deck_categories
              WHERE id = ?1 AND deck_id = ?2",
            params![source, deck_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| CATEGORY_GONE.to_owned())?;
    if kind != "main" {
        if let Some(id) = conn
            .query_row(
                "SELECT id FROM deck_categories
                  WHERE deck_id = ?1 AND variant = ?2 AND kind = ?3",
                params![deck_id, variant, kind],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            return Ok(id);
        }
    }
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND variant = ?2 AND name = ?3",
            params![deck_id, variant, name],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
    {
        return Ok(id);
    }
    conn.query_row(
        "INSERT INTO deck_categories (deck_id, variant, name, kind, is_active, sort_order,
                                       origin, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch(), unixepoch())
         RETURNING id",
        params![deck_id, variant, name, kind, is_active, sort_order, origin],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Make a new `kind = 'main'` category in one list. Refuses a name that list already has —
/// [`category_for_name`]'s opposite number, for the command a user presses "New category" on.
///
/// **`variant` is the tab the reader pressed it on** (user schema v53, issue #561): the pile is
/// made in that list only, and the other list may already hold, or later make, a pile of the same
/// name without either one refusing.
pub fn create_category(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    name: &str,
) -> Result<DeckCategoryRow, String> {
    let variant = valid_variant(variant)?;
    let name = valid_name(name, "A category")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deck_categories
                            WHERE deck_id = ?1 AND variant = ?2 AND name = ?3)",
            params![deck_id, variant, name],
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
    let next_order = next_sort_order(&tx, deck_id, variant)?;
    // **`'user'`: this is the reader pressing "New category"**, which is the whole of what
    // separates this function from [`category_for_name`]. A pile made here draws whether or not
    // anything is in it — it was created with intent, and an empty one is where the next card
    // of that kind goes.
    let id: i64 = tx
        .query_row(
            "INSERT INTO deck_categories (deck_id, variant, name, kind, is_active, sort_order,
                                           origin, created_at, updated_at)
             VALUES (?1, ?2, ?3, 'main', 1, ?4, 'user', unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, variant, name, next_order],
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
    read_category(conn, id)?.ok_or_else(|| CATEGORY_GONE.to_owned())
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

/// One undo step for a category or label write, with the two `Step::new` lines every caller here
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

/// The same for a label.
fn label_step_row(tx: &Connection, id: i64) -> Result<Vec<crate::deck_undo::LabelRow>, String> {
    Ok(crate::deck_undo::read_label(tx, id)?.into_iter().collect())
}

/// One `label`-kind history row **about the label itself** — created, renamed or deleted. No
/// card, and an `action` verb: see the module doc for why the two halves of this kind share it.
fn record_label(tx: &Connection, deck_id: i64, payload: &serde_json::Value) -> Result<i64, String> {
    crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::LABEL,
        None,
        payload,
        0,
    )
}

/// Rename a `kind = 'main'` category. Refuses a predefined one
/// ([`predefined_refusal`]) and a name another pile **of the same list** already has
/// ([`CATEGORY_NAME_TAKEN`]) — a theory pile may take a name a live pile holds, since user
/// schema v53, because the two lists keep separate piles.
pub fn rename_category(conn: &Connection, id: i64, name: &str) -> Result<DeckCategoryRow, String> {
    let name = valid_name(name, "A category")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let (deck_id, variant, current_name, kind): (i64, String, String, String) = tx
        .query_row(
            "SELECT deck_id, variant, name, kind FROM deck_categories WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
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
                            WHERE deck_id = ?1 AND variant = ?2 AND name = ?3 AND id <> ?4)",
            params![deck_id, variant, name, id],
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
    read_category(conn, id)?.ok_or_else(|| CATEGORY_GONE.to_owned())
}

/// Flip `is_active`. Every category answers to this, `commander` included — see
/// [`DeckCategoryRow::is_active`]'s doc for why there is no kind check here at all.
///
/// **Reallocates nothing**, where until schema v25 it was the one write here that did:
/// `is_active` was the whole of what the allocator allocated *for*, so switching a pile off
/// handed its copies back to every other deck. A deck holds what sits in its group, and a
/// switched-off pile is a pile the reader is not counting rather than cards they have put down.
pub fn set_category_active(
    conn: &Connection,
    id: i64,
    is_active: bool,
) -> Result<DeckCategoryRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The name comes back with the deck id for the history's sake: a row that said only
    // "deactivated category 41" is a row nobody can read once the panel is closed.
    let category: Option<(i64, String, String)> = tx
        .query_row(
            "SELECT deck_id, name, variant FROM deck_categories WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (deck_id, name, variant) = category.ok_or_else(|| CATEGORY_GONE.to_owned())?;
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
    // **The token reconcile, by hand** — this step is built without `deck_undo::record_cells`,
    // which is where every other card write gets it. A pile switched off counts toward nothing,
    // so its cards make no tokens, and a Treasure only they made loses its entries in that pile's
    // list — only that one since user schema v53, because the pile holds one list's cards. They
    // ride this step, so switching the pile back on with Ctrl+Z brings the reader's Treasure
    // printings back with it; switching it on by hand brings the Treasure back as its implicit
    // entry, which is rule 7's own promise.
    let removed = crate::deck_tokens::reconcile_in(&tx, deck_id, &[variant.as_str()])?;
    let mut undo = vec![crate::deck_undo::Op::Categories {
        restore: vec![],
        patch: before,
        delete: vec![],
        default_category_id: None,
    }];
    let mut redo = vec![crate::deck_undo::Op::Categories {
        restore: vec![],
        patch: category_step_row(&tx, id)?,
        delete: vec![],
        default_category_id: None,
    }];
    crate::deck_undo::push_removed_tokens(removed, &mut undo, &mut redo);
    record_category_step(&tx, audit_id, deck_id, undo, redo)?;
    tx.commit().map_err(|e| e.to_string())?;
    read_category(conn, id)?.ok_or_else(|| CATEGORY_GONE.to_owned())
}

/// Write `sort_order` from position in `ids`. An id that does not belong to `deck_id` — the
/// wrong deck, or gone entirely — matches no row in the `WHERE id = ?1 AND deck_id = ?2` guard
/// and is silently skipped rather than refusing the whole reorder over one stale entry.
///
/// **The ids must be piles of one list** (user schema v53, issue #561): each list orders its own
/// piles, so a reorder naming this deck's live and theory piles together is refused with
/// [`CATEGORY_MIXED_LISTS`] before anything is written, rather than writing one list's positions
/// through the other's. The readback is that list's piles — the list the reorder was drawn from.
pub fn reorder_categories(
    conn: &Connection,
    deck_id: i64,
    ids: &[i64],
) -> Result<Vec<DeckCategoryRow>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    // The one list every id this deck owns belongs to. A stale id (gone, or another deck's) says
    // nothing about the list and is skipped here as the UPDATE below skips it; an empty answer —
    // nothing in `ids` is this deck's — reads back the live list, the one the editor opens on.
    let mut list: Option<String> = None;
    for id in ids {
        if let Some((owner, variant)) = pile_owner(&tx, *id)? {
            if owner != deck_id {
                continue;
            }
            match &list {
                Some(seen) if *seen != variant => return Err(CATEGORY_MIXED_LISTS.to_owned()),
                Some(_) => {}
                None => list = Some(variant),
            }
        }
    }
    let list = list.unwrap_or_else(|| crate::schema::DECK_VARIANTS[0].to_owned());
    // **Every pile of the list, both sides.** The history row is a bare `{"action":"reorder"}` —
    // it names no category *and no order*, deliberately, because the drawer records changes
    // rather than state — so this is the one write whose reversal the audit log cannot even
    // begin to describe. `read_categories` is in id order and each row carries its own
    // `sort_order`. Narrowed to the reordered list since user schema v53: the other list's piles
    // did not move, and carrying them would let an unstepped change over there (a sync pull)
    // retire the undo of a reorder that never touched them.
    let list_piles = |tx: &Connection| -> Result<Vec<crate::deck_undo::CategoryRow>, String> {
        Ok(crate::deck_undo::read_categories(tx, deck_id)?
            .into_iter()
            .filter(|c| c.variant == list)
            .collect())
    };
    let before = list_piles(&tx)?;
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
            patch: list_piles(&tx)?,
            delete: vec![],
            default_category_id: None,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    list_categories(conn, deck_id, &list, readback_marketplace(conn))
}

/// Delete a `kind = 'main'` category — refuses a predefined one, [`predefined_refusal`] again.
///
/// **`moveToCategoryId: Some(id)` moves the cards first, in the same transaction**, folding on
/// [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) — `deck_id, variant, category_id,
/// card_id` — into a target that must be a pile of **the same deck and the same list**
/// ([`CATEGORY_WRONG_DECK`], [`CATEGORY_WRONG_LIST`]): since user schema v53 a pile holds one
/// list's cards, and moving them under the other list's pile would file a theory card in a
/// column only the Actual tab draws. `None` leaves the
/// `ON DELETE CASCADE` on `deck_cards.category_id` to take the cards with the category, which
/// is the DDL's own comment on that column: "deleting a category deletes the cards filed under
/// it, which is what the confirm dialog says it will do."
///
/// One command for both, because the confirm dialog offers both and a caller that had to do
/// the move and the delete as two round trips could lose the cards between them if the second
/// one failed.
///
/// **The copies behind the deleted cards come back, and only in the `None` arm.** A `deck_cards`
/// row is an intention and the CASCADE is right to take it; a row in the deck's **group** is a
/// card the reader physically owns, and deleting a pile does not stop them owning it. So every
/// copy the group holds for a `live` row of this category is filed into `Recently removed`
/// first, through [`crate::deck::release_live_copies`] — the same act
/// [`crate::collection_alloc::deck_to_collection`] performs one card at a time. Left undone the
/// copies stay filed under a deck that has never heard of them, invisible until the reader
/// wonders why a card they own is unavailable to every deck they have.
///
/// The move arm moves nothing at all: those cards stay in this deck, one pile over, so the
/// group is still the right place for the copies behind them. And deleting a `theory` pile moves
/// nothing either, in either arm — a plan holds no cards
/// ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`]), so there is nothing in any folder behind
/// one.
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
    let (deck_id, variant, name, kind): (i64, String, String, String) = tx
        .query_row(
            "SELECT deck_id, variant, name, kind FROM deck_categories WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| CATEGORY_GONE.to_owned())?;
    if kind != "main" {
        return Err(predefined_refusal(&name));
    }
    if let Some(target) = move_to_category_id {
        match pile_owner(&tx, target)? {
            Some((d, v)) if d == deck_id && v == variant => {}
            Some((d, _)) if d == deck_id => return Err(CATEGORY_WRONG_LIST.to_owned()),
            Some(_) => return Err(CATEGORY_WRONG_DECK.to_owned()),
            None => return Err(CATEGORY_GONE.to_owned()),
        }
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    // Counted **before** anything moves or cascades, and in copies rather than rows — two
    // printings at 2 and 3 is 5 cards, which is what the confirm dialog warned about. Every row
    // under the pile, which since user schema v53 is one list's rows: a pile holds its own list's
    // cards and no other's, so this is exactly the `cardCount` the dialog quoted.
    //
    // **This is a count of `deck_cards`, never of the copies that move.** The two can differ
    // wherever the group holds fewer copies than the list claims, and what the dialog warns
    // about is what leaves the deck.
    let cards: i64 = tx
        .query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards WHERE category_id = ?1",
            params![id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // **The undo step's "before", and the single largest thing the audit log could not
    // describe.** That row records `{"action":"delete","name":"Ramp","cards":7}` — a *count* of
    // what the CASCADE took, and a count cannot rebuild a pile. These are the cards themselves.
    //
    // **What it still cannot put back is the custody**, and that is worth knowing rather than
    // rediscovering: the step restores `deck_cards`, while the copies behind them have gone to
    // `Recently removed` and stay there. An undone delete gives the reader their list back with
    // its owned counts at zero until they file the copies again — the same place a cut card
    // leaves them, which has never been undoable either.
    //
    // Two cells, not one: **the deleted pile and the target**, because the move arm folds on
    // `DECK_CARD_GRAIN` into whatever the target already held. Without the target's own cell,
    // undoing a delete-with-move would put the deleted pile back and leave the folded copies in
    // the target as well — the deck would gain cards by being un-deleted. Both in the pile's own
    // list, which since user schema v53 is the only list either pile holds cards of; this read
    // four cells, one per list per pile, while a pile was shared by both.
    let mut cells = vec![crate::deck_undo::Cell::pile(&variant, id)];
    if let Some(target) = move_to_category_id {
        cells.push(crate::deck_undo::Cell::pile(&variant, target));
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
    // **The copies the CASCADE is about to strand**, released through
    // [`crate::deck::release_live_copies`] — which owns the ordering, the `live` fence and the
    // walk, so what is left here is only *why this scope*. **Only the `None` arm**: the move arm
    // re-files these cards into another pile of the same deck, so the group is still exactly
    // where their copies belong — and it is fenced by this `if` rather than left to the move's
    // own DELETE having emptied the pile first, because that is an ordering an edit three
    // statements away can undo without meaning to.
    //
    // The pile's own variant is passed, and the helper's `live` fence does the rest: a theory
    // pile's rows are a plan's, and a plan holds no copies to release.
    if move_to_category_id.is_none() {
        crate::deck::release_live_copies(&tx, deck_id, &variant, Some(id))?;
    }
    if let Some(target) = move_to_category_id {
        // `deck::move_card`'s INSERT … SELECT … ON CONFLICT shape verbatim, over categories
        // instead of zones. The `DO UPDATE` touches only `quantity`/`updated_at`: a row the
        // target already holds keeps its own `label_id` and `needs_review`, never the moved
        // row's — the same "the existing row wins a fold" rule `move_card`'s comment names.
        let sql = format!(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, label_id, quantity, needs_review, created_at, updated_at)
             SELECT deck_id, ?2, variant, card_id, set_code, collector_number, lang, name,
                    label_id, quantity, needs_review, unixepoch(), unixepoch()
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
    // **The token reconcile, by hand, over the pile's list** — [`set_category_active`]'s reason,
    // and the CASCADE's reach: the cards under the pile went, so a token only they made goes.
    // One list since user schema v53, because the pile held one list's cards. Last on both sides
    // of the step, after the pile and its cards, because nothing it restores points at either.
    let removed = crate::deck_tokens::reconcile_in(&tx, deck_id, &[variant.as_str()])?;
    let mut undo = vec![
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
    ];
    let mut redo = vec![
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
    ];
    crate::deck_undo::push_removed_tokens(removed, &mut undo, &mut redo);
    record_category_step(&tx, audit_id, deck_id, undo, redo)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------

/// Every label in use in one list of one deck, **most-used first** — [`DeckLabelRow`]'s read.
///
/// ## Why membership is a join and not a column
///
/// It was `WHERE t.deck_id = ?1` until schema v21, when labels became app-wide. There is no
/// deck on the row to filter by any more, so "this deck's labels" is derived from the only place
/// the fact now lives: the cards. A label is in this list because something in it is wearing the
/// label, which is also exactly what the right-click menu wants to offer — one definition of
/// "in use", serving the menu, the dialog and the counts.
///
/// ## `variant` scopes membership now, where it used to scope only the count
///
/// **A deliberate widening, and the issue asks for it in those words**: the live list and the
/// theory list are treated as different decks where labels are concerned. A label worn only by
/// theory rows is not offered while the reader is editing live, because offering it there would
/// be offering a fact about a list they are not looking at. It costs nothing to reach — the
/// label is still in [`list_all_labels`], one section down in the dialog.
///
/// ## The order
///
/// Copies descending, then name, where this used to be alphabetical throughout. Most-used
/// first is what the issue asks for and it is right for a menu: the label a reader reaches for
/// is overwhelmingly the one they have already used most in this very deck, and an alphabet
/// puts that wherever its first letter happens to fall. `t.name` breaks the tie so the answer
/// is stable rather than SQLite's row order.
pub fn list_labels(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<DeckLabelRow>, String> {
    let variant = valid_variant(variant)?;
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.color, sum(dc.quantity)
               FROM deck_labels t
               JOIN deck_cards dc ON dc.label_id = t.id
              WHERE dc.deck_id = ?1 AND dc.variant = ?2
              GROUP BY t.id, t.name, t.color
              ORDER BY sum(dc.quantity) DESC, t.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], |r| {
            Ok(DeckLabelRow {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                card_count: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Every label there is, most-used first — [`GlobalLabel`]'s read, and **the only list that can
/// answer a label no card is wearing**.
///
/// It replaced `tag_suggestions` — the label was called a tag then, and the function name is
/// left as it was written because nothing answers to it any more — which grouped the table on
/// `(name, color)` and answered names rather than rows. That shape existed because two decks
/// could hold two rows spelling one word, and picking a "suggestion" *copied* it into the deck
/// you were in. Schema v21 removed the thing it was working around: there is one row per name
/// now, so this answers ids, and picking one **uses** that label rather than making a second one.
///
/// `LEFT JOIN`, so a label worn by nothing is a row with two zeroes rather than a row that is
/// not there. That is the whole reason a reader can make a label in the Labels dialog before any
/// card wears it and still find it afterwards.
pub fn list_all_labels(conn: &Connection) -> Result<Vec<GlobalLabel>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.color,
                    coalesce(sum(dc.quantity), 0),
                    count(DISTINCT dc.deck_id)
               FROM deck_labels t
               LEFT JOIN deck_cards dc ON dc.label_id = t.id
              GROUP BY t.id, t.name, t.color
              ORDER BY coalesce(sum(dc.quantity), 0) DESC, t.name",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(GlobalLabel {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                card_count: r.get(3)?,
                deck_count: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One label by id, as [`GlobalLabel`] — every write's readback.
///
/// **A write answers the global row, not a [`DeckLabelRow`]**, and the change is not cosmetic:
/// a create, a rename and a recolour are all app-wide acts now, so the honest answer is the
/// thing that changed rather than one deck's view of it. It also retires `READBACK_VARIANT` for
/// labels — that constant existed because a rename carries no variant and something had to pick
/// one to count by, and a global row's counts are not scoped by a variant at all.
fn read_global_label(conn: &Connection, id: i64) -> Result<Option<GlobalLabel>, String> {
    conn.query_row(
        "SELECT t.id, t.name, t.color,
                coalesce(sum(dc.quantity), 0),
                count(DISTINCT dc.deck_id)
           FROM deck_labels t
           LEFT JOIN deck_cards dc ON dc.label_id = t.id
          WHERE t.id = ?1
          GROUP BY t.id, t.name, t.color",
        params![id],
        |r| {
            Ok(GlobalLabel {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
                card_count: r.get(3)?,
                deck_count: r.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Whether some **other** row already holds this name, by
/// [`label_name_key`](crate::schema::label_name_key)'s comparison rather than by the word.
///
/// `except` is the row allowed to hold it — `None` for a create, the row's own id for a rename,
/// which is what lets a reader recapitalise `removal` to `Removal` without being told the name
/// is taken by itself.
fn label_name_is_taken(conn: &Connection, key: &str, except: Option<i64>) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM deck_labels
                        WHERE name_key = ?1 AND id IS NOT ?2)",
        params![key, except],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Make a label. **App-wide** — `deck_id` says where the reader was standing, for the history
/// row and the undo step, and is not stored on the label.
///
/// **`deck_id` is optional, and its absence is the Appearance panel.** A label is one app-wide row
/// and always was (schema v21); the deck is what the *side effects* need — its `updated_at`, and
/// the history entry the editor's dialog draws. A call from Settings has no deck to name, so it
/// makes the label and writes no history: no [`crate::deck::touch_deck`], no `deck_audit` row and
/// no undo step. **The trade is that such an edit is in no deck's undo stack.** Naming one deck
/// for a change that reaches every deck wearing the label would be a false entry, and naming all
/// of them is a feature nobody asked for — so the entry is simply not written. See
/// `a_deckless_label_write_records_no_audit_and_no_undo` in this module's tests.
///
/// Refuses a name any label already holds ([`LABEL_NAME_TAKEN`]). That refusal is the issue's
/// second half and it is enforced here rather than in the webview, because uniqueness is a
/// property of the table: the dialog steering a reader away from a duplicate is a courtesy, and
/// two windows racing the same new name is what a UNIQUE index is for.
pub fn create_label(
    conn: &Connection,
    deck_id: Option<i64>,
    name: &str,
    color: &str,
) -> Result<GlobalLabel, String> {
    let name = valid_name(name, "A label")?;
    let color = valid_color(color)?;
    let key = crate::schema::label_name_key(name);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if label_name_is_taken(&tx, &key, None)? {
        return Err(LABEL_NAME_TAKEN.to_owned());
    }
    // **The deck's side effects, and only when there is a deck** — see this function's doc.
    if let Some(deck_id) = deck_id {
        crate::deck::touch_deck(&tx, deck_id)?;
    }
    let id: i64 = tx
        .query_row(
            "INSERT INTO deck_labels (name, name_key, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![name, key, color],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if let Some(deck_id) = deck_id {
        let audit_id = record_label(
            &tx,
            deck_id,
            &json!({ "action": "create", "label": name, "previous": null }),
        )?;
        // Nothing wears it yet, so the label itself is the whole of the change.
        record_category_step(
            &tx,
            audit_id,
            deck_id,
            vec![crate::deck_undo::Op::Labels {
                restore: vec![],
                patch: vec![],
                delete: vec![id],
                carriers: vec![],
            }],
            vec![crate::deck_undo::Op::Labels {
                restore: label_step_row(&tx, id)?,
                patch: vec![],
                delete: vec![],
                carriers: vec![],
            }],
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_global_label(conn, id)?.ok_or_else(|| LABEL_GONE.to_owned())
}

/// Rename and/or recolour a label, **everywhere at once**.
///
/// This is the change the issue is chiefly about: one row means one colour, so a reader who
/// recolours "Cut candidate" here recolours it in the nine other decks wearing it, and there is
/// no longer a way for the same word to be two colours. Refuses a name another row holds.
///
/// `deck_id` is the deck the reader was standing in and is used for nothing but the history row
/// and the undo step. It is honest rather than arbitrary: the change is global, but the *act*
/// happened somewhere, and a history that could not say where would be a worse record than one
/// that names the deck the reader pressed it in.
///
/// **And it is optional for [`create_label`]'s reason** — a rename from the Appearance panel was
/// pressed in no deck at all, so it renames the label and records nothing.
pub fn update_label(
    conn: &Connection,
    deck_id: Option<i64>,
    id: i64,
    name: &str,
    color: &str,
) -> Result<GlobalLabel, String> {
    let name = valid_name(name, "A label")?;
    let color = valid_color(color)?;
    let key = crate::schema::label_name_key(name);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The old name, for the history and for the choice of verb: this statement is the last
    // moment it still exists.
    let label: Option<String> = tx
        .query_row(
            "SELECT name FROM deck_labels WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let previous = label.ok_or_else(|| LABEL_GONE.to_owned())?;
    if label_name_is_taken(&tx, &key, Some(id))? {
        return Err(LABEL_NAME_TAKEN.to_owned());
    }
    if let Some(deck_id) = deck_id {
        crate::deck::touch_deck(&tx, deck_id)?;
    }
    // Read before the UPDATE below rewrites it, and only worth reading when there is a step to
    // put it in.
    let before = match deck_id {
        Some(_) => label_step_row(&tx, id)?,
        None => vec![],
    };
    tx.execute(
        "UPDATE deck_labels SET name = ?2, name_key = ?3, color = ?4, updated_at = unixepoch()
          WHERE id = ?1",
        params![id, name, key, color],
    )
    .map_err(|e| e.to_string())?;
    // **Two verbs now, where `rename` used to cover both.** It covered both because a colour
    // was one of six palette tokens and never appeared in a sentence, so a second verb would
    // have named a distinction no reader could see. Both halves of that have gone: the colour
    // is the reader's own hex, and it is the same colour in every deck — so "Recoloured label
    // Ramp" is a line a reader may well come back looking for. `auditText` has rendered
    // `recolour` since before anything wrote it.
    if let Some(deck_id) = deck_id {
        let payload = if previous == name {
            json!({ "action": "recolour", "label": name, "previous": null, "color": color })
        } else {
            json!({ "action": "rename", "label": name, "previous": previous, "color": color })
        };
        let audit_id = record_label(&tx, deck_id, &payload)?;
        record_category_step(
            &tx,
            audit_id,
            deck_id,
            vec![crate::deck_undo::Op::Labels {
                restore: vec![],
                patch: before,
                delete: vec![],
                carriers: vec![],
            }],
            vec![crate::deck_undo::Op::Labels {
                restore: vec![],
                patch: label_step_row(&tx, id)?,
                delete: vec![],
                carriers: vec![],
            }],
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_global_label(conn, id)?.ok_or_else(|| LABEL_GONE.to_owned())
}

/// Take a label off **this deck's cards in one list**, leaving the label itself alone.
///
/// **The action the global list needed and the per-deck one never did.** While a label belonged
/// to a deck, "I am done with this label here" and "this label should stop existing" were the
/// same press. They are not any more, and conflating them would mean a reader tidying one deck
/// silently stripping the label off nine others. So the row in the deck's own section offers
/// this, and deleting a label outright is a separate act on the app-wide list.
///
/// Scoped to `variant` for [`list_labels`]'s reason: the row this press is on was drawn from one
/// list, so the press is about that list. A label worn by theory rows survives being removed
/// from live.
///
/// Answers how many rows lost the label. Zero is a success, not a refusal — the caller wanted
/// this deck's cards not to wear it and they do not.
pub fn remove_label_from_deck(
    conn: &Connection,
    deck_id: i64,
    label_id: i64,
    variant: &str,
) -> Result<i64, String> {
    let variant = valid_variant(variant)?;
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM deck_labels WHERE id = ?1",
            params![label_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let name = name.ok_or_else(|| LABEL_GONE.to_owned())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Exactly the rows about to be cleared, read before the UPDATE that clears them — the only
    // place the fact still exists once it has run.
    let carriers = crate::deck_undo::read_carriers_in(&tx, label_id, deck_id, variant)?;
    if carriers.is_empty() {
        return Ok(0);
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    let cleared = tx
        .execute(
            "UPDATE deck_cards SET label_id = NULL, updated_at = unixepoch()
              WHERE deck_id = ?1 AND variant = ?2 AND label_id = ?3",
            params![deck_id, variant, label_id],
        )
        .map_err(|e| e.to_string())? as i64;
    let audit_id = record_label(
        &tx,
        deck_id,
        &json!({ "action": "remove", "label": name, "previous": null, "cards": cleared }),
    )?;
    // No `restore`, no `delete`: the label was never touched. The whole of the change is which
    // cards were wearing it, so the whole of the reversal is the carriers.
    record_category_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Labels {
            restore: vec![],
            patch: vec![],
            delete: vec![],
            carriers: carriers.clone(),
        }],
        vec![crate::deck_undo::Op::Labels {
            restore: vec![],
            patch: vec![],
            delete: vec![],
            // The same cells, wearing nothing: a redo re-clears exactly what the undo put
            // back, and does it by address rather than by re-running the UPDATE.
            carriers: carriers
                .iter()
                .map(|c| crate::deck_undo::Carrier {
                    label_id: None,
                    ..c.clone()
                })
                .collect(),
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(cleared)
}

/// Delete a label **from the whole app**. `deck_cards.label_id` is `ON DELETE SET NULL`, so
/// every card carrying it anywhere is left in place, unlabelled — deleting a label must never
/// delete a card. Like [`crate::deck::delete_deck`], an id that resolves to nothing is a
/// success: the caller wanted that label gone, and it is gone.
///
/// **The reach is the app's now, and the confirmation is what owes the reader that.** A label
/// worn in six decks comes off the cards in six decks; [`GlobalLabel::deck_count`] exists so the
/// dialog can say the number before the press rather than after it.
///
/// `deck_id` is where the reader was standing — [`update_label`]'s argument, for its reason, and
/// **optional for [`create_label`]'s**. A deckless delete still deletes the label everywhere and
/// still un-labels every card that wore it, through the same `SET NULL`; what it does not do is
/// touch a deck, write the `delete` history row or file an undo step — so those cards cannot be
/// re-labelled by Ctrl+Z, and the `cards` count that row carries is never computed.
pub fn delete_label(conn: &Connection, deck_id: Option<i64>, id: i64) -> Result<(), String> {
    // Read rather than through a deck-owner lookup, which means nothing for a label: the history
    // needs the name, and this is the last statement in which it is knowable.
    let name: Option<String> = conn
        .query_row(
            "SELECT name FROM deck_labels WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(name) = name else {
        return Ok(());
    };
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // **The label, and every card wearing it in every deck.** The DELETE below silently
    // un-labels them through the FK's `SET NULL`, and the history row says only that a label
    // went — so undo has to put the label back *and* put it back on those cards, which is the
    // only place either fact still exists. `Carrier` carries its own `deck_id` for exactly this
    // reason: the carriers of a global delete are not all in the deck the press happened in.
    //
    // **Both reads are the history's and the DELETE needs neither** — it names the label by id
    // and nothing else — but they have to happen *before* it, so the guard is here rather than
    // around the block below. A deckless delete reads nothing extra at all.
    let history = match deck_id {
        Some(deck_id) => {
            crate::deck::touch_deck(&tx, deck_id)?;
            Some((
                label_step_row(&tx, id)?,
                crate::deck_undo::read_carriers(&tx, id)?,
            ))
        }
        None => None,
    };
    tx.execute("DELETE FROM deck_labels WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let (Some(deck_id), Some((before, carriers))) = (deck_id, history) {
        let cards: i64 = carriers.len() as i64;
        // `previous` is null: this row is about the label, and the one it is about is named by
        // the `label` key. `previous` carries the *former* name of a renamed one and nothing
        // else, so filling it here would make a delete read as a rename that went nowhere.
        // `cards` is what `auditText`'s "N cards unlabelled" is rendered from — it has always
        // been read and was never written until the reach became worth stating.
        let audit_id = record_label(
            &tx,
            deck_id,
            &json!({ "action": "delete", "label": name, "previous": null, "cards": cards }),
        )?;
        // The carriers ride on the same op as the restore, so they are written after it and can
        // be rewritten through the remap when the label comes back under a fresh id. On the redo
        // side there are none: the delete's own `SET NULL` is what clears them again.
        record_category_step(
            &tx,
            audit_id,
            deck_id,
            vec![crate::deck_undo::Op::Labels {
                restore: before,
                patch: vec![],
                delete: vec![],
                carriers,
            }],
            vec![crate::deck_undo::Op::Labels {
                restore: vec![],
                patch: vec![],
                delete: vec![id],
                carriers: vec![],
            }],
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Set (or clear) the one label a deck card carries. **A card carries 0 or 1 labels** — the whole
/// of that rule is the `label_id` column itself; nothing here enforces it beyond writing to it.
///
/// Identifies the row by `(deckId, cardId, categoryId, variant, finish)` —
/// [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) exactly, so at most one row can match.
/// A row that no longer matches — moved, folded, stepped to zero since the editor last read it
/// — answers [`CARD_NOT_IN_CATEGORY`], `deck::card_gone`'s reason.
///
/// **`finish` is part of that address, and dropping it is not a harmless simplification** — which
/// is the shape this had until 2026-09-03. The *command* declared no `finish` and handed the
/// helper `None`, so the fence below matched only rows whose finish is null: every foil and
/// etched row answered `CARD_NOT_IN_CATEGORY` for a row sitting right there, and 148 of the 611
/// rows in the developer's own database are one of those. The frontend had been sending `finish`
/// the whole time — Tauri discards a payload field the command does not declare, so neither side
/// could say so. Nothing went red either, because the Storybook fake matched on four fields too.
///
/// **The wrong-deck fence went with schema v21 and left nothing behind.** It refused a `labelId`
/// that resolved to another deck's label, which was a real hazard while a label was per-deck: the
/// FK only checked that the id existed. There is no other deck's label any more — every row in
/// `deck_labels` is every deck's — so the only refusal left is [`LABEL_GONE`], for an id that
/// resolves to nothing at all.
pub fn set_card_label(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: i64,
    variant: &str,
    finish: Option<&str>,
    label_id: Option<i64>,
) -> Result<(), String> {
    let variant = valid_variant(variant)?;
    // Addresses the row and is never written: since schema v18 a pile can hold the regular copy
    // and the foil as two rows, and a label belongs to one of them.
    let finish = crate::deck::normalise_finish(finish)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // The new label's own name — the history needs the word rather than the id, and the same
    // read is what stands between a stale editor and a `label_id` pointing at nothing.
    let applied: Option<String> = match label_id {
        Some(label) => {
            let row: Option<String> = tx
                .query_row(
                    "SELECT name FROM deck_labels WHERE id = ?1",
                    params![label],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Some(row.ok_or_else(|| LABEL_GONE.to_owned())?)
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
               FROM deck_cards dc LEFT JOIN deck_labels t ON t.id = dc.label_id
              WHERE dc.deck_id = ?1 AND dc.card_id = ?2 AND dc.category_id = ?3
                AND dc.variant = ?4 AND coalesce(dc.finish, '') = coalesce(?5, '')",
            params![deck_id, card_id, category_id, variant, finish],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let (card_name, previous) = card.ok_or_else(|| CARD_NOT_IN_CATEGORY.to_owned())?;
    // The whole row, not just its label. The history carries the two label *names* and `previous`
    // is `null` for an unlabelled card — indistinguishable from a card wearing a label called
    // nothing — while the step carries the id the column actually held.
    let cells = vec![crate::deck_undo::Cell::card(variant, category_id, card_id)];
    let before = crate::deck_undo::read_cells(&tx, deck_id, &cells)?;
    tx.execute(
        "UPDATE deck_cards SET label_id = ?6, updated_at = unixepoch()
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4
            AND coalesce(finish, '') = coalesce(?5, '')",
        params![deck_id, card_id, category_id, variant, finish, label_id],
    )
    .map_err(|e| e.to_string())?;
    // `card_id` set is what marks this the *card's* half of the `label` kind, and `label: null` is
    // how a row says the card wears nothing now — clearing a label is as much a change as
    // applying one, and `previous` is the only place the label it lost is written down.
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::LABEL,
        Some((card_id, &card_name)),
        &json!({ "label": applied, "previous": previous }),
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
/// unlike a category or a label, `deck_folders` carries no grain constant and no unique index
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

/// The cycle walk itself, in one place because [`move_folder`] and [`reorder_folders`] both owe
/// it and a refusal written twice is a refusal that comes to disagree with itself. `start` is an
/// id rather than an `Option`, because the root is nobody's descendant and a move there has
/// nothing to climb. [`move_folder`] is where the reasoning is written down — what the walk
/// guards, and why the hop budget is not about depth.
fn refuse_cycle(conn: &Connection, id: i64, start: i64) -> Result<(), String> {
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
    Ok(())
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
        refuse_cycle(conn, id, start)?;
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

/// File a whole row of siblings at once: every `id` in `ids` gets `parent_id` as its parent and
/// its **position in the slice** as its `sort_order`. `ids` is that parent's complete child list
/// in the order the reader just dropped it into; `None` is the root, as everywhere in this
/// module.
///
/// **One command doing both jobs, deliberately.** A drag re-parents and positions in one
/// gesture, and the two as separate writes are a moment when the folder is under its new parent
/// at its old number — a state the reader can see and nobody chose. One transaction is what
/// makes that moment unreachable.
///
/// **Nothing writes `sort_order` from a position anywhere else.** [`create_folder`] hands out
/// `max + 1` and [`move_folder`] leaves the column alone, so a folder's number was whatever it
/// was given at birth until this landed.
///
/// **Every id is fenced before anything is written**, [`refuse_cycle`] rather than a second copy
/// of the walk: an id that *is* `parent_id`, or an ancestor of it, is exactly as fatal here as
/// it is in [`move_folder`], because it is the same `ON DELETE CASCADE` onto the same table that
/// would then walk forever.
///
/// **An id that is not there is [`FOLDER_GONE`]**, which is [`move_folder`]'s answer to the same
/// mistake and not [`reorder_categories`]' silent skip: that one is scoped to a deck and drops a
/// category belonging to another, where a folder id is the entire subject of this write and a
/// stale one means the tree on screen is not the tree in the database.
///
/// **No `kind` fence, because `deck_folders` has no `kind` column.** Only
/// [`crate::collection_folders`] can have a folder the app owns, so only its `reorder_folders`
/// refuses one; the asymmetry is the schema's rather than an omission here.
///
/// **No history and no undo step**, like [`create_folder`], [`rename_folder`] and
/// [`move_folder`]: `deck_audit` rows are filed under a `deck_id`, and reordering folders
/// changes no deck. [`delete_folder`] is this module's one exception and says why there.
pub fn reorder_folders(
    conn: &Connection,
    parent_id: Option<i64>,
    ids: &[i64],
) -> Result<Vec<DeckFolderRow>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if let Some(start) = parent_id {
        for id in ids {
            refuse_cycle(&tx, *id, start)?;
        }
    }
    for (order, id) in ids.iter().enumerate() {
        let changed = tx
            .execute(
                "UPDATE deck_folders SET parent_id = ?2, sort_order = ?3, updated_at = unixepoch()
                  WHERE id = ?1",
                params![id, parent_id, order as i64],
            )
            .map_err(|e| e.to_string())?;
        if changed == 0 {
            return Err(FOLDER_GONE.to_owned());
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    list_folders(conn)
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
#[cfg(not(target_family = "wasm"))]
fn unfinished(e: tauri::Error) -> String {
    format!("the deck's categories, labels or folders could not be written: {e}")
}

/// The category panel. **Read-only connection** — see [`list_categories`]'s doc: it backfills
/// nothing any more, so this never needs to contend for the write mutex.
#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_category_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
    name: String,
) -> Result<DeckCategoryRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_category(c, deck_id, &variant, &name))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_category_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    move_to_category_id: Option<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **Plain `with_write` even though the cascade arm writes `collection_entries`** —
        // `deck::deck_clear`'s note, and [`crate::deck::release_live_copies`] carries the
        // argument: the release re-files rows between folders, and the facet index's `owned`
        // dimension names no folder.
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, |c| delete_category(c, id, move_to_category_id))
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only** connection, like every list in this module.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_label_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    variant: String,
) -> Result<Vec<DeckLabelRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_labels(&crate::sync::lock_db_read(&state), deck_id, &variant)
    })
    .await
    .map_err(|e| format!("the deck's labels could not be read: {e}"))?
}

/// **`deck_id` is optional, and its absence is the Appearance panel.** A label is one app-wide row
/// and always was; the deck is what the *side effects* need — its `updated_at`, and the history
/// entry the editor's dialog draws. A call from Settings has no deck to name, so it makes the
/// label and writes no history. See the module tests for the trade.
///
/// **Tauri fills a missing `Option` argument with `None`**, so the deck editor's existing calls,
/// which send `deckId`, are unchanged.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_label_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: Option<i64>,
    name: String,
    color: String,
) -> Result<GlobalLabel, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_label(c, deck_id, &name, &color))
    })
    .await
    .map_err(unfinished)?
}

/// `deck_id` is where the reader was standing, not what is being changed — see
/// [`update_label`], which is app-wide. Optional, for [`deck_label_create`]'s reason: a rename
/// made from Settings names no deck and records nothing.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_label_update(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: Option<i64>,
    id: i64,
    name: String,
    color: String,
) -> Result<GlobalLabel, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| update_label(c, deck_id, id, &name, &color))
    })
    .await
    .map_err(unfinished)?
}

/// Deletes the label **everywhere**, and answers nothing. `deck_id` is where the reader was, and
/// is optional for [`deck_label_create`]'s reason — a deckless delete still un-labels every card,
/// and writes no history and no undo step.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_label_delete(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: Option<i64>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_label(c, deck_id, id))
    })
    .await
    .map_err(unfinished)?
}

/// Answers how many rows lost the label — see [`remove_label_from_deck`], which leaves the label
/// itself alone.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_label_remove_from_deck(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    label_id: i64,
    variant: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            remove_label_from_deck(c, deck_id, label_id, &variant)
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only**, and the one command in this module with no deck id at all — see
/// [`list_all_labels`]'s doc.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_label_all(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<GlobalLabel>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_all_labels(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the label list could not be read: {e}"))?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_card_set_label(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    finish: Option<String>,
    label_id: Option<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            set_card_label(
                c,
                deck_id,
                &card_id,
                category_id,
                &variant,
                finish.as_deref(),
                label_id,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only**, like every list in this module.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_folder_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DeckFolderRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_folders(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck folders could not be read: {e}"))?
}

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

#[cfg(not(target_family = "wasm"))]
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

/// The drag's own command — see [`reorder_folders`] for why re-parenting and positioning are one
/// write. It answers the **whole** folder list rather than the rows it moved, like
/// [`deck_category_reorder`]: every sibling's number changed, so a caller handed only the moved
/// rows would have to guess at the rest.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_folder_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    parent_id: Option<i64>,
    ids: Vec<i64>,
) -> Result<Vec<DeckFolderRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_folders(c, parent_id, &ids))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
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
        crate::schema::memory_pair()
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

    /// [`category`] for the **theory** list — the same raw insert with the variant spelled out.
    /// A pile belongs to one list since user schema v53, so a fixture that files theory cards
    /// needs a theory pile to file them under; `category` names no variant and takes the
    /// column's `'live'` default.
    fn theory_category(conn: &Connection, deck_id: i64, kind: &str, name: &str) -> i64 {
        conn.query_row(
            "INSERT INTO deck_categories
                (deck_id, variant, name, kind, is_active, sort_order, created_at, updated_at)
             VALUES (?1, 'theory', ?2, ?3, ?4, 0, unixepoch(), unixepoch()) RETURNING id",
            params![deck_id, name, kind, i64::from(kind != "maybe")],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The `collection_folders` row that stands for a deck — an INSERT rather than
    /// [`crate::deck::create_deck`], because [`crate::schema::tests::deck`] writes the `decks`
    /// row directly and every fixture in this module is built on it. Only the handful of tests
    /// that are *about* custody need one, which is why it is not in the fixture.
    fn group_for(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        conn.query_row(
            "INSERT INTO collection_folders
                 (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             VALUES (NULL, ?1, 'deck', ?2, 0, unixepoch(), unixepoch())
             RETURNING id",
            params![name, deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One collection row filed straight into a folder — what "this deck holds these copies"
    /// means since schema v25.
    fn file_into(conn: &Connection, folder: i64, card_id: &str, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                 (card_id, set_code, collector_number, lang, finish, condition, quantity,
                  folder_id, created_at, updated_at)
             VALUES (?1, 'lea', '161', 'en', 'nonfoil', 'NM', ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![card_id, quantity, folder],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Copies of one printing sitting in one folder, summed — a split leaves two rows where
    /// there was one, and the question is how many *cards* are in a place.
    fn folder_copies(conn: &Connection, folder: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM collection_entries
              WHERE folder_id = ?1 AND card_id = ?2",
            params![folder, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The one holding area `Recently removed`, which schema v25 creates exactly one of.
    fn removed_group(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .expect("every database past v25 has one `removed` folder")
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

        ensure_predefined_categories(&conn, deck_id, "live").unwrap();

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
        ensure_predefined_categories(&conn, deck_id, "live").unwrap();
        ensure_predefined_categories(&conn, deck_id, "live").unwrap();
        ensure_predefined_categories(&conn, deck_id, "live").unwrap();

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

        ensure_predefined_categories(&conn, deck_id, "live").unwrap();

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

        ensure_predefined_categories(&conn, deck_id, "live").unwrap();
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

        let first = category_for_name(&conn, deck_id, "live", "Removal").unwrap();
        let second = category_for_name(&conn, deck_id, "live", "Removal").unwrap();
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

        let id = category_for_name(&conn, deck_id, "live", "Removal").unwrap();

        assert_eq!(origin_of(&conn, id), "auto");
    }

    /// **The whole reason this is a stored fact and not a name comparison.**
    ///
    /// [`DECK_CATEGORY_GRAIN`](crate::schema::DECK_CATEGORY_GRAIN) is `(deck_id, variant, name)`,
    /// so a reader who makes their own "Ramp" and later adds a ramp spell has that spell filed into
    /// *their* pile — [`category_for_name`] finds before it creates. The find arm must therefore
    /// touch nothing: were it to write `'auto'` over what it found, or were the drawing rule
    /// reading the name instead, their deliberate pile would silently start hiding itself the
    /// first time they emptied it. That is exactly the case the reader called out as intentional.
    #[test]
    fn category_for_name_leaves_an_existing_user_pile_alone() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let mine = create_category(&conn, deck_id, "live", "Ramp").unwrap();
        assert_eq!(origin_of(&conn, mine.id), "user", "the reader made it");

        let found = category_for_name(&conn, deck_id, "live", "Ramp").unwrap();

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

        let row = create_category(&conn, deck_id, "live", "Flex slots").unwrap();

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

        ensure_predefined_categories(&conn, deck_id, "live").unwrap();

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

    /// Copies, not rows — and **each list's pile counts its own list** (user schema v53). The
    /// two lists' Commander zones are two piles now, so the live one reads 5 and the theory one
    /// 7, and neither list lists the other's pile at all.
    #[test]
    fn card_count_is_copies_not_rows_and_each_list_counts_its_own_pile() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "commander", "Commander");
        let plan = theory_category(&conn, deck_id, "commander", "Commander");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        crate::schema::tests::seed_card(&conn, "bolt-m10", "m10", "146");
        // Two different printings in `live`, 2 and 3 copies: a row count would read 2.
        deck_card(&conn, deck_id, "bolt-lea", cat, 2);
        deck_card(&conn, deck_id, "bolt-m10", cat, 3);
        // The plan's own copy, under the plan's own pile.
        deck_card_variant(&conn, deck_id, "bolt-lea", plan, "theory", 7);

        let live = list_categories(&conn, deck_id, "live", ANY_MARKET).unwrap();
        assert_eq!(
            live.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![cat],
            "the live list lists the live pile and no other"
        );
        assert_eq!(live[0].card_count, 5, "copies, not rows: 2 + 3");
        assert_eq!(live[0].variant, "live");

        let theory = list_categories(&conn, deck_id, "theory", ANY_MARKET).unwrap();
        assert_eq!(theory.iter().map(|c| c.id).collect::<Vec<_>>(), vec![plan]);
        assert_eq!(theory[0].card_count, 7, "the plan's pile counts the plan");
        assert_eq!(theory[0].variant, "theory");
    }

    /// **What the delete confirmation quotes is what the delete takes**, and since user schema
    /// v53 that number is the one `card_count` — which is why `card_count_all_variants` went.
    /// Deleting the live Ramp takes the live Ramp's five copies and leaves the plan's own Ramp,
    /// and its seven, exactly where they were.
    #[test]
    fn deleting_a_category_takes_the_copies_card_count_quoted_and_nothing_of_the_other_list() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Ramp");
        let plan = theory_category(&conn, deck_id, "main", "Ramp");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 5);
        deck_card_variant(&conn, deck_id, "bolt-lea", plan, "theory", 7);

        let quoted = list_categories(&conn, deck_id, "live", ANY_MARKET)
            .unwrap()
            .iter()
            .find(|c| c.id == cat)
            .unwrap()
            .card_count;
        assert_eq!(quoted, 5);

        delete_category(&conn, cat, None).unwrap();
        let left = |variant: &str| -> i64 {
            conn.query_row(
                "SELECT coalesce(sum(quantity), 0) FROM deck_cards
                  WHERE deck_id = ?1 AND variant = ?2",
                params![deck_id, variant],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(left("live"), 0, "all {quoted} live copies went");
        assert_eq!(left("theory"), 7, "and the plan's pile was never touched");
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
            variant: "theory".to_owned(),
            name: "Ramp".to_owned(),
            kind: "custom".to_owned(),
            is_active: true,
            sort_order: 2,
            origin: "auto".to_owned(),
            card_count: 5,
            total_price: Some(41.5),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "deckId": 7, "variant": "theory", "name": "Ramp", "kind": "custom",
                "isActive": true, "sortOrder": 2, "origin": "auto", "cardCount": 5,
                "totalPrice": 41.5
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
        create_category(&conn, deck_id, "live", "Removal").unwrap();
        let err = create_category(&conn, deck_id, "live", "Removal").unwrap_err();
        assert_eq!(err, CATEGORY_NAME_TAKEN);
    }

    #[test]
    fn deck_category_rename_refuses_a_duplicate_name() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        create_category(&conn, deck_id, "live", "Removal").unwrap();
        let counters = create_category(&conn, deck_id, "live", "Counters").unwrap();
        let err = rename_category(&conn, counters.id, "Removal").unwrap_err();
        assert_eq!(err, CATEGORY_NAME_TAKEN);
    }

    #[test]
    fn deck_category_rename_writes_the_new_name() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let counters = create_category(&conn, deck_id, "live", "Counters").unwrap();

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

    /// **Deleting a category gives the copies behind its cards back.** The CASCADE takes the
    /// `deck_cards` rows, which is right — an intention dies with the pile it was filed in — but
    /// a row in the deck's **group** is a card the reader physically owns. Left where it was, it
    /// would sit filed under a deck that has never heard of it: invisible on the collection page
    /// under a folder for a pile that is gone, and unavailable to every other deck for ever.
    ///
    /// **The split is the half worth seeding.** The group holds one row for the grain, four
    /// copies backing two piles, so deleting one may take three of them and no more.
    ///
    /// **And a theory pile's copies are not a thing**, which is the second claim: a plan holds
    /// no cards, so deleting the plan's own Ramp and the 5 theory copies the CASCADE takes with
    /// it puts nothing on the desk and takes nothing out of the group.
    #[test]
    fn deleting_a_category_files_its_copies_into_recently_removed() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let group = group_for(&conn, deck_id, "Burn");
        let doomed = category(&conn, deck_id, "main", "Ramp");
        let kept = category(&conn, deck_id, "main", "Main deck");
        let planned = theory_category(&conn, deck_id, "main", "Ramp");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", doomed, 3);
        deck_card(&conn, deck_id, "bolt-lea", kept, 1);
        deck_card_variant(&conn, deck_id, "bolt-lea", planned, "theory", 5);
        file_into(&conn, group, "bolt-lea", 4);

        delete_category(&conn, doomed, None).unwrap();

        assert_eq!(
            folder_copies(&conn, removed_group(&conn), "bolt-lea"),
            3,
            "the three the deleted pile was holding are on the reader's desk"
        );
        assert_eq!(
            folder_copies(&conn, group, "bolt-lea"),
            1,
            "and the copy behind the pile that survived is still the deck's"
        );

        delete_category(&conn, planned, None).unwrap();
        assert_eq!(
            folder_copies(&conn, removed_group(&conn), "bolt-lea"),
            3,
            "deleting the plan's pile files nothing"
        );
        assert_eq!(folder_copies(&conn, group, "bolt-lea"), 1);
    }

    /// The move arm moves **no copies at all**, and that is not an omission: those cards are
    /// still in this deck, one pile over, so the group is still exactly where the copies behind
    /// them belong. Filing them into `Recently removed` here would take a deck's cards off its
    /// own desk because the reader tidied their columns.
    #[test]
    fn deleting_a_category_that_moves_its_cards_leaves_every_copy_in_the_group() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let group = group_for(&conn, deck_id, "Burn");
        let from = category(&conn, deck_id, "main", "Creatures");
        let to = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", from, 3);
        file_into(&conn, group, "bolt-lea", 3);

        delete_category(&conn, from, Some(to)).unwrap();

        assert_eq!(folder_copies(&conn, group, "bolt-lea"), 3);
        assert_eq!(folder_copies(&conn, removed_group(&conn), "bolt-lea"), 0);
    }

    /// The move folds on the grain into the target, **within one list**: a live pile moves into
    /// a live pile and a theory pile into a theory pile, each summing into what its target
    /// already held, and neither reaching the other list's rows (user schema v53).
    #[test]
    fn deck_category_delete_with_a_move_target_folds_cards_within_its_list() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let from = category(&conn, deck_id, "main", "Creatures");
        let to = category(&conn, deck_id, "main", "Main deck");
        let plan_from = theory_category(&conn, deck_id, "main", "Creatures");
        let plan_to = theory_category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        // The target already holds this printing in `live` — the fold must sum into it.
        deck_card(&conn, deck_id, "bolt-lea", to, 2);
        deck_card(&conn, deck_id, "bolt-lea", from, 3);
        // And the plan's own pair, which the live delete must not touch.
        deck_card_variant(&conn, deck_id, "bolt-lea", plan_to, "theory", 1);
        deck_card_variant(&conn, deck_id, "bolt-lea", plan_from, "theory", 5);

        delete_category(&conn, from, Some(to)).unwrap();

        let gone: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories WHERE id = ?1",
                params![from],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0, "the source category itself is deleted");

        let qty = |category: i64| -> i64 {
            conn.query_row(
                "SELECT coalesce(sum(quantity), 0) FROM deck_cards
                  WHERE deck_id = ?1 AND card_id = 'bolt-lea' AND category_id = ?2",
                params![deck_id, category],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            qty(to),
            5,
            "2 already there + 3 moved in, folded on the grain"
        );
        assert_eq!(
            (qty(plan_from), qty(plan_to)),
            (5, 1),
            "the plan's piles are another list's and were never touched"
        );

        delete_category(&conn, plan_from, Some(plan_to)).unwrap();
        assert_eq!(
            qty(plan_to),
            6,
            "the plan's own move folds into the plan's target"
        );
        assert_eq!(qty(to), 5, "and leaves the live pile alone in turn");
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

    // -- Per-list piles (user schema v53, issue #561) ----------------------------------------
    //
    // A deck's Theory and Actual lists are two versions of the deck, each with its own piles. The
    // theory diff is the only thing that reads across them, so nothing a reader does to one
    // list's piles may show on the other — every test below is one way that used to leak.

    /// A deck made the way the app makes one, with or without a plan — `create_deck` is what
    /// seeds the rules zones, and these tests are about which list gets them.
    fn new_deck(conn: &Connection, name: &str, theory: bool) -> i64 {
        crate::deck::create_deck(
            conn,
            &crate::deck::DeckInput {
                name: name.to_owned(),
                format_key: "modern".to_owned(),
                theory_enabled: Some(theory),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// The one pile of `kind` in one list.
    fn pile_of_kind(conn: &Connection, deck_id: i64, variant: &str, kind: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND variant = ?2 AND kind = ?3",
            params![deck_id, variant, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One list's piles by name, in the order the tab draws them.
    fn pile_names(conn: &Connection, deck_id: i64, variant: &str) -> Vec<String> {
        list_categories(conn, deck_id, variant, ANY_MARKET)
            .unwrap()
            .into_iter()
            .map(|c| c.name)
            .collect()
    }

    /// One list's piles by id — what "the other list is untouched" has to compare.
    fn pile_ids(conn: &Connection, deck_id: i64, variant: &str) -> Vec<i64> {
        list_categories(conn, deck_id, variant, ANY_MARKET)
            .unwrap()
            .into_iter()
            .map(|c| c.id)
            .collect()
    }

    /// One list's cards as `(pile, card, copies)`, sorted — the rows a step has to put back.
    fn list_rows(conn: &Connection, deck_id: i64, variant: &str) -> Vec<(i64, String, i64)> {
        conn.prepare(
            "SELECT category_id, card_id, quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 ORDER BY category_id, card_id",
        )
        .unwrap()
        .query_map(params![deck_id, variant], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
    }

    /// The pile of `name` in one list, or `None` — never made on the way, unlike
    /// [`category_for_name`].
    fn find_pile(conn: &Connection, deck_id: i64, variant: &str, name: &str) -> Option<i64> {
        conn.query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND variant = ?2 AND name = ?3",
            params![deck_id, variant, name],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
    }

    fn undo_newest(conn: &Connection, deck_id: i64) -> i64 {
        let audit = crate::deck_undo::next_undo(conn, deck_id).unwrap().unwrap();
        crate::deck_undo::apply_reversal(conn, deck_id, audit, true).unwrap();
        audit
    }

    fn redo(conn: &Connection, deck_id: i64, audit: i64) {
        crate::deck_undo::apply_reversal(conn, deck_id, audit, false).unwrap();
    }

    /// The bug the issue opened with: "New category" on the Theory tab drew an empty heading on
    /// the Actual one, because a pile had no list and every pile was listed on both.
    #[test]
    fn a_pile_made_in_one_list_is_not_listed_in_the_other() {
        let conn = conn();
        let d = new_deck(&conn, "Burn", true);

        let planned = create_category(&conn, d, "theory", "Burn spells").unwrap();
        assert_eq!(
            planned.variant, "theory",
            "the readback says which list it is in"
        );
        assert!(pile_names(&conn, d, "theory").contains(&"Burn spells".to_owned()));
        assert!(
            !pile_names(&conn, d, "live").contains(&"Burn spells".to_owned()),
            "a pile made on the Theory tab is not drawn on the Actual one"
        );

        let sleeved = create_category(&conn, d, "live", "Ramp").unwrap();
        assert_eq!(sleeved.variant, "live");
        assert!(pile_names(&conn, d, "live").contains(&"Ramp".to_owned()));
        assert!(
            !pile_names(&conn, d, "theory").contains(&"Ramp".to_owned()),
            "and the other way round"
        );

        // The name arm is the list being written too.
        category_for_name(&conn, d, "theory", "Draw").unwrap();
        assert!(!pile_names(&conn, d, "live").contains(&"Draw".to_owned()));
    }

    /// A new pile goes to the end of **its own list**: each list orders its piles on its own, so
    /// the plan's first pile of the reader's is not placed after every live one.
    #[test]
    fn a_new_pile_is_ordered_within_its_own_list() {
        let conn = conn();
        let d = deck(&conn, "Burn");
        category(&conn, d, "main", "A");
        create_category(&conn, d, "live", "B").unwrap();

        let first_planned = create_category(&conn, d, "theory", "C").unwrap();
        assert_eq!(first_planned.sort_order, 0, "the plan has no piles yet");
        let second = category_for_name(&conn, d, "theory", "D").unwrap();
        let order: i64 = conn
            .query_row(
                "SELECT sort_order FROM deck_categories WHERE id = ?1",
                params![second],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(order, 1);
    }

    /// Each list is born with its own four rules zones: `live` always, `theory` when the deck
    /// is born with a plan. A deck without one has no theory piles at all until it is switched on.
    #[test]
    fn a_deck_born_with_a_plan_has_rules_zones_in_both_lists() {
        let conn = conn();
        let planned = new_deck(&conn, "Planned", true);
        let plain = new_deck(&conn, "Plain", false);

        for variant in ["live", "theory"] {
            let kinds: Vec<String> = list_categories(&conn, planned, variant, ANY_MARKET)
                .unwrap()
                .into_iter()
                .map(|c| c.kind)
                .collect();
            assert_eq!(
                kinds,
                vec!["commander", "side", "companion", "maybe"],
                "{variant}: its own four, in the seed's order"
            );
        }
        assert_ne!(
            pile_of_kind(&conn, planned, "live", "side"),
            pile_of_kind(&conn, planned, "theory", "side"),
            "two Sideboards, one per list"
        );
        assert_eq!(pile_names(&conn, plain, "live").len(), 4);
        assert!(pile_names(&conn, plain, "theory").is_empty());

        // And seeding one list is idempotent and leaves the other alone.
        ensure_predefined_categories(&conn, planned, "theory").unwrap();
        assert_eq!(pile_names(&conn, planned, "theory").len(), 4);
        assert_eq!(pile_names(&conn, planned, "live").len(), 4);
    }

    /// The second leak the issue names: switching the Sideboard off on one tab switched it off
    /// on the other, because it was one row.
    #[test]
    fn switching_the_theory_sideboard_off_leaves_the_live_one_on() {
        let conn = conn();
        let d = new_deck(&conn, "Burn", true);
        let plan_side = pile_of_kind(&conn, d, "theory", "side");
        let live_side = pile_of_kind(&conn, d, "live", "side");

        let row = set_category_active(&conn, plan_side, false).unwrap();
        assert!(!row.is_active);
        assert_eq!(row.variant, "theory");

        let live = list_categories(&conn, d, "live", ANY_MARKET).unwrap();
        let side = live.iter().find(|c| c.id == live_side).unwrap();
        assert!(
            side.is_active,
            "the Actual list's Sideboard is its own and still on"
        );
    }

    /// Name uniqueness is per list: the plan may call a pile what a live pile is called — the
    /// two are different piles on different tabs — but not what another *theory* pile is called.
    #[test]
    fn renaming_a_theory_pile_to_a_live_piles_name_is_allowed_and_to_a_theory_piles_is_not() {
        let conn = conn();
        let d = new_deck(&conn, "Burn", true);
        create_category(&conn, d, "live", "Ramp").unwrap();
        let burn = create_category(&conn, d, "theory", "Burn").unwrap();
        let draw = create_category(&conn, d, "theory", "Draw").unwrap();

        let renamed = rename_category(&conn, burn.id, "Ramp").unwrap();
        assert_eq!(
            renamed.name, "Ramp",
            "a live pile's name is free in the plan"
        );

        assert_eq!(
            rename_category(&conn, draw.id, "Ramp").unwrap_err(),
            CATEGORY_NAME_TAKEN,
            "but the plan already has a Ramp now"
        );
        assert_eq!(
            create_category(&conn, d, "theory", "Ramp").unwrap_err(),
            CATEGORY_NAME_TAKEN
        );
        create_category(&conn, d, "live", "Draw").expect("the live list has no Draw");
    }

    /// Every card write that takes a pile id refuses a pile of the other list, in words, and
    /// writes nothing — the fence the DDL cannot hold, because `variant` is on both tables and
    /// no key joins them.
    #[test]
    fn filing_a_card_into_the_other_lists_pile_is_refused() {
        let conn = conn();
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        let d = new_deck(&conn, "Burn", true);
        let live = category_for_name(&conn, d, "live", "Main deck").unwrap();
        let plan = category_for_name(&conn, d, "theory", "Main deck").unwrap();
        assert_ne!(live, plan, "one name, two piles");

        let refused = |r: Result<(), String>, what: &str| {
            assert_eq!(r.unwrap_err(), CATEGORY_WRONG_LIST, "{what}");
        };
        refused(
            crate::deck::add_card(&conn, d, "bolt-lea", Some(live), None, "theory", None, 1)
                .map(|_| ()),
            "a theory card under a live pile",
        );
        refused(
            crate::deck::add_card(&conn, d, "bolt-lea", Some(plan), None, "live", None, 1)
                .map(|_| ()),
            "a live card under a theory pile",
        );

        crate::deck::add_card(&conn, d, "bolt-lea", Some(plan), None, "theory", None, 2).unwrap();
        let before = list_rows(&conn, d, "theory");
        refused(
            crate::deck::move_card(&conn, d, "bolt-lea", plan, Some(live), None, "theory", None)
                .map(|_| ()),
            "a move across the lists",
        );
        refused(
            crate::deck::set_card_quantity(&conn, d, "bolt-lea", live, "theory", None, 3)
                .map(|_| ()),
            "a quantity addressed through the other list's pile",
        );
        refused(
            crate::deck::clear_category(&conn, d, live, "theory").map(|_| ()),
            "a clear of the other list's pile",
        );
        assert_eq!(list_rows(&conn, d, "theory"), before, "nothing was written");
        assert!(list_rows(&conn, d, "live").is_empty());
    }

    /// The move-to target of a delete is a pile of the same list, or the delete is refused and
    /// the pile stands.
    #[test]
    fn delete_with_a_move_refuses_a_target_in_the_other_list() {
        let conn = conn();
        let d = deck(&conn, "Burn");
        let from = category(&conn, d, "main", "Creatures");
        let other_list = theory_category(&conn, d, "main", "Main deck");

        assert_eq!(
            delete_category(&conn, from, Some(other_list)).unwrap_err(),
            CATEGORY_WRONG_LIST
        );
        assert_eq!(
            pile_ids(&conn, d, "live"),
            vec![from],
            "the refused delete wrote nothing"
        );
    }

    /// A reorder names one list's piles: ids of both are refused before anything moves, and a
    /// reorder of the plan answers the plan.
    #[test]
    fn reorder_refuses_a_list_of_both_lists_piles() {
        let conn = conn();
        let d = deck(&conn, "Burn");
        let a = category(&conn, d, "main", "A");
        let b = theory_category(&conn, d, "main", "B");
        let c = theory_category(&conn, d, "main", "C");
        conn.execute(
            "UPDATE deck_categories SET sort_order = id WHERE deck_id = ?1",
            params![d],
        )
        .unwrap();
        let orders = || -> Vec<i64> {
            conn.prepare("SELECT sort_order FROM deck_categories WHERE deck_id = ?1 ORDER BY id")
                .unwrap()
                .query_map(params![d], |r| r.get(0))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        let was = orders();

        assert_eq!(
            reorder_categories(&conn, d, &[c, a, b]).unwrap_err(),
            CATEGORY_MIXED_LISTS
        );
        assert_eq!(orders(), was, "the refused reorder wrote nothing");

        let rows = reorder_categories(&conn, d, &[c, b]).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.id).collect::<Vec<_>>(),
            vec![c, b],
            "the plan's reorder reads back the plan"
        );
    }

    /// The deck's default pile is one setting and names an Actual pile; a theory pile is refused.
    #[test]
    fn the_default_category_refuses_a_theory_pile() {
        let conn = conn();
        let d = new_deck(&conn, "Burn", true);
        let plan_side = pile_of_kind(&conn, d, "theory", "side");
        let live_side = pile_of_kind(&conn, d, "live", "side");
        let patch = |id| crate::deck::DeckPatch {
            default_category_id: Some(id),
            ..Default::default()
        };

        assert_eq!(
            crate::deck::update_deck(&conn, d, &patch(plan_side)).unwrap_err(),
            CATEGORY_WRONG_LIST
        );
        let stored = crate::deck::update_deck(&conn, d, &patch(live_side))
            .unwrap()
            .default_category_id;
        assert_eq!(stored, live_side);
    }

    /// **Switching the plan on clones the live piles into it**, and each moved card lands in its
    /// clone: the deck the reader built is the plan, columns included. The live piles stay where
    /// they were — empty, and from here on independent of the plan's. One Ctrl+Z takes the
    /// clones away with the move, and Ctrl+Y brings both back.
    #[test]
    fn switching_the_plan_on_clones_the_live_piles_and_undo_takes_the_clones_away() {
        let conn = conn();
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        crate::schema::tests::seed_card(&conn, "bolt-m10", "m10", "146");
        let d = new_deck(&conn, "Burn", false);
        let ramp = create_category(&conn, d, "live", "Ramp").unwrap().id;
        let main = category_for_name(&conn, d, "live", "Main deck").unwrap();
        let empty = create_category(&conn, d, "live", "Later").unwrap().id;
        let side = pile_of_kind(&conn, d, "live", "side");
        crate::deck::add_card(&conn, d, "bolt-lea", Some(ramp), None, "live", None, 2).unwrap();
        crate::deck::add_card(&conn, d, "bolt-m10", Some(main), None, "live", None, 1).unwrap();
        crate::deck::add_card(&conn, d, "bolt-lea", Some(side), None, "live", None, 1).unwrap();
        set_category_active(&conn, side, false).unwrap();
        let live_piles = pile_ids(&conn, d, "live");
        let live_rows = list_rows(&conn, d, "live");

        crate::deck::update_deck(
            &conn,
            d,
            &crate::deck::DeckPatch {
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            pile_ids(&conn, d, "live"),
            live_piles,
            "the live piles stay"
        );
        assert!(list_rows(&conn, d, "live").is_empty(), "and are empty");
        assert_eq!(
            pile_names(&conn, d, "theory"),
            pile_names(&conn, d, "live"),
            "the plan has a pile for every live one, the empty one included"
        );
        let plan = list_categories(&conn, d, "theory", ANY_MARKET).unwrap();
        for pile in &plan {
            assert!(
                !live_piles.contains(&pile.id),
                "{}: a clone, not the pile",
                pile.name
            );
        }
        let copy_of = |name: &str| plan.iter().find(|p| p.name == name).unwrap();
        assert_eq!(
            copy_of("Ramp").origin,
            "user",
            "the clone keeps its original's origin"
        );
        assert_eq!(copy_of("Main deck").origin, "auto");
        assert!(!copy_of("Sideboard").is_active, "and its switch");
        assert_eq!(copy_of("Sideboard").kind, "side", "and its kind");
        assert_eq!(
            list_rows(&conn, d, "theory"),
            {
                let mut want = vec![
                    (copy_of("Ramp").id, "bolt-lea".to_owned(), 2),
                    (copy_of("Main deck").id, "bolt-m10".to_owned(), 1),
                    (copy_of("Sideboard").id, "bolt-lea".to_owned(), 1),
                ];
                want.sort();
                want
            },
            "each moved card is filed into its pile's clone"
        );
        assert!(find_pile(&conn, d, "theory", "Later").is_some());
        assert!(pile_ids(&conn, d, "live").contains(&empty));

        // One switch in the Sideboard is now one list's: the lists are independent.
        set_category_active(&conn, copy_of("Sideboard").id, true).unwrap();
        let live_side_active: bool = conn
            .query_row(
                "SELECT is_active FROM deck_categories WHERE id = ?1",
                params![side],
                |r| r.get(0),
            )
            .unwrap();
        assert!(!live_side_active);
        undo_newest(&conn, d);

        let audit = undo_newest(&conn, d);
        assert!(
            pile_ids(&conn, d, "theory").is_empty(),
            "the undo takes away every pile the switch made"
        );
        assert_eq!(
            list_rows(&conn, d, "live"),
            live_rows,
            "and puts the cards back"
        );
        assert_eq!(pile_ids(&conn, d, "live"), live_piles);

        redo(&conn, d, audit);
        assert_eq!(pile_names(&conn, d, "theory"), pile_names(&conn, d, "live"));
        assert!(list_rows(&conn, d, "live").is_empty());
        assert_eq!(
            list_rows(&conn, d, "theory").len(),
            3,
            "the redo files them again"
        );
        for (pile, _, _) in list_rows(&conn, d, "theory") {
            assert_eq!(pile_owner(&conn, pile).unwrap().unwrap().1, "theory");
        }
    }

    /// Switching the plan on over a plan already started moves nothing, and still gives the plan
    /// its rules zones — a Theory tab with nowhere to put a sideboard card is the gap it closes.
    #[test]
    fn switching_the_plan_on_over_a_started_plan_still_seeds_its_rules_zones() {
        let conn = conn();
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        let d = new_deck(&conn, "Burn", false);
        let plan_main = category_for_name(&conn, d, "theory", "Main deck").unwrap();
        crate::deck::add_card(
            &conn,
            d,
            "bolt-lea",
            Some(plan_main),
            None,
            "theory",
            None,
            1,
        )
        .unwrap();
        let live_main = category_for_name(&conn, d, "live", "Main deck").unwrap();
        crate::deck::add_card(&conn, d, "bolt-lea", Some(live_main), None, "live", None, 3)
            .unwrap();

        crate::deck::update_deck(
            &conn,
            d,
            &crate::deck::DeckPatch {
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(
            list_rows(&conn, d, "live"),
            vec![(live_main, "bolt-lea".to_owned(), 3)]
        );
        for kind in ["commander", "side", "companion", "maybe"] {
            pile_of_kind(&conn, d, "theory", kind);
        }
    }

    /// "Copy Actual into the plan" files each card into the plan's pile **of the same name** —
    /// found where the plan has one, made where it does not, and never for a live pile with
    /// nothing in it — and its undo takes away the piles it made along with the cards.
    #[test]
    fn copy_from_live_files_into_the_plans_pile_of_the_same_name_and_undo_removes_what_it_made() {
        let conn = conn();
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        crate::schema::tests::seed_card(&conn, "bolt-m10", "m10", "146");
        let d = new_deck(&conn, "Burn", true);
        let live_ramp = create_category(&conn, d, "live", "Ramp").unwrap().id;
        let live_main = create_category(&conn, d, "live", "Main deck").unwrap().id;
        create_category(&conn, d, "live", "Nothing yet").unwrap();
        let live_side = pile_of_kind(&conn, d, "live", "side");
        let plan_main = create_category(&conn, d, "theory", "Main deck").unwrap().id;
        let plan_side = pile_of_kind(&conn, d, "theory", "side");
        for (pile, card, n) in [
            (live_ramp, "bolt-lea", 2),
            (live_main, "bolt-m10", 1),
            (live_side, "bolt-lea", 1),
        ] {
            crate::deck::add_card(&conn, d, card, Some(pile), None, "live", None, n).unwrap();
        }
        let plan_piles = pile_ids(&conn, d, "theory");

        crate::deck_theory::copy_from_live(&conn, d).unwrap();

        let plan_ramp =
            find_pile(&conn, d, "theory", "Ramp").expect("the plan had no Ramp, so one is made");
        assert!(!plan_piles.contains(&plan_ramp));
        assert_eq!(
            find_pile(&conn, d, "theory", "Main deck"),
            Some(plan_main),
            "the plan's own Main deck is found, not made twice"
        );
        assert_eq!(
            find_pile(&conn, d, "theory", "Nothing yet"),
            None,
            "an empty live pile makes nothing in the plan"
        );
        let mut want = vec![
            (plan_ramp, "bolt-lea".to_owned(), 2),
            (plan_main, "bolt-m10".to_owned(), 1),
            (plan_side, "bolt-lea".to_owned(), 1),
        ];
        want.sort();
        assert_eq!(list_rows(&conn, d, "theory"), want);
        assert_eq!(
            list_rows(&conn, d, "live").len(),
            3,
            "a copy leaves live standing"
        );

        let audit = undo_newest(&conn, d);
        assert_eq!(
            pile_ids(&conn, d, "theory"),
            plan_piles,
            "the made Ramp is gone again"
        );
        assert!(list_rows(&conn, d, "theory").is_empty());

        redo(&conn, d, audit);
        assert_eq!(list_rows(&conn, d, "theory").len(), 3);
        assert!(find_pile(&conn, d, "theory", "Ramp").is_some());
    }

    /// A duplicate copies **both lists' piles**, each in its own list, and remaps both lists'
    /// cards and the deck's default onto the copy's own piles — a live and a theory Ramp stay
    /// two piles in the copy as in the original.
    #[test]
    fn duplicate_deck_copies_both_lists_piles_and_remaps_onto_them() {
        let conn = conn();
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        let d = new_deck(&conn, "Burn", true);
        let live_ramp = create_category(&conn, d, "live", "Ramp").unwrap().id;
        let plan_ramp = create_category(&conn, d, "theory", "Ramp").unwrap().id;
        create_category(&conn, d, "theory", "Plan only").unwrap();
        crate::deck::add_card(&conn, d, "bolt-lea", Some(live_ramp), None, "live", None, 2)
            .unwrap();
        crate::deck::add_card(
            &conn,
            d,
            "bolt-lea",
            Some(plan_ramp),
            None,
            "theory",
            None,
            4,
        )
        .unwrap();
        crate::deck::update_deck(
            &conn,
            d,
            &crate::deck::DeckPatch {
                default_category_id: Some(live_ramp),
                ..Default::default()
            },
        )
        .unwrap();

        let copy = crate::deck::duplicate_deck(&conn, d).unwrap();

        for variant in ["live", "theory"] {
            assert_eq!(
                pile_names(&conn, copy.id, variant),
                pile_names(&conn, d, variant),
                "{variant}: the copy's list has the original's piles"
            );
        }
        let copy_live_ramp = find_pile(&conn, copy.id, "live", "Ramp").unwrap();
        let copy_plan_ramp = find_pile(&conn, copy.id, "theory", "Ramp").unwrap();
        assert_ne!(copy_live_ramp, copy_plan_ramp, "still two piles");
        assert_eq!(
            list_rows(&conn, copy.id, "live"),
            vec![(copy_live_ramp, "bolt-lea".to_owned(), 2)]
        );
        assert_eq!(
            list_rows(&conn, copy.id, "theory"),
            vec![(copy_plan_ramp, "bolt-lea".to_owned(), 4)],
            "the theory card is remapped onto the copy's theory pile"
        );
        assert_eq!(copy.default_category_id, copy_live_ramp);
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

    // -- Rule 4: one label list, app-wide, one row per name ------------------------------------

    /// A card in one deck's live list, wearing one label. The label rules below all need the same
    /// shape and none of them is about building it.
    ///
    /// The category is found before it is made, because a deck's `Main deck` is unique by
    /// `DECK_CATEGORY_GRAIN` and half these tests put two cards in one deck.
    fn labelled(conn: &Connection, deck_id: i64, card: &str, label: i64, qty: i64) -> i64 {
        let cat = conn
            .query_row(
                "SELECT id FROM deck_categories WHERE deck_id = ?1 AND name = 'Main deck'",
                params![deck_id],
                |r| r.get(0),
            )
            .optional()
            .unwrap()
            .unwrap_or_else(|| category(conn, deck_id, "main", "Main deck"));
        crate::schema::tests::seed_card(conn, card, "lea", "161");
        deck_card(conn, deck_id, card, cat, qty);
        set_card_label(conn, deck_id, card, cat, "live", None, Some(label)).unwrap();
        cat
    }

    #[test]
    fn deck_label_all_is_global_and_ordered_by_copies_then_name() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        // One row per name, made once — a second deck does not get its own copy any more, which
        // is the whole of the change. `Draw` is worn by nothing at all.
        let removal = create_label(&conn, Some(deck_a), "Removal", "red").unwrap();
        let ramp = create_label(&conn, Some(deck_a), "Ramp", "green").unwrap();
        create_label(&conn, Some(deck_a), "Draw", "blue").unwrap();

        labelled(&conn, deck_a, "bolt-lea", removal.id, 4);
        labelled(&conn, deck_b, "swords-lea", removal.id, 3);
        labelled(&conn, deck_a, "llanowar-lea", ramp.id, 2);

        let all = list_all_labels(&conn).unwrap();
        let seen: Vec<(&str, i64, i64)> = all
            .iter()
            .map(|t| (t.name.as_str(), t.card_count, t.deck_count))
            .collect();
        assert_eq!(
            seen,
            vec![("Removal", 7, 2), ("Ramp", 2, 1), ("Draw", 0, 0)],
            "copies descending, then name — and a label nothing wears is still a row"
        );
    }

    #[test]
    fn deck_label_create_refuses_a_duplicate_name_in_any_deck() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        create_label(&conn, Some(deck_a), "Removal", "red").unwrap();

        // The same deck, and then a *different* one: while a label was per-deck the second of
        // these was allowed and made the second row this feature exists to prevent.
        assert_eq!(
            create_label(&conn, Some(deck_a), "Removal", "blue").unwrap_err(),
            LABEL_NAME_TAKEN
        );
        assert_eq!(
            create_label(&conn, Some(deck_b), "Removal", "blue").unwrap_err(),
            LABEL_NAME_TAKEN
        );
    }

    #[test]
    fn deck_label_create_compares_names_case_insensitively_and_normalised() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        create_label(&conn, Some(deck_id), "Removal", "red").unwrap();

        for spelling in ["removal", "REMOVAL", "  Removal  "] {
            assert_eq!(
                create_label(&conn, Some(deck_id), spelling, "blue").unwrap_err(),
                LABEL_NAME_TAKEN,
                "`{spelling}` is the same label"
            );
        }

        // The Unicode half, which `COLLATE NOCASE` could not answer: a combining acute against
        // a precomposed one. Both are typeable and which one arrives is the keyboard's choice.
        create_label(&conn, Some(deck_id), "Caf\u{e9}", "red").unwrap();
        assert_eq!(
            create_label(&conn, Some(deck_id), "Cafe\u{301}", "blue").unwrap_err(),
            LABEL_NAME_TAKEN
        );
        assert_eq!(
            create_label(&conn, Some(deck_id), "CAF\u{c9}", "blue").unwrap_err(),
            LABEL_NAME_TAKEN
        );
    }

    #[test]
    fn deck_label_create_keeps_the_capitals_the_reader_typed() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let label = create_label(&conn, Some(deck_id), "Cut Candidate", "red").unwrap();
        assert_eq!(
            label.name, "Cut Candidate",
            "the key is never the display name"
        );
        let stored: String = conn
            .query_row(
                "SELECT name_key FROM deck_labels WHERE id = ?1",
                params![label.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(stored, "cut candidate");
    }

    #[test]
    fn deck_label_update_writes_the_new_name_and_color_for_every_deck() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let label = create_label(&conn, Some(deck_a), "Removal", "red").unwrap();
        labelled(&conn, deck_b, "swords-lea", label.id, 1);

        let returned = update_label(&conn, Some(deck_a), label.id, "Interaction", "blue").unwrap();
        assert_eq!(returned.name, "Interaction");
        assert_eq!(returned.color, "blue");

        let (stored_name, stored_color, stored_key): (String, String, String) = conn
            .query_row(
                "SELECT name, color, name_key FROM deck_labels WHERE id = ?1",
                params![label.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(stored_name, "Interaction");
        assert_eq!(stored_color, "blue", "and the new colour");
        assert_eq!(stored_key, "interaction", "the key follows the name");

        // The other deck reads the same row, which is the issue's headline: recolouring here
        // recoloured it there, with nothing to propagate.
        let elsewhere = list_labels(&conn, deck_b, "live").unwrap();
        assert_eq!(elsewhere.len(), 1);
        assert_eq!(elsewhere[0].name, "Interaction");
        assert_eq!(elsewhere[0].color, "blue");
    }

    #[test]
    fn deck_label_update_refuses_a_name_another_label_holds_but_allows_recapitalising_its_own() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let removal = create_label(&conn, Some(deck_id), "Removal", "red").unwrap();
        create_label(&conn, Some(deck_id), "Ramp", "green").unwrap();

        assert_eq!(
            update_label(&conn, Some(deck_id), removal.id, "ramp", "red").unwrap_err(),
            LABEL_NAME_TAKEN
        );
        // Its own name in different capitals is not taken — by itself.
        let fixed = update_label(&conn, Some(deck_id), removal.id, "REMOVAL", "red").unwrap();
        assert_eq!(fixed.name, "REMOVAL");
    }

    #[test]
    fn deck_label_list_answers_only_what_this_deck_and_variant_wears_most_first() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let removal = create_label(&conn, Some(deck_a), "Removal", "red").unwrap();
        let ramp = create_label(&conn, Some(deck_a), "Ramp", "green").unwrap();
        let elsewhere = create_label(&conn, Some(deck_a), "Elsewhere", "blue").unwrap();
        create_label(&conn, Some(deck_a), "Unworn", "amber").unwrap();

        let cat = labelled(&conn, deck_a, "bolt-lea", ramp.id, 2);
        crate::schema::tests::seed_card(&conn, "swords-lea", "lea", "161");
        deck_card(&conn, deck_a, "swords-lea", cat, 4);
        set_card_label(
            &conn,
            deck_a,
            "swords-lea",
            cat,
            "live",
            None,
            Some(removal.id),
        )
        .unwrap();
        labelled(&conn, deck_b, "llanowar-lea", elsewhere.id, 9);

        let rows = list_labels(&conn, deck_a, "live").unwrap();
        let seen: Vec<(&str, i64)> = rows
            .iter()
            .map(|t| (t.name.as_str(), t.card_count))
            .collect();
        assert_eq!(
            seen,
            vec![("Removal", 4), ("Ramp", 2)],
            "in use here, most copies first, and nothing else"
        );
    }

    #[test]
    fn deck_label_list_treats_the_two_variants_as_different_decks() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let live_only = create_label(&conn, Some(deck_id), "Live only", "red").unwrap();
        let theory_only = create_label(&conn, Some(deck_id), "Theory only", "blue").unwrap();
        let cat = labelled(&conn, deck_id, "bolt-lea", live_only.id, 1);

        crate::schema::tests::seed_card(&conn, "swords-lea", "lea", "161");
        conn.execute(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, label_id, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'theory', 'swords-lea', 'lea', '161', 'en', 'Swords', ?3, 1, 0, 0)",
            params![deck_id, cat, theory_only.id],
        )
        .unwrap();

        let live: Vec<String> = list_labels(&conn, deck_id, "live")
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        let theory: Vec<String> = list_labels(&conn, deck_id, "theory")
            .unwrap()
            .into_iter()
            .map(|t| t.name)
            .collect();
        assert_eq!(live, vec!["Live only"]);
        assert_eq!(theory, vec!["Theory only"]);
    }

    #[test]
    fn removing_a_label_from_a_deck_unlabels_that_list_and_leaves_the_label_and_every_other_deck() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let label = create_label(&conn, Some(deck_a), "Removal", "red").unwrap();
        labelled(&conn, deck_a, "bolt-lea", label.id, 4);
        labelled(&conn, deck_b, "swords-lea", label.id, 3);

        let cleared = remove_label_from_deck(&conn, deck_a, label.id, "live").unwrap();

        assert_eq!(cleared, 1, "one row lost the label");
        assert!(list_labels(&conn, deck_a, "live").unwrap().is_empty());
        assert_eq!(
            list_labels(&conn, deck_b, "live").unwrap().len(),
            1,
            "the other deck is untouched"
        );
        let all = list_all_labels(&conn).unwrap();
        assert_eq!(all.len(), 1, "and the label itself is still there");
        assert_eq!(all[0].deck_count, 1);
    }

    #[test]
    fn removing_a_label_no_card_here_wears_is_a_success_that_writes_nothing() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let label = create_label(&conn, Some(deck_id), "Removal", "red").unwrap();
        let before: i64 = conn
            .query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap();

        assert_eq!(
            remove_label_from_deck(&conn, deck_id, label.id, "live"),
            Ok(0)
        );

        let after: i64 = conn
            .query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, before, "nothing happened, so nothing is recorded");
    }

    #[test]
    fn deleting_a_label_takes_it_off_every_deck_and_deletes_no_card() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let label = create_label(&conn, Some(deck_a), "Removal", "red").unwrap();
        labelled(&conn, deck_a, "bolt-lea", label.id, 4);
        labelled(&conn, deck_b, "swords-lea", label.id, 3);

        delete_label(&conn, Some(deck_a), label.id).unwrap();

        assert!(list_all_labels(&conn).unwrap().is_empty());
        let cards: i64 = conn
            .query_row("SELECT count(*) FROM deck_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cards, 2, "both cards are still in their decks");
        let labelled_rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_cards WHERE label_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(labelled_rows, 0, "and neither is wearing anything");
    }

    // -- A label write with no deck in the room ------------------------------------------------

    /// Every `deck_audit` row in the database, for the three tests below — the module writes one
    /// per label act, and the whole question here is whether a deckless call writes one at all.
    fn audit_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap()
    }

    /// The same for the undo stack, which hangs off those rows.
    fn undo_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM deck_undo", [], |r| r.get(0))
            .unwrap()
    }

    /// **A label can be made with no deck in the room** — the Appearance panel in Settings owns
    /// the app-wide list, and there is no deck there to touch or to write a history entry for.
    ///
    /// A label has been one app-wide row since v21, so this needs no new storage: what `deck_id`
    /// was ever for here is the *deck's* side effects, and a global edit has none.
    #[test]
    fn a_label_can_be_created_without_a_deck() {
        let conn = conn();
        let label = create_label(&conn, None, "Cut candidate", "#d9b95c").unwrap();
        assert_eq!(label.name, "Cut candidate");
        assert!(list_all_labels(&conn)
            .unwrap()
            .iter()
            .any(|l| l.id == label.id));
    }

    /// **And it writes no deck history**, which is the trade this option is, stated as a test
    /// rather than discovered. A rename made from Settings is not an event in any one deck's life
    /// — it reaches every deck wearing the label — so attributing it to one would be a false
    /// entry, and attributing it to all of them is a feature nobody asked for. The cost is that
    /// such an edit is not in a deck's undo stack; the deck editor's own dialog is unchanged and
    /// still records everything it always did.
    #[test]
    fn a_deckless_label_write_records_no_audit_and_no_undo() {
        let conn = conn();
        // A deck exists and wears the label, so the absence below is the argument's doing rather
        // than an empty database's.
        let deck_id = deck(&conn, "Burn");
        let seed = create_label(&conn, Some(deck_id), "Seed", "#3a7d44").unwrap();
        labelled(&conn, deck_id, "bolt-lea", seed.id, 4);
        let before = audit_count(&conn);
        let before_undo = undo_count(&conn);

        let label = create_label(&conn, None, "Cut candidate", "#d9b95c").unwrap();
        update_label(&conn, None, label.id, "Cut", "#0e68ab").unwrap();
        delete_label(&conn, None, label.id).unwrap();

        assert_eq!(
            audit_count(&conn),
            before,
            "no deck was named, so none is told"
        );
        assert_eq!(undo_count(&conn), before_undo, "and nothing is undoable");
        assert!(
            list_all_labels(&conn)
                .unwrap()
                .iter()
                .all(|l| l.id != label.id),
            "the delete itself still happened"
        );
    }

    /// The deck path is untouched: given a deck, all three still touch it and still write the
    /// history entry the editor's dialog depends on.
    #[test]
    fn a_label_write_with_a_deck_still_records_history() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let before = audit_count(&conn);
        create_label(&conn, Some(deck_id), "Cut candidate", "#d9b95c").unwrap();
        assert!(audit_count(&conn) > before);
    }

    // -- Rule 5: a card carries 0 or 1 labels --------------------------------------------------

    #[test]
    fn a_card_carries_zero_or_one_labels() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 4);
        let removal = create_label(&conn, Some(deck_id), "Removal", "red").unwrap();
        let ramp = create_label(&conn, Some(deck_id), "Ramp", "green").unwrap();

        let label_of = |conn: &Connection| -> Option<i64> {
            conn.query_row(
                "SELECT label_id FROM deck_cards WHERE deck_id = ?1 AND card_id = 'bolt-lea'",
                params![deck_id],
                |r| r.get(0),
            )
            .unwrap()
        };

        set_card_label(
            &conn,
            deck_id,
            "bolt-lea",
            cat,
            "live",
            None,
            Some(removal.id),
        )
        .unwrap();
        assert_eq!(label_of(&conn), Some(removal.id));

        // Setting a second label replaces the first — never both.
        set_card_label(&conn, deck_id, "bolt-lea", cat, "live", None, Some(ramp.id)).unwrap();
        assert_eq!(label_of(&conn), Some(ramp.id));

        set_card_label(&conn, deck_id, "bolt-lea", cat, "live", None, None).unwrap();
        assert_eq!(label_of(&conn), None);
    }

    /// The refusal this replaced was `set_card_label_refuses_a_label_from_a_different_deck`, and
    /// its disappearance is the feature rather than a regression: there is no other deck's label
    /// any more. A label made while standing in one deck goes straight onto a card in another.
    #[test]
    fn set_card_label_accepts_a_label_made_in_another_deck() {
        let conn = conn();
        let deck_a = deck(&conn, "Burn");
        let deck_b = deck(&conn, "Control");
        let cat = category(&conn, deck_a, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_a, "bolt-lea", cat, 4);
        let made_elsewhere = create_label(&conn, Some(deck_b), "Removal", "red").unwrap();

        set_card_label(
            &conn,
            deck_a,
            "bolt-lea",
            cat,
            "live",
            None,
            Some(made_elsewhere.id),
        )
        .unwrap();

        let rows = list_labels(&conn, deck_a, "live").unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, made_elsewhere.id);
    }

    #[test]
    fn set_card_label_refuses_a_label_id_that_resolves_to_nothing() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 4);

        let err = set_card_label(&conn, deck_id, "bolt-lea", cat, "live", None, Some(999_999))
            .unwrap_err();
        assert_eq!(err, LABEL_GONE);
    }

    #[test]
    fn set_card_label_refuses_a_card_not_in_that_category() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        let err = set_card_label(&conn, deck_id, "bolt-lea", cat, "live", None, None).unwrap_err();
        assert_eq!(err, CARD_NOT_IN_CATEGORY);
    }

    /// A foil row, which is the half of the grain the command used to drop.
    ///
    /// Written with an INSERT rather than through [`deck_card`] because no seed helper in this
    /// module writes a `finish` — which is itself why the defect below lived here so long.
    fn foil_deck_card(conn: &Connection, deck_id: i64, card_id: &str, category_id: i64) -> i64 {
        conn.query_row(
            "INSERT INTO deck_cards
                (deck_id,category_id,variant,card_id,set_code,collector_number,lang,name,
                 finish,quantity,created_at,updated_at)
             VALUES (?1,?2,'live',?3,'lea','161','en','Lightning Bolt','foil',1,
                     unixepoch(),unixepoch())
             RETURNING id",
            params![deck_id, category_id, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// **The bug this pins shipped, and shipped invisibly.** `deck_card_set_label` declared no
    /// `finish` and handed this helper `None`, so the fence matched only null-finish rows: a foil
    /// row answered [`CARD_NOT_IN_CATEGORY`] for a card the reader could see in front of them.
    /// The frontend had always sent `finish`, and Tauri drops a payload field the command does
    /// not declare, so the argument went missing between two sides that both looked right.
    #[test]
    fn set_card_label_reaches_a_foil_row_when_it_is_told_the_finish() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        let row = foil_deck_card(&conn, deck_id, "bolt-lea", cat);
        let label = create_label(&conn, Some(deck_id), "Cut candidate", "ember").unwrap();

        set_card_label(
            &conn,
            deck_id,
            "bolt-lea",
            cat,
            "live",
            Some("foil"),
            Some(label.id),
        )
        .unwrap();

        let worn: Option<i64> = conn
            .query_row(
                "SELECT label_id FROM deck_cards WHERE id = ?1",
                params![row],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(worn, Some(label.id), "the foil row is wearing the label");
    }

    /// The other half, and the reason the fence itself was never the thing to change: addressed
    /// without its finish, that same foil row is genuinely not on the grain being asked for.
    /// A caller that drops `finish` gets this — which is exactly what the command was doing.
    #[test]
    fn set_card_label_cannot_reach_a_foil_row_addressed_without_its_finish() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        foil_deck_card(&conn, deck_id, "bolt-lea", cat);
        let label = create_label(&conn, Some(deck_id), "Cut candidate", "ember").unwrap();

        let err = set_card_label(
            &conn,
            deck_id,
            "bolt-lea",
            cat,
            "live",
            None,
            Some(label.id),
        )
        .unwrap_err();
        assert_eq!(err, CARD_NOT_IN_CATEGORY);
    }

    // -- Rule 6: every write touches the deck the gallery sorts by -------------------------

    #[test]
    fn every_category_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");

        backdate(&conn, deck_id);
        let cat = create_category(&conn, deck_id, "live", "Removal").unwrap();
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
    fn every_label_and_card_label_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = conn();
        let deck_id = deck(&conn, "Burn");
        let cat = category(&conn, deck_id, "main", "Main deck");
        crate::schema::tests::seed_card(&conn, "bolt-lea", "lea", "161");
        deck_card(&conn, deck_id, "bolt-lea", cat, 4);

        backdate(&conn, deck_id);
        let label = create_label(&conn, Some(deck_id), "Removal", "red").unwrap();
        assert!(
            updated_at(&conn, deck_id) > 0,
            "label create moved the deck"
        );

        backdate(&conn, deck_id);
        update_label(&conn, Some(deck_id), label.id, "Interaction", "red").unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "so does label update");

        backdate(&conn, deck_id);
        set_card_label(
            &conn,
            deck_id,
            "bolt-lea",
            cat,
            "live",
            None,
            Some(label.id),
        )
        .unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "and labelling a card");

        backdate(&conn, deck_id);
        remove_label_from_deck(&conn, deck_id, label.id, "live").unwrap();
        assert!(
            updated_at(&conn, deck_id) > 0,
            "and taking it off this deck"
        );

        backdate(&conn, deck_id);
        delete_label(&conn, Some(deck_id), label.id).unwrap();
        assert!(updated_at(&conn, deck_id) > 0, "and label delete");
    }

    #[test]
    fn a_stale_deck_id_answers_gone_and_writes_nothing() {
        let conn = conn();
        let err = create_category(&conn, 999_999, "live", "Removal").unwrap_err();
        assert_eq!(err, crate::deck::GONE);
        let n: i64 = conn
            .query_row("SELECT count(*) FROM deck_categories", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0);
    }

    // -- deck_folder_reorder ------------------------------------------------------------------

    /// Where a folder ended up, out of the answer [`reorder_folders`] gives — which is a fresh
    /// [`list_folders`] over the table, so this is the stored row and not a returned copy of the
    /// request.
    fn placed(rows: &[DeckFolderRow], id: i64) -> (Option<i64>, i64) {
        let row = rows
            .iter()
            .find(|r| r.id == id)
            .expect("list_folders answers every folder there is");
        (row.parent_id, row.sort_order)
    }

    /// The whole of what makes this one command rather than two: a drag that re-parents *and*
    /// positions. Both halves are asserted for every id, so writing only the order or only the
    /// parent fails.
    #[test]
    fn deck_folder_reorder_writes_the_parent_and_the_position_together() {
        let conn = conn();
        let aggro = create_folder(&conn, None, "Aggro").unwrap();
        let burn = create_folder(&conn, None, "Burn").unwrap();
        let standard = create_folder(&conn, None, "Standard").unwrap();
        let control = create_folder(&conn, Some(standard.id), "Control").unwrap();

        let rows =
            reorder_folders(&conn, Some(standard.id), &[burn.id, control.id, aggro.id]).unwrap();

        assert_eq!(placed(&rows, burn.id), (Some(standard.id), 0));
        assert_eq!(placed(&rows, control.id), (Some(standard.id), 1));
        assert_eq!(placed(&rows, aggro.id), (Some(standard.id), 2));
        assert_eq!(
            placed(&rows, standard.id),
            (None, 2),
            "a folder nobody named is left where it was"
        );
        assert_eq!(rows.len(), 4, "and the answer is the whole cabinet");
    }

    /// Root is `None` and is a destination like any other — the one that cannot cycle.
    #[test]
    fn deck_folder_reorder_files_to_the_root() {
        let conn = conn();
        let standard = create_folder(&conn, None, "Standard").unwrap();
        let burn = create_folder(&conn, Some(standard.id), "Burn").unwrap();

        let rows = reorder_folders(&conn, None, &[burn.id, standard.id]).unwrap();

        assert_eq!(placed(&rows, burn.id), (None, 0));
        assert_eq!(placed(&rows, standard.id), (None, 1));
    }

    /// `parent_id` CASCADEs onto this same table, so a loop written here is [`move_folder`]'s
    /// disaster exactly — and the fences run before the first `UPDATE`, which is what the
    /// untouched sibling proves.
    #[test]
    fn deck_folder_reorder_refuses_a_cycle_and_writes_nothing() {
        let conn = conn();
        let standard = create_folder(&conn, None, "Standard").unwrap();
        let aggro = create_folder(&conn, Some(standard.id), "Aggro").unwrap();
        let burn = create_folder(&conn, Some(aggro.id), "Burn").unwrap();
        let eternal = create_folder(&conn, None, "Eternal").unwrap();

        let err = reorder_folders(&conn, Some(burn.id), &[eternal.id, standard.id]).unwrap_err();

        assert_eq!(err, FOLDER_CYCLE);
        let unchanged = read_folder(&conn, eternal.id).unwrap().unwrap();
        assert_eq!(
            (unchanged.parent_id, unchanged.sort_order),
            (None, 1),
            "the id ahead of the offender in the list must not have been written"
        );
        let subject = read_folder(&conn, standard.id).unwrap().unwrap();
        assert_eq!(subject.parent_id, None);
    }

    #[test]
    fn deck_folder_reorder_refuses_filing_a_folder_inside_itself() {
        let conn = conn();
        let standard = create_folder(&conn, None, "Standard").unwrap();
        let err = reorder_folders(&conn, Some(standard.id), &[standard.id]).unwrap_err();
        assert_eq!(err, FOLDER_CYCLE);
    }

    /// [`move_folder`]'s answer to the same mistake, and the transaction is what makes the
    /// already-written half of the list go back.
    #[test]
    fn deck_folder_reorder_refuses_an_id_that_is_gone_and_writes_nothing() {
        let conn = conn();
        let standard = create_folder(&conn, None, "Standard").unwrap();
        let burn = create_folder(&conn, None, "Burn").unwrap();

        let err = reorder_folders(&conn, None, &[burn.id, 999_999, standard.id]).unwrap_err();

        assert_eq!(err, FOLDER_GONE);
        let unchanged = read_folder(&conn, burn.id).unwrap().unwrap();
        assert_eq!(
            unchanged.sort_order, 1,
            "the row written before the stale id must have rolled back"
        );
    }
}
