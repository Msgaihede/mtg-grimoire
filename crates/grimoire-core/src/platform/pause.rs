//! Standing aside for another thread.
//!
//! **`std::thread::sleep` panics on `wasm32-unknown-unknown`**, and there it would be the wrong
//! thing to do even if it did not: a Worker is one thread, so nothing else can let go of
//! whatever the caller is waiting for while the caller waits. A wait that polls — take the
//! lock, or pause and try again — is therefore a wait that can never succeed in a browser, and
//! the honest answer is to say so at once rather than to spin until a deadline.
//!
//! So [`pause`] answers whether pausing was worth anything. `db::lock_for` and
//! `db::lock_background` are its callers: natively they sleep between attempts exactly as they
//! did, and in a browser `lock_for` gives up on its first contended attempt, which every caller
//! already reads as `db::BUSY`.
//!
//! `maintenance::reclaim_freed_pages` is a third, since the domain step: it stands aside between
//! chunks so a waiter can take the connection, and ignores the answer — with nobody to stand
//! aside for, the next chunk is simply taken at once.
//!
//! **This is not the async sleep.** A timer a future can await is a different interface with a
//! different caller — the feeds' pacing — and arrives with the I/O step.

use std::time::Duration;

/// Park the calling thread for `duration`, so another can finish what it holds.
///
/// `true` when the pause happened. **`false` when this host has no other thread to wait for**:
/// nothing was waited, and waiting again will not help.
pub fn pause(duration: Duration) -> bool {
    imp::pause(duration)
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use std::time::Duration;

    pub fn pause(duration: Duration) -> bool {
        std::thread::sleep(duration);
        true
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use std::time::Duration;

    pub fn pause(_duration: Duration) -> bool {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every host this suite runs on has threads, so a pause is one.
    #[test]
    fn a_pause_on_a_host_with_threads_happens() {
        assert!(pause(Duration::from_millis(1)));
    }
}
