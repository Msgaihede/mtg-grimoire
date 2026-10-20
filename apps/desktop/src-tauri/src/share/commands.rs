//! The six commands, and the row they answer.
//!
//! ⚠️ **`generate_handler!` names a command after the last path segment**, so
//! `share::commands::share_create` is invoked as `"share_create"` — the rule the comment beside
//! `collection_alloc::commands::collection_to_deck` in `desktop.rs` states, and the reason these
//! functions carry the `share_` prefix inside a module already called `share`.

use serde::Serialize;

use crate::sync::{self, AppState};
use grimoire_core::state::Lane;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// One published share, as the page draws it.
///
/// **`owner_name` is on this row because spec §4.3 needs it there**: the relay holds the name,
/// and the second device in a group inherits it from `GET /g/{group}/shares` rather than asking
/// the reader to type it again. A row without it would make `share_create`'s `ownerName`
/// argument unanswerable on any device but the first.
///
/// **`url` is on it for the same kind of reason and one degree harder**: a share list with no
/// links is not a share list, and this one has to be drawable with no network — so the link is a
/// column of `collection_shares` rather than something rebuilt from
/// [`super::publish::SHARE_BASE`] — the Worker builds it from its own binding, and one string
/// built on both sides is two chances to disagree.
///
/// `published` is **this device's** stamp and the relay knows nothing about it: `None` means
/// this device has never uploaded, which is what a second device in the group reads before it
/// offers *Update* rather than *Share*.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareRow {
    pub id: String,
    /// `collection_folders.sync_uid`, and `None` for a whole-collection share.
    pub folder_uid: Option<String>,
    pub title: String,
    pub owner_name: String,
    pub url: String,
    /// The wire form of [`super::ShareFields`] — a subset of `condition`, `lang` and `value`.
    pub fields: Vec<String>,
    /// `live`, `lapsed` or `revoked`. The middle one is the relay's daily pass talking, and is
    /// the one a reader must be told about before their friends tell them.
    pub state: String,
    pub published: Option<i64>,
    pub updated_at: i64,
}

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

/// Whether a [`share_auto_update`] pass is already running in this process.
///
/// Every window's shell asks on its own timer, and two passes over the same changed folder would
/// upload it twice. The second caller is answered "nothing updated" at once rather than queued:
/// the pass already running will see the same changes.
static AUTO_UPDATING: AtomicBool = AtomicBool::new(false);

/// Clears [`AUTO_UPDATING`] however the pass ends — a `?`, a panic in the worker, a cancel.
struct AutoUpdating;

impl Drop for AutoUpdating {
    fn drop(&mut self) {
        AUTO_UPDATING.store(false, Ordering::Release);
    }
}

/// Republish every share this device published whose folder has changed since its last upload
/// (issue #1025), and answer the rows that were updated — `[]` for the ordinary pass where
/// nothing moved.
///
/// **Two halves on two connections, and the split is the point.** Which shares are due is
/// [`super::publish::changed`]: a read and a hash per share, on the **read** connection, with no
/// token and no request — so the pass the shell makes on a timer holds neither the writer nor the
/// sync lane while it decides that nothing needs doing, which is nearly every time. Only when a
/// folder has moved does it take [`on_the_lane`] and run the same [`super::publish::refresh`]
/// the *Update now* press runs, share by share — **holding the writer only for each one's read
/// and commit** (issue #1145), so the reader editing the folder that is going up is not told
/// the app is busy.
///
/// **One share's failure does not stop the others**, and it is not this command's error: the
/// publish has already written its `error_log` row, the previous snapshot is still serving, and
/// the digest it would have stored is still the old one — so the next pass tries it again.
#[tauri::command]
pub async fn share_auto_update(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ShareRow>, String> {
    if AUTO_UPDATING.swap(true, Ordering::AcqRel) {
        return Ok(Vec::new());
    }
    let _running = AutoUpdating;
    let state = state.inner().clone();
    let reader = state.clone();
    let due = tauri::async_runtime::spawn_blocking(move || {
        super::publish::changed(&reader.lock_db_read())
    })
    .await
    .map_err(unfinished)??;
    if due.is_empty() {
        return Ok(Vec::new());
    }
    on_the_lane(state, move |lane, runtime| {
        Ok(due
            .iter()
            .filter_map(|id| runtime.block_on(super::publish::refresh(lane, id)).ok())
            .collect())
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
