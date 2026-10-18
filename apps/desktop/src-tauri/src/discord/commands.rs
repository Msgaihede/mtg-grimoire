//! The six commands and the two structs the page mirrors (`packages/ui/lib/ipc/discord.ts`,
//! held byte for byte by `packages/ui/lib/ipc.test.ts`, which reads this file) — the Discord
//! spec's §13.6.
//!
//! **Desktop-only, all six** (`command_table::DESKTOP_ONLY`), and **none takes an argument the
//! page sends**: what a link or a switch-on needs is this device's own state.
//!
//! ⚠️ `generate_handler!` names a command after its last path segment, so these carry the
//! `discord_` prefix inside a module already called `discord`.
//!
//! **Every time here is Unix milliseconds** — the front's `expiresAt` and `lastPullAt` as they
//! arrive.

use super::{flow, local};
use crate::sync::{self, AppState};
use serde::Serialize;
use std::sync::Arc;

/// What *Settings → Integrations → Discord* draws.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordStatus {
    pub linked: bool,
    pub username: Option<String>,
    pub discord_user_id: Option<String>,
    pub linking: bool,
    pub link_expires_at: Option<i64>,
    pub enrolled: bool,
    pub bot_device_id: Option<String>,
    pub last_pull_at: Option<i64>,
    pub gate: Option<String>, // `None` = ready to enable; `Some(sentence)` = why not
}

/// What a link's begin answers: the page opens `authorize_url` itself, in the reader's browser
/// (`opener`'s `https://*` scope already covers `https://discord.com/…`), and polls until linked
/// or `expires_at`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscordLinkStart {
    pub authorize_url: String,
    pub expires_at: i64,
}

/// The status, read here: the link, the link in flight (until it expires), the bot — **listed on
/// this device's roster**, not merely remembered — and the gate's sentence, answered always.
pub fn status(conn: &rusqlite::Connection, now_ms: i64) -> DiscordStatus {
    let link = local::link(conn);
    let linking = local::linking(conn).filter(|l| l.expires_at >= now_ms);
    DiscordStatus {
        linked: link.is_some(),
        username: link.as_ref().and_then(|l| l.username.clone()),
        discord_user_id: link.as_ref().and_then(|l| l.user_id.clone()),
        linking: linking.is_some(),
        link_expires_at: linking.map(|l| l.expires_at),
        enrolled: flow::enrolled(conn),
        bot_device_id: local::bot(conn),
        last_pull_at: local::last_pull(conn),
        gate: grimoire_core::integration::gate(conn).refusal(),
    }
}

fn now() -> i64 {
    grimoire_core::platform::clock::now_ms()
}

/// The tables a switch-on or a switch-off writes that the update hook cannot see — `sync_devices`
/// and `device_names` are `WITHOUT ROWID` (`crate::changes::MARKED_BY_COMMAND`'s reason), the
/// group and its state too.
fn mark(state: &AppState) {
    for table in ["sync_devices", "device_names", "sync_group", "sync_state"] {
        state.changes.mark_table(table);
    }
}

/// The panel's read: local, plus the gate. No request.
#[tauri::command]
pub async fn discord_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DiscordStatus, String> {
    let state = state.inner().clone();
    let now = now();
    tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| Ok(status(conn, now)))
    })
    .await
    .map_err(|e| format!("could not read the Discord status: {e}"))?
}

/// Begin linking a Discord account: a fresh PKCE pair, `POST /link/begin`, and the code and
/// verifier kept in `sync_state`. A second begin replaces the first.
#[tauri::command]
pub async fn discord_link_begin(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DiscordLinkStart, String> {
    let state = state.inner().clone();
    sync::on_a_worker(move || async move {
        let lane = state.lane_for_press().await?;
        let begun = flow::link_begin(&lane).await?;
        Ok(DiscordLinkStart {
            authorize_url: begun.authorize_url,
            expires_at: begun.expires_at,
        })
    })
    .await
    .map_err(|e| format!("could not start linking Discord: {e}"))?
}

/// One poll of the link in flight (the page asks every two seconds): `POST /link/claim`, the
/// account kept once linked. A link that expired or that Discord's service ended answers its
/// sentence once, and is forgotten — the poll after it answers `linking: false`.
#[tauri::command]
pub async fn discord_link_poll(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DiscordStatus, String> {
    let state = state.inner().clone();
    let now = now();
    sync::on_a_worker(move || async move {
        let lane = state.lane_for_press().await?;
        flow::link_poll(&lane, now).await?;
        grimoire_core::state::Store::with(&lane, |conn| Ok(status(conn, now)))
    })
    .await
    .map_err(|e| format!("could not check the Discord link: {e}"))?
}

/// Forget the link in flight. No request: the front's code expires on its own.
#[tauri::command]
pub async fn discord_link_cancel(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DiscordStatus, String> {
    let state = state.inner().clone();
    let now = now();
    tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| {
            local::forget_linking(conn)?;
            Ok(status(conn, now))
        })
    })
    .await
    .map_err(|e| format!("could not cancel the Discord link: {e}"))?
}

/// **Switch Discord on**: the gate, `pairing::begin_integration`, `POST /link/enroll`, the wait
/// for the bot's join, `pairing::confirm_pinned` — see [`flow::enable`]. Under a press's lane for
/// the whole of it, on a worker.
#[tauri::command]
pub async fn discord_enable(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DiscordStatus, String> {
    let state = state.inner().clone();
    let marks = state.clone();
    let out = sync::on_a_worker(move || async move {
        let lane = state.lane_for_press().await?;
        let secret = grimoire_core::state::Store::with(&lane, |conn| Ok(local::link(conn)))?
            .map(|l| l.secret)
            .unwrap_or_default();
        let mut engine = flow::Engine {
            store: &lane,
            pending: None,
            wait: flow::JOIN_WAIT,
        };
        let front = flow::Linked {
            store: &lane,
            secret,
        };
        flow::enable(&lane, &mut engine, &front).await?;
        flow::refresh(&lane).await;
        grimoire_core::state::Store::with(&lane, |conn| Ok(status(conn, now())))
    })
    .await;
    mark(&marks);
    out.map_err(|e| format!("could not switch Discord on: {e}"))?
}

/// **Switch Discord off**: the bot out of the group when it is listed, `DELETE /link` when
/// linked, and everything forgotten here whatever those two said — see [`flow::disable`].
#[tauri::command]
pub async fn discord_disable(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DiscordStatus, String> {
    let state = state.inner().clone();
    let marks = state.clone();
    let out = sync::on_a_worker(move || async move {
        let lane = state.lane_for_press().await?;
        let link = grimoire_core::state::Store::with(&lane, |conn| Ok(local::link(conn)))?;
        let front = link.map(|l| flow::Linked {
            store: &lane,
            secret: l.secret,
        });
        flow::disable(&lane, &flow::Removal { store: &lane }, front.as_ref()).await?;
        grimoire_core::state::Store::with(&lane, |conn| Ok(status(conn, now())))
    })
    .await;
    mark(&marks);
    out.map_err(|e| format!("could not switch Discord off: {e}"))?
}
