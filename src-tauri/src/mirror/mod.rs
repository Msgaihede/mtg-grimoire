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

pub mod layout;
pub mod paths;
pub mod read;
pub mod run;
pub mod settings;
pub mod watch;
