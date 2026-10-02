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
//! **The browser arm has never run.** It reads `setTimeout` off the global object rather than
//! off `window`, because the host that will call it is a Worker and has none. A deadline that
//! was beaten leaves its timer to fire into nothing: the promise is dropped and the timeout is
//! not cleared, which costs a pending timer for at most the length of the deadline.

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
}

#[cfg(target_family = "wasm")]
mod imp {
    use std::future::Future;
    use std::time::Duration;
    use wasm_bindgen::JsCast as _;

    pub async fn sleep(duration: Duration) {
        // Rounded up: `setTimeout` counts whole milliseconds, and a wait cut short is the one
        // thing a pacing gate cannot be given.
        let ms = duration.as_micros().div_ceil(1000).min(i32::MAX as u128) as i32;
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            let global = js_sys::global();
            // A host with no `setTimeout` has no timer at all; resolving at once is the only
            // honest answer left, and a wait that returns early is one its caller re-checks.
            let scheduled = js_sys::Reflect::get(&global, &"setTimeout".into())
                .ok()
                .and_then(|f| f.dyn_into::<js_sys::Function>().ok())
                .and_then(|f| f.call2(&global, &resolve, &ms.into()).ok());
            if scheduled.is_none() {
                let _ = resolve.call0(&global);
            }
        });
        let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
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
