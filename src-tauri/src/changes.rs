//! Which user tables a commit wrote, told to every open window.
//!
//! A second window is a second webview with its own query cache, and until this module each
//! cache heard only about the writes its own window made (spec
//! `docs/superpowers/specs/2026-09-19-multi-window-design.md` §4). Rust supplies the fact — which
//! **tables** a commit wrote — and TypeScript draws the conclusion, which queries that makes stale
//! (`src/lib/crossWindow.ts`).
//!
//! Three pieces:
//!
//! * [`Changes::mark`] rides the one update hook on the write connection
//!   ([`crate::mirror::watch::install_hook_with_changes`]) and sets one bit per user table. It is
//!   the hook's own discipline: one binary search over a list built in [`Changes::new`], one
//!   `fetch_or`, no allocation and no lock.
//! * The commit hook rings [`Changes::ring`] **only when a bit is set**, so the thousands of corpus
//!   commits a Scryfall ingest makes wake nothing.
//! * [`spawn_emitter`] waits for the ring, lets a burst settle, and — only while two or more
//!   windows are open — emits [`DB_CHANGED`]. With one window nothing is ever emitted, so a
//!   single-window session is exactly what it was before this module.
//!
//! **Six user tables are `WITHOUT ROWID`, and `update_hook` never fires for those.** Their write
//! sites take a bare `&Connection` in modules that have no business with this mask, so the mark is
//! made by the *command* that a reader's press reaches, after its write has committed — see
//! [`MARKED_BY_COMMAND`] and [`WRITTEN_BY_THE_APP`], and the test that holds `sqlite_master` to the
//! two of them.

use crate::schema::{Side, TABLES};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

/// The event every window listens for. `src/lib/ipc.ts`'s `onDbChanged` subscribes to this exact
/// string and `ipc.test.ts` pins this line — an event name is a contract no type system holds.
pub const DB_CHANGED: &str = "db:changed";

/// How long the emitter waits after a wake before it reads the mask, so that a burst of commits —
/// an import is hundreds — is one event rather than hundreds.
pub const COALESCE: Duration = Duration::from_millis(50);

/// The `WITHOUT ROWID` user tables a command marks by hand after its write commits:
/// `muted_tags` from `tags::muted::tag_mute`/`tag_unmute`, `sync_devices` and `device_names` from
/// `sync_pair::pairing::sync_device_rename`, and `sync_state` from
/// `sync_engine::commands::sync_patreon_claim` (the grant) and
/// `sync_pair::pairing::sync_group_leave` (the clear). A reader's press is the only thing that
/// changes them in a way another window could be behind about.
///
/// **`sync_state` is on this list although the app writes it too** — the pull cursor, the apply
/// guard, the roster-dirty mark — and those writes are still unmarked, for
/// [`WRITTEN_BY_THE_APP`]'s reason. What put it here is the entitlement: Connect Patreon and
/// Leave group are presses, and the Sync panel draws what they wrote. This list said it was
/// written only by the app until that was found.
pub const MARKED_BY_COMMAND: &[&str] =
    &["device_names", "muted_tags", "sync_devices", "sync_state"];

/// The `WITHOUT ROWID` user tables no window's press writes — the app writes them itself: a day's
/// prices (`price_history`) and a peer watermark (`sync_engine`). Every window is equally current
/// about them, so nothing marks them.
pub const WRITTEN_BY_THE_APP: &[&str] = &["price_snapshots", "sync_peers"];

/// One bit per user table, and the bell the commit hook rings.
pub struct Changes {
    /// The user side of [`TABLES`], sorted — built once so the hook only ever reads it.
    tables: Vec<&'static str>,
    bits: AtomicU64,
    wake: tokio::sync::Notify,
}

impl Default for Changes {
    fn default() -> Self {
        Self::new()
    }
}

impl Changes {
    pub fn new() -> Self {
        let mut tables: Vec<&'static str> = TABLES
            .iter()
            .filter(|(_, side)| *side == Side::User)
            .map(|(name, _)| *name)
            .collect();
        tables.sort_unstable();
        assert!(
            tables.len() <= 64,
            "one bit per user table, and the mask is a u64"
        );
        Self {
            tables,
            bits: AtomicU64::new(0),
            wake: tokio::sync::Notify::new(),
        }
    }

    /// From inside SQLite's update hook: note that `table` in `db` was written.
    ///
    /// Only `main` — the user file. The corpus is rewritten wholesale by feeds and every window
    /// already hears about those through their own progress events.
    pub fn mark(&self, db: &str, table: &str) {
        if db != "main" {
            return;
        }
        if let Ok(i) = self.tables.binary_search_by(|probe| (*probe).cmp(table)) {
            self.bits.fetch_or(1u64 << i, Ordering::AcqRel);
        }
    }

    /// Whether any bit is set — what the commit hook asks before it rings.
    pub fn pending(&self) -> bool {
        self.bits.load(Ordering::Acquire) != 0
    }

    /// Wake the emitter. `notify_one` stores at most one permit, so a storm is one wake.
    pub fn ring(&self) {
        self.wake.notify_one();
    }

    /// A command's mark for a `WITHOUT ROWID` table, made after its write has committed — so it
    /// rings itself, because the commit hook saw no bit for it.
    pub fn mark_table(&self, table: &str) {
        self.mark("main", table);
        self.ring();
    }

    /// Every table marked since the last take, sorted, and the mask cleared.
    pub fn take(&self) -> Vec<&'static str> {
        let bits = self.bits.swap(0, Ordering::AcqRel);
        self.tables
            .iter()
            .enumerate()
            .filter(|(i, _)| bits & (1u64 << i) != 0)
            .map(|(_, table)| *table)
            .collect()
    }

    /// Resolves after the next ring (or at once, if one is already stored).
    pub async fn notified(&self) {
        self.wake.notified().await;
    }
}

/// Whether a take is worth an event: something changed, and another window exists to hear it.
pub fn should_emit(tables: &[&str], windows: usize) -> bool {
    !tables.is_empty() && windows >= 2
}

/// The payload of [`DB_CHANGED`]. `src/lib/ipc.ts`'s `DbChanged` mirrors it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbChanged {
    pub tables: Vec<&'static str>,
}

/// Start the task that turns rings into events. Desktop only: a phone has one window.
///
/// **The write lock is taken before the read and held across it, and that is a barrier, not a
/// use.** It buys two things, and the second is why the take is inside the lock rather than after
/// it:
///
/// * The commit hook fires while the commit is still being made, under `state.db`'s mutex; a
///   window told before that commit is durable could refetch the old rows and never be told again.
///   Acquiring the mutex proves the commit that rang has finished.
/// * **No transaction is half-written while the bits are taken.** A take made after the lock was
///   dropped could land while the *next* transaction is mid-write: its update hook has set a bit,
///   the take clears it, the event goes out before that transaction's rows are readable — and its
///   commit hook then finds nothing pending, so nothing rings for it and the window is stale for
///   good. Under the lock every bit taken belongs to a transaction that has already ended.
///
/// On timeout it takes and emits anyway — a refetch of data that did not change costs one read,
/// and silence would cost a stale window.
#[cfg(desktop)]
pub fn spawn_emitter(app: tauri::AppHandle, state: std::sync::Arc<crate::sync::AppState>) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        loop {
            state.changes.notified().await;
            tokio::time::sleep(COALESCE).await;
            if app.webview_windows().len() < 2 {
                // Taken regardless, so nothing stale is waiting when a second window opens.
                let _ = state.changes.take();
                continue;
            }
            let barrier = state.clone();
            let tables = tauri::async_runtime::spawn_blocking(move || {
                take_settled(&barrier.db, &barrier.changes, crate::db::WRITE_LOCK_WAIT)
            })
            .await
            // A blocking task that did not finish took nothing, so the bits are still there.
            .unwrap_or_else(|_| state.changes.take());
            if should_emit(&tables, app.webview_windows().len()) {
                let _ = app.emit(DB_CHANGED, DbChanged { tables });
            }
        }
    });
}

/// The emitter's take, made **while holding** `db` — [`spawn_emitter`] says why the take is
/// inside the lock rather than after it. `None` from the lock is the timeout, and the take goes
/// ahead regardless.
///
/// Its own function so a test can hold the lock and watch it wait: the emitter itself needs an
/// `AppHandle`, and this crate has no mock-app harness.
#[cfg(any(desktop, test))]
fn take_settled(
    db: &std::sync::Mutex<rusqlite::Connection>,
    changes: &Changes,
    wait: Duration,
) -> Vec<&'static str> {
    let _held = crate::db::lock_for(db, wait);
    changes.take()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(f)
    }

    /// The one list both suites read. `crossWindow.test.ts` holds the TypeScript map to the same
    /// file, so a table added on one side and not the other is red on that side.
    #[test]
    fn the_json_both_suites_read_is_the_user_side_of_the_registry() {
        let json: Vec<String> =
            serde_json::from_str(include_str!("../../src/lib/userTables.json")).unwrap();
        let mut ours: Vec<&str> = TABLES
            .iter()
            .filter(|(_, side)| *side == Side::User)
            .map(|(name, _)| *name)
            .collect();
        ours.sort_unstable();
        assert_eq!(json, ours);
    }

    #[test]
    fn a_main_write_marks_its_table_once_and_a_corpus_write_marks_nothing() {
        let changes = Changes::new();
        changes.mark("corpus", "cards");
        assert!(!changes.pending(), "the corpus is not this mask's");
        changes.mark("main", "decks");
        changes.mark("main", "decks");
        changes.mark("main", "collection_entries");
        assert_eq!(changes.take(), vec!["collection_entries", "decks"]);
        assert!(!changes.pending(), "a take clears the mask");
        assert!(changes.take().is_empty());
    }

    #[test]
    fn a_table_outside_the_registry_marks_nothing() {
        let changes = Changes::new();
        changes.mark("main", "sqlite_sequence");
        changes.mark("temp", "decks");
        assert!(!changes.pending());
    }

    #[test]
    fn it_emits_only_with_something_to_say_and_somebody_to_say_it_to() {
        assert!(!should_emit(&["decks"], 1), "one window refreshes itself");
        assert!(!should_emit(&[], 2), "nothing changed");
        assert!(should_emit(&["decks"], 2));
        assert!(should_emit(&["decks"], 5));
    }

    #[test]
    fn a_commands_mark_rings_the_emitter_itself() {
        let changes = Changes::new();
        changes.mark_table("muted_tags");
        block_on(async {
            tokio::time::timeout(Duration::from_millis(100), changes.notified())
                .await
                .expect("mark_table must ring: the commit hook saw no bit for this table");
        });
        assert_eq!(changes.take(), vec!["muted_tags"]);
    }

    /// The race the lock closes. A transaction is mid-write — it holds the write connection and
    /// its update hook has set a bit — and the emitter comes to take. Taken now, that bit would
    /// go out before the rows are readable, and the transaction's commit would then find
    /// nothing pending and ring for nobody. So the take has to wait for the transaction.
    ///
    /// **The assertion that can fail is the first one.** A take made outside the lock answers
    /// at once, and the channel has something in it long before the guard drops. The correct
    /// code cannot send before then, so a slow machine can only make this pass for the wrong
    /// reason and never fail for one.
    #[test]
    fn the_emitters_take_waits_for_a_transaction_in_flight() {
        let db = std::sync::Mutex::new(crate::schema::memory_pair());
        let changes = Changes::new();
        let (db, changes) = (&db, &changes);
        std::thread::scope(|s| {
            let held = db.lock().unwrap();
            changes.mark("main", "decks");
            let (tx, rx) = std::sync::mpsc::channel();
            s.spawn(move || {
                tx.send(take_settled(db, changes, crate::db::WRITE_LOCK_WAIT))
                    .unwrap();
            });
            std::thread::sleep(Duration::from_millis(100));
            assert!(
                rx.try_recv().is_err(),
                "the take must not read a bit whose transaction has not committed"
            );
            drop(held);
            assert_eq!(
                rx.recv_timeout(Duration::from_secs(5)).unwrap(),
                vec!["decks"]
            );
        });
    }

    /// The other arm: a lock that never comes is not a reason to stay silent. The take goes
    /// ahead and the event goes out — a refetch of unchanged data costs one read, a missing
    /// event costs a stale window.
    #[test]
    fn the_emitters_take_goes_ahead_when_the_lock_does_not_come() {
        let db = std::sync::Mutex::new(crate::schema::memory_pair());
        let changes = Changes::new();
        let _held = db.lock().unwrap();
        changes.mark("main", "decks");
        assert_eq!(take_settled(&db, &changes, Duration::ZERO), vec!["decks"]);
    }

    /// `update_hook` cannot see these, so each one is a decision — marked by the command that
    /// writes it, or written only by the app. A seventh goes red here until somebody decides.
    #[test]
    fn every_without_rowid_user_table_has_been_decided_about() {
        let conn = crate::schema::memory_pair();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM main.sqlite_master
                 WHERE type = 'table' AND sql LIKE '%WITHOUT ROWID%' ORDER BY name",
            )
            .unwrap();
        let found: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut decided: Vec<&str> = MARKED_BY_COMMAND
            .iter()
            .chain(WRITTEN_BY_THE_APP)
            .copied()
            .collect();
        decided.sort_unstable();
        assert_eq!(found, decided);
    }
}
