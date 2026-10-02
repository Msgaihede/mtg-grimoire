//! The facet index's building block.
//!
//! The index itself — `CardIndex`, its facets and its lifecycle — reads `filters`, the schema
//! and the collection source, so it is still `src-tauri`'s `index` and re-exports this.

pub mod bitset;
