//! The one place this crate knows which machine it is on.
//!
//! **`cfg(target_…)` appears under this directory and nowhere else in the crate.** A module
//! that needs something only one kind of host can give — the time, a file, a request, somewhere
//! to run work off the caller's thread — asks for it here, and what is here has one
//! implementation for the native hosts (the desktop and Android) and one for the browser,
//! picked by `cfg` inside the module that owns the question.
//!
//! The first attempt at these targets put the gate at each call site instead and ended at 552
//! of them, with a hand-written router beside it. `fence.rs` is what stops that starting again:
//! a test that reads every source file in the crate.
//!
//! | Interface | Native | Web | Lands with |
//! | --- | --- | --- | --- |
//! | [`clock`] — the wall clock, and a tick to measure a wait from | `SystemTime`, `Instant` | `Date.now()` | the leaves; the tick with the storage step |
//! | [`pause`] — standing aside for another thread | `thread::sleep` | nothing: there is no other thread | the storage step, for `db::lock_for` |
//! | a sleep a future awaits | the async runtime's | a timer | the I/O step, with its first caller |
//! | HTTP — a request, a streamed body | `reqwest` | `fetch` | the I/O step |
//! | files — the data directory, temp files | `std::fs` | OPFS | the I/O step |
//! | background work | a thread, the async runtime | a microtask | the I/O step — the state step had no caller for it |
//!
//! **Each is here because something calls it.** The rows without a link are named so the step
//! that brings their first caller knows where they go; an interface written before the code
//! that calls it is a guess.
//!
//! **`std::fs` is named outside this directory today**, by `schema` — the corpus it replaces,
//! the backup it takes before a climb, the mark a damaged corpus leaves. That compiles for a
//! browser and fails there when called. It waits for the I/O step, where an OPFS arm has a host
//! to be written against.

pub mod clock;
mod pause;

pub use pause::pause;

mod fence;
