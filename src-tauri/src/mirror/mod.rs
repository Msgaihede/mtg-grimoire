//! The plain-text mirror: a write-only projection of the decks, the collection and the
//! wishlist onto files a reader can open in Notepad.
//!
//! The database stays the source of truth and **nothing here ever reads the mirror back**.
//! The mirror exists for the day the app will not start: the cards are still theirs, in
//! every format this app can write, in a folder they chose. See
//! `docs/superpowers/specs/2026-08-25-text-backed-cards-design.md`.
//!
//! Two consequences shape every module below it. It **cannot cost anything the reader can
//! feel**, so it runs off the read-only connection on its own thread and writes only bytes
//! that actually changed; and it **must survive being killed**, so a full pass runs at
//! startup rather than waiting for the next edit.
//!
//! # The split, and which half a browser gets
//!
//! **The tree and the renderer are every target's; the folder is not.** [`layout`] is a pure
//! function of the database's shape, [`paths`] is string handling, [`read`] is four listings
//! and [`snapshot`] turns a planned file into its bytes — none of them touches a filesystem or
//! a clock, and all four compile for `wasm32-unknown-unknown`. [`run`], [`settings`] and
//! [`watch`] are the folder: `std::fs`, an `update_hook`, a thread and four `#[tauri::command]`s
//! over `AppState` fields wasm's `AppState` does not have.
//!
//! **So web and Android get the same files as a zip, on demand** ([`snapshot`]), and
//! `mirror_set_root`, `mirror_set_enabled`, `mirror_status` and `mirror_rebuild` stay
//! desktop-only. That is the decision rather than a limitation: the mirror writes ~350 files so
//! that *other programs* can read them — a text editor, `grep`, a sync client — and OPFS is
//! invisible to every program but this one, while `tauri-plugin-dialog`'s manifest records
//! Android as having no folder picker at all, so the root could not even be chosen. A folder
//! nothing else can open would be the feature's name without the feature.

pub mod layout;
pub mod paths;
pub mod read;
pub mod readme;
pub mod snapshot;

/// The pass that writes the folder. `std::fs` from top to bottom.
#[cfg(not(target_family = "wasm"))]
pub mod run;
/// The two `app_meta` settings and the Backup panel's four commands.
#[cfg(not(target_family = "wasm"))]
pub mod settings;
/// The `update_hook`, the dirty [`watch::Mask`] and the thread that drains it.
#[cfg(not(target_family = "wasm"))]
pub mod watch;
