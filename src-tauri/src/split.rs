//! Taking the one file apart, and the four states the folder can be in while it happens.
//!
//! **`mtg.db` is not modified until the user file is safely renamed into place.** The order
//! below has exactly one irreversible moment — the rename at step 5 — and every crash before
//! it leaves the original untouched, every crash after it leaves a folder [`state_of`] can
//! name and [`convert`] can finish.
//!
//! Measured 2026-08-28 against a byte copy of the 788 406 272 B development database: 294 ms
//! end to end, producing a 1 323 008 B user file. A fresh install runs the same code against
//! an empty database, which is why this is not a once-per-lifetime path with no coverage.

use crate::db::{CORPUS_DB, LEGACY_DB, USER_DB};
use crate::schema::{self, Side};
use rusqlite::Connection;
use std::path::Path;

/// The half-built user file, before it earns its name.
pub const PART: &str = "user.db.part";

/// The scratch schema name the extraction attaches under.
const SCRATCH: &str = "part";

/// What the data folder holds, and which of them must not read as "done".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum State {
    /// Nothing here yet.
    Fresh,
    /// One file, from a build before schema 27.
    Legacy,
    /// The user file was renamed into place and the corpus rename had not happened. **This
    /// must never read as [`State::Split`]**: opening it would give a reader their whole
    /// collection and no card database, with `mtg.db` sitting beside it holding everything.
    HalfConverted,
    /// Done.
    Split,
}

/// Which of the four states `data_dir` is in.
///
/// The corpus is deliberately not consulted. A missing corpus beside a user file is a
/// *rebuild*, which is `crate::schema::prepare_data_dir`'s question and not this one; a
/// missing user file beside `mtg.db` is a conversion that has not started.
pub fn state_of(data_dir: &Path) -> std::io::Result<State> {
    let legacy = data_dir.join(LEGACY_DB).is_file();
    let user = data_dir.join(USER_DB).is_file();
    Ok(match (legacy, user) {
        (true, false) => State::Legacy,
        (true, true) => State::HalfConverted,
        (false, true) => State::Split,
        (false, false) => State::Fresh,
    })
}

/// Bring `data_dir` to [`State::Split`]. `Ok(false)` means it was already there.
///
/// **A fresh install goes through the conversion too**, and that is the point rather than an
/// accident: the riskiest code in this change is then the code every first launch and every
/// test run executes. For an empty database that is a few milliseconds; for the real one it
/// is the 294 ms measured in this module's doc.
pub fn convert(data_dir: &Path) -> Result<bool, String> {
    match state_of(data_dir).map_err(|e| e.to_string())? {
        State::Split => return Ok(false),
        State::Fresh => {
            let conn = crate::db::open(&data_dir.join(LEGACY_DB)).map_err(|e| e.to_string())?;
            schema::migrate_single_file(&conn).map_err(|e| e.to_string())?;
            crate::db::checkpoint_truncate(&conn).map_err(|e| e.to_string())?;
        }
        State::Legacy => {}
        State::HalfConverted => return finish(data_dir).map(|()| true),
    }

    // 1–4. Everything that touches only the new file.
    {
        let conn = crate::db::open(&data_dir.join(LEGACY_DB)).map_err(|e| e.to_string())?;
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if version > schema::LEGACY_SINGLE_FILE_VERSION {
            return Err(format!(
                "the database at {} is version {version}, which this build does not know. \
                 It is probably from a newer version of MTG Grimoire.",
                data_dir.join(LEGACY_DB).display()
            ));
        }
        schema::migrate_single_file(&conn).map_err(|e| e.to_string())?;
        extract_user_file(&conn, data_dir).map_err(|e| e.to_string())?;
        crate::db::checkpoint_truncate(&conn).map_err(|e| e.to_string())?;
    }

    // 5. The one irreversible moment, and the smallest possible one.
    std::fs::rename(data_dir.join(PART), data_dir.join(USER_DB)).map_err(|e| e.to_string())?;

    finish(data_dir).map(|()| true)
}

/// Steps 6–8: empty the old file of the reader's rows and let it become the corpus.
///
/// Idempotent throughout, because a crash resumes here: `DROP TABLE IF EXISTS`, a version
/// stamp that is already correct, and a rename that is only reached once.
fn finish(data_dir: &Path) -> Result<(), String> {
    {
        let conn = crate::db::open(&data_dir.join(LEGACY_DB)).map_err(|e| e.to_string())?;
        // **Outside the transaction, and that is not a style choice**: `PRAGMA foreign_keys`
        // is documented as a no-op while one is open, so the same statement one line lower
        // would leave the drops running with enforcement on and say nothing about it. OFF
        // for the drop and only the drop: the fifteen go in reverse dependency order, but
        // `deck_cards → deck_categories` and friends make any order a violation for the
        // duration of a batch, and this batch ends with none of them present.
        conn.pragma_update(None, "foreign_keys", "OFF")
            .map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for (table, _) in schema::TABLES
            .iter()
            .filter(|(_, s)| *s == Side::User)
            .rev()
        {
            tx.execute_batch(&format!("DROP TABLE IF EXISTS main.{table}"))
                .map_err(|e| e.to_string())?;
        }
        tx.execute_batch(&format!(
            "PRAGMA user_version = {};",
            schema::CORPUS_SCHEMA_VERSION
        ))
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;

        // Hand the pages back before the file takes its new name — measured at 333 chunks
        // and 29.9 ms on the real database, against a `VACUUM` that would rewrite 787 MB.
        reclaim(&conn);
        crate::db::checkpoint_truncate(&conn).map_err(|e| e.to_string())?;
    }
    // The journals are empty after a truncating checkpoint, so there is nothing in them to
    // carry across; removing them is what keeps the rename from stranding a `-wal` beside a
    // file that no longer has that name.
    for suffix in ["-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("{LEGACY_DB}{suffix}")));
    }
    std::fs::rename(data_dir.join(LEGACY_DB), data_dir.join(CORPUS_DB)).map_err(|e| e.to_string())
}

/// Build `user.db.part` beside the legacy file and copy the fifteen tables into it.
///
/// Attached rather than opened separately so the copy is `INSERT … SELECT` inside one
/// transaction on one connection — and the transaction is honest here where it would not be
/// in the running app, because a crash discards a `.part` file nobody has renamed yet.
pub fn extract_user_file(conn: &Connection, data_dir: &Path) -> rusqlite::Result<()> {
    for suffix in ["", "-wal", "-shm"] {
        let _ = std::fs::remove_file(data_dir.join(format!("{PART}{suffix}")));
    }
    let path = data_dir.join(PART);
    conn.execute(
        &format!("ATTACH DATABASE ?1 AS {SCRATCH}"),
        [path.to_string_lossy().as_ref()],
    )?;
    // The same order and the same reason as `crate::db::configure`: `auto_vacuum` before
    // WAL materialises the file.
    conn.pragma_update(Some(SCRATCH), "auto_vacuum", "INCREMENTAL")?;
    conn.pragma_update(Some(SCRATCH), "journal_mode", "WAL")?;
    conn.pragma_update(Some(SCRATCH), "synchronous", "NORMAL")?;

    conn.pragma_update(None, "foreign_keys", "OFF")?;
    let tx = conn.unchecked_transaction()?;
    schema::create_user_schema(&tx, SCRATCH)?;
    for (table, _) in schema::TABLES.iter().filter(|(_, s)| *s == Side::User) {
        let columns = shared_columns(&tx, table)?;
        tx.execute_batch(&format!(
            "INSERT INTO {SCRATCH}.{table} ({columns}) SELECT {columns} FROM main.{table}"
        ))?;
    }
    tx.execute_batch(&format!(
        "PRAGMA {SCRATCH}.user_version = {};",
        schema::USER_SCHEMA_VERSION
    ))?;
    tx.commit()?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.query_row(
        &format!("PRAGMA {SCRATCH}.wal_checkpoint(TRUNCATE)"),
        [],
        |_| Ok(()),
    )?;
    conn.execute_batch(&format!("DETACH DATABASE {SCRATCH}"))
}

/// The columns both copies of `table` have, in the destination's order.
///
/// A `SELECT *` would be one line and would break the first time a user rung adds a column:
/// the destination is at head and the source is at [`schema::LEGACY_SINGLE_FILE_VERSION`],
/// which are the same shape today and are not required to stay that way.
///
/// **`PRAGMA main.table_info` on a table that does not exist is an empty result, not an
/// error** — measured — so an empty answer here is a real failure mode and is refused rather
/// than turned into `INSERT INTO t () SELECT`.
fn shared_columns(conn: &Connection, table: &str) -> rusqlite::Result<String> {
    let read = |schema: &str| -> rusqlite::Result<Vec<String>> {
        let mut stmt = conn.prepare(&format!("PRAGMA {schema}.table_info({table})"))?;
        let names = stmt.query_map([], |r| r.get::<_, String>(1))?.collect();
        names
    };
    let source = read("main")?;
    let dest = read(SCRATCH)?;
    let shared: Vec<String> = dest
        .into_iter()
        .filter(|c| source.iter().any(|s| s == c))
        .map(|c| format!("\"{c}\""))
        .collect();
    if shared.is_empty() {
        return Err(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
            Some(format!("cannot split: `{table}` has no columns in common")),
        ));
    }
    Ok(shared.join(", "))
}

/// Hand the freed pages back, a chunk at a time. Best-effort: a corpus that is larger than
/// it needs to be is not a reason to refuse to start.
fn reclaim(conn: &Connection) {
    for _ in 0..10_000 {
        let free: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap_or(0);
        if free == 0
            || conn
                .execute_batch("PRAGMA incremental_vacuum(2000);")
                .is_err()
        {
            return;
        }
        let after: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap_or(0);
        if after == free {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mtgtest-split-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build a pre-split database in `dir`, exactly as a shipped build up to v26 left one.
    fn legacy(dir: &std::path::Path) {
        let conn = crate::db::open(&dir.join(crate::db::LEGACY_DB)).unwrap();
        crate::schema::migrate_single_file(&conn).unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('Krenko', 'commander', 100, 100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
               (card_id,set_code,collector_number,lang,finish,quantity,created_at,updated_at)
             VALUES ('abc','m21','139','en','nonfoil',4,100,100)",
            [],
        )
        .unwrap();
        // The two placements this plan corrected the brief on, seeded so that a copy which
        // silently skipped either of them is a red test rather than an empty table nobody
        // counted. `card_migrations` is the ledger of which folds have been applied to the
        // reader's own rows; `muted_tags` is a decision a person made.
        conn.execute(
            "INSERT INTO card_migrations
               (id, performed_at, strategy, old_card_id, new_card_id, note, applied_at)
             VALUES ('m-1','2026-08-01','merge','old','new',NULL,100)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO muted_tags (namespace, tag_id, slug, muted_at)
             VALUES ('oracle','uuid-1','ramp',100)",
            [],
        )
        .unwrap();
        crate::db::checkpoint_truncate(&conn).unwrap();
    }

    /// One row count per user table, read through whichever schema `schema` names.
    fn user_counts(conn: &Connection, schema: &str) -> Vec<(String, i64)> {
        crate::schema::TABLES
            .iter()
            .filter(|(_, s)| *s == Side::User)
            .map(|(t, _)| {
                let n: i64 = conn
                    .query_row(&format!("SELECT count(*) FROM {schema}.{t}"), [], |r| {
                        r.get(0)
                    })
                    .unwrap();
                ((*t).to_owned(), n)
            })
            .collect()
    }

    /// The four states the file system can be in, and the one that must not read as "done".
    #[test]
    fn the_file_state_machine_names_the_crashed_case() {
        let dir = scratch("states");
        assert_eq!(state_of(&dir).unwrap(), State::Fresh);

        legacy(&dir);
        assert_eq!(state_of(&dir).unwrap(), State::Legacy);

        // A crash between the rename of the user file and the rename of the corpus. Both
        // files exist and the corpus does not, which must NOT read as converted — the
        // collection would be intact and the whole card database missing.
        std::fs::write(dir.join(crate::db::USER_DB), b"").unwrap();
        assert_eq!(state_of(&dir).unwrap(), State::HalfConverted);

        std::fs::remove_file(dir.join(crate::db::LEGACY_DB)).unwrap();
        std::fs::write(dir.join(crate::db::CORPUS_DB), b"").unwrap();
        assert_eq!(state_of(&dir).unwrap(), State::Split);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The conversion, end to end, on a database this app actually built.
    #[test]
    fn a_legacy_database_becomes_two_and_keeps_every_user_row() {
        let dir = scratch("convert");
        legacy(&dir);
        let before = {
            let conn = crate::db::open_read_only(&dir.join(crate::db::LEGACY_DB)).unwrap();
            user_counts(&conn, "main")
        };

        let converted = convert(&dir).unwrap();

        assert!(converted);
        assert!(
            !dir.join(crate::db::LEGACY_DB).exists(),
            "mtg.db must be gone"
        );
        let conn = crate::db::open_write(&dir).unwrap();

        let decks: i64 = conn
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        let entries: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        let user_v: i64 = conn
            .query_row("PRAGMA main.user_version", [], |r| r.get(0))
            .unwrap();
        let corpus_v: i64 = conn
            .query_row("PRAGMA corpus.user_version", [], |r| r.get(0))
            .unwrap();
        let after = user_counts(&conn, "main");

        // Every table is in its own file and nowhere else. This is the assertion the whole
        // conversion exists to make true.
        for (table, side) in crate::schema::TABLES {
            let in_user: i64 = conn
                .query_row(
                    "SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            let in_corpus: i64 = conn
                .query_row(
                    "SELECT count(*) FROM corpus.sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            let (want_user, want_corpus) = match side {
                crate::schema::Side::User => (1, 0),
                crate::schema::Side::Corpus => (0, 1),
            };
            assert_eq!(in_user, want_user, "{table} in the user file");
            assert_eq!(in_corpus, want_corpus, "{table} in the corpus");
        }

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(after, before, "a user row count changed across the split");
        assert_eq!(decks, 1);
        assert_eq!(entries, 1);
        assert_eq!(user_v, crate::schema::USER_SCHEMA_VERSION);
        assert_eq!(corpus_v, crate::schema::CORPUS_SCHEMA_VERSION);
    }

    /// Running it twice is running it once. Every launch calls this.
    #[test]
    fn convert_is_idempotent_and_says_it_did_nothing() {
        let dir = scratch("idempotent");
        legacy(&dir);
        assert!(convert(&dir).unwrap());
        assert!(
            !convert(&dir).unwrap(),
            "a converted pair must report no work"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A crash between the two renames is resumed rather than mistaken for success.
    #[test]
    fn a_half_converted_folder_finishes_instead_of_opening_without_a_corpus() {
        let dir = scratch("resume");
        legacy(&dir);
        // Do the first half by hand, exactly as `convert` does, and stop.
        {
            let conn = crate::db::open(&dir.join(crate::db::LEGACY_DB)).unwrap();
            extract_user_file(&conn, &dir).unwrap();
            crate::db::checkpoint_truncate(&conn).unwrap();
        }
        std::fs::rename(dir.join(PART), dir.join(crate::db::USER_DB)).unwrap();
        assert_eq!(state_of(&dir).unwrap(), State::HalfConverted);

        assert!(
            convert(&dir).unwrap(),
            "the resume must report that it did work"
        );

        assert!(!dir.join(crate::db::LEGACY_DB).exists());
        assert!(dir.join(crate::db::CORPUS_DB).is_file());
        let conn = crate::db::open_write(&dir).unwrap();
        let decks: i64 = conn
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        let cards_side: i64 = conn
            .query_row(
                "SELECT count(*) FROM corpus.sqlite_master WHERE name='cards'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(decks, 1);
        assert_eq!(cards_side, 1);
    }

    /// A fresh install goes through the same code, and that is the point rather than an
    /// accident: the riskiest function in this plan is the one every launch runs.
    #[test]
    fn a_fresh_folder_produces_a_split_pair_with_no_legacy_file() {
        let dir = scratch("fresh");
        assert!(convert(&dir).unwrap());
        assert!(dir.join(crate::db::USER_DB).is_file());
        assert!(dir.join(crate::db::CORPUS_DB).is_file());
        assert!(!dir.join(crate::db::LEGACY_DB).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Throw the corpus away and the collection is still there. **This is the third
    /// consequence in the brief, as a property rather than as a button**: a corrupt corpus
    /// is a file to delete, not a reason to lose anything.
    ///
    /// The Danger Zone gets no new row in this change, deliberately — the frontend's own PR
    /// will find the Rust side already true, and this is what says so.
    #[test]
    fn a_destroyed_corpus_costs_a_resync_and_nothing_else() {
        let dir = scratch("corpus-loss");
        legacy(&dir);
        convert(&dir).unwrap();
        {
            let conn = crate::db::open_write(&dir).unwrap();
            crate::db::checkpoint_truncate(&conn).unwrap();
        }

        // What an OPFS eviction, a half-written sync or a bad sector leaves behind.
        std::fs::write(dir.join(crate::db::CORPUS_DB), b"not a database at all").unwrap();
        for suffix in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(dir.join(format!("corpus.db{suffix}")));
        }

        let recovered = crate::schema::prepare_data_dir(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        // The rest of a launch: `ATTACH` made an empty file, and this is what puts a shape
        // in it.
        crate::schema::prepare_database(&conn).unwrap();
        let decks: i64 = conn
            .query_row("SELECT count(*) FROM decks", [], |r| r.get(0))
            .unwrap();
        let entries: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        let migrations: i64 = conn
            .query_row("SELECT count(*) FROM card_migrations", [], |r| r.get(0))
            .unwrap();
        let cards: i64 = conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        let formats: i64 = conn
            .query_row("SELECT count(*) FROM format_specs", [], |r| r.get(0))
            .unwrap();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(recovered, "a corrupt corpus should have been replaced");
        assert_eq!(decks, 1, "the deck must survive losing the card database");
        assert_eq!(entries, 1, "and so must the collection");
        assert_eq!(
            migrations, 1,
            "and the ledger of which folds have been applied, or the next poll doubles a \
             quantity"
        );
        assert_eq!(
            cards, 0,
            "the corpus is empty and owes a sync, which is a supported state"
        );
        assert!(
            formats > 0,
            "the one corpus table no feed produces is seeded by the rebuild"
        );
    }

    /// **The one that cannot be faked with a fixture.** A worktree is a fresh install and can
    /// never show an upgrade bug; the main checkout's database is at `user_version` 25 with
    /// 116 843 cards and 2 581 `card_migrations` rows. Point `MTG_SPLIT_FIXTURE` at a **copy**
    /// and this runs against it — the same escape hatch `index::warmup` already uses with
    /// `MTG_WARMUP_DB`.
    ///
    /// Measured 2026-08-28 on a byte copy of the 788 406 272 B live database: the whole
    /// conversion took **294 ms** and produced a **1 323 008 B** user file beside a
    /// **787 042 304 B** corpus, with zero `foreign_key_check` violations.
    #[test]
    fn the_real_database_converts_with_every_row_intact() {
        let Ok(fixture) = std::env::var("MTG_SPLIT_FIXTURE") else {
            eprintln!("set MTG_SPLIT_FIXTURE to a COPY of a real mtg.db to run this");
            return;
        };
        let dir = scratch("real");
        std::fs::copy(&fixture, dir.join(crate::db::LEGACY_DB)).unwrap();

        let before: Vec<(String, i64)> = {
            let conn = crate::db::open_read_only(&dir.join(crate::db::LEGACY_DB)).unwrap();
            crate::schema::TABLES
                .iter()
                .filter(|(_, s)| *s == crate::schema::Side::User)
                .map(|(t, _)| {
                    let n: i64 = conn
                        .query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get(0))
                        .unwrap();
                    ((*t).to_owned(), n)
                })
                .collect()
        };

        let started = std::time::Instant::now();
        convert(&dir).unwrap();
        let elapsed = started.elapsed();

        let conn = crate::db::open_write(&dir).unwrap();
        let after: Vec<(String, i64)> = before
            .iter()
            .map(|(t, _)| {
                let n: i64 = conn
                    .query_row(&format!("SELECT count(*) FROM main.{t}"), [], |r| r.get(0))
                    .unwrap();
                (t.clone(), n)
            })
            .collect();
        let violations: i64 = conn
            .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |r| {
                r.get(0)
            })
            .unwrap();
        let cards: i64 = conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        let user_bytes = std::fs::metadata(dir.join(crate::db::USER_DB))
            .unwrap()
            .len();
        let corpus_bytes = std::fs::metadata(dir.join(crate::db::CORPUS_DB))
            .unwrap()
            .len();
        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);

        eprintln!(
            "conversion took {elapsed:?}, user.db is {user_bytes} B, corpus.db is {corpus_bytes} B"
        );
        assert_eq!(after, before, "a user row count changed across the split");
        assert_eq!(violations, 0);
        assert!(cards > 100_000, "the corpus must still hold its cards");
    }
}
