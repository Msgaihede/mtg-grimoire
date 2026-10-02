//! **The desktop's half of `reset`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.
//!
//! [`clear_cache`] and what only it calls are here for a different reason: they name
//! `images::Cache` and the three feeds, which move with the extraction's I/O step.

pub use grimoire_core::reset::*;

use rusqlite::Connection;
use std::fs;
use std::path::Path;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use crate::sync::{with_write, AppState};

/// What a directory sweep did, accumulated across a walk.
#[derive(Debug, Clone, Copy, Default)]
struct Swept {
    files: u64,
    bytes: u64,
    failed: u64,
}

/// Empty a directory of its contents, leaving the directory itself.
///
/// **The root survives on purpose and the children do not need to.** Every writer under these
/// two roots — [`crate::images::Cache::fetch_and_store`], the corpus download, the Oracle Tag
/// download, the price-feed download — `create_dir_all`s its own parent before writing, so a
/// shard directory that goes here is rebuilt by the first fetch that wants it. Leaving the
/// root is what keeps the *reported* data directory a directory that exists, which the
/// Settings page prints.
///
/// Depth is three (`images/<variant>/<shard>/`) and one (`tmp/`), so the recursion is bounded
/// by the layout rather than by a counter. A directory that cannot be read is skipped whole:
/// the caller's promise is "the cache is disposable", and a cache that is partly still there
/// costs a re-fetch rather than correctness — [`crate::images::Cache::get`] treats a row
/// whose file is gone as a miss, and so does every bulk download.
///
/// **[`clear_cache`] is its only caller, and its two roots are the whole of what this app ever
/// deletes recursively.** There was a third — `clear_decks` handed it the covers directory —
/// until custom deck covers were removed on 2026-08-31. Nothing should give this function a
/// fourth root without an argument for it: what it is handed, it empties.
fn sweep_dir(root: &Path, out: &mut Swept) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        // `DirEntry::file_type` does not follow symlinks, so a link into the user's pictures
        // folder is treated as the file it is and unlinked — never walked into.
        match entry.file_type() {
            Ok(t) if t.is_dir() => {
                sweep_dir(&path, out);
                // Best-effort: a directory that still holds a file we could not remove is
                // simply left, and that file is already counted in `failed`.
                let _ = fs::remove_dir(&path);
            }
            Ok(_) => {
                let bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                if fs::remove_file(&path).is_ok() {
                    out.files += 1;
                    out.bytes += bytes;
                } else {
                    out.failed += 1;
                }
            }
            Err(_) => out.failed += 1,
        }
    }
}

/// Sweep the two disposable directories and drop the rows that vouched for them.
///
/// **Order is load-bearing, and it is: rows, then files, then the owed queue.**
///
/// * The rows go first, through `forget_rows` — which in the app is
///   `|| with_write(&state, forget_image_rows)`, and in a test the same function over a bare
///   connection. A row that outlived its file is already a supported state —
///   [`crate::images::Cache::get`] reads "cached" from the row, fails to read the file, and
///   treats it as a miss — so the window between the two is a window in which the cache is
///   merely slow. **An `Err` from it sweeps nothing**: a `BUSY` answer leaves the rows and the
///   files both standing, which is a consistent cache and a button the reader can press again.
/// * The files go second, **after `forget_rows` has returned and so after the write mutex is
///   released**. A 5 500-file walk is not something to hold the app-wide write lock across:
///   until 2026-09-27 the whole of this function ran inside the command's `with_write`, so for
///   as long as a large sweep took, every other press in the app waited out
///   [`crate::db::WRITE_LOCK_WAIT`] and then answered [`crate::db::BUSY`] — a sentence about a
///   *sync*, which nothing was running. Taking the rows as a closure rather than a
///   `&Connection` is what makes that shape the only one this function can be called in, and
///   what lets the tests run the production order rather than a copy of it.
/// * [`crate::images::Cache::forget_pending`] goes **last**, and it is the half a first draft
///   gets wrong. That queue holds `image_cache` rows *owed* for bytes already on disk, waiting
///   for a write connection; every one of them describes a file this sweep just deleted, and
///   the next served image flushes the queue. Draining it before the sweep would let a fetch
///   landing mid-walk re-queue, and the row would then outlive the file with no reader ever
///   noticing.
///
/// An image fetched *after* this returns writes its own file and its own row together and is
/// consistent on both counts, which is why nothing here needs to stop the world. One fetched
/// *during* the walk can now also flush its row — the lock is free — and have its file swept
/// a moment later: that is a row without its file, the first bullet's supported state, and it
/// heals at the next request for that picture.
pub fn clear_cache(
    forget_rows: impl FnOnce() -> Result<i64, String>,
    images: &Path,
    tmp: &Path,
    cache: &crate::images::Cache,
) -> Result<CacheCleared, String> {
    let rows = forget_rows()?;
    let mut swept = Swept::default();
    sweep_dir(images, &mut swept);
    sweep_dir(tmp, &mut swept);
    cache.forget_pending();
    Ok(CacheCleared {
        files: swept.files,
        bytes: swept.bytes,
        rows,
        failed: swept.failed,
    })
}

/// The one statement of [`clear_cache`] that needs the write connection.
///
/// A function of its own rather than a closure at the call site so that the command and the
/// tests hand [`clear_cache`] the same statement — the command under `with_write`, a test over
/// its own connection.
fn forget_image_rows(conn: &Connection) -> Result<i64, String> {
    conn.execute("DELETE FROM image_cache", [])
        .map(|n| n as i64)
        .map_err(|e| e.to_string())
}

/// Refused when a sync is in flight, in the reader's words.
const SYNCING: &str = "a card update is running — clear the cache once it has finished";

/// Refused when a feed is downloading into `data/tmp/`, in the reader's words.
///
/// One sentence for all five feeds rather than one per feed: the reader did not necessarily
/// start any of them — every one of them can run at launch without a press — and what they
/// need to know is that the press will work in a minute, not which file was in the way.
const DOWNLOADING: &str =
    "a price, tag or combo download is running — clear the cache once it has finished";

/// Why [`cache_clear`] must not run right now, or `None` when it may.
///
/// **Every download that lands in `data/tmp/` has a second phase that reopens the file**, and a
/// sweep between the two phases fails the job. The corpus sync is `syncing`; the two price
/// feeds, the two Tagger datasets and the combo feed are each module's own refresh claim, held
/// from before the download until the temp file is deleted — which is exactly the span a sweep
/// must not land in. The sync is asked first only because its sentence is the more specific
/// one when both are true.
fn cache_clear_refusal(syncing: bool) -> Option<&'static str> {
    if syncing {
        return Some(SYNCING);
    }
    if crate::marketplace_feed::any_refresh_running()
        || crate::tags::any_refresh_running()
        || crate::combos::any_refresh_running()
    {
        return Some(DOWNLOADING);
    }
    None
}

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

/// The tests of `reset` that name something this crate still holds. Each goes home when what it
/// names does.
#[cfg(test)]
mod tests {
    use super::*;
    use grimoire_core::reset::fixtures::*;

    /// The sweep walks `images/<variant>/<shard>/` and empties `tmp/` beside it, and leaves the
    /// two roots standing.
    #[test]
    fn the_cache_sweep_empties_both_trees_and_keeps_their_roots() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        let shard = images.join("thumb").join("ab");
        fs::create_dir_all(&shard).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        fs::write(shard.join("abcd-0.webp"), b"1234567890").unwrap();
        fs::write(shard.join("abcd-1.webp"), b"12345").unwrap();
        fs::write(tmp.join("default-cards.jsonl.gz"), b"gz").unwrap();
        let conn = db();
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('abcd', 0, 'thumb', 'https://cards.scryfall.io/x.webp?1', 10, 0)",
            [],
        )
        .unwrap();
        let cache = crate::images::Cache::new(images.clone());

        let out = clear_cache(|| forget_image_rows(&conn), &images, &tmp, &cache).unwrap();

        assert_eq!(out.files, 3);
        assert_eq!(out.bytes, 17);
        assert_eq!(out.rows, 1);
        assert_eq!(out.failed, 0);
        assert_eq!(count(&conn, "image_cache"), 0);
        assert!(images.is_dir() && tmp.is_dir());
        assert!(!shard.exists(), "an emptied shard directory goes with it");
    }

    /// **The rows go first and the walk starts only once they have returned** — which is the
    /// whole of what keeps the sweep out from under the write lock, because in the app the
    /// closure *is* `with_write` and its guard drops as it returns. So the closure looks at the
    /// disk and the owed queue from inside: nothing swept yet, nothing forgotten yet. A
    /// `clear_cache` that walked first, or that took a connection and ran everything under the
    /// caller's lock again, would fail one of these two ways — the files already gone when the
    /// rows are asked for, or no closure to hand the lock to at all.
    #[test]
    fn the_cache_rows_go_before_the_sweep_and_the_sweep_waits_for_them() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        let picture = images.join("abcd-0.webp");
        fs::write(&picture, b"1234").unwrap();
        let cache = crate::images::Cache::new(images.clone());
        cache.queue_record_for_test(
            "3f2c9a1e-0000-4000-8000-000000000001",
            "https://cards.scryfall.io/x.webp?1",
            4,
        );
        let conn = db();
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('abcd', 0, 'thumb', 'https://cards.scryfall.io/x.webp?1', 4, 0)",
            [],
        )
        .unwrap();

        let out = clear_cache(
            || {
                assert!(picture.is_file(), "the walk must not have started yet");
                assert_eq!(
                    cache.pending_records(),
                    1,
                    "nor the owed queue been dropped"
                );
                forget_image_rows(&conn)
            },
            &images,
            &tmp,
            &cache,
        )
        .unwrap();

        assert_eq!(
            out.rows, 1,
            "the count is the closure's, reported as it answered"
        );
        assert_eq!(out.files, 1);
        assert!(!picture.exists());
        assert_eq!(cache.pending_records(), 0);
    }

    /// **A row delete that could not run sweeps nothing.** In the app that is `with_write`
    /// answering `BUSY` because a write held the connection for five seconds, and the press
    /// has to leave a cache that is still consistent — rows and files both standing — rather
    /// than files gone under rows that still vouch for them.
    #[test]
    fn a_busy_row_delete_leaves_the_cache_exactly_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        let picture = images.join("abcd-0.webp");
        fs::write(&picture, b"1234").unwrap();
        let cache = crate::images::Cache::new(images.clone());
        cache.queue_record_for_test(
            "3f2c9a1e-0000-4000-8000-000000000001",
            "https://cards.scryfall.io/x.webp?1",
            4,
        );

        let err =
            clear_cache(|| Err(crate::db::BUSY.to_owned()), &images, &tmp, &cache).unwrap_err();

        assert_eq!(err, crate::db::BUSY);
        assert!(picture.is_file(), "no file may go when the rows could not");
        assert_eq!(
            cache.pending_records(),
            1,
            "and the owed queue is untouched"
        );
    }

    /// **A feed downloading into `tmp/` refuses the press**, and so does a sync, which wins
    /// when both are true. Each feed module's claim is taken under a name no real feed uses,
    /// because the registries are process-wide and the suites run in parallel — a test here
    /// holding `"cardkingdom"` would make that module's own refresh tests answer "already being
    /// refreshed". The combo feed is a single flag with no names, so it is not claimed here for
    /// the same reason; its `any_refresh_running` is asserted beside its own guard in `combos`.
    ///
    /// Only the refusing direction is asserted. "Nothing is running, so `None`" would be true
    /// or false depending on which other test happened to be mid-refresh in another thread.
    #[test]
    fn the_cache_clear_is_refused_while_a_feed_is_downloading() {
        {
            let _prices = crate::marketplace_feed::hold_refresh_for_test("reset-test-prices");
            assert_eq!(cache_clear_refusal(false), Some(DOWNLOADING));
            assert_eq!(
                cache_clear_refusal(true),
                Some(SYNCING),
                "a sync is the more specific sentence"
            );
        }
        {
            let _tags = crate::tags::hold_refresh_for_test("reset-test-tags");
            assert_eq!(cache_clear_refusal(false), Some(DOWNLOADING));
        }
    }

    /// The queue that would otherwise re-assert rows for the files just deleted. Drained last,
    /// and this is the assertion that it is drained at all.
    #[test]
    fn the_cache_sweep_drops_the_rows_still_owed_for_the_files_it_deleted() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        let cache = crate::images::Cache::new(images.clone());
        cache.queue_record_for_test(
            "3f2c9a1e-0000-4000-8000-000000000001",
            "https://cards.scryfall.io/x.webp?1",
            10,
        );
        assert_eq!(cache.pending_records(), 1);
        let conn = db();

        clear_cache(|| forget_image_rows(&conn), &images, &tmp, &cache).unwrap();

        assert_eq!(cache.pending_records(), 0);
    }

    /// A directory that is not there is not an error: a fresh install has fetched no picture
    /// and downloaded no bulk file, and pressing the button on that install must still answer.
    #[test]
    fn the_cache_sweep_answers_zero_when_there_is_nothing_to_sweep() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        let cache = crate::images::Cache::new(images.clone());
        let conn = db();

        let out = clear_cache(|| forget_image_rows(&conn), &images, &tmp, &cache).unwrap();

        assert_eq!(out.files, 0);
        assert_eq!(out.bytes, 0);
        assert_eq!(out.failed, 0);
    }

    /// **The blast radius, asserted from the outside**: this command is handed two paths and
    /// reaches neither their parent nor a sibling of theirs. `sweep_dir` deletes recursively, so
    /// the failure this fences is not a wrong file but a wrong *root* — `clear_cache` called
    /// with the data directory instead of `images/` would take everything in it.
    ///
    /// The sibling was `covers/` until 2026-08-31, and it was the reader's own pictures, which
    /// made this test's subject obvious. Custom covers are gone and the fence is not: a bare
    /// sibling stands in, because what is being proved is a property of the sweep rather than a
    /// promise about any one folder. `user.db` and `corpus.db` are the real neighbours now.
    #[test]
    fn the_cache_sweep_reaches_no_sibling_of_the_two_roots() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let tmp = dir.path().join("tmp");
        let sibling = dir.path().join("neighbour");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&tmp).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        let bystander = sibling.join("do-not-touch");
        fs::write(&bystander, b"not this command's to delete").unwrap();
        let cache = crate::images::Cache::new(images.clone());
        let conn = db();

        clear_cache(|| forget_image_rows(&conn), &images, &tmp, &cache).unwrap();

        assert!(bystander.is_file(), "a sibling directory is out of reach");
        assert!(images.is_dir(), "and both roots themselves survive");
        assert!(tmp.is_dir());
    }

    /// A symlink is unlinked, never followed. The sweep would otherwise walk into whatever a
    /// link in the data directory points at — which on a portable install beside the reader's
    /// own folders is not a theoretical target.
    #[cfg(windows)]
    #[test]
    fn the_cache_sweep_unlinks_rather_than_follows() {
        let dir = tempfile::tempdir().unwrap();
        let images = dir.path().join("images");
        let outside = dir.path().join("outside");
        fs::create_dir_all(&images).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let kept = outside.join("precious.txt");
        fs::write(&kept, b"not the cache's").unwrap();
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
