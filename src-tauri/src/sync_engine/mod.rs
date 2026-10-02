//! Keeping a pairing group's databases in step.
//!
//! Seven layers, and only three of them touch SQLite:
//!
//! * [`hlc`] — the hybrid logical clock. Pure.
//! * [`capture`] — the triggers that turn a local write into a row in `sync_ops`, inside the
//!   caller's own transaction.
//! * [`merge`] — spec §7.3's five rules, as pure functions over ops.
//! * [`apply`] — writing a merged result back: uid resolution, cycle-breaking, `needs_review`.
//! * [`baseline`] — a whole database as claim ops, for a peer that has never heard from it.
//! * [`wire`] — the encrypted envelope, batched at 200 ops per stored row.
//! * [`client`] — push and pull over `reqwest`.
//!
//! **The conflict rules live here rather than in TypeScript**, and the argument is in the plan
//! that built this module: "two devices each added one copy and the row must end at +2" is a
//! statement about rows rather than about Magic, an apply has to be transactional with the
//! writes it makes, and [`crate::reconcile`] already merges two versions of the reader's own
//! rows and writes `needs_review` sentences from Rust.
//!
//! [`hlc`], [`merge`], [`capture`], [`apply`] and [`baseline`] are `grimoire-core`'s, re-exported
//! here beside the layers that have not moved yet — the envelope, the client and what drives
//! them, which wait for the roster in `sync_pair::identity`.

pub use grimoire_core::sync_engine::apply;
pub use grimoire_core::sync_engine::baseline;
pub use grimoire_core::sync_engine::capture;
/// The two of `capture`'s tests that drive `reconcile`, which is still here.
#[cfg(test)]
mod capture_tests;
pub mod client;
/// The IPC surface.
pub mod commands;
/// The entitlement grant — the tokens that let this device talk to the relay at all, and the
/// supporter status the relay last reported.
pub mod entitlement;
pub use grimoire_core::sync_engine::hlc;
/// The relay socket and the task that acts on it.
pub mod live;
pub use grimoire_core::sync_engine::merge;
pub mod schedule;
pub mod wire;
