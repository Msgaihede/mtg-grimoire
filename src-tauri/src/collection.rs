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

/// What an *adjustment* says when the row it names is not there — an edit that could not be
/// applied, unlike a delete that finds nothing (see [`remove_entry`]).
pub const GONE: &str = "That collection entry is not there any more.";

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
    /// `{"company":"PSA","grade":"9","cert":"12345678"}` as JSON text, canonicalised
    /// through [`Grading`] before it is stored. See that struct for why it cannot be
    /// stored as it arrived.
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
    /// Editable, because the normalisation that produced `condition` is lossy (EU `GD` and
    /// NA `MP` arrive as one grade) and correcting the grade without correcting the record
    /// of what the file said would leave the row disagreeing with its own provenance.
    pub condition_original: Option<String>,
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

/// A graded slab: the **one** struct that owns the shape of the `grading` column.
///
/// [`COLLECTION_GRAIN`] compares this column byte for byte rather than as JSON, so
/// `{"company":"PSA","grade":10}` and `{"grade":10,"company":"PSA"}` describe one slab and
/// would be two rows — the same physical card forking on every edit, silently, with no
/// constraint anywhere to catch it. `json_valid` is enforced by the table's CHECK;
/// *canonical* is enforced by nothing but this type, so everything that reaches the column
/// is parsed into it and re-serialised out of it. Key order stops being something a caller
/// can get wrong.
///
/// Field order is therefore load-bearing, and so is `skip_serializing_if` on `cert`: an
/// absent cert and an explicit `"cert": null` are the same slab and must not be two rows.
///
/// Scalars are normalised to strings because a grade genuinely arrives as both — `10` in
/// the schema's own examples, `"9"` from a text input — and `10` and `"10"` are one grade.
/// Spec §6 fixes the shape at `{company, grade, cert}` and puts richer slab tracking out of
/// scope, so an unknown key is refused rather than dropped: silently canonicalising away
/// something the user typed is worse than saying it does not belong.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Grading {
    #[serde(deserialize_with = "scalar_string")]
    pub company: String,
    #[serde(deserialize_with = "scalar_string")]
    pub grade: String,
    #[serde(
        default,
        deserialize_with = "optional_scalar_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub cert: Option<String>,
}

/// A JSON string or number, both read as the text they mean.
#[derive(Deserialize)]
#[serde(untagged)]
enum Scalar {
    Text(String),
    Number(serde_json::Number),
}

impl Scalar {
    fn into_string(self) -> String {
        match self {
            Scalar::Text(s) => s.trim().to_owned(),
            Scalar::Number(n) => n.to_string(),
        }
    }
}

fn scalar_string<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(Scalar::deserialize(d)?.into_string())
}

fn optional_scalar_string<'de, D: serde::Deserializer<'de>>(
    d: D,
) -> Result<Option<String>, D::Error> {
    Ok(Option::<Scalar>::deserialize(d)?
        .map(Scalar::into_string)
        .filter(|s| !s.is_empty()))
}

/// `grading` as the column must hold it: canonical text, or nothing at all.
///
/// Blank is `None` rather than an error — an empty field on a form means "no slab", and
/// the grain's `coalesce(grading, '')` already reads `''` and NULL as the same thing, so
/// letting `""` through would only be a second spelling of nothing.
fn canonical_grading(grading: Option<&str>) -> Result<Option<String>, String> {
    let Some(text) = grading.map(str::trim).filter(|t| !t.is_empty()) else {
        return Ok(None);
    };
    let refuse = |why: String| {
        format!(
            "`{text}` is not a grading ({why}). It needs a company and a grade, and may have a \
             cert — like {{\"company\":\"PSA\",\"grade\":\"10\",\"cert\":\"12345678\"}}."
        )
    };
    // Through a `Value` for one purpose only: a `#[derive(Deserialize)]` struct also reads
    // itself from a *sequence* — that is how the compact binary formats address it — so
    // `["PSA", 10]` would otherwise deserialize as happily as the object does, and the wire
    // would have two spellings for one slab. Spec §6 fixes the shape at an object. The
    // canonical text below still comes from the struct in declaration order; nothing is ever
    // re-serialized out of this `Value`, which is the whole point of the exercise.
    let value: serde_json::Value = serde_json::from_str(text).map_err(|e| refuse(e.to_string()))?;
    if !value.is_object() {
        return Err(refuse("it is not a JSON object".to_owned()));
    }
    let slab: Grading = serde_json::from_value(value).map_err(|e| refuse(e.to_string()))?;
    serde_json::to_string(&slab)
        .map(Some)
        .map_err(|e| format!("that grading could not be stored: {e}"))
}

/// A quantity the database will accept, refused in words rather than as a CHECK failure.
///
/// **Zero is allowed, and keeps the row.** A stepper taken to zero leaves the entry with
/// its condition, its purchase price, its tags and its acquisition story intact — the user
/// still owns that story on the day they own none of the card. Deleting is [`remove_entry`]
/// and only ever [`remove_entry`]; a negative number is not a quantity and must never be a
/// back door to one.
fn valid_quantity(n: i64, what: &str) -> Result<i64, String> {
    (n >= 0)
        .then_some(n)
        .ok_or_else(|| format!("{n} is not a quantity. A {what} cannot be less than zero."))
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
    // Not `valid_quantity`: *adding* zero copies is a no-op dressed as a write, and would
    // conjure a row out of nothing on a card the user never said they had. Zero is a state
    // a row can be moved to (`set_quantity`), never a state it can be created in.
    if input.quantity <= 0 {
        return Err("Adding a card needs a quantity of at least one.".into());
    }
    valid_quantity(input.tradelist_quantity, "tradelist quantity")?;
    let grading = canonical_grading(input.grading.as_deref())?;
    let (set_code, collector_number, lang) = printing_of(conn, &input.card_id)?;

    // The conflict target is `COLLECTION_GRAIN` verbatim — the same text the unique index
    // was created from. Anything else is a runtime "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint", which is why the fragment is a constant.
    //
    // The quantities add; everything else is a first-writer-wins detail. A second add of a
    // card you already own is the user saying "one more of these", not "and here is what I
    // paid for it this time" — so a purchase price, a source or a note already on the row
    // stays, and one supplied for a row that has none is taken.
    //
    // `tags` and `condition_original` are deliberately not in the `DO UPDATE` at all, and
    // for opposite reasons. Tags are a set the user curates on the row; folding a quick-add's
    // (usually empty) tags in would either wipe that set or need a merge this statement is
    // the wrong place for. `condition_original` is the *provenance* of the condition already
    // on the row — the string the first import used — and a later add cannot retroactively
    // change what an earlier file said. Both stay as they are; the entry editor is where
    // they change, through `update_entry`.
    //
    // `tradelist_quantity` is clamped to `quantity` in both arms: a tradelist bigger than
    // the pile it is drawn from is not a promise anyone can keep, and the importer is the
    // caller that will send one. `set_quantity` and `update_entry` already enforce it.
    let sql = format!(
        "INSERT INTO collection_entries
            (card_id, set_code, collector_number, lang, finish, condition, condition_original,
             quantity, tradelist_quantity, purchase_price, purchase_currency, acquired_at,
             acquisition_source, serial_number, altered, signed, proxy, misprint, grading,
             tags, notes, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,min(?9,?8),?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                 coalesce(?20,'[]'),?21, unixepoch(), unixepoch())
         ON CONFLICT({COLLECTION_GRAIN}) DO UPDATE SET
            quantity = collection_entries.quantity + excluded.quantity,
            tradelist_quantity =
                min(collection_entries.tradelist_quantity + excluded.tradelist_quantity,
                    collection_entries.quantity + excluded.quantity),
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
                grading,
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

/// Set an absolute quantity. **Zero keeps the row.**
///
/// The stepper in the collection table is what sends this, and taking it to zero is the
/// user saying "I have none of these today", not "forget everything I recorded about
/// them". The condition, the purchase price and currency, the acquisition date and source,
/// the tags and the notes are all still true of the copies that were traded away, and are
/// all still there when the next one turns up. Removal is [`remove_entry`], reached only by
/// the explicit action, so a slip of a stepper can never lose a story that took years to
/// accumulate.
///
/// The consequence belongs to whatever reads this table: a zero row is a real row, so a
/// "cards owned" figure that counts rows rather than summing quantity is wrong the first
/// time somebody trades a playset away. See `collection_entries`' schema comment.
pub fn set_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String> {
    valid_quantity(quantity, "collection quantity")?;
    let changed = conn
        .execute(
            "UPDATE collection_entries
                SET quantity = ?2,
                    -- A tradelist bigger than the pile it is drawn from is not a promise
                    -- anyone can keep — and at zero copies there is nothing to offer.
                    tradelist_quantity = min(tradelist_quantity, ?2),
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![id, quantity],
        )
        .map_err(friendly)?;
    if changed == 0 {
        return Err(GONE.to_owned());
    }
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Apply an edit. Absent fields are left alone (`coalesce(?n, column)`), which is what
/// makes this usable from a form that only sends what it changed.
///
/// A `quantity` of zero is applied like any other, for the reason [`set_quantity`] gives:
/// this is an edit form, and nothing a user types into a number field should delete the row
/// they are editing.
pub fn update_entry(conn: &Connection, id: i64, patch: &EntryPatch) -> Result<EntryChange, String> {
    if let Some(f) = patch.finish.as_deref() {
        valid_finish(f)?;
    }
    if let Some(c) = patch.condition.as_deref() {
        valid_condition(Some(c))?;
    }
    if let Some(q) = patch.quantity {
        valid_quantity(q, "collection quantity")?;
    }
    if let Some(t) = patch.tradelist_quantity {
        valid_quantity(t, "tradelist quantity")?;
    }
    let grading = canonical_grading(patch.grading.as_deref())?;
    let quantity: i64 = conn
        .query_row(
            "UPDATE collection_entries SET
                finish = coalesce(?2, finish),
                condition = coalesce(?3, condition),
                condition_original = coalesce(?4, condition_original),
                quantity = coalesce(?5, quantity),
                tradelist_quantity = min(coalesce(?6, tradelist_quantity),
                                         coalesce(?5, quantity)),
                purchase_price = coalesce(?7, purchase_price),
                purchase_currency = coalesce(?8, purchase_currency),
                acquired_at = coalesce(?9, acquired_at),
                acquisition_source = coalesce(?10, acquisition_source),
                serial_number = coalesce(?11, serial_number),
                altered = coalesce(?12, altered),
                signed = coalesce(?13, signed),
                proxy = coalesce(?14, proxy),
                misprint = coalesce(?15, misprint),
                grading = coalesce(?16, grading),
                tags = coalesce(?17, tags),
                notes = coalesce(?18, notes),
                updated_at = unixepoch()
             WHERE id = ?1
             RETURNING quantity",
            params![
                id,
                patch.finish,
                patch.condition,
                patch.condition_original,
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
                grading,
                patch.tags,
                patch.notes,
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(friendly)?
        .ok_or_else(|| GONE.to_owned())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Delete the row outright — the **only** thing in this module that deletes anything.
///
/// Deliberately asymmetric with [`set_quantity`] and [`update_entry`], which answer [`GONE`]
/// for an id that resolves to nothing: an adjustment to a row that is not there could not do
/// what it was asked, but a delete that finds nothing already has what it wanted. The caller
/// that sends a stale id here is a list still holding a row something else removed, and
/// telling it the row it wants gone is gone is not information — it is an error dialog over
/// a success.
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

    /// Zero is a real state, not a removal. A stepper taken to zero is "I have none of
    /// these today" — the condition, the price paid, the tags and the story of where it
    /// came from are all still true of the copies that were traded away, and are all still
    /// there when the next one turns up. Only the explicit remove deletes.
    #[test]
    fn a_quantity_of_zero_keeps_the_row_and_everything_recorded_on_it() {
        let conn = seeded();
        let added = add_entry(
            &conn,
            &EntryInput {
                purchase_price: Some(12.5),
                acquisition_source: Some("Local shop".into()),
                tags: Some(r#"["cube"]"#.into()),
                tradelist_quantity: 2,
                ..input("bolt-lea", "nonfoil", 3)
            },
        )
        .unwrap();

        let lowered = set_quantity(&conn, added.id, 1).unwrap();
        assert_eq!((lowered.quantity, lowered.removed), (1, false));

        let emptied = set_quantity(&conn, added.id, 0).unwrap();
        assert_eq!((emptied.quantity, emptied.removed), (0, false));

        let (rows, qty, tradelist, price, source, tags): (i64, i64, i64, f64, String, String) =
            conn.query_row(
                "SELECT count(*), quantity, tradelist_quantity, purchase_price,
                        acquisition_source, tags
                 FROM collection_entries",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(rows, 1, "the row survives its own emptiness");
        assert_eq!(qty, 0);
        assert_eq!(tradelist, 0, "nothing to offer from a pile of none");
        assert_eq!(
            (price, source.as_str(), tags.as_str()),
            (12.5, "Local shop", r#"["cube"]"#)
        );

        // The edit form sends zero the same way, and an edit form must never delete the row
        // being edited.
        update_entry(
            &conn,
            added.id,
            &EntryPatch {
                quantity: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        let still: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(still, 1);

        // And the one thing that does delete, does.
        let gone = remove_entry(&conn, added.id).unwrap();
        assert!(gone.removed);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// Below zero is not a quantity at all, and must never be the back door to the deletion
    /// zero stopped being.
    #[test]
    fn a_negative_quantity_is_refused_and_never_deletes_anything() {
        let conn = seeded();
        let added = add_entry(&conn, &input("bolt-lea", "nonfoil", 3)).unwrap();

        for err in [
            set_quantity(&conn, added.id, -1).unwrap_err(),
            update_entry(
                &conn,
                added.id,
                &EntryPatch {
                    quantity: Some(-1),
                    ..Default::default()
                },
            )
            .unwrap_err(),
            update_entry(
                &conn,
                added.id,
                &EntryPatch {
                    tradelist_quantity: Some(-2),
                    ..Default::default()
                },
            )
            .unwrap_err(),
        ] {
            assert!(err.contains("not a quantity"), "{err}");
            // Not the database's own voice: a CHECK failure names `quantity >= 0` and a
            // constraint the reader has no way to act on.
            assert!(!err.contains("CHECK"), "{err}");
        }

        let (rows, qty): (i64, i64) = conn
            .query_row(
                "SELECT count(*), quantity FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, qty), (1, 3), "a refused write changes nothing");
    }

    /// The grain compares `grading` as raw text, so the same slab written with its keys in
    /// a different order — a different JSON serialiser, a hand-built string, a map that
    /// iterates however it likes — would fork one physical card into a second row, silently,
    /// with no constraint anywhere to catch it. Canonicalising at this boundary is what
    /// makes that impossible rather than merely discouraged.
    #[test]
    fn the_same_slab_written_two_ways_is_one_row() {
        let conn = seeded();
        let graded = |grading: &str| {
            add_entry(
                &conn,
                &EntryInput {
                    grading: Some(grading.to_owned()),
                    ..input("bolt-lea", "nonfoil", 1)
                },
            )
        };

        let first = graded(r#"{"company":"PSA","grade":10,"cert":"12345678"}"#).unwrap();
        // Keys reordered, the grade as a string rather than a number, and whitespace: one
        // slab, described three ways it might genuinely arrive.
        let second = graded(r#"{ "cert": "12345678", "grade": "10", "company": "PSA" }"#).unwrap();
        assert_eq!(first.id, second.id, "the same slab is the same row");
        assert_eq!(second.quantity, 2);

        // An absent cert and an explicit null are also one slab — `skip_serializing_if`.
        let bare = graded(r#"{"company":"PSA","grade":10}"#).unwrap();
        let null_cert = graded(r#"{"grade":10,"cert":null,"company":"PSA"}"#).unwrap();
        assert_eq!(bare.id, null_cert.id);
        assert_ne!(
            bare.id, first.id,
            "a certified slab is not an uncertified one"
        );

        // Stored canonically, in declaration order, whatever order it arrived in.
        let stored: Vec<String> = conn
            .prepare("SELECT grading FROM collection_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            stored,
            vec![
                r#"{"company":"PSA","grade":"10","cert":"12345678"}"#.to_owned(),
                r#"{"company":"PSA","grade":"10"}"#.to_owned(),
            ]
        );

        // A grader is not a company name away from being the same slab, either.
        graded(r#"{"company":"CGC","grade":10}"#).unwrap();
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 3);
    }

    /// A grading the struct cannot account for is refused in a sentence naming the shape,
    /// rather than by the table's `json_valid` CHECK (which lets `{"nonsense":1}` straight
    /// through) or by nothing at all. An unknown key is an error and not a silent drop:
    /// canonicalising away something the user typed is worse than saying it does not belong.
    #[test]
    fn a_grading_that_is_not_a_grading_is_refused_with_a_sentence() {
        let conn = seeded();
        for bad in [
            "not json at all",
            r#"{"company":"PSA"}"#,
            r#"{"grade":10}"#,
            r#"{"company":"PSA","grade":10,"subgrades":{"centering":9}}"#,
            r#"["PSA", 10]"#,
        ] {
            let err = add_entry(
                &conn,
                &EntryInput {
                    grading: Some(bad.to_owned()),
                    ..input("bolt-lea", "nonfoil", 1)
                },
            )
            .unwrap_err();
            assert!(err.contains("is not a grading"), "{bad}: {err}");
            assert!(err.contains("company"), "{bad}: {err}");
        }
        // The same guard on the edit path, which is the one that can fork an existing row.
        let added = add_entry(&conn, &input("bolt-lea", "nonfoil", 1)).unwrap();
        let err = update_entry(
            &conn,
            added.id,
            &EntryPatch {
                grading: Some("{}".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("is not a grading"), "{err}");

        // Nothing but the one legitimate add landed.
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    /// A tradelist bigger than the pile it is drawn from is not a promise anyone can keep.
    /// `set_quantity` and `update_entry` clamp already; the importer is the caller that will
    /// send one to `add_entry`, on the insert and on the fold alike.
    #[test]
    fn a_tradelist_can_never_be_larger_than_the_pile_it_comes_from() {
        let conn = seeded();
        let over = |quantity: i64, tradelist: i64| {
            add_entry(
                &conn,
                &EntryInput {
                    tradelist_quantity: tradelist,
                    ..input("bolt-lea", "nonfoil", quantity)
                },
            )
            .unwrap()
        };

        over(2, 5);
        let clamped: i64 = conn
            .query_row(
                "SELECT tradelist_quantity FROM collection_entries",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(clamped, 2, "the insert clamps");

        // The fold: 2 + 1 copies against 2 + 4 offered.
        over(1, 4);
        let (qty, tradelist): (i64, i64) = conn
            .query_row(
                "SELECT quantity, tradelist_quantity FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((qty, tradelist), (3, 3), "the fold clamps too");

        let err = add_entry(
            &conn,
            &EntryInput {
                tradelist_quantity: -1,
                ..input("bolt-lea", "nonfoil", 1)
            },
        )
        .unwrap_err();
        assert!(err.contains("not a quantity"), "{err}");
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

    /// Every field of the add payload, under the exact name the frontend sends.
    ///
    /// This is the one contract nothing else can catch. `#[serde(default)]` means an
    /// unrecognised key is silently ignored, so a name that does not match — a `serialNo`
    /// for a `serialNumber`, a `rename_all` lost in a refactor — is not an error anywhere:
    /// it is a **dropped grain column**, and the card the user marked as serialised folds
    /// into the row of the one they did not. `src/lib/ipc.ts` mirrors these by hand.
    ///
    /// Two things give it teeth. Every value is non-default, so a field that quietly failed
    /// to arrive reads as its default and fails a line below. And the result is
    /// *destructured without a `..`*, so a field added to `EntryInput` and never mirrored on
    /// the wire fails to compile here rather than defaulting silently for the rest of time.
    #[test]
    fn every_entry_input_field_arrives_under_the_name_the_frontend_sends() {
        let payload = serde_json::json!({
            "cardId": "bolt-jp",
            "finish": "etched",
            "condition": "MP",
            "conditionOriginal": "GD",
            "quantity": 4,
            "tradelistQuantity": 2,
            "purchasePrice": 12.5,
            "purchaseCurrency": "USD",
            "acquiredAt": "2020-05-01",
            "acquisitionSource": "Local shop",
            "serialNumber": "042/500",
            "altered": true,
            "signed": true,
            "proxy": true,
            "misprint": true,
            "grading": r#"{"company":"PSA","grade":10}"#,
            "tags": r#"["cube"]"#,
            "notes": "the good one"
        });
        let EntryInput {
            card_id,
            finish,
            condition,
            condition_original,
            quantity,
            tradelist_quantity,
            purchase_price,
            purchase_currency,
            acquired_at,
            acquisition_source,
            serial_number,
            altered,
            signed,
            proxy,
            misprint,
            grading,
            tags,
            notes,
        } = serde_json::from_value(payload).unwrap();

        assert_eq!(card_id, "bolt-jp");
        assert_eq!(finish, "etched");
        assert_eq!(condition.as_deref(), Some("MP"));
        assert_eq!(condition_original.as_deref(), Some("GD"));
        assert_eq!(quantity, 4);
        assert_eq!(tradelist_quantity, 2);
        assert_eq!(purchase_price, Some(12.5));
        assert_eq!(purchase_currency.as_deref(), Some("USD"));
        assert_eq!(acquired_at.as_deref(), Some("2020-05-01"));
        assert_eq!(acquisition_source.as_deref(), Some("Local shop"));
        assert_eq!(serial_number.as_deref(), Some("042/500"));
        assert!(altered && signed && proxy && misprint);
        assert_eq!(grading.as_deref(), Some(r#"{"company":"PSA","grade":10}"#));
        assert_eq!(tags.as_deref(), Some(r#"["cube"]"#));
        assert_eq!(notes.as_deref(), Some("the good one"));
    }

    /// The edit payload, pinned exactly as the add payload is and for a sharper reason: a
    /// name that does not match here is a **silent no-op edit**. `coalesce(?n, column)`
    /// reads the resulting `None` as "leave it", so the write succeeds, the command answers
    /// `Ok`, the form closes — and nothing changed.
    #[test]
    fn every_entry_patch_field_arrives_under_the_name_the_frontend_sends() {
        let payload = serde_json::json!({
            "finish": "etched",
            "condition": "MP",
            "conditionOriginal": "GD",
            "quantity": 4,
            "tradelistQuantity": 2,
            "purchasePrice": 12.5,
            "purchaseCurrency": "USD",
            "acquiredAt": "2020-05-01",
            "acquisitionSource": "Local shop",
            "serialNumber": "042/500",
            "altered": true,
            "signed": true,
            "proxy": true,
            "misprint": true,
            "grading": r#"{"company":"PSA","grade":10}"#,
            "tags": r#"["cube"]"#,
            "notes": "the good one"
        });
        let EntryPatch {
            finish,
            condition,
            condition_original,
            quantity,
            tradelist_quantity,
            purchase_price,
            purchase_currency,
            acquired_at,
            acquisition_source,
            serial_number,
            altered,
            signed,
            proxy,
            misprint,
            grading,
            tags,
            notes,
        } = serde_json::from_value(payload).unwrap();

        assert_eq!(finish.as_deref(), Some("etched"));
        assert_eq!(condition.as_deref(), Some("MP"));
        assert_eq!(condition_original.as_deref(), Some("GD"));
        assert_eq!(quantity, Some(4));
        assert_eq!(tradelist_quantity, Some(2));
        assert_eq!(purchase_price, Some(12.5));
        assert_eq!(purchase_currency.as_deref(), Some("USD"));
        assert_eq!(acquired_at.as_deref(), Some("2020-05-01"));
        assert_eq!(acquisition_source.as_deref(), Some("Local shop"));
        assert_eq!(serial_number.as_deref(), Some("042/500"));
        assert_eq!(
            (altered, signed, proxy, misprint),
            (Some(true), Some(true), Some(true), Some(true))
        );
        assert_eq!(grading.as_deref(), Some(r#"{"company":"PSA","grade":10}"#));
        assert_eq!(tags.as_deref(), Some(r#"["cube"]"#));
        assert_eq!(notes.as_deref(), Some("the good one"));
    }

    /// Every one of those names has to reach a *column*, not just a struct field. The patch
    /// is applied whole and read back, so a field parsed correctly and then dropped from the
    /// `UPDATE` — the way `condition_original` was — fails here.
    #[test]
    fn a_whole_patch_reaches_every_column_it_names() {
        let conn = seeded();
        let added = add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();
        update_entry(
            &conn,
            added.id,
            &EntryPatch {
                finish: Some("etched".into()),
                condition: Some("MP".into()),
                condition_original: Some("GD".into()),
                quantity: Some(4),
                tradelist_quantity: Some(2),
                purchase_price: Some(12.5),
                purchase_currency: Some("USD".into()),
                acquired_at: Some("2020-05-01".into()),
                acquisition_source: Some("Local shop".into()),
                serial_number: Some("042/500".into()),
                altered: Some(true),
                signed: Some(true),
                proxy: Some(true),
                misprint: Some(true),
                grading: Some(r#"{"company":"PSA","grade":10}"#.into()),
                tags: Some(r#"["cube"]"#.into()),
                notes: Some("the good one".into()),
            },
        )
        .unwrap();

        let row: (
            String,
            String,
            String,
            i64,
            i64,
            f64,
            String,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT finish, condition, condition_original, quantity, tradelist_quantity,
                        purchase_price, purchase_currency, acquired_at, acquisition_source,
                        serial_number
                 FROM collection_entries",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                        r.get(8)?,
                        r.get(9)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "etched".to_owned(),
                "MP".to_owned(),
                "GD".to_owned(),
                4,
                2,
                12.5,
                "USD".to_owned(),
                "2020-05-01".to_owned(),
                "Local shop".to_owned(),
                "042/500".to_owned()
            )
        );
        let (altered, signed, proxy, misprint, grading, tags, notes): (
            bool,
            bool,
            bool,
            bool,
            String,
            String,
            String,
        ) = conn
            .query_row(
                "SELECT altered, signed, proxy, misprint, grading, tags, notes
                 FROM collection_entries",
                [],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                    ))
                },
            )
            .unwrap();
        assert!(altered && signed && proxy && misprint);
        // Canonicalised on the way in, here as everywhere else.
        assert_eq!(grading, r#"{"company":"PSA","grade":"10"}"#);
        assert_eq!(tags, r#"["cube"]"#);
        assert_eq!(notes, "the good one");
    }

    /// The bound is the whole point: a write that cannot have the database answers a
    /// sentence rather than holding a button down until a sync finishes. It waits its full
    /// [`crate::db::WRITE_LOCK_WAIT`] first — a lock that frees in 200 ms should be taken,
    /// not refused — and then stops.
    #[test]
    fn a_write_that_cannot_have_the_database_says_so_rather_than_waiting_forever() {
        let state = std::sync::Arc::new(AppState {
            db: std::sync::Mutex::new(Connection::open_in_memory().unwrap()),
            db_read: std::sync::Mutex::new(Connection::open_in_memory().unwrap()),
            data_dir: std::path::PathBuf::from("D:\\app\\data"),
            syncing: std::sync::atomic::AtomicBool::new(true),
            // Neither is ever touched: this test stops at the lock.
            client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            images: crate::images::Cache::new(std::path::PathBuf::from("D:\\app\\data\\images")),
        });

        let held = crate::db::lock_blocking(&state.db);
        let started = std::time::Instant::now();
        let answer = with_write(&state, |_| Ok::<_, String>("never runs"));
        let waited = started.elapsed();
        drop(held);

        assert_eq!(answer.unwrap_err(), BUSY);
        assert!(
            waited >= crate::db::WRITE_LOCK_WAIT,
            "a lock that frees in a moment must still be taken, but gave up after {waited:?}"
        );
        assert!(
            waited < crate::db::WRITE_LOCK_WAIT * 2,
            "the wait is bounded, and took {waited:?}"
        );
        // And the connection is usable the moment it is free again.
        assert!(
            with_write(&state, |c| add_entry(c, &input("nope", "foil", 1))
                .map(|_| ()))
            .is_err()
        );
    }
}
