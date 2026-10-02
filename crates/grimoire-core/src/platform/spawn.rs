//! Work taken off the caller: minutes of SQLite that an `async fn` must not sit in, and a
//! build nobody waits for.
//!
//! Two shapes, because there are two kinds of caller:
//!
//! * [`blocking`] is for an `async fn` with synchronous work to do — the ingest, the migration
//!   log applied, the page reclaim, the one-time compaction. The future resolves with the
//!   work's answer, and the task's thread is free meanwhile.
//! * [`background`] is for work the caller does not wait for at all — the facet index's build.
//!   It answers a handle a test can join.
//!
//! | | Native | Browser |
//! | --- | --- | --- |
//! | [`blocking`] | the async runtime's blocking pool | **run where it stands**, at the first poll |
//! | [`background`] | a thread | **run where it stands**, before the call returns |
//!
//! **A Worker is one thread, so in a browser nothing is taken off anything**: the work runs on
//! the caller, to completion, and the page stays live only because the Worker is not the page.
//! That is the honest arm rather than a clever one — there is no second thread to hand it to —
//! and it is why the web host must run this crate in a Worker and never on the main thread.
//! It also means a browser's [`background`] has *finished* by the time it returns, where a
//! native one has only started; a caller may rely on neither.
//!
//! **The native [`blocking`] needs a tokio runtime on the current task**, as
//! `platform::timer` does, and panics outside one.
//!
//! **Neither browser arm has run.**

use std::fmt;
use std::future::Future;

/// The work did not come back: it panicked, or the runtime shut down under it.
///
/// It prints as the runtime's own error does, so a sentence in `error_log` reads as it always
/// has.
#[derive(Debug)]
pub struct Lost(String);

impl fmt::Display for Lost {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Lost {}

/// Run `work` off the async task that asks for it, and resolve with what it answers.
pub fn blocking<T, F>(work: F) -> impl Future<Output = Result<T, Lost>>
where
    F: FnOnce() -> T + Send + 'static,
    T: Send + 'static,
{
    imp::blocking(work)
}

/// Work nobody is waiting for. Joining it is for a test, and for a caller that must know it
/// has finished.
pub struct Background(imp::Handle);

impl Background {
    /// Wait for the work to end. `Err` when it panicked.
    pub fn join(self) -> Result<(), Lost> {
        imp::join(self.0)
    }
}

/// Start `work` and come straight back.
pub fn background<F>(work: F) -> Background
where
    F: FnOnce() + Send + 'static,
{
    Background(imp::background(work))
}

#[cfg(not(target_family = "wasm"))]
mod imp {
    use super::Lost;

    pub type Handle = std::thread::JoinHandle<()>;

    pub async fn blocking<T, F>(work: F) -> Result<T, Lost>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        tokio::task::spawn_blocking(work)
            .await
            .map_err(|e| Lost(e.to_string()))
    }

    pub fn background<F>(work: F) -> Handle
    where
        F: FnOnce() + Send + 'static,
    {
        std::thread::spawn(work)
    }

    pub fn join(handle: Handle) -> Result<(), Lost> {
        handle.join().map_err(|panic| {
            // A panic's payload is a `&str` or a `String` when it came from `panic!`.
            let said = panic
                .downcast_ref::<&str>()
                .map(|s| (*s).to_owned())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "the background work panicked".to_owned());
            Lost(said)
        })
    }
}

#[cfg(target_family = "wasm")]
mod imp {
    use super::Lost;

    /// The work has already run by the time there is a handle to it.
    pub struct Handle;

    pub async fn blocking<T, F>(work: F) -> Result<T, Lost>
    where
        F: FnOnce() -> T + Send + 'static,
        T: Send + 'static,
    {
        Ok(work())
    }

    pub fn background<F>(work: F) -> Handle
    where
        F: FnOnce() + Send + 'static,
    {
        work();
        Handle
    }

    pub fn join(_handle: Handle) -> Result<(), Lost> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[tokio::test]
    async fn blocking_work_answers_what_it_computed_from_another_thread() {
        let here = std::thread::current().id();
        let (there, answer) = blocking(move || (std::thread::current().id(), 6 * 7))
            .await
            .unwrap();
        assert_eq!(answer, 42);
        assert_ne!(
            there, here,
            "the work must not run on the task's own thread"
        );
    }

    /// A panic inside the work is an answer the caller reads, not one that takes the caller
    /// down with it — `run_sync` writes it to `error_log` and carries on.
    #[tokio::test]
    async fn blocking_work_that_panics_is_lost_and_says_so() {
        let lost = blocking(|| -> u8 { panic!("the ingest fell over") })
            .await
            .unwrap_err();
        assert!(lost.to_string().contains("panicked"), "{lost}");
    }

    #[test]
    fn background_work_runs_and_can_be_joined() {
        let done = Arc::new(AtomicBool::new(false));
        let flag = done.clone();
        background(move || flag.store(true, Ordering::SeqCst))
            .join()
            .unwrap();
        assert!(done.load(Ordering::SeqCst));

        let lost = background(|| panic!("the build fell over"))
            .join()
            .unwrap_err();
        assert_eq!(lost.to_string(), "the build fell over");
    }
}
