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
//! **`update_hook` has two blind spots, and a command marks by hand for each.**
//!
//! * **`WITHOUT ROWID` tables.** Six user tables are, and the hook never fires for them. Their
//!   write sites take a bare `&Connection` in modules that have no business with this mask, so the
//!   mark is made by the *command* that a reader's press reaches, after its write — see
//!   [`MARKED_BY_COMMAND`] and [`WRITTEN_BY_THE_APP`], and the test that holds `sqlite_master` to
//!   the two of them.
//! * **A bare `DELETE FROM <table>` with no `WHERE`.** SQLite empties the table with its truncate
//!   optimisation, visits no row, and is documented not to call the hook for it. Triggers and
//!   foreign-key processing both switch the optimisation off, so a clear of a synced table (its
//!   capture triggers) or of one a foreign key names reaches the hook row by row — which is why
//!   `reset.rs`'s three clears need nothing, and `mirror::watch`'s tests show it. A user table
//!   with neither is blind: `error_log` (*Clear log*, `error_log_clear`) and `sync_group` (*Leave
//!   group*), and each of those commands marks by hand. **This one has no census**, because
//!   whether a statement carries a `WHERE` is a fact about a call site and not about the schema;
//!   what it has is `a_bare_delete_on_a_table_with_no_triggers_or_foreign_keys_marks_nothing`,
//!   beside the hook's other tests in `mirror::watch`, so the next bare `DELETE` on such a table
//!   has somewhere to learn that it owes a mark.

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
/// `sync_pair::pairing::sync_device_rename`, `sync_devices` again from
/// `sync_pair::pairing::sync_group_leave`, and `sync_state` from
/// `sync_engine::commands::sync_patreon_claim` (the grant) and `sync_group_leave` (the clear). A
/// reader's press is the only thing that changes them in a way another window could be behind
/// about.
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
        if let Some(i) = self.bit_of(table) {
            self.bits.fetch_or(1u64 << i, Ordering::AcqRel);
        }
    }

    /// Which bit `table` is, or `None` for a name that is not a user table.
    fn bit_of(&self, table: &str) -> Option<usize> {
        self.tables
            .binary_search_by(|probe| (*probe).cmp(table))
            .ok()
    }

    /// Whether any bit is set — what the commit hook asks before it rings.
    pub fn pending(&self) -> bool {
        self.bits.load(Ordering::Acquire) != 0
    }

    /// Wake the emitter. `notify_one` stores at most one permit, so a storm is one wake.
    pub fn ring(&self) {
        self.wake.notify_one();
    }

    /// A command's mark for a table the hook could not see — a `WITHOUT ROWID` one, or one a bare
    /// `DELETE` emptied (see the module doc) — made after its write, so it rings itself, because
    /// the commit hook saw no bit for it.
    ///
    /// **A debug build refuses a name this mask does not know.** The hook passes every table SQLite
    /// touches and must ignore the ones that are not the reader's, so [`Changes::mark`] cannot
    /// refuse — but a command names its table by hand, and a misspelt one would set no bit, ring,
    /// and tell the emitter there was nothing to say, with nothing anywhere going red.
    pub fn mark_table(&self, table: &str) {
        debug_assert!(
            self.bit_of(table).is_some(),
            "{table} is not a user table this mask knows, so the mark would set nothing"
        );
        self.mark("main", table);
        self.ring();
    }

    /// Every table marked since the last take, sorted, and the mask cleared.
    pub fn take(&self) -> Vec<&'static str> {
        self.names(self.bits.swap(0, Ordering::AcqRel))
    }

    /// Every table marked since the last take, sorted, **with the mask left as it is** — the
    /// emitter's answer when it cannot have the lock (see `take_settled`).
    pub fn peek(&self) -> Vec<&'static str> {
        self.names(self.bits.load(Ordering::Acquire))
    }

    fn names(&self, bits: u64) -> Vec<&'static str> {
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
/// **With one window as well as with two**, and that is spec §4's step 3 rather than thrift: the
/// mask is taken every time, so nothing stale is waiting when a second window opens — and it is
/// taken under the lock every time, so even a one-window take can never clear the bit of a
/// transaction still being written, whose commit would then ring for nobody the moment a second
/// window existed. The one-window cost is one uncontended mutex acquisition per burst of user
/// writes, on a blocking thread, and it emits nothing.
///
/// On timeout it emits what is pending and clears nothing — see [`take_settled`]. A refetch of
/// data that did not change costs one read, and silence would cost a stale window.
#[cfg(desktop)]
pub fn spawn_emitter(app: tauri::AppHandle, state: std::sync::Arc<crate::sync::AppState>) {
    use tauri::{Emitter, Manager};
    tauri::async_runtime::spawn(async move {
        loop {
            state.changes.notified().await;
            tokio::time::sleep(COALESCE).await;
            let barrier = state.clone();
            let tables = tauri::async_runtime::spawn_blocking(move || {
                take_settled(&barrier.db, &barrier.changes, crate::db::WRITE_LOCK_WAIT)
            })
            .await
            // A blocking task that did not finish took nothing: say what is pending and clear
            // nothing, as the timeout arm does, and the next locked take settles it.
            .unwrap_or_else(|_| state.changes.peek());
            if should_emit(&tables, app.webview_windows().len()) {
                let _ = app.emit(DB_CHANGED, DbChanged { tables });
            }
        }
    });
}

/// The emitter's take, made **while holding** `db` — [`spawn_emitter`] says why the take is
/// inside the lock rather than after it.
///
/// **That property is the order of two lines, and no test here can see it.** The guard is bound
/// to `_held` before the `take` and dropped after it; a drop-then-take reads the same bits in
/// every single-threaded test and loses them only when a writer lands in the gap between the two.
/// So the order is held by this structure rather than by an assertion. Do not reorder it, and do
/// not respell the binding `let _ = …`, which drops the guard on the spot.
///
/// **A lock that does not come is answered with a snapshot, never a take.** Whatever holds `db`
/// past the wait may be a transaction whose bits are in the mask right now, and clearing them
/// would leave its commit hook finding nothing pending and ringing for nobody. So the timeout arm
/// says what is pending — a window refetching early costs one read — and leaves the mask set;
/// the commit rings, and the next locked take is the one that clears.
///
/// Its own function so a test can hold the lock and watch it: the emitter itself needs an
/// `AppHandle`, and this crate has no mock-app harness.
#[cfg(any(desktop, test))]
fn take_settled(
    db: &std::sync::Mutex<rusqlite::Connection>,
    changes: &Changes,
    wait: Duration,
) -> Vec<&'static str> {
    let Some(_held) = crate::db::lock_for(db, wait) else {
        return changes.peek();
    };
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

    /// **What this catches is a take that never waits for the lock** — one that reads the mask
    /// without asking for `db` at all. A transaction holds the write connection with its bit set,
    /// and the take must not answer until the guard drops. The assertion that can fail is the
    /// first one; the correct code cannot send before the guard drops, so a slow machine can only
    /// make this pass for the wrong reason and never fail for one.
    ///
    /// **What it does not catch is the race the lock exists to close, and it must not be read as
    /// if it did.** A drop-then-take — lock, release, then read — also waits for this guard and
    /// also passes. That race needs a *second* writer to land in the gap between the release and
    /// the read, and no ordering a test here can arrange puts one there. The property is held by
    /// `take_settled`'s structure — the guard bound to `_held` and outliving the `take` — and by
    /// nothing that can go red.
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

    /// **A take that cannot have the lock says what is pending and clears nothing**, and the
    /// assertion that carries it is the ring. The transaction below is mid-write when the emitter
    /// comes: its bit is in the mask and it holds `db`. The timeout arm answers that bit — the
    /// event goes out rather than nothing, and a refetch is one read — and leaves it set, so the
    /// transaction's own commit still finds it pending and rings. A timeout arm that *took* would
    /// clear the bit, the commit would find nothing and ring for nobody, and the other window
    /// would never hear that the rows it refetched early had since committed.
    #[test]
    fn a_take_that_cannot_have_the_lock_leaves_the_bit_for_the_commit_to_ring() {
        let db = std::sync::Mutex::new(crate::schema::memory_pair());
        let changes = std::sync::Arc::new(Changes::new());
        crate::mirror::watch::install_hook_with_changes(
            &db.lock().unwrap(),
            Default::default(),
            Default::default(),
            Default::default(),
            changes.clone(),
        );
        let held = db.lock().unwrap();
        held.execute_batch(
            "BEGIN;
             INSERT INTO decks (name, format_key, created_at, updated_at)
               VALUES ('mid-write', 'casual', 0, 0);",
        )
        .unwrap();
        assert_eq!(
            take_settled(&db, &changes, Duration::ZERO),
            vec!["decks"],
            "a lock that does not come is not a reason to stay silent"
        );
        assert!(
            changes.pending(),
            "and the bit is still there for the commit"
        );
        held.execute_batch("COMMIT;").unwrap();
        drop(held);
        block_on(async {
            tokio::time::timeout(Duration::from_millis(100), changes.notified())
                .await
                .expect("the commit must still ring: a timed-out take may not clear its bit");
        });
        assert_eq!(
            take_settled(&db, &changes, crate::db::WRITE_LOCK_WAIT),
            vec!["decks"]
        );
        assert!(
            !changes.pending(),
            "a take under the lock is the one that clears"
        );
    }

    /// A table name is a string, so a misspelt `mark_table` would set no bit and ring for
    /// nothing, and no window would ever be told. A debug build refuses it at the call.
    #[cfg(debug_assertions)]
    #[test]
    #[should_panic(expected = "is not a user table this mask knows")]
    fn a_misspelt_mark_is_refused_in_a_debug_build() {
        Changes::new().mark_table("muted_tag");
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
