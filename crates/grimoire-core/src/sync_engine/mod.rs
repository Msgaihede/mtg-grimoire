//! Keeping a pairing group's databases in step.
//!
//! * [`hlc`] — the hybrid logical clock. Pure.
//! * [`capture`] — the triggers that turn a local write into a row in `sync_ops`, inside the
//!   caller's own transaction. [`crate::schema::bring_to_head`] installs them at every open.
//! * [`merge`] — spec §7.3's five rules, as pure functions over ops.
//! * [`apply`] — writing a merged result back: uid resolution, cycle-breaking, `needs_review`.
//!   It re-homes rows through the folder modules, so it arrived with them.
//! * [`baseline`] — a whole database as claim ops, for a peer that has never heard from it.
//! * [`wire`] — the encrypted envelope, batched at 200 ops per stored row.
//! * [`client`] — push, pull, the key check and the rendezvous, over `platform::http`.
//! * [`entitlement`] — the grant: the tokens that let this device talk to the relay at all,
//!   and the supporter status the relay last reported.
//! * [`schedule`] — when a trip runs, as a pure function of a clock. The connection manager
//!   that asks it is the desktop's, beside its socket.
//! * [`commands`] — what the sync panel reads and the functions its commands call. The
//!   `#[tauri::command]` wrappers are the desktop's.
//!
//! **A sync operation reaches the database a stretch at a time, on the lane**
//! ([`crate::state::Store`], [`crate::state::Lane`]) — see [`client`]'s module doc. The client,
//! the entitlement, the commands' functions and pairing arrived here in the sync step's second
//! part, after its first had restated them so that none holds a connection across a request.

pub mod apply;
pub mod baseline;
pub mod capture;
pub mod client;
pub mod commands;
pub mod entitlement;
pub mod hlc;
pub mod merge;
pub mod schedule;
pub mod wire;
