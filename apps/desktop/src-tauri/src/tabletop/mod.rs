//! The Tabletop Simulator integration: every deck as a Tabletop Simulator save, in an
//! `MTG Grimoire` folder inside the reader's TTS `Saves` folder, kept up to date as they edit
//! (issue #1038).
//!
//! **Off until the reader switches it on** — Settings → Integrations. It writes into a folder that
//! belongs to another program, which is not something to do uninvited.
//!
//! It is the text mirror's sibling and borrows its shape on purpose: a write-only projection, on a
//! thread of its own and a read-only connection of its own, debounced, writing only bytes that
//! changed, pruning only what its own manifest says it wrote, and running a full pass at startup so
//! the folder is right after a crash. What it does **not** share is the mirror's mask: the two
//! threads would race to take one, so this one is told about writes by an observer of its own
//! ([`watch::Tabletop`]), which also hears the token tables the mirror ignores.
//!
//! # The modules
//!
//! [`save`] is the TTS file format and touches nothing; [`read`] turns one list of one deck into
//! stacks of cards; [`images`] keeps local copies of the pictures for a reader who asks for them;
//! [`run`] is the pass over the folder; [`settings`] is the three `app_meta` rows and the
//! Settings panel's five commands; [`watch`] is the observer and the thread.

pub mod images;
pub mod read;
pub mod run;
pub mod save;
pub mod settings;
pub mod watch;
