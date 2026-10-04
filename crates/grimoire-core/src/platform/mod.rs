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
//! | [`clock`] — the wall clock, a moment that can be stored, and a tick to measure a wait from | `SystemTime`, `Instant` | `Date.now()`; `performance.now()` for the tick | the leaves; the tick with the storage step; the stored moment with the image cache; the monotonic tick with the web host's first download |
//! | [`pause`] — standing aside for another thread | `thread::sleep` | nothing: there is no other thread | the storage step, for `db::lock_for` |
//! | [`timer`] — a sleep a future awaits, a deadline on one, and a beat | the async runtime's | `setTimeout` | the I/O step, for `scryfall`'s pacing and its image deadline; the beat with live sync's connection manager |
//! | [`http`] — a request, a streamed body, a wait that gives up on a stall | `reqwest` over rustls | `reqwest` over `fetch`, with no `User-Agent` of its own | the I/O step, for `scryfall`; `POST`, a text body and a browser's deadline with the sync client; the stall bounds with the web host's first download |
//! | [`host`] — whether a download has a file to land in, and whether a request is a page's | it has, and it is not | it has not, and it is | the web host's first download (phase 5, step 5.2) |
//! | [`device`] — the machine's own name | the environment | none | the sync step, for the name a device mints |
//! | [`files`] — a download on disk, the files the schema keeps, the image cache's pictures | `std::fs`, `tokio::fs` | refused | the I/O step, for `scryfall`, `ingest` and `schema`; a listing, a stamp and a rename for `images` |
//! | [`sync`] — a permit and a lock an `async fn` holds across an `.await`, first come first served; a bell that keeps a ring nobody was waiting for | `tokio::sync` | `tokio::sync`: it needs no runtime | the I/O step, for the image cache; a lock that guards a value with the sync step, for the pending pairing offer; the bell with live sync's connection manager, for its write wake |
//! | [`Sendable`] — what a fence over a future's `Send`-ness bounds by, and what `spawn` asks of an operation it is handed | `Send` | anything | the sync step, for the fences over a trip |
//! | [`spawn`] — work taken off the caller: minutes of SQLite under an `async fn`, a build nobody waits for, a sync operation | the async runtime's blocking pool, a thread | run where it stands: a Worker has no second thread | the I/O step, for the card sync's ingest and the facet index's build; an operation on a worker with live sync's connection manager, for its trips |
//! | [`socket`] — the relay's doorbell: one WebSocket, a keepalive, the next frame | `tokio-tungstenite` over rustls, the bearer in `Authorization` | refused in a sentence until the browser's own `WebSocket` is written | live sync's connection manager (the light app's phase 6, step 6.2) |
//!
//! [`alone`] is the odd one out: not an interface with two arms but a way for a native **test**
//! to feel the browser's — one thread, work run where it stands, a lock taken twice a failure.
//! [`host::emulate_page`] is its larger sibling: the same thread, with no files and with the
//! response headers a cross-origin `fetch` hides hidden — a native test's whole page.
//!
//! **Each is here because something calls it**: an interface written before the code that calls
//! it is a guess.
//!
//! **The fence holds four more names to this directory since the I/O step**: `reqwest`,
//! `tokio`, `std::fs` and `std::thread`, in shipped code — and, since [`socket`], its crate
//! (`tokio_tungstenite`, `tungstenite`). Each compiles for a desktop wherever it is written,
//! which is exactly why a compiler cannot be what keeps them here.
//!
//! **Every browser arm under this directory compiles, and the web host is what runs them**
//! (`crates/grimoire-web`, the light app's phase 5). CI's `core` job builds them for
//! `wasm32-unknown-unknown`. The first run of any of them was 2026-10-04, under Node's V8 rather
//! than a browser: the module instantiated over SQLite's in-memory VFS and commands of every
//! kind driven through it — which reached [`clock`], [`pause`], [`spawn`]'s `blocking` and the
//! refusing [`files`], and not [`http`], [`timer`] or `spawn`'s `background`. Those three are
//! first called by the web host's launch downloads (phase 5, step 5.2), and what a browser
//! made of them is `docs/reference/light-app.md`'s to record. **[`socket`]'s browser arm is the
//! one that is not run**: it refuses, and no host starts live sync's loop there yet.

pub mod alone;
pub mod clock;
pub mod device;
pub mod files;
pub mod host;
pub mod http;
mod pause;
pub mod socket;
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
