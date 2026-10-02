//! Keeping a pairing group's databases in step — the layers that name nothing outside this
//! crate.
//!
//! * [`hlc`] — the hybrid logical clock. Pure.
//! * [`capture`] — the triggers that turn a local write into a row in `sync_ops`, inside the
//!   caller's own transaction. [`crate::schema::bring_to_head`] installs them at every open.
//! * [`merge`] — spec §7.3's five rules, as pure functions over ops.
//!
//! Apply, the baseline, the envelope and the client are still `src-tauri`'s `sync_engine`,
//! which re-exports these three beside them: `apply` re-homes rows through the folder modules,
//! and the envelope and the client wait for the roster in `sync_pair::identity`.

pub mod capture;
pub mod hlc;
pub mod merge;
