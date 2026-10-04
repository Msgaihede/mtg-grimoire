//! **A host with one thread, stood in for on a machine that has many** — for a test.
//!
//! A browser's Worker is one thread, and three things in this crate behave differently there:
//! [`super::spawn`] runs its work where it stands, [`super::pause`] answers that nothing was
//! waited for, and a lock asked for twice by the one thread there is **is a trap** — std's
//! `Mutex` panics on a recursive lock on `wasm32-unknown-unknown`, where a desktop's deadlocks.
//! None of that can be seen from a native test: the blocking pool is another thread, the
//! desktop's second connection is another mutex, and a lock taken twice is a test that never
//! ends rather than one that fails.
//!
//! So a test may say that **its own thread** is such a host: [`emulate`] answers a guard, and
//! for as long as it lives, on that thread and no other,
//!
//! * [`super::spawn::blocking`] and [`super::spawn::background`] run the work on the caller —
//!   `blocking` at its first poll and `background` before it returns, as the browser arms do;
//! * [`super::pause`] answers `false` without sleeping, so `db::lock_for` gives up at its
//!   first contended attempt and its caller answers `db::BUSY`;
//! * [`lock`], [`read`] and [`write`] — what `db`'s lock helpers take a connection and the
//!   facet index through — **panic on a lock that is already held**, naming the line that asked;
//! * and so does a *bounded* ask for a connection ([`refuse_held`], from `db::lock_for`), which
//!   a Worker answers with `None` rather than a trap. That one is stricter than the browser on
//!   purpose: most callers of a bounded ask drop their work on `None` — an `error_log` row, a
//!   stamp — so a self-contended one is a write that silently never happens, and a test that
//!   only watched for traps and `BUSY` would pass over it.
//!
//! That is why it is sound: with every piece of work on the one thread, nobody else can be
//! holding a lock of this state's, so a lock found held was taken by the thread now asking.
//! `commands`' table test is the caller — every command, run the way a Worker would run it.
//!
//! ⚠️ **It watches a connection and the facet index, and nothing else.** `db::lock_plain` and
//! every bare `.lock()` in the crate — the image cache's maps, the pairing offer, Scryfall's
//! pacing gate, an event sink, the scanner, the undo tickets — are not routed through here, and
//! must not be: several of those locks are process-wide (`db`'s `WAITING` is one), and a test
//! binary's other threads hold them honestly. A recursive one of those on an emulated thread
//! is still what it is natively — a thread that never comes back, which no deadline on a
//! current-thread runtime can interrupt.
//!
//! **A shipped build has none of it.** [`emulated`] is `false` there, a constant the compiler
//! folds every branch on it away behind; the switch itself exists under `cfg(test)` and the
//! `testing` feature only. **It is per thread and never global**, because a test binary runs
//! its tests on many threads at once and one that turned the whole process into a Worker would
//! fail every other test that waits for a lock.
//!
//! **What it does not stand in for**: the browser's clock, its `fetch`, its refusing
//! [`super::files`] and the `!Send` futures of a request. Those arms compile for
//! `wasm32-unknown-unknown` and are run by the web host; this is the one difference a native
//! test can be made to feel.

use std::sync::{Mutex, MutexGuard, RwLock, RwLockReadGuard, RwLockWriteGuard, TryLockError};

/// Whether the calling thread is standing in for a host with no other thread.
///
/// Always `false` in a build that ships.
pub fn emulated() -> bool {
    imp::emulated()
}

/// Stand in for a one-thread host on the calling thread until the guard is dropped.
#[cfg(any(test, feature = "testing"))]
pub fn emulate() -> Emulation {
    imp::set(true);
    Emulation(())
}

/// [`emulate`]'s guard. Dropping it gives the thread its other threads back.
#[cfg(any(test, feature = "testing"))]
pub struct Emulation(());

#[cfg(any(test, feature = "testing"))]
impl Drop for Emulation {
    fn drop(&mut self) {
        imp::set(false);
    }
}

/// What a lock found held says, under [`emulate`]. A panic and not an error: for an ask that
/// waits it is what the browser does, for a bounded one it is louder than the browser on
/// purpose ([`refuse_held`]), and either way a test reads the sentence.
#[track_caller]
fn taken_twice(what: &str) -> ! {
    panic!(
        "a lock taken twice by one thread: {what} was asked for at {} while this thread \
         already held it. On a host with one connection and one thread (a browser's Worker) \
         it can never be given: an ask that waits is a trap there, and a bounded one answers \
         nothing — which most callers take as leave to drop what they were about to write. \
         On a desktop with one connection it is a deadlock, or the whole bound spent.",
        std::panic::Location::caller()
    )
}

/// **For a bounded ask that found its lock held**: under [`emulate`] the holder can only be the
/// caller, so this panics with the line that asked; anywhere else it does nothing and the ask
/// goes on waiting, or gives up, as it always did. `db::lock_for` calls it on `WouldBlock`.
#[track_caller]
pub fn refuse_held(what: &str) {
    if emulated() {
        taken_twice(what);
    }
}

/// Take `mutex`, recovering a poisoned one — and, under [`emulate`], **refusing one that is
/// already held** rather than waiting for a holder that can only be the caller.
///
/// `db::lock_blocking` is this over a connection. Outside an emulation it is `Mutex::lock`.
#[track_caller]
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    if emulated() {
        return match mutex.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(e)) => e.into_inner(),
            Err(TryLockError::WouldBlock) => taken_twice("a connection"),
        };
    }
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

/// [`lock`] for the reading half of an `RwLock`.
#[track_caller]
pub fn read<T>(lock: &RwLock<T>) -> RwLockReadGuard<'_, T> {
    if emulated() {
        return match lock.try_read() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(e)) => e.into_inner(),
            Err(TryLockError::WouldBlock) => taken_twice("a shared value, to read"),
        };
    }
    lock.read().unwrap_or_else(|e| e.into_inner())
}

/// [`lock`] for the writing half of an `RwLock`.
#[track_caller]
pub fn write<T>(lock: &RwLock<T>) -> RwLockWriteGuard<'_, T> {
    if emulated() {
        return match lock.try_write() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(e)) => e.into_inner(),
            Err(TryLockError::WouldBlock) => taken_twice("a shared value, to replace"),
        };
    }
    lock.write().unwrap_or_else(|e| e.into_inner())
}

#[cfg(not(any(test, feature = "testing")))]
mod imp {
    #[inline(always)]
    pub fn emulated() -> bool {
        false
    }
}

#[cfg(any(test, feature = "testing"))]
mod imp {
    use std::cell::Cell;

    thread_local! {
        static ALONE: Cell<bool> = const { Cell::new(false) };
    }

    pub fn emulated() -> bool {
        ALONE.with(Cell::get)
    }

    pub fn set(alone: bool) {
        ALONE.with(|flag| flag.set(alone));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::panic::{catch_unwind, AssertUnwindSafe};
    use std::time::Duration;

    /// What a panic said.
    fn said(panic: Box<dyn std::any::Any + Send>) -> String {
        panic
            .downcast_ref::<String>()
            .cloned()
            .or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
            .unwrap_or_default()
    }

    /// The whole point: a second lock by the same thread is a failure with a sentence, at once,
    /// where the same two lines without the emulation never return.
    #[test]
    fn a_lock_taken_twice_is_a_panic_that_names_the_line_and_not_a_wait() {
        let mutex = Mutex::new(0u8);
        let _alone = emulate();
        let held = lock(&mutex);
        let again = catch_unwind(AssertUnwindSafe(|| drop(lock(&mutex))));
        drop(held);
        let sentence = said(again.expect_err("the second lock must not be granted"));
        assert!(
            sentence.contains("a lock taken twice by one thread"),
            "{sentence}"
        );
        assert!(sentence.contains("alone.rs"), "{sentence}");
        // Let go, it is a lock like any other.
        *lock(&mutex) = 1;
    }

    #[test]
    fn the_same_holds_for_both_halves_of_a_shared_value() {
        let shared = RwLock::new(0u8);
        let _alone = emulate();
        {
            // Two readers are two readers on every host.
            let one = read(&shared);
            let two = read(&shared);
            assert_eq!(*one + *two, 0);
            assert!(catch_unwind(AssertUnwindSafe(|| drop(write(&shared)))).is_err());
        }
        let writing = write(&shared);
        assert!(catch_unwind(AssertUnwindSafe(|| drop(read(&shared)))).is_err());
        drop(writing);
    }

    /// Per thread: a test that stands in for a Worker must not make one of every other test in
    /// the binary. Another thread waits for a held lock here, as it always did.
    #[test]
    fn another_thread_is_not_standing_in_for_anything() {
        let mutex = Mutex::new(0u8);
        let _alone = emulate();
        assert!(emulated());
        std::thread::scope(|scope| {
            let held = lock(&mutex);
            let other = scope.spawn(|| {
                assert!(!emulated());
                *lock(&mutex) += 1;
            });
            std::thread::sleep(Duration::from_millis(30));
            assert!(!other.is_finished(), "the other thread waits for the lock");
            drop(held);
            other.join().expect("and is given it");
        });
        assert_eq!(*lock(&mutex), 1);
    }

    #[test]
    fn the_emulation_ends_with_its_guard() {
        assert!(!emulated());
        {
            let _alone = emulate();
            assert!(emulated());
            assert!(!crate::platform::pause(Duration::from_secs(60)));
        }
        assert!(!emulated());
        assert!(crate::platform::pause(Duration::from_millis(1)));
    }
}
