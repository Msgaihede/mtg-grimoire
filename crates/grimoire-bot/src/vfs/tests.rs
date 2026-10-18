//! The page store, run for real: SQLite natively, over this VFS, over a [`MemoryStore`].

use super::*;
use rusqlite::Connection;

/// A key, by its first byte.
fn kek(b: u8) -> [u8; 32] {
    [b; 32]
}

/// A fresh mount over `store`. Each test names its own mount, so the suite's threads never share
/// one; the registry they do share is behind its lock.
fn mounted(name: &str, store: &Arc<MemoryStore>, key: u8) {
    mount(name, store.clone(), PageCipher::new(&kek(key), name)).unwrap();
}

fn open(name: &str) -> Connection {
    let conn = Connection::open(format!("{name}/user.db")).unwrap();
    conn
}

const MARKER: &str = "Sol Ring, the plaintext a store must never hold";

fn fill(conn: &Connection, rows: i64) {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, note TEXT, pad BLOB)",
    )
    .unwrap();
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..rows {
        tx.execute(
            "INSERT INTO t (note, pad) VALUES (?1, zeroblob(300))",
            [format!("{MARKER} #{i}")],
        )
        .unwrap();
    }
    tx.commit().unwrap();
}

fn count(conn: &Connection) -> i64 {
    conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0))
        .unwrap()
}

/// **A database named with `\` is the same database** — what `Path::join` writes on Windows,
/// where the engine's pair once fell through to memory and the store stayed empty (CI's
/// `windows-latest`, 2026-10-18). Opened by one spelling, it is found by the other.
#[test]
fn a_backslash_name_is_the_same_file() {
    let store = Arc::new(MemoryStore::new());
    mounted("bs", &store, 9);
    {
        let conn = Connection::open("bs\\user.db").unwrap();
        fill(&conn, 10);
    }
    assert_eq!(
        store.files(),
        ["user.db"],
        "kept in the store, not in memory"
    );
    unmount("bs");
    mounted("bs", &store, 9);
    assert_eq!(count(&open("bs")), 10);
}

#[test]
fn a_database_survives_its_isolate() {
    let store = Arc::new(MemoryStore::new());
    mounted("rt", &store, 1);
    {
        let conn = open("rt");
        let journal: String = conn
            .query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            journal, "delete",
            "no shared memory, so no WAL — as in a browser's pool"
        );
        fill(&conn, 500);
        assert_eq!(count(&conn), 500);
    }
    // A new isolate: nothing of the old one's memory, the same store.
    unmount("rt");
    mounted("rt", &store, 1);
    let conn = open("rt");
    assert_eq!(count(&conn), 500);
    let note: String = conn
        .query_row("SELECT note FROM t WHERE id = 250", [], |r| r.get(0))
        .unwrap();
    assert_eq!(note, format!("{MARKER} #249"));
    assert_eq!(
        store.files(),
        vec!["user.db".to_owned()],
        "the journal is memory"
    );
}

#[test]
fn no_stored_byte_is_plaintext() {
    let store = Arc::new(MemoryStore::new());
    mounted("plain", &store, 2);
    fill(&open("plain"), 200);
    let pages = store.sealed_pages("user.db");
    assert!(pages.len() > 10);
    for (_, page) in &pages {
        assert_eq!(page.len(), BLOCK + NONCE + TAG, "a nonce, a page and a tag");
        assert!(
            !page.windows(MARKER.len()).any(|w| w == MARKER.as_bytes()),
            "a stored page held plaintext"
        );
        assert!(!page.starts_with(b"SQLite format 3"));
    }
}

#[test]
fn the_wrong_key_opens_nothing() {
    let store = Arc::new(MemoryStore::new());
    mounted("kek", &store, 3);
    fill(&open("kek"), 50);
    unmount("kek");
    mounted("kek", &store, 4);
    let refused = Connection::open("kek/user.db")
        .and_then(|c| c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)));
    assert!(refused.is_err(), "a page opened under another key");
    // And the right key still opens it: a refusal changed nothing stored.
    unmount("kek");
    mounted("kek", &store, 3);
    assert_eq!(count(&open("kek")), 50);
}

#[test]
fn another_objects_key_opens_nothing_either() {
    let store = Arc::new(MemoryStore::new());
    mount("obj-a", store.clone(), PageCipher::new(&kek(5), "object-a")).unwrap();
    fill(&open("obj-a"), 20);
    unmount("obj-a");
    // The same secret, salted with another Durable Object's id.
    mount("obj-a", store.clone(), PageCipher::new(&kek(5), "object-b")).unwrap();
    assert!(Connection::open("obj-a/user.db")
        .and_then(|c| c.query_row("SELECT count(*) FROM t", [], |r| r.get::<_, i64>(0)))
        .is_err());
}

#[test]
fn a_page_moved_to_another_place_does_not_open() {
    let store = Arc::new(MemoryStore::new());
    mounted("moved", &store, 6);
    fill(&open("moved"), 200);
    unmount("moved");
    let pages = store.sealed_pages("user.db");
    // Page 1 sealed as page 2: the bytes are genuine, the place is not.
    store.tamper("user.db", 2, pages[1].1.clone());
    mounted("moved", &store, 6);
    let read = Connection::open("moved/user.db").and_then(|c| {
        c.query_row("SELECT count(*), sum(length(note)) FROM t", [], |r| {
            r.get::<_, i64>(0)
        })
    });
    assert!(read.is_err(), "a page read from the wrong place");
}

#[test]
fn a_rewrite_reseals_and_keeps_only_the_latest() {
    let store = Arc::new(MemoryStore::new());
    mounted("rewrite", &store, 7);
    let conn = open("rewrite");
    fill(&conn, 100);
    let before = store.sealed_pages("user.db");
    conn.execute("UPDATE t SET note = 'rewritten' WHERE id = 1", [])
        .unwrap();
    let after = store.sealed_pages("user.db");
    assert_eq!(before.len(), after.len(), "a rewrite adds no page");
    let changed = before
        .iter()
        .zip(&after)
        .filter(|((_, a), (_, b))| a != b)
        .count();
    assert!(changed >= 1, "the page that changed was sealed again");
    drop(conn);
    unmount("rewrite");
    mounted("rewrite", &store, 7);
    let note: String = open("rewrite")
        .query_row("SELECT note FROM t WHERE id = 1", [], |r| r.get(0))
        .unwrap();
    assert_eq!(note, "rewritten");
}

#[test]
fn a_transaction_reaches_the_store_once_at_its_commit() {
    let store = Arc::new(MemoryStore::new());
    mounted("once", &store, 8);
    let conn = open("once");
    fill(&conn, 10);
    let commits = store.commits();
    let tx = conn.unchecked_transaction().unwrap();
    for i in 0..400 {
        tx.execute("INSERT INTO t (note, pad) VALUES (?1, zeroblob(500))", [i])
            .unwrap();
    }
    assert_eq!(
        store.commits(),
        commits,
        "nothing is stored before the commit"
    );
    tx.commit().unwrap();
    assert_eq!(
        store.commits(),
        commits + 1,
        "one step for the whole transaction"
    );
}

#[test]
fn a_transaction_that_rolls_back_leaves_the_store_as_it_was() {
    let store = Arc::new(MemoryStore::new());
    mounted("rollback", &store, 9);
    let conn = open("rollback");
    fill(&conn, 10);
    let before = store.sealed_pages("user.db");
    {
        let tx = conn.unchecked_transaction().unwrap();
        // Enough to spill SQLite's page cache into the file before the end.
        conn.execute_batch("PRAGMA cache_size = 10").unwrap();
        for i in 0..2000 {
            tx.execute("INSERT INTO t (note, pad) VALUES (?1, zeroblob(800))", [i])
                .unwrap();
        }
        tx.rollback().unwrap();
    }
    assert_eq!(count(&conn), 10);
    drop(conn);
    unmount("rollback");
    mounted("rollback", &store, 9);
    assert_eq!(count(&open("rollback")), 10);
    // Whatever was synced along the way, the file holds the ten rows it held.
    assert!(store.sealed_pages("user.db").len() >= before.len());
}

#[test]
fn a_file_shrinks_in_the_store_when_sqlite_truncates_it() {
    let store = Arc::new(MemoryStore::new());
    mounted("shrink", &store, 10);
    let conn = open("shrink");
    fill(&conn, 600);
    let grown = store.sealed_pages("user.db").len();
    conn.execute_batch("DELETE FROM t; VACUUM;").unwrap();
    let shrunk = store.sealed_pages("user.db").len();
    assert!(shrunk < grown / 4, "{shrunk} pages left of {grown}");
    let size = store.size("user.db").unwrap().unwrap();
    assert_eq!(size as usize, shrunk * BLOCK);
    fill(&conn, 3);
    assert_eq!(count(&conn), 3);
}

#[test]
fn two_mounts_keep_two_sets_of_files() {
    let a = Arc::new(MemoryStore::new());
    let b = Arc::new(MemoryStore::new());
    mounted("two-a", &a, 11);
    mounted("two-b", &b, 12);
    fill(&open("two-a"), 7);
    fill(&open("two-b"), 9);
    assert_eq!(count(&open("two-a")), 7);
    assert_eq!(count(&open("two-b")), 9);
}

#[test]
fn the_engine_opens_its_pair_through_it() {
    let store = Arc::new(MemoryStore::new());
    mounted("engine", &store, 13);
    let opened = grimoire_core::launch::open_single(
        std::path::Path::new("engine"),
        std::path::Path::new("BOT:/engine"),
    )
    .unwrap();
    assert_eq!(opened.journal.as_str(), "delete");
    assert_eq!(opened.corpus_journal.as_str(), "delete");
    let version: i64 = opened
        .write
        .query_row("PRAGMA main.user_version", [], |r| r.get(0))
        .unwrap();
    assert!(version > 60);
    drop(opened);
    assert_eq!(
        store.files(),
        vec!["corpus.db".to_owned(), "user.db".to_owned()]
    );
    // And again, from the store alone.
    unmount("engine");
    mounted("engine", &store, 13);
    let again = grimoire_core::launch::open_single(
        std::path::Path::new("engine"),
        std::path::Path::new("BOT:/engine"),
    )
    .unwrap();
    let again_version: i64 = again
        .write
        .query_row("PRAGMA main.user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(again_version, version);
}

#[test]
fn the_seal_is_bound_to_its_place() {
    let cipher = PageCipher::new(&kek(14), "object");
    let sealed = cipher.seal("user.db", 3, b"page").unwrap();
    assert_eq!(cipher.open("user.db", 3, &sealed).unwrap(), b"page");
    assert!(cipher.open("user.db", 4, &sealed).is_err());
    assert!(cipher.open("corpus.db", 3, &sealed).is_err());
    assert_ne!(
        sealed,
        cipher.seal("user.db", 3, b"page").unwrap(),
        "a fresh nonce"
    );
}
