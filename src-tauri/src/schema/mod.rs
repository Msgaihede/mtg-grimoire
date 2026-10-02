//! **The schema is `grimoire-core`'s, re-exported here whole — beside the two functions that
//! could not move with it.**
//!
//! Every `crate::schema::…` in this crate is that crate's `schema` (the DDL, both ladders, the
//! grains, the staging swaps) except [`prepare_database`] and [`prepare_data_dir`], which are
//! defined here: an item a module defines shadows a glob import of the same name.
//!
//! * [`prepare_database`] is `schema::bring_to_head` — the two ladders and the capture
//!   triggers, everything that may stop a launch — followed by the launch's logged passes. Those
//!   call `maintenance`, `managed_wishlist`, `deck_tokens` and `deck_meta`, none of which has
//!   moved yet. **The cut is the line the function already drew**, between a failure that stops
//!   a launch and one that is logged and left owing; no statement on either side changed, and
//!   none changed order. It goes home with the extraction's step 4.
//! * [`prepare_data_dir`] is [`crate::split::convert`] followed by
//!   `schema::replace_unreadable_corpus`. `split` takes a pre-27 single file apart, which only
//!   the desktop has ever had, so this one stays as long as `split` does.
//!
//! The tests below are the ones of `schema`'s that name a module still in this crate. They are
//! here unedited, and each goes back when what it names moves.

pub use grimoire_core::schema::*;

use crate::db::CORPUS;
use rusqlite::Connection;

/// Everything a freshly opened database needs before the app touches it: the schema is
/// brought to head, a search index an interrupted compaction owes is rebuilt, and any
/// `cards_staging` an interrupted ingest left behind is dropped.
///
/// The rebuild is second because it is the one that cannot wait for a sync. A compaction
/// killed between its `VACUUM` and its `create_fts` leaves a database whose header says it
/// is converted and whose index answers with the wrong cards; nothing else would notice,
/// because the sync that rebuilds the index is the one that ingests and most syncs get a
/// 304. See [`crate::maintenance::K_FTS_REBUILD_PENDING`]. It costs one `sync_meta` lookup
/// on every launch that does not need it.
///
/// **[`migrate_single_file`] is the only step here allowed to stop a launch.** A schema that cannot be
/// brought to head means the database cannot be used at all. The other two mean something is
/// *worse* rather than unusable — a rebuild that fails means search is wrong, a drop that
/// fails means a few hundred megabytes stay parked — and both failures have the same likely
/// cause: a disk that is full, read-only, or held open by something else. Making either
/// fatal would turn that into an app which refuses to start and tells the user to move a
/// perfectly good `mtg.db` aside, which is the one remedy a full disk is deaf to. So both
/// are logged, their debt is left exactly where it was, and the next launch — or the next
/// sync, through `compact_once` and `create_staging` — tries again.
///
/// The drop is not tidiness. The ingest commits its staging load a batch at a time, so a
/// sync that is killed partway — a closed lid, a pulled stick, a crash — leaves a
/// *committed* staging table holding most of a card database: measured against the ~2 GB
/// `mtg.db`, that is several hundred megabytes.
///
/// **What bounds that residue's life is the throttle, not Scryfall's rotation.** The only
/// other `DROP` is inside [`create_staging`], and the metadata that lets a check
/// short-circuit (`bulk_etag`, `bulk_updated_at`) is written *after* a successful ingest —
/// so a killed run stores nothing, and the next run that is actually due sees the same
/// changed bulk file it died downloading and re-enters `create_staging`. The residue
/// therefore survives the rest of the 24 h check window, and survives indefinitely only
/// while the app stays offline or unlaunched. That is still a day of a USB stick carrying
/// hundreds of megabytes of nothing, and a launch is the moment it is free to hand back.
///
/// This returns those pages to SQLite's freelist, so the next ingest reuses them instead of
/// growing the file past them — and on an incremental-auto-vacuum database, which is every
/// database this app creates (see [`crate::db::open`]), the freelist is exactly what
/// [`crate::maintenance::reclaim_freed_pages`] hands back to the filesystem after the next
/// swap. Reuse is the part that matters for a USB stick either way: without it a killed
/// sync's residue and the next sync's staging table both want room at once.
///
/// What startup deliberately does *not* do is `VACUUM`. It rewrites the whole file — minutes
/// on the measured 2.02 GB database, before there is a window to say so in — and it renumbers
/// rowids, which owes the external-content FTS index a full rebuild. The one conversion that
/// does need a `VACUUM` runs after a sync instead, once per database: see
/// [`crate::maintenance::convert_to_incremental`].
pub fn prepare_database(conn: &Connection) -> rusqlite::Result<()> {
    bring_to_head(conn)?;
    if let Err(e) = crate::maintenance::rebuild_fts_if_pending(conn) {
        eprintln!(
            "the search index still owes a rebuild from an interrupted compaction, and it \
             could not be done now: {e}\nSearch results may be wrong until the next sync."
        );
    }
    if let Err(e) = conn.execute_batch(&format!("DROP TABLE IF EXISTS {CORPUS}.cards_staging")) {
        eprintln!(
            "an interrupted sync left a `cards_staging` table behind and it could not be \
             dropped now: {e}\nThe data folder is using more space than it needs to until \
             the next sync reuses it."
        );
    }
    // Logged and left owing, like the two repairs above it and unlike the two migrations: a feed
    // longer than its ceiling is a database that works perfectly, and nothing a reader could act
    // on would be gained by refusing to start over one.
    if let Err(e) = crate::maintenance::prune_activity_log(conn) {
        eprintln!(
            "the home page's activity log could not be trimmed at launch: {e}\nIt will be \
             trimmed at the next launch; nothing else is affected."
        );
    }
    // Logged and left owing for the same reason: a day missing from the price history is a gap
    // in a widget, and the next sync or feed refresh fills the day anyway. At launch at all so
    // that a reader's first launch after upgrading already has a baseline — a widget that waits
    // for the first *sync* to start its clock can go a day with nothing to measure against.
    if let Err(e) = crate::maintenance::snapshot_prices(conn) {
        eprintln!(
            "today's prices could not be recorded at launch: {e}\nThe next sync or price \
             refresh records them; nothing else is affected."
        );
    }
    // Logged and left owing, the same reason again: a managed wishlist that is a launch behind
    // is a folder that catches up at the next write to its deck. At launch at all because the
    // v48 rung's `DEFAULT 1` promises every existing theory deck a folder, and a reader who
    // opens the wishlist before touching a deck must find it there.
    if let Err(e) = crate::managed_wishlist::settle_all(conn) {
        eprintln!(
            "the managed wishlists could not be brought up to date at launch: {e}\nEach one \
             catches up at the next change to its deck."
        );
    }
    // Logged and left owing, the same reason again: a v51 art pick not yet converted draws as
    // the token's implicit entry — the resolver's printing — until a later pass converts it,
    // and nothing a reader could act on is gained by refusing to start over one. **After
    // `capture::install` and never inside a rung**, because this is the one launch step whose
    // writes must be captured: every entry it derives has to reach the peers that never derived
    // it, or their edits to it stall a sync stream (the v52 rung's comment and the function's own
    // say how). **Gated**: a device in no sync group converts here, and a device in one only once
    // a pull at v52 has landed — until then `sync_engine::client::pull` converts behind its first
    // pull instead, because a conversion before the device has heard its group can revert what a
    // peer did since (`convert_legacy_picks_at_launch`'s doc). Idempotent, so every later launch
    // costs one read that finds nothing.
    if let Err(e) = crate::deck_tokens::convert_legacy_picks_at_launch(conn) {
        eprintln!(
            "the decks' pre-v52 token art picks could not be converted at launch: {e}\nThey \
             are tried again at the next launch; until then each draws its default printing."
        );
    }
    // Logged and left owing, the same reason once more: a token entry in a finish its printing
    // is not sold in draws the wrong chin until the next launch, and nothing a reader could act
    // on is gained by refusing to start over one. **After the conversion**, as its net: the
    // conversion files each pick in the printing's own default finish, read from the corpus it
    // runs after, and falls back to `nonfoil` only where this device's corpus cannot say — those
    // entries, and a printing whose sold finishes changed after its entry was filed, are what
    // this moves. Idempotent, so every later launch costs one read that finds nothing.
    if let Err(e) = crate::deck_tokens::repair_entry_finishes(conn) {
        eprintln!(
            "the finishes of the decks' token printings could not be checked at launch: \
             {e}\nThey are checked again at the next launch."
        );
    }
    // Logged and left owing, the same reason once more: a theory card a v52 peer filed into a
    // live pile draws on neither tab until it is refiled, and nothing a reader could act on is
    // gained by refusing to start over one. **After `capture::install`**, for the conversion's
    // reason: the plan pile it makes and the card it moves must reach the peers that never made
    // them. **Gated** the conversion's way — a paired device repairs behind a pull at v53 instead
    // (`deck_meta::refile_stray_theory_cards`' doc says why). Idempotent: one read at a launch
    // with nothing stray, which is every launch on a device whose group all climbed together.
    if let Err(e) = crate::deck_meta::refile_stray_theory_cards_at_launch(conn) {
        eprintln!(
            "the plans' cards filed in the actual list's categories could not be refiled at \
             launch: {e}\nThey are tried again at the next launch."
        );
    }
    // Logged and left owing, the same reason once more: a token dismissed before v55 that this
    // pass has not retired draws as an ordinary token anyway — no reader treats `hidden` as
    // hidden any more — and nothing a reader could act on is gained by refusing to start over
    // one. **After the conversion and the repair**, because it zeroes entries they may have
    // filed, and **after `migrate_corpus`**, because whether the deck still makes the token is a
    // derivation over `cards.raw`, which is why this is a pass and not part of the v55 rung.
    // Behind `capture::suppressed` and idempotent, so a `hidden` an older peer sends later is
    // retired at the next launch and every launch after costs one read that finds nothing.
    crate::deck_tokens::retire_hidden_logged(conn);
    // **And then the dirty marks every pass since `settle_all` left, drained the way
    // `sync::with_write` drains a write's — rule 7's backstop first, then the managed wishlist.**
    // `settle_all` above armed this connection, so the conversion, the repair, the refile and the
    // retire pass each marked the decks they wrote, and nothing read those marks until the first
    // write of the session. Worse, `settle_all` ran *before* the retire pass: on the first v55
    // launch a theory deck following `all` or `tokens` built its Tokens subfolder from a
    // dismissed token's counts, which the pass then zeroed under it — a shopping list for tokens
    // the reader had said they did not want (the final review's M2). Logged, for the reason
    // every step here is.
    crate::deck_tokens::reconcile_dirty_logged(conn);
    crate::managed_wishlist::settle_logged(conn);
    Ok(())
}

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

/// **The tests of `schema` that name a module this crate still holds** — the launch, the token
/// conversion, the to-do lists, the tag search, the bracket fence — and, re-exported, the
/// fixtures every other test module here reaches as `crate::schema::tests::…`.
#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub(crate) use grimoire_core::schema::fixtures::*;
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

    /// **A pair whose user half is an empty file gets its shape from `prepare_database`.**
    ///
    /// A launch never meets one — a fresh install builds a legacy `mtg.db` at 26 and
    /// `split::convert` takes it apart — so this is the only thing that reaches the arm. Without
    /// it the facet index is what would notice: it reads `collection_entries` for its `owned`
    /// dimension.
    ///
    /// A bare `ATTACH ':memory:'` pair is the right fixture precisely because it is what an
    /// unshaped database looks like: two empty schemas at `user_version = 0`.
    #[test]
    fn an_unshaped_user_file_is_built_by_prepare_database() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!("ATTACH DATABASE ':memory:' AS {CORPUS}"))
            .unwrap();
        let before: i64 = conn
            .query_row("PRAGMA main.user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, 0, "the fixture must start with no shape at all");

        prepare_database(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA main.user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, USER_SCHEMA_VERSION);

        // The table whose absence was the only symptom.
        let owned: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(owned, 0);

        // And the one seeded row, without which no deck can ever release a card.
        let removed: String = conn
            .query_row(
                "SELECT name FROM collection_folders WHERE kind = 'removed'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(removed, "Recently removed");

        // Every user table, against the registry - so a table added to `TABLES` and not to
        // `USER_SCHEMA_SQL` fails here rather than on somebody's first web launch.
        for (table, side) in TABLES {
            if *side != Side::User {
                continue;
            }
            let n: i64 = conn
                .query_row(
                    "SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name=?1",
                    [table],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(n, 1, "`{table}` is a user table and was not created");
        }
    }

    /// **v52 over a real v51 file holding the three kinds of override a reader can have, and the
    /// launch conversion after it.** Seeded before the climb, v47's argument: a row inserted at
    /// head could not hold a `token_stack` at all, so a test that started there would be
    /// asserting about rows the rung never met.
    ///
    /// Deck A draws its pile (`token_stack = 1`) and picked an art for `o1` at 3 copies; deck B
    /// draws none and stepped `o2` to 2 without picking an art. **The rung converts nothing**:
    /// after the climb every override is as it was and the entry table is empty, because an entry
    /// derived from a pick has to be announced to peers that never derived it, and no rung runs
    /// with capture live. Both decks are on `managed`, B included — the reader's answer — and
    /// `token_stack` is gone.
    ///
    /// Then [`crate::deck_tokens::convert_legacy_picks`], a later step of `prepare_database`,
    /// makes A's pick one entry **per list** — both lists drew the shared pick, so both keep
    /// drawing it — named after the override it came from, and the override is legacy. B's row is
    /// untouched, because a quantity alone is the implicit entry's count and no printing may be
    /// invented for it.
    #[test]
    fn v52_swaps_the_stack_for_a_mode_and_leaves_the_picks_to_the_launch_conversion() {
        let conn = user_file_at_51();
        conn.execute_batch(
            "INSERT INTO decks (id, name, format_key, token_stack, created_at, updated_at)
                 VALUES (1, 'A', 'modern', 1, 0, 0), (2, 'B', 'modern', 0, 0, 0);
             INSERT INTO deck_tokens
                 (deck_id, oracle_id, card_id, quantity, state, created_at, updated_at, sync_uid)
                 VALUES (1, 'o1', 'p1', 3, 'auto', 5, 5, 'u-a'),
                        (2, 'o2', NULL, 2, 'auto', 6, 6, 'u-b');",
        )
        .unwrap();
        type Override = (i64, Option<String>, Option<i64>, String);
        let overrides = |conn: &Connection| -> Vec<Override> {
            conn.prepare(
                "SELECT deck_id, card_id, quantity, state FROM deck_tokens ORDER BY deck_id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
        };
        let count_entries = |conn: &Connection| -> i64 {
            conn.query_row("SELECT count(*) FROM deck_token_printings", [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        let before = overrides(&conn);

        migrate_user(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA main.user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 59);
        assert_eq!(
            overrides(&conn),
            before,
            "the rung touches no override: converting a pick is the launch's, where it is captured"
        );
        assert_eq!(count_entries(&conn), 0, "and the entry table is born empty");
        let modes: Vec<String> = conn
            .prepare("SELECT token_mode FROM decks ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            modes,
            ["managed", "managed"],
            "every deck starts on managed, the one whose pile was off included"
        );
        assert_eq!(has_column(&conn, "decks", "token_stack"), 0);

        crate::deck_tokens::convert_legacy_picks(&conn).unwrap();

        let mut stmt = conn
            .prepare(
                "SELECT deck_id, variant, oracle_id, card_id, finish, quantity, sync_uid
                   FROM deck_token_printings ORDER BY deck_id, variant",
            )
            .unwrap();
        type Entry = (i64, String, String, String, String, i64, Option<String>);
        let entries: Vec<Entry> = stmt
            .query_map([], |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                    r.get(6)?,
                ))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let entry = |variant: &str, uid: &str| -> Entry {
            (
                1,
                variant.to_owned(),
                "o1".to_owned(),
                "p1".to_owned(),
                "nonfoil".to_owned(),
                3,
                Some(uid.to_owned()),
            )
        };
        assert_eq!(
            entries,
            [entry("live", "u-a-live"), entry("theory", "u-a-theory")],
            "one entry per list for the picked art, at its quantity, `nonfoil` until the launch \
             repair, and named after the override so every device names it alike — and nothing \
             for the quantity-only override"
        );
        assert_eq!(
            overrides(&conn),
            [
                (1, None, None, "auto".to_owned()),
                (2, None, Some(2), "auto".to_owned()),
            ],
            "the moved override is legacy and keeps its state; the quantity-only one is untouched"
        );

        // Twice is the same as once: a second launch finds the version stamped and the picks
        // cleared, so it moves nothing a second time — which the `DROP COLUMN` would otherwise
        // refuse loudly and the conversion's `INSERT` would otherwise do quietly.
        migrate_user(&conn).unwrap();
        crate::deck_tokens::convert_legacy_picks(&conn).unwrap();
        assert_eq!(count_entries(&conn), 2, "the second launch moved nothing");
    }

    /// **The rung runs on a paired file, and records nothing.** A paired v58 database carries
    /// `sync_ins_decks` and `sync_upd_decks` reading `NEW.todos`, and SQLite refuses the
    /// `DROP COLUMN` under them — so the rung has to take them off first, v43's move. The rewind
    /// took the real ones with it and head's `capture::install` cannot put v58's back, so a
    /// stand-in reading `NEW.todos` stands under the same name, which is the refusal the rung
    /// must clear. Measured: with the rung's three `DROP TRIGGER`s taken out, the climb fails
    /// `error in trigger sync_upd_decks after drop column: no such column: NEW.todos`. And the
    /// conversion is not captured — every device converts its own copy — while the control, a
    /// list made after the climb, is.
    #[test]
    fn the_v59_conversion_runs_under_a_paired_files_triggers_and_is_not_captured() {
        let conn = Connection::open_in_memory().unwrap();
        create_user_schema(&conn, "main").unwrap();
        crate::sync_engine::capture::install(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'dev-a', x'00', x'01', 'A', 0);
             INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g', 0, x'02', 0);",
        )
        .unwrap();
        // Inserted at head, while the capture triggers stand, so the deck carries the uid a
        // paired device's deck has.
        conn.execute(
            "INSERT INTO decks (id, name, format_key, created_at, updated_at)
             VALUES (1, 'Burn', 'modern', 0, 0)",
            [],
        )
        .unwrap();
        conn.execute_batch(&format!("{UNDO_V59} PRAGMA main.user_version = 58;"))
            .unwrap();
        conn.execute_batch(
            "UPDATE decks SET todos = '- [ ] a' WHERE id = 1;
             CREATE TABLE fired (n INTEGER);
             CREATE TRIGGER sync_upd_decks AFTER UPDATE ON decks
             WHEN NEW.todos IS NOT OLD.todos BEGIN
                 INSERT INTO fired VALUES (1);
             END;",
        )
        .unwrap();
        conn.execute("DELETE FROM sync_ops", []).unwrap();

        migrate_user(&conn).unwrap();
        let uid: String = conn
            .query_row("SELECT sync_uid FROM decks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        let list_uid: String = conn
            .query_row("SELECT sync_uid FROM deck_todo_lists", [], |r| r.get(0))
            .unwrap();
        assert_eq!(list_uid, todo_list_uid(&uid));
        let ops = |conn: &Connection| -> i64 {
            conn.query_row("SELECT count(*) FROM sync_ops", [], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(ops(&conn), 0, "the conversion is derived, not an edit");

        crate::sync_engine::capture::install(&conn).unwrap();
        crate::deck_todos::create_list(&conn, 1, "Mana", "- [ ] b").unwrap();
        let listed: i64 = conn
            .query_row(
                "SELECT count(*) FROM sync_ops WHERE tbl = 'deck_todo_lists'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            listed, 1,
            "the control: a list made after the climb is captured"
        );
    }

    /// **The climb and the launch conversion are total over every override a v51 file can hold,
    /// not only the ones a command would write.** `deck_tokens.quantity` has no `CHECK` — a
    /// synced field, so a peer or an old build can have put any integer there — while the entry
    /// table refuses a count below zero; and `deck_tokens`' grain is `(deck_id, oracle_id)`, so
    /// two tokens of one deck can have picked **one printing** (a double-faced token carries two
    /// tokens on one card), which is a single entry on [`DECK_TOKEN_PRINTING_GRAIN`]. Either
    /// would fail an unguarded `INSERT`: in the rung, where the conversion used to run, that
    /// stopped every launch of the reader's database for good; in the launch pass it would be a
    /// conversion that never happens, logged at every launch.
    ///
    /// The rung leaves all three overrides as they were. The conversion floors the negative count
    /// at 0, and skips the second pick of one printing rather than refusing it: the override
    /// first in `oracle_id` order keeps the entry — every device orders one synced row set
    /// alike, so each names the same winner and derives the same uid — and the other keeps its
    /// **count** as its token's implicit one, losing only the art.
    #[test]
    fn the_climb_and_the_conversion_are_total_over_a_negative_count_and_a_shared_printing() {
        let conn = user_file_at_51();
        conn.execute_batch(
            "INSERT INTO decks (id, name, format_key, created_at, updated_at)
                 VALUES (1, 'A', 'modern', 0, 0);
             INSERT INTO deck_tokens
                 (deck_id, oracle_id, card_id, quantity, created_at, updated_at, sync_uid)
                 VALUES (1, 'o-treasure', 'dfc', 4, 0, 0, 'u-treasure'),
                        (1, 'o-food', 'dfc', 2, 0, 0, 'u-food'),
                        (1, 'o-negative', 'p3', -2, 0, 0, 'u-negative');",
        )
        .unwrap();

        migrate_user(&conn).expect("no override a v51 file can hold may stop the climb");
        let untouched: i64 = conn
            .query_row(
                "SELECT count(*) FROM deck_tokens WHERE card_id IS NOT NULL",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(untouched, 3, "the climb leaves every pick where it was");
        crate::deck_tokens::convert_legacy_picks(&conn)
            .expect("no override a v51 file can hold may stop the conversion");

        let entries: Vec<(String, String, String, i64, String)> = conn
            .prepare(
                "SELECT card_id, variant, oracle_id, quantity, sync_uid FROM deck_token_printings
                  ORDER BY card_id, variant",
            )
            .unwrap()
            .query_map([], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .unwrap()
            .map(Result::unwrap)
            .collect();
        let entry = |card: &str, variant: &str, oracle: &str, quantity: i64, uid: &str| {
            (
                card.to_owned(),
                variant.to_owned(),
                oracle.to_owned(),
                quantity,
                uid.to_owned(),
            )
        };
        assert_eq!(
            entries,
            [
                entry("dfc", "live", "o-food", 2, "u-food-live"),
                entry("dfc", "theory", "o-food", 2, "u-food-theory"),
                entry("p3", "live", "o-negative", 0, "u-negative-live"),
                entry("p3", "theory", "o-negative", 0, "u-negative-theory"),
            ],
            "the shared printing is one entry per list, owned by the first oracle; the negative \
             count is floored at zero"
        );

        let overrides: Vec<(String, Option<String>, Option<i64>)> = conn
            .prepare("SELECT oracle_id, card_id, quantity FROM deck_tokens ORDER BY oracle_id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            overrides,
            [
                ("o-food".to_owned(), None, None),
                ("o-negative".to_owned(), None, None),
                ("o-treasure".to_owned(), None, Some(4)),
            ],
            "every art is legacy afterwards; the override that lost the printing keeps its count"
        );
    }

    /// **An override with no `sync_uid` is named before its entries derive from it.** The
    /// derived `<uid>-live` / `-theory` needs a uid to derive from, and a row written behind
    /// `capture::suppressed` has none — the insert trigger that mints one is guarded off there —
    /// while `NULL || '-live'` is NULL: the nameless row the derivation exists to prevent, since
    /// the first edit to it on a paired device emits an op with no uid. So the pick takes the
    /// insert trigger's own mint (32 lowercase hex) first, and its two entries are named after it
    /// like any other pick's — two rows on the wire, one name to derive them from. (Until the fifth
    /// review round each entry took a random uid of its own and the pick stayed nameless, which on
    /// a paired device failed the whole pass at the pick's clear;
    /// `deck_tokens::tests::a_nameless_pick_on_a_paired_device_is_named_and_stalls_no_peer` is that
    /// half, on the paired fixture this unpaired file cannot be.)
    #[test]
    fn the_launch_conversion_names_a_pick_with_no_uid_before_deriving_from_it() {
        let conn = user_file_at_51();
        conn.execute_batch(
            "INSERT INTO decks (id, name, format_key, created_at, updated_at)
                 VALUES (1, 'A', 'modern', 0, 0);
             INSERT INTO deck_tokens
                 (deck_id, oracle_id, card_id, quantity, created_at, updated_at, sync_uid)
                 VALUES (1, 'o1', 'p1', 3, 0, 0, NULL);",
        )
        .unwrap();

        migrate_user(&conn).unwrap();
        crate::deck_tokens::convert_legacy_picks(&conn).unwrap();

        let pick: String = conn
            .query_row("SELECT sync_uid FROM deck_tokens", [], |r| r.get(0))
            .expect("the pick is named before anything derives from it");
        assert!(
            pick.len() == 32
                && pick
                    .chars()
                    .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)),
            "{pick:?} is not the mint's 32 lowercase hex"
        );
        let uids: Vec<Option<String>> = conn
            .prepare("SELECT sync_uid FROM deck_token_printings ORDER BY variant")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(
            uids,
            [Some(format!("{pick}-live")), Some(format!("{pick}-theory"))],
            "one entry per list, each derived from the minted name — two rows on the wire"
        );
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

    /// The twin of `maintenance::a_launch_survives_a_repair_it_cannot_carry_out`, for the
    /// other non-fatal step. `init_state` turns a `prepare_database` error into "this file
    /// may be from a newer version of the app, or damaged — move it aside", which is a
    /// misleading thing to say about a database whose only problem is that the *disk* is
    /// full or read-only, and a useless thing to suggest to somebody who has no room to
    /// move it to. Space this drop would have reclaimed is not worth a launch.
    ///
    /// The failure is arranged with a view, because "the disk is full" is not something a
    /// test can stage hermetically: `DROP TABLE` refuses to delete a view by name, so the
    /// statement fails for a reason of its own while everything around it stays healthy.
    #[test]
    fn a_launch_survives_a_staging_drop_it_cannot_carry_out() {
        let conn = memory_pair();
        conn.execute_batch(&format!(
            "CREATE VIEW {CORPUS}.cards_staging AS SELECT 1 AS x;"
        ))
        .unwrap();

        prepare_database(&conn).expect("a launch must not die on a drop it cannot do");

        // The residue is still there, and still recorded where the next attempt looks —
        // `create_staging` at the next sync, `prepare_database` at the next launch.
        let still: i64 = conn
            .query_row(
                &format!("SELECT count(*) FROM {CORPUS}.sqlite_master WHERE name='cards_staging'"),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(still, 1, "the debt stays where a later run will find it");
    }

    /// A swap rebuilds the search index from scratch, so a rebuild an interrupted compaction
    /// was still owed has just been paid off by something else. Leaving the marker set would
    /// cost the next launch a silent rebuild of 116 k rows for work already done.
    #[test]
    fn a_swap_settles_a_rebuild_an_interrupted_compaction_owed() {
        let conn = memory_pair();
        crate::sync::set_meta(&conn, crate::maintenance::K_FTS_REBUILD_PENDING, "1").unwrap();
        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('new','Lightning Bolt','lea','161','en','normal','{}')", []).unwrap();

        swap_staging(&conn).unwrap();

        assert!(
            !crate::maintenance::fts_rebuild_is_pending(&conn),
            "the swap rebuilt the index, so nothing is owed"
        );
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "and it is the swap's own index that answers");
    }

    /// **Issue #180, and the test the reporter's bug is.** A database that held oracle tags
    /// before v20 can search them the moment it has been migrated — no refresh, no network.
    ///
    /// The failure this pins had every property that makes one expensive: silent, total,
    /// self-healing after up to a week, and sitting beside an art taxonomy that worked
    /// perfectly. v20 added `slug_norm` with `DEFAULT ''`, `tags::query` matches every typed
    /// needle against that column and nothing else, and the taxonomy is only rewritten by a
    /// refresh — which `tags::oracle::REFRESH_INTERVAL_SECS` puts up to seven days away. So the
    /// search answered `[]` to everything, with nothing in `error_log` to say why, while the
    /// rail — which reads `slug` and never `slug_norm` — went on listing the very tags the box
    /// could not find.
    ///
    /// **The fixture is the real upgrade path rather than a hand-built row**: a v19 database
    /// with a tag in it, walked up the whole ladder. A test that inserted `slug_norm = ''`
    /// into a head-version database would prove the backfill runs, not that the ladder ever
    /// reaches it.
    ///
    /// **The needle is spelled three ways and the slug is spelled in neither.** `Spot-Removal`
    /// is how the live file writes it — verified 2026-08-20, and `tags::oracle`'s own ingest
    /// test uses that exact slug — so a backfill that lower-cased without stripping, or
    /// stripped without lower-casing, would still answer one of these and fail the others.
    /// That is the whole hazard `tags::normalize`'s "one copy, deliberately" note describes:
    /// two normalisations that disagree leave both halves self-consistent and the search wrong.
    #[test]
    fn the_oracle_tag_search_answers_over_a_database_that_predates_the_normalised_slug() {
        let conn = v19_database();
        conn.execute_batch(
            "INSERT INTO oracle_tags (slug, label, description)
             VALUES ('Spot-Removal', 'Spot Removal', NULL);",
        )
        .unwrap();

        migrate_single_file(&conn).unwrap();

        // Exact, prefix and substring — the three bands `tags::query` ranks by, so a backfill
        // that satisfied `LIKE '%…%'` by accident could not also answer the exact one.
        for needle in ["Spot Removal", "spot-rem", "removal"] {
            let hits = crate::tags::query::run_tag_search(&conn, needle, "oracle", 50).unwrap();
            assert_eq!(
                hits.iter().map(|h| h.slug.as_str()).collect::<Vec<_>>(),
                ["Spot-Removal"],
                "`{needle}` found no oracle tag",
            );
        }

        // And it is `normalize`'s answer rather than merely *an* answer that matched. The
        // ingest writes this column with that function; a rung that agreed with it on
        // `Spot-Removal` and nowhere else would pass every assertion above.
        let norm: String = conn
            .query_row(
                "SELECT slug_norm FROM oracle_tags WHERE slug = 'Spot-Removal'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(norm, crate::tags::normalize("Spot-Removal"));
    }

    /// The rung over the version below it: a deck that already existed gains `bracket` reading
    /// **0**, which is Auto, and the three combo tables arrive.
    ///
    /// **The deck is seeded into the v25 fixture before the migration and not after**, which is
    /// the whole of what this test is for. A fresh install has no decks, so every deck in it is
    /// born with the column's DEFAULT and the question "what does an *existing* deck read" is
    /// one only an upgrade fixture can answer — the trap `src-tauri/CLAUDE.md` states as *a
    /// fresh worktree is a fresh install and is the one population that cannot show it*.
    #[test]
    fn v26_gives_an_existing_deck_the_auto_bracket_and_creates_the_combo_tables() {
        let conn = v25_database();
        let deck_id = deck(&conn, "Atraxa");
        assert_eq!(has_column(&conn, "decks", "bracket"), 0);

        migrate_single_file(&conn).unwrap();

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, LEGACY_SINGLE_FILE_VERSION);
        let bracket: i64 = conn
            .query_row("SELECT bracket FROM decks WHERE id = ?1", [deck_id], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            bracket,
            crate::deck::AUTO_BRACKET,
            "a deck that predates the column has not answered the question — it is on Auto"
        );
        assert_eq!(combo_table_count(&conn), 3);
    }

    /// **The range is not the database's**, and this is the assertion that says so out loud
    /// rather than leaving the next reader to discover it from a bug report.
    ///
    /// `ALTER TABLE … ADD COLUMN` *can* carry a CHECK — v19's `deck_cards.finish` does, and
    /// `the_deck_card_finish_column_refuses_nonfoil` proves it — so the absence of one here is
    /// a choice: a command parameter reaches this column, and `deck::valid_bracket` can say
    /// which number was wrong and what the legal ones are where `CHECK constraint failed` names
    /// only the constraint. `decks.game_key`'s arrangement, one column along.
    #[test]
    fn the_bracket_column_carries_no_check_because_rust_is_the_fence() {
        let conn = Connection::open_in_memory().unwrap();
        migrate_single_file(&conn).unwrap();
        let id = deck(&conn, "Atraxa");
        conn.execute("UPDATE decks SET bracket = 9 WHERE id = ?1", [id])
            .expect("the column itself takes any integer — the fence is deck::valid_bracket");
        assert_eq!(
            crate::deck::update_deck(
                &conn,
                id,
                &crate::deck::DeckPatch {
                    bracket: Some(9),
                    ..Default::default()
                },
            )
            .unwrap_err(),
            crate::deck::BAD_BRACKET,
            "and the command is where 9 is refused"
        );
    }
}
