//! A deck's to-do lists — several to a deck, each with a title, written in the notes' editor and
//! drawn as cards in a band under the Notes band and as a home widget. User schema v59, the titled
//! to-do lists spec (`docs/superpowers/specs/2026-09-29-titled-todo-lists-design.md` §2–§3), which
//! amends the deck to-dos spec (`docs/superpowers/specs/2026-09-29-deck-todos-design.md` §4–§5).
//!
//! [`crate::sticky_notes`]' file shape: pure functions over a [`Connection`] first, the command
//! wrappers in one block at the foot.
//!
//! # Rows now, where #672 had one column
//!
//! User schema v58 stored **one** checklist per deck in `decks.todos`, on the argument that one
//! list to a deck is a column's shape: a table would owe the synced-table census, a uid and a
//! grain, and two columns inherited the deck's cascade, change mask and capture trigger for
//! nothing. **The owner reversed the premise on 2026-09-29** (issue #688): a deck holds several
//! titled lists now, drawn as cards the way its notes are — and several of a thing is a table's
//! shape, so the census was owed after all. `deck_todo_lists` is `deck_notes`' shape column for
//! column where the two mean the same thing, **uid-only with no grain**, for `deck_notes`' reason:
//! two devices each starting a list while apart must stay two lists, and nothing about a title
//! could tell an accidental duplicate from a deliberate one. v59 converted each non-empty
//! `decks.todos` into one row titled `To-do`, named by [`crate::schema::todo_list_uid`] so every
//! device in a group names its own conversion the same way, and dropped the column.
//! `decks.todos_open` stayed: it is the band's disclosure, it still rides `DeckRow` and
//! `DeckPatch`, and **this module never writes it**.
//!
//! ⚠️ **A list is still not a note.** It shares the notes' title-and-body shape, their editor and
//! their card *look*, and it has none of a note's card attachments, drag order, Save button or
//! history rows. A sentence that says "notes" and means these is the root `CLAUDE.md`'s trap.
//!
//! **Rust stores the text and draws no conclusion from it.** Which items are open, how deep one
//! is nested, which line a tick flips, which lines are text rather than to-dos — every one of
//! those is `todoMarkdown.ts`', the crate root's boundary. A parser here would be a second
//! implementation of that one.
//!
//! # A write touches the deck and records nothing else
//!
//! Every write that changes something moves the deck's `updated_at`, as a deck note does, so a
//! deck the reader just worked through reads as recently edited. **It writes no
//! [`crate::deck_audit`] row, no [`crate::deck_undo`] step and no [`crate::activity`] row**: the
//! dialog autosaves every pause in typing, and one history line per pause would bury every real
//! edit in the drawer. The editor's own Ctrl+Z is the undo — [`crate::sticky_notes`] made the same
//! call for the same reason. **No statement here names `sync_uid`**: the capture trigger mints it,
//! and `nothing_here_writes_the_sync_uid_column` is the fence.
//!
//! # The compare-and-set, and why a tick needs it
//!
//! [`update_list`] takes an optional `expected`. **The dialog sends none**: it is the author's
//! surface, and its autosave is the truth of what the reader typed. **A tick always sends the
//! body it parsed** — the band's card and the home widget alike — because a tick is "flip the
//! marker on line *n* of *this* text", and the text can move under it: the dialog autosaving in
//! another window, a sync apply. A line number against a moved list flips the wrong to-do, so a
//! stale tick is refused with [`TODOS_CHANGED`] and the caller refetches rather than guessing.
use rusqlite::{params, Connection, OptionalExtension};

/// What a compare-and-set write says when the stored list is no longer the one the caller read.
///
/// A sentence rather than a code, `deck_notes`' convention for its refusals: a tick's caller
/// refetches on any refusal and prints it as it stands, in its one-line failure slot. #672's
/// sentence, kept word for word — TypeScript matches it verbatim.
pub const TODOS_CHANGED: &str = "That to-do list changed since it was read. Try again.";

/// What a write to a list says when the id it names is not there — [`crate::deck_notes::NOTE_GONE`]
/// one table over, and for the same stale editor: another window deleted the list, or a sync did.
pub const TODO_LIST_GONE: &str = "That to-do list is not there any more.";

/// What a write says when the list it names belongs to a **different** deck.
///
/// `deck_todo_lists.deck_id` is a real foreign key, so nothing in the DDL is wrong about another
/// deck's list being edited through this deck's band — the row exists and the key is satisfied.
/// This is the fence, and a sentence rather than a constraint failure because a command parameter
/// reaches it: [`crate::deck_notes::NOTE_WRONG_DECK`]'s rule.
pub const TODO_LIST_WRONG_DECK: &str = "That to-do list belongs to a different deck.";

/// One list, as the band and its dialog read it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTodoList {
    pub id: i64,
    pub deck_id: i64,
    /// Stored as it was typed, and possibly empty — the page draws an empty one as
    /// `Untitled list`. **Not trimmed here**, where [`crate::deck_notes::create_note`] trims: the
    /// dialog autosaves the title mid-word, and a stored `"Mana"` answering a typed `"Mana "`
    /// would hand the reader back a title without the space they had just pressed.
    pub title: String,
    /// The list, in the dialect `todoMarkdown.ts` reads: headings, paragraphs and task lists.
    pub body: String,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

/// One list across every deck, as the home widget reads it — the list's own columns beside the
/// three of its deck's the widget draws or writes.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTodoListEntry {
    pub id: i64,
    pub deck_id: i64,
    pub deck_name: String,
    /// Every list is answered, an archived deck's included: whether one is drawn is the widget's
    /// `Include archived decks` toggle, a filter TypeScript applies rather than this query.
    pub archived: bool,
    /// So the widget's deck-heading press writes the disclosure only when the band is shut.
    pub todos_open: bool,
    pub title: String,
    /// Never empty here — [`every_list`] leaves an empty list out.
    pub body: String,
    /// The list's place in its deck, [`DeckTodoList::sort_order`] — so the widget can draw one
    /// deck's lists in the order the band draws them, while this read's own order stays
    /// `updated_at DESC` for the widget's `Last edited`.
    pub sort_order: i64,
    /// The widget's `Last edited` order, and the order [`every_list`] already answers in.
    pub updated_at: i64,
}

const LIST_COLUMNS: &str = "id, deck_id, title, body, sort_order, created_at, updated_at";

fn list_from(r: &rusqlite::Row<'_>) -> rusqlite::Result<DeckTodoList> {
    Ok(DeckTodoList {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        title: r.get(2)?,
        body: r.get(3)?,
        sort_order: r.get(4)?,
        created_at: r.get(5)?,
        updated_at: r.get(6)?,
    })
}

fn read_list(conn: &Connection, id: i64) -> Result<Option<DeckTodoList>, String> {
    conn.query_row(
        &format!("SELECT {LIST_COLUMNS} FROM deck_todo_lists WHERE id = ?1"),
        params![id],
        list_from,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The list `id`, having established it exists and belongs to `deck_id` — the two refusals in
/// that order, [`crate::deck_notes`]' `require_note`: "gone" and "not yours" are different things
/// to be told, and a stale band can produce either.
fn require_list(conn: &Connection, deck_id: i64, id: i64) -> Result<DeckTodoList, String> {
    match read_list(conn, id)? {
        None => Err(TODO_LIST_GONE.to_owned()),
        Some(list) if list.deck_id != deck_id => Err(TODO_LIST_WRONG_DECK.to_owned()),
        Some(list) => Ok(list),
    }
}

/// A deck's lists, in `sort_order` and then `id`.
///
/// **A pure read, and an unknown deck answers `[]`**, `deck_notes::list_notes`' standing and for
/// its reason: a deck that has gone is reported by the read that is *about* the deck, and a band
/// drawn for one has nothing to show either way. The writes are where a missing deck is refused.
///
/// **`id` breaks a `sort_order` tie**, because nothing makes the column unique: two devices each
/// appending a list while apart both take the next number, and a sync brings both here.
pub fn lists_for(conn: &Connection, deck_id: i64) -> Result<Vec<DeckTodoList>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {LIST_COLUMNS} FROM deck_todo_lists
              WHERE deck_id = ?1 ORDER BY sort_order, id"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], list_from)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// A new list at the end of the deck's lists — `max(sort_order) + 1`, or `0` for a deck's first.
///
/// **A missing deck is [`crate::deck::GONE`]**, answered by `touch_deck` before the insert, so a
/// dialog left open over a deck another window deleted is told the deck went rather than failing
/// a foreign key. The same statement moves the deck's `updated_at`.
pub fn create_list(
    conn: &Connection,
    deck_id: i64,
    title: &str,
    body: &str,
) -> Result<DeckTodoList, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    let next_order: i64 = tx
        .query_row(
            "SELECT coalesce(max(sort_order), -1) + 1 FROM deck_todo_lists WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    // **No `sync_uid` in this INSERT and there must never be one** — the capture trigger mints it.
    let id: i64 = tx
        .query_row(
            "INSERT INTO deck_todo_lists
                (deck_id, title, body, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             RETURNING id",
            params![deck_id, title, body, next_order],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    read_list(conn, id)?.ok_or_else(|| TODO_LIST_GONE.to_owned())
}

/// Change a list's title, its body, or both — `None` is *leave it alone*, and `Some("")` really
/// empties the column. With `expected`, a compare-and-set against the stored **body**.
///
/// **The refusals, in order**: a list that is not there is [`TODO_LIST_GONE`]; a list of another
/// deck is [`TODO_LIST_WRONG_DECK`]; an `expected` that is not the stored body is
/// [`TODOS_CHANGED`]. A refusal writes nothing. "Gone" is asked first because a list whose deck
/// was deleted went with it, so a stale tick against a deleted deck says the list went — the one
/// thing it can be sure of.
///
/// **A title and body both equal to the stored ones write nothing at all** — no `updated_at` on
/// either row, no capture op, no mirror pass. The dialog flushes on blur and on close, so a write
/// can carry exactly the text already stored, and one that changed nothing must not reorder the
/// widget by touching the deck.
///
/// Read and write in one transaction, so nothing can land between the comparison and the
/// `UPDATE` on this connection; the deck's `updated_at` moves in the same one.
pub fn update_list(
    conn: &Connection,
    deck_id: i64,
    id: i64,
    title: Option<&str>,
    body: Option<&str>,
    expected: Option<&str>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let stored = require_list(&tx, deck_id, id)?;
    if expected.is_some_and(|e| e != stored.body) {
        return Err(TODOS_CHANGED.to_owned());
    }
    let title = title.unwrap_or(&stored.title);
    let body = body.unwrap_or(&stored.body);
    if title == stored.title && body == stored.body {
        return Ok(());
    }
    tx.execute(
        "UPDATE deck_todo_lists
            SET title = ?2, body = ?3, updated_at = unixepoch()
          WHERE id = ?1",
        params![id, title, body],
    )
    .map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Delete a list — its to-dos are lines of its body, so they go with it.
///
/// **Idempotent on a list already gone**, where [`crate::deck_notes::delete_note`] refuses one:
/// the band's confirm and a sync can race to the same row, and "that list should not exist" is
/// satisfied by its already not existing. What stays a refusal is a list of **another** deck,
/// [`TODO_LIST_WRONG_DECK`], because that one does exist and this press was not about it.
///
/// A delete that deleted something moves the deck's `updated_at`; one that found nothing touches
/// nothing, so a repeated press does not move the deck up the gallery.
pub fn delete_list(conn: &Connection, deck_id: i64, id: i64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    match require_list(&tx, deck_id, id) {
        Err(e) if e == TODO_LIST_GONE => return Ok(()),
        Err(e) => return Err(e),
        Ok(_) => {}
    }
    tx.execute("DELETE FROM deck_todo_lists WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    tx.commit().map_err(|e| e.to_string())
}

/// Every list with a non-empty body across every deck, most recently edited first — the home
/// widget's read, with the three deck columns it draws beside each list.
///
/// **`id` breaks a tie**, because `updated_at` is whole seconds and two lists touched in one second
/// are an ordinary state; without it the widget's order would be whatever SQLite happened to
/// return. **An empty body is left out** and an empty *title* is not: a list with nothing in it
/// has nothing for the widget to draw, while an untitled list with to-dos is drawn as
/// `Untitled list`.
pub fn every_list(conn: &Connection) -> Result<Vec<DeckTodoListEntry>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT l.id, l.deck_id, d.name, d.archived, d.todos_open, l.title, l.body,
                    l.sort_order, l.updated_at
               FROM deck_todo_lists l JOIN decks d ON d.id = l.deck_id
              WHERE l.body <> ''
              ORDER BY l.updated_at DESC, l.id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DeckTodoListEntry {
                id: r.get(0)?,
                deck_id: r.get(1)?,
                deck_name: r.get(2)?,
                archived: r.get::<_, i64>(3)? != 0,
                todos_open: r.get::<_, i64>(4)? != 0,
                title: r.get(5)?,
                body: r.get(6)?,
                sort_order: r.get(7)?,
                updated_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real user schema over [`crate::schema::memory_pair`], `sticky_notes`' `db()`, with three
    /// bare decks: a live one, an archived one with its band open, and a third that never gets a
    /// list — so "leaves empty ones out" has something to leave out. Foreign keys on, so the
    /// cascade test is the cascade and not a hand-written delete.
    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             INSERT INTO decks (id, name, format_key, archived, todos_open, created_at, updated_at)
             VALUES (1, 'Burn', 'modern', 0, 0, 0, 0),
                    (2, 'Zoo', 'modern', 1, 1, 0, 0),
                    (3, 'Empty', 'modern', 0, 0, 0, 0);",
        )
        .unwrap();
        conn
    }

    fn deck_stamp(conn: &Connection, deck_id: i64) -> i64 {
        conn.query_row(
            "SELECT updated_at FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Both clocks back to zero, so a write that touches either is visible as a non-zero.
    fn backdate(conn: &Connection) {
        conn.execute_batch(
            "UPDATE decks SET updated_at = 0; UPDATE deck_todo_lists SET updated_at = 0;",
        )
        .unwrap();
    }

    fn body_of(conn: &Connection, id: i64) -> String {
        read_list(conn, id).unwrap().unwrap().body
    }

    #[test]
    fn a_new_list_goes_at_the_end_and_touches_the_deck() {
        let conn = db();
        let first = create_list(&conn, 1, "Mana", "- [ ] Cut a land").unwrap();
        assert_eq!(first.sort_order, 0, "a deck's first list is at 0");
        assert_eq!(first.deck_id, 1);
        assert_eq!(first.title, "Mana");
        assert_eq!(first.body, "- [ ] Cut a land");
        assert!(first.created_at > 0 && first.updated_at > 0);
        assert!(deck_stamp(&conn, 1) > 0, "the create touches the deck");

        conn.execute("UPDATE deck_todo_lists SET sort_order = 7", [])
            .unwrap();
        let second = create_list(&conn, 1, "", "").unwrap();
        assert_eq!(second.sort_order, 8, "max(sort_order) + 1, not a count");
        assert_eq!(second.title, "", "an empty title is stored as it was sent");
    }

    #[test]
    fn a_title_is_stored_as_it_was_typed() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana ", "").unwrap();
        assert_eq!(
            list.title, "Mana ",
            "the dialog saves mid-word; the space is the reader's"
        );
    }

    #[test]
    fn a_list_cannot_be_started_on_a_deck_that_is_not_there() {
        let conn = db();
        assert_eq!(
            create_list(&conn, 404, "t", "").unwrap_err(),
            crate::deck::GONE
        );
        let n: i64 = conn
            .query_row("SELECT count(*) FROM deck_todo_lists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "a refusal writes nothing");
    }

    #[test]
    fn a_decks_lists_read_in_sort_order_then_id_and_an_unknown_deck_reads_empty() {
        let conn = db();
        let a = create_list(&conn, 1, "a", "").unwrap();
        let b = create_list(&conn, 1, "b", "").unwrap();
        let c = create_list(&conn, 1, "c", "").unwrap();
        create_list(&conn, 2, "elsewhere", "").unwrap();
        conn.execute(
            "UPDATE deck_todo_lists SET sort_order = 0 WHERE id IN (?1, ?2)",
            params![b.id, c.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE deck_todo_lists SET sort_order = 5 WHERE id = ?1",
            params![a.id],
        )
        .unwrap();
        let ids: Vec<i64> = lists_for(&conn, 1).unwrap().iter().map(|l| l.id).collect();
        assert_eq!(ids, vec![b.id, c.id, a.id], "sort_order, then id on a tie");
        assert!(lists_for(&conn, 3).unwrap().is_empty());
        assert!(lists_for(&conn, 404).unwrap().is_empty());
    }

    #[test]
    fn an_update_writes_both_columns_and_touches_both_clocks() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        backdate(&conn);
        update_list(&conn, 1, list.id, Some("Curve"), Some("- [x] a"), None).unwrap();
        let after = read_list(&conn, list.id).unwrap().unwrap();
        assert_eq!(
            (after.title.as_str(), after.body.as_str()),
            ("Curve", "- [x] a")
        );
        assert!(after.updated_at > 0, "the list's own clock moved");
        assert!(deck_stamp(&conn, 1) > 0, "and the deck's");
    }

    #[test]
    fn a_null_field_is_left_alone_and_an_empty_one_empties_it() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        update_list(&conn, 1, list.id, None, Some("- [ ] b"), None).unwrap();
        let after = read_list(&conn, list.id).unwrap().unwrap();
        assert_eq!(after.title, "Mana", "an absent title is left alone");
        assert_eq!(after.body, "- [ ] b");
        update_list(&conn, 1, list.id, Some(""), None, None).unwrap();
        let after = read_list(&conn, list.id).unwrap().unwrap();
        assert_eq!(after.title, "", "Some(\"\") really empties the column");
        assert_eq!(after.body, "- [ ] b", "an absent body is left alone");
    }

    #[test]
    fn a_matching_expected_writes_and_a_moved_one_refuses_and_writes_nothing() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        update_list(&conn, 1, list.id, None, Some("- [x] a"), Some("- [ ] a")).unwrap();
        assert_eq!(body_of(&conn, list.id), "- [x] a");
        backdate(&conn);
        assert_eq!(
            update_list(&conn, 1, list.id, None, Some("- [ ] a"), Some("- [ ] a")).unwrap_err(),
            TODOS_CHANGED
        );
        assert_eq!(
            body_of(&conn, list.id),
            "- [x] a",
            "a refusal writes nothing"
        );
        assert_eq!(deck_stamp(&conn, 1), 0, "not even the deck's clock");
    }

    #[test]
    fn an_update_to_a_list_that_is_not_there_is_gone() {
        let conn = db();
        assert_eq!(
            update_list(&conn, 1, 404, None, Some("- [ ] a"), None).unwrap_err(),
            TODO_LIST_GONE
        );
        // Gone outranks a stale `expected`: there is no stored body to have moved.
        assert_eq!(
            update_list(&conn, 1, 404, None, Some("- [ ] a"), Some("x")).unwrap_err(),
            TODO_LIST_GONE
        );
    }

    #[test]
    fn an_update_through_another_deck_is_refused_in_words_and_writes_nothing() {
        let conn = db();
        let list = create_list(&conn, 2, "Zoo's", "- [ ] a").unwrap();
        backdate(&conn);
        assert_eq!(
            update_list(&conn, 1, list.id, None, Some("- [x] a"), None).unwrap_err(),
            TODO_LIST_WRONG_DECK
        );
        // Wrong deck outranks a stale `expected`, the spec's order.
        assert_eq!(
            update_list(&conn, 1, list.id, None, Some("- [x] a"), Some("x")).unwrap_err(),
            TODO_LIST_WRONG_DECK
        );
        assert_eq!(body_of(&conn, list.id), "- [ ] a");
        assert_eq!(deck_stamp(&conn, 1), 0);
        assert_eq!(deck_stamp(&conn, 2), 0);
    }

    #[test]
    fn an_update_equal_to_what_is_stored_touches_neither_clock() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        backdate(&conn);
        update_list(&conn, 1, list.id, Some("Mana"), Some("- [ ] a"), None).unwrap();
        update_list(&conn, 1, list.id, None, None, None).unwrap();
        update_list(&conn, 1, list.id, None, Some("- [ ] a"), Some("- [ ] a")).unwrap();
        assert_eq!(
            read_list(&conn, list.id).unwrap().unwrap().updated_at,
            0,
            "a write that changes nothing does not touch the list"
        );
        assert_eq!(deck_stamp(&conn, 1), 0, "nor the deck");
    }

    #[test]
    fn a_delete_touches_the_deck_and_a_second_one_is_a_quiet_success() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        backdate(&conn);
        delete_list(&conn, 1, list.id).unwrap();
        assert!(read_list(&conn, list.id).unwrap().is_none());
        assert!(deck_stamp(&conn, 1) > 0, "the delete touches the deck");

        backdate(&conn);
        delete_list(&conn, 1, list.id).unwrap();
        assert_eq!(
            deck_stamp(&conn, 1),
            0,
            "a delete that found nothing touches nothing"
        );
        delete_list(&conn, 404, 404).unwrap();
    }

    #[test]
    fn a_delete_through_another_deck_is_refused_and_the_list_stays() {
        let conn = db();
        let list = create_list(&conn, 2, "Zoo's", "- [ ] a").unwrap();
        assert_eq!(
            delete_list(&conn, 1, list.id).unwrap_err(),
            TODO_LIST_WRONG_DECK
        );
        assert!(read_list(&conn, list.id).unwrap().is_some());
    }

    #[test]
    fn deleting_a_deck_takes_its_lists_with_it() {
        let conn = db();
        create_list(&conn, 1, "a", "- [ ] a").unwrap();
        create_list(&conn, 1, "b", "- [ ] b").unwrap();
        let kept = create_list(&conn, 2, "c", "- [ ] c").unwrap();
        conn.execute("DELETE FROM decks WHERE id = 1", []).unwrap();
        let left: Vec<i64> = conn
            .prepare("SELECT id FROM deck_todo_lists")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(left, vec![kept.id], "the CASCADE, and only this deck's");
    }

    #[test]
    fn every_list_leaves_empty_bodies_out_carries_its_deck_and_reads_newest_first() {
        let conn = db();
        let one = create_list(&conn, 1, "One", "- [ ] one").unwrap();
        let two = create_list(&conn, 2, "", "- [ ] two").unwrap();
        let tie = create_list(&conn, 1, "Tie", "- [ ] tie").unwrap();
        create_list(&conn, 1, "Blank", "").unwrap();
        conn.execute(
            "UPDATE deck_todo_lists SET updated_at = 10 WHERE id IN (?1, ?2)",
            params![one.id, tie.id],
        )
        .unwrap();
        conn.execute(
            "UPDATE deck_todo_lists SET updated_at = 20 WHERE id = ?1",
            params![two.id],
        )
        .unwrap();

        let lists = every_list(&conn).unwrap();
        let ids: Vec<i64> = lists.iter().map(|l| l.id).collect();
        assert_eq!(
            ids,
            vec![two.id, one.id, tie.id],
            "newest first, id on a tie, and the empty body left out"
        );
        assert_eq!(
            lists[0],
            DeckTodoListEntry {
                id: two.id,
                deck_id: 2,
                deck_name: "Zoo".to_owned(),
                archived: true,
                todos_open: true,
                title: String::new(),
                body: "- [ ] two".to_owned(),
                sort_order: 0,
                updated_at: 20,
            },
            "an untitled list with to-dos is answered, with its deck's name and both switches"
        );
        assert!(!lists[1].archived && !lists[1].todos_open);
        assert_eq!(lists[1].deck_name, "Burn");
        assert_eq!(
            lists.iter().map(|l| l.sort_order).collect::<Vec<_>>(),
            vec![0, 0, 1],
            "each list's place in its own deck, never its place in this answer"
        );
    }

    /// A copy starts with no lists — #672's reason: a copy that carried its original's lists
    /// would draw every open to-do in the widget twice, and ticking one would leave its twin open.
    #[test]
    fn a_duplicate_carries_no_list() {
        let conn = db();
        create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        let copy = crate::deck::duplicate_deck(&conn, 1).unwrap();
        assert!(lists_for(&conn, copy.id).unwrap().is_empty());
    }

    /// **No INSERT here names `sync_uid`** — the capture trigger mints it, and nothing in any
    /// `deck*.rs` has ever written that column. A fixture has no triggers installed, so the
    /// column staying NULL is the evidence the statement did not touch it. `deck_notes.rs`' fence,
    /// one table over.
    #[test]
    fn nothing_here_writes_the_sync_uid_column() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        update_list(&conn, 1, list.id, Some("Curve"), Some("- [x] a"), None).unwrap();
        let unset: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_todo_lists WHERE sync_uid IS NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            unset, 1,
            "deck_todo_lists had its uid written by this crate"
        );
    }

    /// And no write here leaves a history row or an undo step — the module doc's rule, pinned so
    /// a later "consistency" pass that copies `deck_notes`' journalling has to delete a test.
    #[test]
    fn a_list_write_records_no_history_and_no_step() {
        let conn = db();
        let list = create_list(&conn, 1, "Mana", "- [ ] a").unwrap();
        update_list(&conn, 1, list.id, None, Some("- [x] a"), None).unwrap();
        delete_list(&conn, 1, list.id).unwrap();
        for table in ["deck_audit", "deck_undo", "activity"] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 0, "{table} gained a row from a to-do list write");
        }
    }
}
