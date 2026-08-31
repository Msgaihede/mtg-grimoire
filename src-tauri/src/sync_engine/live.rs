//! The doorbell: one long-lived socket per device, and the task that acts on it.
//!
//! **Native only.** `sync_engine` compiles for `wasm32-unknown-unknown` (see `lib.rs`'s module
//! doc) and `tokio-tungstenite` does not, so this module and every reference to it carries
//! `cfg(not(target_family = "wasm"))`. The web target has no relay commands at all, so nothing
//! is lost there.
//!
//! **Thin on purpose.** Every decision about *when* lives in [`super::schedule`] as a pure
//! state machine with tests; this file is the socket, the timer and the glue.
//!
//! **A doorbell and not a delivery van.** The frame the relay pushes carries a cursor and the
//! device that moved it, never a card: a device that hears one runs the ordinary HTTP
//! [`client::run_once`], which is the same round trip the Sync Now button has always made. So
//! there is exactly one code path that can change this database, and the socket only decides
//! *when* it runs.
#![cfg(not(target_family = "wasm"))]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

use super::schedule::{backoff_ms, Scheduler, Wake, PING_SECS};
use super::{client, entitlement};
use crate::sync::AppState;
use crate::sync_pair::identity;

/// What the frontend is told about the socket. Mirrored by `LiveState` in `src/lib/ipc.ts`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveState {
    /// No entitlement and no pairing — the state every installation is in today.
    Off,
    Connecting,
    Live,
    Offline,
}

/// The `head` frame. The only thing the relay ever sends.
#[derive(Debug, serde::Deserialize)]
struct HeadFrame {
    t: String,
    cursor: i64,
    #[allow(dead_code)]
    from: String,
}

/// Android's foreground gate. `true` while the app may hold a socket.
///
/// Desktop never clears it: an idle hibernated socket costs nothing, so there is no reason to
/// drop one when the window is minimised. Android does, because Doze severs a background
/// socket anyway and a phone that *looks* connected while being hours stale is worse than one
/// that knows it is offline.
static FOREGROUND: AtomicBool = AtomicBool::new(true);

pub fn resume() {
    FOREGROUND.store(true, Ordering::Relaxed);
}

pub fn pause() {
    FOREGROUND.store(false, Ordering::Relaxed);
}

/// Start the manager. Returns immediately; the work is a detached task.
pub fn spawn(app: tauri::AppHandle, state: Arc<AppState>, writes: Arc<Notify>) {
    tauri::async_runtime::spawn(async move { run(app, state, writes).await });
}

/// How long to wait before asking again whether this device is in a group.
///
/// A poll and not a signal, because the two things that can turn sync on — a pairing
/// completing and a Patreon claim landing — both finish inside a command on another thread and
/// neither has anything to tell. Five seconds is the whole cost of the idle state: one
/// `SELECT` against the read connection, which is what `AppState::db_read` is for.
const IDLE_POLL: std::time::Duration = std::time::Duration::from_secs(5);

/// How often the loop asks the scheduler whether anything has come due.
///
/// The scheduler's own debounces are one second and three ([`super::schedule`]), so a
/// quarter-second tick is finer than anything it can ask for and coarse enough to cost
/// nothing.
const TICK: std::time::Duration = std::time::Duration::from_millis(250);

async fn run(app: tauri::AppHandle, state: Arc<AppState>, writes: Arc<Notify>) {
    let mut sched = Scheduler::new();
    let mut attempt: u32 = 0;
    sched.wake(Wake::Launch, now_ms(), 0);

    loop {
        // The same conditions under which `run_once` already answers `Ok(None)` with no
        // traffic. An installation that has connected nothing opens no socket, which is every
        // installation today.
        if !FOREGROUND.load(Ordering::Relaxed) || !in_a_group(&state).await {
            emit(&app, LiveState::Off);
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        }

        emit(&app, LiveState::Connecting);
        match connect_once(&app, &state, &writes, &mut sched).await {
            Ok(()) => attempt = 0,
            Err(_) => {
                emit(&app, LiveState::Offline);
                let wait = backoff_ms(attempt, jitter());
                attempt = attempt.saturating_add(1);
                tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
            }
        }
        // A reconnect always catches up on whatever arrived while the socket was down.
        sched.wake(Wake::Reconnect, now_ms(), 0);
    }
}

/// How long a socket is allowed to live before it is replaced.
///
/// **Not because it stops working** — the Durable Object checks the token once, at upgrade,
/// and never re-checks — but so a socket never outlives its ticket. `TOKEN_TTL_MS` is 24 h and
/// the refresh margin is six, so twelve hours reconnects comfortably inside both. One extra
/// connection per device per day.
const SOCKET_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(12 * 60 * 60);

/// Hold one socket until it dies, acting on what arrives.
///
/// `Ok(())` means "reconnect without a backoff" — a clean close or the age limit. `Err` means
/// the backoff applies.
async fn connect_once(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    writes: &Arc<Notify>,
    sched: &mut Scheduler,
) -> Result<(), String> {
    let (base, token, device, group) = credentials(state).await?;
    let url = format!(
        "{}/g/{group}/ws?device={device}",
        base.replacen("https://", "wss://", 1)
    );
    // `tokio-tungstenite` builds an arbitrary upgrade request, so the bearer gate the relay
    // already has at `index.ts:169-181` works unchanged. **A browser could not do this** — its
    // `WebSocket` constructor cannot set a header — which is one of the reasons the socket
    // lives in Rust rather than in the page.
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("authorization", format!("Bearer {token}"))
        .body(())
        .map_err(|e| e.to_string())?;

    let (socket, _) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| e.to_string())?;
    let (mut tx, mut rx) = socket.split();

    emit(app, LiveState::Live);
    // A fresh socket has missed whatever happened while it was down.
    sched.wake(Wake::Reconnect, now_ms(), 0);

    let mut ping = tokio::time::interval(std::time::Duration::from_secs(PING_SECS));
    let mut tick = tokio::time::interval(TICK);
    let deadline = tokio::time::Instant::now() + SOCKET_MAX_AGE;

    loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => return Ok(()),

            // **A protocol ping, not a text "ping".** Cloudflare answers protocol pings itself,
            // without waking the Durable Object and without billing them — the only keepalive
            // that keeps hibernation. A text frame would be an incoming *message*: billed, and
            // it wakes the object.
            _ = ping.tick() => {
                tx.send(Message::Ping(Vec::new())).await.map_err(|e| e.to_string())?;
            }

            // A transaction committed on this device.
            () = writes.notified() => {
                sched.wake(Wake::LocalWrite, now_ms(), 0);
            }

            _ = tick.tick() => {
                if sched.take_due(now_ms()) {
                    trip(app, state, sched).await;
                }
            }

            frame = rx.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(head) = serde_json::from_str::<HeadFrame>(&text) {
                        // Anything that is not a `head` is ignored rather than refused: a
                        // later relay may send a frame this build has never heard of, and a
                        // doorbell that hangs up on an unknown ring is worse than one that
                        // ignores it.
                        if head.t == "head" {
                            let mine = pull_cursor(state).await;
                            sched.wake(Wake::Frame { cursor: head.cursor }, now_ms(), mine);
                        }
                    }
                }
                // 4001 is the relay saying this group is gone. Returning `Ok` skips the
                // backoff; the loop in `run` then finds this device is in no group and
                // settles into `Off` rather than hammering a socket it may not have.
                Some(Ok(Message::Close(Some(f)))) if u16::from(f.code) == 4001 => return Ok(()),
                Some(Ok(Message::Close(_))) | None => {
                    return Err("the relay closed the socket".into());
                }
                Some(Err(e)) => return Err(e.to_string()),
                // Pongs and everything else: the runtime handles control frames, and there
                // are no other application messages.
                Some(Ok(_)) => {}
            },
        }
    }
}

/// Tell the frontend. Shape matches `SyncLiveEvent` in `src/lib/ipc.ts`.
fn emit(app: &tauri::AppHandle, state: LiveState) {
    let _ = app.emit("sync:live", serde_json::json!({ "state": state }));
}

/// Everything the upgrade request needs: the relay's address, a bearer, this device's id and
/// the group whose Durable Object to knock on.
///
/// **On the blocking pool with a runtime of its own**, and for the same reason
/// `commands.rs`'s `sync_now` is — the reason [`trip`] below repeats rather than re-derives.
/// [`entitlement::access_token`] is `async` and may *write* a refreshed grant, so it needs the
/// write connection; that connection is behind a `Mutex` whose guard is not `Send` and so
/// cannot cross an `.await` on a multi-threaded runtime. `spawn_blocking` moves the whole read
/// to a thread where a `block_on` is legal and the guard never has to be `Send`.
///
/// `Err` for a device with no group or no grant. No reader ever sees that sentence —
/// [`in_a_group`] has already turned such an installation away — but it is the honest answer to
/// "give me a ticket" when there is none.
async fn credentials(state: &Arc<AppState>) -> Result<(String, String, String, String), String> {
    let owned = state.clone();
    tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        crate::sync::with_write(&owned, |conn| {
            let base = entitlement::base(conn);
            let token = rt
                .block_on(entitlement::access_token(conn))?
                .ok_or_else(|| entitlement::NO_GROUP.to_owned())?;
            let device: String = conn
                .query_row(
                    "SELECT device_id FROM sync_identity WHERE id = 1",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?;
            let group = identity::group(conn)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| entitlement::NO_GROUP.to_owned())?;
            Ok((base, token, device, group.group_id))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// How far this device has already pulled, which is what turns a `head` frame into either a
/// round trip or silence: [`Scheduler::wake`] compares the two and schedules nothing for a
/// cursor this device has already reached. Its own echo is the common case — the relay
/// broadcasts every push, including the one this device just made.
///
/// **The read connection and not the write one**, which is exactly what `AppState::db_read`
/// exists for: a status poll answers from the last committed WAL snapshot without queueing
/// behind an ingest. On the blocking pool all the same, following [`trip`]'s idiom — a search
/// can hold that connection for long enough that waiting on it from a runtime worker would be
/// wrong.
///
/// `0` when the key is missing or unreadable, which is a device that has never pulled: every
/// frame then reads as news, and the worst that costs is one round trip that finds nothing.
async fn pull_cursor(state: &Arc<AppState>) -> i64 {
    let owned = state.clone();
    tokio::task::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&owned);
        client::get_state(&conn, client::PULL_CURSOR)
            .and_then(|v| v.parse().ok())
            .unwrap_or(0)
    })
    .await
    .unwrap_or(0)
}

/// Whether this device is in a sync group at all — the cheap local question, asked of SQLite
/// and never of the relay.
///
/// **This is the gate that keeps every existing installation silent.** Sync is off until a
/// reader pairs or connects a membership, and this answers `false` for all of them, so no
/// socket is opened and no token is ever minted.
///
/// Read connection and blocking pool for [`pull_cursor`]'s reasons; `false` on any error,
/// because a device that cannot read its own identity has nothing to say to a relay.
async fn in_a_group(state: &Arc<AppState>) -> bool {
    let owned = state.clone();
    tokio::task::spawn_blocking(move || {
        let conn = crate::sync::lock_db_read(&owned);
        identity::group(&conn).ok().flatten().is_some()
    })
    .await
    .unwrap_or(false)
}

/// Now, in unix milliseconds — the clock every [`Scheduler`] call is a pure function of.
///
/// `SystemTime::now()` is safe here for the reason `sync_pair::pairing`'s copy of this gives:
/// it panics on `wasm32-unknown-unknown`, and this file has no wasm target to panic on. The
/// every-target halves of `sync_engine` read `unixepoch()` off the connection instead.
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// A fresh number in `0.0..=1.0` for [`backoff_ms`]'s jitter.
///
/// From the OS entropy `sync_pair::crypto` already wraps rather than from a `rand` this crate
/// does not carry. Two bytes is far more resolution than a reconnect spread needs, and it costs
/// one syscall per failed connection.
fn jitter() -> f64 {
    f64::from(u16::from_le_bytes(
        crate::sync_pair::crypto::random_bytes::<2>(),
    )) / f64::from(u16::MAX)
}

/// One round trip, and the event that says it changed something.
///
/// **On the blocking pool with a runtime of its own**, and that is not ceremony: it is the same
/// constraint `commands.rs`'s `sync_now` is written around. The write connection is behind a
/// `Mutex`, so a guard on it cannot cross an `await` on a multi-threaded runtime;
/// `spawn_blocking` moves the whole trip to a thread where a `block_on` is legal and the guard
/// never has to be `Send`.
async fn trip(app: &tauri::AppHandle, state: &Arc<AppState>, sched: &mut Scheduler) {
    sched.started();
    let owned = state.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        crate::sync::with_write(&owned, |conn| rt.block_on(client::run_once(conn)))
    })
    .await;
    sched.finished();

    // **`sync:applied` is emitted only when something changed**, so a frontend listener that
    // invalidates every user-data root does not do so on every heartbeat.
    if let Ok(Ok(Some(o))) = outcome {
        if o.pulled > 0 || o.pushed > 0 {
            let _ = app.emit("sync:applied", o);
        }
    }
}
