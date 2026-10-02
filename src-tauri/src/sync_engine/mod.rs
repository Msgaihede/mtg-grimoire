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
//! **Every layer but the socket is `grimoire-core`'s** since the sync step's second part,
//! re-exported here at the paths it always had. What is still this crate's is [`live`] — the
//! WebSocket connection manager, which is `tokio` tasks, `tokio-tungstenite` and a window to tell
//! — and [`commands`]' `#[tauri::command]` wrappers, beside a glob re-export of the core's module
//! of that name.

pub use grimoire_core::sync_engine::apply;
pub use grimoire_core::sync_engine::baseline;
pub use grimoire_core::sync_engine::capture;
pub use grimoire_core::sync_engine::client;
/// The IPC surface: the core's functions, and the wrappers that call them.
pub mod commands;
pub use grimoire_core::sync_engine::entitlement;
pub use grimoire_core::sync_engine::hlc;
/// The relay socket and the task that acts on it.
pub mod live;
pub use grimoire_core::sync_engine::merge;
pub use grimoire_core::sync_engine::schedule;
pub use grimoire_core::sync_engine::wire;
