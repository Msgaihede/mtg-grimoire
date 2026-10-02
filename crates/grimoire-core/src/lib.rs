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
//! **This is the extraction's first step, so what is here is the leaves**: the modules that
//! name nothing still in `src-tauri`. That crate re-exports each one at the path it always
//! had, so `crate::legalities` over there is this crate's `legalities` and no caller changed.
//! What moves next, and in what order, is the light-app spec's §2.8.
//!
//! **A doc link here that names a module still in `src-tauri` — [`crate::filters`], say —
//! does not resolve yet.** They are left spelled as they were: every one names a module that
//! arrives in a later step, at which point the link is right again without an edit.

/// **The `app_meta` key–value store.** One table and two functions, which view-state modules
/// across the app keep a setting in.
pub mod app_meta;
pub mod cardtypes;
/// **Reading a bulk feed a chunk at a time.** The framers, and the floor every ingest holds
/// before it swaps.
pub mod feed;
/// **The facet index's bitset.** The index itself still lives in `src-tauri`.
pub mod index;
pub mod legalities;
/// **The one place this crate knows which machine it is on.**
pub mod platform;
pub mod slug;
/// **The sync engine's pure half** — the hybrid logical clock and the merge rules.
pub mod sync_engine;
/// **Pairing's pure half** — the cryptography and the invite.
pub mod sync_pair;
