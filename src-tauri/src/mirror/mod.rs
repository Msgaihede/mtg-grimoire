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
//! # The modules
//!
//! [`layout`] is a pure function of the database's shape, [`paths`] is string handling,
//! [`read`] is four listings and [`readme`] is the one fixed file's words — none of them touches
//! a filesystem. [`run`], [`settings`] and [`watch`] are the folder: `std::fs`, an
//! `update_hook`, a thread and four `#[tauri::command]`s.

pub mod layout;
pub mod paths;
pub mod read;
pub mod readme;

/// The pass that writes the folder. `std::fs` from top to bottom.
pub mod run;
/// The two `app_meta` settings and the Backup panel's four commands.
pub mod settings;
/// The `update_hook`, the dirty [`watch::Mask`] and the thread that drains it.
pub mod watch;
