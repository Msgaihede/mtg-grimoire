//! The doorbell: one long-lived socket per device, and the task that acts on it.
//!
//! **Native only.** `sync_engine` compiles for `wasm32-unknown-unknown` (see `lib.rs`'s module
//! doc) and `tokio-tungstenite` does not, so this module and every reference to it carries
//! `cfg(not(target_family = "wasm"))`. The web target has no relay commands at all, so nothing
//! is lost there.
//!
//! **Thin on purpose.** Every decision about *when* lives in [`super::schedule`] as a pure state
//! machine with tests — the debounces, the single flight, the backoff, and since the review that
//! followed this file's first cut, the whole reconnect classification. What is left here is the
//! socket, the timer and the glue.
//!
//! **A doorbell and not a delivery van.** The frame the relay pushes carries a cursor and the
//! device that moved it, never a card: a device that hears one runs the ordinary HTTP
//! [`client::run_once`], which is the same round trip the Sync Now button has always made. So
//! there is exactly one code path that can change this database, and the socket only decides
//! *when* it runs.
#![cfg(not(target_family = "wasm"))]

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;

use futures_util::{SinkExt, StreamExt};
use tauri::Emitter;
use tokio::sync::Notify;
use tokio_tungstenite::tungstenite::Message;

use super::schedule::{
    backoff_ms, deserves_backoff, next_attempt, Disconnect, Scheduler, Wake, PING_SECS,
};
use super::{client, entitlement};
use crate::errors::{Kind, Source};
use crate::sync::AppState;
use crate::sync_pair::identity;

/// What `error_log` calls a failure of the background loop.
///
/// One word for the socket and for the round trip it runs, and deliberately not `client.rs`'s
/// per-request `push`/`pull`/`ack`: those name *which request* failed, this names *who was
/// asking*. A reader looking at the panel needs to tell "I pressed Sync now and it failed" from
/// "this has been failing quietly in the background", and the operation column is where that
/// distinction can be drawn. The rows fold on the message, so a bad afternoon is one row with a
/// count.
const OPERATION: &str = "live";

/// What the frontend is told about the socket. Mirrored by `LiveState` in `src/lib/ipc.ts`.
///
/// `#[repr(u8)]` with explicit discriminants because [`current`] keeps this in an atomic; the
/// numbers are private to this file and nothing off it may depend on them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
#[repr(u8)]
pub enum LiveState {
    /// No entitlement and no pairing — the state every installation is in today.
    Off = 0,
    Connecting = 1,
    Live = 2,
    Offline = 3,
}

impl LiveState {
    fn from_u8(value: u8) -> Self {
        match value {
            1 => Self::Connecting,
            2 => Self::Live,
            3 => Self::Offline,
            _ => Self::Off,
        }
    }
}

/// The `head` frame. The only thing the relay ever sends.
///
/// **The relay also sends `from`, and this struct deliberately does not name it.** Serde ignores
/// a field it has no home for, so leaving it out is what makes the frame forward-compatible: a
/// required field nothing reads is a parse failure waiting for the day the relay stops sending
/// it, and a failed parse here is silent — the doorbell goes deaf until the next reconnect,
/// which is strictly worse than the unknown-frame case the read loop handles on purpose.
/// `t` and `cursor` are required because they *are* the frame.
#[derive(Debug, serde::Deserialize)]
struct HeadFrame {
    t: String,
    cursor: i64,
}

/// Android's foreground gate. `true` while the app may hold a socket.
///
/// Desktop never clears it: an idle hibernated socket costs nothing, so there is no reason to
/// drop one when the window is minimised. Android does, because Doze severs a background socket
/// anyway and a phone that *looks* connected while being hours stale is worse than one that
/// knows it is offline.
static FOREGROUND: AtomicBool = AtomicBool::new(true);

/// [`current`]'s backing store — a [`LiveState`] discriminant.
static STATE: AtomicU8 = AtomicU8::new(LiveState::Off as u8);

pub fn resume() {
    FOREGROUND.store(true, Ordering::Relaxed);
}

pub fn pause() {
    FOREGROUND.store(false, Ordering::Relaxed);
}

/// What the socket is doing right now.
///
/// **This exists because the `sync:live` event is deduplicated.** Emitting only on a transition
/// is right — `Off` is the resting state of every installation that has paired nothing, and a
/// repeat every five seconds forever is a drip on the IPC channel for no news — but it means a
/// listener that mounts after the single `Off` learns nothing until something changes. A read is
/// the other half of that pair: the page subscribes to the event *and* asks once at mount.
///
/// Relaxed, because this is a display value and no other memory is ordered against it.
pub fn current() -> LiveState {
    LiveState::from_u8(STATE.load(Ordering::Relaxed))
}

/// Start the manager. Returns immediately; the work is a detached task.
///
/// ⚠️ **`writes` must be signalled with [`Notify::notify_one`] and never `notify_waiters`.**
/// This task waits on it in exactly one arm of one `select!`, and it is *not* waiting there for
/// most of its life: it is inside a round trip, asleep on the idle poll, asleep on a backoff, or
/// dialling the relay. `notify_one` stores a permit when nothing is waiting, so the next
/// `notified()` returns at once and that write is still pushed; `notify_waiters` wakes only the
/// tasks already parked and stores nothing, so every write that landed in any of those windows
/// would be silently lost until something else happened to schedule a trip.
pub fn spawn(app: tauri::AppHandle, state: Arc<AppState>, writes: Arc<Notify>) {
    tauri::async_runtime::spawn(async move { run(app, state, writes).await });
}

/// How long to wait before asking again whether this device is in a group.
///
/// A poll and not a signal, because the two things that can turn sync on — a pairing completing
/// and a Patreon claim landing — both finish inside a command on another thread and neither has
/// anything to tell. Five seconds is the whole cost of the idle state: one `SELECT` against the
/// read connection, which is what `AppState::db_read` is for.
const IDLE_POLL: std::time::Duration = std::time::Duration::from_secs(5);

/// How often the loop asks the scheduler whether anything has come due.
///
/// The scheduler's own debounces are one second and three ([`super::schedule`]), so a
/// quarter-second tick is finer than anything it can ask for and coarse enough to cost nothing.
const TICK: std::time::Duration = std::time::Duration::from_millis(250);

async fn run(app: tauri::AppHandle, state: Arc<AppState>, writes: Arc<Notify>) {
    let mut sched = Scheduler::new();
    let mut signal = Signal::new();
    let mut attempt: u32 = 0;
    sched.wake(Wake::Launch, now_ms(), 0);

    loop {
        // The same conditions under which `run_once` already answers `Ok(None)` with no traffic.
        // An installation that has connected nothing opens no socket, which is every
        // installation today.
        if !FOREGROUND.load(Ordering::Relaxed) || !in_a_group(&state).await {
            signal.set(&app, LiveState::Off);
            tokio::time::sleep(IDLE_POLL).await;
            continue;
        }

        signal.set(&app, LiveState::Connecting);
        let ended = connect_once(&app, &state, &writes, &mut sched, &mut signal).await;

        // **Every decision below is [`super::schedule`]'s.** This arm classifies nothing: it
        // hands over what happened and does what it is told, which is what makes the rules
        // testable without a socket, a relay or a clock.
        let next = next_attempt(attempt, ended.cause, ended.lived_ms);

        // **A failure the counter forgave is not worth an `error_log` row.** A socket that
        // stayed up longer than the ladder's longest wait and then closed is Cloudflare
        // recycling a connection, not a broken sync — and these rows fold on the message, so
        // logging every one would leave the panel showing a rising count for the app working
        // exactly as intended.
        if next > attempt {
            if let Some(reason) = ended.error {
                note(&state, reason).await;
            }
        }
        attempt = next;

        if deserves_backoff(ended.cause) {
            signal.set(&app, LiveState::Offline);
            let wait = backoff_ms(attempt, jitter());
            tokio::time::sleep(std::time::Duration::from_millis(wait)).await;
        }
        // A reconnect always catches up on whatever arrived while the socket was down.
        sched.wake(Wake::Reconnect, now_ms(), 0);
    }
}

/// How long a socket is allowed to live before it is replaced.
///
/// **Not because it stops working** — the Durable Object checks the token once, at upgrade, and
/// never re-checks — but so a socket never outlives its ticket. `TOKEN_TTL_MS` is 24 h and the
/// refresh margin is six, so twelve hours reconnects comfortably inside both. One extra
/// connection per device per day.
const SOCKET_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(12 * 60 * 60);

const GROUP_GONE: &str = "the relay says this device's sync group no longer exists";
const SOCKET_CLOSED: &str = "the relay closed the socket";

/// What one socket did before it stopped.
///
/// Three facts and no conclusions: [`next_attempt`] and [`deserves_backoff`] draw those, and
/// they are tested.
struct Ended {
    cause: Disconnect,
    /// How long the socket was **up**, in milliseconds — measured from the completed upgrade, so
    /// a connection that never came up reports zero rather than the time spent dialling. This is
    /// what buys forgiveness for the attempt counter, and time spent failing to connect must not
    /// buy any.
    lived_ms: u64,
    /// The sentence for `error_log`, when there is one worth writing.
    error: Option<String>,
}

impl Ended {
    /// Nothing came up, so nothing lived.
    fn failed(message: String) -> Self {
        Self {
            cause: Disconnect::Failed,
            lived_ms: 0,
            error: Some(message),
        }
    }
}

/// Hold one socket until it dies, reporting what happened to it.
async fn connect_once(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    writes: &Arc<Notify>,
    sched: &mut Scheduler,
    signal: &mut Signal,
) -> Ended {
    let (base, token, device, group) = match credentials(state).await {
        Ok(credentials) => credentials,
        Err(e) => return Ended::failed(e),
    };
    let url = format!(
        "{}/g/{group}/ws?device={device}",
        base.replacen("https://", "wss://", 1)
    );
    // `tokio-tungstenite` builds an arbitrary upgrade request, so the bearer gate the relay
    // already has at `index.ts:169-181` works unchanged. **A browser could not do this** — its
    // `WebSocket` constructor cannot set a header — which is one of the reasons the socket lives
    // in Rust rather than in the page.
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(&url)
        .header("authorization", format!("Bearer {token}"))
        .body(());
    let request = match request {
        Ok(request) => request,
        Err(e) => return Ended::failed(e.to_string()),
    };

    let socket = match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => socket,
        Err(e) => return Ended::failed(e.to_string()),
    };
    let (mut tx, mut rx) = socket.split();

    // Everything past this line is a socket that came up, so its lifetime counts.
    let up = tokio::time::Instant::now();
    signal.set(app, LiveState::Live);
    // A fresh socket has missed whatever happened while it was down.
    sched.wake(Wake::Reconnect, now_ms(), 0);

    let mut ping = tokio::time::interval(std::time::Duration::from_secs(PING_SECS));
    let mut tick = tokio::time::interval(TICK);
    let deadline = up + SOCKET_MAX_AGE;

    let (cause, error) = loop {
        tokio::select! {
            _ = tokio::time::sleep_until(deadline) => break (Disconnect::Aged, None),

            // **A protocol ping, not a text "ping".** Cloudflare answers protocol pings itself,
            // without waking the Durable Object and without billing them — the only keepalive
            // that keeps hibernation. A text frame would be an incoming *message*: billed, and
            // it wakes the object.
            _ = ping.tick() => {
                if let Err(e) = tx.send(Message::Ping(Vec::<u8>::new().into())).await {
                    break (Disconnect::Failed, Some(e.to_string()));
                }
            }

            // A transaction committed on this device. See [`spawn`] on why the producer of this
            // signal must use `notify_one`.
            () = writes.notified() => {
                sched.wake(Wake::LocalWrite, now_ms(), 0);
            }

            _ = tick.tick() => {
                // **The foreground gate, read here and not only at the top of `run`.** `pause()`
                // sets a flag, and without this arm the task would sit in this `select!` until
                // the socket died of its own accord — so an Android app sent to the background
                // would keep the connection the gate exists to drop, until Doze severed it in a
                // way this side does not control and cannot time.
                if !FOREGROUND.load(Ordering::Relaxed) {
                    break (Disconnect::Paused, None);
                }
                if sched.take_due(now_ms()) {
                    trip(app, state, sched).await;
                }
            }

            frame = rx.next() => match frame {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(head) = serde_json::from_str::<HeadFrame>(text.as_str()) {
                        // Anything that is not a `head` is ignored rather than refused: a later
                        // relay may send a frame this build has never heard of, and a doorbell
                        // that hangs up on an unknown ring is worse than one that ignores it.
                        if head.t == "head" {
                            let mine = pull_cursor(state).await;
                            sched.wake(Wake::Frame { cursor: head.cursor }, now_ms(), mine);
                        }
                    }
                }
                // 4001 is the relay saying this group is gone. It reports as
                // [`Disconnect::Removed`], which **backs off like any other disconnect** — that
                // variant is where the reason the naive reading is a trap is written down, and
                // where it is tested.
                Some(Ok(Message::Close(Some(f)))) if u16::from(f.code) == 4001 => {
                    break (Disconnect::Removed, Some(GROUP_GONE.to_owned()));
                }
                Some(Ok(Message::Close(_))) | None => {
                    break (Disconnect::Closed, Some(SOCKET_CLOSED.to_owned()));
                }
                Some(Err(e)) => break (Disconnect::Failed, Some(e.to_string())),
                // Pongs and everything else: the runtime handles control frames, and there are
                // no other application messages.
                Some(Ok(_)) => {}
            },
        }
    };

    Ended {
        cause,
        lived_ms: up.elapsed().as_millis() as u64,
        error,
    }
}

/// Tell the frontend. Shape matches `SyncLiveEvent` in `src/lib/ipc.ts`.
fn emit(app: &tauri::AppHandle, state: LiveState) {
    let _ = app.emit("sync:live", serde_json::json!({ "state": state }));
}

/// The last state the frontend was told, so a state that has not changed is not re-sent.
///
/// **This exists because `Off` is the resting state of every installation that has paired
/// nothing**, which is every installation today. [`run`]'s idle branch comes round every
/// [`IDLE_POLL`], and an event twelve times a minute repeating what the last one said is a steady
/// drip on the IPC channel and a re-render on the page for no news at all. The transitions are
/// the whole signal, and [`current`] is what a listener that missed one asks.
///
/// A reconnect cycle still emits every time, and that is not an exception to the rule: it
/// alternates `Connecting` and `Offline`, so each one really is a change.
struct Signal {
    last: Option<LiveState>,
}

impl Signal {
    fn new() -> Self {
        Self { last: None }
    }

    fn set(&mut self, app: &tauri::AppHandle, state: LiveState) {
        if self.last == Some(state) {
            return;
        }
        self.last = Some(state);
        STATE.store(state as u8, Ordering::Relaxed);
        emit(app, state);
    }
}

/// Write a background failure to `error_log`, best effort — and **never a lapse**.
///
/// ⚠️ **The exclusion is the rule rather than a nicety.** `entitlement.rs`'s module doc and spec
/// §10: a 401 means the membership ended, and an `error_log` row is how this window says "your
/// sync is broken", so recording one sends a reader whose pledge lapsed to look at their network
/// — the wrong sentence, pointing at the wrong fix. That module records nothing on any path, on
/// the stated argument that every caller of it is a press the reader is already watching — and
/// **this loop is the first caller that is not**, which is the case its own doc says inverts the
/// argument for everything *except* the lapse. So the other failures are recorded here, and the
/// lapse is *asked about* rather than matched: a revoked grant is a state
/// [`entitlement::membership_ended`] can answer, where the sentence would be a string comparison
/// of exactly the kind `DEVICE_LIMIT` is written to avoid.
///
/// [`Kind::Other`] because a `String` is all [`client::run_once`] and [`credentials`] answer
/// with: the status and the transport error they were built from are gone by the time they reach
/// here, and guessing at a kind from the words would be worse than saying nothing.
async fn note(state: &Arc<AppState>, message: String) {
    let owned = state.clone();
    let _ = tokio::task::spawn_blocking(move || {
        let _ = crate::sync::with_write(&owned, |conn| {
            if !entitlement::membership_ended(conn) {
                crate::errors::record(conn, Source::Relay, OPERATION, Kind::Other, &message, None);
            }
            Ok(())
        });
    })
    .await;
}

/// Everything the upgrade request needs: the relay's address, a bearer, this device's id and the
/// group whose Durable Object to knock on.
///
/// **On the blocking pool with a runtime of its own**, and for the same reason `commands.rs`'s
/// `sync_now` is — the reason [`trip`] below repeats rather than re-derives.
/// [`entitlement::access_token`] is `async` and may *write* a refreshed grant, so it needs the
/// write connection; that connection is behind a `Mutex` whose guard is not `Send` and so cannot
/// cross an `.await` on a multi-threaded runtime. `spawn_blocking` moves the whole read to a
/// thread where a `block_on` is legal and the guard never has to be `Send`.
///
/// `Err` for a device with no group or no grant, and its distinctive sentences are worth
/// keeping: a 403 `device_limit`, a rotated-away device that cannot mint a token, a grant that
/// vanished. [`run`] records them through [`note`].
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

/// How far this device has already pulled, which is what turns a `head` frame into either a round
/// trip or silence: [`Scheduler::wake`] compares the two and schedules nothing for a cursor this
/// device has already reached. Its own echo is the common case — the relay broadcasts every push,
/// including the one this device just made.
///
/// **The read connection and not the write one**, which is exactly what `AppState::db_read`
/// exists for: a status poll answers from the last committed WAL snapshot without queueing behind
/// an ingest. On the blocking pool all the same, following [`trip`]'s idiom — a search can hold
/// that connection long enough that waiting on it from a runtime worker would be wrong.
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

/// Whether this device is in a sync group at all — the cheap local question, asked of SQLite and
/// never of the relay.
///
/// **This is the gate that keeps every existing installation silent.** Sync is off until a reader
/// pairs or connects a membership, and this answers `false` for all of them, so no socket is
/// opened and no token is ever minted.
///
/// Read connection and blocking pool for [`pull_cursor`]'s reasons; `false` on any error, because
/// a device that cannot read its own identity has nothing to say to a relay.
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
/// `SystemTime::now()` is safe here for the reason `sync_pair::pairing`'s copy of this gives: it
/// panics on `wasm32-unknown-unknown`, and this file has no wasm target to panic on. The
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

/// One round trip, the event that says it changed something, and the row that says it failed.
///
/// **On the blocking pool with a runtime of its own**, and that is not ceremony: it is the same
/// constraint `commands.rs`'s `sync_now` is written around. The write connection is behind a
/// `Mutex`, so a guard on it cannot cross an `await` on a multi-threaded runtime;
/// `spawn_blocking` moves the whole trip to a thread where a `block_on` is legal and the guard
/// never has to be `Send`.
///
/// **The failure is recorded inside that same closure**, which is `sync.rs`'s reentrancy rule
/// rather than a convenience: the connection is already in hand, and coming back for it through
/// [`note`] would spend the whole `WRITE_LOCK_WAIT` failing to take a lock this very thread
/// holds, then silently drop the row. The lapse exclusion is [`note`]'s, for [`note`]'s reasons.
async fn trip(app: &tauri::AppHandle, state: &Arc<AppState>, sched: &mut Scheduler) {
    sched.started();
    let owned = state.clone();
    let outcome = tokio::task::spawn_blocking(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|e| e.to_string())?;
        crate::sync::with_write(&owned, |conn| {
            let outcome = rt.block_on(client::run_once(conn));
            if let Err(e) = &outcome {
                if !entitlement::membership_ended(conn) {
                    crate::errors::record(conn, Source::Relay, OPERATION, Kind::Other, e, None);
                }
            }
            outcome
        })
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
