//! Decks: the gallery, the deck itself, and what sits in each of its five zones.
//!
//! Shaped like [`crate::collection`]: pure functions over a `Connection`, testable without a
//! Tauri app, wrapped in `async` commands that run on the blocking pool. Writes take
//! `AppState.db` through [`crate::db::lock_for`] and answer [`crate::collection::BUSY`]
//! rather than waiting; the one read goes through `db_read` like every other read.
//!
//! Two rules run through the whole module and are worth stating once:
//!
//! * **A zone write denormalizes the printing *and the name*.** `deck_cards.card_id` is a
//!   soft reference — `cards` is dropped and rebuilt on every sync — so the row records
//!   what it was made from at the only moment that is knowable. The name is here for the
//!   wishlist's reason: a deck list that cannot say what an orphaned row *is* is not a list.
//! * **Zero is a removal.** `deck_cards.quantity` carries `CHECK (quantity > 0)`, unlike the
//!   collection's, because a zone slot at zero holds nothing worth keeping — no condition,
//!   no purchase price, no acquisition story, just an intention the user withdrew.

use crate::collection::{valid_quantity, EntryChange, ZERO_ADD};
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// The five zones, re-exported from the schema so the CHECK and its Rust twin cannot drift.
///
/// Schema v7 (Plan 8, Task 1) deleted `schema::DECK_ZONES` — the zone became a user-owned
/// `deck_categories` row, and `deck_cards.zone` no longer exists — so this now points at
/// `schema::CATEGORY_KINDS`, the same five words under their new name. This is the one
/// change Task 1 makes here, purely to keep the crate compiling; every zone-shaped query in
/// this file (`deck_cards.zone`, the `DECK_CARD_GRAIN` writes, `ZONE_PRIORITY`'s allocator
/// walk) still targets a column that is gone, and is Task 3's job to re-point onto
/// `category_id`, not this task's.
pub const ZONES: [&str; 5] = crate::schema::CATEGORY_KINDS;

/// What a deck is in when nobody says otherwise — `decks.format_key`'s own DDL default, so
/// an omitted `formatKey` means here exactly what it means in SQL.
pub const DEFAULT_FORMAT: &str = "casual";

/// What an adjustment says when the deck it names is not there.
pub const GONE: &str = "That deck is not there any more.";

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
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeckPatch {
    pub name: Option<String>,
    pub format_key: Option<String>,
    pub description: Option<String>,
    pub cover_card_id: Option<String>,
    pub is_built: Option<bool>,
    pub archived: Option<bool>,
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
    /// Scryfall image policy: an `art` crop lacks the printed frame, so wherever the
    /// gallery shows one it must credit the artist — read here so the tile can.
    pub cover_artist: Option<String>,
    pub is_built: bool,
    pub archived: bool,
    /// main + commander copies — what "a 60-card deck" means in a caption, and **the same
    /// zones the validation engine sizes a deck by** (`SIZE_ZONES` in `engine.ts`). One
    /// definition, because a tile that says 101 beside a panel that says "exactly 100 incl
    /// cmdr; you have 100" is two answers to one question. The sideboard, the maybe pile and
    /// the companion are all deliberately out of it: a companion is not in the deck it is
    /// played beside — where a format gives it a home it is a sideboard slot (CR 100.4a), and
    /// EDH's is "effectively a 101st card", which is exactly the card this count must not add.
    pub card_count: i64,
    pub updated_at: i64,
}

/// A zone the schema knows, refused in words rather than as a CHECK failure — the same
/// discipline `collection::valid_finish` applies to the finish enum.
fn valid_zone(zone: &str) -> Result<&str, String> {
    ZONES.contains(&zone).then_some(zone).ok_or_else(|| {
        format!(
            "`{zone}` is not a deck zone. Use one of: {}.",
            ZONES.join(", ")
        )
    })
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
type Printing = (String, String, String, String);

/// The printing and the name, as the deck row will remember them.
///
/// The name is what `collection::printing_of` does not read and the wishlist does: a
/// collection row is a thing the user can hold, but a deck list is *read*, and a line that
/// can only say `e7f8…` once the id stops resolving is not a deck list.
fn printing_of(conn: &Connection, card_id: &str) -> Result<Printing, String> {
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

/// What a zone write says when the row it was asked to adjust is not in that zone.
fn card_gone(zone: &str) -> String {
    format!("That card is not in this deck's {zone} zone any more.")
}

/// Every column of a [`DeckRow`], from the one query shape the list and the single read
/// share. Both LEFT JOINs are load-bearing: a vanished cover printing or a format key the
/// specs no longer carry must never hide a deck from its owner.
///
/// The zone list in the subquery is [`DeckRow::card_count`]'s definition, and it is the
/// engine's `SIZE_ZONES` (`main` + `commander`) verbatim — see that field's doc.
const DECK_SELECT: &str = "SELECT d.id, d.name, d.format_key, fs.display_name, d.description,
            d.cover_card_id, c.artist, d.is_built, d.archived,
            coalesce((SELECT sum(quantity) FROM deck_cards
                       WHERE deck_id = d.id
                         AND zone IN ('main','commander')), 0),
            d.updated_at
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
        cover_artist: r.get(6)?,
        is_built: r.get(7)?,
        archived: r.get(8)?,
        card_count: r.get(9)?,
        updated_at: r.get(10)?,
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

pub fn create_deck(conn: &Connection, input: &DeckInput) -> Result<DeckRow, String> {
    let name = valid_name(&input.name)?;
    let format_key = valid_format(conn, &input.format_key)?;
    let id: i64 = conn
        .query_row(
            "INSERT INTO decks (name, format_key, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![name, format_key, input.description],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    read_deck(conn, id)?.ok_or_else(|| GONE.to_owned())
}

/// Apply an edit. Absent fields are left alone (`coalesce(?n, column)`), which is what
/// makes this usable from a form that only sends what it changed — `collection::update_entry`
/// verbatim. Rename, re-format, cover, build and archive all arrive here.
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
    let changed = tx
        .execute(
            "UPDATE decks SET
                name = coalesce(?2, name),
                format_key = coalesce(?3, format_key),
                description = coalesce(?4, description),
                cover_card_id = coalesce(?5, cover_card_id),
                is_built = coalesce(?6, is_built),
                archived = coalesce(?7, archived),
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
            ],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(GONE.to_owned());
    }
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

/// Delete the deck outright.
///
/// **This one really deletes**, unlike anything in [`crate::reconcile`]: a deck is the
/// user's to destroy, and `deck_cards` and `deck_allocations` both cascade from it by a
/// choice made per delete-site in the v5 DDL. Archiving is the soft path
/// ([`DeckPatch::archived`]), and it is what a gallery's "remove" should reach for.
///
/// Like [`crate::collection::remove_entry`], an id that resolves to nothing is a success:
/// the caller wanted that deck gone, and it is gone.
pub fn delete_deck(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM decks WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Copy the deck and its cards — never its claims, never `is_built`, never `archived`.
///
/// A copy is a **draft**: it has reserved no copies of anything (claims belong to the deck
/// that made them, and Task 5's allocator will give the copy its own), it is not sleeved up
/// on a table, and it is not something the user filed away. Everything that describes the
/// deck rather than its state — format, description, cover — comes across, so the copy
/// looks like what was copied.
pub fn duplicate_deck(conn: &Connection, id: i64) -> Result<DeckRow, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let copy: Option<i64> = tx
        .query_row(
            "INSERT INTO decks (name, format_key, description, cover_kind, cover_card_id,
                                cover_image_path, is_built, archived, created_at, updated_at)
             SELECT name || ' (copy)', format_key, description, cover_kind, cover_card_id,
                    cover_image_path, 0, 0, unixepoch(), unixepoch()
               FROM decks WHERE id = ?1
             RETURNING id",
            params![id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(copy) = copy else {
        return Err(GONE.to_owned());
    };
    // `needs_review` travels with the row: the sentence says this printing left the card
    // database, which is just as true of the copy.
    tx.execute(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             needs_review, created_at, updated_at)
         SELECT ?2, card_id, set_code, collector_number, lang, name, zone, quantity,
                needs_review, unixepoch(), unixepoch()
           FROM deck_cards WHERE deck_id = ?1",
        params![id, copy],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_deck(conn, copy)?.ok_or_else(|| GONE.to_owned())
}

/// The gallery, archived decks last and most recently touched first.
pub fn list_decks(conn: &Connection) -> Result<Vec<DeckRow>, String> {
    let sql = format!("{DECK_SELECT} ORDER BY d.archived ASC, d.updated_at DESC, d.id DESC");
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], deck_row).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Add copies to a zone, folding on the grain — the drag-in and the click-to-add write.
pub fn add_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    zone: &str,
    quantity: i64,
) -> Result<EntryChange, String> {
    let zone = valid_zone(zone)?;
    // Not `valid_quantity`: *adding* zero copies is a no-op dressed as a write, and would
    // conjure a row out of nothing. The same refusal `collection::add_entry` gives, from the
    // one constant that owns the sentence.
    if quantity <= 0 {
        return Err(ZERO_ADD.to_owned());
    }
    let (set_code, collector_number, lang, name) = printing_of(conn, card_id)?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // The conflict target is `DECK_CARD_GRAIN` verbatim — the same text the unique index
    // was created from. Anything else is a runtime "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint" at the first quick-add, which is why it is a
    // constant. The quantities add; the row holds nothing else a second add could disagree
    // with.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8, unixepoch(), unixepoch())
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()
         RETURNING id, quantity",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let (id, quantity): (i64, i64) = tx
        .query_row(
            &sql,
            params![
                deck_id,
                card_id,
                set_code,
                collector_number,
                lang,
                name,
                zone,
                quantity
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Set an absolute quantity — the stepper write. **Zero removes the row.**
///
/// The wishlist's asymmetry, for the wishlist's reason: `deck_cards.quantity` carries
/// `CHECK (quantity > 0)`, and a zone slot at zero holds nothing worth keeping. The
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
    zone: &str,
    quantity: i64,
) -> Result<EntryChange, String> {
    let zone = valid_zone(zone)?;
    valid_quantity(quantity, "deck quantity")?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;

    if quantity == 0 {
        let id: Option<i64> = tx
            .query_row(
                "DELETE FROM deck_cards
                  WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3
                 RETURNING id",
                params![deck_id, card_id, zone],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        allocate_deck(&tx, deck_id)?;
        tx.commit().map_err(|e| e.to_string())?;
        // A slot the caller wanted empty and that is empty: like `remove_entry`, a delete
        // that finds nothing already has what it wanted. There is no row left to name, so
        // the id is 0 — the only thing this path reports is that the slot is gone.
        return Ok(EntryChange {
            id: id.unwrap_or(0),
            quantity: 0,
            removed: true,
        });
    }

    let id: Option<i64> = tx
        .query_row(
            "UPDATE deck_cards SET quantity = ?4, updated_at = unixepoch()
              WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3
             RETURNING id",
            params![deck_id, card_id, zone, quantity],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // The [`crate::collection::GONE`] asymmetry: an *adjustment* to a row that is not there
    // could not do what it was asked. Putting a card into a zone is [`add_card`].
    let id = id.ok_or_else(|| card_gone(zone))?;
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Move every copy from one zone to another, in one transaction, folding into the row the
/// target zone already holds.
///
/// The identity travels **from the moved row**, never from a fresh `cards` lookup: a deck
/// whose printing left the card database is exactly the deck whose maybe pile someone is
/// tidying, and a move that needed the id to resolve would refuse the one row that most
/// needs moving.
pub fn move_card(
    conn: &Connection,
    deck_id: i64,
    card_id: &str,
    from: &str,
    to: &str,
) -> Result<(), String> {
    let from = valid_zone(from)?;
    let to = valid_zone(to)?;
    if from == to {
        return Ok(());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;
    // `INSERT … SELECT … ON CONFLICT` over the same table: the `WHERE` is what makes it
    // unambiguous to parse, and it is here anyway. `needs_review` comes across with a row
    // that lands in an empty zone and is left alone where the target row already exists —
    // the fold's rule in `reconcile::fold_deck_card_into_existing`, for its reason.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             needs_review, created_at, updated_at)
         SELECT deck_id, card_id, set_code, collector_number, lang, name, ?3, quantity,
                needs_review, unixepoch(), unixepoch()
           FROM deck_cards
          WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?4
         ON CONFLICT({grain}) DO UPDATE SET
            quantity = deck_cards.quantity + excluded.quantity,
            updated_at = unixepoch()",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    let moved = tx
        .execute(&sql, params![deck_id, card_id, to, from])
        .map_err(|e| e.to_string())?;
    if moved == 0 {
        return Err(card_gone(from));
    }
    tx.execute(
        "DELETE FROM deck_cards WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3",
        params![deck_id, card_id, from],
    )
    .map_err(|e| e.to_string())?;
    // A move changes what is claimed even though nothing was added or removed: `maybe`
    // reserves nothing, so a card dragged into or out of it is a claim released or made.
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// What a swap answers: where the copies ended up, and whether they had company.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResult {
    /// The target zone already held that printing, so the two rows became one. The UI says
    /// so, because a deck list that silently loses a line reads like a bug.
    pub folded: bool,
    /// The quantity of the row the copies now live in — the **sum**, when `folded`.
    pub quantity: i64,
}

/// Swap a deck card to another printing of the same card: same zone, same copies, folding
/// into whatever that zone already holds of the printing swapped to.
///
/// The card pane's "Use this printing", and the one zone write whose identity comes from a
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
    zone: &str,
) -> Result<SwapResult, String> {
    let zone = valid_zone(zone)?;
    // Before the transaction, so a no-op does not move `updated_at` and resort the gallery.
    if from_card_id == to_card_id {
        return Err(SAME_PRINTING.to_owned());
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    touch_deck(&tx, deck_id)?;

    // The name comes across with the quantity because a refusal below has to say what is in
    // the deck, and the row's own denormalized name is what the deck list is showing.
    let (quantity, from_name): (i64, String) = tx
        .query_row(
            "SELECT quantity, name FROM deck_cards
              WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3",
            params![deck_id, from_card_id, zone],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?
        // [`set_card_quantity`]'s asymmetry: a swap adjusts a row, and a row that is not in
        // that zone is a stale editor. Putting a card into a zone is [`add_card`].
        .ok_or_else(|| card_gone(zone))?;

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
    // in that zone" is the same write whether they came from a search or from another row.
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, card_id, set_code, collector_number, lang, name, zone, quantity,
             created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8, unixepoch(), unixepoch())
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
                to_card_id,
                set_code,
                collector_number,
                lang,
                name,
                zone,
                quantity
            ],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    tx.execute(
        "DELETE FROM deck_cards WHERE deck_id = ?1 AND card_id = ?2 AND zone = ?3",
        params![deck_id, from_card_id, zone],
    )
    .map_err(|e| e.to_string())?;

    // The deck wants a different printing than it did a statement ago, and the allocator
    // takes the exact printing first — so the copies it reserves can change even though the
    // count did not.
    allocate_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(SwapResult {
        // `deck_cards.quantity` carries `CHECK (quantity > 0)`, so a row that was already
        // there contributed at least one copy: the landed total is strictly greater than
        // what was moved exactly when the insert folded. No second read needed to know it.
        folded: landed > quantity,
        quantity: landed,
    })
}

// ---------------------------------------------------------------------------------------
// The read, the allocator, and what is still missing
// ---------------------------------------------------------------------------------------

/// The zones in the order copies are handed out in — the allocator's walk and the read's
/// attribution both take it.
///
/// `commander` first, because a deck's commander is the copy it cannot be played without;
/// `maybe` last, and the allocator never reaches it at all: a maybe pile is a scratchpad,
/// and copies reserved for a card the user has not decided to play are copies another deck
/// cannot have. It is in the list because attribution walks *every* row — anything the four
/// real zones did not take would otherwise have nowhere to land.
///
/// A permutation of [`ZONES`], and `the_allocation_order_covers_every_zone_the_schema_knows`
/// is what keeps it one: a sixth zone added to the schema with no place here would sort last
/// by accident rather than by decision.
const ZONE_PRIORITY: [&str; 5] = ["commander", "main", "side", "companion", "maybe"];

/// The scratchpad zone: listed and counted, but never a claim on anything.
const MAYBE: &str = "maybe";

/// Where a zone sorts in [`ZONE_PRIORITY`]. An unknown zone — impossible past [`valid_zone`]
/// and the table's CHECK — sorts last rather than panicking.
fn zone_rank(zone: &str) -> usize {
    ZONE_PRIORITY
        .iter()
        .position(|z| *z == zone)
        .unwrap_or(ZONE_PRIORITY.len())
}

/// One card in one zone of one deck: what it is, what the validation engine needs to judge
/// it, and how much of it the user actually has.
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
    pub zone: String,
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
    /// Printed at uncommon on **any** printing of this oracle card. Computed, not read: a
    /// Pauper Commander commander is eligible for having been uncommon *somewhere*, and the
    /// `paupercommander` legality key answers a different question (the 99).
    pub ever_uncommon: bool,
    /// Nonfoil `usd` from the prices blob — `WishRow::unit_price_usd`'s rule. Never
    /// `cards.price_usd`, which is a display fallback chain and must not be summed.
    pub unit_price_usd: Option<f64>,
    /// Copies of this oracle card the allocator secured for this deck, attributed to this
    /// row in [`ZONE_PRIORITY`] order and clamped to what each entry still holds — so a
    /// collection that shrank under a stored claim reads honestly.
    pub owned_quantity: i64,
}

/// One deck and everything in it: the gallery's row, plus every zone in one answer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckDetail {
    pub deck: DeckRow,
    pub cards: Vec<DeckCardRow>,
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
/// `deck_cards dc LEFT JOIN cards c` is [`crate::collection`]'s discipline verbatim: an
/// inner join would delete from the view exactly the rows the denormalised columns exist
/// for. `ever_uncommon`'s `EXISTS` rides `idx_cards_oracle`, and answers false for an orphan
/// on its own (`NULL = NULL` is not true), which is the right answer — nothing is known
/// about a card that is not there.
const DECK_CARD_SELECT: &str = "SELECT dc.id, dc.card_id, dc.zone, dc.quantity, dc.name,
            dc.set_code, dc.collector_number, dc.lang, dc.needs_review,
            c.oracle_id, c.mana_cost, c.cmc, c.type_line, c.oracle_text, c.colors,
            c.color_identity, c.legalities, c.power, c.toughness, c.layout, c.rarity,
            c.faces, c.game_changer,
            CAST(json_extract(c.prices, '$.usd') AS REAL) AS unit_price_usd,
            EXISTS(SELECT 1 FROM cards u
                    WHERE u.oracle_id = c.oracle_id AND u.rarity = 'uncommon') AS ever_uncommon
       FROM deck_cards dc LEFT JOIN cards c ON c.id = dc.card_id
      WHERE dc.deck_id = ?1";

/// The whole deck in one read: the gallery's row, every card, every fact, every number.
///
/// One command rather than three, because the editor and the validation engine ask the same
/// question — *what is in this deck* — and a screen that draws a curve from one query, a
/// legality panel from another and an owned badge from a third is a screen whose three
/// answers can disagree.
pub fn get_deck(conn: &Connection, id: i64) -> Result<Option<DeckDetail>, String> {
    let Some(deck) = read_deck(conn, id)? else {
        return Ok(None);
    };
    let mut cards = read_deck_cards(conn, id)?;
    fill_unknown_power_toughness(conn, &mut cards)?;
    attribute_owned(&mut cards, &owned_by_oracle(conn, id)?);
    Ok(Some(DeckDetail { deck, cards }))
}

/// Every card in the deck, in the order the editor reads them.
fn read_deck_cards(conn: &Connection, deck_id: i64) -> Result<Vec<DeckCardRow>, String> {
    let mut stmt = conn.prepare(DECK_CARD_SELECT).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| {
            Ok(DeckCardRow {
                id: r.get(0)?,
                card_id: r.get(1)?,
                zone: r.get(2)?,
                quantity: r.get(3)?,
                name: r.get(4)?,
                set_code: r.get(5)?,
                collector_number: r.get(6)?,
                lang: r.get(7)?,
                needs_review: r.get(8)?,
                oracle_id: r.get(9)?,
                mana_cost: r.get(10)?,
                cmc: r.get(11)?,
                type_line: r.get(12)?,
                oracle_text: r.get(13)?,
                colors: r.get(14)?,
                color_identity: r.get(15)?,
                legalities: r.get(16)?,
                power: r.get(17)?,
                toughness: r.get(18)?,
                layout: r.get(19)?,
                rarity: r.get(20)?,
                faces: r.get(21)?,
                game_changer: r.get(22)?,
                unit_price_usd: r.get(23)?,
                ever_uncommon: r.get(24)?,
                // Filled by `attribute_owned`, once the claims are known.
                owned_quantity: 0,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut cards = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    // Zone order, then the name the row carries — which an orphan has and its card does not.
    cards.sort_by(|a, b| {
        zone_rank(&a.zone)
            .cmp(&zone_rank(&b.zone))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(cards)
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
/// stored claim is left alone — the next zone write recomputes it — because a read is not
/// the place to discover that the world moved.
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
/// it. The walk is [`ZONE_PRIORITY`] then row id — the commander is the copy a deck cannot be
/// played without, and `maybe` is last because it is the pile the allocator never claimed
/// for. Its own order, not the caller's: a read that sorted differently would attribute
/// differently, and the number a row shows must not depend on how the list was displayed.
fn attribute_owned(rows: &mut [DeckCardRow], owned_by_oracle: &HashMap<String, i64>) {
    let mut order: Vec<usize> = (0..rows.len()).collect();
    order.sort_by_key(|&i| (zone_rank(&rows[i].zone), rows[i].id));
    let mut left = owned_by_oracle.clone();
    for i in order {
        let Some(oracle) = rows[i].oracle_id.clone() else {
            rows[i].owned_quantity = 0;
            continue;
        };
        let remaining = left.entry(oracle).or_insert(0);
        let take = (*remaining).min(rows[i].quantity).max(0);
        *remaining -= take;
        rows[i].owned_quantity = take;
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
/// rows. Greedy, in [`ZONE_PRIORITY`] order over the deck's cards (never [`MAYBE`]): for each
/// one, the entries of the same **oracle** card — a Bolt is a Bolt — taking the exact
/// printing first, real copies before proxies, then entry id, and never more than the entry
/// still has free.
///
/// Availability is `entry.quantity` minus the claims of other **built** decks. That is the
/// whole of what `is_built` means: a deck on a table has the cards, a deck being planned is
/// planning with cards it may share with every other draft. A deck is never blocked by its
/// own claims, which is why they are deleted before anything is counted.
///
/// **Takes `&Connection` and opens no transaction of its own.** Every zone write already runs
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

    // What the deck wants. An INNER JOIN, because the hunt is for entries of the same oracle
    // card and an orphaned row names no oracle card — it is listed, flagged and reads owned
    // 0 until the reconciler or the next sync gives it its identity back.
    let mut wants: Vec<(i64, String, String, i64, String)> = conn
        .prepare(
            "SELECT dc.id, dc.zone, dc.card_id, dc.quantity, c.oracle_id
               FROM deck_cards dc JOIN cards c ON c.id = dc.card_id
              WHERE dc.deck_id = ?1 AND dc.zone <> ?2 AND c.oracle_id IS NOT NULL",
        )
        .map_err(|e| e.to_string())?
        .query_map(params![deck_id, MAYBE], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    wants.sort_by_key(|(id, zone, ..)| (zone_rank(zone), *id));

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
/// fills the hole is whichever one turns up. `maybe` is not counted — the pile is a
/// scratchpad, and a card the user has not decided to play is not a card they need to buy.
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
pub fn missing_to_wishlist(conn: &Connection, deck_id: i64) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    allocate_deck(&tx, deck_id)?;
    let detail = get_deck(&tx, deck_id)?.ok_or_else(|| GONE.to_owned())?;

    // Oracle-grained, so the same card short in two zones is one wish for the sum — which is
    // what "one wish per card still missing" means, and what the reader would count.
    let mut missing: BTreeMap<String, (String, i64)> = BTreeMap::new();
    for row in &detail.cards {
        if row.zone == MAYBE {
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

#[tauri::command]
pub async fn deck_delete(state: tauri::State<'_, Arc<AppState>>, id: i64) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_deck(c, id)))
        .await
        .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_duplicate(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<DeckRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| duplicate_deck(c, id)))
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

/// One deck, everything in it, every fact the validator needs. **Read-only** connection.
#[tauri::command]
pub async fn deck_get(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<Option<DeckDetail>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_deck(&crate::sync::lock_db_read(&state), id))
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

#[tauri::command]
pub async fn deck_add_card(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    zone: String,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| add_card(c, deck_id, &card_id, &zone, quantity))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command]
pub async fn deck_set_card_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    card_id: String,
    zone: String,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            set_card_quantity(c, deck_id, &card_id, &zone, quantity)
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
    from: String,
    to: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| move_card(c, deck_id, &card_id, &from, &to))
    })
    .await
    .map_err(unfinished)?
}

/// The card pane's "Use this printing". `deckId` like every other zone write's, because
/// `decks.id` is an integer everywhere it is written.
#[tauri::command]
pub async fn deck_swap_printing(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    from_card_id: String,
    to_card_id: String,
    zone: String,
) -> Result<SwapResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            swap_printing(c, deck_id, &from_card_id, &to_card_id, &zone)
        })
    })
    .await
    .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn card_row<'a>(detail: &'a DeckDetail, card_id: &str, zone: &str) -> &'a DeckCardRow {
        detail
            .cards
            .iter()
            .find(|r| r.card_id == card_id && r.zone == zone)
            .unwrap_or_else(|| panic!("no `{card_id}` in the {zone} zone"))
    }

    /// What the deck says it owns of one printing, read the way the editor reads it.
    fn owned_of(conn: &Connection, deck_id: i64, card_id: &str, zone: &str) -> i64 {
        let detail = get_deck(conn, deck_id).unwrap().unwrap();
        card_row(&detail, card_id, zone).owned_quantity
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

    /// The zone write is the collection quick-add's contract on the deck grain: the same
    /// printing in the same zone twice is one row with a bigger number, and the printing
    /// AND name are denormalized from `cards` at write time — the only moment they are
    /// knowable, and the reason the row outlives the id (spec §6, CLAUDE.md).
    #[test]
    fn adding_the_same_card_to_the_same_zone_twice_folds() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let first = add_card(&conn, deck.id, "bolt-jp", "main", 2).unwrap();
        let second = add_card(&conn, deck.id, "bolt-jp", "main", 2).unwrap();

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

        // `zone` is in the grain: the same printing in the maybe pile is a second
        // intention, not the same row somewhere else.
        let maybe = add_card(&conn, deck.id, "bolt-jp", "maybe", 1).unwrap();
        assert_ne!(maybe.id, second.id);
        assert_eq!(count(&conn, "deck_cards"), 2);
    }

    #[test]
    fn a_zone_the_schema_does_not_know_is_refused_in_words() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let err = add_card(&conn, deck.id, "bolt-lea", "sideboard", 1).unwrap_err();
        assert!(err.contains("sideboard"), "{err}");
        for zone in ZONES {
            assert!(err.contains(zone), "the refusal names `{zone}`: {err}");
        }
        assert_eq!(count(&conn, "deck_cards"), 0, "and nothing was written");

        // Every zone write validates in Rust, so the CHECK never reaches a user.
        assert!(set_card_quantity(&conn, deck.id, "bolt-lea", "sideboard", 1).is_err());
        assert!(move_card(&conn, deck.id, "bolt-lea", "main", "sideboard").is_err());
    }

    #[test]
    fn zero_removes_the_deck_card_and_negative_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let added = add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();

        let lowered = set_card_quantity(&conn, deck.id, "bolt-lea", "main", 1).unwrap();
        assert_eq!(
            (lowered.id, lowered.quantity, lowered.removed),
            (added.id, 1, false),
            "an absolute quantity, not an addition"
        );

        let err = set_card_quantity(&conn, deck.id, "bolt-lea", "main", -1).unwrap_err();
        assert!(err.contains("is not a quantity"), "{err}");
        assert_eq!(count(&conn, "deck_cards"), 1, "and it never deletes");

        let removed = set_card_quantity(&conn, deck.id, "bolt-lea", "main", 0).unwrap();
        assert_eq!(
            (removed.id, removed.quantity, removed.removed),
            (added.id, 0, true)
        );
        assert_eq!(count(&conn, "deck_cards"), 0);
    }

    #[test]
    fn moving_a_card_between_zones_folds_into_the_target_row() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "side", 1).unwrap();

        move_card(&conn, deck.id, "bolt-lea", "main", "side").unwrap();

        assert_eq!(count(&conn, "deck_cards"), 1, "one row, not two");
        let (zone, quantity): (String, i64) = conn
            .query_row("SELECT zone, quantity FROM deck_cards", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!((zone.as_str(), quantity), ("side", 5), "four into one");

        // An empty target zone is a create, and the identity comes from the moved row
        // rather than from a fresh lookup — so the printing is dropped from `cards` first,
        // which is what the next sync does to a card Scryfall stopped publishing. The row
        // being tidied out of a deck is exactly the row most likely to be orphaned, and a
        // move that needed the id to resolve would refuse it.
        conn.execute("DELETE FROM cards", []).unwrap();

        move_card(&conn, deck.id, "bolt-lea", "side", "maybe").unwrap();

        assert_eq!(count(&conn, "deck_cards"), 1);
        let (zone, quantity, name, set): (String, i64, String, String) = conn
            .query_row(
                "SELECT zone, quantity, name, set_code FROM deck_cards",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (zone.as_str(), quantity, name.as_str(), set.as_str()),
            ("maybe", 5, "Lightning Bolt", "lea"),
            "an orphaned row still moves, still counted and still sayable"
        );
    }

    /// The zone rows of one deck, in a fixed order, as every swap assertion reads them.
    fn zone_rows(conn: &Connection, deck_id: i64) -> Vec<(String, String, i64)> {
        conn.prepare(
            "SELECT card_id, zone, quantity FROM deck_cards
              WHERE deck_id = ?1 ORDER BY zone, card_id",
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
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![(lea, 3)],
            "the allocator takes the exact printing first, so the claim is the Alpha row"
        );
        stop_the_clock(&conn, deck.id);

        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", "main").unwrap();

        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        // The other half of what every refusal below pins: a swap *is* an edit, so the deck
        // rises in a gallery that sorts by this column. Without this the whole file could
        // pass with `touch_deck` deleted.
        assert!(
            touched_at(&conn, deck.id) > UNMOVED,
            "a swap moves `updated_at`: the gallery resorts for it"
        );
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![("bolt-m10".to_owned(), "main".to_owned(), 3)],
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

        // Any zone the schema knows, the scratchpad included — choosing a printing is
        // exactly what a maybe pile is for, and it still reserves nothing.
        add_card(&conn, deck.id, "serra-lea", "maybe", 1).unwrap();
        swap_printing(&conn, deck.id, "serra-lea", "serra-8ed", "maybe").unwrap();
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![
                ("bolt-m10".to_owned(), "main".to_owned(), 3),
                ("serra-8ed".to_owned(), "maybe".to_owned(), 1),
            ],
        );
        assert_eq!(
            claims(&conn, deck.id),
            vec![(m10, 3)],
            "a maybe swap claims nothing, before or after"
        );
    }

    /// Two printings of one card in one zone is one row, because the grain says so — the
    /// same fold [`add_card`] and [`move_card`] do, reported so the UI can say "folded".
    #[test]
    fn a_swap_onto_an_existing_row_folds_quantities_on_the_grain() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        add_card(&conn, deck.id, "bolt-m10", "main", 2).unwrap();
        // The same printing in another zone: `zone` is in the grain, so this row is not in
        // the swap's way and must not collect the copies.
        add_card(&conn, deck.id, "bolt-m10", "side", 1).unwrap();

        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", "main").unwrap();

        assert_eq!(
            (swapped.folded, swapped.quantity),
            (true, 5),
            "three into two, and the answer says it folded"
        );
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![
                ("bolt-m10".to_owned(), "main".to_owned(), 5),
                ("bolt-m10".to_owned(), "side".to_owned(), 1),
            ],
        );
    }

    /// Swapping a printing to itself is not an edit: the pane hides the action on the row the
    /// deck already uses, so reaching here is a double-click or a stale list.
    #[test]
    fn a_swap_refuses_the_same_printing_and_writes_nothing() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-lea", "main").unwrap_err();

        assert!(err.contains("already"), "{err}");
        assert_eq!(
            touched_at(&conn, deck.id),
            UNMOVED,
            "a no-op is not an edit — the gallery does not resort for it"
        );
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), "main".to_owned(), 3)]
        );
    }

    /// The [`card_gone`] asymmetry: a swap adjusts a row, and a row that is not in that zone
    /// is a stale editor rather than an invitation to create one.
    #[test]
    fn a_swap_of_a_missing_row_says_which_zone_it_looked_in() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", "side").unwrap_err();

        assert!(err.contains("side"), "the refusal names the zone: {err}");
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), "main".to_owned(), 3)],
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
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'bolt-m10'", [])
            .unwrap();
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", "main").unwrap_err();

        assert!(err.contains("sync"), "{err}");
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), "main".to_owned(), 3)],
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
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        stop_the_clock(&conn, deck.id);

        let err = swap_printing(&conn, deck.id, "bolt-lea", "serra-lea", "main").unwrap_err();

        assert!(
            err.contains("Lightning Bolt") && err.contains("Serra Angel"),
            "the refusal names both cards, because which two were paired is the whole \
             question: {err}"
        );
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), "main".to_owned(), 3)],
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
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();

        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "serra-8ed", "main").unwrap();

        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![("serra-8ed".to_owned(), "main".to_owned(), 3)],
            "the copies left the dead printing for the one the reader chose"
        );
    }

    #[test]
    fn a_swap_on_a_deleted_deck_answers_gone() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        delete_deck(&conn, deck.id).unwrap();

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", "main").unwrap_err();

        assert_eq!(err, GONE, "the same sentence every other zone write gives");
    }

    /// The insert, the delete and the reallocation are one write. Failure injected at the
    /// last of the three — the state in between is a deck holding the copies in *neither*
    /// row, and it is not a state anyone can read.
    #[test]
    fn a_swap_is_one_transaction() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 3);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 3).unwrap();
        assert_eq!(claims(&conn, deck.id), vec![(entry, 3)]);
        stop_the_clock(&conn, deck.id);

        conn.execute_batch(
            "CREATE TRIGGER boom BEFORE INSERT ON deck_allocations
             BEGIN SELECT RAISE(ABORT, 'boom'); END;",
        )
        .unwrap();

        let err = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", "main").unwrap_err();

        assert!(err.contains("boom"), "{err}");
        assert_eq!(
            zone_rows(&conn, deck.id),
            vec![("bolt-lea".to_owned(), "main".to_owned(), 3)],
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
        let swapped = swap_printing(&conn, deck.id, "bolt-lea", "bolt-m10", "main").unwrap();
        assert_eq!((swapped.folded, swapped.quantity), (false, 3));
        assert_eq!(claims(&conn, deck.id), vec![(entry, 3)]);
    }

    #[test]
    fn duplicate_copies_cards_but_not_allocations_or_built() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        add_card(&conn, deck.id, "bolt-jp", "maybe", 1).unwrap();
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

        let copy = duplicate_deck(&conn, deck.id).unwrap();

        assert_ne!(copy.id, deck.id);
        assert_eq!(copy.name, "Burn (copy)");
        assert_eq!(copy.format_key, "modern");
        assert!(!copy.is_built, "a copy is a draft, never a built deck");
        assert_eq!(
            copy.card_count, 4,
            "main only — the maybe pile is not the deck"
        );

        let cards: Vec<(String, String, i64)> = conn
            .prepare(
                "SELECT card_id, zone, quantity FROM deck_cards WHERE deck_id = ?1
                  ORDER BY zone",
            )
            .unwrap()
            .query_map(params![copy.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            cards,
            vec![
                ("bolt-lea".to_owned(), "main".to_owned(), 4),
                ("bolt-jp".to_owned(), "maybe".to_owned(), 1),
            ]
        );

        let claims: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_allocations WHERE deck_id = ?1",
                params![copy.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            claims, 0,
            "a copy reserves nothing — the original's claims are the original's"
        );
        assert_eq!(count(&conn, "deck_allocations"), 1);
    }

    #[test]
    fn list_decks_counts_main_and_commander_and_reads_the_cover_artist() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Bolt Tribal", "commander")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 2).unwrap();
        add_card(&conn, deck.id, "bolt-jp", "commander", 1).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "companion", 1).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "side", 3).unwrap();
        add_card(&conn, deck.id, "bolt-jp", "maybe", 7).unwrap();
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
        // `SIZE_ZONES`, which is `main` + `commander` and nothing else. A companion is the
        // reason this is pinned: EDH calls one "effectively a 101st card", so counting it here
        // would put 101 on the tile of a deck the panel had just called exactly 100.
        assert_eq!(
            decks[0].card_count, 3,
            "2 main + 1 commander; the companion, side and maybe piles are not the deck"
        );
        assert_eq!(decks[0].format_name.as_deref(), Some("Commander"));
        assert_eq!(decks[0].cover_artist.as_deref(), Some("Christopher Rush"));
        assert_eq!(decks[1].card_count, 0);
    }

    #[test]
    fn a_card_id_that_does_not_resolve_is_refused() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        let err = add_card(&conn, deck.id, "no-such-card", "main", 1).unwrap_err();

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

    /// A deck delete is a real user deletion — the decks are the user's to destroy — and
    /// the CASCADEs take the cards and the claims with it. What it never touches is the
    /// collection: a deck names copies, it does not own them.
    #[test]
    fn deleting_a_deck_takes_its_cards_and_claims_and_deleting_it_twice_still_succeeds() {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        own_and_claim(&conn, deck.id);

        delete_deck(&conn, deck.id).unwrap();

        assert_eq!(count(&conn, "decks"), 0);
        assert_eq!(count(&conn, "deck_cards"), 0);
        assert_eq!(count(&conn, "deck_allocations"), 0);
        assert_eq!(
            count(&conn, "collection_entries"),
            1,
            "the copies are still owned"
        );

        delete_deck(&conn, deck.id).expect("a deck that is already gone is gone");
    }

    /// The gallery sorts by `decks.updated_at`, so a deck that was edited has to rise —
    /// and the same statement is what tells a zone write that the deck it names exists.
    #[test]
    fn every_zone_write_touches_the_deck_the_gallery_sorts_by() {
        let conn = seeded();
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
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
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        assert!(updated_at(&conn) > 0, "the add moved the deck");

        backdate(&conn);
        set_card_quantity(&conn, deck.id, "bolt-lea", "main", 2).unwrap();
        assert!(updated_at(&conn) > 0, "so does the stepper");

        backdate(&conn);
        move_card(&conn, deck.id, "bolt-lea", "main", "side").unwrap();
        assert!(updated_at(&conn) > 0, "and so does the move");

        // The same statement is the existence check: a stale deck id from a gallery that
        // has not refreshed is a sentence, never a foreign-key error.
        let err = add_card(&conn, deck.id + 999, "bolt-lea", "main", 1).unwrap_err();
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
            cover_artist: Some("Christopher Rush".to_owned()),
            is_built: true,
            archived: false,
            card_count: 60,
            updated_at: 1_800_000_000,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "name": "Burn", "formatKey": "modern", "formatName": "Modern",
                "description": null, "coverCardId": "bolt-lea",
                "coverArtist": "Christopher Rush", "isBuilt": true, "archived": false,
                "cardCount": 60, "updatedAt": 1800000000
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

        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();

        assert_eq!(
            claims(&conn, deck.id),
            vec![(lea, 2), (m10, 1)],
            "a different printing of the same oracle card is the same card"
        );
        let detail = get_deck(&conn, deck.id).unwrap().unwrap();
        let row = card_row(&detail, "bolt-lea", "main");
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

        add_card(&conn, deck.id, "bolt-lea", "main", 5).unwrap();

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
        add_card(&conn, a.id, "bolt-lea", "main", 4).unwrap();
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
        add_card(&conn, b.id, "bolt-lea", "main", 4).unwrap();

        assert_eq!(claims(&conn, b.id), vec![], "those copies are on a table");
        assert_eq!(owned_of(&conn, b.id, "bolt-lea", "main"), 0);
        assert_eq!(
            owned_of(&conn, a.id, "bolt-lea", "main"),
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

        assert_eq!(owned_of(&conn, b.id, "bolt-lea", "main"), 4);
        assert_eq!(
            owned_of(&conn, a.id, "bolt-lea", "main"),
            4,
            "two drafts may both plan on one playset — only a built deck reserves it"
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
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        assert_eq!(claims(&conn, deck.id), vec![(entry, 4)]);

        crate::collection::set_quantity(&conn, entry, 1).unwrap();

        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 4)],
            "a collection edit does not walk every deck…"
        );
        assert_eq!(
            owned_of(&conn, deck.id, "bolt-lea", "main"),
            1,
            "…so the read is what has to tell the truth about a shrunken binder"
        );

        // The collection keeps a row it has been emptied to zero — the condition, the price
        // and the acquisition story survive the day the copies are traded away — and an
        // entry holding none of the card must reserve none of it. A claim of zero is not
        // just wrong, it is `CHECK (quantity > 0)`: the allocator writes no row at all.
        crate::collection::set_quantity(&conn, entry, 0).unwrap();
        set_card_quantity(&conn, deck.id, "bolt-lea", "main", 4).unwrap();

        assert_eq!(
            claims(&conn, deck.id),
            vec![],
            "a zero-keeps row claims nothing"
        );
        assert_eq!(owned_of(&conn, deck.id, "bolt-lea", "main"), 0);
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
        add_card(&conn, deck.id, "serra-lea", "main", 1).unwrap();
        add_card(&conn, deck.id, "serra-8ed", "side", 1).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();

        let detail = get_deck(&conn, deck.id).unwrap().unwrap();
        let alpha = card_row(&detail, "serra-lea", "main");
        let eighth = card_row(&detail, "serra-8ed", "side");

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
            !card_row(&detail, "bolt-lea", "main").ever_uncommon,
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
            card_row(&detail, "bolt-lea", "main").unit_price_usd,
            Some(400.0),
            "nonfoil `usd` out of the blob, never `price_usd`"
        );
    }

    /// An orphaned deck card is still a row: name/set/cn from the entry, card facts NULL,
    /// owned 0 — listed, never dropped (the LEFT JOIN discipline).
    #[test]
    fn an_orphaned_deck_card_is_listed_from_its_denormalized_columns() {
        let conn = seeded();
        own(&conn, "bolt-jp", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-jp", "main", 4).unwrap();
        // What the next sync does to a printing Scryfall stopped publishing.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-jp'", [])
            .unwrap();

        let detail = get_deck(&conn, deck.id).unwrap().unwrap();

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
        add_card(&conn, deck.id, "ship", "commander", 1).unwrap();
        add_card(&conn, deck.id, "delver", "main", 4).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        add_card(&conn, deck.id, "island", "main", 20).unwrap();
        add_card(&conn, deck.id, "mystery", "main", 1).unwrap();

        let stored: Option<String> = conn
            .query_row("SELECT power FROM cards WHERE id = 'ship'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(
            stored.is_none(),
            "the column is empty until the next sync — that is the case under test"
        );

        let detail = get_deck(&conn, deck.id).unwrap().unwrap();

        let ship = card_row(&detail, "ship", "commander");
        assert_eq!(
            (ship.power.as_deref(), ship.toughness.as_deref()),
            (Some("6"), Some("5")),
            "a Vehicle WITH a P/T box can be a commander; unknown must never read as `no box`"
        );
        let delver = card_row(&detail, "delver", "main");
        assert_eq!(
            (delver.power.as_deref(), delver.toughness.as_deref()),
            (Some("1"), Some("1")),
            "the front face's, like every other per-face fallback in this app"
        );
        let bolt = card_row(&detail, "bolt-lea", "main");
        assert!(
            bolt.power.is_none() && bolt.toughness.is_none(),
            "and an Instant really has no P/T box — recovery is not invention"
        );

        // The gate, in the only way it can be observed: a land whose blob carries a P/T is
        // read as having none, because the blob is never opened. On a fully synced database
        // this is most of every deck — every land, instant, sorcery, enchantment and
        // ordinary artifact has both columns NULL *correctly*, and an ungated recovery would
        // inflate a 2 KB blob for each of them on every read, for ever, and find nothing.
        let island = card_row(&detail, "island", "main");
        assert!(
            island.power.is_none() && island.toughness.is_none(),
            "a Land's blob is never opened — no type that prints a P/T box, no lookup"
        );
        // …and an unknown type line is still looked at, because unknown is not `no`.
        let mystery = card_row(&detail, "mystery", "main");
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
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
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

    /// The claims follow every zone write, because a deck the user is editing is a deck
    /// whose availability is being asked about a second later — and the `maybe` pile
    /// reserves nothing at all.
    #[test]
    fn every_zone_write_recomputes_the_claims() {
        let conn = seeded();
        let entry = own(&conn, "bolt-lea", 4);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();

        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        assert_eq!(claims(&conn, deck.id), vec![(entry, 4)]);

        set_card_quantity(&conn, deck.id, "bolt-lea", "main", 1).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![(entry, 1)],
            "the stepper hands three copies back"
        );

        move_card(&conn, deck.id, "bolt-lea", "main", "maybe").unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![],
            "a maybe pile is a scratchpad, and a scratchpad reserves nothing"
        );

        move_card(&conn, deck.id, "bolt-lea", "maybe", "side").unwrap();
        assert_eq!(claims(&conn, deck.id), vec![(entry, 1)], "a sideboard does");

        set_card_quantity(&conn, deck.id, "bolt-lea", "side", 0).unwrap();
        assert_eq!(
            claims(&conn, deck.id),
            vec![],
            "and a removal releases the last"
        );
    }

    /// `missing_to_wishlist`: 4 wanted, 1 owned → an any-printing wish for 3 lands through
    /// the wishlist grain; run twice → the wish is 6 (the fold is `add_wish`'s contract, not
    /// double-counted rows); a fully-owned card adds nothing; `maybe` never counts.
    #[test]
    fn missing_to_wishlist_writes_any_printing_wishes_through_the_wishlist_grain() {
        let conn = seeded();
        own(&conn, "bolt-lea", 1);
        own(&conn, "serra-lea", 1);
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        add_card(&conn, deck.id, "bolt-lea", "main", 4).unwrap();
        add_card(&conn, deck.id, "serra-lea", "main", 1).unwrap();
        // The same oracle card as the main-deck Bolts, so a `maybe` pile that leaked into
        // the shortfall would change the number rather than merely add a row.
        add_card(&conn, deck.id, "bolt-jp", "maybe", 3).unwrap();

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

    /// A zone the schema knows and the allocator does not would sort last by accident. The
    /// two lists are deliberately in different orders — one is the DDL's, one is the order
    /// copies are handed out in — so only their contents can be compared.
    #[test]
    fn the_allocation_order_covers_every_zone_the_schema_knows() {
        assert_eq!(ZONE_PRIORITY.len(), ZONES.len());
        for zone in ZONES {
            assert!(
                ZONE_PRIORITY.contains(&zone),
                "`{zone}` has no place in the allocation order"
            );
        }
        assert_eq!(
            ZONE_PRIORITY[ZONE_PRIORITY.len() - 1],
            MAYBE,
            "the scratchpad is always last"
        );
    }

    #[test]
    fn deck_card_and_format_spec_json_use_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(DeckCardRow {
            id: 7,
            card_id: "bolt-lea".to_owned(),
            zone: "main".to_owned(),
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
            ever_uncommon: false,
            unit_price_usd: Some(400.0),
            owned_quantity: 3,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 7, "cardId": "bolt-lea", "zone": "main", "quantity": 4,
                "name": "Lightning Bolt", "setCode": "lea", "collectorNumber": "161",
                "lang": "en", "needsReview": null, "oracleId": "o1", "manaCost": "{R}",
                "cmc": 1.0, "typeLine": "Instant", "oracleText": "Deal 3 damage.",
                "colors": "R", "colorIdentity": "R",
                "legalities": "{\"modern\":\"legal\"}", "power": null, "toughness": null,
                "layout": "normal", "rarity": "common", "faces": null,
                "gameChanger": false, "everUncommon": false, "unitPriceUsd": 400.0,
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

        // The wrapper the command actually answers with.
        let deck = create_deck(&conn, &input("Burn", "modern")).unwrap();
        let detail = serde_json::to_value(get_deck(&conn, deck.id).unwrap().unwrap()).unwrap();
        assert_eq!(detail["deck"]["formatKey"], "modern");
        assert_eq!(detail["cards"], serde_json::json!([]));
    }
}
