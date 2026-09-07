//! How the reader has the deck gallery ordered — the setting, and nothing else.
//!
//! **The order is TypeScript's; the row is this crate's.** Which keys the picker offers, what
//! each one compares, which direction is a key's *natural* one and what the toggle then does to
//! it are all questions about a wall this crate never draws. All Rust owns is one `app_meta` row
//! holding a single string like `"updated:desc"`, and the rule that a database with nothing in
//! that row opens on [`DEFAULT`].
//!
//! That is [`crate::listview`]'s split with the vocabulary handed over entirely, and the
//! difference is the whole of what is worth writing down here. That module checks the word it is
//! given against [`crate::listview::LAYOUTS`], because a wall is drawn one of two ways and this
//! build knows both. **This one checks nothing but emptiness**, because the words are
//! `src/features/decks/deckSort.ts`'s — six keys and two directions today — and *a database
//! outlives the app*. A key a later build stops offering, or one an earlier build has never
//! heard of, has to degrade to the default **on the reading side**; refused at the write end it
//! would instead be a reader whose sort silently would not save, on a build that had every
//! reason to think it had. The read side that degrades it is TypeScript's, for the same reason
//! the vocabulary is.
//!
//! So the two rules are [`crate::listview`]'s, one of them narrowed:
//!
//! * **Reading can never fail.** A missing row, an unreadable row, a row somebody hand-edited to
//!   a blank — every one of them answers [`DEFAULT`], and [`deck_sort`] is therefore infallible
//!   by signature ([`crate::zoom::card_zoom`]'s contract). A preference that cannot be read is
//!   not worth refusing to draw a gallery over.
//! * **Writing validates exactly one thing.** [`store`] refuses an empty string —
//!   [`crate::listview::store`]'s blank-section refusal, and its reason: an empty value is a bug
//!   in the caller rather than an order, and stored it would be a row that reads back as
//!   "nothing stored" forever while looking saved. Everything else is written as given.
//!
//! **A default here and not, as [`crate::listview::stored`] has it, an absence.** That module
//! answers a map and lets a missing entry mean "the frontend's own default"; there is one
//! setting here and one string to answer with, so an `Option` would be an emptiness every caller
//! had to spell the same fallback for. [`DEFAULT`] is the order the gallery has always opened on
//! — most recently touched first — so a fresh install and a database at head answer the same
//! thing.
//!
//! **Only the sort is remembered.** A filter is a thing a reader is doing right now, and a
//! gallery that opened already narrowed, with no memory of having asked for it, is a gallery
//! that looks like it has lost decks.
//!
//! No migration: `app_meta` is schema v6's key/value table — the *application's*, deliberately
//! not `sync_meta`, where a row the sync did not write makes every later timing claim a fiction
//! — and this is a key in it.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key.
pub const K_DECK_SORT: &str = "deck_sort";

/// What a database that has never been asked answers: most recently touched first.
///
/// **Spelled here as well as in `deckSort.ts`, and the duplication is deliberate.** The two
/// halves cannot share a constant across the wire, and the alternative — answering an empty
/// string and making every caller supply its own fallback — would put the same duplication in
/// more places, none of them named. If the frontend's default ever moves, this string is the one
/// place on this side to move it, and a reader whose row already says something is unaffected
/// either way.
pub const DEFAULT: &str = "updated:desc";

/// The whole of what this crate checks about a stored order, and `listview`'s `NO_SECTION`
/// one module over: the words themselves are TypeScript's, but an empty string is not an order
/// in any vocabulary — it is a bug in the caller, and storing it would put a row in `app_meta`
/// that every read discards while the write that made it reported success.
const NO_SORT: &str = "A deck sort cannot be blank.";

/// How the gallery is ordered, or [`DEFAULT`] if nothing usable is stored.
///
/// The breadth of "nothing usable" is one line and is the point: no row (a fresh install, and
/// the common case), a row `get_app_meta` could not read at all, and a row somebody emptied by
/// hand. **A row holding a key this build has never heard of is not on that list** — it is
/// answered verbatim, because this build has no vocabulary to judge it against and the side that
/// does is the one drawing the wall. See the module doc.
pub fn stored(conn: &Connection) -> String {
    crate::app_meta::get_app_meta(conn, K_DECK_SORT)
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| DEFAULT.to_owned())
}

/// Remember how the gallery is ordered.
///
/// One refusal, and [`stored`]'s silence about everything else is why there is exactly one: a
/// blank would look saved and read back as nothing forever, and nothing else can, because
/// nothing else is discarded on the way back.
pub fn store(conn: &Connection, sort: &str) -> Result<(), String> {
    if sort.is_empty() {
        return Err(NO_SORT.to_owned());
    }
    crate::app_meta::set_app_meta(conn, K_DECK_SORT, sort)
        .map_err(|e| format!("could not save the deck order: {e}"))
}

/// How the reader has the deck gallery ordered.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason:
/// the frontend reads this once while the gallery is drawing its first frame, to seed a store
/// already built out of its own default, and there is nothing a wall of decks could do with an
/// error here that is not just "open on the order you already have".
///
/// `#[tauri::command(async)]` rather than a bare sync command, also [`crate::listview`]'s: a
/// sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which a search
/// may hold for tens of milliseconds.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn deck_sort(state: tauri::State<'_, Arc<AppState>>) -> String {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember how the gallery is ordered. Refuses a blank, and answers [`crate::db::BUSY`] if a
/// sync holds the write connection — the bound every write command in this crate takes.
///
/// **A refusal here is not worth surfacing**, [`crate::listview::set_list_view`]'s note and for
/// its reason: the frontend writes optimistically and keeps the reader's choice for the session
/// either way, so a BUSY during a first-run sync costs them nothing they can see now and only
/// the next launch's starting order.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_deck_sort(
    state: tauri::State<'_, Arc<AppState>>,
    sort: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &sort))
    })
    .await
    .map_err(|e| format!("the deck order could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// A database nobody has sorted has nothing to say about the gallery, and this is the state
    /// every fresh install is in — so it is the one the default has to be right about. Asserted
    /// against a missing row rather than only against the answer, because "no row" and "a row
    /// holding the default" are two different databases that must read the same.
    #[test]
    fn a_missing_row_answers_the_default() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_DECK_SORT), None);
        assert_eq!(stored(&conn), DEFAULT);
    }

    /// The setting outlives the process, so the only thing that matters about it is that what
    /// went in comes back out — repeatedly, because a reader changes this one more often than
    /// they change anything else on the page.
    #[test]
    fn a_written_order_round_trips() {
        let conn = db();
        for sort in ["name:asc", "colors:asc", "bracket:desc", "name:asc"] {
            store(&conn, sort).unwrap();
            assert_eq!(stored(&conn), sort);
        }
    }

    /// **The rule this module exists to state, and the one that separates it from
    /// [`crate::listview`].** The words are TypeScript's, so a key this build has never heard of
    /// is stored as given and answered as given: a database outlives the app, and a build that
    /// refused what it did not recognise would refuse tomorrow's vocabulary today.
    #[test]
    fn a_key_this_build_does_not_know_is_stored_and_answered_verbatim() {
        let conn = db();
        for sort in [
            "price:desc",
            "updated:sideways",
            "something_else_entirely",
            "x",
        ] {
            store(&conn, sort).unwrap();
            assert_eq!(
                stored(&conn),
                sort,
                "`{sort}` is TypeScript's to judge, not this crate's"
            );
        }
    }

    /// A row this build cannot make sense of costs the reader their order and nothing else.
    /// Written past [`store`] deliberately — a blank row is what a hand-edit or a different
    /// build leaves behind, which no validation of ours was ever in a position to refuse.
    #[test]
    fn a_blank_row_answers_the_default_rather_than_failing() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_DECK_SORT, "").unwrap();
        assert_eq!(stored(&conn), DEFAULT);
    }

    /// The complement of the read rule above: a blank is refused at the door rather than stored
    /// and silently discarded on every later launch.
    #[test]
    fn a_blank_order_is_refused() {
        let conn = db();
        assert_eq!(store(&conn, "").unwrap_err(), NO_SORT);
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_DECK_SORT), None);
    }

    /// A junk row is not sticky: the next write puts the setting back on its feet, so a reader
    /// who hits this never has to be told to clear anything.
    #[test]
    fn a_write_over_a_blank_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_DECK_SORT, "").unwrap();
        assert_eq!(stored(&conn), DEFAULT);

        store(&conn, "cards:desc").unwrap();
        assert_eq!(stored(&conn), "cards:desc");
    }
}
