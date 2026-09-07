//! What colour the reader has each card mark drawn in — the setting, and nothing else.
//!
//! **Which marks are customisable is TypeScript's; the row is this crate's.** That is
//! [`crate::listview`]'s split with the bound moved one step further out: there the frontend owns
//! which *walls* exist and this crate owns the two words a wall may be drawn in, and here the
//! frontend owns which *marks* exist and this crate owns only the shape a colour may have. It
//! knows nothing about a theory tick.
//!
//! The two rules are [`crate::listview`]'s two:
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, an entry whose value is a
//!   number or a word — every one reads as "nothing stored for that mark", and a mark with
//!   nothing stored is drawn in the colour `index.css` gives it. A preference that cannot be read
//!   is not worth refusing to draw a card over.
//! * **Writing validates.** [`store`] refuses a blank key and anything that is not `#rrggbb`, so
//!   the row cannot accumulate entries every later read would silently discard.
//!
//! **A `None` colour deletes the entry rather than storing a default**, and that is the one thing
//! this module has that its model does not. Reset in the Appearance panel has to leave the reader
//! in the state they were in before they ever chose, and a default hex written into the row is a
//! different state: it freezes today's palette into the database, which is exactly the cost
//! `src/features/decks/labelColors.ts` records for a stored label colour. A cleared key means
//! "the stylesheet decides", forever.
//!
//! **A write preserves entries this build does not understand**, [`crate::listview`]'s rule
//! verbatim: the row is read back as a raw `serde_json::Map` and only the key being written is
//! touched, so a build that learns to colour a fourth mark does not have its row quietly emptied
//! by an older build pointed at the same file.
//!
//! No migration: `app_meta` is schema v6's key/value table, and this is a key in it. It is not in
//! [`crate::schema::SYNCED_TABLES`], so these colours are **this device's** — every other stored
//! preference in the app is too, and the two per-deck switches beside this feature are not.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta`.
pub const K_MARK_COLORS: &str = "mark_colors";

/// A blank key is a bug in the caller, not a mark — [`crate::listview`]'s `NO_SECTION`.
const NO_KEY: &str = "A mark cannot be blank.";

/// Is this `#rrggbb`?
///
/// **Six digits and a hash, and nothing else.** Shorthand is not accepted here even though the
/// webview's own field takes it: `normalizeLabelColor` expands `#f00` to `#ff0000` before
/// anything is sent, so three digits arriving at this boundary means a caller that skipped it —
/// and a row holding two spellings of one colour is a row whose entries cannot be compared.
fn is_hex(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
///
/// Every failure collapses into an empty map, which is the read rule at its widest: no row, a row
/// that is not JSON, a row holding an array or a bare string. None of those is worth failing over,
/// and all of them mean one thing to a caller — nothing has been stored.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_MARK_COLORS)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Every mark this database has a usable colour for.
///
/// **A mark is absent rather than defaulted**: what an uncustomised mark is drawn in lives in
/// `index.css`, so a default invented here would be a second opinion about a colour the
/// stylesheet already owns. Entries are dropped one at a time, so a single hand-edited value
/// costs that mark its colour and leaves the others intact.
pub fn stored(conn: &Connection) -> BTreeMap<String, String> {
    stored_object(conn)
        .into_iter()
        .filter(|(mark, _)| !mark.is_empty())
        .filter_map(|(mark, value)| {
            let color = value.as_str().filter(|c| is_hex(c))?;
            Some((mark, color.to_ascii_lowercase()))
        })
        .collect()
}

/// Remember one mark's colour, or — with `None` — forget it, leaving every other entry alone.
///
/// The refusals are the exact complement of [`stored`]'s silence: that one discards an unusable
/// entry without a word, so without them a colour this build cannot draw would look saved, survive
/// a restart in the table, and read back as nothing forever.
pub fn store(conn: &Connection, mark: &str, color: Option<&str>) -> Result<(), String> {
    if mark.is_empty() {
        return Err(NO_KEY.to_owned());
    }
    let mut colors = stored_object(conn);
    match color {
        Some(color) => {
            if !is_hex(color) {
                return Err(format!(
                    "\"{color}\" is not a colour this app can store. Expected #rrggbb."
                ));
            }
            colors.insert(mark.to_owned(), Value::from(color.to_ascii_lowercase()));
        }
        // Reset. See the module doc: the absence *is* the default.
        None => {
            colors.remove(mark);
        }
    }
    let json = serde_json::to_string(&Value::Object(colors))
        .map_err(|e| format!("could not save the colour: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_MARK_COLORS, &json)
        .map_err(|e| format!("could not save the colour: {e}"))
}

/// Every mark's remembered colour, as mark → `#rrggbb`.
///
/// **Infallible by signature**, [`crate::listview::list_view`]'s contract and for its reason: the
/// frontend reads this once at launch to paint over defaults it already holds, and there is
/// nothing a card could do with an error here that is not just "draw the colour you already
/// have".
///
/// `#[tauri::command(async)]` rather than a bare sync command, [`crate::listview::list_view`]'s
/// reason: a sync body runs inline on the IPC thread, and this one takes `db_read`'s mutex, which
/// a search may hold for tens of milliseconds — and this is called while the window is drawing
/// its first frame.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn mark_colors(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, String> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one mark's colour, or clear it. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes. Unlike the rail and the list
/// layout, **this refusal is worth surfacing**: the reader is standing in front of a colour picker
/// watching a swatch, so the panel says the write did not land rather than leaving them to find
/// out at the next launch.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_mark_color(
    state: tauri::State<'_, Arc<AppState>>,
    mark: String,
    color: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &mark, color.as_deref()))
    })
    .await
    .map_err(|e| format!("the colour could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// What went in comes back out. The setting outlives the process and there is nothing else to
    /// be right about.
    #[test]
    fn a_colour_round_trips() {
        let conn = db();
        store(&conn, "theoryExact", Some("#56bd78")).unwrap();
        assert_eq!(
            stored(&conn).get("theoryExact").map(String::as_str),
            Some("#56bd78")
        );
    }

    /// **`None` clears rather than writing a default**, which is what Reset in the panel means.
    /// A reader who has never chosen and a reader who has reset are the same state — the
    /// stylesheet's own value — and a stored "default" hex would freeze today's palette into the
    /// database, which is the cost `labelColors.ts` already documents for a label.
    #[test]
    fn clearing_a_colour_removes_the_entry() {
        let conn = db();
        store(&conn, "theoryName", Some("#ff0000")).unwrap();
        store(&conn, "theoryName", None).unwrap();
        assert!(!stored(&conn).contains_key("theoryName"));
    }

    /// A database nobody has customised says nothing about any mark, and the frontend's own
    /// defaults stand. This is the state every fresh install is in.
    #[test]
    fn a_missing_row_customises_nothing() {
        let conn = db();
        assert!(stored(&conn).is_empty());
    }

    /// Two marks share one row, so a write to either rewrites the whole document — and an entry a
    /// *newer* build wrote survives a write this build makes beside it. Written past `store`
    /// deliberately: this build cannot produce a third key, which is exactly why the case has to
    /// be built by hand.
    #[test]
    fn a_write_keeps_every_other_entry() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_MARK_COLORS, r##"{"ruleBreak":"#d3202a"}"##)
            .unwrap();
        store(&conn, "theoryExact", Some("#56bd78")).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_MARK_COLORS).unwrap();
        let map: Map<String, Value> = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            map.get("ruleBreak").and_then(Value::as_str),
            Some("#d3202a"),
            "a mark this build does not know must not be emptied by a write beside it"
        );
        assert_eq!(
            stored(&conn).get("theoryExact").map(String::as_str),
            Some("#56bd78")
        );
    }

    /// A row this build cannot make sense of costs the reader their colours and nothing else.
    /// Every one of these is what a hand-edit or a different build left behind.
    #[test]
    fn an_unreadable_row_customises_nothing_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "null",
            "\"#56bd78\"",
            r#"{"theoryExact":1}"#,
            r#"{"theoryExact":null}"#,
            r#"{"theoryExact":"green"}"#,
            r##"{"theoryExact":"#xyzxyz"}"##,
            r##"{"":"#56bd78"}"##,
        ] {
            crate::app_meta::set_app_meta(&conn, K_MARK_COLORS, junk).unwrap();
            assert!(
                !stored(&conn).contains_key("theoryExact"),
                "`{junk}` must read as nothing stored, not as a colour and not as a failure"
            );
        }
    }

    /// The complement of the read rule: a colour this build cannot draw is refused at the door
    /// rather than stored and silently discarded on the next launch. Shorthand is refused too —
    /// the webview normalises `#f00` to `#ff0000` before it sends, so a three-digit value
    /// arriving here is a caller that skipped `normalizeLabelColor`.
    #[test]
    fn a_colour_that_is_not_a_full_hex_is_refused() {
        let conn = db();
        for junk in [
            "",
            "green",
            "#f00",
            "56bd78",
            "#56BD78 ",
            "rgb(1,2,3)",
            "#56bd7",
        ] {
            assert!(
                store(&conn, "theoryExact", Some(junk)).is_err(),
                "`{junk}` must be refused rather than stored"
            );
        }
        assert_eq!(crate::app_meta::get_app_meta(&conn, K_MARK_COLORS), None);
    }

    /// Uppercase is a colour, not junk: `#56BD78` and `#56bd78` are the same paint, and refusing
    /// one of them would be a rule about typing rather than about colour. Stored lowercased, so
    /// the row has one spelling per colour.
    #[test]
    fn uppercase_is_accepted_and_stored_lowercased() {
        let conn = db();
        store(&conn, "theoryExact", Some("#56BD78")).unwrap();
        assert_eq!(
            stored(&conn).get("theoryExact").map(String::as_str),
            Some("#56bd78")
        );
    }

    /// A blank key is a bug in the caller, not a mark — `listview`'s `NO_SECTION` verbatim.
    #[test]
    fn a_blank_key_is_refused() {
        let conn = db();
        assert!(store(&conn, "", Some("#56bd78")).is_err());
    }
}
