//! The doorbell's desktop half: **the push on the way out**.
//!
//! The connection manager — the socket, the loop that acts on it, the write wake and the state
//! a page asks for — is `grimoire-core`'s `sync_engine::live` since the light app's phase 6, and
//! is re-exported here at the paths this crate has always reached it by; `desktop.rs` spawns
//! its loop. What is left is the one thing only this host has a moment for: as the last window
//! closes, ask whether anything is unpushed, and make one more round trip inside the exit's
//! budget. The Android host has no such moment — its process ends with no hook it can await a
//! request in — so there the loop's own write debounce is the whole of it.

pub use grimoire_core::sync_engine::live::*;

use std::sync::Arc;

use super::client;
use crate::sync::AppState;

// ---------------------------------------------------------------------------------------
// The way out
// ---------------------------------------------------------------------------------------

/// Is there anything this device has written and not yet handed the relay?
///
/// The same question [`super::commands::sync_relay_status`]'s panel answers, on the same SQL —
/// one `count(*)` over `sync_ops WHERE pushed_at IS NULL`, served by a partial index
/// ([`unpushed`], the core's, which the loop's own local-write gate asks too) — but that one
/// takes the write connection through [`crate::sync::with_write`], and this caller cannot
/// afford its wait. This is `desktop.rs`'s `ExitRequested` gate, asked before a single window
/// has closed and before the hard budget on the push itself even starts: a query that queued
/// behind a contended write connection would spend part of that budget just deciding whether to
/// try. So this reads `db_read` instead, with `Duration::ZERO` — one `try_lock` and no sleep,
/// [`crate::db::lock_for`]'s own documented shape for a caller with a real answer for "could
/// not". A connection this contended at the moment the window is closing has bigger problems
/// than a missed push, and answering `false` costs nothing a normal exit does not already
/// forgive: the op stays `pushed_at IS NULL` and the next launch's ordinary sync tries again.
pub fn anything_pending(state: &Arc<AppState>) -> bool {
    unpushed(state.reader(), std::time::Duration::ZERO)
}

/// One last round trip on the way out, best effort and with nobody left to tell if it fails.
///
/// **Not the loop's `trip`.** There is no scheduler out here and no next loop iteration to
/// hand an outcome to, so this skips the started/finished bookkeeping and — deliberately — the
/// `error_log` write the loop makes for a failed trip. The caller already bounds this whole
/// call with a hard timeout (`EXIT_PUSH_BUDGET` in `desktop.rs`), and losing that race is not a
/// failure worth a durable row: the op this trip was trying to push is still
/// `pushed_at IS NULL`, exactly the state [`anything_pending`] reads, and the very next
/// launch's ordinary sync tries it again.
///
/// On a worker ([`crate::sync::on_a_worker`]) and under the lane, as the loop's trip is. **A
/// trip already in flight is waited for**, and the caller's budget is what ends that wait: what
/// this would have pushed, that trip has read already or the next launch's will.
pub async fn push_now(state: Arc<AppState>) {
    let _ = crate::sync::on_a_worker(move || async move {
        let lane = state.lane().await;
        client::run_once(&lane).await
    })
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// A real `AppState` on a real file. [`crate::sync::tests::file_state`]'s shape, kept here
    /// because that one is private to its own module: [`anything_pending`] reads `db_read` and
    /// [`push_now`] takes `db`, and an in-memory pair cannot stand in for either — two
    /// `:memory:` connections are two different databases.
    fn file_state(name: &str) -> Arc<AppState> {
        let dir = crate::scratch::path(&format!("live-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        crate::split::convert(&dir).unwrap();
        let conn = crate::db::open_write(&dir).unwrap();
        let read = crate::db::open_read(&dir).unwrap();
        // Hooked up for the same reason every sibling fixture hooks it up: `sync::with_write`'s
        // debug_assert reads the fence `State::new` arms, and a throwaway bell is all the
        // observers need — nothing in these tests starts the loop or waits on it.
        let mirror = Arc::new(crate::mirror::watch::Mask::default());
        let changes = Arc::new(crate::changes::Changes::new());
        Arc::new(AppState {
            core: std::sync::Arc::new(grimoire_core::state::State::new(
                conn,
                Some(read),
                dir.clone(),
                grimoire_core::events::silent(),
                crate::mirror::watch::observers(
                    mirror.clone(),
                    changes.clone(),
                    Arc::new(grimoire_core::platform::sync::Bell::new()),
                ),
                // Never called: `push_now` with no group answers `Ok(None)` before it would be.
                crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                crate::images::Cache::new(dir.join("images")),
            )),
            mirror,
            mirror_status: Mutex::new(crate::mirror::watch::LastPass::default()),
            changes,
        })
    }

    #[test]
    fn nothing_is_pending_on_a_fresh_database() {
        let state = file_state("nothing-pending");
        assert!(!anything_pending(&state));
    }

    #[test]
    fn an_unpushed_op_is_pending() {
        let state = file_state("unpushed-op");
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO sync_ops (tbl, uid, kind, hlc_ms, hlc_ctr, device_id)
                 VALUES ('decks', 'u1', 'put', 0, 0, 'dev1')",
                [],
            )
            .unwrap();
        assert!(anything_pending(&state));
    }

    #[test]
    fn a_pushed_op_is_not_pending() {
        let state = file_state("pushed-op");
        state
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO sync_ops (tbl, uid, kind, hlc_ms, hlc_ctr, device_id, pushed_at)
                 VALUES ('decks', 'u1', 'put', 0, 0, 'dev1', 1)",
                [],
            )
            .unwrap();
        assert!(!anything_pending(&state));
    }

    /// No group and no entitlement is every existing installation, and `push_now` must finish
    /// quietly rather than hang or panic — which is what lets `ExitRequested` await it inside a
    /// bounded [`tokio::time::timeout`] with no special case for the common state.
    #[tokio::test]
    async fn push_now_is_a_quiet_no_op_with_no_group() {
        let state = file_state("no-group");
        push_now(state).await;
    }
}
