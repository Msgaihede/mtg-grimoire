//! How many batches a loader has run **for one [`State`]** — what the batch tests assert on.
//!
//! One count per state and not one per process, because every test has a state of its own and
//! they all run at once: a process-wide counter is moved by whichever test is beside the one
//! reading it, so that test could only ever take the smaller of two runs and hope. A state's own
//! count is moved by nothing but the documents run against it, so a test reads the exact figure.
//!
//! Keyed by the state's address. A loader holds its `Arc` until its batch has run, and a test holds
//! its own for as long as it reads, so an address cannot be reused under a count being read.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};

use grimoire_core::state::State;

/// The loaders whose batches are counted.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum Batch {
    DeckNotes,
    CollectionFolders,
    OracleTags,
    PerDeck,
}

static COUNTS: Mutex<BTreeMap<(Batch, usize), usize>> = Mutex::new(BTreeMap::new());

fn key(batch: Batch, state: &Arc<State>) -> (Batch, usize) {
    (batch, Arc::as_ptr(state) as usize)
}

/// One batch of `batch` ran against `state`.
pub(crate) fn ran(batch: Batch, state: &Arc<State>) {
    *COUNTS.lock().unwrap().entry(key(batch, state)).or_default() += 1;
}

/// How many batches of `batch` have run against `state`.
pub(crate) fn runs(batch: Batch, state: &Arc<State>) -> usize {
    COUNTS
        .lock()
        .unwrap()
        .get(&key(batch, state))
        .copied()
        .unwrap_or(0)
}
