//! The facet index's building block.
//!
//! The index itself — `CardIndex`, its facets and its lifecycle — is still `src-tauri`'s `index`,
//! which re-exports this. What it reads (`filters`, the schema, the collection source) is all in
//! this crate since the domain step; what keeps it is its lifecycle, which builds on a thread of
//! its own and arrives with the I/O step.

pub mod bitset;
