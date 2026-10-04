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
//! **And a turn given back to the host**: [`yield_to_host`], and [`Breather`], which takes one
//! on a budget of work. A loop of `chunk().await` and a synchronous push looks as though it
//! lets go at every `.await`, and in a browser it does not — the first measured run found a
//! page's commands waiting 3.5–8.4 s behind a card download for it. Both say why.

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
    pub fn new(budget: Duration) -> Breather {
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
