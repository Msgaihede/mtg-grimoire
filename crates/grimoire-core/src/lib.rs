//! MTG Grimoire's engine, with no window.
//!
//! Three hosts link this crate — the desktop app in `src-tauri`, an Android shell and a WASM
//! build running in a Worker — and it knows about none of them. Four rules hold that, and each
//! has something that goes red when it is broken:
//!
//! * **No `tauri`.** A window, a webview and a command attribute are a host's.
//!   [`platform`]'s fence reads `Cargo.toml` and every source file for the name.
//! * **`cfg(target_…)` appears only under [`platform`].** The first attempt at these targets
//!   ended with 552 gates scattered through the tree; here a module that needs to know the
//!   machine asks `platform` instead. The same fence sweeps for it.
//! * **Nothing outside [`platform`] reads the wall clock.** `SystemTime::now()` and
//!   `Instant::now()` both panic on `wasm32-unknown-unknown` — at run time, on a build that
//!   compiled clean.
//! * **CI compiles it for all three targets** on every pull request that can have broken it —
//!   the `core` job for `wasm32-unknown-unknown` and `aarch64-linux-android`, the `rust` job for
//!   the desktop, where the tests run.
//!
//! **It is being filled a step at a time.** What is here is the leaves; the storage layer — the
//! database, both schema ladders, and the modules that read only them; the state a host holds
//! over them — [`state::State`], the one update hook on its write connection ([`hooks`]) and the
//! way out for an event ([`events`]); and, since the domain step, what the app is *about*: the
//! decks, the collection, the wishlist, the search, the card pane and the view-state modules,
//! with [`state::with_write`] over them. What is not here yet reaches a network, a filesystem or
//! the relay: Scryfall and the feeds, the images, the facet index's lifecycle, the sync client.
//! What moves next, and in what order, is the light-app spec's §2.8.
//!
//! **`src-tauri` re-exports each moved module at the path it always had**, so `crate::schema`
//! over there is this crate's `schema` and no caller changed; its `AppState` wraps a
//! [`state::State`] and derefs to it, for the same reason. **A module with commands left them
//! behind**: a `#[tauri::command]` wrapper names a window, so each one stays in `src-tauri`, in a
//! module of the same name that re-exports this crate's with a glob and defines the wrappers
//! beside it. Nothing here is a command, and nothing here spawns a thread to run one on.
//!
//! **A few modules arrived without one function**, because that function names code a later
//! step moves — `errors`' `kind_of` (it classifies `scryfall`'s error), `deck`'s `bracket_reads`
//! (it matches against `combos`, a feed), `reset`'s `clear_cache` (the image cache) and
//! `collection_source`'s `with_write_owned` (the facet index) — or names something only the
//! desktop has: `schema`'s `prepare_data_dir`, `import`'s `read_import_file`, `marketplace`'s
//! `set_marketplace_now`. Each is still `src-tauri`'s, in the module that re-exports the rest.
//!
//! **A doc link here that names a module still in `src-tauri` — [`crate::scryfall`], say —
//! does not resolve yet.** They are left spelled as they were: every one names a module that
//! arrives in a later step, at which point the link is right again without an edit. A moved
//! file's own `//!` doc may still say its command wrappers are "at the foot": they are at the
//! foot of `src-tauri`'s module of that name.

pub mod activity;
/// **The `app_meta` key–value store.** One table and two functions, which view-state modules
/// across the app keep a setting in.
pub mod app_meta;
pub mod bulk_undo;
pub mod card;
/// **One Scryfall card object as the `cards` row it becomes**, and `raw`'s gzip.
pub mod card_row;
pub mod cardtypes;
pub mod collection;
pub mod collection_alloc;
pub mod collection_folders;
pub mod collection_source;
/// **The connections**: the pair `user.db` + `corpus.db`, the pragmas each file needs, and the
/// two ways of asking for the write connection — a bounded ask that answers `BUSY`, and a
/// background batch that stands aside for one.
pub mod db;
pub mod deck;
pub mod deck_audit;
pub mod deck_completion;
pub mod deck_meta;
pub mod deck_missing;
pub mod deck_notes;
pub mod deck_pull;
pub mod deck_query;
pub mod deck_quick_add;
pub mod deck_theory;
pub mod deck_todos;
pub mod deck_tokens;
pub mod deck_undo;
pub mod deckpane;
pub mod decksort;
/// **The error log**: what failed, when, how often. The Scryfall classifier, `kind_of`, is
/// still `src-tauri`'s.
pub mod errors;
/// **How an event leaves this crate**: one trait a host implements, given to the [`state`] it
/// builds. Nothing here takes a window.
pub mod events;
/// **Reading a bulk feed a chunk at a time.** The framers, and the floor every ingest holds
/// before it swaps.
pub mod feed;
/// **The card filters every list shares**, as SQL: `push_card_filters` and the FTS match.
pub mod filters;
pub mod home;
/// **The one update hook on the write connection, and who it tells.** SQLite allows one per
/// connection, so this crate owns the installer and a host registers observers.
pub mod hooks;
/// **The resolution rule under the image cache.** Two columns of `cards`, the precedence
/// between them and one predicate over a string.
pub mod image_uri;
pub mod import;
/// **The facet index's bitset.** The index itself still lives in `src-tauri`.
pub mod index;
pub mod legalities;
pub mod listview;
pub mod maintenance;
pub mod managed_wishlist;
pub mod markcolors;
pub mod marketplace;
pub mod nav;
pub mod new_printings;
/// **The one place this crate knows which machine it is on.**
pub mod platform;
pub mod price_history;
pub mod recent_cards;
pub mod reset;
/// **Every table, both ladders and the staging swaps.** `bring_to_head` is the half of a launch
/// that may stop it; `prepare_database` is that and the half that is logged and left owing.
pub mod schema;
/// **Where a test puts a real file.** Test builds, and other crates' through `testing`.
#[cfg(any(test, feature = "testing"))]
pub mod scratch;
pub mod search;
pub mod searchopen;
pub mod set_completion;
pub mod shelffolds;
pub mod slug;
/// **The sort vocabulary and every price expression.**
pub mod sorting;
pub mod stackhide;
pub mod startview;
/// **What every host holds while it runs**: the connections, the data directory, the cross-file
/// fence and the event sink — the half of the desktop's `AppState` with no reason to know about
/// a window, as far as the extraction has got — and `with_write`, the one definition of a
/// user-facing write.
pub mod state;
pub mod sticky_notes;
/// **The sync engine without its transport** — the hybrid logical clock, the capture triggers,
/// the merge rules, apply and the baseline. The envelope and the client are still `src-tauri`'s.
pub mod sync_engine;
/// **The `sync_meta` key–value store**, carved out of `src-tauri`'s `sync`.
pub mod sync_meta;
/// **Pairing's pure half** — the cryptography and the invite.
pub mod sync_pair;
pub mod upcoming_sets;
pub mod value_history;
pub mod wishlist;
pub mod wishlist_folders;
pub mod wishlist_optimize;
pub mod zoom;
