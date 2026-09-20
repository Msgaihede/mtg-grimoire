//! The reader's own prose on the home page — a stack of sticky notes belonging to nobody but
//! them. User schema v46, [issue #479](https://github.com/Msgaihede/mtg-grimoire/issues/479).
//!
//! [`crate::deck_notes`]'s file shape and almost none of its machinery: pure functions over a
//! [`Connection`] first, the command wrappers in one `#[cfg(not(target_family = "wasm"))]` block
//! at the foot. Nothing above that block names `tauri::` at all, which is what lets
//! [`crate::web::route`] call the same functions the desktop wrappers call.
//!
//! # A sticky note hangs off nothing
//!
//! That is the whole model, and it is what separates a sticky note from a deck note: no parent,
//! no attachment, no scope. It is the first user table in this app that belongs to the reader
//! and to nothing else. **Three things [`crate::deck_notes`] does on every write are therefore
//! absent here, and each absence is a decision rather than an omission:**
//!
//! * **No [`crate::deck::touch_deck`].** There is no deck to touch.
//! * **No [`crate::deck_audit::record`].** Every row in `deck_audit` carries a `deck_id` that is
//!   a real foreign key, so a sticky note has no row shape there at all — not a missing entry,
//!   a missing column.
//! * **No [`crate::deck_undo::record_step`].** An undo step hangs off an audit row, so the
//!   second absence decides the third: there is no undo here, and the dialog's own confirmation
//!   is the whole of the safety net.
//!
//! **And no [`crate::activity`] row either, which is not a judgement call.** `activity.scope` is
//! `CHECK (scope IN ('collection','wishlist'))` and SQLite has no `ALTER … CHECK`, so there is
//! no word to write and inventing one would cost a full table rebuild. The feed is about the
//! collection; a sticky note is not in it.
//!
//! # What this module decides, and what it refuses to
//!
//! It stores strings. **`color` carries no `CHECK`** — `schema.rs`'s comment on the column has
//! the argument — so a word this build has never heard of is stored exactly as written and the
//! page maps it to `slate`. A constraint here would make a build that added a sixth colour emit
//! rows *this* build refuses at apply, and a refused row is a failed sync rather than a note
//! that arrives looking wrong.
//!
//! `title` may be empty, and an empty one is not a missing one: the page prints the body's first
//! line in its place, **computed at render and never stored**, because a stored derivation goes
//! stale the moment the body is edited and no writer could notice.
//!
//! There is exactly one refusal, [`NOTE_GONE`], and it is a **sentence fired before the write**
//! rather than a constraint failure or a silent no-op.
//!
//! # No INSERT here names the uid column
//!
//! The capture trigger mints it — `lower(hex(randomblob(16)))`, unconditionally, on unpaired
//! devices too — and nothing in any `deck*.rs` has ever written it. A test at the foot of this
//! file reads this file back to keep it that way, which is also why that column's name is
//! spelled in exactly one place below.

#[cfg(not(target_family = "wasm"))]
use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// What a write says when the note it names is not there any more.
///
/// [`crate::deck_meta::CATEGORY_GONE`]'s asymmetry one table over: an *adjustment* to a row that
/// has gone is told about, because "changed nothing" and "there is nothing to change" are two
/// answers and the dialog draws them differently.
pub const NOTE_GONE: &str = "That note is not there any more.";

/// Every column the page is told about, in [`StickyNoteRow`]'s own order.
///
/// **`ORDER BY sort_order, id`**, and the tiebreak is not decoration: [`reorder_notes`]
/// renumbers from zero and a note written on another device arrives with a number of its own, so
/// two notes sharing one `sort_order` is an ordinary state rather than a corrupt one.
const SELECT: &str = "SELECT id, title, body, color, pinned, sort_order, created_at, updated_at
                      FROM sticky_notes ORDER BY sort_order, id";

/// Where a new note goes: after every note there is. `-1 + 1` is the empty-table answer.
const NEXT_ORDER: &str = "SELECT coalesce(max(sort_order), -1) + 1 FROM sticky_notes";

/// Is there such a note? A `SELECT` of its own rather than the row count off an `UPDATE`,
/// because the refusal has to come *before* the write — see [`NOTE_GONE`].
const EXISTS: &str = "SELECT 1 FROM sticky_notes WHERE id = ?1";

/// One sticky note, as the page reads it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNoteRow {
    pub id: i64,
    /// May be empty. The page prints the body's first line in its place.
    pub title: String,
    /// CommonMark, in the narrowed dialect `noteMarkdown.ts` pins for deck notes. Never HTML and
    /// never ProseMirror JSON: a body Rust can hand to anything as text is what keeps a renderer
    /// out of this crate.
    pub body: String,
    /// One of five names the page knows — unvalidated here on purpose, see the module doc.
    pub color: String,
    pub pinned: bool,
    pub sort_order: i64,
    /// Both stamps are read and neither is synced: a timestamp on a field list would put two
    /// answers to "when" in the database, which is `capture.rs`'s rule and not this module's.
    pub created_at: i64,
    pub updated_at: i64,
}

/// Every note, in the reader's order.
///
/// **The complete list by construction.** A sticky note hangs off nothing, so there is no scope
/// that could hide one and no second read that answers a narrower question.
pub fn list_notes(conn: &Connection) -> rusqlite::Result<Vec<StickyNoteRow>> {
    let mut stmt = conn.prepare(SELECT)?;
    let rows = stmt.query_map([], |r| {
        Ok(StickyNoteRow {
            id: r.get(0)?,
            title: r.get(1)?,
            body: r.get(2)?,
            color: r.get(3)?,
            pinned: r.get::<_, i64>(4)? != 0,
            sort_order: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    rows.collect()
}

/// Write a new note and answer its id. It lands **last**, which is the only place a note the
/// reader has not arranged yet can go.
pub fn create_note(conn: &Connection, title: &str, body: &str, color: &str) -> Result<i64, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let next_order: i64 = tx
        .query_row(NEXT_ORDER, [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    // **No uid column in this INSERT and there must never be one** — the capture trigger mints
    // it, and the test at the foot of this file reads this file back to keep it so.
    let id: i64 = tx
        .query_row(
            "INSERT INTO sticky_notes (title, body, color, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             RETURNING id",
            params![title, body, color, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Change any of the four columns the reader owns.
///
/// **An absent field means *leave it alone*, and `Some(String::new())` really empties one** —
/// [`crate::deck_notes::update_note`]'s idiom verbatim: the `coalesce` is over the *bound* value,
/// and a bound `''` is a value. Tauri fills a missing `Option` argument with `None`, so a dialog
/// that changed only the colour sends only the colour.
///
/// `pinned` rides the same `coalesce` as a nullable integer rather than as a separate statement,
/// which is what keeps one write one round trip.
pub fn update_note(
    conn: &Connection,
    id: i64,
    title: Option<String>,
    body: Option<String>,
    color: Option<String>,
    pinned: Option<bool>,
) -> Result<(), String> {
    if !exists(conn, id)? {
        return Err(NOTE_GONE.to_owned());
    }
    conn.execute(
        "UPDATE sticky_notes
            SET title = coalesce(?2, title),
                body = coalesce(?3, body),
                color = coalesce(?4, color),
                pinned = coalesce(?5, pinned),
                updated_at = unixepoch()
          WHERE id = ?1",
        params![id, title, body, color, pinned.map(i64::from)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Throw a note away. Nothing cascades and nothing is recorded — see the module doc on the three
/// absences.
pub fn delete_note(conn: &Connection, id: i64) -> Result<(), String> {
    if !exists(conn, id)? {
        return Err(NOTE_GONE.to_owned());
    }
    conn.execute("DELETE FROM sticky_notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renumber in the order given, from zero.
///
/// **An id that is not a note is skipped rather than refused**, which is the one place this
/// module is deliberately laxer than [`update_note`]: the page sends the order it just drew, and
/// a note another window deleted mid-drag must not fail the drag. The `UPDATE` matches no row
/// and the loop carries on.
///
/// **A skipped id still consumes a position**, because `enumerate()` counts it — so a stranger
/// in the middle leaves the notes either side at 0 and 2. That is the design and not a leak:
/// **`sort_order` is monotonic and never dense**, a delete leaves holes in it too, and neither
/// is repaired. The column answers *before or after* and nothing more, which is all `SELECT`
/// asks of it; a reader of it that counts gaps is reading it wrong.
///
/// **An empty slice is a no-op and needs no guard.** The loop runs zero times and the deferred
/// transaction commits having taken no write lock and written nothing — so no `updated_at` is
/// bumped, no capture row is minted, and a drag that drops onto an empty board costs a `BEGIN`
/// and a `COMMIT` rather than a refusal.
pub fn reorder_notes(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE sticky_notes SET sort_order = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn exists(conn: &Connection, id: i64) -> Result<bool, String> {
    let found: Option<i64> = conn
        .query_row(EXISTS, [id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(found.is_some())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a reader's problem. The
/// write itself answers [`crate::db::BUSY`] when a sync holds the connection.
#[cfg(not(target_family = "wasm"))]
fn unfinished(e: tauri::Error) -> String {
    format!("the note could not be written: {e}")
}

/// Every sticky note.
///
/// **Infallible by signature**, [`crate::home::home_layout`]'s contract and for its reason: the
/// widget reads this while the window draws its first frame, and there is nothing it could do
/// with an error that is not "draw the notes you already have".
///
/// `#[tauri::command(async)]` on a **sync** `fn`, the same module's reason: a bare sync body runs
/// inline on the IPC thread, and this one takes [`crate::sync::lock_db_read`]'s mutex, which a
/// search may hold for tens of milliseconds.
///
/// **`generate_handler!` names a command after its last path segment**, so
/// `sticky_notes::sticky_notes` registers as `sticky_notes` — the module and its read wear one
/// name on purpose, exactly as `deck_notes::deck_notes` does, because the wire name is the one
/// `src/lib/ipc.ts` invokes.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn sticky_notes(state: tauri::State<'_, Arc<AppState>>) -> Vec<StickyNoteRow> {
    list_notes(&crate::sync::lock_db_read(state.inner())).unwrap_or_default()
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sticky_note_create(
    state: tauri::State<'_, Arc<AppState>>,
    title: String,
    body: String,
    color: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| create_note(c, &title, &body, &color))
    })
    .await
    .map_err(unfinished)?
}

/// **Every field is optional and an absent one means *leave it*.** See [`update_note`].
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sticky_note_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    title: Option<String>,
    body: Option<String>,
    color: Option<String>,
    pinned: Option<bool>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| update_note(c, id, title, body, color, pinned))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sticky_note_delete(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| delete_note(c, id)))
        .await
        .map_err(unfinished)?
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sticky_note_reorder(
    state: tauri::State<'_, Arc<AppState>>,
    ids: Vec<i64>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| reorder_notes(c, &ids)))
        .await
        .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real user schema over [`crate::schema::memory_pair`] — a pair rather than a bare
    /// in-memory connection, this repo's rule for anything touching the user side, even though
    /// nothing here reads the corpus.
    ///
    /// **User tables only, and no capture triggers**: an unpaired device is the state most
    /// readers are in and the one every write here has to be correct in.
    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    #[test]
    fn a_new_note_lands_last_and_is_read_back() {
        let conn = db();
        let a = create_note(&conn, "First", "body a", "amber").unwrap();
        let b = create_note(&conn, "", "body b", "jade").unwrap();
        let notes = list_notes(&conn).unwrap();
        let ids: Vec<i64> = notes.iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![a, b]);
        assert_eq!(notes[1].title, "");
        assert_eq!(notes[1].color, "jade");
        assert!(!notes[1].pinned);
        assert_eq!(notes[1].sort_order, 1);
    }

    #[test]
    fn an_absent_field_is_left_and_an_empty_string_really_empties() {
        let conn = db();
        let id = create_note(&conn, "Named", "body", "amber").unwrap();
        update_note(&conn, id, None, Some("changed".into()), None, None).unwrap();
        let note = list_notes(&conn).unwrap().remove(0);
        assert_eq!(note.title, "Named");
        assert_eq!(note.body, "changed");

        update_note(&conn, id, Some(String::new()), None, None, Some(true)).unwrap();
        let note = list_notes(&conn).unwrap().remove(0);
        assert_eq!(note.title, "");
        assert!(note.pinned);
    }

    /// The whole point of the column carrying no `CHECK`: a newer build's word arrives over sync
    /// and has to be stored, because the page can draw it as `slate` and a constraint cannot.
    #[test]
    fn a_colour_this_build_has_never_heard_of_is_stored_as_written() {
        let conn = db();
        let id = create_note(&conn, "x", "", "chartreuse").unwrap();
        update_note(&conn, id, None, None, Some("puce".into()), None).unwrap();
        assert_eq!(list_notes(&conn).unwrap()[0].color, "puce");
    }

    #[test]
    fn a_missing_note_is_refused_in_a_sentence() {
        let conn = db();
        let refused = update_note(&conn, 404, None, None, None, None).unwrap_err();
        assert_eq!(refused, NOTE_GONE);
        assert_eq!(delete_note(&conn, 404).unwrap_err(), NOTE_GONE);
    }

    /// The stranger is the point: a drag sends the order the page drew, and a note another
    /// window deleted in the meantime must not fail it.
    #[test]
    fn reorder_renumbers_in_the_order_given_and_ignores_a_stranger() {
        let conn = db();
        let a = create_note(&conn, "a", "", "slate").unwrap();
        let b = create_note(&conn, "b", "", "slate").unwrap();
        let c = create_note(&conn, "c", "", "slate").unwrap();
        reorder_notes(&conn, &[c, a, b, 999]).unwrap();
        let ids: Vec<i64> = list_notes(&conn).unwrap().iter().map(|n| n.id).collect();
        assert_eq!(ids, vec![c, a, b]);
    }

    /// A stranger in the **middle** consumes a position: `enumerate()` counts it, so the notes
    /// either side land 0 and 2 rather than 0 and 1.
    ///
    /// **Stated rather than left to be found**, because the test above puts the stranger last
    /// and cannot see this at all. `sort_order` is monotonic and never dense — a delete leaves
    /// holes in it too — so nothing downstream may read a gap as a missing note. The Storybook
    /// fake pins this same case, and the two agreeing on purpose is the point of writing it
    /// twice.
    #[test]
    fn a_stranger_in_the_middle_consumes_a_position() {
        let conn = db();
        let a = create_note(&conn, "a", "", "slate").unwrap();
        let b = create_note(&conn, "b", "", "slate").unwrap();
        reorder_notes(&conn, &[a, 999, b]).unwrap();
        let notes = list_notes(&conn).unwrap();
        let ids: Vec<i64> = notes.iter().map(|n| n.id).collect();
        // The hole is in the numbering, never in the order — which is the whole of the claim.
        assert_eq!(ids, vec![a, b]);
        assert_eq!(notes[0].sort_order, 0);
        assert_eq!(notes[1].sort_order, 2, "the stranger consumed position 1");
    }

    /// An empty order is what a drag onto an empty board sends. It writes nothing and refuses
    /// nothing — see [`reorder_notes`] on why that needs no guard.
    #[test]
    fn an_empty_order_writes_nothing_and_refuses_nothing() {
        let conn = db();
        let a = create_note(&conn, "a", "", "slate").unwrap();
        let before = list_notes(&conn).unwrap().remove(0);
        reorder_notes(&conn, &[]).unwrap();
        let after = list_notes(&conn).unwrap().remove(0);
        assert_eq!(after.id, a);
        assert_eq!(after.sort_order, before.sort_order);
        assert_eq!(after.updated_at, before.updated_at, "nothing was touched");
    }

    /// **The file reads itself, because nothing else can see this.** The capture trigger mints
    /// the uid column unconditionally, on unpaired devices too, so a write here that named it
    /// would set a value the trigger then replaces — green in every suite, and wrong on the far
    /// device.
    ///
    /// ⚠️ **Two things keep this from being vacuous, and the obvious version is.** The needle is
    /// *assembled* rather than written, because a literal spelling of the column is itself part
    /// of the source being read: a whole-file `contains` answers `true` about its own assertion
    /// and fails the moment it is written. And the search is narrowed to the statements that
    /// write, because the prose above may name the column and should. The two guards are what
    /// keep both halves honest — the assembled needle has to name a real column of the real
    /// table, and there has to be a statement to read.
    #[test]
    fn no_insert_here_names_the_uid_column() {
        let conn = db();
        let column = ["sync", "uid"].join("_");
        let named: i64 = conn
            .query_row(
                "SELECT count(*) FROM pragma_table_info('sticky_notes') WHERE name = ?1",
                params![column],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(named, 1, "the needle names no column of the table");

        let source = include_str!("sticky_notes.rs");
        let mut statements = 0;
        for (at, _) in source.match_indices("INSERT INTO") {
            statements += 1;
            let tail = &source[at..];
            let sql = &tail[..tail.find('"').unwrap_or(tail.len())];
            assert!(
                !sql.contains(&column),
                "an INSERT here names sync_uid; the capture trigger mints it"
            );
        }
        assert!(statements > 0, "no INSERT was read, so nothing was checked");
    }
}
