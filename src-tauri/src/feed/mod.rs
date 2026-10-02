//! Reading a bulk feed a chunk at a time — and, in [`backoff`], when to stop asking for one.
//!
//! The framers and the floor every ingest holds are `grimoire_core::feed`'s, re-exported at the
//! paths they always had. [`backoff`] is still here: it reads `sync_meta`.

pub mod backoff;
pub use grimoire_core::feed::{frame, mostly_unusable};
