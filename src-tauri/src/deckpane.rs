//! How wide the decks page's folder tree is drawn, and whether the reader has shut it down to a
//! rail — the setting, and nothing else.
//!
//! **The tree is TypeScript's; the row is this crate's.** Where the drag handle sits, how narrow
//! the tree may be pulled before it stops being readable, how wide it may be pulled before the
//! deck gallery beside it has nowhere left to go, what the rail shows once the labels are gone and
//! whether either change is animated are all questions about a window this crate never sees. All
//! Rust owns is one `app_meta` row holding a JSON object with two fields — a width and a collapse
//! — plus the rule that anything else in either of them means *nothing stored*.
//!
//! **It is [`crate::listview`]'s shape with a fixed field list where that one has an open one.**
//! There the keys are section names the frontend invents and this crate never enumerates; here
//! there are exactly two, [`F_WIDTH`] and [`F_COLLAPSED`], and they are named constants for
//! [`crate::nav`]'s reason — the read is a lookup with no schema behind it, so a second spelling
//! introduced at the write end would not fail anywhere. It would simply mean the reader's tree
//! opened at the default width on every launch, with nothing logged.
//!
//! **One row holding two fields rather than two rows**, [`crate::zoom`]'s reason: the two are
//! never read apart. The tree is drawn once, from both, in the same first frame — so two keys
//! would be two reads of one table to answer one question, and two writes for one drag that ended
//! with the reader also pressing the collapse.
//!
//! Three rules shape it, and they are [`crate::listview`]'s three:
//!
//! * **Reading can never fail.** A missing row, a row that is not JSON, a row holding an array or
//!   a bare scalar, a `width` that is a string or a fraction or a negative number or a number
//!   outside [`MIN_PANE_WIDTH`]..=[`MAX_PANE_WIDTH`], a `collapsed` that is not a bool — every one
//!   of them reads as "nothing stored for that field", and a field with nothing stored is
//!   [`DeckFolderPane::default`]: no width, not collapsed. The fields are dropped **one at a
//!   time**, [`crate::listview::stored`]'s rule: a hand-edited width costs the reader their width
//!   and leaves their collapse standing. A preference that cannot be read is not worth refusing to
//!   draw the decks page over, so [`deck_folder_pane`] is infallible by signature — a bare struct
//!   and not a `Result`, which is [`crate::nav::nav_collapsed`]'s contract rather than a shortcut.
//! * **Writing is where validation lives, and there is exactly one thing left to validate.**
//!   `serde` has already refused a fraction, a negative and a string before [`store`] is reached —
//!   the width crosses the wire as a `u32` — and `collapsed` is a `bool`, which has no junk state
//!   at all ([`crate::searchopen`]'s observation about the same type). What is left is the band.
//! * **A write preserves fields this build does not understand**, [`crate::listview`]'s rule
//!   verbatim and for its reason: the row is read back as a raw `serde_json::Map` and only the two
//!   fields being written are touched, so a build that learns a third thing about this pane — a
//!   remembered scroll offset, a rail width of its own — does not have its row quietly emptied by
//!   an older build pointed at the same database.
//!
//! **[`MIN_PANE_WIDTH`] and [`MAX_PANE_WIDTH`] are a *storage* sanity check and are deliberately
//! not the UI's clamp**, which is [`crate::zoom::MIN_ZOOM`]'s split stated for a length instead of
//! a multiplier. How narrow the tree may be drawn and how wide the desk can spare are measurements
//! about a window — its width, its zoom, what else is on it — that this crate has no access to and
//! could not make even if it did. So the frontend clamps again where it draws, against the box it
//! can actually measure, and these two ends only say what may land in a column: a row claiming
//! `40000` is refused at the door rather than discovered as a decks page with no decks visible on
//! it, and a row claiming `3` is refused rather than discovered as a tree the reader cannot find
//! to drag back. The band is wider than any clamp the frontend is likely to pick, which is the
//! point — a build that re-picks its handle stops inside these ends and needs no change here.
//!
//! **A refusal is deliberately not surfaced**, [`crate::nav::set_nav_collapsed`]'s trade: the
//! frontend writes optimistically on a trailing timer after the drag has stopped and keeps the
//! reader's choice for the session either way, so a [`crate::db::BUSY`] during a first-run sync
//! costs them nothing they can see now and only the next launch's starting width.
//!
//! No migration. `app_meta` is the *application's* key/value table (schema v6), deliberately not
//! `sync_meta` — a row in that one the sync did not write makes every later timing claim a fiction
//! — and this is a key in a table that has existed since v6. A preference that needed a schema
//! step would be a preference that could fail a launch.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{Map, Value};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key. The table is the *application's*, deliberately not `sync_meta` — a row in
/// that one the sync did not write makes every later timing claim a fiction (schema v6).
pub const K_DECK_FOLDER_PANE: &str = "deck_folder_pane";

/// The field holding the open tree's width in CSS pixels.
///
/// Named rather than inlined because [`stored`] and [`store`] have to agree on it character for
/// character: the read is a lookup on a raw map with no schema behind it, so a second spelling
/// introduced at the write end would not fail anywhere — it would simply mean the reader's width
/// never came back, on every launch, with nothing logged.
pub const F_WIDTH: &str = "width";

/// The field holding whether the tree is shut down to a rail. See [`F_WIDTH`].
///
/// **It is a field beside the width and not a width of its own**, which is the one modelling
/// choice in this module: a collapsed tree could have been spelled as a very small width, and then
/// re-opening it would have had nothing to re-open *to*. The reader's width is what they dragged
/// it to; the collapse is a second, independent answer laid over it.
pub const F_COLLAPSED: &str = "collapsed";

/// The narrowest tree this crate will store, in CSS pixels.
///
/// **A storage bound, not the drag handle's stop** — see the module doc. It is under anything a
/// tree of deck names could usefully be drawn at and still be a tree rather than a rail, because
/// the rail is a separate answer ([`F_COLLAPSED`]) and not a width.
pub const MIN_PANE_WIDTH: u32 = 80;

/// The widest tree this crate will store, in CSS pixels. See [`MIN_PANE_WIDTH`].
///
/// Past any sidebar a window this app is drawn in can spare, and deliberately well past whatever
/// the frontend's own handle stops at.
pub const MAX_PANE_WIDTH: u32 = 1200;

/// The decks page's folder tree as this database remembers it.
///
/// **`width: None` is "the reader has never dragged it", not "zero"**, and the distinction is the
/// whole reason the field is an `Option`: what an un-dragged tree opens at lives on the other side
/// of the wire, so a number invented here would be a second opinion about a default `FolderTree`
/// already owns. [`Default`] is that state, and it is what a fresh install answers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct DeckFolderPane {
    /// The open tree's width in CSS pixels, or `None` if nothing usable is stored.
    pub width: Option<u32>,
    /// Whether the tree is shut down to a rail. Absence reads as `false` — an installation that
    /// has never collapsed it has an open tree, which is the one state a reader can always get
    /// out of by pressing something they can see.
    pub collapsed: bool,
}

/// Is this a width this crate will store?
pub fn is_storable_width(width: u32) -> bool {
    (MIN_PANE_WIDTH..=MAX_PANE_WIDTH).contains(&width)
}

/// The row as it stands, with nothing thrown away — the shape a write has to preserve.
///
/// Every failure collapses into an empty map, which is the read rule at its widest: no row, a row
/// that is not JSON, a row holding an array or a bare number. None of those is worth failing over,
/// and all of them mean one thing to a caller — nothing has been stored.
fn stored_object(conn: &Connection) -> Map<String, Value> {
    match crate::app_meta::get_app_meta(conn, K_DECK_FOLDER_PANE)
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(Value::Object(map)) => map,
        _ => Map::new(),
    }
}

/// What this database remembers about the folder tree.
///
/// The two fields are read independently, [`crate::listview::stored`]'s per-entry rule: a width a
/// hand-edit or a newer build left unreadable costs the reader their width and leaves their
/// collapse alone, which is the difference between a reader noticing the tree opened wide and a
/// reader noticing it opened wide *and* forgot it had been shut.
///
/// `as_u64` and not `as_f64`: this build writes an integer, so a fraction is something else's, and
/// it is refused rather than rounded into a number nobody chose. A negative reads as nothing for
/// the same reason — `serde_json` will not hand it back as a `u64`, and no rescue of it here could
/// say what the reader had meant.
pub fn stored(conn: &Connection) -> DeckFolderPane {
    let row = stored_object(conn);
    DeckFolderPane {
        width: row
            .get(F_WIDTH)
            .and_then(Value::as_u64)
            .and_then(|w| u32::try_from(w).ok())
            .filter(|w| is_storable_width(*w)),
        collapsed: row
            .get(F_COLLAPSED)
            .and_then(Value::as_bool)
            .unwrap_or_default(),
    }
}

/// Remember the folder tree's width and collapse, leaving every other field in the row exactly as
/// it was.
///
/// The band is the whole of the validation, and it is the exact complement of [`stored`]'s
/// silence: that one discards an out-of-band width without a word, so without this a tree dragged
/// to 40 000 px would look saved, survive a restart in the table, and read back as nothing
/// forever.
///
/// **Both fields are written on every call, including a `collapsed` of `false`.** A reader who
/// opens the tree again has made a second choice and not withdrawn the first — [`crate::nav`]'s
/// `"0"` rule in the shape an object row takes.
pub fn store(conn: &Connection, width: u32, collapsed: bool) -> Result<(), String> {
    if !is_storable_width(width) {
        return Err(format!(
            "{width} is not a folder tree width this app stores. \
             Expected a whole number of pixels between {MIN_PANE_WIDTH} and {MAX_PANE_WIDTH}."
        ));
    }
    let mut pane = stored_object(conn);
    // Read-modify-write over the *raw* map, so a field a newer build wrote — a remembered scroll
    // offset, a rail width of its own — survives a write made beside it. See the module doc.
    pane.insert(F_WIDTH.to_owned(), Value::from(width));
    pane.insert(F_COLLAPSED.to_owned(), Value::from(collapsed));
    let json = serde_json::to_string(&Value::Object(pane))
        .map_err(|e| format!("could not save the folder tree width: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_DECK_FOLDER_PANE, &json)
        .map_err(|e| format!("could not save the folder tree width: {e}"))
}

/// The decks page's folder tree as this database remembers it.
///
/// **Infallible by signature**, [`crate::nav::nav_collapsed`]'s contract and for its reason: the
/// frontend reads this once to seed a store that already has defaults of its own, and there is
/// nothing the decks page could do with an error here that is not just "draw the tree the way you
/// already would have".
///
/// `#[tauri::command(async)]` rather than a bare sync command: a sync body runs inline on the IPC
/// thread, and this one takes `db_read`'s mutex, which a search may hold for tens of milliseconds
/// — and this is called while the window is drawing its first frame. It is not an `async fn`
/// because Tauri requires a `Result` from one that borrows `State`, and a `Result` here would be a
/// failure mode this call does not have.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn deck_folder_pane(state: tauri::State<'_, Arc<AppState>>) -> DeckFolderPane {
    stored(&crate::sync::lock_db_read(state.inner()))
}

/// Remember the folder tree's width and collapse. Rejects a width outside
/// [`MIN_PANE_WIDTH`]..=[`MAX_PANE_WIDTH`], and answers [`crate::db::BUSY`] if a sync holds the
/// write connection — the bound every write command in this crate takes.
///
/// **A refusal here is deliberately not surfaced**, [`crate::nav::set_nav_collapsed`]'s note and
/// for its reason: the frontend writes optimistically and keeps the reader's choice for the
/// session either way, so a BUSY during a first-run sync costs them nothing they can see now and
/// only the next launch's starting width. Nothing on screen would be improved by saying so.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_deck_folder_pane(
    state: tauri::State<'_, Arc<AppState>>,
    width: u32,
    collapsed: bool,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store(conn, width, collapsed))
    })
    .await
    .map_err(|e| format!("the folder tree width could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The setting outlives the process, so the only thing that matters about it is that what went
    /// in comes back out — both fields, in both directions, and repeatedly, because a reader drags
    /// this handle far more often than they change a marketplace.
    #[test]
    fn both_fields_round_trip() {
        let conn = db();
        for (width, collapsed) in [
            (208u32, false),
            (320, true),
            (208, true),
            (MIN_PANE_WIDTH, false),
            (MAX_PANE_WIDTH, true),
            (176, false),
            (176, false),
        ] {
            store(&conn, width, collapsed).unwrap();
            assert_eq!(
                stored(&conn),
                DeckFolderPane {
                    width: Some(width),
                    collapsed
                }
            );
        }
    }

    /// A database nobody has dragged has nothing to say about the tree. This is the state every
    /// fresh install is in, so it is the one the defaults have to be right about — and it is what
    /// lets `FolderTree`'s own starting width stand rather than being overwritten by an opinion
    /// invented here.
    #[test]
    fn a_missing_row_reads_as_the_defaults() {
        let conn = db();
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_DECK_FOLDER_PANE),
            None
        );
        let pane = stored(&conn);
        assert_eq!(pane, DeckFolderPane::default());
        assert_eq!(pane.width, None, "no width, deliberately not a number");
        assert!(!pane.collapsed, "an un-dragged tree is open");
    }

    /// **The case a naive implementation gets wrong.** Treating the field's *presence* as the
    /// collapse — writing it on collapse, leaving it out on expand — reads identically on a fresh
    /// install and identically after a collapse, and fails only here: the reader opens the tree
    /// again, and every later launch still draws the rail. So the row is asserted as well as the
    /// answer.
    #[test]
    fn expanding_again_clears_a_stored_collapse() {
        let conn = db();
        store(&conn, 240, true).unwrap();
        assert!(stored(&conn).collapsed);

        store(&conn, 240, false).unwrap();
        assert!(!stored(&conn).collapsed, "expanding must undo the collapse");

        let raw = crate::app_meta::get_app_meta(&conn, K_DECK_FOLDER_PANE).unwrap();
        let row: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            row[F_COLLAPSED],
            json!(false),
            "the field is rewritten, not left standing with the old value"
        );
    }

    /// A row this build cannot make sense of costs the reader their tree width and nothing else.
    /// Written past [`store`] deliberately — every one of these is what a hand-edit or a different
    /// build left behind, which no validation of ours was ever in a position to refuse.
    ///
    /// `{"width":"208"}` is the plausible slip once the value crosses a wire as JSON, `-5` is what
    /// a signed frontend clamp could send if this crate took an `i64`, `9999` is past the band and
    /// `208.5` is a fraction from a browser that measured rather than rounded. None of them may be
    /// forgiven into a width, and none of them may fail.
    #[test]
    fn an_unreadable_row_reads_as_the_defaults_rather_than_failing() {
        let conn = db();
        for junk in [
            "",
            "not json",
            "[]",
            "[208]",
            "null",
            "true",
            "208",
            "\"208\"",
            r#"{"width":"208"}"#,
            r#"{"width":-5}"#,
            r#"{"width":208.5}"#,
            r#"{"width":null}"#,
            r#"{"width":9999}"#,
            r#"{"width":3}"#,
            r#"{"collapsed":"yes"}"#,
            r#"{"collapsed":1}"#,
            r#"{"collapsed":null}"#,
            r#"{"width":"208","collapsed":"yes"}"#,
        ] {
            crate::app_meta::set_app_meta(&conn, K_DECK_FOLDER_PANE, junk).unwrap();
            assert_eq!(
                stored(&conn),
                DeckFolderPane::default(),
                "`{junk}` must read as nothing stored, not as a pane and not as a failure"
            );
        }
    }

    /// The band, at both ends and just past each of them, read off a hand-written row. `store`
    /// cannot produce these, which is exactly why they have to be built by hand — and `stored`
    /// discarding them silently is what makes the refusal in [`store`] load-bearing rather than
    /// belt and braces.
    #[test]
    fn a_width_outside_the_band_reads_as_nothing_and_its_ends_do_not() {
        let conn = db();
        for (width, expected) in [
            (MIN_PANE_WIDTH - 1, None),
            (MIN_PANE_WIDTH, Some(MIN_PANE_WIDTH)),
            (MAX_PANE_WIDTH, Some(MAX_PANE_WIDTH)),
            (MAX_PANE_WIDTH + 1, None),
            (0, None),
            (40_000, None),
        ] {
            let row = format!(r#"{{"width":{width},"collapsed":false}}"#);
            crate::app_meta::set_app_meta(&conn, K_DECK_FOLDER_PANE, &row).unwrap();
            assert_eq!(
                stored(&conn).width,
                expected,
                "{width} px must read as {expected:?}"
            );
        }
    }

    /// **One bad field costs one field, not the row.** A width nothing can use sits beside a
    /// collapse that is perfectly readable, and the reader keeps the half that survived — which is
    /// the difference between a tree that opens at the wrong width and a tree that opens at the
    /// wrong width *and* forgets it was shut.
    #[test]
    fn a_junk_width_leaves_the_collapse_standing() {
        let conn = db();
        crate::app_meta::set_app_meta(
            &conn,
            K_DECK_FOLDER_PANE,
            r#"{"width":"wide","collapsed":true}"#,
        )
        .unwrap();
        assert_eq!(
            stored(&conn),
            DeckFolderPane {
                width: None,
                collapsed: true
            }
        );

        crate::app_meta::set_app_meta(
            &conn,
            K_DECK_FOLDER_PANE,
            r#"{"width":320,"collapsed":"no"}"#,
        )
        .unwrap();
        assert_eq!(
            stored(&conn),
            DeckFolderPane {
                width: Some(320),
                collapsed: false
            }
        );
    }

    /// A junk row is not sticky: the next write puts the setting back on its feet, so a reader who
    /// hits this never has to be told to clear anything.
    #[test]
    fn a_write_over_a_junk_row_takes_effect() {
        let conn = db();
        crate::app_meta::set_app_meta(&conn, K_DECK_FOLDER_PANE, "not json").unwrap();
        assert_eq!(stored(&conn), DeckFolderPane::default());

        store(&conn, 264, true).unwrap();
        assert_eq!(
            stored(&conn),
            DeckFolderPane {
                width: Some(264),
                collapsed: true
            }
        );
    }

    /// A field a *newer* build wrote survives a write this build makes beside it — the raw
    /// read-modify-write's whole purpose. Written past [`store`] deliberately: this build has no
    /// way to produce a third field, which is exactly why the case has to be built by hand.
    #[test]
    fn an_unknown_field_survives_a_write_beside_it() {
        let conn = db();
        crate::app_meta::set_app_meta(
            &conn,
            K_DECK_FOLDER_PANE,
            r#"{"width":180,"collapsed":true,"railWidth":36,"scrollTop":420}"#,
        )
        .unwrap();

        store(&conn, 300, false).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_DECK_FOLDER_PANE).unwrap();
        let row: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            row["railWidth"],
            json!(36),
            "a field this build does not know must not be emptied by a write beside it"
        );
        assert_eq!(row["scrollTop"], json!(420));
        // And this build still answers for the two it does know.
        assert_eq!(
            stored(&conn),
            DeckFolderPane {
                width: Some(300),
                collapsed: false
            }
        );
    }

    /// The stored shape is the contract with anything else that reads this row — a newer build, a
    /// hand-edit, a support answer telling somebody what to put there. Pinning it here is what
    /// makes changing it a deliberate act rather than a rename that reads as a no-op.
    ///
    /// Compared as a parsed `Value` rather than as text, so the pin is on the *shape* — two fields,
    /// under these two names, an integer and a bool — and not on `serde_json`'s key order, which is
    /// a property of a Cargo feature nothing in this module chose.
    #[test]
    fn the_stored_json_shape_is_pinned() {
        let conn = db();
        store(&conn, 208, true).unwrap();

        let raw = crate::app_meta::get_app_meta(&conn, K_DECK_FOLDER_PANE).unwrap();
        let row: Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(row, json!({ "width": 208, "collapsed": true }));
        assert!(row[F_WIDTH].is_u64(), "the width is a whole number: {row}");
        assert!(row[F_COLLAPSED].is_boolean(), "the collapse is a bool");
    }

    /// The wire shape the frontend reads, pinned at the other end: `width` may be `null` and
    /// `collapsed` may not. A `serde` attribute that skipped a `None` — the reflex on an
    /// `Option` — would take the key off the object entirely, and the field would arrive
    /// `undefined` in a reader written against a `number | null`.
    #[test]
    fn the_wire_shape_carries_a_null_width_rather_than_dropping_it() {
        let conn = db();
        assert_eq!(
            serde_json::to_value(stored(&conn)).unwrap(),
            json!({ "width": null, "collapsed": false })
        );

        store(&conn, 208, true).unwrap();
        assert_eq!(
            serde_json::to_value(stored(&conn)).unwrap(),
            json!({ "width": 208, "collapsed": true })
        );
    }

    /// The complement of the read rule above: a width this crate will not store is refused at the
    /// door rather than stored and silently discarded on the next launch. The ends themselves are
    /// storable — a band that refused its own extremes would refuse the two widths a reader
    /// reaches by dragging the handle as far as it goes.
    #[test]
    fn a_width_outside_the_band_is_refused() {
        let conn = db();
        store(&conn, 208, false).unwrap();
        let before = crate::app_meta::get_app_meta(&conn, K_DECK_FOLDER_PANE);

        for bad in [
            0,
            1,
            MIN_PANE_WIDTH - 1,
            MAX_PANE_WIDTH + 1,
            40_000,
            u32::MAX,
        ] {
            assert!(store(&conn, bad, true).is_err(), "{bad} must be refused");
        }
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_DECK_FOLDER_PANE),
            before,
            "a refused write rewrites nothing — not the width, and not the collapse beside it"
        );

        store(&conn, MIN_PANE_WIDTH, false).unwrap();
        store(&conn, MAX_PANE_WIDTH, false).unwrap();
    }
}
