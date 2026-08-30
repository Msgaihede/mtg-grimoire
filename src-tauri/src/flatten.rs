//! Whether the reader has flattened each wall of cards — the filing ignored and every folder's
//! contents drawn at once — the setting, and nothing else.
//!
//! **The pages are TypeScript's; the row is this crate's.** Which lists have a Flatten switch at
//! all, what a flattened list does with the folder tree it is ignoring, and what a fresh install
//! opens on are all questions about screens this crate never draws. All Rust owns is one
//! `app_meta` row holding a JSON object of section name → whether that list is flattened.
//!
//! **This is [`crate::listview`] with a `bool` where the layout word is**, and every rule below is
//! that module's rather than a fresh argument:
//!
//! * **Reading can never fail**, [`crate::listview::stored`]'s rule at its widest. A missing row, a
//!   row that is not JSON, a row holding an array or a bare scalar, an entry whose value is a
//!   string or a number — every one of them reads as "nothing stored for that section", and a
//!   section with nothing stored opens on the frontend's own default. [`flatten_state`] is
//!   therefore infallible by signature.
//! * **Writing validates — and here there is only one thing left to validate.** [`store`] refuses
//!   a blank section, [`crate::listview::store`]'s first refusal; it has no second, because
//!   [`crate::listview`]'s other one polices a *vocabulary* and a `bool` has none. `serde` has
//!   already refused everything that is not `true` or `false` before this function is reached, and
//!   both of those are storable. **That asymmetry is the one place this module is simpler than the
//!   one it is ported from**, and it is [`crate::nav`]'s observation about the same type.
//! * **A write preserves entries this build does not understand**, [`crate::listview`]'s rule
//!   verbatim and for its reason: the row is read back as a raw `serde_json::Map` and only the
//!   section being written is touched, so a build that learns a third flattenable list does not
//!   have its row quietly emptied by an older build pointed at the same `mtg.db`.
//! * **One row rather than one key per list**, [`crate::listview`]'s reason: the frontend seeds
//!   every section in a single pass at launch, so a key each would be a read of that table each,
//!   to answer one question.
//! * **No migration**: `app_meta` is schema v6's key/value table, and this is a key in it.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta` — a row in
/// that one the sync did not write makes every later timing claim a fiction (schema v6).
pub const K_FLATTEN: &str = "flatten";

/// The whole of what this crate checks about a section name, and [`crate::listview`]'s
/// `NO_SECTION` sentence one row over: the word itself is TypeScript's vocabulary, but an empty
/// string is not a list in any vocabulary — it is a bug in the caller, and storing it would put an
/// entry in the row that no reader could ever match a section against.
const NO_SECTION: &str = "A flatten section cannot be blank.";

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
///
/// Every failure collapses into an empty map, which is the read rule at its widest: no row, a row
/// that is not JSON, a row holding an array or a bare `true`. None of those is worth failing over,
/// and all of them mean one thing to a caller — nothing has been stored.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_FLATTEN)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Every list this database has a usable Flatten state for.
///
/// **A section is absent rather than defaulted**, [`crate::listview::stored`]'s rule: whether a
/// fresh page opens flattened lives on the other side of the wire, so a `false` invented here
/// would be a second opinion about a choice the frontend's store already owns. An empty map is the
/// honest answer for a database nobody has flattened, and it is what a fresh install returns.
///
/// **`false` is not absence**, which is the one thing this reader has to keep straight that
/// [`crate::listview::stored`] never had to: a section that reads back `Some(false)` is a reader
/// who un-flattened a list, and a section that is missing is a reader who never touched it. They
/// are the same picture on screen only until the frontend's default is anything but `false`.
///
/// Entries are dropped one at a time rather than the row as a whole, [`crate::listview::stored`]'s
/// rule: a single hand-edited value costs that list its memory and leaves the others intact.
pub fn stored(conn: &Connection) -> BTreeMap<String, bool> {
    stored_object(conn)
        .into_iter()
        .filter(|(section, _)| !section.is_empty())
        .filter_map(|(section, value)| Some((section, value.as_bool()?)))
        .collect()
}

/// Remember whether one list is flattened, leaving every other entry in the row exactly as it was.
///
/// The blank-section refusal is the whole of the validation, and there is nothing beside it to
/// write: `Value::Bool` is the only thing a `bool` can serialise to, so unlike
/// [`crate::listview::store`] this function has no way to put an entry in the row that [`stored`]
/// would silently discard on the next launch.
///
/// **`false` writes an entry; it does not remove one.** A reader who flattens a list and then
/// un-flattens it has made a second choice and not withdrawn the first — [`crate::nav::store`]'s
/// `"0"` rule, in the shape an object row takes.
pub fn store(conn: &Connection, section: &str, flattened: bool) -> Result<(), String> {
    if section.is_empty() {
        return Err(NO_SECTION.to_owned());
    }
    let mut flags = stored_object(conn);
    // Read-modify-write over the *raw* map, so an entry a newer build wrote — a third flattenable
    // list — survives a write made beside it. See the module doc.
    flags.insert(section.to_owned(), Value::from(flattened));
    let json = serde_json::to_string(&Value::Object(flags))
        .map_err(|e| format!("could not save the flatten state: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_FLATTEN, &json)
        .map_err(|e| format!("could not save the flatten state: {e}"))
}

/// Every list's remembered Flatten state, as section name → flattened.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason: the
/// frontend reads this once at launch to seed a store already built out of its own defaults, and
/// there is nothing a list could do with an error here that is not just "draw the filing you
/// already have".
///
/// `#[tauri::command(async)]` rather than a bare sync command, [`crate::listview::list_view`]'s
/// reason: a sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which
/// a search may hold for tens of milliseconds — and this is called while the window is drawing its
/// first frame.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn flatten_state(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, bool> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember whether one list is flattened. Rejects a blank section, and answers
/// [`crate::db::BUSY`] if a sync holds the write connection — the bound every write command in
/// this crate takes.
///
/// **A refusal here is not worth surfacing**, [`crate::listview::set_list_view`]'s note and for its
/// reason: the frontend writes optimistically and keeps the reader's choice for the session either
/// way, so a BUSY during a first-run sync costs them nothing they can see now and only the next
/// launch's starting state.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_flatten_state(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    flattened: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, flattened))
    })
    .await
    .map_err(|e| format!("the flatten state could not be saved: {e}"))?
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
    fn both_states_round_trip() {
        let conn = db();
        for flattened in [true, false, true, true, false, false] {
            store(&conn, "collection", flattened).unwrap();
            assert_eq!(stored(&conn).get("collection"), Some(&flattened));
        }
    }

    /// A database nobody has flattened has nothing to say about any list. This is the state every
    /// fresh install is in, so it is the one the empty answer has to be right about — and it is
    /// what lets the frontend's own defaults stand rather than being overwritten by an opinion
    /// invented here.
    #[test]
    fn a_missing_row_remembers_nothing() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_FLATTEN), None);
        assert!(stored(&conn).is_empty());
    }

    /// The two lists are remembered independently, and **`false` is an answer rather than a
    /// silence**: the collection is flattened, the wishlist has been un-flattened, and both come
    /// back. The naive implementation — write on flatten, delete on un-flatten — reads identically
    /// on a fresh install and identically after a flatten, and fails only here.
    ///
    /// It is also [`crate::listview`]'s "a write keeps every other section": one row holds both, so
    /// a write to either rewrites the whole document.
    #[test]
    fn each_list_is_remembered_on_its_own() {
        let conn = db();
        store(&conn, "collection", true).unwrap();
        store(&conn, "wishlist", false).unwrap();

        let all = stored(&conn);
        assert_eq!(all.get("collection"), Some(&true));
        assert_eq!(
            all.get("wishlist"),
            Some(&false),
            "un-flattening stores `false`; it does not withdraw the entry"
        );
        assert_eq!(
            all.len(),
            2,
            "nothing was invented for a list nobody flipped"
        );
    }

    /// An entry a *newer* build wrote survives a write this build makes beside it — the raw
    /// read-modify-write's whole purpose. Written past [`store`] deliberately: this build has no
    /// way to produce a third section, which is exactly why the case has to be built by hand.
    #[test]
    fn an_unknown_section_survives_a_write_beside_it() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_FLATTEN, r#"{"binders":true}"#).unwrap();

        store(&conn, "collection", true).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_FLATTEN).unwrap();
        let map: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            map.get("binders").and_then(Value::as_bool),
            Some(true),
            "a section this build does not know must not be emptied by a write beside it"
        );
        // And this build still answers for the one it does know.
        assert_eq!(stored(&conn).get("collection"), Some(&true));
    }

    /// A row this build cannot make sense of costs the reader their Flatten state and nothing
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
            crate::app_meta::set_app_meta(&conn, K_FLATTEN, junk).unwrap();
            assert!(
                stored(&conn).is_empty(),
                "`{junk}` must read as nothing stored, not as a state and not as a failure"
            );
        }
    }

    /// **One bad entry costs one list, not the row.** This is what proves the skip is per-entry:
    /// a string, a number, a `null` and a blank key are each dropped while the valid sibling
    /// sitting beside them in the same row still comes back. `"true"` is the one to watch — a
    /// reader who is not `Value::as_bool` forgives it into a flatten nobody asked for.
    #[test]
    fn a_stringy_or_numeric_entry_is_dropped_and_its_neighbour_survives() {
        let conn = db();
        crate::app_meta::set_app_meta(
            &conn,
            K_FLATTEN,
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

    /// A blank section is a bug in the caller, not a list. Refused for [`crate::listview`]'s
    /// reason: stored, it would put an entry in the row no reader could ever match a section
    /// against. The wording is asserted because it is the only sentence this module can say.
    #[test]
    fn a_blank_section_is_refused() {
        let conn = db();
        assert_eq!(store(&conn, "", true).unwrap_err(), NO_SECTION);
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_FLATTEN),
            None,
            "a refused write touches nothing"
        );
    }

    /// A junk row is not sticky: the next write puts the setting back on its feet, so a reader who
    /// hits this never has to be told to clear anything.
    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_FLATTEN, "not json").unwrap();
        assert!(stored(&conn).is_empty());

        store(&conn, "collection", true).unwrap();
        assert_eq!(stored(&conn).get("collection"), Some(&true));
    }
}
