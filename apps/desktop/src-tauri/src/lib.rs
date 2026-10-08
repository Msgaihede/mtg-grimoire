//! The crate's module map, and nothing else: the command registry and the app's startup are
//! `desktop.rs`'s.
//!
//! **A `pub use grimoire_core::…` in this map is a module that has moved to the shared core**
//! (`crates/grimoire-core`, the light app's spec §2.8) and is re-exported at the path it always
//! had, so `crate::legalities` here is that crate's `legalities` and no caller changed.
//!
//! **A `pub mod` here is not always a module that has not moved.** Since the extraction's domain
//! step most of them are the *desktop's half* of one that has: `deck/mod.rs` is
//! `pub use grimoire_core::deck::*;` and, below it, deck's `#[tauri::command]` wrappers — a
//! wrapper names a window, so it cannot move. The doc comment on each line below describes the
//! module, wherever its code now is; each `<module>/mod.rs` says what it kept and why.

/// **The collection's and the wishlist's history, and the feed that reads it beside
/// [`deck_audit`].** A table, a `record` that takes the caller's `&Connection` so a row lands
/// inside the transaction of the change it describes, and one query. No clock beyond SQLite's
/// own `unixepoch()`, no filesystem and no network.
pub mod activity;
/// **The `app_meta` key–value store, carved out of [`update`].** Eleven modules keep view state
/// in that one table and only `update` swaps an `.exe`. `grimoire-core`'s, re-exported.
pub use grimoire_core::app_meta;
/// **Which pages are this app's own, and the navigation guard that keeps every window on them.**
/// One origin set, read by the guard and by [`camera`], so the two cannot disagree.
pub mod app_origin;
pub mod archive;
/// **Taking back one bulk collection or wishlist write** (issue #555) — the before/after images of
/// exactly the rows it changed, held in memory for the session and put back only while nothing
/// has touched them since.
pub mod bulk_undo;
/// **The camera-permission handler for the in-app QR scanner.** `#[cfg(windows)]` inside:
/// WebView2 needs `webview2-com` COM interop, and everywhere else `camera::install` is a no-op.
pub mod camera;
/// **The card pane.** Its six command wrappers sit in a block and everything else is
/// `&Connection` in, DTO out.
pub mod card;
pub use grimoire_core::card_row;
pub use grimoire_core::cardtypes;
/// **Which user tables a commit wrote, told to every open window.** It rides the write
/// connection's update hook and lives on `AppState` beside `mirror`. See the module doc.
pub mod changes;
pub mod collection;
pub mod collection_alloc;
pub mod collection_folders;
pub use grimoire_core::collection_source;
pub mod combos;
/// The fence between `grimoire-core`'s command table and `generate_handler!` — test-only.
#[cfg(test)]
mod command_table;
pub use grimoire_core::db;
pub mod deck;
pub mod deck_audit;
/// **The home page's Deck completion read and To review's deck-card count** — how much of each
/// deck the reader holds and what the rest costs, by the deck editor's own rules and through its
/// own two pool functions, and how many deck rows are flagged. No table of its own, no clock and
/// no network.
pub mod deck_completion;
pub mod deck_meta;
pub mod deck_missing;
/// **A deck's notebook** — user schema v43, issue #447. Two tables, eight commands and no
/// renderer: a note's body is CommonMark stored as text, because a markdown reader in this crate
/// would be a second implementation of the TypeScript one and `packages/ui/features/transfer/__golden__`
/// is the fence that exists to make exactly that pair go red. Nothing in it reaches a filesystem
/// or a network.
pub mod deck_notes;
pub mod deck_pull;
/// **Which of a deck's cards answer the search terms typed into the editor's filter box** —
/// issue #621. One read over `deck_cards`, through the search's own `filters` SQL.
pub mod deck_query;
pub mod deck_quick_add;
pub mod deck_theory;
/// **A deck's to-do list** — user schema v58. Two `decks` columns rather than a table, three
/// commands and no renderer: the body is the checklist dialect `todoMarkdown.ts` reads, stored as
/// text, and every conclusion drawn from it (what is open, which line a tick flips) is
/// TypeScript's. Nothing in it reaches a filesystem or a network.
pub mod deck_todos;
/// **The tokens and emblems a deck needs, derived — and which printings of them the reader keeps,
/// stored.** Which tokens a deck makes is derived (schema v37): it reads `all_parts` out of each
/// deck card's gzip `raw` blob, which is [`card::meld_parts`]' one trick applied to a different
/// `component`, so it is a sibling of that function.
/// Which printings the reader keeps, in which finish and how many, is stored — the entries of
/// `deck_token_printings` since user schema v52, which nothing can derive. Nothing here reaches a
/// filesystem or a network.
pub mod deck_tokens;
pub mod deck_undo;
/// **[`decksort`]'s neighbour and its argument, one page over.** It is [`listview`]'s shape with a
/// *fixed* field list — one `app_meta` row holding a width and a collapse, an infallible read and
/// a write whose only refusal is a width outside a storage band — and it is filed up here rather
/// than beside the view-state run below for the reason the module under it gives: the decks page's
/// own settings are what somebody looking between `deck_undo` and `errors` came here to find.
pub mod deckpane;
/// **A view-state module wearing the deck domain's name.** It is [`listview`]'s shape exactly —
/// one `app_meta` row, an infallible read and a write whose only refusal is a blank — and it is
/// filed here rather than beside its four siblings below because a `decksort` between
/// `deck_undo` and `errors` is where the next person looking for the deck gallery's settings
/// will look.
pub mod decksort;
/// **The error log**: what failed, when, how often. `grimoire-core`'s, re-exported — whole
/// since the I/O step, when `kind_of` followed `scryfall` there.
pub use grimoire_core::errors;
pub mod export;
pub use grimoire_core::feed;
/// **Every file dialog the app shows, opened from Rust** (issue #545) — so the path the reader
/// chose goes to the read or the write without crossing IPC, and no command takes a path from
/// the page. The rule for the next file command is in the module doc.
pub mod file_dialog;
pub use grimoire_core::filters;
/// **[`markcolors`]'s shape with a document instead of a map.** One `app_meta` row, an
/// infallible read that answers the default layout for anything it cannot parse, and a write
/// that validates the document's *shape* and never its vocabulary — a widget kind this build
/// has never heard of survives a round trip, which is what stops an older build quietly
/// emptying a newer one's row.
pub mod home;
/// **The resolution rule under the image cache.** Two columns of `cards`, the precedence
/// between them and one predicate over a string — no filesystem and no protocol handler.
/// `search.rs` puts a card's URL on a result row from here, and [`images`] composes the same
/// three pieces into a cached fetch. `grimoire-core`'s, re-exported.
pub use grimoire_core::image_uri;
pub mod images;
pub mod import;
pub mod index;
/// **`grimoire-core`'s bulk-file ingest**, and the one test of it that builds its database with
/// [`split`].
pub mod ingest;
pub use grimoire_core::legalities;
/// **The four view-state modules.** `listview`, `nav`, `searchopen` and `zoom` each keep one
/// setting in `app_meta` and answer it back - two commands apiece. [`searchopen`] arrived on
/// 2026-09-07, when `deck.rs`'s one boolean row became a map three docked search columns share.
/// **They are not the only ones of this shape in the crate** — [`deckpane`], [`decksort`] and
/// [`markcolors`] are three more, filed where the page they belong to would be looked for rather
/// than in this run; the run is a place in the alphabet, not the list of view-state modules.
pub mod listview;
pub mod maintenance;
/// **A theory deck's managed wishlist** (user schema v48, issue #512) — a wishlist folder each
/// device derives from its own copy of the deck and rewrites after every write, and the guard
/// that refuses a hand-made edit to it.
pub use grimoire_core::managed_wishlist;
/// **A settings row wearing [`listview`]'s shape with the vocabulary moved one step out.**
/// There the frontend owns which walls exist and this crate owns the two words a wall may be
/// drawn in; here the frontend owns which *marks* exist and this crate owns only the shape a
/// colour may have. One `app_meta` row, an infallible read and a write whose refusals are a
/// blank key and anything that is not `#rrggbb` — no filesystem, no clock and no network.
pub mod markcolors;
/// **The stored marketplace id.** `stored` and `store` are one settings row, and `deck_meta`'s
/// readback quotes the first of them; `set_marketplace_now` also tells the mirror about a
/// change.
pub mod marketplace;
pub mod marketplace_feed;
/// **The plain-text mirror** — the decks, the collection and the wishlist written to a folder a
/// reader can open without the app. Its module doc says which half touches the filesystem.
pub mod mirror;
pub mod nav;
/// **The home page's New printings feed** — reprints of cards the reader's watched decks already
/// hold, newest first. Two `SELECT`s over `deck_cards` and the corpus plus one `app_meta` row for
/// the *seen* cursor; no table of its own, no filesystem and no network, and its only clock is
/// SQLite's `date('now')`.
pub mod new_printings;
pub mod paths;
/// **The home page's Price movers history** — user schema v45, a snapshot of today's price per
/// owned printing and a read that compares against one. The day is SQLite's `date('now')`, never
/// `SystemTime::now()`, and nothing in it reaches a filesystem or a network.
pub mod price_history;
/// **[`home`]'s shape with a list instead of a document** — the cards this device opened most
/// recently, one `app_meta` row of ids and times, joined with the corpus at read time. Its clock is
/// SQLite's `unixepoch()` rather than `SystemTime::now()`.
pub mod recent_cards;
/// **Scryfall's id-migration log applied to the reader's rows, and the orphan sweep.**
/// `grimoire-core`'s, re-exported.
pub use grimoire_core::reconcile;
/// **Settings' four clears.** `clear_collection`, `clear_wishlist` and `clear_decks` are
/// `&Connection` in and a DTO out; `clear_cache` takes [`images`]' byte cache as well.
pub mod reset;
/// **The card scanner's commands**, over a glob re-export of `grimoire-core`'s `scanner` — whose
/// doc has the asset load order, the lease, the prefs and the tray; this module's has the request
/// body and the embedded assets. Its commands are registered in `desktop.rs`.
pub mod scanner;
/// **`grimoire-core`'s schema, and the two launch functions that could not move with it** —
/// `prepare_database` and `prepare_data_dir`. See the module doc for where the cut is.
pub mod schema;
/// **Where a test puts a real file** — one directory per `cargo test` process and one per test
/// below it, so two worktrees' runs at once never share a database. Test builds only:
/// `grimoire-core`'s, behind its `testing` feature, which this crate asks for under
/// `[dev-dependencies]`.
#[cfg(test)]
use grimoire_core::scratch;
/// **The Scryfall client** — the bulk check, the download, the set list, the migration log and
/// one card image, behind the pacing gate and the 429 lockout. `grimoire-core`'s, re-exported,
/// over its `platform::http`.
pub use grimoire_core::scryfall;
pub mod search;
pub mod searchopen;
/// **How much of each set the reader owns**, for the home page's Set completion widget. One
/// grouped `SELECT` over the collection, `cards` and `sets` — no table of its own.
pub mod set_completion;
/// **A collection folder, published read-only.** Rendering a folder as a share snapshot is
/// SQLite in and JSON out; the publish puts the bytes on the relay.
pub mod share;
/// **Which shelves the reader folded, per page** — one `app_meta` row, [`searchopen`]'s shape one
/// level deeper: an infallible read, a write that refuses an unknown page or a key that is not a
/// folder id, and `None` taking an override back off. No filesystem, no clock and no network.
pub mod shelffolds;
pub use grimoire_core::slug;
pub use grimoire_core::sorting;
/// **A pre-27 single-file `mtg.db`, taken apart into `user.db` and `corpus.db`.** Its one
/// caller, [`schema::prepare_data_dir`], is reached only from `desktop::init_state`.
pub mod split;
/// **Which stacks the reader hid in a deck** (issue #618) — [`shelffolds`]' shape keyed by deck:
/// one `app_meta` row, an infallible read and a write whose only refusal is an id that is not
/// positive. No filesystem, no clock and no network.
pub mod stackhide;
/// **Whether the background startup has landed, as the webview asks it.** Managed Tauri state
/// and one `#[tauri::command]`. See the module doc for why startup left the UI thread.
pub mod startup;
/// **[`nav`]'s shape with a word instead of a bit, and [`listview`]'s split.** Which view the
/// app opens on is one `app_meta` row; *which views exist* is TypeScript's, so this module
/// stores a non-empty word and validates nothing else. A Rust-side allow-list would make every
/// new view a Rust change and would strand a reader on a page a downgrade no longer draws.
pub mod startview;
/// **The home page's sticky notes** — the first user table that hangs off nothing, and five
/// commands over it. SQLite in and a DTO out with no clock beyond `unixepoch()`.
pub mod sticky_notes;
pub mod sync;
/// **The sync engine.** `wire` seals every batch with [`sync_pair::crypto`]; `commands` is its
/// `#[tauri::command]`s.
pub mod sync_engine;
/// **Pairing, in four layers.** `pairing` is `#[tauri::command]`s and a state machine over
/// `AppState`; `crypto`, `invite` and `identity` are pure functions and three SQLite tables, and
/// [`sync_engine::wire`] seals every batch with the first of them.
pub mod sync_pair;
pub mod tags;
/// **The Rust half of an export, and the second implementation the golden fence exists for.**
/// `packages/ui/features/transfer/export/` is the first; this one is here because the mirror thread
/// cannot ask the page to render a file. Pure formatting: `&[Card]` and two enums in, a `String`
/// out, with no filesystem, no clock and no `tauri::` anywhere in it.
/// `packages/ui/features/transfer/__golden__/` is one corpus and one golden set that both suites assert
/// byte equality against.
pub mod transfer;
/// **The home page's Coming soon read** — sets with printings announced for the next N days,
/// read off `cards`. One `SELECT` whose only clock is SQLite's `date('now')`.
pub mod upcoming_sets;
/// **The version, the release history and the portable swap.** `UpdateStatus` and
/// [`update::history`] are a `serde` struct and two `app_meta` reads; the `.exe` replacement,
/// the staging and the relaunch are the rest.
pub mod update;
/// **The home page's Collection value graph** — user schema v50's `price_snapshots.copies`
/// multiplied back out into what the collection was worth each day, split four ways, with a live
/// point for today. One read over the table [`price_history`] writes and the collection
/// [`collection`] summarises; its only clock is SQLite's `date('now')`.
pub mod value_history;
/// **What size a window opens at, and where** — the first one's, and every one
/// [`window::open_new`] opens behind a relaunch or Ctrl+Shift+N.
pub mod window;
pub mod wishlist;
pub mod wishlist_folders;
/// **The wishlist's cheapest-printing sweep** — issue #352, and two commands rather than one
/// button because the reader has to be able to see what a press would do before making it.
/// Beside [`wishlist`] rather than inside it: that module is the wishlist's storage and its
/// list, and this one is a *policy* over both — it reads through
/// [`wishlist::wishlist_scope`] and writes through [`wishlist::set_printing_inner`], adding
/// no SQL over `wishlist_entries` of its own except the one guard read that tells a stale
/// row from a live one.
pub mod wishlist_optimize;
pub mod zoom;

mod desktop;
pub use desktop::run;
