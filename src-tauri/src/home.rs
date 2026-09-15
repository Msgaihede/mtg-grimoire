//! The home page's layout document — which widgets the reader has, where each sits on the page's
//! square-cell grid and how many cells it covers.
//!
//! **[`crate::markcolors`]'s shape with a document instead of a map, and its four rules
//! unchanged.** That module owns the shape a *colour* may have and knows nothing about which
//! marks exist; this one owns the shape a *widget entry* may have and knows nothing about which
//! widgets exist. `kind` is a free [`String`] and `config` is an opaque [`serde_json::Value`],
//! and the whole vocabulary — `summary`, `decks`, `folders`, `collectionValue`, `wishlistValue`,
//! `activity`, and whatever a later build adds — lives in TypeScript. Rust supplies the row; the
//! page draws the conclusion.
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, a row holding an array or
//!   a bare string, a document whose `widgets` is a number — every one of them reads as
//!   [`DEFAULT_LAYOUT`]. [`stored`] is therefore **infallible by signature** — it answers a
//!   [`HomeLayout`] and not a `Result`, which is [`crate::nav::nav_collapsed`]'s contract and not
//!   a shortcut. There is nothing the home page could do with an error here that is not just
//!   "draw the layout a first launch gets".
//! * **But an empty widget list is a layout, not a missing row.** A reader who removed every
//!   widget has made a choice, and handing them the defaults back on the next launch would
//!   undo it silently, every time, for ever. So only the *absence* of a row and a document that
//!   cannot be parsed are the default; `{"version":2,"widgets":[]}` is an answer and is kept.
//!   `an_empty_widget_list_is_a_layout_and_not_a_missing_row` is what pins that edge.
//! * **Writing validates the shape and never the vocabulary.** [`store`] refuses a `version` this
//!   build does not write, a blank `id` or `kind`, a footprint outside [`MAX_W`]×[`MAX_H`], a
//!   corner past [`MAX_X`]/[`MAX_Y`], a `span` outside [`MIN_SPAN`]`..=`[`MAX_SPAN`] and a document
//!   over [`MAX_BYTES`] — and refuses a *kind* never, because a kind it has never heard of is the
//!   case this module is built around rather than an error. Every refusal is a
//!   **sentence**: the reader is looking at a page they just rearranged, so the panel can say
//!   what did not land. **The refusal comes before the write**, so a refused document leaves the
//!   row exactly as it stood — the complement of the read rule, which would otherwise discard a
//!   layout that had looked saved.
//! * **A write preserves what this build does not understand**, [`crate::markcolors`]'s rule
//!   verbatim and the whole reason the vocabulary is not a Rust enum. A widget kind a newer build
//!   invented, and whatever it keeps in that widget's `config`, survives a round trip through
//!   this one — so an older build pointed at the same file rearranges the widgets it knows and
//!   does not quietly empty the row of the ones it does not. **The preservation is by *type*
//!   rather than by read-modify-write**, which is where it parts from `markcolors`: there the row
//!   holds one entry per mark and a write touches one key, here the caller hands over the whole
//!   document because the page that sends it is the page that just read it. What follows from
//!   that is the rule for extending a widget: **a new per-widget setting goes in `config`, never
//!   in a new field beside it** — `config` is opaque and survives, a new field on [`HomeWidget`]
//!   is dropped by every build that predates it. (Version 2's four geometry fields are that cost
//!   paid knowingly, once: a version-1 build drops them, which is why `span` rides along.)
//!
//! A future document is refused **in words** rather than downgraded. Reading one is a different
//! question from writing one and is answered the other way: [`stored`] hands back whatever parses,
//! version included, because the widgets in a newer document are exactly what an older build must
//! not lose — where writing at a version this build does not understand would mean rewriting a
//! document by rules that do not apply to it.
//!
//! # Version 2: a grid of cells, and the version-1 width kept beside it
//!
//! Version 1 was a flex-wrap row: each widget carried a `span` of 1 or 2 columns and its place
//! was its index. Version 2 places each widget at `x`,`y` with a `w`×`h` footprint, in cells.
//! **Two things about that move are load-bearing, and both are about builds other than this
//! one.**
//!
//! * **A version-1 row still reads.** The four geometry fields are `#[serde(default)]`, so a
//!   document with `span` and no `x` answers `0` for all four with its `span` kept — and the
//!   *webview* upgrades it (`layout.ts`'s `parseLayout` reads `w == 0` as "never placed" and lays
//!   the widget out from `span`). Rust does not do the upgrade because it cannot: where a widget
//!   lands depends on the footprints the widget registry gives each kind, and that registry is
//!   TypeScript's. `a_version_one_row_still_reads_with_its_widgets_and_spans` pins it.
//! * **`span` is still written, and read by nothing here.** An *older* build's `HomeWidget`
//!   requires the field, so a version-2 document without it would read as that build's default
//!   layout — and the reader's next Customize there would overwrite this build's page. With it,
//!   the old build draws the widgets in a row and refuses to save a version it does not write,
//!   which is the round trip this document has always promised. So it is `Option` here — absent is
//!   legal, since nothing in this build needs it — and bounded when present.
//!
//! **Rust knows nothing about how many columns a window has**, so the geometry is bounded by value
//! alone: the page's `normalise` is what brings a document inside the grid it is about to be drawn
//! on. The bounds exist to refuse nonsense — a `w` of zero is a widget nobody can see or grab, and
//! a `y` of four billion is a page the renderer would try to allocate rows for — not to encode a
//! layout rule.
//!
//! No migration: `app_meta` is schema v6's key/value table and this is a key in it. It is not in
//! [`crate::schema::SYNCED_TABLES`], so the layout is **this device's** — every stored preference
//! in this app is, and a home page is a thing about the screen in front of the reader rather than
//! about the collection.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta`.
pub const K_HOME_LAYOUT: &str = "home_layout";

/// The document version this build writes, and the only one [`store`] accepts.
///
/// `2` since the cell grid. A version-1 row still *reads* — see the module doc — and is refused
/// on *write*, because this build writes geometry and a version-1 reader would not know to keep it.
const VERSION: u8 = 2;

/// The widest a widget may be, in cells.
///
/// Wider than any grid the page draws today on purpose: how many columns a window has is the
/// page's question (`fit.ts`'s `columnsFor`) and changes with the window, so a bound tied to one
/// window would refuse a document another window drew legitimately. Twenty-four is a fence against
/// a runaway number, not a layout rule — the page's `normalise` clamps a widget into the grid it
/// is drawing.
pub const MAX_W: u32 = 24;

/// The tallest a widget may be, in cells. [`MAX_W`]'s argument, one axis over.
pub const MAX_H: u32 = 40;

/// The furthest right a widget's left edge may sit, in cells.
///
/// Far past any real window, for [`MAX_W`]'s reason — this refuses a coordinate that could only be
/// a bug, not a layout the reader could have dragged.
pub const MAX_X: u32 = 1000;

/// The furthest down a widget's top edge may sit, in cells.
///
/// Ten times [`MAX_X`] because a page grows downward and never sideways — a narrow window stacks
/// every widget into one long column — but still bounded, because the page sizes its grid from the
/// lowest row in use and a `y` of four billion would be a request for that many rows.
pub const MAX_Y: u32 = 10_000;

/// The narrowest a version-1 widget may be, in that version's columns.
pub const MIN_SPAN: u8 = 1;

/// The widest a version-1 widget may be, in that version's columns.
///
/// **Read by nothing in this build**: `span` is carried for an *older* build, whose flex-wrap row
/// had two columns and whose `home.rs` requires the field (see the module doc). So it is bounded
/// by what that build accepts, and only when present — writing a span an older build refuses to
/// parse would hand it the default layout, which is the failure the field exists to prevent.
pub const MAX_SPAN: u8 = 2;

/// The version-1 width a version-2 widget is written with — `layout.ts`'s `spanFor`, transcribed.
///
/// A widget wider than half of the narrowest grid the page draws (eight cells) takes the older
/// build's whole row; anything else takes one of its two columns. Used only to seed
/// [`DEFAULT_LAYOUT`]'s document: every later write carries the `span` the page computed.
fn legacy_span(w: u32) -> u8 {
    /// `layout.ts`'s `MIN_COLUMNS / 2`.
    const HALF_OF_THE_NARROWEST_GRID: u32 = 4;
    if w > HALF_OF_THE_NARROWEST_GRID {
        MAX_SPAN
    } else {
        MIN_SPAN
    }
}

/// The most a stored layout may serialize to, in bytes.
///
/// `app_meta` already holds a 201 550-byte row (`update_release_history`), so the cap is not
/// about what the table can take. It is about what a *layout* can honestly be: 64 KiB is orders
/// of magnitude more than a page of widgets and their settings, so anything over it is a `config`
/// being used as a document store or a bug minting widgets in a loop — neither of which should be
/// discovered as a database that will not fit in memory.
pub const MAX_BYTES: usize = 64 * 1024;

/// A blank id is a bug in the caller, not a widget — [`crate::markcolors`]'s `NO_KEY`.
const NO_ID: &str = "A widget needs an id, and this layout has one without.";

/// A blank kind is the same mistake one field along: the id says *which* widget and the kind says
/// *what it draws*, and a widget that draws nothing has nothing to be.
const NO_KIND: &str = "A widget needs a kind, and this layout has one without.";

/// The layout a database nobody has customised answers, as `(id, kind, x, y, w, h)` in order.
///
/// **A table of tuples rather than a `HomeLayout` constant, because a `Vec` and a `String`
/// cannot be built in a `const`** — `PREDEFINED_CATEGORIES` in [`crate::schema`] is the same
/// shape for the same reason. [`default_layout`] is what turns it into the document, and gives
/// every entry the `span` [`legacy_span`] reads off its `w`.
///
/// ⚠️ **This and `src/features/home/widgets.ts`'s `DEFAULT_LAYOUT` are one fact written in two
/// places, and this one is what a first launch actually gets** — [`stored`] answers it for a
/// missing row long before the webview has loaded that file. Changing one means changing the
/// other, id for id, kind for kind, cell for cell and in the same order;
/// `the_default_layout_is_the_documents_the_webview_seeds` pins this half against the literal
/// that file holds, and `widgets.test.ts` pins the other.
///
/// Eight columns is the narrowest grid the page draws, so a default that fits eight fits every
/// window: two half-width bands, three tall tiles, and a closing row of three, which fills the
/// eight-by-seven rectangle with no hole.
///
/// **These `kind` strings are TypeScript's vocabulary and this crate knows nothing about them.**
/// They are here as the seed a first launch gets and for no other purpose: nothing in this module
/// compares a stored kind against them, and adding a widget kind to the app changes this table
/// only if a fresh install should start with it.
///
/// The ids are the kinds because a default layout holds each widget once. A reader who adds a
/// second `decks` widget gets a minted id from the page — the id is what identifies a widget, and
/// two `decks` widgets pinning two sets of decks is a layout to build rather than a case to
/// refuse.
pub const DEFAULT_LAYOUT: [(&str, &str, u32, u32, u32, u32); 8] = [
    ("summary", "summary", 0, 0, 4, 2),
    ("recentCards", "recentCards", 4, 0, 4, 2),
    ("decks", "decks", 0, 2, 3, 3),
    ("activity", "activity", 3, 2, 3, 3),
    ("collectionValue", "collectionValue", 6, 2, 2, 3),
    ("folders", "folders", 0, 5, 4, 2),
    ("priceMovers", "priceMovers", 4, 5, 2, 2),
    ("setCompletion", "setCompletion", 6, 5, 2, 2),
];

/// How many widgets a reader who has never customised anything gets.
///
/// **Read off [`DEFAULT_LAYOUT`] rather than written down**, so the tests below name a number
/// that cannot drift away from the table it is about.
pub const DEFAULT_WIDGET_COUNT: usize = DEFAULT_LAYOUT.len();

/// One widget on the home page.
///
/// `kind` is a free string and `config` is opaque **on purpose** — see the module doc. `config`
/// carries `#[serde(default)]` so a widget written without one still parses: a kind that needs no
/// settings has nothing to put there, and a document missing the key is not a document to throw
/// away. The four geometry fields carry it for a different reason — a version-1 row has none of
/// them, and it must still read (see the module doc).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeWidget {
    /// Stable, minted when the widget is added. It is what identifies a widget, so a kind may
    /// appear more than once.
    pub id: String,
    /// What the widget draws. The vocabulary is TypeScript's.
    pub kind: String,
    /// The widget's left edge, in cells from the page's left. `0` on a version-1 row.
    #[serde(default)]
    pub x: u32,
    /// The widget's top edge, in cells from the page's top. `0` on a version-1 row.
    #[serde(default)]
    pub y: u32,
    /// How many cells wide, `1..=`[`MAX_W`] on a write. **`0` on a version-1 row**, which is how
    /// the webview's `parseLayout` knows the widget has never been placed.
    #[serde(default)]
    pub w: u32,
    /// How many cells tall, `1..=`[`MAX_H`] on a write. `0` on a version-1 row.
    #[serde(default)]
    pub h: u32,
    /// The version-1 width, [`MIN_SPAN`]`..=`[`MAX_SPAN`] when present. **Carried for an older
    /// build and read by nothing in this one** — see the module doc. Omitted from the JSON when
    /// absent rather than written as `null`, because an older build's `u8` would refuse a `null`
    /// exactly as it refuses a missing key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub span: Option<u8>,
    /// Per-kind settings, opaque to this crate.
    #[serde(default)]
    pub config: serde_json::Value,
}

/// The whole home page, as one `app_meta` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeLayout {
    /// The document version. [`store`] writes and accepts [`VERSION`] and nothing else; [`stored`]
    /// answers whatever parsed, a version-1 row included.
    pub version: u8,
    /// The widgets. **Empty is a layout**, not a missing row. Their order is no longer where they
    /// are drawn — `x` and `y` are — but it is kept as sent, so a page that reads it back gets the
    /// document it wrote.
    pub widgets: Vec<HomeWidget>,
}

/// [`DEFAULT_LAYOUT`] as a document.
fn default_layout() -> HomeLayout {
    HomeLayout {
        version: VERSION,
        widgets: DEFAULT_LAYOUT
            .iter()
            .map(|&(id, kind, x, y, w, h)| HomeWidget {
                id: id.to_owned(),
                kind: kind.to_owned(),
                x,
                y,
                w,
                h,
                span: Some(legacy_span(w)),
                config: serde_json::Value::Null,
            })
            .collect(),
    }
}

/// The reader's home page, or the default one.
///
/// Every failure collapses into [`DEFAULT_LAYOUT`], which is the read rule at its widest: no row
/// (a fresh install, and the common case), a row that is not JSON, a row holding an array or a
/// bare string, a document whose `widgets` is a number, a `version` that will not fit in a `u8`.
/// None of those is worth failing over and all of them mean one thing to the caller — nothing
/// usable has been stored, so draw the page a first launch draws.
///
/// **A parsed document is answered as it stands, `version` included.** A newer build's document
/// is readable rather than unreadable, and handing back the default instead would lose the
/// reader's widgets on any build that happened to be older than the one that wrote them. What
/// this build refuses to do with such a document is *write* it — see [`store`].
pub fn stored(conn: &Connection) -> HomeLayout {
    crate::app_meta::get_app_meta(conn, K_HOME_LAYOUT)
        .and_then(|raw| serde_json::from_str::<HomeLayout>(&raw).ok())
        .unwrap_or_else(default_layout)
}

/// Remember the reader's home page.
///
/// The refusals are the exact complement of [`stored`]'s silence: that one discards an unusable
/// document without a word, so without them a layout this build cannot read back would look
/// saved, survive a restart in the table, and read as the default for ever.
///
/// Validated in this order, first failure wins, and **all of it before [`crate::app_meta`] is
/// touched** so a refused write leaves the existing row exactly where it was:
///
/// 1. `version` is [`VERSION`]. A document from a future build is refused **in words** rather
///    than silently rewritten at a version this build understands — downgrading a document by
///    rules that do not apply to it is how a newer build's page comes back wrong with nothing
///    logged anywhere.
/// 2. Every `id` and `kind` is non-empty after `trim`. `"  "` is a blank, not a name.
/// 3. Every `w` is `1..=`[`MAX_W`] and every `h` is `1..=`[`MAX_H`]. **The low end is the one that
///    matters**: a zero-cell widget is one nobody can see, grab or remove, and it is also exactly
///    what a version-1 row reads as — so accepting one would let the page save an upgrade it had
///    not finished.
/// 4. Every `x` is at most [`MAX_X`] and every `y` at most [`MAX_Y`].
/// 5. Every `span` that is present is [`MIN_SPAN`]`..=`[`MAX_SPAN`]. An absent one is fine —
///    nothing in this build reads it.
/// 6. The serialized document is at most [`MAX_BYTES`].
///
/// **Nothing here looks at a `kind`'s spelling or at a `config`'s contents**, and nothing checks
/// that two widgets overlap or that a widget fits a window. The first is the split this module
/// exists for; the second is the page's, because only the page knows how many columns it has.
pub fn store(conn: &Connection, layout: &HomeLayout) -> Result<(), String> {
    if layout.version != VERSION {
        return Err(format!(
            "That home layout is version {}, and this app stores version {VERSION}. \
             Refusing it rather than rewriting it as something this build understands.",
            layout.version
        ));
    }
    for widget in &layout.widgets {
        if widget.id.trim().is_empty() {
            return Err(NO_ID.to_owned());
        }
        if widget.kind.trim().is_empty() {
            return Err(NO_KIND.to_owned());
        }
        if !(1..=MAX_W).contains(&widget.w) || !(1..=MAX_H).contains(&widget.h) {
            return Err(format!(
                "The widget \"{}\" asks to be {} by {} cells. A widget is 1 to {MAX_W} cells \
                 wide and 1 to {MAX_H} tall.",
                widget.id, widget.w, widget.h
            ));
        }
        if widget.x > MAX_X || widget.y > MAX_Y {
            return Err(format!(
                "The widget \"{}\" asks to sit at column {}, row {}. A widget starts no further \
                 than column {MAX_X} or row {MAX_Y}.",
                widget.id, widget.x, widget.y
            ));
        }
        if let Some(span) = widget.span {
            if !(MIN_SPAN..=MAX_SPAN).contains(&span) {
                return Err(format!(
                    "The widget \"{}\" carries an older layout width of {span}. That width is \
                     {MIN_SPAN} or {MAX_SPAN}.",
                    widget.id
                ));
            }
        }
    }
    let json =
        serde_json::to_string(layout).map_err(|e| format!("could not save the home page: {e}"))?;
    if json.len() > MAX_BYTES {
        return Err(format!(
            "That home layout is {} bytes and the most this app stores is {MAX_BYTES}.",
            json.len()
        ));
    }
    crate::app_meta::set_app_meta(conn, K_HOME_LAYOUT, &json)
        .map_err(|e| format!("could not save the home page: {e}"))
}

/// The reader's home page, or the default one.
///
/// **Infallible by signature**, [`crate::nav::nav_collapsed`]'s contract and for its reason: the
/// page reads this once at launch to seed a store that already holds a default of its own, and
/// there is nothing it could do with an error that is not just "draw the widgets you already
/// have".
///
/// `#[tauri::command(async)]` rather than a bare sync command, [`crate::nav::nav_collapsed`]'s
/// reason: a sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which
/// a search may hold for tens of milliseconds — and this is called while the window is drawing
/// its first frame.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn home_layout(state: tauri::State<'_, Arc<AppState>>) -> HomeLayout {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the reader's home page. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// **This refusal is worth surfacing**, [`crate::markcolors::set_mark_color`]'s reading rather
/// than [`crate::nav::set_nav_collapsed`]'s: the reader has just dragged a widget somewhere and
/// is looking at the result, so the page says the arrangement did not save rather than leaving
/// them to find out at the next launch.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_home_layout(
    state: tauri::State<'_, Arc<AppState>>,
    layout: HomeLayout,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &layout))
    })
    .await
    .map_err(|e| format!("the home page could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_meta::set_app_meta;

    /// The table this module's one row lives in, as `schema.rs` builds it — `app_meta.rs`'s own
    /// test helper. The whole schema is not needed: nothing here reads a second table.
    fn conn() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute(
            "CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
            [],
        )
        .unwrap();
        c
    }

    /// One widget at a given footprint, with everything else ordinary.
    fn widget(id: &str, kind: &str, x: u32, y: u32, w: u32, h: u32) -> HomeWidget {
        HomeWidget {
            id: id.into(),
            kind: kind.into(),
            x,
            y,
            w,
            h,
            span: Some(1),
            config: serde_json::Value::Null,
        }
    }

    /// A version-2 document holding exactly these widgets.
    fn layout(widgets: Vec<HomeWidget>) -> HomeLayout {
        HomeLayout {
            version: VERSION,
            widgets,
        }
    }

    /// The state every fresh install is in, so it is the one the fallback has to be right about.
    #[test]
    fn a_missing_row_reads_as_the_default_layout() {
        let c = conn();
        let back = stored(&c);
        assert_eq!(back.version, 2);
        assert_eq!(back.widgets.len(), DEFAULT_WIDGET_COUNT);
    }

    /// ⚠️ **The literal below is `src/features/home/widgets.ts`'s `DEFAULT_LAYOUT`, transcribed** —
    /// as JSON, because the webview compares the document and not the Rust table. The two are one
    /// fact in two places and this one is what a first launch gets, so if this goes red the
    /// question is which of the two moved, not how to make the assertion pass.
    #[test]
    fn the_default_layout_is_the_documents_the_webview_seeds() {
        let got = serde_json::to_value(default_layout()).unwrap();
        let want = serde_json::json!({
            "version": 2,
            "widgets": [
                { "id": "summary", "kind": "summary", "x": 0, "y": 0, "w": 4, "h": 2, "span": 1, "config": null },
                { "id": "recentCards", "kind": "recentCards", "x": 4, "y": 0, "w": 4, "h": 2, "span": 1, "config": null },
                { "id": "decks", "kind": "decks", "x": 0, "y": 2, "w": 3, "h": 3, "span": 1, "config": null },
                { "id": "activity", "kind": "activity", "x": 3, "y": 2, "w": 3, "h": 3, "span": 1, "config": null },
                { "id": "collectionValue", "kind": "collectionValue", "x": 6, "y": 2, "w": 2, "h": 3, "span": 1, "config": null },
                { "id": "folders", "kind": "folders", "x": 0, "y": 5, "w": 4, "h": 2, "span": 1, "config": null },
                { "id": "priceMovers", "kind": "priceMovers", "x": 4, "y": 5, "w": 2, "h": 2, "span": 1, "config": null },
                { "id": "setCompletion", "kind": "setCompletion", "x": 6, "y": 5, "w": 2, "h": 2, "span": 1, "config": null },
            ],
        });
        assert_eq!(got, want);
    }

    /// The default is a document this module would itself accept. A seed [`store`] refuses would
    /// be a first launch whose very first Customize could not save without the reader moving
    /// something first.
    #[test]
    fn the_default_layout_is_storable() {
        let c = conn();
        store(&c, &default_layout()).unwrap();
        assert_eq!(stored(&c), default_layout());
    }

    /// [`legacy_span`] is `layout.ts`'s `spanFor`: over half of eight takes the older build's
    /// whole row, anything else one of its two columns.
    #[test]
    fn the_legacy_span_is_the_webviews_rule() {
        assert_eq!(legacy_span(1), 1);
        assert_eq!(legacy_span(4), 1);
        assert_eq!(legacy_span(5), 2);
        assert_eq!(legacy_span(8), 2);
    }

    /// A row this build cannot make sense of costs the reader their arrangement and nothing else.
    /// Every one of these is what a hand-edit or a different build left behind, which no
    /// validation of ours was ever in a position to refuse — so each is written past [`store`].
    #[test]
    fn junk_reads_as_the_default_layout() {
        let c = conn();
        for junk in [
            "",
            "null",
            "[]",
            "\"a string\"",
            "{\"widgets\":7}",
            "{not json",
        ] {
            set_app_meta(&c, K_HOME_LAYOUT, junk).unwrap();
            assert_eq!(stored(&c).widgets.len(), DEFAULT_WIDGET_COUNT, "{junk}");
        }
    }

    /// **The rule the whole module is shaped around.** A widget kind a newer build invented, and
    /// whatever it keeps in that widget's `config`, comes back out of this build unharmed — which
    /// is what stops an older build quietly emptying the row of a newer one's page.
    ///
    /// Version 2 widens the promise to everything the page wrote: the geometry and the version-1
    /// `span` come back exactly as they went in, beside the unknown kind's `config`.
    #[test]
    fn a_kind_this_build_has_never_heard_of_survives_a_round_trip() {
        let c = conn();
        let sent = layout(vec![HomeWidget {
            id: "w1".into(),
            kind: "somethingFromTheFuture".into(),
            x: 5,
            y: 9,
            w: 6,
            h: 3,
            span: Some(2),
            config: serde_json::json!({ "keep": [1, 2, 3] }),
        }]);
        store(&c, &sent).unwrap();
        let back = stored(&c);
        assert_eq!(back, sent, "the whole document, geometry and span included");
        assert_eq!(back.widgets[0].kind, "somethingFromTheFuture");
        assert_eq!(back.widgets[0].config["keep"][2], 3);
    }

    /// **The upgrade's Rust half.** A version-1 row — `span`, no geometry — is exactly what every
    /// reader who customised their page before the grid has on disk, and reading it as the default
    /// would throw their arrangement away on the first launch of this build. It reads with its
    /// widgets, its spans and its configs, geometry `0`, version `1` — and the webview does the
    /// placing, because only the webview knows each kind's footprint.
    #[test]
    fn a_version_one_row_still_reads_with_its_widgets_and_spans() {
        let c = conn();
        set_app_meta(
            &c,
            K_HOME_LAYOUT,
            r#"{"version":1,"widgets":[
                {"id":"summary","kind":"summary","span":2,"config":null},
                {"id":"d1","kind":"decks","span":1,"config":{"deckIds":[4,7]}}
            ]}"#,
        )
        .unwrap();

        let back = stored(&c);
        assert_eq!(back.version, 1, "answered as it stands, version included");
        assert_eq!(back.widgets.len(), 2, "not the default layout");
        assert_eq!(back.widgets[0].id, "summary");
        assert_eq!(back.widgets[0].span, Some(2));
        assert_eq!(back.widgets[1].span, Some(1));
        assert_eq!(back.widgets[1].config["deckIds"][1], 7);
        for w in &back.widgets {
            assert_eq!(
                (w.x, w.y, w.w, w.h),
                (0, 0, 0, 0),
                "`{}` has never been placed",
                w.id
            );
        }
    }

    /// A version-2 widget without `span` is legal — nothing in this build reads it — and it goes
    /// back out without the key rather than with a `null` an older build's `u8` would refuse.
    #[test]
    fn an_absent_span_is_stored_and_written_without_the_key() {
        let c = conn();
        let mut w = widget("w1", "summary", 0, 0, 2, 2);
        w.span = None;
        store(&c, &layout(vec![w])).unwrap();
        let raw = crate::app_meta::get_app_meta(&c, K_HOME_LAYOUT).unwrap();
        assert!(!raw.contains("span"), "{raw}");
        assert_eq!(stored(&c).widgets[0].span, None);
    }

    /// A version this build does not write is refused, in both directions: a future document is
    /// not rewritten by rules that do not apply to it, and a version-1 document is not stored over
    /// a page this build has already placed on the grid.
    #[test]
    fn a_version_other_than_two_is_refused() {
        let c = conn();
        for version in [0, 1, 3] {
            let mut doc = layout(vec![widget("w1", "summary", 0, 0, 2, 2)]);
            doc.version = version;
            let err = store(&c, &doc).unwrap_err();
            assert!(err.contains(&format!("version {version}")), "{err}");
        }
        assert!(crate::app_meta::get_app_meta(&c, K_HOME_LAYOUT).is_none());
    }

    /// The shape half of the write rule, one refusal at a time — and **each leaves the stored row
    /// exactly as it was**, which is the assertion that makes the refusal worth having. A blank
    /// `id` cannot identify a widget, a blank `kind` cannot draw one, a zero footprint is a widget
    /// nobody can see or grab, a runaway one or a runaway corner is a bug, and a `span` an older
    /// build refuses to parse would hand that build the default layout.
    #[test]
    fn each_shape_refusal_is_a_sentence_and_leaves_the_row_alone() {
        let c = conn();
        let good = layout(vec![widget("keep", "summary", 1, 1, 2, 2)]);
        store(&c, &good).unwrap();

        let with_span = |span: u8| {
            let mut w = widget("w1", "summary", 0, 0, 2, 2);
            w.span = Some(span);
            w
        };
        let refused = [
            ("a blank id", widget("  ", "summary", 0, 0, 2, 2)),
            ("a blank kind", widget("w1", "", 0, 0, 2, 2)),
            ("a zero width", widget("w1", "summary", 0, 0, 0, 2)),
            (
                "a width past the cap",
                widget("w1", "summary", 0, 0, MAX_W + 1, 2),
            ),
            ("a zero height", widget("w1", "summary", 0, 0, 2, 0)),
            (
                "a height past the cap",
                widget("w1", "summary", 0, 0, 2, MAX_H + 1),
            ),
            (
                "a column past the cap",
                widget("w1", "summary", MAX_X + 1, 0, 2, 2),
            ),
            (
                "a row past the cap",
                widget("w1", "summary", 0, MAX_Y + 1, 2, 2),
            ),
            ("a span of zero", with_span(0)),
            ("a span of three", with_span(3)),
        ];
        for (what, bad) in refused {
            // Behind a good widget, so the check is of every entry and not only the first.
            let doc = layout(vec![widget("ok", "decks", 0, 0, 1, 1), bad]);
            let err = store(&c, &doc).expect_err(what);
            assert!(err.ends_with('.'), "{what} is refused in a sentence: {err}");
            assert_eq!(stored(&c), good, "{what} left the row alone");
        }

        // And the edges themselves are legal: the bounds are inclusive.
        let edges = layout(vec![
            widget("a", "summary", 0, 0, 1, 1),
            widget("b", "summary", MAX_X, MAX_Y, MAX_W, MAX_H),
        ]);
        store(&c, &edges).unwrap();
        assert_eq!(stored(&c), edges);
    }

    /// **The refusal happens before the write, and the second assertion is what says so.** A cap
    /// checked after `set_app_meta` would be a sentence on screen over a row that had already
    /// been replaced — the reader told their change did not save, and their previous page gone.
    #[test]
    fn a_document_over_the_cap_is_refused_and_the_row_is_left_alone() {
        let c = conn();
        store(&c, &layout(vec![])).unwrap();
        let fat = layout(
            (0..4000)
                .map(|i| HomeWidget {
                    config: serde_json::json!({ "pad": "x".repeat(64) }),
                    ..widget(&format!("w{i}"), "summary", 0, i, 1, 1)
                })
                .collect(),
        );
        assert!(store(&c, &fat).is_err());
        assert_eq!(
            stored(&c).widgets.len(),
            0,
            "the refused write left the row alone"
        );
    }

    /// **The read rule's edge, and the one a naive implementation gets wrong.** "No widgets" and
    /// "no row" are one value to a `unwrap_or_default`, so a reader who cleared their home page
    /// would be handed the defaults back on every launch, for ever, with nothing to show they had
    /// ever chosen. Only an *absent* row and an *unparseable* one are the default.
    #[test]
    fn an_empty_widget_list_is_a_layout_and_not_a_missing_row() {
        let c = conn();
        store(&c, &layout(vec![])).unwrap();
        assert_eq!(stored(&c).widgets.len(), 0);

        // A version-1 row that emptied the page is the same answer from an older build.
        set_app_meta(&c, K_HOME_LAYOUT, r#"{"version":1,"widgets":[]}"#).unwrap();
        assert_eq!(stored(&c).widgets.len(), 0);
    }
}
