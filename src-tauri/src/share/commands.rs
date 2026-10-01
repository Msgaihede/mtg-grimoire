//! The five commands, and the row they answer.
//!
//! ⚠️ **`generate_handler!` names a command after the last path segment**, so
//! `share::commands::share_create` is invoked as `"share_create"` — the rule the comment beside
//! `collection_alloc::commands::collection_to_deck` in `desktop.rs` states, and the reason these
//! functions carry the `share_` prefix inside a module already called `share`.

use serde::Serialize;

use crate::sync::{self, AppState};
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

/// A blocking worker with a runtime of its own, for the commands whose network trip ends in a
/// write to `collection_shares` — the list's reconcile, a publish's cached row, a withdrawal's
/// state.
///
/// **This is [`crate::sync_engine::commands::sync_now`]'s shape and it is not ceremony.** The
/// write connection is behind a `Mutex`, so a guard on it cannot cross an `await` on a
/// multi-threaded runtime; `spawn_blocking` moves the whole trip to a thread where a `block_on`
/// is legal and the guard never has to be `Send`.
///
/// ⚠️ **It holds the writer for the whole trip, which is only tolerable because the far end is
/// the reader's own Worker.** [`share_open`] talks to whatever host a stranger's link names, and
/// ran in here until 2026-09-28 — see its doc for what that cost and why it no longer does.
async fn on_the_write_connection<T: Send + 'static>(
    state: Arc<AppState>,
    work: impl FnOnce(&rusqlite::Connection, &tokio::runtime::Runtime) -> Result<T, String>
        + Send
        + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        sync::with_write(&state, |conn| work(conn, &runtime))
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
    on_the_write_connection(state, |conn, runtime| {
        runtime.block_on(super::publish::list(conn))
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
    on_the_write_connection(state, move |conn, runtime| {
        runtime.block_on(super::publish::publish(
            conn,
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
    on_the_write_connection(state, move |conn, runtime| {
        runtime.block_on(super::publish::refresh(conn, &id))
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
    on_the_write_connection(state, move |conn, runtime| {
        runtime.block_on(super::publish::revoke(conn, &id))
    })
    .await
}

/// Open somebody else's shared collection from its link.
///
/// **Needs no membership and sends no token** (spec §9): viewing is open to everyone, and the
/// link is the whole of the capability.
///
/// ⚠️ **It holds no connection while it fetches, and until 2026-09-28 it held the write one**
/// (issue #545). It ran inside [`on_the_write_connection`] so that [`super::publish::open`] could
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
