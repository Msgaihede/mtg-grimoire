//! Database maintenance: the one-time `auto_vacuum` conversion, and the page return after
//! every sync.
//!
//! Deliberately **not** part of `schema::migrate`. `migrate` runs before the window
//! exists, and a `VACUUM` on the measured 2.02 GB live database rewrites the whole file —
//! minutes of an unresponsive splash on the USB stick this app is meant to run from.
//! Compaction is therefore an *operation*, with a phase on the sync progress channel, and
//! it happens after the sync it follows rather than before the app the user launched.

use rusqlite::Connection;

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

/// Convert an existing database to `auto_vacuum = INCREMENTAL`.
///
/// Three statements, and the order is the whole of it:
///
/// 1. the pragma, which by itself only records an intention;
/// 2. `VACUUM`, which is what applies it — and which rewrites every page of the file;
/// 3. `create_fts`, **mandatory**: SQLite documents that `VACUUM` may renumber the ROWIDs
///    of any table without an INTEGER PRIMARY KEY, `cards.id` is TEXT, and `cards_fts` is
///    external-content with no triggers. A desynced external-content index does not error
///    — it returns the wrong card, quietly, for the life of the database.
///
/// Then a truncating checkpoint, because the VACUUM has just written the entire database
/// through the write-ahead log and leaving that on disk would undo most of what it bought.
///
/// Interruptible by construction rather than by bookkeeping: the `VACUUM` is a single
/// statement, so a process killed partway leaves `auto_vacuum` on NONE and the next sync
/// simply asks again.
///
/// Measured on a copy of the live database (2.02 GB, 116 568 cards, a 998 MB freelist):
/// **22–37 s** over four runs, leaving a 1.02 GB file with 499 free pages, and an FTS index
/// that answers for all 116 568 rows with no wrong hits. This is why it is a phase on the
/// sync channel and not a step in `migrate`.
pub fn convert_to_incremental(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    conn.execute_batch("VACUUM;")?;
    crate::schema::create_fts(conn)?;
    crate::db::checkpoint_truncate(conn)
}

/// Hand pages freed since the last call back to the filesystem.
///
/// The swap frees an entire copy of `cards` every time; without this the file only ever
/// grows (measured: 922 MB → 2.02 GB over two forced re-syncs). What makes it safe to run
/// inside a sync is that it needs no temporary file — unlike `VACUUM`, which wants room for
/// a second copy of the database.
///
/// **Not** the milliseconds it is easy to assume, at this database's scale. Measured on a
/// converted copy of the live database, returning the 1.02 GB that dropping `cards` and
/// `cards_fts` frees: **12.1 s**, writing 1.03 GB through the write-ahead log on the way
/// (the WAL is folded back by the exit checkpoint, as the ingest's own 857 MB already is).
/// It is page movement, so the cost scales with the megabytes handed back and with nothing
/// else. The caller in `sync::do_sync` holds the write connection for that whole time.
///
/// Must not be called inside a transaction: SQLite refuses `PRAGMA incremental_vacuum`
/// there. Every caller runs it on its own, between transactions.
///
/// Stepped to exhaustion rather than run through `execute_batch`, and that is not a style
/// choice. This pragma is a *loop* in the VDBE that emits one result row per page it
/// returns; `execute_batch` steps a statement once and resets it, so the obvious spelling
/// hands back exactly **one page** and reports success. Measured on the test's own
/// database: 264 free pages in, 263 still free out.
pub fn incremental_vacuum(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_query(None, "incremental_vacuum", |_| Ok(()))
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

    /// The cheap one, after every swap: freed pages go back to the filesystem instead of
    /// sitting in a freelist that measured 998 MB on the live database.
    #[test]
    fn incremental_vacuum_returns_freed_pages() {
        let dir = scratch("incremental");
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
        let before: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();

        incremental_vacuum(&conn).unwrap();

        let after: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert!(before > 0, "the deletes should have freed pages");
        assert_eq!(after, 0, "and this is what hands them back");

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
