//! **The desktop's half of `collection_source`.**
//!
//! The module itself is `grimoire-core`'s and is re-exported here whole, so a path through this
//! one reaches that crate's item — except for what is defined below, because an item a module
//! defines shadows a glob import of the same name. What is below names a window or the
//! desktop's `AppState`: the `#[tauri::command]` wrappers and what only they call.
//!
//! [`with_write_owned`] is the core's `with_write` plus the facet index's `owned` rebuild, and
//! the index's lifecycle moves with the extraction's I/O step.

pub use grimoire_core::collection_source::*;

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// `crate::sync::with_write`, plus the facet index's `owned` rebuild on success.
///
/// Only on success. A refusal — [`crate::db::BUSY`], a `GONE`, a rejected quantity — changed
/// nothing, and re-reading after one would be a copy of the whole index to arrive at the same
/// answer.
///
/// Lives here rather than in [`crate::collection`] because its callers are a collection write,
/// [`crate::reset::collection_clear`] and anything else that can move what the reader owns, and
/// the thing they have in common is this module rather than that one.
pub(crate) fn with_write_owned<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);
    if answer.is_ok() {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}
