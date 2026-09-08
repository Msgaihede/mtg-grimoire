//! Publishing a collection folder as a read-only snapshot.
//!
//! **This module does not read through [`crate::collection::list_entries`], and that is the
//! whole of its safety.** That query scopes a named folder with `e.folder_id = ?` — direct
//! members only — and skips `exclude_locked` entirely whenever `folder_id` is set, because "a
//! named folder is served whole" is the right answer for a reader standing in their own drawer.
//! Both defaults publish more than the reader asked for. So the read here is its own, and where
//! `CollectionQuery`'s unasked question keeps every row, this one's keeps none.
mod snapshot;
#[cfg(test)]
mod tests;

pub use snapshot::{
    gzip, snapshot, ShareCard, ShareFields, ShareFolder, ShareSnapshot, FOLDER_IS_LOCKED,
    FOLDER_NOT_FOUND, FOLDER_NOT_SHAREABLE, SNAPSHOT_VERSION, WHOLE_COLLECTION_TITLE,
};
