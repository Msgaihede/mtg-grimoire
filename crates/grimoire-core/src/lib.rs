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
//! **It is being filled a step at a time.** What is here is the leaves, the storage layer —
//! the database, both schema ladders, and the modules that read only them — and the state a
//! host holds over them: [`state::State`], the one update hook on its write connection
//! ([`hooks`]) and the way out for an event ([`events`]). `src-tauri` re-exports each moved
//! module at the path it always had, so `crate::schema` over there is this crate's `schema` and
//! no caller changed; its `AppState` wraps a [`state::State`] and derefs to it, for the same
//! reason. What moves next, and in what order, is the light-app spec's §2.8.
//!
//! **Two modules arrived without one function each**, because that function names code a later
//! step moves: `schema`'s `prepare_database` (the launch's logged passes call the deck and
//! wishlist modules) and `errors`' `kind_of` (it classifies `scryfall`'s error). Both are still
//! `src-tauri`'s, in a module that re-exports the rest.
//!
//! **A doc link here that names a module still in `src-tauri` — [`crate::filters`], say —
//! does not resolve yet.** They are left spelled as they were: every one names a module that
//! arrives in a later step, at which point the link is right again without an edit.

/// **The `app_meta` key–value store.** One table and two functions, which view-state modules
/// across the app keep a setting in.
pub mod app_meta;
/// **One Scryfall card object as the `cards` row it becomes**, and `raw`'s gzip.
pub mod card_row;
pub mod cardtypes;
/// **The connections**: the pair `user.db` + `corpus.db`, the pragmas each file needs, and the
/// two ways of asking for the write connection — a bounded ask that answers `BUSY`, and a
/// background batch that stands aside for one.
pub mod db;
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
/// **The one update hook on the write connection, and who it tells.** SQLite allows one per
/// connection, so this crate owns the installer and a host registers observers.
pub mod hooks;
/// **The resolution rule under the image cache.** Two columns of `cards`, the precedence
/// between them and one predicate over a string.
pub mod image_uri;
/// **The facet index's bitset.** The index itself still lives in `src-tauri`.
pub mod index;
pub mod legalities;
/// **The one place this crate knows which machine it is on.**
pub mod platform;
/// **Every table, both ladders and the staging swaps.** `bring_to_head` is the half of a launch
/// that may stop it; the half that is logged and left owing is the host's until step 4.
pub mod schema;
/// **Where a test puts a real file.** Test builds, and other crates' through `testing`.
#[cfg(any(test, feature = "testing"))]
pub mod scratch;
pub mod slug;
/// **The sort vocabulary and every price expression.**
pub mod sorting;
/// **What every host holds while it runs**: the connections, the data directory, the cross-file
/// fence and the event sink. The half of the desktop's `AppState` with no reason to know about
/// a window — as far as the extraction has got.
pub mod state;
/// **The sync engine's pure half** — the hybrid logical clock and the merge rules.
pub mod sync_engine;
/// **The `sync_meta` key–value store**, carved out of `src-tauri`'s `sync`.
pub mod sync_meta;
/// **Pairing's pure half** — the cryptography and the invite.
pub mod sync_pair;
