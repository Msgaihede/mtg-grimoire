//! Keeping a pairing group's databases in step.
//!
//! Six layers, and only two of them touch SQLite:
//!
//! * [`hlc`] — the hybrid logical clock. Pure.
//! * [`capture`] — the triggers that turn a local write into a row in `sync_ops`, inside the
//!   caller's own transaction.
//! * [`merge`] — spec §7.3's five rules, as pure functions over ops.
//! * [`apply`] — writing a merged result back: uid resolution, cycle-breaking, `needs_review`.
//! * [`wire`] — the encrypted envelope, batched at 200 ops per stored row.
//! * [`client`] — push and pull over `reqwest`.
//!
//! **The conflict rules live here rather than in TypeScript**, and the argument is in the plan
//! that built this module: "two devices each added one copy and the row must end at +2" is a
//! statement about rows rather than about Magic, an apply has to be transactional with the
//! writes it makes, and [`crate::reconcile`] already merges two versions of the reader's own
//! rows and writes `needs_review` sentences from Rust.
//!
//! **Every module here compiles for `wasm32-unknown-unknown`**, which is the third of those
//! arguments stated as a constraint: the web target's core is this same crate, so a layer that
//! did not compile there would be a second implementation of the conflict rules waiting to be
//! written. `hlc` and `merge` need nothing but `serde`; `capture` and `apply` need `rusqlite`,
//! which the wasm build already has; `wire` needs [`crate::sync_pair::crypto`], which is why
//! that module's five crates moved into `Cargo.toml`'s every-target block.

pub mod capture;
pub mod hlc;
pub mod merge;
