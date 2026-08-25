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

use crate::mirror::run::{Dirty, PassReport};
use crate::mirror::settings;
use crate::sync::AppState;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
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
/// `deck_allocations` is the one exclusion worth naming, because it *looks* like it belongs:
/// it records which collection copies a deck holds. The mirror reads the collection with
/// [`crate::collection::Allocation::All`] and writes no owned/missing column on any surface,
/// so an allocation moving changes no byte on disk. The write that put the card in the deck
/// touched `deck_cards` in the same breath, and that is what marks.
///
/// **Written as a match on a fixed list rather than a prefix test**, so that a table added
/// later is `None` until somebody decides otherwise — the safe direction for a table like
/// `deck_audit`, which starts with `deck_` and must never trigger anything.
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
pub fn install_hook(conn: &Connection, mask: Arc<Mask>) {
    // The `Result` is `Err` only for a connection this crate never makes — one already lent
    // out, or borrowed from a shared handle — so there is nothing to recover, and refusing to
    // start the app over a mirror that will not notice edits would be the wrong trade. A
    // failure here degrades to "the startup pass is the only pass", which is still a mirror.
    if let Err(e) = conn.update_hook(Some(
        move |_action: rusqlite::hooks::Action, _db: &str, table: &str, _rowid: i64| {
            if let Some(d) = surface_of(table) {
                mask.mark(d);
            }
        },
    )) {
        eprintln!("the backup mirror will not see live edits: {e}");
    }
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

/// The loop.
fn watch(state: &AppState) {
    let mut cache: HashMap<String, u64> = HashMap::new();
    // The root the digests in `cache` describe. A changed root invalidates every one of them:
    // the map is keyed by a plan-relative path, so a digest remembered for
    // `Decks/Burn/deck.txt` under the old folder would let `put` skip writing the same file
    // under the new one, and the reader would watch a freshly chosen folder fill up with gaps.
    // See the `Err` arm of [`pass`] for the same trap in its other form.
    let mut cached_root: Option<PathBuf> = None;

    let mut on = enabled(state);
    // The startup pass, before the loop and before anything can have been edited: it is the
    // whole of what makes a mirror correct after a crash, a kill, or a write that landed while
    // the last session was closing. `Dirty::ALL`, because the mask cannot describe what
    // happened while the process was not running.
    if on {
        pass(state, Dirty::ALL, &mut cache, &mut cached_root);
    }

    let mut settings_checked = Instant::now();
    let mut seen_marks = state.mirror.marks();
    let mut quiet_since = Instant::now();

    loop {
        std::thread::sleep(TICK);

        // The settings, at most once per debounce rather than once per tick: this takes
        // `db_read`'s mutex, and a search may be holding it. Four reads a second of one
        // `app_meta` row, forever, is the sort of cost that is invisible until it is not.
        if settings_checked.elapsed() >= DEBOUNCE {
            settings_checked = Instant::now();
            let now_on = enabled(state);
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
        let Some(dirty) = state.mirror.take() else {
            continue;
        };
        pass(state, dirty, &mut cache, &mut cached_root);
    }
}

/// Is the mirror switched on? Infallible, like [`settings::enabled`] itself.
fn enabled(state: &AppState) -> bool {
    settings::enabled(&crate::sync::lock_db_read(state))
}

/// Run one pass and record what it did.
///
/// **`db_read` only.** A pass reads the whole collection, every deck and the whole wishlist;
/// on the write connection that would be seconds of a lock a button press is waiting for, and
/// the reader would meet it as [`crate::db::BUSY`]. The one write this whole module makes is
/// the single `error_log` row below, and that does not wait for the connection either.
fn pass(
    state: &AppState,
    dirty: Dirty,
    cache: &mut HashMap<String, u64>,
    cached_root: &mut Option<PathBuf>,
) {
    let outcome = {
        let conn = crate::sync::lock_db_read(state);
        let root = settings::root(&conn, &state.data_dir);
        if cached_root.as_deref() != Some(root.as_path()) {
            cache.clear();
            *cached_root = Some(root.clone());
        }
        crate::mirror::run::run_pass(&conn, &root, dirty, cache)
    };
    record(state, &outcome);
    if let Err(e) = &outcome {
        // **Everything the failed pass believed about the disk goes with it.** `run_pass`
        // fails when the root cannot be created — an unplugged stick, a share that went away,
        // a permission taken back — and a root that comes back may come back *empty*. The
        // digest map is in memory and would still say every file matches, so a warm cache
        // would make the recovery pass write nothing at all. Spec §7's "a root that comes back
        // gets a full rebuild" is these three lines.
        cache.clear();
        *cached_root = None;
        state.mirror.mark_all();
        note_failure(state, e);
    }
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
    use crate::schema;
    use std::path::Path;

    fn migrated_memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn
    }

    /// An [`AppState`] over a real file database inside a `tempfile` root.
    ///
    /// A file and not `:memory:` because the two connections have to be the *same* database —
    /// two in-memory handles are two empty ones — and `tempfile` rather than
    /// `std::env::temp_dir()` because a pass writes files and nothing in this suite may put
    /// one where a later run would find it.
    fn state_at(dir: &Path) -> AppState {
        let path = dir.join("mtg.db");
        let conn = crate::db::open(&path).unwrap();
        schema::migrate(&conn).unwrap();
        let read = crate::db::open_read_only(&path).unwrap();
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
        }
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
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
            .unwrap();
        let tables: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let mut mapped: Vec<&str> = tables
            .iter()
            .filter(|t| surface_of(t).is_some())
            .map(String::as_str)
            .collect();
        mapped.sort_unstable();
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
            ],
            "of the {} tables the schema creates, exactly these nine reach the mirror",
            tables.len()
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
        install_hook(&conn, mask.clone());
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
        install_hook(&conn, mask.clone());
        crate::update::set_app_meta(&conn, "anything", "at all").unwrap();
        assert_eq!(mask.take(), None);
    }

    /// A card row, which is what a sync writes 116 700 of. It must not so much as flip a bit.
    #[test]
    fn writing_a_card_row_does_not_mark_anything() {
        let conn = migrated_memory_db();
        let mask = Arc::new(Mask::default());
        install_hook(&conn, mask.clone());
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
        install_hook(&conn, mask.clone());
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
        install_hook(&conn, mask.clone());
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
        install_hook(&conn, mask.clone());
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

    /// The recovery contract of spec §7, and the trap it exists for: `run::put` short-circuits
    /// on the in-memory digest *before* it looks at the disk, so a root that goes away and
    /// comes back empty would be answered "unchanged" by a warm cache and never rewritten.
    #[test]
    fn a_failed_pass_forgets_every_digest_and_marks_everything() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        // A file where a folder should be, so `create_dir_all` on a child of it cannot work.
        let blocker = dir.path().join("blocked");
        std::fs::write(&blocker, b"not a folder").unwrap();
        {
            // Written past `set_root`, which refuses a parent that is not a directory: the
            // subject here is `run_pass` failing, not the setting's own validation.
            let conn = crate::sync::lock_db(&state);
            crate::update::set_app_meta(
                &conn,
                settings::K_ROOT,
                blocker.join("mirror").to_str().unwrap(),
            )
            .unwrap();
        }
        let mut cache: HashMap<String, u64> = HashMap::new();
        cache.insert("Decks/Burn/deck.txt".into(), 12_345);
        let mut cached_root = Some(blocker.join("mirror"));

        pass(&state, Dirty::ALL, &mut cache, &mut cached_root);

        assert!(cache.is_empty(), "a failed pass must forget every digest");
        assert_eq!(cached_root, None);
        assert_eq!(
            state.mirror.take(),
            Some(Dirty::ALL),
            "a root that comes back gets a full rebuild, not a partial one"
        );
        assert!(crate::sync::lock_plain(&state.mirror_status)
            .last_error
            .is_some());
    }

    /// Changing the root has to invalidate the digests too, for `put`'s reason above: the map
    /// is keyed by a plan-relative path, which is the same key under both folders.
    #[test]
    fn moving_the_root_forgets_the_digests_taken_under_the_old_one() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let new_root = dir.path().join("new");
        {
            let conn = crate::sync::lock_db(&state);
            settings::set_root(&conn, &new_root).unwrap();
        }
        let mut cache: HashMap<String, u64> = HashMap::new();
        cache.insert("Collection/collection.txt".into(), 999);
        let mut cached_root = Some(dir.path().join("old"));

        pass(&state, Dirty::ALL, &mut cache, &mut cached_root);

        assert_eq!(cached_root, Some(new_root.clone()));
        assert!(
            !cache.contains_key("Collection/collection.txt"),
            "a digest taken under the old root cannot vouch for a file under the new one"
        );
        assert!(
            new_root.is_dir(),
            "the pass creates the folder it was given"
        );
        assert!(crate::sync::lock_plain(&state.mirror_status)
            .last_error
            .is_none());
    }

    /// A second pass over the same root keeps the digests, which is what makes the steady
    /// state render-and-hash rather than 350 writes every two seconds. The counterpart to the
    /// two tests above: they clear the cache, and this one proves clearing is not the default.
    ///
    /// **The files are deleted between the two passes, and that is the whole experiment.**
    /// `run::put` has two ways to answer "unchanged" — the remembered digest, and a read of
    /// the file — so a test that simply ran twice would pass with the cache emptied every time
    /// and prove nothing. It was written that way first, and a mutation that cleared the cache
    /// on every pass survived it. With the files gone, only the cache can still say
    /// "unchanged"; a cleared one has to write all of them again.
    ///
    /// It is also the hazard the failure path exists for, seen from the other side: a cache
    /// that outlives the files it describes is a mirror that never rewrites them.
    #[test]
    fn a_second_pass_at_the_same_root_keeps_its_digests() {
        let dir = tempfile::tempdir().unwrap();
        let state = state_at(dir.path());
        let root = dir.path().join("mirror");
        {
            let conn = crate::sync::lock_db(&state);
            settings::set_root(&conn, &root).unwrap();
        }
        let mut cache: HashMap<String, u64> = HashMap::new();
        let mut cached_root = None;
        pass(&state, Dirty::ALL, &mut cache, &mut cached_root);
        let first = cache.len();
        assert!(first > 0, "an empty collection still writes its own files");
        assert_eq!(
            crate::sync::lock_plain(&state.mirror_status)
                .last_report
                .as_ref()
                .unwrap()
                .written,
            first,
            "the first pass writes every file it planned"
        );

        for rel in cache.keys() {
            std::fs::remove_file(root.join(rel)).unwrap();
        }
        pass(&state, Dirty::ALL, &mut cache, &mut cached_root);

        assert_eq!(cache.len(), first, "the digests survive a pass");
        let last = crate::sync::lock_plain(&state.mirror_status);
        assert_eq!(
            last.last_report.as_ref().unwrap().written,
            0,
            "a remembered digest is answered without opening the file at all"
        );
        assert_eq!(last.last_report.as_ref().unwrap().unchanged, first);
    }
}
