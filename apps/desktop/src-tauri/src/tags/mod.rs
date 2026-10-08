//! **Scryfall's two Tagger taxonomies are `grimoire-core`'s, re-exported here beside their
//! commands.**
//!
//! The engine — the fetch, the parse, the graph walk, the staged write and the swap — and both
//! bindings, the search and the mute list are in `crates/grimoire-core/src/tags/` since the
//! extraction's I/O step. A path through this module reaches that crate's item unless a file
//! here defines it, and what the four files here define is the twelve `#[tauri::command]`
//! wrappers: each of them is the core's module of its name, and the commands below it.
//!
//! A refresh takes no window: it says what it is doing through the state's event sink, which
//! this app forwards to every window.

pub use grimoire_core::tags::*;

pub mod art;
pub mod muted;
pub mod oracle;
pub mod query;
