//! Whether the reader has collapsed the app shell's global navigation rail — the setting, and
//! nothing else.
//!
//! **The rail is TypeScript's; the row is this crate's.** How wide the rail sits when it is open,
//! what it shrinks to when it is not, which of its labels survive the collapse and whether the
//! change is animated are all questions about a shell this crate never draws. All Rust owns is one
//! `app_meta` row holding `"1"` or `"0"`, plus the rule that anything else means *not collapsed*.
//! That is [`crate::marketplace`]'s split and [`crate::zoom`]'s: Rust stores the fact, the
//! frontend draws every conclusion from it.
//!
//! Two rules shape it, and they are [`crate::zoom`]'s two — the second one hollowed out:
//!
//! * **Reading can never fail.** A missing row, a row holding something that is neither `"1"` nor
//!   `"0"`, a row that cannot be read at all — every one of them reads as **expanded**. The rail's
//!   job is to be there: it is how a reader reaches every other page, so a preference that cannot
//!   be read is not worth refusing to draw the window's navigation over, and expanded is the one
//!   state a reader can always get out of by pressing something they can see. [`nav_collapsed`] is
//!   therefore infallible by signature — a bare `bool`, not a `Result`, which is
//!   [`crate::zoom::card_zoom`]'s contract rather than a shortcut.
//! * **Writing is where validation would live — and here there is nothing to validate.** A `bool`
//!   off the IPC boundary has no junk state the way [`crate::zoom`]'s multiplier or
//!   [`crate::card::store_group_by`]'s mode name does: `serde` has already refused everything that
//!   is not `true` or `false` before [`store`] is reached, and both of those are storable. So
//!   [`store`] carries no refusals at all, and the asymmetry with its two sibling modules is the
//!   point rather than an omission — their `Err` arms exist because an `f64` and a `String` can
//!   each carry a value the read side would silently discard, and a `bool` cannot. The one `Err`
//!   [`store`] does answer is SQLite's, which is plumbing failing rather than an argument being
//!   refused.
//!
//! `"1"`/`"0"` rather than `"true"`/`"false"` or a JSON document, for the reason the read rule
//! makes cheap: the value is one bit, and every spelling that is not the one this module writes
//! already reads as expanded without a parser being involved. A hand-edit or a build that spells
//! it differently costs the reader their collapsed rail on one launch, which is the smallest
//! failure available here.
//!
//! No migration. `app_meta` is the *application's* key/value table (schema v6), deliberately not
//! `sync_meta` — a row in that one the sync did not write makes every later timing claim a fiction
//! — and this is a key in a table that has existed since v6. A preference that needed a schema
//! step would be a preference that could fail a launch.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key.
///
/// `app_meta` is the *application's* key/value table (schema v6), deliberately not `sync_meta` —
/// a row in that one the sync did not write makes every later timing claim a fiction. **No
/// migration**: this is a key in a table that has existed since v6.
pub const K_NAV_COLLAPSED: &str = "nav_collapsed";

/// What a collapsed rail is written as, and the *only* string that reads back as one.
///
/// Named rather than inlined because [`stored`] and [`store`] have to agree on it character for
/// character: the read is an equality test with no parser behind it, so a second spelling
/// introduced at the write end would not fail anywhere — it would simply mean the reader's choice
/// never came back, on every launch, with nothing logged.
const COLLAPSED: &str = "1";

/// What an expanded rail is written as.
///
/// It matters that expanding writes a value rather than deleting the row: this is the state
/// [`stored`] would answer for a missing row anyway, so the temptation is to treat the row's
/// *existence* as the setting. That implementation reads correctly and clears wrong — see
/// `expanding_again_clears_a_stored_collapse`.
const EXPANDED: &str = "0";

/// Is the navigation rail collapsed?
///
/// Everything that is not exactly `"1"` is expanded, and the breadth of that is the whole
/// rule: no row (a fresh install, and the common case), an unreadable row (`get_app_meta` swallows
/// the error), `"true"`, `"yes"`, `"2"` — what a hand-edit or a build that spelled the value
/// differently leaves behind. None of them is worth failing over, and all of them mean the same
/// thing to the caller: draw the rail.
pub fn stored(conn: &Connection) -> bool {
    crate::app_meta::get_app_meta(conn, K_NAV_COLLAPSED).as_deref() == Some(COLLAPSED)
}

/// Remember whether the rail is collapsed.
///
/// **No refusals**, unlike [`crate::zoom::store`] and [`crate::card::store_group_by`]: a `bool` has
/// no value this module would rather not store, so there is nothing here for a validation arm to
/// catch. The `Result` is SQLite's — a full or read-only disk — and it is a failure of the write
/// rather than a judgement about the argument.
///
/// **`false` writes `"0"`; it does not delete the row.** Both spellings have to reach the table,
/// because a reader who collapses the rail and then opens it again has made a second choice and
/// not withdrawn the first.
pub fn store(conn: &Connection, collapsed: bool) -> Result<(), String> {
    let value = if collapsed { COLLAPSED } else { EXPANDED };
    crate::app_meta::set_app_meta(conn, K_NAV_COLLAPSED, value)
        .map_err(|e| format!("could not save the navigation state: {e}"))
}

/// Whether the navigation rail opens collapsed.
///
/// **Infallible by signature**, which is [`crate::zoom::card_zoom`]'s contract and for its reason:
/// the frontend reads this to seed a store that already has a default of its own, and there is
/// nothing the app shell could do with an error here that is not just "draw the rail" — so this
/// answers that instead of making the caller spell it out.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame. It is not an `async fn`
/// because Tauri requires a `Result` from one that borrows `State`, and a `Result` here would be a
/// failure mode this call does not have.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn nav_collapsed(state: tauri::State<'_, Arc<AppState>>) -> bool {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember whether the rail is collapsed. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// **A refusal here is deliberately not surfaced**, which is a fact about the caller rather than
/// about this function: the frontend writes optimistically and keeps the reader's choice for the
/// session either way, so a BUSY during a first-run sync costs them nothing they can see now and
/// only the next launch's starting state. Nothing on screen would be improved by saying so.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_nav_collapsed(
    state: tauri::State<'_, Arc<AppState>>,
    collapsed: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, collapsed))
    })
    .await
    .map_err(|e| format!("the navigation state could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The setting outlives the process, so the only thing that matters about it is that what went
    /// in comes back out — in both directions, and repeatedly, because a reader toggles this one
    /// far more often than they change a marketplace.
    #[test]
    fn both_states_round_trip() {
        let conn = db();
        for collapsed in [true, false, true, true, false, false] {
            store(&conn, collapsed).unwrap();
            assert_eq!(stored(&conn), collapsed);
        }
    }

    /// A database nobody has collapsed draws the rail. This is the state every fresh install is
    /// in, so it is the one the fallback has to be right about.
    #[test]
    fn a_missing_row_reads_as_expanded() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_NAV_COLLAPSED), None);
        assert!(!stored(&conn));
    }

    /// **The case a naive implementation gets wrong.** Treating the row's *existence* as the
    /// setting — writing on collapse, writing nothing on expand — reads identically on a fresh
    /// install and identically after a collapse, and fails only here: the reader opens the rail
    /// again, and every later launch still hides it. So the row is asserted as well as the answer.
    #[test]
    fn expanding_again_clears_a_stored_collapse() {
        let conn = db();
        store(&conn, true).unwrap();
        assert!(stored(&conn));

        store(&conn, false).unwrap();
        assert!(!stored(&conn), "expanding must undo a stored collapse");
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_NAV_COLLAPSED).as_deref(),
            Some(EXPANDED),
            "the row is rewritten, not left standing with the old value"
        );
    }

    /// A row this build cannot make sense of is a fact about storage, not a reason to hide the
    /// only way to reach the app's other pages. Written past [`store`] deliberately — every one of
    /// these is what a hand-edit or a different build left behind, which no validation of ours was
    /// ever in a position to refuse. `"true"` and `"yes"` are on the list because they are what a
    /// person editing the table by hand would most plausibly write, and both must read as expanded
    /// rather than be quietly forgiven into a collapse.
    #[test]
    fn an_unreadable_row_reads_as_expanded_rather_than_failing() {
        let conn = db();
        for junk in ["", "not json", "true", "yes", "2", "null", " 1", "1\n"] {
            crate::app_meta::set_app_meta(&conn, K_NAV_COLLAPSED, junk).unwrap();
            assert!(
                !stored(&conn),
                "`{junk}` must read as expanded, not as collapsed and not as a failure"
            );
        }
    }

    /// The stored spelling is the contract with anything else that reads this row — a newer build,
    /// a hand-edit, a support answer telling somebody which value to put there. Pinning it here is
    /// what makes changing it a deliberate act rather than a rename that reads as a no-op.
    #[test]
    fn the_row_holds_one_or_zero_and_nothing_else() {
        let conn = db();

        store(&conn, true).unwrap();
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_NAV_COLLAPSED).as_deref(),
            Some("1")
        );

        store(&conn, false).unwrap();
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_NAV_COLLAPSED).as_deref(),
            Some("0")
        );
    }

    /// A junk row is not sticky: the next write puts the setting back on its feet, so a reader who
    /// hits this never has to be told to clear anything.
    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_NAV_COLLAPSED, "yes").unwrap();
        assert!(!stored(&conn));

        store(&conn, true).unwrap();
        assert!(stored(&conn));
    }
}
