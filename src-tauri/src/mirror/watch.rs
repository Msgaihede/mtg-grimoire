//! How a write becomes a pass: the hook, the mask, and the thread that watches it.
//!
//! Three pieces, and the seam between them is an `AtomicU8`:
//!
//! * [`install_hook`] puts an `update_hook` on the **one write connection**. Every insert,
//!   update and delete in this crate goes through [`crate::sync::with_write`] on that
//!   connection, so the hook sees every user write with the table's name — and no command
//!   has to remember to tell the mirror anything, nor can one added next year forget to.
//! * [`surface_of`] turns that table name into the surfaces it could have changed, or into
//!   `None` for the great majority of tables that change nothing a reader's files show.
//! * [`spawn`] starts the thread that watches the mask, waits for the writing to stop, and
//!   runs [`crate::mirror::run::run_pass`].
//!
//! **The hook is the cheapest thing that could work, and it has to be.** It fires inside
//! SQLite's own callback, on the writer's thread, while the write connection's mutex is
//! held: it does one `fetch_or` on an atomic and returns. No allocation, no lock, and
//! nothing that could call back into the database — which SQLite forbids from a hook anyway.
//!
//! **It is an over-approximation on purpose, twice over.** The hook fires per *row* and
//! before the transaction commits, so a rolled-back write still marks the mask, and one
//! `INSERT` marks the same bit as a thousand. Both are harmless because a pass compares
//! digests before it opens anything: an over-marked surface costs a render and a hash, not a
//! write. Being wrong in the other direction — a change no bit describes — is the failure
//! that shows up as a file that never catches up, which is why the map errs towards marking.
//!
//! See `docs/superpowers/specs/2026-08-25-text-backed-cards-design.md` §5.

use crate::mirror::run::{DigestCache, Dirty, PassReport};
use crate::mirror::settings;
use crate::sync::AppState;
use rusqlite::Connection;

use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

// ---------------------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------------------

/// Decks only — the four tables that describe a deck's contents and nothing else.
const DECKS_ONLY: Dirty = Dirty {
    decks: true,
    collection: false,
    wishlist: false,
};

/// A deck row: its own file **and** the group folder its name titles in the cabinet.
const DECKS_AND_COLLECTION: Dirty = Dirty {
    decks: true,
    collection: true,
    wishlist: false,
};

const COLLECTION_ONLY: Dirty = Dirty {
    decks: false,
    collection: true,
    wishlist: false,
};

const WISHLIST_ONLY: Dirty = Dirty {
    decks: false,
    collection: false,
    wishlist: true,
};

/// Which surfaces a write to `table` could have changed, or `None` for a table whose rows
/// nothing on disk is rendered from.
///
/// **The `None` arm is the load-bearing one and it is the default rather than a list.** A
/// sync rewrites 116 700 `cards` rows and a price-feed refresh rewrites `marketplace_prices`
/// wholesale; either one mapped to a surface would fire this a hundred thousand times per
/// refresh and turn every sync into a mirror rebuild. What those two change — a corrected
/// card name, a moved price — enters through one full pass after the refresh *completes*
/// ([`crate::sync::run_sync`] and [`crate::marketplace_feed::refresh`] both call
/// [`Mask::mark_all`]), which is a bounded event instead of a per-row storm. The same goes
/// for `deck_audit`, `deck_undo`, `error_log`, `image_cache`, the art- and oracle-tag tables,
/// `app_meta` and `sync_meta`: none of them is read by [`crate::mirror::read`].
///
/// **Written as a match on a fixed list rather than a prefix test**, so that a table added
/// later is `None` until somebody decides otherwise — the safe direction for a table like
/// `deck_audit`, which starts with `deck_` and must never trigger anything. What keeps that
/// from being a silent decision is `every_table_in_the_schema_has_been_decided_about`, which
/// asserts the whole of `sqlite_master` against a written-down list: a migration that adds a
/// table goes red here until somebody says which side of this match it belongs on.
///
/// **The hook reports a schema name as well now, and this map ignores it on purpose.** Since
/// schema 27 a write arrives as `("main", "decks")` or `("corpus", "cards")`, and taking only
/// the table is correct because a table name is unique across the two files by
/// [`crate::schema::TABLES`] — which `every_table_is_on_exactly_one_side` is what keeps
/// true. The schema name is not wasted: [`install_hook`] passes it to
/// [`crate::db::CrossFileFence`], which rides in this same callback because SQLite allows one
/// update hook per connection.
pub fn surface_of(table: &str) -> Option<Dirty> {
    match table {
        "deck_cards" | "deck_categories" | "deck_tags" | "deck_folders" => Some(DECKS_ONLY),
        // Both, and the over-approximation is deliberate: a deck's name titles its group
        // folder in the cabinet, so a rename that only marked decks would leave the folder
        // named after the old one until something else touched the collection. Being wrong
        // this way costs one render and one hash; being wrong the other way costs a folder
        // whose name never catches up.
        "decks" => Some(DECKS_AND_COLLECTION),
        "collection_entries" | "collection_folders" => Some(COLLECTION_ONLY),
        "wishlist_entries" | "wishlist_folders" => Some(WISHLIST_ONLY),
        _ => None,
    }
}

// ---------------------------------------------------------------------------------------
// The mask
// ---------------------------------------------------------------------------------------

const BIT_DECKS: u8 = 1 << 0;
const BIT_COLLECTION: u8 = 1 << 1;
const BIT_WISHLIST: u8 = 1 << 2;

/// What has changed since the last pass, as three bits.
///
/// An `AtomicU8` rather than a `Mutex<Dirty>` because of where [`mark`](Mask::mark) is
/// called from: inside SQLite's update hook, on the writing thread, with the write
/// connection's mutex already held. A second mutex taken there is a second thing a write can
/// wait on, and a lock-free `fetch_or` costs a single instruction.
///
/// The second counter is what makes the debounce mean what it says. Marking a surface that
/// is already in the mask changes no bit, so bits alone cannot tell "still being edited"
/// from "dirty and quiet" — and a reader dragging thirty cards into one deck would have the
/// pass fire in the middle of it. [`marks`](Mask::marks) is bumped by every mark, changed or
/// not, and the thread restarts its two seconds whenever the number moves.
#[derive(Debug, Default)]
pub struct Mask {
    bits: AtomicU8,
    marks: AtomicU64,
}

impl Mask {
    /// Add a surface to the mask.
    pub fn mark(&self, d: Dirty) {
        self.bits.fetch_or(bits_of(d), Ordering::Relaxed);
        self.marks.fetch_add(1, Ordering::Relaxed);
    }

    /// Every surface — a finished sync, a finished feed refresh, a failed pass, and the
    /// moment the mirror is switched back on.
    pub fn mark_all(&self) {
        self.mark(Dirty::ALL);
    }

    /// Take what is dirty, clearing the mask as it reads. `None` when nothing is.
    ///
    /// **Clearing and reading are one atomic swap**, which is the whole reason this is not a
    /// `peek` and a `clear`: a write that landed between the two would be read by neither the
    /// pass that is starting nor the one after it, and the file would stay stale until the
    /// next unrelated edit.
    pub fn take(&self) -> Option<Dirty> {
        dirty_of(self.bits.swap(0, Ordering::Relaxed))
    }

    /// Is anything dirty? A plain load — it does not clear, and the thread uses it to avoid
    /// consulting the settings on a tick with nothing to do.
    pub fn is_dirty(&self) -> bool {
        self.bits.load(Ordering::Relaxed) != 0
    }

    /// How many times [`mark`](Mask::mark) has been called. See the struct doc.
    pub fn marks(&self) -> u64 {
        self.marks.load(Ordering::Relaxed)
    }
}

fn bits_of(d: Dirty) -> u8 {
    let mut b = 0;
    if d.decks {
        b |= BIT_DECKS;
    }
    if d.collection {
        b |= BIT_COLLECTION;
    }
    if d.wishlist {
        b |= BIT_WISHLIST;
    }
    b
}

fn dirty_of(bits: u8) -> Option<Dirty> {
    if bits == 0 {
        return None;
    }
    Some(Dirty {
        decks: bits & BIT_DECKS != 0,
        collection: bits & BIT_COLLECTION != 0,
        wishlist: bits & BIT_WISHLIST != 0,
    })
}

// ---------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------

/// Watch every write on `conn` and mark the mask.
///
/// **Install this on the write connection and nowhere else.** `db_read` is opened read-only
/// and can never fire it; installing a second hook on a second connection would simply
/// replace this one, because SQLite allows exactly one update hook per handle.
///
/// **A bare `DELETE FROM <table>` may not reach here.** SQLite's truncate optimisation empties
/// a table without visiting rows, and the update hook is documented as not firing for it. The
/// optimisation is disabled by triggers and by foreign-key processing, which is why the Danger
/// Zone's three clears still mark: each of them empties a table other rows point at with
/// `ON DELETE CASCADE`. The tests at the bottom of this file are what keep that true, rather
/// than a claim about SQLite's release notes.
pub fn install_hook(conn: &Connection, mask: Arc<Mask>, fence: Arc<crate::db::CrossFileFence>) {
    // **The fence rides in the mirror's hook because SQLite allows exactly one update hook
    // per connection**, which is the rule stated two paragraphs up: a second `install_hook`
    // replaces rather than adds, so a second *installer* would silently take this one off.
    // That is why the two live in one function rather than in two.
    let marker = fence.clone();
    // The `Result` is `Err` only for a connection this crate never makes — one already lent
    // out, or borrowed from a shared handle — so there is nothing to recover, and refusing to
    // start the app over a mirror that will not notice edits would be the wrong trade. A
    // failure here degrades to "the startup pass is the only pass", which is still a mirror.
    if let Err(e) = conn.update_hook(Some(
        move |_action: rusqlite::hooks::Action, db: &str, table: &str, _rowid: i64| {
            marker.note(db);
            if let Some(d) = surface_of(table) {
                mask.mark(d);
            }
        },
    )) {
        eprintln!("the backup mirror will not see live edits: {e}");
    }
    let settling = fence.clone();
    // Both of these fail for the one reason the update hook does, and with the same answer:
    // a fence that could not be installed costs a diagnostic, never a launch.
    let _ = conn.commit_hook(Some(move || {
        if settling.settle() {
            // Said out loud rather than asserted: this is a diagnostic on a user's machine
            // and the write has already happened. `crate::sync::with_write` is where a debug
            // build turns it into a failing test.
            eprintln!(
                "a transaction wrote to both the user database and the card database; \
                 SQLite does not guarantee those commit together"
            );
        }
        // **Never true.** A commit hook that answered `true` would abort the commit, which
        // would turn a diagnostic into data loss over a bug in this fence.
        false
    }));
    let clearing = fence;
    let _ = conn.rollback_hook(Some(move || clearing.clear()));
}

// ---------------------------------------------------------------------------------------
// The thread
// ---------------------------------------------------------------------------------------

/// How often the thread looks at the mask. Small enough that [`DEBOUNCE`] is what a reader
/// experiences rather than this, and large enough that an idle app is idle.
pub const TICK: Duration = Duration::from_millis(250);

/// How long the mask has to sit unchanged before a pass runs.
///
/// The whole of the debounce's job is to turn an editing session into one pass rather than
/// one per keystroke: adding thirty cards to a deck is thirty hook fires and, two seconds
/// after the last of them, a single render.
pub const DEBOUNCE: Duration = Duration::from_millis(2_000);

/// What the last pass did, as the Settings panel reads it back.
///
/// In memory and not in the database, deliberately: these numbers describe a folder that may
/// not survive a restart — a stick, a synced drive, a path that was valid on the other
/// machine — and a count read back after one would be a claim about a disk nobody has looked
/// at since. `None` everywhere is the honest state of a session whose first pass has not
/// finished.
#[derive(Debug, Default, Clone)]
pub struct LastPass {
    /// Unix seconds as a string, matching `SyncStatus::last_check_at`'s shape.
    pub last_run_at: Option<String>,
    pub last_report: Option<PassReport>,
    /// The sentence to show when the pass could not write. `None` when it went fine.
    pub last_error: Option<String>,
}

/// Record a finished pass on the state, for [`crate::mirror::settings::mirror_status`].
///
/// Shared with `mirror_rebuild`, which has to stamp its own pass: without it a manual
/// rebuild reports "350 files written" directly above a "last written" line still pointing at
/// whatever the thread last did, and the panel ranks those two by clock.
pub fn record(state: &AppState, outcome: &Result<PassReport, String>) {
    let mut last = crate::sync::lock_plain(&state.mirror_status);
    last.last_run_at = Some(unix_now().to_string());
    match outcome {
        Ok(report) => {
            last.last_report = Some(report.clone());
            last.last_error = None;
        }
        // The report is left as it was: it describes the last pass that *got* somewhere, and
        // blanking it would take the panel's only numbers away at the moment they are most
        // worth reading beside the failure.
        Err(e) => last.last_error = Some(e.clone()),
    }
}

/// Start the mirror thread. Detached, and never fatal.
///
/// **No `AppHandle`.** The brief's signature carried one for the `try_state` race
/// [`crate::paths::covers_dir`] documents, but that race is the *webview* reaching a command
/// before `setup` has managed the state — and this is called from inside `setup` with the
/// `Arc` already in hand, after `prepare_database`. There is nothing to wait for and nothing
/// to emit: the Backup panel polls `mirror_status` rather than listening for an event.
///
/// The handle is dropped exactly as [`crate::index::lifecycle::spawn_build`]'s is. A thread
/// that could not be started costs the mirror and nothing else, so it is printed and
/// swallowed rather than returned into `setup`, where a `Box<dyn Error>` reaches the user as
/// a one-line panic.
pub fn spawn(state: Arc<AppState>) {
    if let Err(e) = std::thread::Builder::new()
        .name("mirror".to_owned())
        .spawn(move || watch(&state))
    {
        eprintln!("the backup mirror did not start: {e}");
    }
}

/// The longest this thread will wait between retries after a run of failed passes.
///
/// A minute, and the ceiling is the interesting half. Without a backoff an unreachable root is
/// retried every tick the mask stays dirty — roughly 1 600 times an hour, each one climbing the
/// `count` on a single folded `error_log` row and each one a `create_dir_all` at a path that is
/// not there. With one, the same hour is about sixty. It stops at a minute rather than climbing
/// further because the reader who plugs the stick back in is often watching the panel while
/// they do it, and `Rebuild now` is the immediate way out in any case.
const MAX_BACKOFF: Duration = Duration::from_secs(60);

/// How long to wait after `failures` consecutive failed passes: 2 s, 4 s, 8 s … to
/// [`MAX_BACKOFF`]. Zero failures is no wait at all.
fn backoff_for(failures: u32) -> Duration {
    if failures == 0 {
        return Duration::ZERO;
    }
    // Shift capped well inside `u32`, so the multiply cannot be the thing that overflows.
    let steps = 1u32 << failures.saturating_sub(1).min(16);
    DEBOUNCE.saturating_mul(steps).min(MAX_BACKOFF)
}

/// The loop.
///
/// **Its own read-only connection, never `AppState.db_read`** — the rule
/// [`crate::index::lifecycle::build_now`] states two lines from where this is spawned. A pass
/// reads all four listings and writes up to ~350 files, and holding the shared read connection
/// across that would queue every search and every `mirror_status` poll behind it. Spec §5 says
/// the mirror "never blocks a search"; a second reader under WAL is how that is true rather
/// than aspirational.
fn watch(state: &AppState) {
    // Spelled here, in `lib.rs`'s `init_state`, and in `index::lifecycle::build_now` — three
    // readers, three connections, one file.
    let conn = match crate::db::open_read(&state.data_dir) {
        Ok(conn) => conn,
        Err(e) => {
            // The end of the mirror for this session, and it is reported three ways rather
            // than swallowed: `init_state` opened this same file read-only moments ago, so a
            // failure here is not a transient the next tick would clear. Retrying it forever
            // would be a thread spinning on a question already answered.
            let message =
                format!("the backup mirror could not open a database connection of its own: {e}");
            eprintln!("{message}");
            record(state, &Err(message.clone()));
            note_failure(state, &message);
            return;
        }
    };

    let mut cache = DigestCache::default();
    let mut on = settings::enabled(&conn);
    // The startup pass, before the loop and before anything can have been edited: it is the
    // whole of what makes a mirror correct after a crash, a kill, or a write that landed while
    // the last session was closing. `Dirty::ALL`, because the mask cannot describe what
    // happened while the process was not running.
    //
    // **The mask is taken first, and the order is the point.** `install_hook` runs before this
    // thread starts, so anything written between the two is already marked — and a full render
    // covers it, so leaving it marked would buy nothing and cost a second full render two and a
    // quarter seconds later. Taken *before* rather than after because a write that lands while
    // the pass is running must stay marked: it may not be in the rows this pass read.
    let mut failures = 0u32;
    if on {
        state.mirror.take();
        failures = pass(state, &conn, Dirty::ALL, &mut cache, failures);
    }

    let mut settings_checked = Instant::now();
    let mut seen_marks = state.mirror.marks();
    let mut quiet_since = Instant::now();
    let mut last_failure = Instant::now();

    loop {
        std::thread::sleep(TICK);

        // The settings, at most once per debounce rather than once per tick. One `app_meta`
        // row is cheap, but four reads a second forever is the sort of cost that is invisible
        // until it is not.
        if settings_checked.elapsed() >= DEBOUNCE {
            settings_checked = Instant::now();
            let now_on = settings::enabled(&conn);
            // Off to on: a full pass, because everything written while it was off is
            // unrecorded and the mask cannot describe it. This is what "takes effect without a
            // restart" has to mean — a mirror that waited for the reader's next edit before
            // writing anything would look broken for as long as they did not make one.
            if now_on && !on {
                state.mirror.mark_all();
            }
            on = now_on;
        }
        if !on {
            // Ticking, and deliberately *not* taking the mask: what is dirty stays dirty, so
            // switching back on writes the edits made while it was off.
            continue;
        }

        let marks = state.mirror.marks();
        if marks != seen_marks {
            seen_marks = marks;
            quiet_since = Instant::now();
            continue;
        }
        if !state.mirror.is_dirty() || quiet_since.elapsed() < DEBOUNCE {
            continue;
        }
        // The backoff, and it is checked here rather than folded into the debounce so that a
        // run of failures slows the *retries* without slowing anything else: the mask keeps
        // accumulating, the settings keep being read, and the first pass after the root comes
        // back is still a full one.
        if last_failure.elapsed() < backoff_for(failures) {
            continue;
        }
        let Some(dirty) = state.mirror.take() else {
            continue;
        };
        failures = pass(state, &conn, dirty, &mut cache, failures);
        if failures > 0 {
            last_failure = Instant::now();
        }
    }
}

/// Run one pass and record what it did. Answers the new consecutive-failure count.
///
/// **Never `AppState.db`, and never `AppState.db_read` either** — see [`watch`]. `conn` is this
/// thread's own read-only handle, so a pass that takes seconds blocks no search, no facet
/// request and no `mirror_status` poll.
///
/// **The digest cache is not swept here, and it used to be.** Two special cases stood in this
/// function — clear on failure, clear when the root moved — because a remembered digest let
/// `run::put` skip a file that was no longer on disk. A third way to reach the same state (the
/// reader deleting the mirror folder while the app runs, which `README.txt` tells them is safe)
/// showed the shape was wrong: `put` now confirms a cache hit with a `stat` before trusting it,
/// which answers all three at once. What is left here is the one thing that is genuinely about
/// the *mask* rather than the disk.
///
/// **A panic is caught rather than allowed to end the thread.** The mutexes recover from
/// poisoning crate-wide, so a panic in here was survivable in the sense that nothing else
/// broke — and invisible in every sense that matters: no `error_log` row, no sentence in the
/// panel, and a Backup panel reporting the last good pass forever while the folder quietly
/// stopped being updated. Caught, it is an ordinary failure with an ordinary backoff.
/// `AssertUnwindSafe` is honest here rather than a silencer: the one thing a panic can leave
/// half-written is `cache`, and a stale or missing entry there costs a `stat` and a rewrite.
fn pass(
    state: &AppState,
    conn: &Connection,
    dirty: Dirty,
    cache: &mut DigestCache,
    failures: u32,
) -> u32 {
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let root = settings::root(conn, &state.data_dir);
        crate::mirror::run::run_pass(conn, &root, dirty, cache)
    }))
    .unwrap_or_else(|payload| Err(panic_sentence(&payload)));

    record(state, &outcome);
    match &outcome {
        Ok(_) => 0,
        Err(e) => {
            // The mask was taken before this ran, so the surfaces this pass was responsible for
            // are no longer recorded anywhere else. `mark_all` rather than re-marking `dirty`:
            // spec §7's "a root that comes back gets a full rebuild rather than a partial one",
            // because the mask cannot describe what was missed while it was gone.
            state.mirror.mark_all();
            note_failure(state, e);
            failures.saturating_add(1)
        }
    }
}

/// The sentence a caught panic becomes. `Box<dyn Any>` carries the payload of `panic!`, which
/// is a `&str` for a literal and a `String` for a format — and neither for a panic raised any
/// other way, which is what the third arm is for.
fn panic_sentence(payload: &Box<dyn std::any::Any + Send>) -> String {
    let what = payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "no message".to_owned());
    format!("the backup mirror hit a bug and skipped this pass: {what}")
}

/// One `error_log` row for a failed pass — never one per file, which is what
/// [`crate::mirror::run::PassReport::failed`] counts instead.
///
/// `Duration::ZERO` is one `try_lock` and no waiting, the shape
/// [`crate::images::Cache::flush_records`] uses for its own bookkeeping: this describes a
/// failure that has already happened, on a thread nobody is waiting for, and it must not be
/// the reason a button answers [`crate::db::BUSY`]. A row dropped because a sync held the
/// connection costs the log one entry; the sentence still reaches the reader through
/// `mirror_status`, which is the panel's actual source.
///
/// [`crate::errors::Source::Database`] rather than a source of its own: the five are
/// CHECK-constrained in SQL and narrowed again in TypeScript, so a sixth is a migration and a
/// frontend change, neither of which belongs in this task.
fn note_failure(state: &AppState, message: &str) {
    if let Some(conn) = crate::db::lock_for(&state.db, Duration::ZERO) {
        crate::errors::record(
            &conn,
            crate::errors::Source::Database,
            "mirror_pass",
            crate::errors::Kind::Io,
            message,
            None,
        );
    }
}

/// Seconds since the Unix epoch. A clock before 1970 reads as 0, the choice
/// [`crate::sync`] and [`crate::marketplace_feed`] both make.
fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn migrated_memory_db() -> Connection {
        crate::schema::memory_pair()
    }

    /// An [`AppState`] over a real file database inside a `tempfile` root.
    ///
    /// A file and not `:memory:` because the two connections have to be the *same* database —
    /// two in-memory handles are two empty ones — and `tempfile` rather than
    /// `std::env::temp_dir()` because a pass writes files and nothing in this suite may put
    /// one where a later run would find it.
    fn state_at(dir: &Path) -> AppState {
        crate::split::convert(dir).unwrap();
        let conn = crate::db::open_write(dir).unwrap();
        let read = crate::db::open_read(dir).unwrap();
        AppState {
            db: std::sync::Mutex::new(conn),
            db_read: std::sync::Mutex::new(read),
            data_dir: dir.to_path_buf(),
            syncing: std::sync::atomic::AtomicBool::new(false),
            // Never called: nothing in this module reaches the network or an image.
            client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            images: crate::images::Cache::new(dir.join("images")),
            index: std::sync::RwLock::default(),
            mirror: Arc::new(Mask::default()),
            mirror_status: std::sync::Mutex::new(LastPass::default()),
            fence: std::sync::Arc::new(crate::db::CrossFileFence::new()),
        }
    }

    /// A transaction that writes both files commits non-atomically in WAL mode, and SQLite
    /// will not say so. This is what says so.
    #[test]
    fn the_fence_trips_on_a_transaction_that_writes_both_files() {
        let conn = migrated_memory_db();
        let mask = Arc::new(Mask::default());
        let fence = Arc::new(crate::db::CrossFileFence::new());
        install_hook(&conn, mask.clone(), fence.clone());

        conn.execute_batch(
            "BEGIN;
             INSERT INTO decks (name, format_key, created_at, updated_at)
               VALUES ('one file', 'casual', 0, 0);
             COMMIT;",
        )
        .unwrap();
        assert!(!fence.tripped(), "a user-only transaction is fine");

        conn.execute_batch(
            "BEGIN;
             INSERT INTO decks (name, format_key, created_at, updated_at)
               VALUES ('two files', 'casual', 0, 0);
             INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz', 'probe');
             COMMIT;",
        )
        .unwrap();
        assert!(fence.tripped(), "a cross-file transaction must be caught");
    }

    /// A rolled-back transaction is not a cross-file commit, and marking one would make the
    /// fence cry wolf on every failed write in the app.
    ///
    /// **The second half is what makes the rollback hook load-bearing, and the first half
    /// alone did not.** `settle` runs from the *commit* hook, which a `ROLLBACK` never
    /// reaches — so the rolled-back transaction cannot trip the fence whether the rollback
    /// hook exists or not, and a test that stopped there passed with it deleted. What the
    /// hook actually buys is the *next* commit: without the clear, the abandoned bits sit in
    /// `seen`, and the first ordinary user-only write after a failed one reports a crossing
    /// that never happened.
    #[test]
    fn a_rolled_back_cross_file_transaction_does_not_trip_the_fence() {
        let conn = migrated_memory_db();
        let fence = Arc::new(crate::db::CrossFileFence::new());
        install_hook(&conn, Arc::new(Mask::default()), fence.clone());
        conn.execute_batch(
            "BEGIN;
             INSERT INTO decks (name, format_key, created_at, updated_at) VALUES ('x','casual',0,0);
             INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz','probe');
             ROLLBACK;",
        )
        .unwrap();
        assert!(!fence.tripped(), "a rollback is not a commit");

        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at) VALUES ('y','casual',0,0)",
            [],
        )
        .unwrap();
        assert!(
            !fence.tripped(),
            "the abandoned transaction's bits must not be charged to the next write"
        );
    }

    /// The mirror still sees every write it is supposed to, now that half the schema is in
    /// another file — and it still sees none of the ones it is not.
    #[test]
    fn the_mask_is_unmoved_by_the_split() {
        let conn = migrated_memory_db();
        let mask = Arc::new(Mask::default());
        install_hook(
            &conn,
            mask.clone(),
            Arc::new(crate::db::CrossFileFence::new()),
        );

        conn.execute(
            "INSERT OR REPLACE INTO sets (code, name) VALUES ('zzz','probe')",
            [],
        )
        .unwrap();
        assert_eq!(mask.take(), None, "a corpus write must mark nothing");

        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at) VALUES ('d','casual',0,0)",
            [],
        )
        .unwrap();
        let taken = mask.take().expect("a user write must mark something");
        // Both, because a deck stands for a folder in the cabinet since schema v25 -
        // `surface_of` maps this table to DECKS_AND_COLLECTION and the split changed nothing
        // about that.
        assert!(taken.decks && taken.collection && !taken.wishlist);
    }

    /// The load-bearing row of the map. A sync rewrites 116 700 `cards` rows and a feed
    /// refresh rewrites the price table; either one mapped to a surface is a hundred thousand
    /// hook fires and a full rebuild per refresh.
    #[test]
    fn the_tables_a_sync_rewrites_map_to_nothing() {
        for table in [
            "cards",
            "sets",
            "marketplace_prices",
            "marketplace_feed_meta",
            "image_cache",
            "deck_audit",
            "deck_undo",
            "error_log",
            "app_meta",
            "sync_meta",
            "card_migrations",
            "format_specs",
            "muted_tags",
            "oracle_tags",
            "oracle_taggings",
            "oracle_tag_cards",
            "oracle_tag_parents",
            "oracle_tag_meta",
            "art_tags",
            "art_taggings",
            "art_tag_illustrations",
            "art_tag_parents",
            "art_tag_meta",
        ] {
            assert_eq!(
                surface_of(table),
                None,
                "{table} must never trigger a mirror pass"
            );
        }
    }

    /// Every table the schema creates is either in the map on purpose or out of it on purpose.
    /// The point is the *next* table: one added without a decision here changes this number
    /// rather than quietly mirroring nothing — or everything.
    #[test]
    fn every_table_in_the_schema_has_been_decided_about() {
        let conn = migrated_memory_db();
        // **Both files, and the `UNION ALL` is the whole of why this test still means
        // anything.** `sqlite_master` unqualified is `main`'s, so from the day the corpus
        // moved into a file of its own an unqualified read would have gone on passing while
        // covering fifteen tables instead of forty — a guard that silently halves its own
        // scope, which is exactly the failure it exists to catch.
        let mut stmt = conn
            .prepare(
                "SELECT name FROM main.sqlite_master WHERE type = 'table'
                 UNION ALL
                 SELECT name FROM corpus.sqlite_master WHERE type = 'table'
                 ORDER BY name",
            )
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();

        let (mapped, ignored): (Vec<&str>, Vec<&str>) = tables
            .iter()
            .map(String::as_str)
            .partition(|t| surface_of(t).is_some());

        // The nine that reach the mirror.
        assert_eq!(
            mapped,
            [
                "collection_entries",
                "collection_folders",
                "deck_cards",
                "deck_categories",
                "deck_folders",
                "deck_tags",
                "decks",
                "wishlist_entries",
                "wishlist_folders",
            ]
        );

        // **And every other table the schema creates, by name.** The count alone was the first
        // draft of this and it could not fail: `tables.len()` appeared only in an assertion
        // *message*, so a migration adding a table passed green and the doc on `surface_of`
        // claiming otherwise was simply wrong. Spelled out, a new table is a red test with an
        // obvious remedy — add it here, having decided which side of the match it is on.
        //
        // The `cards_fts*` five are FTS5's own shadow tables. They are in `sqlite_master` like
        // any other, the ingest writes them, and they map to nothing for the reason `cards`
        // does.
        assert_eq!(
            ignored,
            [
                "app_meta",
                "art_tag_illustrations",
                "art_tag_meta",
                "art_tag_parents",
                "art_taggings",
                "art_tags",
                "card_migrations",
                "cards",
                "cards_fts",
                "cards_fts_config",
                "cards_fts_data",
                "cards_fts_docsize",
                "cards_fts_idx",
                // The Commander Spellbook feed's three (schema v26). They map to nothing for
                // `cards`' and `marketplace_prices`' reason and a sharper one: a refresh
                // rewrites all three wholesale, the reader never edits a row in any of them,
                // and no mirrored file quotes a combo — so a surface here would be tens of
                // thousands of hook calls per refresh in exchange for nothing on disk.
                "combo_cards",
                "combo_meta",
                "combos",
                "deck_audit",
                "deck_undo",
                "error_log",
                "format_specs",
                "image_cache",
                "marketplace_feed_meta",
                "marketplace_prices",
                "muted_tags",
                "oracle_tag_cards",
                "oracle_tag_meta",
                "oracle_tag_parents",
                "oracle_taggings",
                "oracle_tags",
                "sets",
                // Pairing's three (user schema v28). They map to nothing for the sharpest
                // reason on this list: they hold this device's secret key, the group key and
                // the roster, and a mirrored file that quoted any of them would write a key
                // into a folder the reader syncs with Dropbox. `sync_devices` could not reach
                // the hook anyway — it is `WITHOUT ROWID`, like `muted_tags` — but the other
                // two can, and "the hook cannot see it" is not a decision.
                "sync_devices",
                "sync_group",
                "sync_identity",
                "sync_meta",
            ],
            "a table added to the schema has to be decided about here"
        );
    }

    #[test]
    fn every_user_table_maps_to_the_surface_it_belongs_to() {
        assert!(surface_of("deck_cards").unwrap().decks);
        assert!(!surface_of("deck_cards").unwrap().collection);
        assert!(surface_of("deck_categories").unwrap().decks);
        assert!(surface_of("deck_tags").unwrap().decks);
        assert!(surface_of("deck_folders").unwrap().decks);
        assert!(surface_of("wishlist_entries").unwrap().wishlist);
        assert!(surface_of("wishlist_folders").unwrap().wishlist);
        assert!(!surface_of("wishlist_entries").unwrap().decks);
        assert!(surface_of("collection_entries").unwrap().collection);
        assert!(!surface_of("collection_entries").unwrap().decks);
        assert!(surface_of("collection_folders").unwrap().collection);
        let decks = surface_of("decks").unwrap();
        assert!(
            decks.decks && decks.collection,
            "a deck's name titles its group folder"
        );
        assert!(!decks.wishlist);
    }

    #[test]
    fn the_mask_accumulates_and_take_clears_it() {
        let mask = Mask::default();
        assert_eq!(mask.take(), None);
        mask.mark(Dirty {
            decks: true,
            collection: false,
            wishlist: false,
        });
        mask.mark(Dirty {
            decks: false,
            collection: false,
            wishlist: true,
        });
        let taken = mask.take().unwrap();
        assert!(taken.decks && taken.wishlist && !taken.collection);
        assert_eq!(mask.take(), None, "taking must clear");
    }

    /// Re-marking a surface already in the mask changes no bit — which is exactly why the
    /// debounce cannot key off the bits. If this stops counting, a reader adding thirty cards
    /// to one deck gets a pass in the middle of the drag.
    #[test]
    fn marking_the_same_surface_twice_still_counts_as_activity() {
        let mask = Mask::default();
        let before = mask.marks();
        mask.mark(DECKS_ONLY);
        let once = mask.marks();
        mask.mark(DECKS_ONLY);
        assert!(once > before, "the first mark must count");
        assert!(
            mask.marks() > once,
            "a mark that changes no bit must still restart the debounce"
        );
    }

    #[test]
    fn mark_all_covers_every_surface() {
        let mask = Mask::default();
        assert!(!mask.is_dirty());
        mask.mark_all();
        assert!(mask.is_dirty());
        assert_eq!(mask.take(), Some(Dirty::ALL));
        assert!(!mask.is_dirty());
    }

    #[test]
    fn a_write_through_the_hooked_connection_marks_its_surface() {
        let conn = migrated_memory_db();
        let mask = Arc::new(Mask::default());
        install_hook(
            &conn,
            mask.clone(),
            Arc::new(crate::db::CrossFileFence::new()),
        );
        conn.execute(
            "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
             VALUES ('Ordered', 0, 0, 0)",
            [],
        )
        .unwrap();
        let taken = mask.take().unwrap();
        assert!(taken.wishlist);
        assert!(!taken.decks && !taken.collection);
    }

    #[test]
    fn a_write_to_a_table_the_map_ignores_marks_nothing() {
        let conn = migrated_memory_db();
        let mask = Arc::new(Mask::default());
        install_hook(
            &conn,
            mask.clone(),
            Arc::new(crate::db::CrossFileFence::new()),
        );
        crate::update::set_app_meta(&conn, "anything", "at all").unwrap();
        assert_eq!(mask.take(), None);
    }

    /// A card row, which is what a sync writes 116 700 of. It must not so much as flip a bit.
    #[test]
    fn writing_a_card_row_does_not_mark_anything() {
        let conn = migrated_memory_db();
        let mask = Arc::new(Mask::default());
        install_hook(
            &conn,
            mask.clone(),
            Arc::new(crate::db::CrossFileFence::new()),
        );
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('bolt-lea','Lightning Bolt','lea','161','en','normal',1,'{}')",
            [],
        )
        .unwrap();
        assert_eq!(
            mask.take(),
            None,
            "a sync must not put the mirror to work per row"
        );
    }

    /// The one thing SQLite's docs say the update hook does *not* see: a whole table emptied by
    /// the truncate optimisation. `reset::clear_wishlist` is bare `DELETE FROM`s, so this is
    /// the difference between "wiped the wishlist" reaching the mirror and not.
    #[test]
    fn clearing_a_whole_table_still_reaches_the_mirror() {
        let conn = migrated_memory_db();
        conn.execute(
            "INSERT INTO wishlist_folders (name, sort_order, created_at, updated_at)
             VALUES ('Ordered', 0, 0, 0)",
            [],
        )
        .unwrap();
        let mask = Arc::new(Mask::default());
        install_hook(
            &conn,
            mask.clone(),
            Arc::new(crate::db::CrossFileFence::new()),
        );
        conn.execute("DELETE FROM wishlist_folders", []).unwrap();
        assert!(
            mask.take().is_some_and(|d| d.wishlist),
            "a bare DELETE FROM must still mark — see `install_hook`"
        );
    }

    /// The same question for the collection's own clear. `collection_entries` is a child rather
    /// than a parent, so it is the half most likely to be truncated away with no hook fire.
    #[test]
    fn clearing_the_collection_reaches_the_mirror() {
        let conn = migrated_memory_db();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('bolt-lea','Lightning Bolt','lea','161','en','normal',1,'{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,quantity,created_at,updated_at)
             VALUES ('bolt-lea','lea','161','en','nonfoil',1,0,0)",
            [],
        )
        .unwrap();
        let mask = Arc::new(Mask::default());
        install_hook(
            &conn,
            mask.clone(),
            Arc::new(crate::db::CrossFileFence::new()),
        );
        conn.execute("DELETE FROM collection_entries", []).unwrap();
        assert!(
            mask.take().is_some_and(|d| d.collection),
            "emptying the collection must mark it"
        );
    }

    /// A deck through the app's own writer, so the map is checked against what the crate
    /// actually inserts rather than against hand-written SQL.
    #[test]
    fn creating_a_deck_marks_both_the_decks_and_the_cabinet() {
        let conn = migrated_memory_db();
        let mask = Arc::new(Mask::default());
        install_hook(
            &conn,
            mask.clone(),
            Arc::new(crate::db::CrossFileFence::new()),
        );
        crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "Burn".into(),
                format_key: "commander".into(),
                ..Default::default()
            },
        )
        .unwrap();
        let taken = mask.take().expect("creating a deck must mark something");
        assert!(taken.decks, "the deck's own files");
        assert!(taken.collection, "the group folder its name titles");
    }

    /// Ruling R12. A rebuild that did not stamp itself leaves the panel drawing
    /// "Rebuilt — 350 files written" directly above "Last written 2 hours ago", because it
    /// ranks the two by clock and the rebuild had left no clock reading of its own.
    #[test]
    fn a_rebuild_records_its_own_pass() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        {
            let conn = crate::sync::lock_db(&state);
            settings::set_root(&conn, &dir.path().join("mirror")).unwrap();
        }
        assert!(
            crate::sync::lock_plain(&state.mirror_status)
                .last_run_at
                .is_none(),
            "nothing has run yet"
        );
        let report = settings::rebuild_now(&state).unwrap();
        let last = crate::sync::lock_plain(&state.mirror_status);
        assert_eq!(
            last.last_report.as_ref(),
            Some(&report),
            "the panel's numbers must be the ones this press produced"
        );
        assert!(last.last_run_at.is_some(), "and stamped with when it ran");
    }

    /// The debounce is the reader-facing number and the tick is how finely it is measured; a
    /// tick at or above the debounce would make the wait a coin toss.
    #[test]
    fn the_tick_divides_the_debounce() {
        assert!(TICK < DEBOUNCE);
        assert_eq!(DEBOUNCE.as_millis() % TICK.as_millis(), 0);
    }

    /// `record` is what `mirror_rebuild` and the thread share, and the failure arm is the half
    /// with an opinion: a pass that could not write must not blank the numbers from the last
    /// one that could.
    #[test]
    fn a_failed_pass_keeps_the_last_report_and_adds_the_sentence() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let report = PassReport {
            written: 7,
            unchanged: 343,
            skipped: 0,
            pruned: 0,
            failed: 0,
        };
        record(&state, &Ok(report.clone()));
        {
            let last = crate::sync::lock_plain(&state.mirror_status);
            assert_eq!(last.last_report, Some(report.clone()));
            assert_eq!(last.last_error, None);
            assert!(last.last_run_at.is_some());
        }
        record(&state, &Err("the backup folder E:/cards is gone".into()));
        let last = crate::sync::lock_plain(&state.mirror_status);
        assert_eq!(
            last.last_report,
            Some(report),
            "the numbers describe the last pass that got somewhere"
        );
        assert!(last.last_error.as_deref().unwrap().contains("E:/cards"));
    }

    /// A pass that got somewhere clears the sentence the failed one left, or the panel would
    /// go on reporting an unplugged stick after the reader plugged it back in.
    #[test]
    fn a_pass_that_works_clears_the_previous_sentence() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        record(&state, &Err("gone".into()));
        record(&state, &Ok(PassReport::default()));
        assert_eq!(
            crate::sync::lock_plain(&state.mirror_status).last_error,
            None
        );
    }

    /// A read-only connection of the mirror thread's own, which is what [`watch`] opens: a
    /// pass reads four listings and writes ~350 files, and doing that on `AppState.db_read`
    /// queues every search behind it. The tests below take one the same way.
    fn own_conn(dir: &Path) -> Connection {
        crate::db::open_read(dir).unwrap()
    }

    /// Point the mirror at `root` without going through `set_root`'s validation.
    fn aim_at(state: &AppState, root: &Path) {
        let conn = crate::sync::lock_db(state);
        crate::update::set_app_meta(&conn, settings::K_ROOT, root.to_str().unwrap()).unwrap();
    }

    /// Spec §7's recovery contract. The mask was **taken** before the pass ran, so a failure
    /// that did not re-mark would lose the surfaces that pass was responsible for outright —
    /// and it re-marks *everything*, because the mask cannot describe what was missed while
    /// the root was gone.
    #[test]
    fn a_failed_pass_marks_everything_for_the_next_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let conn = own_conn(dir.path());
        // A file where a folder should be, so `create_dir_all` on a child of it cannot work.
        let blocker = dir.path().join("blocked");
        std::fs::write(&blocker, b"not a folder").unwrap();
        aim_at(&state, &blocker.join("mirror"));

        let mut cache = DigestCache::default();
        let failures = pass(&state, &conn, Dirty::ALL, &mut cache, 0);

        assert_eq!(failures, 1, "a failed pass is counted, for the backoff");
        assert_eq!(
            state.mirror.take(),
            Some(Dirty::ALL),
            "a root that comes back gets a full rebuild, not a partial one"
        );
        assert!(crate::sync::lock_plain(&state.mirror_status)
            .last_error
            .is_some());
    }

    /// The class of bug the `is_file` guard in `run::put` closes, in the shape that a reader
    /// can actually produce: `README.txt` tells them deleting the folder is safe, they delete
    /// it, and `create_dir_all` puts an empty one back — so **no failure arm fires at all**.
    /// A cache trusted on its own word would answer "unchanged" for all ~350 files and leave
    /// that folder empty for the rest of the session.
    ///
    /// This is what let two special cases be deleted from [`pass`]: clearing the cache on
    /// failure and clearing it when the root moved were each one route into this state, and
    /// neither of them covered this one.
    #[test]
    fn deleting_the_mirror_folder_mid_session_gets_it_rebuilt() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let conn = own_conn(dir.path());
        let root = dir.path().join("mirror");
        aim_at(&state, &root);

        let mut cache = DigestCache::default();
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);
        let first = cache.len();
        assert!(first > 0, "an empty collection still writes its own files");

        // What the reader does, and what the README says is safe.
        std::fs::remove_dir_all(&root).unwrap();

        let failures = pass(&state, &conn, Dirty::ALL, &mut cache, 0);

        assert_eq!(failures, 0, "recreating the folder is not a failure");
        let last = crate::sync::lock_plain(&state.mirror_status);
        assert_eq!(
            last.last_report.as_ref().unwrap().written,
            first,
            "every file the reader deleted is written again"
        );
        assert_eq!(last.last_report.as_ref().unwrap().unchanged, 0);
    }

    /// The same class from the other route, and the one the deleted `cached_root` special case
    /// used to answer: the digest map is keyed by a plan-relative path, which is the *same* key
    /// under both folders. Spec §7's "moving the root writes a fresh mirror at the new
    /// location" is this test plus `set_root_now`'s `mark_all`.
    #[test]
    fn moving_the_root_writes_a_whole_mirror_at_the_new_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let conn = own_conn(dir.path());
        let old_root = dir.path().join("old");
        aim_at(&state, &old_root);

        let mut cache = DigestCache::default();
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);
        let planned = cache.len();
        assert!(planned > 0);

        let new_root = dir.path().join("new");
        settings::set_root_now(&state, &new_root).unwrap();
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);

        assert!(
            new_root.is_dir(),
            "the pass creates the folder it was given"
        );
        assert_eq!(
            crate::sync::lock_plain(&state.mirror_status)
                .last_report
                .as_ref()
                .unwrap()
                .written,
            planned,
            "a digest taken under the old root cannot vouch for a file under the new one"
        );
        assert!(
            old_root.is_dir(),
            "and the previous folder is left exactly where it was — spec §7"
        );
    }

    /// The hash-skip, which is what makes the steady state render-and-hash rather than ~350
    /// writes every two seconds. The counterpart to the three tests above: they all end in a
    /// rewrite, and this one proves rewriting is not simply what always happens.
    ///
    /// **One file's contents are corrupted between the passes, and that is the experiment.**
    /// `run::put` has two ways to answer "unchanged" — the remembered digest, and a read of
    /// the file — so a test that just ran twice passes with the cache emptied every time and
    /// proves nothing. It was written that way first and a mutation clearing the cache on
    /// every pass survived it. The file is left *present* so the `is_file` guard is satisfied
    /// and only the digest can answer; a cold cache reads it, finds a mismatch and rewrites.
    ///
    /// It also pins the documented semantics: the cache trusts **presence**, not contents, and
    /// a hand-edited mirror file is `Rebuild now`'s job.
    #[test]
    fn a_second_pass_skips_a_file_whose_digest_it_remembers() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let conn = own_conn(dir.path());
        let root = dir.path().join("mirror");
        aim_at(&state, &root);

        let mut cache = DigestCache::default();
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);
        let first = cache.len();
        assert!(first > 0);

        let victim = root.join(cache.paths().next().unwrap());
        std::fs::write(&victim, b"a reader typed this").unwrap();
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);

        assert_eq!(cache.len(), first, "the digests survive a pass");
        let last = crate::sync::lock_plain(&state.mirror_status);
        assert_eq!(
            last.last_report.as_ref().unwrap().written,
            0,
            "a remembered digest is answered without reading the file"
        );
        assert_eq!(last.last_report.as_ref().unwrap().unchanged, first);
        drop(last);
        assert_eq!(
            std::fs::read(&victim).unwrap(),
            b"a reader typed this",
            "presence is what the cache checks, never contents"
        );
    }

    /// I3. A panic in the render used to end the thread with nothing to show for it: the
    /// mutexes recover crate-wide, so nothing else broke — and nothing was recorded either,
    /// leaving the panel reporting the last good pass while the folder quietly stopped
    /// updating.
    ///
    /// **Driven through [`pass`] itself, which the first version of this test was not.** It
    /// re-implemented `catch_unwind` + [`panic_sentence`] + [`record`] in its own body and
    /// never called the function it is named after, so deleting [`pass`]'s own `catch_unwind`
    /// left it green — the guard was the one thing here that was untested.
    ///
    /// **The subject is an `i64` overflow in the fold, which is a real bug's shape rather than
    /// a `panic!` planted for the occasion.** Two collection rows of one printing, told apart
    /// only by a serial number, each holding `i64::MAX` copies: every format but CSV renders
    /// without a serial-number channel, so `fold_for_fields` merges them and `seen.quantity +=
    /// card.quantity` overflows. That is `render` → `format_export` → `fold`, entirely inside
    /// the caught closure.
    ///
    /// `#[cfg(debug_assertions)]` because that is what makes the overflow a panic: a release
    /// build wraps instead, and the pass would then succeed and this test would be red for a
    /// reason that is not the guard. `npm run verify` and CI both run `cargo test` in debug.
    #[cfg(debug_assertions)]
    #[test]
    fn a_panic_inside_the_pass_is_recorded_and_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        seed_a_render_that_overflows(&state);
        let conn = own_conn(dir.path());
        let root = dir.path().join("mirror");
        aim_at(&state, &root);

        let failures = pass(&state, &conn, Dirty::ALL, &mut DigestCache::default(), 0);

        assert_eq!(failures, 1, "a caught panic is an ordinary failure");
        let last = crate::sync::lock_plain(&state.mirror_status);
        let sentence = last.last_error.clone().expect("the panic must be recorded");
        assert!(sentence.contains("skipped this pass"), "{sentence}");
        assert!(
            sentence.contains("overflow"),
            "the payload has to survive into the sentence: {sentence}"
        );
        drop(last);
        assert!(
            state.mirror.is_dirty(),
            "and the surfaces it was responsible for are marked again"
        );
    }

    /// Two collection rows of one printing that a fold with no serial-number channel merges,
    /// each holding as many copies as an `i64` can — so the merge overflows.
    ///
    /// **Seeding `cards` is allowed here only because the database is a file in a tempdir that
    /// dies with the test**, so no later measurement of the real corpus can be made a fiction
    /// by it. The two entries go in through `collection::add_entry`, the app's own write.
    #[cfg(debug_assertions)]
    fn seed_a_render_that_overflows(state: &AppState) {
        let conn = crate::sync::lock_db(state);
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,type_line,finishes,prices,raw)
             VALUES ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                'Instant','[\"nonfoil\",\"foil\"]','{\"usd\":\"1.00\"}','{}')",
            [],
        )
        .unwrap();
        for i in 0..2 {
            crate::collection::add_entry(
                &conn,
                &crate::collection::EntryInput {
                    card_id: "bolt-lea".to_owned(),
                    finish: "nonfoil".to_owned(),
                    quantity: i64::MAX,
                    serial_number: Some(format!("{i}/2")),
                    ..Default::default()
                },
            )
            .unwrap();
        }
    }

    /// A `String` payload as well as the `&str` one above, because a downcast handling only
    /// one of the two turns a whole class of panic into "no message".
    ///
    /// **The obvious version of this test cannot fail, and it was the first draft.**
    /// `panic!("root {} is gone", 7)` looks like a formatted panic and is not: every argument
    /// is a literal, so the message is const-evaluated and the payload arrives as a
    /// `&'static str`. Removing the `String` arm from `panic_sentence` left that test green —
    /// a surviving mutation, and the reason these two subjects are what they are. Both were
    /// checked by printing the two downcasts rather than reasoned about:
    ///
    /// * a format argument with a runtime value, which is `Some(String)`;
    /// * `Result::unwrap()` on an `Err`, which is the realistic way a bug in the render path
    ///   would reach [`pass`]'s guard, and is also `Some(String)`.
    #[test]
    fn a_string_payload_keeps_its_message_too() {
        let root = std::env::temp_dir().join("E-cards").display().to_string();
        let formatted = std::panic::catch_unwind(|| panic!("root {root} is gone")).unwrap_err();
        assert!(
            formatted.downcast_ref::<String>().is_some(),
            "the subject has to be a String payload or this test proves nothing"
        );
        assert!(panic_sentence(&formatted).contains("is gone"));

        let unwrapped = std::panic::catch_unwind(|| "nope".parse::<u8>().unwrap()).unwrap_err();
        assert!(unwrapped.downcast_ref::<String>().is_some());
        assert!(panic_sentence(&unwrapped).contains("InvalidDigit"));
    }

    /// The backoff, which is the difference between climbing one `error_log` row's count ~1 600
    /// times an hour and ~60. Doubling, and capped — the cap is the half that matters, because
    /// the reader plugging the stick back in is often watching the panel while they do it.
    #[test]
    fn the_retry_backoff_doubles_and_stops_at_a_minute() {
        assert_eq!(
            backoff_for(0),
            Duration::ZERO,
            "a healthy pass waits not at all"
        );
        assert_eq!(backoff_for(1), DEBOUNCE);
        assert_eq!(backoff_for(2), DEBOUNCE * 2);
        assert_eq!(backoff_for(3), DEBOUNCE * 4);
        assert_eq!(backoff_for(10), MAX_BACKOFF);
        assert_eq!(
            backoff_for(u32::MAX),
            MAX_BACKOFF,
            "and it must not overflow on the way there"
        );
    }

    /// A pass that works resets the count, so one bad afternoon does not leave the mirror
    /// waiting a minute between passes for the rest of the session.
    #[test]
    fn a_pass_that_works_clears_the_backoff() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let conn = own_conn(dir.path());
        aim_at(&state, &dir.path().join("mirror"));
        let mut cache = DigestCache::default();
        assert_eq!(pass(&state, &conn, Dirty::ALL, &mut cache, 9), 0);
    }

    /// I1, and spec §7's "moving the root writes a fresh mirror at the new location". Nothing
    /// else can mark it: `mirror_root` is an `app_meta` row, and `app_meta` maps to no surface.
    #[test]
    fn choosing_a_new_folder_marks_every_surface() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        assert_eq!(state.mirror.take(), None, "nothing is dirty yet");
        settings::set_root_now(&state, &dir.path().join("mirror")).unwrap();
        assert_eq!(
            state.mirror.take(),
            Some(Dirty::ALL),
            "the new folder has to be written, and only a mark can cause that"
        );
    }

    /// The other half of it: a refused path has moved nothing, so it must not cause a pass.
    #[test]
    fn a_refused_folder_marks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        settings::set_root_now(&state, Path::new("export")).unwrap_err();
        assert_eq!(state.mirror.take(), None);
    }

    /// The sync gate, through the one part of `run_sync`'s tail that a test can reach — that
    /// function takes a `tauri::AppHandle` and this crate has no mock-app harness, so the
    /// *call* to this stays untested and is reported as such. The condition is what is worth
    /// pinning: a throttled run that downloaded nothing must not spend a full render, and a
    /// run that did must.
    #[test]
    fn only_a_sync_that_updated_something_marks_the_mirror() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let outcome = |updated| crate::sync::SyncOutcome {
            updated,
            card_count: 116_700,
            updated_at: None,
        };

        crate::sync::note_mirror_after_sync(&state, &Ok(outcome(false)));
        assert_eq!(
            state.mirror.take(),
            None,
            "a throttled run changed no card name and must cost no render"
        );

        crate::sync::note_mirror_after_sync(&state, &Err("no network".into()));
        assert_eq!(state.mirror.take(), None, "and neither must a failure");

        crate::sync::note_mirror_after_sync(&state, &Ok(outcome(true)));
        assert_eq!(
            state.mirror.take(),
            Some(Dirty::ALL),
            "a corrected card name reaches the files this way and no other"
        );
    }

    /// **Bug 1 from the live pass.** Measured against the real corpus: delete the mirror folder
    /// mid-session and 93 of 100 files come back — `Wishlist/` never does. `abs.is_file()`
    /// forces a rewrite of every file whose *surface* is being rendered, and the next edit
    /// dirties one surface, so a wishlist nobody has touched stays missing for the rest of the
    /// session while `README.txt` promises the reader that deleting the folder is safe.
    ///
    /// The signal is the manifest: the one file the mirror always writes and never plans away,
    /// so its absence under a root that exists means the mirror was reset and the next pass
    /// owes a full one. It covers the reader who deletes only part of the folder as well.
    #[test]
    fn deleting_the_folder_repairs_the_surfaces_the_next_edit_did_not_touch() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let conn = own_conn(dir.path());
        let root = dir.path().join("mirror");
        aim_at(&state, &root);

        let mut cache = DigestCache::default();
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);
        let wishlist: Vec<String> = cache
            .paths()
            .filter(|p| p.starts_with("Wishlist/"))
            .map(str::to_owned)
            .collect();
        assert!(!wishlist.is_empty(), "the plan has to reach the wishlist");

        // What the reader does, and what the README says is safe.
        std::fs::remove_dir_all(&root).unwrap();

        // The next edit is a deck edit. Only the decks are dirty; nobody has touched a wish.
        pass(&state, &conn, DECKS_ONLY, &mut cache, 0);

        for rel in &wishlist {
            assert!(
                root.join(rel).is_file(),
                "{rel} is gone, and no edit to a deck will ever bring it back"
            );
        }
        assert!(
            root.join(crate::mirror::run::MANIFEST_NAME).is_file(),
            "and the manifest, or the next pass cannot tell this happened at all"
        );
    }

    /// **Bug 3 from the live pass**, and a regression the class fix introduced: moving the root
    /// away and back left the returning folder's manifest untouched — `written 21` where 22 was
    /// expected — so the next prune read a manifest describing a plan that no longer existed
    /// and 21 files were orphaned for good.
    ///
    /// `abs.is_file()` proves a file is *present*; it cannot prove that **this root's** copy
    /// holds the content the digest describes. Here the manifest is present at the first root
    /// holding the older plan, while the digest remembered from the second root says the newer
    /// one — so the pass skipped it and the two disagreed permanently.
    ///
    /// The assertion whose absence let this through is the last one: the manifest at the root
    /// the pass is actually about has to say what that pass planned.
    #[test]
    fn coming_back_to_a_root_rewrites_the_manifest_it_left_behind() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let conn = own_conn(dir.path());
        let first = dir.path().join("first");
        let second = dir.path().join("second");

        aim_at(&state, &first);
        let mut cache = DigestCache::default();
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);
        let left_behind = std::fs::read_to_string(first.join(crate::mirror::run::MANIFEST_NAME))
            .expect("the first pass writes a manifest");

        // The plan changes while the mirror is pointed somewhere else — a deck made while the
        // stick was out. Anything that adds files.
        {
            let write = crate::sync::lock_db(&state);
            crate::deck::create_deck(
                &write,
                &crate::deck::DeckInput {
                    name: "Burn".into(),
                    format_key: "commander".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        aim_at(&state, &second);
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);
        let planned_now = std::fs::read_to_string(second.join(crate::mirror::run::MANIFEST_NAME))
            .expect("the second root gets one of its own");
        assert_ne!(
            planned_now, left_behind,
            "the two roots have to disagree or this test proves nothing"
        );

        // And back. The manifest is present at `first`, and holds the *older* plan.
        aim_at(&state, &first);
        pass(&state, &conn, Dirty::ALL, &mut cache, 0);

        assert_eq!(
            std::fs::read_to_string(first.join(crate::mirror::run::MANIFEST_NAME)).unwrap(),
            planned_now,
            "a digest taken under the second root cannot vouch for the first root's copy"
        );
    }

    /// **Bug 2 from the live pass.** Switching marketplace changed nothing on disk until
    /// `Rebuild now` was pressed, which then moved a row from 8.25 to 5.99 — every mirrored CSV
    /// had been carrying the previous marketplace's prices.
    ///
    /// `app_meta` maps to no surface and must not: a sync writes that table and the hook has to
    /// stay quiet. But this is a deliberate user action that changes what every price column
    /// says, so it marks explicitly — the shape `set_root_now` already has.
    #[test]
    fn switching_marketplace_marks_every_surface() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        assert_eq!(state.mirror.take(), None, "nothing is dirty yet");
        crate::marketplace::set_marketplace_now(&state, "cardkingdom").unwrap();
        assert_eq!(
            state.mirror.take(),
            Some(Dirty::ALL),
            "every Price column in the mirror just changed meaning"
        );
    }

    /// The other half: an id this build does not know is refused, so nothing changed on disk
    /// and nothing may be re-rendered.
    #[test]
    fn a_refused_marketplace_marks_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        crate::marketplace::set_marketplace_now(&state, "cardmarket-but-typo").unwrap_err();
        assert_eq!(state.mirror.take(), None);
    }
}
