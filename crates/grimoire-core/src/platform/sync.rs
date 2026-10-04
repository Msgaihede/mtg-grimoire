//! A permit and a lock that an `async fn` holds across an `.await`.
//!
//! The image cache is why they exist: it caps the pictures in flight with a [`Semaphore`], and
//! holds one [`Lock`] per key so two callers who want the same picture make one round trip.
//! Both are held across a network fetch, which a `std` mutex must never be.
//!
//! | | Native | Browser |
//! | --- | --- | --- |
//! | [`Semaphore`], [`Lock`], [`Shared`], [`Bell`] | `tokio::sync` | `tokio::sync` |
//!
//! **One implementation, and it is the one this app has always used.** `tokio::sync` needs no
//! runtime — nothing in it spawns, sleeps or reads a clock — so it is the one part of tokio a
//! browser build carries, and it is here rather than named where it is used only because the
//! fence keeps the crate's name under this directory.
//!
//! **Both are first come, first served, and the cache leans on it.** A released permit goes to
//! whoever has waited longest. A pre-warm asks for its next picture the instant it has let go
//! of the last, so under a semaphore that hands a freed permit to whoever asks first it would
//! keep that permit for its whole run, ahead of every tile the reader is looking at. (The move
//! to this crate went through one for an afternoon; a reviewer caught it by reading the other
//! crate's source.)

/// At most this many holders at once, in the order they asked.
#[derive(Debug)]
pub struct Semaphore(tokio::sync::Semaphore);

/// One of a [`Semaphore`]'s permits. Given back when it is dropped.
#[derive(Debug)]
pub struct Permit<'a>(#[allow(dead_code)] tokio::sync::SemaphorePermit<'a>);

impl Semaphore {
    pub fn new(permits: usize) -> Semaphore {
        Semaphore(tokio::sync::Semaphore::new(permits))
    }

    /// Wait for a permit.
    pub async fn acquire(&self) -> Permit<'_> {
        // The one way this fails is a semaphore that was closed, and nothing here can close one.
        Permit(self.0.acquire().await.expect("never closed"))
    }
}

/// A mutex over nothing: what it protects is whatever its holder does while holding it.
#[derive(Debug, Default)]
pub struct Lock(tokio::sync::Mutex<()>);

/// A [`Lock`], held. Let go when it is dropped.
#[derive(Debug)]
pub struct Held<'a>(#[allow(dead_code)] tokio::sync::MutexGuard<'a, ()>);

impl Lock {
    pub fn new() -> Lock {
        Lock::default()
    }

    /// Wait for the lock.
    pub async fn lock(&self) -> Held<'_> {
        Held(self.0.lock().await)
    }
}

/// A value an `async fn` may hold across an `.await`: a [`Lock`] that guards something.
///
/// The pending pairing offer is the one: an accept, a confirm and a poll each keep it while they
/// talk to the relay, which is what makes a Cancel wait and win, and what stops two polls from
/// completing one offer twice. First come, first served, like the rest of this module.
#[derive(Debug, Default)]
pub struct Shared<T>(tokio::sync::Mutex<T>);

/// A [`Shared`], held. Let go when it is dropped.
#[derive(Debug)]
pub struct Guard<'a, T>(tokio::sync::MutexGuard<'a, T>);

impl<T> Shared<T> {
    pub fn new(value: T) -> Shared<T> {
        Shared(tokio::sync::Mutex::new(value))
    }

    /// Wait for the value.
    pub async fn lock(&self) -> Guard<'_, T> {
        Guard(self.0.lock().await)
    }
}

impl<T> std::ops::Deref for Guard<'_, T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> std::ops::DerefMut for Guard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

/// A bell one side rings and one task waits on — **and a ring with nobody waiting is kept**.
///
/// Live sync's write wake is the one: the write connection's commit hook rings it
/// (`sync_engine::live::WriteWake`), from inside SQLite's own callback, and the connection
/// manager waits on it in one arm of its loop. That loop is *not* waiting there for most of its
/// life — it is inside a round trip, asleep on a backoff or dialling the relay — so a bell that
/// woke only whoever was already listening would lose every write that landed in one of those
/// windows.
///
/// **So [`Bell::ring`] stores one permit when nobody is waiting, and the next [`Bell::rung`]
/// takes it and returns at once.** One, not a count: ten rings in a row with nobody listening
/// are one wake, which is all a listener that then asks "is there anything to do?" needs. A
/// wait that was woken and then dropped before it was polled — the losing arm of a select —
/// hands its ring on rather than swallowing it.
///
/// `tokio::sync::Notify`, by its `notify_one` and never its `notify_waiters`, which stores
/// nothing. It needs no runtime, so it is the same on every host.
#[derive(Debug, Default)]
pub struct Bell(tokio::sync::Notify);

impl Bell {
    pub fn new() -> Bell {
        Bell::default()
    }

    /// Ring it. Never blocks and cannot fail, which is what a commit hook requires of anything
    /// it calls.
    pub fn ring(&self) {
        self.0.notify_one();
    }

    /// Wait for a ring — or take the one that was kept.
    pub async fn rung(&self) {
        self.0.notified().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// A permit is exclusive for as long as it is held, and one that is given back goes to the
    /// caller that has waited longest — not to whoever asks next.
    #[tokio::test]
    async fn a_freed_permit_goes_to_whoever_has_waited_longest() {
        let gate = Arc::new(Semaphore::new(1));
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let first = gate.acquire().await;

        // A waiter, parked behind the held permit.
        let waiter = {
            let (gate, order) = (gate.clone(), order.clone());
            tokio::spawn(async move {
                let _permit = gate.acquire().await;
                order.lock().unwrap().push("waiter");
            })
        };
        // Let it reach the queue before anybody else asks.
        for _ in 0..50 {
            tokio::task::yield_now().await;
        }

        // The holder lets go and asks again at once — the pre-warm's shape. It must queue
        // behind the waiter rather than take back what it has just released.
        drop(first);
        let _again = gate.acquire().await;
        order.lock().unwrap().push("holder, again");
        drop(_again);
        waiter.await.unwrap();

        assert_eq!(*order.lock().unwrap(), ["waiter", "holder, again"]);
    }

    /// One holder at a time, and the next gets it when the first lets go.
    #[tokio::test]
    async fn a_lock_is_held_by_one_at_a_time() {
        let lock = Arc::new(Lock::new());
        let inside = Arc::new(AtomicUsize::new(0));
        let most = Arc::new(AtomicUsize::new(0));
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let (lock, inside, most) = (lock.clone(), inside.clone(), most.clone());
                tokio::spawn(async move {
                    let _held = lock.lock().await;
                    let now = inside.fetch_add(1, Ordering::SeqCst) + 1;
                    most.fetch_max(now, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    inside.fetch_sub(1, Ordering::SeqCst);
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(most.load(Ordering::SeqCst), 1);
    }

    /// A shared value is held by one at a time across an `.await`, and what each holder
    /// wrote is what the next one reads — eight increments that each yield between the read
    /// and the write lose none.
    #[tokio::test]
    async fn a_shared_value_is_changed_by_one_holder_at_a_time() {
        let shared = Arc::new(Shared::new(0usize));
        let tasks: Vec<_> = (0..8)
            .map(|_| {
                let shared = shared.clone();
                tokio::spawn(async move {
                    let mut held = shared.lock().await;
                    let seen = *held;
                    tokio::task::yield_now().await;
                    *held = seen + 1;
                })
            })
            .collect();
        for task in tasks {
            task.await.unwrap();
        }
        assert_eq!(*shared.lock().await, 8);
    }

    /// **A ring with nobody waiting is kept, as one**: the next wait returns at once, and the
    /// one after it waits — which is the whole of what live sync's write wake leans on. Polled
    /// by hand rather than awaited, so "it would have waited" is an answer and not a test that
    /// never ends.
    #[test]
    fn a_ring_with_nobody_waiting_is_kept_and_only_one_of_them() {
        use futures_util::FutureExt;

        let bell = Bell::new();
        assert!(
            bell.rung().now_or_never().is_none(),
            "nothing rang, so there is nothing to take"
        );

        bell.ring();
        bell.ring();
        bell.ring();
        assert!(
            bell.rung().now_or_never().is_some(),
            "a ring nobody was waiting for must still wake the next wait"
        );
        assert!(
            bell.rung().now_or_never().is_none(),
            "three rings with nobody listening are one wake, not three"
        );
    }

    /// **A wait that was woken and then dropped unpolled hands its ring on** — the losing arm
    /// of a select, which is exactly where the connection manager's wait sits when a frame and
    /// a commit arrive together.
    #[tokio::test]
    async fn a_woken_wait_that_is_dropped_does_not_swallow_the_ring() {
        use futures_util::FutureExt;

        let bell = Bell::new();
        {
            let waiting = bell.rung();
            let mut waiting = std::pin::pin!(waiting);
            // Parked: polled once with nothing rung.
            assert!(waiting.as_mut().now_or_never().is_none());
            bell.ring();
            // And dropped here, woken but never polled again.
        }
        assert!(
            bell.rung().now_or_never().is_some(),
            "the ring the dropped wait was given must reach the next one"
        );
    }
}
