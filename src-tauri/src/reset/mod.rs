//! **The desktop's half of `reset`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.

pub use grimoire_core::reset::*;

use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::sync::{with_write, AppState};

// ── The command wrappers ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn collection_clear(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<CollectionCleared, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // `with_write_owned` and not bare `with_write`. The facet index's `owned` bitset is
        // built by `collection_source::owned_rowids`, so this wipe moves it — and a skipped
        // rebuild would leave the search sidebar offering an Owned facet over a collection
        // that no longer exists.
        crate::collection_source::with_write_owned(&state, clear_collection)
    })
    .await
    .map_err(|e| format!("the collection could not be cleared: {e}"))?
}

#[tauri::command]
pub async fn wishlist_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, clear_wishlist))
        .await
        .map_err(|e| format!("the wishlist could not be cleared: {e}"))?
}

/// Empty every deck.
#[tauri::command]
pub async fn decks_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<DecksCleared, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
        // `collection_to_deck`/`deck_to_collection` DO move ownership and must use
        // `collection_source::with_write_owned` instead.
        with_write(&state, clear_decks)
    })
    .await
    .map_err(|e| format!("the decks could not be cleared: {e}"))?
}

/// Empty the picture cache and the download scratch directory.
///
/// **Refused outright while anything is downloading into `data/tmp/`**, which is the one guard
/// this command needs and the reason it is checked here rather than inside [`clear_cache`].
/// Every download there has a second phase that reads the file back: the corpus sync puts
/// `default-cards.jsonl.gz` there — 77 MB that an ingest then reads back — and the two price
/// feeds, the two Tagger datasets and the combo feed each download to a temp file and reopen
/// it to ingest. A sweep landing between the write and the read fails the job: for the sync, a
/// 90-second job the reader is watching a progress bar for; for the combo feed, another 27.5 MB
/// at the next launch. A refusal they can retry in a minute is the better trade, and
/// [`cache_clear_refusal`] is the whole list.
///
/// **This said the opposite about the feeds until 2026-09-27**: that the price-feed and Oracle
/// Tag downloads were *not* fenced, because each was a single button the reader pressed and
/// neither read its file back after closing it. Both halves had stopped being true — every one
/// of them ingests from the file it just closed, and the tag and combo refreshes run uninvited
/// at launch, which is exactly when a reader is likeliest to be in Settings.
///
/// **One narrow race is left, and it is accepted rather than missed.** The check is a read of
/// the flags, not a claim on them, so a refresh that *starts* after it and before the sweep
/// finishes can still have its temp file taken. The corpus sync's check has always had the
/// same window. Closing it would mean the sweep taking all five feeds' claims and the sync's
/// flag for its duration — refusing a launch refresh because the reader was clearing a cache —
/// to guard a collision that needs a launch task to start inside the few seconds of a sweep.
/// What it costs when it happens is one failed refresh, written to `error_log` with the
/// previous rows untouched, and retried at the next launch or press.
///
/// **The write lock is held for the `DELETE` and released before the sweep** — see
/// [`clear_cache`] for why, and for why it is that function's shape and not a habit here.
#[tauri::command]
pub async fn cache_clear(state: tauri::State<'_, Arc<AppState>>) -> Result<CacheCleared, String> {
    let state = state.inner().clone();
    if let Some(refusal) = cache_clear_refusal(state.syncing.load(Ordering::Relaxed)) {
        return Err(refusal.to_owned());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let images = state.images.dir().to_path_buf();
        let tmp = state.data_dir.join("tmp");
        clear_cache(
            || with_write(&state, forget_image_rows),
            &images,
            &tmp,
            &state.images,
        )
    })
    .await
    .map_err(|e| format!("the cache could not be cleared: {e}"))?
}

/// The one test of the cache sweep that could not go home with it: it makes a symlink with a
/// Windows call, behind a platform gate, and the core keeps those under `platform/` — in its
/// tests too. It drives the core's `clear_cache`.
///
/// **The gate is on the module and not on the test**: a module holding nothing but a
/// Windows-only test is two unused imports on every other target, which is what CI's Linux
/// clippy refuses.
#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use grimoire_core::reset::fixtures::*;

    /// A symlink is unlinked, never followed. The sweep would otherwise walk into whatever a
    /// link in the data directory points at — which on a portable install beside the reader's
    /// own folders is not a theoretical target.
    #[test]
    fn the_cache_sweep_unlinks_rather_than_follows() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&images).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let kept = outside.join("precious.txt");
        std::fs::write(&kept, b"not the cache's").unwrap();
        // Creating a symlink needs Developer Mode or an elevated shell; where it is refused
        // there is nothing to assert and the guarantee is the OS's rather than ours.
        if std::os::windows::fs::symlink_file(&kept, images.join("link.txt")).is_err() {
            return;
        }
        let cache = crate::images::Cache::new(images.clone());
        let conn = db();

        clear_cache(
            || forget_image_rows(&conn),
            &images,
            &dir.path().join("tmp"),
            &cache,
        )
        .unwrap();

        assert!(kept.exists(), "the link's target must survive");
        assert!(!images.join("link.txt").exists(), "the link itself must go");
    }
}
