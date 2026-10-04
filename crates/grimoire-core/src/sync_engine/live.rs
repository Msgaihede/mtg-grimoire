//! The doorbell: one long-lived socket per device, and the task that acts on it.
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
//!
//! **Every host's, and a host starts it**: [`run`] is the loop as a future, which the desktop,
//! the Android host and the web host each spawn once their state is settled — on their async
//! runtime, or on a Worker's one thread — with the [`WriteWake`] they registered on the write
//! connection. It names no window — what it has to say goes through the state's event sink —
//! and no socket crate: what a WebSocket *is* on a host is [`crate::platform::socket`]'s, a
//! browser's own included. The desktop's push on the way out stays the desktop's, beside its
//! exit.
//!
//! **A socket is its group's, and the loop lets go of one its device has left.** The relay's
//! object is addressed by the group id, so a socket kept across a *Leave group*, a removal or a
//! join elsewhere is the old group's doorbell. The loop looks at `sync_group` on the commit that
//! could have changed it and on every keepalive, and ends such a socket as
//! [`Disconnect::Left`] — which is not a failure: no backoff, no row.

use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::{pin_mut, select, FutureExt};

use super::schedule::{
    backoff_ms, closed_as_gone, deserves_backoff, let_go, next_attempt, Disconnect, Membership,
    Scheduler, Wake, CONNECT_SECS, PING_SECS,
};
use super::{client, commands, entitlement};
use crate::errors::{Kind, Source};
use crate::events::EventSink;
use crate::platform::clock::{self, Tick};
use crate::platform::socket::{self, Event};
use crate::platform::sync::Bell;
use crate::platform::{spawn, timer};
use crate::state::{State, Store};
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

/// [`current`]'s backing store — a [`LiveState`] discriminant.
static STATE: AtomicU8 = AtomicU8::new(LiveState::Off as u8);

/// What the socket is doing right now.
///
/// **This exists because the `sync:live` event is deduplicated.** Emitting only on a transition
/// is right — `Off` is the resting state of every installation that has paired nothing, and a
/// repeat every five seconds forever is a drip on the IPC channel for no news — but it means a
/// listener that mounts after the single `Off` learns nothing until something changes. A read is
/// the other half of that pair: the page subscribes to the event *and* asks once at mount.
///
/// **`Off` on a host that never starts [`run`]**, which is the truth there: no socket. Every
/// host starts it today.
///
/// Relaxed, because this is a display value and no other memory is ordered against it.
pub fn current() -> LiveState {
    LiveState::from_u8(STATE.load(Ordering::Relaxed))
}

/// **Live sync's wake, as an observer of the write connection's commit hook** — the first of
/// the desktop's three (its `mirror::watch::observers`) and the Android host's only one, riding
/// the core's one installer because SQLite allows one commit hook per connection.
///
/// A commit, not a row: `update_hook` does not fire for `WITHOUT ROWID` tables, and two of the
/// synced tables are exactly that (`muted_tags`, and `device_names` since user schema v31). A
/// row-level wake would silently never sync a mute or a rename.
///
/// **This says only "a transaction committed", and deciding is somebody else's job** — spec
/// §6.3's "`commit_hook` wakes, the outbox decides". The decider is `outbox_has_work`, on the arm
/// that receives this signal: `sync_ops WHERE pushed_at IS NULL`, one partial-index scan. That is
/// what keeps the Scryfall ingest, the image cache, the price and tag feeds and every `error_log`
/// row off the relay — none of them is a synced table — and it is what closes the loop a round
/// trip would otherwise be, since `round_trip` ends by stamping `last_sync_at` on this very
/// connection and so rings this bell itself.
///
/// ⚠️ **This comment described that gate for a day before the gate existed**, and the cost was a
/// trip every three seconds for ever. If the sentence above is ever true again only of the
/// design, delete it rather than leave it standing.
///
/// [`Bell::ring`] does not block and cannot fail, which is what a commit hook requires — and it
/// must be a bell that keeps a ring nobody was waiting for, for the reason on [`run`].
pub struct WriteWake(pub Arc<Bell>);

impl crate::hooks::WriteObserver for WriteWake {
    fn committed(&self) {
        self.0.ring();
    }
}

/// How long to wait before asking again whether this device is in a group.
///
/// A poll and not a signal, because the two things that can turn sync on — a pairing completing
/// and a Patreon claim landing — both finish inside a command on another thread and neither has
/// anything to tell. Five seconds is the whole cost of the idle state: one `SELECT` against the
/// connection reads go through ([`State::lock_db_read`]).
const IDLE_POLL: Duration = Duration::from_secs(5);

/// How often the loop asks the scheduler whether anything has come due.
///
/// The scheduler's own debounces are one second and three ([`super::schedule`]), so a
/// quarter-second tick is finer than anything it can ask for and coarse enough to cost nothing.
const TICK: Duration = Duration::from_millis(250);

/// The manager: runs for the life of the process, and is the host's to spawn — after its
/// launch has settled, on its async runtime, as a detached task.
///
/// ⚠️ **`writes` must be a bell that keeps a ring nobody was waiting for** — [`Bell`], rung
/// with [`Bell::ring`], which is `notify_one` and never `notify_waiters`. This task waits on it
/// in exactly one arm of one select, and it is *not* waiting there for most of its life: it is
/// inside a round trip, asleep on the idle poll, asleep on a backoff, or dialling the relay. A
/// ring with nobody waiting stores a permit, so the next wait returns at once and that write
/// is still pushed; a wake that reached only the tasks already parked would store nothing, and
/// every write that landed in any of those windows would be silently lost until something else
/// happened to schedule a trip.
///
/// **It must be the same bell the host registered on the write connection**
/// ([`WriteWake`], an observer handed to [`State::new`]): one the hook does not ring is a
/// device whose own edits wait for somebody else's frame.
pub async fn run(state: Arc<State>, writes: Arc<Bell>) {
    let mut sched = Scheduler::new();
    let mut signal = Signal::new();
    let mut attempt: u32 = 0;
    sched.wake(Wake::Launch, now_ms(), 0);

    loop {
        // The same conditions under which `run_once` already answers `Ok(None)` with no traffic.
        // An installation that has connected nothing opens no socket, which is every
        // installation today.
        if !in_a_group(&state).await {
            signal.set(&*state.events, LiveState::Off);
            timer::sleep(IDLE_POLL).await;
            continue;
        }

        signal.set(&*state.events, LiveState::Connecting);

        // **Spec §6.4: "the connection manager's first act is a full round trip, then the
        // socket."** This arm is that act, and it is here rather than only in
        // [`connect_once`]'s tick because a round trip is plain HTTPS and the socket is an
        // upgrade — two different things to be allowed to do. On a network that permits the one
        // and refuses the other, which is what a corporate or hotel proxy usually is, a device
        // whose only `take_due` lived inside the connected loop got **no automatic sync at
        // all**: not the launch catch-up, not a local write, nothing but the exit push and the
        // button. With this it degrades instead to one trip per backoff cycle — bounded, and
        // honest about what it can reach.
        //
        // The `Reconnect` wake [`connect_once`] arms once the upgrade completes is not made
        // redundant by this and is deliberately kept: it closes the window between this trip's
        // pull and the socket starting to listen, which is the only gap a frame could fall
        // into. Two trips per connection is what §6.4 asks for in as many words, and a
        // connection is a rare event — twelve hours of [`SOCKET_MAX_AGE`], or a reconnect.
        if sched.take_due(now_ms()) {
            trip(&state, &mut sched).await;
        }

        let ended = connect_once(&state, &writes, &mut sched, &mut signal).await;

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
            signal.set(&*state.events, LiveState::Offline);
            let wait = backoff_ms(attempt, jitter());
            timer::sleep(Duration::from_millis(wait)).await;
        }
        // A reconnect always catches up on whatever arrived while the socket was down.
        sched.wake(Wake::Reconnect, now_ms(), 0);
    }
}

/// **The fence, and it is the compiler's**: the desktop and the Android host spawn [`run`] on a
/// runtime that moves a task between threads, so on a native build the loop may hold nothing
/// across an `.await` that cannot go with it — a connection's guard above all. In a browser the
/// question is not asked ([`crate::platform::Sendable`]): the socket there is a JavaScript
/// object, and the host that runs this spawns it on its one thread. Never called.
#[allow(dead_code)]
fn the_loop_can_be_handed_to_a_hosts_runtime(state: Arc<State>, writes: Arc<Bell>) {
    fn sendable<T: crate::platform::Sendable>(_: T) {}
    sendable(run(state, writes));
}

/// How long a socket is allowed to live before it is replaced.
///
/// **Not because it stops working** — the Durable Object checks the token once, at upgrade, and
/// never re-checks — but so a socket never outlives its ticket. `TOKEN_TTL_MS` is 24 h and the
/// refresh margin is six, so twelve hours reconnects comfortably inside both. One extra
/// connection per device per day.
const SOCKET_MAX_AGE: Duration = Duration::from_secs(12 * 60 * 60);

/// What a 4001 is recorded as. **One sentence for both things the relay means by it** — the
/// group was dropped, or a rotation took this device off it — because the close says which of
/// the two no more than this does. (It read *"this device's sync group no longer exists"* while
/// a dropped group was the only cause.)
const GROUP_GONE: &str = "the relay says this device is no longer in its sync group";
const SOCKET_CLOSED: &str = "the relay closed the socket";

/// What a dial that got no answer says.
const NO_ANSWER: &str = "the relay did not answer the live socket's upgrade in time";

/// The close code the relay sends for a group that is gone, and — since the light app's step
/// 6.3b — to a device a rotation's manifest no longer names.
const CLOSE_GROUP_GONE: u16 = 4001;

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

    /// Nothing was dialled, because there is no group to dial for any more. Not a failure.
    fn left() -> Self {
        Self {
            cause: Disconnect::Left,
            lived_ms: 0,
            error: None,
        }
    }
}

/// Dial the relay, and give up when it has not answered.
///
/// **A socket that never answers its upgrade is not a failure anything else reports in time.**
/// The loop says `connecting` before it dials and runs no trip until the dial returns, and a
/// connection that reaches a host which then says nothing — a captive portal, a proxy holding the
/// request, a relay mid-deploy — returns when the stack underneath gives up: a browser holds a
/// `WebSocket` in `CONNECTING` for minutes, and a TCP stack is not asked at all once the
/// handshake itself has completed. Until then the device reads `connecting`, hears no doorbell,
/// and makes none of the trips a failed socket degrades to.
///
/// Past [`CONNECT_SECS`] the dial is dropped — which closes whatever it had opened, on either
/// host — and the socket has failed in a sentence: the ordinary backoff, and the trip in front
/// of the next attempt.
async fn dial(url: &str, token: &str) -> Result<socket::Socket, String> {
    match timer::timeout(
        Duration::from_secs(CONNECT_SECS),
        socket::connect(url, token),
    )
    .await
    {
        Some(answered) => answered,
        None => Err(NO_ANSWER.to_owned()),
    }
}

/// Which of the connected loop's five wakes came first.
///
/// The select below answers one of these and nothing else, so that every future it raced —
/// the wait for a frame, which borrows the socket, among them — is gone before the arm that
/// acts on the answer runs. The keepalive needs that socket back.
enum Woke {
    /// The socket reached [`SOCKET_MAX_AGE`].
    Aged,
    /// The keepalive's beat.
    Ping,
    /// A transaction committed on this device.
    Wrote,
    /// The scheduler's beat.
    Tick,
    /// The socket said something, or ended.
    Frame(Event),
}

/// Hold one socket until it dies, reporting what happened to it.
async fn connect_once(
    state: &Arc<State>,
    writes: &Arc<Bell>,
    sched: &mut Scheduler,
    signal: &mut Signal,
) -> Ended {
    let (base, token, device, group) = match credentials(state).await {
        Ok(credentials) => credentials,
        // **No group is not a failed dial.** The round trip in front of this — the loop's first
        // act — is where a removed device learns it was removed and clears its group, and a
        // press of *Leave group* can land between the loop's look and this one. Either way
        // there is nothing to dial for, and saying so as a failure would be a backoff, the word
        // `offline` and an `error_log` row over a device that is simply in no group. Asked of
        // the database, never read off the refusal's words.
        Err(_) if !in_a_group(state).await => return Ended::left(),
        Err(e) => return Ended::failed(e),
    };
    let url = format!("{}/g/{group}/ws?device={device}", socket::ws_origin(&base));
    let mut socket = match dial(&url, &token).await {
        Ok(socket) => socket,
        Err(e) => return Ended::failed(e),
    };

    // Everything past this line is a socket that came up, so its lifetime counts.
    let up = Tick::now();
    signal.set(&*state.events, LiveState::Live);
    // A fresh socket has missed whatever happened while it was down.
    sched.wake(Wake::Reconnect, now_ms(), 0);

    let mut ping = timer::interval(Duration::from_secs(PING_SECS));
    let mut tick = timer::interval(TICK);
    // One sleep for the socket's whole life, polled by every pass of the loop below.
    //
    // **It counts from its first poll, not from `up`**: `timer::sleep` is an `async fn`, so the
    // timer under it is made when the select below first polls this, a few statements — or,
    // when another arm is ready first, a first trip — after the upgrade. That is seconds of
    // drift against twelve hours, on a limit whose only job is to stay well inside a
    // twenty-four hour token; `lived_ms` is measured from `up` itself. Not worth a deadline
    // type on `platform::timer` to remove, and not a bug to fix.
    let aged = timer::sleep(SOCKET_MAX_AGE).fuse();
    pin_mut!(aged);

    let (cause, error) = loop {
        // **Five wakes, raced afresh on every pass, and whichever is ready is taken in no
        // fixed order** — a commit storm must not starve the frames, nor the frames the tick.
        // The four made here are dropped when another wins, and each is safe to drop: a beat
        // keeps its place ([`timer::Interval`]), a frame is not half-read
        // ([`socket::Socket::next`]), and a ring a dropped wait was given is handed on
        // ([`Bell`]).
        let woke = {
            let ping_due = ping.tick().fuse();
            let wrote = writes.rung().fuse();
            let tick_due = tick.tick().fuse();
            let frame = socket.next().fuse();
            pin_mut!(ping_due, wrote, tick_due, frame);
            select! {
                () = aged => Woke::Aged,
                () = ping_due => Woke::Ping,
                () = wrote => Woke::Wrote,
                () = tick_due => Woke::Tick,
                event = frame => Woke::Frame(event),
            }
        };
        match woke {
            Woke::Aged => break (Disconnect::Aged, None),

            // The keepalive — a protocol ping wherever the host can send one, and
            // [`socket::Socket::keepalive`] has why. **It is also where a socket that died
            // without a word is found**: it fails when the ping before it was never answered
            // by a peer that has answered one, and that is an ordinary failed socket — a
            // backoff and a reconnect — a ping period or two after the network went, rather
            // than whenever TCP gives up.
            //
            // **And the beat on which the loop looks at its group whatever else happened** —
            // the backstop behind the commit's own look below, for the one that could not be
            // taken because the connection was busy past its wait.
            Woke::Ping => {
                if let_go(&group, as_membership(&membership(state).await)) {
                    break (Disconnect::Left, None);
                }
                if let Err(e) = socket.keepalive().await {
                    break (Disconnect::Failed, Some(e));
                }
            }

            // A transaction committed on this device. See [`run`] on why the bell this waits
            // on must keep a ring nobody was waiting for.
            //
            // **Spec §6.3's second half: `commit_hook` wakes, [`the outbox`](outbox_has_work)
            // decides.** The wake is deliberately indiscriminate — one signal per transaction,
            // whatever it wrote — so *this* is the only place that can tell a user edit from
            // everything else that commits on this connection, and without it the loop does not
            // close: `client::round_trip` ends by stamping `LAST_SYNC_AT`, that commit rings
            // this bell, and an ungated arm would schedule the next trip three seconds later,
            // for ever. The same gate is what keeps the Scryfall ingest's one commit per 2 000
            // rows, every image-cache flush, every price and tag ingest and every `error_log`
            // row off the relay: none of them is a synced table, so none of them leaves an op.
            //
            // **And first: is this socket still this device's group's?** The commit that takes
            // a device out of its group — *Leave group*, or the trip on which a removed device
            // learns it was removed — rings this bell like any other, and it is the one moment
            // the answer can have changed. A socket for a group the device is no longer in is
            // let go of here ([`let_go`]); the loop above then says `off`, or dials for the
            // group the device is in now. Until this look existed the socket was kept for its
            // whole twelve hours, on the old group's object.
            Woke::Wrote => {
                if let_go(&group, as_membership(&membership(state).await)) {
                    break (Disconnect::Left, None);
                }
                if outbox_has_work(state).await {
                    sched.wake(Wake::LocalWrite, now_ms(), 0);
                }
            }

            Woke::Tick => {
                if sched.take_due(now_ms()) {
                    trip(state, sched).await;
                }
            }

            Woke::Frame(Event::Text(text)) => {
                if let Ok(head) = serde_json::from_str::<HeadFrame>(&text) {
                    // Anything that is not a `head` is ignored rather than refused: a later
                    // relay may send a frame this build has never heard of, and a doorbell
                    // that hangs up on an unknown ring is worse than one that ignores it.
                    if head.t == "head" {
                        let mine = pull_cursor(state).await;
                        sched.wake(
                            Wake::Frame {
                                cursor: head.cursor,
                            },
                            now_ms(),
                            mine,
                        );
                    }
                }
            }
            // 4001 is the relay saying this group is gone, or that this device is no longer in
            // it. It reports as [`Disconnect::Removed`], which **backs off like any other
            // disconnect** — that variant is where the reason the naive reading is a trap is
            // written down, and where it is tested.
            //
            // **Unless this device has itself just left**: its own departure is a manifest
            // without it, so the relay closes its socket a moment before the press clears the
            // group here. Asked behind the sync lane, which that press holds to its last write
            // ([`closed_as_gone`]) — and then it is a socket let go of, with nothing to record.
            Woke::Frame(Event::Closed(Some(CLOSE_GROUP_GONE))) => {
                let now = membership_behind_the_lane(state).await;
                match closed_as_gone(&group, as_membership(&now)) {
                    Disconnect::Left => break (Disconnect::Left, None),
                    cause => break (cause, Some(GROUP_GONE.to_owned())),
                }
            }
            Woke::Frame(Event::Closed(_)) => {
                break (Disconnect::Closed, Some(SOCKET_CLOSED.to_owned()));
            }
            Woke::Frame(Event::Failed(e)) => break (Disconnect::Failed, Some(e)),
        }
    };

    Ended {
        cause,
        lived_ms: up.elapsed().as_millis() as u64,
        error,
    }
}

/// Tell the page. Shape matches `SyncLiveEvent` in `src/lib/ipc.ts`.
fn emit(sink: &dyn EventSink, state: LiveState) {
    crate::events::emit(sink, "sync:live", &serde_json::json!({ "state": state }));
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

    fn set(&mut self, sink: &dyn EventSink, state: LiveState) {
        if self.last == Some(state) {
            return;
        }
        self.last = Some(state);
        STATE.store(state as u8, Ordering::Relaxed);
        emit(sink, state);
    }
}

/// **Has this device's membership ended** — the one background failure that is not recorded.
///
/// `entitlement::membership_ended`, **asked behind `commands::entitled`, as that function's own
/// doc says it must be**. Alone it is "no refresh secret, and the relay has said something" —
/// which is a lapse on the device that pressed Connect, and is also the ordinary, healthy state
/// of **every device that joined by pairing**: it holds no Patreon-side secret and never will,
/// and what it holds instead is the `active` the group door last answered. This loop asked it
/// alone until 2026-10-04, so on a paired-only device — a phone, a browser, most desktops in a
/// group of three — it recorded no background failure at all: an afternoon of a relay it could
/// not reach left the Errors panel empty. `entitled` first, and the two states come apart: a
/// device the relay still mints for is not lapsed, whichever door it mints through; one the
/// relay has refused — `revoke`'s `dead`, on either door — is.
///
/// The Settings panel reads the same two in the same order (`commands::supporter_status`).
fn lapsed(conn: &rusqlite::Connection) -> bool {
    !commands::entitled(conn) && entitlement::membership_ended(conn)
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
/// lapse is *asked about* rather than matched: a revoked grant is a state [`lapsed`] can answer,
/// where the sentence would be a string comparison of exactly the kind `DEVICE_LIMIT` is written
/// to avoid.
///
/// [`Kind::Other`] because a `String` is all [`client::run_once`] and [`credentials`] answer
/// with: the status and the transport error they were built from are gone by the time they reach
/// here, and guessing at a kind from the words would be worse than saying nothing.
async fn note(state: &Arc<State>, message: String) {
    let owned = state.clone();
    let _ = spawn::blocking(move || {
        let _ = crate::state::with_write(&owned, |conn| {
            if !lapsed(conn) {
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
/// On a worker ([`spawn::on_a_worker`]) and under the lane, waited for: a token is the
/// sync client's to mint, [`entitlement::access_token`] may *write* a refreshed grant, and a
/// trip or a claim in flight is writing the same rows. The lane is let go before the socket is
/// opened — what it guards is the token's minting, not the connection that uses it.
///
/// `Err` for a device with no group or no grant, and its distinctive sentences are worth
/// keeping: a 403 `device_limit`, a rotated-away device that cannot mint a token, a grant that
/// vanished. [`run`] records them through [`note`].
async fn credentials(state: &Arc<State>) -> Result<(String, String, String, String), String> {
    let owned = state.clone();
    spawn::on_a_worker(move || async move {
        let lane = owned.lane().await;
        let token = entitlement::access_token(&lane)
            .await?
            .ok_or_else(|| entitlement::NO_GROUP.to_owned())?;
        lane.with(|conn| {
            let base = entitlement::base(conn);
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
/// **The read connection and not the write one, on a host that has both**
/// ([`State::lock_db_read`]): a status poll answers from the last committed WAL snapshot without
/// queueing behind an ingest. On the blocking pool all the same, following [`trip`]'s idiom — a
/// search can hold that connection long enough that waiting on it from a runtime worker would be
/// wrong.
///
/// `0` when the key is missing or unreadable, which is a device that has never pulled: every
/// frame then reads as news, and the worst that costs is one round trip that finds nothing.
///
/// **Read from SQLite on every frame and never kept here**, which is what lets
/// `identity::forget_log_position` reach it. The key is a place in one group's log, and a value
/// carried in from the last group would make every frame the new one sends up to that number read
/// as old news: the doorbell stays silent for them.
async fn pull_cursor(state: &Arc<State>) -> i64 {
    let owned = state.clone();
    spawn::blocking(move || {
        let conn = owned.lock_db_read();
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
async fn in_a_group(state: &Arc<State>) -> bool {
    let owned = state.clone();
    spawn::blocking(move || {
        let conn = owned.lock_db_read();
        identity::group(&conn).ok().flatten().is_some()
    })
    .await
    .unwrap_or(false)
}

/// The id of the group this device is in right now, by `db` — `Some(None)` for no group, and
/// `None` when the look could not be taken: the connection was not had inside `wait`, or the
/// read failed.
///
/// [`unpushed`]'s shape, for the caller that asks both: over whichever connection, for however
/// long that caller will wait.
fn group_on(db: &std::sync::Mutex<rusqlite::Connection>, wait: Duration) -> Option<Option<String>> {
    let conn = crate::db::lock_for(db, wait)?;
    identity::group(&conn)
        .ok()
        .map(|group| group.map(|group| group.group_id))
}

/// [`group_on`]'s answer as the scheduler reads one.
fn as_membership(seen: &Option<Option<String>>) -> Membership<'_> {
    match seen {
        None => Membership::Unknown,
        Some(None) => Membership::Nowhere,
        Some(Some(group)) => Membership::In(group),
    }
}

/// Which group this device is in, **after the commit that just rang the doorbell**.
///
/// **The write connection, for [`outbox_has_work`]'s reason and with its wait**: a commit hook
/// fires before its transaction is visible to anybody else, so the read connection, asked the
/// moment the bell rings, can still answer the group the commit is in the middle of deleting —
/// and the loop would keep the socket, with no second commit coming to make it look again. The
/// writer holds [`State::db`] until its commit is done; taking that same mutex is what puts
/// this look behind it. On a host with one connection it is the only connection there is, and
/// the look runs on the caller between two turns of the event loop, when no write is open.
/// `the_look_behind_a_commit_sees_what_it_committed` holds both.
///
/// `None` when the connection could not be had in [`WAKE_LOCK_WAIT`] — a long write is on it —
/// which [`let_go`] reads as "keep the socket": the next commit asks again, and the keepalive's
/// beat asks whatever happens.
async fn membership(state: &Arc<State>) -> Option<Option<String>> {
    let owned = state.clone();
    spawn::blocking(move || group_on(&owned.db, WAKE_LOCK_WAIT))
        .await
        .ok()
        .flatten()
}

/// Which group this device is in, **once whatever sync operation is in flight has finished** —
/// what a 4001 is read against ([`closed_as_gone`]).
///
/// On a worker and under the lane, waited for, as [`credentials`] is: a *Leave group* holds the
/// lane from the request that publishes its departure — which is what makes the relay close
/// this socket — to the write that clears the group here, so a look taken on the lane is taken
/// after that write. The lane's holder always lets go in bounded time ([`State::lane`]).
async fn membership_behind_the_lane(state: &Arc<State>) -> Option<Option<String>> {
    let owned = state.clone();
    spawn::on_a_worker(move || async move {
        let lane = owned.lane().await;
        lane.with(|conn| {
            identity::group(conn)
                .map(|group| group.map(|group| group.group_id))
                .map_err(|e| e.to_string())
        })
        .ok()
    })
    .await
    .ok()
    .flatten()
}

/// Now, in unix milliseconds — the clock every [`Scheduler`] call is a pure function of.
fn now_ms() -> u64 {
    u64::try_from(clock::now_ms()).unwrap_or(0)
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
/// On a worker ([`spawn::on_a_worker`]) and under the lane, **waited for**: a press's trip
/// in flight is one this trip queues behind, where it used to be told the connection was busy and
/// lose its wake.
///
/// **The failure is recorded behind the trip, in a stretch of its own on the same lane** — so a
/// press that follows reads the row, and nothing else can have revoked or restored the grant
/// between the trip's answer and the question that row turns on. The lapse exclusion is
/// [`note`]'s, for [`note`]'s reasons.
async fn trip(state: &Arc<State>, sched: &mut Scheduler) {
    sched.started();
    let owned = state.clone();
    let outcome = spawn::on_a_worker(move || async move {
        let lane = owned.lane().await;
        let outcome = client::run_once(&lane).await;
        if let Err(e) = &outcome {
            let _ = lane.with(|conn| {
                if !lapsed(conn) {
                    crate::errors::record(conn, Source::Relay, OPERATION, Kind::Other, e, None);
                }
                Ok(())
            });
        }
        outcome
    })
    .await;
    sched.finished();

    // **`sync:applied` is emitted only when something changed**, so a frontend listener that
    // invalidates every user-data root does not do so on every heartbeat. `changed` and not
    // `pulled`: a pull can delete rows here through the moot arm, and the conversions behind it
    // write rows, with nothing applied (`RelayOutcome::changed`).
    if let Ok(Ok(Some(o))) = outcome {
        if o.changed || o.pushed > 0 {
            crate::events::emit(&*state.events, "sync:applied", &o);
        }
    }
}

// ---------------------------------------------------------------------------------------
// The local-write gate
// ---------------------------------------------------------------------------------------

/// The one `count(*)` both gates are — this loop's [`outbox_has_work`], and the desktop's
/// `anything_pending` on its way out — over whichever connection the caller can afford and for
/// however long that caller is willing to wait for it: `sync_ops WHERE pushed_at IS NULL`,
/// served by a partial index.
///
/// `false` when the lock could not be had inside `wait`, which is a deliberate answer rather
/// than an error: both callers have a real one for "could not ask", and both are documented
/// where they call this.
pub fn unpushed(db: &std::sync::Mutex<rusqlite::Connection>, wait: Duration) -> bool {
    let Some(conn) = crate::db::lock_for(db, wait) else {
        return false;
    };
    conn.query_row(
        "SELECT count(*) FROM sync_ops WHERE pushed_at IS NULL",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|n| n > 0)
    .unwrap_or(false)
}

/// How long the local-write gate waits for the write connection.
///
/// One second and not [`crate::db::WRITE_LOCK_WAIT`]'s five, because nothing here is a person
/// waiting on a button: giving up costs one delayed push, never an op. `sync_ops` is durable and
/// `pushed_at IS NULL` survives everything, so the next commit, the next `head` frame or the
/// next reconnect asks again. It is not the desktop's exit gate's `Duration::ZERO` either — that
/// caller is inside a shutdown budget and this one is not, and a wake silently dropped because
/// the write connection happened to be busy for a moment is a real edit that never syncs.
const WAKE_LOCK_WAIT: Duration = Duration::from_secs(1);

/// Is there anything for the relay after the commit that just rang the doorbell?
///
/// **The write connection and not the read one, and that is the whole correctness of this
/// gate.** A commit hook fires *before* its transaction commits — that is exactly why returning
/// `true` from one aborts the write, as [`crate::hooks::install`] says — so a read taken off the
/// other connection the moment the notification arrives may still be looking at the snapshot the
/// commit is in the middle of replacing, and answering `false` there would drop a real edit on
/// the floor with nothing to raise it again. The writer holds [`State::db`] for the whole of
/// [`crate::state::with_write`], so taking that same mutex is what orders this question *after*
/// the commit that asked it.
///
/// **It contends with a round trip for a stretch at most**, which is the other reason it can
/// afford the write connection: this loop's own [`trip`] is awaited inside the same loop as
/// this arm, so the loop is never in both places at once, and a *press's* trip — which used to
/// hold the connection for its whole length, a second longer than this waits — now holds it only
/// while it reads or writes.
///
/// On the blocking pool because the wait for the connection blocks, and a `MutexGuard` on one
/// is not `Send` and must not be held across an `.await`.
async fn outbox_has_work(state: &Arc<State>) -> bool {
    let owned = state.clone();
    spawn::blocking(move || unpushed(&owned.db, WAKE_LOCK_WAIT))
        .await
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::fixtures::Recording;
    use futures_util::StreamExt;
    use serde_json::{json, Value};
    use tokio_tungstenite::tungstenite::handshake::server::{ErrorResponse, Request, Response};
    use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
    use tokio_tungstenite::tungstenite::protocol::CloseFrame;
    use tokio_tungstenite::tungstenite::Message;

    // -----------------------------------------------------------------------------------
    // The local-write gate — spec §6.3's "the outbox decides"
    // -----------------------------------------------------------------------------------

    /// A device that is in a group and capturing, which is what the capture triggers need
    /// before they will write anything at all.
    ///
    /// **All three rows are load-bearing and none is decoration.** Every trigger's body ends
    /// `SELECT … FROM sync_clock c, sync_identity i, sync_group g` — a cross join — so a table
    /// that is empty makes the whole `SELECT` produce nothing and no op is written. That is
    /// what a device which has paired nothing looks like, and it is also what
    /// [`crate::state::fixtures::on_files`] leaves behind: a pair built at head, with neither
    /// the capture triggers nor the launch's passes, so this fixture installs the one and seeds
    /// the clock itself. Measured rather than assumed — without the clock seed the "a user edit
    /// is pending" case below failed with `sync_ops` empty, which is the same shape as a broken
    /// gate.
    fn in_a_group_state(name: &str) -> Arc<State> {
        let (state, _dir) = crate::state::fixtures::on_files(name, "http://127.0.0.1:1");
        {
            let conn = state.lock_db();
            crate::sync_engine::capture::install(&conn).unwrap();
            conn.execute(
                "INSERT OR IGNORE INTO sync_clock (id, ms, ctr) VALUES (1, 0, 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name,
                                            created_at)
                 VALUES (1, 'dev1', x'00', x'01', 'dev1', 0)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
                 VALUES (1, '0123456789abcdef', 1, ?1, 0)",
                rusqlite::params![vec![7u8; 32]],
            )
            .unwrap();
        }
        state
    }

    /// **The loop C1 was: a round trip's own last commit must not schedule the next one.**
    ///
    /// `client::round_trip` ends by writing [`client::LAST_SYNC_AT`] into `sync_state` on the
    /// very connection the commit hook is installed on, so that stamp rings the doorbell like
    /// any other transaction. `sync_state` is not on `schema::SYNCED_TABLES`, so it carries no
    /// capture trigger and leaves no op — and this is the assertion that the arm's gate reads
    /// that and schedules nothing. Ungated, this stamp scheduled a trip 3 s later, which wrote
    /// the stamp again, for ever.
    #[tokio::test]
    async fn a_round_trips_own_last_sync_stamp_leaves_nothing_to_push() {
        let state = in_a_group_state("live-last-sync-stamp");
        {
            let conn = state.lock_db();
            client::set_state(&conn, client::LAST_SYNC_AT, "1756600000").unwrap();
        }
        assert!(
            !outbox_has_work(&state).await,
            "the round trip's own stamp must not schedule the next round trip"
        );
    }

    /// The other half of the same loop: a **failing** trip writes an `error_log` row inside the
    /// same closure, and that commit rings the same bell. `error_log` is not synced either, so
    /// an error row **with nothing else pending** leaves the outbox with nothing to find. That
    /// is narrower than it sounds and deliberately so: with a pending op present, the gate
    /// answers `true` and a trip that keeps failing keeps retrying every three seconds while the
    /// socket is up, its own `error_log` commit ringing the bell each time — see "What is still
    /// owed" in `sync.md`.
    #[tokio::test]
    async fn a_failed_trips_error_row_leaves_nothing_to_push() {
        let state = in_a_group_state("live-error-row");
        {
            let conn = state.lock_db();
            crate::errors::record(
                &conn,
                Source::Relay,
                OPERATION,
                Kind::Other,
                "the relay did not answer",
                None,
            );
        }
        assert!(
            !outbox_has_work(&state).await,
            "a background failure must not schedule its own retry storm"
        );
    }

    /// And the case the whole wake exists for, so the gate above is not simply "never". A write
    /// to a synced table fires the capture trigger in the same transaction, so by the time the
    /// commit hook's notification is answered the op is there.
    #[tokio::test]
    async fn a_user_edit_is_something_to_push() {
        let state = in_a_group_state("live-user-edit");
        {
            let conn = state.lock_db();
            conn.execute(
                "INSERT INTO decks (name, created_at, updated_at) VALUES ('Bant', 0, 0)",
                [],
            )
            .unwrap();
        }
        assert!(
            outbox_has_work(&state).await,
            "an edit to a synced table is exactly what the doorbell is for"
        );
    }

    /// **The wake is the host's observer, and it is a commit that rings it**: a write through a
    /// state built with a [`WriteWake`] leaves the bell a ring for a loop that was not waiting,
    /// and a rolled-back one leaves none — the wiring the Android host and the desktop each do
    /// at their open.
    #[test]
    fn a_commit_through_the_state_rings_the_hosts_bell_and_a_rollback_does_not() {
        let writes = Arc::new(Bell::new());
        let state = State::new(
            crate::schema::memory_pair(),
            None,
            std::path::PathBuf::from("nowhere"),
            crate::events::silent(),
            vec![Arc::new(WriteWake(writes.clone()))],
            crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            crate::images::Cache::new(std::path::PathBuf::from("nowhere").join("images")),
        );
        assert!(writes.rung().now_or_never().is_none(), "nothing written");

        state
            .lock_db()
            .execute_batch(
                "BEGIN;
                 INSERT INTO decks (name, format_key, created_at, updated_at)
                   VALUES ('abandoned', 'casual', 0, 0);
                 ROLLBACK;",
            )
            .unwrap();
        assert!(
            writes.rung().now_or_never().is_none(),
            "a rollback is not a commit, and must not ring"
        );

        state
            .lock_db()
            .execute(
                "INSERT INTO decks (name, format_key, created_at, updated_at)
                 VALUES ('kept', 'casual', 0, 0)",
                [],
            )
            .unwrap();
        assert!(
            writes.rung().now_or_never().is_some(),
            "a commit with nobody waiting must leave the loop a ring"
        );
    }

    // -----------------------------------------------------------------------------------
    // The loop itself
    // -----------------------------------------------------------------------------------

    /// [`current`] is one value for the whole process, so the tests that run a loop take turns.
    /// An async lock: each is held across the test's own awaits.
    static ONE_LOOP: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    fn said(state: &str) -> (String, serde_json::Value) {
        ("sync:live".to_owned(), json!({ "state": state }))
    }

    /// **A device in no group opens no socket, and says `off` once** — however many times the
    /// idle poll comes round. `Connecting` is said before anything is dialled, so its absence
    /// is the absence of a dial; and the second half proves the loop was polling all along,
    /// rather than asleep where a broken test would also find one `off`: put in a group, it
    /// notices inside one poll and only then says anything else.
    ///
    /// On a paused clock, so a minute of idle polls costs none.
    #[tokio::test(start_paused = true)]
    async fn a_device_in_no_group_opens_no_socket_and_says_off_exactly_once() {
        let _turn = ONE_LOOP.lock().await;
        let (state, heard, _dir) = crate::state::fixtures::listening("live-loop-no-group");
        let writes = Arc::new(Bell::new());
        let running = tokio::spawn(run(state.clone(), writes));

        // Twelve idle polls.
        tokio::time::sleep(IDLE_POLL * 12).await;
        assert_eq!(
            heard.taken(),
            [said("off")],
            "one `off`, and nothing that would mean a dial"
        );
        assert_eq!(current(), LiveState::Off);

        // In a group now, with no grant, and a relay that hangs up on whatever asks: the next
        // poll finds the group. (Something that answers rather than a closed port, because a
        // refused connection takes Windows two seconds to report, and the loop's first act in
        // a group is a round trip.)
        let nobody = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = nobody.local_addr().unwrap().port();
        let hanging_up = tokio::spawn(async move {
            loop {
                let _ = nobody.accept().await;
            }
        });
        {
            let conn = state.lock_db();
            client::set_state(
                &conn,
                client::RELAY_URL,
                &format!("http://127.0.0.1:{port}"),
            )
            .unwrap();
            let me = identity::ensure(&conn).unwrap();
            identity::create_group(&conn, &me).unwrap();
        }
        // Bounded by the real clock: the paused one runs as fast as the loop lets it.
        let mut events = Vec::new();
        let waiting = Tick::now();
        while events.is_empty() && waiting.elapsed() < Duration::from_secs(20) {
            tokio::time::sleep(IDLE_POLL).await;
            events.extend(heard.taken());
        }
        running.abort();
        hanging_up.abort();
        assert_eq!(
            events.first(),
            Some(&said("connecting")),
            "the loop was polling, and noticed the group: {events:?}"
        );
        assert!(
            !events.contains(&said("off")),
            "and `off` is not said again on the way: {events:?}"
        );
    }

    /// The `error_log` rows the background loop has written, as `(message, count)`.
    fn live_rows(state: &State) -> Vec<(String, i64)> {
        let conn = state.lock_db();
        let mut stmt = conn
            .prepare(
                "SELECT message, count FROM error_log
                 WHERE source = 'relay' AND operation = 'live' ORDER BY id",
            )
            .unwrap();
        let rows = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        rows
    }

    /// What the stand-in relay saw of one socket.
    #[derive(Debug, Default)]
    struct Asked {
        path: String,
        authorization: Option<String>,
    }

    /// The stand-in relay's end of one socket.
    type Peer = tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>;

    /// Offer one connection an upgrade, keeping what its request said. `None` for a connection
    /// that was not asking for one — a round trip's plain request, which the stand-in cannot
    /// answer and lets fall away.
    async fn upgraded(stream: tokio::net::TcpStream) -> Option<(Peer, Asked)> {
        let mut asked = Asked::default();
        // The refusal this callback could answer is a whole HTTP response — tungstenite's
        // contract for it — and this one never refuses.
        #[allow(clippy::result_large_err)]
        let keep = |request: &Request, response: Response| -> Result<Response, ErrorResponse> {
            asked.path = request.uri().to_string();
            asked.authorization = request
                .headers()
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .map(str::to_owned);
            Ok(response)
        };
        let peer = tokio_tungstenite::accept_hdr_async(stream, keep)
            .await
            .ok()?;
        Some((peer, asked))
    }

    /// How many failures the background loop has noted, however they folded into rows.
    fn noted(state: &State) -> i64 {
        live_rows(state).iter().map(|(_, count)| count).sum()
    }

    /// **The connected loop on one connection and one thread.** The test above it never brings
    /// a socket up, so three things the loop only does under one went unwalked there: the
    /// keepalive, the cursor read a `head` frame asks for, and the outbox gate a commit rings.
    /// Here the socket comes up, on a state whose write connection carries the wake, and the
    /// stand-in sends a `head` ahead of this device's cursor — each step on the one connection,
    /// on a thread where a lock taken twice is a panic ([`crate::platform::alone`]).
    ///
    /// What shows each was walked: the stand-in's first frame is the ping; a trip follows the
    /// `head`, which only a cursor read behind it schedules; and the bell has no ring left in
    /// it, though every failed trip's row was a commit that rang it.
    #[tokio::test]
    async fn the_connected_loop_takes_no_lock_twice_on_one_connection_and_one_thread() {
        use futures_util::SinkExt;

        let _turn = ONE_LOOP.lock().await;
        let soon = Duration::from_secs(20);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        // `state::fixtures::single`'s shape, with the wake registered as a host registers it.
        let dir = crate::scratch::path("live-loop-alone-connected");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let opened = crate::db::open_single(&dir).unwrap();
        crate::schema::build_pair(&opened.conn);
        let heard = Arc::new(Recording::default());
        let writes = Arc::new(Bell::new());
        let state = Arc::new(State::new(
            opened.conn,
            None,
            dir.clone(),
            heard.clone(),
            vec![Arc::new(WriteWake(writes.clone()))],
            crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            crate::images::Cache::new(dir.join("images")),
        ));
        assert!(state.one_connection());
        {
            let conn = state.lock_db();
            client::set_state(
                &conn,
                client::RELAY_URL,
                &format!("http://127.0.0.1:{port}"),
            )
            .unwrap();
            let me = identity::ensure(&conn).unwrap();
            identity::create_group(&conn, &me).unwrap();
            let tomorrow = crate::platform::clock::now_secs() + 24 * 60 * 60;
            entitlement::store_grant(&conn, "tok", "refresh", tomorrow).unwrap();
        }

        // The relay's side: the socket is heard once, then holds until the test says to ring,
        // sends a `head` ahead of any cursor this device has, and goes on reading — which is
        // what answers the ping.
        let (tell, mut told) = tokio::sync::mpsc::unbounded_channel();
        let ring = Arc::new(tokio::sync::Notify::new());
        let relay = {
            let ring = ring.clone();
            tokio::spawn(async move {
                loop {
                    let (stream, _) = listener.accept().await.unwrap();
                    let (tell, ring) = (tell.clone(), ring.clone());
                    tokio::spawn(async move {
                        let Some((mut peer, _asked)) = upgraded(stream).await else {
                            return;
                        };
                        let first = peer.next().await;
                        let _ = tell.send(first);
                        ring.notified().await;
                        let head = r#"{"t":"head","cursor":5,"from":"d2"}"#;
                        let _ = peer.send(Message::Text(head.into())).await;
                        while peer.next().await.is_some() {}
                    });
                }
            })
        };

        let _alone = crate::platform::alone::emulate();
        let running = tokio::spawn(run(state.clone(), writes.clone()));
        let waiting = Tick::now();
        let still_running = |what: &str| {
            assert!(
                !running.is_finished(),
                "the loop ended, which it never does: a lock taken twice is a panic here"
            );
            assert!(waiting.elapsed() < soon, "{what}");
        };

        let first = tokio::time::timeout(soon, told.recv())
            .await
            .expect("the loop never dialled")
            .expect("the stand-in is still listening");
        assert!(
            matches!(&first, Some(Ok(Message::Ping(payload))) if payload.is_empty()),
            "the keepalive is the socket's first word: {first:?}"
        );

        // The launch's trip and the reconnect's, neither of which the stand-in can answer.
        while noted(&state) < 2 {
            still_running("the trips around the socket were never noted");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let before = noted(&state);

        // The doorbell. A second and a tick later, the trip it asked for.
        ring.notify_one();
        while noted(&state) == before {
            still_running("a `head` ahead of the cursor scheduled no trip");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        still_running("the loop is still up");

        // Every one of those rows was a commit, and each rang the bell while the loop was
        // inside the trip that wrote it. None is left: the outbox gate took them.
        assert!(
            writes.rung().now_or_never().is_none(),
            "a ring was left in the bell, so the commit arm never asked the outbox"
        );
        let events = heard.taken();
        running.abort();
        relay.abort();
        assert_eq!(
            events,
            [said("connecting"), said("live")],
            "the socket came up and stayed up"
        );
    }

    /// **The whole loop against a socket that really answers**: a device in a group, holding a
    /// token, dials the relay's address as a WebSocket with its bearer in `Authorization`, says
    /// `connecting` and then `live`, pings at once, and — told its group is gone — says
    /// `offline` and writes the row a reader can find.
    ///
    /// The stand-in is a listener on loopback that upgrades whatever asks to. It is no relay:
    /// the round trips the loop makes around the socket are plain HTTP requests it cannot
    /// answer, so each fails, and those failures are part of what is asserted — a trip that
    /// fails is a `live` row too, and the socket comes up regardless (spec §6.4's two different
    /// things to be allowed to do, the other way round).
    #[tokio::test]
    async fn a_device_in_a_group_dials_with_its_bearer_goes_live_and_backs_off_when_removed() {
        let _turn = ONE_LOOP.lock().await;
        let soon = Duration::from_secs(20);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        let (state, heard, _dir) = crate::state::fixtures::listening("live-loop-in-a-group");
        let group = {
            let conn = state.lock_db();
            client::set_state(
                &conn,
                client::RELAY_URL,
                &format!("http://127.0.0.1:{port}"),
            )
            .unwrap();
            let me = identity::ensure(&conn).unwrap();
            let group = identity::create_group(&conn, &me).unwrap();
            // A token with a day left in it, so the loop asks no door for one.
            let tomorrow = crate::platform::clock::now_secs() + 24 * 60 * 60;
            entitlement::store_grant(&conn, "tok", "refresh", tomorrow).unwrap();
            (me.device_id, group.group_id)
        };

        // The relay's side: every connection is offered an upgrade, each on a task of its own —
        // a round trip's request must fall away at once while the socket is being held. The
        // one that takes the upgrade is the socket: it is heard once, told its group is gone,
        // and read to its end.
        let (tell, mut told) = tokio::sync::mpsc::unbounded_channel();
        let relay = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let tell = tell.clone();
                tokio::spawn(async move {
                    let Some((mut peer, asked)) = upgraded(stream).await else {
                        return;
                    };
                    // The first thing a fresh socket sends is its keepalive.
                    let first = peer.next().await;
                    let _ = peer
                        .close(Some(CloseFrame {
                            code: CloseCode::from(CLOSE_GROUP_GONE),
                            reason: "gone".into(),
                        }))
                        .await;
                    // Read to the end, so the close handshake completes.
                    while peer.next().await.is_some() {}
                    let _ = tell.send((asked, first));
                });
            }
        });

        let writes = Arc::new(Bell::new());
        let running = tokio::spawn(run(state.clone(), writes));
        let (asked, first) = tokio::time::timeout(soon, told.recv())
            .await
            .expect("the loop never dialled")
            .expect("the stand-in is still listening");

        // Until the loop has said how it ended. The row is written before `offline` is said,
        // so it is there by then.
        let mut events = Vec::new();
        let waiting = Tick::now();
        while !events.contains(&said("offline")) {
            assert!(waiting.elapsed() < soon, "never went offline: {events:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
            events.extend(heard.taken());
        }
        let rows = live_rows(&state);
        running.abort();
        relay.abort();

        let (device, group) = group;
        assert_eq!(asked.authorization.as_deref(), Some("Bearer tok"));
        assert_eq!(asked.path, format!("/g/{group}/ws?device={device}"));
        assert!(
            matches!(&first, Some(Ok(Message::Ping(payload))) if payload.is_empty()),
            "a fresh socket's first word is a protocol ping: {first:?}"
        );

        let live: Vec<_> = events
            .iter()
            .filter(|(name, _)| name == "sync:live")
            .cloned()
            .collect();
        // The first three: the backoff behind `offline` is a second at least, but a machine
        // busy enough could let the loop come round again before this looked.
        assert_eq!(
            live.get(..3),
            Some(&[said("connecting"), said("live"), said("offline")][..]),
            "each state once, in order: {live:?}"
        );
        assert!(
            !events.iter().any(|(name, _)| name == "sync:applied"),
            "no trip succeeded, so nothing was applied: {events:?}"
        );

        assert!(
            rows.iter().any(|(m, _)| m == GROUP_GONE),
            "the removal is a row a reader can find: {rows:?}"
        );
        assert!(
            rows.iter().any(|(m, _)| m != GROUP_GONE),
            "and the launch's trip, which this stand-in cannot answer, is another: {rows:?}"
        );
    }

    /// **The loop on a host with one connection and one thread** — a browser's shape, stood in
    /// for natively ([`crate::platform::alone`]): every read goes through the connection every
    /// write does, and work "on the pool" or "on a worker" is on the caller. A lock the loop
    /// took twice would be a panic here with the line that asked, where on a desktop it is two
    /// mutexes and nobody ever sees it.
    ///
    /// In a group from the start, against a relay that hangs up, so one pass of the loop walks
    /// every step that touches the database: the group read, a trip and the row for its
    /// failure, the token for the upgrade, the note for the socket that never came up.
    #[tokio::test]
    async fn the_loop_takes_no_lock_twice_on_one_connection_and_one_thread() {
        let _turn = ONE_LOOP.lock().await;
        let soon = Duration::from_secs(20);
        let nobody = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = nobody.local_addr().unwrap().port();
        let hanging_up = tokio::spawn(async move {
            loop {
                let _ = nobody.accept().await;
            }
        });

        let (state, heard, _dir) =
            crate::state::fixtures::single("live-loop-alone", "http://127.0.0.1:1");
        assert!(state.one_connection());
        {
            let conn = state.lock_db();
            client::set_state(
                &conn,
                client::RELAY_URL,
                &format!("http://127.0.0.1:{port}"),
            )
            .unwrap();
            let me = identity::ensure(&conn).unwrap();
            identity::create_group(&conn, &me).unwrap();
        }

        let _alone = crate::platform::alone::emulate();
        let writes = Arc::new(Bell::new());
        let running = tokio::spawn(run(state.clone(), writes));

        let mut events = Vec::new();
        let waiting = Tick::now();
        while !events.contains(&said("offline")) {
            assert!(
                !running.is_finished(),
                "the loop ended, which it never does: a lock taken twice is a panic here"
            );
            assert!(waiting.elapsed() < soon, "never went offline: {events:?}");
            tokio::time::sleep(Duration::from_millis(10)).await;
            events.extend(heard.taken());
        }
        let rows = live_rows(&state);
        assert!(!running.is_finished());
        running.abort();
        hanging_up.abort();

        assert_eq!(
            events.get(..2),
            Some(&[said("connecting"), said("offline")][..]),
            "no socket came up, and the loop said so: {events:?}"
        );
        // Two failures, which fold into one row when they say the same sentence.
        let noted: i64 = rows.iter().map(|(_, count)| count).sum();
        assert!(
            noted >= 2,
            "the trip that failed and the socket that could not be dialled are each noted: \
             {rows:?}"
        );
    }

    // -----------------------------------------------------------------------------------
    // What the loop records, on a device that pressed Connect and on one that only paired
    // -----------------------------------------------------------------------------------

    /// How a device came to be entitled.
    #[derive(Debug, Clone, Copy)]
    enum Door {
        /// It pressed Connect: a refresh secret, and the token it minted.
        Claimed,
        /// It joined by pairing and never pressed Connect: no secret, and what the relay's
        /// group door last answered — a token and `active`.
        PairedOnly,
    }

    /// A device in a group, entitled through `door`, whose relay is `relay`. Answers the state,
    /// the group's id and its epoch.
    fn entitled_through(name: &str, door: Door, relay: &str) -> (Arc<State>, String, i64) {
        let (state, _dir) = crate::state::fixtures::on_files(name, "http://127.0.0.1:1");
        let (group, epoch) = {
            let conn = state.lock_db();
            client::set_state(&conn, client::RELAY_URL, relay).unwrap();
            let me = identity::ensure(&conn).unwrap();
            let group = identity::create_group(&conn, &me).unwrap();
            let now = crate::platform::clock::now_secs();
            let tomorrow = now + 24 * 60 * 60;
            match door {
                Door::Claimed => {
                    entitlement::store_grant(&conn, "tok", "refresh", tomorrow).unwrap();
                }
                Door::PairedOnly => entitlement::store_access(&conn, "tok", tomorrow).unwrap(),
            }
            entitlement::store_status(&conn, "active", Some(now)).unwrap();
            assert!(commands::entitled(&conn), "{door:?} is entitled");
            assert!(!lapsed(&conn), "{door:?} has not lapsed");
            (group.group_id, group.epoch)
        };
        (state, group, epoch)
    }

    /// **A background failure is recorded on a device that only ever paired, as on one that
    /// pressed Connect** — the trip that failed, and the socket that fell.
    ///
    /// Until 2026-10-04 the loop asked `entitlement::membership_ended` alone, which is also true
    /// of a healthy paired-only device (no refresh secret, a status the group door wrote), so
    /// that device — the light app's commonest: a phone or a browser pairs, the desktop holds
    /// the membership — recorded nothing at all, and both counts below were 0 for it.
    #[tokio::test]
    async fn a_background_failure_is_recorded_whichever_door_the_device_is_entitled_through() {
        for door in [Door::Claimed, Door::PairedOnly] {
            let server = httpmock::MockServer::start();
            server.mock(|when, then| {
                when.any_request();
                then.status(500).body("down");
            });
            let (state, _group, _epoch) =
                entitled_through(&format!("live-records-{door:?}"), door, &server.base_url());

            trip(&state, &mut Scheduler::new()).await;
            assert_eq!(
                noted(&state),
                1,
                "{door:?}: a trip the relay answered 500 to is a row: {:?}",
                live_rows(&state)
            );

            note(&state, SOCKET_CLOSED.to_owned()).await;
            let rows = live_rows(&state);
            assert!(
                rows.iter().any(|(message, _)| message == SOCKET_CLOSED),
                "{door:?}: and a socket that fell is another: {rows:?}"
            );
            assert_eq!(noted(&state), 2, "{door:?}: {rows:?}");
        }
    }

    /// **A lapse is never recorded, whichever door the device is entitled through.** The relay
    /// answers this device's token with a 401 on a sync route — the membership behind the group
    /// has ended — and the trip fails without a row, on the device that pressed Connect and on
    /// one that only paired; and what the loop notes of the socket afterwards is left out too.
    /// A row there would send a reader whose pledge lapsed to look at their network.
    #[tokio::test]
    async fn a_lapse_is_never_recorded_whichever_door_the_device_is_entitled_through() {
        for door in [Door::Claimed, Door::PairedOnly] {
            let server = httpmock::MockServer::start();
            let (state, group, epoch) =
                entitled_through(&format!("live-lapse-{door:?}"), door, &server.base_url());
            // The key check is ahead of the token and is not what refuses: this epoch, no blob.
            server.mock(|when, then| {
                when.method(httpmock::Method::GET)
                    .path(format!("/g/{group}/keys"));
                then.status(200)
                    .json_body(json!({ "epoch": epoch, "blob": null, "devices": [] }));
            });
            let refused = server.mock(|when, then| {
                when.method(httpmock::Method::GET)
                    .path(format!("/g/{group}/pull"));
                then.status(401).body("unauthorized");
            });

            trip(&state, &mut Scheduler::new()).await;
            refused.assert();
            {
                let conn = state.lock_db();
                assert!(
                    lapsed(&conn),
                    "{door:?}: the relay refused the token, so the membership has ended"
                );
                assert!(entitlement::membership_ended(&conn));
                assert!(!commands::entitled(&conn));
            }
            assert_eq!(
                live_rows(&state),
                Vec::<(String, i64)>::new(),
                "{door:?}: a lapse is not a broken sync, and leaves no row"
            );

            note(&state, SOCKET_CLOSED.to_owned()).await;
            assert_eq!(
                noted(&state),
                0,
                "{door:?}: nor does the socket that fell behind it"
            );
        }
    }

    // -----------------------------------------------------------------------------------
    // A device that left, was removed or changed group lets go of its socket
    // -----------------------------------------------------------------------------------

    /// An observer that says when the commit hook has fired and then **holds the hook open** —
    /// the commit is under way and not yet anybody else's to see — until it is told to go on.
    /// Armed for one commit, so the fixture's own writes pass straight through.
    struct HeldCommit {
        armed: std::sync::atomic::AtomicBool,
        fired: std::sync::Mutex<std::sync::mpsc::Sender<()>>,
        go_on: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    }

    impl crate::hooks::WriteObserver for HeldCommit {
        fn committed(&self) {
            if self.armed.swap(false, Ordering::SeqCst) {
                let _ = self.fired.lock().unwrap().send(());
                let _ = self
                    .go_on
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(20));
            }
        }
    }

    /// **Which connection sees a group that has just been left, at the moment its commit rings
    /// the bell: the write connection, behind the writer — and not the read one.**
    ///
    /// The hook fires before the commit is anybody else's to see. Held open here, on a host
    /// with two connections the read connection still answers the group that is being deleted,
    /// which is the look that would have kept the socket for ever; the loop's look
    /// ([`group_on`], over [`State::db`]) waits for the writer and then answers no group. On a
    /// host with one connection there is no other connection to be wrong on, and the same look
    /// gives the same answer.
    #[test]
    fn the_look_behind_a_commit_sees_what_it_committed() {
        let soon = Duration::from_secs(20);
        for one_connection in [false, true] {
            let dir = crate::scratch::path(if one_connection {
                "live-look-one-connection"
            } else {
                "live-look-two-connections"
            });
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let (write, read) = if one_connection {
                let conn = crate::db::open_single(&dir).unwrap().conn;
                crate::schema::build_pair(&conn);
                (conn, None)
            } else {
                let conn = crate::db::open_write(&dir).unwrap();
                crate::schema::build_pair(&conn);
                (conn, Some(crate::db::open_read(&dir).unwrap()))
            };
            let (fired, heard) = std::sync::mpsc::channel();
            let (go_on, waiting) = std::sync::mpsc::channel();
            let held = Arc::new(HeldCommit {
                armed: std::sync::atomic::AtomicBool::new(false),
                fired: std::sync::Mutex::new(fired),
                go_on: std::sync::Mutex::new(waiting),
            });
            let observer: Arc<dyn crate::hooks::WriteObserver> = held.clone();
            let state = Arc::new(State::new(
                write,
                read,
                dir.clone(),
                crate::events::silent(),
                vec![observer],
                crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                crate::images::Cache::new(dir.join("images")),
            ));
            assert_eq!(state.one_connection(), one_connection);
            let group = {
                let conn = state.lock_db();
                let me = identity::ensure(&conn).unwrap();
                identity::create_group(&conn, &me).unwrap().group_id
            };
            assert_eq!(
                group_on(&state.db, soon),
                Some(Some(group)),
                "in its group, before anything leaves"
            );

            // The departure, on a thread of its own, stopped inside its commit.
            held.armed.store(true, Ordering::SeqCst);
            let writer = {
                let state = state.clone();
                std::thread::spawn(move || {
                    let conn = state.lock_db();
                    identity::leave_group(&conn).unwrap();
                })
            };
            heard.recv_timeout(soon).expect("the commit hook fired");

            if !one_connection {
                // The trap: the bell has rung, and the read connection has not seen the commit.
                let stale = identity::group(&state.lock_db_read()).unwrap();
                assert!(
                    stale.is_some(),
                    "the read connection already sees the departure, so the hook no longer \
                     fires ahead of the commit and this test's premise has moved"
                );
            }

            // The loop's look, asked now: it waits for the writer rather than answering early.
            let look = {
                let state = state.clone();
                std::thread::spawn(move || group_on(&state.db, soon))
            };
            std::thread::sleep(Duration::from_millis(100));
            assert!(
                !look.is_finished(),
                "the look answered while the commit was still under way"
            );
            go_on.send(()).unwrap();
            assert_eq!(
                look.join().unwrap(),
                Some(None),
                "behind the commit, the device is in no group ({} connection)",
                if one_connection { "one" } else { "two" }
            );
            writer.join().unwrap();

            // And a look that cannot have the connection in its wait says so, and decides
            // nothing.
            let busy = state.lock_db();
            assert_eq!(group_on(&state.db, Duration::from_millis(20)), None);
            assert!(!let_go("g", as_membership(&None)));
            drop(busy);
        }
    }

    /// A stand-in relay that upgrades whatever asks, says what each socket asked for, and then
    /// does what `then` says with it. Requests that are not upgrades — the loop's trips — fall
    /// away, as in the tests above.
    fn stand_in<F, Fut>(
        listener: tokio::net::TcpListener,
        then: F,
    ) -> (
        tokio::task::JoinHandle<()>,
        tokio::sync::mpsc::UnboundedReceiver<String>,
    )
    where
        F: Fn(Peer) -> Fut + Send + Sync + 'static,
        Fut: std::future::Future<Output = ()> + Send + 'static,
    {
        let (tell, told) = tokio::sync::mpsc::unbounded_channel();
        let then = Arc::new(then);
        let relay = tokio::spawn(async move {
            loop {
                let (stream, _) = listener.accept().await.unwrap();
                let (tell, then) = (tell.clone(), then.clone());
                tokio::spawn(async move {
                    let Some((peer, asked)) = upgraded(stream).await else {
                        return;
                    };
                    let _ = tell.send(asked.path);
                    then(peer).await;
                });
            }
        });
        (relay, told)
    }

    /// A device in a group it founded, holding a day's token, whose relay is the stand-in on
    /// `port`. Answers the state, what a page would hear, and the group's id.
    fn paired(name: &str, port: u16) -> (Arc<State>, Arc<Recording>, String) {
        let (state, heard, _dir) = crate::state::fixtures::listening(name);
        let group = {
            let conn = state.lock_db();
            client::set_state(
                &conn,
                client::RELAY_URL,
                &format!("http://127.0.0.1:{port}"),
            )
            .unwrap();
            let me = identity::ensure(&conn).unwrap();
            let group = identity::create_group(&conn, &me).unwrap();
            let tomorrow = crate::platform::clock::now_secs() + 24 * 60 * 60;
            entitlement::store_grant(&conn, "tok", "refresh", tomorrow).unwrap();
            group.group_id
        };
        (state, heard, group)
    }

    /// Wait until the page has heard `state`, keeping everything it heard on the way.
    async fn until_said(heard: &Recording, events: &mut Vec<(String, Value)>, state: &str) {
        let waiting = Tick::now();
        while !events.contains(&said(state)) {
            assert!(
                waiting.elapsed() < Duration::from_secs(30),
                "never said {state}: {events:?}"
            );
            tokio::time::sleep(Duration::from_millis(10)).await;
            events.extend(heard.taken());
        }
    }

    /// **The twelve-hour bug.** A device that leaves its group under a live socket lets go of
    /// the socket at the commit that took it out — the relay's end sees it close — says `off`
    /// without ever saying `offline`, and writes no row for it; and put into *another* group
    /// it dials that group's address. Before the loop looked, it kept the first group's socket
    /// until it aged out, reading `live`, and the second group's doorbell rang on nobody.
    #[tokio::test]
    async fn a_device_that_leaves_lets_go_of_its_socket_and_dials_for_the_group_it_joins() {
        let _turn = ONE_LOOP.lock().await;
        let soon = Duration::from_secs(30);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let (closed, mut ended) = tokio::sync::mpsc::unbounded_channel();
        // The relay's side holds each socket and reads it to its end, then says it ended.
        let (relay, mut dialled) = stand_in(listener, move |mut peer| {
            let closed = closed.clone();
            async move {
                while let Some(Ok(_)) = peer.next().await {}
                let _ = closed.send(());
            }
        });
        let (state, heard, first) = paired("live-loop-lets-go", port);

        let writes = Arc::new(Bell::new());
        let running = tokio::spawn(run(state.clone(), writes.clone()));
        let mut events = Vec::new();
        until_said(&heard, &mut events, "live").await;
        let path = tokio::time::timeout(soon, dialled.recv())
            .await
            .unwrap()
            .unwrap();
        assert!(path.starts_with(&format!("/g/{first}/ws")), "{path}");
        // The two trips around a fresh socket, which the stand-in cannot answer, are noted;
        // nothing after this may be.
        while noted(&state) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let before = live_rows(&state);

        // *Leave group*, as far as this database is concerned — and the ring its commit gives
        // the bell a host registers on the write connection (this fixture registers none).
        {
            let conn = state.lock_db();
            identity::leave_group(&conn).unwrap();
            entitlement::clear(&conn).unwrap();
        }
        writes.ring();

        until_said(&heard, &mut events, "off").await;
        tokio::time::timeout(soon, ended.recv())
            .await
            .expect("the relay's end never saw the socket close")
            .unwrap();
        assert_eq!(
            events,
            [said("connecting"), said("live"), said("off")],
            "let go of, not lost: `offline` is the word for a broken sync"
        );
        assert_eq!(current(), LiveState::Off);
        assert_eq!(
            live_rows(&state),
            before,
            "letting go is not a failure, and leaves no row"
        );

        // Into another group. The loop's idle read finds it and dials *its* address.
        let second = {
            let conn = state.lock_db();
            let me = identity::ensure(&conn).unwrap();
            let group = identity::create_group(&conn, &me).unwrap();
            let tomorrow = crate::platform::clock::now_secs() + 24 * 60 * 60;
            entitlement::store_grant(&conn, "tok", "refresh", tomorrow).unwrap();
            group.group_id
        };
        assert_ne!(second, first);
        let path = tokio::time::timeout(soon, dialled.recv())
            .await
            .expect("the loop never dialled for the group it joined")
            .unwrap();
        running.abort();
        relay.abort();
        assert!(
            path.starts_with(&format!("/g/{second}/ws")),
            "the socket is the new group's: {path}"
        );
    }

    /// **A 4001 on a device that is itself leaving is its own doing, and is quiet.** The
    /// departure it published is what made the relay close the socket, a moment before the
    /// press clears the group here; the loop asks behind the sync lane, which the press holds,
    /// so it reads the close after the group has gone: `off`, never `offline`, and no row
    /// saying the relay removed it. (The control — a 4001 on a device still in its group — is
    /// `a_device_in_a_group_dials_with_its_bearer_goes_live_and_backs_off_when_removed`.)
    #[tokio::test]
    async fn a_4001_that_lands_inside_this_devices_own_departure_is_not_a_removal() {
        let _turn = ONE_LOOP.lock().await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let close = Arc::new(tokio::sync::Notify::new());
        let (relay, _dialled) = stand_in(listener, {
            let close = close.clone();
            move |mut peer| {
                let close = close.clone();
                async move {
                    close.notified().await;
                    let _ = peer
                        .close(Some(CloseFrame {
                            code: CloseCode::from(CLOSE_GROUP_GONE),
                            reason: "removed".into(),
                        }))
                        .await;
                    while peer.next().await.is_some() {}
                }
            }
        });
        let (state, heard, _group) = paired("live-loop-own-departure", port);
        let writes = Arc::new(Bell::new());
        let running = tokio::spawn(run(state.clone(), writes));
        let mut events = Vec::new();
        until_said(&heard, &mut events, "live").await;
        while noted(&state) < 2 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        // The press: the lane taken, the departure published — the relay closes the socket —
        // and only then the group cleared, still on the lane.
        {
            let lane = state.lane().await;
            close.notify_one();
            // Long enough for the close to arrive and the loop to be asking after it.
            tokio::time::sleep(Duration::from_millis(300)).await;
            events.extend(heard.taken());
            assert!(
                !events.contains(&said("offline")),
                "the loop decided before the departure had finished: {events:?}"
            );
            crate::state::Store::with(&lane, |conn| {
                identity::leave_group(conn)?;
                entitlement::clear(conn)
            })
            .unwrap();
        }

        until_said(&heard, &mut events, "off").await;
        let rows = live_rows(&state);
        running.abort();
        relay.abort();
        assert_eq!(
            events,
            [said("connecting"), said("live"), said("off")],
            "its own departure is not a broken sync"
        );
        assert!(
            !rows.iter().any(|(m, _)| m == GROUP_GONE),
            "and is not recorded as the relay removing it: {rows:?}"
        );
    }

    /// **A device in no group is not a failed dial.** The trip in front of a dial is where a
    /// removed device learns it was removed; what follows must be `off`, not a backoff and a
    /// row. And a device that *is* in a group and cannot get a token is still a failure, as it
    /// was.
    #[tokio::test]
    async fn a_dial_with_no_group_to_dial_for_is_let_go_of_and_one_with_no_token_still_fails() {
        let _turn = ONE_LOOP.lock().await;
        let (state, _heard, _dir) = crate::state::fixtures::listening("live-dial-no-group");
        let writes = Arc::new(Bell::new());
        let mut sched = Scheduler::new();
        let mut signal = Signal::new();

        let ended = connect_once(&state, &writes, &mut sched, &mut signal).await;
        assert_eq!(ended.cause, Disconnect::Left);
        assert_eq!(ended.error, None);
        assert_eq!(next_attempt(3, ended.cause, ended.lived_ms), 3);
        assert!(!deserves_backoff(ended.cause));

        // In a group, with no grant and a relay that is not there: a failure, in a sentence.
        {
            let conn = state.lock_db();
            client::set_state(&conn, client::RELAY_URL, "http://127.0.0.1:1").unwrap();
            let me = identity::ensure(&conn).unwrap();
            identity::create_group(&conn, &me).unwrap();
        }
        let ended = connect_once(&state, &writes, &mut sched, &mut signal).await;
        assert_eq!(ended.cause, Disconnect::Failed);
        assert!(ended.error.is_some_and(|sentence| !sentence.is_empty()));
    }

    /// **A relay that takes the connection and never answers the upgrade is a failed socket
    /// after [`CONNECT_SECS`], in a sentence** — where it used to be a dial that returned
    /// whenever the stack underneath gave up, with the device reading `connecting` and running
    /// no trip meanwhile. On a paused clock, so the twenty seconds cost none.
    #[tokio::test(start_paused = true)]
    async fn a_dial_the_relay_never_answers_fails_at_its_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        // Accepts, keeps every connection open, and says nothing on any of them.
        let silent = tokio::spawn(async move {
            let mut kept = Vec::new();
            loop {
                if let Ok((stream, _)) = listener.accept().await {
                    kept.push(stream);
                }
            }
        });

        // Measured on the paused clock itself, by two waits around the deadline: still dialling
        // a second short of it, and answered within a second after.
        let url = format!("ws://127.0.0.1:{port}/g/abc/ws?device=d1");
        let dialling = dial(&url, "tok");
        tokio::pin!(dialling);
        let short = Duration::from_secs(CONNECT_SECS - 1);
        assert!(
            tokio::time::timeout(short, &mut dialling).await.is_err(),
            "the dial gave up before its deadline"
        );
        let refused = tokio::time::timeout(Duration::from_secs(2), &mut dialling)
            .await
            .expect("the dial outlived its deadline");
        silent.abort();
        assert_eq!(refused.err().as_deref(), Some(NO_ANSWER));
    }

    /// A `head` frame parses with or without the fields this build does not read, and a frame
    /// of another kind parses too — to be ignored by its `t`, not refused.
    #[test]
    fn a_head_frame_is_read_by_its_two_fields_and_nothing_else() {
        let head: HeadFrame =
            serde_json::from_str(r#"{"t":"head","cursor":7,"from":"d2","later":true}"#).unwrap();
        assert_eq!((head.t.as_str(), head.cursor), ("head", 7));
        let bare: HeadFrame = serde_json::from_str(r#"{"t":"head","cursor":7}"#).unwrap();
        assert_eq!(bare.cursor, 7);
        let other: HeadFrame = serde_json::from_str(r#"{"t":"later","cursor":1}"#).unwrap();
        assert_ne!(other.t, "head");
        assert!(serde_json::from_str::<HeadFrame>(r#"{"t":"head"}"#).is_err());
        assert!(serde_json::from_str::<HeadFrame>("ping").is_err());
    }

    /// The state is said once per change and kept for a page that asks later. In its turn with
    /// the loops, because saying a state writes the one [`current`] reads.
    #[tokio::test]
    async fn a_state_is_said_on_a_change_and_never_twice_running() {
        let _turn = ONE_LOOP.lock().await;
        let heard = Recording::default();
        let mut signal = Signal::new();
        for state in [
            LiveState::Connecting,
            LiveState::Connecting,
            LiveState::Offline,
            LiveState::Offline,
            LiveState::Connecting,
        ] {
            signal.set(&heard, state);
        }
        assert_eq!(
            heard.taken(),
            [said("connecting"), said("offline"), said("connecting")]
        );
        assert_eq!(current(), LiveState::Connecting);
    }

    /// **The read beside the event, through the table a light host answers by**: a page that
    /// mounts after the last `sync:live` asks `sync_live_state` and is told what it missed, in
    /// the word the event would have used.
    #[tokio::test]
    async fn the_table_answers_the_state_a_page_missed() {
        let _turn = ONE_LOOP.lock().await;
        let (state, _dir) = crate::state::fixtures::on_files("live-table", "http://127.0.0.1:1");
        let ask = || crate::commands::dispatch(&state, "sync_live_state", json!(null), None);
        let mut signal = Signal::new();

        signal.set(&*state.events, LiveState::Offline);
        assert_eq!(ask().await, Ok(json!("offline")));
        signal.set(&*state.events, LiveState::Live);
        assert_eq!(ask().await, Ok(json!("live")));
        signal.set(&*state.events, LiveState::Off);
        assert_eq!(ask().await, Ok(json!("off")));
        assert_eq!(LiveState::from_u8(LiveState::Live as u8), LiveState::Live);
        assert_eq!(LiveState::from_u8(200), LiveState::Off);
    }
}
