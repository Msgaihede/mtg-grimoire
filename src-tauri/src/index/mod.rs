//! **The facet index is `grimoire-core`'s, re-exported here beside its one command.**
//!
//! `CardIndex`, its facets and its lifecycle are in `crates/grimoire-core/src/index/` since the
//! extraction's I/O step, and a path through this module reaches that crate's item unless this
//! file defines it. It defines one thing: [`facets`], which is the core's module of that name
//! plus the `facet_cards` command.
//!
//! **No test of the index is here.** Every one moved with the code, onto a fixture the core
//! builds at head; the fixture this file had — an `AppState` over a file `split` converted —
//! went when its last caller did.

pub use grimoire_core::index::*;

pub mod facets;
