//! **The schema is `grimoire-core`'s, re-exported here whole — beside the one function that
//! cannot move with it.**
//!
//! Every `crate::schema::…` in this crate is that crate's `schema` (the DDL, both ladders, the
//! grains, the staging swaps, `prepare_database`) except [`prepare_data_dir`], which is defined
//! here: an item a module defines shadows a glob import of the same name.
//!
//! [`prepare_data_dir`] is [`crate::split::convert`] followed by
//! `schema::replace_unreadable_corpus`. `split` takes a pre-27 single file apart, which only the
//! desktop has ever had, so this one stays as long as `split` does.
//!
//! **`prepare_database` was here too, between the extraction's storage step and its domain
//! step**: the launch's logged passes call `maintenance`, `managed_wishlist`, `deck_tokens` and
//! `deck_meta`, which moved later than the ladders did. It is the core's again, directly below
//! `bring_to_head`, and nine of the tests that waited here with it went home.
//!
//! The tests below are the ones of `schema`'s that still name a module in this crate: `split`,
//! through this function or through a converted fixture, and the tag search. They are here
//! unedited; the tag search's goes back when `tags` moves, and the rest stay as long as `split`
//! does. ⚠️ **One of them is `#[ignore]`d and carries a rewind chain**, so a new user rung still
//! owes its `UNDO_V<N>` here as well as in the core's fixtures, and nothing goes red without it.

pub use grimoire_core::schema::*;

/// Bring `data_dir` to a state the app can open: convert if a single file is there, and
/// replace a corpus that will not open at all — or that an earlier session found damaged.
///
/// `Ok(true)` means something was rebuilt or converted. The conversion is this crate's
/// [`crate::split`]; what replaces an unreadable corpus, and why deleting it is enough, is
/// `schema::replace_unreadable_corpus`'s, which this calls second — as it always did.
pub fn prepare_data_dir(data_dir: &std::path::Path) -> Result<bool, String> {
    let converted = crate::split::convert(data_dir)?;
    Ok(replace_unreadable_corpus(data_dir) || converted)
}

/// **The tests of `schema` that name a module this crate still holds** — the conversion from a
/// single file and the tag search — and, re-exported, the fixtures every other test module here
/// reaches as `crate::schema::tests::…`.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::db::CORPUS;
    pub(crate) use grimoire_core::schema::fixtures::*;
    use rusqlite::Connection;
    /// A fresh split pair in a temp folder, with a corpus big enough to have pages past the
    /// first — a `damage` table of a few hundred pages, checkpointed so they are in the file
    /// rather than in its log.
    fn corpus_with_pages() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        crate::split::convert(dir.path()).unwrap();
        let conn = crate::db::open(&dir.path().join(crate::db::CORPUS_DB)).unwrap();
        conn.execute_batch(
            "CREATE TABLE damage (id INTEGER PRIMARY KEY, body TEXT NOT NULL);
             WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000)
             INSERT INTO damage (id, body) SELECT i, printf('%.200c', 'x') FROM n;",
        )
        .unwrap();
        crate::db::checkpoint_truncate(&conn).unwrap();
        drop(conn);
        dir
    }

    /// **The launch probe is deliberately blind to this, and the background check is not.** A
    /// page damaged past the first used to be caught by the `quick_check` every launch ran before
    /// a window could draw; the probe that replaced it reads only the header and the schema, so
    /// the file opens and the app starts. What still has to be true is that the damage is
    /// *found* and that the next launch replaces the file before any connection holds it — which
    /// is the old guarantee, one session later.
    #[test]
    fn a_corpus_damaged_past_its_first_page_starts_and_is_replaced_the_launch_after() {
        let dir = corpus_with_pages();
        damage_a_middle_page(dir.path());
        let corpus = dir.path().join(crate::db::CORPUS_DB);
        let size = std::fs::metadata(&corpus).unwrap().len();

        assert!(
            corpus_is_readable(dir.path()),
            "page one is sound, so the launch probe passes"
        );
        assert!(
            !prepare_data_dir(dir.path()).unwrap(),
            "and nothing is replaced this launch"
        );
        assert_eq!(std::fs::metadata(&corpus).unwrap().len(), size);

        let CorpusCheck::Damaged(answer) = check_corpus(dir.path()) else {
            panic!("the full check must find a damaged page");
        };
        mark_corpus_damaged(dir.path(), &answer).unwrap();

        assert!(
            prepare_data_dir(dir.path()).unwrap(),
            "the marked corpus is replaced"
        );
        assert!(
            !dir.path().join(CORPUS_DAMAGED_MARK).exists(),
            "and the mark goes with it"
        );
        assert!(
            !corpus.exists() || std::fs::metadata(&corpus).unwrap().len() < size,
            "the damaged file must not survive the launch after the check"
        );
        assert!(
            dir.path().join(crate::db::USER_DB).is_file(),
            "the reader's file is untouched"
        );
    }

    /// A data folder as a launch leaves it: converted, opened and migrated, with one row the
    /// reader wrote and one card a sync wrote. Answers the folder; the connection is closed.
    fn launched_pair() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        prepare_data_dir(dir.path()).unwrap();
        let conn = crate::db::open_write(dir.path()).unwrap();
        prepare_database(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO app_meta (key, value) VALUES ('reader_wrote', 'this');
             INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number, lang,
                                layout, raw)
               VALUES ('bolt', 'o1', 'Lightning Bolt', 'lea', 'Alpha', '161', 'en', 'normal',
                       '{}');",
        )
        .unwrap();
        crate::db::checkpoint_truncate(&conn).unwrap();
        dir
    }

    /// Issue #550, the state the old ladder could leave behind: every corpus table built, the
    /// stamp never written. It used to stop every launch on `table cards already exists`; now it
    /// is replaced, and the reader's file is not touched.
    #[test]
    fn a_corpus_shaped_under_version_zero_is_replaced_and_the_launch_goes_on() {
        let dir = launched_pair();
        {
            let conn = crate::db::open_write(dir.path()).unwrap();
            conn.execute_batch(&format!("PRAGMA {CORPUS}.user_version = 0;"))
                .unwrap();
        }

        let conn = crate::db::open_write(dir.path()).unwrap();
        prepare_database(&conn).expect("the launch must go on");
        assert_eq!(corpus_version(&conn), CORPUS_SCHEMA_VERSION);
        let cards: i64 = conn
            .query_row("SELECT count(*) FROM cards", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            cards, 0,
            "the corpus was rebuilt empty, for the next sync to fill"
        );
        let kept: String = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'reader_wrote'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, "this", "and the reader's own file was not touched");
    }

    /// Issue #550: a copy of the reader's file before a rung moves anything, never overwritten,
    /// and only the newest three kept — beside a file of the reader's own that is left alone.
    #[test]
    fn the_user_file_is_copied_before_an_upgrade_and_only_three_copies_are_kept() {
        let dir = launched_pair();
        let conn = crate::db::open_write(dir.path()).unwrap();
        let backups = dir.path().join(USER_BACKUPS_DIR);

        let copy = back_up_user_file(&conn, 40)
            .unwrap()
            .expect("a copy is written");
        assert_eq!(copy, backups.join("user.v40.db"));
        let read = Connection::open(&copy).unwrap();
        let kept: String = read
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'reader_wrote'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(kept, "this");
        let has_cards: i64 = read
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name = 'cards'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            has_cards, 0,
            "the copy is the user file alone, not the corpus"
        );
        drop(read);

        assert_eq!(
            back_up_user_file(&conn, 40).unwrap(),
            None,
            "an existing copy is never overwritten"
        );

        std::fs::write(backups.join("mine.db"), b"the reader's own").unwrap();
        for from in [41, 42, 43] {
            back_up_user_file(&conn, from).unwrap().unwrap();
        }
        let mut left: Vec<String> = std::fs::read_dir(&backups)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        left.sort();
        assert_eq!(
            left,
            ["mine.db", "user.v41.db", "user.v42.db", "user.v43.db"]
        );
    }

    /// Issue #550: a corpus that could not be deleted keeps its mark, so the next launch tries
    /// again rather than living with a damaged file nothing remembers. A directory in the file's
    /// place is a delete that fails on every platform.
    #[test]
    fn a_corpus_that_could_not_be_deleted_keeps_its_damage_mark() {
        let dir = launched_pair();
        let corpus = dir.path().join(crate::db::CORPUS_DB);
        std::fs::remove_file(&corpus).unwrap();
        std::fs::create_dir(&corpus).unwrap();
        mark_corpus_damaged(dir.path(), "*** in database main ***").unwrap();

        assert!(
            !prepare_data_dir(dir.path()).unwrap(),
            "nothing was replaced, and it does not say so"
        );
        assert!(dir.path().join(CORPUS_DAMAGED_MARK).exists());

        std::fs::remove_dir(&corpus).unwrap();
        assert!(prepare_data_dir(dir.path()).unwrap());
        assert!(
            !dir.path().join(CORPUS_DAMAGED_MARK).exists(),
            "once the delete succeeds, the mark goes"
        );
    }

    #[test]
    fn a_sound_corpus_checks_sound_and_a_file_that_is_no_database_checks_damaged() {
        let dir = corpus_with_pages();
        assert_eq!(check_corpus(dir.path()), CorpusCheck::Sound);

        std::fs::write(
            dir.path().join(crate::db::CORPUS_DB),
            b"not a database at all",
        )
        .unwrap();
        assert!(matches!(check_corpus(dir.path()), CorpusCheck::Damaged(_)));
    }

    /// **The one that cannot be faked with a fixture.** A worktree is a fresh install, so every
    /// test above backfills two rows and calls that unique. A backfill that is unique over two
    /// rows and collides over eight thousand is exactly the bug a fixture cannot show.
    ///
    /// Point `MTG_SPLIT_FIXTURE` at a **copy** of a real `mtg.db` — the escape hatch
    /// [`crate::split::tests::the_real_database_converts_with_every_row_intact`] already uses —
    /// and this converts it, winds the user file back to 28 with the whole rewind chain —
    /// [`UNDO_V39`], [`UNDO_V38`], [`UNDO_V37`], [`UNDO_V35`], [`UNDO_V34`], [`UNDO_V33`],
    /// [`UNDO_V31`],
    /// [`UNDO_V30`] and [`UNDO_V29`], newest first, which is the chain the body spells and every
    /// rung above 28 with a shape to take back (v32 and v36 write none) —
    /// and climbs the rungs over the reader's own rows. **This list had lost its own top once
    /// and nothing could go red for it**: the chain below is a `format!` and was always right,
    /// while this enumeration is prose and the test is `#[ignore]`d, so no suite reads either.
    /// Add the new constant here whenever one lands.
    /// **Winding back is the whole trick**:
    /// `split::convert` stamps head, so a converted file never climbs anything and a test that
    /// only converted would prove nothing about the rung.
    ///
    /// **The counts are taken before the rewind and not after it**, which they were until v33:
    /// [`SYNCED_TABLES`] names `deck_labels`, a rewound file calls that table `deck_tags`, and a
    /// snapshot taken between the two would fail on the table it is most about. A rename moves
    /// no rows, so the number is the same on either side of it.
    ///
    /// `cargo test --lib -- --ignored migrate_the_real_database --nocapture`
    #[test]
    #[ignore]
    fn migrate_the_real_database_to_v29() {
        let Ok(fixture) = std::env::var("MTG_SPLIT_FIXTURE") else {
            eprintln!("set MTG_SPLIT_FIXTURE to a COPY of a real mtg.db to run this");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        std::fs::copy(&fixture, dir.path().join(crate::db::LEGACY_DB)).unwrap();
        crate::split::convert(dir.path()).unwrap();

        let conn = crate::db::open_write(dir.path()).unwrap();
        let before: Vec<(String, i64)> = SYNCED_TABLES
            .iter()
            .map(|t| {
                let n: i64 = conn
                    .query_row(&format!("SELECT count(*) FROM main.{t}"), [], |r| r.get(0))
                    .unwrap();
                ((*t).to_owned(), n)
            })
            .collect();
        conn.execute_batch(&format!(
            "{UNDO_V59} {UNDO_V58} {UNDO_V57} {UNDO_V56} {UNDO_V55} {UNDO_V54} {UNDO_V53} {UNDO_V52} {UNDO_V51} {UNDO_V50} {UNDO_V49} {UNDO_V48} {UNDO_V47} {UNDO_V46} {UNDO_V45} {UNDO_V44} {UNDO_V43} {UNDO_V42} {UNDO_V41} {UNDO_V40} {UNDO_V39} {UNDO_V38} {UNDO_V37} {UNDO_V35} {UNDO_V34} {UNDO_V33} {UNDO_V31} {UNDO_V30} {UNDO_V29} \
             PRAGMA main.user_version = 28;"
        ))
        .unwrap();

        let started = std::time::Instant::now();
        migrate_user(&conn).unwrap();
        let elapsed = started.elapsed();

        let version: i64 = conn
            .query_row("PRAGMA main.user_version", [], |r| r.get(0))
            .unwrap();
        // Head rather than a literal `29`: the rewind stops at 28 and `migrate_user` climbs
        // every rung above it, so this number moves with the ladder.
        assert_eq!(version, USER_SCHEMA_VERSION);
        eprintln!("the v29 rung over a real user file took {elapsed:?}");
        for (table, rows) in &before {
            let (now, uids): (i64, i64) = conn
                .query_row(
                    &format!("SELECT count(*), count(DISTINCT sync_uid) FROM main.{table}"),
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .unwrap();
            eprintln!("  {table}: {rows} rows before, {now} after, {uids} distinct uids");
            assert_eq!(now, *rows, "{table} lost or gained a row across the rung");
            assert_eq!(uids, now, "{table} has a NULL or a duplicate sync_uid");
        }
        let ticks: i64 = conn
            .query_row("SELECT count(*) FROM sync_clock", [], |r| r.get(0))
            .unwrap();
        assert_eq!(ticks, 1);

        // **The rest of the launch, over the same real file.** `prepare_database` is what
        // installs the capture triggers, and thirty-one `CREATE TRIGGER`s against a database
        // with the reader's own tables in it is the step no fixture exercises. Then one write,
        // to prove the triggers fire on a real row rather than merely existing.
        prepare_database(&conn).unwrap();
        conn.execute(
            "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('After the rung', 'commander', unixepoch(), unixepoch())",
            [],
        )
        .unwrap();
        let (uid, ops): (Option<String>, i64) = conn
            .query_row(
                "SELECT (SELECT sync_uid FROM decks WHERE name = 'After the rung'),
                        (SELECT count(*) FROM sync_ops)",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert!(
            uid.is_some(),
            "the capture trigger did not mint on a real file"
        );
        assert_eq!(
            ops, 0,
            "an unpaired device records nothing, and this database has never paired"
        );
    }

    /// A killed sync leaves a *committed* staging table now that the ingest chunks its
    /// load — several hundred megabytes of it, on the database of an app that ships on a
    /// USB stick. Nothing else would drop it before the next run that is actually due:
    /// `create_staging` holds the only other `DROP`, and `bulk_etag`/`bulk_updated_at` are
    /// written only after a *successful* ingest — so the killed run stored nothing, and the
    /// rest of the 24 h check window (longer, offline) stands between the residue and the
    /// `create_staging` that would clear it.
    ///
    /// A real file rather than `:memory:`, because the residue this is about is disk.
    #[test]
    fn startup_drops_the_staging_table_a_killed_ingest_left_behind() {
        let dir = crate::scratch::path("schema-residue");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();

        // The state a killed ingest leaves: a migrated database, a swap that never ran,
        // and committed rows in staging.
        {
            let conn = crate::db::open_write(&dir).unwrap();
            prepare_database(&conn).unwrap();
            create_staging(&conn).unwrap();
            conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('half','Half Ingested','x','1','en','normal','{}')", []).unwrap();
            crate::db::checkpoint_truncate(&conn).unwrap();
        }

        // The next launch, which is `init_state`'s one act of database preparation.
        let conn = crate::db::open_write(&dir).unwrap();
        prepare_database(&conn).unwrap();

        let staging: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {CORPUS}.sqlite_master WHERE name='cards_staging'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(staging, 0, "crash residue must not survive a launch");
        // And the launch is still a launch: the schema it was there to prepare is intact.
        let tables: i64 = conn
            .query_row(
                &format!(
                    "SELECT count(*) FROM {CORPUS}.sqlite_master
                     WHERE name IN ('cards','sets','sync_meta','cards_fts')"
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tables, 4);

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
