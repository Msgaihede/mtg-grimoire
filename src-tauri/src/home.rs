//! The home page's layout document — which widgets the reader has, in what order and how wide.
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
//!   widget has made a choice, and handing them the six defaults back on the next launch would
//!   undo it silently, every time, for ever. So only the *absence* of a row and a document that
//!   cannot be parsed are the default; `{"version":1,"widgets":[]}` is an answer and is kept.
//!   `an_empty_widget_list_is_a_layout_and_not_a_missing_row` is what pins that edge.
//! * **Writing validates the shape and never the vocabulary.** [`store`] refuses a `version` this
//!   build does not write, a blank `id` or `kind`, a `span` outside [`MIN_SPAN`]`..=`[`MAX_SPAN`]
//!   and a document over [`MAX_BYTES`] — and refuses a *kind* never, because a kind it has never
//!   heard of is the case this module is built around rather than an error. Every refusal is a
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
//!   in a new field beside it** — `config` is opaque and survives, a fifth field on
//!   [`HomeWidget`] is dropped by every build that predates it.
//!
//! A future document is refused **in words** rather than downgraded. Reading one is a different
//! question from writing one and is answered the other way: [`stored`] hands back whatever parses,
//! version included, because the widgets in a newer document are exactly what an older build must
//! not lose — where writing at a version this build does not understand would mean rewriting a
//! document by rules that do not apply to it.
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
const VERSION: u8 = 1;

/// The narrowest a widget may be, in grid columns.
pub const MIN_SPAN: u8 = 1;

/// The widest a widget may be, in grid columns.
///
/// Two is the whole grid — a `span: 2` widget is `basis-full` in the flex-wrap row the page draws
/// — so this is a fact about the *document* rather than a preference about layout, which is why
/// it is one of the four things [`store`] refuses.
pub const MAX_SPAN: u8 = 2;

/// The most a stored layout may serialize to, in bytes.
///
/// `app_meta` already holds a 201 550-byte row (`update_release_history`), so the cap is not
/// about what the table can take. It is about what a *layout* can honestly be: 64 KiB is orders
/// of magnitude more than six widgets and their settings, so anything over it is a `config` being
/// used as a document store or a bug minting widgets in a loop — neither of which should be
/// discovered as a database that will not fit in memory.
pub const MAX_BYTES: usize = 64 * 1024;

/// A blank id is a bug in the caller, not a widget — [`crate::markcolors`]'s `NO_KEY`.
const NO_ID: &str = "A widget needs an id, and this layout has one without.";

/// A blank kind is the same mistake one field along: the id says *which* widget and the kind says
/// *what it draws*, and a widget that draws nothing has nothing to be.
const NO_KIND: &str = "A widget needs a kind, and this layout has one without.";

/// The layout a database nobody has customised answers, as `(id, kind, span)` in order.
///
/// **A table of triples rather than a `HomeLayout` constant, because a `Vec` and a `String`
/// cannot be built in a `const`** — `PREDEFINED_CATEGORIES` in [`crate::schema`] is the same
/// shape for the same reason. [`default_layout`] is what turns it into the document.
///
/// **These `kind` strings are TypeScript's vocabulary and this crate knows nothing about them.**
/// They are here as the seed a first launch gets and for no other purpose: nothing in this module
/// compares a stored kind against them, and adding a seventh widget to the app changes this table
/// only if a fresh install should start with it.
///
/// The ids are the kinds because a default layout holds each widget once. A reader who adds a
/// second `decks` widget gets a minted id from the page — the id is what identifies a widget, and
/// two `decks` widgets pinning two sets of decks is a layout to build rather than a case to
/// refuse.
pub const DEFAULT_LAYOUT: [(&str, &str, u8); 6] = [
    ("summary", "summary", 2),
    ("decks", "decks", 1),
    ("activity", "activity", 1),
    ("collectionValue", "collectionValue", 1),
    ("wishlistValue", "wishlistValue", 1),
    ("folders", "folders", 2),
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
/// away.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeWidget {
    /// Stable, minted when the widget is added. It is what identifies a widget, so a kind may
    /// appear more than once.
    pub id: String,
    /// What the widget draws. The vocabulary is TypeScript's.
    pub kind: String,
    /// How many grid columns wide, [`MIN_SPAN`]`..=`[`MAX_SPAN`].
    pub span: u8,
    /// Per-kind settings, opaque to this crate.
    #[serde(default)]
    pub config: serde_json::Value,
}

/// The whole home page, as one `app_meta` row.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HomeLayout {
    /// The document version. [`store`] writes and accepts [`VERSION`] and nothing else.
    pub version: u8,
    /// The widgets, in the order they are drawn. **Empty is a layout**, not a missing row.
    pub widgets: Vec<HomeWidget>,
}

/// [`DEFAULT_LAYOUT`] as a document.
fn default_layout() -> HomeLayout {
    HomeLayout {
        version: VERSION,
        widgets: DEFAULT_LAYOUT
            .iter()
            .map(|(id, kind, span)| HomeWidget {
                id: (*id).to_owned(),
                kind: (*kind).to_owned(),
                span: *span,
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
/// 3. Every `span` is [`MIN_SPAN`]`..=`[`MAX_SPAN`].
/// 4. The serialized document is at most [`MAX_BYTES`].
///
/// **Nothing here looks at a `kind`'s spelling or at a `config`'s contents.** That is the split
/// this module exists for.
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
        if !(MIN_SPAN..=MAX_SPAN).contains(&widget.span) {
            return Err(format!(
                "The widget \"{}\" asks to be {} columns wide. A widget is {MIN_SPAN} or \
                 {MAX_SPAN}.",
                widget.id, widget.span
            ));
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

    /// The state every fresh install is in, so it is the one the fallback has to be right about.
    #[test]
    fn a_missing_row_reads_as_the_default_layout() {
        let c = conn();
        assert_eq!(stored(&c).widgets.len(), DEFAULT_WIDGET_COUNT);
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
    #[test]
    fn a_kind_this_build_has_never_heard_of_survives_a_round_trip() {
        let c = conn();
        let layout = HomeLayout {
            version: 1,
            widgets: vec![HomeWidget {
                id: "w1".into(),
                kind: "somethingFromTheFuture".into(),
                span: 2,
                config: serde_json::json!({ "keep": [1, 2, 3] }),
            }],
        };
        store(&c, &layout).unwrap();
        let back = stored(&c);
        assert_eq!(back.widgets[0].kind, "somethingFromTheFuture");
        assert_eq!(back.widgets[0].config["keep"][2], 3);
    }

    /// The shape half of the write rule. A blank `id` cannot identify a widget, a blank `kind`
    /// cannot draw one, and a span outside the grid is a width the page has no column for —
    /// stored, each would read back as a widget that cannot be shown and cannot be removed.
    #[test]
    fn a_blank_id_a_blank_kind_and_a_bad_span_are_each_refused() {
        let c = conn();
        let one = |id: &str, kind: &str, span: u8| HomeLayout {
            version: 1,
            widgets: vec![HomeWidget {
                id: id.into(),
                kind: kind.into(),
                span,
                config: serde_json::Value::Null,
            }],
        };
        assert!(store(&c, &one("", "summary", 1)).is_err());
        assert!(store(&c, &one("w1", "  ", 1)).is_err());
        assert!(store(&c, &one("w1", "summary", 0)).is_err());
        assert!(store(&c, &one("w1", "summary", 3)).is_err());
    }

    /// **The refusal happens before the write, and the second assertion is what says so.** A cap
    /// checked after `set_app_meta` would be a sentence on screen over a row that had already
    /// been replaced — the reader told their change did not save, and their previous page gone.
    #[test]
    fn a_document_over_the_cap_is_refused_and_the_row_is_left_alone() {
        let c = conn();
        let good = HomeLayout {
            version: 1,
            widgets: vec![],
        };
        store(&c, &good).unwrap();
        let fat = HomeLayout {
            version: 1,
            widgets: (0..4000)
                .map(|i| HomeWidget {
                    id: format!("w{i}"),
                    kind: "summary".into(),
                    span: 1,
                    config: serde_json::json!({ "pad": "x".repeat(64) }),
                })
                .collect(),
        };
        assert!(store(&c, &fat).is_err());
        assert_eq!(
            stored(&c).widgets.len(),
            0,
            "the refused write left the row alone"
        );
    }

    /// **The read rule's edge, and the one a naive implementation gets wrong.** "No widgets" and
    /// "no row" are one value to a `unwrap_or_default`, so a reader who cleared their home page
    /// would be handed the six defaults back on every launch, for ever, with nothing to show they
    /// had ever chosen. Only an *absent* row and an *unparseable* one are the default.
    #[test]
    fn an_empty_widget_list_is_a_layout_and_not_a_missing_row() {
        let c = conn();
        store(
            &c,
            &HomeLayout {
                version: 1,
                widgets: vec![],
            },
        )
        .unwrap();
        assert_eq!(stored(&c).widgets.len(), 0);
    }
}
