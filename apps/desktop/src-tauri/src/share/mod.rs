//! **The desktop's half of `share`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole — the snapshot and its
//! readers, the `collection_shares` cache, the publish requests and the publish round's half —
//! so a path through this one reaches that crate's item, except for what is defined below: an
//! item a module defines shadows a glob import of the same name. What is below names a window or
//! the desktop's `AppState` — the `#[tauri::command]`s — or is the viewer, which opens a
//! stranger's link and stayed the desktop's (`publish`, beside a glob of the core's module of
//! that name).
//!
//! **The share goldens stay here**, `__golden__/snapshot.json` and `deck.json`, with the tests that
//! hold the writer to them: the two TypeScript viewers read these very files, and they are what
//! said the snapshot did not move a byte when its reads went to the core's projector.

pub use grimoire_core::share::*;

/// The `#[tauri::command]`s, and [`commands::ShareRow`] re-exported from the core.
pub mod commands;
/// The viewer, beside the core's upload.
pub mod publish;
#[cfg(test)]
mod tests;
