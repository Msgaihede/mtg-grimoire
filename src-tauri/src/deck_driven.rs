//! Whether the reader's collection is derived from their decks.
//!
//! One bit in `app_meta` (schema v6) — **no migration**, the same as [`crate::nav`], whose
//! shape this module copies wholesale. When it is on, every "what does the reader own"
//! query in the crate reads the sum of the `live` deck lists instead of
//! `collection_entries`; [`crate::collection_source`] owns that rule and this module owns
//! only the bit.
//!
//! **Nothing is deleted when it goes on.** The reader's hand-built rows stay on disk and
//! come back untouched the moment it goes off, which is the whole reason the switch is safe
//! to try — and the reason the five collection writes refuse while it is on rather than
//! writing somewhere invisible (see [`crate::collection`]).

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// The `app_meta` key.
///
/// `app_meta` is the *application's* key/value table, deliberately not `sync_meta` — a row in
/// that one the sync did not write makes every later timing claim a fiction.
pub const K_DECK_DRIVEN: &str = "deck_driven_collection";

/// What a deck-driven collection is written as, and the *only* string that reads back as one.
///
/// Named rather than inlined because [`stored`] and [`store`] have to agree on it character
/// for character: the read is an equality test with no parser behind it, so a second spelling
/// at the write end would not fail anywhere — the reader's choice would simply never come
/// back, on every launch, with nothing logged.
const ON: &str = "1";

/// What a hand-kept collection is written as.
///
/// It matters that switching off writes a value rather than deleting the row: that is the
/// state [`stored`] answers for a missing row anyway, so the temptation is to treat the row's
/// *existence* as the setting. That implementation reads correctly and clears wrong — see
/// `switching_it_off_again_clears_a_stored_on`.
const OFF: &str = "0";

/// Is the collection derived from the reader's decks?
///
/// **Infallible, and that breadth is the rule**: no row (a fresh install, and the common
/// case), an unreadable row (`get_app_meta` swallows the error), `"true"`, `"yes"`, `"2"` —
/// every one of them answers `false`, which is the hand-kept collection the reader's rows are
/// still sitting in. That is the right floor: the degraded state shows them their own data.
///
/// Called inside query builders on a connection the caller already holds, which is the shape
/// `crate::deck_meta::readback_marketplace` established (`deck_meta.rs:431`) — a Rust value
/// that picks a SQL branch, never a bound parameter.
pub fn stored(conn: &Connection) -> bool {
    crate::update::get_app_meta(conn, K_DECK_DRIVEN).as_deref() == Some(ON)
}

/// Remember whether the collection is deck driven.
///
/// **No refusals**, unlike [`crate::zoom::store`]: a `bool` off the IPC boundary has no junk
/// state — `serde` has already rejected everything that is not `true` or `false` — so there
/// is nothing here for a validation arm to catch. The `Result` is SQLite's.
pub fn store(conn: &Connection, enabled: bool) -> Result<(), String> {
    let value = if enabled { ON } else { OFF };
    crate::update::set_app_meta(conn, K_DECK_DRIVEN, value)
        .map_err(|e| format!("could not save the collection setting: {e}"))
}

/// Whether the collection is derived from the reader's decks.
///
/// **Infallible by signature**, [`crate::nav::nav_collapsed`]'s contract for its reason: there
/// is nothing the page could do with an error here that is not "draw the hand-kept
/// collection", so this answers that instead of making the caller spell it out.
#[tauri::command(async)]
pub fn deck_driven_collection(state: tauri::State<'_, Arc<AppState>>) -> bool {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the choice. Answers [`crate::db::BUSY`] if a sync holds the write connection.
///
/// **Through [`crate::collection_source::with_write_owned`], not bare `with_write`** — and
/// that is the one line of this module that is not [`crate::nav`]'s. Flipping this bit
/// changes which cards are owned without touching either table, so the `owned` dimension is
/// stale the instant the write lands. It is the one index dimension that moves without a
/// sync, and nothing on screen would say so.
///
/// **A refusal here IS surfaced**, unlike the nav rail's. That switch costs a reader one
/// launch's starting state; this one changes what their whole Collection page is a list of,
/// so a write that silently did not land would leave the page and the setting disagreeing
/// until the next restart.
#[tauri::command]
pub async fn set_deck_driven_collection(
    state: tauri::State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |conn| store(conn, enabled))
    })
    .await
    .map_err(|e| format!("the collection setting could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn a_fresh_database_is_not_deck_driven() {
        assert!(!stored(&db()));
    }

    #[test]
    fn a_stored_choice_reads_back() {
        let conn = db();
        store(&conn, true).unwrap();
        assert!(stored(&conn));
    }

    /// The case a "the row's existence is the setting" implementation reads correctly and
    /// clears wrong. `nav.rs`'s `expanding_again_clears_a_stored_collapse` is this test.
    #[test]
    fn switching_it_off_again_clears_a_stored_on() {
        let conn = db();
        store(&conn, true).unwrap();
        store(&conn, false).unwrap();
        assert!(!stored(&conn));
        assert_eq!(
            crate::update::get_app_meta(&conn, K_DECK_DRIVEN).as_deref(),
            Some("0"),
            "off must write a value, not delete the row"
        );
    }

    /// Everything that is not exactly "1" is off, and the breadth of that is the rule: a
    /// hand-edit, or a build that spelled the value differently, must not fail anything.
    #[test]
    fn junk_in_the_row_reads_as_off() {
        let conn = db();
        for junk in ["true", "yes", "2", "", "on"] {
            crate::update::set_app_meta(&conn, K_DECK_DRIVEN, junk).unwrap();
            assert!(!stored(&conn), "{junk:?} should read as off");
        }
    }
}
