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
//! runs exactly as it did before this feature existed. Every failure is logged and dropped.
//!
//! One window is known and left open: a collection write that commits *during* a build lands
//! in neither the build's snapshot nor [`invalidate_owned`], which returns early while the
//! index is cold. It costs an `owned` count that is one row behind until the next collection
//! write, sync or launch, and closing it would mean either a dirty flag threaded through the
//! build or a ~767 ms build on a quick-add. The window is the length of one build.

use super::CardIndex;
use crate::sync::AppState;
use std::sync::Arc;

/// The current index, or `None` while it is cold.
///
/// Clones the `Arc` and drops the read guard at once, deliberately: a facet pass is then
/// free to take as long as it likes over a snapshot nobody can pull out from under it, and a
/// sync's rebuild never waits on a reader.
pub fn current(state: &AppState) -> Option<Arc<CardIndex>> {
    crate::db::lock_read(&state.index).clone()
}

/// Go cold, now.
///
/// The first half of every rebuild, and callable on its own for the moment a swap has landed
/// but the run that owes the rebuild has not finished — see `sync::do_sync`, which clears
/// here and builds several seconds later.
pub fn clear(state: &AppState) {
    *crate::db::lock_write(&state.index) = None;
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
    clear(state);
    // Spelled here and in `lib.rs`'s `init_state`, which is the one that creates it.
    let conn = crate::db::open_read_only(&state.data_dir.join("mtg.db"))
        .map_err(|e| format!("index connection: {e}"))?;
    let ix = CardIndex::build(&conn).map_err(|e| format!("index build: {e}"))?;
    *crate::db::lock_write(&state.index) = Some(Arc::new(ix));
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
    let Some(current) = current(state) else {
        return;
    };
    let Ok(conn) = crate::db::open_read_only(&state.data_dir.join("mtg.db")) else {
        return;
    };
    let mut next = (*current).clone();
    if let Err(e) = next.rebuild_owned(&conn) {
        eprintln!("the owned facet could not be refreshed: {e}");
        return;
    }
    *crate::db::lock_write(&state.index) = Some(Arc::new(next));
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
