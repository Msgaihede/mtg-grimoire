//! Publishing a collection folder as a read-only snapshot.
//!
//! **This module does not read through [`crate::collection::list_entries`], and that is the
//! whole of its safety.** That query scopes a named folder with `e.folder_id = ?` — direct
//! members only — and skips `exclude_locked` entirely whenever `folder_id` is set, because "a
//! named folder is served whole" is the right answer for a reader standing in their own drawer.
//! Both defaults publish more than the reader asked for. So the read here is its own, and where
//! `CollectionQuery`'s unasked question keeps every row, this one's keeps none.
/// The `collection_shares` reads and writes.
pub mod cache;
/// The five `#[tauri::command]`s and [`commands::ShareRow`].
pub mod commands;
/// A deck's share — its live list, drawn as a deck (issue #1032).
mod deck;
/// The upload.
pub mod publish;
mod snapshot;
#[cfg(test)]
mod tests;
/// A wishlist's share — the whole list, one folder, or a deck's managed wishlist (issue #941).
mod wishlist;

pub use deck::{ShareCover, ShareDeck, SharePile, DECK_NOT_FOUND};
pub use snapshot::{
    gzip, snapshot, ShareCard, ShareFields, ShareFolder, ShareSnapshot, FOLDER_IS_LOCKED,
    FOLDER_NOT_FOUND, SNAPSHOT_VERSION, WHOLE_COLLECTION_TITLE,
};
pub use wishlist::{WHOLE_WISHLIST_TITLE, WISHLIST_FOLDER_NOT_FOUND};
