//! Database maintenance: the one-time `auto_vacuum` conversion, and the page return after
//! every sync.
//!
//! Deliberately **not** part of `schema::migrate`. `migrate` runs before the window
//! exists, and a `VACUUM` on the measured 2.02 GB live database rewrites the whole file —
//! minutes of an unresponsive splash on the USB stick this app is meant to run from.
//! Compaction is therefore an *operation*, with a phase on the sync progress channel, and
//! it happens after the sync it follows rather than before the app the user launched.

use rusqlite::Connection;
use std::sync::Mutex;

/// `sync_meta` key: the search index is owed a rebuild, and nothing may assume otherwise.
///
/// This exists because **the conversion's completion marker is not ours to write.**
/// `auto_vacuum` flips in the file header the instant the `VACUUM` commits, which is one
/// statement *before* [`convert_to_incremental`] is finished — and the rebuild that follows
/// is itself three commits (drop, create, and a populate that walks every card). A process
/// killed anywhere in that window leaves a database that reports itself converted and
/// carries an index pointing at the wrong rows, with no error and nothing to notice it: the
/// swap that would rebuild the index only happens on a sync that actually ingests, and the
/// common answer is a 304.
///
/// So the flag is written and committed *before* the `VACUUM` and cleared only once
/// `create_fts` has returned. Whoever finds it set owes the rebuild — [`crate::schema::
/// prepare_database`] at every launch, `sync::compact_once` at every sync.
pub const K_FTS_REBUILD_PENDING: &str = "fts_rebuild_pending";

/// `sync_meta` key holding why the one-time conversion failed, if it ever did.
///
/// Its presence is also the "do not try again" flag. A `VACUUM` needs free space roughly
/// the size of the database, so the common failure is a full disk — retrying that on every
/// sync would spend a minute a day achieving nothing. Plan 6's "Compact database" button
/// is what clears the key and asks again, deliberately, with the user watching.
pub const K_AUTO_VACUUM_ERROR: &str = "auto_vacuum_error";

/// Is this database still on SQLite's default `auto_vacuum = NONE`?
///
/// `2` is incremental. A database this app created is already there (see [`crate::db::open`]);
/// one created by Plan 1 or Plan 2 is not, because the pragma was issued after
/// `journal_mode=WAL` had already materialised the file, where it is silently a no-op.
///
/// A database that cannot answer the pragma at all reads as "no conversion needed": the
/// caller's only response would be to start a `VACUUM` on a file that just failed to answer
/// a one-word question, which is not a repair.
pub fn needs_conversion(conn: &Connection) -> bool {
    conn.query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i64>(0))
        .map(|mode| mode != 2)
        .unwrap_or(false)
}

/// Is the search index owed a rebuild? See [`K_FTS_REBUILD_PENDING`].
pub fn fts_rebuild_is_pending(conn: &Connection) -> bool {
    crate::sync::get_meta(conn, K_FTS_REBUILD_PENDING).is_some()
}

/// Pay off a rebuild the conversion owed, if it owes one. `Ok(false)` means it did not.
///
/// Unconditional when the marker is set, and deliberately not guarded by
/// [`K_AUTO_VACUUM_ERROR`]: a conversion that failed *at* `create_fts` records both, and the
/// index being wrong is a worse state than the file being large. A rebuild is also the one
/// half that is cheap to retry — no `VACUUM`, no temporary file, no free space needed.
pub fn rebuild_fts_if_pending(conn: &Connection) -> rusqlite::Result<bool> {
    if !fts_rebuild_is_pending(conn) {
        return Ok(false);
    }
    crate::schema::create_fts(conn)?;
    crate::sync::set_meta_opt(conn, K_FTS_REBUILD_PENDING, None)?;
    Ok(true)
}

/// Convert an existing database to `auto_vacuum = INCREMENTAL`.
///
/// Four steps, and the order is the whole of it:
///
/// 1. [`K_FTS_REBUILD_PENDING`], committed **before** anything else, because from the next
///    statement on this database is one kill away from looking converted while its search
///    index points at the wrong rows;
/// 2. the pragma, which by itself only records an intention;
/// 3. `VACUUM`, which is what applies it — and which rewrites every page of the file;
/// 4. `create_fts`, **mandatory**: SQLite documents that `VACUUM` may renumber the ROWIDs
///    of any table without an INTEGER PRIMARY KEY, `cards.id` is TEXT, and `cards_fts` is
///    external-content with no triggers. A desynced external-content index does not error
///    — it returns the wrong card, quietly, for the life of the database.
///
/// Then the marker comes off, and a truncating checkpoint runs because the VACUUM has just
/// written the entire database through the write-ahead log. That last step is *cleanup*, not
/// a success condition: a failed checkpoint costs disk space until the next one, and
/// reporting it as a failed conversion would record [`K_AUTO_VACUUM_ERROR`] against work
/// that is already done and refuse to ever do it again.
///
/// **Not interruptible by construction** — that was the tempting reading, and it is wrong.
/// The `VACUUM` is one statement, but it is also what writes the "converted" flag, so a kill
/// after it and before the rebuild does not roll anything back: it leaves the flag set and
/// the index broken. Step 1 is what makes the window recoverable, and
/// `a_kill_between_the_vacuum_and_the_rebuild_is_repaired_at_the_next_launch` is the proof.
/// A kill *before* the VACUUM is the harmless case: `auto_vacuum` stays NONE and the next
/// sync asks again.
///
/// Measured on a copy of the live database (2.02 GB, 116 568 cards, a 998 MB freelist):
/// **22–37 s** over four runs, leaving a 1.02 GB file with 499 free pages, and an FTS index
/// that answers for all 116 568 rows with no wrong hits. This is why it is a phase on the
/// sync channel and not a step in `migrate`.
pub fn convert_to_incremental(conn: &Connection) -> rusqlite::Result<()> {
    crate::sync::set_meta(conn, K_FTS_REBUILD_PENDING, "1")?;
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    conn.execute_batch("VACUUM;")?;
    crate::schema::create_fts(conn)?;
    crate::sync::set_meta_opt(conn, K_FTS_REBUILD_PENDING, None)?;
    if let Err(e) = crate::db::checkpoint_truncate(conn) {
        // Cleanup, not the conversion. The pages are already reclaimed; all a failure here
        // costs is a write-ahead log that the next checkpoint or the exit handler folds in.
        eprintln!("the database was compacted, but its journal could not be folded in: {e}");
    }
    Ok(())
}

/// How many pages are waiting to be handed back to the filesystem.
///
/// Also the denominator of the `reclaiming` phase — the one phase of a sync that can report
/// a true fraction, because unlike a download or an ingest this number is known before the
/// work starts and only ever falls.
pub fn freelist_pages(conn: &Connection) -> i64 {
    conn.query_row("PRAGMA freelist_count", [], |r| r.get(0))
        .unwrap_or(0)
}

/// Pages handed back per chunk.
///
/// The whole reason the reclaim is chunked is the length of one lock hold, so this is the
/// number that sets it. Measured returning 974 MB of the live database in 126 chunks:
/// **67 ms** for a typical one and **1.66 s** for the worst (the first, which pays for the
/// initial truncation), against a [`crate::db::WRITE_LOCK_WAIT`] of five seconds. So a
/// collection edit landing at the worst possible moment still answers, which is the property
/// this number exists to buy. Larger chunks amortise slightly better and spend that margin;
/// smaller ones spend more of the run acquiring the mutex.
pub const RECLAIM_CHUNK_PAGES: i64 = 2_000;

/// Hand the pages a swap freed back to the filesystem, a chunk at a time.
///
/// The swap frees an entire copy of `cards` every time; without this the file only ever
/// grows (measured: 922 MB → 2.02 GB over two forced re-syncs). What makes it safe to run
/// inside a sync is that it needs no temporary file — unlike `VACUUM`, which wants room for
/// a second copy of the database.
///
/// **Chunked, and that is not an optimisation.** As a single `PRAGMA incremental_vacuum`,
/// handing back the 1.02 GB an old `cards` leaves took a measured 12.1 s with the write
/// connection held throughout — longer than [`crate::db::WRITE_LOCK_WAIT`], so a collection
/// edit during the daily sync was a button that answered "busy", and a quit in that window
/// lost the exit checkpoint's own five-second wait and left a ~1 GB journal behind.
///
/// Taking the lock per chunk, exactly as the ingest takes it per batch, fixes all three, and
/// the same measurement says by how much:
///
/// | | one hold | 126 chunks |
/// |---|---|---|
/// | wall clock | 12.1 s | **8.4 s** |
/// | peak write-ahead log | 1.03 GB | **8 MB** |
/// | longest anyone waits for the connection | 12.1 s | **1.66 s** |
///
/// The journal is the striking one, and it is the reason rather than a bonus: each chunk
/// commits, so `wal_autocheckpoint` can fire between them instead of the log growing to the
/// size of everything returned. The file therefore shrinks progressively too, rather than in
/// one step after a gigabyte of journal has been written. It is also *faster* — a WAL that
/// stays in cache beats one that spills a gigabyte to disk.
///
/// Runs no transaction of its own and needs none — the pragma is perfectly legal inside one
/// (probed: 264 free pages to 0 within an open transaction). Being *outside* one is what
/// lets each chunk commit, which is the entire point.
///
/// Stops early rather than spinning if a chunk returns nothing, which is what a database
/// still on `auto_vacuum = NONE` would do — though such a database never gets here, because
/// the mode is checked first.
///
/// `progress` is called once at entry with `(0, total)` and once per chunk that made
/// headway, ending on `(total, total)`.
pub fn reclaim_freed_pages(
    db: &Mutex<Connection>,
    progress: &mut dyn FnMut(i64, i64),
) -> rusqlite::Result<()> {
    let total = {
        let conn = crate::db::lock_blocking(db);
        // A database still on NONE has a freelist too, and `incremental_vacuum` would
        // silently do nothing with it. Reporting a phase for that would be a lie.
        if needs_conversion(&conn) {
            return Ok(());
        }
        freelist_pages(&conn)
    };
    if total == 0 {
        return Ok(());
    }
    progress(0, total);

    let mut left = total;
    while left > 0 {
        let now = {
            let conn = crate::db::lock_blocking(db);
            // Stepped to exhaustion rather than run through `execute_batch`, and that is not
            // a style choice: this pragma is a *loop* in the VDBE that emits one result row
            // per page it returns, and `execute_batch` steps a statement once and resets it.
            // The obvious spelling hands back exactly **one page** and reports success —
            // measured, 264 free pages in and 263 still free out.
            conn.pragma(None, "incremental_vacuum", RECLAIM_CHUNK_PAGES, |_| Ok(()))?;
            freelist_pages(&conn)
        };
        if now >= left {
            break;
        }
        left = now;
        progress(total - left, total);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mtgtest-maint-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A database created the way Plans 1–2 created them: WAL first, so `auto_vacuum`
    /// never took. This is what every existing install looks like, and converting it is
    /// the whole reason this module exists.
    fn legacy_database(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")
            .unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn a_legacy_database_is_converted_once_and_keeps_its_search_index() {
        let dir = scratch("convert");
        let conn = legacy_database(&dir.join("mtg.db"));
        for i in 0..500 {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,search_text,raw)
                 VALUES (?1,?2,'lea',?1,'en','normal',?2,'{}')",
                rusqlite::params![format!("c{i}"), format!("Lightning Bolt {i}")],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        conn.execute(
            "DELETE FROM cards WHERE CAST(substr(id,2) AS INTEGER) % 2 = 0",
            [],
        )
        .unwrap();

        assert!(needs_conversion(&conn), "a legacy database starts at NONE");
        convert_to_incremental(&conn).unwrap();

        assert!(!needs_conversion(&conn), "and is incremental afterwards");
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            mode.to_lowercase(),
            "wal",
            "the journal mode is not collateral"
        );

        // The mandatory half. VACUUM may renumber the rowids an external-content FTS index
        // is keyed on (SQLite documents it for any table without an INTEGER PRIMARY KEY,
        // and `cards.id` is TEXT), and a desynced index returns the *wrong card* silently.
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            hits, 250,
            "the index counts the rows that are actually there"
        );
        let joined: String = conn
            .query_row(
                "SELECT c.name FROM cards c JOIN cards_fts f ON f.rowid = c.rowid
                 WHERE cards_fts MATCH '\"lightning\"*' ORDER BY c.id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(joined.starts_with("Lightning Bolt"), "{joined}");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fill a database and then free most of it, which is the shape a staging swap leaves.
    /// Returns the connection and the freelist it produced.
    fn database_with_a_freelist(dir: &std::path::Path) -> (Connection, i64) {
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT);").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..5000 {
            tx.execute(
                "INSERT INTO t VALUES (?1)",
                [format!("{i}{}", "x".repeat(200))],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        conn.execute("DELETE FROM t", []).unwrap();
        let free = freelist_pages(&conn);
        assert!(free > 0, "the deletes should have freed pages");
        (conn, free)
    }

    /// The cheap one, after every swap: freed pages go back to the filesystem instead of
    /// sitting in a freelist that measured 998 MB on the live database.
    #[test]
    fn incremental_vacuum_returns_freed_pages() {
        let dir = scratch("incremental");
        let (conn, before) = database_with_a_freelist(&dir);
        let db = std::sync::Mutex::new(conn);

        reclaim_freed_pages(&db, &mut |_, _| {}).unwrap();

        let conn = db.into_inner().unwrap();
        let after = freelist_pages(&conn);
        assert!(before > 0, "the deletes should have freed pages");
        assert_eq!(after, 0, "and this is what hands them back");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reclaim is a *loop* of bounded chunks, not one long hold, and this is the half
    /// of that which the caller shows the user: a denominator taken once at entry and a
    /// numerator that only ever climbs, ending exactly on the total.
    #[test]
    fn the_chunked_reclaim_terminates_and_reports_a_climbing_fraction() {
        let dir = scratch("chunks");
        let (conn, before) = database_with_a_freelist(&dir);
        let db = std::sync::Mutex::new(conn);

        let mut seen: Vec<(i64, i64)> = Vec::new();
        reclaim_freed_pages(&db, &mut |done, total| seen.push((done, total))).unwrap();

        let conn = db.into_inner().unwrap();
        assert_eq!(freelist_pages(&conn), 0);
        assert!(
            seen.len() >= 2,
            "a chunked run reports more than once: {seen:?}"
        );
        assert_eq!(
            seen.first().unwrap(),
            &(0, before),
            "the fraction opens at 0"
        );
        assert_eq!(
            seen.last().unwrap(),
            &(before, before),
            "and closes on the whole freelist"
        );
        assert!(
            seen.windows(2).all(|w| w[0].0 <= w[1].0),
            "the numerator never goes backwards: {seen:?}"
        );
        assert!(
            seen.iter().all(|(_, total)| *total == before),
            "the denominator is fixed at entry: {seen:?}"
        );

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Why the reclaim is chunked at all. It used to be one `PRAGMA incremental_vacuum`
    /// holding the write connection for a measured 12.1 s — longer than `WRITE_LOCK_WAIT`,
    /// so an "Add to collection" during the daily sync was a button that answered "busy".
    /// Now it takes the lock per chunk and gives it back, so the longest anyone waits is
    /// one chunk (measured ~92 ms for 2 000 pages).
    ///
    /// The probe runs on another thread, as a command would, and asks with a bound. A take
    /// only counts once the reclaim has demonstrably started — the first progress call —
    /// and before it has finished; otherwise an unchunked reclaim would simply make the
    /// probe wait and then collect its locks from an idle mutex and pass.
    #[test]
    fn a_writer_gets_the_connection_between_reclaim_chunks() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let dir = scratch("interleave");
        // Rows a little larger than a page, so a modest row count buys a freelist of
        // several chunks without writing tens of megabytes.
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT);").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..10_000 {
            tx.execute(
                "INSERT INTO t VALUES (?1)",
                [format!("{i}{}", "x".repeat(4_000))],
            )
            .unwrap();
        }
        tx.commit().unwrap();
        conn.execute("DELETE FROM t", []).unwrap();
        let free = freelist_pages(&conn);
        assert!(
            free > 4 * RECLAIM_CHUNK_PAGES,
            "the run needs several chunks, and has {free} pages"
        );
        let db = std::sync::Mutex::new(conn);

        let taken = AtomicUsize::new(0);
        let running = AtomicBool::new(false);
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                while taken.load(Ordering::SeqCst) < 3 && !done.load(Ordering::SeqCst) {
                    let won =
                        crate::db::lock_for(&db, std::time::Duration::from_millis(200)).is_some();
                    if won && running.load(Ordering::SeqCst) && !done.load(Ordering::SeqCst) {
                        taken.fetch_add(1, Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
            });
            let result = reclaim_freed_pages(&db, &mut |done, _| {
                // `done > 0` and not merely "called": the entry report fires *before* the
                // loop has taken the connection at all, so counting from there would score
                // wins against an idle mutex and pass no matter what the loop does. Only
                // reports from a completed chunk say anything about the loop.
                if done > 0 {
                    running.store(true, Ordering::SeqCst);
                }
                // Stands in for the per-chunk cost this test's database is too small to
                // have (measured at ~92 ms against the live one) and for the IPC event the
                // real callback emits. The point is *when* it happens: between chunks, with
                // the connection released — a reclaim that held the lock across its whole
                // loop would hold it across this too, and the probe would score zero.
                std::thread::sleep(std::time::Duration::from_millis(20));
            });
            // Set before any assertion: a panic here must still release the probe.
            done.store(true, Ordering::SeqCst);
            result.unwrap();
        });

        assert!(
            taken.load(Ordering::SeqCst) >= 3,
            "a writer must get the connection between chunks, and got it {} times",
            taken.load(Ordering::SeqCst)
        );

        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Two facts about the app's *second* connection, and the second one is a trap.
    ///
    /// The conversion must survive the read-only handle `init_state` opens alongside the
    /// writer — a `VACUUM` that lost to the app's own reader would be a conversion that can
    /// never happen. It does survive.
    ///
    /// But `PRAGMA auto_vacuum` is answered out of a per-connection cache of the file
    /// header, refreshed only when a read transaction notices the file changed. So the
    /// reader goes on reporting `NONE` after a conversion the writer has already finished,
    /// and corrects itself only at its next real query. That is why `sync::compact_once`
    /// asks the **write** connection whether a conversion is due: asking the reader would
    /// order the same 22–37 s `VACUUM` again on the next Refresh of the session.
    #[test]
    fn a_read_only_handle_reports_a_stale_auto_vacuum_after_a_conversion() {
        let dir = scratch("reader");
        let path = dir.join("mtg.db");
        let conn = legacy_database(&path);
        for i in 0..500 {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,search_text,raw)
                 VALUES (?1,?2,'lea',?1,'en','normal',?2,'{}')",
                rusqlite::params![format!("c{i}"), format!("Lightning Bolt {i}")],
            )
            .unwrap();
        }
        // The app's second handle, exactly as `init_state` builds it, and warmed with a
        // query so it is a real open reader rather than an unused file descriptor.
        let reader = crate::db::open_read_only(&path).unwrap();
        let n: i64 = reader
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 500);

        convert_to_incremental(&conn).expect("a VACUUM must not lose to the app's own reader");

        assert!(
            !needs_conversion(&conn),
            "the connection that ran the VACUUM knows it ran"
        );
        assert!(
            needs_conversion(&reader),
            "if this ever stops being stale, `compact_once` may read `db_read` again"
        );
        // What clears it: any real query, because that is what re-reads the header.
        let after: i64 = reader
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 500, "and the reader still sees every row");
        assert!(!needs_conversion(&reader));

        drop(reader);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fill a legacy database with 500 cards and delete half, leaving an index that a
    /// `VACUUM` will desync unless something rebuilds it.
    fn legacy_database_with_cards(path: &std::path::Path) -> Connection {
        let conn = legacy_database(path);
        for i in 0..500 {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,search_text,raw)
                 VALUES (?1,?2,'lea',?1,'en','normal',?2,'{}')",
                rusqlite::params![format!("c{i}"), format!("Lightning Bolt {i}")],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        conn.execute(
            "DELETE FROM cards WHERE CAST(substr(id,2) AS INTEGER) % 2 = 0",
            [],
        )
        .unwrap();
        conn
    }

    fn lightning_hits(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// **The conversion's "done" marker is written by the `VACUUM`, not by the rebuild that
    /// has to follow it.** `auto_vacuum` flips in the file header the moment the `VACUUM`
    /// commits, so a process killed in the window between that and `create_fts` returning
    /// leaves a database that reports itself fully converted and carries a silently
    /// desynced search index — one that answers with *other cards*, forever, because the
    /// 304 that most syncs get never rebuilds anything.
    ///
    /// `fts_rebuild_pending` is what closes the window: written and committed *before* the
    /// `VACUUM`, cleared only once `create_fts` has returned. Anything that finds it set
    /// owes the index a rebuild — `prepare_database` at every launch, and `compact_once` at
    /// every sync.
    #[test]
    fn a_kill_between_the_vacuum_and_the_rebuild_is_repaired_at_the_next_launch() {
        let dir = scratch("killed");
        let path = dir.join("mtg.db");
        let conn = legacy_database_with_cards(&path);

        // The conversion, killed mid-flight: everything `convert_to_incremental` does up to
        // and including the VACUUM, and then the process dies.
        crate::sync::set_meta(&conn, K_FTS_REBUILD_PENDING, "1").unwrap();
        conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")
            .unwrap();
        conn.execute_batch("VACUUM;").unwrap();
        drop(conn);

        // The next launch. The header says the work is finished...
        let conn = crate::db::open(&path).unwrap();
        assert!(
            !needs_conversion(&conn),
            "the VACUUM already flipped the header — this is the trap"
        );
        // ...and the index is lying: 500 hits over 250 surviving rows.
        assert_eq!(lightning_hits(&conn), 500, "the index is desynced");
        assert!(fts_rebuild_is_pending(&conn), "but the marker says so");

        crate::schema::prepare_database(&conn).unwrap();

        assert_eq!(
            lightning_hits(&conn),
            250,
            "a launch must repair the index the conversion owed"
        );
        assert!(
            !fts_rebuild_is_pending(&conn),
            "and the marker is cleared once it is paid"
        );

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A conversion that ran to completion owes nothing, so a launch after one must not
    /// spend a rebuild on 116 k rows for the sake of it.
    #[test]
    fn a_completed_conversion_leaves_no_rebuild_owing() {
        let dir = scratch("nopending");
        let path = dir.join("mtg.db");
        let conn = legacy_database_with_cards(&path);

        convert_to_incremental(&conn).unwrap();

        assert!(!fts_rebuild_is_pending(&conn));
        assert_eq!(lightning_hits(&conn), 250);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The production path, which no other test walks: an *existing* file created before
    /// this plan, opened through `db::open` exactly as `init_state` opens it. The pragma in
    /// `open` cannot help such a file — that is the whole premise of the module — so this is
    /// the case `needs_conversion` has to fire on.
    #[test]
    fn an_existing_database_opened_normally_is_recognised_as_needing_conversion() {
        let dir = scratch("legacyfile");
        let path = dir.join("mtg.db");
        drop(legacy_database(&path));

        let conn = crate::db::open(&path).unwrap();

        assert!(
            needs_conversion(&conn),
            "`db::open` cannot convert a file that already exists"
        );
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A database this app creates is incremental from its first byte — which is only true
    /// because `db::open` sets the pragma *before* `journal_mode=WAL` writes the header.
    /// Measured live: with WAL first, a new file reads back `auto_vacuum = 0` and stays
    /// there through every reopen.
    #[test]
    fn a_database_this_app_creates_never_needs_converting() {
        let dir = scratch("fresh");
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        crate::schema::migrate(&conn).unwrap();

        assert!(!needs_conversion(&conn));

        drop(conn);
        let reopened = crate::db::open(&dir.join("mtg.db")).unwrap();
        assert!(!needs_conversion(&reopened), "and it stays that way");
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
