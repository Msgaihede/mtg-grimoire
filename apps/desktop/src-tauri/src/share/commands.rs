//! The five commands, and the row they answer.
//!
//! ⚠️ **`generate_handler!` names a command after the last path segment**, so
//! `share::commands::share_create` is invoked as `"share_create"` — the rule the comment beside
//! `collection_alloc::commands::collection_to_deck` in `desktop.rs` states, and the reason these
//! functions carry the `share_` prefix inside a module already called `share`.
//!
//! **No timer command any more** (issue #1396): the window's shell asked `share_auto_update` every
//! five minutes until the core's publish round (`integration::publish`, spawned by `desktop.rs`)
//! took the job over — after every sync trip, on every host, for any live share of the group.

use crate::sync::{self, AppState};
use grimoire_core::state::Lane;
use std::sync::Arc;

/// One published share, as the page draws it — the core's since PR 2 of issue #1396, because
/// the core's publish answers it on every host. Re-exported at the path the page's mirror and
/// this file's commands have always named.
pub use grimoire_core::share::ShareRow;

/// The three switches the publish dialog offers, as they arrive over IPC.
///
/// **A struct of three booleans and not a list of names**, because [`super::ShareFields`] is
/// already that and a list would let the page invent a fourth field by spelling one. There is no
/// `Default` here for the same reason there is none on that type: spec §3 lists six columns that
/// are absent from the format rather than switched off in it.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareFieldsArg {
    #[serde(default)]
    pub condition: bool,
    #[serde(default)]
    pub lang: bool,
    #[serde(default)]
    pub value: bool,
}

impl From<ShareFieldsArg> for super::ShareFields {
    fn from(arg: ShareFieldsArg) -> super::ShareFields {
        super::ShareFields {
            condition: arg.condition,
            lang: arg.lang,
            value: arg.value,
        }
    }
}

/// What a write here says when its worker thread died under it — never a reader's problem; the
/// write itself answers [`crate::db::BUSY`] when the database is busy.
/// [`crate::collection_folders`]' helper of the same name, named for this table instead.
fn unfinished(e: tauri::Error) -> String {
    format!("the share list could not be written: {e}")
}

/// A blocking worker with a runtime of its own and **the sync lane**, for the commands whose
/// network trip reads or writes `collection_shares` — the list's reconcile, a publish's cached
/// row, a withdrawal's state.
///
/// **The lane and not the connection, since issue #1145.** A publish mints its bearer through
/// `entitlement::access_token`, which writes the grant a trip or a claim in flight is writing
/// too, so it takes the lane as a press takes it — its turn within
/// [`crate::db::WRITE_LOCK_WAIT`], or [`crate::db::BUSY`]. The lane is the work's
/// [`Store`](grimoire_core::state::Store): what it reads and writes is a stretch, and every request is
/// made between two with the connection free, which is a sync trip's own shape. Until
/// 2026-10-20 this held the write connection for the whole trip, so an upload over a slow uplink
/// was every edit in the app answering `BUSY` for as long as it took.
///
/// **`spawn_blocking` and a runtime of its own is still the shape**, because a stretch waits for
/// the connection by blocking its thread (`with_write_waiting`), which must not be one of the
/// async runtime's.
///
/// [`share_open`] never came in here: it talks to whatever host a stranger's link names and
/// holds nothing at all — see its doc for what that cost before 2026-09-28.
async fn on_the_lane<T: Send + 'static>(
    state: Arc<AppState>,
    work: impl FnOnce(&Lane<'_>, &tokio::runtime::Runtime) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        let lane = runtime.block_on(state.lane_for_press())?;
        work(&lane, &runtime)
    })
    .await
    .map_err(unfinished)?
}

/// Every share the group has published.
///
/// ⚠️ **It reconciles against the relay first when it can, and this is the only command that
/// could.** Spec §4.3 has a second device inherit the owner's name from the relay's list, and
/// every other `share_*` command needs an id or a name that device does not yet have. A failure
/// — or no membership at all — answers the cache, which is what the cache is for.
#[tauri::command]
pub async fn share_list(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<ShareRow>, String> {
    let state = state.inner().clone();
    on_the_lane(state, |lane, runtime| {
        runtime.block_on(super::publish::list(lane))
    })
    .await
}

/// Publish a folder — or the whole collection, for a `null` `folderUid`.
#[tauri::command]
pub async fn share_create(
    state: tauri::State<'_, Arc<AppState>>,
    folder_uid: Option<String>,
    owner_name: String,
    fields: ShareFieldsArg,
) -> Result<ShareRow, String> {
    let state = state.inner().clone();
    on_the_lane(state, move |lane, runtime| {
        runtime.block_on(super::publish::publish(
            lane,
            folder_uid.as_deref(),
            &owner_name,
            fields.into(),
        ))
    })
    .await
}

/// Upload a fresh snapshot for a share that already exists, keeping its link.
#[tauri::command]
pub async fn share_refresh(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<ShareRow, String> {
    let state = state.inner().clone();
    on_the_lane(state, move |lane, runtime| {
        runtime.block_on(super::publish::refresh(lane, &id))
    })
    .await
}

/// Withdraw a share. Terminal, and the reader's own press.
#[tauri::command]
pub async fn share_revoke(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    on_the_lane(state, move |lane, runtime| {
        runtime.block_on(super::publish::revoke(lane, &id))
    })
    .await
}

/// Open somebody else's shared collection from its link.
///
/// **Needs no membership and sends no token** (spec §9): viewing is open to everyone, and the
/// link is the whole of the capability.
///
/// ⚠️ **It holds no connection while it fetches, and until 2026-09-28 it held the write one**
/// (issue #545). It ran inside the helper the other four share so that [`super::publish::open`] could
/// record a failure in `error_log` — which handed a stranger's host the length of time the app's
/// only writer was held. One byte a minute kept the per-chunk read timeout from ever firing, and
/// every other press in the app answered [`crate::db::BUSY`] for as long as the host liked. So the
/// open now runs here on the async runtime with nothing held, and a failure comes back carrying
/// the row it owes, which is written **afterwards**.
///
/// **The row is best effort and detached, and both halves are deliberate.** `errors::record` can
/// never fail the thing it describes, and nor may the lock it needs: a note that meets a sync
/// holding the writer waits out [`crate::db::WRITE_LOCK_WAIT`], answers `BUSY` to nobody and costs
/// the log one row — the mirror's own trade for its `error_log` row. Awaiting it would hold the
/// reader's sentence behind a lock the open itself no longer needs.
#[tauri::command]
pub async fn share_open(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
) -> Result<serde_json::Value, String> {
    match super::publish::open(&url).await {
        Ok(snapshot) => Ok(snapshot),
        Err(refused) => {
            if let Some(note) = refused.note {
                let state = state.inner().clone();
                // The handle is dropped on purpose: the reader's answer goes back now, and the
                // row lands whenever the writer is free.
                tauri::async_runtime::spawn_blocking(move || {
                    // `BUSY` here is a row the log goes without, never a failed open.
                    let _ = sync::with_write(&state, |conn| {
                        note.record(conn);
                        Ok(())
                    });
                });
            }
            Err(refused.sentence)
        }
    }
}
