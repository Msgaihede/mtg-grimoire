//! **The Discord bot as a restricted sync device** — the Discord spec
//! (`docs/superpowers/specs/2026-10-17-discord-integration-design.md`) §9 and §13 (PR 3), and §14
//! (PR 4: the `add` capability).
//!
//! `grimoire-core` compiled to WASM for **workerd**, held by the `BotDevice` Durable Object in
//! `infrastructure/bot-device/`, one object per Discord link. It is a device of the reader's sync
//! group — paired by the desktop through an invite, holding its own identity and the group key —
//! that pulls the group's ops with the core's own client and answers narrow reads. It is an
//! **`add` device**: capture is off, so nothing it does to its own rows is ever an op; the one
//! thing it sends is what a reader confirmed in Discord (`/collection add`, `/wishlist add`), as
//! the single op `integration::add::emit` builds and every receiver's allow-list checks.
//!
//! | Module | Compiled for | Holds |
//! | --- | --- | --- |
//! | [`vfs`] | every target | The SQLite page store: pages in the Durable Object's SQL storage, sealed under `BOT_KEK` |
//! | [`device`] | every target | One object's engine: enrol, the alarm's step (pairing, push, pull, corpus), status, the reads, an add's target and its emit |
//! | [`queries`] | every target | The reads the Durable Object renders |
//! | [`corpus`] | every target | The slim corpus, from Scryfall's `/cards/collection` |
//! | `glue` | wasm32 only | The `#[wasm_bindgen]` class `Bot` and the JavaScript page store |
//!
//! **Only `glue` is gated to the target** — the web host's rule — so `cargo test -p grimoire-bot`
//! runs the VFS for real (natively, over an in-memory store), the core's real pairing against a
//! local rendezvous, and every query over a seeded pair.
//!
//! Built by `node scripts/build-wasm.ts --only bot` into `dist-wasm/bot/`
//! (`wasm-bindgen --target web`), which the Worker imports.
//!
//! # workerd, and what it changes
//!
//! * **No OPFS, so a VFS of its own** ([`vfs`]); **no threads**, which the core already runs
//!   without (its browser arms: `platform::spawn` inline, `platform::timer` on `setTimeout`).
//! * **`Date.now()` is frozen within an execution** and moves only across I/O. The core's clock
//!   reads it (`platform::clock`); the HLC counts past a frozen millisecond, a pairing's ten
//!   minutes and a token's expiry are measured across awaits, which move it. Nothing here times
//!   work with it.
//! * **128 MB an isolate, and a CPU budget an invocation.** The database is pages in storage
//!   with a megabyte of cache a file, not memory; the corpus is filled [`device::CORPUS_BATCHES`]
//!   requests an alarm; and **a pull is the core's paged pull** — 256 ops a page, each applied
//!   and committed before the next. ⚠️ **The core fetches every page to the head before it
//!   evaluates the last** (`sync_engine::client::pull`'s doc), so one catch-up's sealed text is
//!   held at once — bounded by the relay's 128 MiB group quota, not by this crate. A group whose
//!   catch-up is a large fraction of that is a pull this isolate cannot hold; the core would need
//!   a pull that stops after N pages (it cannot today without leaving the last page's decision
//!   unmade).

pub mod corpus;
pub mod device;
pub mod queries;
pub mod vfs;

#[cfg(target_family = "wasm")]
mod glue;
