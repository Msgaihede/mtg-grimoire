//! Decks: the gallery, the deck itself, and what sits in each of its categories.
//!
//! Shaped like [`crate::collection`]: pure functions over a `Connection`, testable without a
//! Tauri app, wrapped in `async` commands that run on the blocking pool. Writes take
//! `AppState.db` through [`crate::db::lock_for`] and answer [`crate::collection::BUSY`]
//! rather than waiting; the one read goes through `db_read` like every other read.
//!
//! Four rules run through the whole module and are worth stating once:
//!
//! * **A card is addressed by its category, never by a fixed word.** Schema v8 replaced
//!   `deck_cards.zone` with `category_id` — a row in [`crate::deck_meta`]'s `deck_categories`
//!   that the user names, orders, deactivates and deletes. What used to be a five-word enum
//!   is now data, and the only thing the rules still read off it is its `kind`.
//! * **An inactive category counts toward nothing** — not [`DeckRow::card_count`], not the
//!   validation engine's size or copy limits, and [`allocate_deck`] claims no collection copy
//!   for it. That is the whole of what the `maybe` zone used to mean, generalised: the
//!   Maybeboard is simply the one category seeded `is_active = 0`, and a category of the
//!   user's own that they switch off behaves identically. Nothing in this file asks whether a
//!   category *is* the Maybeboard.
//! * **A card write denormalizes the printing *and the name*.** `deck_cards.card_id` is a
//!   soft reference — `cards` is dropped and rebuilt on every sync — so the row records
//!   what it was made from at the only moment that is knowable. The name is here for the
//!   wishlist's reason: a deck list that cannot say what an orphaned row *is* is not a list.
//! * **Zero is a removal.** `deck_cards.quantity` carries `CHECK (quantity > 0)`, unlike the
//!   collection's, because a category slot at zero holds nothing worth keeping — no condition,
//!   no purchase price, no acquisition story, just an intention the user withdrew.
//!
//! Every card command takes a `variant` ([`crate::schema::DECK_VARIANTS`]) as well, because
//! v8 widened the grain: `live` is what is sleeved up, `theory` is what the deck is being
//! built toward, and an edit tried out in one must never fold into the other's row.
//!
//! And every write here leaves a line in [`crate::deck_audit`], **inside its own transaction**
//! — so a change that rolls back takes its history with it. The two exceptions say why on
//! their own docs: [`delete_deck`] (the row would CASCADE away with the deck it describes) and
//! [`missing_to_wishlist`] (it changes the wishlist, not the deck).

use crate::collection::{valid_quantity, EntryChange, ZERO_ADD};
use crate::deck_meta::{DeckCategoryRow, DeckTagRow};
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::Arc;

/// The variant this module means when it says "the deck": what is actually sleeved up.
///
/// [`DeckRow::card_count`], [`allocate_deck`] and [`missing_to_wishlist`] all read it and
/// nothing else. A theory list is a plan — it is counted on no tile, it reserves no copy, and
/// it puts nothing on a shopping list, because a plan is not a deck the user has.
/// `DECK_VARIANTS[0]` by index rather than by spelling, so the two cannot drift.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];

/// What a deck is in when nobody says otherwise — `decks.format_key`'s own DDL default, so
/// an omitted `formatKey` means here exactly what it means in SQL.
pub const DEFAULT_FORMAT: &str = "casual";

/// What [`add_card`] says when it is handed neither a category id nor a name to find or make
/// one by. The two are alternatives, not a pair — an explicit id is a drop onto a named
/// column, a name is the add path's "file it where this card belongs" (TypeScript's
/// `autoCategoryFor` computes the word) — but a card has to land *somewhere*, and
/// `deck_cards.category_id` is `NOT NULL`.
pub const NO_CATEGORY: &str = "A card needs a category to go in.";

/// What an adjustment says when the deck it names is not there.
pub const GONE: &str = "That deck is not there any more.";

/// `decks.cover_kind` when the deck shows a card's art crop — the DDL's own default, and what
/// [`update_deck`] puts back the moment a `coverCardId` arrives.
const COVER_CARD_ART: &str = "card_art";

/// `decks.cover_kind` when the deck shows the file the user picked, at
/// `<data dir>/covers/<id>.webp`. The two words are CHECK-constrained on the column; they are
/// constants here so a typo is a compile error rather than a `CHECK constraint failed` on the
/// one write nobody tests by hand.
const COVER_CUSTOM: &str = "custom";

/// What [`swap_printing`] says when it is asked to change a printing to itself. The pane
/// hides the action on the row the deck already uses, so reaching this is a double-click or
/// a list that went stale — either way there is nothing to write.
pub const SAME_PRINTING: &str = "That is already this printing.";

/// What [`swap_printing`] says when the printing it was pointed at is not in `cards`.
///
/// Deliberately **not** [`printing_of`]'s sentence: the printing was clicked out of a live
/// printings list a moment ago, so "no card with that id" is not news to the user — the news
/// is that `cards` was dropped and rebuilt underneath the open pane, which is the one thing
/// that can make a printing they are looking at stop existing (see CLAUDE.md's swap rule).
const PRINTING_GONE: &str = "That printing is not in the card database any more — a sync \
     replaced it while the card was open. Reopen the card for the printings it has now.";

/// One new deck, as the "New deck" dialog sends it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckInput {
    pub name: String,
    pub format_key: String,
    pub description: Option<String>,
}

/// An edit to one deck. Every field is optional: absent means "leave it".
///
/// **Absent is the only way to say "leave it", so `null` cannot say "clear it".** Every column
/// below is written with `coalesce(?n, column)`, which reads a bound NULL as "unchanged" — so
/// there is no patch that files a deck back at the root of the folder tree, and none that
/// clears a cover or a description either. That is the shape this struct has had since v5 and
/// [`DeckPatch::folder_id`] joins it rather than inventing a second convention; un-filing a
/// deck wants a double-`Option` (absent versus null) across the whole struct, which is a
/// change to make once and deliberately, not as a side effect of adding a column.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckPatch {
    pub name: Option<String>,
    pub format_key: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    pub is_built: Option<bool>,
    pub archived: Option<bool>,
    /// Which folder the deck is filed in. `decks.folder_id` is `ON DELETE SET NULL`, so a
    /// folder the user deletes surfaces its decks at the root rather than taking them with it.
    ///
    /// **Un-filing is [`set_folder`]'s job, not this field's**, and no patch field could do it:
    /// by the rule above, a `null` here means "leave it". A reader looking for the way to put a
    /// deck back at the root of the tree wants that command.
    pub folder_id: Option<i64>,
    /// The deck's long-form notes — the v8 column, and **not** [`Self::description`], which is
    /// the one-line blurb the "New deck" dialog fills and the gallery tile shows. Two columns
    /// because they are two things: a caption and a notebook.
    pub notes: Option<String>,
    /// Whether this deck keeps a theory list beside its live one.
    ///
    /// **Switching it on seeds the theory list from live when there is nothing in it**, in this
    /// same transaction — an empty theory list beside a full live one reads as data loss, not
    /// as a blank page. Switching it off **keeps every row**: it hides a switch, it does not
    /// delete a list. Both halves live in [`crate::deck_theory`].
    pub theory_enabled: Option<bool>,
}

/// One deck as the gallery shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckRow {
    pub id: i64,
    pub name: String,
    pub format_key: String,
    /// From `format_specs`, so the gallery never re-derives a display name.
    pub format_name: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    /// `card_art` | `custom` — **which of the two cover fields a tile should draw**, and the
    /// only thing that decides it. `card_art` means [`Self::cover_card_id`]'s art crop;
    /// `custom` means `mtgimg://<origin>/cover/<id>`, the file the user picked.
    ///
    /// A deck can carry both at once and usually does: setting a custom cover leaves the card
    /// id alone and picking a card leaves the file on disk, so switching back and forth costs
    /// nothing and loses nothing. That is only coherent because this column is the one answer
    /// to "which one is showing".
    pub cover_kind: String,
    /// Scryfall image policy: an `art` crop lacks the printed frame, so wherever the
    /// gallery shows one it must credit the artist — read here so the tile can.
    pub cover_artist: Option<String>,
    pub is_built: bool,
    pub archived: bool,
    /// `live` copies in **active** categories of kind `main`, `commander` or `maybe` — what "a
    /// 60-card deck" means in a caption, and **the same cards the validation engine sizes a
    /// deck by** (`SIZE_KINDS` in `engine.ts`). One definition, because a tile that says 101
    /// beside a panel that says "exactly 100 incl cmdr; you have 100" is two answers to one
    /// question. The kind list here and that constant are the same three words, and a change to
    /// one is a change to both.
    ///
    /// **The switch decides whether a pile counts at all; the kind decides only whether it is
    /// played *beside* the deck or *in* it — and only `side` and `companion` are beside it.**
    /// So the sideboard is out (CR 100.4a) and the companion is out (EDH calls one "effectively
    /// a 101st card", which is exactly the card this must not add), and everything else that is
    /// switched on is in.
    ///
    /// That is why `maybe` is on the list, which reads odd until the alternative is written
    /// out: leaving it off made an *active* Maybeboard part of the format's card pool and part
    /// of the binder's reservations but not part of the deck's size — so a second Sol Ring in
    /// one was a singleton error reported under a size figure that still read 100. Kind `maybe`
    /// now exists for exactly one reason, to name the predefined Maybeboard and seed it
    /// inactive, and that is honest: being switched off is the whole of what the Maybeboard is.
    pub card_count: i64,
    pub updated_at: i64,
    /// Which folder the deck is filed in, or `None` for the root of the tree.
    pub folder_id: Option<i64>,
    /// The deck's long-form notes — the v8 column, not [`Self::description`].
    pub notes: Option<String>,
    /// Whether this deck keeps a theory list beside its live one.
    ///
    /// Read here as well as written through [`DeckPatch`] because a switch the app can set and
    /// never see is a switch nothing can draw: the editor's Live/Theory control is this
    /// boolean, and without it on the row every reader would have to guess from whether the
    /// theory list happens to be empty — which is exactly the state
    /// [`crate::deck_theory::seed_from_live`] exists to make impossible to interpret.
    pub theory_enabled: bool,
}

/// A name a gallery can show. A deck with no name is a nameless tile, and `decks.name` has
/// no CHECK to catch one — this is the whole of that constraint.
fn valid_name(name: &str) -> Result<&str, String> {
    let name = name.trim();
    (!name.is_empty())
        .then_some(name)
        .ok_or_else(|| "A deck needs a name.".to_owned())
}

/// A format key `format_specs` actually holds.
///
/// Validated **here rather than by a foreign key**, on purpose: `format_specs` is seeded
/// with `INSERT OR REPLACE` and every future migration that corrects a cell re-runs that
/// seed, which a REFERENCES clause on a live `decks` row would turn into a migration that
/// can fail in the field. Blank is the DDL's own `DEFAULT 'casual'` — an omitted format is
/// not a wrong one.
fn valid_format<'a>(conn: &Connection, key: &'a str) -> Result<&'a str, String> {
    let key = key.trim();
    if key.is_empty() {
        return Ok(DEFAULT_FORMAT);
    }
    conn.query_row(
        "SELECT 1 FROM format_specs WHERE key = ?1",
        params![key],
        |_| Ok(()),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .map(|()| key)
    .ok_or_else(|| {
        format!("`{key}` is not a format this app knows. Pick one from the format list.")
    })
}

/// `set_code`, `collector_number`, `lang`, `name` — what a zone write copies onto its row.
pub(crate) type Printing = (String, String, String, String);

/// The printing and the name, as the deck row will remember them.
///
/// The name is what `collection::printing_of` does not read and the wishlist does: a
/// collection row is a thing the user can hold, but a deck list is *read*, and a line that
/// can only say `e7f8…` once the id stops resolving is not a deck list.
///
/// `pub(crate)`, not private, for [`touch_deck`]'s reason: [`crate::deck_import::commit_import`]
/// denormalizes exactly these four columns onto exactly the same table, and a second copy of
/// this query would be a second place for an imported row and an added row to disagree about
/// what a deck card remembers.
pub(crate) fn printing_of(conn: &Connection, card_id: &str) -> Result<Printing, String> {
    printing_row(conn, card_id)?
        .ok_or_else(|| format!("no card with the id `{card_id}` is in the card database"))
}

/// The same read, with "not there" left to the caller — one SQL statement, two sentences.
/// [`add_card`] is told an id it was handed does not resolve; [`swap_printing`] knows more
/// than that (see [`PRINTING_GONE`]) and says it.
fn printing_row(conn: &Connection, card_id: &str) -> Result<Option<Printing>, String> {
    conn.query_row(
        "SELECT set_code, collector_number, lang, name FROM cards WHERE id = ?1",
        params![card_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Which oracle card a printing is of — `None` when the id is not in `cards`, **and equally
/// when the row it finds has no `oracle_id`**.
///
/// One answer for both, because they are the same answer to the only question asked here:
/// *can these two printings be compared?* `cards.oracle_id` is NULLABLE (no live row is null,
/// all 116 k of them, but the column is), and a null is as uncomparable as a missing row —
/// folding it into the SQL rather than into a `match` is what keeps a caller from reading
/// `Some(null)` as an oracle two printings could share.
fn oracle_of(conn: &Connection, card_id: &str) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT oracle_id FROM cards WHERE id = ?1 AND oracle_id IS NOT NULL",
        params![card_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// What [`swap_printing`] says when the two ids are printings of *different cards*.
///
/// Names both, because which two were paired is the whole question — and it names the one in
/// the deck as **the deck lists it** and the target as **`cards` has it now**, which is what
/// the reader is looking at on each side of the press.
fn not_the_same_card(from: &str, to: &str) -> String {
    format!(
        "`{to}` is not another printing of `{from}`. Swapping a printing changes which \
         printing of a card this deck plays, never which card it plays."
    )
}

/// Move the deck's `updated_at` — and, in the same statement, learn whether the deck is
/// there at all.
///
/// Every zone write opens with this, which buys two things for one UPDATE. The gallery
/// sorts by this column, so a write that left it alone would be an edit that does not
/// surface; and a stale deck id — a gallery that has not refreshed since another view
/// deleted the deck — is answered with [`GONE`] rather than with a foreign-key error, one
/// statement before there is an orphan row to worry about.
///
/// `pub(crate)`, not private: [`crate::deck_meta`]'s category, tag and folder writes open
/// with it too — a category rename is exactly as much an edit the gallery should surface as
/// a card add is, and duplicating the UPDATE there would be a second place to keep this in
/// step with [`GONE`].
pub(crate) fn touch_deck(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let changed = conn
        .execute(
            "UPDATE decks SET updated_at = unixepoch() WHERE id = ?1",
            params![deck_id],
        )
        .map_err(|e| e.to_string())?;
    (changed > 0).then_some(()).ok_or_else(|| GONE.to_owned())
}

/// What a card write says when the row it was asked to adjust is not in that category.
///
/// Takes the category's **name**, not its id: a number a user never chose says nothing, and
/// every caller has the name already — [`category_of_deck`] hands it back as the by-product
/// of the fence they all run first.
fn card_gone(category: &str) -> String {
    format!("That card is not in this deck's {category} category any more.")
}

/// Check that a category id names a category **of this deck**, and answer its name.
///
/// The fence every card command opens with, and it is not decoration: nothing in the DDL
/// stops `deck_cards.category_id` pointing at a category of a *different* deck — the FK only
/// requires the row to exist — so this is where "a card of deck A cannot be filed under a
/// category of deck B" actually lives. [`crate::deck_meta::delete_category`]'s move target and
/// `set_card_tag`'s tag id draw the same two-sentence distinction, and for the same reason:
/// "gone" and "not yours" are different things to tell a stale editor.
///
/// Returning the name rather than `()` is what lets [`card_gone`] name the category the reader
/// is looking at without a second query.
fn category_of_deck(conn: &Connection, deck_id: i64, category_id: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT deck_id, name FROM deck_categories WHERE id = ?1",
        params![category_id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| crate::deck_meta::CATEGORY_GONE.to_owned())
    .and_then(|(owner, name)| {
        (owner == deck_id)
            .then_some(name)
            .ok_or_else(|| crate::deck_meta::CATEGORY_WRONG_DECK.to_owned())
    })
}

/// Every column of a [`DeckRow`], from the one query shape the list and the single read
/// share. Both LEFT JOINs are load-bearing: a vanished cover printing or a format key the
/// specs no longer carry must never hide a deck from its owner.
///
/// The subquery is [`DeckRow::card_count`]'s definition, and it is the engine's `SIZE_KINDS`
/// (`main`, `commander`, `maybe`) verbatim — see that field's doc for why `maybe` is on the
/// list. Its `JOIN deck_categories` is an *inner* join, unlike the two above it, because
/// `deck_cards.category_id` is `NOT NULL` with an enforced foreign key: a card with no category
/// is a row the schema cannot hold.
///
/// `'live'` is spelled out rather than interpolated from [`LIVE`] because this is a `const` and
/// there is nothing to interpolate with;
/// `the_gallery_count_reads_only_live_rows_in_active_categories` is what keeps the literal
/// honest, and `an_active_maybeboard_is_part_of_the_deck_and_an_inactive_one_is_not` is what
/// keeps the kind list in step with `SIZE_KINDS`.
const DECK_SELECT: &str = "SELECT d.id, d.name, d.format_key, fs.display_name, d.description,
            d.cover_card_id, d.cover_kind, c.artist, d.is_built, d.archived,
            coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                        JOIN deck_categories cat ON cat.id = dc.category_id
                       WHERE dc.deck_id = d.id
                         AND dc.variant = 'live'
                         AND cat.is_active = 1
                         AND cat.kind IN ('main','commander','maybe')), 0),
            d.updated_at, d.folder_id, d.notes, d.theory_enabled
       FROM decks d
       LEFT JOIN format_specs fs ON fs.key = d.format_key
       LEFT JOIN cards c ON c.id = d.cover_card_id";

fn deck_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckRow> {
    Ok(DeckRow {
        id: r.get(0)?,
        name: r.get(1)?,
        format_key: r.get(2)?,
        format_name: r.get(3)?,
        description: r.get(4)?,
        cover_card_id: r.get(5)?,
        cover_kind: r.get(6)?,
        cover_artist: r.get(7)?,
        is_built: r.get(8)?,
        archived: r.get(9)?,
        card_count: r.get(10)?,
        updated_at: r.get(11)?,
        folder_id: r.get(12)?,
        notes: r.get(13)?,
        theory_enabled: r.get(14)?,
    })
}

/// One deck, or nothing. Every write that returns a `DeckRow` ends here, so the row the
/// caller gets back is the row the gallery would have read.
pub(crate) fn read_deck(conn: &Connection, id: i64) -> Result<Option<DeckRow>, String> {
    conn.query_row(
        &format!("{DECK_SELECT} WHERE d.id = ?1"),
        params![id],
        deck_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Make a deck, and give it its four predefined categories in the same transaction — a deck
/// that exists but cannot be filed into anything is a state nothing downstream expects, and
/// the v8 migration only ever seeded these for decks that existed *at* the migration; a deck
/// made afterwards needs the same four rows made for it here. `deck_meta::
/// ensure_predefined_categories` says on its own doc why it takes no transaction of its
/// own — this is the call that supplies one.
pub fn create_deck(conn: &Connection, input: &DeckInput) -> Result<DeckRow, String> {
    let name = valid_name(&input.name)?;
    let format_key = valid_format(conn, &input.format_key)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let id: i64 = tx
        .query_row(
            "INSERT INTO decks (name, format_key, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![name, format_key, input.description],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    crate::deck_meta::ensure_predefined_categories(&tx, id)?;
    // The first line of the deck's history, and the one place a `deck` row carries a `from` of
    // null: there was no previous name, because there was no deck. Recorded here rather than
    // left out so that a drawer scrolled to the bottom ends at the deck's own beginning
    // instead of at whatever edit happens to be oldest.
    crate::deck_audit::record(
        &tx,
        id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &json!({ "field": "name", "from": null, "to": name }),
        0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, id)?.ok_or_else(|| GONE.to_owned())
}

/// One `decks` row as it was before an edit — every column [`DeckPatch`] can reach, read
/// inside the transaction so the `from` side of a history row is the value the UPDATE is
/// actually about to replace.
struct DeckBefore {
    name: String,
    format_key: String,
    description: Option<String>,
    cover_card_id: Option<String>,
    cover_kind: String,
    is_built: bool,
    archived: bool,
    folder_id: Option<i64>,
    notes: Option<String>,
    theory_enabled: bool,
}

/// What a `deck`/`cover` history row records as the cover: the card's id when the deck is
/// showing card art, and the word [`COVER_CUSTOM`] when it is showing the user's own file.
///
/// One value for two columns, because "what is the cover" has one answer at a time — which is
/// [`DeckRow::cover_kind`]'s whole job — and a history that recorded the card id of a deck
/// showing a custom picture would be recording the cover it *would* fall back to. The custom
/// file's path is deliberately **not** what is written: it is a path on this machine, it says
/// nothing a reader wants, and it is not what the change was about.
fn cover_value(kind: &str, cover_card_id: Option<&str>) -> serde_json::Value {
    if kind == COVER_CUSTOM {
        json!(COVER_CUSTOM)
    } else {
        json!(cover_card_id)
    }
}

/// Apply an edit. Absent fields are left alone (`coalesce(?n, column)`), which is what
/// makes this usable from a form that only sends what it changed — `collection::update_entry`
/// verbatim. Rename, re-format, cover, build, archive and filing all arrive here.
///
/// **One history row per field that actually changed**, which is a narrower rule than "one per
/// call" and a wider one than "one per press". A patch that asks for the value a field already
/// has changed nothing and records nothing — otherwise every Save on an untouched form would
/// fill the drawer with edits nobody made. A patch that changes two fields is two facts, and
/// the `deck` payload names one field: the alternative would be choosing which half of the
/// user's edit is remembered. The editor sends one field at a time, which is why
/// `every_deck_write_leaves_exactly_one_audit_row` counts one here.
pub fn update_deck(conn: &Connection, id: i64, patch: &DeckPatch) -> Result<DeckRow, String> {
    let name = match patch.name.as_deref() {
        Some(n) => Some(valid_name(n)?.to_owned()),
        None => None,
    };
    let format_key = match patch.format_key.as_deref() {
        Some(k) => Some(valid_format(conn, k)?.to_owned()),
        None => None,
    };
    // One transaction, for [`allocate_deck`]'s sake: sleeving a deck up rewrites its claims
    // as a DELETE and N INSERTs, and in autocommit a reader between them would see a built
    // deck holding nothing while a failure part-way would strand a half-rebuilt claim set
    // under an `is_built` that had already flipped. The flag and the claims it means are one
    // fact and are written as one. Every other allocation site already had a transaction to
    // join; this is the only one that had to open its own.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Read before write, so the history's `from` side is what this UPDATE is about to replace.
    // Inside the transaction, because a value read outside one could have moved by the time
    // the UPDATE ran and the row would then record a change that never happened.
    let before: DeckBefore = tx
        .query_row(
            "SELECT name, format_key, description, cover_card_id, cover_kind, is_built,
                    archived, folder_id, notes, theory_enabled
               FROM decks WHERE id = ?1",
            params![id],
            |r| {
                Ok(DeckBefore {
                    name: r.get(0)?,
                    format_key: r.get(1)?,
                    description: r.get(2)?,
                    cover_card_id: r.get(3)?,
                    cover_kind: r.get(4)?,
                    is_built: r.get(5)?,
                    archived: r.get(6)?,
                    folder_id: r.get(7)?,
                    notes: r.get(8)?,
                    theory_enabled: r.get(9)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| GONE.to_owned())?;
    let changed = tx
        .execute(
            "UPDATE decks SET
                name = coalesce(?2, name),
                format_key = coalesce(?3, format_key),
                description = coalesce(?4, description),
                cover_card_id = coalesce(?5, cover_card_id),
                -- Picking a card is what puts the deck back on card art, and it is the only
                -- way back: `deck_set_cover_image` writes 'custom' and nothing else clears it.
                -- The custom **file is left alone** on purpose, so switching between the two
                -- costs nothing and loses nothing — a user who tries a card and changes their
                -- mind still has the picture they chose. `?11` is bound rather than spelled,
                -- so the word this writes and the word `cover_value` reads are one constant.
                cover_kind = CASE WHEN ?5 IS NULL THEN cover_kind ELSE ?11 END,
                is_built = coalesce(?6, is_built),
                archived = coalesce(?7, archived),
                folder_id = coalesce(?8, folder_id),
                notes = coalesce(?9, notes),
                theory_enabled = coalesce(?10, theory_enabled),
                updated_at = unixepoch()
              WHERE id = ?1",
            params![
                id,
                name,
                format_key,
                patch.description,
                patch.cover_card_id,
                patch.is_built,
                patch.archived,
                patch.folder_id,
                patch.notes,
                patch.theory_enabled,
                COVER_CARD_ART,
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(GONE.to_owned());
    }
    // **Switching the theory list on fills it, in this transaction.** The flag and the list it
    // reveals are one fact: a flag that committed while the copy rolled back is the empty
    // theory list beside a full live one that this exists to prevent. Only on the *transition*,
    // and only when there is nothing there — a plan the user has started is not something a
    // re-press of the switch may pour the live deck over
    // (`enabling_theory_again_leaves_a_started_plan_alone`).
    if patch.theory_enabled == Some(true)
        && !before.theory_enabled
        && crate::deck_theory::theory_is_empty(&tx, id)?
    {
        crate::deck_theory::seed_from_live(&tx, id)?;
    }
    record_deck_edit(&tx, id, patch, &name, &format_key, &before)?;
    // Sleeving a deck up (or taking it apart) is the one edit here that changes what is
    // available, so it is the one that reallocates. **This deck only:** every other deck's
    // claims are recomputed the next time it is touched, because walking the whole gallery
    // on a toggle would make one checkbox a write over every deck the user owns.
    if patch.is_built.is_some() {
        allocate_deck(&tx, id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, id)?.ok_or_else(|| GONE.to_owned())
}

/// Write [`update_deck`]'s history: one row per field whose value actually moved.
///
/// `name` and `format_key` arrive already validated and canonicalised (a blank format key is
/// [`DEFAULT_FORMAT`] by then), so what is compared here is what was written and not what was
/// typed — a patch that sends `"  Burn  "` for a deck already called `Burn` records nothing,
/// which is the honest answer.
///
/// **Filing a deck is a `folder` row, not a `deck` one**, and that is the one asymmetry worth
/// naming: `deck_folders` is the only thing a deck can point at that has a *name of its own*,
/// and a bare folder id in a `deck` row's `to` would be a number no reader could resolve once
/// the folder was renamed. The path is resolved here, at the moment it is true.
fn record_deck_edit(
    tx: &Connection,
    id: i64,
    patch: &DeckPatch,
    name: &Option<String>,
    format_key: &Option<String>,
    before: &DeckBefore,
) -> Result<(), String> {
    let field = |field: &str, from: serde_json::Value, to: serde_json::Value| {
        crate::deck_audit::record(
            tx,
            id,
            crate::deck_audit::DECK_LEVEL,
            crate::deck_audit::DECK,
            None,
            &json!({ "field": field, "from": from, "to": to }),
            0,
        )
    };
    if let Some(to) = name.as_deref().filter(|n| *n != before.name) {
        field("name", json!(before.name), json!(to))?;
    }
    if let Some(to) = format_key.as_deref().filter(|k| *k != before.format_key) {
        field("format", json!(before.format_key), json!(to))?;
    }
    if let Some(to) = patch
        .description
        .as_deref()
        .filter(|d| Some(*d) != before.description.as_deref())
    {
        field("description", json!(before.description), json!(to))?;
    }
    // A cover change is "which picture is showing", so a card id that is already stored still
    // changes the cover when the deck was showing a custom file — and the `from` side says
    // `custom` rather than the card underneath it. See [`cover_value`].
    let cover_was = cover_value(&before.cover_kind, before.cover_card_id.as_deref());
    if let Some(to) = patch
        .cover_card_id
        .as_deref()
        .filter(|c| json!(*c) != cover_was)
    {
        field("cover", cover_was, json!(to))?;
    }
    if let Some(to) = patch.is_built.filter(|b| *b != before.is_built) {
        field("built", json!(before.is_built), json!(to))?;
    }
    if let Some(to) = patch.archived.filter(|a| *a != before.archived) {
        field("archived", json!(before.archived), json!(to))?;
    }
    if let Some(to) = patch
        .notes
        .as_deref()
        .filter(|n| Some(*n) != before.notes.as_deref())
    {
        field("notes", json!(before.notes), json!(to))?;
    }
    // One row, whether or not the theory list was seeded above: the seeding is part of
    // switching the list on, not a second edit, and N `add` rows for one press would read as a
    // deck somebody typed out.
    if let Some(to) = patch.theory_enabled.filter(|t| *t != before.theory_enabled) {
        field("theory", json!(before.theory_enabled), json!(to))?;
    }
    if let Some(to) = patch.folder_id.filter(|f| Some(*f) != before.folder_id) {
        record_filed(tx, id, Some(to))?;
    }
    Ok(())
}

/// File a deck under a folder, or — with `None` — back at the **root of the tree**.
///
/// A command of its own rather than a [`DeckPatch`] field, and the reason is the convention
/// every column in that struct is written under: `coalesce(?n, column)` reads a bound NULL as
/// "leave it", so within a patch `null` cannot mean "clear it". A double-`Option` (absent versus
/// null) would express it, but only across the *whole* struct, and inventing a second convention
/// inside one that already has one is how a reader comes to distrust both. Here `None` genuinely
/// means root, because there is nothing else it could mean.
///
/// `DeckPatch::folder_id` stays exactly as it is for the set-a-folder case; this is the one that
/// can also take it back out.
///
/// Records one `folder` row **when the deck actually moves**, [`update_deck`]'s rule: a dialog
/// that saves an untouched form must not fill the drawer with moves nobody made. The
/// `updated_at` touch is unconditional, also [`update_deck`]'s.
pub fn set_folder(
    conn: &Connection,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<DeckRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Validated in words rather than left to the foreign key. `decks.folder_id` does declare
    // `REFERENCES deck_folders(id)`, but `PRAGMA foreign_keys` is a per-connection setting and a
    // constraint failure names the table and not the mistake — the same reason
    // `valid_format` checks `format_specs` by hand.
    if let Some(folder) = folder_id {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM deck_folders WHERE id = ?1)",
                params![folder],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(crate::deck_meta::FOLDER_GONE.to_owned());
        }
    }
    let before: Option<i64> = tx
        .query_row(
            "SELECT folder_id FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| GONE.to_owned())?;
    touch_deck(&tx, deck_id)?;
    tx.execute(
        "UPDATE decks SET folder_id = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![deck_id, folder_id],
    )
    .map_err(|e| e.to_string())?;
    if folder_id != before {
        record_filed(&tx, deck_id, folder_id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, deck_id)?.ok_or_else(|| GONE.to_owned())
}

/// The one `folder` history row, written by every writer that can file a deck: the two here,
/// and [`crate::deck_meta::delete_folder`], which un-files every deck in the folder it
/// destroys.
///
/// `None` is the root of the tree and records `"folder": null` — the absence of a path, not the
/// empty string, because a reader has to be able to tell "filed nowhere" from "filed under a
/// folder whose name is blank" and only one of those is a state the app can produce.
pub(crate) fn record_filed(
    tx: &Connection,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<(), String> {
    let folder = match folder_id {
        Some(id) => json!(folder_path(tx, id)?),
        None => json!(null),
    };
    crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::FOLDER,
        None,
        &json!({ "action": "move", "folder": folder }),
        0,
    )
}

/// A folder's full path, root first, joined with ` › ` — `"Commander › Legends"`.
///
/// Resolved at write time and stored in the history row, which is deliberate and is the
/// opposite of what every other reference in this schema does: a `folder_id` would be the
/// normalised thing to keep, and it would be **wrong here**, because a history says what was
/// true then. A folder renamed or deleted afterwards must not rewrite the line that recorded
/// the move.
///
/// Walks `parent_id` upward with a hop budget rather than an unbounded loop: `move_folder`
/// refuses a cycle, so the tree cannot hold one — but this walk runs over data, and a walk
/// over data that trusts an invariant is a walk that hangs the day the invariant is wrong. A
/// path that exceeds the budget is answered as far as it was read.
fn folder_path(conn: &Connection, folder_id: i64) -> Result<String, String> {
    /// Deep enough that no filing anyone does by hand reaches it.
    const MAX_DEPTH: usize = 64;

    let mut names: Vec<String> = Vec::new();
    let mut cursor = Some(folder_id);
    while let Some(id) = cursor {
        if names.len() >= MAX_DEPTH {
            break;
        }
        let row: Option<(String, Option<i64>)> = conn
            .query_row(
                "SELECT name, parent_id FROM deck_folders WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some((name, parent)) = row else { break };
        names.push(name);
        cursor = parent;
    }
    names.reverse();
    Ok(names.join(" › "))
}

/// Delete the deck outright.
///
/// **This one really deletes**, unlike anything in [`crate::reconcile`]: a deck is the
/// user's to destroy, and `deck_cards` and `deck_allocations` both cascade from it by a
/// choice made per delete-site in the v5 DDL. Archiving is the soft path
/// ([`DeckPatch::archived`]), and it is what a gallery's "remove" should reach for.
///
/// Like [`crate::collection::remove_entry`], an id that resolves to nothing is a success:
/// the caller wanted that deck gone, and it is gone.
///
/// **Records nothing**, and cannot: `deck_audit.deck_id` is `NOT NULL` and CASCADEs from
/// `decks`, so a row written to say "this deck was deleted" would be removed by the very
/// statement that made it true. It is the one deck write with no history, because it is the
/// one deck write with nothing left to file a history under —
/// `deleting_a_deck_takes_its_history_with_it` pins that this is a property of the schema and
/// not an omission.
///
/// **The custom cover file goes too, best-effort.** `covers` is the directory or `None` when it
/// could not even be resolved, and a failure to delete is logged and never returned: the deck
/// is gone, and refusing a delete that already happened because a picture of it survived would
/// be an error the user can do nothing with. What is left behind in that case is one orphaned
/// `<id>.webp` in a folder that is safe to delete — the cost of the softer failure.
pub fn delete_deck(conn: &Connection, id: i64, covers: Option<&Path>) -> Result<(), String> {
    conn.execute("DELETE FROM decks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    if let Some(covers) = covers {
        if let Err(e) = crate::images::remove_cover(covers, id) {
            eprintln!("could not delete the cover image for deck {id}: {e}");
        }
    }
    Ok(())
}

/// Point a deck at a picture the user picked: write the already-encoded bytes beside the
/// database and record that the deck is showing them.
///
/// **This function is handed `bytes` and never encodes**, and that signature is the whole of
/// the ordering rule: [`crate::images::encode_cover`] runs in [`deck_set_cover_image`] *before*
/// `with_write`, so the decode, the Lanczos resample and the lossless WEBP encode are outside
/// the app-wide write mutex. A source is bounded at
/// [`crate::images::MAX_COVER_SOURCE_PIXELS`]-worth of pixels rather than by taste, so holding
/// the mutex across it would put every collection edit in the app behind a hundred-megapixel
/// decode. Taking a path here instead — which is what this did — made that ordering a sentence
/// in a doc that the call site could contradict, and it did.
///
/// **The file is written inside the transaction**, which is the other half of that order: the
/// deck's existence is checked by [`touch_deck`] first, so a cover is never written for a deck
/// that is not there, and a failed write rolls the row back rather than leaving a deck pointing
/// at a picture that was never stored. The one seam left is a commit that fails after the file
/// landed — which leaves an orphaned `<id>.webp` that the next set-cover overwrites and
/// [`delete_deck`] removes. Bytes on disk with no row pointing at them are inert; a row
/// pointing at bytes that are not there is a broken tile.
///
/// `cover_image_path` is stored **absolute**, as the path actually written. It is not what the
/// route reads — `mtgimg://…/cover/<deckId>` resolves the covers directory itself, which is what
/// keeps a portable app working after its folder is moved — it is the record of what was
/// written, for a reader and for anything that ever has to clean up.
pub fn set_cover_image(
    conn: &Connection,
    covers: &Path,
    deck_id: i64,
    bytes: &[u8],
) -> Result<DeckRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let before: (Option<String>, String) = tx
        .query_row(
            "SELECT cover_card_id, cover_kind FROM decks WHERE id = ?1",
            params![deck_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| GONE.to_owned())?;
    touch_deck(&tx, deck_id)?;
    crate::images::write_cover(covers, deck_id, bytes)?;
    let stored = crate::images::cover_file(covers, deck_id);
    tx.execute(
        "UPDATE decks SET cover_kind = ?2, cover_image_path = ?3, updated_at = unixepoch()
          WHERE id = ?1",
        params![deck_id, COVER_CUSTOM, stored.to_string_lossy()],
    )
    .map_err(|e| e.to_string())?;
    // The same `deck`/`cover` row [`update_deck`] writes, from the other direction — one field,
    // one history line, whichever kind of cover the deck was showing before. **Recorded even
    // when both sides read `custom`**, which is the case a `from != to` guard would swallow:
    // replacing one picture with another is exactly the change this command exists to make,
    // and the payload deliberately does not name the file (see [`cover_value`]), so the two
    // sides matching is what "a different picture" looks like from here.
    crate::deck_audit::record(
        &tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &json!({
            "field": "cover",
            "from": cover_value(&before.1, before.0.as_deref()),
            "to": COVER_CUSTOM,
        }),
        0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, deck_id)?.ok_or_else(|| GONE.to_owned())
}

/// One `deck_cards` row on its way from a deck to its copy — every column that describes the
/// card, with the two that describe *which deck's* category and tag it is (`category_id`,
/// `tag_id`) still holding the source's ids, for [`duplicate_deck`] to remap.
struct CopiedCard {
    category_id: i64,
    tag_id: Option<i64>,
    variant: String,
    card_id: String,
    set_code: String,
    collector_number: String,
    lang: String,
    name: String,
    quantity: i64,
    needs_review: Option<String>,
}

/// Copy the deck, its categories, its tags and its cards — never its claims, never
/// `is_built`, never `archived`.
///
/// A copy is a **draft**: it has reserved no copies of anything (claims belong to the deck
/// that made them, and the copy earns its own at its first card write), it is not sleeved up
/// on a table, and it is not something the user filed away. Everything that describes the
/// deck rather than its state — format, description, cover, notes, which folder it is filed
/// in, whether it keeps a theory list — comes across, so the copy looks like what was copied.
///
/// **Both variants are copied.** A theory list is the deck's plan for itself, and a copy made
/// to try something out is exactly the copy that wants the plan too. `theory_enabled` travels
/// with them for the same reason: copying the rows and leaving the flag off would give the
/// copy a list it cannot open.
///
/// **A custom cover is copied as a file, not as a path**, and that is the trap this argument
/// exists for: `cover_kind` and `cover_image_path` come across in the `INSERT … SELECT` above
/// like every other column, which on its own leaves the copy claiming `custom` with no
/// `<newId>.webp` behind it and a path pointing at the *original's* file — `mtgimg://…/cover/…`
/// then 404s and the tile is blank. So the bytes are copied too, and if they cannot be (no
/// covers directory, no source file, an unwritable disk) the copy falls back to `card_art`
/// rather than keeping a claim it cannot honour. Best-effort like [`delete_deck`]'s removal: a
/// failure is logged, never fatal, and a duplicate is never refused over a picture.
///
/// **Categories and tags are new rows with new ids**, and the cards are remapped onto them.
/// This is the part a "copy the cards" implementation gets wrong invisibly: `deck_cards`
/// stores a `category_id`, so copying a card row verbatim would file the copy's card under
/// the *original's* category — and then deleting the original would take the copy's cards
/// with it through `ON DELETE CASCADE`. Two id maps, built as the rows are written, are what
/// keep the copy a copy. `tag_id` maps the same way and falls back to NULL, which cannot
/// happen (a card's tag is a tag of its own deck) but is the honest answer if it ever does.
///
/// The copy is **not** handed [`crate::deck_meta::ensure_predefined_categories`]: it inherits
/// the source's four, because every deck has them — the v8 migration backfilled every deck
/// that predates it and [`create_deck`] seeds every one made since. Topping up afterwards
/// would be a second write with a failure mode of its own (a user category named "Sideboard"
/// collides with the seeded one on `DECK_CATEGORY_GRAIN`) in exchange for an invariant that
/// already holds.
pub fn duplicate_deck(
    conn: &Connection,
    id: i64,
    covers: Option<&Path>,
) -> Result<DeckRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let copy: Option<(i64, String, String)> = tx
        .query_row(
            "INSERT INTO decks (name, format_key, description, cover_kind, cover_card_id,
                                cover_image_path, folder_id, notes, theory_enabled,
                                is_built, archived, created_at, updated_at)
             SELECT name || ' (copy)', format_key, description, cover_kind, cover_card_id,
                    cover_image_path, folder_id, notes, theory_enabled,
                    0, 0, unixepoch(), unixepoch()
               FROM decks WHERE id = ?1
             RETURNING id, name, cover_kind",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((copy, copy_name, copy_cover_kind)) = copy else {
        return Err(GONE.to_owned());
    };
    if copy_cover_kind == COVER_CUSTOM {
        copy_cover_file(&tx, covers, id, copy)?;
    }

    // Read then write, one row at a time with `RETURNING id`, rather than one
    // `INSERT … SELECT`: the map from old id to new is the whole point, and a set insert
    // answers no ordered list of ids to build one from.
    let categories: Vec<(i64, String, String, bool, i64)> = tx
        .prepare(
            "SELECT id, name, kind, is_active, sort_order FROM deck_categories
              WHERE deck_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut category_map: HashMap<i64, i64> = HashMap::new();
    for (old, name, kind, is_active, sort_order) in categories {
        let new: i64 = tx
            .query_row(
                "INSERT INTO deck_categories
                    (deck_id, name, kind, is_active, sort_order, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, unixepoch(), unixepoch())
                 RETURNING id",
                params![copy, name, kind, is_active, sort_order],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        category_map.insert(old, new);
    }

    let tags: Vec<(i64, String, String)> = tx
        .prepare("SELECT id, name, color FROM deck_tags WHERE deck_id = ?1 ORDER BY id")
        .map_err(|e| e.to_string())?
        .query_map(params![id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let mut tag_map: HashMap<i64, i64> = HashMap::new();
    for (old, name, color) in tags {
        let new: i64 = tx
            .query_row(
                "INSERT INTO deck_tags (deck_id, name, color, created_at, updated_at)
                 VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
                 RETURNING id",
                params![copy, name, color],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        tag_map.insert(old, new);
    }

    // `needs_review` travels with the row: the sentence says this printing left the card
    // database, which is just as true of the copy.
    let cards: Vec<CopiedCard> = tx
        .prepare(
            "SELECT category_id, tag_id, variant, card_id, set_code, collector_number, lang,
                    name, quantity, needs_review
               FROM deck_cards WHERE deck_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![id], |r| {
            Ok(CopiedCard {
                category_id: r.get(0)?,
                tag_id: r.get(1)?,
                variant: r.get(2)?,
                card_id: r.get(3)?,
                set_code: r.get(4)?,
                collector_number: r.get(5)?,
                lang: r.get(6)?,
                name: r.get(7)?,
                quantity: r.get(8)?,
                needs_review: r.get(9)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    for card in cards {
        tx.execute(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, tag_id, quantity, needs_review, created_at, updated_at)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11, unixepoch(), unixepoch())",
            params![
                copy,
                category_map.get(&card.category_id),
                card.variant,
                card.card_id,
                card.set_code,
                card.collector_number,
                card.lang,
                card.name,
                card.tag_id.and_then(|t| tag_map.get(&t).copied()),
                card.quantity,
                card.needs_review,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    // **The copy's history, not the original's, and one line rather than one per card.** The
    // copy is a new deck and its history begins the way [`create_deck`]'s does; the cards it
    // arrived with are not edits anyone made to it, and N `add` rows for one press would read
    // as a deck someone typed out. The original is untouched and records nothing at all — it
    // was not changed.
    crate::deck_audit::record(
        &tx,
        copy,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &json!({ "field": "name", "from": null, "to": copy_name }),
        0,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, copy)?.ok_or_else(|| GONE.to_owned())
}

/// Give a freshly duplicated deck its own copy of the original's cover image, or take the claim
/// away.
///
/// The columns are already `custom` when this runs — [`duplicate_deck`]'s `INSERT … SELECT`
/// copied them — so the only two honest outcomes are "the copy has its own file, pointing at
/// itself" and "the copy shows card art". What must not survive is the state in between: a deck
/// claiming `custom` whose `cover_image_path` names *another deck's* file, which outlives that
/// deck's deletion as a path to nothing.
///
/// Best-effort in the sense [`delete_deck`] is: every failure lands in the second branch and is
/// logged, and the duplicate itself is never refused. Inside the caller's transaction, so the
/// columns and the file agree or neither happened.
fn copy_cover_file(
    tx: &Connection,
    covers: Option<&Path>,
    from: i64,
    to: i64,
) -> Result<(), String> {
    let copied = covers.is_some_and(|dir| match crate::images::copy_cover(dir, from, to) {
        Ok(()) => true,
        Err(e) => {
            eprintln!("could not copy the cover image from deck {from} to deck {to}: {e}");
            false
        }
    });
    if copied {
        tx.execute(
            "UPDATE decks SET cover_image_path = ?2 WHERE id = ?1",
            params![
                to,
                crate::images::cover_file(
                    covers.expect("a copy cannot have happened without a directory"),
                    to
                )
                .to_string_lossy()
            ],
        )
    } else {
        tx.execute(
            "UPDATE decks SET cover_kind = ?2, cover_image_path = NULL WHERE id = ?1",
            params![to, COVER_CARD_ART],
        )
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The gallery, archived decks last and most recently touched first.
pub fn list_decks(conn: &Connection) -> Result<Vec<DeckRow>, String> {
    let sql = format!("{DECK_SELECT} ORDER BY d.archived ASC, d.updated_at DESC, d.id DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], deck_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Add copies to a category, folding on the grain — the drag-in and the click-to-add write.
///
/// **Either `category_id` or `category_name`**, and at least one ([`NO_CATEGORY`]). An
/// explicit id is a drop onto a column the user pointed at; a name is the add path's "file it
/// where this card belongs", found-or-created through
/// [`crate::deck_meta::category_for_name`] — the word itself is computed in TypeScript
/// (`autoCategoryFor`), because which pile a Sol Ring belongs in is domain logic and this
/// module is plumbing. When both arrive the id wins: it is the more specific instruction, and
/// it is the one a drag carries.
pub fn add_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: Option<i64>,
    category_name: Option<&str>,
    variant: &str,
    quantity: i64,
) -> Result<EntryChange, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    // Not `valid_quantity`: *adding* zero copies is a no-op dressed as a write, and would
    // conjure a row out of nothing. The same refusal `collection::add_entry` gives, from the
    // one constant that owns the sentence.
    if quantity <= 0 {
        return Err(ZERO_ADD.to_owned());
    }
    if category_id.is_none() && category_name.is_none() {
        return Err(NO_CATEGORY.to_owned());
    }
    let (set_code, collector_number, lang, name) = printing_of(conn, card_id)?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // Inside the transaction because the name arm *writes*: a category nobody has made yet is
    // made here, and it must not survive a card insert that fails after it.
    //
    // Both arms answer the category's **name** as well as its id, because the history row
    // below names the pile the card went into and a number nobody chose says nothing. The id
    // arm gets it free from the fence it runs anyway; the name arm trims the caller's string
    // the way `category_for_name` did before storing it, so the two arms record the same word
    // for the same category.
    let (category_id, category) = match category_id {
        Some(id) => (id, category_of_deck(&tx, deck_id, id)?),
        // Unreachable past the guard above, and written as a second refusal rather than an
        // `expect` so that an edit which ever drops that guard answers the sentence instead
        // of panicking in a user's face.
        None => {
            let Some(name) = category_name else {
                return Err(NO_CATEGORY.to_owned());
            };
            (
                crate::deck_meta::category_for_name(&tx, deck_id, name)?,
                name.trim().to_owned(),
            )
        }
    };
    // The conflict target is `DECK_CARD_GRAIN` verbatim — the same text the unique index
    // was created from. Anything else is a runtime "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint" at the first quick-add, which is why it is a
    // constant. The quantities add; `tag_id` and `needs_review` are left alone, because the
    // row that is already there is the one the user labelled.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()
         RETURNING id, quantity",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let (id, landed): (i64, i64) = tx
        .query_row(
            &sql,
            params![
                deck_id,
                category_id,
                variant,
                card_id,
                set_code,
                collector_number,
                lang,
                name,
                quantity
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    // The copies **added**, never the total the row landed on: the history is a list of
    // changes, and `delta` is what the day header adds up. A fold that took a row from 2 to 3
    // is one copy of history, not three.
    crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::ADD,
        Some((card_id, &name)),
        &json!({ "category": category, "quantity": quantity }),
        quantity,
    )?;
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity: landed,
        removed: false,
    })
}

/// Set an absolute quantity — the stepper write. **Zero removes the row.**
///
/// The wishlist's asymmetry, for the wishlist's reason: `deck_cards.quantity` carries
/// `CHECK (quantity > 0)`, and a category slot at zero holds nothing worth keeping. The
/// collection keeps its zeros because it has a condition, a price and an acquisition story
/// to keep; a deck slot has an intention and nothing else, and an intention the user
/// stepped down to none of is a withdrawn intention.
///
/// A negative number is refused through the one [`valid_quantity`], and the refusal matters
/// more here rather than less: in a module where zero legitimately deletes, treating `-1` as
/// close enough to zero would let arithmetic that went wrong upstream destroy a row.
pub fn set_card_quantity(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    category_id: i64,
    variant: &str,
    quantity: i64,
) -> Result<EntryChange, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    valid_quantity(quantity, "deck quantity")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    let category = category_of_deck(&tx, deck_id, category_id)?;

    // The row as it is now, read before either branch writes. The history needs all three
    // columns — the count it is moving *from*, and the name the line will be read by once the
    // row is gone — and reading them once here is also what lets the `quantity` branch report
    // both numbers, which `RETURNING` cannot: SQLite's `RETURNING` on an UPDATE answers the
    // **new** row, so the old value is unrecoverable a statement later.
    let current: Option<(i64, i64, String)> = tx
        .query_row(
            "SELECT id, quantity, name FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
            params![deck_id, card_id, category_id, variant],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    if quantity == 0 {
        if let Some((_, was, name)) = &current {
            tx.execute(
                "DELETE FROM deck_cards
                  WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
                params![deck_id, card_id, category_id, variant],
            )
            .map_err(|e| e.to_string())?;
            // `reason` is null and stays null from here: the reconciler is the only writer
            // that could ever have one to give, and it does not delete — it flags. The key is
            // in the shape so a later caller that *does* remove a card for a stated reason has
            // somewhere to put it, rather than a second payload shape for one kind.
            crate::deck_audit::record(
                &tx,
                deck_id,
                variant,
                crate::deck_audit::REMOVE,
                Some((card_id, name)),
                &json!({ "category": category, "quantity": was, "reason": null }),
                -was,
            )?;
        }
        // A stepper that lands on a slot already empty removed nothing, so it records nothing:
        // this is the one place the "every write records a row" rule gives way, and it gives
        // way to the truth. A `remove` of zero copies would be a history of a change that
        // never happened.
        allocate_deck(&tx, deck_id)?;
        tx.commit().map_err(|e| e.to_string())?;
        // A slot the caller wanted empty and that is empty: like `remove_entry`, a delete
        // that finds nothing already has what it wanted. There is no row left to name, so
        // the id is 0 — the only thing this path reports is that the slot is gone.
        return Ok(EntryChange {
            id: current.map_or(0, |(id, ..)| id),
            quantity: 0,
            removed: true,
        });
    }

    // The [`crate::collection::GONE`] asymmetry: an *adjustment* to a row that is not there
    // could not do what it was asked. Putting a card into a category is [`add_card`].
    let (id, was, name) = current.ok_or_else(|| card_gone(&category))?;
    tx.execute(
        "UPDATE deck_cards SET quantity = ?5, updated_at = unixepoch()
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
        params![deck_id, card_id, category_id, variant, quantity],
    )
    .map_err(|e| e.to_string())?;
    crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::QUANTITY,
        Some((card_id, &name)),
        &json!({ "category": category, "from": was, "to": quantity }),
        quantity - was,
    )?;
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Move every copy from one category to another, in one transaction, folding into the row the
/// target category already holds. **Within one variant**: a move is a re-filing, never a
/// promotion of a theory row into the live deck.
///
/// The identity travels **from the moved row**, never from a fresh `cards` lookup: a deck
/// whose printing left the card database is exactly the deck whose scratchpad someone is
/// tidying, and a move that needed the id to resolve would refuse the one row that most
/// needs moving.
///
/// `tag_id` travels with it too, where the printing does — a label is the user's word about
/// *this card in this deck*, and re-filing it is not a reason to lose it.
pub fn move_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    from_category_id: i64,
    to_category_id: i64,
    variant: &str,
) -> Result<(), String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    if from_category_id == to_category_id {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    let from = category_of_deck(&tx, deck_id, from_category_id)?;
    let to = category_of_deck(&tx, deck_id, to_category_id)?;
    // The moved row's own denormalized name, read before the move folds it into whatever the
    // target already held — and it is the row's name rather than a fresh `cards` lookup for
    // the reason the identity below travels from the row: an orphan is exactly the card most
    // likely to be getting tidied, and it has no `cards` row left to be named by.
    //
    // This read is also the "is there a row to move" fence, which used to be the `INSERT`'s own
    // affected-row count. Same `WHERE`, same answer, one statement earlier — and earlier is
    // where it belongs, because the alternative is running an INSERT … SELECT that is known to
    // select nothing before discovering it.
    let moved_name: String = tx
        .query_row(
            "SELECT name FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
            params![deck_id, card_id, from_category_id, variant],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| card_gone(&from))?;
    // `INSERT … SELECT … ON CONFLICT` over the same table: the `WHERE` is what makes it
    // unambiguous to parse, and it is here anyway. `needs_review` comes across with a row
    // that lands in an empty category and is left alone where the target row already exists —
    // the fold's rule in `reconcile::fold_deck_card_into_existing`, for its reason.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             tag_id, quantity, needs_review, created_at, updated_at)
         SELECT deck_id, ?3, variant, card_id, set_code, collector_number, lang, name,
                tag_id, quantity, needs_review, unixepoch(), unixepoch()
           FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?4 AND variant = ?5
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    tx.execute(
        &sql,
        params![deck_id, card_id, to_category_id, from_category_id, variant],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
        params![deck_id, card_id, from_category_id, variant],
    )
    .map_err(|e| e.to_string())?;
    // `delta` 0: a move changes no count. The copies are in the deck before and after, and a
    // day roll-up that charged them twice would report a tidy-up as a shopping trip.
    crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::MOVE,
        Some((card_id, &moved_name)),
        &json!({ "from": from, "to": to }),
        0,
    )?;
    // A move changes what is claimed even though nothing was added or removed: an inactive
    // category reserves nothing, so a card dragged into or out of one is a claim released or
    // made.
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// What a swap answers: where the copies ended up, and whether they had company.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResult {
    /// The target category already held that printing, so the two rows became one. The UI
    /// says so, because a deck list that silently loses a line reads like a bug.
    pub folded: bool,
    /// The quantity of the row the copies now live in — the **sum**, when `folded`.
    pub quantity: i64,
}

/// Swap a deck card to another printing of the same card: same category, same variant, same
/// copies, folding into whatever that category already holds of the printing swapped to.
///
/// The card pane's "Use this printing", and the one card write whose identity comes from a
/// **fresh `cards` lookup** rather than from the row being changed ([`move_card`]'s comment
/// is the other half of that thought). The reason is the direction of travel: a move keeps a
/// printing the user already chose, while a swap is the user choosing a new one — off a list
/// that was read out of `cards` a second ago. So an id that does not resolve is not an
/// orphan to be preserved, it is a sync that raced the click ([`PRINTING_GONE`]).
///
/// "Of the same card" is **enforced** rather than assumed: the two ids' `oracle_id`s are
/// compared and a mismatch is refused ([`not_the_same_card`]), because every statement below
/// would carry the quantity onto whatever it is handed. The pair that cannot be compared — a
/// `from` printing that has left `cards` — is allowed through; see the guard's comment. It is
/// not the only way to be uncomparable, and the doc would be flattering the guard to stop
/// there: [`oracle_of`] answers `None` for a NULL `oracle_id` as much as for a missing row, so
/// a null on *either* side skips the comparison — and a null on the **to** side would let an
/// unverified cross-card write through, where the `from` side's is the deliberate case above.
/// That is a fence around a nullable column rather than a card anyone can reach: `oracle_id` is
/// NULLABLE and no live row is null, 0 of 116 590 including all 81 reversible printings,
/// because `card_row` falls back to `card_faces[0]`.
///
/// `needs_review` is deliberately **not** carried across. The flag says the row's printing
/// left the card database, and a swap onto a printing that is in it is exactly the cure —
/// the new row is written clean. A fold leaves the target row's flag alone, [`add_card`]'s
/// rule and the reconciler's.
///
/// One transaction, for the reason [`update_deck`]'s is one: mid-swap the copies are in
/// neither row, or in both, and neither is a state a reader may see.
pub fn swap_printing(
    conn: &Connection,
    deck_id: i64,
    from_card_id: &str,
    to_card_id: &str,
    category_id: i64,
    variant: &str,
) -> Result<SwapResult, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    // Before the transaction, so a no-op does not move `updated_at` and resort the gallery.
    if from_card_id == to_card_id {
        return Err(SAME_PRINTING.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    let category = category_of_deck(&tx, deck_id, category_id)?;

    // The name comes across with the quantity because a refusal below has to say what is in
    // the deck, and the row's own denormalized name is what the deck list is showing. The set
    // code comes across for the history: "swapped `lea` for `m10`" is the whole of what a
    // reader wants from this line, and the row about to be deleted is the only place the
    // *old* one is still written down.
    let (quantity, from_name, from_set): (i64, String, String) = tx
        .query_row(
            "SELECT quantity, name, set_code FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
            params![deck_id, from_card_id, category_id, variant],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        // [`set_card_quantity`]'s asymmetry: a swap adjusts a row, and a row that is not in
        // that category is a stale editor. Putting a card into one is [`add_card`].
        .ok_or_else(|| card_gone(&category))?;

    let (set_code, collector_number, lang, name) =
        printing_row(&tx, to_card_id)?.ok_or_else(|| PRINTING_GONE.to_owned())?;

    // "Another printing of the same card" is this command's whole promise, and nothing below
    // enforces it: the insert carries the quantity onto whatever id it is handed, so a caller
    // that paired the wrong two would turn four Bolts into four Black Lotuses at the same
    // count, silently. Compared here rather than in the UI because the UI is exactly what
    // could be wrong.
    //
    // Both sides have to resolve for there to be a comparison. A **from** printing that is not
    // in `cards` is the deck's orphan row, and its oracle id is unknowable — refusing on
    // "cannot tell" would fence the copies onto a dead printing, which is the one row this
    // command most needs to be able to move (see the doc above: `needs_review` is not carried
    // across, because a swap is the cure).
    if let (Some(from_oracle), Some(to_oracle)) =
        (oracle_of(&tx, from_card_id)?, oracle_of(&tx, to_card_id)?)
    {
        if from_oracle != to_oracle {
            return Err(not_the_same_card(&from_name, &name));
        }
    }

    // [`add_card`]'s insert, grain and all — the same statement, because "put these copies
    // in that category" is the same write whether they came from a search or from another row.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             quantity, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()
         RETURNING quantity",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let landed: i64 = tx
        .query_row(
            &sql,
            params![
                deck_id,
                category_id,
                variant,
                to_card_id,
                set_code,
                collector_number,
                lang,
                name,
                quantity
            ],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND category_id = ?3 AND variant = ?4",
        params![deck_id, from_card_id, category_id, variant],
    )
    .map_err(|e| e.to_string())?;

    // `deck_cards.quantity` carries `CHECK (quantity > 0)`, so a row that was already there
    // contributed at least one copy: the landed total is strictly greater than what was moved
    // exactly when the insert folded. No second read needed to know it.
    let folded = landed > quantity;
    // `delta` 0 and the **new** printing's id: the deck holds the same number of the same card
    // and a different printing of it, so the line the history draws is about the row that
    // exists now. `folded` rides along because a deck list that silently loses a line reads
    // like a bug, and the history is the one place that can say it did not.
    crate::deck_audit::record(
        &tx,
        deck_id,
        variant,
        crate::deck_audit::SWAP,
        Some((to_card_id, &name)),
        &json!({
            "category": category,
            "fromSet": from_set,
            "toSet": set_code,
            "folded": folded,
        }),
        0,
    )?;
    // The deck wants a different printing than it did a statement ago, and the allocator
    // takes the exact printing first — so the copies it reserves can change even though the
    // count did not.
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SwapResult {
        folded,
        quantity: landed,
    })
}

// ---------------------------------------------------------------------------------------
// The read, the allocator, and what is still missing
// ---------------------------------------------------------------------------------------

/// The category **kinds** in the order [`allocate_deck`] hands scarce copies out in.
///
/// `commander` first, because a deck's commander is the copy it cannot be played without,
/// then the deck, then the cards played beside it. Only the *order* is decided here — what is
/// allocated at all is decided by `is_active`, which is a property of the category rather
/// than of its kind, and is read separately.
///
/// Two categories of the same kind (a user may own any number of `main` ones) tie here and
/// are separated by row id, which is what makes the walk deterministic. `maybe` sorts last
/// as a preference and nothing more: a Maybeboard the user deliberately switched *on* is
/// allocated for like anything else, it is simply served last when copies run short.
///
/// A permutation of [`crate::schema::CATEGORY_KINDS`], and
/// `the_allocation_order_covers_every_kind_the_schema_knows` is what keeps it one: a sixth
/// kind added to the schema with no place here would sort last by accident rather than by
/// decision.
const KIND_PRIORITY: [&str; 5] = ["commander", "main", "side", "companion", "maybe"];

/// Where a kind sorts in [`KIND_PRIORITY`]. An unknown kind — impossible past
/// `deck_categories`' own CHECK — sorts last rather than panicking.
fn kind_rank(kind: &str) -> usize {
    KIND_PRIORITY
        .iter()
        .position(|k| *k == kind)
        .unwrap_or(KIND_PRIORITY.len())
}

/// One card in one category of one deck: what it is, what the validation engine needs to
/// judge it, and how much of it the user actually has.
///
/// Three groups of columns, and the split is the design:
///
/// * **The row's own identity** (`name`, `set_code`, `collector_number`, `lang`) — copied
///   from `cards` at write time and `NOT NULL` ever since. A deck whose printing left the
///   card database still says what it is holding.
/// * **The card facts**, every one an `Option`: an orphaned row is still a card in the deck,
///   so the LEFT JOIN answers NULL rather than dropping the line — [`crate::collection`]'s
///   `FROM` discipline, for its reason.
/// * **The availability numbers**, computed at read time and stored on no row.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCardRow {
    pub id: i64,
    pub card_id: String,
    pub category_id: i64,
    /// The category's own name, as the user wrote it — what a column heading and every
    /// refusal about this row say. Denormalised into the read rather than looked up per row
    /// by the caller, because the editor draws it beside every line.
    pub category_name: String,
    /// `main` | `side` | `commander` | `companion` | `maybe` — **what the rules read**. The
    /// name is the user's and can be anything; the kind is the fixed word the validation
    /// engine sizes, counts copies and judges a commander by.
    pub category_kind: String,
    /// An inactive category counts toward nothing: not size, not copies, not legality, and
    /// [`allocate_deck`] claims no collection copy for it — so such a row always reads
    /// `owned_quantity` 0, by design and not because the user is short of it.
    pub category_active: bool,
    /// `live` | `theory` — which of the two decks this row belongs to. Every row in one read
    /// carries the same value (the read asks by variant), and it is here so a caller holding
    /// a row can write it back without remembering which list it came from.
    pub variant: String,
    /// The one tag this row carries, or none. A tag is per-deck data with a name and a
    /// palette colour, resolved here so a row can be drawn without a second lookup — and
    /// `None` on all three fields together, because a tag deleted out from under a card sets
    /// `deck_cards.tag_id` to NULL rather than deleting the card.
    pub tag_id: Option<i64>,
    pub tag_name: Option<String>,
    pub tag_color: Option<String>,
    pub quantity: i64,
    pub name: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
    pub needs_review: Option<String>,
    pub oracle_id: Option<String>,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    /// The card's colours as **concatenated letters** (`"WU"`), not a JSON array: that is
    /// what [`crate::card_row`] stores, so that is what is returned. Parsing it as JSON on
    /// the way out would be a second shape for one fact.
    pub colors: Option<String>,
    /// Scryfall's precomputed `color_identity`, in the same letter form. Precomputed is the
    /// point: it already folds in DFC backs, adventures, colour indicators and basic land
    /// types, so one subset check answers CR 903.5c and 903.5d together.
    pub color_identity: Option<String>,
    /// **This printing's** blob, not the oracle card's — the one thing that makes Old School
    /// come out right with no special case. `oldschool` is the only printing-sensitive
    /// legality key (Serra Angel is legal from `lea`, not from `8ed`), and a deck card names
    /// a printing, so each row's own blob answers the question the engine is asking.
    pub legalities: Option<String>,
    /// The printed power and toughness **as text**, because that is what they are: `"*"`,
    /// `"1+*"` and a printed `"0"` all ship in real data.
    ///
    /// Both NULL means *unknown*, never "no P/T box" — see [`fill_unknown_power_toughness`],
    /// which is what makes that true for a database that has not synced since schema v5.
    pub power: Option<String>,
    pub toughness: Option<String>,
    pub layout: Option<String>,
    pub rarity: Option<String>,
    /// The `card_faces` array verbatim: per-face mana cost, MV and P/T live only here, and
    /// Tiny Leaders' per-face MV cap and DFC commander fronts both read them.
    pub faces: Option<String>,
    pub game_changer: Option<bool>,
    /// The finishes this printing exists in, as the JSON array `cards.finishes` stores.
    ///
    /// A deck names a *printing* and never a finish — the model has no opinion on whether a
    /// copy is foil. What this answers is the narrower question the art can carry: whether
    /// the printing itself leaves no choice, which is true of 12 366 foil-only and 892
    /// etched-only paper printings. `None` for an orphan, whose card has left `cards`.
    pub finishes: Option<String>,
    /// Printed at uncommon on **any** printing of this oracle card. Computed, not read: a
    /// Pauper Commander commander is eligible for having been uncommon *somewhere*, and the
    /// `paupercommander` legality key answers a different question (the 99).
    pub ever_uncommon: bool,
    /// Nonfoil `usd` from the prices blob — `WishRow::unit_price_usd`'s rule. Never
    /// `cards.price_usd`, which is a display fallback chain and must not be summed.
    pub unit_price_usd: Option<f64>,
    /// Copies of this oracle card the allocator secured for this deck, attributed to this
    /// row in the read's own order (see [`read_deck_cards`]) and clamped to what each entry
    /// still holds — so a collection that shrank under a stored claim reads honestly.
    pub owned_quantity: i64,
}

/// One deck and everything in it: the gallery's row, one variant's cards, and **every**
/// category and tag the deck owns.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDetail {
    pub deck: DeckRow,
    pub cards: Vec<DeckCardRow>,
    /// Every category of the deck, in `sort_order`, **never filtered by what is in it**: an
    /// empty category still draws a column (that is where the next card goes) and an inactive
    /// one always draws (that is the affordance for switching it back on). A category list
    /// narrowed to the categories that happen to hold cards would make an empty deck
    /// uneditable.
    ///
    /// Their `card_count`/`total_price_usd` are scoped to the same variant the cards are.
    pub categories: Vec<DeckCategoryRow>,
    /// Every tag of the deck, alphabetically — the palette a row's label is picked from,
    /// which exists whether or not any row is wearing it.
    pub tags: Vec<DeckTagRow>,
}

/// One row of `format_specs` — the rules as data (spec §6), handed to the TS engine whole.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormatSpecRow {
    pub key: String,
    pub display_name: String,
    pub enabled_in_picker: bool,
    pub deck_min: i64,
    pub deck_max: Option<i64>,
    pub max_copies: Option<i64>,
    pub sideboard_max: Option<i64>,
    pub singleton: bool,
    pub requires_commander: bool,
    pub commander_rule: Option<String>,
    pub life: i64,
    pub restricted_semantic: String,
    pub has_legality_data: bool,
    pub max_mana_value: Option<i64>,
    pub allows_companion: bool,
    pub sort_order: i64,
}

/// One deck card and every fact about it, as one row.
///
/// Three joins, and each one's kind is a decision:
///
/// * `LEFT JOIN cards` is [`crate::collection`]'s discipline verbatim — an inner join would
///   delete from the view exactly the rows the denormalised columns exist for.
/// * `LEFT JOIN deck_tags` for the same reason at one remove: `deck_cards.tag_id` is
///   `ON DELETE SET NULL`, so an untagged row is the ordinary case, not a broken one.
/// * `JOIN deck_categories` is **inner**, and is the only inner join in this file's reads.
///   `category_id` is `NOT NULL` with an enforced foreign key, so a card with no category is
///   a row the schema cannot hold — unlike `card_id`, which is soft by design.
///
/// `ever_uncommon`'s `EXISTS` rides `idx_cards_oracle`, and answers false for an orphan on its
/// own (`NULL = NULL` is not true), which is the right answer — nothing is known about a card
/// that is not there.
///
/// The `ORDER BY` is [`read_deck_cards`]'s contract; see its doc for why it lives in SQL.
const DECK_CARD_SELECT: &str = "SELECT dc.id, dc.card_id,
            dc.category_id, cat.name, cat.kind, cat.is_active,
            dc.variant, dc.tag_id, t.name, t.color,
            dc.quantity, dc.name,
            dc.set_code, dc.collector_number, dc.lang, dc.needs_review,
            c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
            c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
            c.faces, c.game_changer, c.finishes,
            CAST(json_extract(c.prices, '$.usd') AS REAL) AS unit_price_usd,
            EXISTS(SELECT 1 FROM cards u
                    WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon
       FROM deck_cards dc
       JOIN deck_categories cat ON cat.id = dc.category_id
       LEFT JOIN deck_tags t ON t.id = dc.tag_id
       LEFT JOIN cards c ON c.id = dc.card_id
      WHERE dc.deck_id = ?1 AND dc.variant = ?2
      ORDER BY cat.sort_order, cat.id, dc.name, dc.id";

/// The whole deck in one read: the gallery's row, one variant's cards, every category, every
/// tag, every fact, every number.
///
/// One command rather than five, because the editor and the validation engine ask the same
/// question — *what is in this deck* — and a screen that draws a curve from one query, a
/// legality panel from another, an owned badge from a third and its column headings from a
/// fourth is a screen whose answers can disagree.
///
/// **`variant` scopes the cards, and every number counted over them.** *Which* categories and
/// *which* tags come back does not depend on it (see [`DeckDetail::categories`]), so switching
/// between the live deck and the theory one changes what is in the columns and never which
/// columns there are — but a category's and a tag's `card_count` both count the variant that
/// was asked for, because all three parts of this answer describe one list of cards. Threading
/// it into [`crate::deck_meta::list_categories`] and not into
/// [`crate::deck_meta::list_tags`] is exactly how they came to disagree once.
pub fn get_deck(conn: &Connection, id: i64, variant: &str) -> Result<Option<DeckDetail>, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    let Some(deck) = read_deck(conn, id)? else {
        return Ok(None);
    };
    let mut cards = read_deck_cards(conn, id, variant)?;
    fill_unknown_power_toughness(conn, &mut cards)?;
    attribute_owned(&mut cards, &owned_by_oracle(conn, id)?);
    let categories = crate::deck_meta::list_categories(conn, id, variant)?;
    let tags = crate::deck_meta::list_tags(conn, id, variant)?;
    Ok(Some(DeckDetail {
        deck,
        cards,
        categories,
        tags,
    }))
}

/// Every card in one variant of the deck, in the order the editor reads them.
///
/// **Category `sort_order`, then the name the row carries, then row id** — and it is an
/// `ORDER BY` rather than a `sort_by` because the sort key that decides it (`sort_order`)
/// belongs to the category and is not a field of [`DeckCardRow`]. `cat.id` breaks a tie
/// between two categories the user gave the same order, so the walk is total.
///
/// The name is the *row's*, which an orphan has and its `cards` row does not. This order is
/// the read's own and not the caller's: [`attribute_owned`] hands `owned_quantity` out along
/// it, so the number a row shows must not depend on how a view chose to display the list.
fn read_deck_cards(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<DeckCardRow>, String> {
    let mut stmt = conn.prepare(DECK_CARD_SELECT).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], |r| {
            Ok(DeckCardRow {
                id: r.get(0)?,
                card_id: r.get(1)?,
                category_id: r.get(2)?,
                category_name: r.get(3)?,
                category_kind: r.get(4)?,
                category_active: r.get(5)?,
                variant: r.get(6)?,
                tag_id: r.get(7)?,
                tag_name: r.get(8)?,
                tag_color: r.get(9)?,
                quantity: r.get(10)?,
                name: r.get(11)?,
                set_code: r.get(12)?,
                collector_number: r.get(13)?,
                lang: r.get(14)?,
                needs_review: r.get(15)?,
                oracle_id: r.get(16)?,
                mana_cost: r.get(17)?,
                cmc: r.get(18)?,
                type_line: r.get(19)?,
                oracle_text: r.get(20)?,
                colors: r.get(21)?,
                color_identity: r.get(22)?,
                legalities: r.get(23)?,
                power: r.get(24)?,
                toughness: r.get(25)?,
                layout: r.get(26)?,
                rarity: r.get(27)?,
                faces: r.get(28)?,
                game_changer: r.get(29)?,
                finishes: r.get(30)?,
                unit_price_usd: r.get(31)?,
                ever_uncommon: r.get(32)?,
                // Filled by `attribute_owned`, once the claims are known.
                owned_quantity: 0,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Recover a P/T that the `cards` columns do not have yet.
///
/// **Both columns NULL means unknown, never "no P/T box"** — and CR 903.3 (2026) turns on
/// exactly that difference: a legendary Vehicle or Spacecraft *with* a P/T box can be a
/// commander, one without cannot. `power`/`toughness` are schema v5 columns that the ingest
/// fills from here on, but the v5 backfill could only recover the **1 510 of 116 590** rows
/// that keep a `card_faces` array: `raw` is a gzip BLOB, and SQL cannot see into one. Until
/// the next real sync — which the 24 h throttle and the ETag check can put a day or more
/// away — every ordinary creature in every deck reads NULL, and a validator told "no P/T
/// box" would refuse commanders that are legal.
///
/// So the read repairs itself, for the rows that ask and only those: one lookup per distinct
/// printing that is **both** missing its P/T and of a type that could have one, gunzipped
/// **in Rust** through [`crate::card_row::raw_json`] over `CAST(raw AS BLOB)`, because
/// `json_extract` over a gzip member is a hard `malformed JSON` error rather than a NULL
/// (CLAUDE.md).
///
/// The type gate is what keeps this from being permanent: on a *fully synced* database both
/// columns are NULL for every land, instant, sorcery, enchantment and ordinary artifact —
/// Scryfall simply omits the keys, and NULL is then the correct answer — so an ungated
/// recovery would inflate and parse a 2 KB blob for the majority of every deck, forever,
/// and find nothing every time. See [`may_have_a_power_toughness_box`].
fn fill_unknown_power_toughness(conn: &Connection, rows: &mut [DeckCardRow]) -> Result<(), String> {
    let unknown: Vec<String> = {
        let mut ids: Vec<String> = rows
            .iter()
            .filter(|r| {
                r.power.is_none()
                    && r.toughness.is_none()
                    && may_have_a_power_toughness_box(r.type_line.as_deref())
            })
            .map(|r| r.card_id.clone())
            .collect();
        ids.sort_unstable();
        ids.dedup();
        ids
    };
    if unknown.is_empty() {
        return Ok(());
    }
    let mut stmt = conn
        .prepare("SELECT CAST(raw AS BLOB) FROM cards WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut printed: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    for card_id in unknown {
        let stored: Option<Vec<u8>> = stmt
            .query_row(params![card_id], |r| r.get(0))
            .optional()
            .map_err(|e| e.to_string())?;
        // An orphan has no `raw` to read, and that is the honest answer for it too.
        let Some(json) = stored.as_deref().and_then(crate::card_row::raw_json) else {
            continue;
        };
        printed.insert(card_id, printed_power_toughness(&json));
    }
    for row in rows.iter_mut() {
        if let Some((power, toughness)) = printed.get(&row.card_id) {
            row.power.clone_from(power);
            row.toughness.clone_from(toughness);
        }
    }
    Ok(())
}

/// Whether a missing P/T is worth going to `raw` for.
///
/// The three types that print a P/T box: creatures, and — since 2026 — Vehicles and
/// Spacecraft, which is the same list CR 903.3 gives for what a legendary permanent must be
/// to command a deck. Everything else has no box, so NULL is not a gap in the data but the
/// fact itself, and looking is a guaranteed miss.
///
/// Matched against the **whole** type line, which is why a transform card is covered: `cards`
/// stores the combined `"Land // Legendary Creature — Demon"`, so a back-face creature is
/// found by the same substring. A **NULL** type line is treated as *could be* — an orphan has
/// no type line and neither does a card row that arrived without one, and the conservative
/// direction for an unknown is to look. One wasted lookup is cheaper than a commander refused.
fn may_have_a_power_toughness_box(type_line: Option<&str>) -> bool {
    match type_line {
        None => true,
        Some(t) => ["Creature", "Vehicle", "Spacecraft"]
            .iter()
            .any(|k| t.contains(k)),
    }
}

/// A bulk line's printed P/T: top level, then the front face — [`crate::card_row`]'s own
/// fallback, because a transform card keeps its P/T only on its faces.
fn printed_power_toughness(json: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else {
        return (None, None);
    };
    let pick = |key: &str| {
        value
            .get(key)
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                value
                    .get("card_faces")
                    .and_then(|f| f.get(0))
                    .and_then(|f| f.get(key))
                    .and_then(serde_json::Value::as_str)
            })
            .map(str::to_owned)
    };
    (pick("power"), pick("toughness"))
}

/// Copies this deck has secured, per oracle card, **clamped entry by entry**.
///
/// `min(a.quantity, e.quantity)` is the clamp and it is per claim, not per total: a deck that
/// reserved four copies of a row the user has since stepped to one owns one of them. The
/// stored claim is left alone — the next card write recomputes it — because a read is not
/// the place to discover that the world moved.
///
/// **`deck_allocations` carries no variant, and does not need one**: [`allocate_deck`] only
/// ever writes claims for the `live` list, so every row here is a live claim by construction.
/// What that means for a `theory` read is [`attribute_owned`]'s to decide, and it decides it
/// explicitly rather than by accident.
fn owned_by_oracle(conn: &Connection, deck_id: i64) -> Result<HashMap<String, i64>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.oracle_id, sum(min(a.quantity, e.quantity))
               FROM deck_allocations a
               JOIN collection_entries e ON e.id = a.collection_entry_id
               JOIN cards c ON c.id = e.card_id
              WHERE a.deck_id = ?1 AND c.oracle_id IS NOT NULL
              GROUP BY c.oracle_id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<HashMap<_, _>>>()
        .map_err(|e| e.to_string())
}

/// Hand the secured copies out to the rows that wanted them.
///
/// Pure, and deliberately so: this is the one piece of the availability story with no SQL in
/// it. The walk is the slice's own order, which is [`read_deck_cards`]' `ORDER BY` — the
/// read's order and not a caller's, which is the property that matters: a list that sorted
/// itself differently before calling this would attribute differently, and the number a row
/// shows must not depend on how it was displayed. `get_deck` is the only caller and hands the
/// rows straight over.
///
/// **A row the allocator did not claim for is passed over rather than served last**, and there
/// are two of those. A row in an **inactive** category: the allocator claimed nothing for it
/// (see [`allocate_deck`]), so there is nothing of its to hand out, and letting it take from
/// the pool would move copies off the rows that *are* the deck onto a scratchpad that reserves
/// none of them. And a row in the **theory** list, which is the subtler one: `deck_allocations`
/// carries no variant, so a theory read walks the *live* deck's claims and would otherwise hand
/// a plan the copies the sleeved deck reserved. A plan reserves nothing and must say so —
/// pinned by `the_allocator_claims_nothing_for_the_theory_variant`.
///
/// This walk and [`allocate_deck`]'s are deliberately **not** the same order — the allocator
/// spends copies in [`KIND_PRIORITY`], and this hands them out in the user's own category
/// order — and the difference is visible in exactly one case: the same oracle card filed in
/// two categories while the user owns fewer copies than the two rows want between them. The
/// *total* is identical either way (both walk every active row once, drawing on one pool);
/// only which of the two rows wears the badge can differ. That is the trade for a read whose
/// order is the order the deck is written in, which is what the editor draws.
fn attribute_owned(rows: &mut [DeckCardRow], owned_by_oracle: &HashMap<String, i64>) {
    let mut left = owned_by_oracle.clone();
    for row in rows.iter_mut() {
        let claimed_for = row.category_active && row.variant == LIVE;
        let Some(oracle) = row.oracle_id.clone().filter(|_| claimed_for) else {
            row.owned_quantity = 0;
            continue;
        };
        let remaining = left.entry(oracle).or_insert(0);
        let take = (*remaining).min(row.quantity).max(0);
        *remaining -= take;
        row.owned_quantity = take;
    }
}

/// One collection row this deck could draw a copy from, and how many it still could.
struct Candidate {
    entry_id: i64,
    card_id: String,
    proxy: bool,
    /// The entry's quantity less every **built** other deck's claim on it, floored at zero,
    /// and then less whatever this walk has already taken.
    available: i64,
}

/// Recompute this deck's claims from scratch.
///
/// **Delete and rebuild**, which is what makes it both deterministic and idempotent: there is
/// no incremental state to drift, and running it twice on an unchanged world writes the same
/// rows. Greedy, in [`KIND_PRIORITY`] order over the deck's cards: for each one, the entries
/// of the same **oracle** card — a Bolt is a Bolt — taking the exact printing first, real
/// copies before proxies, then entry id, and never more than the entry still has free.
///
/// **Two filters decide what is allocated for at all**, and both are the whole of a rule
/// stated once elsewhere:
///
/// * `variant = 'live'` ([`LIVE`]). A theory list is a plan, and a plan claims nothing — a
///   change tried out in Theory must not take copies away from the decks that are real.
/// * `cat.is_active = 1`. An inactive category counts toward nothing, and copies reserved for
///   a card the user has not decided to play are copies another deck cannot have. This is the
///   *only* thing that decides it — there is no kind check here, so a Maybeboard switched on
///   allocates and a main-deck category switched off does not.
///
/// Availability is `entry.quantity` minus the claims of other **built** decks. That is the
/// whole of what `is_built` means: a deck on a table has the cards, a deck being planned is
/// planning with cards it may share with every other draft. A deck is never blocked by its
/// own claims, which is why they are deleted before anything is counted.
///
/// **Takes `&Connection` and opens no transaction of its own.** Every card write already runs
/// inside one and `unchecked_transaction` does not nest — `Transaction` derefs to
/// `Connection`, so `allocate_deck(&tx, id)` is the call at every site.
///
/// The collection is never written to. Not once, not by a column, not by a trigger: an
/// allocation is a claim recorded beside the binder, and spec §6's non-destructive model is
/// exactly that sentence.
pub fn allocate_deck(conn: &Connection, deck_id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM deck_allocations WHERE deck_id = ?1",
        params![deck_id],
    )
    .map_err(|e| e.to_string())?;

    // What the deck wants. `JOIN cards` is an INNER join, because the hunt is for entries of
    // the same oracle card and an orphaned row names no oracle card — it is listed, flagged
    // and reads owned 0 until the reconciler or the next sync gives it its identity back.
    let mut wants: Vec<(i64, String, String, i64, String)> = conn
        .prepare(
            "SELECT dc.id, cat.kind, dc.card_id, dc.quantity, c.oracle_id
               FROM deck_cards dc
               JOIN deck_categories cat ON cat.id = dc.category_id
               JOIN cards c ON c.id = dc.card_id
              WHERE dc.deck_id = ?1 AND dc.variant = ?2 AND cat.is_active = 1
                AND c.oracle_id IS NOT NULL",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![deck_id, LIVE], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    wants.sort_by_key(|(id, kind, ..)| (kind_rank(kind), *id));

    let mut stmt = conn
        .prepare(
            "SELECT e.id, e.card_id, e.proxy, e.quantity -
                    coalesce((SELECT sum(a.quantity) FROM deck_allocations a
                               JOIN decks d ON d.id = a.deck_id
                              WHERE a.collection_entry_id = e.id
                                AND a.deck_id <> ?1 AND d.is_built = 1), 0)
               FROM collection_entries e JOIN cards c ON c.id = e.card_id
              WHERE c.oracle_id = ?2
              ORDER BY e.id",
        )
        .map_err(|e| e.to_string())?;

    // One candidate list per oracle card, drawn down as the walk spends it — so two zones
    // wanting the same card cannot both be told the same copies are free.
    let mut pools: HashMap<String, Vec<Candidate>> = HashMap::new();
    // BTreeMap: one row per entry drawn from ([`crate::schema::ALLOCATION_GRAIN`] is the
    // pair), written in a fixed order.
    let mut taken: BTreeMap<i64, i64> = BTreeMap::new();

    for (_, _, card_id, quantity, oracle_id) in wants {
        let pool = match pools.entry(oracle_id) {
            std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
            std::collections::hash_map::Entry::Vacant(e) => {
                let candidates = stmt
                    .query_map(params![deck_id, e.key()], |r| {
                        Ok(Candidate {
                            entry_id: r.get(0)?,
                            card_id: r.get(1)?,
                            proxy: r.get(2)?,
                            available: r.get::<_, i64>(3)?.max(0),
                        })
                    })
                    .map_err(|err| err.to_string())?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(|err| err.to_string())?;
                e.insert(candidates)
            }
        };
        // Exact printing, then real copies, then the oldest entry. Computed per deck card
        // rather than once per pool: "exact" is a statement about the card being served.
        let mut order: Vec<usize> = (0..pool.len()).collect();
        order.sort_by_key(|&i| (pool[i].card_id != card_id, pool[i].proxy, pool[i].entry_id));

        let mut still = quantity;
        for i in order {
            if still == 0 {
                break;
            }
            let candidate = &mut pool[i];
            let draw = candidate.available.min(still);
            if draw > 0 {
                candidate.available -= draw;
                still -= draw;
                *taken.entry(candidate.entry_id).or_insert(0) += draw;
            }
        }
    }

    for (entry_id, quantity) in taken {
        conn.execute(
            "INSERT INTO deck_allocations
                (deck_id, collection_entry_id, quantity, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())",
            params![deck_id, entry_id, quantity],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// One wish per card the deck is still short of. Returns how many wishes were touched.
///
/// **Any printing**, always: a shopping list is not a printing preference, and the copy that
/// fills the hole is whichever one turns up. An **inactive** category is not counted, and the
/// **theory** list is not read at all — a card the user has not decided to play is not a card
/// they need to buy, whether the undecidedness is a switched-off category or a whole plan.
///
/// Written *through* [`crate::wishlist::add_wish`] rather than into `wishlist_entries`: the
/// grain, the canonicalisation and the fold all live there, and a second write path is a
/// second set of rules to keep in step. Clicking twice therefore raises the quantity of one
/// line rather than making two, which is `add_wish`'s contract and not this function's.
///
/// It reallocates first, in the same transaction. The claims may be a collection edit out of
/// date (see [`allocate_deck`]'s callers), and a button that puts already-bought cards on a
/// shopping list is worse than no button.
///
/// An orphaned row is skipped: a wish needs an oracle card or a printing that resolves, and
/// an orphan has neither. It is already carrying a `needs_review` sentence that says so.
///
/// **Records no history**, and it is the one card-adjacent command that does not: nothing about
/// the deck changed. It writes the wishlist and it rewrites this deck's claims, and neither is
/// a change to what the deck plays — the drawer would be reporting a shopping trip as an edit.
pub fn missing_to_wishlist(conn: &Connection, deck_id: i64) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    allocate_deck(&tx, deck_id)?;
    let detail = get_deck(&tx, deck_id, LIVE)?.ok_or_else(|| GONE.to_owned())?;

    // Oracle-grained, so the same card short in two categories is one wish for the sum —
    // which is what "one wish per card still missing" means, and what the reader would count.
    let mut missing: BTreeMap<String, (String, i64)> = BTreeMap::new();
    for row in &detail.cards {
        if !row.category_active {
            continue;
        }
        let Some(oracle_id) = row.oracle_id.as_deref() else {
            continue;
        };
        let short = row.quantity - row.owned_quantity;
        if short <= 0 {
            continue;
        }
        let entry = missing
            .entry(oracle_id.to_owned())
            .or_insert_with(|| (row.name.clone(), 0));
        entry.1 += short;
    }

    let touched = missing.len();
    for (oracle_id, (name, quantity)) in missing {
        crate::wishlist::add_wish(
            &tx,
            &crate::wishlist::WishInput {
                oracle_id: Some(oracle_id),
                // The deck row's own name, which is the one name an orphan-safe row always
                // has — and the same name the list would show for it.
                name: Some(name),
                quantity,
                ..Default::default()
            },
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(touched)
}

/// The format rules, as data (spec §6), in the order a picker shows them.
///
/// Read whole and handed to the engine: a new format is a seeded row, never a code branch,
/// and that is only true if nothing here decides which cells matter.
pub fn list_format_specs(conn: &Connection) -> Result<Vec<FormatSpecRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT key, display_name, enabled_in_picker, deck_min, deck_max, max_copies,
                    sideboard_max, singleton, requires_commander, commander_rule, life,
                    restricted_semantic, has_legality_data, max_mana_value, allows_companion,
                    sort_order
               FROM format_specs ORDER BY sort_order",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(FormatSpecRow {
                key: r.get(0)?,
                display_name: r.get(1)?,
                enabled_in_picker: r.get(2)?,
                deck_min: r.get(3)?,
                deck_max: r.get(4)?,
                max_copies: r.get(5)?,
                sideboard_max: r.get(6)?,
                singleton: r.get(7)?,
                requires_commander: r.get(8)?,
                commander_rule: r.get(9)?,
                life: r.get(10)?,
                restricted_semantic: r.get(11)?,
                has_legality_data: r.get(12)?,
                max_mana_value: r.get(13)?,
                allows_companion: r.get(14)?,
                sort_order: r.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Run `f` with the write connection, or answer [`crate::collection::BUSY`].
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(crate::collection::BUSY.to_owned()),
    }
}

/// What a deck write says when its worker thread died under it. Never a user's problem —
/// the write itself answers [`crate::collection::BUSY`] when the database is busy.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck could not be written: {e}")
}

#[tauri::command]
pub async fn deck_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck: DeckInput,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| create_deck(c, &deck)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    patch: DeckPatch,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| update_deck(c, id, &patch)))
        .await
        .map_err(unfinished)?
}

/// Delete a deck, and the custom cover file that was only ever about it.
///
/// The covers directory is resolved before the blocking task rather than inside it, because
/// `AppHandle` is what resolves it and the task owns everything it touches. `None` — the app
/// still starting, an unwritable data folder — is not a reason to refuse a delete: see
/// [`delete_deck`].
#[tauri::command]
pub async fn deck_delete(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    let covers = crate::paths::covers_dir(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_deck(c, id, covers.as_deref()))
    })
    .await
    .map_err(unfinished)?
}

/// Point a deck at a picture on disk. Answers the deck as the gallery would read it.
///
/// **The encode is inside the blocking task and outside the write lock**, and the order is the
/// point rather than a detail: a decode of up to
/// [`crate::images::MAX_COVER_SOURCE_PIXELS`] plus a Lanczos resample plus a lossless WEBP
/// encode is not tens of milliseconds at the top of that range, and holding the app-wide write
/// mutex across it would put every collection edit in the app behind one file-picker. It is
/// [`set_cover_image`]'s **signature** that keeps this true — it takes bytes and cannot
/// encode — because the version of this that took a path had the doc and the wiring disagree.
#[tauri::command]
pub async fn deck_set_cover_image(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    deck_id: i64,
    source_path: String,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    let covers = crate::paths::covers_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = crate::images::encode_cover(Path::new(&source_path))?;
        with_write(&state, |c| set_cover_image(c, &covers, deck_id, &bytes))
    })
    .await
    .map_err(unfinished)?
}

/// Copy a deck, its categories, its tags, its cards — and its custom cover file.
///
/// The covers directory is resolved before the blocking task, like [`deck_delete`]'s, and `None`
/// is not a reason to refuse: the copy falls back to card art. See [`duplicate_deck`].
#[tauri::command]
pub async fn deck_duplicate(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    id: i64,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    let covers = crate::paths::covers_dir(&app).ok();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| duplicate_deck(c, id, covers.as_deref()))
    })
    .await
    .map_err(unfinished)?
}

/// File a deck under a folder, or with `folderId: null` back at the root of the tree — the one
/// thing [`DeckPatch`] cannot express. See [`set_folder`].
#[tauri::command]
pub async fn deck_set_folder(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    folder_id: Option<i64>,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_folder(c, deck_id, folder_id))
    })
    .await
    .map_err(unfinished)?
}

/// The deck gallery. **Read-only** connection, blocking pool — as every read in this app
/// is, so a gallery never queues behind a sync.
#[tauri::command]
pub async fn deck_list(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<DeckRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_decks(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck list could not be read: {e}"))?
}

/// One deck, one variant's cards, every category and tag, every fact the validator needs.
/// **Read-only** connection.
#[tauri::command]
pub async fn deck_get(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    variant: String,
) -> Result<Option<DeckDetail>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        get_deck(&crate::sync::lock_db_read(&state), id, &variant)
    })
    .await
    .map_err(|e| format!("the deck could not be read: {e}"))?
}

/// The format rules as data, for the picker and the validation engine. **Read-only.**
#[tauri::command]
pub async fn format_specs_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<FormatSpecRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_format_specs(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("the format list could not be read: {e}"))?
}

/// The one click: everything this deck is short of, onto the wishlist.
#[tauri::command]
pub async fn deck_missing_to_wishlist(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| missing_to_wishlist(c, deck_id))
    })
    .await
    .map_err(unfinished)?
}

/// Put copies into a category. **`categoryId` or `categoryName`, and at least one** — see
/// [`add_card`] for which wins when both arrive.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn deck_add_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: Option<i64>,
    category_name: Option<String>,
    variant: String,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            add_card(
                c,
                deck_id,
                &card_id,
                category_id,
                category_name.as_deref(),
                &variant,
                quantity,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_set_card_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    category_id: i64,
    variant: String,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            set_card_quantity(c, deck_id, &card_id, category_id, &variant, quantity)
        })
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_move_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    from_category_id: i64,
    to_category_id: i64,
    variant: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            move_card(
                c,
                deck_id,
                &card_id,
                from_category_id,
                to_category_id,
                &variant,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

/// The card pane's "Use this printing". `deckId` like every other card write's, because
/// `decks.id` is an integer everywhere it is written.
#[tauri::command]
pub async fn deck_swap_printing(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    from_card_id: String,
    to_card_id: String,
    category_id: i64,
    variant: String,
) -> Result<SwapResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            swap_printing(
                c,
                deck_id,
                &from_card_id,
                &to_card_id,
                category_id,
                &variant,
            )
        })
    })
    .await
    .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The other variant, spelled out beside [`LIVE`] so a test that means "the plan" says so.
    const THEORY: &str = crate::schema::DECK_VARIANTS[1];

    /// Five printings of two oracle cards.
    ///
    /// `o1` is three printings of one common — the allocator's cross-printing walk needs a
    /// second and a third printing of the *same* card to have anything to walk. `o2` is the
    /// pair the read is judged on: Serra Angel was **uncommon** in Alpha and **rare** in
    /// Eighth, and Old School accepts the Alpha printing and refuses the Eighth. One
    /// fixture, both traps, and neither of them invented — those are the real rarities and
    /// the real legalities.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,artist,mana_cost,cmc,type_line,oracle_text,colors,color_identity,
                    legalities,power,toughness,prices,raw)
               VALUES
                 ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                  'Christopher Rush','{R}',1.0,'Instant',
                  'Lightning Bolt deals 3 damage to any target.','R','R',
                  '{"oldschool":"legal","modern":"legal"}',NULL,NULL,
                  '{"usd":"400.00","usd_foil":null}','{}'),
                 ('bolt-jp','o1','Lightning Bolt','4ed','209','ja','normal','common',
                  'Christopher Rush','{R}',1.0,'Instant',
                  'Lightning Bolt deals 3 damage to any target.','R','R',
                  '{"oldschool":"not_legal","modern":"legal"}',NULL,NULL,NULL,'{}'),
                 ('bolt-m10','o1','Lightning Bolt','m10','146','en','normal','common',
                  'Christopher Moeller','{R}',1.0,'Instant',
                  'Lightning Bolt deals 3 damage to any target.','R','R',
                  '{"oldschool":"not_legal","modern":"legal"}',NULL,NULL,
                  '{"usd":"1.50"}','{}'),
                 ('serra-lea','o2','Serra Angel','lea','175','en','normal','uncommon',
                  'Douglas Shuler','{3}{W}{W}',5.0,'Creature — Angel','Flying, vigilance',
                  'W','W','{"oldschool":"legal","paupercommander":"not_legal"}','4','4',
                  '{"usd":"120.00"}','{}'),
                 ('serra-8ed','o2','Serra Angel','8ed','44','en','normal','rare',
                  'Greg Staples','{3}{W}{W}',5.0,'Creature — Angel','Flying, vigilance',
                  'W','W','{"oldschool":"not_legal","paupercommander":"not_legal"}','4','4',
                  '{"usd":"1.00"}','{}');"#,
        )
        .unwrap();
        conn
    }

    /// The deck's predefined category of one `kind` — the row [`create_deck`] seeded through
    /// `deck_meta::ensure_predefined_categories`. Panics rather than creating one: a deck
    /// missing a predefined kind is a broken invariant, not a fixture to paper over.
    fn kind_of(conn: &Connection, deck_id: i64, kind: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND kind = ?2",
            params![deck_id, kind],
            |r| r.get(0),
        )
        .unwrap_or_else(|e| panic!("deck {deck_id} has no `{kind}` category: {e}"))
    }

    /// The deck's main pile, made on first ask.
    ///
    /// There is no predefined `main` category — a deck may own any number of them, so the
    /// schema predefines none — and this is `deck_meta::category_for_name`, which is exactly
    /// the call [`add_card`]'s name arm makes. So a test that asks for it twice gets one
    /// category, the same way the app does.
    fn main_of(conn: &Connection, deck_id: i64) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, "Main deck").unwrap()
    }

    /// [`add_card`] by explicit category, in the live variant — the shape almost every test
    /// below wants, so the two arms it does not want stay visible where they are used.
    fn add(
        conn: &Connection,
        deck_id: i64,
        card_id: &str,
        category_id: i64,
        quantity: i64,
    ) -> EntryChange {
        add_card(
            conn,
            deck_id,
            card_id,
            Some(category_id),
            None,
            LIVE,
            quantity,
        )
        .unwrap()
    }

    /// One collection row, at the plainest grain there is.
    fn own(conn: &Connection, card_id: &str, quantity: i64) -> i64 {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// The same, printed at home.
    fn own_proxy(conn: &Connection, card_id: &str, quantity: i64) -> i64 {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                proxy: true,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// What this deck has reserved, entry id ascending.
    fn claims(conn: &Connection, deck_id: i64) -> Vec<(i64, i64)> {
        conn.prepare(
            "SELECT collection_entry_id, quantity FROM deck_allocations
              WHERE deck_id = ?1 ORDER BY collection_entry_id",
        )
        .unwrap()
        .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    fn card_row<'a>(detail: &'a DeckDetail, card_id: &str, category_id: i64) -> &'a DeckCardRow {
        detail
            .cards
            .iter()
            .find(|r| r.card_id == card_id && r.category_id == category_id)
            .unwrap_or_else(|| panic!("no `{card_id}` in category {category_id}"))
    }

    /// What the deck says it owns of one printing, read the way the editor reads it.
    fn owned_of(conn: &Connection, deck_id: i64, card_id: &str, category_id: i64) -> i64 {
        let detail = get_deck(conn, deck_id, LIVE).unwrap().unwrap();
        card_row(&detail, card_id, category_id).owned_quantity
    }

    fn input(name: &str, format_key: &str) -> DeckInput {
        DeckInput {
            name: name.to_owned(),
            format_key: format_key.to_owned(),
            description: None,
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    /// One collection row plus one deck's claim on it — the two things a duplicate and a
    /// delete both have to have an opinion about.
    fn own_and_claim(conn: &Connection, deck_id: i64) -> i64 {
        let entry: i64 = conn
            .query_row(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     created_at,updated_at)
                 VALUES ('bolt-lea','lea','161','en','nonfoil','NM',4,unixepoch(),unixepoch())
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        conn.execute(
            "INSERT INTO deck_allocations
                (deck_id, collection_entry_id, quantity, created_at, updated_at)
             VALUES (?1,?2,4,unixepoch(),unixepoch())",
            params![deck_id, entry],
        )
        .unwrap();
        entry
    }

    /// The card write is the collection quick-add's contract on the deck grain: the same
    /// printing in the same category twice is one row with a bigger number, and the printing
    /// AND name are denormalized from `cards` at write time — the only moment they are
    /// knowable, and the reason the row outlives the id (spec §6, CLAUDE.md).
    #[test]
    fn adding_the_same_card_to_the_same_category_twice_folds() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);

        let first = add(&conn, deck.id, "bolt-jp", main, 2);
        let second = add(&conn, deck.id, "bolt-jp", main, 2);

        assert_eq!(first.id, second.id, "the same grain is the same row");
        assert_eq!(second.quantity, 4);
        assert_eq!(count(&conn, "deck_cards"), 1);

        let (set, cn, lang, name): (String, String, String, String) = conn
            .query_row(
                "SELECT set_code, collector_number, lang, name FROM deck_cards WHERE id = ?1",
                params![second.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (set.as_str(), cn.as_str(), lang.as_str(), name.as_str()),
            ("4ed", "209", "ja", "Lightning Bolt"),
            "the printing and the name are copied from `cards` at write time"
        );

        // `category_id` is in the grain: the same printing in the Maybeboard is a second
        // intention, not the same row somewhere else.
        let scratch = add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "maybe"),
            1,
        );
        assert_ne!(scratch.id, second.id);
        assert_eq!(count(&conn, "deck_cards"), 2);

        // …and so is `variant`: a change tried out in Theory is a row of its own, never a
        // draft that could silently overwrite the deck as it is sleeved.
        let theory = add_card(&conn, deck.id, "bolt-jp", Some(main), None, THEORY, 3).unwrap();
        assert_ne!(theory.id, second.id);
        assert_eq!(
            theory.quantity, 3,
            "and it started from nothing, not from 4"
        );
        assert_eq!(count(&conn, "deck_cards"), 3);
    }

    /// The add path's other arm: a **name** rather than an id, found-or-created. This is what
    /// "when a card is added but not to a specific category, it should find its card category
    /// or create it" means — the word is computed in TypeScript, the find-or-create is here.
    #[test]
    fn adding_by_category_name_finds_or_creates_one_and_needing_neither_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let before = count(&conn, "deck_categories");

        let first = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            None,
            Some("Burn spells"),
            LIVE,
            2,
        )
        .unwrap();
        let second = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            None,
            Some("Burn spells"),
            LIVE,
            2,
        )
        .unwrap();

        assert_eq!(first.id, second.id, "the second add found the first's pile");
        assert_eq!(second.quantity, 4);
        assert_eq!(
            count(&conn, "deck_categories"),
            before + 1,
            "one new category, not two"
        );
        let (name, kind, active): (String, String, bool) = conn
            .query_row(
                "SELECT cat.name, cat.kind, cat.is_active
                   FROM deck_cards dc JOIN deck_categories cat ON cat.id = dc.category_id
                  WHERE dc.id = ?1",
                params![first.id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (name.as_str(), kind.as_str(), active),
            ("Burn spells", "main", true),
            "a category the user's own cards made is a `main` one, and it counts"
        );

        // Neither an id nor a name is refused in words, and before anything is written:
        // `deck_cards.category_id` is NOT NULL, so there is no row to make.
        let err = add_card(&conn, deck.id, "bolt-m10", None, None, LIVE, 1).unwrap_err();
        assert_eq!(err, NO_CATEGORY);
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was written");

        // Both: the id wins, because it is the more specific instruction and the one a drag
        // carries. The name is not even looked at, so no category is made for it.
        let categories = count(&conn, "deck_categories");
        let explicit = add_card(
            &conn,
            deck.id,
            "bolt-m10",
            Some(kind_of(&conn, deck.id, "side")),
            Some("Ignored"),
            LIVE,
            1,
        )
        .unwrap();
        assert_eq!(count(&conn, "deck_categories"), categories);
        let landed: String = conn
            .query_row(
                "SELECT cat.name FROM deck_cards dc
                   JOIN deck_categories cat ON cat.id = dc.category_id WHERE dc.id = ?1",
                params![explicit.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(landed, "Sideboard");
    }

    /// The two fences every card write opens with: a variant the schema does not know, and a
    /// category id that resolves to another deck's pile. Neither is stopped by the DDL —
    /// `deck_cards.category_id`'s foreign key only asks that the category *exist* — so both
    /// are refused here, in words, before a row can be filed into the wrong deck.
    #[test]
    fn an_unknown_variant_and_another_decks_category_are_both_refused_in_words() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let other = create_deck(&conn, &input("Angels", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let theirs = main_of(&conn, other.id);

        let err = add_card(&conn, deck.id, "bolt-lea", Some(main), None, "draft", 1).unwrap_err();
        assert!(err.contains("draft"), "{err}");
        for variant in crate::schema::DECK_VARIANTS {
            assert!(
                err.contains(variant),
                "the refusal names `{variant}`: {err}"
            );
        }

        let err = add_card(&conn, deck.id, "bolt-lea", Some(theirs), None, LIVE, 1).unwrap_err();
        assert_eq!(err, crate::deck_meta::CATEGORY_WRONG_DECK);

        let err = add_card(
            &conn,
            deck.id,
            "bolt-lea",
            Some(theirs + 999),
            None,
            LIVE,
            1,
        )
        .unwrap_err();
        assert_eq!(
            err,
            crate::deck_meta::CATEGORY_GONE,
            "gone and not-yours are different things to tell a stale editor"
        );
        assert_eq!(count(&conn, "deck_cards"), 0, "and nothing was written");

        // Every card write runs the same two fences, so the CHECK and the FK never reach a
        // user. **The row has to exist first and the refusal has to be compared by text**, and
        // both halves are the point: with an empty deck every one of these calls errors at its
        // row lookup instead, with `card_gone`, so an `is_err()` here goes on passing with the
        // fences deleted from all three commands. That is what this assertion used to be.
        add(&conn, deck.id, "bolt-lea", main, 4);
        assert_eq!(
            set_card_quantity(&conn, deck.id, "bolt-lea", theirs, LIVE, 1).unwrap_err(),
            crate::deck_meta::CATEGORY_WRONG_DECK
        );
        let err = set_card_quantity(&conn, deck.id, "bolt-lea", main, "draft", 1).unwrap_err();
        assert!(err.contains("draft"), "{err}");
        assert_eq!(
            move_card(&conn, deck.id, "bolt-lea", main, theirs, LIVE).unwrap_err(),
            crate::deck_meta::CATEGORY_WRONG_DECK,
            "the destination is fenced as well as the source"
        );
        assert_eq!(
            swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", theirs, LIVE).unwrap_err(),
            crate::deck_meta::CATEGORY_WRONG_DECK
        );
        assert_eq!(
            count(&conn, "deck_cards"),
            1,
            "and the one row that does exist is untouched"
        );
    }

    #[test]
    fn zero_removes_the_deck_card_and_negative_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let added = add(&conn, deck.id, "bolt-lea", main, 4);

        let lowered = set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, 1).unwrap();
        assert_eq!(
            (lowered.id, lowered.quantity, lowered.removed),
            (added.id, 1, false),
            "an absolute quantity, not an addition"
        );

        let err = set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, -1).unwrap_err();
        assert!(err.contains("is not a quantity"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 1, "and it never deletes");

        let removed = set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, 0).unwrap();
        assert_eq!(
            (removed.id, removed.quantity, removed.removed),
            (added.id, 0, true)
        );
        assert_eq!(count(&conn, "deck_cards"), 0);
    }

    /// A stepper pointed at a row that is not in that category any more is a stale editor,
    /// and the refusal names the category **by the name the user gave it** — an id says
    /// nothing to the person reading it.
    #[test]
    fn adjusting_a_row_that_is_not_in_that_category_names_the_category() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);

        let err = set_card_quantity(
            &conn,
            deck.id,
            "bolt-lea",
            kind_of(&conn, deck.id, "side"),
            LIVE,
            1,
        )
        .unwrap_err();

        assert!(err.contains("Sideboard"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was written");
    }

    #[test]
    fn moving_a_card_between_categories_folds_into_the_target_row() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-lea", side, 1);

        move_card(&conn, deck.id, "bolt-lea", main, side, LIVE).unwrap();

        assert_eq!(count(&conn, "deck_cards"), 1, "one row, not two");
        let (category, quantity): (i64, i64) = conn
            .query_row("SELECT category_id, quantity FROM deck_cards", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((category, quantity), (side, 5), "four into one");

        // An empty target category is a create, and the identity comes from the moved row
        // rather than from a fresh lookup — so the printing is dropped from `cards` first,
        // which is what the next sync does to a card Scryfall stopped publishing. The row
        // being tidied out of a deck is exactly the row most likely to be orphaned, and a
        // move that needed the id to resolve would refuse it.
        conn.execute("DELETE FROM cards", []).unwrap();

        move_card(&conn, deck.id, "bolt-lea", side, scratch, LIVE).unwrap();

        assert_eq!(count(&conn, "deck_cards"), 1);
        let (category, quantity, name, set): (i64, i64, String, String) = conn
            .query_row(
                "SELECT category_id, quantity, name, set_code FROM deck_cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (category, quantity, name.as_str(), set.as_str()),
            (scratch, 5, "Lightning Bolt", "lea"),
            "an orphaned row still moves, still counted and still sayable"
        );
    }

    /// A move re-files a card; it never promotes a plan into the deck. The two variants hold
    /// the same printing in the same category, and moving one leaves the other exactly where
    /// it was.
    #[test]
    fn a_move_stays_inside_its_own_variant() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 4);
        add_card(&conn, deck.id, "bolt-lea", Some(main), None, THEORY, 2).unwrap();

        move_card(&conn, deck.id, "bolt-lea", main, side, LIVE).unwrap();

        let rows: Vec<(String, i64, i64)> = conn
            .prepare("SELECT variant, category_id, quantity FROM deck_cards ORDER BY variant, id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![(LIVE.to_owned(), side, 4), (THEORY.to_owned(), main, 2)],
            "the live copies moved and the theory row did not follow them"
        );
    }

    /// The card rows of one deck, in a fixed order, as every swap assertion reads them.
    fn category_rows(conn: &Connection, deck_id: i64) -> Vec<(String, i64, i64)> {
        conn.prepare(
            "SELECT card_id, category_id, quantity FROM deck_cards
              WHERE deck_id = ?1 ORDER BY category_id, card_id",
        )
        .unwrap()
        .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// A clock a rollback can be seen against. `decks.updated_at` is whole seconds, so a
    /// touch inside the same second as the setup would be invisible — every "wrote nothing"
    /// assertion here pins it to a value no `unixepoch()` will ever produce twice.
    const UNMOVED: i64 = 1000;

    fn stop_the_clock(conn: &Connection, deck_id: i64) {
        conn.execute(
            "UPDATE decks SET updated_at = ?2 WHERE id = ?1",
            params![deck_id, UNMOVED],
        )
        .unwrap();
    }

    fn touched_at(conn: &Connection, deck_id: i64) -> i64 {
        read_deck(conn, deck_id).unwrap().unwrap().updated_at
    }

    /// The pane's "Use this printing": the copies move to the other printing's row, the row
    /// is denormalized from the printing swapped **to**, and the claims follow — a deck that
    /// now wants the M10 Bolt reserves the M10 Bolt.
    #[test]
    fn a_swap_moves_the_quantity_to_the_new_printing_row() {
        let conn = seeded();
        let lea = own(&conn, "bolt-lea", 3);
        let m10 = own(&conn, "bolt-m10", 3);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 3);
        assert_eq!(
            claims(&conn, deck.id),
            vec![(lea, 3)],
            "the allocator takes the exact printing first, so the claim is the Alpha row"
        );
        stop_the_clock(&conn, deck.id);

        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE).unwrap();

        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        // The other half of what every refusal below pins: a swap *is* an edit, so the deck
        // rises in a gallery that sorts by this column. Without this the whole file could
        // pass with `touch_deck` deleted.
        assert!(
            touched_at(&conn, deck.id) > UNMOVED,
            "a swap moves `updated_at`: the gallery resorts for it"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-m10".to_owned(), main, 3)],
            "one row: the old one is deleted, never left at zero"
        );
        let (set, cn, lang, name): (String, String, String, String) = conn
            .query_row(
                "SELECT set_code, collector_number, lang, name FROM deck_cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (set.as_str(), cn.as_str(), lang.as_str(), name.as_str()),
            ("m10", "146", "en", "Lightning Bolt"),
            "the printing and the name come from the `cards` row swapped TO"
        );
        assert_eq!(
            claims(&conn, deck.id),
            vec![(m10, 3)],
            "and the claims followed: the exact printing is a different copy now"
        );

        // Any category, an inactive one included — choosing a printing is exactly what a
        // scratchpad is for, and it still reserves nothing.
        add(&conn, deck.id, "serra-lea", scratch, 1);
        swap_printing(&conn, deck.id, "serra-lea", "serra-8ed", scratch, LIVE).unwrap();
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![
                ("serra-8ed".to_owned(), scratch, 1),
                ("bolt-m10".to_owned(), main, 3),
            ],
        );
        assert_eq!(
            claims(&conn, deck.id),
            vec![(m10, 3)],
            "a swap in an inactive category claims nothing, before or after"
        );
    }

    /// Two printings of one card in one category is one row, because the grain says so — the
    /// same fold [`add_card`] and [`move_card`] do, reported so the UI can say "folded".
    #[test]
    fn a_swap_onto_an_existing_row_folds_quantities_on_the_grain() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "bolt-lea", main, 3);
        add(&conn, deck.id, "bolt-m10", main, 2);
        // The same printing in another category: `category_id` is in the grain, so this row
        // is not in the swap's way and must not collect the copies.
        add(&conn, deck.id, "bolt-m10", side, 1);

        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE).unwrap();

        assert_eq!(
            (swapped.folded, swapped.quantity),
            (true, 5),
            "three into two, and the answer says it folded"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![
                ("bolt-m10".to_owned(), side, 1),
                ("bolt-m10".to_owned(), main, 5),
            ],
        );
    }

    /// Swapping a printing to itself is not an edit: the pane hides the action on the row the
    /// deck already uses, so reaching here is a double-click or a stale list.
    #[test]
    fn a_swap_refuses_the_same_printing_and_writes_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-lea", main, LIVE).unwrap_err();

        assert!(err.contains("already"), "{err}");
        assert_eq!(
            touched_at(&conn, deck.id),
            UNMOVED,
            "a no-op is not an edit — the gallery does not resort for it"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)]
        );
    }

    /// The [`card_gone`] asymmetry: a swap adjusts a row, and a row that is not in that
    /// category is a stale editor rather than an invitation to create one.
    #[test]
    fn a_swap_of_a_missing_row_says_which_category_it_looked_in() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(
            &conn,
            deck.id,
            "bolt-lea",
            "bolt-m10",
            kind_of(&conn, deck.id, "side"),
            LIVE,
        )
        .unwrap_err();

        assert!(err.contains("Sideboard"), "the refusal names it: {err}");
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the main-deck row is not what was asked about and is not touched"
        );
        assert_eq!(
            touched_at(&conn, deck.id),
            UNMOVED,
            "and the GONE gate's touch rolled back with the rest"
        );
    }

    /// The printing was clicked out of a *live* printings list, so its absence from `cards`
    /// means one thing: a sync swapped the table out from under the open pane.
    #[test]
    fn a_swap_to_a_printing_the_card_database_lost_blames_the_sync() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        conn.execute("DELETE FROM cards WHERE id = 'bolt-m10'", [])
            .unwrap();
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE).unwrap_err();

        assert!(err.contains("sync"), "{err}");
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the copies stay where they are rather than moving to an id that resolves to \
             nothing"
        );
        assert_eq!(touched_at(&conn, deck.id), UNMOVED);
    }

    /// A swap changes **which printing of a card** a deck plays. Nothing about the statements
    /// it runs would stop it changing *which card* — the quantity is carried across whatever
    /// it is pointed at — so a caller that paired the wrong two ids would turn three Bolts
    /// into three Serra Angels at the same count, silently and with no way back.
    #[test]
    fn a_swap_to_a_different_card_is_refused_and_writes_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(&conn, deck.id, "bolt-lea", "serra-lea", main, LIVE).unwrap_err();

        assert!(
            err.contains("Lightning Bolt") && err.contains("Serra Angel"),
            "the refusal names both cards, because which two were paired is the whole \
             question: {err}"
        );
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the copies stay on the card the reader put in the deck"
        );
        assert_eq!(touched_at(&conn, deck.id), UNMOVED);
    }

    /// The one row the guard must not fence in: a deck card whose printing has left `cards`.
    ///
    /// Its oracle id is unknowable — that is what an orphan *is* — so there is nothing to
    /// compare, and refusing on "cannot tell" would trap the copies on a dead printing that
    /// the reader is trying to escape. The target here is deliberately a **different** card:
    /// with a same-card target the test would pass just as well against a guard that never
    /// skipped, and would prove nothing.
    #[test]
    fn a_swap_off_an_orphaned_printing_is_allowed() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();

        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "serra-8ed", main, LIVE).unwrap();

        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("serra-8ed".to_owned(), main, 3)],
            "the copies left the dead printing for the one the reader chose"
        );
    }

    #[test]
    fn a_swap_on_a_deleted_deck_answers_gone() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        delete_deck(&conn, deck.id, None).unwrap();

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE).unwrap_err();

        assert_eq!(err, GONE, "the same sentence every other card write gives");
    }

    /// The insert, the delete and the reallocation are one write. Failure injected at the
    /// last of the three — the state in between is a deck holding the copies in *neither*
    /// row, and it is not a state anyone can read.
    #[test]
    fn a_swap_is_one_transaction() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 3);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 3);
        assert_eq!(claims(&conn, deck.id), vec![(entry, 3)]);
        stop_the_clock(&conn, deck.id);

        conn.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON deck_allocations
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE).unwrap_err();

        assert!(err.contains("boom"), "{err}");
        assert_eq!(
            category_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), main, 3)],
            "the row the copies came from is still there, and the row they went to is not"
        );
        assert_eq!(touched_at(&conn, deck.id), UNMOVED, "the touch rolled back");
        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 3)],
            "and the claims the rebuild deleted are back"
        );

        // Nothing was stranded: with the failure gone the same swap goes through.
        conn.execute_batch("DROP TRIGGER boom;").unwrap();
        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", main, LIVE).unwrap();
        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        assert_eq!(claims(&conn, deck.id), vec![(entry, 3)]);
    }

    /// A copy is a copy of the whole deck: its cards in **both** variants, its categories and
    /// its tags as **new rows**, and none of its state.
    ///
    /// The remap is the part that fails invisibly. `deck_cards.category_id` is an id, so a
    /// copy that carried the source's would file the copy's cards under the *original's*
    /// piles — and deleting the original would then take the copy's cards with it through
    /// `ON DELETE CASCADE`. Deleting the source at the end is what proves it did not.
    #[test]
    fn duplicate_copies_categories_tags_and_both_variants_but_not_allocations_or_built() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let scratch = kind_of(&conn, deck.id, "maybe");
        let tag = crate::deck_meta::create_tag(&conn, deck.id, "Flex", "amber").unwrap();
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-jp", scratch, 1);
        add_card(&conn, deck.id, "bolt-m10", Some(main), None, THEORY, 2).unwrap();
        crate::deck_meta::set_card_tag(&conn, deck.id, "bolt-lea", main, LIVE, Some(tag.id))
            .unwrap();
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                is_built: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        own_and_claim(&conn, deck.id);

        let copy = duplicate_deck(&conn, deck.id, None).unwrap();

        assert_ne!(copy.id, deck.id);
        assert_eq!(copy.name, "Burn (copy)");
        assert_eq!(copy.format_key, "modern");
        assert!(!copy.is_built, "a copy is a draft, never a built deck");
        assert_eq!(
            copy.card_count, 4,
            "live main-deck copies only — the Maybeboard is inactive and the theory row is \
             not the deck"
        );

        // Its categories and tags are its own rows, with its own ids, and every one of them
        // came across.
        let categories: Vec<(String, String, bool)> = conn
            .prepare(
                "SELECT name, kind, is_active FROM deck_categories WHERE deck_id = ?1
                  ORDER BY sort_order, id",
            )
            .unwrap()
            .query_map(params![copy.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            categories,
            vec![
                ("Commander".to_owned(), "commander".to_owned(), true),
                ("Sideboard".to_owned(), "side".to_owned(), true),
                ("Companion".to_owned(), "companion".to_owned(), true),
                ("Maybeboard".to_owned(), "maybe".to_owned(), false),
                ("Main deck".to_owned(), "main".to_owned(), true),
            ],
            "every category, in the order it was in, active flags and all"
        );
        let shared: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_categories a JOIN deck_categories b ON a.id = b.id
                  WHERE a.deck_id = ?1 AND b.deck_id = ?2",
                params![deck.id, copy.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(shared, 0, "not one category row is shared between the two");

        let cards: Vec<(String, String, String, Option<String>, i64)> = conn
            .prepare(
                "SELECT dc.card_id, dc.variant, cat.name, t.name, dc.quantity
                   FROM deck_cards dc
                   JOIN deck_categories cat ON cat.id = dc.category_id
                   LEFT JOIN deck_tags t ON t.id = dc.tag_id
                  WHERE dc.deck_id = ?1 ORDER BY dc.variant, dc.card_id",
            )
            .unwrap()
            .query_map(params![copy.id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            cards,
            vec![
                (
                    "bolt-jp".to_owned(),
                    LIVE.to_owned(),
                    "Maybeboard".to_owned(),
                    None,
                    1
                ),
                (
                    "bolt-lea".to_owned(),
                    LIVE.to_owned(),
                    "Main deck".to_owned(),
                    Some("Flex".to_owned()),
                    4
                ),
                (
                    "bolt-m10".to_owned(),
                    THEORY.to_owned(),
                    "Main deck".to_owned(),
                    None,
                    2
                ),
            ],
            "both variants, filed under the copy's own categories, tag remapped"
        );

        assert_eq!(
            count(&conn, "deck_allocations"),
            1,
            "a copy reserves nothing — the original's claims are the original's"
        );
        let copied_claims: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_allocations WHERE deck_id = ?1",
                params![copy.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(copied_claims, 0);

        // The remap, proven the only way it can be: deleting the source fires the CASCADE on
        // every category and tag it owns, and the copy is untouched by it.
        delete_deck(&conn, deck.id, None).unwrap();
        assert_eq!(
            count(&conn, "deck_cards"),
            3,
            "the copy's three rows survive the original's deletion"
        );
    }

    #[test]
    fn list_decks_counts_the_active_piles_in_the_deck_and_reads_the_cover_artist() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bolt Tribal", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 2);
        add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "commander"),
            1,
        );
        add(
            &conn,
            deck.id,
            "bolt-lea",
            kind_of(&conn, deck.id, "companion"),
            1,
        );
        add(
            &conn,
            deck.id,
            "bolt-lea",
            kind_of(&conn, deck.id, "side"),
            3,
        );
        add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "maybe"),
            7,
        );
        update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                cover_card_id: Some("bolt-lea".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        let old = create_deck(&conn, &input("Old Standard", "standard")).unwrap();
        update_deck(
            &conn,
            old.id,
            &DeckPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let decks = list_decks(&conn).unwrap();

        assert_eq!(
            decks.len(),
            2,
            "an archived deck is listed — the UI separates them"
        );
        assert_eq!(decks[0].id, deck.id, "archived decks sort last");
        assert!(decks[1].archived);
        // The gallery's number and the validation panel's are one definition — the engine's
        // `SIZE_KINDS`, which is `main`, `commander` **and `maybe`**. A companion is the
        // reason this is pinned: EDH calls one "effectively a 101st card", so counting it here
        // would put 101 on the tile of a deck the panel had just called exactly 100.
        //
        // The Maybeboard is out of the number below because it is seeded **inactive**, not
        // because of its kind — the switch decides whether a pile counts at all, and an
        // *active* Maybeboard counts like any other pile. This comment used to say "`main` +
        // `commander` and nothing else", which passes for the wrong reason.
        assert_eq!(
            decks[0].card_count, 3,
            "2 main + 1 commander; the companion, sideboard and Maybeboard are not the deck"
        );
        assert_eq!(decks[0].format_name.as_deref(), Some("Commander"));
        assert_eq!(decks[0].cover_artist.as_deref(), Some("Christopher Rush"));
        assert_eq!(decks[1].card_count, 0);
    }

    /// The gallery's caption is about the deck the user has, and two things are not it: a
    /// **theory** row, which is a plan, and a row in a category that has been switched
    /// **off**, which counts toward nothing at all. Neither is a kind check — a main-deck
    /// category the user deactivated stops counting exactly like the Maybeboard does.
    #[test]
    fn the_gallery_count_reads_only_live_rows_in_active_categories() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add_card(&conn, deck.id, "bolt-m10", Some(main), None, THEORY, 40).unwrap();

        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            4,
            "the theory list is a plan and is counted on no tile"
        );

        crate::deck_meta::set_category_active(&conn, main, false).unwrap();
        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            0,
            "and a `main` category switched off counts toward nothing, kind or no kind"
        );

        crate::deck_meta::set_category_active(&conn, main, true).unwrap();
        assert_eq!(read_deck(&conn, deck.id).unwrap().unwrap().card_count, 4);
    }

    /// **The switch decides whether a pile counts at all; the kind decides only whether it is
    /// played *beside* the deck or *in* it, and only `side` and `companion` are beside it.**
    ///
    /// So an active Maybeboard is part of the deck's size and an inactive one is not — the
    /// same sentence as every other category, which is the point. The alternative was measured
    /// and rejected: with `maybe` left out of the size list, an active Maybeboard was inside
    /// the format's card pool and inside the binder's reservations but outside the size, so a
    /// second Sol Ring in one raised a singleton error under a figure that still read 100.
    ///
    /// Paired with `SIZE_KINDS` in `engine.ts`, which is these three words and must stay them:
    /// [`DeckRow::card_count`] and the validation panel answer one question, and two answers to
    /// it is the bug this whole definition exists to prevent.
    #[test]
    fn an_active_maybeboard_is_part_of_the_deck_and_an_inactive_one_is_not() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let scratch = kind_of(&conn, deck.id, "maybe");
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-jp", scratch, 3);

        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            4,
            "the Maybeboard is seeded off, so it counts toward nothing — including the size"
        );

        crate::deck_meta::set_category_active(&conn, scratch, true).unwrap();

        assert_eq!(
            read_deck(&conn, deck.id).unwrap().unwrap().card_count,
            7,
            "switched on, it is a pile played *in* the deck like any other, so it sizes"
        );

        // And the two kinds that really are played beside the deck stay out either way —
        // CR 100.4a for the sideboard, and EDH's "effectively a 101st card" for the companion.
        add(
            &conn,
            deck.id,
            "serra-lea",
            kind_of(&conn, deck.id, "side"),
            15,
        );
        add(
            &conn,
            deck.id,
            "serra-8ed",
            kind_of(&conn, deck.id, "companion"),
            1,
        );
        assert_eq!(read_deck(&conn, deck.id).unwrap().unwrap().card_count, 7);
    }

    #[test]
    fn a_card_id_that_does_not_resolve_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let err = add_card(
            &conn,
            deck.id,
            "no-such-card",
            Some(main_of(&conn, deck.id)),
            None,
            LIVE,
            1,
        )
        .unwrap_err();

        assert!(err.contains("no-such-card"), "{err}");
        assert!(err.contains("card database"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 0);
    }

    /// `format_key` carries no foreign key on purpose — `format_specs` is re-seeded with
    /// `INSERT OR REPLACE` by every migration that corrects a cell — so the check lives
    /// here, in words, at the two moments a key can be chosen.
    #[test]
    fn a_deck_needs_a_name_and_a_format_the_specs_know() {
        let conn = seeded();

        let err = create_deck(&conn, &input("Burn", "kitchen-table")).unwrap_err();
        assert!(err.contains("kitchen-table"), "{err}");
        assert_eq!(count(&conn, "decks"), 0);

        let err = create_deck(&conn, &input("   ", "modern")).unwrap_err();
        assert!(err.contains("name"), "{err}");
        assert_eq!(count(&conn, "decks"), 0);

        // An omitted format is the table's own default, not a refusal.
        let deck = create_deck(
            &conn,
            &DeckInput {
                name: "Burn".to_owned(),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(deck.format_key, DEFAULT_FORMAT);

        let err = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                format_key: Some("kitchen-table".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("kitchen-table"), "{err}");

        let renamed = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                name: Some("Burn v2".to_owned()),
                format_key: Some("modern".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "Burn v2");
        assert_eq!(
            (renamed.format_key.as_str(), renamed.format_name.as_deref()),
            ("modern", Some("Modern"))
        );
    }

    /// A new deck is born with the four predefined categories, because a deck that exists but
    /// cannot be filed into anything is a state nothing downstream expects — the v8 migration
    /// only ever seeded these for decks that existed *at* the migration.
    #[test]
    fn a_new_deck_is_born_with_its_predefined_categories() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let rows: Vec<(String, String, bool)> = conn
            .prepare(
                "SELECT kind, name, is_active FROM deck_categories WHERE deck_id = ?1
                  ORDER BY sort_order, id",
            )
            .unwrap()
            .query_map(params![deck.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                ("commander".to_owned(), "Commander".to_owned(), true),
                ("side".to_owned(), "Sideboard".to_owned(), true),
                ("companion".to_owned(), "Companion".to_owned(), true),
                ("maybe".to_owned(), "Maybeboard".to_owned(), false),
            ],
            "`schema::PREDEFINED_CATEGORIES`, with the Maybeboard alone switched off — and no \
             `main` row, because a deck may own any number of those and predefines none"
        );
    }

    /// A deck delete is a real user deletion — the decks are the user's to destroy — and
    /// the CASCADEs take the cards, the claims, the categories and the tags with it. What it
    /// never touches is the collection: a deck names copies, it does not own them.
    #[test]
    fn deleting_a_deck_takes_its_cards_and_claims_and_deleting_it_twice_still_succeeds() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add(&conn, deck.id, "bolt-lea", main_of(&conn, deck.id), 4);
        crate::deck_meta::create_tag(&conn, deck.id, "Flex", "amber").unwrap();
        own_and_claim(&conn, deck.id);

        delete_deck(&conn, deck.id, None).unwrap();

        assert_eq!(count(&conn, "decks"), 0);
        assert_eq!(count(&conn, "deck_cards"), 0);
        assert_eq!(count(&conn, "deck_allocations"), 0);
        assert_eq!(count(&conn, "deck_categories"), 0);
        assert_eq!(count(&conn, "deck_tags"), 0);
        assert_eq!(
            count(&conn, "collection_entries"),
            1,
            "the copies are still owned"
        );

        delete_deck(&conn, deck.id, None).expect("a deck that is already gone is gone");
    }

    /// A scratch `covers/` directory and a valid WEBP to put in it. Written through the real
    /// encoder, so what the tests below move around is the shape the app actually stores.
    ///
    /// Named for **this process** as well as for the test. That is a precaution rather than a
    /// fix for anything measured: the directory is removed and recreated a moment later, and on
    /// Windows a pending-delete directory and a file a scanner has just opened both surface as
    /// `Access is denied`, so two `cargo test` processes sharing a fixed name would have a
    /// window in which one can fail the other. One red run of this suite was seen and never
    /// reproduced in twenty-four more; this removes a failure mode that could have caused it,
    /// and does not diagnose it.
    fn covers(name: &str) -> (std::path::PathBuf, Vec<u8>) {
        let dir =
            std::env::temp_dir().join(format!("mtgtest-deck-covers-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.png");
        image::RgbaImage::new(40, 30).save(&source).unwrap();
        let bytes = crate::images::encode_cover(&source).unwrap();
        (dir, bytes)
    }

    /// The cover file is only ever about one deck, so it goes when the deck does — nothing
    /// else will ever look at it, and a portable app's `data/` folder is the user's disk.
    #[test]
    fn deleting_a_deck_takes_its_cover_file() {
        let conn = seeded();
        let (dir, bytes) = covers("delete");
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        set_cover_image(&conn, &dir, deck.id, &bytes).unwrap();
        let file = crate::images::cover_file(&dir, deck.id);
        assert!(file.is_file(), "the fixture must have written a cover");
        assert_eq!(std::fs::read(&file).unwrap(), bytes);

        delete_deck(&conn, deck.id, Some(&dir)).unwrap();

        let gone = !file.exists();
        // And a deck with no cover file is deleted without complaint: `remove_cover` reads a
        // missing file as a success, because a deck the user deleted is deleted whatever the
        // disk says about a picture of it.
        let second = create_deck(&conn, &input("Other", "modern")).unwrap();
        let no_cover = delete_deck(&conn, second.id, Some(&dir));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(gone, "the cover file must go with the deck");
        assert!(no_cover.is_ok());
    }

    /// Setting a custom cover is one write: the file lands, `cover_kind` says which of the two
    /// covers is showing, and `cover_image_path` records what was written.
    ///
    /// **Picking a card afterwards leaves the file alone**, which is the half that makes the
    /// pair usable: a user who tries a card art and changes their mind still has the picture
    /// they chose, and switching back is one column.
    #[test]
    fn a_custom_cover_and_a_card_cover_take_turns_without_losing_either() {
        let conn = seeded();
        let (dir, bytes) = covers("switch");
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let row = set_cover_image(&conn, &dir, deck.id, &bytes).unwrap();
        assert_eq!(row.cover_kind, COVER_CUSTOM);
        let stored: Option<String> = conn
            .query_row(
                "SELECT cover_image_path FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            stored.as_deref(),
            crate::images::cover_file(&dir, deck.id).to_str()
        );

        let back = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                cover_card_id: Some("bolt-lea".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let file_kept = crate::images::cover_file(&dir, deck.id).is_file();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(back.cover_kind, COVER_CARD_ART, "the card is showing now");
        assert_eq!(back.cover_card_id.as_deref(), Some("bolt-lea"));
        assert!(file_kept, "and the picture the user chose is still there");
    }

    /// A cover for a deck that is not there writes **no file**: the existence check runs before
    /// the write, so a stale gallery cannot leave a `<id>.webp` behind for a deck id that will
    /// one day belong to somebody else's deck.
    #[test]
    fn a_cover_for_a_deck_that_is_gone_writes_nothing() {
        let conn = seeded();
        let (dir, bytes) = covers("gone");

        let refused = set_cover_image(&conn, &dir, 404, &bytes).unwrap_err();

        let written = crate::images::cover_file(&dir, 404).exists();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(refused, GONE);
        assert!(!written);
    }

    /// A duplicate of a custom-cover deck gets **its own file**, not a path to the original's.
    ///
    /// The columns come across in the `INSERT … SELECT` like everything else, which on its own
    /// leaves the copy claiming `custom` over a file that is not there — the route 404s and the
    /// tile is blank — and pointing at a path that dies with the original.
    #[test]
    fn duplicating_a_deck_gives_the_copy_its_own_cover_file() {
        let conn = seeded();
        let (dir, bytes) = covers("duplicate");
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        set_cover_image(&conn, &dir, deck.id, &bytes).unwrap();

        let copy = duplicate_deck(&conn, deck.id, Some(&dir)).unwrap();

        let file = crate::images::cover_file(&dir, copy.id);
        let landed = std::fs::read(&file).ok();
        let stored: Option<String> = conn
            .query_row(
                "SELECT cover_image_path FROM decks WHERE id = ?1",
                params![copy.id],
                |r| r.get(0),
            )
            .unwrap();
        let original_kept = crate::images::cover_file(&dir, deck.id).is_file();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(copy.cover_kind, COVER_CUSTOM);
        assert_eq!(landed.as_deref(), Some(bytes.as_slice()));
        assert_eq!(
            stored.as_deref(),
            file.to_str(),
            "and the row points at the copy's own file, not the original's"
        );
        assert!(original_kept, "the original is untouched");
    }

    /// When the bytes cannot be copied the claim is given up rather than kept: a deck showing
    /// its card art is a deck that looks right, and one claiming `custom` over nothing is a
    /// blank tile. Best-effort in both directions — the duplicate itself never fails over a
    /// picture.
    #[test]
    fn a_duplicate_falls_back_to_card_art_when_the_cover_cannot_be_copied() {
        let conn = seeded();
        let (dir, bytes) = covers("duplicate-fallback");
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        set_cover_image(&conn, &dir, deck.id, &bytes).unwrap();
        // The file goes, the columns stay — which is exactly the state a hand-deleted
        // `data/covers` leaves behind, and `covers/` is documented as safe to delete.
        std::fs::remove_file(crate::images::cover_file(&dir, deck.id)).unwrap();

        let copy = duplicate_deck(&conn, deck.id, Some(&dir)).unwrap();
        // And with no covers directory at all, which is what an unwritable data folder gives.
        let no_dir = duplicate_deck(&conn, deck.id, None).unwrap();

        let stored: Option<String> = conn
            .query_row(
                "SELECT cover_image_path FROM decks WHERE id = ?1",
                params![copy.id],
                |r| r.get(0),
            )
            .unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(copy.cover_kind, COVER_CARD_ART);
        assert_eq!(no_dir.cover_kind, COVER_CARD_ART);
        assert_eq!(stored, None, "and no path to a file that is not there");
    }

    /// The one thing a [`DeckPatch`] cannot say: **put this deck back at the root**. `None` is
    /// root here because there is nothing else it could be — the whole reason this is a command
    /// rather than a patch field.
    #[test]
    fn a_deck_can_be_filed_and_unfiled() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let commander = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;

        let filed = set_folder(&conn, deck.id, Some(commander)).unwrap();
        assert_eq!(filed.folder_id, Some(commander));

        // The patch route can move it between folders but never out of one: `coalesce` reads a
        // bound NULL as "leave it", which is what this command exists to work around.
        let still_filed = update_deck(&conn, deck.id, &DeckPatch::default()).unwrap();
        assert_eq!(still_filed.folder_id, Some(commander));

        let unfiled = set_folder(&conn, deck.id, None).unwrap();
        assert_eq!(unfiled.folder_id, None, "back at the root of the tree");

        // Both moves are in the history, and the root one says so with a null rather than an
        // empty string — "filed nowhere" and "filed under a folder called nothing" are
        // different, and only one of them is a state the app can produce.
        let history = crate::deck_audit::list(&conn, deck.id, 10).unwrap();
        let folders: Vec<serde_json::Value> = history
            .iter()
            .filter(|r| r.kind == crate::deck_audit::FOLDER)
            .map(|r| serde_json::from_str(&r.payload).unwrap())
            .collect();
        assert_eq!(
            folders,
            vec![
                json!({ "action": "move", "folder": null }),
                json!({ "action": "move", "folder": "Commander" }),
            ]
        );
    }

    /// A stale folder id is refused in words, not left to a foreign key that may not even be
    /// enforced on this connection — and a deck that is not there is [`GONE`], as everywhere.
    #[test]
    fn filing_a_deck_somewhere_that_is_not_there_is_refused_by_name() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        assert_eq!(
            set_folder(&conn, deck.id, Some(404)).unwrap_err(),
            crate::deck_meta::FOLDER_GONE
        );
        assert_eq!(set_folder(&conn, 404, None).unwrap_err(), GONE);
        // A refused filing wrote nothing, history included.
        let filed: Option<i64> = conn
            .query_row(
                "SELECT folder_id FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(filed, None);
    }

    /// Re-filing a deck where it already is changed nothing, so it records nothing —
    /// [`update_deck`]'s rule, and the reason a settings dialog that saves an untouched form
    /// does not fill the drawer with moves nobody made.
    #[test]
    fn filing_a_deck_where_it_already_is_records_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let folder = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;
        set_folder(&conn, deck.id, Some(folder)).unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        set_folder(&conn, deck.id, Some(folder)).unwrap();

        assert_eq!(count(&conn, "deck_audit"), 0);
    }

    /// The two words `decks.cover_kind`'s CHECK allows, walked against the live column — the
    /// discipline `schema::CATEGORY_KINDS` gets, for the same reason: a typo in either constant
    /// is otherwise a `CHECK constraint failed` on the one write nobody exercises by hand.
    #[test]
    fn the_cover_kinds_are_the_ones_the_column_allows() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        for kind in [COVER_CARD_ART, COVER_CUSTOM] {
            conn.execute(
                "UPDATE decks SET cover_kind = ?2 WHERE id = ?1",
                params![deck.id, kind],
            )
            .unwrap_or_else(|e| panic!("`{kind}` must be a cover kind, but: {e}"));
        }
        assert!(
            conn.execute(
                "UPDATE decks SET cover_kind = 'gradient' WHERE id = ?1",
                params![deck.id],
            )
            .is_err(),
            "and nothing else is"
        );
    }

    /// The gallery sorts by `decks.updated_at`, so a deck that was edited has to rise —
    /// and the same statement is what tells a card write that the deck it names exists.
    #[test]
    fn every_card_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        // `unixepoch()` has one-second resolution, so the clock is moved back rather than
        // waited on.
        let backdate = |conn: &Connection| {
            conn.execute(
                "UPDATE decks SET updated_at = 0 WHERE id = ?1",
                params![deck.id],
            )
            .unwrap();
        };
        let updated_at = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![deck.id],
                |r| r.get(0),
            )
            .unwrap()
        };

        backdate(&conn);
        add(&conn, deck.id, "bolt-lea", main, 4);
        assert!(updated_at(&conn) > 0, "the add moved the deck");

        backdate(&conn);
        set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, 2).unwrap();
        assert!(updated_at(&conn) > 0, "so does the stepper");

        backdate(&conn);
        move_card(&conn, deck.id, "bolt-lea", main, side, LIVE).unwrap();
        assert!(updated_at(&conn) > 0, "and so does the move");

        // The same statement is the existence check: a stale deck id from a gallery that
        // has not refreshed is a sentence, never a foreign-key error.
        let err =
            add_card(&conn, deck.id + 999, "bolt-lea", Some(main), None, LIVE, 1).unwrap_err();
        assert_eq!(err, GONE);
        assert_eq!(count(&conn, "deck_cards"), 1, "and nothing was written");
    }

    #[test]
    fn deck_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(DeckRow {
            id: 3,
            name: "Burn".to_owned(),
            format_key: "modern".to_owned(),
            format_name: Some("Modern".to_owned()),
            description: None,
            cover_card_id: Some("bolt-lea".to_owned()),
            cover_kind: "card_art".to_owned(),
            cover_artist: Some("Christopher Rush".to_owned()),
            is_built: true,
            archived: false,
            card_count: 60,
            updated_at: 1_800_000_000,
            folder_id: Some(7),
            notes: None,
            theory_enabled: true,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "name": "Burn", "formatKey": "modern", "formatName": "Modern",
                "description": null, "coverCardId": "bolt-lea",
                "coverKind": "card_art",
                "coverArtist": "Christopher Rush", "isBuilt": true, "archived": false,
                "cardCount": 60, "updatedAt": 1800000000,
                "folderId": 7, "notes": null, "theoryEnabled": true
            })
        );

        // And the two payloads the frontend sends: `#[serde(default)]` throughout, so a
        // dialog sends the fields it has and a patch sends only what it changed.
        let input: DeckInput = serde_json::from_str(r#"{"name":"Burn","formatKey":"modern"}"#)
            .expect("the create payload");
        assert_eq!(
            (input.name.as_str(), input.format_key.as_str()),
            ("Burn", "modern")
        );
        assert!(input.description.is_none());

        let patch: DeckPatch = serde_json::from_str(r#"{"coverCardId":"bolt-lea","isBuilt":true}"#)
            .expect("the patch payload");
        assert_eq!(patch.cover_card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(patch.is_built, Some(true));
        assert!(patch.name.is_none(), "an omitted field means leave it");
    }

    /// The allocator's whole contract in one scene: 4 Bolts wanted, 3 owned across two
    /// entries (2 lea + 1 m10 — a DIFFERENT printing of the same oracle card), nothing else
    /// claiming them → allocations total 3, the deck reads owned 3 of 4, and the collection
    /// rows still say 2 and 1: availability is computed, never decremented (spec §6,
    /// Deckbox semantics).
    #[test]
    fn the_allocator_reserves_owned_copies_across_printings_without_touching_the_collection() {
        let conn = seeded();
        let lea = own(&conn, "bolt-lea", 2);
        let m10 = own(&conn, "bolt-m10", 1);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);

        add(&conn, deck.id, "bolt-lea", main, 4);

        assert_eq!(
            claims(&conn, deck.id),
            vec![(lea, 2), (m10, 1)],
            "a different printing of the same oracle card is the same card"
        );
        let detail = get_deck(&conn, deck.id, LIVE).unwrap().unwrap();
        let row = card_row(&detail, "bolt-lea", main);
        assert_eq!((row.quantity, row.owned_quantity), (4, 3), "3 of 4");

        let held: Vec<(i64, i64)> = conn
            .prepare("SELECT id, quantity FROM collection_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            held,
            vec![(lea, 2), (m10, 1)],
            "the binder still holds what it held — a deck names copies, it never takes them"
        );
    }

    /// Exact printing first: the deck runs the lea Bolt, so the lea entries are drained
    /// before the m10 entry is touched — and within them the real copies before the proxies,
    /// which is why the proxy row is the *older* entry here. Deterministic, so a re-run
    /// allocates identically (delete + rebuild inside one transaction).
    #[test]
    fn the_allocator_prefers_the_exact_printing_then_other_printings() {
        let conn = seeded();
        // Lowest id first: entry order alone would drain the proxies before the real cards.
        let proxy = own_proxy(&conn, "bolt-lea", 4);
        let real = own(&conn, "bolt-lea", 2);
        let other = own(&conn, "bolt-m10", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        add(&conn, deck.id, "bolt-lea", main_of(&conn, deck.id), 5);

        assert_eq!(
            claims(&conn, deck.id),
            vec![(proxy, 3), (real, 2)],
            "both real lea copies, then three proxies, and the m10 entry untouched"
        );
        assert!(
            !claims(&conn, deck.id).iter().any(|(e, _)| *e == other),
            "another printing is the last resort, not the first"
        );

        allocate_deck(&conn, deck.id).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![(proxy, 3), (real, 2)],
            "delete-and-rebuild lands on exactly the same rows"
        );
    }

    /// `is_built` is what makes a claim RESERVE: two decks want the same 4 copies; deck A
    /// (built) claims them; deck B's allocator finds availability 0 and B reads owned 0 of 4.
    /// Unbuild A, reallocate B → B reads 4. A deck's own claims never block itself.
    #[test]
    fn built_decks_reserve_availability_and_unbuilt_decks_do_not() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 4);
        let a = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let a_main = main_of(&conn, a.id);
        add(&conn, a.id, "bolt-lea", a_main, 4);
        update_deck(
            &conn,
            a.id,
            &DeckPatch {
                is_built: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(claims(&conn, a.id), vec![(entry, 4)], "sleeved up");

        let b = create_deck(&conn, &input("Burn II", "modern")).unwrap();
        let b_main = main_of(&conn, b.id);
        add(&conn, b.id, "bolt-lea", b_main, 4);

        assert_eq!(claims(&conn, b.id), vec![], "those copies are on a table");
        assert_eq!(owned_of(&conn, b.id, "bolt-lea", b_main), 0);
        assert_eq!(
            owned_of(&conn, a.id, "bolt-lea", a_main),
            4,
            "a deck is never blocked by its own claims"
        );

        update_deck(
            &conn,
            a.id,
            &DeckPatch {
                is_built: Some(false),
                ..Default::default()
            },
        )
        .unwrap();
        allocate_deck(&conn, b.id).unwrap();

        assert_eq!(owned_of(&conn, b.id, "bolt-lea", b_main), 4);
        assert_eq!(
            owned_of(&conn, a.id, "bolt-lea", a_main),
            4,
            "two drafts may both plan on one playset — only a built deck reserves it"
        );
    }

    /// **Rule 1, and the whole of what the `maybe` zone used to be.** `is_active` is the only
    /// thing the allocator asks: a category of the user's own that they switch off stops
    /// claiming copies, and a Maybeboard they switch **on** starts. Nothing anywhere reads
    /// the word `maybe` to decide it.
    ///
    /// The two halves matter equally. The first is the bug a leftover `zone <> 'maybe'` would
    /// hide — it would look correct until the day a user deactivated a category of their own.
    /// The second is the bug the *fix* could introduce: excluding the `maybe` **kind** as
    /// well as inactive categories would be a special case nobody could switch off.
    #[test]
    fn the_allocator_skips_an_inactive_category_and_not_a_named_one() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let mine = crate::deck_meta::create_category(&conn, deck.id, "Flex slots").unwrap();
        let scratch = kind_of(&conn, deck.id, "maybe");

        add(&conn, deck.id, "bolt-lea", mine.id, 2);
        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 2)],
            "a category the user made is active, so it claims"
        );

        crate::deck_meta::set_category_active(&conn, mine.id, false).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![],
            "switched off, it claims nothing — and no kind check could have known that"
        );
        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", mine.id), 0);

        // The other direction: the Maybeboard is only special because it is seeded off.
        crate::deck_meta::set_category_active(&conn, scratch, true).unwrap();
        add(&conn, deck.id, "bolt-m10", scratch, 1);
        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 1)],
            "a Maybeboard the user switched ON claims like any other category"
        );
    }

    /// **Rule 2.** A theory list is a plan, and a plan claims nothing: the copies stay
    /// available to every other deck until the change is made for real.
    #[test]
    fn the_allocator_claims_nothing_for_the_theory_variant() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);

        add_card(&conn, deck.id, "bolt-lea", Some(main), None, THEORY, 4).unwrap();

        assert_eq!(claims(&conn, deck.id), vec![], "a plan reserves nothing");
        let theory = get_deck(&conn, deck.id, THEORY).unwrap().unwrap();
        assert_eq!(
            card_row(&theory, "bolt-lea", main).owned_quantity,
            0,
            "and it says so rather than borrowing the live deck's answer"
        );

        // The same printing, the same category, in the live deck: that one claims — and the
        // theory row beside it *still* reads 0. This is the half a naive read gets wrong:
        // `deck_allocations` carries no variant, so a theory read walks the live deck's stored
        // claims and would hand the plan the four copies the sleeved deck reserved.
        add(&conn, deck.id, "bolt-lea", main, 4);
        assert_eq!(claims(&conn, deck.id), vec![(entry, 4)]);
        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", main), 4);
        let theory = get_deck(&conn, deck.id, THEORY).unwrap().unwrap();
        assert_eq!(
            card_row(&theory, "bolt-lea", main).owned_quantity,
            0,
            "a plan reserves nothing even when the deck it is a plan for reserves everything"
        );
    }

    /// The read clamps: the allocation says 4, the entry has since been stepped to 1 →
    /// `owned_quantity` reads 1, not 4. A claim on copies that left the binder is not
    /// ownership.
    #[test]
    fn owned_quantity_clamps_to_what_the_entry_still_holds() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        assert_eq!(claims(&conn, deck.id), vec![(entry, 4)]);

        crate::collection::set_quantity(&conn, entry, 1).unwrap();

        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 4)],
            "a collection edit does not walk every deck…"
        );
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", main),
            1,
            "…so the read is what has to tell the truth about a shrunken binder"
        );

        // The collection keeps a row it has been emptied to zero — the condition, the price
        // and the acquisition story survive the day the copies are traded away — and an
        // entry holding none of the card must reserve none of it. A claim of zero is not
        // just wrong, it is `CHECK (quantity > 0)`: the allocator writes no row at all.
        crate::collection::set_quantity(&conn, entry, 0).unwrap();
        set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, 4).unwrap();

        assert_eq!(
            claims(&conn, deck.id),
            vec![],
            "a zero-keeps row claims nothing"
        );
        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", main), 0);
        assert_eq!(
            count(&conn, "collection_entries"),
            1,
            "and the row itself is still there, as it always is"
        );
    }

    /// TRAP B and TRAP C ride the read: two printings of one card with different `oldschool`
    /// legalities come back with their own blobs; a rare printing whose oracle card was ever
    /// printed at uncommon reads `ever_uncommon = true`.
    #[test]
    fn the_read_returns_per_printing_legalities_and_ever_uncommon() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Angels", "oldschool")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        add(&conn, deck.id, "serra-lea", main, 1);
        add(&conn, deck.id, "serra-8ed", side, 1);
        add(&conn, deck.id, "bolt-lea", main, 4);

        let detail = get_deck(&conn, deck.id, LIVE).unwrap().unwrap();
        let alpha = card_row(&detail, "serra-lea", main);
        let eighth = card_row(&detail, "serra-8ed", side);

        assert!(
            alpha.legalities.as_deref().unwrap().contains("\"legal\""),
            "{:?}",
            alpha.legalities
        );
        assert!(
            eighth
                .legalities
                .as_deref()
                .unwrap()
                .contains("\"oldschool\":\"not_legal\""),
            "the printing's own blob, which is the whole of Old School: {:?}",
            eighth.legalities
        );
        assert_eq!(
            (alpha.rarity.as_deref(), eighth.rarity.as_deref()),
            (Some("uncommon"), Some("rare"))
        );
        assert!(
            alpha.ever_uncommon && eighth.ever_uncommon,
            "a RARE printing of a card that was uncommon somewhere is a PDH commander — \
             eligibility is computed over the oracle card, never read off this printing"
        );
        assert!(
            !card_row(&detail, "bolt-lea", main).ever_uncommon,
            "and a card that never was uncommon is not"
        );

        // The facts the engine reads beside them, from this printing's row.
        assert_eq!(
            (
                alpha.cmc,
                alpha.color_identity.as_deref(),
                alpha.type_line.as_deref(),
                alpha.power.as_deref(),
                alpha.unit_price_usd
            ),
            (
                Some(5.0),
                Some("W"),
                Some("Creature — Angel"),
                Some("4"),
                Some(120.0)
            )
        );
        assert_eq!(
            card_row(&detail, "bolt-lea", main).unit_price_usd,
            Some(400.0),
            "nonfoil `usd` out of the blob, never `price_usd`"
        );
    }

    /// **Rules 4 and 6.** One read answers with one variant's cards and **every** category and
    /// tag the deck owns — an empty category still draws its column, an inactive one always
    /// draws, and a tag nobody is wearing is still in the palette. The cards come back in
    /// category `sort_order`, then the row's own name, then row id.
    #[test]
    fn the_read_scopes_cards_by_variant_and_answers_with_every_category_and_tag() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        let scratch = kind_of(&conn, deck.id, "maybe");
        let tag = crate::deck_meta::create_tag(&conn, deck.id, "Flex", "amber").unwrap();
        crate::deck_meta::create_tag(&conn, deck.id, "Unworn", "slate").unwrap();
        // Written so the reading order is neither the insert order nor the category order a
        // reader would guess: the Sideboard and the Maybeboard both sort *before* the main
        // pile, because they were seeded with the deck and the main pile was made by the
        // first add. Inside it the Bolt sorts before the Angel on the row's own name, which
        // is the reverse of the order they were written in.
        add(&conn, deck.id, "serra-lea", main, 1);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "bolt-m10", side, 2);
        add(&conn, deck.id, "bolt-jp", scratch, 3);
        add_card(&conn, deck.id, "serra-8ed", Some(main), None, THEORY, 7).unwrap();
        crate::deck_meta::set_card_tag(&conn, deck.id, "bolt-lea", main, LIVE, Some(tag.id))
            .unwrap();
        crate::deck_meta::set_card_tag(&conn, deck.id, "serra-8ed", main, THEORY, Some(tag.id))
            .unwrap();

        let live = get_deck(&conn, deck.id, LIVE).unwrap().unwrap();

        assert_eq!(
            live.cards
                .iter()
                .map(|c| (c.card_id.as_str(), c.category_name.as_str(), c.quantity))
                .collect::<Vec<_>>(),
            vec![
                ("bolt-m10", "Sideboard", 2),
                ("bolt-jp", "Maybeboard", 3),
                ("bolt-lea", "Main deck", 4),
                ("serra-lea", "Main deck", 1),
            ],
            "category `sort_order` first, then the name the row carries"
        );
        assert!(
            live.cards.iter().all(|c| c.variant == LIVE),
            "one variant's cards, and only that one's"
        );
        let bolt = card_row(&live, "bolt-lea", main);
        assert_eq!(
            (
                bolt.category_kind.as_str(),
                bolt.category_active,
                bolt.tag_name.as_deref(),
                bolt.tag_color.as_deref()
            ),
            ("main", true, Some("Flex"), Some("amber")),
            "the kind the rules read, the flag that decides whether they read it at all, and \
             the label the row is wearing"
        );
        assert!(
            !card_row(&live, "bolt-jp", scratch).category_active,
            "the Maybeboard is seeded off, which is the whole of what makes it a scratchpad"
        );
        assert!(card_row(&live, "bolt-m10", side).tag_id.is_none());

        assert_eq!(
            live.categories
                .iter()
                .map(|c| (c.name.as_str(), c.card_count))
                .collect::<Vec<_>>(),
            vec![
                ("Commander", 0),
                ("Sideboard", 2),
                ("Companion", 0),
                ("Maybeboard", 3),
                ("Main deck", 5),
            ],
            "every category in `sort_order`, empty ones included — that is where the next \
             card goes"
        );
        assert_eq!(
            live.tags
                .iter()
                .map(|t| (t.name.as_str(), t.card_count))
                .collect::<Vec<_>>(),
            vec![("Flex", 4), ("Unworn", 0)],
            "and every tag, worn or not — `card_count` being copies rather than rows, which \
             is why the tag on one four-of reads 4"
        );

        let theory = get_deck(&conn, deck.id, THEORY).unwrap().unwrap();
        assert_eq!(
            theory
                .cards
                .iter()
                .map(|c| (c.card_id.as_str(), c.quantity))
                .collect::<Vec<_>>(),
            vec![("serra-8ed", 7)],
            "the other list is its own list"
        );
        assert_eq!(
            theory.categories.len(),
            live.categories.len(),
            "and it draws exactly the same columns"
        );
        assert_eq!(
            theory
                .categories
                .iter()
                .find(|c| c.id == main)
                .unwrap()
                .card_count,
            7,
            "with the counts of the variant that was asked for"
        );
        // **And the tags are counted over that same variant**, which they briefly were not:
        // `get_deck` threaded its variant into the category list and not into the tag list, so
        // a Theory read came back with Theory category counts beside Live tag counts. Live has
        // 4 tagged copies and Theory has 7, so a leak reads 4 here — a number belonging to a
        // list this answer is not about.
        assert_eq!(
            theory
                .tags
                .iter()
                .map(|t| (t.name.as_str(), t.card_count))
                .collect::<Vec<_>>(),
            vec![("Flex", 7), ("Unworn", 0)],
            "one read, one list of cards, one variant — on all three of its parts"
        );
    }

    /// An orphaned deck card is still a row: name/set/cn from the entry, card facts NULL,
    /// owned 0 — listed, never dropped (the LEFT JOIN discipline).
    #[test]
    fn an_orphaned_deck_card_is_listed_from_its_denormalized_columns() {
        let conn = seeded();
        own(&conn, "bolt-jp", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add(&conn, deck.id, "bolt-jp", main_of(&conn, deck.id), 4);
        // What the next sync does to a printing Scryfall stopped publishing.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-jp'", [])
            .unwrap();

        let detail = get_deck(&conn, deck.id, LIVE).unwrap().unwrap();

        assert_eq!(detail.cards.len(), 1, "listed, never dropped");
        let row = &detail.cards[0];
        assert_eq!(
            (
                row.name.as_str(),
                row.set_code.as_str(),
                row.collector_number.as_str(),
                row.lang.as_str(),
                row.quantity
            ),
            ("Lightning Bolt", "4ed", "209", "ja", 4),
            "everything the row was written with, and it was written with it for this day"
        );
        assert_eq!(
            row.category_name.as_str(),
            "Main deck",
            "its category is a row of its own and has not gone anywhere"
        );
        assert!(row.oracle_id.is_none());
        assert!(row.legalities.is_none());
        assert!(row.type_line.is_none());
        assert!(row.unit_price_usd.is_none());
        assert!(
            !row.ever_uncommon,
            "nothing is known, so nothing is claimed"
        );
        assert_eq!(
            row.owned_quantity, 0,
            "an oracle card nobody can name is an oracle card nobody can count copies of"
        );
    }

    /// NULL power **and** NULL toughness is UNKNOWN, never "no P/T box" — and the difference
    /// is the whole of CR 903.3 (2026): a legendary Vehicle *with* a P/T box can be a
    /// commander and one without cannot. Only 1 510 of 116 590 rows have the columns filled
    /// until the user's next real sync, so the read recovers them from `raw` — which is a
    /// **gzip BLOB**, where `json_extract` is a hard error and only Rust can look.
    #[test]
    fn an_unknown_power_and_toughness_is_recovered_from_the_raw_blob() {
        let conn = seeded();
        let ship = r#"{"object":"card","name":"Skysovereign, Consul Flagship","power":"6","toughness":"5"}"#;
        let delver = r#"{"object":"card","name":"Delver of Secrets","card_faces":[{"name":"Delver of Secrets","power":"1","toughness":"1"},{"name":"Insectile Aberration","power":"3","toughness":"2"}]}"#;
        // A land whose blob *lies*: no land has a P/T, so these keys can only be reached by
        // a lookup — which is exactly what the type gate must not make. If the gate ever
        // goes, this row starts reading 9/9 and says so.
        let island = r#"{"object":"card","name":"Island","power":"9","toughness":"9"}"#;
        // No type line at all: unknown, so it is looked at — the conservative direction.
        let nameless = r#"{"object":"card","name":"Mystery","power":"2","toughness":"3"}"#;
        for (id, oracle, name, set, cn, type_line, raw) in [
            (
                "ship",
                "o3",
                "Skysovereign, Consul Flagship",
                "kld",
                "234",
                Some("Legendary Artifact — Vehicle"),
                ship,
            ),
            (
                "delver",
                "o4",
                "Delver of Secrets // Insectile Aberration",
                "isd",
                "51",
                Some("Creature — Human Wizard"),
                delver,
            ),
            (
                "island",
                "o5",
                "Island",
                "isd",
                "255",
                Some("Basic Land — Island"),
                island,
            ),
            ("mystery", "o6", "Mystery", "ust", "1", None, nameless),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,raw)
                 VALUES (?1,?2,?3,?4,?5,'en','normal','rare',?6,?7)",
                params![
                    id,
                    oracle,
                    name,
                    set,
                    cn,
                    type_line,
                    crate::card_row::gzip_raw(raw)
                ],
            )
            .unwrap();
        }
        let deck = create_deck(&conn, &input("Vehicles", "commander")).unwrap();
        let main = main_of(&conn, deck.id);
        let commander = kind_of(&conn, deck.id, "commander");
        add(&conn, deck.id, "ship", commander, 1);
        add(&conn, deck.id, "delver", main, 4);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "island", main, 20);
        add(&conn, deck.id, "mystery", main, 1);

        let stored: Option<String> = conn
            .query_row("SELECT power FROM cards WHERE id = 'ship'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            stored.is_none(),
            "the column is empty until the next sync — that is the case under test"
        );

        let detail = get_deck(&conn, deck.id, LIVE).unwrap().unwrap();

        let ship = card_row(&detail, "ship", commander);
        assert_eq!(
            (ship.power.as_deref(), ship.toughness.as_deref()),
            (Some("6"), Some("5")),
            "a Vehicle WITH a P/T box can be a commander; unknown must never read as `no box`"
        );
        let delver = card_row(&detail, "delver", main);
        assert_eq!(
            (delver.power.as_deref(), delver.toughness.as_deref()),
            (Some("1"), Some("1")),
            "the front face's, like every other per-face fallback in this app"
        );
        let bolt = card_row(&detail, "bolt-lea", main);
        assert!(
            bolt.power.is_none() && bolt.toughness.is_none(),
            "and an Instant really has no P/T box — recovery is not invention"
        );

        // The gate, in the only way it can be observed: a land whose blob carries a P/T is
        // read as having none, because the blob is never opened. On a fully synced database
        // this is most of every deck — every land, instant, sorcery, enchantment and
        // ordinary artifact has both columns NULL *correctly*, and an ungated recovery would
        // inflate a 2 KB blob for each of them on every read, for ever, and find nothing.
        let island = card_row(&detail, "island", main);
        assert!(
            island.power.is_none() && island.toughness.is_none(),
            "a Land's blob is never opened — no type that prints a P/T box, no lookup"
        );
        // …and an unknown type line is still looked at, because unknown is not `no`.
        let mystery = card_row(&detail, "mystery", main);
        assert_eq!(
            (mystery.power.as_deref(), mystery.toughness.as_deref()),
            (Some("2"), Some("3"))
        );
    }

    /// The gate itself, over the type lines that decide it. `Vehicle` and `Spacecraft` are
    /// on the list for CR 903.3's reason, and the combined type line of a transform card is
    /// why a back-face creature needs no special case.
    #[test]
    fn only_a_type_line_that_could_print_a_power_toughness_box_is_worth_a_lookup() {
        for worth in [
            "Creature — Human Wizard",
            "Legendary Artifact — Vehicle",
            "Artifact — Spacecraft",
            "Land Creature — Forest Dryad",
            "Land // Legendary Creature — Demon",
        ] {
            assert!(may_have_a_power_toughness_box(Some(worth)), "{worth}");
        }
        for not in [
            "Instant",
            "Sorcery",
            "Basic Land — Island",
            "Enchantment — Aura",
            "Legendary Planeswalker — Jace",
            "Artifact — Equipment",
        ] {
            assert!(!may_have_a_power_toughness_box(Some(not)), "{not}");
        }
        assert!(
            may_have_a_power_toughness_box(None),
            "unknown is not `no`: an orphan, or a row that arrived without a type line"
        );
    }

    /// A build toggle is one fact — the flag and the claims it means — so it is one
    /// transaction. Failure injected where it hurts: after the rebuild has deleted the old
    /// claims and before it has written the new ones.
    #[test]
    fn an_is_built_toggle_and_its_reallocation_commit_or_fail_together() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add(&conn, deck.id, "bolt-lea", main_of(&conn, deck.id), 4);
        assert_eq!(claims(&conn, deck.id), vec![(entry, 4)]);

        conn.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON deck_allocations
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let err = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                is_built: Some(true),
                ..Default::default()
            },
        )
        .unwrap_err();

        assert!(err.contains("boom"), "{err}");
        assert!(
            !read_deck(&conn, deck.id).unwrap().unwrap().is_built,
            "the flag did not flip on a rebuild that could not finish"
        );
        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 4)],
            "and the claims the delete removed are back — mid-rebuild is not a state anyone \
             can read"
        );

        // Nothing was stranded: with the failure gone the same toggle goes through.
        conn.execute_batch("DROP TRIGGER boom;").unwrap();
        let built = update_deck(
            &conn,
            deck.id,
            &DeckPatch {
                is_built: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(built.is_built);
        assert_eq!(claims(&conn, deck.id), vec![(entry, 4)]);
    }

    /// The claims follow every card write, because a deck the user is editing is a deck
    /// whose availability is being asked about a second later — and an inactive category
    /// reserves nothing at all.
    #[test]
    fn every_card_write_recomputes_the_claims() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        let side = kind_of(&conn, deck.id, "side");
        let scratch = kind_of(&conn, deck.id, "maybe");

        add(&conn, deck.id, "bolt-lea", main, 4);
        assert_eq!(claims(&conn, deck.id), vec![(entry, 4)]);

        set_card_quantity(&conn, deck.id, "bolt-lea", main, LIVE, 1).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 1)],
            "the stepper hands three copies back"
        );

        move_card(&conn, deck.id, "bolt-lea", main, scratch, LIVE).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![],
            "an inactive category is a scratchpad, and a scratchpad reserves nothing"
        );

        move_card(&conn, deck.id, "bolt-lea", scratch, side, LIVE).unwrap();
        assert_eq!(claims(&conn, deck.id), vec![(entry, 1)], "a sideboard does");

        set_card_quantity(&conn, deck.id, "bolt-lea", side, LIVE, 0).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![],
            "and a removal releases the last"
        );
    }

    /// `missing_to_wishlist`: 4 wanted, 1 owned → an any-printing wish for 3 lands through
    /// the wishlist grain; run twice → the wish is 6 (the fold is `add_wish`'s contract, not
    /// double-counted rows); a fully-owned card adds nothing; an inactive category and the
    /// theory list never count.
    #[test]
    fn missing_to_wishlist_writes_any_printing_wishes_through_the_wishlist_grain() {
        let conn = seeded();
        own(&conn, "bolt-lea", 1);
        own(&conn, "serra-lea", 1);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let main = main_of(&conn, deck.id);
        add(&conn, deck.id, "bolt-lea", main, 4);
        add(&conn, deck.id, "serra-lea", main, 1);
        // The same oracle card as the main-deck Bolts, so a scratchpad or a plan that leaked
        // into the shortfall would change the number rather than merely add a row.
        add(
            &conn,
            deck.id,
            "bolt-jp",
            kind_of(&conn, deck.id, "maybe"),
            3,
        );
        add_card(&conn, deck.id, "bolt-m10", Some(main), None, THEORY, 3).unwrap();

        let touched = missing_to_wishlist(&conn, deck.id).unwrap();

        assert_eq!(touched, 1, "one card is short; the Angel is not");
        let wishes: Vec<(Option<String>, Option<String>, String, i64)> = conn
            .prepare("SELECT oracle_id, card_id, name, quantity FROM wishlist_entries")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            wishes,
            vec![(Some("o1".to_owned()), None, "Lightning Bolt".to_owned(), 3)],
            "any printing will do — a shopping list is not a printing preference"
        );

        assert_eq!(missing_to_wishlist(&conn, deck.id).unwrap(), 1);
        let (rows, quantity): (i64, i64) = conn
            .query_row(
                "SELECT count(*), sum(quantity) FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            (rows, quantity),
            (1, 6),
            "the grain folds the repeat — one line, a bigger number"
        );
    }

    /// The rules as data, all the way out to the frontend: the nullable cells are the ones
    /// worth a fence, because `NULL` means *unlimited* here and `0` means *none*.
    #[test]
    fn the_format_specs_read_carries_every_cell_including_the_nullable_ones() {
        let conn = seeded();

        let specs = list_format_specs(&conn).unwrap();

        assert_eq!(specs.len(), 25);
        assert_eq!(specs[0].key, "standard", "sort_order, not alphabetical");
        let spec = |key: &str| specs.iter().find(|s| s.key == key).unwrap();
        let edh = spec("commander");
        assert_eq!(
            (
                edh.display_name.as_str(),
                edh.deck_min,
                edh.deck_max,
                edh.max_copies,
                edh.sideboard_max,
                edh.singleton,
                edh.requires_commander,
                edh.commander_rule.as_deref(),
                edh.life,
                edh.allows_companion,
            ),
            (
                "Commander",
                100,
                Some(100),
                Some(1),
                Some(0),
                true,
                true,
                Some("edh"),
                40,
                true
            ),
            "sideboard_max 0 is NO sideboard, and EDH still allows a companion"
        );
        let casual = spec("casual");
        assert_eq!(
            (
                casual.deck_max,
                casual.max_copies,
                casual.sideboard_max,
                casual.has_legality_data,
                casual.commander_rule.as_deref(),
            ),
            (None, None, None, false, None),
            "NULL is unlimited, and a pseudo-format checks no legality at all"
        );
        assert_eq!(
            spec("duel").restricted_semantic,
            "banned_as_commander",
            "TRAP A rides the read: `restricted` means something else here"
        );
        assert_eq!(spec("tlr").max_mana_value, Some(3));
        assert!(!spec("future").enabled_in_picker);
        assert!(!spec("gladiator").allows_companion);
    }

    /// A category kind the schema knows and the allocator does not would sort last by
    /// accident. The two lists are deliberately in different orders — one is the DDL's, one is
    /// the order copies are handed out in — so only their contents can be compared.
    #[test]
    fn the_allocation_order_covers_every_kind_the_schema_knows() {
        assert_eq!(KIND_PRIORITY.len(), crate::schema::CATEGORY_KINDS.len());
        for kind in crate::schema::CATEGORY_KINDS {
            assert!(
                KIND_PRIORITY.contains(&kind),
                "`{kind}` has no place in the allocation order"
            );
        }
        // A tie-break preference and nothing more: what is allocated for at all is decided by
        // `is_active`, which is a property of the category and not of its kind.
        assert_eq!(KIND_PRIORITY[KIND_PRIORITY.len() - 1], "maybe");
        assert_eq!(kind_rank("commander"), 0);
        assert_eq!(
            kind_rank("nonsense"),
            KIND_PRIORITY.len(),
            "an unknown kind sorts last rather than panicking"
        );
    }

    #[test]
    fn deck_card_and_format_spec_json_use_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(DeckCardRow {
            id: 7,
            card_id: "bolt-lea".to_owned(),
            category_id: 2,
            category_name: "Main deck".to_owned(),
            category_kind: "main".to_owned(),
            category_active: true,
            variant: "live".to_owned(),
            tag_id: Some(5),
            tag_name: Some("Flex".to_owned()),
            tag_color: Some("amber".to_owned()),
            quantity: 4,
            name: "Lightning Bolt".to_owned(),
            set_code: "lea".to_owned(),
            collector_number: "161".to_owned(),
            lang: "en".to_owned(),
            needs_review: None,
            oracle_id: Some("o1".to_owned()),
            mana_cost: Some("{R}".to_owned()),
            cmc: Some(1.0),
            type_line: Some("Instant".to_owned()),
            oracle_text: Some("Deal 3 damage.".to_owned()),
            colors: Some("R".to_owned()),
            color_identity: Some("R".to_owned()),
            legalities: Some(r#"{"modern":"legal"}"#.to_owned()),
            power: None,
            toughness: None,
            layout: Some("normal".to_owned()),
            rarity: Some("common".to_owned()),
            faces: None,
            game_changer: Some(false),
            finishes: Some(r#"["nonfoil","foil"]"#.to_owned()),
            ever_uncommon: false,
            unit_price_usd: Some(400.0),
            owned_quantity: 3,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 7, "cardId": "bolt-lea", "categoryId": 2, "categoryName": "Main deck",
                "categoryKind": "main", "categoryActive": true, "variant": "live",
                "tagId": 5, "tagName": "Flex", "tagColor": "amber", "quantity": 4,
                "name": "Lightning Bolt", "setCode": "lea", "collectorNumber": "161",
                "lang": "en", "needsReview": null, "oracleId": "o1", "manaCost": "{R}",
                "cmc": 1.0, "typeLine": "Instant", "oracleText": "Deal 3 damage.",
                "colors": "R", "colorIdentity": "R",
                "legalities": "{\"modern\":\"legal\"}", "power": null, "toughness": null,
                "layout": "normal", "rarity": "common", "faces": null,
                "gameChanger": false, "finishes": "[\"nonfoil\",\"foil\"]",
                "everUncommon": false, "unitPriceUsd": 400.0,
                "ownedQuantity": 3
            })
        );

        let conn = seeded();
        let spec = serde_json::to_value(&list_format_specs(&conn).unwrap()[11]).unwrap();
        assert_eq!(
            spec,
            serde_json::json!({
                "key": "commander", "displayName": "Commander", "enabledInPicker": true,
                "deckMin": 100, "deckMax": 100, "maxCopies": 1, "sideboardMax": 0,
                "singleton": true, "requiresCommander": true, "commanderRule": "edh",
                "life": 40, "restrictedSemantic": "max_one", "hasLegalityData": true,
                "maxManaValue": null, "allowsCompanion": true, "sortOrder": 12
            })
        );

        // The wrapper the command actually answers with: an empty deck still names its four
        // categories, because that is what the editor draws before anything is in it.
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let detail =
            serde_json::to_value(get_deck(&conn, deck.id, LIVE).unwrap().unwrap()).unwrap();
        assert_eq!(detail["deck"]["formatKey"], "modern");
        assert_eq!(detail["cards"], serde_json::json!([]));
        assert_eq!(detail["tags"], serde_json::json!([]));
        assert_eq!(detail["categories"].as_array().unwrap().len(), 4);
        assert_eq!(detail["categories"][0]["name"], "Commander");
        assert_eq!(detail["categories"][0]["isActive"], true);
    }
}
