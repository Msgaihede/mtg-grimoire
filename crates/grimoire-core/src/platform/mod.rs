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
//! | Interface | Native | Web | Landed with |
//! | --- | --- | --- | --- |
//! | [`clock`] — the wall clock, a moment that can be stored, and a tick to measure a wait from | `SystemTime`, `Instant` | `Date.now()` | the leaves; the tick with the storage step; the stored moment with the image cache |
//! | [`pause`] — standing aside for another thread | `thread::sleep` | nothing: there is no other thread | the storage step, for `db::lock_for` |
//! | [`timer`] — a sleep a future awaits, and a deadline on one | the async runtime's | `setTimeout` | the I/O step, for `scryfall`'s pacing and its image deadline |
//! | [`http`] — a request, a streamed body | `reqwest` over rustls | `reqwest` over `fetch` | the I/O step, for `scryfall`; `POST`, a text body and a browser's deadline with the sync client |
//! | [`device`] — the machine's own name | the environment | none | the sync step, for the name a device mints |
//! | [`files`] — a download on disk, the files the schema keeps, the image cache's pictures | `std::fs`, `tokio::fs` | refused | the I/O step, for `scryfall`, `ingest` and `schema`; a listing, a stamp and a rename for `images` |
//! | [`sync`] — a permit and a lock an `async fn` holds across an `.await`, first come first served | `tokio::sync` | `tokio::sync`: it needs no runtime | the I/O step, for the image cache; a lock that guards a value with the sync step, for the pending pairing offer |
//! | [`Sendable`] — what a fence over a future's `Send`-ness bounds by | `Send` | anything | the sync step, for the fences over a trip |
//! | [`spawn`] — work taken off the caller: minutes of SQLite under an `async fn`, a build nobody waits for | the async runtime's blocking pool, a thread | run where it stands: a Worker has no second thread | the I/O step, for the card sync's ingest and the facet index's build |
//!
//! **Each is here because something calls it**: an interface written before the code that calls
//! it is a guess.
//!
//! **The fence holds four more names to this directory since the I/O step**: `reqwest`,
//! `tokio`, `std::fs` and `std::thread`, in shipped code. Each compiles for a desktop wherever
//! it is written, which is exactly why a compiler cannot be what keeps them here.
//!
//! **Every browser arm under this directory compiles and none has run.** CI's `core` job builds
//! them for `wasm32-unknown-unknown`; the first host to call one is the web build.

pub mod clock;
pub mod device;
pub mod files;
pub mod http;
mod pause;
pub mod spawn;
pub mod sync;
pub mod timer;

pub use pause::pause;

/// **What a native host may hand to another thread: `Send` there, and anything in a browser.**
/// A browser's request is a JavaScript promise, which is not `Send` and never will be, and a
/// Worker has no other thread to hand one to. So a fence that asks whether a future holds a
/// lock across an `.await` — the sync modules' `nothing_is_held_across_a_request`, which bound
/// by this rather than by `Send` — asks it of every native build and is no question at all in a
/// browser, where a future holding nothing and one holding a guard are equally `!Send`.
#[cfg(not(target_family = "wasm"))]
pub trait Sendable: Send {}
#[cfg(not(target_family = "wasm"))]
impl<T: Send> Sendable for T {}
/// See the native arm: in a browser every value is sendable, because there is nowhere to send it.
#[cfg(target_family = "wasm")]
pub trait Sendable {}
#[cfg(target_family = "wasm")]
impl<T> Sendable for T {}

mod fence;
