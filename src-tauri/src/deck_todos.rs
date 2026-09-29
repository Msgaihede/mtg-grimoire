//! A deck's to-do list — one checklist to a deck, written in the notes' editor and drawn as a
//! band under the Notes band and as a home widget. User schema v58, the deck to-dos spec
//! (`docs/superpowers/specs/2026-09-29-deck-todos-design.md` §4–§5).
//!
//! [`crate::sticky_notes`]' file shape: pure functions over a [`Connection`] first, the command
//! wrappers in one block at the foot.
//!
//! # One list to a deck, so two columns and not a table
//!
//! `decks.todos` holds the checklist as text, in the dialect `todoMarkdown.ts` reads — `- [ ]`
//! and `- [x]` lines, sub-to-dos indented under their parent — and `''` means the deck has no
//! list. `decks.todos_open` is whether the band is expanded, and rides `DeckRow` and `DeckPatch`
//! like the Notes band's `notes_open`; **this module never writes it**. A table would have owed
//! the synced-table census, a uid and a grain, and a grain would fold two devices' first to-dos
//! into one row by rules written for cards. Two columns inherit the deck's cascade, its change
//! mask and its capture trigger for nothing, and sync per field: a to-do edit on one device and
//! a rename on another both survive. Two devices editing *one* list while apart keep the later
//! write whole, which is what a deck note's body already does.
//!
//! **Rust stores the text and draws no conclusion from it.** Which items are open, how deep one
//! is nested, which line a tick flips — every one of those is `todoMarkdown.ts`', the crate
//! root's boundary. A parser here would be a second implementation of that one.
//!
//! # A write touches the deck and records nothing else
//!
//! It moves the deck's `updated_at`, as a deck note does, so a deck the reader just worked
//! through reads as recently edited. **It writes no [`crate::deck_audit`] row, no
//! [`crate::deck_undo`] step and no [`crate::activity`] row**: the band autosaves every pause in
//! typing, and one history line per pause would bury every real edit in the drawer. The editor's
//! own Ctrl+Z is the undo — [`crate::sticky_notes`] made the same call for the same reason.
//!
//! # The compare-and-set, and why the widget needs it
//!
//! [`set_todos`] takes an optional `expected`. **The band sends none**: it is the author's
//! surface, and its autosave is the truth of what the reader typed. **The home widget always
//! sends the body it parsed**, because a tick there is "flip the marker on line *n* of *this*
//! text", and the text can move under it — the band autosaving in another window, a sync apply.
//! A line number against a moved list flips the wrong to-do, so a stale tick is refused with
//! [`TODOS_CHANGED`] and the widget refetches rather than guessing.

use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;

/// What a compare-and-set write says when the stored list is no longer the one the caller read.
///
/// A sentence rather than a code, `deck_notes`' convention for its refusals: the widget refetches
/// on any refused tick and prints the refusal as it stands, in its one-line failure slot.
pub const TODOS_CHANGED: &str = "That to-do list changed since it was read. Try again.";

/// One deck's list, as the home widget reads it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTodoList {
    pub deck_id: i64,
    pub name: String,
    /// Every list is answered, an archived deck's included: whether one is drawn is the widget's
    /// `Include archived decks` toggle, a filter TypeScript applies rather than this query.
    pub archived: bool,
    /// So the widget's heading press writes the disclosure only when the band is shut.
    pub todos_open: bool,
    /// The widget's `Last edited` order, and the order [`list_lists`] already answers in.
    pub updated_at: i64,
    /// The checklist, in the dialect `todoMarkdown.ts` reads. Never empty here.
    pub body: String,
}

/// The deck's checklist, `""` when it has none.
///
/// **A pure read, and an unknown deck answers `""`**, `deck_notes::list_notes`' standing and for
/// its reason: a deck that has gone is reported by the read that is *about* the deck, and a band
/// drawn for one has nothing to show either way. The write is where a missing deck is refused.
pub fn read_todos(conn: &Connection, deck_id: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT todos FROM decks WHERE id = ?1",
        params![deck_id],
        |r| r.get(0),
    )
    .optional()
    .map(|found| found.unwrap_or_default())
    .map_err(|e| e.to_string())
}

/// Write the checklist. With `expected`, a compare-and-set: refused with [`TODOS_CHANGED`] unless
/// the stored list is exactly `expected`, and a refusal writes nothing.
///
/// **A missing deck is [`crate::deck::GONE`]**, checked first, so a stale tick against a deleted
/// deck says the deck went rather than that its list moved.
///
/// **A body equal to the stored one writes nothing at all** — no `updated_at`, no capture op, no
/// mirror pass. The band flushes on blur and on unmount, so a write can carry exactly the text
/// already stored, and one that changed nothing must not reorder the widget by touching the deck.
///
/// Read and write in one transaction, so nothing can land between the comparison and the
/// `UPDATE` on this connection.
pub fn set_todos(
    conn: &Connection,
    deck_id: i64,
    body: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current: Option<String> = tx
        .query_row(
            "SELECT todos FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(current) = current else {
        return Err(crate::deck::GONE.to_owned());
    };
    if expected.is_some_and(|e| e != current) {
        return Err(TODOS_CHANGED.to_owned());
    }
    if current == body {
        return Ok(());
    }
    tx.execute(
        "UPDATE decks SET todos = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![deck_id, body],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Every deck with a non-empty list, most recently edited first — the home widget's read.
///
/// **`id` breaks a tie**, because `updated_at` is whole seconds and two decks touched in one
/// second are an ordinary state; without it the widget's order would be whatever SQLite
/// happened to return.
pub fn list_lists(conn: &Connection) -> Result<Vec<DeckTodoList>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, archived, todos_open, updated_at, todos FROM decks
              WHERE todos <> '' ORDER BY updated_at DESC, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DeckTodoList {
                deck_id: r.get(0)?,
                name: r.get(1)?,
                archived: r.get::<_, i64>(2)? != 0,
                todos_open: r.get::<_, i64>(3)? != 0,
                updated_at: r.get(4)?,
                body: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/// What a write here says when its worker thread died under it — never a reader's problem. The
/// write itself answers [`crate::db::BUSY`] when a sync holds the connection.
fn unfinished(e: tauri::Error) -> String {
    format!("the to-do list could not be written: {e}")
}

/// One deck's checklist.
///
/// **Fallible, where `sticky_notes`' read is infallible by signature, and deliberately.** The band
/// autosaves: a read that failed and answered `""` would mount an empty editor whose next
/// autosave writes `""` over the reader's list. An error lets the band draw a failure line and
/// no editor at all.
///
/// `#[tauri::command(async)]` on a **sync** `fn`, `sticky_notes`' reason: a bare sync body runs
/// inline on the IPC thread, and this one takes [`crate::sync::lock_db_read`]'s mutex. And the
/// module and its read wear one name, `deck_notes::deck_notes`' reason: `generate_handler!` names
/// a command after its last path segment, so this registers as `deck_todos`.
#[tauri::command(async)]
pub fn deck_todos(state: tauri::State<'_, Arc<AppState>>, deck_id: i64) -> Result<String, String> {
    read_todos(&crate::sync::lock_db_read(state.inner()), deck_id)
}

/// Write one deck's checklist — see [`set_todos`] for `expected` and the two refusals.
#[tauri::command]
pub async fn deck_todos_set(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    body: String,
    expected: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| {
            set_todos(c, deck_id, &body, expected.as_deref())
        })
    })
    .await
    .map_err(unfinished)?
}

/// Every deck's non-empty list, for the home widget. Fallible for [`deck_todos`]' reason: the
/// widget ticks through a compare-and-set against the body it read, and an empty answer from a
/// failed read would draw "No to-dos yet" over a reader who has some.
#[tauri::command(async)]
pub fn deck_todo_lists(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<DeckTodoList>, String> {
    list_lists(&crate::sync::lock_db_read(state.inner()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real user schema over [`crate::schema::memory_pair`], `sticky_notes`' `db()`, with three
    /// bare decks: a live one, an archived one with a later stamp, and a third that never gets a
    /// list — so "leaves empty ones out" has something to leave out.
    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "INSERT INTO decks (id, name, format_key, archived, created_at, updated_at)
             VALUES (1, 'Burn', 'modern', 0, 0, 0),
                    (2, 'Zoo', 'modern', 1, 0, 5),
                    (3, 'Empty', 'modern', 0, 0, 9);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_new_deck_has_an_empty_list_and_an_unknown_deck_reads_empty() {
        let conn = db();
        assert_eq!(read_todos(&conn, 1).unwrap(), "");
        assert_eq!(read_todos(&conn, 404).unwrap(), "");
    }

    #[test]
    fn a_write_is_read_back_and_moves_updated_at() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] Revise tokens", None).unwrap();
        assert_eq!(read_todos(&conn, 1).unwrap(), "- [ ] Revise tokens");
        let at: i64 = conn
            .query_row("SELECT updated_at FROM decks WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert!(at > 0, "the write touches the deck");
    }

    #[test]
    fn a_matching_expected_writes_and_a_moved_one_refuses_and_writes_nothing() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        set_todos(&conn, 1, "- [x] a", Some("- [ ] a")).unwrap();
        assert_eq!(read_todos(&conn, 1).unwrap(), "- [x] a");
        assert_eq!(
            set_todos(&conn, 1, "- [ ] a", Some("- [ ] a")).unwrap_err(),
            TODOS_CHANGED
        );
        assert_eq!(
            read_todos(&conn, 1).unwrap(),
            "- [x] a",
            "a refusal writes nothing"
        );
    }

    #[test]
    fn a_write_to_a_deck_that_is_not_there_is_gone() {
        let conn = db();
        assert_eq!(
            set_todos(&conn, 404, "- [ ] a", None).unwrap_err(),
            crate::deck::GONE
        );
    }

    #[test]
    fn an_unchanged_body_writes_nothing() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        conn.execute("UPDATE decks SET updated_at = 0 WHERE id = 1", [])
            .unwrap();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        let at: i64 = conn
            .query_row("SELECT updated_at FROM decks WHERE id = 1", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            at, 0,
            "a write that changes nothing does not touch the deck"
        );
    }

    #[test]
    fn the_lists_leave_empty_ones_out_and_read_newest_first() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] one", None).unwrap();
        set_todos(&conn, 2, "- [ ] two", None).unwrap();
        conn.execute("UPDATE decks SET updated_at = 10 WHERE id = 1", [])
            .unwrap();
        conn.execute(
            "UPDATE decks SET updated_at = 20, todos_open = 1 WHERE id = 2",
            [],
        )
        .unwrap();
        let lists = list_lists(&conn).unwrap();
        let ids: Vec<i64> = lists.iter().map(|l| l.deck_id).collect();
        assert_eq!(ids, vec![2, 1], "newest first; deck 3 has no list");
        assert!(lists[0].archived && lists[0].todos_open);
        assert_eq!(lists[0].body, "- [ ] two");
        assert_eq!(lists[0].name, "Zoo");
    }

    #[test]
    fn a_duplicate_carries_neither_column() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        conn.execute("UPDATE decks SET todos_open = 1 WHERE id = 1", [])
            .unwrap();
        let copy = crate::deck::duplicate_deck(&conn, 1).unwrap();
        assert_eq!(read_todos(&conn, copy.id).unwrap(), "");
        assert!(!copy.todos_open);
    }
}
