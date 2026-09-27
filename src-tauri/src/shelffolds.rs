//! Which shelves the reader folded away from their default, on the collection's wall and on the
//! wishlist's — the setting, and nothing else.
//!
//! **The shelves are TypeScript's; the row is this crate's.** Which folders a page draws as
//! shelves, what each starts as (deck groups, `Recently removed` and managed wishlist folders
//! start folded, everything else open) and what a fold hides are questions about a wall this
//! crate never draws — `src/lib/shelves.ts` answers them. All Rust owns is one `app_meta` row
//! holding, per page, a JSON object of folder id → folded, **for the folders the reader moved off
//! their default and no others** (spec §5.7).
//!
//! **This is [`crate::searchopen`] one level deeper**, and every rule is that module's:
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, a page that is not an
//!   object, an entry whose value is not a `bool` or whose key is not a folder id — each reads as
//!   "nothing folded" for that much and no more. [`shelf_folds`] is infallible by signature.
//! * **A write preserves what this build does not understand**: the row is read back as a raw
//!   `serde_json::Map` and only the page being written is touched, so a third page a newer build
//!   folds shelves on survives a write from an older one.
//! * **`None` takes an override back off** — [`crate::markcolors`]' reset. The absence *is* the
//!   default, so "back to the default" deletes the entry rather than storing the default's value,
//!   which would outlive a later change of what the default is.
//! * **A stale id is stored and answered, never pruned.** A folder deleted in another window or
//!   on another device leaves an entry behind; while no folder has that id the page ignores it
//!   (Review Focus 5), and pruning here would mean reading the folder tables, which this module
//!   has no reason to. **But the id can come back**: `collection_folders.id` and
//!   `wishlist_folders.id` are `INTEGER PRIMARY KEY` without `AUTOINCREMENT`, so SQLite hands the
//!   next folder `max(id) + 1`, which reuses a deleted highest id. A new folder would then inherit
//!   the deleted one's fold, so both pages clear any override stored under the id a create answers
//!   (final review R-M2), and a create whose id has nothing stored writes nothing here.
//! * **Two refusals, both sentences, and the whole change set is refused**: a page that is not one
//!   of [`PAGES`], and a key that is not a folder id — decimal digits, `0` for Not sorted.
//! * **Per device and never synced**: `app_meta` is on no capture spec. Each window reads the row
//!   once and writes it optimistically, so it is on `multi-window.md`'s per-window list.
//! * **No migration**: `app_meta` is schema v6's key/value table, and this is a key in it.

use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

/// The `app_meta` key.
pub const K_SHELF_FOLDS: &str = "shelf_folds";

/// The two pages that draw shelves, spelled as `ShelfFoldPage` in `src/lib/ipc.ts` spells them —
/// and as [`ShelfFolds`]' fields, which a test holds this list to.
pub const PAGES: [&str; 2] = ["collection", "wishlist"];

/// What [`store`] says to a page with no shelves on it.
pub const UNKNOWN_PAGE: &str =
    "Shelves are folded on the collection or the wishlist, and nowhere else.";

/// What [`store`] says to a key that is not a folder id.
pub const NOT_A_SHELF: &str = "A shelf is named by its folder id, or 0 for Not sorted.";

/// Every override, per page: folder id (decimal) → folded. Both pages are always present — an
/// empty map is a page on which the reader has moved nothing off its default.
#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct ShelfFolds {
    pub collection: BTreeMap<String, bool>,
    pub wishlist: BTreeMap<String, bool>,
}

/// A folder id as the page keys it: decimal digits, `0` being Not sorted. Nothing else can match
/// a shelf, so nothing else is stored or answered.
fn is_shelf(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_digit())
}

/// The row as it stands, with nothing thrown away — the shape a write has to preserve. Every
/// failure collapses into an empty map, [`crate::searchopen`]'s read rule at its widest.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_SHELF_FOLDS)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// One page's usable overrides. Entries are dropped one at a time, so a single hand-edited value
/// costs that shelf its memory and leaves its neighbours intact.
fn page_of(row: &Map<String, Value>, page: &str) -> BTreeMap<String, bool> {
    match row.get(page) {
        Some(Value::Object(entries)) => entries
            .iter()
            .filter(|(id, _)| is_shelf(id))
            .filter_map(|(id, value)| Some((id.clone(), value.as_bool()?)))
            .collect(),
        _ => BTreeMap::new(),
    }
}

/// Every override this database holds, on both pages.
pub fn stored(conn: &Connection) -> ShelfFolds {
    let row = stored_object(conn);
    ShelfFolds {
        collection: page_of(&row, "collection"),
        wishlist: page_of(&row, "wishlist"),
    }
}

/// Apply one page's changes: `Some(folded)` sets an override, `None` removes it. Every other page
/// in the row, and every entry this call does not name, is left exactly as it was.
///
/// Both refusals run before anything is read or written, and an empty change set writes nothing.
pub fn store(
    conn: &Connection,
    page: &str,
    changes: &HashMap<String, Option<bool>>,
) -> Result<(), String> {
    if !PAGES.contains(&page) {
        return Err(UNKNOWN_PAGE.to_owned());
    }
    if changes.keys().any(|id| !is_shelf(id)) {
        return Err(NOT_A_SHELF.to_owned());
    }
    if changes.is_empty() {
        return Ok(());
    }
    let mut row = stored_object(conn);
    let mut entries = row
        .get(page)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for (id, folded) in changes {
        match folded {
            Some(folded) => {
                entries.insert(id.clone(), Value::Bool(*folded));
            }
            None => {
                entries.remove(id);
            }
        }
    }
    row.insert(page.to_owned(), Value::Object(entries));
    let json = serde_json::to_string(&Value::Object(row))
        .map_err(|e| format!("could not save the folded shelves: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_SHELF_FOLDS, &json)
        .map_err(|e| format!("could not save the folded shelves: {e}"))
}

/// Every page's folded-shelf overrides. **Infallible by signature**, `search_open`'s contract: a
/// wall that cannot read the row draws every shelf at its default, which is what the frontend
/// does with an empty map anyway. `(async)` for `search_open`'s reason — it takes `db_read`'s
/// mutex while a window may be drawing its first frame.
#[tauri::command(async)]
pub fn shelf_folds(state: tauri::State<'_, Arc<AppState>>) -> ShelfFolds {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Set or remove folded-shelf overrides on one page. Refuses an unknown page and a key that is not
/// a folder id, and answers [`crate::db::BUSY`] while a sync holds the write connection — a refusal
/// the frontend swallows, `set_search_open`'s trade: the fold holds for this session either way.
#[tauri::command]
pub async fn set_shelf_folds(
    state: tauri::State<'_, Arc<AppState>>,
    page: String,
    changes: HashMap<String, Option<bool>>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &page, &changes))
    })
    .await
    .map_err(|e| format!("the folded shelves could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    fn changes(pairs: &[(&str, Option<bool>)]) -> HashMap<String, Option<bool>> {
        pairs
            .iter()
            .map(|(id, folded)| ((*id).to_owned(), *folded))
            .collect()
    }

    fn folded(pairs: &[(&str, bool)]) -> BTreeMap<String, bool> {
        pairs.iter().map(|(id, f)| ((*id).to_owned(), *f)).collect()
    }

    /// A fresh install has folded nothing, on either page — and both pages are in the answer,
    /// because `ShelfFolds` in `ipc.ts` is a `Record` over both.
    #[test]
    fn a_missing_row_folds_nothing_on_either_page() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_SHELF_FOLDS), None);
        assert_eq!(stored(&conn), ShelfFolds::default());
    }

    #[test]
    fn each_page_round_trips_on_its_own() {
        let conn = db();
        store(
            &conn,
            "collection",
            &changes(&[("12", Some(true)), ("0", Some(false))]),
        )
        .unwrap();
        store(&conn, "wishlist", &changes(&[("7", Some(true))])).unwrap();
        let folds = stored(&conn);
        assert_eq!(folds.collection, folded(&[("0", false), ("12", true)]));
        assert_eq!(folds.wishlist, folded(&[("7", true)]));
    }

    /// **`None` takes an override back off** — `markcolors`' reset: the absence *is* the default,
    /// so "back to the default" deletes the entry. A `None` for an id never stored is a no-op.
    #[test]
    fn none_takes_an_override_back_off_and_touches_nothing_else() {
        let conn = db();
        store(
            &conn,
            "collection",
            &changes(&[("12", Some(true)), ("13", Some(false))]),
        )
        .unwrap();
        store(
            &conn,
            "collection",
            &changes(&[("12", None), ("404", None)]),
        )
        .unwrap();
        assert_eq!(stored(&conn).collection, folded(&[("13", false)]));
    }

    /// **Review Focus 5**: an id whose folder was deleted — here one that never existed — is stored
    /// and answered. This module reads no folder table; the page ignores what nothing matches.
    #[test]
    fn a_stale_folder_id_is_stored_and_answered_rather_than_pruned() {
        let conn = db();
        store(&conn, "wishlist", &changes(&[("999", Some(true))])).unwrap();
        assert_eq!(stored(&conn).wishlist.get("999"), Some(&true));
    }

    #[test]
    fn an_unknown_page_is_refused_and_writes_nothing() {
        let conn = db();
        assert_eq!(
            store(&conn, "decks", &changes(&[("1", Some(true))])).unwrap_err(),
            UNKNOWN_PAGE
        );
        assert_eq!(store(&conn, "", &changes(&[])).unwrap_err(), UNKNOWN_PAGE);
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_SHELF_FOLDS), None);
    }

    /// A key that is not a folder id can match no shelf, so the whole change set is refused and
    /// nothing is half-written.
    #[test]
    fn a_key_that_is_not_a_folder_id_refuses_the_whole_change_set() {
        let conn = db();
        for bad in ["binder", "", "-1", "1.5", " 12"] {
            assert_eq!(
                store(
                    &conn,
                    "collection",
                    &changes(&[("12", Some(true)), (bad, Some(true))])
                )
                .unwrap_err(),
                NOT_A_SHELF,
                "`{bad}` is not a folder id"
            );
        }
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_SHELF_FOLDS), None);
    }

    #[test]
    fn an_empty_change_set_writes_nothing() {
        let conn = db();
        store(&conn, "collection", &HashMap::new()).unwrap();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_SHELF_FOLDS), None);
    }

    /// A row this build cannot read costs the reader their folds and nothing else.
    #[test]
    fn an_unreadable_row_folds_nothing_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "null",
            "true",
            r#"{"collection":[12]}"#,
            r#"{"collection":"12"}"#,
        ] {
            crate::app_meta::set_app_meta(&conn, K_SHELF_FOLDS, junk).unwrap();
            assert_eq!(
                stored(&conn),
                ShelfFolds::default(),
                "`{junk}` must read as nothing folded"
            );
        }
    }

    /// **One bad entry costs one shelf**: a string, a number, a word and a blank key are dropped
    /// while the valid neighbours in the same row survive.
    #[test]
    fn one_bad_entry_costs_one_shelf_and_its_neighbours_survive() {
        let conn = db();
        crate::app_meta::set_app_meta(
            &conn,
            K_SHELF_FOLDS,
            r#"{"collection":{"12":"true","13":1,"binder":true,"":false,"14":true},"wishlist":{"7":false}}"#,
        )
        .unwrap();
        let folds = stored(&conn);
        assert_eq!(folds.collection, folded(&[("14", true)]));
        assert_eq!(folds.wishlist, folded(&[("7", false)]));
    }

    /// A page a newer build folds shelves on survives a write from this one.
    #[test]
    fn a_write_keeps_a_page_this_build_does_not_know() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_SHELF_FOLDS, r#"{"decks":{"3":true}}"#).unwrap();
        store(&conn, "collection", &changes(&[("12", Some(true))])).unwrap();
        let raw = crate::app_meta::get_app_meta(&conn, K_SHELF_FOLDS).unwrap();
        let row: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(row.get("decks"), Some(&serde_json::json!({ "3": true })));
        assert_eq!(stored(&conn).collection, folded(&[("12", true)]));
    }

    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_SHELF_FOLDS, "not json").unwrap();
        store(&conn, "wishlist", &changes(&[("7", Some(true))])).unwrap();
        assert_eq!(stored(&conn).wishlist, folded(&[("7", true)]));
    }

    /// The wire: the two page names `ShelfFoldPage` spells, both always present, and a `null` in
    /// the change set arriving as `None` — which is what Tauri's deserializer hands
    /// `set_shelf_folds`.
    #[test]
    fn the_folds_cross_the_wire_under_the_names_the_page_uses() {
        let folds = ShelfFolds {
            collection: folded(&[("12", true)]),
            wishlist: BTreeMap::new(),
        };
        assert_eq!(
            serde_json::to_value(&folds).unwrap(),
            serde_json::json!({ "collection": { "12": true }, "wishlist": {} })
        );
        let keys: Vec<String> = serde_json::to_value(ShelfFolds::default())
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        assert_eq!(keys, PAGES, "PAGES is the struct's own field list");

        let parsed: HashMap<String, Option<bool>> =
            serde_json::from_str(r#"{"12":true,"7":null}"#).unwrap();
        assert_eq!(parsed, changes(&[("12", Some(true)), ("7", None)]));
    }
}
