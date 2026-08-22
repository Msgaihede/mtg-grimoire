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

/// Flip the setting: the bit, **and the allocation ledger the mode it hands back to reads**.
///
/// [`store`] is the bit on its own and is the wrong thing for a command to call, because
/// flipping this switch is not only a change of where the collection is read from — it is the
/// end of a period in which nothing kept `deck_allocations` in step.
/// [`crate::deck::allocate_deck`] returns early for the whole of that period (every card write
/// calls it, and every one of those calls does nothing), so a deck the reader edited while the
/// setting was on still has the claims it had when they turned it on: rows reserving copies for
/// cards that deck no longer holds. Those claims cost **other** decks — availability is the
/// entry's quantity minus the claims of other built decks — so a reader who switches back finds
/// a deck short a copy it owns, a shopping list telling them to buy it, and no way to clear it
/// but a card write to the deck that went stale.
///
/// So on the way **off**, every deck is reallocated. Nothing is done on the way **on**: the
/// ledger is not read in that mode, and emptying it there would throw away a state the reader
/// may be one press away from wanting back. The alternative design — clear the ledger as the
/// setting goes on and let the first later write rebuild it — is simpler and does exactly that
/// throwing away, which is why this is the arm that carries the work.
///
/// **One transaction, and the order inside it is load-bearing twice over.** The flag is written
/// first because [`crate::deck::allocate_every_deck`] asks [`stored`] and would stand down if it
/// still read on; and both writes commit together because a crash between them lands on the very
/// state this repairs — a hand-kept collection reading a ledger from a mode that never used it.
pub fn switch(conn: &Connection, enabled: bool) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    store(&tx, enabled)?;
    if !enabled {
        crate::deck::allocate_every_deck(&tx)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
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
/// **[`switch`] and not [`store`]**: on the way off it also rebuilds `deck_allocations`, in the
/// same transaction as the flag. See that function for why the ledger cannot be trusted after a
/// spell of the setting being on.
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
    tauri::async_runtime::spawn_blocking(move || write_setting(&state, enabled))
        .await
        .map_err(|e| format!("the collection setting could not be saved: {e}"))?
}

/// The command's whole body, lifted out so that a test can reach it.
///
/// **Not ceremony.** A `#[tauri::command]` takes a `tauri::State`, which a unit test has no way
/// to build, so the one line saying *which* of [`store`] and [`switch`] the running app calls
/// was the only line in this module nothing could execute. It was wrong once — the ledger
/// rebuild below was written, tested and completely unreachable from the app, with every test
/// in the crate green. `the_command_writes_the_flag_and_rebuilds_the_ledger` is what now stands
/// in that gap.
pub(crate) fn write_setting(state: &Arc<AppState>, enabled: bool) -> Result<(), String> {
    crate::collection_source::with_write_owned(state, |conn| switch(conn, enabled))
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

    /// **The wiring, which is the half of this module a `&Connection` test cannot see.**
    /// `switch`'s own tests live in `deck.rs`, where the deck fixtures are, and they prove the
    /// rebuild works; none of them can prove the *command* calls it. Left to `store`, every one
    /// of those tests still passes and the reader's ledger is never repaired.
    ///
    /// A phantom claim is planted by hand — a deck that holds no cards at all, reserving four
    /// copies — because that is what a spell of the setting being on leaves behind, and it is
    /// what a rebuild has to sweep. The setting goes on (the claim must survive) and off again
    /// (it must not).
    #[test]
    fn the_command_writes_the_flag_and_rebuilds_the_ledger() {
        let state = crate::index::fixtures::state_with_seeded_cards("deck-driven-command");
        crate::sync::with_write(&state, |conn| {
            conn.execute_batch(
                "INSERT INTO collection_entries
                    (id,card_id,set_code,collector_number,lang,finish,condition,quantity,
                     created_at,updated_at)
                 VALUES (1,'1','lea','1','en','nonfoil','NM',4,0,0);

                 INSERT INTO decks (id,name,created_at,updated_at) VALUES (1,'Burn',0,0);

                 INSERT INTO deck_allocations
                    (deck_id,collection_entry_id,quantity,created_at,updated_at)
                 VALUES (1,1,4,0,0);",
            )
            .map_err(|e| e.to_string())
        })
        .unwrap();

        let claims = || -> i64 {
            crate::sync::lock_db_read(&state)
                .query_row("SELECT count(*) FROM deck_allocations", [], |r| r.get(0))
                .unwrap()
        };
        let flag = || stored(&crate::sync::lock_db_read(&state));

        write_setting(&state, true).unwrap();
        assert!(flag(), "the bit is still written");
        assert_eq!(claims(), 1, "the way on touches no claim");

        write_setting(&state, false).unwrap();
        assert!(!flag());
        assert_eq!(
            claims(),
            0,
            "the command reaches `switch`, not `store`: a deck holding no cards claims none"
        );
    }
}
