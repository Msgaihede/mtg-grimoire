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
//! | [`clock`] — the wall clock | `SystemTime` | `Date.now()` | this step |
//! | a sleep | `thread::sleep`, the async runtime's | a timer | the I/O step, with its first caller |
//! | HTTP — a request, a streamed body | `reqwest` | `fetch` | the I/O step |
//! | files — the data directory, temp files | `std::fs` | OPFS | the I/O step |
//! | background work | a thread, the async runtime | a microtask | the state step |
//!
//! **Only the clock is here, because only the clock has a caller's shape to copy.** The other
//! four are named so the next step knows where they go; an interface written before the code
//! that calls it is a guess, and this crate's leaves call none of them.

pub mod clock;

mod fence;
