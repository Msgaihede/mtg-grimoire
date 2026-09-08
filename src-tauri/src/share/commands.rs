//! The five commands, and the row they answer.
//!
//! ⚠️ **`generate_handler!` names a command after the last path segment**, so
//! `share::commands::share_create` is invoked as `"share_create"` — the rule the comment beside
//! `collection_alloc::commands::collection_to_deck` in `desktop.rs` states, and the reason these
//! functions carry the `share_` prefix inside a module already called `share`.
//!
//! **The module compiles on every target and the commands do not**, which is
//! [`crate::collection_folders`]' shape rather than [`crate::sync_engine::commands`]'. The five
//! wrappers are `#[cfg(not(target_family = "wasm"))]` because `tauri` is a desktop dependency;
//! [`ShareRow`] is not, because [`crate::web::route`] answers `share_list` on the browser build
//! and needs the type to say what it answered.

use serde::Serialize;

#[cfg(not(target_family = "wasm"))]
use crate::sync::{self, AppState};
#[cfg(not(target_family = "wasm"))]
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
/// column of `collection_shares` rather than something rebuilt from `share::publish::SHARE_BASE`
/// — spelled without a link, because that module does not exist on the browser build and this
/// struct does. It is a placeholder until the Worker is deployed.
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
#[cfg(not(target_family = "wasm"))]
fn unfinished(e: tauri::Error) -> String {
    format!("the share list could not be written: {e}")
}

/// A blocking worker with a runtime of its own, for the four commands that reach the network.
///
/// **This is [`crate::sync_engine::commands::sync_now`]'s shape and it is not ceremony.** The
/// write connection is behind a `Mutex`, so a guard on it cannot cross an `await` on a
/// multi-threaded runtime; `spawn_blocking` moves the whole trip to a thread where a `block_on`
/// is legal and the guard never has to be `Send`.
#[cfg(not(target_family = "wasm"))]
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
///
/// **The browser build routes the cache read alone**; see [`crate::web::route`].
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn share_list(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<ShareRow>, String> {
    let state = state.inner().clone();
    on_the_write_connection(state, |conn, runtime| {
        runtime.block_on(super::publish::list(conn))
    })
    .await
}

/// Publish a folder — or the whole collection, for a `null` `folderUid`.
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
/// link is the whole of the capability. It still takes the write connection, because
/// [`super::publish::open`] records a failure in `error_log` like every other network path here.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn share_open(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
) -> Result<serde_json::Value, String> {
    let state = state.inner().clone();
    on_the_write_connection(state, move |conn, runtime| {
        runtime.block_on(super::publish::open(conn, &url))
    })
    .await
}
