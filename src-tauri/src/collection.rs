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
/// normalised into this one at the edge — see `src/lib/conditions.ts` — and the string it
/// arrived as is kept in `condition_original`.
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

/// What an *add* says when it was asked for no copies.
///
/// One sentence for two tables, because it is one rule: adding zero copies is a no-op
/// dressed as a write, and it would conjure a row out of nothing — a card the user never
/// said they had here, an intention they never expressed in [`crate::deck::add_card`].
/// Zero is a state a row can be moved to ([`set_quantity`]), never one it can be created
/// in. A second copy of the sentence is a second thing to drift.
pub const ZERO_ADD: &str = "Adding a card needs a quantity of at least one.";

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
/// **Zero is allowed here, and keeps the row.** A stepper taken to zero leaves the entry
/// with its condition, its purchase price, its tags and its acquisition story intact — the
/// user still owns that story on the day they own none of the card. Deleting is
/// [`remove_entry`] and only ever [`remove_entry`]; a negative number is not a quantity and
/// must never be a back door to one.
///
/// `what` names the field, so the one message serves every caller. The wishlist shares it
/// (`crate::wishlist::set_wish_quantity`) for the *negative* half only — its zero is a
/// removal, because `wishlist_entries` carries `CHECK (quantity > 0)` and a wish holds
/// nothing worth keeping once emptied. Both refuse below zero for the same reason, and
/// there is no second wording of it.
pub(crate) fn valid_quantity(n: i64, what: &str) -> Result<i64, String> {
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
        return Err(ZERO_ADD.to_owned());
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

/// [`with_write`], plus the facet index's `owned` dimension re-read afterwards.
///
/// Every command in this module that changes what the user owns goes through here, because
/// `owned` is the one index dimension a user moves without a sync — and an index that
/// disagrees with the collection greys out "Owned" for a card they have just added.
///
/// **After the write lock is gone, never inside it.** [`with_write`] returns before this runs,
/// which is the house rule that a command must not do its remaining work while holding its own
/// guard: 10–23 ms of re-read under the write connection is 10–23 ms of every other writer
/// waiting, for work that reads through a connection of its own and needs no lock at all.
///
/// Only on success. A refusal — [`BUSY`], [`GONE`], a rejected quantity — changed nothing, and
/// re-reading after one would be a copy of the whole index to arrive at the same answer.
fn with_write_owned<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = with_write(state, f);
    if answer.is_ok() {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}

#[tauri::command]
pub async fn collection_add(
    state: tauri::State<'_, Arc<AppState>>,
    entry: EntryInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write_owned(&state, |c| add_entry(c, &entry)))
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
        with_write_owned(&state, |c| set_quantity(c, id, quantity))
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
        with_write_owned(&state, |c| update_entry(c, id, &patch))
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
    tauri::async_runtime::spawn_blocking(move || with_write_owned(&state, |c| remove_entry(c, id)))
        .await
        .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// What one owned card is worth in USD, read from the `prices` blob **by finish**.
///
/// Never `cards.price_usd`: that column is a display/sort fallback chain
/// (`usd → usd_foil → usd_etched`) and would price a plain copy of a card whose only
/// listed price is its foil at the foil's price. A finish with no price is `NULL` —
/// which is a different statement from `0.00`, and is counted as such.
pub const FINISH_PRICE_USD: &str = "CAST(json_extract(c.prices,
        CASE e.finish WHEN 'foil' THEN '$.usd_foil'
                      WHEN 'etched' THEN '$.usd_etched'
                      ELSE '$.usd' END) AS REAL)";

/// The same in EUR, with the hole the data actually has: **`eur_etched` does not exist**.
/// An etched card is unpriced in euros rather than valued at the nonfoil rate.
pub const FINISH_PRICE_EUR: &str = "CASE e.finish WHEN 'etched' THEN NULL ELSE
        CAST(json_extract(c.prices,
            CASE e.finish WHEN 'foil' THEN '$.eur_foil' ELSE '$.eur' END) AS REAL) END";

/// Rows per page. The collection is not 116 k rows, but it can be tens of thousands, and
/// the table is virtualised for the same reason the search results are.
const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

/// A collection list, as the UI asks for it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionQuery {
    /// The card filters, flattened onto the same JSON object — so `{"sets":["lea"],
    /// "finishes":["foil"]}` is one payload rather than a nested shape the UI has to build.
    #[serde(flatten)]
    pub cards: crate::filters::CardFilters,
    pub finishes: Option<Vec<String>>,
    pub conditions: Option<Vec<String>>,
    /// `Some(true)` narrows to the rows a Scryfall migration or a vanished printing flagged.
    pub needs_review: Option<bool>,
    /// How to order the list: columns in priority order, the first deciding and the rest
    /// breaking its ties. Empty or absent is name order. Keys outside [`COLLECTION_SORTS`]
    /// are dropped, never interpolated.
    pub sort: Option<Vec<crate::sorting::SortTerm>>,
    /// Which currency the `value` and `price` sorts order by. Absent — or anything this build
    /// does not recognise — means `usd`, which is what every caller had before there was a
    /// marketplace to pick. See [`crate::sorting::Currency`].
    pub currency: crate::sorting::Currency,
    pub limit: u32,
    pub offset: u32,
}

/// One row of the collection table: the entry, plus whatever `cards` still knows about the
/// printing it names. Every `cards`-derived field is `Option` — a row whose printing has
/// left the database is still a card the user owns.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRow {
    pub id: i64,
    pub card_id: String,
    pub name: Option<String>,
    /// From the *entry*, not the card: this is what the user recorded owning.
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub lang: String,
    pub rarity: Option<String>,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
    pub layout: Option<String>,
    pub finish: String,
    pub condition: String,
    pub quantity: i64,
    pub tradelist_quantity: i64,
    /// Per copy, per finish, from the blob. `None` when there is no price for that finish.
    pub unit_price_usd: Option<f64>,
    pub unit_price_eur: Option<f64>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub altered: bool,
    pub signed: bool,
    pub proxy: bool,
    pub misprint: bool,
    pub grading: Option<String>,
    pub tags: String,
    pub notes: Option<String>,
    /// A sentence when this row needs the user's attention, `None` otherwise.
    pub needs_review: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPage {
    pub items: Vec<CollectionRow>,
    /// Rows matching the filters, counted in full — a collection is thousands of rows, not
    /// the 116 k the search has to cap.
    pub total: i64,
}

/// The aggregate header (spec §7): total cards, unique cards, estimated value.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    /// Copies, not rows. A row emptied to zero (see [`set_quantity`]) contributes 0 here —
    /// which is the whole reason this sums `quantity` rather than counting rows.
    pub total_cards: i64,
    /// Distinct printings **recorded**, not distinct printings currently held: a row taken
    /// to zero still names a card the user has an entry for, and it is still on the screen
    /// this number captions. Counting only what has copies today would make the header
    /// disagree with the list under it every time a playset is traded away.
    pub unique_cards: i64,
    pub entries: i64,
    pub tradelist_cards: i64,
    pub value_usd: f64,
    pub value_eur: f64,
    /// Copies with no price for their finish. Shown beside the value, because a total that
    /// silently omits 400 cards is a number that lies by rounding down.
    pub unpriced_usd: i64,
    pub unpriced_eur: i64,
    pub needs_review: i64,
}

/// The rows every statement here reads, and the only join any of them makes.
///
/// LEFT JOIN, always: an entry whose printing is gone is the case the denormalised columns
/// exist for, and an inner join would delete exactly those rows from the view that most
/// needs them. Nothing widens this — see [`scope`] for why even the text filter reaches
/// `cards_fts` through a subquery rather than a second join.
const FROM: &str = "collection_entries e LEFT JOIN cards c ON c.id = e.card_id";

/// The `WHERE` shared by the page, the count and the summary — because a summary taken
/// over different rows than the list is a header that describes a different screen.
fn scope(q: &CollectionQuery) -> crate::filters::Predicates {
    let mut p = crate::filters::Predicates::default();

    if let Some(text) = crate::filters::nonblank(&q.cards.text) {
        if let Some(query) = crate::filters::fts_query(text) {
            // Searching by text is a statement about a card's name or rules, so it can only
            // match rows that still have a card — this narrows the list to those, on
            // purpose.
            //
            // A subquery over `c.rowid`, **not** the `JOIN cards_fts ON cards_fts.rowid =
            // c.rowid` the search uses, and the difference is not style. Joined, SQLite
            // offers `cards_fts.rowid = c.rowid` to FTS5's own `xBestIndex`, which drops a
            // rowid constraint whose value is NULL rather than failing it — so on this
            // query's LEFT JOIN *every orphaned row* would survive any text at all that
            // matched something, and a search for "counterspell" would list a Lightning
            // Bolt whose printing had vanished. `NULL IN (…)` is NULL, which is the answer
            // this needs. (`a_text_filter_matches_through_the_search_index_and_never_lists
            // _an_orphan` is the evidence; the search's own join is safe because it has no
            // LEFT JOIN and so no NULL rowid to offer.)
            p.push(
                "c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)".to_owned(),
                Box::new(query),
            );
        }
    }
    // `paper_only` is forced off: the user owns what the user owns, and `c.is_paper = 1`
    // over a LEFT JOIN would also throw away every orphan (`NULL = 1` is not true).
    let cards = crate::filters::CardFilters {
        text: None,
        paper_only: Some(false),
        ..q.cards.clone()
    };
    // `Some("e")`: the entry carries its own `set_code`, so a set filter reads through to it
    // for the rows `cards` no longer knows about — the ones this list still shows under that
    // very code. Every other card filter stays card-only; `push_card_filters` says why.
    crate::filters::push_card_filters(&mut p, &cards, "c", Some("e"));

    push_in_list(&mut p, "e.finish", q.finishes.as_deref(), &FINISHES);
    push_in_list(&mut p, "e.condition", q.conditions.as_deref(), &CONDITIONS);
    match q.needs_review {
        Some(true) => p.wheres.push("e.needs_review IS NOT NULL".to_owned()),
        Some(false) => p.wheres.push("e.needs_review IS NULL".to_owned()),
        None => {}
    }
    p
}

/// `column IN (…)` for a filter over a known enum.
///
/// Values outside the enum are dropped rather than bound: they can only come from a stale
/// or hand-made payload, they can never match, and binding them would turn a typo into an
/// empty list with no explanation.
fn push_in_list(
    p: &mut crate::filters::Predicates,
    column: &str,
    picked: Option<&[String]>,
    allowed: &[&str],
) {
    let Some(picked) = picked else { return };
    let values: Vec<String> = picked
        .iter()
        .filter(|v| allowed.contains(&v.as_str()))
        .cloned()
        .collect();
    if values.is_empty() {
        return;
    }
    let holes = vec!["?"; values.len()].join(",");
    p.wheres.push(format!("{column} IN ({holes})"));
    for v in values {
        p.params.push(Box::new(v));
    }
}

/// The columns the collection table's headers can sort on, plus the two the filter bar's
/// select offers that have no column to press.
///
/// Matched against literals and never interpolated; [`crate::sorting::order_by`] appends
/// the `e.id` tiebreak, so ties — the common case here, one card name covering a dozen
/// rows — page deterministically.
///
/// `set` is the binder order: natural collector number, which is a `CAST` because ~9% of
/// them are not numeric (`741z`, `1★`, `A-123`) and a plain string sort puts `100` before
/// `2`. `name` coalesces to the card id so orphans sort under something rather than at the
/// top under an empty string.
///
/// **`value` and `price` are two different questions about the same column, and both are
/// real.** `value` is what the row is worth — unit price × copies, which is the figure the
/// Value cell prints, and therefore what its header sorts by, because a column that
/// reorders by something other than the number written in it is a column that lies.
/// `price` is what one copy costs, which is the order a reader means by "what is my most
/// expensive card"; it has no header and stays reachable from the select.
///
/// `finish` ranks the condition rather than spelling it: `DMG` before `LP` is alphabetical
/// order, not grade order.
///
/// `value` and `price` are not here — they are the two keys whose SQL depends on the reader's
/// marketplace, so they live in [`COLLECTION_PRICE_SORTS`] and are appended by
/// [`crate::sorting::sorts_for`].
const COLLECTION_SORTS: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "coalesce(c.name, e.card_id) ASC",
        desc: "coalesce(c.name, e.card_id) DESC",
    },
    crate::sorting::SortColumn {
        key: "set",
        asc: "e.set_code ASC, CAST(e.collector_number AS INTEGER) ASC, e.collector_number ASC",
        desc: "e.set_code DESC, CAST(e.collector_number AS INTEGER) DESC, e.collector_number DESC",
    },
    crate::sorting::SortColumn {
        key: "finish",
        asc: "e.finish ASC, CASE e.condition WHEN 'NM' THEN 0 WHEN 'LP' THEN 1 \
              WHEN 'MP' THEN 2 WHEN 'HP' THEN 3 WHEN 'DMG' THEN 4 ELSE 5 END ASC",
        desc: "e.finish DESC, CASE e.condition WHEN 'NM' THEN 0 WHEN 'LP' THEN 1 \
               WHEN 'MP' THEN 2 WHEN 'HP' THEN 3 WHEN 'DMG' THEN 4 ELSE 5 END DESC",
    },
    crate::sorting::SortColumn {
        key: "quantity",
        asc: "e.quantity ASC",
        desc: "e.quantity DESC",
    },
    // The id carries the rest of the answer, and it is not the builder's tiebreak doing it:
    // `created_at` is whole seconds, so a handful of entries added in one go all share one,
    // and the appended `e.id ASC` would read them out oldest-first under a heading that
    // says "Recently added". The duplicate id term the builder then appends is unreachable
    // and harmless — the same shape `search`'s `ORDER_NAME` has.
    crate::sorting::SortColumn {
        key: "added",
        asc: "e.created_at ASC, e.id ASC",
        desc: "e.created_at DESC, e.id DESC",
    },
];

/// `value` and `price`, in each currency — the two keys that turn on the reader's
/// marketplace.
///
/// Both order by the **output aliases** of the two per-finish price expressions the page
/// already selects, `unit_price_usd` and `unit_price_eur`, and never by any column of either
/// table. So the euro orders carry [`FINISH_PRICE_EUR`]'s hole with them: an etched row is
/// NULL in euros and sorts last in both directions, where in dollars it has a price and does
/// not. That is the marketplace being honest rather than the sort being wrong — Cardmarket
/// does not quote etched.
const COLLECTION_PRICE_SORTS: &[crate::sorting::PricedSort] = &[
    crate::sorting::PricedSort {
        usd: crate::sorting::SortColumn {
            key: "value",
            asc: "unit_price_usd * e.quantity ASC NULLS LAST",
            desc: "unit_price_usd * e.quantity DESC NULLS LAST",
        },
        eur: crate::sorting::SortColumn {
            key: "value",
            asc: "unit_price_eur * e.quantity ASC NULLS LAST",
            desc: "unit_price_eur * e.quantity DESC NULLS LAST",
        },
    },
    crate::sorting::PricedSort {
        usd: crate::sorting::SortColumn {
            key: "price",
            asc: "unit_price_usd ASC NULLS LAST",
            desc: "unit_price_usd DESC NULLS LAST",
        },
        eur: crate::sorting::SortColumn {
            key: "price",
            asc: "unit_price_eur ASC NULLS LAST",
            desc: "unit_price_eur DESC NULLS LAST",
        },
    },
];

/// Name order, with the orphans under their card id rather than at the top under an empty
/// string. The `e.id` tiebreak is appended by [`crate::sorting::order_by`].
const COLLECTION_DEFAULT_ORDER: &str =
    "coalesce(c.name, e.card_id) ASC, e.set_code ASC, CAST(e.collector_number AS INTEGER) ASC";

pub fn list_entries(conn: &Connection, q: &CollectionQuery) -> Result<CollectionPage, String> {
    let limit = if q.limit == 0 {
        DEFAULT_LIMIT
    } else {
        q.limit.min(MAX_LIMIT)
    };
    let p = scope(q);
    let where_sql = p.where_sql();
    let mut params = p.params;

    // The count first, while `params` holds exactly the filter parameters. Counted in
    // full — this is a collection, not a 116 k-row table, and a pager that says "1 240
    // cards" should mean it.
    let total: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM {FROM} WHERE {where_sql}"),
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sql = format!(
        "SELECT e.id, e.card_id, c.name, e.set_code, c.set_name, e.collector_number, e.lang,
                c.rarity, c.mana_cost, c.type_line, c.layout,
                e.finish, e.condition, e.quantity, e.tradelist_quantity,
                {FINISH_PRICE_USD} AS unit_price_usd, {FINISH_PRICE_EUR} AS unit_price_eur,
                e.purchase_price, e.purchase_currency, e.acquired_at, e.acquisition_source,
                e.serial_number, e.altered, e.signed, e.proxy, e.misprint, e.grading,
                e.tags, e.notes, e.needs_review, e.updated_at
         FROM {FROM} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
        order = crate::sorting::order_by(
            q.sort.as_deref(),
            &crate::sorting::sorts_for(COLLECTION_SORTS, COLLECTION_PRICE_SORTS, q.currency),
            COLLECTION_DEFAULT_ORDER,
            "e.id ASC",
        )
    );
    params.push(Box::new(limit));
    params.push(Box::new(q.offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| {
                Ok(CollectionRow {
                    id: r.get(0)?,
                    card_id: r.get(1)?,
                    name: r.get(2)?,
                    set_code: r.get(3)?,
                    set_name: r.get(4)?,
                    collector_number: r.get(5)?,
                    lang: r.get(6)?,
                    rarity: r.get(7)?,
                    mana_cost: r.get(8)?,
                    type_line: r.get(9)?,
                    layout: r.get(10)?,
                    finish: r.get(11)?,
                    condition: r.get(12)?,
                    quantity: r.get(13)?,
                    tradelist_quantity: r.get(14)?,
                    unit_price_usd: r.get(15)?,
                    unit_price_eur: r.get(16)?,
                    purchase_price: r.get(17)?,
                    purchase_currency: r.get(18)?,
                    acquired_at: r.get(19)?,
                    acquisition_source: r.get(20)?,
                    serial_number: r.get(21)?,
                    altered: r.get(22)?,
                    signed: r.get(23)?,
                    proxy: r.get(24)?,
                    misprint: r.get(25)?,
                    grading: r.get(26)?,
                    tags: r.get(27)?,
                    notes: r.get(28)?,
                    needs_review: r.get(29)?,
                    updated_at: r.get(30)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(CollectionPage { items, total })
}

/// The aggregate header, over the *same* rows the list is showing.
pub fn summarise(conn: &Connection, q: &CollectionQuery) -> Result<CollectionSummary, String> {
    let p = scope(q);
    let where_sql = p.where_sql();
    let sql = format!(
        "SELECT coalesce(sum(e.quantity), 0),
                count(DISTINCT e.card_id),
                count(*),
                coalesce(sum(e.tradelist_quantity), 0),
                coalesce(sum(e.quantity * coalesce({usd}, 0.0)), 0.0),
                coalesce(sum(e.quantity * coalesce({eur}, 0.0)), 0.0),
                coalesce(sum(CASE WHEN {usd} IS NULL THEN e.quantity ELSE 0 END), 0),
                coalesce(sum(CASE WHEN {eur} IS NULL THEN e.quantity ELSE 0 END), 0),
                coalesce(sum(CASE WHEN e.needs_review IS NOT NULL THEN 1 ELSE 0 END), 0)
         FROM {FROM} WHERE {where_sql}",
        usd = FINISH_PRICE_USD,
        eur = FINISH_PRICE_EUR
    );
    conn.query_row(
        &sql,
        rusqlite::params_from_iter(p.params.iter().map(|p| p.as_ref())),
        |r| {
            Ok(CollectionSummary {
                total_cards: r.get(0)?,
                unique_cards: r.get(1)?,
                entries: r.get(2)?,
                tradelist_cards: r.get(3)?,
                value_usd: r.get(4)?,
                value_eur: r.get(5)?,
                unpriced_usd: r.get(6)?,
                unpriced_eur: r.get(7)?,
                needs_review: r.get(8)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// The collection list. **Read-only** connection, blocking pool — as every read in this
/// app is, so a list never queues behind a sync.
#[tauri::command]
pub async fn collection_list(
    state: tauri::State<'_, Arc<AppState>>,
    query: CollectionQuery,
) -> Result<CollectionPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_entries(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}

#[tauri::command]
pub async fn collection_summary(
    state: tauri::State<'_, Arc<AppState>>,
    query: CollectionQuery,
) -> Result<CollectionSummary, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        summarise(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// One sort term, in the shape the UI sends.
    fn term(key: &str, dir: &str) -> crate::sorting::SortTerm {
        crate::sorting::SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

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
            index: std::sync::RwLock::default(),
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

    /// Every write in this module goes through [`with_write_owned`], and this is what that
    /// buys: the facet index's `owned` dimension is true again by the time the command
    /// answers, so the panel the user is looking at does not grey out "Owned" for a card they
    /// have just added.
    ///
    /// And **only on success**, which is asserted on the published `Arc`'s identity rather
    /// than on its contents: a refusal changed no rows, so a refresh after one arrives at the
    /// same counts and a count is therefore blind to whether the work was done. A new `Arc` is
    /// the only visible trace of ~1 MB of index copied to learn nothing. (Measured: with the
    /// `is_ok` guard removed, the count assertion still passes and this one fails.)
    ///
    /// The refusal is [`GONE`] rather than [`BUSY`]: a busy write would need the lock held
    /// from another thread, and the point being pinned is the same either way.
    #[test]
    fn a_write_that_lands_refreshes_the_owned_facet_and_one_that_is_refused_does_not() {
        let state = crate::index::fixtures::state_with_seeded_cards("collection-owned");
        crate::index::lifecycle::build_now(&state).unwrap();
        let before = crate::index::lifecycle::current(&state).unwrap();
        assert_eq!(before.owned.count(), 0);

        with_write_owned(&state, |c| add_entry(c, &input("1", "nonfoil", 2))).unwrap();
        let refreshed = crate::index::lifecycle::current(&state).unwrap();
        assert_eq!(
            refreshed.owned.count(),
            1,
            "the index has to know about the row the command just wrote"
        );

        let refused = with_write_owned(&state, |c| set_quantity(c, 4_242, 3));
        assert_eq!(refused.unwrap_err(), GONE);
        let after = crate::index::lifecycle::current(&state).unwrap();
        assert!(
            std::sync::Arc::ptr_eq(&refreshed, &after),
            "a refused write must not republish the index at all"
        );
        assert_eq!(after.owned.count(), 1);
    }

    /// Money, per finish, out of the blob. The fixture is built so that using `price_usd`
    /// — the derived fallback chain — instead would give a *different, higher* number:
    /// the Alpha printing has no foil price at all, and `price_usd` would fall through to
    /// the nonfoil one and quietly value a foil that does not exist at $400.
    #[test]
    fn value_is_summed_per_finish_from_the_prices_blob() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap(); // 2 × 400.50
        add_entry(&conn, &input("bolt-jp", "foil", 3)).unwrap(); //     3 × 90.00
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap(); //  1 × 12.00

        let s = summarise(&conn, &CollectionQuery::default()).unwrap();

        assert_eq!(s.total_cards, 6);
        assert_eq!(s.unique_cards, 2, "two printings, three rows");
        assert_eq!(s.entries, 3);
        assert!(
            (s.value_usd - (2.0 * 400.50 + 3.0 * 90.00 + 12.00)).abs() < 0.005,
            "got {}",
            s.value_usd
        );
        // The Japanese printing has no EUR price of any kind, so those four cards are
        // counted as unpriced rather than valued at their dollar figure.
        assert!(
            (s.value_eur - 2.0 * 320.00).abs() < 0.005,
            "got {}",
            s.value_eur
        );
        assert_eq!(s.unpriced_eur, 4);
        assert_eq!(s.unpriced_usd, 0);
    }

    /// `eur_etched` is documented and **does not exist in the data**. An etched card is
    /// therefore unpriced in euros — never priced at the nonfoil rate, which is what a
    /// naive `coalesce` chain would do.
    #[test]
    fn an_etched_card_has_no_euro_price_at_all() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                finishes,prices,raw)
             VALUES ('bolt-etch','o1','Lightning Bolt','sld','1','en','normal',
                '[\"etched\"]','{\"usd\":\"5.00\",\"usd_etched\":\"25.00\",\"eur\":\"4.00\"}','{}')",
            [],
        )
        .unwrap();
        add_entry(&conn, &input("bolt-etch", "etched", 2)).unwrap();

        let s = summarise(&conn, &CollectionQuery::default()).unwrap();

        assert!((s.value_usd - 50.00).abs() < 0.005, "got {}", s.value_usd);
        assert_eq!(s.value_eur, 0.0, "there is no eur_etched key in the data");
        assert_eq!(s.unpriced_eur, 2);
    }

    /// Collector numbers are TEXT and ~9% of them are not numeric. A plain string sort puts
    /// `100` before `2`; this is the sort a printed binder is in.
    #[test]
    fn the_set_sort_orders_collector_numbers_naturally() {
        let conn = seeded();
        for (id, cn) in [
            ("c-100", "100"),
            ("c-2", "2"),
            ("c-9", "9"),
            ("c-741z", "741z"),
            ("c-star", "1★"),
            ("c-a", "A-123"),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
                 VALUES (?1,'o9','Filler','tst',?2,'en','normal','{}')",
                rusqlite::params![id, cn],
            )
            .unwrap();
            add_entry(&conn, &input(id, "nonfoil", 1)).unwrap();
        }

        let page = list_entries(
            &conn,
            &CollectionQuery {
                sort: Some(vec![term("set", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let numbers: Vec<&str> = page
            .items
            .iter()
            .filter(|r| r.set_code == "tst")
            .map(|r| r.collector_number.as_str())
            .collect();
        assert_eq!(numbers, ["A-123", "1★", "2", "9", "100", "741z"]);
    }

    /// The card filters are the *same* filters the search view uses — that is what
    /// `filters.rs` is for — and the entry filters AND with them.
    #[test]
    fn the_card_filters_and_the_entry_filters_combine() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();

        let by_set = list_entries(
            &conn,
            &CollectionQuery {
                cards: crate::filters::CardFilters {
                    sets: Some(vec!["lea".into()]),
                    ..Default::default()
                },
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_set.total, 1);
        assert_eq!(by_set.items[0].set_code, "lea");

        let foils = list_entries(
            &conn,
            &CollectionQuery {
                finishes: Some(vec!["foil".into()]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(foils.total, 1);
        assert_eq!(foils.items[0].finish, "foil");

        let neither = list_entries(
            &conn,
            &CollectionQuery {
                cards: crate::filters::CardFilters {
                    sets: Some(vec!["lea".into()]),
                    ..Default::default()
                },
                finishes: Some(vec!["foil".into()]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(neither.total, 0, "the filters AND, they do not OR");
    }

    /// A row whose printing has left the card database still lists, still counts, and
    /// still says which card it is — from the columns denormalised at write time. This is
    /// the payoff for spec §6's insurance, and the reason the join is a LEFT JOIN.
    #[test]
    fn an_orphaned_entry_still_lists_with_its_denormalised_printing() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();

        let page = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(page.total, 1);
        let row = &page.items[0];
        assert_eq!(row.name, None, "there is no card row to name it");
        assert_eq!(
            (row.set_code.as_str(), row.collector_number.as_str()),
            ("lea", "161")
        );
        assert_eq!(row.unit_price_usd, None, "and no price either — not zero");
        let s = summarise(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(s.total_cards, 2, "the cards are still owned");
        assert_eq!(s.unpriced_usd, 2);
    }

    /// The zero-quantity ruling, fenced. A stepper taken to zero keeps the row (Task 5), and
    /// every aggregate over this table therefore has to say *deliberately* what it does with
    /// one. Three separate positions, each of which a plausible "tidy-up" would break, and
    /// none of which any other test notices: a `WHERE e.quantity > 0` bolted onto the scope,
    /// or a `count(*)` in place of `sum(e.quantity)`, or a `unique_cards` narrowed to what is
    /// held today, all pass the rest of this module.
    ///
    /// * The row still **lists** — it is a real row, and it is where the user's condition,
    ///   price paid, tags and acquisition story still live.
    /// * `total_cards` is **copies**, so it drops by exactly the copies that left.
    /// * `unique_cards` is printings **recorded**, not printings held, so it does not move:
    ///   the row is still on the screen this number captions, and a header that stopped
    ///   counting it would disagree with the list underneath it.
    #[test]
    fn a_row_emptied_to_zero_still_lists_and_is_still_a_printing_the_collection_knows() {
        let conn = seeded();
        let lea = add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 3)).unwrap();

        let before = summarise(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(
            (before.total_cards, before.unique_cards, before.entries),
            (5, 2, 2)
        );

        set_quantity(&conn, lea.id, 0).unwrap();
        let after = summarise(&conn, &CollectionQuery::default()).unwrap();

        let page = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 2, "an emptied row is a row");
        let emptied = page
            .items
            .iter()
            .find(|r| r.id == lea.id)
            .expect("the row the user emptied is still the row the user is looking at");
        assert_eq!(emptied.quantity, 0);

        assert_eq!(
            after.total_cards, 3,
            "copies, not rows — the two Alpha copies are gone"
        );
        assert_eq!(
            after.unique_cards, 2,
            "printings recorded, not printings held"
        );
        assert_eq!(after.entries, 2, "and the entry is still an entry");
        // The value follows the copies, which is the same statement seen from the money
        // side: an emptied row is worth nothing and is not unpriced.
        assert!(
            (after.value_usd - 3.0 * 90.00).abs() < 0.005,
            "got {}",
            after.value_usd
        );
    }

    /// The set filter is the one card filter whose value the *entry* also carries, and it has
    /// to read through to it. The list shows an orphan under the set code denormalised at
    /// write time; a filter that then hid that row would be contradicting the column printed
    /// beside it — the reader clicks `lea` on a row that says `lea` and it disappears.
    ///
    /// The other half is the part that keeps this honest: `rarity` (and format, colours, mana
    /// value) is a claim only a card row can answer, so the orphan still fails it. There is
    /// nowhere to read it from, and inventing an answer would be a claim about a printing
    /// that is gone.
    #[test]
    fn an_orphan_still_matches_the_set_it_is_recorded_under_but_not_a_card_only_filter() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();
        // The surviving printing is Modern-legal, so the format filter below is a filter
        // that finds something — otherwise "the orphan is not in the list" would be true of
        // an empty list and would prove nothing. Both columns, the way a synced row carries
        // them, so the assertion holds whichever of the two the filter reads.
        conn.execute(
            "UPDATE cards SET legalities = '{\"modern\":\"legal\"}', legal_mask = ?1
             WHERE id = 'bolt-jp'",
            [crate::legalities::bit("modern").unwrap() as i64],
        )
        .unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();

        let filtered = |cards: crate::filters::CardFilters| {
            list_entries(
                &conn,
                &CollectionQuery {
                    cards,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap()
        };
        let by_sets = |code: &str| {
            filtered(crate::filters::CardFilters {
                sets: Some(vec![code.to_owned()]),
                ..Default::default()
            })
        };

        let lea = by_sets("lea");
        assert_eq!(
            lea.total, 1,
            "the list shows this row as `lea`, so filtering to `lea` has to find it"
        );
        assert_eq!(lea.items[0].card_id, "bolt-lea");
        assert_eq!(
            by_sets("4ed").total,
            1,
            "and a row with a card still matches"
        );
        assert_eq!(by_sets("zzz").total, 0, "it is still a filter");

        // The single-set filter is the same claim and answers the same way.
        let single = filtered(crate::filters::CardFilters {
            set_code: Some("lea".into()),
            ..Default::default()
        });
        assert_eq!(single.total, 1);

        let commons = filtered(crate::filters::CardFilters {
            rarity: Some("common".into()),
            ..Default::default()
        });
        assert_eq!(commons.total, 1, "the orphan has no rarity to match");
        assert_eq!(commons.items[0].card_id, "bolt-jp");

        // Format is the same claim through a different column, and the reason it is spelled
        // out separately: the filter is `c.legal_mask & ? != 0`, and the LEFT JOIN gives an
        // orphan a NULL alias, so the test is `NULL & ?`, which is NULL — false, exactly as
        // `json_extract(NULL, …) IN (…)` was before the mask. An implementation reaching for
        // `coalesce(c.legal_mask, …)` or moving the column onto the entry would list a
        // printing that is gone as legal in a format nobody can check.
        let modern = filtered(crate::filters::CardFilters {
            format: Some("modern".into()),
            ..Default::default()
        });
        assert_eq!(modern.total, 1, "the orphan has no legalities to match");
        assert_eq!(modern.items[0].card_id, "bolt-jp");
    }

    /// The digital-printing rule the search applies does **not** apply here: the user owns
    /// what the user owns, and a paper-only predicate over a LEFT JOIN would also delete
    /// every orphan from the list, because `NULL = 1` is not true.
    #[test]
    fn the_collection_does_not_hide_rows_behind_the_paper_only_default() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                is_paper,digital,raw)
             VALUES ('bolt-mtgo','o1','Lightning Bolt','pmtg1','7','en','normal',0,1,'{}')",
            [],
        )
        .unwrap();
        add_entry(&conn, &input("bolt-mtgo", "nonfoil", 1)).unwrap();

        let page = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
    }

    /// Text is the one filter that is not a column comparison: it reaches `cards_fts`, and
    /// its parameter has to bind ahead of every card and entry predicate that follows it in
    /// the `WHERE`. A `?` bound one position out here would search the index for a set code.
    ///
    /// It is also the one filter that *narrows to rows that still have a card*, because
    /// "matches this rules text" is a claim only a card row can answer — and the last third
    /// of this test is why `scope` reaches the index through a subquery rather than through
    /// the join the search uses. Written as `JOIN cards_fts ON cards_fts.rowid = c.rowid`
    /// over this query's LEFT JOIN, FTS5's `xBestIndex` **drops** the rowid constraint when
    /// the value is NULL instead of failing it, and every orphaned row is returned by every
    /// text that matches anything at all.
    #[test]
    fn a_text_filter_matches_through_the_search_index_and_never_lists_an_orphan() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();
        // External-content FTS with no triggers: rows added after `migrate` are invisible
        // to the index until it is rebuilt.
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        let by_text = |text: &str, sets: Option<Vec<String>>| {
            list_entries(
                &conn,
                &CollectionQuery {
                    cards: crate::filters::CardFilters {
                        text: Some(text.to_owned()),
                        sets,
                        ..Default::default()
                    },
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap()
        };

        assert_eq!(by_text("light bol", None).total, 2, "both printings match");
        assert_eq!(by_text("counterspell", None).total, 0);
        // The MATCH parameter and the set list, in one statement: bound out of order, the
        // set code would be fed to `cards_fts` and this would be an FTS syntax error or a
        // silent zero.
        let narrowed = by_text("light bol", Some(vec!["lea".into()]));
        assert_eq!(narrowed.total, 1);
        assert_eq!(narrowed.items[0].set_code, "lea");

        // An orphan has no card row and therefore no rules text — the inner join is what
        // says so, and it is the one thing a text search is allowed to hide.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", [])
            .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        assert_eq!(by_text("light bol", None).total, 1);
        let unfiltered = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            unfiltered.total, 2,
            "and the list without one still has both"
        );
    }

    /// Every sort key is a *string interpolated into the statement*, so one that names a
    /// column or an alias the query does not have is a `prepare` error at run time — an
    /// empty list and an error dialog, not a differently-ordered one. `price` and `value`
    /// earn this on their own: both order by the `unit_price_usd` **output alias**, not by
    /// any column of either table. Paged two at a time as well, so a sort that is not a
    /// total order shows a row twice here rather than in front of a reader — and the
    /// two-key case is in the list, because a second key makes an order *look* more
    /// determined than it is.
    #[test]
    fn every_sort_key_prepares_and_pages_without_repeating_a_row() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();

        let orders: [(&str, Vec<crate::sorting::SortTerm>); 9] = [
            ("name", vec![term("name", "asc")]),
            ("set", vec![term("set", "desc")]),
            ("finish", vec![term("finish", "asc")]),
            ("added", vec![term("added", "desc")]),
            ("quantity", vec![term("quantity", "desc")]),
            ("price", vec![term("price", "desc")]),
            ("value", vec![term("value", "desc")]),
            (
                "quantity+name",
                vec![term("quantity", "desc"), term("name", "asc")],
            ),
            ("nonsense", vec![term("nonsense", "asc")]),
        ];
        // Both currencies, because the euro orders are *different strings* over a second
        // alias — a `value` written against a `unit_price_eur` the page did not select would
        // fail at prepare time and only ever on Cardmarket.
        for currency in [crate::sorting::Currency::Usd, crate::sorting::Currency::Eur] {
            for (label, sort) in orders.clone() {
                let mut seen: Vec<i64> = Vec::new();
                for page in 0..2 {
                    let p = list_entries(
                        &conn,
                        &CollectionQuery {
                            sort: Some(sort.clone()),
                            currency,
                            limit: 2,
                            offset: page * 2,
                            ..Default::default()
                        },
                    )
                    .unwrap_or_else(|e| panic!("sorting by `{label}` in {currency:?} failed: {e}"));
                    assert_eq!(p.total, 3, "the count is the same set whatever the order");
                    seen.extend(p.items.iter().map(|r| r.id));
                }
                let mut unique = seen.clone();
                unique.sort_unstable();
                unique.dedup();
                assert_eq!(
                    (unique.len(), seen.len()),
                    (3, 3),
                    "paging by `{label}` in {currency:?} returned a row twice or lost one: {seen:?}"
                );
            }
        }
    }

    /// Three entries whose dollar order and euro order disagree on every pair, one of them
    /// **etched** — and the etched card's blob carries a perfectly good `$.eur`, which is
    /// exactly the number a naive fallback would charge for it.
    fn seeded_currencies() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        for (id, prices) in [
            ("cheap-usd", r#"{"usd":"1.00","eur":"90.00"}"#),
            ("dear-usd", r#"{"usd":"50.00","eur":"2.00"}"#),
            ("etched", r#"{"usd":"9.00","usd_etched":"9.00","eur":"7.00"}"#),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    finishes,prices,raw)
                 VALUES (?1,?1,?1,'tst','1','en','normal','[\"nonfoil\",\"etched\"]',?2,'{}')",
                rusqlite::params![id, prices],
            )
            .unwrap();
        }
        // Quantities chosen so `value` and `price` disagree as well: the cheapest card is
        // held ten times and the dearest once.
        add_entry(&conn, &input("cheap-usd", "nonfoil", 10)).unwrap();
        add_entry(&conn, &input("dear-usd", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("etched", "etched", 3)).unwrap();
        conn
    }

    /// Ordering happens inside SQLite, so the chosen marketplace is the one thing about it
    /// that has to cross the wire. Both keys, both directions, both currencies.
    #[test]
    fn the_value_and_price_sorts_order_by_the_currency_they_are_asked_for() {
        let conn = seeded_currencies();
        let ids = |key: &str, dir: &str, currency| -> Vec<String> {
            list_entries(
                &conn,
                &CollectionQuery {
                    sort: Some(vec![term(key, dir)]),
                    currency,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .into_iter()
            .map(|r| r.card_id)
            .collect()
        };
        let (usd, eur) = (crate::sorting::Currency::Usd, crate::sorting::Currency::Eur);

        // Per copy: $1 / $50 / $9 against €90 / €2 / —.
        assert_eq!(ids("price", "asc", usd), ["cheap-usd", "etched", "dear-usd"]);
        assert_eq!(ids("price", "asc", eur), ["dear-usd", "cheap-usd", "etched"]);
        assert_eq!(ids("price", "desc", usd), ["dear-usd", "etched", "cheap-usd"]);
        assert_eq!(
            ids("price", "desc", eur),
            ["cheap-usd", "dear-usd", "etched"],
            "the etched row has no euro price and stays last in both directions"
        );

        // × copies: $10 / $50 / $27 against €900 / €2 / —.
        assert_eq!(ids("value", "asc", usd), ["cheap-usd", "etched", "dear-usd"]);
        assert_eq!(ids("value", "asc", eur), ["dear-usd", "cheap-usd", "etched"]);
        assert_eq!(ids("value", "desc", usd), ["dear-usd", "etched", "cheap-usd"]);
        assert_eq!(ids("value", "desc", eur), ["cheap-usd", "dear-usd", "etched"]);
    }

    /// The rule the euro sorts inherit, stated on the row itself: an etched entry is `NULL`
    /// in euros **even though its blob has a `$.eur`**, because `eur_etched` does not exist
    /// and the nonfoil rate is not a stand-in for it.
    #[test]
    fn an_etched_row_is_unpriced_in_euros_while_its_blob_names_a_nonfoil_euro_price() {
        let conn = seeded_currencies();
        let rows = list_entries(&conn, &CollectionQuery::default()).unwrap();
        let row = |id: &str| rows.items.iter().find(|r| r.card_id == id).unwrap();

        assert_eq!(row("etched").unit_price_usd, Some(9.00));
        assert_eq!(row("etched").unit_price_eur, None, "and not the €7.00 beside it");
        assert_eq!(row("cheap-usd").unit_price_eur, Some(90.00));
    }

    /// Absent means dollars — the order every caller had before there was a picker — and so
    /// does a currency this build has never heard of. Deserialized from the wire, because it
    /// is the *payload* that omits the field.
    #[test]
    fn a_query_with_no_currency_sorts_in_dollars() {
        let conn = seeded_currencies();
        let ids = |json: &str| -> Vec<String> {
            let q: CollectionQuery = serde_json::from_str(json).unwrap();
            list_entries(&conn, &q)
                .unwrap()
                .items
                .into_iter()
                .map(|r| r.card_id)
                .collect()
        };
        let sort = r#""sort":[{"key":"price","dir":"asc"}]"#;

        let dollars = ["cheap-usd", "etched", "dear-usd"];
        assert_eq!(ids(&format!("{{{sort}}}")), dollars, "absent");
        assert_eq!(
            ids(&format!(r#"{{{sort},"currency":"gbp"}}"#)),
            dollars,
            "and a currency this build has never heard of"
        );
        assert_eq!(
            ids(&format!(r#"{{{sort},"currency":"eur"}}"#)),
            ["dear-usd", "cheap-usd", "etched"]
        );
    }

    /// The Value column shows unit price × copies, so its header sorts by that. A column
    /// that reorders by something other than the figure printed in it is a column that
    /// lies — and the unit-price order the filter bar still offers really does disagree,
    /// which is why both keys exist.
    #[test]
    fn value_sorts_by_the_total_and_price_by_the_unit() {
        let conn = seeded();
        // A cheap card held ten times is worth more than a dear one held once.
        conn.execute(
            "UPDATE cards SET prices='{\"usd\":\"2.00\"}' WHERE id='bolt-lea'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE cards SET prices='{\"usd\":\"15.00\"}' WHERE id='bolt-jp'",
            [],
        )
        .unwrap();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 10)).unwrap();
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();

        let first = |sort: &str| -> String {
            list_entries(
                &conn,
                &CollectionQuery {
                    sort: Some(vec![term(sort, "desc")]),
                    ..Default::default()
                },
            )
            .unwrap()
            .items[0]
                .card_id
                .clone()
        };
        assert_eq!(first("value"), "bolt-lea", "$2 × 10 beats $15 × 1");
        assert_eq!(
            first("price"),
            "bolt-jp",
            "and one $15 copy is the dearest card"
        );
    }

    /// The hand-mirrored wire contract, pinned whole so a field added on this side and
    /// never mirrored in `src/lib/ipc.ts` fails here rather than rendering as `undefined`.
    #[test]
    fn collection_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(CollectionRow {
            id: 7,
            card_id: "bolt-lea".into(),
            name: Some("Lightning Bolt".into()),
            set_code: "lea".into(),
            set_name: Some("Limited Edition Alpha".into()),
            collector_number: "161".into(),
            lang: "en".into(),
            rarity: Some("common".into()),
            mana_cost: Some("{R}".into()),
            type_line: Some("Instant".into()),
            layout: Some("normal".into()),
            finish: "nonfoil".into(),
            condition: "NM".into(),
            quantity: 4,
            tradelist_quantity: 1,
            unit_price_usd: Some(400.5),
            unit_price_eur: Some(320.0),
            purchase_price: Some(12.5),
            purchase_currency: Some("USD".into()),
            acquired_at: Some("2020-05-01".into()),
            acquisition_source: Some("Local shop".into()),
            serial_number: None,
            altered: false,
            signed: true,
            proxy: false,
            misprint: false,
            grading: None,
            tags: "[]".into(),
            notes: None,
            needs_review: None,
            updated_at: 1_800_000_000,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": 7, "cardId": "bolt-lea", "name": "Lightning Bolt", "setCode": "lea",
                "setName": "Limited Edition Alpha", "collectorNumber": "161", "lang": "en",
                "rarity": "common", "manaCost": "{R}", "typeLine": "Instant", "layout": "normal",
                "finish": "nonfoil", "condition": "NM", "quantity": 4, "tradelistQuantity": 1,
                "unitPriceUsd": 400.5, "unitPriceEur": 320.0, "purchasePrice": 12.5,
                "purchaseCurrency": "USD", "acquiredAt": "2020-05-01",
                "acquisitionSource": "Local shop", "serialNumber": null, "altered": false,
                "signed": true, "proxy": false, "misprint": false, "grading": null,
                "tags": "[]", "notes": null, "needsReview": null, "updatedAt": 1800000000
            })
        );

        let summary = serde_json::to_value(CollectionSummary {
            total_cards: 6,
            unique_cards: 2,
            entries: 3,
            tradelist_cards: 1,
            value_usd: 1213.0,
            value_eur: 640.0,
            unpriced_usd: 0,
            unpriced_eur: 4,
            needs_review: 0,
        })
        .unwrap();
        assert_eq!(
            summary,
            serde_json::json!({
                "totalCards": 6, "uniqueCards": 2, "entries": 3, "tradelistCards": 1,
                "valueUsd": 1213.0, "valueEur": 640.0, "unpricedUsd": 0, "unpricedEur": 4,
                "needsReview": 0
            })
        );
    }
}
