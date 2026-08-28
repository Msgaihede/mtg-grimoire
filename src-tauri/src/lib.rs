//! The crate's module map, and nothing else.
//!
//! **The left column below compiles for `wasm32-unknown-unknown`; the right does not.**
//! Four of the exclusions are permanent (spec §6.3): the plain-text `mirror`, the Rust
//! `transfer` writer that exists only for it, the portable `update` swap, and `window`'s
//! Win32 snap layouts. The rest are "not yet" — they are ported with the commands that
//! need them. `images` is neither: on web the image cache is Cache Storage rather than a
//! filesystem, so it is a rewrite and not a port.

// ── Every target ─────────────────────────────────────────────────────────────────
pub mod card_row;
pub mod collection_source;
pub mod combos;
pub mod db;
pub mod errors;
pub mod feed;
pub mod filters;
pub mod index;
pub mod ingest;
pub mod legalities;
pub mod maintenance;
pub mod schema;
pub mod search;
pub mod slug;
pub mod sorting;
/// **Compiles for wasm and can never succeed there**, which is cheaper than gating it and is
/// the same trade [`combos::ingest_gz`] makes. Every path in here is `std::fs`, which builds
/// for `wasm32-unknown-unknown` and answers `Unsupported` at run time; its one caller,
/// [`schema::prepare_data_dir`], is reached only from `desktop::init_state`. A browser has no
/// legacy `mtg.db` to convert — its OPFS pool was created by a build that already had two
/// files — so there is nothing here for the web target to call.
pub mod split;
pub mod sync;
pub mod web;

// ── Desktop and Android ──────────────────────────────────────────────────────────
#[cfg(not(target_family = "wasm"))]
pub mod card;
#[cfg(not(target_family = "wasm"))]
pub mod collection;
#[cfg(not(target_family = "wasm"))]
pub mod collection_alloc;
#[cfg(not(target_family = "wasm"))]
pub mod collection_folders;
#[cfg(not(target_family = "wasm"))]
pub mod deck;
#[cfg(not(target_family = "wasm"))]
pub mod deck_audit;
#[cfg(not(target_family = "wasm"))]
pub mod deck_meta;
#[cfg(not(target_family = "wasm"))]
pub mod deck_theory;
#[cfg(not(target_family = "wasm"))]
pub mod deck_undo;
#[cfg(not(target_family = "wasm"))]
pub mod export;
#[cfg(not(target_family = "wasm"))]
pub mod flatten;
#[cfg(not(target_family = "wasm"))]
pub mod images;
#[cfg(not(target_family = "wasm"))]
pub mod import;
#[cfg(not(target_family = "wasm"))]
pub mod listview;
#[cfg(not(target_family = "wasm"))]
pub mod marketplace;
#[cfg(not(target_family = "wasm"))]
pub mod marketplace_feed;
#[cfg(not(target_family = "wasm"))]
pub mod mirror;
#[cfg(not(target_family = "wasm"))]
pub mod nav;
#[cfg(not(target_family = "wasm"))]
pub mod paths;
#[cfg(not(target_family = "wasm"))]
pub mod reconcile;
#[cfg(not(target_family = "wasm"))]
pub mod reset;
#[cfg(not(target_family = "wasm"))]
pub mod scryfall;
#[cfg(not(target_family = "wasm"))]
pub mod tags;
#[cfg(not(target_family = "wasm"))]
pub mod transfer;
#[cfg(not(target_family = "wasm"))]
pub mod update;
#[cfg(not(target_family = "wasm"))]
pub mod window;
#[cfg(not(target_family = "wasm"))]
pub mod wishlist;
#[cfg(not(target_family = "wasm"))]
pub mod wishlist_folders;
#[cfg(not(target_family = "wasm"))]
pub mod zoom;

#[cfg(not(target_family = "wasm"))]
mod desktop;
#[cfg(not(target_family = "wasm"))]
pub use desktop::run;
