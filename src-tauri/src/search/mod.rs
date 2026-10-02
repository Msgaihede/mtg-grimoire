//! **The desktop's half of `search`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::search::*;

use crate::sync::{lock_db_read, AppState};
use std::sync::Arc;

/// [`run_search_marks`] over the read connection, for [`search_cards`]' reasons.
#[tauri::command]
pub async fn search_marks(
    state: tauri::State<'_, Arc<AppState>>,
    req: MarksRequest,
) -> Result<Vec<CardMarks>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_search_marks(&lock_db_read(&state), &req))
        .await
        .map_err(|e| format!("search marks could not be read: {e}"))?
}

/// Search the card database.
///
/// Runs on the **read-only** connection, which is the whole reason there is one: the
/// writer's longest job is the ingest, ~80 s of a 92–99 s sync, and a search sharing its
/// mutex would queue behind it — the app would stop answering searches once a day for the
/// length of a sync. Chunking the ingest bounded that wait to one 2 000-row batch, but a
/// search must not wait for a batch either: 20 timed searches across a live sync, every
/// one correct, none stalled. Under WAL a reader sees the last committed snapshot
/// without blocking, so it
/// answers immediately with the pre-swap card data, which is exactly right.
///
/// `async` + `spawn_blocking`, not a plain sync command: a sync command body runs inline
/// on the IPC thread, and SQLite work is blocking. `lock_db_read` is shared with `sync`
/// so poison recovery has one definition.
#[tauri::command]
pub async fn search_cards(
    state: tauri::State<'_, Arc<AppState>>,
    req: SearchRequest,
) -> Result<SearchResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_search(&lock_db_read(&state), &req))
        .await
        .map_err(|e| format!("search could not be run: {e}"))?
}

/// The set list, for the search filter. Read-only connection, blocking pool — as
/// [`search_cards`] is, and for the same reason.
#[tauri::command]
pub async fn list_sets(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<SetSummary>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_list_sets(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("set list could not be read: {e}"))?
}

/// The tests of `search` that name something this crate still holds. Each goes home when what it
/// names does.
#[cfg(test)]
mod tests {
    use super::*;

    /// The reason there are two connections. A search must answer while an ingest holds
    /// the write connection — under WAL the reader sees the last committed snapshot and
    /// never waits, and the only thing that used to serialise them was sharing one
    /// `Mutex<Connection>`. This test holds that lock outright, which is the guarantee
    /// being pinned: the chunked ingest releases it between batches, so a search that only
    /// answered in those gaps would still pass a gentler test and still stall a reader for
    /// the length of a batch. Run from another thread, as the real command is, so a
    /// regression to the shared lock fails here in five seconds rather than hanging the
    /// suite.
    #[test]
    fn a_search_answers_while_an_ingest_holds_the_write_connection() {
        use crate::sync::lock_db_read;
        use std::sync::atomic::AtomicBool;

        let dir = crate::scratch::path("search-concurrent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();

        let write = crate::db::open_write(&dir).unwrap();
        write.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw) VALUES ('1','Lightning Bolt','lea','161','en','normal',1,'{}')", []).unwrap();
        let read = crate::db::open_read(&dir).unwrap();

        // **Hooked up, so what these fixtures drive runs with the cross-file fence
        // armed.** `State::new` installs it, `crate::sync::with_write`'s `debug_assert`
        // reads it, so a command that committed to both files fails its own test rather
        // than printing a line nobody reads. The desktop's three observers ride along as
        // they do in the app, and nothing here looks at them: the wake is a throwaway,
        // since nothing in this fixture starts `sync_engine::live`.
        let mirror = std::sync::Arc::new(crate::mirror::watch::Mask::default());
        let changes = std::sync::Arc::new(crate::changes::Changes::new());
        let state = Arc::new(AppState {
            core: grimoire_core::state::State::new(
                write,
                Some(read),
                dir.clone(),
                grimoire_core::events::silent(),
                crate::mirror::watch::observers(
                    mirror.clone(),
                    changes.clone(),
                    Default::default(),
                ),
            ),
            syncing: AtomicBool::new(true),
            client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            images: crate::images::Cache::new(dir.join("images")),
            index: std::sync::RwLock::default(),
            // The mirror is never started in these tests; a clean mask and an empty record are
            // what an `AppState` looks like before the first pass.
            mirror,
            mirror_status: std::sync::Mutex::new(crate::mirror::watch::LastPass::default()),
            pairing: std::sync::Mutex::new(None),
            changes,
        });

        // Stands in for the ingest, which holds this exact lock for the length of a sync.
        let held = state.db.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let state = state.clone();
            std::thread::spawn(move || {
                let req = SearchRequest {
                    limit: 10,
                    ..Default::default()
                };
                let _ = tx.send(run_search(&lock_db_read(&state), &req));
            });
        }
        let answered = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("search must not queue behind the write connection");
        drop(held);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);

        let r = answered.unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Lightning Bolt");
    }
}
