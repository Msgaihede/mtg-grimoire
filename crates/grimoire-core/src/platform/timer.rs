//! A wait a future awaits, and a bound on one.
//!
//! [`crate::platform::pause`] parks a *thread*, which is right for a lock a batch loop stands
//! aside from and wrong inside an `async fn`: there the wait has to give the task's thread back.
//! This is that wait. Natively it is the async runtime's timer; in a browser it is the Worker's
//! own `setTimeout`, awaited as a promise.
//!
//! **The native arm needs a runtime with a timer on the current task** — every host's async code
//! runs on one (Tauri's is tokio), and a call from outside it panics, as `tokio::time::sleep`
//! always has.
//!
//! **The browser arm first ran on 2026-10-04**, under the web host's first downloads in
//! headless Chrome 154 (`docs/reference/light-app.md` §9.2).
//! It reads `setTimeout` off the global object rather than off `window`, because the host that
//! calls it is a Worker and has none. **A deadline that was beaten clears its timer**: the
//! sleep it raced is dropped, and the timer goes with it — it used to be left to fire into
//! nothing, which was one stray timer for a relay request and would have been thousands for a
//! body bounded a chunk at a time (`http::Body::chunk_within`).
//!
//! **And a beat**: [`interval`], a first tick at once and then one a period, on [`sleep`] and
//! a monotonic tick rather than on either host's own interval — so live sync's connection
//! manager keeps one grid on every host.
//!
//! **And a turn given back to the host**: [`yield_to_host`], and [`Breather`], which takes one
//! on a budget of work. A loop of `chunk().await` and a synchronous push looks as though it
//! lets go at every `.await`, and in a browser it does not — the first measured run found a
//! page's commands waiting 3.5–8.4 s behind a card download for it. Both say why.
//!
//! **And a loop written once for both kinds of host**: [`Turn`] is what a batch loop awaits
//! in the gap where it has let go of the connection — a [`Breather`] where the host has one
//! thread, [`NoTurn`] where it has many — and [`unbroken`] runs the second kind to its end
//! where it stands, so the host with threads calls a function, as it always did.

use std::future::Future;
use std::time::Duration;

/// Come back after `duration`, and never before it.
pub async fn sleep(duration: Duration) {
    imp::sleep(duration).await
}

/// Run `future`, giving up after `duration`. `None` is the deadline passing with the future
/// unfinished — it is dropped, which for a request is the cancellation.
pub async fn timeout<F: Future>(duration: Duration, future: F) -> Option<F::Output> {
    imp::timeout(duration, future).await
}

/// [`timeout`], for a future whose answer arrives as **an event the host has queued** — a
/// socket's `open` — and whose deadline can therefore pass while the answer is already waiting.
///
/// A deadline is a timer, and in a browser a timer is one more queued task. After a synchronous
/// stretch longer than `duration` — a card ingest holds the engine's one thread for ten seconds
/// and more — the timer's task and the event's are *both* queued when the thread comes back,
/// and the order they run in is the host's. Timer first, and a plain [`timeout`] polls the
/// future while its event has not been delivered, sees it pending, and gives up on something
/// that had already happened: for a dial, an open socket dropped, with a row saying the relay
/// never answered.
///
/// So when the deadline passes this takes **one turn of the host** ([`yield_to_host`]) and polls
/// the future **once more** before giving up: whatever was queued beside the timer has then
/// run. A future still pending after that turn really is unanswered.
///
/// ⚠️ **Task ordering in a browser is not specified, and this does not pretend it is.** One turn
/// delivers what was queued *as a task* when the deadline ran — a `MessageChannel` message is
/// queued behind it. An answer that needs two turns, or that arrives a millisecond later, is
/// late by the deadline's own terms and is given up on, as it should be. The native test below
/// stages the order with a runtime whose order *is* known; it shows the second poll happens, not
/// what a browser does.
pub async fn timeout_after_a_last_turn<F: Future>(
    duration: Duration,
    future: F,
) -> Option<F::Output> {
    use futures_util::future::{select, Either};
    use futures_util::FutureExt as _;
    let mut future = std::pin::pin!(future);
    {
        let deadline = std::pin::pin!(sleep(duration));
        if let Either::Left((answered, _)) = select(future.as_mut(), deadline).await {
            return Some(answered);
        }
    }
    yield_to_host().await;
    future.as_mut().now_or_never()
}

/// **A beat**: [`Interval::tick`] comes back at once the first time, and then once every
/// `period`.
///
/// Live sync's connection manager keeps two — the quarter-second on which it asks its
/// scheduler whether a trip is due, and the 45 s of its keepalive — and both were the async
/// runtime's own interval while that loop was the desktop's. This is that interval's shape on
/// [`sleep`], so a browser has it too:
///
/// * **the first tick is immediate**, so a socket that has just come up is pinged and asked
///   about at once;
/// * **a beat taken a little late keeps the grid**: the next is due one `period` after this one
///   was *due*, not after it was taken, so lateness does not add up. Counted on [`Tick`], which
///   a wall clock's step cannot move;
/// * **beats that were missed outright are dropped, not owed.** A caller that comes back more
///   than a period late takes one beat, and the next is a period from *then*;
/// * **a tick dropped while it waits has lost nothing**: the next one waits out what is left.
///   That is what lets it be one arm of a select.
///
/// ⚠️ **The third is where this deliberately parts from the runtime's interval**, whose default
/// is to burst: every missed beat owed, taken back to back until the grid is caught up. A
/// process the system froze for an hour — Android does that to an app in the background, a
/// browser to a Worker, a lid to a laptop — would come back owing 14 400 quarter-second ticks
/// and eighty keepalives. The runtime's own interval at least passes through a timer on each
/// of them, which yields; this one, with nothing to wait for, would not — so the burst would
/// hold its thread from end to end, and the loop that owns it would read no frame until it
/// was over. And there is nothing in the beats to want back: a tick asks a scheduler whether
/// something is due *now*, and eighty pings down a socket that slept for an hour say what one
/// does.
///
/// [`Tick`]: super::clock::Tick
#[derive(Debug)]
pub struct Interval {
    period: Duration,
    due: super::clock::Tick,
}

/// An [`Interval`] of `period`, whose first tick is due now.
pub fn interval(period: Duration) -> Interval {
    Interval::starting(period, super::clock::Tick::now())
}

impl Interval {
    /// [`interval`] with the moment handed in, so a test can say "an hour later" without
    /// waiting for one.
    pub fn starting(period: Duration, now: super::clock::Tick) -> Interval {
        Interval { period, due: now }
    }

    /// How long until the next beat, as of `now`: nothing when it is already due.
    pub fn wait_at(&self, now: super::clock::Tick) -> Duration {
        self.due.saturating_duration_since(now)
    }

    /// Record a beat taken at `now`, and set when the next is due — [`Interval::tick`]'s
    /// bookkeeping, apart so a test can drive the grid on a clock of its own.
    ///
    /// On the grid while the beat was taken within a period of when it fell due; a period
    /// from `now` when it was later than that, which is what drops the beats missed between.
    pub fn took_one_at(&mut self, now: super::clock::Tick) {
        let late = now.saturating_duration_since(self.due);
        self.due = if late > self.period {
            now + self.period
        } else {
            self.due + self.period
        };
    }

    /// Wait for the next beat.
    pub async fn tick(&mut self) {
        let wait = self.wait_at(super::clock::Tick::now());
        if !wait.is_zero() {
            sleep(wait).await;
        }
        // Only once the wait is over: a tick dropped above leaves `due` where it was.
        self.took_one_at(super::clock::Tick::now());
    }
}

/// **Give the host's event loop a turn, and come back after it.**
///
/// An `.await` is not, by itself, a turn of the event loop. In a browser a future that is
/// already resolved — a chunk of a response the network had buffered — is continued on the
/// **microtask** queue, which the engine drains to the end before it takes its next *task*;
/// and a command a page sends to the Worker is a task. So a loop that awaits a chunk, pushes
/// it into a sink and awaits the next never returns to the event loop while chunks are
/// buffered, however many `.await`s it passes. Measured on the first run in a browser
/// (headless Chrome 154, 2026-10-04): a `sync_status` sent once a second was taken eight
/// times in a 16.4 s card download, 3.5–8.4 s late, where the same call answered in 1.4 ms
/// beside a download that was waiting on the network.
///
/// This is the await that *is* a turn:
///
/// | | |
/// | --- | --- |
/// | Native | the async runtime's own yield (`tokio::task::yield_now`): other tasks on the runtime get a poll. The hosts with threads do not need it — their commands run on other threads — and it costs them a re-poll |
/// | Browser | **a message posted to itself over a `MessageChannel`**, awaited. Its delivery is a task on the same source a page's own messages to the Worker arrive on, queued behind them — so every command that was waiting is taken first, and this resumes right after. Not `setTimeout(0)`, which browsers clamp to a millisecond and to four once timers nest, and not `scheduler.yield()`, whose continuation is prioritised *ahead* of other queued tasks, which is the opposite of what is wanted here. Where there is no `MessageChannel`, a zero `setTimeout` — late, and still a turn |
///
/// **Hold nothing across it that a command could want**: a turn is exactly when one runs.
pub async fn yield_to_host() {
    imp::yield_to_host().await
}

/// **A turn for the host every so much work** — what a long loop keeps, so that it gives the
/// event loop back a few times a second rather than at every pass or never.
///
/// [`Breather::breathe`] is called once per pass of the loop and does nothing until
/// `budget` has gone by since the last turn; then it is one [`yield_to_host`]. Per pass would
/// be thousands of turns over a download, each a round trip through the host; never is the
/// measured 8 s. Counted on [`Tick`], so it is work and waiting alike: a loop that spent the
/// budget waiting on the network has already given the host its turns, and one more costs
/// nothing.
///
/// [`Tick`]: super::clock::Tick
#[derive(Debug)]
pub struct Breather {
    budget: Duration,
    since: super::clock::Tick,
    taken: u32,
}

impl Breather {
    /// A breather that takes its first turn once `budget` has passed from now.
    ///
    /// On a test's thread that asked for it ([`turn_at_every_pass`]) the budget is nothing,
    /// so every pass is a turn; a build that ships has no such switch.
    pub fn new(budget: Duration) -> Breather {
        let budget = if every_pass::asked() {
            Duration::ZERO
        } else {
            budget
        };
        Breather::starting(budget, super::clock::Tick::now())
    }

    /// [`Breather::new`] with the moment handed in, so a test can say "fifty milliseconds
    /// later" without waiting for them.
    pub fn starting(budget: Duration, now: super::clock::Tick) -> Breather {
        Breather {
            budget,
            since: now,
            taken: 0,
        }
    }

    /// Whether a turn is owed at `now`: the budget has been spent since the last one.
    pub fn due_at(&self, now: super::clock::Tick) -> bool {
        now.saturating_duration_since(self.since) >= self.budget
    }

    /// Take a turn if one is owed, and start the budget again from when it came back.
    /// Answers whether it did.
    pub async fn breathe(&mut self) -> bool {
        if !self.due_at(super::clock::Tick::now()) {
            return false;
        }
        yield_to_host().await;
        self.took_one_at(super::clock::Tick::now());
        true
    }

    /// Record a turn that ended at `now`. [`Breather::breathe`]'s bookkeeping, apart so a
    /// test can drive the budget on a clock of its own.
    pub fn took_one_at(&mut self, now: super::clock::Tick) {
        self.since = now;
        self.taken += 1;
    }

    /// How many turns it has taken.
    pub fn taken(&self) -> u32 {
        self.taken
    }
}

/// **Where a loop that is written once for every host lets the host have a turn.**
///
/// A feed's finish is a run of short transactions with the connection given back between two
/// of them. Natively that gap is for another *thread* — [`crate::platform::pause`] parks this
/// one — and a command is answered there whatever this loop does. In a browser there is no
/// other thread, `pause` returns at once, and the gap lets nobody in unless the loop returns
/// to the event loop in it ([`yield_to_host`]). So the loop is an `async fn` that awaits a
/// `Turn` in each gap, and what it is handed decides what the gap is:
///
/// | Handed | The gap |
/// | --- | --- |
/// | [`NoTurn`] | nothing — the future never waits, and [`unbroken`] runs it to its end where it stands. What a host with threads passes, so its loop is statement for statement the synchronous one it was |
/// | a [`Breather`] | one [`yield_to_host`] each time its budget is spent. What a streamed download passes: the same breather its chunk loop kept |
///
/// **Hold nothing across `take`** — no guard, no open transaction: a turn is exactly when a
/// command runs, and on a host with one connection it asks for the one this loop just let go.
pub trait Turn {
    /// Give the host a turn if one is owed, and come back after it.
    fn take(&mut self) -> impl Future<Output = ()>;
}

/// The turn of a caller with none to give: ready at once. See [`Turn`].
#[derive(Debug, Clone, Copy, Default)]
pub struct NoTurn;

impl Turn for NoTurn {
    async fn take(&mut self) {}
}

impl Turn for Breather {
    async fn take(&mut self) {
        self.breathe().await;
    }
}

/// **Run a future that never waits to its end, where it stands** — what makes a loop written
/// once as an `async fn` ([`Turn`]) the synchronous function a host with threads has always
/// called: handed [`NoTurn`], every `.await` in it is ready, so one poll is the whole run.
///
/// No runtime is needed and none is entered; this is a function call.
///
/// # Panics
///
/// If the future does wait. That is a caller that handed a loop something other than
/// [`NoTurn`] and then asked for it synchronously — a mistake in the code, never a state a
/// run can reach — and the alternative, polling again in a loop, is a thread spinning on a
/// timer that only its own runtime can fire.
pub fn unbroken<F: Future>(future: F) -> F::Output {
    let mut context = std::task::Context::from_waker(std::task::Waker::noop());
    match std::pin::pin!(future).poll(&mut context) {
        std::task::Poll::Ready(output) => output,
        std::task::Poll::Pending => panic!(
            "a future run where it stands waited for something: it was handed a turn that \
             is not `NoTurn`, or awaits something besides its turns"
        ),
    }
}

/// **For a test: every [`Breather`] made on this thread takes a turn at every pass**, until
/// the guard is dropped.
///
/// A breather's budget is fifty milliseconds of real work, which a test's fixture finishes
/// inside of — so a loop that is supposed to let a command in between two batches would run
/// straight through, and the test of it would pass or fail on how fast the machine is. With
/// this, the turn after every batch is taken, whatever the clock says. Per thread and never
/// global, for [`super::alone`]'s reason.
#[cfg(any(test, feature = "testing"))]
pub fn turn_at_every_pass() -> EveryPass {
    every_pass::set(true);
    EveryPass(())
}

/// [`turn_at_every_pass`]'s guard.
#[cfg(any(test, feature = "testing"))]
pub struct EveryPass(());

#[cfg(any(test, feature = "testing"))]
impl Drop for EveryPass {
    fn drop(&mut self) {
        every_pass::set(false);
    }
}

#[cfg(not(any(test, feature = "testing")))]
mod every_pass {
    #[inline(always)]
    pub fn asked() -> bool {
        false
    }
}

#[cfg(any(test, feature = "testing"))]
mod every_pass {
    use std::cell::Cell;

    thread_local! {
        static EVERY_PASS: Cell<bool> = const { Cell::new(false) };
    }

    pub fn asked() -> bool {
        EVERY_PASS.with(Cell::get)
    }

    pub fn set(every: bool) {
        EVERY_PASS.with(|flag| flag.set(every));
    }
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use std::future::Future;
    use std::time::Duration;

    pub async fn sleep(duration: Duration) {
        tokio::time::sleep(duration).await
    }

    pub async fn timeout<F: Future>(duration: Duration, future: F) -> Option<F::Output> {
        tokio::time::timeout(duration, future).await.ok()
    }

    pub async fn yield_to_host() {
        tokio::task::yield_now().await
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use std::future::Future;
    use std::time::Duration;
    use wasm_bindgen::JsCast as _;

    /// A timer that has been set, **cleared when it is dropped**. A deadline that was beaten
    /// drops its sleep unfinished, and without this each one left a timer to fire into
    /// nothing — harmless once, and thousands deep on a streamed download, where every chunk
    /// of a 78 MB body races a sixty-second timer of its own.
    struct Set(Option<wasm_bindgen::JsValue>);

    impl Drop for Set {
        fn drop(&mut self) {
            let Some(id) = self.0.take() else { return };
            let global = js_sys::global();
            // Clearing a timer that has already fired does nothing, which is the case of a
            // sleep that ran its length.
            if let Some(clear) = js_sys::Reflect::get(&global, &"clearTimeout".into())
                .ok()
                .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
            {
                let _ = clear.call1(&global, &id);
            }
        }
    }

    pub async fn sleep(duration: Duration) {
        // Rounded up: `setTimeout` counts whole milliseconds, and a wait cut short is the one
        // thing a pacing gate cannot be given.
        let ms = duration.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32;
        let mut set = Set(None);
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            let global = js_sys::global();
            // A host with no `setTimeout` has no timer at all; resolving at once is the only
            // honest answer left, and a wait that returns early is one its caller re-checks.
            let scheduled = js_sys::Reflect::get(&global, &"setTimeout".into())
                .ok()
                .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
                .and_then(|f| f.call2(&global, &resolve, &ms.into()).ok());
            match scheduled {
                Some(id) => set.0 = Some(id),
                None => {
                    let _ = resolve.call0(&global);
                }
            }
        });
        let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
        // Held to here, so a sleep dropped at the `.await` above takes its timer with it.
        drop(set);
    }

    pub async fn timeout<F: Future>(duration: Duration, future: F) -> Option<F::Output> {
        use futures_util::future::{select, Either};
        let future = std::pin::pin!(future);
        let deadline = std::pin::pin!(sleep(duration));
        match select(future, deadline).await {
            Either::Left((out, _)) => Some(out),
            Either::Right(_) => None,
        }
    }

    /// One property of a JavaScript object, when it is there and is a function.
    fn method(of: &wasm_bindgen::JsValue, name: &str) -> Option<js_sys::Function> {
        js_sys::Reflect::get(of, &name.into())
            .ok()
            .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
    }

    /// A promise that resolves when a message this posts to itself over a fresh
    /// `MessageChannel` is delivered — and the port to close afterwards. `None` where the host
    /// has no such thing, or any step of it refused.
    ///
    /// A channel per turn rather than one kept: two loops can be mid-turn at once (a download
    /// and a command that streams), and one port's `onmessage` can hold one waiter.
    fn posted_to_self() -> Option<(js_sys::Promise, wasm_bindgen::JsValue)> {
        let global = js_sys::global();
        let channel =
            js_sys::Reflect::construct(&method(&global, "MessageChannel")?, &js_sys::Array::new())
                .ok()?;
        let listening = js_sys::Reflect::get(&channel, &"port1".into()).ok()?;
        let posting = js_sys::Reflect::get(&channel, &"port2".into()).ok()?;
        let post = method(&posting, "postMessage")?;
        let mut armed = false;
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            // Setting `onmessage` is also what starts the port.
            armed = js_sys::Reflect::set(&listening, &"onmessage".into(), &resolve)
                .unwrap_or(false)
                && post.call1(&posting, &wasm_bindgen::JsValue::NULL).is_ok();
        });
        armed.then_some((promise, listening))
    }

    pub async fn yield_to_host() {
        let Some((delivered, port)) = posted_to_self() else {
            // No channel: a zero timer is late by the browser's clamp, and still a turn.
            return sleep(Duration::ZERO).await;
        };
        let _ = wasm_bindgen_futures::JsFuture::from(delivered).await;
        // A port left open keeps its channel alive; this one has done its one job.
        if let Some(close) = method(&port, "close") {
            let _ = close.call0(&port);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::platform::clock::Tick;

    #[tokio::test]
    async fn a_sleep_lasts_at_least_as_long_as_it_was_asked_to() {
        let tick = Tick::now();
        sleep(Duration::from_millis(30)).await;
        assert!(
            tick.elapsed() >= Duration::from_millis(30),
            "{:?}",
            tick.elapsed()
        );
    }

    /// A future whose answer is **queued on the host beside the deadline**: a task that runs at
    /// the same instant the deadline does sets it, as a browser's queued `open` event would,
    /// and the future is ready only once that task has had its turn.
    fn answered_by_a_task_queued_at(when: Duration) -> impl Future<Output = ()> {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let answered = Arc::new(AtomicBool::new(false));
        let host = answered.clone();
        tokio::spawn(async move {
            tokio::time::sleep(when).await;
            host.store(true, Ordering::SeqCst);
        });
        std::future::poll_fn(move |_| {
            if answered.load(Ordering::SeqCst) {
                std::task::Poll::Ready(())
            } else {
                std::task::Poll::Pending
            }
        })
    }

    /// **A deadline that passes while the answer is queued behind it takes one turn and looks
    /// again** — where a plain [`timeout`] gives up on something that had already happened.
    ///
    /// The control is the first assertion, and it is what the staging rests on: on this runtime
    /// the task that timed out is polled before the task queued at the same instant, so a plain
    /// timeout answers `None`. Were that order ever the other way the control fails and says
    /// the staging has stopped staging — it is this runtime's order, known; **a browser's is
    /// not specified**, and what this shows is that the second look is taken, not what a
    /// browser does.
    ///
    /// **What makes it red**: giving up at the deadline without the turn, or without the poll
    /// after it.
    #[tokio::test(start_paused = true)]
    async fn a_deadline_takes_one_last_turn_before_it_gives_up() {
        let wait = Duration::from_secs(20);
        assert_eq!(
            timeout(wait, answered_by_a_task_queued_at(wait)).await,
            None,
            "the staging: the deadline is meant to run before the queued answer"
        );

        assert_eq!(
            timeout_after_a_last_turn(wait, answered_by_a_task_queued_at(wait)).await,
            Some(())
        );
        // An answer in time is an answer, and one that never comes is still given up on — a
        // turn later, and no more than that.
        assert_eq!(timeout_after_a_last_turn(wait, async { 7 }).await, Some(7));
        assert_eq!(
            timeout_after_a_last_turn(wait, std::future::pending::<()>()).await,
            None
        );
        // One turn, not two: an answer queued behind a second turn is late.
        assert_eq!(
            timeout_after_a_last_turn(
                wait,
                answered_by_a_task_queued_at(wait + Duration::from_millis(1))
            )
            .await,
            None
        );
    }

    /// **A beat is due at once the first time and a period apart after; one taken a little
    /// late keeps the grid; and the beats missed outright are dropped, not owed** — on a clock
    /// the test moves by hand, as the breather's is, so an hour away costs none and nothing
    /// here turns on how busy the machine is.
    #[test]
    fn an_interval_is_due_at_once_keeps_its_grid_and_drops_the_beats_it_missed() {
        let period = Duration::from_millis(250);
        let ms = Duration::from_millis;
        let t0 = Tick::now();
        let mut beat = Interval::starting(period, t0);

        assert_eq!(beat.wait_at(t0), Duration::ZERO, "the first is due at once");
        beat.took_one_at(t0);
        assert_eq!(beat.wait_at(t0), period, "and the second a period after");
        assert_eq!(beat.wait_at(t0 + ms(100)), ms(150));
        assert_eq!(beat.wait_at(t0 + period), Duration::ZERO);

        // Taken forty milliseconds late: the third is still due at two periods from the
        // start, so lateness does not add up.
        beat.took_one_at(t0 + period + ms(40));
        assert_eq!(beat.wait_at(t0 + period + ms(40)), period - ms(40));

        // Late by exactly a period is still on the grid: the beat after is due now.
        let on_the_edge = t0 + period * 3;
        beat.took_one_at(on_the_edge);
        assert_eq!(beat.wait_at(on_the_edge), Duration::ZERO);
        beat.took_one_at(on_the_edge);
        assert_eq!(beat.wait_at(on_the_edge), period);

        // Away for an hour — 14 400 periods. One beat is owed, and the next is a period on.
        let back = t0 + Duration::from_secs(3600);
        let mut taken = 0;
        while beat.wait_at(back).is_zero() {
            beat.took_one_at(back);
            taken += 1;
            assert!(taken < 10, "the missed beats are being taken back to back");
        }
        assert_eq!(taken, 1, "one beat for the hour, not one per period of it");
        assert_eq!(beat.wait_at(back), period);
        assert_eq!(
            beat.wait_at(back + ms(100)),
            ms(150),
            "and on a grid from there"
        );
    }

    /// **A tick waits for its beat** — lower bounds only, which a sleep never undercuts, so a
    /// stalled machine cannot fail it.
    #[tokio::test]
    async fn an_interval_tick_waits_out_its_period() {
        let period = Duration::from_millis(30);
        let start = Tick::now();
        let mut beat = interval(period);
        beat.tick().await;
        beat.tick().await;
        assert!(start.elapsed() >= period, "{:?}", start.elapsed());
        beat.tick().await;
        assert!(start.elapsed() >= period * 2, "{:?}", start.elapsed());
    }

    /// **A tick dropped while it waits has lost nothing** — what lets it be an arm of a select
    /// that another arm keeps winning: the beat is still due when it was, not a full period
    /// after the last time somebody asked. An hour's period, so the wait given up on can never
    /// have been over, and what is compared is the due moment itself.
    #[tokio::test]
    async fn an_interval_tick_dropped_mid_wait_moves_nothing() {
        let mut beat = interval(Duration::from_secs(3600));
        beat.tick().await;
        let due = beat.due;
        for _ in 0..4 {
            assert_eq!(timeout(Duration::from_millis(5), beat.tick()).await, None);
            assert_eq!(
                beat.due, due,
                "an abandoned wait must not start the period again"
            );
        }
    }

    /// **A yield is a turn**: work that was queued on the runtime runs before the yield comes
    /// back, where without one it has not run at all — the difference between a command taken
    /// during a download and one taken after it.
    #[tokio::test]
    async fn a_yield_lets_what_was_queued_run_before_it_comes_back() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let ran = Arc::new(AtomicBool::new(false));
        let flag = ran.clone();
        let queued = tokio::spawn(async move { flag.store(true, Ordering::SeqCst) });
        assert!(
            !ran.load(Ordering::SeqCst),
            "nothing else runs on this thread until this task lets go"
        );
        yield_to_host().await;
        assert!(
            ran.load(Ordering::SeqCst),
            "the queued work ran in the turn"
        );
        queued.await.unwrap();
    }

    /// **A breather takes a turn when its budget is spent and not before**, and the budget
    /// starts again from the turn — on a clock the test moves by hand, so "fifty milliseconds
    /// of work" costs none.
    #[tokio::test]
    async fn a_breather_takes_a_turn_on_its_budget_and_not_at_every_pass() {
        let budget = Duration::from_millis(50);
        let t0 = Tick::now();
        let mut breather = Breather::starting(budget, t0);
        assert!(!breather.due_at(t0));
        assert!(!breather.due_at(t0 + Duration::from_millis(49)));
        assert!(breather.due_at(t0 + budget));
        assert!(breather.due_at(t0 + Duration::from_secs(8)));

        // A turn at 60 ms: the next is owed fifty after *that*, not after the start.
        let turn = t0 + Duration::from_millis(60);
        breather.took_one_at(turn);
        assert_eq!(breather.taken(), 1);
        assert!(!breather.due_at(t0 + Duration::from_millis(100)));
        assert!(breather.due_at(turn + budget));

        // A loop of a thousand passes a millisecond apart takes a turn every fifty of them.
        let mut breather = Breather::starting(budget, t0);
        for pass in 1..=1000u64 {
            let now = t0 + Duration::from_millis(pass);
            if breather.due_at(now) {
                breather.took_one_at(now);
            }
        }
        assert_eq!(breather.taken(), 20, "one in fifty, not one per pass");

        // And against the real clock: nothing owed at once, one owed after the budget.
        let mut real = Breather::new(Duration::from_millis(20));
        assert!(!real.breathe().await, "no work has been done yet");
        sleep(Duration::from_millis(30)).await;
        assert!(real.breathe().await);
        assert!(!real.breathe().await, "and the budget starts again");
        assert_eq!(real.taken(), 1);
    }

    /// **A loop handed no turn is a function call**: every `.await` in it is ready, so it runs
    /// to its end in one poll, with no runtime under it — this test has none.
    #[test]
    fn a_loop_handed_no_turn_runs_to_its_end_where_it_stands() {
        async fn batches(turn: &mut impl Turn) -> u32 {
            let mut done = 0;
            for _ in 0..1000 {
                done += 1;
                turn.take().await;
            }
            done
        }
        assert_eq!(unbroken(batches(&mut NoTurn)), 1000);
    }

    /// …and a future that does wait is refused in words rather than spun on.
    #[test]
    fn a_future_that_waits_is_refused_rather_than_polled_again() {
        let waited = std::panic::catch_unwind(|| unbroken(std::future::pending::<()>()));
        let said = waited.expect_err("a pending future has no end to run to");
        let said = said
            .downcast_ref::<&str>()
            .map(|s| (*s).to_owned())
            .or_else(|| said.downcast_ref::<String>().cloned())
            .unwrap_or_default();
        assert!(said.contains("waited for something"), "{said}");
    }

    /// **A breather is a turn**, on its budget — and on a test's thread that asked, at every
    /// pass, so a test of a loop's gaps does not turn on how fast the machine is.
    #[tokio::test]
    async fn a_breather_handed_as_a_turn_breathes_and_a_test_can_make_every_pass_one() {
        let mut slow = Breather::new(Duration::from_secs(3600));
        slow.take().await;
        assert_eq!(slow.taken(), 0, "an hour's budget is not spent yet");
        {
            let _every = turn_at_every_pass();
            let mut breather = Breather::new(Duration::from_secs(3600));
            for _ in 0..3 {
                breather.take().await;
            }
            assert_eq!(breather.taken(), 3);
        }
        let mut after = Breather::new(Duration::from_secs(3600));
        after.take().await;
        assert_eq!(after.taken(), 0, "the switch went with its guard");
    }

    /// The deadline is what ends the call, and a future that beats it keeps its answer.
    #[tokio::test]
    async fn a_timeout_answers_the_future_or_nothing() {
        assert_eq!(timeout(Duration::from_secs(5), async { 7 }).await, Some(7));
        let tick = Tick::now();
        let late = timeout(Duration::from_millis(30), sleep(Duration::from_secs(30))).await;
        assert_eq!(late, None);
        assert!(
            tick.elapsed() < Duration::from_secs(5),
            "{:?}",
            tick.elapsed()
        );
    }
}
