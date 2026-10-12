//! How wide each of the app's docked side panels was last dragged — the setting, and nothing else.
//!
//! **This is [`crate::searchopen`] with a width where the `bool` is**, and every rule is that
//! module's: one `app_meta` row holding a JSON object of section name → width in CSS pixels, a
//! read that can never fail (junk is dropped per entry), a write that refuses a blank section, and
//! a read-modify-write over the raw map so an entry a newer build wrote survives. Which panels
//! exist and what width they open at are TypeScript's; this crate only bounds the number.
//!
//! **No legacy bridge and no migration**: nothing stored a width before this row.
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

/// The `app_meta` key.
pub const K_PANEL_WIDTH: &str = "panel_width";

/// The narrowest width a panel may be stored at. Below this a panel is not a panel; the frontend
/// clamps its drag well above it, so this only fences out a caller's bug.
pub const MIN_PANEL_WIDTH: u32 = 80;

/// The widest width a panel may be stored at — wider than any desk this app runs on.
pub const MAX_PANEL_WIDTH: u32 = 4000;

/// [`crate::searchopen`]'s sentence, for the same caller bug.
const NO_SECTION: &str = "A search section cannot be blank.";

/// The row as it stands, with nothing thrown away — the shape a write has to preserve. Every
/// failure collapses into an empty map.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_PANEL_WIDTH)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// One entry's width, or `None` for anything [`store`] could not have written: a non-integer, a
/// negative, a string, or a number outside `MIN_PANEL_WIDTH..=MAX_PANEL_WIDTH`.
fn usable(value: &Value) -> Option<u32> {
    let width = u32::try_from(value.as_u64()?).ok()?;
    (MIN_PANEL_WIDTH..=MAX_PANEL_WIDTH)
        .contains(&width)
        .then_some(width)
}

/// Every panel this database has a usable width for. A section is absent rather than defaulted —
/// the default width is the frontend's — and an unusable entry costs that section alone.
pub fn stored(conn: &Connection) -> BTreeMap<String, u32> {
    stored_object(conn)
        .into_iter()
        .filter(|(section, _)| !section.is_empty())
        .filter_map(|(section, value)| Some((section, usable(&value)?)))
        .collect()
}

/// Remember one panel's width, leaving every other entry in the row exactly as it was. Refuses a
/// blank section and a width outside `MIN_PANEL_WIDTH..=MAX_PANEL_WIDTH`, so nothing it writes is
/// something [`stored`] would drop.
pub fn store(conn: &Connection, section: &str, width: u32) -> Result<(), String> {
    if section.is_empty() {
        return Err(NO_SECTION.to_owned());
    }
    if !(MIN_PANEL_WIDTH..=MAX_PANEL_WIDTH).contains(&width) {
        return Err(out_of_range(width));
    }
    let mut panels = stored_object(conn);
    panels.insert(section.to_owned(), Value::from(width));
    let json = serde_json::to_string(&Value::Object(panels))
        .map_err(|e| format!("could not save the panel width: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_PANEL_WIDTH, &json)
        .map_err(|e| format!("could not save the panel width: {e}"))
}

/// The refusal for a width out of bounds.
fn out_of_range(width: u32) -> String {
    format!("A panel width must be between {MIN_PANEL_WIDTH} and {MAX_PANEL_WIDTH} pixels, not {width}.")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    #[test]
    fn a_width_round_trips() {
        let conn = db();
        for width in [320, MIN_PANEL_WIDTH, MAX_PANEL_WIDTH, 512] {
            store(&conn, "tags", width).unwrap();
            assert_eq!(stored(&conn).get("tags"), Some(&width));
        }
    }

    #[test]
    fn a_missing_row_remembers_nothing() {
        let conn = db();
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_PANEL_WIDTH), None);
        assert!(stored(&conn).is_empty());
    }

    #[test]
    fn each_section_is_remembered_on_its_own() {
        let conn = db();
        store(&conn, "tags", 300).unwrap();
        store(&conn, "deck", 420).unwrap();
        store(&conn, "tags", 360).unwrap();

        let all = stored(&conn);
        assert_eq!(all.get("tags"), Some(&360));
        assert_eq!(all.get("deck"), Some(&420));
        assert_eq!(all.len(), 2, "nothing invented for a panel nobody dragged");
    }

    /// An entry a newer build wrote — even one this build would not read — survives a write
    /// beside it.
    #[test]
    fn an_unknown_section_survives_a_write_beside_it() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_PANEL_WIDTH, r#"{"binders":{"w":300}}"#).unwrap();

        store(&conn, "tags", 300).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_PANEL_WIDTH).unwrap();
        let map: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(map.get("binders"), Some(&serde_json::json!({ "w": 300 })));
        assert_eq!(stored(&conn).get("tags"), Some(&300));
    }

    #[test]
    fn an_unreadable_row_remembers_nothing_rather_than_failing() {
        let conn = db();
        for junk in ["", "not json", "[]", "[300]", "null", "300", "\"tags\""] {
            crate::app_meta::set_app_meta(&conn, K_PANEL_WIDTH, junk).unwrap();
            assert!(
                stored(&conn).is_empty(),
                "`{junk}` must read as nothing stored"
            );
        }
        // And the next write puts it back on its feet.
        store(&conn, "tags", 300).unwrap();
        assert_eq!(stored(&conn).get("tags"), Some(&300));
    }

    /// One bad entry costs one section, not the row.
    #[test]
    fn a_junk_entry_is_dropped_and_its_neighbour_survives() {
        let conn = db();
        crate::app_meta::set_app_meta(
            &conn,
            K_PANEL_WIDTH,
            r#"{"a":"300","b":300.5,"c":-1,"d":null,"e":true,"f":79,"g":4001,"h":99999999999,"":300,"tags":320}"#,
        )
        .unwrap();

        let all = stored(&conn);
        assert_eq!(all.get("tags"), Some(&320));
        assert_eq!(all.len(), 1, "only the usable entry survives: {all:?}");
    }

    #[test]
    fn a_blank_section_is_refused() {
        let conn = db();
        assert_eq!(store(&conn, "", 300).unwrap_err(), NO_SECTION);
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_PANEL_WIDTH), None);
    }

    #[test]
    fn a_width_out_of_range_is_refused() {
        let conn = db();
        for width in [0, MIN_PANEL_WIDTH - 1, MAX_PANEL_WIDTH + 1, u32::MAX] {
            assert_eq!(
                store(&conn, "tags", width).unwrap_err(),
                out_of_range(width)
            );
        }
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_PANEL_WIDTH),
            None,
            "a refused write touches nothing"
        );
    }
}
