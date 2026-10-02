//! **The bulk-file ingest is `grimoire-core`'s, re-exported here beside the one test that names
//! a module this crate keeps.**
//!
//! `a_writer_gets_the_connection_between_batches_of_an_ingest` builds its database with
//! [`crate::split::convert`], and `split` — the pre-27 single file's conversion — is the
//! desktop's for good. The test is here unedited; everything else of the module, code and
//! tests, is in `crates/grimoire-core/src/ingest.rs`.

pub use grimoire_core::ingest::*;

#[cfg(test)]
mod tests {
    use super::*;
    use grimoire_core::ingest::fixtures::*;

    /// The whole point of chunking. Plan 3 writes user rows from commands, and the ingest
    /// used to hold `AppState.db` for its entire ~44 s run — so an "Add to collection"
    /// during the daily sync was a frozen button. Now the load commits every `BATCH` rows
    /// and drops the guard between batches, so the longest anyone waits is one batch.
    ///
    /// The probe runs on another thread, as a command would, and asks with a bound. What
    /// makes the count mean something is *when* a take is allowed to count: only between
    /// the first progress callback (the first batch has committed, so the ingest is
    /// demonstrably mid-run and using the connection) and the ingest returning. A take won
    /// before the ingest got going, or in the instant after it finished, is discarded.
    ///
    /// Without that window the assertion is decoration: an ingest that held the connection
    /// from end to end would simply make the probe wait, and it would then collect three
    /// locks from an idle mutex and pass. With it, the same regression scores zero.
    #[test]
    fn a_writer_gets_the_connection_between_batches_of_an_ingest() {
        use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

        let dir = crate::scratch::path("ingest-chunked");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        // **The corpus is brought to head, because a launch brings it to head** —
        // `index::fixtures::state_with_seeded_cards`' line and its whole argument. `convert`
        // builds the file through the frozen `migrate_single_file` ladder and *then* stamps
        // `CORPUS_SCHEMA_VERSION` on it, so what comes out wears head while carrying whatever
        // shape that ladder last built; `db::open_write` migrates nothing, by design. Without
        // this line the fixture is a database no launch can produce, and corpus schema 3 is
        // where that stopped being invisible: the `cards` this ingest stages from had no
        // `produced_mana`, and the run died on `table cards_staging has no column named
        // produced_mana` — the exact field failure the rung's shape gate exists to prevent.
        crate::schema::migrate_corpus(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);

        // Eight batches' worth. Only the seven release points *after* the first batch
        // count, so the run has to have plenty of them left once counting opens.
        let rows: Vec<String> = (0..BATCH * 8).map(card_line).collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        let p = gz_fixture(&lines);

        let taken = AtomicUsize::new(0);
        let ingesting = AtomicBool::new(false);
        let done = AtomicBool::new(false);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                // Runs for the length of the ingest, asking the way a command asks.
                while taken.load(Ordering::SeqCst) < 3 && !done.load(Ordering::SeqCst) {
                    let won =
                        crate::db::lock_for(&db, std::time::Duration::from_millis(200)).is_some();
                    if won && ingesting.load(Ordering::SeqCst) && !done.load(Ordering::SeqCst) {
                        taken.fetch_add(1, Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            });
            // The first progress call is the first committed batch: from here the ingest
            // is unambiguously running, and every lock it gives up is one it chose to.
            let stats = ingest_gz(&db, &p, &mut |_| ingesting.store(true, Ordering::SeqCst));
            // Set before any assertion: a panic here must still release the probe, or
            // the scope would join a thread that never leaves its loop.
            done.store(true, Ordering::SeqCst);
            assert_eq!(stats.unwrap().inserted, BATCH * 8);
        });

        assert!(
            taken.load(Ordering::SeqCst) >= 3,
            "a writer must be able to take the connection while the ingest is running, \
             and took it {} times",
            taken.load(Ordering::SeqCst)
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
