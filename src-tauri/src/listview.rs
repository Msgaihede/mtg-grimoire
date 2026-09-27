//! How the reader has each wall of cards drawn — art or a table — the setting, and nothing else.
//!
//! **The pages are TypeScript's; the row is this crate's.** Which lists have a layout of their own,
//! what a fresh install opens on, and what either word does to the markup are all questions about
//! screens this crate never draws. All Rust owns is one `app_meta` row holding a JSON object of
//! section name → layout word, plus the two words that may go in it.
//!
//! That is [`crate::zoom`]'s split with the bound moved: there the frontend owns the ladder and
//! this crate knows only how far a number may stray, and here the frontend owns *which* walls
//! there are and this crate knows only the two words a wall may be in. The vocabulary is closed
//! and tiny — [`GRID`] and [`TABLE`] — so it is checked the way [`crate::card::store_group_by`]
//! checks a grouping rather than left open the way a section name is.
//!
//! Two rules shape it, and they are [`crate::zoom`]'s two:
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, a row holding an array, an
//!   entry whose value is a number, an entry holding a third word — every one of them reads as
//!   "nothing stored for that section", and a section with nothing stored opens on the frontend's
//!   own default. A preference that cannot be read is not worth refusing to draw a list over.
//! * **Writing validates.** [`store`] refuses a blank section and a word that is neither of the
//!   two, so the row cannot accumulate entries every later read would silently discard.
//!
//! **A write preserves entries this build does not understand**, [`crate::zoom`]'s rule verbatim
//! and for its reason: the row is read back as a raw `serde_json::Map` and only the section being
//! written is touched, so a build that learns a fifth wall does not have its row quietly emptied
//! by an older build pointed at the same `mtg.db`. Validation applies to what *this* call writes,
//! never to what it is writing beside.
//!
//! One row rather than one key per list, for [`crate::zoom`]'s reason: the frontend seeds every
//! section in a single pass at launch, so four keys would be four reads of one table to answer one
//! question.
//!
//! No migration: `app_meta` is schema v6's key/value table, and this is a key in it.

use crate::sync::AppState;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta` — a row in
/// that one the sync did not write makes every later timing claim a fiction (schema v6).
pub const K_LIST_VIEW: &str = "list_view";

/// A wall of art.
///
/// Named rather than inlined because [`stored`] and [`store`] have to agree on it character for
/// character: the read is an equality test with no parser behind it, so a second spelling
/// introduced at the write end would not fail anywhere — it would simply mean the reader's choice
/// never came back, on every launch, with nothing logged.
pub const GRID: &str = "grid";

/// A table of rows. See [`GRID`].
pub const TABLE: &str = "table";

/// The two layouts, in the order the refusal sentence lists them.
pub const LAYOUTS: [&str; 2] = [GRID, TABLE];

/// The whole of what this crate checks about a section name, and [`crate::zoom`]'s `NO_SECTION`
/// sentence one row over: the word itself is TypeScript's vocabulary, but an empty string is not a
/// list in any vocabulary — it is a bug in the caller, and storing it would put an entry in the
/// row that no reader could ever match a section against.
const NO_SECTION: &str = "A list section cannot be blank.";

/// Is this a layout this build draws?
pub fn is_layout(view: &str) -> bool {
    LAYOUTS.contains(&view)
}

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
///
/// Every failure collapses into an empty map, which is the read rule at its widest: no row, a row
/// that is not JSON, a row holding an array or a bare string. None of those is worth failing over,
/// and all of them mean one thing to a caller — nothing has been stored.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_LIST_VIEW)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Every list this database has a usable layout for.
///
/// **A section is absent rather than defaulted**, and the absence is the point: which layout a
/// fresh page opens on lives on the other side of the wire, so a default invented here would be a
/// second opinion about a choice `store.ts` already owns. An empty map is the honest answer for a
/// database nobody has switched, and it is what a fresh install returns.
///
/// Entries are dropped one at a time rather than the row as a whole, [`crate::zoom::stored`]'s
/// rule: a single hand-edited value costs that list its memory and leaves the others intact.
pub fn stored(conn: &Connection) -> BTreeMap<String, String> {
    stored_object(conn)
        .into_iter()
        .filter(|(section, _)| !section.is_empty())
        .filter_map(|(section, value)| {
            let view = value.as_str().filter(|v| is_layout(v))?;
            Some((section, view.to_owned()))
        })
        .collect()
}

/// Remember one list's layout, leaving every other entry in the row exactly as it was.
///
/// The refusals are the whole of the function, and they are the exact complement of [`stored`]'s
/// silence: that one discards an unusable entry without a word, so without them a typo'd layout
/// would look saved, survive a restart in the table, and read back as nothing forever.
pub fn store(conn: &Connection, section: &str, view: &str) -> Result<(), String> {
    if section.is_empty() {
        return Err(NO_SECTION.to_owned());
    }
    if !is_layout(view) {
        return Err(format!(
            "\"{view}\" is not a way this app draws a list. Expected one of: {}.",
            LAYOUTS.join(", ")
        ));
    }
    let mut views = stored_object(conn);
    // Read-modify-write over the *raw* map, so an entry a newer build wrote — a fifth wall, a
    // third layout — survives a write made beside it. See the module doc.
    views.insert(section.to_owned(), Value::from(view));
    let json = serde_json::to_string(&Value::Object(views))
        .map_err(|e| format!("could not save the list layout: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_LIST_VIEW, &json)
        .map_err(|e| format!("could not save the list layout: {e}"))
}

/// Every list's remembered layout, as section name → layout word.
///
/// **Infallible by signature**, [`crate::zoom::card_zoom`]'s contract and for its reason: the
/// frontend reads this once at launch to seed a store already built out of its own defaults, and
/// there is nothing a list could do with an error here that is not just "draw the layout you
/// already have".
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame.
#[tauri::command(async)]
pub fn list_view(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, String> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one list's layout. Rejects a blank section and a word that is not a layout, and
/// answers [`crate::db::BUSY`] if a sync holds the write connection — the bound every write
/// command in this crate takes.
///
/// **A refusal here is not worth surfacing**, [`crate::nav::set_nav_collapsed`]'s note and for its
/// reason: the frontend writes optimistically and keeps the reader's choice for the session either
/// way, so a BUSY during a first-run sync costs them nothing they can see now and only the next
/// launch's starting layout.
#[tauri::command]
pub async fn set_list_view(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    view: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, &view))
    })
    .await
    .map_err(|e| format!("the list layout could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The setting outlives the process, so the only thing that matters about it is that what went
    /// in comes back out — in both directions and repeatedly, because a reader flips this one far
    /// more often than they change a marketplace.
    #[test]
    fn both_layouts_round_trip() {
        let conn = db();
        for view in [GRID, TABLE, GRID, GRID, TABLE] {
            store(&conn, "collection", view).unwrap();
            assert_eq!(
                stored(&conn).get("collection").map(String::as_str),
                Some(view)
            );
        }
    }

    /// A database nobody has switched has nothing to say about any list. This is the state every
    /// fresh install is in, so it is the one the empty answer has to be right about — and it is
    /// what lets the frontend's own defaults stand rather than being overwritten by an opinion
    /// invented here.
    #[test]
    fn a_missing_row_remembers_nothing() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_LIST_VIEW), None);
        assert!(stored(&conn).is_empty());
    }

    /// **The rule a key-per-list implementation would not need and this one cannot do without.**
    /// Four lists share one row, so a write to any of them rewrites the whole document — and a
    /// build that dropped the entries it was not writing would cost the reader every other list's
    /// memory on the first press.
    #[test]
    fn a_write_keeps_every_other_section() {
        let conn = db();
        store(&conn, "search", TABLE).unwrap();
        store(&conn, "wishlist", GRID).unwrap();
        store(&conn, "collection", TABLE).unwrap();

        let all = stored(&conn);
        assert_eq!(all.get("search").map(String::as_str), Some(TABLE));
        assert_eq!(all.get("wishlist").map(String::as_str), Some(GRID));
        assert_eq!(all.get("collection").map(String::as_str), Some(TABLE));
    }

    /// An entry a *newer* build wrote survives a write this build makes beside it — the raw
    /// read-modify-write's whole purpose. Written past [`store`] deliberately: this build has no
    /// way to produce a fifth section, which is exactly why the case has to be built by hand.
    #[test]
    fn an_unknown_section_survives_a_write_beside_it() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_LIST_VIEW, r#"{"binders":"grid"}"#).unwrap();

        store(&conn, "collection", TABLE).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_LIST_VIEW).unwrap();
        let map: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            map.get("binders").and_then(Value::as_str),
            Some(GRID),
            "a section this build does not know must not be emptied by a write beside it"
        );
        // And this build still answers for the one it does know, without inventing the other.
        assert_eq!(
            stored(&conn).get("collection").map(String::as_str),
            Some(TABLE)
        );
    }

    /// A row this build cannot make sense of costs the reader their layout and nothing else.
    /// Written past [`store`] deliberately — every one of these is what a hand-edit or a different
    /// build left behind, which no validation of ours was ever in a position to refuse.
    #[test]
    fn an_unreadable_row_remembers_nothing_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "null",
            "\"grid\"",
            r#"{"collection":1}"#,
            r#"{"collection":"cards"}"#,
            r#"{"collection":null}"#,
            r#"{"":"grid"}"#,
            r#"{"collection":"Grid"}"#,
        ] {
            crate::app_meta::set_app_meta(&conn, K_LIST_VIEW, junk).unwrap();
            assert!(
                !stored(&conn).contains_key("collection"),
                "`{junk}` must read as nothing stored, not as a layout and not as a failure"
            );
        }
    }

    /// The complement of the read rule above: a word this build cannot draw is refused at the door
    /// rather than stored and silently discarded on the next launch. `"Grid"` is on the list
    /// because a case-folded match is the plausible slip, and the read is an equality test.
    #[test]
    fn a_layout_this_build_does_not_draw_is_refused() {
        let conn = db();
        for junk in ["", "Grid", "GRID", "cards", "list", "rows", " grid"] {
            assert!(
                store(&conn, "collection", junk).is_err(),
                "`{junk}` must be refused rather than stored"
            );
        }
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_LIST_VIEW), None);
    }

    /// A blank section is a bug in the caller, not a list. Refused for [`crate::zoom`]'s reason:
    /// stored, it would put an entry in the row no reader could ever match a section against.
    #[test]
    fn a_blank_section_is_refused() {
        let conn = db();
        assert_eq!(store(&conn, "", GRID).unwrap_err(), NO_SECTION);
    }

    /// A junk row is not sticky: the next write puts the setting back on its feet, so a reader who
    /// hits this never has to be told to clear anything.
    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_LIST_VIEW, "not json").unwrap();
        assert!(stored(&conn).is_empty());

        store(&conn, "collection", GRID).unwrap();
        assert_eq!(
            stored(&conn).get("collection").map(String::as_str),
            Some(GRID)
        );
    }
}
