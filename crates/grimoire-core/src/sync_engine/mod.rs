//! Keeping a pairing group's databases in step — the half that is pure functions.
//!
//! * [`hlc`] — the hybrid logical clock.
//! * [`merge`] — spec §7.3's five rules, as functions over ops.
//!
//! Capture, apply, the baseline, the envelope and the client are still `src-tauri`'s
//! `sync_engine`, which re-exports these two beside them.

pub mod hlc;
pub mod merge;
