//! **The desktop's half of `integration`** (issue #1396).
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole — the projection, the
//! store's client, the switch's cache and commands, and the publish round — so a path through this
//! one reaches that crate's item, except for what is defined below: the eight `#[tauri::command]`
//! wrappers behind Settings → Integrations — the switch's four and the review list's four — each
//! its table entry's twin in name and arguments (`command_table` holds them to it).
//!
//! **No logic of their own.** Each runs the core's command on a worker with a runtime of its own
//! (`sync::on_a_worker`, the sync commands' shape): the three writes through the sync lane as a
//! press takes it, and the status through [`settings::status_or_cached`], which answers the cache
//! rather than "busy" when a round or a trip holds the lane. The publish loop is spawned by
//! `desktop::start`, beside live sync.

pub use grimoire_core::integration::*;

use crate::sync::{self, AppState};
use grimoire_core::integration::projection::IntegrationFields;
use grimoire_core::integration::review::IntentReview;
use grimoire_core::integration::settings::IntegrationsStatus;
use std::sync::Arc;

/// What a command here says when its worker died under it — never a reader's problem.
fn unfinished(e: tauri::Error) -> String {
    format!("the integrations settings could not be reached: {e}")
}

/// The panel's state: the store asked when this device can, the cache when it cannot.
#[tauri::command]
pub async fn integrations_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<IntegrationsStatus, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move { settings::status_or_cached(&core).await })
        .await
        .map_err(unfinished)?
}

/// Switch integrations on for the group, under `fields`.
#[tauri::command]
pub async fn integrations_enable(
    state: tauri::State<'_, Arc<AppState>>,
    fields: IntegrationFields,
) -> Result<IntegrationsStatus, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move {
        let lane = core.lane_for_press().await?;
        settings::enable(&lane, fields).await
    })
    .await
    .map_err(unfinished)?
}

/// Change the group's columns while its store exists.
#[tauri::command]
pub async fn integrations_set_fields(
    state: tauri::State<'_, Arc<AppState>>,
    fields: IntegrationFields,
) -> Result<IntegrationsStatus, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move {
        let lane = core.lane_for_press().await?;
        settings::set_fields(&lane, fields).await
    })
    .await
    .map_err(unfinished)?
}

/// Switch integrations off for every device in the group.
#[tauri::command]
pub async fn integrations_disable(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<IntegrationsStatus, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move {
        let lane = core.lane_for_press().await?;
        settings::disable(&lane).await
    })
    .await
    .map_err(unfinished)?
}

/// The intents this device's policy parks, and the per-kind switches.
#[tauri::command]
pub async fn integrations_review(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<IntentReview, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move {
        let lane = core.lane_for_press().await?;
        review::review(&lane).await
    })
    .await
    .map_err(unfinished)?
}

/// Apply one parked intent, whatever the policy says.
#[tauri::command]
pub async fn integrations_review_apply(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<IntentReview, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move {
        let lane = core.lane_for_press().await?;
        review::apply(&lane, &id).await
    })
    .await
    .map_err(unfinished)?
}

/// Decline one parked intent.
#[tauri::command]
pub async fn integrations_review_decline(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<IntentReview, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move {
        let lane = core.lane_for_press().await?;
        review::decline(&lane, &id).await
    })
    .await
    .map_err(unfinished)?
}

/// Switch one `(source, kind)` automatic on this device, or off.
#[tauri::command]
pub async fn integrations_set_automatic(
    state: tauri::State<'_, Arc<AppState>>,
    source: String,
    kind: String,
    on: bool,
) -> Result<IntentReview, String> {
    let core = state.core.clone();
    sync::on_a_worker(move || async move {
        let lane = core.lane_for_press().await?;
        review::set_automatic(&lane, &source, &kind, on).await
    })
    .await
    .map_err(unfinished)?
}
