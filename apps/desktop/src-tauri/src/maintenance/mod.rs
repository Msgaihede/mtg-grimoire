//! **The desktop's half of `maintenance`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. Nothing of the module's code is left
//! here: what is below are the tests of it that name something this crate still holds.
//!
//! The tests are the ones over a database `split` converted from a single file, which only the
//! desktop has ever had.

pub use grimoire_core::maintenance::*;

/// The tests of `maintenance` that name something this crate still holds. Each goes home when what it
/// names does.
#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::CORPUS;
    use grimoire_core::maintenance::fixtures::*;
    use rusqlite::Connection;

    /// A database created the way Plans 1–2 created them: WAL first, so `auto_vacuum`
    /// never took. This is what every existing install looks like, and converting it is
    /// the whole reason this module exists.
    fn legacy_database(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")
            .unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();
        conn
    }

    /// The same legacy file, taken through the split, opened as the app opens it.
    ///
    /// **The corpus keeps the `auto_vacuum = NONE` the single file had**, because
    /// `split::finish` renames that very file into place — which is what makes this the
    /// shape every existing install arrives in, and what the whole module is about. The user
    /// file is built fresh and is therefore already incremental, which is the asymmetry
    /// `the_reclaim_reads_the_corpus_and_not_the_user_file` turns into an assertion.
    fn legacy_pair(dir: &std::path::Path) -> Connection {
        crate::split::convert(dir).unwrap();
        crate::db::open_write(dir).unwrap()
    }

    #[test]
    fn a_legacy_database_is_converted_once_and_keeps_its_search_index() {
        let dir = scratch("convert");
        drop(legacy_database(&dir.join("mtg.db")));
        let conn = legacy_pair(&dir);
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

        assert!(
            needs_conversion(&conn, CORPUS),
            "a legacy corpus starts at NONE"
        );
        convert_to_incremental(&conn).unwrap();

        assert!(
            !needs_conversion(&conn, CORPUS),
            "and is incremental afterwards"
        );
        let mode: String = conn
            .query_row(&format!("PRAGMA {CORPUS}.journal_mode"), [], |r| r.get(0))
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
        drop(legacy_database(&dir.join("mtg.db")));
        let conn = legacy_pair(&dir);
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
        let reader = crate::db::open_read(&dir).unwrap();
        let n: i64 = reader
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 500);

        convert_to_incremental(&conn).expect("a VACUUM must not lose to the app's own reader");

        assert!(
            !needs_conversion(&conn, CORPUS),
            "the connection that ran the VACUUM knows it ran"
        );
        assert!(
            needs_conversion(&reader, CORPUS),
            "if this ever stops being stale, `compact_once` may read `db_read` again"
        );
        // What clears it: any real query, because that is what re-reads the header.
        let after: i64 = reader
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(after, 500, "and the reader still sees every row");
        assert!(!needs_conversion(&reader, CORPUS));

        drop(reader);
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Fill a legacy database with 500 cards and an index that answers correctly for them.
    fn legacy_database_with_cards(dir: &std::path::Path) -> Connection {
        drop(legacy_database(&dir.join("mtg.db")));
        let conn = legacy_pair(dir);
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
        conn
    }

    /// Delete half the cards, leaving 250 rows behind an index that still lists 500 — the
    /// state a `VACUUM` turns from stale into actively wrong by renumbering the rowids.
    fn delete_half_the_cards(conn: &Connection) {
        conn.execute(
            "DELETE FROM cards WHERE CAST(substr(id,2) AS INTEGER) % 2 = 0",
            [],
        )
        .unwrap();
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
        let conn = legacy_database_with_cards(&dir);
        delete_half_the_cards(&conn);

        // The conversion, killed mid-flight: everything `convert_to_incremental` does up to
        // and including the VACUUM, and then the process dies.
        crate::sync::set_meta(&conn, K_FTS_REBUILD_PENDING, "1").unwrap();
        conn.pragma_update(Some(CORPUS), "auto_vacuum", "INCREMENTAL")
            .unwrap();
        conn.execute_batch(&format!("VACUUM {CORPUS};")).unwrap();
        drop(conn);

        // The next launch. The header says the work is finished...
        let conn = crate::db::open_write(&dir).unwrap();
        assert!(
            !needs_conversion(&conn, CORPUS),
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
        let conn = legacy_database_with_cards(&dir);
        delete_half_the_cards(&conn);

        convert_to_incremental(&conn).unwrap();

        assert!(!fts_rebuild_is_pending(&conn));
        assert_eq!(lightning_hits(&conn), 250);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The other end of the marker, and a false positive is not free: a `VACUUM` that fails
    /// **rolls back**, so the rowids are the ones the index already has and nothing was
    /// desynced. Leaving the marker set there would order a silent rebuild of 116 k rows at
    /// the next launch to repair damage that was never done — and, when the reason the
    /// `VACUUM` failed was a full disk, that rebuild would fail too.
    ///
    /// The failure is forced with an open transaction, which SQLite refuses to `VACUUM`
    /// from. The transaction is committed rather than dropped so that what the function
    /// wrote and unwrote is actually observable.
    #[test]
    fn a_failed_conversion_leaves_no_rebuild_owing_because_it_broke_nothing() {
        let dir = scratch("failedvacuum");
        let conn = legacy_database_with_cards(&dir);
        assert_eq!(lightning_hits(&conn), 500, "the index starts correct");

        let tx = conn.unchecked_transaction().unwrap();
        let err = convert_to_incremental(&conn).expect_err("a VACUUM inside a transaction");
        tx.commit().unwrap();

        assert!(
            err.to_string().to_lowercase().contains("transaction"),
            "the failure must be the VACUUM, not something else: {err}"
        );
        assert!(
            needs_conversion(&conn, CORPUS),
            "a failed conversion converted nothing"
        );
        assert!(
            !fts_rebuild_is_pending(&conn),
            "and owes no rebuild, because a rolled-back VACUUM desynced nothing"
        );
        assert_eq!(lightning_hits(&conn), 500, "the index is untouched");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The reclaim is about the gigabyte an old `cards` leaves behind, and after the split
    /// that gigabyte is in the attached file. Every one of these pragmas means `main` when it
    /// is not told otherwise — measured after the split: `page_count` unqualified 323 against
    /// `corpus.page_count` 192 149 — so an unqualified reclaim is a reclaim of nothing that
    /// reports success.
    #[test]
    fn the_reclaim_reads_the_corpus_and_not_the_user_file() {
        let dir = scratch("reclaim-side");
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE {CORPUS}.ballast (v TEXT);
             INSERT INTO ballast (v)
               WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 20000)
               SELECT hex(randomblob(200)) FROM n;
             DROP TABLE {CORPUS}.ballast;"
        ))
        .unwrap();

        let user_free = freelist_pages(&conn, "main");
        let corpus_free = freelist_pages(&conn, CORPUS);

        let db = std::sync::Mutex::new(conn);
        reclaim_freed_pages(&db, &mut |_, _| {}).unwrap();
        let after = freelist_pages(&crate::db::lock_blocking(&db), CORPUS);
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);

        assert_eq!(user_free, 0, "the user file has nothing to reclaim");
        assert!(
            corpus_free > 100,
            "the drop should have freed corpus pages, got {corpus_free}"
        );
        assert_eq!(
            after, 0,
            "the reclaim must have emptied the CORPUS freelist"
        );
    }

    /// The production path, which no other test walks: an *existing* file created before
    /// this plan, opened through `db::open` exactly as `init_state` opens it. The pragma in
    /// `open` cannot help such a file — that is the whole premise of the module — so this is
    /// the case `needs_conversion` has to fire on.
    #[test]
    fn an_existing_database_opened_normally_is_recognised_as_needing_conversion() {
        let dir = scratch("legacyfile");
        drop(legacy_database(&dir.join("mtg.db")));

        let conn = legacy_pair(&dir);

        assert!(
            needs_conversion(&conn, CORPUS),
            "the split renames the old file into place, pragmas and all"
        );
        let mode: String = conn
            .query_row(&format!("PRAGMA {CORPUS}.journal_mode"), [], |r| r.get(0))
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
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();

        assert!(!needs_conversion(&conn, "main"));
        assert!(!needs_conversion(&conn, CORPUS));

        drop(conn);
        let reopened = crate::db::open_write(&dir).unwrap();
        assert!(
            !needs_conversion(&reopened, CORPUS),
            "and it stays that way"
        );
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// **A launch trims the activity log**, which is the whole of what bounds it: the table is
    /// append-only and grows with every press the reader makes.
    ///
    /// Driven through `schema::prepare_database` rather than through
    /// [`prune_activity_log`] directly, for the reason
    /// `a_kill_between_the_vacuum_and_the_rebuild_is_repaired_at_the_next_launch` is written the
    /// same way: what is being asserted is that the *launch* does it, and a test that called the
    /// helper would go on passing the day the call in `prepare_database` was tidied out.
    #[test]
    fn a_launch_trims_the_activity_log_to_its_ceiling() {
        let dir = scratch("prune-activity");
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();

        let over = crate::activity::KEEP as i64 + 120;
        let tx = conn.unchecked_transaction().unwrap();
        for at in 1..=over {
            tx.execute(
                "INSERT INTO activity (at, scope, kind, card_id, card_name, payload, delta)
                 VALUES (?1, 'collection', 'add', 'bolt-lea', 'Lightning Bolt', '{}', 1)",
                rusqlite::params![at],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        crate::schema::prepare_database(&conn).unwrap();

        let left: i64 = conn
            .query_row("SELECT count(*) FROM activity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, crate::activity::KEEP as i64);
        let oldest: i64 = conn
            .query_row("SELECT min(at) FROM activity", [], |r| r.get(0))
            .unwrap();
        assert_eq!(oldest, 121, "and it is the newest that survived");

        // A second launch on a log under the ceiling loses nothing — the trim is idempotent,
        // which is what makes it safe to run on every start.
        crate::schema::prepare_database(&conn).unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM activity", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            crate::activity::KEEP as i64
        );

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
