//! Whether each of the app's docked card-search columns was last left open — the setting, and
//! nothing else.
//!
//! **The columns are TypeScript's; the row is this crate's.** Which pages have a search column at
//! all, what one draws when it is open, and what a fresh install opens on are all questions about
//! screens this crate never draws. All Rust owns is one `app_meta` row holding a JSON object of
//! section name → whether that column is open.
//!
//! **This is [`crate::flatten`] with a different key**, which is itself [`crate::listview`] with a
//! `bool` where the layout word is. Every rule below is those modules' rather than a fresh
//! argument:
//!
//! * **Reading can never fail**, [`crate::listview::stored`]'s rule at its widest. A missing row, a
//!   row that is not JSON, a row holding an array or a bare scalar, an entry whose value is a
//!   string or a number — every one of them reads as "nothing stored for that section", and a
//!   section with nothing stored opens on the frontend's own default. [`search_open`] is therefore
//!   infallible by signature.
//! * **Writing validates — and here there is only one thing left to validate.** [`store`] refuses
//!   a blank section, [`crate::listview::store`]'s first refusal; it has no second, because
//!   [`crate::listview`]'s other one polices a *vocabulary* and a `bool` has none. `serde` has
//!   already refused everything that is not `true` or `false` before this function is reached, and
//!   both of those are storable — [`crate::flatten`]'s observation about the same type.
//! * **A write preserves entries this build does not understand**, [`crate::listview`]'s rule
//!   verbatim and for its reason: the row is read back as a raw `serde_json::Map` and only the
//!   section being written is touched, so a build that learns a fourth searchable page does not
//!   have its row quietly emptied by an older build pointed at the same database.
//! * **One row rather than one key per column**, [`crate::listview`]'s reason and the whole reason
//!   this module exists: `deck_search_open` was a key, a default, two functions and two commands
//!   for one boolean, and three columns asking the same question that way would have been three
//!   rows, six commands, three query keys and three prefetches for one fact.
//! * **No migration**: `app_meta` is schema v6's key/value table, and this is a key in it.
//!
//! **The old `deck_search_open` row is carried across by the read rather than by a rung** — see
//! [`stored`]. The row itself is left where it is: the one precedent for deleting an orphaned
//! `app_meta` key (v25's `deck_driven_collection`) was a passenger on a rung already doing
//! structural work, and a standalone `DELETE FROM app_meta` rung has no precedent here.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta` — a row in
/// that one the sync did not write makes every later timing claim a fiction (schema v6).
pub const K_SEARCH_OPEN: &str = "search_open";

/// The key this module replaced: `deck.rs`'s own row, holding `"1"`/`"0"` for the deck editor's
/// column alone. Read by [`stored`] and written by nothing, which is what makes the bridge decay.
const K_LEGACY_DECK: &str = "deck_search_open";

/// The section the legacy row was about. TypeScript's word for the deck editor's column, and the
/// only section name this crate names at all — every other one arrives as a parameter.
const LEGACY_SECTION: &str = "deck";

/// The whole of what this crate checks about a section name, and [`crate::listview`]'s
/// `NO_SECTION` sentence two rows over: the word itself is TypeScript's vocabulary, but an empty
/// string is not a column in any vocabulary — it is a bug in the caller, and storing it would put
/// an entry in the row that no reader could ever match a section against.
const NO_SECTION: &str = "A search section cannot be blank.";

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
///
/// Every failure collapses into an empty map, which is the read rule at its widest: no row, a row
/// that is not JSON, a row holding an array or a bare `true`. None of those is worth failing over,
/// and all of them mean one thing to a caller — nothing has been stored.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_SEARCH_OPEN)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Every column this database has a usable open/shut state for.
///
/// **A section is absent rather than defaulted**, [`crate::listview::stored`]'s rule: whether a
/// fresh page opens with its column drawn lives on the other side of the wire, so a `false`
/// invented here would be a second opinion about a choice the frontend's own defaults already own.
/// An empty map is the honest answer for a database nobody has pressed a disclosure in, and it is
/// what a fresh install returns.
///
/// **`false` is not absence**, [`crate::flatten::stored`]'s distinction: a section that reads back
/// `Some(false)` is a reader who shut a column, and a section that is missing is a reader who
/// never touched it. They are the same picture on screen only until the frontend's default is
/// anything but `false` — and all three of its defaults are `true`.
///
/// Entries are dropped one at a time rather than the row as a whole, [`crate::listview::stored`]'s
/// rule: a single hand-edited value costs that column its memory and leaves the others intact.
///
/// **The one thing here that is not [`crate::flatten`]'s: the legacy bridge.** Before this module
/// there was `deck.rs`'s `deck_search_open` row, holding `"1"`/`"0"` for the deck editor's column.
/// A map with no `"deck"` entry falls back to it, so a reader who shut that column before
/// upgrading finds it still shut. Anything but those two spellings — a missing row, a hand-edit,
/// `"true"` — inserts nothing and lets the frontend's default stand, which is exactly what the
/// function it replaced did with the same values.
///
/// **It decays on its own and needs no rung.** Nothing writes the legacy row any more, so the
/// first press of the deck editor's disclosure stores a `"deck"` entry in the map and this
/// fallback is never consulted on that database again. A map entry always wins: it is this
/// build's answer, and the legacy row is a fossil of the last press an older build saw.
pub fn stored(conn: &Connection) -> BTreeMap<String, bool> {
    let mut open: BTreeMap<String, bool> = stored_object(conn)
        .into_iter()
        .filter(|(section, _)| !section.is_empty())
        .filter_map(|(section, value)| Some((section, value.as_bool()?)))
        .collect();

    if !open.contains_key(LEGACY_SECTION) {
        match crate::app_meta::get_app_meta(conn, K_LEGACY_DECK).as_deref() {
            Some("1") => {
                open.insert(LEGACY_SECTION.to_owned(), true);
            }
            Some("0") => {
                open.insert(LEGACY_SECTION.to_owned(), false);
            }
            _ => {}
        }
    }

    open
}

/// Remember whether one column is open, leaving every other entry in the row exactly as it was.
///
/// The blank-section refusal is the whole of the validation, and there is nothing beside it to
/// write: `Value::Bool` is the only thing a `bool` can serialise to, so unlike
/// [`crate::listview::store`] this function has no way to put an entry in the row that [`stored`]
/// would silently discard on the next launch.
///
/// **`false` writes an entry; it does not remove one.** A reader who shuts a column has made a
/// second choice and not withdrawn the first — [`crate::nav::store`]'s `"0"` rule, in the shape an
/// object row takes. It is also what retires the legacy row for the deck section: an entry of
/// either value is what [`stored`]'s bridge stands down for.
pub fn store(conn: &Connection, section: &str, open: bool) -> Result<(), String> {
    if section.is_empty() {
        return Err(NO_SECTION.to_owned());
    }
    let mut columns = stored_object(conn);
    // Read-modify-write over the *raw* map, so an entry a newer build wrote — a fourth searchable
    // page — survives a write made beside it. See the module doc.
    columns.insert(section.to_owned(), Value::from(open));
    let json = serde_json::to_string(&Value::Object(columns))
        .map_err(|e| format!("could not save the search column state: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_SEARCH_OPEN, &json)
        .map_err(|e| format!("could not save the search column state: {e}"))
}

/// Every column's remembered state, as section name → open.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason: the
/// frontend reads this once at launch to seed a store already built out of its own defaults, and
/// there is nothing a page could do with an error here that is not just "draw the column the way
/// you already would have".
///
/// **Read once at launch and not by the panel**, which is a measurement rather than tidiness:
/// asked by the panel instead, the read queues behind the page's own query and lands ~700 ms after
/// the column has already been drawn the other way round — which is how a reader who had shut it
/// watched it thrown open and yanked closed on every deck they opened.
///
/// `#[tauri::command(async)]` rather than a bare sync command, [`crate::listview::list_view`]'s
/// reason: a sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which
/// a search may hold for tens of milliseconds — and this is called while the window is drawing its
/// first frame.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn search_open(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, bool> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember whether one column is open. Rejects a blank section, and answers [`crate::db::BUSY`]
/// if a sync holds the write connection — the bound every write command in this crate takes.
///
/// **A refusal here is not worth surfacing**, [`crate::listview::set_list_view`]'s note and for its
/// reason: the frontend writes optimistically and keeps the reader's choice for the session either
/// way, so a BUSY during a first-run sync costs them nothing they can see now and only the next
/// launch's starting state.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_search_open(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    open: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, open))
    })
    .await
    .map_err(|e| format!("the search column state could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The setting outlives the process, so the only thing that matters about it is that what went
    /// in comes back out — in both directions and repeatedly, because a reader presses a
    /// disclosure far more often than they change a marketplace.
    #[test]
    fn both_states_round_trip() {
        let conn = db();
        for open in [true, false, true, true, false, false] {
            store(&conn, "collection", open).unwrap();
            assert_eq!(stored(&conn).get("collection"), Some(&open));
        }
    }

    /// A database nobody has pressed a disclosure in has nothing to say about any column. This is
    /// the state every fresh install is in, so it is the one the empty answer has to be right
    /// about — and it is what lets the frontend's own defaults stand rather than being overwritten
    /// by an opinion invented here.
    #[test]
    fn a_missing_row_remembers_nothing() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_SEARCH_OPEN), None);
        assert!(stored(&conn).is_empty());
    }

    /// The three columns are remembered independently, and **`false` is an answer rather than a
    /// silence**: the collection's column is open, the wishlist's has been shut, and both come
    /// back. The naive implementation — write on open, delete on shut — reads identically on a
    /// fresh install and identically after an open, and fails only here.
    ///
    /// It is also [`crate::listview`]'s "a write keeps every other section": one row holds all
    /// three, so a write to any of them rewrites the whole document.
    #[test]
    fn each_section_is_remembered_on_its_own() {
        let conn = db();
        store(&conn, "collection", true).unwrap();
        store(&conn, "wishlist", false).unwrap();

        let all = stored(&conn);
        assert_eq!(all.get("collection"), Some(&true));
        assert_eq!(
            all.get("wishlist"),
            Some(&false),
            "shutting a column stores `false`; it does not withdraw the entry"
        );
        assert_eq!(
            all.len(),
            2,
            "nothing was invented for a column nobody pressed"
        );
    }

    /// An entry a *newer* build wrote survives a write this build makes beside it — the raw
    /// read-modify-write's whole purpose. Written past [`store`] deliberately: this build has no
    /// way to produce a fourth section, which is exactly why the case has to be built by hand.
    #[test]
    fn an_unknown_section_survives_a_write_beside_it() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_SEARCH_OPEN, r#"{"binders":true}"#).unwrap();

        store(&conn, "collection", true).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_SEARCH_OPEN).unwrap();
        let map: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            map.get("binders").and_then(Value::as_bool),
            Some(true),
            "a section this build does not know must not be emptied by a write beside it"
        );
        // And this build still answers for the one it does know.
        assert_eq!(stored(&conn).get("collection"), Some(&true));
    }

    /// A row this build cannot make sense of costs the reader their column states and nothing
    /// else. Written past [`store`] deliberately — every one of these is what a hand-edit or a
    /// different build left behind, which no validation of ours was ever in a position to refuse.
    /// `"true"` and `"1"` are on the list because a bare bool at the top of the row is the
    /// plausible slip once the value type is a bool, and it is still not an object.
    #[test]
    fn an_unreadable_row_remembers_nothing_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "[true]",
            "null",
            "true",
            "1",
            "\"collection\"",
        ] {
            crate::app_meta::set_app_meta(&conn, K_SEARCH_OPEN, junk).unwrap();
            assert!(
                stored(&conn).is_empty(),
                "`{junk}` must read as nothing stored, not as a state and not as a failure"
            );
        }
    }

    /// **One bad entry costs one column, not the row.** This is what proves the skip is per-entry:
    /// a string, a number, a `null` and a blank key are each dropped while the valid sibling
    /// sitting beside them in the same row still comes back. `"true"` is the one to watch — a
    /// reader who is not `Value::as_bool` forgives it into a column nobody asked to be open.
    #[test]
    fn a_stringy_or_numeric_entry_is_dropped_and_its_neighbour_survives() {
        let conn = db();
        crate::app_meta::set_app_meta(
            &conn,
            K_SEARCH_OPEN,
            r#"{"collection":"true","tags":1,"decks":null,"":true,"wishlist":true}"#,
        )
        .unwrap();

        let all = stored(&conn);
        assert_eq!(
            all.get("wishlist"),
            Some(&true),
            "the valid sibling in the same row survives its neighbours"
        );
        assert_eq!(
            all.get("collection"),
            None,
            "`\"true\"` is a string, not a state"
        );
        assert_eq!(all.get("tags"), None, "`1` is a number, not a state");
        assert_eq!(all.get("decks"), None);
        assert!(!all.contains_key(""), "a blank key can match no section");
        assert_eq!(all.len(), 1, "only the usable entry survives: {all:?}");
    }

    /// A blank section is a bug in the caller, not a column. Refused for [`crate::listview`]'s
    /// reason: stored, it would put an entry in the row no reader could ever match a section
    /// against. The wording is asserted because it is the only sentence this module can say.
    #[test]
    fn a_blank_section_is_refused() {
        let conn = db();
        assert_eq!(store(&conn, "", true).unwrap_err(), NO_SECTION);
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_SEARCH_OPEN),
            None,
            "a refused write touches nothing"
        );
    }

    /// A junk row is not sticky: the next write puts the setting back on its feet, so a reader who
    /// hits this never has to be told to clear anything.
    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_SEARCH_OPEN, "not json").unwrap();
        assert!(stored(&conn).is_empty());

        store(&conn, "collection", true).unwrap();
        assert_eq!(stored(&conn).get("collection"), Some(&true));
    }

    /// **The upgrade case.** Every database that has ever had this app's deck editor open is in
    /// this state on the launch after the upgrade: a `deck_search_open` row and no map at all. A
    /// reader who shut that column finds it still shut, which is the whole of what the bridge
    /// buys. Both spellings are checked, because `"1"` and `"0"` are the only two the row the
    /// bridge reads was ever written with.
    #[test]
    fn a_database_with_only_the_old_row_answers_for_the_deck_section() {
        for (legacy, expected) in [("0", false), ("1", true)] {
            let conn = db();
            crate::app_meta::set_app_meta(&conn, K_LEGACY_DECK, legacy).unwrap();

            let all = stored(&conn);
            assert_eq!(
                all.get(LEGACY_SECTION),
                Some(&expected),
                "`{legacy}` in the old row is the deck column's answer until the map has one"
            );
            assert_eq!(all.len(), 1, "the bridge answers for one section: {all:?}");
        }
    }

    /// Anything the old row can hold that is not one of its two spellings inserts **nothing**,
    /// rather than guessing — which is what the function this replaced did with the same values,
    /// and it leaves the frontend's own default standing. `"true"` is the spelling a reader
    /// hand-editing the table would reach for first.
    #[test]
    fn an_unreadable_old_row_bridges_nothing() {
        for legacy in ["true", "false", "", "yes", "2"] {
            let conn = db();
            crate::app_meta::set_app_meta(&conn, K_LEGACY_DECK, legacy).unwrap();
            assert!(
                stored(&conn).is_empty(),
                "`{legacy}` is not one of the two spellings the old row was ever written with"
            );
        }
    }

    /// **The map wins, and that is what makes the bridge decay.** Once the reader presses the deck
    /// editor's disclosure, the map carries a `"deck"` entry and the fossil is never consulted on
    /// this database again. Written with the two disagreeing on purpose: if the fallback ran
    /// unconditionally, or ran last, this reads `false` and the press the reader just made is
    /// undone on the next launch.
    #[test]
    fn a_map_with_a_deck_entry_ignores_the_old_row() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_LEGACY_DECK, "0").unwrap();
        store(&conn, LEGACY_SECTION, true).unwrap();

        assert_eq!(
            stored(&conn).get(LEGACY_SECTION),
            Some(&true),
            "the map is this build's answer; the old row is a fossil of an older build's"
        );
    }

    /// A `false` in the map is an *entry*, so it stands down the bridge exactly as a `true` does.
    /// This is [`each_section_is_remembered_on_its_own`]'s "`false` is not absence" read against
    /// the one section that has a second place to look — a `contains_key` written as a truthiness
    /// check passes every other test in this file and fails only here.
    #[test]
    fn a_stored_false_stands_the_old_row_down_too() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_LEGACY_DECK, "1").unwrap();
        store(&conn, LEGACY_SECTION, false).unwrap();

        assert_eq!(
            stored(&conn).get(LEGACY_SECTION),
            Some(&false),
            "a stored `false` is an answer, not a gap for the old row to fill"
        );
    }
}
