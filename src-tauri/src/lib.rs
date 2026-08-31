//! The crate's module map, and nothing else.
//!
//! **The first block below compiles for `wasm32-unknown-unknown`; the second does not.**
//! Four of the exclusions are permanent (spec §6.3): the plain-text `mirror`, the Rust
//! `transfer` writer that exists only for it, the portable `update` swap, and `window`'s
//! Win32 snap layouts. The rest are "not yet" — they are ported with the commands that
//! need them. `images` is neither: on web the image cache is Cache Storage rather than a
//! filesystem, so it is a rewrite and not a port.
//!
//! **A module's side is decided by what is *in* it, not by where its commands are, and that
//! is what moved eleven of them on 2026-08-29.** The deck domain, the collection, the
//! wishlist and both folder tables were on the right because each file ends in a block of
//! `#[tauri::command]` wrappers — while everything above that block is `&Connection` in and
//! a DTO out. Gating the *wrappers* and leaving the module puts the SQLite underneath them
//! on both targets, which is the shape [`search`] has always had: two gated commands in an
//! ungated module, and `run_search` reachable from [`web::route`] because of it.
//!
//! **Compiling for wasm is not the same as being reachable from a browser.** These modules
//! build there; [`web::route`] answers four commands, and until a `match` arm names one the
//! page still gets `unknown command`. The two halves are deliberately separate PRs — this
//! one cannot change desktop behaviour, and the one that adds arms cannot fail to compile.

// ── Every target ─────────────────────────────────────────────────────────────────
/// **The `app_meta` key–value store, carved out of [`update`] so both targets have it.**
/// Eleven modules keep view state in that one table and only `update` swaps an `.exe`; a
/// re-export from there does not work, because a name re-exported from a gated module is
/// invisible on wasm exactly when it is wanted.
pub mod app_meta;
/// **The card pane, moved here on 2026-08-30** for the deck domain's reason and with the same
/// finding: its six command wrappers sit in a block and everything else is `&Connection` in,
/// DTO out - no filesystem, no `tokio`, no `reqwest` anywhere in the file. `card_detail` is
/// the command the reader hit first on the phone.
pub mod card;
pub mod card_row;
/// **The deck domain, and the ten modules below it, moved here on 2026-08-29** — they were
/// under "Desktop and Android" because of where their *commands* were, not because of
/// anything in them. Every one is `&Connection` in and a DTO out, with no `tauri::`, no
/// `tokio` and no filesystem: `deck.rs`'s 4 444 lines of real code contain no `tauri::`
/// reference before line 3992, where its command wrappers begin in one block.
///
/// **The gate did not go away, it moved onto the wrappers** — the shape [`search`] has had
/// all along, and the reason `run_search` is reachable from [`web::route`] while
/// `list_decks` was not. Nothing here is routed by that module yet; PR 10 does that, and
/// what this buys is that it *can* be.
pub mod collection;
pub mod collection_alloc;
pub mod collection_folders;
pub mod collection_source;
pub mod combos;
pub mod db;
pub mod deck;
pub mod deck_audit;
pub mod deck_meta;
pub mod deck_theory;
pub mod deck_undo;
pub mod errors;
pub mod feed;
pub mod filters;
/// **The resolution rule under the image cache, and the reason it is on this side of the
/// map while [`images`] is not.** Two columns of `cards`, the precedence between them and
/// one predicate over a string — no filesystem, no protocol handler, nothing a browser
/// lacks. `search.rs` puts a card's URL on a result row from here, and `images` composes
/// the same three pieces into a cached fetch.
/// **The four view-state modules, moved here on 2026-08-30.** `flatten`, `listview`, `nav` and
/// `zoom` each keep one setting in `app_meta` and answer it back - two commands apiece and no
/// filesystem, no `tokio` and no `reqwest` between them. They were on the other side only
/// because [`app_meta`] used to live inside the portable updater; PR 10a moved the store and
/// this moves the four modules that lean on it hardest.
pub mod flatten;
pub mod image_uri;
pub mod index;
pub mod ingest;
pub mod legalities;
pub mod listview;
pub mod maintenance;
/// **The stored marketplace id is every target's; telling the mirror about a change is not.**
/// `stored` and `store` are one settings row, and `deck_meta`'s readback quotes the first of
/// them on every platform — so the module is here and `set_marketplace_now`, which calls
/// `AppState.mirror` (a field wasm's `AppState` does not have), carries the gate instead.
pub mod marketplace;
pub mod nav;
/// **Three of Settings' four clears, moved here on 2026-08-31** — the deck domain's move a
/// day earlier, arrived at from the same finding. `clear_collection`, `clear_wishlist` and
/// `clear_decks` are `&Connection` in and a DTO out; what was holding the whole module on
/// the other side was the block of `#[tauri::command]` wrappers at its foot, and the gate
/// moved onto them.
///
/// **`clear_cache` is the one that did not come**, and it is the only thing in the file that
/// does not compile here: its `cache` parameter is [`images`]' type, and on web the byte
/// cache is Cache Storage rather than a directory. That is the same rewrite-not-a-port
/// `images` itself is, and it carries its own gate at its own site.
pub mod reset;
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
/// **The version, the release history and the clock they were read at — but never the swap.**
/// This module was §6.3's second permanent exclusion and only half of it ever was one: the
/// `.exe` replacement, the staging and the relaunch are Windows to the bone, while
/// `UpdateStatus`, [`update::history`] and the pure version comparison underneath them are a
/// `serde` struct and two `app_meta` reads. The half that swaps a file keeps the gate, item
/// by item; the half that *reports* is here, so `update_status` and `update_history` can be
/// answered on a target that has no executable to replace.
///
/// **What that buys is not a Download button, it is a decidable one.** `UpdatePanel` chooses
/// what to draw from `installKind`, which is an answer from this module — so where the
/// command did not answer at all, the panel read the silence as "not managed" and offered
/// controls a browser cannot honour. [`update::InstallKind::Web`] is the answer that was
/// missing.
pub mod update;
pub mod web;
pub mod wishlist;
pub mod wishlist_folders;
pub mod zoom;

// ── Desktop and Android ──────────────────────────────────────────────────────────
#[cfg(not(target_family = "wasm"))]
pub mod export;
#[cfg(not(target_family = "wasm"))]
pub mod images;
pub mod import;
pub mod marketplace_feed;
#[cfg(not(target_family = "wasm"))]
pub mod mirror;
#[cfg(not(target_family = "wasm"))]
pub mod paths;
#[cfg(not(target_family = "wasm"))]
pub mod picked;
#[cfg(not(target_family = "wasm"))]
pub mod reconcile;
#[cfg(not(target_family = "wasm"))]
pub mod scryfall;
pub mod tags;
#[cfg(not(target_family = "wasm"))]
pub mod transfer;
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
mod desktop;
#[cfg(not(target_family = "wasm"))]
pub use desktop::run;
