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
/// **The resolution rule under the image cache, and the reason it is on this side of the
/// map while [`images`] is not.** Two columns of `cards`, the precedence between them and
/// one predicate over a string — no filesystem, no protocol handler, nothing a browser
/// lacks. `search.rs` puts a card's URL on a result row from here, and `images` composes
/// the same three pieces into a cached fetch.
pub mod image_uri;
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
/// **Every layer of the engine compiles for wasm, and that is the point rather than a bonus.**
/// The conflict rules are one implementation on three targets (spec §2), so a layer that
/// only built on the desktop would be a second copy of them waiting to be written — and
/// `wire` seals every batch with [`sync_pair::crypto`], so a browser that could not open an
/// envelope would be a browser that cannot sync. The one module inside it that is gated is
/// `commands`, which is `#[tauri::command]`s and therefore not a layer of anything.
pub mod sync_engine;
/// **Three of its four layers compile for wasm; `pairing` does not and never will.**
/// That module is `#[tauri::command]`s and a state machine over `AppState`, which is the
/// desktop's IPC surface; `crypto`, `invite` and `identity` are pure functions and three
/// SQLite tables, and [`sync_engine::wire`] seals every batch with the first of them. A
/// browser that could not open an envelope would be a browser that cannot sync.
pub mod sync_pair;
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
pub mod picked;
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
// Desktop only. `open_sized_to_monitor` calls `WebviewWindow::center()`, which tauri
// declares `#[cfg(desktop)]` (tauri/src/window/mod.rs:1924) — so this module is not merely
// useless on a phone, it does not compile there. Android's window is the activity and the
// OS sizes it.
//
// **`desktop` already excludes wasm and is not a second spelling of the gate above.** It is
// `tauri_build`'s cfg, emitted from `build.rs` — which returns before `tauri_build::build()`
// runs for a wasm `TARGET`, so nothing sets it there.
#[cfg(desktop)]
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
