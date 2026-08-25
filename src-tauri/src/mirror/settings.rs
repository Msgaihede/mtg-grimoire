//! Whether the mirror runs, and where it writes — the setting, and nothing else.
//!
//! Two keys in `app_meta`, schema v6's key/value table, and **no migration**: exactly the
//! shape [`crate::marketplace`] settled on, for the same reason. A setting is a row, and a
//! row in a table that already exists is not a rung on the ladder.
//!
//! That module's two rules bind here verbatim:
//!
//! * **Reading can never fail.** A missing row, a row somebody hand-edited, a row a *newer*
//!   build wrote — all of them read as the default. [`enabled`] and [`root`] are infallible
//!   by signature and that is the contract: the mirror thread consults them on every tick,
//!   and there is nothing sensible for a tick to do with an error that is not "assume the
//!   default". An unparseable setting is a fact about storage, not a refusal.
//! * **Writing validates.** [`set_root`] refuses a path that is not absolute and one whose
//!   parent does not exist, so the table cannot accumulate a value every later read would
//!   silently discard.
//!
//! **The absolute rule is the one worth spelling out.** A relative root resolves against the
//! process's working directory, and for a portable app that is wherever the shortcut pointed
//! — a different folder on Tuesday than on Monday, with a mirror scattered across both and
//! neither one prunable. `export` typed into the box is not a folder; it is a lottery.
//!
//! See `docs/superpowers/specs/2026-08-25-text-backed-cards-design.md`.

use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The `app_meta` key holding whether the mirror runs. The table is the *application's*,
/// deliberately not `sync_meta` — a row in that one the sync did not write makes every later
/// timing claim a fiction (schema v6).
pub const K_ENABLED: &str = "mirror_enabled";

/// The `app_meta` key holding the folder the mirror writes into, as an absolute path.
pub const K_ROOT: &str = "mirror_root";

/// The mirror runs unless somebody says otherwise.
///
/// On rather than off because the whole point of the feature is the day the app will not
/// start: a mirror a reader has to remember to switch on is a mirror that is not there when
/// the window finally refuses to open. It costs a folder of small text files and, after the
/// first pass, only the bytes that actually changed.
pub const DEFAULT_ENABLED: bool = true;

/// The folder the mirror writes into when nobody has chosen — `export`, beside the database.
///
/// Beside the database because that is the folder a portable install already carries around,
/// so the cards travel with the app by default rather than being left behind on a machine
/// the reader has stopped using.
pub const DEFAULT_ROOT_NAME: &str = "export";

/// How `true` is spelled in the row. Read by exact match, so anything else falls back.
const ON: &str = "1";
/// How `false` is spelled in the row.
const OFF: &str = "0";

/// Does the mirror run?
///
/// Three cases collapse into [`DEFAULT_ENABLED`] and it matters that they do: no row, an
/// unreadable row (`get_app_meta` swallows the error), and a row holding something that is
/// neither [`ON`] nor [`OFF`]. None of them is worth stopping a background pass over, and
/// none of them is worth failing the Settings panel's read over either.
pub fn enabled(conn: &Connection) -> bool {
    match crate::update::get_app_meta(conn, K_ENABLED).as_deref() {
        Some(ON) => true,
        Some(OFF) => false,
        _ => DEFAULT_ENABLED,
    }
}

/// Where the mirror writes, or `data_dir/export`.
///
/// The stored value is filtered on `is_absolute` rather than trusted: [`set_root`] is the
/// only writer that validates, and a row this build did not write — a hand edit, a database
/// copied from a machine whose drive letters differ — must not be able to point a pruning
/// pass at a relative path. A value that fails the filter reads exactly as no value at all.
pub fn root(conn: &Connection, data_dir: &Path) -> PathBuf {
    crate::update::get_app_meta(conn, K_ROOT)
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| data_dir.join(DEFAULT_ROOT_NAME))
}

/// Switch the mirror on or off.
pub fn set_enabled(conn: &Connection, on: bool) -> Result<(), String> {
    let value = if on { ON } else { OFF };
    crate::update::set_app_meta(conn, K_ENABLED, value)
        .map_err(|e| format!("could not save the mirror setting: {e}"))
}

/// Choose the folder the mirror writes into.
///
/// The refusals are the whole point of the function, because [`root`] discards a bad value
/// silently: without them a relative path would look like it saved and then read back as
/// `data_dir/export` forever, with the reader watching a folder nothing is ever written to.
///
/// Three things are refused, each in a sentence rather than an error code:
///
/// * a path that is not absolute — see the module doc;
/// * a path whose parent does not exist, because the mirror creates the folder it was
///   pointed at and not a whole tree of ancestors: a typo'd drive letter or a disconnected
///   network share would otherwise be accepted and then fail once per pass, silently;
/// * a path that already exists as a file, which no amount of retrying makes a folder.
///
/// The folder itself is deliberately **not** required to exist — the first pass creates it.
pub fn set_root(conn: &Connection, path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err(format!(
            "\"{}\" is not an absolute path. The mirror needs a full path — a drive letter \
             or a share — because a relative one is resolved against wherever the app was \
             started from, which is not the same folder twice.",
            path.display()
        ));
    }
    let Some(text) = path.to_str() else {
        return Err(format!(
            "\"{}\" cannot be saved: the mirror folder has to be text this app can store.",
            path.display()
        ));
    };
    // `parent()` is `None` only for a filesystem root (`C:\`, `/`), which is its own parent
    // as far as this question goes: the folder it would be created in is the one it is.
    let parent = path.parent().unwrap_or(path);
    if !parent.is_dir() {
        return Err(format!(
            "\"{}\" does not exist, so \"{}\" cannot be created in it. Pick a folder that is \
             already there.",
            parent.display(),
            path.display()
        ));
    }
    if path.is_file() {
        return Err(format!(
            "\"{}\" is a file, not a folder. The mirror needs a folder of its own.",
            path.display()
        ));
    }
    crate::update::set_app_meta(conn, K_ROOT, text)
        .map_err(|e| format!("could not save the mirror folder: {e}"))
}

/// Everything the Settings panel needs to draw the mirror's row, in one round trip.
///
/// Two of the five fields are stored and three are about *this process run*: a pass records
/// what it did in memory, because the numbers describe a folder that may not survive a
/// restart and a stale count read back after one would be a claim about a disk nobody has
/// looked at since.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MirrorStatus {
    pub enabled: bool,
    pub root: String,
    /// Unix seconds as a string, `None` if no pass has finished this session.
    ///
    /// A string for `SyncStatus::last_check_at`'s reason: JSON numbers are `f64` on the
    /// other side, and a seconds-since-epoch value is not something to round-trip through
    /// one.
    pub last_run_at: Option<String>,
    pub last_report: Option<crate::mirror::run::PassReport>,
    /// The sentence to show when the last pass could not write. `None` when it went fine.
    pub last_error: Option<String>,
}

/// Build the panel's answer from the two stored settings and this session's three facts.
///
/// Split out from [`mirror_status`] so that what the command adds is only *where the three
/// session values come from* — the pure half is testable without an `AppState`, and reading
/// the settings can never fail, so neither can this.
pub fn status(
    conn: &Connection,
    data_dir: &Path,
    last_run_at: Option<String>,
    last_report: Option<crate::mirror::run::PassReport>,
    last_error: Option<String>,
) -> MirrorStatus {
    MirrorStatus {
        enabled: enabled(conn),
        root: root(conn, data_dir).display().to_string(),
        last_run_at,
        last_report,
        last_error,
    }
}

/// What the Settings panel polls.
///
/// **Infallible by signature**, which is the contract and not an accident: the panel reads
/// this to decide whether to draw a switch as on, and there is nothing useful for it to do
/// with an error that is not "show the defaults" — so this does that instead of making the
/// caller do it.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on
/// the IPC thread and this one takes `db_read`'s mutex, which a search may hold for tens of
/// milliseconds. It is not an `async fn` because Tauri requires a `Result` from one that
/// borrows `State`, and a `Result` here would be a failure mode this call does not have.
///
/// The two locks are taken one at a time and in this order — the session record first, then
/// `db_read` — so that neither is ever held while waiting for the other.
#[tauri::command(async)]
pub fn mirror_status(state: tauri::State<'_, Arc<AppState>>) -> MirrorStatus {
    let state = state.inner();
    let last = crate::sync::lock_plain(&state.mirror_status).clone();
    status(
        &crate::sync::lock_db_read(state),
        &state.data_dir,
        last.last_run_at,
        last.last_report,
        last.last_error,
    )
}

/// Switch the mirror on or off. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// Takes effect without a restart: the pass thread consults [`enabled`] on every tick rather
/// than reading it once at startup.
#[tauri::command]
pub async fn mirror_set_enabled(
    state: tauri::State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| set_enabled(conn, enabled))
    })
    .await
    .map_err(|e| format!("the mirror setting could not be saved: {e}"))?
}

/// Point the mirror at a folder. Refuses a relative path and one whose parent is not there,
/// each in a sentence — see [`set_root`].
///
/// The old folder is **not** cleaned up, deliberately: the files under it are the reader's
/// cards in plain text, and a setting change is not consent to delete them. Moving the
/// mirror leaves the previous copy where it was.
#[tauri::command]
pub async fn mirror_set_root(
    state: tauri::State<'_, Arc<AppState>>,
    root: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| set_root(conn, Path::new(&root)))
    })
    .await
    .map_err(|e| format!("the mirror folder could not be saved: {e}"))?
}

/// Rewrite every file the mirror owns, now, and answer what the pass did.
///
/// On the blocking pool against `db_read`, exactly as every other read-shaped command is:
/// a pass reads the whole collection and writes a few hundred small files, which is far too
/// much to do on the IPC thread and must never touch the write connection.
///
/// [`crate::mirror::run::Dirty::ALL`] and a **fresh** digest cache, both because this is the
/// press a reader makes when they suspect the folder is wrong: reusing the thread's cache
/// would let a file somebody deleted or edited by hand read as unchanged, which is the one
/// state this button exists to get out of.
///
/// Runs whether or not the mirror is [`enabled`] — an explicit press is an explicit press,
/// and a reader who wants one folder of text files without a background thread watching them
/// is asking for something this command can give.
///
/// **It records its own pass**, through the same [`crate::mirror::watch::record`] the thread
/// uses. Without that the panel draws "Rebuilt — 350 files written" directly above
/// "Last written 2 hours ago", because it ranks a recorded failure against a rebuild **by
/// clock** and the rebuild had left no clock reading of its own.
#[tauri::command]
pub async fn mirror_rebuild(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<crate::mirror::run::PassReport, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || rebuild_now(&state))
        .await
        .map_err(|e| format!("the mirror could not be rebuilt: {e}"))?
}

/// [`mirror_rebuild`]'s body, with the `AppState` handed in.
///
/// Split out so the stamp above can be tested: a `#[tauri::command]` taking
/// `tauri::State` cannot be called without a running app, and "the rebuild records itself"
/// is exactly the sort of one-line wiring that is silently dropped and never noticed.
pub fn rebuild_now(state: &AppState) -> Result<crate::mirror::run::PassReport, String> {
    let outcome = {
        let conn = crate::sync::lock_db_read(state);
        let root = root(&conn, &state.data_dir);
        let mut cache = std::collections::HashMap::new();
        crate::mirror::run::run_pass(&conn, &root, crate::mirror::run::Dirty::ALL, &mut cache)
    };
    // After the read lock has gone, and before the answer: the panel polls `mirror_status` the
    // moment this resolves, so a stamp written any later is a stamp it can miss.
    crate::mirror::watch::record(state, &outcome);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    fn migrated_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    /// A database nobody has told is a database that mirrors, into the folder beside itself.
    /// Both halves of the default matter: off-by-default would mean the feature is missing on
    /// the day it is needed, and a root that had to be chosen would mean the same.
    #[test]
    fn the_mirror_is_on_and_beside_the_database_until_somebody_says_otherwise() {
        let conn = migrated_memory_db();
        assert!(enabled(&conn));
        assert_eq!(
            root(&conn, Path::new("D:/app/data")),
            Path::new("D:/app/data/export")
        );
    }

    /// The row a *different* build left behind, written past `set_enabled` deliberately —
    /// no validation of ours was ever in a position to refuse it.
    #[test]
    fn an_unreadable_setting_reads_as_the_default_rather_than_failing() {
        let conn = migrated_memory_db();
        crate::update::set_app_meta(&conn, K_ENABLED, "perhaps").unwrap();
        assert!(
            enabled(&conn),
            "an unparseable setting is a fact about storage, not a refusal"
        );
    }

    /// The same rule one key over: a relative root stored by something other than
    /// [`set_root`] must read as no root at all rather than being followed.
    #[test]
    fn an_unreadable_root_reads_as_the_default_rather_than_being_followed() {
        let conn = migrated_memory_db();
        for junk in ["export", "", "./export", "../export"] {
            crate::update::set_app_meta(&conn, K_ROOT, junk).unwrap();
            assert_eq!(
                root(&conn, Path::new("D:/app/data")),
                Path::new("D:/app/data/export"),
                "a stored `{junk}` must read as the default, not be resolved against the cwd"
            );
        }
    }

    #[test]
    fn a_relative_root_is_refused_in_words() {
        let conn = migrated_memory_db();
        let err = set_root(&conn, Path::new("export")).unwrap_err();
        assert!(err.contains("absolute"), "got: {err}");
    }

    /// A path that genuinely is not there, built as a child of a directory that genuinely is:
    /// `tmp/nope/export`'s parent `tmp/nope` was never created. A hardcoded `Z:/...` was the
    /// first draft and is wrong twice over — `Z:` is a real drive on some machines, and the
    /// answer must not depend on which machine ran the suite.
    #[test]
    fn a_root_whose_parent_does_not_exist_is_refused() {
        let conn = migrated_memory_db();
        let tmp = tempfile::tempdir().unwrap();
        let missing = tmp.path().join("nope").join("export");
        assert!(set_root(&conn, &missing).is_err());
    }

    /// The half that is easy to leave untested: a validator that refused *everything* would
    /// pass all four tests above. The parent is the temp directory, which exists for as long
    /// as `tmp` is alive; the folder itself does not exist and is not created — the first
    /// pass does that.
    ///
    /// `tempfile::tempdir` rather than a fixed name under `%TEMP%`: the suite runs in
    /// parallel, and a leftover directory from an earlier run would make the assertion below
    /// vacuous rather than failing loudly.
    #[test]
    fn an_absolute_root_whose_parent_exists_round_trips() {
        let conn = migrated_memory_db();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mirror");
        assert!(!dir.exists(), "a fresh temp dir starts empty");

        set_root(&conn, &dir).unwrap();
        assert_eq!(root(&conn, Path::new("D:/app/data")), dir);
        assert_eq!(
            crate::update::get_app_meta(&conn, K_ROOT).as_deref(),
            dir.to_str(),
            "the path is stored verbatim"
        );
    }

    /// A refused write must leave the previous choice alone: `root` discards junk silently,
    /// so a write that half-landed would look like a save and read back as the default.
    #[test]
    fn a_refused_root_leaves_the_stored_one_intact() {
        let conn = migrated_memory_db();
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("mirror");
        set_root(&conn, &dir).unwrap();

        assert!(set_root(&conn, Path::new("export")).is_err());
        assert!(set_root(&conn, &tmp.path().join("nope").join("export")).is_err());

        assert_eq!(root(&conn, Path::new("D:/app/data")), dir);
    }

    #[test]
    fn switching_it_off_and_on_round_trips() {
        let conn = migrated_memory_db();
        set_enabled(&conn, false).unwrap();
        assert!(!enabled(&conn));
        set_enabled(&conn, true).unwrap();
        assert!(enabled(&conn));
    }
}
