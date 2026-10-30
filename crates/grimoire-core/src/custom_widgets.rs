//! The reader's own home-page widgets — each a name, a GraphQL query over the read graph
//! (`crates/grimoire-graph`) and a json-render spec that draws its answer. User schema v68.
//!
//! [`crate::sticky_notes`]' file shape: pure functions over a [`Connection`] first, the command
//! table's entries calling them, the tests at the foot. The page lists these definitions in its
//! *Custom widgets* dialog and places one on the home layout as a widget of kind `custom` whose
//! `config` is `{ widgetId }` — [`crate::home`] stores that entry like any other and knows nothing
//! about this table.
//!
//! # Device-local, and in the full export
//!
//! **Not synced** (the owner's decision): no `sync_uid` column, no capture spec, absent from
//! [`crate::schema::SYNCED_TABLES`]. A definition is the reader's own work and nothing rebuilds
//! it, so it is on the user side of [`crate::schema::TABLES`] — which is what puts it in the full
//! export, since [`crate::archive`] carries every user table but sync's own.
//!
//! # The shape, never the vocabulary
//!
//! [`crate::home`]'s rule one table over. This module refuses a blank name, an over-long one, a
//! blank or over-long query, a spec that is not `{ root, elements }` or is too large, and a
//! footprint outside [`W`]×[`H`] — **and never looks at a component's name, a prop, or whether the
//! query is valid GraphQL**. The catalogue a spec is drawn from is TypeScript's
//! (`packages/ui/features/home/generated/`), and the graph is another crate's; a check of either
//! here would be a second copy that drifts. The desktop's MCP tool `widget_create` checks both
//! before it calls in, because an agent writes these without a page to show it a broken one.
//!
//! Every refusal is a **sentence**, and **it comes before the write**: a refused definition leaves
//! the table exactly as it stood.
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::ops::RangeInclusive;

/// The longest name, in characters, after trimming. It titles a widget and a row of the dialog.
pub const MAX_NAME_CHARS: usize = 80;
/// The longest description, in characters.
pub const MAX_DESCRIPTION_CHARS: usize = 500;
/// The largest query, in bytes as written. A widget's query is a few hundred.
pub const MAX_QUERY_BYTES: usize = 20_000;
/// The largest spec, in bytes as serialized.
pub const MAX_SPEC_BYTES: usize = 200_000;
/// How many grid cells wide a custom widget may be placed.
pub const W: RangeInclusive<i64> = 2..=12;
/// How many grid cells tall a custom widget may be placed.
pub const H: RangeInclusive<i64> = 2..=8;

/// What an update or a delete says when the widget it names is not there any more —
/// [`crate::sticky_notes::NOTE_GONE`]'s reason: "changed nothing" and "nothing to change" are two
/// answers.
pub const WIDGET_GONE: &str = "That widget is not there any more.";

const NO_NAME: &str = "A widget needs a name.";
const NO_QUERY: &str = "A widget needs a data query.";
const NOT_AN_OBJECT: &str = "A widget's spec must be a JSON object.";
const NO_ROOT: &str = "A widget's spec needs a root: the key of the element it starts from.";
const NO_ELEMENTS: &str = "A widget's spec needs its elements, as an object.";

/// Every column the page is told about, in [`CustomWidget`]'s own order.
const COLUMNS: &str = "id, name, description, query, spec, w, h, created_at, updated_at";

/// One stored definition, as the page reads it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CustomWidget {
    pub id: i64,
    pub name: String,
    pub description: String,
    /// The GraphQL document, as written.
    pub query: String,
    /// The json-render spec: a JSON object `{ root, elements, state? }`.
    pub spec: serde_json::Value,
    /// The footprint it is placed at, in grid cells.
    pub w: i64,
    pub h: i64,
    /// Unix seconds.
    pub created_at: i64,
    pub updated_at: i64,
}

fn from_row(r: &Row<'_>) -> rusqlite::Result<CustomWidget> {
    // Stored by [`create`] and [`update`] as serialized JSON and held by the column's
    // `json_valid` CHECK — a restored archive included — so a failure here is a damaged file.
    let spec: String = r.get(4)?;
    let spec = serde_json::from_str(&spec).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(4, rusqlite::types::Type::Text, Box::new(e))
    })?;
    Ok(CustomWidget {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        query: r.get(3)?,
        spec,
        w: r.get(5)?,
        h: r.get(6)?,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

/// Every definition, by name ignoring case and then by id — the dialog's order, and stable for
/// two widgets of one name.
pub fn list(conn: &Connection) -> rusqlite::Result<Vec<CustomWidget>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {COLUMNS} FROM custom_widgets ORDER BY name COLLATE NOCASE, id"
    ))?;
    let rows = stmt.query_map([], from_row)?;
    rows.collect()
}

/// One definition, or `None`.
pub fn get(conn: &Connection, id: i64) -> rusqlite::Result<Option<CustomWidget>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM custom_widgets WHERE id = ?1"),
        [id],
        from_row,
    )
    .optional()
}

/// The name, trimmed, or the refusal.
pub fn check_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err(NO_NAME.to_owned());
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(format!(
            "A widget's name can be at most {MAX_NAME_CHARS} characters."
        ));
    }
    Ok(name.to_owned())
}

/// The description, trimmed, or the refusal. Empty is a widget with nothing to say.
pub fn check_description(description: &str) -> Result<String, String> {
    let description = description.trim();
    if description.chars().count() > MAX_DESCRIPTION_CHARS {
        return Err(format!(
            "A widget's description can be at most {MAX_DESCRIPTION_CHARS} characters."
        ));
    }
    Ok(description.to_owned())
}

/// The query or the refusal. **Kept as written** — the document a model or a reader wrote,
/// indentation and all — and blank only after trimming.
pub fn check_query(query: &str) -> Result<(), String> {
    if query.trim().is_empty() {
        return Err(NO_QUERY.to_owned());
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(format!(
            "A widget's data query can be at most {MAX_QUERY_BYTES} bytes."
        ));
    }
    Ok(())
}

/// The spec serialized for its column, or the refusal: a JSON object with a string `root` and
/// an object `elements`, at most [`MAX_SPEC_BYTES`]. **Nothing else about it is looked at** — see
/// the module doc.
pub fn check_spec(spec: &serde_json::Value) -> Result<String, String> {
    let Some(object) = spec.as_object() else {
        return Err(NOT_AN_OBJECT.to_owned());
    };
    if !object.get("root").is_some_and(serde_json::Value::is_string) {
        return Err(NO_ROOT.to_owned());
    }
    if !object
        .get("elements")
        .is_some_and(serde_json::Value::is_object)
    {
        return Err(NO_ELEMENTS.to_owned());
    }
    let text = serde_json::to_string(spec).map_err(|e| e.to_string())?;
    if text.len() > MAX_SPEC_BYTES {
        return Err(format!(
            "A widget's spec can be at most {MAX_SPEC_BYTES} bytes."
        ));
    }
    Ok(text)
}

/// The footprint, or the refusal.
pub fn check_size(w: i64, h: i64) -> Result<(), String> {
    if !W.contains(&w) {
        return Err(format!(
            "A widget is {} to {} cells wide.",
            W.start(),
            W.end()
        ));
    }
    if !H.contains(&h) {
        return Err(format!(
            "A widget is {} to {} cells tall.",
            H.start(),
            H.end()
        ));
    }
    Ok(())
}

/// Store a new definition and answer it as read back.
pub fn create(
    conn: &Connection,
    name: &str,
    description: &str,
    query: &str,
    spec: &serde_json::Value,
    w: i64,
    h: i64,
) -> Result<CustomWidget, String> {
    let name = check_name(name)?;
    let description = check_description(description)?;
    check_query(query)?;
    let spec = check_spec(spec)?;
    check_size(w, h)?;
    let id: i64 = conn
        .query_row(
            "INSERT INTO custom_widgets (name, description, query, spec, w, h, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch())
             RETURNING id",
            params![name, description, query, spec, w, h],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    read_back(conn, id)
}

/// Change any of the six fields; an absent one is left alone, [`crate::sticky_notes::update_note`]'s
/// `coalesce` idiom. Every field given is checked as [`create`] checks it, and the widget is
/// looked for, **before** anything is written. `updated_at` moves on every update that lands.
#[allow(clippy::too_many_arguments)]
pub fn update(
    conn: &Connection,
    id: i64,
    name: Option<String>,
    description: Option<String>,
    query: Option<String>,
    spec: Option<serde_json::Value>,
    w: Option<i64>,
    h: Option<i64>,
) -> Result<CustomWidget, String> {
    let name = name.as_deref().map(check_name).transpose()?;
    let description = description.as_deref().map(check_description).transpose()?;
    if let Some(query) = &query {
        check_query(query)?;
    }
    let spec = spec.as_ref().map(check_spec).transpose()?;
    let Some(current) = get(conn, id).map_err(|e| e.to_string())? else {
        return Err(WIDGET_GONE.to_owned());
    };
    check_size(w.unwrap_or(current.w), h.unwrap_or(current.h))?;
    conn.execute(
        "UPDATE custom_widgets
            SET name = coalesce(?2, name),
                description = coalesce(?3, description),
                query = coalesce(?4, query),
                spec = coalesce(?5, spec),
                w = coalesce(?6, w),
                h = coalesce(?7, h),
                updated_at = unixepoch()
          WHERE id = ?1",
        params![id, name, description, query, spec, w, h],
    )
    .map_err(|e| e.to_string())?;
    read_back(conn, id)
}

/// Throw a definition away. A placed widget naming it is the layout's and stays there; the page
/// draws it as gone.
pub fn delete(conn: &Connection, id: i64) -> Result<(), String> {
    if get(conn, id).map_err(|e| e.to_string())?.is_none() {
        return Err(WIDGET_GONE.to_owned());
    }
    conn.execute("DELETE FROM custom_widgets WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_back(conn: &Connection, id: i64) -> Result<CustomWidget, String> {
    get(conn, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| WIDGET_GONE.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// The real user schema over [`crate::schema::memory_pair`], `sticky_notes`' `db()`.
    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    fn spec() -> serde_json::Value {
        json!({
            "root": "body",
            "elements": { "body": { "type": "Text", "props": { "text": "Hi" }, "children": [] } },
        })
    }

    fn make(conn: &Connection, name: &str) -> CustomWidget {
        create(conn, name, "", "{ decks { id } }", &spec(), 4, 3).unwrap()
    }

    #[test]
    fn a_widget_is_created_listed_updated_and_deleted() {
        let conn = db();
        let made = create(
            &conn,
            "  Deck values  ",
            "What each deck is worth.",
            "{\n  decks { name }\n}",
            &spec(),
            4,
            3,
        )
        .unwrap();
        assert_eq!(made.name, "Deck values", "the name is trimmed");
        assert_eq!(
            made.query, "{\n  decks { name }\n}",
            "the query is kept as written"
        );
        assert_eq!(made.spec, spec());
        assert_eq!((made.w, made.h), (4, 3));
        assert!(made.created_at > 0 && made.updated_at == made.created_at);
        assert_eq!(list(&conn).unwrap(), vec![made.clone()]);

        let mut changed = spec();
        changed["state"] = json!({ "ui": { "open": true } });
        let updated = update(
            &conn,
            made.id,
            None,
            Some(String::new()),
            None,
            Some(changed.clone()),
            Some(6),
            None,
        )
        .unwrap();
        assert_eq!(updated.name, "Deck values", "an absent field is left");
        assert_eq!(updated.description, "", "an empty one really empties");
        assert_eq!(updated.spec, changed);
        assert_eq!((updated.w, updated.h), (6, 3));
        assert_eq!(updated.created_at, made.created_at);
        assert!(updated.updated_at >= made.updated_at);

        delete(&conn, made.id).unwrap();
        assert!(list(&conn).unwrap().is_empty());
    }

    #[test]
    fn the_list_is_by_name_ignoring_case_then_by_id() {
        let conn = db();
        let b = make(&conn, "bravo");
        let a2 = make(&conn, "Alpha");
        let a1 = make(&conn, "alpha");
        let ids: Vec<i64> = list(&conn).unwrap().iter().map(|w| w.id).collect();
        assert_eq!(ids, vec![a2.id, a1.id, b.id]);
    }

    #[test]
    fn a_missing_widget_is_refused_in_a_sentence() {
        let conn = db();
        let none = update(&conn, 404, Some("x".into()), None, None, None, None, None);
        assert_eq!(none.unwrap_err(), WIDGET_GONE);
        assert_eq!(delete(&conn, 404).unwrap_err(), WIDGET_GONE);
    }

    #[test]
    fn each_shape_is_refused_before_the_write() {
        let conn = db();
        let try_make =
            |name: &str, description: &str, query: &str, spec: serde_json::Value, w, h| {
                create(&conn, name, description, query, &spec, w, h).unwrap_err()
            };
        let q = "{ decks { id } }";
        assert_eq!(try_make("  ", "", q, spec(), 4, 3), NO_NAME);
        assert!(try_make(&"n".repeat(81), "", q, spec(), 4, 3).contains("80 characters"));
        assert!(try_make("n", &"d".repeat(501), q, spec(), 4, 3).contains("500 characters"));
        assert_eq!(try_make("n", "", " \n ", spec(), 4, 3), NO_QUERY);
        let long = format!("{{ decks {{ id }} }}{}", " ".repeat(MAX_QUERY_BYTES));
        assert!(try_make("n", "", &long, spec(), 4, 3).contains("20000 bytes"));
        assert_eq!(try_make("n", "", q, json!([]), 4, 3), NOT_AN_OBJECT);
        assert_eq!(
            try_make("n", "", q, json!({ "elements": {} }), 4, 3),
            NO_ROOT
        );
        assert_eq!(
            try_make("n", "", q, json!({ "root": 1, "elements": {} }), 4, 3),
            NO_ROOT
        );
        assert_eq!(
            try_make("n", "", q, json!({ "root": "a", "elements": [] }), 4, 3),
            NO_ELEMENTS
        );
        let big =
            json!({ "root": "a", "elements": {}, "state": { "x": "y".repeat(MAX_SPEC_BYTES) } });
        assert!(try_make("n", "", q, big, 4, 3).contains("200000 bytes"));
        assert!(try_make("n", "", q, spec(), 1, 3).contains("2 to 12 cells wide"));
        assert!(try_make("n", "", q, spec(), 13, 3).contains("2 to 12 cells wide"));
        assert!(try_make("n", "", q, spec(), 4, 1).contains("2 to 8 cells tall"));
        assert!(try_make("n", "", q, spec(), 4, 9).contains("2 to 8 cells tall"));
        assert!(
            list(&conn).unwrap().is_empty(),
            "nothing refused was written"
        );

        let made = make(&conn, "Kept");
        let refused = update(&conn, made.id, None, None, None, None, Some(20), None);
        assert!(refused.unwrap_err().contains("cells wide"));
        let refused = update(
            &conn,
            made.id,
            Some(" ".into()),
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(refused.unwrap_err(), NO_NAME);
        let refused = update(
            &conn,
            made.id,
            None,
            None,
            None,
            Some(json!("x")),
            None,
            None,
        );
        assert_eq!(refused.unwrap_err(), NOT_AN_OBJECT);
        assert_eq!(
            list(&conn).unwrap(),
            vec![made],
            "a refused update wrote nothing"
        );
    }

    /// The core checks the shape and never the vocabulary: a component this build has never
    /// heard of, and a query that is not GraphQL at all, are stored as given.
    #[test]
    fn the_vocabulary_is_not_this_modules() {
        let conn = db();
        let strange = json!({ "root": "nowhere", "elements": { "a": { "type": "Hologram" } } });
        let made = create(&conn, "Odd", "", "not graphql", &strange, 2, 2).unwrap();
        assert_eq!(made.spec, strange);
    }

    /// The owner's decision, held where the table is used: the reader's, not synced, and so in
    /// the full export.
    #[test]
    fn the_table_is_the_readers_and_does_not_sync() {
        use crate::schema::{Side, SYNCED_TABLES, TABLES};
        assert!(!SYNCED_TABLES.contains(&"custom_widgets"));
        assert!(TABLES.contains(&("custom_widgets", Side::User)));
    }
}
