//! Owning [`super::CardIndex`] across the app's life: the warm-up build, the rebuild every
//! sync's staging swap owes it, and the cheap `owned` refresh a collection write owes it.
//!
//! **It is derived from `cards`, which every sync drops and recreates.** That renumbers
//! rowids, so a stale index does not go gently out of date — it points at the wrong cards.
//! Every rebuild therefore replaces the whole thing; nothing is amended in place except
//! `owned`, which is the one dimension a user changes without a sync.
//!
//! **Cold is a supported state, not an error, and it is the only safe guess.** For the length
//! of a build the app answers `ready: false` and every filter control stays live, because
//! [`super::facets::compute`] counts an option the index has never heard of as **zero** — so
//! an index one sync behind greys out sets the search would happily return printings for.
//! Not-greyed means "we do not know"; greyed means "this is empty". Only one of those is
//! safe to guess wrong, which is why every path here **clears before it fills** rather than
//! keeping the old index visible and swapping at the end. Serving stale counts is worse than
//! serving none.
//!
//! **Nothing here is fatal.** The index is an optimisation: if it cannot be built the app
//! runs exactly as it did before this feature existed. Every failure is logged and dropped —
//! logged in both senses since the error log landed: an `eprintln!` for a dev console, and a
//! row in `error_log` for the shipped build, which has no console for the first to print to.
//! **A cold index is otherwise completely silent by design** — the UI's answer to one is to
//! leave every control live, which looks exactly like a warm index that greyed nothing — so
//! this is the only place a failed build is ever mentioned.
//!
//! One window is known and left open: a collection write that commits *during* a build lands
//! in neither the build's snapshot nor [`invalidate_owned`], which returns early while the
//! index is cold. It costs an `owned` count that is one row behind until the next collection
//! write, sync or launch, and closing it would mean either a dirty flag threaded through the
//! build or a ~767 ms build on a quick-add. The window is the length of one build.

use super::CardIndex;
use crate::sync::AppState;
use std::sync::Arc;

/// Write a failed index build down where a user can see it.
///
/// [`crate::errors::Source::Database`] and [`crate::errors::Kind::Io`], the same pair
/// `sync.rs`'s `note_database` uses for a sweep, a reclaim or a compaction: this is the app's
/// own SQLite failing at its own work, and the fix is a disk or a database rather than a
/// query.
///
/// Best-effort and never waited on, for the reason every caller here is: the index is an
/// optimisation, this describes a failure that has already been absorbed, and nothing about
/// recording it is worth blocking a launch or a sync over.
///
/// **Safe to take the write lock from every call site, and that is checked rather than
/// assumed.** `spawn_build` runs on a thread of its own holding nothing, and
/// `collection::with_write_owned` — the one caller of [`invalidate_owned`] that has just
/// written — releases its guard *before* calling in, which its own doc names as the house
/// rule. Recording from inside a held guard is the deadlock `do_sync`'s orphan-sweep arm
/// avoids by passing its connection down instead.
fn note_index_failure(state: &AppState, operation: &str, message: &str) {
    if let Some(conn) = crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        crate::errors::record(
            &conn,
            crate::errors::Source::Database,
            operation,
            crate::errors::Kind::Io,
            message,
            None,
        );
    }
}

/// What [`crate::sync::AppState`] holds: the published index, and the generation of the
/// corpus it was built against.
///
/// **The two are one lock and not an index plus an `AtomicU64` beside it**, because the
/// counter is only ever read or written while holding this lock — an atomic sibling would be
/// a field that belongs in here wearing a workaround for not being, and it would leave
/// "re-check the generation *under the write guard*" as a rule to remember rather than the
/// only thing the code can express.
#[derive(Default)]
pub struct IndexSlot {
    /// Bumped by every [`clear`]. A rebuild reads it on entry and refuses to publish a result
    /// built against a generation that has since moved — see [`publish_build`].
    generation: u64,
    index: Option<Arc<CardIndex>>,
}

/// The current index, or `None` while it is cold.
///
/// Clones the `Arc` and drops the read guard at once, deliberately: a facet pass is then
/// free to take as long as it likes over a snapshot nobody can pull out from under it, and a
/// sync's rebuild never waits on a reader.
pub fn current(state: &AppState) -> Option<Arc<CardIndex>> {
    crate::db::lock_read(&state.index).index.clone()
}

/// Go cold, now, and answer the generation that starts here.
///
/// The first half of every rebuild, and callable on its own for the moment a swap has landed
/// but the run that owes the rebuild has not finished — see `sync::do_sync`, which clears
/// here and builds several seconds later.
///
/// The returned generation is what a rebuild carries to its publish. Returned rather than
/// re-read, because re-reading it is itself a race: a second clear between the two would be
/// invisible.
pub fn clear(state: &AppState) -> u64 {
    let mut slot = crate::db::lock_write(&state.index);
    slot.index = None;
    slot.generation += 1;
    slot.generation
}

/// Publish a freshly built index, **unless a clear landed while it was being built**.
///
/// Clearing first only makes staleness impossible against *one* operation at a time. Two are
/// reachable: `setup` spawns the launch build, and a legacy database's first sync reaches
/// `compact_once`'s `VACUUM` clear 0.5–2 s later — well inside a build whose 767 ms was
/// measured warm and has never been measured cold. Without this check that build lands after
/// the clear and republishes a pre-`VACUUM` index for the 22–37 s of the conversion, which is
/// the exact harm clearing first exists to prevent.
///
/// Answers whether it landed. A refusal is not a failure: the clear that superseded it belongs
/// to something that owes a rebuild of its own.
fn publish_build(state: &AppState, generation: u64, ix: CardIndex) -> bool {
    let mut slot = crate::db::lock_write(&state.index);
    if slot.generation != generation {
        return false;
    }
    slot.index = Some(Arc::new(ix));
    true
}

/// Publish an amended copy, **unless the copy it was made from has been replaced**.
///
/// [`invalidate_owned`] clones the live index and then re-reads `owned` from the database, and
/// those are two moments: a swap landing between them leaves the copy's corpus bitsets on one
/// generation of rowids and its `owned` bits on the next — the same split-snapshot hazard
/// [`CardIndex::build`] closes with a read transaction, which cannot help here because half of
/// the pair is in memory and not in the database at all. Identity is what closes it instead: if
/// the slot no longer holds the exact `Arc` the copy was made from, the copy describes a corpus
/// the app has stopped believing in.
///
/// `Arc::ptr_eq` rather than the generation, and it is strictly stronger here — a clear is not
/// the only thing that can supersede an amendment. Two collection writes racing each other
/// clone the same base, and without this the slower one's re-read wins and the faster one's
/// row is lost until the next write.
fn publish_amendment(state: &AppState, base: &Arc<CardIndex>, ix: CardIndex) -> bool {
    let mut slot = crate::db::lock_write(&state.index);
    if !slot
        .index
        .as_ref()
        .is_some_and(|live| Arc::ptr_eq(live, base))
    {
        return false;
    }
    slot.index = Some(Arc::new(ix));
    true
}

/// Read the corpus and publish a new index, **clearing the old one first**.
///
/// Clearing first is the whole contract and not tidiness: the caller is a swap that has just
/// renumbered every rowid, so from the moment it lands the published index answers about
/// other cards. Cold for ~767 ms is an honest "we do not know"; warm and wrong is a set the
/// user cannot click because a facet said it was empty. It is also what makes a *failed*
/// build safe — the app is left with no index rather than the last one.
///
/// The connection is its **own**, never `AppState.db_read`. This is a full pass over `cards`
/// and holding the read connection for it would queue every search behind it at launch,
/// which is the exact failure that second connection exists to prevent.
pub fn build_now(state: &AppState) -> Result<(), String> {
    let generation = clear(state);
    // Spelled here and in `lib.rs`'s `init_state`, which is the one that creates it.
    let conn = crate::db::open_read_only(&state.data_dir.join("mtg.db"))
        .map_err(|e| format!("index connection: {e}"))?;
    let ix = CardIndex::build(&conn).map_err(|e| format!("index build: {e}"))?;
    if !publish_build(state, generation, ix) {
        // Not an error: something cleared while this ran, and whatever cleared owes a rebuild
        // of its own. Said out loud because it is also the trace of the two-rebuild
        // interleaving being real on this machine.
        eprintln!("a card index build was superseded while it ran and was dropped");
    }
    Ok(())
}

/// [`build_now`] off the calling thread, going cold **before** it returns.
///
/// The clear is taken here rather than left to the spawned thread so that the guarantee is
/// the caller's: `sync` returns from this line with the index already cold, whatever the
/// scheduler does with the new thread next. [`build_now`] clears again on arrival, which
/// costs one uncontended lock and keeps the same guarantee for a direct call.
///
/// The handle is returned so a test can join it; the three production call sites drop it and
/// let the thread run detached. A failure is logged and nothing else — see the module docs.
pub fn spawn_build(state: &Arc<AppState>) -> std::thread::JoinHandle<()> {
    clear(state);
    let state = state.clone();
    std::thread::spawn(move || {
        if let Err(e) = build_now(&state) {
            eprintln!("card index unavailable, facets will stay open: {e}");
            // Recorded here and not in `build_now`, which returns its error for the caller to
            // decide about — the direct callers are tests, and this is the only production
            // path.
            note_index_failure(&state, "index_build", &e);
        }
    })
}

/// Re-read the `owned` dimension after a collection write, leaving the rest of the index be.
///
/// 10–23 ms against ~767 ms for a full rebuild, which is why this exists as its own entry
/// point: the collection changes far more often than the corpus, and a quick-add cannot cost
/// a full read of `cards`.
///
/// **A cold index stays cold.** Building one here would spend that ~767 ms on a button press,
/// and blanking one is not on the table either — the index is copied, amended and published,
/// so a reader mid-pass keeps the snapshot it already holds.
///
/// The copy is a real one: `CardIndex` is ~1 MB of bitsets and ordinals over the live corpus,
/// and every byte of it is memcpy'd. Copy-on-write rather than mutation because the published
/// index is behind an `Arc` that readers are holding — there is no `&mut` to be had, and
/// there should not be.
pub fn invalidate_owned(state: &AppState) {
    let Some(base) = current(state) else {
        return;
    };
    let Ok(conn) = crate::db::open_read_only(&state.data_dir.join("mtg.db")) else {
        return;
    };
    let mut next = (*base).clone();
    if let Err(e) = next.rebuild_owned(&conn) {
        eprintln!("the owned facet could not be refreshed: {e}");
        note_index_failure(state, "index_owned_refresh", &e.to_string());
        return;
    }
    // Dropped in silence if the base is gone: a sync taking the index cold underneath a
    // quick-add is ordinary, and the sync's own rebuild is the answer to it.
    publish_amendment(state, &base, next);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::index::fixtures::{own, state_with_seeded_cards};

    /// Cold is a real state and the app has to answer in it — for the length of the build
    /// after launch, and again after every sync swap. `current` returning `None` is what
    /// makes every facet fail OPEN.
    #[test]
    fn an_unbuilt_index_reads_as_absent_rather_than_empty() {
        let state = state_with_seeded_cards("cold");
        assert!(current(&state).is_none());
    }

    #[test]
    fn a_built_index_is_published_and_readable() {
        let state = state_with_seeded_cards("built");
        build_now(&state).unwrap();
        assert_eq!(current(&state).unwrap().paper.count(), 3);
    }

    /// A sync renumbers every rowid, so a stale index does not merely go out of date — it
    /// points at the wrong cards. Rebuilding must replace it wholesale, and a reader still
    /// holding the old `Arc` must keep reading the old answers rather than a half-rebuilt one.
    #[test]
    fn a_rebuild_replaces_the_index_rather_than_amending_it() {
        let state = state_with_seeded_cards("rebuild");
        build_now(&state).unwrap();
        let before = current(&state).unwrap();
        {
            let conn = crate::db::lock_blocking(&state.db);
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
                 VALUES ('99','New Card','neo','1','en','normal',1,'{}')",
                [],
            )
            .unwrap();
        }
        build_now(&state).unwrap();
        let after = current(&state).unwrap();
        assert_eq!(
            before.paper.count(),
            3,
            "the old index is untouched, not mutated"
        );
        assert_eq!(after.paper.count(), 4);
    }

    /// **The one that has teeth.** A build reads a corpus a swap has just renumbered, so the
    /// index has to go cold *before* the read rather than be replaced after it: an
    /// implementation that keeps the old one visible and swaps at the end passes every other
    /// test in this file and serves an index pointing at the wrong cards for the whole ~767 ms
    /// of the rebuild — and for good, if the rebuild then fails.
    ///
    /// Dropping `cards` is not a contrivance: it is the first half of what
    /// [`crate::schema::swap_staging`] does on every sync, so this is the real mid-swap
    /// moment with the second half never arriving.
    #[test]
    fn a_build_that_cannot_read_the_corpus_leaves_the_index_cold_rather_than_stale() {
        let state = state_with_seeded_cards("failed");
        build_now(&state).unwrap();
        assert!(current(&state).is_some(), "warm to begin with");

        {
            let conn = crate::db::lock_blocking(&state.db);
            conn.execute_batch("DROP TABLE cards;").unwrap();
        }
        assert!(
            build_now(&state).is_err(),
            "the build cannot read the corpus"
        );
        assert!(
            current(&state).is_none(),
            "a failed rebuild must leave the app with no index, never with the last one"
        );
    }

    /// The collection changes far more often than the corpus, and a full rebuild per
    /// quick-add would be ~767 ms of work for one row.
    #[test]
    fn a_collection_write_rebuilds_only_the_owned_dimension() {
        let state = state_with_seeded_cards("owned");
        build_now(&state).unwrap();
        let before = current(&state).unwrap();
        assert_eq!(before.owned.count(), 0);
        {
            let conn = crate::db::lock_blocking(&state.db);
            own(&conn, "1", 1);
        }
        invalidate_owned(&state);

        let after = current(&state).unwrap();
        assert_eq!(after.owned.count(), 1);
        assert_eq!(after.paper.count(), 3, "and the corpus is carried over");
        assert_eq!(
            before.owned.count(),
            0,
            "the published index a reader already holds is never mutated under it"
        );
    }

    /// A collection write must not go cold, and must not build. Going cold would blank every
    /// facet count on a quick-add; building would spend ~767 ms on a button press. So the one
    /// state where `invalidate_owned` does nothing at all is the state where there is nothing
    /// to amend.
    #[test]
    fn a_collection_write_neither_builds_nor_blanks_a_cold_index() {
        let state = state_with_seeded_cards("cold-owned");
        {
            let conn = crate::db::lock_blocking(&state.db);
            own(&conn, "1", 1);
        }
        invalidate_owned(&state);
        assert!(
            current(&state).is_none(),
            "a cold index stays cold — a quick-add is not the place to spend a full build"
        );
    }

    /// One printing's worth of index, built the way [`build_now`] builds it — the thing a
    /// rebuild is holding in its hands when the moment below arrives.
    fn built(state: &AppState) -> CardIndex {
        let conn = crate::db::open_read_only(&state.data_dir.join("mtg.db")).unwrap();
        CardIndex::build(&conn).unwrap()
    }

    /// **Clearing first is only half of it.** A rebuild reads its generation, spends ~767 ms
    /// in the database and then publishes — and a clear that lands in between is silently
    /// undone by an unconditional publish. Reachable at launch: `setup` spawns the build, and
    /// a legacy database's first sync reaches `compact_once`'s `VACUUM` clear 0.5–2 s later.
    ///
    /// The race is not simulated here — a build over four rows takes microseconds and there is
    /// no seam to park one in — so this drives the decision the race comes down to at exactly
    /// the point `build_now` makes it, with the interleaving arranged by hand.
    #[test]
    fn a_build_superseded_while_it_ran_is_dropped_rather_than_published() {
        let state = state_with_seeded_cards("superseded");

        // Nothing moved: the build lands, which is the ordinary case and the control.
        let generation = clear(&state);
        assert!(publish_build(&state, generation, built(&state)));
        assert_eq!(current(&state).unwrap().paper.count(), 3);

        // And now the real one. A build starts...
        let generation = clear(&state);
        let ix = built(&state);
        // ...a swap lands and takes the index cold while it is still reading...
        clear(&state);
        // ...and the build must not undo that clear on its way past.
        assert!(
            !publish_build(&state, generation, ix),
            "a build against a superseded generation must not publish"
        );
        assert!(
            current(&state).is_none(),
            "cold, rather than warm with an index of a corpus that has left"
        );
    }

    /// The same hazard on the cheap path, and worse there: an amendment carries the **old**
    /// index's corpus bitsets and a **new** read of `owned`, so publishing one over a swap
    /// does not merely go stale, it mixes two generations of rowids in one index. The read
    /// transaction inside `CardIndex::build` cannot help — half of this pair is in memory.
    ///
    /// The last case is the side benefit: identity catches a *sibling* amendment too, so two
    /// collection writes racing cannot end with the slower one's re-read winning.
    #[test]
    fn an_amendment_whose_base_has_been_replaced_is_dropped() {
        let state = state_with_seeded_cards("amendment");
        build_now(&state).unwrap();
        let base = current(&state).unwrap();

        // The control: the base is still the live index, so the amendment lands.
        assert!(publish_amendment(&state, &base, (*base).clone()));

        // A swap takes the index cold while the amendment is being read.
        let base = current(&state).unwrap();
        let amended = (*base).clone();
        clear(&state);
        assert!(!publish_amendment(&state, &base, amended));
        assert!(current(&state).is_none(), "and it stays cold");

        // And a base that was replaced rather than cleared is just as gone.
        build_now(&state).unwrap();
        let stale = current(&state).unwrap();
        let amended = (*stale).clone();
        build_now(&state).unwrap();
        assert!(
            !publish_amendment(&state, &stale, amended),
            "an amendment of an index nobody is publishing any more is not an amendment"
        );
        assert_eq!(
            current(&state).unwrap().paper.count(),
            3,
            "the live index is left exactly as it was"
        );
    }

    /// The wrapper the three call sites actually use: it must run the build, and it must not
    /// make the caller wait for it.
    #[test]
    fn a_spawned_build_publishes_off_the_calling_thread() {
        let state = state_with_seeded_cards("spawned");
        spawn_build(&state).join().unwrap();
        assert_eq!(current(&state).unwrap().paper.count(), 3);
    }

    /// Nothing here may be fatal. A build that cannot run leaves the app exactly as it was
    /// before this feature existed: cold index, facets open, no panic out of the thread.
    #[test]
    fn a_spawned_build_that_fails_is_logged_and_survived() {
        let state = state_with_seeded_cards("spawn-fails");
        {
            let conn = crate::db::lock_blocking(&state.db);
            conn.execute_batch("DROP TABLE cards;").unwrap();
        }
        spawn_build(&state)
            .join()
            .expect("a failed build must not panic the thread it runs on");
        assert!(current(&state).is_none());
    }
}
