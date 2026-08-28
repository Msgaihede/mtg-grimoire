//! How large the reader draws the card tiles on each wall — the setting, and nothing else.
//!
//! **The ladder is TypeScript's; the row is this crate's.** `src/lib/cardZoom.ts` owns the ten
//! stops a zoom may land on, which of the app's walls zoom independently, and what a value off
//! the ladder means. All Rust owns is one `app_meta` row holding a JSON object of section name →
//! multiplier, and one bound on the number that may go in it. That is the split
//! [`crate::deck::DeckViewState`] already draws around a remembered grouping — the *words* are
//! the frontend's vocabulary and this crate deliberately does not know them — with one
//! deliberate exception, noted on [`MIN_ZOOM`].
//!
//! Two rules shape it, and they are [`crate::marketplace`]'s two:
//!
//! * **Reading can never fail.** A missing row, a row holding something that is not JSON, a row
//!   holding JSON that is not an object, an entry whose value is a string — every one of them
//!   reads as "nothing stored for that section", and a section with nothing stored opens at the
//!   frontend's own default. A preference that cannot be read is not worth refusing to draw a
//!   wall of cards over.
//! * **Writing validates.** [`store`] refuses a blank section and a multiplier outside
//!   [`MIN_ZOOM`]..=[`MAX_ZOOM`], so the row cannot accumulate entries every later read would
//!   silently discard.
//!
//! **A write preserves entries this build does not understand**, which is the one thing a
//! key/value *object* has to get right that a bare string does not. The row is read back as a raw
//! `serde_json::Map` and only the section being written is touched, so a build that learns a wall
//! this one has never drawn — or widens the ladder past 2× — does not have its row quietly emptied
//! by an older build pointed at the same `mtg.db`. Validation applies to what *this* call writes,
//! never to what it is writing beside. (It read "an eighth wall" until 2026-08-26, when the decks
//! gallery became one; a hypothetical spelled as a number stops being hypothetical.)
//!
//! One row rather than one key per section, because a wall's zoom is never read alone: the
//! frontend seeds every section in a single pass at launch, so a key each would be a read of that
//! table each, to answer one question. The cost is that a write is a read-modify-write, which in a
//! single-window app already holding the write lock is one extra `SELECT`.
//!
//! No migration: `app_meta` is schema v6's key/value table, and this is a key in it.

use crate::sync::AppState;
use rusqlite::Connection;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta` — a row in
/// that one the sync did not write makes every later timing claim a fiction (schema v6).
pub const K_CARD_ZOOM: &str = "card_zoom";

/// The smallest multiplier this crate will store — the bottom of `ZOOM_STEPS` in
/// `src/lib/cardZoom.ts`.
///
/// **The one thing about the ladder Rust knows, and it knows it as a bound rather than as the ten
/// stops.** Where the stops sit is a question about how a gesture feels and belongs wholly to the
/// frontend; how far a *stored* number may stray is a question about what may land in a column,
/// and refusing junk is storage's own business. So a build that re-spaces the ladder inside these
/// ends needs no change here, while a row claiming 40× is refused at the door rather than
/// discovered by a wall of cards drawn off the screen.
pub const MIN_ZOOM: f64 = 0.5;

/// The largest multiplier this crate will store — the top of `ZOOM_STEPS`. See [`MIN_ZOOM`].
pub const MAX_ZOOM: f64 = 2.0;

/// The whole of what this crate checks about a section name, and [`crate::deck`]'s `NO_MODE`
/// sentence one table over: the word itself is TypeScript's vocabulary, but an empty string is not
/// a wall in any vocabulary — it is a bug in the caller, and storing it would put an entry in the
/// row that no reader could ever match a section against.
const NO_SECTION: &str = "A card section cannot be blank.";

/// Is this a multiplier this crate will store?
///
/// `is_finite` is belt and braces rather than dead code: JSON cannot express NaN or infinity, so
/// nothing can ever *read* one back, but [`store`] takes an `f64` straight off the IPC boundary
/// and `serde_json` serialises a non-finite one as `null` — an entry that reads back as nothing,
/// from a write that answered `Ok`.
pub fn is_storable(zoom: f64) -> bool {
    zoom.is_finite() && (MIN_ZOOM..=MAX_ZOOM).contains(&zoom)
}

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
///
/// Every failure collapses into an empty map, which is the read rule at its widest: no row, a row
/// that is not JSON, a row holding an array or a bare number. None of those is worth failing over,
/// and all of them mean one thing to a caller — nothing has been stored.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::update::get_app_meta(conn, K_CARD_ZOOM)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// Every section this database has a usable zoom for.
///
/// **A section is absent rather than defaulted**, and the absence is the point: the ten stops live
/// on the other side of the wire, so a default invented here would be a second opinion about a
/// number `DEFAULT_SECTION_ZOOMS` already owns. An empty map is the honest answer for a database
/// nobody has zoomed, and it is what a fresh install returns.
///
/// Entries are dropped one at a time rather than the row as a whole. A single hand-edited value
/// costs that section its memory and leaves its neighbours intact, which is the difference between
/// a reader noticing one wall opened at 100% and a reader noticing that all of them did.
pub fn stored(conn: &Connection) -> BTreeMap<String, f64> {
    stored_object(conn)
        .into_iter()
        .filter(|(section, _)| !section.is_empty())
        .filter_map(|(section, value)| {
            let zoom = value.as_f64().filter(|z| is_storable(*z))?;
            Some((section, zoom))
        })
        .collect()
}

/// Remember one section's zoom, leaving every other entry in the row exactly as it was.
///
/// The refusals are the whole of the function: [`stored`] discards an unusable entry silently, so
/// without them a wall zoomed to 40× would look saved and open at 100% forever.
pub fn store(conn: &Connection, section: &str, zoom: f64) -> Result<(), String> {
    if section.is_empty() {
        return Err(NO_SECTION.to_owned());
    }
    if !is_storable(zoom) {
        return Err(format!(
            "{zoom} is not a card zoom this app stores. \
             Expected a number between {MIN_ZOOM} and {MAX_ZOOM}."
        ));
    }
    let mut zooms = stored_object(conn);
    // Read-modify-write over the *raw* map, so an entry a newer build wrote — a wall this one has
    // never drawn, a multiplier past this build's ceiling — survives a write made beside it. See
    // the module doc.
    zooms.insert(section.to_owned(), Value::from(zoom));
    let json = serde_json::to_string(&Value::Object(zooms))
        .map_err(|e| format!("could not save the card zoom: {e}"))?;
    crate::update::set_app_meta(conn, K_CARD_ZOOM, &json)
        .map_err(|e| format!("could not save the card zoom: {e}"))
}

/// Every wall's remembered zoom, as section name → multiplier.
///
/// **Infallible by signature**, [`crate::marketplace::get_marketplace`]'s contract and for its
/// reason: the frontend reads this once at launch to seed a store that has already been built out
/// of its own defaults, and there is nothing a wall of cards could do with an error here that is
/// not just "keep the size you already have" — so this does that instead of making the caller do
/// it.
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame.
#[tauri::command(async)]
pub fn card_zoom(state: tauri::State<'_, Arc<AppState>>) -> BTreeMap<String, f64> {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember one section's zoom. Rejects a blank section and an out-of-range multiplier, and
/// answers [`crate::db::BUSY`] if a sync holds the write connection — the bound every write
/// command in this crate takes.
///
/// **A refusal here is not worth surfacing**, which is a fact about the caller rather than about
/// this function: the frontend writes on a trailing timer after a gesture has stopped, so a BUSY
/// during a first-run sync costs the reader nothing they can see this session and only the next
/// launch's starting size. Nothing on screen would be improved by saying so.
#[tauri::command]
pub async fn set_card_zoom(
    state: tauri::State<'_, Arc<AppState>>,
    section: String,
    zoom: f64,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, &section, zoom))
    })
    .await
    .map_err(|e| format!("the card zoom could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The setting outlives the process, so the only thing that matters about it is that what
    /// went in comes back out — at both ends of the ladder and at every stop between them.
    /// The stops are the frontend's and this crate does not hold a copy — the list here is
    /// `ZOOM_STEPS` as it stands today, used as *data* about what a round trip has to survive
    /// rather than as a rule this module enforces. A ladder re-spaced inside the bound needs no
    /// change to `zoom.rs`; if this list goes stale it costs the test its realism and nothing else.
    #[test]
    fn every_stop_on_the_ladder_round_trips() {
        let conn = db();
        for zoom in [
            0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0,
        ] {
            store(&conn, "deck", zoom).unwrap();
            assert_eq!(stored(&conn).get("deck"), Some(&zoom));
        }
    }

    /// **An off-ladder value between the ends is stored and read back unchanged**, which is the
    /// split this module is built on: the bound is storage's, the ten-or-sixteen stops are the
    /// frontend's, and `snapZoom` on that side is what puts a restored value back on the rungs. A
    /// crate that snapped here would silently rewrite a value a newer build meant.
    #[test]
    fn a_value_between_the_ends_but_off_the_ladder_survives_untouched() {
        let conn = db();
        // The stops a build before 2026-08-22 would have written.
        for zoom in [0.67, 0.75, 1.25, 1.75, 1.37] {
            store(&conn, "search", zoom).unwrap();
            assert_eq!(stored(&conn).get("search"), Some(&zoom));
        }
    }

    /// A database nobody has zoomed answers with nothing at all — deliberately not with an entry
    /// per wall at 1.0, which would be this crate inventing a default the frontend already owns.
    #[test]
    fn a_missing_row_reads_as_nothing_stored() {
        let conn = db();
        assert_eq!(crate::update::get_app_meta(&conn, K_CARD_ZOOM), None);
        assert!(stored(&conn).is_empty());
    }

    /// One memory per wall, independent of every other. The whole reason the value is an object rather
    /// than one number: zooming the deck editor's docked search column must not resize the deck
    /// laid out beside it, and that has to survive a restart too.
    #[test]
    fn each_section_is_remembered_on_its_own() {
        let conn = db();
        store(&conn, "deckSearch", 1.5).unwrap();
        store(&conn, "deck", 0.75).unwrap();

        let zooms = stored(&conn);
        assert_eq!(zooms.get("deckSearch"), Some(&1.5));
        assert_eq!(zooms.get("deck"), Some(&0.75));
        assert_eq!(
            zooms.len(),
            2,
            "nothing was invented for the walls nobody zoomed"
        );
    }

    /// A row this build cannot make sense of is a fact about storage, not a reason to refuse to
    /// draw cards. Written past `store` deliberately — every one of these is what a hand-edit or
    /// a different program left behind, which no validation of ours was in a position to refuse.
    #[test]
    fn an_unreadable_row_reads_as_nothing_rather_than_failing() {
        let conn = db();
        for junk in ["", "not json", "[1, 2]", "null", "7", "\"deck\""] {
            crate::update::set_app_meta(&conn, K_CARD_ZOOM, junk).unwrap();
            assert!(
                stored(&conn).is_empty(),
                "`{junk}` must read as nothing stored, not fail"
            );
        }
    }

    /// **One bad entry costs one section**, which is the difference between a reader noticing
    /// that one wall opened at 100% and noticing that all of them did.
    #[test]
    fn a_junk_entry_is_dropped_and_its_neighbours_survive() {
        let conn = db();
        crate::update::set_app_meta(
            &conn,
            K_CARD_ZOOM,
            r#"{"deck": 1.25, "search": "big", "tags": 40, "wishlist": null, "": 1.5}"#,
        )
        .unwrap();

        let zooms = stored(&conn);
        assert_eq!(zooms.get("deck"), Some(&1.25));
        assert_eq!(zooms.len(), 1, "only the usable entry survives: {zooms:?}");
    }

    /// The bound, at both ends and just past each of them. `stored` discards an out-of-range
    /// value silently, so a write that half-landed would look like a save and read back as
    /// nothing forever.
    #[test]
    fn a_multiplier_outside_the_ladder_is_refused() {
        let conn = db();
        store(&conn, "deck", 1.25).unwrap();

        for bad in [0.49, 2.01, 0.0, -1.0, 40.0, f64::NAN, f64::INFINITY] {
            assert!(store(&conn, "deck", bad).is_err(), "{bad} must be refused");
        }
        assert_eq!(stored(&conn).get("deck"), Some(&1.25), "the choice stands");

        // The ends themselves are storable — a bound that refused its own extremes would refuse
        // the two stops a reader reaches by holding the wheel down.
        store(&conn, "deck", MIN_ZOOM).unwrap();
        store(&conn, "deck", MAX_ZOOM).unwrap();
    }

    /// The section name is the frontend's word and this crate does not know the list — but a
    /// blank one is not a wall in any vocabulary, and an entry under it could never be matched.
    #[test]
    fn a_blank_section_is_refused() {
        let conn = db();
        let err = store(&conn, "", 1.25).unwrap_err();
        assert_eq!(err, NO_SECTION);
        assert!(stored(&conn).is_empty());
    }

    /// The mirror of the sentence above: a section this build has never heard of is stored
    /// without complaint, because the list of walls belongs to the other side of the wire.
    #[test]
    fn a_section_this_build_does_not_know_is_stored_anyway() {
        let conn = db();
        store(&conn, "somethingNew", 1.5).unwrap();
        assert_eq!(stored(&conn).get("somethingNew"), Some(&1.5));
    }

    /// **A newer build's row survives an older build's write**, which is the one thing an object
    /// row has to get right that a bare string does not: a wall this build has never drawn and a
    /// multiplier past its ceiling are both still there after it writes beside them.
    ///
    /// The fixture's key was `eighthWall` until 2026-08-26, when the decks gallery became the
    /// eighth and the name started reading as a section somebody had forgotten to add.
    #[test]
    fn a_write_preserves_entries_this_build_cannot_use() {
        let conn = db();
        crate::update::set_app_meta(&conn, K_CARD_ZOOM, r#"{"aWallFromLater": 1.5, "deck": 4}"#)
            .unwrap();

        store(&conn, "search", 1.1).unwrap();

        let raw = crate::update::get_app_meta(&conn, K_CARD_ZOOM).unwrap();
        let row: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            row["aWallFromLater"], 1.5,
            "a wall this build has never drawn"
        );
        assert_eq!(row["deck"], 4, "a multiplier past this build's ceiling");
        assert_eq!(row["search"], 1.1);
        // And this build still reads only what it can use out of it.
        let zooms = stored(&conn);
        assert_eq!(zooms.get("search"), Some(&1.1));
        assert_eq!(zooms.get("aWallFromLater"), Some(&1.5));
        assert_eq!(zooms.get("deck"), None, "4× is past the bound");
    }

    /// A refused write leaves the row untouched — not merely the section it named, the whole row.
    /// The read-modify-write is where that could go wrong: a validation done after the read would
    /// still have rewritten the row without the refused entry in it.
    #[test]
    fn a_refused_write_rewrites_nothing() {
        let conn = db();
        store(&conn, "deck", 1.25).unwrap();
        let before = crate::update::get_app_meta(&conn, K_CARD_ZOOM);

        assert!(store(&conn, "search", 9.0).is_err());
        assert!(store(&conn, "", 1.0).is_err());

        assert_eq!(crate::update::get_app_meta(&conn, K_CARD_ZOOM), before);
    }
}
