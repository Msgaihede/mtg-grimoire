//! A deck's notebook: many notes per deck, each naming any number of cards — user schema v43,
//! [issue #447](https://github.com/Msgaihede/mtg-grimoire/issues/447).
//!
//! Shaped like [`crate::deck_meta`] and [`crate::deck_tokens`]: pure functions over a
//! `Connection`, testable without a Tauri app, wrapped in `async` commands that sit in one block
//! at the bottom behind `#[cfg(not(target_family = "wasm"))]`. Nothing above that block names
//! `tauri::` at all, which is what lets [`crate::web::route`] call the same functions the desktop
//! wrappers call.
//!
//! # A card reference is a pointer the note holds, never a place the note lives
//!
//! That is the issue's central sentence and it is the whole of the schema: `deck_note_cards`
//! hangs off `deck_notes`, so [`list_notes`] is the complete list **by construction** and a note
//! cannot become invisible by acquiring a card. It also decides what there is no command for —
//! nothing here answers *which cards in this deck have notes*, because the band already holds
//! every note and every note holds its oracle ids, so that set is a derivation TypeScript makes
//! out of a read it has already done.
//!
//! # It attaches by `oracle_id` and never by `card_id`
//!
//! [`crate::deck_tokens`]' argument verbatim: a printing id means nothing on the far device's
//! shelf, where an oracle id is Scryfall's and is the same everywhere. So a note survives the
//! reader swapping printing, a note written against the Theory list shows on the Live list, and
//! one note naming Lightning Bolt names it once however many copies the deck holds.
//!
//! **The reference is soft**, like every other card reference in a user table: nothing points at
//! `cards.id` with an enforced key, and an oracle id with no row in the corpus is answered with
//! **the oracle id itself** rather than with an error — see [`attachments_by_note`]. A note about
//! a card this device has not synced yet is still a note.
//!
//! # Every write here follows the same six steps
//!
//! Open [`Connection::unchecked_transaction`], **refuse in a sentence before touching anything**,
//! [`crate::deck::touch_deck`], the write, [`crate::deck_audit::record`],
//! [`crate::deck_undo::record_step`], commit, then re-read for the readback. Two details of that
//! are worth stating because they are easy to get wrong:
//!
//! * **No INSERT here names `sync_uid`.** The capture trigger mints it, and nothing in any
//!   `deck*.rs` has ever written that column.
//! * **History rides the existing `deck` kind.** [`crate::schema::AUDIT_KINDS`] stays at nine —
//!   the vocabulary is inside a `CHECK` and SQLite has no `ALTER … CHECK`, so a tenth word costs
//!   a full `deck_audit` rebuild, which would in turn fire `deck_undo`'s `ON DELETE CASCADE` and
//!   silently empty the undo stack on every real launch while leaving it intact in every test.
//!   The payload is `{"field": "note", "action": …, "note": <title>, "card": <name or null>}`.
//!
//! # What an undo step carries, and the rule that keeps it honest
//!
//! [`crate::deck_undo::Op::Notes`] has `restore`, `patch`, `delete` and `attachments`.
//! `restore` and `patch` are two lists for [`crate::deck_undo::Op::Categories`]' reason:
//! `deck_notes.id` is a rowid alias, so deleting the highest-numbered note and writing a new one
//! reuses the number, and a single list deciding by *is there a row at this id* would overwrite
//! the reader's newest note with the one they deleted.
//!
//! **`attachments` is the whole set for every note the op names, never a diff**, and this module
//! applies that rule even where nothing about the attachments changed. Two reasons, and the
//! second is the one that would otherwise be found the hard way:
//!
//! * The rows cascade away with the note, so restoring a note has to rebuild them.
//! * A note the op names has to be *named* — `attachments` alone cannot name a note whose set is
//!   **empty**, which is exactly the state undoing the first attach on a note has to reach. So
//!   every attach and detach step also carries the (unchanged) note row in `patch`, and every
//!   step carrying a `patch` carries that note's complete attachment set beside it.

use crate::schema::DECK_NOTE_CARD_GRAIN;
#[cfg(not(target_family = "wasm"))]
use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// What an adjustment to a note says when the id it names is not there — the asymmetry
/// [`crate::deck_meta::CATEGORY_GONE`] draws, one table over.
pub const NOTE_GONE: &str = "That note is not there any more.";

/// What a write says when the note it names belongs to a **different** deck.
///
/// `deck_notes.deck_id` is a real foreign key, so nothing in the DDL is wrong about a note of
/// another deck being edited through this deck's editor — the row exists and the key is
/// satisfied. This is the fence, and it is a sentence rather than a constraint failure because
/// a command parameter reaches it: [`crate::deck::set_folder`]'s rule.
pub const NOTE_WRONG_DECK: &str = "That note belongs to a different deck.";

/// What [`create_note`], [`attach_card`] and [`detach_card`] say when handed a blank oracle id.
///
/// Refused rather than skipped, because an attachment list arrives from a picker over the deck's
/// own cards: a blank in it means the caller lost track of what it was pointing at, and a note
/// that quietly named one card fewer than the reader chose is the failure nobody reports.
pub const NO_ORACLE_ID: &str = "A note attaches to a card, so it needs one.";

/// The five actions a `note` history row records, plus the sixth this module writes and the
/// spec's sentence list does not name.
///
/// `create | edit | delete | attach | detach` are the five `auditText.ts` words; `reorder` is
/// here because **a deck write that records nothing is the bug `deck_audit` exists to prevent**,
/// and a reorder is a deck write. It falls through that renderer's default arm to
/// *Changed the deck*, which is true of every deck edit and therefore never a failure — the
/// standing this module inherits rather than invents.
const ACTION_REORDER: &str = "reorder";

/// The `WHERE` [`attachments_by_note`] takes for a whole deck's notes.
///
/// A literal from this module and never a caller's string, so the `format!` that splices it
/// carries no injection risk — [`crate::deck_meta::owning_deck`]'s arrangement.
const NOTES_OF_DECK: &str = "n.deck_id = ?1";

/// The same for one note. Named on `deck_note_cards` rather than on `deck_notes`, so the join to
/// the parent is still what scopes the row and the two filters read the same statement.
const ONE_NOTE: &str = "nc.note_id = ?1";

/// Every column of a [`DeckNoteRow`] but the attachments, which are a second statement.
const NOTE_SELECT: &str =
    "SELECT id, deck_id, title, body, sort_order, created_at, updated_at FROM deck_notes";

/// One note of one deck, with the cards it names already resolved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckNoteRow {
    pub id: i64,
    pub deck_id: i64,
    /// **May be empty, and an empty one is not a missing one.** What the list prints when it is
    /// blank is the body's first line, computed at render and never stored: a stored derivation
    /// would go stale the moment the body was edited and there is no writer that could notice.
    pub title: String,
    /// CommonMark, in the narrowed dialect `src/features/decks/noteMarkdown.ts` pins. Never HTML
    /// and never ProseMirror JSON — a body this crate can hand to anything as text is what keeps
    /// a renderer out of Rust, and `src/features/transfer/__golden__` is the fence that exists to
    /// make a second implementation of a TypeScript one go red.
    pub body: String,
    pub sort_order: i64,
    /// The oracle ids this note names, and the card name for each — so no reader has to make a
    /// second round trip to print a submenu. **Empty is the ordinary case.**
    pub cards: Vec<DeckNoteCard>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One card a note names.
///
/// `name` is a **convenience and not a key**: it is resolved from the corpus at read time, and an
/// oracle id the corpus has never heard of is named by the id itself rather than by nothing. Two
/// devices that synced on different days can honestly disagree about it, which is why nothing is
/// ever matched on it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckNoteCard {
    pub oracle_id: String,
    pub name: String,
}

/// One note naming one card, seen from the **card** rather than from a deck — [`notes_for_card`]'s
/// row, and the one read in this module that is not deck-scoped.
///
/// It carries the deck's id and name because that is the whole of what makes the answer readable:
/// a card opened from the collection, from search or from another deck is asking *what have I
/// written about this card*, and a list of paragraphs with no deck against them answers a
/// different question.
///
/// **No `cards` and no `sortOrder`.** A note's other attachments are a fact about that note in its
/// own deck's band, and the order two notes in two different decks are in is not a fact at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardNoteRow {
    pub id: i64,
    pub deck_id: i64,
    pub deck_name: String,
    pub title: String,
    pub body: String,
}

fn note_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckNoteRow> {
    Ok(DeckNoteRow {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        title: r.get(2)?,
        body: r.get(3)?,
        sort_order: r.get(4)?,
        // Filled by the second statement — see [`list_notes`].
        cards: Vec::new(),
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

/// An oracle id good enough to attach, refused in a sentence rather than stored blank.
///
/// [`crate::deck_meta::valid_name`]'s discipline: `deck_note_cards.oracle_id` is `NOT NULL` with
/// no `CHECK`, so `''` would be a perfectly legal row naming no card at all — and it would take
/// a slot on [`DECK_NOTE_CARD_GRAIN`](crate::schema::DECK_NOTE_CARD_GRAIN), so the *second* blank
/// would silently fold into the first.
fn valid_oracle_id(oracle_id: &str) -> Result<&str, String> {
    let oracle_id = oracle_id.trim();
    (!oracle_id.is_empty())
        .then_some(oracle_id)
        .ok_or_else(|| NO_ORACLE_ID.to_owned())
}

/// The note's title, having established it exists and belongs to `deck_id`.
///
/// Two refusals rather than one, because "gone" and "not yours" are different things to be told
/// and a stale editor can produce either — [`crate::deck_meta::owning_deck`] draws the same
/// distinction for a category's move target.
fn require_note(conn: &Connection, deck_id: i64, id: i64) -> Result<String, String> {
    let row: Option<(i64, String)> = conn
        .query_row(
            "SELECT deck_id, title FROM deck_notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match row {
        None => Err(NOTE_GONE.to_owned()),
        Some((owner, _)) if owner != deck_id => Err(NOTE_WRONG_DECK.to_owned()),
        Some((_, title)) => Ok(title),
    }
}

/// Every attachment matching one filter, grouped by note.
///
/// **This is the second of [`list_notes`]' two statements, and it is why there is no N+1.** One
/// query answers every attachment of every note in the deck; the caller zips them onto the notes
/// it already read.
///
/// Three things about the SQL:
///
/// * **`LEFT JOIN cards`, so a card the corpus has never heard of is still an attachment.** The
///   reference is soft like every other card reference in a user table, and a note that refused
///   to load because a printing has not been synced yet would be a note the reader cannot reach.
/// * **`coalesce(min(c.name), nc.oracle_id)` — the id is the fallback name.** An unknown oracle id
///   answers itself, which is unlovely and legible, where a `NULL` name would have to be a
///   nullable field every reader then has to branch on.
/// * **`GROUP BY` is load-bearing and is not a tidiness.** `cards` holds one row per *printing*,
///   so the join multiplies an attachment by however many printings that oracle card has —
///   Lightning Bolt alone would put the same card on a note dozens of times. `min()` collapses
///   them to the one name every printing of an oracle card shares.
fn attachments_by_note(
    conn: &Connection,
    filter: &str,
    id: i64,
) -> Result<HashMap<i64, Vec<DeckNoteCard>>, String> {
    let sql = format!(
        "SELECT nc.note_id, nc.oracle_id, coalesce(min(c.name), nc.oracle_id)
           FROM deck_note_cards nc
           JOIN deck_notes n ON n.id = nc.note_id
           LEFT JOIN cards c ON c.oracle_id = nc.oracle_id
          WHERE {filter}
          GROUP BY nc.note_id, nc.oracle_id
          ORDER BY nc.note_id, coalesce(min(c.name), nc.oracle_id), nc.oracle_id"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                DeckNoteCard {
                    oracle_id: r.get(1)?,
                    name: r.get(2)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out: HashMap<i64, Vec<DeckNoteCard>> = HashMap::new();
    for row in rows {
        let (note_id, card) = row.map_err(|e| e.to_string())?;
        out.entry(note_id).or_default().push(card);
    }
    Ok(out)
}

/// One note by id, with its cards — every write's readback.
fn read_note(conn: &Connection, id: i64) -> Result<Option<DeckNoteRow>, String> {
    let note = conn
        .query_row(
            &format!("{NOTE_SELECT} WHERE id = ?1"),
            params![id],
            note_from,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(mut note) = note else {
        return Ok(None);
    };
    note.cards = attachments_by_note(conn, ONE_NOTE, id)?
        .remove(&id)
        .unwrap_or_default();
    Ok(Some(note))
}

/// Every note on one deck, in display order, with its cards — **two statements, never N+1**.
///
/// A pure read: an unknown deck answers an empty list rather than [`crate::deck::GONE`], which is
/// [`crate::deck_meta::list_categories`]' standing and for its reason — a list is what the page
/// draws, and a deck that has gone will be reported by the read that is *about* the deck.
pub fn list_notes(conn: &Connection, deck_id: i64) -> Result<Vec<DeckNoteRow>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "{NOTE_SELECT} WHERE deck_id = ?1 ORDER BY sort_order, id"
        ))
        .map_err(|e| e.to_string())?;
    let mut notes = stmt
        .query_map(params![deck_id], note_from)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<DeckNoteRow>>>()
        .map_err(|e| e.to_string())?;
    let mut cards = attachments_by_note(conn, NOTES_OF_DECK, deck_id)?;
    for note in &mut notes {
        note.cards = cards.remove(&note.id).unwrap_or_default();
    }
    Ok(notes)
}

/// The card's name for a history row, or the oracle id when the corpus has no row for it.
///
/// [`attachments_by_note`]'s `min(c.name)` spelled again for one id, and deliberately the same
/// rule: the drawer and the band must not name one card two ways. `min()` always answers a row,
/// so the `Option` here is the aggregate's `NULL` rather than a missing row.
fn card_name_for(conn: &Connection, oracle_id: &str) -> Result<String, String> {
    let name: Option<String> = conn
        .query_row(
            "SELECT min(name) FROM cards WHERE oracle_id = ?1",
            params![oracle_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(name.unwrap_or_else(|| oracle_id.to_owned()))
}

/// One `note`-kind history row, with the four constants every caller here would otherwise repeat.
///
/// A note change is about no card *list* and moves no copies, so `card_id` is NULL and `delta` is
/// 0 at every call site — the payload's `action` is the whole of what differs. `card` is the
/// attached card's **name** and not its id, for [`crate::deck_audit::DeckAuditEntry::card_name`]'s
/// reason: a history line that can only say `o-3f2a…` once the corpus moves is not a history.
fn record_note(
    tx: &Connection,
    deck_id: i64,
    action: &str,
    note: Option<&str>,
    card: Option<&str>,
) -> Result<i64, String> {
    crate::deck_audit::record(
        tx,
        deck_id,
        crate::deck_audit::DECK_LEVEL,
        crate::deck_audit::DECK,
        None,
        &json!({ "field": "note", "action": action, "note": note, "card": card }),
        0,
    )
}

/// One undo step for a note write, with the two `Step::new` lines every caller here would
/// otherwise repeat — [`crate::deck_meta`]'s `record_category_step`, one module over.
fn record_note_step(
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

/// The notes named by `ids`, as a step carries them. An id with no row contributes nothing, which
/// is what a delete's **redo** side needs: it asks about a note that will not be there.
fn step_rows(tx: &Connection, ids: &[i64]) -> Result<Vec<crate::deck_undo::NoteRow>, String> {
    let mut stmt = tx
        .prepare("SELECT id, deck_id, title, body, sort_order FROM deck_notes WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let row = stmt
            .query_row(params![id], |r| {
                Ok(crate::deck_undo::NoteRow {
                    id: r.get(0)?,
                    deck_id: r.get(1)?,
                    title: r.get(2)?,
                    body: r.get(3)?,
                    sort_order: r.get(4)?,
                })
            })
            .optional()
            .map_err(|e| e.to_string())?;
        out.extend(row);
    }
    Ok(out)
}

/// The **complete** `deck_note_cards` set for the notes named by `ids` — see this module's header
/// for why every step carries the whole set rather than the rows that moved.
fn step_attachments(
    tx: &Connection,
    ids: &[i64],
) -> Result<Vec<crate::deck_undo::NoteCard>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT note_id, oracle_id FROM deck_note_cards
              WHERE note_id = ?1 ORDER BY oracle_id",
        )
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for id in ids {
        let rows = stmt
            .query_map(params![id], |r| {
                Ok(crate::deck_undo::NoteCard {
                    note_id: r.get(0)?,
                    oracle_id: r.get(1)?,
                })
            })
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        out.extend(rows);
    }
    Ok(out)
}

/// One attachment, or nothing if the note already names that card.
///
/// **`DECK_NOTE_CARD_GRAIN` interpolated and never retyped**: an `ON CONFLICT` target that does
/// not match `idx_deck_note_cards_grain` verbatim is a runtime error at the first write rather
/// than a compile error, so the index and this statement read one constant —
/// [`crate::deck_tokens::set_token_override`]'s rule.
///
/// **`DO NOTHING` and not `INSERT OR IGNORE`.** The second swallows *every* constraint failure,
/// including a `note_id` whose note has gone; this one names the collision it means to forgive.
fn attach_row(tx: &Connection, note_id: i64, oracle_id: &str) -> Result<usize, String> {
    tx.execute(
        &format!(
            "INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (?1, ?2, unixepoch(), unixepoch())
             ON CONFLICT ({DECK_NOTE_CARD_GRAIN}) DO NOTHING"
        ),
        params![note_id, oracle_id],
    )
    .map_err(|e| e.to_string())
}

/// Write a note, with however many cards it names.
///
/// A blank `title` is legal and reads as the body's first line at render — see
/// [`DeckNoteRow::title`]. `oracle_ids` is deduplicated here as well as by the grain, so a picker
/// that sends one card twice writes one row and the readback says so.
///
/// **Every refusal fires before the transaction opens**, which is why the blank-id fence is above
/// `unchecked_transaction` and not inside the loop: a note that had already been inserted when
/// the fourth of its cards turned out to be blank would roll back anyway, but the reader would
/// have been told about a note rather than about the card.
pub fn create_note(
    conn: &Connection,
    deck_id: i64,
    title: &str,
    body: &str,
    oracle_ids: &[String],
) -> Result<DeckNoteRow, String> {
    let title = title.trim();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut cards: Vec<&str> = Vec::with_capacity(oracle_ids.len());
    for oracle_id in oracle_ids {
        let oracle_id = valid_oracle_id(oracle_id)?;
        if seen.insert(oracle_id) {
            cards.push(oracle_id);
        }
    }

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    let next_order: i64 = tx
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM deck_notes WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // **No `sync_uid` in this INSERT and there must never be one** — the capture trigger mints it,
    // and nothing in any `deck*.rs` has ever written that column.
    let id: i64 = tx
        .query_row(
            "INSERT INTO deck_notes
                (deck_id, title, body, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, title, body, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    for oracle_id in cards {
        attach_row(&tx, id, oracle_id)?;
    }
    let audit_id = record_note(&tx, deck_id, "create", Some(title), None)?;
    // The undo side deletes; its attachments go with it through
    // `deck_note_cards.note_id ON DELETE CASCADE`, so there is nothing to name. The redo side has
    // to rebuild both, which is what a whole-set `attachments` is for.
    record_note_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: vec![],
            delete: vec![id],
            attachments: vec![],
        }],
        vec![crate::deck_undo::Op::Notes {
            restore: step_rows(&tx, &[id])?,
            patch: vec![],
            delete: vec![],
            attachments: step_attachments(&tx, &[id])?,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_note(conn, id)?.ok_or_else(|| NOTE_GONE.to_owned())
}

/// Change a note's title, its body, or both. An absent field is *leave it alone*.
///
/// **`Some("")` really empties the column**, and that is the one thing the old `decks.notes` could
/// never do: `update_deck` writes `notes = coalesce(?8, notes)`, so no patch could ever clear it
/// and only `deck_undo::apply` — which writes the raw value — could. A multi-note model needs a
/// real empty, so the `coalesce` here is over the *bound* value and a bound `''` is a value.
pub fn update_note(
    conn: &Connection,
    deck_id: i64,
    id: i64,
    title: Option<&str>,
    body: Option<&str>,
) -> Result<DeckNoteRow, String> {
    let title = title.map(str::trim);
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    require_note(&tx, deck_id, id)?;
    crate::deck::touch_deck(&tx, deck_id)?;
    let before = step_rows(&tx, &[id])?;
    tx.execute(
        "UPDATE deck_notes
            SET title = coalesce(?2, title), body = coalesce(?3, body),
                updated_at = unixepoch()
          WHERE id = ?1",
        params![id, title, body],
    )
    .map_err(|e| e.to_string())?;
    // The title *after* the edit, which is what the drawer names the note by. `auditText` does not
    // print it for an edit — "a note is a paragraph nobody wants in a one-line history", the rule
    // `Edited the deck notes` established and this inherits — but it is recorded, because a row
    // that could not say which note changed would be a row nobody can read.
    let after = step_rows(&tx, &[id])?;
    let named = after.first().map(|r| r.title.clone()).unwrap_or_default();
    let audit_id = record_note(&tx, deck_id, "edit", Some(&named), None)?;
    // `patch`, never `restore`: the row is there and its columns go back. A restore would insert a
    // second note the moment its id had been reused — the two lists are two intents.
    //
    // The attachment set is unchanged and is carried on **both** sides anyway, which is this
    // module's rule: an op that names a note without its set is an op that cannot say whether the
    // set is empty on purpose.
    let attachments = step_attachments(&tx, &[id])?;
    record_note_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: before,
            delete: vec![],
            attachments: attachments.clone(),
        }],
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: after,
            delete: vec![],
            attachments,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_note(conn, id)?.ok_or_else(|| NOTE_GONE.to_owned())
}

/// Delete a note. Its attachments go with it — `deck_note_cards.note_id` is `ON DELETE CASCADE`.
///
/// **An id that resolves to nothing is refused rather than reported a success**, which is
/// [`crate::deck_meta::delete_category`]'s answer and not [`crate::deck_meta::delete_label`]'s.
/// The difference is scope: a label is app-wide, so "that label should not exist" is satisfied by
/// its already not existing, where a note is *of a deck* and a delete naming another deck's note
/// has to be refused whatever else is true — and having refused that, refusing the missing one too
/// is what keeps one sentence per mistake.
pub fn delete_note(conn: &Connection, deck_id: i64, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let title = require_note(&tx, deck_id, id)?;
    crate::deck::touch_deck(&tx, deck_id)?;
    // Both reads before the DELETE: afterwards the note is gone and the CASCADE has taken the
    // attachments, and this is the only place either fact still exists.
    let before = step_rows(&tx, &[id])?;
    let attachments = step_attachments(&tx, &[id])?;
    tx.execute("DELETE FROM deck_notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    let audit_id = record_note(&tx, deck_id, "delete", Some(&title), None)?;
    record_note_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Notes {
            restore: before,
            patch: vec![],
            delete: vec![],
            attachments,
        }],
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: vec![],
            delete: vec![id],
            attachments: vec![],
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Name one more card on a note.
///
/// **Attaching a card the note already names is a success that writes nothing** — no row, no
/// history, no step and no `updated_at`. The grain would have folded the row anyway; short-
/// circuiting is what keeps the drawer from carrying a line about a change that did not happen,
/// which is `import::commit_import`'s rule about a removal that removed nothing.
pub fn attach_card(
    conn: &Connection,
    deck_id: i64,
    note_id: i64,
    oracle_id: &str,
) -> Result<DeckNoteRow, String> {
    let oracle_id = valid_oracle_id(oracle_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let title = require_note(&tx, deck_id, note_id)?;
    let already: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM deck_note_cards WHERE note_id = ?1 AND oracle_id = ?2)",
            params![note_id, oracle_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if already {
        drop(tx);
        return read_note(conn, note_id)?.ok_or_else(|| NOTE_GONE.to_owned());
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    let note = step_rows(&tx, &[note_id])?;
    let before = step_attachments(&tx, &[note_id])?;
    attach_row(&tx, note_id, oracle_id)?;
    let card = card_name_for(&tx, oracle_id)?;
    let audit_id = record_note(&tx, deck_id, "attach", Some(&title), Some(&card))?;
    // The note row rides in `patch` on both sides even though none of its columns moved: it is
    // what **names** the note, and `attachments` alone cannot name one whose set is empty — which
    // is exactly the state undoing the first attach on a note has to reach.
    record_note_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: note.clone(),
            delete: vec![],
            attachments: before,
        }],
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: note,
            delete: vec![],
            attachments: step_attachments(&tx, &[note_id])?,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_note(conn, note_id)?.ok_or_else(|| NOTE_GONE.to_owned())
}

/// Stop a note naming a card. The note stays in the list — that is the issue's central
/// requirement, and it is true by construction here rather than by a rule.
///
/// **A card the note does not name is a success that writes nothing**, [`attach_card`]'s
/// short-circuit from the other end.
pub fn detach_card(
    conn: &Connection,
    deck_id: i64,
    note_id: i64,
    oracle_id: &str,
) -> Result<DeckNoteRow, String> {
    let oracle_id = valid_oracle_id(oracle_id)?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let title = require_note(&tx, deck_id, note_id)?;
    let note = step_rows(&tx, &[note_id])?;
    let before = step_attachments(&tx, &[note_id])?;
    if !before.iter().any(|c| c.oracle_id == oracle_id) {
        drop(tx);
        return read_note(conn, note_id)?.ok_or_else(|| NOTE_GONE.to_owned());
    }
    crate::deck::touch_deck(&tx, deck_id)?;
    // The card's name comes out of the corpus rather than out of the row being deleted, so the
    // order is not load-bearing here the way `delete_note`'s two reads are — but the sentence the
    // drawer keeps is the one thing about this press that outlives it, so it is read either way.
    let card = card_name_for(&tx, oracle_id)?;
    tx.execute(
        "DELETE FROM deck_note_cards WHERE note_id = ?1 AND oracle_id = ?2",
        params![note_id, oracle_id],
    )
    .map_err(|e| e.to_string())?;
    let audit_id = record_note(&tx, deck_id, "detach", Some(&title), Some(&card))?;
    record_note_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: note.clone(),
            delete: vec![],
            attachments: before,
        }],
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: note,
            delete: vec![],
            attachments: step_attachments(&tx, &[note_id])?,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    read_note(conn, note_id)?.ok_or_else(|| NOTE_GONE.to_owned())
}

/// Write `sort_order` from position in `ids`.
///
/// An id that does not belong to `deck_id` — another deck's, or gone entirely — matches no row in
/// the `WHERE id = ?1 AND deck_id = ?2` guard and is **silently skipped** rather than refusing the
/// whole reorder over one stale entry. That is [`crate::deck_meta::reorder_categories`]' answer
/// and for its reason: this write is scoped to a deck, so a foreign id is a row that was never in
/// the list being ordered.
///
/// The step carries **every** note of the deck on both sides, because every one of them moved:
/// there is no "from" and no "to" that is about one note, and the history row names none for the
/// same reason.
pub fn reorder_notes(conn: &Connection, deck_id: i64, ids: &[i64]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    let all: Vec<i64> = tx
        .prepare("SELECT id FROM deck_notes WHERE deck_id = ?1 ORDER BY id")
        .and_then(|mut stmt| {
            stmt.query_map(params![deck_id], |r| r.get(0))?
                .collect::<rusqlite::Result<Vec<i64>>>()
        })
        .map_err(|e| e.to_string())?;
    let before = step_rows(&tx, &all)?;
    for (order, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE deck_notes SET sort_order = ?3, updated_at = unixepoch()
              WHERE id = ?1 AND deck_id = ?2",
            params![id, deck_id, order as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    let audit_id = record_note(&tx, deck_id, ACTION_REORDER, None, None)?;
    let attachments = step_attachments(&tx, &all)?;
    record_note_step(
        &tx,
        audit_id,
        deck_id,
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: before,
            delete: vec![],
            attachments: attachments.clone(),
        }],
        vec![crate::deck_undo::Op::Notes {
            restore: vec![],
            patch: step_rows(&tx, &all)?,
            delete: vec![],
            attachments,
        }],
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// Every note in **every** deck that names this card.
///
/// The one read here that is not deck-scoped, and it is what the card modal's `Notes` row asks. A
/// card opened from the collection, from search or from another deck still answers *what have I
/// written about this card*, which is the question that modal exists to answer completely.
///
/// **Ordered by deck and then by the note's own position**, so two notes from one deck arrive
/// together and in the order that deck's band draws them. `n.id` breaks the last tie, because a
/// list that reordered itself between two opens for no visible reason is the failure a stable sort
/// exists to prevent.
pub fn notes_for_card(conn: &Connection, oracle_id: &str) -> Result<Vec<CardNoteRow>, String> {
    let oracle_id = oracle_id.trim();
    if oracle_id.is_empty() {
        // A printing with no `oracle_id` is a fence around the type rather than a card anybody can
        // find — 0 of 116 590 live rows are missing one — but the *page* can still hold a null,
        // and `oracle_id = ''` would match every blank attachment in the database at once.
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.deck_id, d.name, n.title, n.body
               FROM deck_note_cards nc
               JOIN deck_notes n ON n.id = nc.note_id
               JOIN decks d ON d.id = n.deck_id
              WHERE nc.oracle_id = ?1
              ORDER BY d.name, n.deck_id, n.sort_order, n.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![oracle_id], |r| {
            Ok(CardNoteRow {
                id: r.get(0)?,
                deck_id: r.get(1)?,
                deck_name: r.get(2)?,
                title: r.get(3)?,
                body: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a user's problem, the
/// write itself answers [`crate::db::BUSY`] when the database is busy.
#[cfg(not(target_family = "wasm"))]
fn unfinished(e: tauri::Error) -> String {
    format!("the deck's notes could not be written: {e}")
}

/// The Notes band's own read. **Read-only connection**, like every list in the deck domain.
///
/// **`generate_handler!` names a command after its last path segment**, so
/// `deck_notes::deck_notes` registers as `deck_notes` — the module and the read wear the same
/// name on purpose, exactly as `deck_tokens::deck_tokens` does, because the wire name is the one
/// `src/lib/ipc.ts` invokes and `deck_notes_list` would be a second thing to remember.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_notes(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<DeckNoteRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_notes(&crate::sync::lock_db_read(&state), deck_id)
    })
    .await
    .map_err(|e| format!("the deck's notes could not be read: {e}"))?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_note_create(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    title: String,
    body: String,
    oracle_ids: Vec<String>,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            create_note(c, deck_id, &title, &body, &oracle_ids)
        })
    })
    .await
    .map_err(unfinished)?
}

/// **Both fields are optional and an absent one means *leave it*.** Tauri fills a missing
/// `Option` argument with `None`, so a page editing only the body sends only the body.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_note_update(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    id: i64,
    title: Option<String>,
    body: Option<String>,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            update_note(c, deck_id, id, title.as_deref(), body.as_deref())
        })
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_note_delete(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| delete_note(c, deck_id, id))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_note_attach(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    note_id: i64,
    oracle_id: String,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| attach_card(c, deck_id, note_id, &oracle_id))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_note_detach(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    note_id: i64,
    oracle_id: String,
) -> Result<DeckNoteRow, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| detach_card(c, deck_id, note_id, &oracle_id))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_note_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    ids: Vec<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| reorder_notes(c, deck_id, &ids))
    })
    .await
    .map_err(unfinished)?
}

/// **Read-only**, and the one command in this module with no deck id at all — see
/// [`notes_for_card`].
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn card_notes(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
) -> Result<Vec<CardNoteRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        notes_for_card(&crate::sync::lock_db_read(&state), &oracle_id)
    })
    .await
    .map_err(|e| format!("this card's notes could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::tests::deck;

    /// Two decks over the real user schema, and **user tables only** — nothing here writes to
    /// `cards` or `sync_meta`, which belong to the sync, so every card name these tests see comes
    /// out of [`attachments_by_note`]'s fallback rather than out of a hand-written corpus row.
    ///
    /// [`crate::schema::memory_pair`] rather than a bare in-memory connection: the attachment read
    /// joins `cards`, which lives in the attached corpus, and a single-file fixture cannot see a
    /// statement that landed in the wrong database.
    fn deck_db() -> (Connection, i64, i64) {
        let conn = crate::schema::memory_pair();
        let burn = deck(&conn, "Burn");
        let storm = deck(&conn, "Storm");
        (conn, burn, storm)
    }

    fn audit_actions(conn: &Connection, deck_id: i64) -> Vec<String> {
        conn.prepare("SELECT payload FROM deck_audit WHERE deck_id = ?1 ORDER BY id")
            .unwrap()
            .query_map(params![deck_id], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .map(|p| {
                serde_json::from_str::<serde_json::Value>(&p).unwrap()["action"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect()
    }

    fn steps(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM deck_undo", [], |r| r.get(0))
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

    /// `unixepoch()` has one-second resolution, so every "did this touch the deck" test moves the
    /// clock back rather than waiting on it — `deck.rs`'s own trick.
    fn backdate(conn: &Connection, deck_id: i64) {
        conn.execute(
            "UPDATE decks SET updated_at = 0 WHERE id = ?1",
            params![deck_id],
        )
        .unwrap();
    }

    /// **The issue's central requirement**: a note that names a card is still in the notes list.
    #[test]
    fn a_note_survives_being_attached_to_a_card() {
        let (conn, burn, _) = deck_db();
        let note =
            create_note(&conn, burn, "Mana", "Fourteen sources.", &["o-bolt".into()]).unwrap();
        assert_eq!(note.cards.len(), 1);

        let all = list_notes(&conn, burn).unwrap();
        assert_eq!(all.len(), 1, "a note with a card is still a note");
        assert_eq!(all[0].id, note.id);
        assert_eq!(all[0].cards[0].oracle_id, "o-bolt");
    }

    /// The grain folds it — `idx_deck_note_cards_grain` — and the command short-circuits before
    /// the grain is even asked, so a redundant press writes no history either.
    #[test]
    fn attaching_the_same_card_twice_is_not_an_error_and_adds_no_row() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "t", "b", &[]).unwrap();
        attach_card(&conn, burn, note.id, "o-bolt").unwrap();
        let again = attach_card(&conn, burn, note.id, "o-bolt").unwrap();
        assert_eq!(again.cards.len(), 1, "the grain let a duplicate through");
        assert_eq!(
            audit_actions(&conn, burn),
            vec!["create", "attach"],
            "the second press changed nothing and must record nothing"
        );
    }

    #[test]
    fn a_note_belonging_to_another_deck_is_refused_in_words() {
        let (conn, burn, storm) = deck_db();
        let note = create_note(&conn, burn, "t", "b", &[]).unwrap();

        let err = update_note(&conn, storm, note.id, Some("x"), None).unwrap_err();
        assert!(
            err.contains("note"),
            "the refusal did not name what was wrong: {err}"
        );
        assert_eq!(err, NOTE_WRONG_DECK);

        // And the write really did not happen.
        assert_eq!(list_notes(&conn, burn).unwrap()[0].title, "t");
        assert!(list_notes(&conn, storm).unwrap().is_empty());
    }

    /// An id nobody answers to is the other refusal, and it is a different sentence.
    #[test]
    fn a_note_that_is_not_there_is_refused_by_its_own_name() {
        let (conn, burn, _) = deck_db();
        assert_eq!(
            update_note(&conn, burn, 404, Some("x"), None).unwrap_err(),
            NOTE_GONE
        );
        assert_eq!(delete_note(&conn, burn, 404).unwrap_err(), NOTE_GONE);
        assert_eq!(
            attach_card(&conn, burn, 404, "o-bolt").unwrap_err(),
            NOTE_GONE
        );
    }

    #[test]
    fn deleting_a_note_records_history_and_a_reversible_step() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "Mana", "b", &["o-bolt".into()]).unwrap();
        let before = steps(&conn);

        delete_note(&conn, burn, note.id).unwrap();

        assert!(list_notes(&conn, burn).unwrap().is_empty());
        let kinds: Vec<String> = conn
            .prepare("SELECT kind FROM deck_audit WHERE deck_id = ?1 ORDER BY id")
            .unwrap()
            .query_map(params![burn], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            kinds.last().map(String::as_str),
            Some("deck"),
            "notes ride the existing `deck` kind — AUDIT_KINDS stays at nine"
        );
        assert!(steps(&conn) > before, "the delete left nothing to undo");

        // The attachment went with it, through `deck_note_cards.note_id ON DELETE CASCADE`.
        let orphans: i64 = conn
            .query_row("SELECT count(*) FROM deck_note_cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(orphans, 0);
    }

    /// The step a delete files has to be able to put the cards back, because the CASCADE took
    /// them: the row itself is not enough.
    #[test]
    fn the_delete_step_carries_the_cards_the_cascade_took() {
        let (conn, burn, _) = deck_db();
        let note = create_note(
            &conn,
            burn,
            "Mana",
            "b",
            &["o-bolt".into(), "o-ritual".into()],
        )
        .unwrap();
        delete_note(&conn, burn, note.id).unwrap();

        let step: String = conn
            .query_row(
                // `audit_id` and not `id`: `deck_undo`'s primary key *is* the audit row it
                // reverses, so there is no separate rowid to order by. Ordering by it is still
                // newest-first, because the audit ids it points at are handed out in order.
                "SELECT step FROM deck_undo WHERE deck_id = ?1 ORDER BY audit_id DESC LIMIT 1",
                params![burn],
                |r| r.get(0),
            )
            .unwrap();
        let step: serde_json::Value = serde_json::from_str(&step).unwrap();
        let attachments = &step["undo"][0]["attachments"];
        assert_eq!(
            attachments.as_array().map(Vec::len),
            Some(2),
            "the undo side has to rebuild the whole set: {step}"
        );
        assert_eq!(step["undo"][0]["restore"][0]["title"], json!("Mana"));
        assert_eq!(step["redo"][0]["delete"][0], json!(note.id));
    }

    #[test]
    fn card_notes_answers_across_every_deck() {
        let (conn, burn, storm) = deck_db();
        create_note(&conn, burn, "In burn", "b", &["o-bolt".into()]).unwrap();
        create_note(&conn, storm, "In storm", "b", &["o-bolt".into()]).unwrap();
        create_note(&conn, storm, "Elsewhere", "b", &["o-ritual".into()]).unwrap();

        let found = notes_for_card(&conn, "o-bolt").unwrap();
        assert_eq!(found.len(), 2);
        assert!(found.iter().any(|n| n.deck_id == storm));
        assert!(found.iter().any(|n| n.deck_name == "Burn"));
        assert!(
            found.iter().all(|n| n.title != "Elsewhere"),
            "a note about another card must not be in this card's list"
        );
    }

    /// A card the page has no oracle id for must not match every blank attachment there is.
    #[test]
    fn card_notes_answers_nothing_for_a_blank_oracle_id() {
        let (conn, burn, _) = deck_db();
        create_note(&conn, burn, "In burn", "b", &["o-bolt".into()]).unwrap();
        assert!(notes_for_card(&conn, "").unwrap().is_empty());
        assert!(notes_for_card(&conn, "   ").unwrap().is_empty());
    }

    /// **The soft reference, from the read side.** [`deck_db`] seeds user tables only, so every
    /// oracle id in it is one the corpus has never heard of — and a note about a card this device
    /// has not synced yet is still a note.
    #[test]
    fn a_card_the_corpus_does_not_know_is_named_by_its_oracle_id() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "Mana", "b", &["o-bolt".into()]).unwrap();
        assert_eq!(note.cards[0].name, "o-bolt");
        assert_eq!(note.cards[0].oracle_id, "o-bolt");
    }

    /// One statement per attachment would multiply a card by its printings; the `GROUP BY` is what
    /// stops it. Asserted with a real second printing of one oracle card in the corpus half of the
    /// pair — `cards` there is the *corpus*, which no user table owns.
    #[test]
    fn a_card_with_many_printings_is_one_attachment() {
        let (conn, burn, _) = deck_db();
        for (id, cn) in [
            ("bolt-lea", "161"),
            ("bolt-m10", "146"),
            ("bolt-4ed", "209"),
        ] {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                                     layout, raw)
                 VALUES (?1, 'o-bolt', 'Lightning Bolt', 'x', ?2, 'en', 'normal', '{}')",
                params![id, cn],
            )
            .unwrap();
        }
        let note = create_note(&conn, burn, "Mana", "b", &["o-bolt".into()]).unwrap();
        assert_eq!(note.cards.len(), 1, "three printings, one card");
        assert_eq!(note.cards[0].name, "Lightning Bolt");
    }

    /// A note attaching two cards, and the list answering both — the issue's *"a note may have any
    /// number of attached cards"*.
    #[test]
    fn a_note_may_name_any_number_of_cards_and_a_repeat_is_one() {
        let (conn, burn, _) = deck_db();
        let note = create_note(
            &conn,
            burn,
            "The engine",
            "b",
            &["o-bolt".into(), "o-ritual".into(), "o-bolt".into()],
        )
        .unwrap();
        assert_eq!(note.cards.len(), 2, "the repeat folded");
        let ids: Vec<&str> = note.cards.iter().map(|c| c.oracle_id.as_str()).collect();
        assert_eq!(ids, vec!["o-bolt", "o-ritual"]);
    }

    #[test]
    fn a_blank_oracle_id_is_refused_before_anything_is_written() {
        let (conn, burn, _) = deck_db();
        backdate(&conn, burn);

        assert_eq!(
            create_note(&conn, burn, "t", "b", &["  ".into()]).unwrap_err(),
            NO_ORACLE_ID
        );
        assert!(list_notes(&conn, burn).unwrap().is_empty());
        assert_eq!(
            updated_at(&conn, burn),
            0,
            "a refused write must not move the gallery's sort"
        );

        let note = create_note(&conn, burn, "t", "b", &[]).unwrap();
        assert_eq!(
            attach_card(&conn, burn, note.id, "").unwrap_err(),
            NO_ORACLE_ID
        );
    }

    /// **What the old column could never do.** `update_deck` writes `notes = coalesce(?8, notes)`,
    /// so no patch could ever empty `decks.notes`; a multi-note model needs a real empty and this
    /// is it.
    #[test]
    fn an_update_can_empty_a_title_where_the_old_column_never_could() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "Mana", "Fourteen sources.", &[]).unwrap();

        let cleared = update_note(&conn, burn, note.id, Some("  "), None).unwrap();
        assert_eq!(cleared.title, "", "a blank title is legal and is stored");
        assert_eq!(
            cleared.body, "Fourteen sources.",
            "an absent field means leave it alone"
        );

        let body_only = update_note(&conn, burn, note.id, None, Some("")).unwrap();
        assert_eq!(body_only.body, "");
    }

    /// The band's list is `sort_order`, and a new note goes on the end.
    #[test]
    fn notes_are_listed_in_sort_order_and_a_new_one_appends() {
        let (conn, burn, _) = deck_db();
        let first = create_note(&conn, burn, "One", "", &[]).unwrap();
        let second = create_note(&conn, burn, "Two", "", &[]).unwrap();
        let third = create_note(&conn, burn, "Three", "", &[]).unwrap();
        assert_eq!(
            (first.sort_order, second.sort_order, third.sort_order),
            (0, 1, 2)
        );

        reorder_notes(&conn, burn, &[third.id, first.id, second.id]).unwrap();

        let titles: Vec<String> = list_notes(&conn, burn)
            .unwrap()
            .into_iter()
            .map(|n| n.title)
            .collect();
        assert_eq!(titles, vec!["Three", "One", "Two"]);
    }

    /// A stale id in a reorder is skipped, never a refusal — the list on screen is one press
    /// behind, and refusing the whole gesture over it would be worse than placing the rest.
    #[test]
    fn a_reorder_skips_an_id_that_is_not_this_decks() {
        let (conn, burn, storm) = deck_db();
        let mine = create_note(&conn, burn, "Mine", "", &[]).unwrap();
        let theirs = create_note(&conn, storm, "Theirs", "", &[]).unwrap();

        reorder_notes(&conn, burn, &[theirs.id, mine.id]).unwrap();

        assert_eq!(list_notes(&conn, burn).unwrap()[0].id, mine.id);
        assert_eq!(
            list_notes(&conn, storm).unwrap()[0].sort_order,
            0,
            "the other deck's note kept its own number"
        );
    }

    /// Detaching leaves the note standing — the issue asks for it in those words, and it is true
    /// by construction because the attachment hangs off the note rather than the other way round.
    #[test]
    fn detaching_a_card_leaves_the_note_in_the_list() {
        let (conn, burn, _) = deck_db();
        let note = create_note(
            &conn,
            burn,
            "Mana",
            "b",
            &["o-bolt".into(), "o-ritual".into()],
        )
        .unwrap();

        let after = detach_card(&conn, burn, note.id, "o-bolt").unwrap();

        assert_eq!(after.cards.len(), 1);
        assert_eq!(after.cards[0].oracle_id, "o-ritual");
        assert_eq!(list_notes(&conn, burn).unwrap().len(), 1);

        // The whole way down to none, and it is still a note.
        let bare = detach_card(&conn, burn, note.id, "o-ritual").unwrap();
        assert!(bare.cards.is_empty());
        assert_eq!(list_notes(&conn, burn).unwrap().len(), 1);
    }

    /// Detaching a card the note does not name is a success that writes nothing —
    /// [`attach_card`]'s short-circuit from the other end.
    #[test]
    fn detaching_a_card_the_note_never_named_writes_nothing() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "Mana", "b", &[]).unwrap();
        backdate(&conn, burn);

        detach_card(&conn, burn, note.id, "o-bolt").unwrap();

        assert_eq!(audit_actions(&conn, burn), vec!["create"]);
        assert_eq!(updated_at(&conn, burn), 0);
    }

    /// **The payload shape `auditText.ts` is written against.** `field` is `note` — not `notes`,
    /// which is the v8 column's word and has to go on rendering for every history row written
    /// before v43 — and `card` carries the card's *name*.
    #[test]
    fn the_history_row_names_the_note_and_the_card() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "Mana", "b", &[]).unwrap();
        attach_card(&conn, burn, note.id, "o-bolt").unwrap();

        let payloads: Vec<serde_json::Value> = conn
            .prepare("SELECT payload FROM deck_audit WHERE deck_id = ?1 ORDER BY id")
            .unwrap()
            .query_map(params![burn], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .map(|p| serde_json::from_str(&p).unwrap())
            .collect();

        assert_eq!(
            payloads[0],
            json!({ "field": "note", "action": "create", "note": "Mana", "card": null })
        );
        assert_eq!(
            payloads[1],
            json!({ "field": "note", "action": "attach", "note": "Mana", "card": "o-bolt" })
        );
    }

    /// Every write records one history row **and** one step, which is the rule `deck_audit`'s
    /// header states and the reason nothing here may quietly succeed.
    #[test]
    fn every_note_write_leaves_one_history_row_and_one_step() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "Mana", "b", &[]).unwrap();
        attach_card(&conn, burn, note.id, "o-bolt").unwrap();
        detach_card(&conn, burn, note.id, "o-bolt").unwrap();
        update_note(&conn, burn, note.id, Some("Mana base"), None).unwrap();
        reorder_notes(&conn, burn, &[note.id]).unwrap();
        delete_note(&conn, burn, note.id).unwrap();

        assert_eq!(
            audit_actions(&conn, burn),
            vec!["create", "attach", "detach", "edit", "reorder", "delete"]
        );
        assert_eq!(steps(&conn), 6, "one step per press, and none missing");
    }

    /// Every write moves the deck's `updated_at`, so an edit surfaces in the gallery — the reason
    /// `touch_deck` is the first statement of every one of them.
    #[test]
    fn a_note_write_moves_the_decks_own_clock() {
        let (conn, burn, _) = deck_db();
        let note = create_note(&conn, burn, "Mana", "b", &[]).unwrap();
        for step in 0..4 {
            backdate(&conn, burn);
            match step {
                0 => {
                    attach_card(&conn, burn, note.id, "o-bolt").unwrap();
                }
                1 => {
                    update_note(&conn, burn, note.id, None, Some("more")).unwrap();
                }
                2 => reorder_notes(&conn, burn, &[note.id]).unwrap(),
                _ => delete_note(&conn, burn, note.id).unwrap(),
            }
            assert!(updated_at(&conn, burn) > 0, "write {step} left the clock");
        }
    }

    /// **No INSERT here names `sync_uid`** — the capture trigger mints it, and nothing in any
    /// `deck*.rs` has ever written that column. A fixture has no triggers installed, so the
    /// column staying NULL is the evidence the statement did not touch it.
    #[test]
    fn nothing_here_writes_the_sync_uid_column() {
        let (conn, burn, _) = deck_db();
        create_note(&conn, burn, "Mana", "b", &["o-bolt".into()]).unwrap();

        for table in ["deck_notes", "deck_note_cards"] {
            let unset: i64 = conn
                .query_row(
                    &format!("SELECT count(*) FROM {table} WHERE sync_uid IS NULL"),
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(unset, 1, "{table} had its uid written by this crate");
        }
    }

    /// A deck that has never had a note reads an empty list rather than refusing, and so does one
    /// that is not there — `list_notes` is a pure read.
    #[test]
    fn an_unknown_deck_reads_an_empty_list_rather_than_refusing() {
        let (conn, burn, _) = deck_db();
        assert!(list_notes(&conn, burn).unwrap().is_empty());
        assert!(list_notes(&conn, 404).unwrap().is_empty());
    }

    /// A write against a deck that is gone is [`crate::deck::GONE`] — `touch_deck` answers it one
    /// statement before there is an orphan row to worry about.
    #[test]
    fn a_note_cannot_be_written_to_a_deck_that_is_not_there() {
        let (conn, _, _) = deck_db();
        assert_eq!(
            create_note(&conn, 404, "t", "b", &[]).unwrap_err(),
            crate::deck::GONE
        );
    }
}
