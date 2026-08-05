//! The owned-cards table: what the user has, at what grain, and what it is worth.
//!
//! Shaped like [`crate::card`]: pure functions over a `Connection`, testable without a
//! Tauri app, wrapped in `async` commands that run on the blocking pool. The difference is
//! which connection — these *write*, so they take `AppState.db` with a bound rather than
//! `db_read`, and a lock they cannot get is an answer rather than a wait.

use crate::schema::COLLECTION_GRAIN;
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Scryfall's finish enum. Never a boolean — `etched` is a third thing, and collapsing it
/// into `foil: true` is the single most common way an importer loses data.
pub const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];

/// The NA condition scale, in descending order. The EU scale (`M/NM/EX/GD/LP/PL/PO`) is
/// normalised into this one at the edge — see `src/features/collection/conditions.ts` —
/// and the string it arrived as is kept in `condition_original`.
pub const CONDITIONS: [&str; 5] = ["NM", "LP", "MP", "HP", "DMG"];

/// What a card is assumed to be when nobody says otherwise.
pub const DEFAULT_CONDITION: &str = "NM";

/// What a write command says when it could not have the database.
///
/// A sentence rather than a lock error, and it names the wait: after the ingest was
/// chunked (Task 1) the only thing that can hold the connection for five seconds is
/// something genuinely stuck, and "try again in a moment" is both true and actionable.
pub const BUSY: &str = "The card database is busy finishing a sync. Try that again in a moment.";

/// One quick-add, as the UI sends it.
///
/// `#[serde(default)]` throughout: the popup sends the three fields it has (`cardId`,
/// `finish`, `quantity`) and the entry editor sends more. `lang`, `set_code` and
/// `collector_number` are deliberately *not* here — they are properties of the printing,
/// read from `cards` at write time, and letting a caller supply them would let a caller
/// disagree with the card it named.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryInput {
    pub card_id: String,
    pub finish: String,
    pub condition: Option<String>,
    pub condition_original: Option<String>,
    pub quantity: i64,
    pub tradelist_quantity: i64,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub altered: bool,
    pub signed: bool,
    pub proxy: bool,
    pub misprint: bool,
    /// `{"company":"PSA","grade":"9","cert":"12345678"}`, verbatim JSON.
    ///
    /// Verbatim because this column is part of the grain **as raw text** (see
    /// [`COLLECTION_GRAIN`]): the bytes are compared, not the JSON. Re-serialising it here
    /// through a `serde_json::Value` would put the keys in whatever order a map iterates
    /// in and fork the same slab into a new row on every edit. Whatever writes this — the
    /// grading form, the importer — owes it one fixed-field struct, serialized once, and
    /// this carries the answer through untouched.
    pub grading: Option<String>,
    /// A JSON array of strings. `None` means the row keeps whatever it has.
    pub tags: Option<String>,
    pub notes: Option<String>,
}

/// An edit to one existing row. Every field is optional: absent means "leave it".
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryPatch {
    pub finish: Option<String>,
    pub condition: Option<String>,
    pub quantity: Option<i64>,
    pub tradelist_quantity: Option<i64>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub altered: Option<bool>,
    pub signed: Option<bool>,
    pub proxy: Option<bool>,
    pub misprint: Option<bool>,
    pub grading: Option<String>,
    pub tags: Option<String>,
    pub notes: Option<String>,
}

/// What a write did. `removed` is the difference between "you now have zero" and "that row
/// is gone", which the list has to know to drop it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryChange {
    pub id: i64,
    pub quantity: i64,
    pub removed: bool,
}

fn valid_finish(finish: &str) -> Result<&str, String> {
    FINISHES.contains(&finish).then_some(finish).ok_or_else(|| {
        format!(
            "`{finish}` is not a finish. Use one of: {}.",
            FINISHES.join(", ")
        )
    })
}

fn valid_condition(condition: Option<&str>) -> Result<&str, String> {
    let c = condition.unwrap_or(DEFAULT_CONDITION);
    CONDITIONS.contains(&c).then_some(c).ok_or_else(|| {
        format!(
            "`{c}` is not a condition. Use one of: {}.",
            CONDITIONS.join(", ")
        )
    })
}

/// The printing, as the entry will remember it.
fn printing_of(conn: &Connection, card_id: &str) -> Result<(String, String, String), String> {
    conn.query_row(
        "SELECT set_code, collector_number, lang FROM cards WHERE id = ?1",
        params![card_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("no card with the id `{card_id}` is in the card database"))
}

/// Add copies, folding into the row that already holds this grain.
pub fn add_entry(conn: &Connection, input: &EntryInput) -> Result<EntryChange, String> {
    let finish = valid_finish(&input.finish)?;
    let condition = valid_condition(input.condition.as_deref())?;
    if input.quantity <= 0 {
        return Err("Adding a card needs a quantity of at least one.".into());
    }
    let (set_code, collector_number, lang) = printing_of(conn, &input.card_id)?;

    // The conflict target is `COLLECTION_GRAIN` verbatim — the same text the unique index
    // was created from. Anything else is a runtime "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint", which is why the fragment is a constant.
    //
    // The quantities add; everything else is a first-writer-wins detail. A second add of a
    // card you already own is the user saying "one more of these", not "and here is what I
    // paid for it this time" — so a purchase price, a source or a note already on the row
    // stays, and one supplied for a row that has none is taken.
    let sql = format!(
        "INSERT INTO collection_entries
            (card_id, set_code, collector_number, lang, finish, condition, condition_original,
             quantity, tradelist_quantity, purchase_price, purchase_currency, acquired_at,
             acquisition_source, serial_number, altered, signed, proxy, misprint, grading,
             tags, notes, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                 coalesce(?20,'[]'),?21, unixepoch(), unixepoch())
         ON CONFLICT({COLLECTION_GRAIN}) DO UPDATE SET
            quantity = collection_entries.quantity + excluded.quantity,
            tradelist_quantity =
                collection_entries.tradelist_quantity + excluded.tradelist_quantity,
            purchase_price = coalesce(collection_entries.purchase_price, excluded.purchase_price),
            purchase_currency =
                coalesce(collection_entries.purchase_currency, excluded.purchase_currency),
            acquired_at = coalesce(collection_entries.acquired_at, excluded.acquired_at),
            acquisition_source =
                coalesce(collection_entries.acquisition_source, excluded.acquisition_source),
            notes = coalesce(collection_entries.notes, excluded.notes),
            updated_at = unixepoch()
         RETURNING id, quantity"
    );
    let (id, quantity): (i64, i64) = conn
        .query_row(
            &sql,
            params![
                input.card_id,
                set_code,
                collector_number,
                lang,
                finish,
                condition,
                input.condition_original,
                input.quantity,
                input.tradelist_quantity,
                input.purchase_price,
                input.purchase_currency,
                input.acquired_at,
                input.acquisition_source,
                input.serial_number,
                input.altered,
                input.signed,
                input.proxy,
                input.misprint,
                input.grading,
                input.tags,
                input.notes,
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(friendly)?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Set an absolute quantity. Zero removes the row: a row of no cards is not a fact about a
/// collection, it is a row nobody deleted.
pub fn set_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String> {
    if quantity <= 0 {
        return remove_entry(conn, id);
    }
    let changed = conn
        .execute(
            "UPDATE collection_entries
                SET quantity = ?2,
                    -- A tradelist bigger than the pile it is drawn from is not a promise
                    -- anyone can keep.
                    tradelist_quantity = min(tradelist_quantity, ?2),
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![id, quantity],
        )
        .map_err(friendly)?;
    if changed == 0 {
        return Err("That collection entry is not there any more.".into());
    }
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Apply an edit. Absent fields are left alone (`coalesce(?n, column)`), which is what
/// makes this usable from a form that only sends what it changed.
pub fn update_entry(conn: &Connection, id: i64, patch: &EntryPatch) -> Result<EntryChange, String> {
    if let Some(f) = patch.finish.as_deref() {
        valid_finish(f)?;
    }
    if let Some(c) = patch.condition.as_deref() {
        valid_condition(Some(c))?;
    }
    if patch.quantity == Some(0) {
        return remove_entry(conn, id);
    }
    let quantity: i64 = conn
        .query_row(
            "UPDATE collection_entries SET
                finish = coalesce(?2, finish),
                condition = coalesce(?3, condition),
                quantity = coalesce(?4, quantity),
                tradelist_quantity = min(coalesce(?5, tradelist_quantity),
                                         coalesce(?4, quantity)),
                purchase_price = coalesce(?6, purchase_price),
                purchase_currency = coalesce(?7, purchase_currency),
                acquired_at = coalesce(?8, acquired_at),
                acquisition_source = coalesce(?9, acquisition_source),
                serial_number = coalesce(?10, serial_number),
                altered = coalesce(?11, altered),
                signed = coalesce(?12, signed),
                proxy = coalesce(?13, proxy),
                misprint = coalesce(?14, misprint),
                grading = coalesce(?15, grading),
                tags = coalesce(?16, tags),
                notes = coalesce(?17, notes),
                updated_at = unixepoch()
             WHERE id = ?1
             RETURNING quantity",
            params![
                id,
                patch.finish,
                patch.condition,
                patch.quantity,
                patch.tradelist_quantity,
                patch.purchase_price,
                patch.purchase_currency,
                patch.acquired_at,
                patch.acquisition_source,
                patch.serial_number,
                patch.altered,
                patch.signed,
                patch.proxy,
                patch.misprint,
                patch.grading,
                patch.tags,
                patch.notes,
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(friendly)?
        .ok_or_else(|| "That collection entry is not there any more.".to_owned())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

pub fn remove_entry(conn: &Connection, id: i64) -> Result<EntryChange, String> {
    conn.execute("DELETE FROM collection_entries WHERE id = ?1", params![id])
        .map_err(friendly)?;
    Ok(EntryChange {
        id,
        quantity: 0,
        removed: true,
    })
}

/// A database error in the app's own voice.
///
/// Only one of them is a user's problem rather than a bug: an edit that lands on a grain
/// the collection already holds. SQLite says "UNIQUE constraint failed:
/// index 'idx_collection_grain'", which names an implementation detail and no way forward.
fn friendly(e: rusqlite::Error) -> String {
    let text = e.to_string();
    if text.contains("idx_collection_grain") {
        return "You already have an entry for that printing at that finish and condition — \
                change its quantity instead, or give this one a different condition."
            .to_owned();
    }
    text
}

/// Run `f` with the write connection, or answer [`BUSY`].
///
/// Bounded rather than blocking: this runs on a worker thread from a button press, and the
/// one thing that can hold `AppState.db` for any length of time is a sync — which, since
/// the ingest was chunked, holds it for one batch at a time.
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(BUSY.to_owned()),
    }
}

#[tauri::command]
pub async fn collection_add(
    state: tauri::State<'_, Arc<AppState>>,
    entry: EntryInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| add_entry(c, &entry)))
        .await
        .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_set_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_quantity(c, id, quantity))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    patch: EntryPatch,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| update_entry(c, id, &patch))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| remove_entry(c, id)))
        .await
        .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,finishes,prices,raw)
             VALUES ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                '[\"nonfoil\"]',
                '{\"usd\":\"400.50\",\"usd_foil\":null,\"eur\":\"320.00\"}','{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,finishes,prices,raw)
             VALUES ('bolt-jp','o1','Lightning Bolt','4ed','209','ja','normal','common',
                '[\"nonfoil\",\"foil\"]','{\"usd\":\"12.00\",\"usd_foil\":\"90.00\"}','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn input(card_id: &str, finish: &str, quantity: i64) -> EntryInput {
        EntryInput {
            card_id: card_id.to_owned(),
            finish: finish.to_owned(),
            quantity,
            ..Default::default()
        }
    }

    /// The whole quick-add contract: the same printing, finish and condition twice is one
    /// row with a bigger number, not two rows a collection view would show side by side.
    #[test]
    fn adding_the_same_printing_twice_adds_to_the_row_that_is_already_there() {
        let conn = seeded();

        let first = add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        let second = add_entry(&conn, &input("bolt-lea", "nonfoil", 3)).unwrap();

        assert_eq!(first.id, second.id, "the same grain is the same row");
        assert_eq!(second.quantity, 5);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    /// The printing is denormalised *at write time*, from `cards` — which is the only
    /// moment it is knowable. After the next sync drops and rebuilds that table, this row
    /// is still a Japanese Fourth Edition Lightning Bolt whatever happens to the id.
    #[test]
    fn an_entry_records_the_printing_it_was_made_from() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();

        let (set, cn, lang): (String, String, String) = conn
            .query_row(
                "SELECT set_code, collector_number, lang FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            (set.as_str(), cn.as_str(), lang.as_str()),
            ("4ed", "209", "ja")
        );
    }

    /// Different finish, different condition, different flags, different serial: four
    /// different physical things, four rows. This is the grain in the language a user
    /// would use for it.
    #[test]
    fn copies_that_differ_in_the_grain_are_separate_rows() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();
        add_entry(
            &conn,
            &EntryInput {
                condition: Some("LP".into()),
                ..input("bolt-jp", "foil", 1)
            },
        )
        .unwrap();
        add_entry(
            &conn,
            &EntryInput {
                signed: true,
                ..input("bolt-jp", "foil", 1)
            },
        )
        .unwrap();
        add_entry(
            &conn,
            &EntryInput {
                serial_number: Some("042/500".into()),
                ..input("bolt-jp", "foil", 1)
            },
        )
        .unwrap();

        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 5);
    }

    /// The enum, refused in words rather than as a constraint violation the UI would have
    /// to translate. `"Foil"` is what an import writes and what a boolean would have
    /// flattened; it is not a finish.
    #[test]
    fn an_unknown_finish_or_condition_is_refused_with_a_sentence() {
        let conn = seeded();
        let bad_finish = add_entry(
            &conn,
            &EntryInput {
                finish: "Foil".into(),
                ..input("bolt-lea", "foil", 1)
            },
        )
        .unwrap_err();
        assert!(bad_finish.contains("nonfoil"), "{bad_finish}");

        let bad_condition = add_entry(
            &conn,
            &EntryInput {
                condition: Some("Near Mint".into()),
                ..input("bolt-lea", "nonfoil", 1)
            },
        )
        .unwrap_err();
        assert!(bad_condition.contains("NM"), "{bad_condition}");
    }

    /// An id with no card behind it is a bug in the caller, not a card nobody has heard
    /// of: every add starts from a printing the user is looking at.
    #[test]
    fn adding_an_unknown_card_id_is_an_error_not_an_empty_row() {
        let conn = seeded();
        let err = add_entry(&conn, &input("no-such-card", "nonfoil", 1)).unwrap_err();
        assert!(err.contains("no card"), "{err}");
    }

    /// Zero is not a quantity, it is a removal — and the stepper in the collection table
    /// is the only thing that ever sends it. A row of zero copies would sit in the list
    /// forever answering "none".
    #[test]
    fn setting_a_quantity_to_zero_removes_the_row() {
        let conn = seeded();
        let added = add_entry(&conn, &input("bolt-lea", "nonfoil", 3)).unwrap();

        let lowered = set_quantity(&conn, added.id, 1).unwrap();
        assert_eq!((lowered.quantity, lowered.removed), (1, false));

        let gone = set_quantity(&conn, added.id, 0).unwrap();
        assert!(gone.removed);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// Editing a row onto a grain that already exists is the one edit that cannot just be
    /// applied. Answering with the constraint name would be the database talking; this is
    /// the app talking, and it names the way out.
    #[test]
    fn editing_a_row_onto_an_existing_grain_says_what_to_do_instead() {
        let conn = seeded();
        let nonfoil = add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();

        let err = update_entry(
            &conn,
            nonfoil.id,
            &EntryPatch {
                finish: Some("foil".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("already have"), "{err}");
    }

    /// `src/lib/ipc.ts` mirrors this by hand and nothing checks that the two still agree.
    #[test]
    fn entry_change_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(EntryChange {
            id: 7,
            quantity: 3,
            removed: false,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"id": 7, "quantity": 3, "removed": false})
        );
    }

    /// `invoke` matches argument names, and the payload the popup sends omits every field
    /// it has no value for — so every one of them has to have a default.
    #[test]
    fn a_partial_camel_case_payload_deserialises_into_a_usable_entry() {
        let input: EntryInput =
            serde_json::from_str(r#"{"cardId":"bolt-lea","finish":"foil","quantity":2}"#).unwrap();
        assert_eq!(input.card_id, "bolt-lea");
        assert_eq!(input.condition, None, "absent means the default, NM");
        assert!(!input.altered && !input.signed && !input.proxy && !input.misprint);

        let conn = seeded();
        let change = add_entry(&conn, &input).unwrap();
        let condition: String = conn
            .query_row(
                "SELECT condition FROM collection_entries WHERE id = ?1",
                [change.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(condition, DEFAULT_CONDITION);
    }
}
