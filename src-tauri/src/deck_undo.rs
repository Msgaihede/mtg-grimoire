//! Undo and redo for the deck editor: the journal, and the four primitives it replays.
//!
//! Three decisions shape this module, and each one is a thing that goes wrong if it is
//! reversed:
//!
//! * **A step restores rows; it does not run a command backwards.** There is no
//!   `unmove_card`, no `unswap_printing`. A step names a **scope** — the cells of `deck_cards`
//!   the write was about — and the rows that were in it, and applying the step deletes exactly
//!   that scope and inserts exactly those rows. That is what makes the swap's *fold* reversible
//!   (two rows became one; the step carries both), what makes a category delete reversible (the
//!   CASCADE took the cards; the step carries them), and what makes every one of these
//!   idempotent. An inverse-command design would need `deck_import_commit` to have an inverse,
//!   and it has none: `replace` cleared rows nothing recorded.
//! * **[`record_step`] is called inside the caller's transaction and never opens its own.**
//!   [`crate::deck_audit::record`]'s rule, for a sharper version of its reason. An audit row
//!   that outlives its change is a history that lies; a *step* that outlives its change is a
//!   reversal that would be applied into a deck that never had it done, and unlike the history
//!   row nobody would read it first.
//! * **Rust restores facts; it draws no conclusion about them.** Nothing here consults
//!   `autoCategoryFor`, decides which pile a card belongs in, or words a sentence — restoring
//!   the exact rows that were there is data plumbing, which is the side of CLAUDE.md's boundary
//!   this belongs on. `auditText.ts` is still the only thing that words an undo.
//!
//! # The cursor, and why the redo stack is not in this table
//!
//! `deck_undo.undone_at` is NULL while a change is still applied, and the cursor is the newest
//! row of a deck that is still NULL ([`next_undo`]). It **persists**, so undo survives a restart
//! and carries on below where it stopped — "as far back as the history allows".
//!
//! **The redo stack is the webview's, and the table only says which id may come off it.** A redo
//! stack is the *reader's* position in a session, not a fact about the deck: the webview holds
//! the ids it has just undone and hands one back to `deck_redo_apply`, and closing the window
//! throws them away — a database-backed redo would resurrect a fortnight-old branch of edits the
//! reader had forgotten making. What the table *does* answer is [`next_redo`], undo's cursor
//! mirrored: the one undone step a redo may take, so an id from a window that another window has
//! overtaken is refused rather than applied out of order.
//!
//! # A reversal is checked against the deck before it writes anything
//!
//! **Not every write to `deck_cards` files a step**: the cut and the Collection tab's filing
//! (`collection_alloc`), a sync pull, another deck's filing that took a copy from this one, and
//! Scryfall's reconcile all change rows with no step. So the cursor alone cannot say the deck
//! still looks the way a step left it, and a step applied blindly deletes its scope and inserts
//! its rows over whatever those writes did. [`apply_reversal`] therefore checks the side it is
//! moving *away from* against the database first — an undo needs the deck to hold the step's
//! redo side, a redo its undo side — and refuses when it does not. What each op kind compares is
//! [`holds`]' to say; what a delete being applied may take is [`deletes_hold`]'s.
//!
//! **A refused undo retires its step; a refused redo changes nothing.** The undo's step is the
//! cursor, and a cursor that refuses is refused again at every press after it: nothing older in
//! the deck could ever be undone. So the refusal deletes that one `deck_undo` row (the history
//! row stays), says [`RETIRED`], and the next Ctrl+Z is the change below it — and a write that
//! *fails* is a refusal too, rolled back to a savepoint first. A redo is the webview's id and the
//! webview drops it on any refusal, so there is nothing to retire; it says [`MOVED_ON`].
//!
//! **`undone_at` is an ordinal, not a time.** An undo stamps `max(now, newest in this deck + 1)`,
//! so it reads as roughly when, but what [`next_redo`] relies on is that it strictly increases
//! within a deck.
//!
//! # An undo is a `deck` audit row and adds no kind
//!
//! [`crate::schema::AUDIT_KINDS`] stays at nine. `deck_audit.kind`'s CHECK cannot be altered —
//! SQLite has no `ALTER … CHECK` — so a tenth word means rebuilding every reader's whole deck
//! history for a spelling. [`crate::import::commit_import`] met this first and reused
//! `add`/`remove` with a keyed payload; this reuses `deck` with
//! `{"field":"undo"|"redo","of":<audit_id>}`. `auditText.ts`'s `deckLine` already answers an
//! unrecognised field with "Changed the deck", so an older build degrades to a true sentence
//! rather than to a hole.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// What an apply says when the id it was handed is not the deck's cursor (or, for a redo, not
/// [`next_redo`]), or when a redo finds the deck no longer the way the undo left it.
///
/// The id travels from the webview rather than being implied, so a window showing a stale
/// toolbar cannot undo something it was not looking at. The sentence names the situation rather
/// than the id, because the reader's next act is to look at the history and not to debug.
pub const MOVED_ON: &str =
    "That is not the most recent change any more — the deck has been edited since. \
     Open the history to see what happened.";

/// What an undo says when the step at the cursor can no longer be applied, and has been taken off
/// the undo list for it.
///
/// **Not [`MOVED_ON`], because that sentence would be false here and the difference is the next
/// press.** The step *is* the most recent change; what happened is that it was discarded, and the
/// Undo button now names an older one. A reader told "not the most recent change" presses Ctrl+Z
/// again to retry — and undoes that older change without meaning to.
pub const RETIRED: &str = "That change can no longer be undone — the deck has changed since, \
     so it was taken off the undo list.";

/// What an apply says when there is nothing at the cursor at all.
pub const NOTHING_TO_UNDO: &str = "There is nothing left to undo in this deck.";

/// What a redo says when the step it was handed is not undone.
pub const NOTHING_TO_REDO: &str = "That change has not been undone, so there is nothing to redo.";

/// What a step says when a row it was told to change back is not there.
///
/// A fence against a **refactor**, like [`DECK_FIELDS`]: the strict-stack cursor means a step
/// is only ever applied to the deck it was recorded against, in order, so a patch that finds
/// nothing is a step built wrong at its call site — and the alternative is a `0 rows changed`
/// that reports success and leaves the reader's deck half-reverted.
pub const MISSING_ROW: &str =
    "That change cannot be undone: part of what it changed is no longer in the deck.";

/// The `decks` columns a [`Op::Deck`] step may write, and the whole of the fence around it.
///
/// A step is JSON that came out of this database, so this is a fence against a **refactor**
/// rather than against a user — the same standing [`crate::deck_audit::record`]'s kind check
/// has. What it buys is that a column added to `decks` later cannot be written by a step
/// recorded before anyone thought about whether undoing it is meaningful: it has to be added
/// here on purpose.
///
/// **`updated_at` is deliberately absent.** Undo is an edit like any other and moves the deck to
/// the top of a gallery sorted by "most recently touched", because that is what happened.
const DECK_FIELDS: &[&str] = &[
    "name",
    "format_key",
    // Schema v18, and on the list for the same reason `format_key` is: it is a deck-level answer
    // an ordinary `deck_update` writes and an ordinary history row records, so a Ctrl+Z that
    // left it alone would put a deck's format back and leave the platform the same press moved.
    "game_key",
    "description",
    // **`notes` was here until user schema v43 and is deliberately not replaced.** The column
    // is gone — one paragraph became [`Op::Notes`]' many rows — and `notes_open` is not its
    // successor on this list any more than `tokens_open` or `stats_open` are on it: a
    // disclosure is not an audited edit, so there is nothing for a Ctrl+Z to put back.
    // `token_stack` (user schema v47) is absent on the same terms: a view setting with no
    // history row, so no step either.
    "cover_card_id",
    "cover_kind",
    // **Retired, and it must stay on this list until the column itself goes.** Nothing has
    // written `decks.cover_image_path` since custom deck covers were removed on 2026-08-31, so
    // every step recorded from then on carries the same value it read. That is not a reason to
    // drop it: `read_deck_row` records *all* of `DECK_FIELDS` into every step, so every step
    // already on a reader's disk names this column — and `apply` refuses a step naming a field
    // that is not here. Measured by handing `apply` an `Op::Deck` naming only this column: it
    // answers `Ok(())` with the entry present and
    // "`cover_image_path` is not a deck column an undo step may write" without it. So taking it
    // off breaks Ctrl+Z on every deck edit made before the upgrade, on every existing database.
    "cover_image_path",
    "folder_id",
    "theory_enabled",
    // Schema v40's deck kind, beside the other half of the pair it spells. On the list for
    // `theory_enabled`'s reason and for one more of its own: `deck::update_deck` writes **both**
    // columns whenever either is turned on, so a list carrying one and not the other would let
    // Ctrl+Z put a deck's plan back while leaving it virtual — which is `1/1`, the one pair of
    // these two booleans that names no kind at all. The two are on this list together or the
    // journal can produce a deck nothing can read.
    //
    // **Undoing the flag puts the column back and nothing else, and nothing here claims
    // otherwise.** Becoming virtual also files the deck's copies into `Recently removed` and
    // deletes its `collection_folders` group; a step writes `decks` and `deck_cards` and no
    // third table, so a Ctrl+Z restores the *kind* and leaves both of those where the press put
    // them. That is the same standing `collection_alloc`'s two moves have — they record a
    // history row and file no step at all — and it is the honest one here: an undo that rebuilt
    // the group would have to decide which copies in a shared holding area had come from this
    // deck, which nothing records. The way back is a second press of the switch, which makes
    // the group again, and `Recently removed` is where the cards are waiting.
    "virtual_only",
    "archived",
    "separate_x_group",
    "default_category_id",
    // Schema v26, and on the list for the same reason `game_key` is: it is a deck-level answer
    // an ordinary `deck_update` writes and an ordinary history row records, so a Ctrl+Z that
    // left it alone would put a deck's format back and leave the bracket the same press moved.
    "bracket",
    // Schema v38's two and v39's third, on the list for the same reason `game_key` and
    // `bracket` are: all three are
    // deck-level answers an ordinary `deck_update` writes and an ordinary history row records,
    // so a Ctrl+Z that left them alone would put a deck's format back and leave the theory marks
    // the same press moved.
    //
    // **All three, never a subset.** They are three independent switches and one Save can move
    // every one of them, so a
    // list carrying only some would restore part of one press — which is worse than
    // restoring none of it, because the drawer would still name the change it had not undone.
    "theory_mark_exact",
    "theory_mark_name",
    "theory_mark_unplanned",
    // Schema v49's managed-wishlist mode — an ordinary `deck_update` answer with a history row.
    "managed_wishlist_mode",
    "last_variant",
    "last_group_by",
    "last_sort_by",
];

/// The [`DECK_FIELDS`] that `deck::set_view_state` writes on every tab switch, with no history
/// row and no step.
///
/// **They never refuse a reversal.** A step that moved one (the theory switch moves
/// `last_variant`) still writes it back, but [`holds`] does not compare them: switching tabs is
/// not an edit, and a Ctrl+Z that depended on which tab was open since would be refused for a
/// reason the reader cannot see.
const VIEW_FIELDS: &[&str] = &["last_variant", "last_group_by", "last_sort_by"];

/// One `deck_cards` row, as a step carries it.
///
/// **`id`, `created_at` and `updated_at` are deliberately not here.** A restored row is a new
/// row: nothing in the schema points at `deck_cards.id` at all, so carrying the old id would buy
/// nothing and would collide the first time an id had been reused. `created_at` would claim the
/// row had been there all along, which is the one thing about it that is not true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub category_id: i64,
    pub variant: String,
    pub card_id: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
    pub name: String,
    /// Which label the card wore — `tag_id` in the column, and `tagId` in this key, until
    /// schema v33.
    ///
    /// **`#[serde(alias = "tagId")]` is what lets a step written before that rung still read.**
    /// It sits on the field and not only on [`Op::Labels`] because this key is on *every
    /// card-shaped step* — a quantity change, a move between piles, an import — and not only on
    /// the ones about a label. The v33 rung keeps `deck_undo`'s rows on the grounds that no label
    /// id moves, which is true of the ids and says nothing about what the keys are called.
    ///
    /// **This half fails silently where the variant's fails loudly, and that is why it is the
    /// half worth writing down.** An unrecognised `op` raises; an unrecognised *field* is
    /// discarded, and a missing `Option` deserialises to `None` with no `#[serde(default)]`
    /// anywhere near it. So without the alias, undoing a step the reader wrote last week would
    /// put every card back **unlabelled**, report success, and leave nothing to say it had
    /// happened.
    ///
    /// **An alias and not a `default`**: an alias is a second spelling of a fact the step
    /// carries, where a default would be this build inventing one for a step that genuinely has
    /// none. Nothing serialises `tagId` any more, so this is a read path with no writer, and it
    /// does not expire — `labelColors.ts`'s `LEGACY_TOKENS` reason, which is that a database is
    /// not migrated by a build being newer than it.
    /// `a_step_written_before_v33_still_reads_and_still_undoes` is the proof.
    #[serde(alias = "tagId")]
    pub label_id: Option<i64>,
    pub quantity: i64,
    pub needs_review: Option<String>,
    /// Which object the row played — `None` the regular copy, `Some("foil")`/`Some("etched")`
    /// the premium ones. Schema v18.
    ///
    /// **Without it a restored foil row comes back regular**, which is a silent wrong answer
    /// rather than a failure: the row is there, the count is right, and the only thing that has
    /// changed is what the deck says it plays and what that copy is worth. Undo is the one
    /// feature whose mistakes the reader cannot see in time to fix by hand.
    ///
    /// `#[serde(default)]`, so a step written before v18 still deserialises — and reads as the
    /// regular copy, which is exactly what a pre-v18 deck row was.
    #[serde(default)]
    pub finish: Option<String>,
}

/// One slot of `deck_cards` a step is about — the unit a scope is built from.
///
/// `card_id: None` means **every card** of that `(variant, category)`, which is what a cleared
/// pile and a deleted category need. Spelling it as an absent id rather than as a second op kind
/// is what keeps [`Op::Cards`] one arm: a clear is a scope of one wide cell, and a quantity
/// change is a scope of one narrow one.
///
/// **A cell names no finish, on purpose** (schema v18). A printing can be two rows in one pile
/// now — the regular copy and the foil — and a cell with a `card_id` covers **both**. That is
/// the correct scope rather than an omission to tidy: `crate::deck::set_card_finish` *moves
/// quantity between* those two rows, so a scope naming one finish would delete half of what the
/// write touched and restore half of what it read. The wide cell deletes both and puts both
/// back, which is exactly what "delete exactly `scope` and insert exactly `rows`" already
/// promised — the fact that has to travel is on [`CardRow::finish`], not here.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub variant: String,
    pub category_id: i64,
    pub card_id: Option<String>,
}

impl Cell {
    /// One printing in one pile of one list — the shape almost every card write is about.
    pub fn card(variant: &str, category_id: i64, card_id: &str) -> Self {
        Self {
            variant: variant.to_owned(),
            category_id,
            card_id: Some(card_id.to_owned()),
        }
    }

    /// A whole pile of one list — what a clear and a category delete are about.
    pub fn pile(variant: &str, category_id: i64) -> Self {
        Self {
            variant: variant.to_owned(),
            category_id,
            card_id: None,
        }
    }
}

/// One `deck_categories` row, as a step carries it. `deck_id` is the step's, not the row's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRow {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub is_active: bool,
    pub sort_order: i64,
    pub origin: String,
}

/// One `deck_labels` row, as a step carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LabelRow {
    pub id: i64,
    pub name: String,
    pub color: String,
}

/// Which label one deck card wore.
///
/// Addressed by its **cell** rather than by `deck_cards.id`, because a step is replayed after
/// other steps may have deleted and reinserted that row — [`CardRow`] says why ids are not
/// restored. The cell is stable across all of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Carrier {
    /// Which deck the card is in — **not the step's**, since schema v21.
    ///
    /// A label belongs to no deck now, so a delete's carriers are every card wearing it *in every
    /// deck*, while the step recording that delete is filed under the one deck the reader was
    /// standing in. Without this field the reversal would put the label back on that deck's
    /// cards and quietly leave the other decks' bare — the failure mode being that undo looks
    /// like it worked, on the screen that is open.
    ///
    /// `#[serde(default)]` and `Option`, so a step written before v21 still deserialises;
    /// [`apply`] reads `None` as the step's own deck, which is what such a step meant. Nothing
    /// in a shipped database can be in that state — schema v21 clears `deck_undo` — but a step
    /// is a serialised format and the cheap fallback is worth more than the assertion.
    #[serde(default)]
    pub deck_id: Option<i64>,
    pub variant: String,
    pub category_id: i64,
    pub card_id: String,
    /// Which label the card wore — `tagId` in a step written before schema v33, aliased for
    /// [`CardRow::label_id`]'s reason and with its failure mode: an unrecognised field is
    /// discarded in silence, so without this a reversal would clear the very label it exists to
    /// put back.
    #[serde(alias = "tagId")]
    pub label_id: Option<i64>,
}

/// One `deck_notes` row, as a step carries it — user schema v43.
///
/// **`created_at` and `updated_at` are deliberately absent**, [`CardRow`]'s rule: a restored
/// note is a new row and claiming it had been there all along is the one thing about it that is
/// not true. `id` **is** here, unlike `CardRow`'s, because something does point at it —
/// [`NoteCard::note_id`] — and the whole difficulty this variant exists for is that the id may
/// have been taken since.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRow {
    pub id: i64,
    /// Which deck the note belongs to.
    ///
    /// **Always the step's own deck**, unlike [`Carrier::deck_id`], and carried anyway so the
    /// row is a whole `deck_notes` row rather than most of one: a note hangs off exactly one
    /// deck and nothing in this app records a note step against a different one. A restore
    /// inserts with this value; a *patch* and a *delete* are scoped by the step's deck instead,
    /// which is [`Op::Categories`]' fence and keeps a step from reaching into another deck's
    /// notebook however the row was built.
    pub deck_id: i64,
    /// May be empty. The list prints the body's first line when it is, computed at render — so
    /// there is nothing derived here for a restore to put back inconsistently.
    pub title: String,
    /// CommonMark, in the dialect `noteMarkdown.ts` pins. Text on this side, whole and opaque.
    pub body: String,
    pub sort_order: i64,
}

/// One `deck_note_cards` row — which card a note names, by the identity every printing of it
/// shares.
///
/// **An `oracle_id` and never a `card_id`**, `deck_tokens`' argument: a printing id means
/// nothing on the far device's shelf, and a note written against the Theory list is about the
/// same card as one written against the Live list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteCard {
    /// The note the row hangs off — **remapped through [`Remap`] like every other id in a
    /// step**, because the note it names may have come back under a fresh number.
    pub note_id: i64,
    pub oracle_id: String,
}

/// One reversal instruction. A step is a list of these, applied in order.
///
/// **Order inside a step is load-bearing**: `deck_cards.category_id` and `.label_id` are real
/// foreign keys, so a [`Op::Categories`] or [`Op::Labels`] that restores a row has to run before
/// the [`Op::Cards`] that files cards under it. Every call site builds its list in that order,
/// and [`apply`] threads the id remap forward so the later ops see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// Delete exactly `scope` and insert exactly `rows`.
    Cards {
        scope: Vec<Cell>,
        rows: Vec<CardRow>,
    },
    /// The same over a whole variant of the deck — an import, or the theory move.
    Variant { variant: String, rows: Vec<CardRow> },
    /// Bring categories back, set existing ones' columns, delete them, and optionally put
    /// `decks.default_category_id` back.
    ///
    /// **`restore` and `patch` are two lists because they are two intents, and one list cannot
    /// tell them apart.** A patch is a rename, a switch or a reorder: the row is there and its
    /// columns go back. A restore is a delete being undone: the row is *gone*, and whatever
    /// holds its id now is somebody else's pile — `deck_categories.id` is a rowid alias, so
    /// deleting the highest-numbered pile and making a new one reuses the number, and that new
    /// pile belongs to the same deck. A single list deciding by "is there a row at this id"
    /// therefore renames the reader's newest pile into the one they deleted, silently, and
    /// leaves the cards in it. That is not a hypothetical: it is what
    /// `a_restored_category_keeps_its_cards_even_when_its_id_was_reused` caught.
    Categories {
        #[serde(default)]
        restore: Vec<CategoryRow>,
        #[serde(default)]
        patch: Vec<CategoryRow>,
        #[serde(default)]
        delete: Vec<i64>,
        #[serde(default)]
        default_category_id: Option<i64>,
    },
    /// The same three lists over `deck_labels`, plus which cards wore them.
    ///
    /// **`tags` on the wire until schema v33.** The variant-level twin of
    /// [`CardRow::label_id`]'s alias, and the loud half of the pair: an internally-tagged enum
    /// refuses a tag it does not know, so a step carrying the old spelling would have failed the
    /// press outright rather than quietly.
    #[serde(alias = "tags")]
    Labels {
        #[serde(default)]
        restore: Vec<LabelRow>,
        #[serde(default)]
        patch: Vec<LabelRow>,
        #[serde(default)]
        delete: Vec<i64>,
        #[serde(default)]
        carriers: Vec<Carrier>,
    },
    /// The same three lists over `deck_notes`, plus which cards each note named — user schema
    /// v43, and the fifth of these.
    ///
    /// **`restore` and `patch` are two lists because they are two intents, and the reason
    /// transfers from [`Op::Categories`] word for word.** A patch is a retitle, a rewrite or a
    /// reorder: the row is there and its columns go back. A restore is a delete being undone:
    /// the row is *gone*, and whatever holds its id now is the reader's own newer note —
    /// `deck_notes.id` is a rowid alias, so deleting the highest-numbered note and writing a
    /// new one reuses the number, and that new note belongs to the same deck. A single list
    /// deciding by "is there a row at this id" would therefore overwrite the reader's newest
    /// note with the one they deleted, silently. That is not a hypothesis: it is what
    /// `a_restored_category_keeps_its_cards_even_when_its_id_was_reused` caught one table over,
    /// and `a_restored_note_keeps_its_cards_even_when_its_id_was_reused` is the same failure
    /// pinned here.
    ///
    /// **`attachments` is the whole `deck_note_cards` set for the notes in this step, not a
    /// diff** — [`Op::Labels`]' `carriers` again, for a sharper reason than its. Those rows
    /// hang off the note with `ON DELETE CASCADE`, so undoing a note's delete finds them *gone*
    /// rather than changed and the step has to rebuild them; and the arm deletes each named
    /// note's rows before inserting the list, which is [`Op::Cards`]' "delete exactly the scope
    /// and insert exactly the rows" and is what makes a replay idempotent.
    ///
    /// ⚠️ **"The notes in this step" is the union of all four lists and never `attachments`
    /// alone.** An empty attachment set is a real state — it is what undoing a note's *first*
    /// attach must reach — and a list of rows cannot carry the id of a note that has none. A
    /// caller therefore has to name such a note in `restore` or `patch`, which is what
    /// `deck_notes`' attach and detach both do; the arm's own comment states the failure.
    ///
    /// **No `#[serde(alias)]`.** The aliases on [`Op::Labels`] exist because schema v33
    /// *renamed* something that steps already on a reader's disk had written down. `Notes` has
    /// never had another spelling, so an alias here would be a read path for a step that has
    /// never existed.
    Notes {
        #[serde(default)]
        restore: Vec<NoteRow>,
        #[serde(default)]
        patch: Vec<NoteRow>,
        #[serde(default)]
        delete: Vec<i64>,
        #[serde(default)]
        attachments: Vec<NoteCard>,
    },
    /// Put named `decks` columns back. Keys are checked against [`DECK_FIELDS`].
    Deck {
        fields: serde_json::Map<String, Value>,
    },
}

/// One change, reversible both ways.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub undo: Vec<Op>,
    pub redo: Vec<Op>,
}

impl Step {
    pub fn new(undo: Vec<Op>, redo: Vec<Op>) -> Self {
        Self { undo, redo }
    }
}

/// Ids that moved while a step was being applied.
///
/// A restored category or label keeps its own id whenever that id is free, which is the case
/// almost every time and is what lets the [`Op::Cards`] beside it name the id it recorded. When
/// the id has been **taken since** — `deck_categories.id` is a rowid alias, so deleting the
/// highest-numbered pile and making a new one reuses the number — the row comes back under a
/// fresh id and every later op in the same step is rewritten through this map. Without it the
/// cards would be filed under a pile belonging to somebody else's press, or refused outright by
/// the foreign key.
#[derive(Debug, Default)]
struct Remap {
    categories: HashMap<i64, i64>,
    labels: HashMap<i64, i64>,
    /// The same for `deck_notes` — user schema v43. A note's id is pointed at by
    /// [`NoteCard::note_id`] and by nothing else, so this map has exactly one reader; it exists
    /// for the same reason the two above it do, which is that a rowid alias hands a deleted
    /// row's number to the next row written.
    notes: HashMap<i64, i64>,
}

impl Remap {
    fn category(&self, id: i64) -> i64 {
        self.categories.get(&id).copied().unwrap_or(id)
    }

    fn label(&self, id: Option<i64>) -> Option<i64> {
        id.map(|t| self.labels.get(&t).copied().unwrap_or(t))
    }

    fn note(&self, id: i64) -> i64 {
        self.notes.get(&id).copied().unwrap_or(id)
    }
}

/// Write one step, inside the transaction the caller already opened.
///
/// `audit_id` is the history row this reverses — [`crate::deck_audit::record`] writes that row,
/// so the call is `record_step(&tx, tx.last_insert_rowid(), …)` immediately after it. For the
/// three commands that write more than one audit row for one press
/// (`deck_update`, `deck_import_commit` in `replace` mode, `deck_folder_delete`), the id is the
/// **last** of them and the earlier rows get no step at all — one press is one Ctrl+Z, and a
/// cursor that could land mid-press would undo half of a reader's single act.
pub fn record_step(
    tx: &Connection,
    audit_id: i64,
    deck_id: i64,
    step: &Step,
) -> Result<(), String> {
    let json = serde_json::to_string(step).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO deck_undo (audit_id, deck_id, step) VALUES (?1, ?2, ?3)",
        params![audit_id, deck_id, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Record the step for a write that changed one scope of `deck_cards` — the shape five of the
/// six card commands have, and the reason none of them spells a `Step` out by hand.
///
/// `before` is the caller's read of `cells` taken **before** its write; the "after" side is
/// read here, from the same transaction, after it. Both sides name the same scope, which is
/// what makes the pair reversible in either direction: undo deletes the scope and puts `before`
/// back, redo deletes it and puts `after` back.
/// `made` is the deck's category ids **before** the write, for the two commands that can invent
/// a pile — [`crate::deck::add_card`]'s name arm and the importer, both through
/// `category_for_name`. `None` where the command cannot create one, which skips the diff.
/// Without it, undoing a quick add that invented `Ramp` puts the card back and leaves the
/// column standing: harmless on screen, because TypeScript hides an empty `auto` pile, and a
/// lie about what the deck contained a moment ago.
pub fn record_cells(
    tx: &Connection,
    audit_id: i64,
    deck_id: i64,
    cells: Vec<Cell>,
    before: Vec<CardRow>,
    made: Option<Vec<i64>>,
) -> Result<(), String> {
    let after = read_cells(tx, deck_id, &cells)?;
    let mut undo = vec![Op::Cards {
        scope: cells.clone(),
        rows: before,
    }];
    let mut redo = vec![Op::Cards {
        scope: cells,
        rows: after,
    }];
    push_made_categories(tx, deck_id, made, &mut undo, &mut redo)?;
    record_step(tx, audit_id, deck_id, &Step::new(undo, redo))
}

/// Add the piles a write invented to both sides of a step.
///
/// **The order inside each list is the point.** On the undo side the delete goes *after* the
/// cards, because the restore has already emptied the invented pile and a `deck_categories`
/// delete CASCADEs whatever is still in it. On the redo side the restore goes *first*, because
/// `deck_cards.category_id` is a real foreign key and the cards have nowhere to land until the
/// pile is back.
fn push_made_categories(
    tx: &Connection,
    deck_id: i64,
    made: Option<Vec<i64>>,
    undo: &mut Vec<Op>,
    redo: &mut Vec<Op>,
) -> Result<(), String> {
    let Some(before_ids) = made else {
        return Ok(());
    };
    let invented: Vec<CategoryRow> = read_categories(tx, deck_id)?
        .into_iter()
        .filter(|c| !before_ids.contains(&c.id))
        .collect();
    if invented.is_empty() {
        return Ok(());
    }
    undo.push(Op::Categories {
        restore: vec![],
        patch: vec![],
        delete: invented.iter().map(|c| c.id).collect(),
        default_category_id: None,
    });
    redo.insert(
        0,
        Op::Categories {
            restore: invented,
            patch: vec![],
            delete: vec![],
            default_category_id: None,
        },
    );
    Ok(())
}

/// Add the labels a write invented to both sides of a step — [`push_made_categories`]'s job over
/// `deck_labels`.
///
/// **The order is that function's, and it is load-bearing for the same reason at one remove.** On
/// the undo side the delete goes *after* the cards: `deck_cards.label_id` is `ON DELETE SET NULL`,
/// so deleting an invented label first would be harmless for the rows being restored (none of
/// them wore it — it did not exist when they were read) but would leave the ordering rule
/// different from the categories' for no reason anybody could reconstruct. On the redo side the
/// restore goes **first**, and there it is not a nicety: `label_id` is a real foreign key and
/// `insert_cards` writes the redo rows' labels through `remap.label`, so the rows have nowhere to
/// point until the label is back.
///
/// **No `deck_id` anywhere in here**, unlike its sibling: a label has belonged to no deck since
/// schema v21, so "every label there is" is the only list there is to diff.
fn push_made_labels(
    tx: &Connection,
    made: Option<Vec<i64>>,
    undo: &mut Vec<Op>,
    redo: &mut Vec<Op>,
) -> Result<(), String> {
    let Some(before_ids) = made else {
        return Ok(());
    };
    let invented: Vec<LabelRow> = read_labels(tx)?
        .into_iter()
        .filter(|t| !before_ids.contains(&t.id))
        .collect();
    if invented.is_empty() {
        return Ok(());
    }
    undo.push(Op::Labels {
        restore: vec![],
        patch: vec![],
        delete: invented.iter().map(|t| t.id).collect(),
        // None: the cards wearing these labels are being replaced wholesale by the `Op::Variant`
        // beside this one, which carries each row's own `label_id`. A carrier list would be a
        // second, weaker statement about the same rows.
        carriers: vec![],
    });
    redo.insert(
        0,
        Op::Labels {
            restore: invented,
            patch: vec![],
            delete: vec![],
            carriers: vec![],
        },
    );
    Ok(())
}

/// Every `deck_labels` row — the whole table, because a label belongs to no deck.
pub fn read_labels(conn: &Connection) -> Result<Vec<LabelRow>, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, color FROM deck_labels ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(LabelRow {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Every label id there is — the "before" half of [`push_made_labels`]' diff, and
/// [`category_ids`]' opposite number.
pub fn label_ids(conn: &Connection) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM deck_labels")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The deck's category ids as they are now — the "before" half of the diff above.
pub fn category_ids(conn: &Connection, deck_id: i64) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM deck_categories WHERE deck_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The same for a write that reshapes a whole variant — an import, and the theory move.
pub fn record_variant(
    tx: &Connection,
    audit_id: i64,
    deck_id: i64,
    variant: &str,
    before: Vec<CardRow>,
    made: Option<Vec<i64>>,
    // The `deck_labels` ids as they stood before the write, or `None` for a caller that cannot
    // invent one — the theory move, which files cards that already exist. Every id not in this
    // list afterwards is a label the write made, and undoing it takes that label away again.
    made_labels: Option<Vec<i64>>,
) -> Result<(), String> {
    let after = read_variant(tx, deck_id, variant)?;
    let mut undo = vec![Op::Variant {
        variant: variant.to_owned(),
        rows: before,
    }];
    let mut redo = vec![Op::Variant {
        variant: variant.to_owned(),
        rows: after,
    }];
    push_made_categories(tx, deck_id, made, &mut undo, &mut redo)?;
    push_made_labels(tx, made_labels, &mut undo, &mut redo)?;
    record_step(tx, audit_id, deck_id, &Step::new(undo, redo))
}

/// The rows of `deck_cards` in these cells, as a step carries them.
///
/// Called **before** the write it is recording a reversal for, which is the whole discipline of
/// this module: the "before" side of a step is read inside the caller's transaction, after its
/// fences have passed and before its own statement runs.
pub fn read_cells(conn: &Connection, deck_id: i64, cells: &[Cell]) -> Result<Vec<CardRow>, String> {
    let mut rows = Vec::new();
    for cell in cells {
        let mut stmt = conn
            .prepare(
                "SELECT category_id, variant, card_id, set_code, collector_number, lang, name,
                        label_id, quantity, needs_review, finish
                   FROM deck_cards
                  WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3
                    AND (?4 IS NULL OR card_id = ?4)",
            )
            .map_err(|e| e.to_string())?;
        let found = stmt
            .query_map(
                params![deck_id, cell.variant, cell.category_id, cell.card_id],
                card_row,
            )
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.extend(found);
    }
    Ok(rows)
}

/// Every row of one variant of one deck — an import's and the theory move's "before".
pub fn read_variant(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<CardRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT category_id, variant, card_id, set_code, collector_number, lang, name,
                    label_id, quantity, needs_review, finish
               FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], card_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn card_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CardRow> {
    Ok(CardRow {
        category_id: r.get(0)?,
        variant: r.get(1)?,
        card_id: r.get(2)?,
        set_code: r.get(3)?,
        collector_number: r.get(4)?,
        lang: r.get(5)?,
        name: r.get(6)?,
        label_id: r.get(7)?,
        quantity: r.get(8)?,
        needs_review: r.get(9)?,
        finish: r.get(10)?,
    })
}

/// One `deck_categories` row, for the "before" side of a category step.
pub fn read_category(conn: &Connection, id: i64) -> Result<Option<CategoryRow>, String> {
    conn.query_row(
        "SELECT id, name, kind, is_active, sort_order, origin
           FROM deck_categories WHERE id = ?1",
        params![id],
        |r| {
            Ok(CategoryRow {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                is_active: r.get(3)?,
                sort_order: r.get(4)?,
                origin: r.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every category of a deck, in id order — what a reorder's step carries on both sides.
pub fn read_categories(conn: &Connection, deck_id: i64) -> Result<Vec<CategoryRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, is_active, sort_order, origin
               FROM deck_categories WHERE deck_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| {
            Ok(CategoryRow {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                is_active: r.get(3)?,
                sort_order: r.get(4)?,
                origin: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One `deck_labels` row, for the "before" side of a label step.
pub fn read_label(conn: &Connection, id: i64) -> Result<Option<LabelRow>, String> {
    conn.query_row(
        "SELECT id, name, color FROM deck_labels WHERE id = ?1",
        params![id],
        |r| {
            Ok(LabelRow {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every card wearing one label **in every deck**, as cells — what a label delete's `SET NULL`
/// is about to clear.
///
/// Deck-blind since v8 and *correct* only since v21: while a label belonged to one deck, every
/// carrier was in that deck by construction and the missing `WHERE deck_id` was a distinction
/// with no difference. A label is the app's now, so this genuinely spans decks — which is why
/// [`Carrier::deck_id`] exists.
pub fn read_carriers(conn: &Connection, label_id: i64) -> Result<Vec<Carrier>, String> {
    carriers_where(conn, "label_id = ?1", params![label_id], label_id)
}

/// The same, narrowed to one list of one deck — [`crate::deck_meta::remove_label_from_deck`]'s
/// read, which is about a deck's cards rather than about the label.
pub fn read_carriers_in(
    conn: &Connection,
    label_id: i64,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<Carrier>, String> {
    carriers_where(
        conn,
        "label_id = ?1 AND deck_id = ?2 AND variant = ?3",
        params![label_id, deck_id, variant],
        label_id,
    )
}

/// The one statement both reads are. `where_sql` is a literal from this module and never a
/// caller's string, so building it with `format!` carries no injection risk.
fn carriers_where(
    conn: &Connection,
    where_sql: &str,
    args: impl rusqlite::Params,
    label_id: i64,
) -> Result<Vec<Carrier>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT deck_id, variant, category_id, card_id FROM deck_cards WHERE {where_sql}"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(args, |r| {
            Ok(Carrier {
                deck_id: Some(r.get(0)?),
                variant: r.get(1)?,
                category_id: r.get(2)?,
                card_id: r.get(3)?,
                label_id: Some(label_id),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The named `decks` columns as they are now — an [`Op::Deck`]'s "before" or "after".
pub fn read_deck_fields(
    conn: &Connection,
    deck_id: i64,
    fields: &[&str],
) -> Result<serde_json::Map<String, Value>, String> {
    for field in fields {
        if !DECK_FIELDS.contains(field) {
            return Err(format!(
                "`{field}` is not a deck column an undo step may write."
            ));
        }
    }
    if fields.is_empty() {
        return Ok(serde_json::Map::new());
    }
    // One statement whatever the field count: [`read_deck_row`] asks for the whole of
    // [`DECK_FIELDS`] on every deck edit, and a query apiece would be two round trips per column
    // for a rename. **A count stood here and went stale on the rung that added `game_key`** —
    // the list is what answers it.
    let sql = format!("SELECT {} FROM decks WHERE id = ?1", fields.join(", "));
    conn.query_row(&sql, params![deck_id], |r| {
        let mut out = serde_json::Map::new();
        for (i, field) in fields.iter().enumerate() {
            out.insert((*field).to_owned(), sql_value(r.get_ref(i)?));
        }
        Ok(out)
    })
    .map_err(|e| e.to_string())
}

/// Every column a step may write — the "before" and "after" of a deck-row edit.
///
/// **Every one of [`DECK_FIELDS`] rather than the ones the patch named**, deliberately.
/// `update_deck` writes
/// through `coalesce(?n, column)` and its theory arm changes `last_variant` as a side effect,
/// so "which columns did this press change" has more than one answer; recording the whole row
/// makes the step correct without anyone having to keep a second list in step with `DeckPatch`.
pub fn read_deck_row(
    conn: &Connection,
    deck_id: i64,
) -> Result<serde_json::Map<String, Value>, String> {
    read_deck_fields(conn, deck_id, DECK_FIELDS)
}

/// A SQLite value as the JSON a step stores it as.
fn sql_value(value: rusqlite::types::ValueRef<'_>) -> Value {
    match value {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(i) => json!(i),
        rusqlite::types::ValueRef::Real(f) => json!(f),
        rusqlite::types::ValueRef::Text(t) => json!(String::from_utf8_lossy(t).into_owned()),
        // No `decks` column is a BLOB, and a step that invented one could not be put back
        // through `JsonParam` anyway.
        rusqlite::types::ValueRef::Blob(_) => Value::Null,
    }
}

/// Apply a list of ops, inside the caller's transaction.
///
pub fn apply(tx: &Connection, deck_id: i64, ops: &[Op]) -> Result<(), String> {
    let mut remap = Remap::default();
    for op in ops {
        match op {
            Op::Cards { scope, rows } => {
                for cell in scope {
                    tx.execute(
                        "DELETE FROM deck_cards
                          WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3
                            AND (?4 IS NULL OR card_id = ?4)",
                        params![
                            deck_id,
                            cell.variant,
                            remap.category(cell.category_id),
                            cell.card_id
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
                insert_cards(tx, deck_id, rows, &remap)?;
            }
            Op::Variant { variant, rows } => {
                tx.execute(
                    "DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2",
                    params![deck_id, variant],
                )
                .map_err(|e| e.to_string())?;
                insert_cards(tx, deck_id, rows, &remap)?;
            }
            Op::Categories {
                restore,
                patch,
                delete,
                default_category_id,
            } => {
                for id in delete {
                    tx.execute(
                        "DELETE FROM deck_categories WHERE id = ?1 AND deck_id = ?2",
                        params![remap.category(*id), deck_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                for row in restore {
                    restore_category(tx, deck_id, row, &mut remap)?;
                }
                for row in patch {
                    patch_category(tx, deck_id, row, &remap)?;
                }
                if let Some(id) = default_category_id {
                    tx.execute(
                        "UPDATE decks SET default_category_id = ?2 WHERE id = ?1",
                        params![deck_id, remap.category(*id)],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Op::Labels {
                restore,
                patch,
                delete,
                carriers,
            } => {
                // No `AND deck_id = ?`, and none of the three statements in this arm has one
                // since schema v21: a label is one app-wide row, so the id *is* the whole
                // address. A deck-scoped clause here would silently match nothing and report a
                // successful undo that undid nothing.
                for id in delete {
                    tx.execute(
                        "DELETE FROM deck_labels WHERE id = ?1",
                        params![remap.label(Some(*id))],
                    )
                    .map_err(|e| e.to_string())?;
                }
                for row in restore {
                    restore_label(tx, row, &mut remap)?;
                }
                for row in patch {
                    let id = remap.label(Some(row.id));
                    let changed = tx
                        .execute(
                            "UPDATE deck_labels
                                SET name = ?2, name_key = ?3, color = ?4,
                                    updated_at = unixepoch()
                              WHERE id = ?1",
                            params![
                                id,
                                row.name,
                                crate::schema::label_name_key(&row.name),
                                row.color
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                    if changed == 0 {
                        return Err(MISSING_ROW.to_owned());
                    }
                }
                for carrier in carriers {
                    // The carrier's own deck, falling back to the step's for a step written
                    // before v21 — see `Carrier::deck_id`.
                    tx.execute(
                        "UPDATE deck_cards SET label_id = ?5, updated_at = unixepoch()
                          WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3
                            AND card_id = ?4",
                        params![
                            carrier.deck_id.unwrap_or(deck_id),
                            carrier.variant,
                            remap.category(carrier.category_id),
                            carrier.card_id,
                            remap.label(carrier.label_id)
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Op::Notes {
                restore,
                patch,
                delete,
                attachments,
            } => {
                // **Deletes first**, [`Op::Labels`]' order and its reason: a note being taken
                // away frees the rowid that a restore below may then be handed, and the
                // CASCADE takes that note's `deck_note_cards` rows with it so nothing here has
                // to.
                //
                // `AND deck_id = ?2`, unlike the label arm one block up: a note belongs to
                // exactly one deck, so the step's deck is a fence rather than a redundancy.
                for id in delete {
                    tx.execute(
                        "DELETE FROM deck_notes WHERE id = ?1 AND deck_id = ?2",
                        params![remap.note(*id), deck_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                for row in restore {
                    restore_note(tx, row, &mut remap)?;
                }
                for row in patch {
                    patch_note(tx, deck_id, row, &remap)?;
                }
                // **The whole set for the notes this step names, never a diff** — `Op::Cards`'
                // "delete exactly the scope, insert exactly the rows", which is what makes the
                // arm idempotent under a replay.
                //
                // ⚠️ **The scope is the union of all four lists, and drawing it from
                // `attachments` alone is the bug this comment exists to prevent.** That list
                // cannot name a note whose attachment set is *empty* — there is no row in it
                // to carry the id — and empty is exactly the state undoing a note's **first**
                // attach has to reach. A scope read off `attachments` would clear nothing
                // there, the `INSERT OR IGNORE` would add nothing, and the row would survive
                // its own undo: the card goes on wearing a note glyph it should have lost, in
                // a deck whose history says the attach was reversed. Redoing a detach fails
                // the same way. `restore` and `patch` are what carry such a note — `deck_notes`
                // always names the note row on an attach or a detach — and `delete` and
                // `attachments` join them so the scope is well-defined for any step, including
                // one built somewhere that does not follow that convention.
                //
                // `delete`'s ids are in it for a second reason: those rows go through the
                // note's `ON DELETE CASCADE`, and `PRAGMA foreign_keys` is per-connection, so
                // on a connection that has it off the clear is what keeps an orphan from being
                // handed to whatever next takes that rowid.
                //
                // Resolved through [`Remap`] like every other id here, and collected so a note
                // named by two lists is cleared once.
                //
                // `INSERT OR IGNORE`, because `idx_deck_note_cards_grain` is a real unique
                // index and a step listing one card twice describes one fact — a refusal there
                // would fail a reader's Ctrl+Z over a duplicate the schema is already deciding
                // about.
                let scope: BTreeSet<i64> = restore
                    .iter()
                    .chain(patch)
                    .map(|r| r.id)
                    .chain(delete.iter().copied())
                    .chain(attachments.iter().map(|c| c.note_id))
                    .map(|id| remap.note(id))
                    .collect();
                for id in &scope {
                    tx.execute(
                        "DELETE FROM deck_note_cards WHERE note_id = ?1",
                        params![id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                for card in attachments {
                    tx.execute(
                        "INSERT OR IGNORE INTO deck_note_cards
                            (note_id, oracle_id, created_at, updated_at)
                         VALUES (?1, ?2, unixepoch(), unixepoch())",
                        params![remap.note(card.note_id), card.oracle_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Op::Deck { fields } => {
                for (field, value) in fields {
                    if !DECK_FIELDS.contains(&field.as_str()) {
                        return Err(format!(
                            "`{field}` is not a deck column an undo step may write."
                        ));
                    }
                    tx.execute(
                        &format!("UPDATE decks SET {field} = ?2 WHERE id = ?1"),
                        params![deck_id, JsonParam(value)],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

/// What a reversal writes — `forward`, the side being applied — once the deck has been checked
/// against `backward`, the side it is moving away from. `None` means the deck has moved on and
/// nothing may be written.
///
/// **Two ops come back narrower than they were recorded, for one reason.**
///
/// * **[`Op::Deck`] writes only the columns whose two sides differ.** Every `deck_update` step
///   records all of [`DECK_FIELDS`] ([`read_deck_row`]), so a rename carries the folder, the
///   archive flag, the bracket and the view state on both sides; writing them all back reverted
///   whatever had moved them since without a step — a folder delete's SET NULL, a tab switch, a
///   column another device synced — and put a deleted folder's id into a real foreign key. The
///   rule reads the step and not a list, so every step already on a reader's disk keeps working.
/// * **[`Op::Categories`]' `default_category_id` is written only when the two sides differ**, for
///   the same reason: a category delete records the deck's default on both sides whether or not
///   the delete moved it.
///
/// **A `folder_id` naming a folder that has gone refuses rather than being skipped.** The check
/// can pass there — the deck is exactly where the step left it, and the folder it came *from* was
/// deleted — and the write is a foreign-key failure. Skipping the column would answer success for
/// an undo that left the deck where it was, which is the `0 rows changed` [`MISSING_ROW`] exists
/// to refuse. Refusing here is only the case this function can foresee: [`apply_reversal`] also
/// runs the write inside a savepoint and treats *any* failure of it as a refusal, which is what
/// keeps the ones nobody foresaw — a restored card naming a label deleted since, a restored pile
/// whose name was taken since — from wedging the cursor.
///
/// **And a delete being applied may take only what the step recorded** ([`deletes_hold`]), and a
/// carrier being applied may only label a bare cell ([`carriers_free`]).
fn plan(
    tx: &Connection,
    deck_id: i64,
    forward: &[Op],
    backward: &[Op],
) -> Result<Option<Vec<Op>>, String> {
    let ahead = deck_fields(forward)?;
    let behind = deck_fields(backward)?;
    let changed: BTreeSet<&str> = ahead
        .iter()
        .filter(|(field, value)| {
            behind
                .get(field.as_str())
                .is_none_or(|was| !same_value(was, value))
        })
        .map(|(field, _)| field.as_str())
        .collect();
    let default_moved = category_default(forward) != category_default(backward);

    if !holds(tx, deck_id, backward, &changed, default_moved)?
        || !deletes_hold(tx, deck_id, forward, backward)?
        || !carriers_free(tx, deck_id, forward)?
    {
        return Ok(None);
    }

    let mut ops = Vec::with_capacity(forward.len());
    for op in forward {
        ops.push(match op {
            Op::Deck { fields } => {
                let fields: serde_json::Map<String, Value> = fields
                    .iter()
                    .filter(|(field, _)| changed.contains(field.as_str()))
                    .map(|(field, value)| (field.clone(), value.clone()))
                    .collect();
                if let Some(folder) = fields.get("folder_id").and_then(Value::as_i64) {
                    let there: bool = tx
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM deck_folders WHERE id = ?1)",
                            params![folder],
                            |r| r.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    if !there {
                        return Ok(None);
                    }
                }
                Op::Deck { fields }
            }
            Op::Categories {
                restore,
                patch,
                delete,
                default_category_id,
            } => Op::Categories {
                restore: restore.clone(),
                patch: patch.clone(),
                delete: delete.clone(),
                default_category_id: default_category_id.filter(|_| default_moved),
            },
            other => other.clone(),
        });
    }
    Ok(Some(ops))
}

/// Every [`Op::Deck`] column one side of a step names, merged — and refused by name when one is
/// not on [`DECK_FIELDS`], **before** [`plan`] narrows the list. Narrowing first would let a step
/// naming a column nobody decided was undoable through silently whenever its two sides agreed.
fn deck_fields(ops: &[Op]) -> Result<serde_json::Map<String, Value>, String> {
    let mut out = serde_json::Map::new();
    for op in ops {
        if let Op::Deck { fields } = op {
            for (field, value) in fields {
                if !DECK_FIELDS.contains(&field.as_str()) {
                    return Err(format!(
                        "`{field}` is not a deck column an undo step may write."
                    ));
                }
                out.insert(field.clone(), value.clone());
            }
        }
    }
    Ok(out)
}

/// The `decks.default_category_id` one side of a step writes through [`Op::Categories`], if any.
fn category_default(ops: &[Op]) -> Option<i64> {
    ops.iter().rev().find_map(|op| match op {
        Op::Categories {
            default_category_id,
            ..
        } => *default_category_id,
        _ => None,
    })
}

/// Two step values as the one SQLite value each is written as — [`JsonParam`]'s mapping, so a
/// hand-built `true` and the `1` [`read_deck_fields`] reads back are the same value.
fn same_value(a: &Value, b: &Value) -> bool {
    fn canonical(v: &Value) -> Value {
        match v {
            Value::Bool(b) => json!(i64::from(*b)),
            other => other.clone(),
        }
    }
    canonical(a) == canonical(b)
}

/// Does the deck still hold what `ops` — one recorded side of a step — says it holds?
///
/// **Every side is read out of the database after or before a real write**, so each op in it is a
/// set of true facts about one real state, and each can be checked on its own. Content is
/// compared and row ids and timestamps are not — [`CardRow`]'s rule, since a restored row is a new
/// row. Per kind:
///
/// * **[`Op::Cards`]**: the rows in its scope, as a multiset, equal the recorded rows exactly.
/// * **[`Op::Variant`]**: the same over the whole variant.
/// * **[`Op::Categories`] / [`Op::Labels`] / [`Op::Notes`]**: every `restore` and `patch` row is
///   there (categories and notes in *this* deck) with the recorded columns; a note's attachment
///   set is the recorded set; a carrier's cell still holds at least as many rows wearing the
///   recorded label as the carriers name (a carrier names no finish, so a cell with a foil and a
///   regular row wearing different labels has to be read as "at least"). The deck's default pile
///   is compared only when the step moved it.
/// * **[`Op::Deck`]**: the columns in `changed` — the ones the step moved — hold the recorded
///   values, [`VIEW_FIELDS`] excepted.
///
/// ⚠️ **`delete` lists are deliberately not checked**, in any of the three kinds. They state an
/// absence ("no row has this id"), and every row id here is a rowid alias that another deck's, or
/// another label's, next insert is handed — so the check would refuse an undo because somebody
/// elsewhere made a pile. It protects nothing either: every restore finds a taken id and moves
/// through [`Remap`] instead of overwriting it.
///
/// One thing this cannot see: an id a later reversal restored under a **fresh** number (the
/// remap). A step recorded before that names the old id and is refused rather than applied to a
/// pile it no longer describes — which is what applying it would have got wrong.
fn holds(
    tx: &Connection,
    deck_id: i64,
    ops: &[Op],
    changed: &BTreeSet<&str>,
    default_moved: bool,
) -> Result<bool, String> {
    for op in ops {
        let held = match op {
            Op::Cards { scope, rows } => same_rows(read_cells(tx, deck_id, scope)?, rows),
            Op::Variant { variant, rows } => same_rows(read_variant(tx, deck_id, variant)?, rows),
            Op::Categories {
                restore,
                patch,
                default_category_id,
                ..
            } => {
                categories_hold(tx, deck_id, restore.iter().chain(patch))?
                    && match default_category_id.filter(|_| default_moved) {
                        Some(want) => {
                            let now: i64 = tx
                                .query_row(
                                    "SELECT default_category_id FROM decks WHERE id = ?1",
                                    params![deck_id],
                                    |r| r.get(0),
                                )
                                .map_err(|e| e.to_string())?;
                            now == want
                        }
                        None => true,
                    }
            }
            Op::Labels {
                restore,
                patch,
                carriers,
                ..
            } => {
                let mut held = true;
                for row in restore.iter().chain(patch) {
                    held &= read_label(tx, row.id)?.as_ref() == Some(row);
                }
                held && carriers_hold(tx, deck_id, carriers)?
            }
            Op::Notes {
                restore,
                patch,
                attachments,
                ..
            } => notes_hold(tx, deck_id, restore.iter().chain(patch), attachments)?,
            Op::Deck { fields } => {
                let wanted: Vec<&str> = fields
                    .keys()
                    .map(String::as_str)
                    .filter(|f| changed.contains(f) && !VIEW_FIELDS.contains(f))
                    .collect();
                let now = read_deck_fields(tx, deck_id, &wanted)?;
                wanted.iter().all(|f| same_value(&now[*f], &fields[*f]))
            }
        };
        if !held {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Two row sets as multisets: the order `read_cells` answers in is not part of the fact.
fn same_rows(mut now: Vec<CardRow>, recorded: &[CardRow]) -> bool {
    fn order(a: &CardRow, b: &CardRow) -> std::cmp::Ordering {
        let key = |r: &CardRow| {
            (
                r.category_id,
                r.variant.clone(),
                r.card_id.clone(),
                r.finish.clone(),
                r.label_id,
                r.quantity,
                r.needs_review.clone(),
                r.set_code.clone(),
                r.collector_number.clone(),
                r.lang.clone(),
                r.name.clone(),
            )
        };
        key(a).cmp(&key(b))
    }
    let mut recorded = recorded.to_vec();
    now.sort_by(order);
    recorded.sort_by(order);
    now == recorded
}

/// Each category is this deck's and has the recorded columns.
fn categories_hold<'a>(
    tx: &Connection,
    deck_id: i64,
    rows: impl Iterator<Item = &'a CategoryRow>,
) -> Result<bool, String> {
    for row in rows {
        let now = tx
            .query_row(
                "SELECT id, name, kind, is_active, sort_order, origin
                   FROM deck_categories WHERE id = ?1 AND deck_id = ?2",
                params![row.id, deck_id],
                |r| {
                    Ok(CategoryRow {
                        id: r.get(0)?,
                        name: r.get(1)?,
                        kind: r.get(2)?,
                        is_active: r.get(3)?,
                        sort_order: r.get(4)?,
                        origin: r.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if now.as_ref() != Some(row) {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Each carrier's cell still holds at least as many rows wearing the recorded label as the
/// carriers name for it.
fn carriers_hold(tx: &Connection, deck_id: i64, carriers: &[Carrier]) -> Result<bool, String> {
    let mut wanted: HashMap<(i64, &str, i64, &str, Option<i64>), i64> = HashMap::new();
    for c in carriers {
        *wanted
            .entry((
                c.deck_id.unwrap_or(deck_id),
                c.variant.as_str(),
                c.category_id,
                c.card_id.as_str(),
                c.label_id,
            ))
            .or_default() += 1;
    }
    for ((deck, variant, category, card, label), count) in wanted {
        let held: i64 = tx
            .query_row(
                "SELECT count(*) FROM deck_cards
                  WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                    AND label_id IS ?5",
                params![deck, variant, category, card, label],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if held < count {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Each note is this deck's with the recorded columns, and every note the op names carries
/// exactly the recorded attachment set.
fn notes_hold<'a>(
    tx: &Connection,
    deck_id: i64,
    rows: impl Iterator<Item = &'a NoteRow>,
    attachments: &[NoteCard],
) -> Result<bool, String> {
    let mut scope: BTreeSet<i64> = attachments.iter().map(|c| c.note_id).collect();
    for row in rows {
        let now = tx
            .query_row(
                "SELECT id, deck_id, title, body, sort_order
                   FROM deck_notes WHERE id = ?1 AND deck_id = ?2",
                params![row.id, deck_id],
                |r| {
                    Ok(NoteRow {
                        id: r.get(0)?,
                        deck_id: r.get(1)?,
                        title: r.get(2)?,
                        body: r.get(3)?,
                        sort_order: r.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if now.as_ref() != Some(row) {
            return Ok(false);
        }
        scope.insert(row.id);
    }
    let mut stmt = tx
        .prepare("SELECT oracle_id FROM deck_note_cards WHERE note_id = ?1")
        .map_err(|e| e.to_string())?;
    for id in scope {
        let now: BTreeSet<String> = stmt
            .query_map(params![id], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?;
        let recorded: BTreeSet<String> = attachments
            .iter()
            .filter(|c| c.note_id == id)
            .map(|c| c.oracle_id.clone())
            .collect();
        if now != recorded {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Would a delete in `forward` — the side being applied — take rows the step never recorded?
///
/// [`holds`] reads the side being moved *away from*, which is the right question for every write
/// the reversal makes except a delete's reach. **A pile delete CASCADEs every card under it and a
/// label delete SET-NULLs it off every card in every deck**, so undoing "New category" or a quick
/// add that invented its pile takes a card the Collection tab filed into that pile since (its
/// copies left in the deck's group with no row claiming them), and undoing "New label" strips a
/// label another deck put on a card since — a press filed in *that* deck's journal, where this
/// cursor cannot see it.
///
/// A row is the step's to take when an [`Op::Cards`] scope or an [`Op::Variant`] on the same side
/// rewrites it anyway — those were checked against the other side by [`holds`] — or, for a label,
/// when the other side names its cell as a carrier of that label: those are the cards the step
/// recorded wearing it. Anything else refuses.
fn deletes_hold(
    tx: &Connection,
    deck_id: i64,
    forward: &[Op],
    backward: &[Op],
) -> Result<bool, String> {
    let rewritten = |variant: &str, category_id: i64, card_id: &str| {
        forward.iter().any(|op| match op {
            Op::Cards { scope, .. } => scope.iter().any(|cell| {
                cell.variant == variant
                    && cell.category_id == category_id
                    && cell.card_id.as_deref().is_none_or(|id| id == card_id)
            }),
            Op::Variant { variant: v, .. } => v == variant,
            _ => false,
        })
    };
    for op in forward {
        match op {
            Op::Categories { delete, .. } => {
                let mut stmt = tx
                    .prepare(
                        "SELECT variant, card_id FROM deck_cards
                          WHERE deck_id = ?1 AND category_id = ?2",
                    )
                    .map_err(|e| e.to_string())?;
                for pile in delete {
                    let under: Vec<(String, String)> = stmt
                        .query_map(params![deck_id, pile], |r| Ok((r.get(0)?, r.get(1)?)))
                        .map_err(|e| e.to_string())?
                        .collect::<rusqlite::Result<_>>()
                        .map_err(|e| e.to_string())?;
                    if !under
                        .iter()
                        .all(|(variant, card)| rewritten(variant, *pile, card))
                    {
                        return Ok(false);
                    }
                }
            }
            Op::Labels { delete, .. } => {
                let mut stmt = tx
                    .prepare(
                        "SELECT deck_id, variant, category_id, card_id FROM deck_cards
                          WHERE label_id = ?1",
                    )
                    .map_err(|e| e.to_string())?;
                for label in delete {
                    let wearing: Vec<(i64, String, i64, String)> = stmt
                        .query_map(params![label], |r| {
                            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                        })
                        .map_err(|e| e.to_string())?
                        .collect::<rusqlite::Result<_>>()
                        .map_err(|e| e.to_string())?;
                    let recorded = |deck: i64, variant: &str, category_id: i64, card: &str| {
                        backward.iter().any(|op| match op {
                            Op::Labels { carriers, .. } => carriers.iter().any(|c| {
                                c.deck_id.unwrap_or(deck_id) == deck
                                    && c.variant == variant
                                    && c.category_id == category_id
                                    && c.card_id == card
                                    && c.label_id == Some(*label)
                            }),
                            _ => false,
                        })
                    };
                    if !wearing.iter().all(|(deck, variant, category, card)| {
                        (*deck == deck_id && rewritten(variant, *category, card))
                            || recorded(*deck, variant, *category, card)
                    }) {
                        return Ok(false);
                    }
                }
            }
            _ => {}
        }
    }
    Ok(true)
}

/// May each labelling carrier in `forward` be written? Only over a cell whose rows are bare, or
/// already wear the label the carrier names.
///
/// A carrier's UPDATE labels every row of its cell, so applying one over a card labelled since by
/// a write that files no step replaces that label. This is the one check a label delete's undo
/// gets: its redo side records no carriers — the delete's own SET NULL is what cleared them — so
/// [`holds`] has nothing to compare, and it is the carriers being *applied* that can be asked.
///
/// **The label a carrier names stops counting as its own when this op restores it and another
/// label holds that id now** — the freed rowid was handed on, so a row wearing it wears somebody
/// else's label. A clearing carrier (`label_id: None`) is not asked: [`holds`] has already found
/// its cell wearing the label it clears, on the other side.
fn carriers_free(tx: &Connection, deck_id: i64, forward: &[Op]) -> Result<bool, String> {
    for op in forward {
        let Op::Labels {
            restore, carriers, ..
        } = op
        else {
            continue;
        };
        for c in carriers {
            let Some(label) = c.label_id else {
                continue;
            };
            let handed_on = restore.iter().any(|row| row.id == label)
                && tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM deck_labels WHERE id = ?1)",
                        params![label],
                        |r| r.get::<_, bool>(0),
                    )
                    .map_err(|e| e.to_string())?;
            let own = (!handed_on).then_some(label);
            let clashing: i64 = tx
                .query_row(
                    "SELECT count(*) FROM deck_cards
                      WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3 AND card_id = ?4
                        AND label_id IS NOT NULL AND label_id IS NOT ?5",
                    params![
                        c.deck_id.unwrap_or(deck_id),
                        c.variant,
                        c.category_id,
                        c.card_id,
                        own
                    ],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            if clashing > 0 {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// A JSON value bound as the SQLite value it came out of the database as.
///
/// `serde_json::Value` has no `ToSql`, and a blanket `to_string()` would write the *text*
/// `"true"` into `theory_enabled` — which SQLite accepts, and which every later read then sees
/// as neither 0 nor 1.
struct JsonParam<'a>(&'a Value);

impl rusqlite::ToSql for JsonParam<'_> {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        use rusqlite::types::{ToSqlOutput, Value as SqlValue};
        Ok(match self.0 {
            Value::Null => ToSqlOutput::Owned(SqlValue::Null),
            Value::Bool(b) => ToSqlOutput::Owned(SqlValue::Integer(i64::from(*b))),
            Value::Number(n) => match n.as_i64() {
                Some(i) => ToSqlOutput::Owned(SqlValue::Integer(i)),
                None => ToSqlOutput::Owned(SqlValue::Real(n.as_f64().unwrap_or_default())),
            },
            Value::String(s) => ToSqlOutput::Owned(SqlValue::Text(s.clone())),
            // An array or an object in a `decks` column is not a state this app can produce;
            // storing its JSON text is the least surprising answer and cannot fail the step.
            other => ToSqlOutput::Owned(SqlValue::Text(other.to_string())),
        })
    }
}

fn insert_cards(
    tx: &Connection,
    deck_id: i64,
    rows: &[CardRow],
    remap: &Remap,
) -> Result<(), String> {
    for row in rows {
        tx.execute(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, label_id, quantity, needs_review, finish, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                     unixepoch(), unixepoch())",
            params![
                deck_id,
                remap.category(row.category_id),
                row.variant,
                row.card_id,
                row.set_code,
                row.collector_number,
                row.lang,
                row.name,
                remap.label(row.label_id),
                row.quantity,
                row.needs_review,
                row.finish
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring one category back from a delete, keeping its own id where that id is free.
///
/// **Two cases, and the second is the whole reason this is not an upsert.**
///
/// 1. **Nothing holds that id** — insert with the id it had, and the cards restored beside it
///    resolve with no remap. This is what happens almost every time.
/// 2. **Something holds it** — insert under a fresh id and record the move in the remap, which
///    every later op in this step reads. `deck_categories.id` is a rowid alias, so deleting the
///    highest-numbered pile and creating another one reuses the number, and **that pile belongs
///    to the same deck** — which is why "is it this deck's row?" is not the question. Updating
///    it would rename the reader's newest pile into the one they deleted and hand it their old
///    cards.
///
/// A row that is merely being *changed back* — a rename, a switch, a reorder — is
/// [`patch_category`]'s, not this one's. The two are separate lists on [`Op::Categories`]
/// because no test of the database can tell the two intents apart after the fact.
fn restore_category(
    tx: &Connection,
    deck_id: i64,
    row: &CategoryRow,
    remap: &mut Remap,
) -> Result<(), String> {
    if taken(tx, "deck_categories", row.id)? {
        let fresh: i64 = tx
            .query_row(
                "INSERT INTO deck_categories
                    (deck_id, name, kind, is_active, sort_order, origin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch())
                 RETURNING id",
                params![
                    deck_id,
                    row.name,
                    row.kind,
                    row.is_active,
                    row.sort_order,
                    row.origin
                ],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        remap.categories.insert(row.id, fresh);
    } else {
        tx.execute(
            "INSERT INTO deck_categories
                (id, deck_id, name, kind, is_active, sort_order, origin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch(), unixepoch())",
            params![
                row.id,
                deck_id,
                row.name,
                row.kind,
                row.is_active,
                row.sort_order,
                row.origin
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Put an existing category's columns back — a rename, a switch or a reorder, undone.
///
/// The row must be there. A patch that changes nothing means the step is being replayed against
/// a deck it does not describe, which the strict-stack cursor makes unreachable and which is
/// therefore a bug rather than a state to tolerate silently.
fn patch_category(
    tx: &Connection,
    deck_id: i64,
    row: &CategoryRow,
    remap: &Remap,
) -> Result<(), String> {
    let changed = tx
        .execute(
            "UPDATE deck_categories
                SET name = ?2, kind = ?3, is_active = ?4, sort_order = ?5, origin = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1 AND deck_id = ?7",
            params![
                remap.category(row.id),
                row.name,
                row.kind,
                row.is_active,
                row.sort_order,
                row.origin,
                deck_id
            ],
        )
        .map_err(|e| e.to_string())?;
    (changed > 0)
        .then_some(())
        .ok_or_else(|| MISSING_ROW.to_owned())
}

/// Bring one label back from a delete — [`restore_category`]'s two cases, over `deck_labels`.
///
/// **No `deck_id`, since schema v21**, and one refusal that is new with it: the label being
/// restored may have had its *name* taken in the meantime, by another deck, because the grain
/// is app-wide. The UNIQUE index answers that with an error the reader sees, which is the right
/// outcome — the alternative is a silent second row spelling the same word, which is the one
/// thing the new grain exists to prevent.
fn restore_label(tx: &Connection, row: &LabelRow, remap: &mut Remap) -> Result<(), String> {
    let key = crate::schema::label_name_key(&row.name);
    if taken(tx, "deck_labels", row.id)? {
        let fresh: i64 = tx
            .query_row(
                "INSERT INTO deck_labels (name, name_key, color, created_at, updated_at)
                 VALUES (?1, ?2, ?3, unixepoch(), unixepoch()) RETURNING id",
                params![row.name, key, row.color],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        remap.labels.insert(row.id, fresh);
    } else {
        tx.execute(
            "INSERT INTO deck_labels (id, name, name_key, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())",
            params![row.id, row.name, key, row.color],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring one note back from a delete — [`restore_category`]'s two cases, over `deck_notes`.
///
/// The **row's own** `deck_id`, which is the step's in every step this app records — see
/// [`NoteRow::deck_id`]. The two cases are the category's exactly: the id is free and the note
/// comes back under it, so the `attachments` beside it resolve with no remap; or something
/// holds it — almost always the reader's own newer note, `deck_notes.id` being a rowid alias —
/// and the note comes back under a fresh id which every later op in the step reads through
/// [`Remap`]. Updating the row in place instead would overwrite that newer note with the one
/// the reader deleted, which is the whole failure [`Op::Notes`] splits its two lists to avoid.
///
/// **No unique index can refuse this**, unlike [`restore_label`]: `deck_notes` is uid-only and
/// has no grain, deliberately — two devices each typing a note about the mana base must stay
/// two notes.
fn restore_note(tx: &Connection, row: &NoteRow, remap: &mut Remap) -> Result<(), String> {
    if taken(tx, "deck_notes", row.id)? {
        let fresh: i64 = tx
            .query_row(
                "INSERT INTO deck_notes
                    (deck_id, title, body, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
                 RETURNING id",
                params![row.deck_id, row.title, row.body, row.sort_order],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        remap.notes.insert(row.id, fresh);
    } else {
        tx.execute(
            "INSERT INTO deck_notes
                (id, deck_id, title, body, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, unixepoch(), unixepoch())",
            params![row.id, row.deck_id, row.title, row.body, row.sort_order],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Put an existing note's columns back — a retitle, a rewrite or a reorder, undone.
///
/// [`patch_category`]'s contract: the row must be there, and `AND deck_id = ?5` is the fence
/// that keeps a step from rewriting another deck's notebook. A patch that changes nothing means
/// the step is being replayed against a deck it does not describe, which the strict-stack cursor
/// makes unreachable and which is therefore a bug rather than a state to tolerate in silence.
fn patch_note(tx: &Connection, deck_id: i64, row: &NoteRow, remap: &Remap) -> Result<(), String> {
    let changed = tx
        .execute(
            "UPDATE deck_notes
                SET title = ?2, body = ?3, sort_order = ?4, updated_at = unixepoch()
              WHERE id = ?1 AND deck_id = ?5",
            params![
                remap.note(row.id),
                row.title,
                row.body,
                row.sort_order,
                deck_id
            ],
        )
        .map_err(|e| e.to_string())?;
    (changed > 0)
        .then_some(())
        .ok_or_else(|| MISSING_ROW.to_owned())
}

/// Is anything at all sitting on this rowid?
///
/// **Deck-blind on purpose.** The question a restore asks is "may I have my id back", and the
/// answer is no whoever holds it — a pile of this very deck, made after the delete, is the
/// commonest holder and the one that made the deck-scoped version of this check wrong.
///
/// The table name is interpolated because `PRAGMA`-free SQLite has no parameter position for
/// one; all three call sites pass a literal from this module and no caller reaches it.
fn taken(tx: &Connection, table: &str, id: i64) -> Result<bool, String> {
    tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// The audit id of the next thing Ctrl+Z would undo in this deck, or `None`.
///
/// The newest step of this deck that is still applied. `audit_id DESC` rather than a stamp:
/// `deck_audit.at` is `unixepoch()` and a single press can write two rows inside one second —
/// the same reason `deck_audit::list` tie-breaks on the id, one table over.
pub fn next_undo(conn: &Connection, deck_id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT audit_id FROM deck_undo
          WHERE deck_id = ?1 AND undone_at IS NULL
          ORDER BY audit_id DESC LIMIT 1",
        params![deck_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The audit id of the change Ctrl+Y may put back in this deck, or `None` — [`next_undo`]'s
/// mirror, and what makes a redo checked rather than trusted.
///
/// The undone step **above the cursor** with the **newest `undone_at`**:
///
/// * **Above the cursor**, because an applied step newer than an undone one can only have been
///   filed after the undo — the reader edited past it, in this window or another, and that branch
///   is gone.
/// * **Newest stamp**, because among the undone steps above the cursor the one undone last is the
///   top of the stack, and a step undone before the last edit — a dead branch that the cursor has
///   since come back down past — always carries an older stamp than any undone after it. That
///   holds only if stamps strictly increase within a deck, which is why [`apply_reversal`] stamps
///   `max(now, newest + 1)` rather than the wall clock: two presses inside one second would tie,
///   and a tie broken by id picks the dead branch
///   (`a_change_undone_before_a_later_edit_can_never_be_redone`).
pub fn next_redo(conn: &Connection, deck_id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT audit_id FROM deck_undo
          WHERE deck_id = ?1 AND undone_at IS NOT NULL
            AND audit_id > coalesce((SELECT max(audit_id) FROM deck_undo
                                      WHERE deck_id = ?1 AND undone_at IS NULL), 0)
          ORDER BY undone_at DESC, audit_id ASC LIMIT 1",
        params![deck_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The step stored for one history row, and whether it has been undone.
pub fn read_step(conn: &Connection, audit_id: i64) -> Result<Option<(Step, bool)>, String> {
    let found: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT step, undone_at FROM deck_undo WHERE audit_id = ?1",
            params![audit_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match found {
        Some((json, undone_at)) => {
            let step: Step = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            Ok(Some((step, undone_at.is_some())))
        }
        None => Ok(None),
    }
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What the toolbar's two buttons draw: the change each would reverse, or `None`.
///
/// The whole `DeckAuditEntry` rather than a sentence, because a sentence is domain logic —
/// `auditText.ts` words it, and the button reads "Undo — Removed 2 × Lightning Bolt" by asking
/// that module. The same split every row of the history drawer already goes through.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckUndoState {
    pub undo: Option<crate::deck_audit::DeckAuditEntry>,
    pub redo: Option<crate::deck_audit::DeckAuditEntry>,
}

#[cfg_attr(target_family = "wasm", allow(dead_code))]
/// The `deck` payload an undo or a redo records, and the whole of what makes the pair legible.
///
/// `of` is the history row being reversed, which is what lets `auditText.ts` render the undone
/// change's own sentence inside the verb rather than "Changed the deck".
fn reversal_payload(field: &str, of: i64) -> Value {
    json!({ "field": field, "of": of })
}

#[cfg_attr(target_family = "wasm", allow(dead_code))]
/// One history row for the reversal itself.
///
/// **`delta` is negated on an undo and carried straight on a redo**, so the day header's
/// `+7 / −6` roll-up still adds up: undoing an add of two copies takes two copies out of the
/// day's arithmetic, which is what happened.
fn record_reversal(
    tx: &Connection,
    deck_id: i64,
    field: &str,
    of: i64,
    delta: i64,
) -> Result<(), String> {
    crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &reversal_payload(field, of),
        delta,
    )?;
    Ok(())
}

/// Apply one step, in one transaction, and record the history row for having done it.
///
/// `undoing` picks the direction. The id is checked against the cursor — [`next_undo`], or
/// [`next_redo`] for a redo — rather than trusted: the webview's toolbar can be a moment behind
/// the deck, and undoing "the most recent change" when the most recent change is not the one on
/// the button is exactly the surprise this feature must not produce. **Then the deck itself is
/// checked** ([`plan`]), because a write that files no step moves the rows without moving the
/// cursor; see the module doc.
///
/// **A refused undo at the cursor retires its step** — deletes the `deck_undo` row, keeps the
/// history row, commits that and nothing else, and answers [`RETIRED`] — because the cursor would
/// otherwise refuse the same way at every press and nothing older could ever be undone. "Refused"
/// means [`plan`] said no **or the write itself failed**: it runs inside a savepoint, and any
/// error rolls back to it, so a constraint nobody foresaw (a label deleted since, a pile name
/// taken since) cannot wedge the cursor either. A refused redo writes nothing and answers
/// [`MOVED_ON`], or the write's own error.
///
/// **`pub(crate)` since 2026-08-29**, and the `allow(dead_code)` it carried for one PR is gone:
/// `web::route` is the second caller, so the direction flag now has two callers on every
/// target rather than two `#[tauri::command]`s on one.
pub(crate) fn apply_reversal(
    conn: &Connection,
    deck_id: i64,
    audit_id: i64,
    undoing: bool,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    if undoing {
        match next_undo(&tx, deck_id)? {
            None => return Err(NOTHING_TO_UNDO.to_owned()),
            Some(cursor) if cursor != audit_id => return Err(MOVED_ON.to_owned()),
            Some(_) => {}
        }
    }
    let (step, undone) = read_step(&tx, audit_id)?.ok_or(NOTHING_TO_UNDO)?;
    if !undoing {
        if !undone {
            return Err(NOTHING_TO_REDO.to_owned());
        }
        if next_redo(&tx, deck_id)? != Some(audit_id) {
            return Err(MOVED_ON.to_owned());
        }
    }
    let entry = crate::deck_audit::by_id(&tx, audit_id)?.ok_or(NOTHING_TO_UNDO)?;
    if entry.deck_id != deck_id {
        return Err(MOVED_ON.to_owned());
    }

    let (forward, backward) = match undoing {
        true => (&step.undo, &step.redo),
        false => (&step.redo, &step.undo),
    };
    // `None` when the reversal went through; otherwise why it did not — no plan (the deck moved
    // on), or the write's own error, already rolled back to the savepoint.
    let refused: Option<Option<String>> = match plan(&tx, deck_id, forward, backward)? {
        None => Some(None),
        Some(ops) => {
            tx.execute_batch("SAVEPOINT reversal")
                .map_err(|e| e.to_string())?;
            match apply(&tx, deck_id, &ops) {
                Ok(()) => {
                    tx.execute_batch("RELEASE reversal")
                        .map_err(|e| e.to_string())?;
                    None
                }
                Err(e) => {
                    tx.execute_batch("ROLLBACK TO reversal; RELEASE reversal")
                        .map_err(|e| e.to_string())?;
                    Some(Some(e))
                }
            }
        }
    };
    if let Some(failure) = refused {
        if !undoing {
            return Err(failure.unwrap_or_else(|| MOVED_ON.to_owned()));
        }
        if let Some(e) = failure {
            // The reader hears [`RETIRED`]; the constraint that failed is worth a line for
            // whoever reads the log, because a step that no check foresaw may be a step built
            // wrong.
            eprintln!("deck {deck_id}: undo of history row {audit_id} failed and was retired: {e}");
        }
        tx.execute(
            "DELETE FROM deck_undo WHERE audit_id = ?1",
            params![audit_id],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        return Err(RETIRED.to_owned());
    }
    if undoing {
        // Strictly increasing within the deck, and never behind the wall clock — see
        // [`next_redo`] for why a plain `unixepoch()` is the bug.
        tx.execute(
            "UPDATE deck_undo
                SET undone_at = max(unixepoch(),
                                    coalesce((SELECT max(undone_at) FROM deck_undo
                                               WHERE deck_id = ?2), 0) + 1)
              WHERE audit_id = ?1",
            params![audit_id, deck_id],
        )
    } else {
        tx.execute(
            "UPDATE deck_undo SET undone_at = NULL WHERE audit_id = ?1",
            params![audit_id],
        )
    }
    .map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    record_reversal(
        &tx,
        deck_id,
        if undoing { "undo" } else { "redo" },
        audit_id,
        if undoing { -entry.delta } else { entry.delta },
    )?;
    tx.commit().map_err(|e| e.to_string())
}

/// What the deck's Undo and Redo buttons would do, or `None` for each.
///
/// **`redo` takes the id from the caller**, because the redo stack lives in the webview and
/// dies with the window — the reader's position in a session is not a fact about the deck. This
/// answers what that id names so the button can be labelled, and refuses nothing: a `redo` that
/// has stopped being redoable simply comes back `None`.
/// The answer itself, over a connection the caller already holds.
///
/// **Lifted out of the wrapper on 2026-08-29 so `web::route` can reach it.** It was the one
/// read in the deck cluster whose logic lived *inside* the `#[tauri::command]` rather than in
/// a function the command called — three lookups and a filter — and a `match` arm that
/// re-spelled it would have been a second copy of the redo rule to drift.
pub fn undo_state(
    conn: &Connection,
    deck_id: i64,
    redo_id: Option<i64>,
) -> Result<DeckUndoState, String> {
    let undo = match next_undo(conn, deck_id)? {
        Some(id) => crate::deck_audit::by_id(conn, id)?,
        None => None,
    };
    // The press's own question, [`next_redo`], so a window whose redo another window has
    // overtaken draws a greyed button rather than one that is refused when pressed.
    let redo = match redo_id {
        Some(id) if next_redo(conn, deck_id)? == Some(id) => {
            crate::deck_audit::by_id(conn, id)?.filter(|e| e.deck_id == deck_id)
        }
        _ => None,
    };
    Ok(DeckUndoState { undo, redo })
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_undo_state(
    state: tauri::State<'_, Arc<crate::sync::AppState>>,
    deck_id: i64,
    redo_id: Option<i64>,
) -> Result<DeckUndoState, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        undo_state(&crate::sync::lock_db_read(&state), deck_id, redo_id)
    })
    .await
    .map_err(|e| format!("the deck's undo state could not be read: {e}"))?
}

/// Undo the named change. The id is the cursor's or the call is refused in words.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_undo_apply(
    state: tauri::State<'_, Arc<crate::sync::AppState>>,
    deck_id: i64,
    audit_id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        crate::sync::with_write(&state, |conn| apply_reversal(conn, deck_id, audit_id, true))
    })
    .await
    .map_err(|e| format!("the change could not be undone: {e}"))?
}

/// Put back a change that was undone.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_redo_apply(
    state: tauri::State<'_, Arc<crate::sync::AppState>>,
    deck_id: i64,
    audit_id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        crate::sync::with_write(&state, |conn| {
            apply_reversal(conn, deck_id, audit_id, false)
        })
    })
    .await
    .map_err(|e| format!("the change could not be redone: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::DeckInput;

    /// Two printings of one card and one of another — a swap needs two printings of one oracle
    /// card, and a move needs somewhere to go. `deck_audit`'s fixture, for its reasons.
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,mana_cost,cmc,type_line,prices,finishes,raw)
               VALUES
                 ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                  '{R}',1.0,'Instant','{"usd":"400.00"}','["nonfoil"]','{}'),
                 ('bolt-m10','o1','Lightning Bolt','m10','146','en','normal','common',
                  '{R}',1.5,'Instant','{"usd":"1.50"}','["nonfoil","foil"]','{}'),
                 ('serra-lea','o2','Serra Angel','lea','175','en','normal','uncommon',
                  '{3}{W}{W}',5.0,'Creature — Angel','{"usd":"120.00"}','["nonfoil"]','{}');"#,
        )
        .unwrap();
        conn
    }

    fn deck(conn: &Connection, name: &str) -> i64 {
        crate::deck::create_deck(
            conn,
            &DeckInput {
                name: name.to_owned(),
                format_key: "modern".to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    fn category(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, name).unwrap()
    }

    fn quantity(conn: &Connection, deck_id: i64, category_id: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND category_id = ?2 AND card_id = ?3 AND variant = 'live'",
            params![deck_id, category_id, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Everything about this deck that a step is supposed to be able to put back, as one
    /// comparable value.
    ///
    /// **`deck_cards.id`, `created_at` and `updated_at` are deliberately left out**, for
    /// [`CardRow`]'s reason: a restored row is a new row, and a snapshot that compared ids
    /// would assert the one thing this design says is not promised. Everything a reader can
    /// see is in here — including `label_id` and `needs_review`, which are the two columns an
    /// "obvious" reversal built out of the audit payload would silently drop.
    ///
    /// **`finish` is a third column of exactly that kind, and it joined this list late** (v18).
    /// A sweep that did not read it would report every finish case below as passing while undo
    /// restored the right count in the wrong object — the assertion would be there and would be
    /// checking nothing. A column added to `deck_cards` that a reader can see is owed a place
    /// here in the same commit.
    fn snapshot(conn: &Connection, deck_id: i64) -> Vec<String> {
        let mut out = Vec::new();
        let mut cards = conn
            .prepare(
                "SELECT category_id, variant, card_id, set_code, collector_number, lang, name,
                        coalesce(label_id, -1), quantity, coalesce(needs_review, ''),
                        coalesce(finish, '')
                   FROM deck_cards WHERE deck_id = ?1",
            )
            .unwrap();
        out.extend(
            cards
                .query_map(params![deck_id], |r| {
                    Ok(format!(
                        "card {}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
                        r.get::<_, i64>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, String>(6)?,
                        r.get::<_, i64>(7)?,
                        r.get::<_, i64>(8)?,
                        r.get::<_, String>(9)?,
                        r.get::<_, String>(10)?,
                    ))
                })
                .unwrap()
                .map(Result::unwrap),
        );
        let mut cats = conn
            .prepare(
                "SELECT name, kind, is_active, sort_order, origin
                   FROM deck_categories WHERE deck_id = ?1",
            )
            .unwrap();
        out.extend(
            cats.query_map(params![deck_id], |r| {
                Ok(format!(
                    "category {}|{}|{}|{}|{}",
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap),
        );
        // **Every label, not this deck's**, since schema v21 — there is no such thing as this
        // deck's. A label write is app-wide now, so a snapshot narrowed to one deck would let a
        // botched reversal leave another deck's label renamed and call the deck restored.
        let mut labels = conn.prepare("SELECT name, color FROM deck_labels").unwrap();
        out.extend(
            labels
                .query_map([], |r| {
                    Ok(format!(
                        "label {}|{}",
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?
                    ))
                })
                .unwrap()
                .map(Result::unwrap),
        );
        for field in DECK_FIELDS {
            let value = read_deck_fields(conn, deck_id, &[field]).unwrap();
            out.push(format!("deck {field}={}", value[*field]));
        }
        out.sort();
        out
    }

    /// Undo the deck's newest step — [`apply_reversal`] itself, so the sweeps exercise the
    /// command's own path rather than a second implementation of it that could drift.
    fn undo(conn: &Connection, deck_id: i64) -> Result<(), String> {
        let audit_id = next_undo(conn, deck_id)?.ok_or(NOTHING_TO_UNDO)?;
        apply_reversal(conn, deck_id, audit_id, true)
    }

    /// Redo it again.
    fn redo(conn: &Connection, deck_id: i64, audit_id: i64) -> Result<(), String> {
        apply_reversal(conn, deck_id, audit_id, false)
    }

    /// One command under test: what to call it in a failure, the state it needs, and the one
    /// call being measured.
    ///
    /// **The setup is a separate function and not the first two lines of `drive`**, because the
    /// snapshot is taken between them. A case that built its fixture inside `drive` would be
    /// asserting that undo reverses *two* writes, which is the opposite of the strict-stack
    /// rule — `every_deck_write_leaves_exactly_one_audit_row` splits them the same way, by
    /// clearing the history between the two.
    type Case = (&'static str, fn(&Connection, i64), fn(&Connection, i64));

    /// A case that needs nothing beyond [`fresh`].
    fn nothing(_: &Connection, _: i64) {}

    /// A deck with two piles, a label and some cards in it — enough state that a step which
    /// dropped a column would show up in [`snapshot`] rather than comparing two empty decks.
    fn fresh() -> (Connection, i64) {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        let draw = category(&conn, id, "Draw");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", None, 2).unwrap();
        crate::deck::add_card(&conn, id, "serra-lea", Some(draw), None, "live", None, 1).unwrap();
        crate::deck::add_card(&conn, id, "bolt-m10", Some(ramp), None, "theory", None, 3).unwrap();
        let label = crate::deck_meta::create_label(&conn, Some(id), "Cut candidate", "amber")
            .unwrap()
            .id;
        crate::deck_meta::set_card_label(&conn, id, "serra-lea", draw, "live", None, Some(label))
            .unwrap();
        (conn, id)
    }

    fn ramp(conn: &Connection, deck_id: i64) -> i64 {
        category(conn, deck_id, "Ramp")
    }

    fn draw(conn: &Connection, deck_id: i64) -> i64 {
        category(conn, deck_id, "Draw")
    }

    /// The card commands, each driven once over the same fixture.
    fn card_write_cases() -> Vec<Case> {
        vec![
            ("deck_add_card", nothing, |c, id| {
                crate::deck::add_card(c, id, "serra-lea", Some(ramp(c, id)), None, "live", None, 4)
                    .unwrap();
            }),
            ("deck_add_card (folding onto a row)", nothing, |c, id| {
                crate::deck::add_card(c, id, "bolt-lea", Some(ramp(c, id)), None, "live", None, 3)
                    .unwrap();
            }),
            ("deck_set_card_quantity", nothing, |c, id| {
                crate::deck::set_card_quantity(c, id, "bolt-lea", ramp(c, id), "live", None, 7)
                    .unwrap();
            }),
            ("deck_set_card_quantity (zero)", nothing, |c, id| {
                crate::deck::set_card_quantity(c, id, "bolt-lea", ramp(c, id), "live", None, 0)
                    .unwrap();
            }),
            (
                // The label and the `needs_review` sentence are what a reversal rebuilt from the
                // audit payload would lose: that row records a category, a quantity and a
                // reason, and the label the reader put on the card is in none of them.
                "deck_set_card_quantity (zero, a labelled row)",
                nothing,
                |c, id| {
                    crate::deck::set_card_quantity(
                        c,
                        id,
                        "serra-lea",
                        draw(c, id),
                        "live",
                        None,
                        0,
                    )
                    .unwrap();
                },
            ),
            ("deck_move_card", nothing, |c, id| {
                let to = draw(c, id);
                crate::deck::move_card(
                    c,
                    id,
                    "bolt-lea",
                    ramp(c, id),
                    Some(to),
                    None,
                    "live",
                    None,
                )
                .unwrap();
            }),
            (
                "deck_move_card (folding onto a row)",
                |c, id| {
                    crate::deck::add_card(
                        c,
                        id,
                        "bolt-lea",
                        Some(draw(c, id)),
                        None,
                        "live",
                        None,
                        5,
                    )
                    .unwrap();
                },
                |c, id| {
                    let to = draw(c, id);
                    crate::deck::move_card(
                        c,
                        id,
                        "bolt-lea",
                        ramp(c, id),
                        Some(to),
                        None,
                        "live",
                        None,
                    )
                    .unwrap();
                },
            ),
            (
                // The name arm, which **creates** the pile it moves into — `add_card`'s second
                // entrance, grown on this command by main while this branch was open. Undo has
                // to take the column away along with the card that made it, or the deck keeps a
                // heading for a card that is no longer under it.
                "deck_move_card (inventing a category by name)",
                nothing,
                |c, id| {
                    crate::deck::move_card(
                        c,
                        id,
                        "bolt-lea",
                        ramp(c, id),
                        None,
                        Some("Landfall"),
                        "live",
                        None,
                    )
                    .unwrap();
                },
            ),
            ("deck_swap_printing", nothing, |c, id| {
                crate::deck::swap_printing(
                    c,
                    id,
                    "bolt-lea",
                    "bolt-m10",
                    ramp(c, id),
                    "live",
                    None,
                )
                .unwrap();
            }),
            (
                // **The row comes back at the finish it had, or undo is a silent data loss.**
                // `CardRow::finish` is the whole of what makes this pass; without it the row is
                // restored with the right count in the wrong object, which nothing on screen
                // announces and no other assertion here would catch.
                "deck_set_card_finish",
                // `bolt-m10` rather than `bolt-lea`, because Alpha printed no foils and
                // `set_card_finish` reads `cards.finishes` — the fixture's lists are the real
                // ones. `fresh` files this printing under `theory`, so the live row is made here.
                |c, id| {
                    crate::deck::add_card(
                        c,
                        id,
                        "bolt-m10",
                        Some(ramp(c, id)),
                        None,
                        "live",
                        None,
                        2,
                    )
                    .unwrap();
                },
                |c, id| {
                    crate::deck::set_card_finish(
                        c,
                        id,
                        "bolt-m10",
                        ramp(c, id),
                        "live",
                        None,
                        Some("foil"),
                    )
                    .unwrap();
                },
            ),
            (
                // The fold, which is the half a boolean in the audit payload cannot reverse:
                // two rows became one, and only the recorded rows say what the two were.
                "deck_set_card_finish (folding onto a row)",
                |c, id| {
                    for finish in [None, Some("foil")] {
                        crate::deck::add_card(
                            c,
                            id,
                            "bolt-m10",
                            Some(ramp(c, id)),
                            None,
                            "live",
                            finish,
                            5,
                        )
                        .unwrap();
                    }
                },
                |c, id| {
                    crate::deck::set_card_finish(
                        c,
                        id,
                        "bolt-m10",
                        ramp(c, id),
                        "live",
                        None,
                        Some("foil"),
                    )
                    .unwrap();
                },
            ),
            (
                "deck_swap_printing (folding onto a row)",
                |c, id| {
                    crate::deck::add_card(
                        c,
                        id,
                        "bolt-m10",
                        Some(ramp(c, id)),
                        None,
                        "live",
                        None,
                        6,
                    )
                    .unwrap();
                },
                |c, id| {
                    crate::deck::swap_printing(
                        c,
                        id,
                        "bolt-lea",
                        "bolt-m10",
                        ramp(c, id),
                        "live",
                        None,
                    )
                    .unwrap();
                },
            ),
            ("deck_category_clear", nothing, |c, id| {
                crate::deck::clear_category(c, id, ramp(c, id), "live").unwrap();
            }),
            (
                // The same press one scope out, and the case above cannot stand in for it:
                // [`fresh`] puts live cards in **two** piles, so this step carries a cell per
                // pile where that one carries a single cell. A `clear_variant` that recorded
                // only the pile it happened to read first would pass every assertion the
                // category clear makes and lose a whole column to Ctrl+Z.
                "deck_clear",
                nothing,
                |c, id| {
                    crate::deck::clear_variant(c, id, "live").unwrap();
                },
            ),
            (
                // The name arm, which **creates** a pile. Undo has to take the column away
                // again along with the card that made it — otherwise the deck keeps a
                // `Landfall` heading for a card it no longer holds, which TypeScript happens to
                // hide (an empty `auto` pile draws nothing) and which is a lie either way.
                "deck_add_card (inventing a category by name)",
                nothing,
                |c, id| {
                    crate::deck::add_card(
                        c,
                        id,
                        "serra-lea",
                        None,
                        Some("Landfall"),
                        "live",
                        None,
                        2,
                    )
                    .unwrap();
                },
            ),
        ]
    }

    /// The deck-row, import and theory writes.
    fn deck_write_cases() -> Vec<Case> {
        vec![
            ("deck_update (name)", nothing, |c, id| {
                crate::deck::update_deck(
                    c,
                    id,
                    &crate::deck::DeckPatch {
                        name: Some("Burn v2".to_owned()),
                        ..Default::default()
                    },
                )
                .unwrap();
            }),
            // Schema v18's column, driven here rather than trusted to ride along: [`snapshot`]
            // sweeps [`DECK_FIELDS`], so a column added to the patch and *not* to that list
            // would leave this case passing while the platform stayed where the press put it.
            ("deck_update (game)", nothing, |c, id| {
                crate::deck::update_deck(
                    c,
                    id,
                    &crate::deck::DeckPatch {
                        game_key: Some("arena".to_owned()),
                        ..Default::default()
                    },
                )
                .unwrap();
            }),
            // Schema v26's column, driven for the reason the case above it is: [`snapshot`]
            // sweeps [`DECK_FIELDS`], so a column added to the patch and *not* to that list
            // would leave this case passing while the bracket stayed where the press put it.
            ("deck_update (bracket)", nothing, |c, id| {
                crate::deck::update_deck(
                    c,
                    id,
                    &crate::deck::DeckPatch {
                        bracket: Some(4),
                        ..Default::default()
                    },
                )
                .unwrap();
            }),
            (
                // **Two history rows, one step, one Ctrl+Z.** A cursor that could land between
                // them would put half a settings form back.
                //
                // The second field is arbitrary and is only here to make the press two facts —
                // it was `is_built` until schema v25 dropped that column, and `archived` says
                // the same nothing in its place.
                "deck_update (two fields at once)",
                nothing,
                |c, id| {
                    crate::deck::update_deck(
                        c,
                        id,
                        &crate::deck::DeckPatch {
                            name: Some("Burn v2".to_owned()),
                            archived: Some(true),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                },
            ),
            (
                // The one deck-row write that moves cards. The audit row says
                // `{field:"theory",from:false,to:true}` and nothing anywhere else records which
                // rows were live — this case is why the journal exists at all.
                "deck_update (theory on, which moves the live list)",
                nothing,
                |c, id| {
                    crate::deck::update_deck(
                        c,
                        id,
                        &crate::deck::DeckPatch {
                            theory_enabled: Some(true),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                },
            ),
            (
                // Schema v40's kind, driven for the reason `game` and `bracket` above it are —
                // [`snapshot`] sweeps [`DECK_FIELDS`], so a column added to the patch and not to
                // that list leaves the case passing while the deck stays where the press put it
                // — and for one more of its own. This is the only patch field whose write moves
                // **two** columns: `deck::deck_kind` clears `theory_enabled` as it sets this, so
                // a list carrying one of the pair and not the other would let Ctrl+Z restore the
                // plan and leave the deck virtual, which is `1/1` — the pair that names no kind
                // at all. The deck is switched to theory first so that both halves have
                // somewhere to move from.
                //
                // **What this case does not claim** is that the cardboard comes back: becoming
                // virtual also files the deck's copies into `Recently removed` and deletes its
                // group, and a step writes neither table. `snapshot` reads `decks` and
                // `deck_cards`, which is exactly the scope an undo restores.
                "deck_update (virtual, which clears the theory flag with it)",
                |c: &Connection, id: i64| {
                    crate::deck::update_deck(
                        c,
                        id,
                        &crate::deck::DeckPatch {
                            theory_enabled: Some(true),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                },
                |c, id| {
                    crate::deck::update_deck(
                        c,
                        id,
                        &crate::deck::DeckPatch {
                            virtual_only: Some(true),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                },
            ),
            ("deck_set_folder", nothing, |c, id| {
                let folder = crate::deck_meta::create_folder(c, None, "Commander")
                    .unwrap()
                    .id;
                crate::deck::set_folder(c, id, Some(folder)).unwrap();
            }),
            (
                // `None` is a real value here rather than "leave it", which is the whole reason
                // this is a command and not a `DeckPatch` field — and the half an undo needs.
                "deck_set_folder (back to the root)",
                |c, id| {
                    let folder = crate::deck_meta::create_folder(c, None, "Commander")
                        .unwrap()
                        .id;
                    crate::deck::set_folder(c, id, Some(folder)).unwrap();
                },
                |c, id| {
                    crate::deck::set_folder(c, id, None).unwrap();
                },
            ),
            ("deck_theory_copy_from_live", nothing, |c, id| {
                crate::deck_theory::copy_from_live(c, id).unwrap();
            }),
            ("deck_import_commit (merge)", nothing, |c, id| {
                crate::import::commit_import(
                    c,
                    id,
                    "live",
                    "merge",
                    &[imported("bolt-m10", 4, "Ramp")],
                )
                .unwrap();
            }),
            (
                // The mode that clears the list first. Its `remove` row records `cleared: 42` —
                // a count, which cannot rebuild a decklist.
                "deck_import_commit (replace)",
                nothing,
                |c, id| {
                    crate::import::commit_import(
                        c,
                        id,
                        "live",
                        "replace",
                        &[imported("serra-lea", 4, "Ramp")],
                    )
                    .unwrap();
                },
            ),
            (
                "deck_import_commit (inventing categories)",
                nothing,
                |c, id| {
                    crate::import::commit_import(
                        c,
                        id,
                        "live",
                        "merge",
                        &[
                            imported("bolt-m10", 2, "Burn"),
                            imported("serra-lea", 1, "Angels"),
                        ],
                    )
                    .unwrap();
                },
            ),
            (
                // Archidekt's `^Keeper,#4aab08^`. `snapshot` reads **every** `deck_labels` row, so
                // this case is what proves a step sweeps the labels the import invented — a
                // reversal that left them behind would restore the deck and fail here on two
                // extra `label` lines.
                "deck_import_commit (inventing labels)",
                nothing,
                |c, id| {
                    crate::import::commit_import(
                        c,
                        id,
                        "live",
                        "merge",
                        &[
                            labelled("bolt-m10", "Ramp", "Keeper", "#4aab08"),
                            labelled("serra-lea", "Ramp", "Fence", "#fffc19"),
                        ],
                    )
                    .unwrap();
                },
            ),
        ]
    }

    /// The category and label writes.
    fn meta_write_cases() -> Vec<Case> {
        vec![
            ("deck_category_create", nothing, |c, id| {
                crate::deck_meta::create_category(c, id, "Removal").unwrap();
            }),
            ("deck_category_rename", nothing, |c, id| {
                crate::deck_meta::rename_category(c, ramp(c, id), "Acceleration").unwrap();
            }),
            ("deck_category_set_active (off)", nothing, |c, id| {
                crate::deck_meta::set_category_active(c, ramp(c, id), false).unwrap();
            }),
            ("deck_category_reorder", nothing, |c, id| {
                let ids: Vec<i64> = crate::deck_undo::read_categories(c, id)
                    .unwrap()
                    .into_iter()
                    .rev()
                    .map(|cat| cat.id)
                    .collect();
                crate::deck_meta::reorder_categories(c, id, &ids).unwrap();
            }),
            (
                // The CASCADE case: the pile goes and takes its cards, in **both** variants.
                // Its history row says `cards: 7` and calls that "the only part of a deleted
                // category a reader cannot get back".
                "deck_category_delete (cascading its cards)",
                |c, id| {
                    crate::deck::add_card(
                        c,
                        id,
                        "serra-lea",
                        Some(ramp(c, id)),
                        None,
                        "theory",
                        None,
                        2,
                    )
                    .unwrap();
                },
                |c, id| {
                    crate::deck_meta::delete_category(c, ramp(c, id), None).unwrap();
                },
            ),
            (
                // The move arm, which folds into whatever the target already held — so the
                // step has to carry the target's rows too, or undoing gains the deck cards.
                "deck_category_delete (moving its cards, folding)",
                |c, id| {
                    crate::deck::add_card(
                        c,
                        id,
                        "bolt-lea",
                        Some(draw(c, id)),
                        None,
                        "live",
                        None,
                        5,
                    )
                    .unwrap();
                },
                |c, id| {
                    crate::deck_meta::delete_category(c, ramp(c, id), Some(draw(c, id))).unwrap();
                },
            ),
            (
                // The `default_category_id` clean-up: deleting the pile a deck files by puts
                // the deck back on Auto, and undo has to put the pile *and* the setting back.
                "deck_category_delete (the deck's default pile)",
                |c, id| {
                    crate::deck::update_deck(
                        c,
                        id,
                        &crate::deck::DeckPatch {
                            default_category_id: Some(ramp(c, id)),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                },
                |c, id| {
                    crate::deck_meta::delete_category(c, ramp(c, id), None).unwrap();
                },
            ),
            ("deck_label_create", nothing, |c, id| {
                crate::deck_meta::create_label(c, Some(id), "Keep", "jade").unwrap();
            }),
            (
                "deck_label_update (renaming and recolouring)",
                nothing,
                |c, id| {
                    let label = label_id(c, id);
                    crate::deck_meta::update_label(c, Some(id), label, "Cut", "jade").unwrap();
                },
            ),
            (
                // `SET NULL` un-labels N cards on the way out, and the history counts them.
                "deck_label_delete (un-labelling its cards)",
                nothing,
                |c, id| {
                    crate::deck_meta::delete_label(c, Some(id), label_id(c, id)).unwrap();
                },
            ),
            ("deck_card_set_label", nothing, |c, id| {
                let label = label_id(c, id);
                crate::deck_meta::set_card_label(
                    c,
                    id,
                    "bolt-lea",
                    ramp(c, id),
                    "live",
                    None,
                    Some(label),
                )
                .unwrap();
            }),
            ("deck_card_set_label (clearing one)", nothing, |c, id| {
                crate::deck_meta::set_card_label(
                    c,
                    id,
                    "serra-lea",
                    draw(c, id),
                    "live",
                    None,
                    None,
                )
                .unwrap();
            }),
        ]
    }

    /// The label [`fresh`] seeds. **No deck in the lookup**, since v21 there is none on the row
    /// — and no ambiguity either: these fixtures seed one deck and one label.
    fn label_id(conn: &Connection, _deck_id: i64) -> i64 {
        conn.query_row("SELECT id FROM deck_labels", [], |r| r.get(0))
            .unwrap()
    }

    /// One line of an imported decklist.
    fn imported(card_id: &str, quantity: i64, category: &str) -> crate::import::ImportItem {
        crate::import::ImportItem {
            card_id: card_id.to_owned(),
            quantity,
            category_name: category.to_owned(),
            // An ordinary counted pile, which is what an import has always made. The flag says
            // the *file* called this pile a maybeboard (Archidekt's `{noDeck}`); a journal test
            // about restoring rows has no opinion about that, nor about the finish.
            inactive: false,
            finish: None,
            // No label. The label half of an import's step has its own tests below, which name
            // their own items for the reason this helper names none.
            label_name: None,
            label_color: None,
        }
    }

    /// One imported line wearing Archidekt's `^Name,#rrggbb^`.
    fn labelled(
        card_id: &str,
        category: &str,
        label: &str,
        color: &str,
    ) -> crate::import::ImportItem {
        crate::import::ImportItem {
            label_name: Some(label.to_owned()),
            label_color: Some(color.to_owned()),
            ..imported(card_id, 1, category)
        }
    }

    /// **The rule this journal exists for.** Every deck write records a step, and undoing that
    /// step puts the deck back exactly — row for row over `deck_cards`, `deck_categories`,
    /// `deck_labels` and every `decks` column a step may write.
    ///
    /// Written as a list of cases rather than as ten tests for
    /// `every_deck_write_leaves_exactly_one_audit_row`'s reason, one module over: the claim is
    /// about the **set** of commands, and a new write that records no step fails here the
    /// moment its line is added. **Count the list, never a remembered number.**
    ///
    /// **The `folding onto a row` cases are the point of the list.** Add, move and swap all
    /// sum into a row the category already holds, and the history records only that they did —
    /// a boolean, or a delta. Those three are where a reversal built out of the audit payload
    /// is not merely lossy but *wrong*, deleting a row the reader put there separately.
    #[test]
    fn undoing_any_card_write_restores_the_deck_exactly() {
        drive_cases(card_write_cases());
    }

    /// The same claim for the deck-row, import and theory writes. A separate test rather than a
    /// longer list so a failure names which family broke.
    #[test]
    fn undoing_any_deck_row_write_restores_the_deck_exactly() {
        drive_cases(deck_write_cases());
    }

    /// And for the category and label writes.
    #[test]
    fn undoing_any_category_or_label_write_restores_the_deck_exactly() {
        drive_cases(meta_write_cases());
    }

    /// Drive each case once over a fresh deck: set up, snapshot, write, undo, compare, redo,
    /// compare.
    fn drive_cases(cases: Vec<Case>) {
        for (name, setup, drive) in cases {
            let (conn, id) = fresh();
            setup(&conn, id);
            let before = snapshot(&conn, id);

            drive(&conn, id);
            assert_ne!(
                snapshot(&conn, id),
                before,
                "`{name}` must actually change the deck, or the case proves nothing"
            );
            let audit_id = next_undo(&conn, id)
                .unwrap()
                .unwrap_or_else(|| panic!("`{name}` recorded no undo step"));
            let after = snapshot(&conn, id);

            undo(&conn, id).unwrap();
            assert_eq!(snapshot(&conn, id), before, "`{name}` must undo exactly");

            redo(&conn, id, audit_id).unwrap();
            assert_eq!(snapshot(&conn, id), after, "`{name}` must redo exactly");
        }
    }

    /// **The half `drive_cases` cannot show for the deck kind: that it is on [`DECK_FIELDS`] at
    /// all.**
    ///
    /// [`snapshot`] iterates that constant, so a column dropped off it disappears from *both*
    /// sides of the comparison and every case in the sweep goes on passing — an assertion that
    /// reads the constant it is asserting about, which is exactly the shape of green that says
    /// nothing. The `game_key` and `bracket` cases above carry comments claiming the sweep
    /// covers them; measured on 2026-09-08 by taking `virtual_only` off the list, it does not,
    /// and this test is what does. It reads the two columns with SQL of its own.
    ///
    /// **Both halves of the pair, because the write moves both.** `deck::deck_kind` clears
    /// `theory_enabled` as it sets `virtual_only`, so a `DECK_FIELDS` carrying one and not the
    /// other would let Ctrl+Z restore the plan and leave the deck virtual — `1/1`, the pair that
    /// names no kind at all, arriving from the one direction no command can produce.
    #[test]
    fn undoing_a_kind_change_puts_both_halves_of_the_pair_back() {
        let (conn, id) = fresh();
        let kind = |c: &Connection| -> (i64, i64) {
            c.query_row(
                "SELECT theory_enabled, virtual_only FROM decks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(kind(&conn), (1, 0), "a deck with a plan");

        crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                virtual_only: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(kind(&conn), (0, 1), "one press, two columns");
        let audit_id = next_undo(&conn, id).unwrap().unwrap();

        undo(&conn, id).unwrap();
        assert_eq!(kind(&conn), (1, 0), "and one Ctrl+Z, both back");

        redo(&conn, id, audit_id).unwrap();
        assert_eq!(kind(&conn), (0, 1), "and forward again");
    }

    /// The half `drive_cases` cannot show: undoing an import sweeps the labels it **invented**
    /// and leaves the reader's own alone.
    ///
    /// The sweep above starts from `fresh`, whose one label predates the write, so it proves the
    /// invented ones go and says nothing about the difference. Here there is a label of the
    /// reader's *and* two of the file's, and only the two go — which is `push_made_labels`' whole
    /// job and matters because `deck_labels` is app-wide since schema v21.
    #[test]
    fn undoing_an_import_sweeps_only_the_labels_it_made() {
        let (conn, id) = fresh();
        let names = |c: &Connection| {
            let mut stmt = c
                .prepare("SELECT name FROM deck_labels ORDER BY name")
                .unwrap();
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .unwrap()
                .map(Result::unwrap)
                .collect::<Vec<_>>();
            rows
        };
        let mine = names(&conn);
        assert_eq!(mine.len(), 1, "`fresh` makes exactly one label");

        crate::import::commit_import(
            &conn,
            id,
            "live",
            "merge",
            &[
                labelled("bolt-m10", "Ramp", "Keeper", "#4aab08"),
                labelled("serra-lea", "Ramp", "Fence", "#fffc19"),
            ],
        )
        .unwrap();
        let audit_id = next_undo(&conn, id).unwrap().unwrap();
        assert_eq!(names(&conn).len(), 3);

        undo(&conn, id).unwrap();
        assert_eq!(
            names(&conn),
            mine,
            "the reader's label is not the import's to sweep"
        );

        redo(&conn, id, audit_id).unwrap();
        assert_eq!(names(&conn).len(), 3, "and redo puts the two back");
        let worn: Option<String> = conn
            .query_row(
                "SELECT t.name FROM deck_cards dc
                   JOIN deck_labels t ON t.id = dc.label_id
                  WHERE dc.deck_id = ?1 AND dc.card_id = 'bolt-m10'",
                params![id],
                |r| r.get(0),
            )
            .optional()
            .unwrap();
        assert_eq!(
            worn.as_deref(),
            Some("Keeper"),
            "the card wears it again — `Op::Labels` restores before `Op::Variant` inserts, and              `insert_cards` remaps the id"
        );
    }

    /// **A `deck_undo` row written before schema v33 still reads, and still undoes exactly.**
    ///
    /// That rung renamed `deck_tags` to `deck_labels` and `deck_cards.tag_id` to `label_id`, and
    /// it deliberately keeps every step it finds rather than clearing the stack the way v21 did.
    /// The JSON keys moved with the Rust fields, so three `#[serde(alias)]`es are the whole of
    /// what makes that decision true — see [`CardRow::label_id`] for which of them bites hardest.
    ///
    /// **Both halves are driven, because they fail differently.** `{"op":"tags"}` raises, which a
    /// reader would at least see; `"tagId"` is discarded, which would put the cards back
    /// unlabelled and report success. The second is the one a test has to hold.
    ///
    /// **Written by rewinding the stored text rather than by building a `Step`**, because the
    /// thing under test is a spelling nothing in this build can produce any more: a `Step`
    /// serialised here would carry the new names and the test would pass with no aliases at all.
    #[test]
    fn a_step_written_before_v33_still_reads_and_still_undoes() {
        let (conn, id) = fresh();
        let before = snapshot(&conn, id);

        // Two presses, because no one step carries both shapes. The quantity change records an
        // `Op::Cards` over a row that wears a label — that is the `tagId` half — and the delete
        // records an `Op::Labels` with a carrier apiece, which is the `{"op":"tags"}` half.
        crate::deck::set_card_quantity(&conn, id, "serra-lea", draw(&conn, id), "live", None, 4)
            .unwrap();
        let quantity_step = next_undo(&conn, id).unwrap().unwrap();
        crate::deck_meta::delete_label(&conn, Some(id), label_id(&conn, id)).unwrap();
        let label_step = next_undo(&conn, id).unwrap().unwrap();

        let mut wound_back = String::new();
        for audit_id in [quantity_step, label_step] {
            let stored: String = conn
                .query_row(
                    "SELECT step FROM deck_undo WHERE audit_id = ?1",
                    params![audit_id],
                    |r| r.get(0),
                )
                .unwrap();
            let old = stored
                .replace(r#""op":"labels""#, r#""op":"tags""#)
                .replace(r#""labelId""#, r#""tagId""#);
            assert_ne!(old, stored, "step {audit_id} carried no new spelling");
            assert!(!old.contains(r#""labelId""#), "{old}");
            conn.execute(
                "UPDATE deck_undo SET step = ?2 WHERE audit_id = ?1",
                params![audit_id, &old],
            )
            .unwrap();
            wound_back.push_str(&old);
        }
        // The fixture has to carry both old spellings, or this passes against the very step it
        // was written to avoid producing.
        assert!(wound_back.contains(r#""op":"tags""#), "{wound_back}");
        assert!(wound_back.contains(r#""tagId":"#), "{wound_back}");

        undo(&conn, id).unwrap();
        undo(&conn, id).unwrap();
        assert_eq!(
            snapshot(&conn, id),
            before,
            "an old step puts the deck back exactly, the label on the card included"
        );
    }

    /// The primitive the whole module rests on: a scope is exact in both directions — every
    /// cell it names is emptied, and no cell it does not name is touched.
    #[test]
    fn a_cards_op_restores_exactly_the_cells_it_names_and_nothing_else() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        let draw = category(&conn, id, "Draw");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", None, 2).unwrap();
        crate::deck::add_card(&conn, id, "serra-lea", Some(draw), None, "live", None, 1).unwrap();

        let scope = vec![Cell::card("live", ramp, "bolt-lea")];
        let before = read_cells(&conn, id, &scope).unwrap();
        crate::deck::set_card_quantity(&conn, id, "bolt-lea", ramp, "live", None, 5).unwrap();
        assert_eq!(quantity(&conn, id, ramp, "bolt-lea"), 5);

        apply(
            &conn,
            id,
            &[Op::Cards {
                scope: scope.clone(),
                rows: before,
            }],
        )
        .unwrap();

        assert_eq!(
            quantity(&conn, id, ramp, "bolt-lea"),
            2,
            "the named cell is back as it was"
        );
        assert_eq!(
            quantity(&conn, id, draw, "serra-lea"),
            1,
            "a cell the scope did not name is untouched"
        );
    }

    /// A cell with no card id is the whole pile, which is what a clear and a category delete
    /// are about — and it must not reach the same printing in another pile.
    #[test]
    fn a_pile_cell_covers_every_card_of_that_category_and_no_other() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        let draw = category(&conn, id, "Draw");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", None, 2).unwrap();
        crate::deck::add_card(&conn, id, "serra-lea", Some(ramp), None, "live", None, 3).unwrap();
        crate::deck::add_card(&conn, id, "bolt-lea", Some(draw), None, "live", None, 1).unwrap();

        let scope = vec![Cell::pile("live", ramp)];
        let before = read_cells(&conn, id, &scope).unwrap();
        assert_eq!(before.len(), 2);
        crate::deck::clear_category(&conn, id, ramp, "live").unwrap();

        apply(
            &conn,
            id,
            &[Op::Cards {
                scope,
                rows: before,
            }],
        )
        .unwrap();

        assert_eq!(quantity(&conn, id, ramp, "bolt-lea"), 2);
        assert_eq!(quantity(&conn, id, ramp, "serra-lea"), 3);
        assert_eq!(
            quantity(&conn, id, draw, "bolt-lea"),
            1,
            "the same printing in another pile is a different cell"
        );
    }

    /// A category comes back with its own id, and the cards under it still resolve — the
    /// ordinary case, where nothing has taken the id.
    #[test]
    fn a_deleted_category_comes_back_with_its_own_id() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", None, 4).unwrap();

        let row = read_category(&conn, ramp).unwrap().unwrap();
        let cards = read_cells(&conn, id, &[Cell::pile("live", ramp)]).unwrap();
        crate::deck_meta::delete_category(&conn, ramp, None).unwrap();

        apply(
            &conn,
            id,
            &[
                Op::Categories {
                    restore: vec![row],
                    patch: vec![],
                    delete: vec![],
                    default_category_id: None,
                },
                Op::Cards {
                    scope: vec![Cell::pile("live", ramp)],
                    rows: cards,
                },
            ],
        )
        .unwrap();

        assert_eq!(quantity(&conn, id, ramp, "bolt-lea"), 4);
        assert_eq!(read_category(&conn, ramp).unwrap().unwrap().name, "Ramp");
    }

    /// The case the remap exists for. `deck_categories.id` is a rowid alias, so deleting the
    /// highest-numbered pile and creating another one **reuses the number** — and a step that
    /// re-inserted under its recorded id would either collide or file the reader's cards into
    /// a pile they made a moment ago. Neither is a thing a test would notice from row counts,
    /// which is why this one follows the cards.
    #[test]
    fn a_restored_category_keeps_its_cards_even_when_its_id_was_reused() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", None, 4).unwrap();

        let row = read_category(&conn, ramp).unwrap().unwrap();
        let cards = read_cells(&conn, id, &[Cell::pile("live", ramp)]).unwrap();
        crate::deck_meta::delete_category(&conn, ramp, None).unwrap();

        // The reader makes another pile, which takes the freed rowid.
        let usurper = crate::deck_meta::create_category(&conn, id, "Draw")
            .unwrap()
            .id;
        assert_eq!(
            usurper, ramp,
            "the fixture only tests anything if the id was reused"
        );

        apply(
            &conn,
            id,
            &[
                Op::Categories {
                    restore: vec![row],
                    patch: vec![],
                    delete: vec![],
                    default_category_id: None,
                },
                Op::Cards {
                    scope: vec![Cell::pile("live", ramp)],
                    rows: cards,
                },
            ],
        )
        .unwrap();

        let restored: i64 = conn
            .query_row(
                "SELECT id FROM deck_categories WHERE deck_id = ?1 AND name = 'Ramp'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(restored, ramp, "it had to move, because Draw holds that id");
        assert_eq!(
            quantity(&conn, id, restored, "bolt-lea"),
            4,
            "the cards followed it through the remap"
        );
        assert_eq!(
            quantity(&conn, id, usurper, "bolt-lea"),
            0,
            "and none of them landed in the pile that took the id"
        );
    }

    /// Write one note straight into `deck_notes` and answer its id.
    ///
    /// **Raw SQL rather than `deck_notes::create_note`**, deliberately: what is under test here
    /// is [`Op::Notes`]' replay, and driving it through the command would make the fixture
    /// depend on that module's refusals, its audit row and its own step — three things that can
    /// fail this test for reasons that are not this test's.
    fn note(conn: &Connection, deck_id: i64, title: &str, body: &str, sort_order: i64) -> i64 {
        conn.query_row(
            "INSERT INTO deck_notes (deck_id, title, body, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, title, body, sort_order],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The note's title, body and sort order as they are now, or `None`.
    fn read_note(conn: &Connection, id: i64) -> Option<(String, String, i64)> {
        conn.query_row(
            "SELECT title, body, sort_order FROM deck_notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap()
    }

    /// Which cards a note names, in oracle-id order.
    fn attached(conn: &Connection, note_id: i64) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT oracle_id FROM deck_note_cards WHERE note_id = ?1 ORDER BY oracle_id")
            .unwrap();
        let rows = stmt
            .query_map(params![note_id], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        rows
    }

    /// [`a_restored_category_keeps_its_cards_even_when_its_id_was_reused`] over `deck_notes`,
    /// and the reason [`Op::Notes`] carries two lists rather than one — user schema v43.
    ///
    /// `deck_notes.id` is a rowid alias, so deleting the highest-numbered note and writing a new
    /// one **reuses the number**. A single list deciding by "is there a row at this id" would
    /// therefore find the reader's newest note sitting where the deleted one was and rewrite it
    /// into the deleted one's title and body — a Ctrl+Z that destroys a note the reader wrote
    /// *after* the change being undone, silently, with the row count unchanged either way. That
    /// is why this test follows the *attachment* as well: a restore that landed on the usurper
    /// would also hang the deleted note's card off the reader's newer one.
    #[test]
    fn a_restored_note_keeps_its_cards_even_when_its_id_was_reused() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let mana = note(&conn, id, "Mana", "Fourteen sources.", 0);
        conn.execute(
            "INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (?1, 'o1', unixepoch(), unixepoch())",
            params![mana],
        )
        .unwrap();

        // What the delete's step would have recorded, read before the write it reverses —
        // this module's whole discipline.
        let recorded = NoteRow {
            id: mana,
            deck_id: id,
            title: "Mana".to_owned(),
            body: "Fourteen sources.".to_owned(),
            sort_order: 0,
        };
        let cards = vec![NoteCard {
            note_id: mana,
            oracle_id: "o1".to_owned(),
        }];

        conn.execute("DELETE FROM deck_notes WHERE id = ?1", params![mana])
            .unwrap();
        assert!(
            attached(&conn, mana).is_empty(),
            "the CASCADE took the attachment, which is why `attachments` is a set and not a diff"
        );

        // The reader writes another note, which takes the freed rowid.
        let usurper = note(&conn, id, "Sideboard", "Bolt on the draw.", 1);
        assert_eq!(
            usurper, mana,
            "the fixture only tests anything if the id was reused"
        );

        apply(
            &conn,
            id,
            &[Op::Notes {
                restore: vec![recorded],
                patch: vec![],
                delete: vec![],
                attachments: cards,
            }],
        )
        .unwrap();

        assert_eq!(
            read_note(&conn, usurper),
            Some(("Sideboard".to_owned(), "Bolt on the draw.".to_owned(), 1)),
            "the reader's newer note is untouched — the failure a single list would produce"
        );

        let restored: i64 = conn
            .query_row(
                "SELECT id FROM deck_notes WHERE deck_id = ?1 AND title = 'Mana'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(
            restored, mana,
            "it had to move, because the newer note holds that id"
        );
        assert_eq!(
            read_note(&conn, restored),
            Some(("Mana".to_owned(), "Fourteen sources.".to_owned(), 0)),
            "and it came back whole rather than as a row with the right title"
        );
        assert_eq!(
            attached(&conn, restored),
            vec!["o1".to_owned()],
            "the card followed it through the remap"
        );
        assert!(
            attached(&conn, usurper).is_empty(),
            "and it did not land on the note that took the id"
        );
    }

    /// The other three lists, and the property that makes a replay safe.
    ///
    /// **`attachments` is the whole set for the notes in the step**, so applying the same step
    /// twice leaves one row per card and not two — which is what the arm's delete-then-insert
    /// buys and what a diff could not. `patch` puts an existing note's columns back without
    /// touching its id, `delete` takes a note away and the CASCADE takes its cards, and a patch
    /// naming a note that is not there is [`MISSING_ROW`] rather than a silent success.
    #[test]
    fn a_notes_op_patches_deletes_and_rebuilds_the_attachment_set() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let mana = note(&conn, id, "Mana", "Fourteen sources.", 0);
        let plan = note(&conn, id, "Plan", "Race them.", 1);
        conn.execute(
            "INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (?1, 'o2', unixepoch(), unixepoch())",
            params![mana],
        )
        .unwrap();

        let step = [Op::Notes {
            restore: vec![],
            patch: vec![NoteRow {
                id: mana,
                deck_id: id,
                title: "Mana base".to_owned(),
                body: "Fifteen sources.".to_owned(),
                sort_order: 3,
            }],
            delete: vec![plan],
            attachments: vec![
                NoteCard {
                    note_id: mana,
                    oracle_id: "o1".to_owned(),
                },
                NoteCard {
                    note_id: mana,
                    oracle_id: "o2".to_owned(),
                },
            ],
        }];

        apply(&conn, id, &step).unwrap();
        assert_eq!(
            read_note(&conn, mana),
            Some(("Mana base".to_owned(), "Fifteen sources.".to_owned(), 3)),
            "a patch puts the columns back and leaves the id alone"
        );
        assert_eq!(
            read_note(&conn, plan),
            None,
            "and the delete took the other"
        );
        assert_eq!(
            attached(&conn, mana),
            vec!["o1".to_owned(), "o2".to_owned()]
        );

        // Replayed. Every statement in the arm is idempotent, which is what "delete exactly the
        // scope and insert exactly the rows" promises — a second pass must not double the set.
        apply(&conn, id, &step).unwrap();
        assert_eq!(
            attached(&conn, mana),
            vec!["o1".to_owned(), "o2".to_owned()],
            "the set was rebuilt rather than added to"
        );

        // A patch naming a note that is not there is a step built wrong at its call site, and
        // the alternative is a `0 rows changed` reporting success — `patch_category`'s rule.
        let err = apply(
            &conn,
            id,
            &[Op::Notes {
                restore: vec![],
                patch: vec![NoteRow {
                    id: plan,
                    deck_id: id,
                    title: "Plan".to_owned(),
                    body: "Race them.".to_owned(),
                    sort_order: 1,
                }],
                delete: vec![],
                attachments: vec![],
            }],
        )
        .unwrap_err();
        assert_eq!(err, MISSING_ROW);
    }

    /// A step reaches the deck it was recorded against and no other.
    ///
    /// `deck_notes.id` is unique across the whole table, so a patch or a delete addressed by id
    /// alone would reach a *different deck's* note — and the strict-stack cursor cannot fence
    /// that, because it only promises the step is replayed against the deck it was filed under.
    /// `AND deck_id = ?` in both statements is what does, and the refusal is [`MISSING_ROW`]
    /// rather than a quiet no-op.
    #[test]
    fn a_notes_op_cannot_reach_another_decks_notebook() {
        let conn = seeded();
        let mine = deck(&conn, "Burn");
        let theirs = deck(&conn, "Storm");
        let elsewhere = note(&conn, theirs, "Theirs", "Not yours.", 0);

        let err = apply(
            &conn,
            mine,
            &[Op::Notes {
                restore: vec![],
                patch: vec![NoteRow {
                    id: elsewhere,
                    deck_id: theirs,
                    title: "Rewritten".to_owned(),
                    body: "By the wrong step.".to_owned(),
                    sort_order: 0,
                }],
                delete: vec![],
                attachments: vec![],
            }],
        )
        .unwrap_err();
        assert_eq!(err, MISSING_ROW);

        apply(
            &conn,
            mine,
            &[Op::Notes {
                restore: vec![],
                patch: vec![],
                delete: vec![elsewhere],
                attachments: vec![],
            }],
        )
        .unwrap();
        assert_eq!(
            read_note(&conn, elsewhere),
            Some(("Theirs".to_owned(), "Not yours.".to_owned(), 0)),
            "the delete named another deck's note and left it standing"
        );
    }

    /// Undoing a note's **first** attach takes its attachment set back to empty.
    ///
    /// ⚠️ **The case a scope drawn from `attachments` cannot reach, and the reason the arm
    /// unions all four lists.** `deck_notes::attach_card` records a step whose undo names the
    /// note in `patch` and carries an **empty** `attachments` — because that is what the note
    /// held before the press. A scope read off `attachments` would be empty too, so the arm
    /// would clear nothing, insert nothing, and answer `Ok(())` over a row that is still there:
    /// the card goes on wearing a note glyph in a deck whose history says the attach was
    /// reversed, and no count anywhere changes. Redoing a detach is the same step from the
    /// other end.
    #[test]
    fn undoing_the_first_attach_on_a_note_leaves_it_naming_nothing() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let mana = note(&conn, id, "Mana", "Fourteen sources.", 0);
        conn.execute(
            "INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (?1, 'o1', unixepoch(), unixepoch())",
            params![mana],
        )
        .unwrap();
        assert_eq!(attached(&conn, mana), vec!["o1".to_owned()]);

        // The undo side of an attach: the note row as it stood, and the set it held before —
        // which is nothing at all.
        apply(
            &conn,
            id,
            &[Op::Notes {
                restore: vec![],
                patch: vec![NoteRow {
                    id: mana,
                    deck_id: id,
                    title: "Mana".to_owned(),
                    body: "Fourteen sources.".to_owned(),
                    sort_order: 0,
                }],
                delete: vec![],
                attachments: vec![],
            }],
        )
        .unwrap();

        assert!(
            attached(&conn, mana).is_empty(),
            "the attachment survived its own undo — the card would keep a note glyph it lost"
        );
        assert_eq!(
            read_note(&conn, mana),
            Some(("Mana".to_owned(), "Fourteen sources.".to_owned(), 0)),
            "and the note itself is untouched: an attach is not a note edit"
        );
    }

    /// A `Notes` step survives the round trip through the JSON column it is stored in — and
    /// **without a `#[serde(alias)]`**, which is the one thing about this variant that is a
    /// decision rather than a copy of [`Op::Labels`].
    ///
    /// The aliases on `Labels` exist because schema v33 renamed something steps already on disk
    /// had written down; `Notes` has never had another spelling, so a step carrying one would
    /// be a step no build has ever produced. The four lists are `#[serde(default)]` all the
    /// same, for the reason every list on the four variants above is: a step that names three
    /// of them is the ordinary case.
    #[test]
    fn a_notes_step_round_trips_through_its_json_column() {
        let step = Step::new(
            vec![Op::Notes {
                restore: vec![NoteRow {
                    id: 4,
                    deck_id: 1,
                    title: String::new(),
                    body: "Untitled on purpose.".to_owned(),
                    sort_order: 2,
                }],
                patch: vec![],
                delete: vec![9],
                attachments: vec![NoteCard {
                    note_id: 4,
                    oracle_id: "o1".to_owned(),
                }],
            }],
            vec![],
        );
        let json = serde_json::to_string(&step).unwrap();
        assert_eq!(
            serde_json::from_str::<Step>(&json).unwrap(),
            step,
            "the step that comes back out is the step that went in"
        );
        // camelCase on the wire, `deck_undo`'s convention throughout — and the tag is `notes`,
        // which is what an internally-tagged enum refuses to read if it drifts.
        assert!(
            json.contains(r#""op":"notes""#) && json.contains(r#""sortOrder":2"#),
            "the stored spelling is the one every reader of this column expects: {json}"
        );

        // The ordinary sparse step: three lists absent, and `#[serde(default)]` reads each as
        // empty rather than failing the press.
        let sparse: Op = serde_json::from_str(r#"{"op":"notes","delete":[3]}"#).unwrap();
        assert_eq!(
            sparse,
            Op::Notes {
                restore: vec![],
                patch: vec![],
                delete: vec![3],
                attachments: vec![],
            }
        );
    }

    /// A `Deck` op writes the SQLite value the column came out as, never its JSON text — a
    /// `theory_enabled` of `"true"` is a string SQLite stores happily and every later read
    /// sees as neither 0 nor 1.
    ///
    /// **The null half rode `notes` until user schema v43 took the column away**, and it is
    /// `description` now rather than gone: what it pins is that a `Value::Null` reaches SQLite
    /// as a NULL and not as the four characters `null`, which needs *a* nullable column on
    /// [`DECK_FIELDS`] and does not care which. `description` is the nearest one — same
    /// `TEXT`, same nullability, and the column `notes` spent its whole life being contrasted
    /// with.
    #[test]
    fn a_deck_op_restores_a_flag_as_a_number_and_a_null_as_null() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let before = read_deck_fields(&conn, id, &["theory_enabled", "description"]).unwrap();

        conn.execute(
            "UPDATE decks SET theory_enabled = 1, description = 'x' WHERE id = ?1",
            params![id],
        )
        .unwrap();

        apply(&conn, id, &[Op::Deck { fields: before }]).unwrap();

        let (theory, description): (i64, Option<String>) = conn
            .query_row(
                "SELECT theory_enabled, description FROM decks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(theory, 0);
        assert_eq!(description, None);
    }

    /// A bracket the reader set and then took back, through the two real commands — schema v26.
    ///
    /// **`deck_write_cases` already sweeps this field and this test is not a duplicate of it.**
    /// That sweep compares a whole-deck snapshot and would go green if `bracket` were simply
    /// missing from [`DECK_FIELDS`] *and* from [`snapshot`]'s sweep, since the sweep reads the
    /// list rather than the table. This one names the column, so a bracket that fell off both
    /// ends at once still fails here — the shape of the hole `src-tauri/CLAUDE.md` calls a mock
    /// encoding an impossible state.
    ///
    /// **Both directions**, because an undo that restored the value it was already at would
    /// look identical to a working one from either end alone: Auto → 4 and back to Auto, then
    /// the redo that puts 4 back.
    #[test]
    fn undoing_a_bracket_change_puts_the_deck_back_on_auto() {
        let conn = seeded();
        let id = deck(&conn, "Atraxa");
        let bracket = |c: &Connection| -> i64 {
            c.query_row(
                "SELECT bracket FROM decks WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(bracket(&conn), 0, "a new deck is on Auto");

        crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                bracket: Some(4),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(bracket(&conn), 4);

        let audit_id = next_undo(&conn, id).unwrap().expect("a step to reverse");
        undo(&conn, id).unwrap();
        assert_eq!(bracket(&conn), 0, "Ctrl+Z puts the deck back on Auto");

        redo(&conn, id, audit_id).unwrap();
        assert_eq!(
            bracket(&conn),
            4,
            "and Ctrl+Y puts the reader's answer back"
        );
    }

    /// The fence against a refactor, not against a user: a step naming a column nobody decided
    /// was undoable is refused by name rather than executed as SQL.
    #[test]
    fn a_deck_op_refuses_a_column_that_is_not_on_the_list() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let mut fields = serde_json::Map::new();
        fields.insert("updated_at".to_owned(), json!(0));

        let refused = apply(&conn, id, &[Op::Deck { fields }]).unwrap_err();

        assert!(refused.contains("updated_at"), "{refused}");
    }

    /// The cursor is the newest step still applied, and it is per deck — two decks edited in
    /// one sitting must not undo into each other.
    #[test]
    fn the_cursor_is_the_newest_applied_step_of_that_deck() {
        let conn = seeded();
        let burn = deck(&conn, "Burn");
        let angels = deck(&conn, "Angels");
        let step = Step::new(vec![], vec![]);
        let audit = |deck_id: i64| -> i64 {
            crate::deck_audit::record(
                &conn,
                deck_id,
                "live",
                crate::deck_audit::ADD,
                None,
                &json!({}),
                0,
            )
            .unwrap();
            conn.last_insert_rowid()
        };

        let first = audit(burn);
        record_step(&conn, first, burn, &step).unwrap();
        let second = audit(burn);
        record_step(&conn, second, burn, &step).unwrap();
        let other = audit(angels);
        record_step(&conn, other, angels, &step).unwrap();

        assert_eq!(next_undo(&conn, burn).unwrap(), Some(second));
        assert_eq!(next_undo(&conn, angels).unwrap(), Some(other));

        conn.execute(
            "UPDATE deck_undo SET undone_at = unixepoch() WHERE audit_id = ?1",
            params![second],
        )
        .unwrap();
        assert_eq!(
            next_undo(&conn, burn).unwrap(),
            Some(first),
            "an undone step is stepped over, not undone twice"
        );
    }

    /// **The stack stays linear**, which is the property that makes Ctrl+Z twice go back two
    /// changes rather than toggling one.
    ///
    /// An undo is a deck write and records its own history row — the drawer would otherwise
    /// have a hole in it exactly where the reader was working — but that row gets **no step**,
    /// so the cursor walks straight past it to the change below.
    #[test]
    fn an_undo_records_history_but_is_not_itself_a_step() {
        let (conn, id) = fresh();
        let first = next_undo(&conn, id).unwrap().unwrap();
        crate::deck::add_card(
            &conn,
            id,
            "serra-lea",
            Some(ramp(&conn, id)),
            None,
            "live",
            None,
            1,
        )
        .unwrap();
        let second = next_undo(&conn, id).unwrap().unwrap();
        assert_ne!(first, second);

        undo(&conn, id).unwrap();

        let entry = crate::deck_audit::by_id(&conn, conn.last_insert_rowid())
            .unwrap()
            .unwrap();
        assert_eq!(
            entry.kind,
            crate::deck_audit::DECK,
            "the undo is in the history"
        );
        let payload: Value = serde_json::from_str(&entry.payload).unwrap();
        assert_eq!(payload, json!({ "field": "undo", "of": second }));
        assert_eq!(
            read_step(&conn, entry.id).unwrap(),
            None,
            "and is not itself undoable, or Ctrl+Z twice would toggle one change"
        );
        assert_eq!(
            next_undo(&conn, id).unwrap(),
            Some(first),
            "the cursor moved down to the change before it"
        );
    }

    /// The day header's `+7 / −6` still adds up: undoing an add of two copies takes two copies
    /// out of the day's arithmetic, because that is what happened.
    #[test]
    fn an_undo_negates_the_delta_and_a_redo_carries_it_straight() {
        let (conn, id) = fresh();
        crate::deck::add_card(
            &conn,
            id,
            "serra-lea",
            Some(ramp(&conn, id)),
            None,
            "live",
            None,
            2,
        )
        .unwrap();
        let added = next_undo(&conn, id).unwrap().unwrap();
        assert_eq!(
            crate::deck_audit::by_id(&conn, added)
                .unwrap()
                .unwrap()
                .delta,
            2
        );

        undo(&conn, id).unwrap();
        let undone = crate::deck_audit::by_id(&conn, conn.last_insert_rowid())
            .unwrap()
            .unwrap();
        assert_eq!(undone.delta, -2);

        redo(&conn, id, added).unwrap();
        let redone = crate::deck_audit::by_id(&conn, conn.last_insert_rowid())
            .unwrap()
            .unwrap();
        assert_eq!(redone.delta, 2);
    }

    /// The toolbar can be a moment behind the deck. Undoing "the most recent change" when the
    /// most recent change is not the one on the button is the surprise this feature must not
    /// produce, so the id is checked against the cursor rather than trusted.
    #[test]
    fn undoing_a_change_that_is_no_longer_the_newest_is_refused_by_name() {
        let (conn, id) = fresh();
        crate::deck::add_card(
            &conn,
            id,
            "serra-lea",
            Some(ramp(&conn, id)),
            None,
            "live",
            None,
            1,
        )
        .unwrap();
        let stale = next_undo(&conn, id).unwrap().unwrap();
        crate::deck::add_card(
            &conn,
            id,
            "bolt-m10",
            Some(ramp(&conn, id)),
            None,
            "live",
            None,
            1,
        )
        .unwrap();
        let before = snapshot(&conn, id);

        let refused = apply_reversal(&conn, id, stale, true).unwrap_err();

        assert!(refused.contains("edited since"), "{refused}");
        assert_eq!(snapshot(&conn, id), before, "and it changed nothing");
    }

    /// Redo is the webview's list, so the id it hands back can be one this deck has not undone
    /// — a second window, or a step already redone. Refused rather than applied twice.
    #[test]
    fn redoing_a_change_that_was_never_undone_is_refused_by_name() {
        let (conn, id) = fresh();
        crate::deck::add_card(
            &conn,
            id,
            "serra-lea",
            Some(ramp(&conn, id)),
            None,
            "live",
            None,
            1,
        )
        .unwrap();
        let applied = next_undo(&conn, id).unwrap().unwrap();

        let refused = apply_reversal(&conn, id, applied, false).unwrap_err();

        assert!(refused.contains("not been undone"), "{refused}");
    }

    /// A step filed under another deck is not this deck's to undo, however the id arrived.
    #[test]
    fn a_step_belonging_to_another_deck_is_refused() {
        let (conn, burn) = fresh();
        let angels = deck(&conn, "Angels");
        let pile = category(&conn, angels, "Ramp");
        crate::deck::add_card(
            &conn,
            angels,
            "serra-lea",
            Some(pile),
            None,
            "live",
            None,
            1,
        )
        .unwrap();
        let theirs = next_undo(&conn, angels).unwrap().unwrap();

        let refused = apply_reversal(&conn, burn, theirs, true).unwrap_err();

        assert!(refused.contains("edited since"), "{refused}");
    }

    /// The state command answers what the two buttons would do, and **the redo half is the
    /// caller's id** — the redo stack lives in the webview and dies with the window.
    #[test]
    fn the_state_command_answers_both_buttons() {
        let (conn, id) = fresh();
        crate::deck::add_card(
            &conn,
            id,
            "serra-lea",
            Some(ramp(&conn, id)),
            None,
            "live",
            None,
            1,
        )
        .unwrap();
        let added = next_undo(&conn, id).unwrap().unwrap();

        // Before any undo, the id names a step that is still applied, so there is no redo.
        assert!(matches!(read_step(&conn, added).unwrap(), Some((_, false))));

        undo(&conn, id).unwrap();
        let (step, undone) = read_step(&conn, added).unwrap().unwrap();
        assert!(undone, "the stamp persists, so undo survives a restart");
        assert!(!step.redo.is_empty(), "and the forward half is still there");
    }

    /// The transaction rule, proven by breaking it — `deck_audit`'s own test one table over.
    /// A step that committed while the change it reverses rolled back would be applied into a
    /// deck that never had it done.
    #[test]
    fn a_recorded_step_that_rolls_back_leaves_no_journal_entry() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        crate::deck_audit::record(
            &conn,
            id,
            "live",
            crate::deck_audit::ADD,
            None,
            &json!({}),
            0,
        )
        .unwrap();
        let audit_id = conn.last_insert_rowid();

        let tx = conn.unchecked_transaction().unwrap();
        record_step(&tx, audit_id, id, &Step::new(vec![], vec![])).unwrap();
        drop(tx);

        assert_eq!(next_undo(&conn, id).unwrap(), None);
    }

    /// `bolt-lea`'s quantity in `Ramp`'s live pile — the cell the staleness cases below edit.
    fn bolt(conn: &Connection, deck_id: i64) -> i64 {
        quantity(conn, deck_id, ramp(conn, deck_id), "bolt-lea")
    }

    /// Step `bolt-lea` in `Ramp` to `to`, through the command the stepper calls.
    fn step_bolt(conn: &Connection, deck_id: i64, to: i64) -> i64 {
        let ramp = ramp(conn, deck_id);
        crate::deck::set_card_quantity(conn, deck_id, "bolt-lea", ramp, "live", None, to).unwrap();
        next_undo(conn, deck_id).unwrap().unwrap()
    }

    /// Step `serra-lea` in `Draw` to `to` — a second cell, which shares nothing with `bolt-lea`'s.
    fn step_serra(conn: &Connection, deck_id: i64, to: i64) -> i64 {
        let draw = draw(conn, deck_id);
        crate::deck::set_card_quantity(conn, deck_id, "serra-lea", draw, "live", None, to).unwrap();
        next_undo(conn, deck_id).unwrap().unwrap()
    }

    /// **The step-filing half of a stale redo.** Window A undoes a change and keeps its id on its
    /// redo stack; window B edits the same card, which files a step of its own. A's stack is only
    /// cleared by A's own writes, so A's Ctrl+Y still names the undone change — and applying it
    /// would put A's old quantity over B's newer one.
    #[test]
    fn a_redo_is_refused_once_another_window_has_filed_a_change() {
        let (conn, id) = fresh();
        let a = step_bolt(&conn, id, 3);
        undo(&conn, id).unwrap();

        step_bolt(&conn, id, 5);
        let before = snapshot(&conn, id);

        let refused = redo(&conn, id, a).unwrap_err();

        assert_eq!(refused, MOVED_ON);
        assert_eq!(
            snapshot(&conn, id),
            before,
            "and window B's 5 is still the deck's"
        );
        assert_eq!(bolt(&conn, id), 5);
    }

    /// **The half of a stale redo no cursor can see.** The same stale redo, over a write that files
    /// no step — a sync pull, a cut, the copy another deck's filing took. The undone change is
    /// still the one the next redo would take, so only the rows themselves can say the deck has
    /// moved on.
    #[test]
    fn a_redo_is_refused_when_its_cells_changed_without_a_step() {
        let (conn, id) = fresh();
        let a = step_bolt(&conn, id, 3);
        undo(&conn, id).unwrap();
        conn.execute(
            "UPDATE deck_cards SET quantity = 7
              WHERE deck_id = ?1 AND card_id = 'bolt-lea' AND variant = 'live'",
            params![id],
        )
        .unwrap();
        let before = snapshot(&conn, id);

        let refused = redo(&conn, id, a).unwrap_err();

        assert_eq!(refused, MOVED_ON);
        assert_eq!(
            snapshot(&conn, id),
            before,
            "the 7 nobody filed a step for stays"
        );
        assert!(
            matches!(read_step(&conn, a).unwrap(), Some((_, true))),
            "and a refused redo changes nothing, the journal included"
        );
    }

    /// **Redo mirrors undo's cursor.** Two changes to two cells, both undone: the one undone last
    /// is the only one a redo may take, exactly as the newest applied change is the only one an
    /// undo may take. The cells do not overlap, so nothing but the order can refuse this.
    #[test]
    fn only_the_change_undone_last_can_be_redone() {
        let (conn, id) = fresh();
        let first = step_bolt(&conn, id, 3);
        let second = step_serra(&conn, id, 4);
        undo(&conn, id).unwrap();
        undo(&conn, id).unwrap();
        let before = snapshot(&conn, id);

        let refused = redo(&conn, id, second).unwrap_err();
        assert_eq!(refused, MOVED_ON);
        assert_eq!(snapshot(&conn, id), before, "and it changed nothing");

        redo(&conn, id, first).unwrap();
        redo(&conn, id, second).unwrap();
        assert_eq!(bolt(&conn, id), 3);
        assert_eq!(quantity(&conn, id, draw(&conn, id), "serra-lea"), 4);
    }

    /// **An edit made after an undo cuts that branch off for good** — in the database, and not
    /// only in the window that made it. Both changes end up undone and the dead one has the lower
    /// id, so only the order they were undone in can tell them apart — and a wall-clock
    /// `undone_at` cannot: two presses inside one second tie (and a tie broken by id picks the
    /// dead one), and a clock that steps back puts the later press first.
    ///
    /// **The dead stamp is pushed a hundred seconds ahead to make that deterministic**, rather
    /// than hoping both presses land in one second: `undone_at` is an ordinal that must strictly
    /// increase within a deck, and a wall-clock stamp fails this case every time.
    #[test]
    fn a_change_undone_before_a_later_edit_can_never_be_redone() {
        let (conn, id) = fresh();
        let dead = step_bolt(&conn, id, 3);
        undo(&conn, id).unwrap();
        conn.execute(
            "UPDATE deck_undo SET undone_at = unixepoch() + 100 WHERE audit_id = ?1",
            params![dead],
        )
        .unwrap();
        let live = step_serra(&conn, id, 4);
        undo(&conn, id).unwrap();
        let stamp = |audit_id: i64| -> i64 {
            conn.query_row(
                "SELECT undone_at FROM deck_undo WHERE audit_id = ?1",
                params![audit_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(
            stamp(live) > stamp(dead),
            "the change undone last carries the later stamp"
        );

        assert_eq!(redo(&conn, id, dead).unwrap_err(), MOVED_ON);
        redo(&conn, id, live).unwrap();
        assert_eq!(
            redo(&conn, id, dead).unwrap_err(),
            MOVED_ON,
            "and it stays dead once the change above it is back"
        );
        assert_eq!(bolt(&conn, id), 2, "the dead branch never came back");
    }

    /// The Redo button asks the same question the press does, so a window whose redo has been
    /// overtaken draws a greyed button rather than one that refuses when pressed.
    #[test]
    fn the_redo_button_is_offered_only_for_the_change_a_redo_would_take() {
        let (conn, id) = fresh();
        let first = step_bolt(&conn, id, 3);
        let second = step_serra(&conn, id, 4);
        undo(&conn, id).unwrap();
        undo(&conn, id).unwrap();

        assert!(
            undo_state(&conn, id, Some(second)).unwrap().redo.is_none(),
            "the second change cannot come back before the first"
        );
        assert_eq!(
            undo_state(&conn, id, Some(first))
                .unwrap()
                .redo
                .map(|e| e.id),
            Some(first)
        );
    }

    /// A connection with `foreign_keys` on, as [`crate::db::open`] hands out every one the app
    /// uses — the folder cases below are about what the `REFERENCES deck_folders(id)` on
    /// `decks.folder_id` does, and an in-memory database starts without it.
    fn seeded_with_fks() -> Connection {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn
    }

    /// The four `decks` columns the folder cases below are about, as they are now.
    fn deck_columns(
        conn: &Connection,
        id: i64,
    ) -> (String, Option<i64>, Option<String>, Option<String>) {
        conn.query_row(
            "SELECT name, folder_id, last_group_by, description FROM decks WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap()
    }

    /// **A rename undone after its folder was deleted.** Every `deck_update` step records every column [`DECK_FIELDS`] names, so
    /// a rename carries the deck's folder on both sides. Deleting that folder from the gallery
    /// SET-NULLs `folder_id` with no step, by design — and an undo that wrote every recorded
    /// column put the deleted folder's id back into a real foreign key, failed, and left the
    /// cursor on a step that could never succeed. The view state and a column another device
    /// synced were reverted by the same statement list, silently.
    ///
    /// Undoing the rename writes the name and nothing else, and the step below it is refused
    /// **and retired** rather than left to refuse every press after it.
    #[test]
    fn undoing_a_rename_writes_the_name_and_leaves_every_other_column_where_it_now_is() {
        let conn = seeded_with_fks();
        let id = deck(&conn, "Burn");
        let folder = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;
        crate::deck::set_folder(&conn, id, Some(folder)).unwrap();
        let filed = next_undo(&conn, id).unwrap().unwrap();
        crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                name: Some("Burn v2".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let renamed = next_undo(&conn, id).unwrap().unwrap();

        // Three writes that file no step: the gallery's folder delete, a tab switch, and a
        // column another device changed and synced.
        crate::deck_meta::delete_folder(&conn, folder).unwrap();
        crate::deck::set_view_state(
            &conn,
            id,
            &crate::deck::DeckViewState {
                group_by: Some("type".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        conn.execute(
            "UPDATE decks SET description = 'Synced from the laptop.' WHERE id = ?1",
            params![id],
        )
        .unwrap();

        apply_reversal(&conn, id, renamed, true).unwrap();

        assert_eq!(
            deck_columns(&conn, id),
            (
                "Burn".to_owned(),
                None,
                Some("type".to_owned()),
                Some("Synced from the laptop.".to_owned())
            ),
            "the name went back and nothing the rename did not change moved"
        );

        assert_eq!(next_undo(&conn, id).unwrap(), Some(filed));
        let refused = apply_reversal(&conn, id, filed, true).unwrap_err();
        assert_eq!(
            refused, RETIRED,
            "the deck is not in the folder that step filed it in any more"
        );
        assert_eq!(
            next_undo(&conn, id).unwrap(),
            None,
            "and the cursor moved on — a step that can never apply is not left to wedge it"
        );
    }

    /// **The folder a reversal would write.** Moving a deck from F to G and then
    /// deleting F leaves the deck exactly where the step says it is — so the rows agree — and the
    /// undo would write F's id into a real foreign key. It is refused in words, with the deck left
    /// in G, and the cursor moves on.
    #[test]
    fn undoing_a_move_out_of_a_folder_deleted_since_is_refused_and_moves_the_cursor_on() {
        let conn = seeded_with_fks();
        let id = deck(&conn, "Burn");
        let from = crate::deck_meta::create_folder(&conn, None, "Old")
            .unwrap()
            .id;
        let to = crate::deck_meta::create_folder(&conn, None, "New")
            .unwrap()
            .id;
        crate::deck::set_folder(&conn, id, Some(from)).unwrap();
        let first = next_undo(&conn, id).unwrap().unwrap();
        crate::deck::set_folder(&conn, id, Some(to)).unwrap();
        let second = next_undo(&conn, id).unwrap().unwrap();
        crate::deck_meta::delete_folder(&conn, from).unwrap();

        let refused = apply_reversal(&conn, id, second, true).unwrap_err();

        assert_eq!(refused, RETIRED);
        assert_eq!(deck_columns(&conn, id).1, Some(to), "the deck stays in G");
        assert_eq!(
            next_undo(&conn, id).unwrap(),
            Some(first),
            "and the next Ctrl+Z is the change below it, not the same refusal"
        );
    }

    /// **The view state is not a reason to refuse.** Turning theory on with an empty plan moves
    /// the live list into it and `last_variant` to `theory`, and switching tabs afterwards moves
    /// that again through `set_view_state`, which files no step. The deck has not been *edited*
    /// since, so Ctrl+Z still works.
    ///
    /// **Not [`fresh`]**: its plan already holds a card, so the switch moves nothing and leaves
    /// `last_variant` alone — and this case would pass with the view columns compared.
    #[test]
    fn switching_tabs_after_turning_theory_on_does_not_block_its_undo() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", None, 2).unwrap();
        crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let kind = |c: &Connection| -> (i64, String) {
            c.query_row(
                "SELECT theory_enabled, last_variant FROM decks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap()
        };
        assert_eq!(
            kind(&conn),
            (1, "theory".to_owned()),
            "the press moved the view, or this case proves nothing"
        );
        crate::deck::set_view_state(
            &conn,
            id,
            &crate::deck::DeckViewState {
                variant: Some("live".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        undo(&conn, id).unwrap();

        assert_eq!(kind(&conn).0, 0);
        assert_eq!(
            quantity(&conn, id, ramp, "bolt-lea"),
            2,
            "and the list is live again"
        );
    }

    /// `Op::Categories`' `default_category_id`, on [`Op::Deck`]'s rule: a category delete records
    /// the deck's default on both sides, and where the delete did not move it, an undo has no
    /// business writing it back over one another device changed since.
    #[test]
    fn undoing_a_category_delete_leaves_a_default_it_did_not_move_alone() {
        let (conn, id) = fresh();
        let draw = draw(&conn, id);
        crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                default_category_id: Some(draw),
                ..Default::default()
            },
        )
        .unwrap();
        crate::deck_meta::delete_category(&conn, ramp(&conn, id), None).unwrap();
        conn.execute(
            "UPDATE decks SET default_category_id = 0 WHERE id = ?1",
            params![id],
        )
        .unwrap();

        undo(&conn, id).unwrap();

        let default: i64 = conn
            .query_row(
                "SELECT default_category_id FROM decks WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(default, 0, "the synced Auto stands");
        assert_eq!(bolt(&conn, id), 2, "and the pile and its cards came back");
    }

    /// `Op::Categories`: a pile changed without a step is not overwritten by an undo.
    #[test]
    fn undoing_a_pile_rename_is_refused_once_the_pile_changed_without_a_step() {
        let (conn, id) = fresh();
        let ramp = ramp(&conn, id);
        crate::deck_meta::rename_category(&conn, ramp, "Acceleration").unwrap();
        conn.execute(
            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
            params![ramp],
        )
        .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        let (name, active): (String, bool) = conn
            .query_row(
                "SELECT name, is_active FROM deck_categories WHERE id = ?1",
                params![ramp],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((name.as_str(), active), ("Acceleration", false));
    }

    /// `Op::Labels`: a label is app-wide, so it can be renamed from somewhere that files no step
    /// in this deck — the Appearance panel files none anywhere. Ctrl+Z here must not put the old
    /// name over that one.
    #[test]
    fn undoing_a_label_rename_is_refused_once_the_label_was_renamed_elsewhere() {
        let (conn, id) = fresh();
        let label = label_id(&conn, id);
        crate::deck_meta::update_label(&conn, Some(id), label, "Keep", "amber").unwrap();
        crate::deck_meta::update_label(&conn, None, label, "Trade", "amber").unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert_eq!(read_label(&conn, label).unwrap().unwrap().name, "Trade");
    }

    /// `Op::Labels`' carriers: taking a label off this deck's cards and then having one of them
    /// labelled again by a write that files no step. Undoing the removal would put the old label
    /// over the new one.
    #[test]
    fn undoing_a_label_removal_is_refused_once_a_carrier_was_relabelled_without_a_step() {
        let (conn, id) = fresh();
        let label = label_id(&conn, id);
        crate::deck_meta::remove_label_from_deck(&conn, id, label, "live").unwrap();
        let other = crate::deck_meta::create_label(&conn, None, "Trade", "jade")
            .unwrap()
            .id;
        conn.execute(
            "UPDATE deck_cards SET label_id = ?2 WHERE deck_id = ?1 AND card_id = 'serra-lea'",
            params![id, other],
        )
        .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        let worn: Option<i64> = conn
            .query_row(
                "SELECT label_id FROM deck_cards WHERE deck_id = ?1 AND card_id = 'serra-lea'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(worn, Some(other));
    }

    /// `Op::Notes`: a note body another device synced is not overwritten by an undo of an edit
    /// made before it.
    #[test]
    fn undoing_a_note_edit_is_refused_once_the_note_changed_without_a_step() {
        let (conn, id) = fresh();
        let note = crate::deck_notes::create_note(&conn, id, "Mana", "Fourteen sources.", &[])
            .unwrap()
            .id;
        crate::deck_notes::update_note(&conn, id, note, Some("Mana base"), None).unwrap();
        conn.execute(
            "UPDATE deck_notes SET body = 'Fifteen, from the laptop.' WHERE id = ?1",
            params![note],
        )
        .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert_eq!(
            read_note(&conn, note),
            Some((
                "Mana base".to_owned(),
                "Fifteen, from the laptop.".to_owned(),
                0
            ))
        );
    }

    /// `Op::Notes`' attachment set: undoing an attach rebuilds the note's whole set, so a card
    /// another device attached since would be taken off with it.
    #[test]
    fn undoing_an_attach_is_refused_once_the_note_named_another_card_without_a_step() {
        let (conn, id) = fresh();
        let note = crate::deck_notes::create_note(&conn, id, "Mana", "Fourteen sources.", &[])
            .unwrap()
            .id;
        crate::deck_notes::attach_card(&conn, id, note, "o1").unwrap();
        conn.execute(
            "INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (?1, 'o2', unixepoch(), unixepoch())",
            params![note],
        )
        .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert_eq!(
            attached(&conn, note),
            vec!["o1".to_owned(), "o2".to_owned()]
        );
    }

    /// The deck's piles by name — whether a pile of that name is there, and how many.
    fn piles_named(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM deck_categories WHERE deck_id = ?1 AND name = ?2",
            params![deck_id, name],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// **Any write a reversal cannot make retires its step, not only the ones the check
    /// foresees.** Undoing a pile delete restores the pile and then its cards — and a card that
    /// wore a label deleted since from the Appearance panel (which files no step) fails the
    /// label's foreign key at the second op, after the first has written. Every press failed the
    /// same way with the cursor never moving; now the half-written undo is rolled back and the
    /// step retired.
    #[test]
    fn an_undo_whose_write_fails_is_rolled_back_and_retired() {
        let (conn, id) = fresh();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let below = next_undo(&conn, id).unwrap().unwrap();
        crate::deck_meta::delete_category(&conn, draw(&conn, id), None).unwrap();
        let deleted = next_undo(&conn, id).unwrap().unwrap();
        crate::deck_meta::delete_label(&conn, None, label_id(&conn, id)).unwrap();

        assert_eq!(
            apply_reversal(&conn, id, deleted, true).unwrap_err(),
            RETIRED
        );
        assert_eq!(
            piles_named(&conn, id, "Draw"),
            0,
            "the pile the first op restored went back out with the failed second"
        );
        assert_eq!(
            next_undo(&conn, id).unwrap(),
            Some(below),
            "and the cursor moved on"
        );
    }

    /// The same over a pile's name: a pile deleted with a step and made again with none — the
    /// Collection tab's filing by name makes one — passes the check and then fails the
    /// `(deck_id, name)` index on every press.
    #[test]
    fn undoing_a_pile_delete_after_the_pile_was_made_again_is_retired() {
        let (conn, id) = fresh();
        let below = next_undo(&conn, id).unwrap().unwrap();
        crate::deck_meta::delete_category(&conn, ramp(&conn, id), None).unwrap();
        crate::deck_meta::category_for_name(&conn, id, "Ramp").unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert_eq!(piles_named(&conn, id, "Ramp"), 1);
        assert_eq!(next_undo(&conn, id).unwrap(), Some(below));
    }

    /// **A delete in the side being applied takes whatever sits under it, not only what the step
    /// recorded.** Undoing "New category" deletes the pile, and a card filed into it since by a
    /// write that files no step — the Collection tab — would go with it through the CASCADE,
    /// leaving its copies in the deck's group with no row claiming them.
    #[test]
    fn undoing_a_new_pile_is_retired_once_a_card_was_filed_into_it_without_a_step() {
        let (conn, id) = fresh();
        let pile = crate::deck_meta::create_category(&conn, id, "Removal")
            .unwrap()
            .id;
        conn.execute(
            "INSERT INTO deck_cards
                 (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                  name, quantity, created_at, updated_at)
             VALUES (?1, ?2, 'live', 'bolt-m10', 'm10', '146', 'en', 'Lightning Bolt', 1,
                     unixepoch(), unixepoch())",
            params![id, pile],
        )
        .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert_eq!(quantity(&conn, id, pile, "bolt-m10"), 1);
    }

    /// A second deck playing Serra Angel, for the label cases: a label is app-wide, so the card
    /// a reversal must not touch can be in a deck whose journal this one's cursor cannot see.
    fn angels(conn: &Connection) -> (i64, i64) {
        let other = deck(conn, "Angels");
        let pile = category(conn, other, "Main");
        crate::deck::add_card(conn, other, "serra-lea", Some(pile), None, "live", None, 1).unwrap();
        (other, pile)
    }

    /// The label a card in a deck wears, if any.
    fn worn(conn: &Connection, deck_id: i64) -> Option<i64> {
        conn.query_row(
            "SELECT label_id FROM deck_cards WHERE deck_id = ?1 AND card_id = 'serra-lea'",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The same rule over a label, whose delete clears it off every card in every deck. Undoing
    /// "New label" here must not take it off a card another deck labelled with it since — that
    /// press filed its step in *that* deck's journal.
    #[test]
    fn undoing_a_new_label_is_retired_once_another_deck_wears_it() {
        let (conn, id) = fresh();
        let keep = crate::deck_meta::create_label(&conn, Some(id), "Keep", "jade")
            .unwrap()
            .id;
        let (other, pile) = angels(&conn);
        crate::deck_meta::set_card_label(&conn, other, "serra-lea", pile, "live", None, Some(keep))
            .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert!(read_label(&conn, keep).unwrap().is_some());
        assert_eq!(worn(&conn, other), Some(keep));
    }

    /// And from the redo end: a label delete undone, the label then put on a card in another
    /// deck, then Ctrl+Y — the redo's delete would take it off a card the step never recorded
    /// wearing it.
    #[test]
    fn redoing_a_label_delete_is_refused_once_a_card_it_never_recorded_wears_the_label() {
        let (conn, id) = fresh();
        let label = label_id(&conn, id);
        crate::deck_meta::delete_label(&conn, Some(id), label).unwrap();
        let deleted = next_undo(&conn, id).unwrap().unwrap();
        undo(&conn, id).unwrap();
        let (other, pile) = angels(&conn);
        crate::deck_meta::set_card_label(
            &conn,
            other,
            "serra-lea",
            pile,
            "live",
            None,
            Some(label),
        )
        .unwrap();

        assert_eq!(redo(&conn, id, deleted).unwrap_err(), MOVED_ON);
        assert!(read_label(&conn, label).unwrap().is_some());
        assert_eq!(worn(&conn, other), Some(label));
    }

    /// Undoing a label delete puts the label back on every card that wore it, and one of them may
    /// wear another label since, put there by a write that files no step. The delete's redo side
    /// records no carriers — its own SET NULL is what cleared them — so it is the carriers being
    /// *applied* that are checked: a cell may be bare and nothing else.
    #[test]
    fn undoing_a_label_delete_is_retired_once_a_card_that_wore_it_wears_another() {
        let (conn, id) = fresh();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let label = label_id(&conn, id);
        // Made first, so it cannot take the deleted label's rowid.
        let trade = crate::deck_meta::create_label(&conn, None, "Trade", "jade")
            .unwrap()
            .id;
        crate::deck_meta::delete_label(&conn, Some(id), label).unwrap();
        conn.execute(
            "UPDATE deck_cards SET label_id = ?2 WHERE deck_id = ?1 AND card_id = 'serra-lea'",
            params![id, trade],
        )
        .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert_eq!(worn(&conn, id), Some(trade));
    }

    /// The same, when the label made since was **handed the deleted one's rowid**: a card wearing
    /// that id wears the new label, not the one the undo restores, and the restore — which moves
    /// to a fresh id — would relabel it anyway.
    #[test]
    fn undoing_a_label_delete_leaves_a_label_that_took_its_id_alone() {
        let (conn, id) = fresh();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let label = label_id(&conn, id);
        crate::deck_meta::delete_label(&conn, Some(id), label).unwrap();
        let trade = crate::deck_meta::create_label(&conn, None, "Trade", "jade")
            .unwrap()
            .id;
        assert_eq!(
            trade, label,
            "the case only tests anything if the id was reused"
        );
        conn.execute(
            "UPDATE deck_cards SET label_id = ?2 WHERE deck_id = ?1 AND card_id = 'serra-lea'",
            params![id, trade],
        )
        .unwrap();

        assert_eq!(undo(&conn, id).unwrap_err(), RETIRED);
        assert_eq!(worn(&conn, id), Some(trade));
    }
}
