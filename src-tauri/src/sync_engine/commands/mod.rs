//! The sync commands: the `#[tauri::command]` wrappers over `grimoire_core::sync_engine::commands`,
//! whose functions and DTOs they call through the glob below. The relay socket's state is the
//! one thing here that is not the core's: it is `super::live`'s.

pub use grimoire_core::sync_engine::commands::*;

use crate::sync::{self, AppState};
use crate::sync_engine::client::{self, RelayOutcome};
use crate::sync_engine::entitlement;
use crate::sync_engine::live::{self, LiveState};
use grimoire_core::state::Store;
use std::sync::Arc;
use tauri::Emitter;

/// What Settings draws: the relay, what is waiting, and what wants looking at.
#[tauri::command]
pub async fn sync_relay_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<RelayStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, read_status))
        .await
        .map_err(|e| e.to_string())?
}

/// What the supporter block draws: the membership, and which of §10's three sentences to say.
///
/// **A read taking the write lock, which is [`sync_relay_status`]'s shape rather than a decision
/// of its own.** Both are one press of the Settings page against a handful of `sync_state` rows,
/// so neither is worth a second connection — and taking the lock means this cannot answer from
/// beside the claim that has just written, which is the read the panel makes next.
#[tauri::command]
pub async fn sync_supporter_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SupporterStatus, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        sync::with_write(&state, |conn| Ok(supporter_status(conn)))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where **Connect Patreon** sends the reader.
///
/// It answers a URL and opens nothing: the page belongs to the `opener` plugin, which is
/// TypeScript's, so this command needs no permission of its own.
#[tauri::command]
pub async fn sync_patreon_begin(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, begin_authorize))
        .await
        .map_err(|e| e.to_string())?
}

/// Trade the code the reader pasted for a grant, and answer what the panel should now say.
///
/// On a worker ([`sync::on_a_worker`]) and under the lane, a press's: a claim seeds the group's
/// auth on the relay and stores the grant, and neither may interleave with a sync in flight —
/// whose own 401 would otherwise wipe the grant this has just written.
///
/// [`ensure_group`] runs first, so this can never answer [`entitlement::NO_GROUP`] — spec §6.3's
/// group of one is made here, before the request that has to name it.
#[tauri::command]
pub async fn sync_patreon_claim(
    state: tauri::State<'_, Arc<AppState>>,
    code: String,
) -> Result<SupporterStatus, String> {
    let state = state.inner().clone();
    let marks = state.clone();
    let out = sync::on_a_worker(move || async move {
        let lane = state.lane_for_press().await?;
        lane.with(ensure_group)?;
        entitlement::claim(&lane, &code).await?;
        lane.with(|conn| Ok(supporter_status(conn)))
    })
    .await;
    // The grant is `sync_state` rows, and `sync_state` is `WITHOUT ROWID`, which the update hook
    // never sees — so the other windows' Sync panels hear about a claim from here. See
    // `crate::changes::MARKED_BY_COMMAND`.
    //
    // **Marked whatever the answer, because `Err` does not mean nothing was written.**
    // `entitlement::store_grant` commits the grant in a transaction of its own and `store_status`
    // runs after it, so a claim can answer an error over a grant that is stored. Over-marking costs
    // another window one refetch (spec §4); under-marking costs it a panel reading *Not connected*
    // over a live membership.
    marks.changes.mark_table("sync_state");
    out.map_err(|e| e.to_string())?
}

/// One round trip now.
///
/// On a worker ([`sync::on_a_worker`]) and under the lane, a press's: a trip already in flight —
/// the live socket's — answers `BUSY` after five seconds, as it did while that trip held the
/// connection.
///
/// **Emits `sync:applied`, on the same condition [`live::trip`] uses** (the trip pushed, or it
/// `changed` the synced tables here, which is wider than applying something), so a manual press
/// reports through the one event Task 10's listener invalidates on — the automatic path is not
/// the only source of that event any more. `app` is taken by value into this function and used
/// only after the worker has answered; it is never captured *into* the worker's closure, which is
/// `state`'s shape here and not `app`'s — `AppHandle` has no business on the thread doing the
/// write, and reaching for it from inside that closure would be the mistake to watch for in a
/// diff, not the shape this one takes.
#[tauri::command]
pub async fn sync_now(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Option<RelayOutcome>, String> {
    let state = state.inner().clone();
    let outcome = sync::on_a_worker(move || async move {
        let lane = state.lane_for_press().await?;
        client::run_once(&lane).await
    })
    .await
    .map_err(|e| e.to_string())??;

    if let Some(o) = outcome {
        if o.changed || o.pushed > 0 {
            let _ = app.emit("sync:applied", o);
        }
    }
    Ok(outcome)
}

/// The relay socket's state right now.
///
/// **A read beside the event, because `sync:live` only fires on a transition.** The manager
/// deduplicates — otherwise `Off` would go out every five seconds for the life of every
/// installation that has paired nothing, which is all of them today — so a listener that mounts
/// after the last transition would never hear anything. Tauri also drops events emitted before
/// the webview registered its listener, which makes that the common case at launch rather than a
/// rare one: a page that only ever subscribed would sit on its default state indefinitely.
#[tauri::command]
pub fn sync_live_state() -> LiveState {
    live::current()
}

/// Every row carrying a sentence, from all six tables that can hold one.
#[tauri::command]
pub async fn sync_review_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<ReviewRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || sync::with_write(&state, read_review))
        .await
        .map_err(|e| e.to_string())?
}

/// "Looks fine": clear one row's sentence.
///
/// **A fifth command the plan does not list, and the panel it describes cannot work without
/// it.** Clearing is a write like any other, so it is captured and travels: a row one device
/// has looked at stops asking on the others too, which is the whole point of the sentence
/// being on the row rather than in a notification.
#[tauri::command]
pub async fn sync_review_clear(
    state: tauri::State<'_, Arc<AppState>>,
    table: String,
    uid: String,
) -> Result<Vec<ReviewRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        // **The table name is checked against the census and never interpolated raw.** It
        // arrives from the webview, and every other statement in this file builds its SQL by
        // `format!`.
        if !REVIEWABLE.iter().any(|(t, _)| *t == table) {
            return Err("That is not a table with anything to review.".to_owned());
        }
        sync::with_write(&state, |conn| {
            conn.execute(
                &format!("UPDATE {table} SET needs_review = NULL WHERE sync_uid = ?1"),
                [&uid],
            )
            .map_err(|e| e.to_string())?;
            read_review(conn)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
