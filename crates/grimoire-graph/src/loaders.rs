//! The batches: what turns a nested field asked of every row of a list into one read.
//!
//! async-graphql's [`DataLoader`] collects every key a level of the answer asks for, waits a
//! millisecond for the rest of the level, and hands the whole set to [`Loader::load`] once. A
//! loader is made per execution ([`crate::Graph::run`]), so nothing is cached between two
//! documents and a write between them is always seen.
//!
//! **Where a batch runs.** The loader's future is handed to a spawner, and nothing here has a
//! runtime to spawn on: every caller is on a thread that may block. So each batch gets a thread
//! of its own and is driven to the end there — a widget's document has a handful of batch
//! levels, and a thread is a fraction of the one SQLite read it carries. The read takes the
//! read connection's lock and drops it inside `load`, as every resolver does.

use std::collections::HashMap;
use std::sync::Arc;

use async_graphql::dataloader::{DataLoader, Loader};
use async_graphql::futures_util::future::BoxFuture;
use grimoire_core::deck::{deck_values_for, DeckValue};
use grimoire_core::deck_notes::{list_notes_of_decks, DeckNoteRow};
use grimoire_core::sorting::Marketplace;
use grimoire_core::state::State;

fn on_a_thread_of_its_own(batch: BoxFuture<'static, ()>) {
    std::thread::spawn(move || futures_executor::block_on(batch));
}

/// A loader whose batches a test counts. **A wider window under test, and nothing in a build.** A
/// level's keys are all asked in one pass, but a loaded CI runner can stop that thread for longer
/// than the 1 ms a batch waits, and the keys after it would be a second, harmless read that
/// fails an exact count. What the tests hold is that one pass is one batch, not the runner's timing.
#[cfg(test)]
pub(crate) fn counted<T: Send + Sync + 'static>(loader: DataLoader<T>) -> DataLoader<T> {
    loader.delay(std::time::Duration::from_millis(50))
}

#[cfg(not(test))]
pub(crate) fn counted<T>(loader: DataLoader<T>) -> DataLoader<T> {
    loader
}

/// Every deck's deck notes, for the decks a level of the answer asked about.
pub struct DeckNotes(Arc<State>);

impl Loader<i64> for DeckNotes {
    type Value = Vec<DeckNoteRow>;
    type Error = Arc<String>;

    async fn load(&self, keys: &[i64]) -> Result<HashMap<i64, Self::Value>, Self::Error> {
        #[cfg(test)]
        crate::batches::ran(crate::batches::Batch::DeckNotes, &self.0);
        list_notes_of_decks(&self.0.lock_db_read(), keys).map_err(Arc::new)
    }
}

pub fn deck_notes(state: &Arc<State>) -> DataLoader<DeckNotes> {
    counted(DataLoader::new(
        DeckNotes(state.clone()),
        on_a_thread_of_its_own,
    ))
}

/// One deck's worth at one marketplace — the key a `value(marketplace:)` edge asks for.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ValueKey {
    pub marketplace: String,
    pub deck_id: i64,
}

/// Every deck's worth, read once per marketplace the level asked about: `deck_values_for`
/// answers every deck in one statement, so the batch is the marketplaces, not the decks.
pub struct DeckValues(Arc<State>);

impl Loader<ValueKey> for DeckValues {
    type Value = DeckValue;
    type Error = Arc<String>;

    async fn load(&self, keys: &[ValueKey]) -> Result<HashMap<ValueKey, Self::Value>, Self::Error> {
        let mut marketplaces: Vec<&str> = keys.iter().map(|k| k.marketplace.as_str()).collect();
        marketplaces.sort_unstable();
        marketplaces.dedup();
        let conn = self.0.lock_db_read();
        let mut out = HashMap::new();
        for marketplace in marketplaces {
            let values =
                deck_values_for(&conn, Marketplace::from_id(marketplace)).map_err(Arc::new)?;
            for value in values {
                let key = ValueKey {
                    marketplace: marketplace.to_owned(),
                    deck_id: value.deck_id,
                };
                out.insert(key, value);
            }
        }
        Ok(out)
    }
}

pub fn deck_values(state: &Arc<State>) -> DataLoader<DeckValues> {
    DataLoader::new(DeckValues(state.clone()), on_a_thread_of_its_own)
}
