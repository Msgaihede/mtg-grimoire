//! Publishing a collection folder, a wishlist or a deck as a read-only snapshot, and keeping it
//! current.
//!
//! **This module does not read through [`crate::collection::list_entries`], and that is the
//! whole of its safety.** That query scopes a named folder with `e.folder_id = ?` — direct
//! members only — and skips `exclude_locked` entirely whenever `folder_id` is set, because "a
//! named folder is served whole" is the right answer for a reader standing in their own drawer.
//! Both defaults publish more than the reader asked for. So the read here is its own, and where
//! `CollectionQuery`'s unasked question keeps every row, this one's keeps none.
//!
//! **That read is [`crate::integration::projection`]'s since PR 2 of issue #1396** — the share
//! snapshot is a filtered output of the projector (spec §7.5) — and this module is what a share
//! adds to it: the key that names what is published, the refusals, the share's own field policy,
//! the short keys of `ShareSnapshot v1`, the `collection_shares` cache and the upload.
//!
//! **Here and not in the desktop host since that PR**, so Android and the web host refresh a share
//! too. The desktop keeps the `#[tauri::command]`s and the viewer that opens a stranger's link,
//! and re-exports this module at the path it always had.

/// The `collection_shares` reads and writes, and [`ShareRow`].
pub mod cache;
/// A deck's share — its live list, drawn as a deck (issue #1032).
pub mod deck;
/// The upload, and the publish round's share half.
pub mod publish;
/// The snapshot: its wire structs, the collection's share, and the gzip.
pub mod snapshot;
/// A wishlist's share — the whole list, one folder, or a deck's managed wishlist (issue #941).
pub mod wishlist;

pub use cache::ShareRow;
pub use deck::{ShareCover, ShareDeck, SharePile, DECK_NOT_FOUND};
pub use snapshot::{
    gzip, snapshot, ShareCard, ShareFields, ShareFolder, ShareSnapshot, FOLDER_IS_LOCKED,
    FOLDER_NOT_FOUND, SNAPSHOT_VERSION, WHOLE_COLLECTION_TITLE,
};
pub use wishlist::{WHOLE_WISHLIST_TITLE, WISHLIST_FOLDER_NOT_FOUND};
