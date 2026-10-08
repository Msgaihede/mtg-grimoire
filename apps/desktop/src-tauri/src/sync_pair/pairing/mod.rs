//! The pairing commands: the `#[tauri::command]` wrappers over `grimoire_core::sync_pair::pairing`,
//! whose state machine, departure and removal they call through the glob below.

pub use grimoire_core::sync_pair::pairing::*;

// ---------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------
//
// **A press that talks to the relay takes two things, in this order: the pending offer and
// the lane.** The offer's lock is held for the whole call — a request included — which is what
// makes a Cancel wait and win, and what keeps two polls from completing one offer twice. The
// lane is `State::lane_for_press`: a sync in flight answers `BUSY` after five seconds, like
// every other press here, and a departure alone waits (`State::lane`).
//
// **A press that only reads or writes the database** — the status, a begin, a rename — takes
// the write connection through `sync::with_write` as it always did. `identity::ensure` writes
// on a database that has never paired, so even `status` is a write path.
//
// ⚠️ **`with_write` must not be called while holding a guard on `state.db`.** It is a bounded
// `try_lock` loop, so a reentrant call spends the whole `WRITE_LOCK_WAIT` failing against its
// own thread and then answers `BUSY` against itself.

use crate::sync::{self, AppState};
use crate::sync_pair::identity;
use std::sync::Arc;

/// What Settings draws: this device, the group it is in, and the roster.
#[tauri::command]
pub async fn sync_pairing_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<PairingStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, status))
        .await
        .map_err(|e| format!("could not read the pairing status: {e}"))?
}

/// Start offering a pairing. Replaces any offer already in flight.
#[tauri::command]
pub async fn sync_pairing_begin(state: tauri::State<'_, Arc<AppState>>) -> Result<Offer, String> {
    let state = state.inner().clone();
    sync::on_a_worker(move || async move {
        let mut pending = state.pairing.lock().await;
        sync::with_write(&state, |conn| begin(conn, &mut pending))
    })
    .await
    .map_err(|e| format!("could not start pairing: {e}"))?
}

/// Read an offer on the joining device: derives the key, posts the answer to the relay, and
/// answers the six digits.
///
/// On a worker ([`sync::on_a_worker`]), under the pending offer and then the lane.
#[tauri::command]
pub async fn sync_pairing_accept(
    state: tauri::State<'_, Arc<AppState>>,
    code: String,
) -> Result<Handshake, String> {
    let state = state.inner().clone();
    sync::on_a_worker(move || async move {
        let mut pending = state.pairing.lock().await;
        let lane = state.lane_for_press().await?;
        accept(&lane, &mut pending, &code).await
    })
    .await
    .map_err(|e| format!("could not read that pairing code: {e}"))?
}

/// The reader says the digits matched: the group key is sealed, posted to the relay, and only
/// then committed. Answers the sealed group key.
///
/// On a worker, under the pending offer and then the lane, as [`sync_pairing_accept`] is.
#[tauri::command]
pub async fn sync_pairing_confirm(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SealedKey, String> {
    let state = state.inner().clone();
    sync::on_a_worker(move || async move {
        let mut pending = state.pairing.lock().await;
        let lane = state.lane_for_press().await?;
        confirm(&lane, &mut pending).await
    })
    .await
    .map_err(|e| format!("could not finish pairing: {e}"))?
}

/// What the panel asks every 1.5 seconds while a pairing is in flight. See [`poll`].
///
/// On a worker, under the pending offer and then the lane, as [`sync_pairing_accept`] is.
/// `now` is read here, on the IPC thread, before either is waited for.
///
/// **A poll that meets a sync in flight is told `BUSY` like any press**, and the panel's query
/// asks again a second and a half later — which is what it did before, when the trip held the
/// connection.
#[tauri::command]
pub async fn sync_pairing_poll(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<PairingProgress, String> {
    let state = state.inner().clone();
    let now = grimoire_core::platform::clock::now_ms();
    sync::on_a_worker(move || async move {
        let mut pending = state.pairing.lock().await;
        let lane = state.lane_for_press().await?;
        poll(&lane, &mut pending, now).await
    })
    .await
    .map_err(|e| format!("could not check the pairing's progress: {e}"))?
}

/// Throw away whatever is in flight.
///
/// **It waits for the pending offer and nothing else** — not the lane, not the connection — so a
/// Cancel pressed while an accept or a confirm is talking to the relay lands the moment that
/// request ends, and is what the offer is left as.
#[tauri::command]
pub async fn sync_pairing_cancel(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    cancel(&mut *state.inner().pairing.lock().await);
    Ok(())
}

/// Rename a device on the roster.
#[tauri::command]
pub async fn sync_device_rename(
    state: tauri::State<'_, Arc<AppState>>,
    device_id: String,
    name: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    let marks = state.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| {
            identity::rename_device(conn, &device_id, &name).map_err(|e| e.to_string())
        })
    })
    .await
    .map_err(|e| format!("could not rename that device: {e}"))?;
    // `identity::rename_device` writes `sync_devices` and `device_names`, and both are
    // `WITHOUT ROWID`, which the update hook never sees — so the other windows hear about a
    // rename from here. See `crate::changes::MARKED_BY_COMMAND`.
    if out.is_ok() {
        marks.changes.mark_table("sync_devices");
        marks.changes.mark_table("device_names");
    }
    out
}

/// Remove a device and rotate the group key. See [`remove_device`] for the order.
///
/// On a worker ([`sync::on_a_worker`]), under the lane.
///
/// **A press's lane, where [`sync_group_leave`] waits — on purpose.** A removal means nothing
/// until the relay accepts it and opens with a round trip of its own, so waiting out a sync in
/// flight only to start another buys nothing a second press would not; *busy* after five seconds
/// is the kinder answer.
#[tauri::command]
pub async fn sync_device_revoke(
    state: tauri::State<'_, Arc<AppState>>,
    device_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    sync::on_a_worker(move || async move {
        let lane = state.lane_for_press().await?;
        remove_device(&lane, &device_id).await
    })
    .await
    .map_err(|e| format!("could not remove that device: {e}"))?
}

/// Leave the group. See [`leave_group_now`] for the order and why the last step is unconditional.
///
/// On a worker ([`sync::on_a_worker`]), under the lane.
///
/// **[`State::lane`] and never [`State::lane_for_press`]** (issue #546, item 7). A sync in flight
/// holds the lane for its whole round trip, so under a press's bounded wait a Leave pressed during
/// a slow trip would answer *the database is busy* — and "always possible" would have a
/// condition. This press waits the trip out instead, which is bounded because every request in a
/// trip is, and its own stretches wait for the connection as every stretch does.
#[tauri::command]
pub async fn sync_group_leave(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    let state = state.inner().clone();
    let marks = state.clone();
    let out = sync::on_a_worker(move || async move { leave(&state).await }).await;
    // **Three marks, because the update hook hears none of what a departure writes.**
    // `identity::leave_group` empties `sync_devices`, which is `WITHOUT ROWID`, and `sync_group`
    // with a bare `DELETE` on a table no trigger and no foreign key touches — so SQLite truncates it
    // and visits no row. It also deletes its own `sync_state` rows — the superseded keys and the
    // held pull — and `entitlement::clear` then empties the grant's, `WITHOUT ROWID` again. See
    // `crate::changes`' module doc for both blind spots.
    //
    // **Marked whatever the answer, because `Err` does not mean nothing was written**: the
    // departure commits before the clear runs, so a failed clear answers an error over a group
    // this device has already left. Over-marking costs another window one refetch (spec §4).
    for table in ["sync_devices", "sync_group", "sync_state"] {
        marks.changes.mark_table(table);
    }
    out.map_err(|e| format!("could not leave that group: {e}"))?
}
