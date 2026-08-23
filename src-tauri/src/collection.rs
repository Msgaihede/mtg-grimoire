//! The owned-cards table: what the user has, at what grain, and what it is worth.
//!
//! Shaped like [`crate::card`]: pure functions over a `Connection`, testable without a
//! Tauri app, wrapped in `async` commands that run on the blocking pool. The difference is
//! which connection — these *write*, so they take `AppState.db` with a bound rather than
//! `db_read`, and a lock they cannot get is an answer rather than a wait.

// The two sentences a folder an add cannot use gets, reached across rather than re-spelled —
// `collection_folders`' own import of `FOLDER_GONE` makes the argument at length, and this is
// the fifth write over a `folder_id` column to need it. `FOLDER_NOT_YOURS` and `USER_KIND` come
// from that module for the sharper version of the same reason: it owns what a folder's `kind`
// means and how the app says no to one of its own, and a second wording here would be a second
// answer to one mistake.
use crate::collection_folders::{FOLDER_NOT_YOURS, USER_KIND};
use crate::deck_meta::FOLDER_GONE;
use crate::schema::{COLLECTION_GRAIN, FINISHES};
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// The NA condition scale, in descending order. The EU scale (`M/NM/EX/GD/LP/PL/PO`) is
/// normalised into this one at the edge — see `src/lib/conditions.ts` — and the string it
/// arrived as is kept in `condition_original`.
pub const CONDITIONS: [&str; 5] = ["NM", "LP", "MP", "HP", "DMG"];

/// What a card is assumed to be when nobody says otherwise.
pub const DEFAULT_CONDITION: &str = "NM";

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
    /// Which folder the copies are filed in. `None` is the **root**, which is where every add
    /// landed before schema v24 and where every add that names no folder still lands.
    ///
    /// **On the input rather than left to a follow-up `collection_set_folder`, because it is
    /// part of the grain.** `coalesce(folder_id, 0)` is `COLLECTION_GRAIN`'s eleventh term, so
    /// "Add to → Binder" and "Add to → Collection" are two different rows of the same printing —
    /// an add that could not name a folder would land at the root and then have to be *moved*,
    /// which is a merge into whatever the root already held followed by a move back out. The
    /// column has to be written by the statement that decides the conflict target.
    ///
    /// Fenced in words against `collection_folders` ([`folder_named`]) rather than by the
    /// foreign key, which is `crate::wishlist::WishInput::folder_id`'s argument on the same
    /// field one table over: the key is per-connection (`PRAGMA foreign_keys`) and
    /// `FOREIGN KEY constraint failed` names a constraint rather than the mistake.
    ///
    /// **The kind is fenced as well as the existence**, with
    /// `collection_folders::set_entry_folder`'s wording and for its reason: an add that filed
    /// into a `deck` or `removed` folder would be asserting something only the app can make
    /// true. The menu the reader presses offers `kind == "user"` and nothing else, so a request
    /// naming one of the app's folders is a stale client or a bug either way. The deck-driven
    /// writes reach those folders through `collection_folders::refile_entry`, which is
    /// deliberately unfenced and is the whole difference between the two doors.
    pub folder_id: Option<i64>,
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
/// **Zero is allowed here, and what it then means is the caller's.** This function's whole
/// rule is that a negative number is not a quantity and must never be a back door to one;
/// zero is a state a row can legitimately be asked for, and the column's `CHECK` is `>= 0`
/// so that it can. Which of the three answers it gets is decided at the write:
/// [`set_quantity`] deletes the row (schema v24), [`update_entry`] keeps it — an edit form
/// must not delete the row being edited — and [`remove_entry`] is the unconditional delete
/// that takes no quantity at all.
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

/// `tags` as the column will take it, refused in words rather than as a constraint failure —
/// or, worse, as silence.
///
/// The column is `tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags))`, and this asks the
/// same question one layer up. **It exists because [`PATCH_SQL`] is `UPDATE OR IGNORE`**: a
/// statement that violates a CHECK there does not raise, it updates nothing — which is
/// indistinguishable from the grain collision the ignore is *for*, and from an id that resolves
/// to no row. [`update_entry`] would look for the collision, find none, and answer [`GONE`]:
/// "that collection entry is not there any more" about a row that is plainly there, sending the
/// reader to look for something that was never deleted. Refusing before the statement runs is
/// what keeps a rejected write and a missing row two different answers.
///
/// **`json_valid` and no more**, deliberately. The wire calls this a JSON array of strings, but
/// the column has never said so and the collection can already hold rows that are not one; a
/// validator stricter than the constraint it stands in for would refuse an edit to a row the
/// database is perfectly happy with.
fn valid_tags(tags: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(tags)
        .map(|_| ())
        .map_err(|e| {
            format!(
                "`{tags}` is not a tag list ({e}). Tags are stored as JSON, like \
                 [\"cube\", \"trade\"]."
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

/// The folder an add names, refused in words unless it is there **and is the reader's own**.
/// `None` is the root and is always a destination — there is no row to look up, so the fence must
/// not reach it.
///
/// `crate::wishlist::add_wish`'s check on the same field one table over, and the fourth write in
/// the crate to make the same argument: `collection_entries.folder_id` **is** a real foreign key
/// between two user tables, so an id nothing answers to does fail — with
/// `FOREIGN KEY constraint failed`, a sentence about a constraint, and only while
/// `PRAGMA foreign_keys` happens to be on, which is per-connection. The reader who deleted a
/// folder in one pane and pressed "Add to" in another must meet the sentence they met in the
/// deck gallery and on the wishlist. One mistake, one wording.
///
/// **The kind is checked too, which is `collection_folders`' own fence and its own wording**
/// ([`crate::collection_folders::FOLDER_NOT_YOURS`], the constant the four writes in that module
/// already answer with). A `deck` or `removed` folder is reached only through the dedicated
/// deck-driven writes, and the card menu offers `kind == "user"` and nothing else — so a request
/// naming one of the app's folders is a stale client or a bug, and honouring it would let an
/// ordinary add assert something only the app can make true. `collection_folders::refile_entry`
/// is deliberately unfenced and is the door those writes come through.
///
/// One statement for both halves, because they are one question — a folder that is not there
/// cannot be the app's, which is `collection_folders::user_folder`'s ordering, and a NULL `kind`
/// is unreachable (the column is `NOT NULL`, CHECKed against
/// `schema::COLLECTION_FOLDER_KINDS`).
fn folder_named(conn: &Connection, folder_id: Option<i64>) -> Result<(), String> {
    let Some(folder) = folder_id else {
        return Ok(());
    };
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM collection_folders WHERE id = ?1",
            params![folder],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match kind.as_deref() {
        None => Err(FOLDER_GONE.to_owned()),
        Some(USER_KIND) => Ok(()),
        Some(_) => Err(FOLDER_NOT_YOURS.to_owned()),
    }
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
///
/// **The grain includes the folder since schema v24**, which is what makes "Add to → Binder" an
/// *add* rather than a move: the same printing filed in two places is two rows, so an add can
/// never quietly relocate copies the reader filed last week. [`EntryInput::folder_id`] is the
/// field, `None` is the root, and the column has to be written by this statement rather than by
/// a follow-up move — the conflict target is `COLLECTION_GRAIN` verbatim, so the column that
/// decides which row is folded into must be set before the conflict is resolved.
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
    folder_named(conn, input.folder_id)?;
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
             tags, notes, folder_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,min(?9,?8),?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                 coalesce(?20,'[]'),?21,?22, unixepoch(), unixepoch())
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
                input.folder_id,
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// One line of an import, after TypeScript has decided everything a *collection* decision is.
///
/// The condition is `Option` rather than defaulted here: an absent one means the file said
/// nothing, and the **dialog** is where the reader chose what that becomes. Defaulting it in two
/// places is how the preview and the write come to disagree.
///
/// # Six of these fields are the grain, and they were hard-coded until schema v24
///
/// `altered`, `signed`, `proxy`, `misprint`, `serial_number` and `grading` are terms of
/// [`COLLECTION_GRAIN`], and [`commit_import`] used to write a default for every one of them.
/// The consequence was not a lost flag: it was that a re-import could **never** land on a
/// reader's altered or graded row, because the row it conflicted against was at a different
/// grain. It wrote a second all-defaults entry beside the real one — quietly, on the one screen
/// whose whole job is not to duplicate what the collection already records.
///
/// **`#[serde(default)]` on the six**, so a planner written before they existed still
/// deserialises and an absent field still means the plain copy an import has always described.
/// That is `crate::import::ImportItem::inactive`'s rule, for its reason.
///
/// `grading` rides as the **text the file carried** and is canonicalised by the write rather
/// than here: [`Grading`] is the one struct that owns that column's key order, and
/// [`canonical_grading`] — which [`add_entry`] and [`set_entry`] both call — is the one place it
/// is parsed and re-serialised. A second spelling built anywhere else is the same physical card
/// forking into a new row on every edit, with no constraint anywhere to catch it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionImportItem {
    pub card_id: String,
    pub quantity: i64,
    pub finish: String,
    pub condition: Option<String>,
    pub condition_original: Option<String>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub notes: Option<String>,
    #[serde(default)]
    pub serial_number: Option<String>,
    #[serde(default)]
    pub altered: bool,
    #[serde(default)]
    pub signed: bool,
    #[serde(default)]
    pub proxy: bool,
    #[serde(default)]
    pub misprint: bool,
    /// `{"company":"PSA","grade":"9","cert":"12345678"}` as JSON text — see the type doc.
    #[serde(default)]
    pub grading: Option<String>,
}

/// What a bulk import did. **`removed` is both lists' since schema v24** — a `set` of 0 deletes
/// a wish, and now deletes a collection row too ([`set_quantity`] is where that reversal is
/// argued). It was the wishlist's alone and 0 here, and the one shape covering both commands is
/// what made the change a count rather than a field.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitOutcome {
    pub added: i64,
    pub updated: i64,
    pub removed: i64,
}

/// [`add_entry`] with one clause changed: the grain's quantity is **written**, not accumulated.
/// A `set` import means "this file's number is the truth", not "add these copies to what is
/// already there" — the collection's own asymmetry [`set_quantity`] already carries, reused here
/// for a row the caller named by grain instead of by id.
///
/// Every other column keeps `add_entry`'s first-writer-wins rule: a second write of a card the
/// reader already tracks is not licence to overwrite a purchase story they already recorded, and
/// a `set` import is still a second write. `tradelist_quantity` follows [`set_quantity`]'s own
/// clamp — `min(existing, new quantity)` — rather than `add_entry`'s additive cap, because a
/// written total is not a delta and clamping against the *old* quantity as well would let the
/// tradelist outlive the very quantity that bounds it.
fn set_entry(conn: &Connection, input: &EntryInput) -> Result<EntryChange, String> {
    let finish = valid_finish(&input.finish)?;
    let condition = valid_condition(input.condition.as_deref())?;
    valid_quantity(input.quantity, "collection quantity")?;
    valid_quantity(input.tradelist_quantity, "tradelist quantity")?;
    let grading = canonical_grading(input.grading.as_deref())?;
    folder_named(conn, input.folder_id)?;
    let (set_code, collector_number, lang) = printing_of(conn, &input.card_id)?;

    // The conflict target is `COLLECTION_GRAIN` verbatim, exactly as [`add_entry`]'s is.
    let sql = format!(
        "INSERT INTO collection_entries
            (card_id, set_code, collector_number, lang, finish, condition, condition_original,
             quantity, tradelist_quantity, purchase_price, purchase_currency, acquired_at,
             acquisition_source, serial_number, altered, signed, proxy, misprint, grading,
             tags, notes, folder_id, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,min(?9,?8),?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                 coalesce(?20,'[]'),?21,?22, unixepoch(), unixepoch())
         ON CONFLICT({COLLECTION_GRAIN}) DO UPDATE SET
            quantity = excluded.quantity,
            tradelist_quantity =
                min(collection_entries.tradelist_quantity, excluded.quantity),
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
                input.folder_id,
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// **One transaction for the whole file**, which is the whole reason this exists rather than the
/// page calling `collection_add` per line: a 500-row CSV would otherwise be 500 transactions, and
/// a failure halfway through would leave a collection nobody can reason about.
///
/// Added and updated are counted by the **row count before and after** rather than by a
/// grain lookup per item. `COLLECTION_GRAIN` is eleven columns and a hand-written `WHERE`
/// matching it would be a second copy of the index's definition — the thing this module already
/// warns against at the `ON CONFLICT` target.
///
/// **A `set` of 0 removes the row**, which is [`set_quantity`]'s reversal reaching the importer:
/// a file that says a printing is at zero is a file saying the reader does not own it. It is
/// done *after* [`set_entry`] rather than inside it, so that command keeps one shape and the
/// grain stays the upsert's to find — the row lands at zero and is then deleted by id, inside
/// this transaction, which is the intermediate zero the column's `CHECK (quantity >= 0)` allows.
///
/// The arithmetic follows: `added` is the row-count delta **plus** what was removed, because a
/// removal is a row that left for a reason that is not "it was never added". The one line this
/// counts oddly is a `set 0` for a printing the reader does not own — the upsert inserts, the
/// delete takes it away, and the outcome reads one added and one removed rather than nothing.
/// Both numbers describe statements that really ran, and the cheaper answer would be a
/// per-item `count(*)` over a table that can hold tens of thousands of rows.
///
/// **`updated` is therefore clamped at zero**, because that same line spends the item twice:
/// `items.len() - added - removed` is `1 - 1 - 1` for a one-line file of that shape, and a
/// negative count of rows updated is not a number any dialog can say. It is unreachable from the
/// shipped importer — both parsers refuse a quantity below 1 (`src/features/transfer/import/
/// parse.ts`) — so the clamp is a fence rather than a case, and the honest reading of a `0` here
/// is "nothing was updated", which is exactly what happened. Clamped rather than restructured:
/// `added` and `removed` each name statements that ran, and making `updated` the subtraction of
/// two counts that can overlap is what costs the invariant, not the counters themselves.
fn commit_import(
    conn: &Connection,
    items: &[CollectionImportItem],
    mode: &str,
) -> Result<ImportCommitOutcome, String> {
    // Before the transaction opens, not inside it: a refusal that has already begun a write
    // is a rollback the reader pays for.
    if mode != "add" && mode != "set" {
        return Err(format!(
            "`{mode}` is not an import mode. Use `add` or `set`."
        ));
    }
    let before: i64 = conn
        .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut removed = 0i64;
    for item in items {
        let input = EntryInput {
            card_id: item.card_id.clone(),
            finish: item.finish.clone(),
            condition: item.condition.clone(),
            condition_original: item.condition_original.clone(),
            quantity: item.quantity,
            tradelist_quantity: 0,
            purchase_price: item.purchase_price,
            purchase_currency: item.purchase_currency.clone(),
            acquired_at: item.acquired_at.clone(),
            acquisition_source: item.acquisition_source.clone(),
            // The six grain columns, carried rather than defaulted. Hard-coded here until
            // schema v24, which is why a re-import could not land on an altered or graded
            // row — see [`CollectionImportItem`].
            serial_number: item.serial_number.clone(),
            altered: item.altered,
            signed: item.signed,
            proxy: item.proxy,
            misprint: item.misprint,
            grading: item.grading.clone(),
            // Still `None`, and it is not one of the six: `tags` is a set the reader curates on
            // the row and is deliberately absent from both writes' `DO UPDATE`, so a file has
            // nothing to say about it.
            tags: None,
            notes: item.notes.clone(),
            // Spelled rather than defaulted, `deck_categories.origin`'s rule: an import names
            // no folder, and a `..Default::default()` here would be a decision nobody can see
            // at the call site on the one field that is part of the grain.
            folder_id: None,
        };
        if mode == "add" {
            add_entry(&tx, &input)?;
        } else {
            let change = set_entry(&tx, &input)?;
            if change.quantity == 0 {
                remove_entry(&tx, change.id)?;
                removed += 1;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    let after: i64 = conn
        .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let added = after - before + removed;
    Ok(ImportCommitOutcome {
        added,
        // `.max(0)` for the one line that is counted in two of the three — see this function's
        // doc. Every other file shape makes this subtraction exact.
        updated: (items.len() as i64 - added - removed).max(0),
        removed,
    })
}

/// Set an absolute quantity. **Zero removes the row**, and the row's whole story with it.
///
/// This is the reversal of the ruling `collection_entries`' schema comment was written under,
/// and it was the reader's own call. A collection is what somebody *has*; a row saying they
/// have none of a printing is a row that says nothing, and every list, count and total in the
/// app carried a special case to describe it. So the stepper in the collection table taken to
/// zero now means what it looks like it means.
///
/// **What that costs is exactly what the old rule was preserving**, and it is worth naming
/// rather than discovering: the row's `condition` and `condition_original`, the purchase price
/// and currency, `acquired_at`, the acquisition source, the notes and the tags all go. A reader
/// who trades a playset away and buys it back next year retypes every one of them.
///
/// [`remove_entry`] is therefore no longer the only door out — but it is still the only one
/// that is *unconditional*: an id that resolves to nothing is a success there and [`GONE`]
/// here, because an adjustment to a row that is not there could not do what it was asked.
///
/// **`CHECK (quantity >= 0)` stays on the column** and is not a leftover: the guard is the
/// command, and an intermediate zero inside a transaction — [`commit_import`]'s `set` mode
/// writes one before deleting it — is still legal. [`update_entry`] is the other deliberate
/// exception, and its own doc says why.
pub fn set_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String> {
    valid_quantity(quantity, "collection quantity")?;
    if quantity == 0 {
        let gone = conn
            .execute("DELETE FROM collection_entries WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        if gone == 0 {
            return Err(GONE.to_owned());
        }
        return Ok(EntryChange {
            id,
            quantity: 0,
            removed: true,
        });
    }
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
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(GONE.to_owned());
    }
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// The edit, as one statement. Absent fields are left alone (`coalesce(?n, column)`), which is
/// what makes it usable from a form that only sends what it changed.
///
/// **`OR IGNORE`, and that is [`update_entry`]'s whole collision detector**: eight of the
/// eighteen holes are grain columns, so an edit really can land on a row the collection already
/// holds — and a plain `UPDATE` answers that as `UNIQUE constraint failed`, from inside a
/// statement that has already decided nothing. Ignored, it changes no row and returns nothing,
/// which is the same answer an id that is not there gives; telling the two apart is the caller's
/// next question, and it is a cheaper one than unpicking an error string.
///
/// **`OR IGNORE` ignores *every* constraint on the table, though, not only
/// `idx_collection_grain` — so the ignore is narrowed by refusing the rest in words before this
/// statement ever runs.** Otherwise a third reason for "no row changed" arrives dressed as the
/// first two: a bad value updates nothing, no collision target is found, and the answer is
/// [`GONE`] about a row that is sitting right there. The census, and where each one is stopped:
/// `finish` and `condition` by [`valid_finish`] and [`valid_condition`], `quantity` and
/// `tradelist_quantity` by [`valid_quantity`], `grading`'s `json_valid` by [`canonical_grading`],
/// which re-serialises it, and `tags`' by [`valid_tags`], which was the one hole and the one this
/// paragraph was written for. `NOT NULL` cannot fire — every hole is a `coalesce` over the
/// column's own value — and the two soft columns (`card_id`, `lang`) are not reachable from a
/// patch at all. **A new CHECK on `collection_entries` needs its refusal on this list**, or it
/// will be reported to a reader as a deleted row.
///
/// One constant because [`update_entry`] runs it **twice** on the folding path — once with every
/// hole filled, and once with the eight grain holes bound to NULL, which is the same statement
/// saying "leave the grain alone".
const PATCH_SQL: &str = "UPDATE OR IGNORE collection_entries SET
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
             RETURNING quantity";

/// Apply an edit. Absent fields are left alone — see [`PATCH_SQL`], which is the statement.
///
/// A `quantity` of zero is applied like any other and **keeps the row**, which is the one place
/// left in this module where zero does. [`set_quantity`] deletes at zero because a stepper taken
/// to zero says "I have none of these"; this is an edit form, and nothing a reader types into a
/// number field beside seven other fields should delete the row they are editing. The
/// asymmetry is deliberate and is the reason the column's `CHECK` is `>= 0`.
///
/// # An edit onto a grain the collection already holds folds into it
///
/// Eight of the patch's fields are grain columns, so a reader can ask a row to become a row they
/// already have — the same LP copy edited to NM when an NM row is already there. That answered
/// a refusal until schema v24 ("You already have an entry for that printing at that finish and
/// condition — change its quantity instead"), which put the work back on the reader and was
/// already the odd one out: `collection_folders::set_entry_folder` merges rather than refusing
/// when a card is filed into a folder that holds its printing, and `reconcile` has folded a
/// collided repoint since Plan 2. An edit is the same fact from the third side — the reader has
/// said these two rows are one row — so it is answered the same way, by the same five statements
/// ([`fold_entry`]).
///
/// **The answer therefore names a row the caller did not pass in.** That is what [`EntryChange`]
/// carries an `id` for, and the collection table has to follow it: the row the reader was editing
/// is gone.
///
/// **The patch's non-grain half is applied to the source *before* the fold**, so a reader who
/// corrects the condition and the quantity in one press folds the quantity they typed rather
/// than the one the row had. The grain half is applied to nothing at all — the surviving row
/// already carries every value it names, which is precisely why the two collided.
///
/// **Why not `collection_folders::refile_entry`, which is the crate's other merge-on-taken-grain
/// door**: that one probes for a target using the row's grain *as stored*, so it can express
/// "this row moved onto a folder that is taken" and cannot express "this row was edited onto a
/// grain that is taken" — the ten non-folder terms differ at the moment it would have to look.
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
    // The one CHECK on this table that nothing else here stands in front of — see [`valid_tags`]
    // for why `OR IGNORE` makes it this function's problem rather than SQLite's.
    if let Some(t) = patch.tags.as_deref() {
        valid_tags(t)?;
    }
    let grading = canonical_grading(patch.grading.as_deref())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;

    let applied: Option<i64> = tx
        .query_row(
            PATCH_SQL,
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
        .map_err(|e| e.to_string())?;
    if let Some(quantity) = applied {
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(EntryChange {
            id,
            quantity,
            removed: false,
        });
    }

    // Nothing changed, and `OR IGNORE` will not say which of the two reasons it was. The
    // grain the edit *would have* landed on is the question that separates them: a row
    // answering it is the row in the way, and no row answering it means there was nothing to
    // edit. Ten of the eleven terms are `coalesce(<patch>, <the source's own>)` — the grain
    // **after** the patch rather than before it, which is `reconcile::collision_target`'s rule
    // and its reason. `card_id` and `lang` are properties of the printing and no patch reaches
    // them; `folder_id` is `collection_folders`' to move and no patch reaches that either, so
    // both are read straight off the source row. Spelled out rather than interpolated from
    // `schema::COLLECTION_GRAIN` for that constant's own reason: it is a list of expressions
    // over one row, and this compares the same list between two.
    //
    // At most one row can match, because these eleven terms *are* `idx_collection_grain`.
    let target: Option<i64> = tx
        .query_row(
            "SELECT t.id FROM collection_entries t, collection_entries s
              WHERE s.id = ?1 AND t.id <> s.id
                AND t.card_id = s.card_id
                AND t.lang = s.lang
                AND t.finish = coalesce(?2, s.finish)
                AND t.condition = coalesce(?3, s.condition)
                AND t.altered = coalesce(?4, s.altered)
                AND t.signed = coalesce(?5, s.signed)
                AND t.proxy = coalesce(?6, s.proxy)
                AND t.misprint = coalesce(?7, s.misprint)
                AND coalesce(t.serial_number,'') = coalesce(?8, s.serial_number, '')
                AND coalesce(t.grading,'') = coalesce(?9, s.grading, '')
                AND coalesce(t.folder_id, 0) = coalesce(s.folder_id, 0)",
            params![
                id,
                patch.finish,
                patch.condition,
                patch.altered,
                patch.signed,
                patch.proxy,
                patch.misprint,
                patch.serial_number,
                grading,
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(target) = target else {
        return Err(GONE.to_owned());
    };

    // The same statement, with the eight grain holes bound to NULL: everything the reader
    // typed that is *not* what made the two rows one, onto the row that is about to fold.
    tx.query_row(
        PATCH_SQL,
        params![
            id,
            None::<String>,
            None::<String>,
            patch.condition_original,
            patch.quantity,
            patch.tradelist_quantity,
            patch.purchase_price,
            patch.purchase_currency,
            patch.acquired_at,
            patch.acquisition_source,
            None::<String>,
            None::<bool>,
            None::<bool>,
            None::<bool>,
            None::<bool>,
            None::<String>,
            patch.tags,
            patch.notes,
        ],
        |r| r.get::<_, i64>(0),
    )
    .map_err(|e| e.to_string())?;
    fold_entry(&tx, target, id).map_err(|e| e.to_string())?;
    let quantity: i64 = tx
        .query_row(
            "SELECT quantity FROM collection_entries WHERE id = ?1",
            params![target],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id: target,
        quantity,
        removed: false,
    })
}

/// Delete the row outright — the **unconditional** delete, where [`set_quantity`]'s zero and
/// [`fold_entry`] are the two conditional ones.
///
/// (It was the only delete in this module until schema v24, and it is worth knowing which of
/// the three a stale id reaches.) Deliberately asymmetric with [`set_quantity`] and
/// [`update_entry`], which answer [`GONE`] for an id that resolves to nothing: an adjustment to
/// a row that is not there could not do what it was asked, but a delete that finds nothing
/// already has what it wanted. The caller that sends a stale id here is a list still holding a
/// row something else removed, and telling it the row it wants gone is gone is not
/// information — it is an error dialog over a success.
pub fn remove_entry(conn: &Connection, id: i64) -> Result<EntryChange, String> {
    conn.execute("DELETE FROM collection_entries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity: 0,
        removed: true,
    })
}

/// Fold `source` into `target` and delete it — the crate's answer to "one collection row
/// becomes another", with no opinion at all about *why* the two are one row.
///
/// Three callers ask that question three ways and share this answer:
/// [`update_entry`], where the reader edited a row onto a grain another row holds;
/// `reconcile::fold_into_existing`, where an upstream id merge repointed one onto another; and
/// `collection_folders::merge_entry`, where a card was filed — by a drag, or by the re-filing a
/// folder delete does one row at a time — into a folder that already holds its printing. It
/// lived in the reconciler until schema v24 made the third and the first possible in one release.
///
/// **This is the only copy in the crate, and that is the point.** The reconciler and the folder
/// tree each carried their own spelling of these five statements while v24 was being built. Two
/// implementations of one rule disagree the first time either changes, and what this one guards
/// is a built deck's claims (below), so both now call it and neither keeps a statement of its
/// own.
///
/// **`pub(crate)` and taking a `&Connection` rather than a `&Transaction`**, so either caller's
/// handle fits, and it commits nothing: whoever opened the transaction owns it.
///
/// # What moves
///
/// The quantities add, and the five columns the user typed themselves — what they paid, in what
/// currency, when, where from, and their note — are taken by the survivor **only where it has
/// none**. That is [`add_entry`]'s `ON CONFLICT` rule verbatim, and for the same reason: the
/// survivor's own answers are not up for revision, but a fold that dropped the other row's is a
/// receipt destroyed to resolve a collision the reader did not cause.
///
/// `tags` and `condition_original` are deliberately absent, exactly as they are from
/// `add_entry`'s `DO UPDATE`. Tags are a set the user curates per row, and merging two sets is
/// not something one statement should decide; `condition_original` is the provenance of *this*
/// row's condition — the string one import used — and it cannot describe a condition it was
/// never written beside. Both stay the survivor's, and the entry editor is where they change.
///
/// # And the decks' claims move with it
///
/// `deck_allocations.collection_entry_id` is the only enforced foreign key pointed at a
/// collection entry, `ON DELETE CASCADE` (schema v5) so that [`remove_entry`] takes the
/// reservations with the row. **This delete must therefore leave nothing for the cascade to
/// take**: the copies still exist and the deck still wants them. Claims on the folding row move
/// to the survivor; where the deck already claims the survivor, the two claims fold first —
/// their grain is one row per `(deck, entry)`, the same shape as the entries' own.
///
/// All three allocation statements seek through `idx_deck_allocations_entry`, and every
/// statement here is inside the caller's transaction: an allocation is never briefly homeless,
/// and a pass that fails takes the whole fold back with it.
pub(crate) fn fold_entry(tx: &Connection, target: i64, source: i64) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE collection_entries AS t SET
            quantity = t.quantity + s.quantity,
            tradelist_quantity = t.tradelist_quantity + s.tradelist_quantity,
            purchase_price = coalesce(t.purchase_price, s.purchase_price),
            purchase_currency = coalesce(t.purchase_currency, s.purchase_currency),
            acquired_at = coalesce(t.acquired_at, s.acquired_at),
            acquisition_source = coalesce(t.acquisition_source, s.acquisition_source),
            notes = coalesce(t.notes, s.notes),
            updated_at = unixepoch()
          FROM (SELECT * FROM collection_entries WHERE id = ?2) AS s
          WHERE t.id = ?1",
        params![target, source],
    )?;
    tx.execute(
        "UPDATE deck_allocations AS t SET
            quantity = t.quantity + s.quantity,
            updated_at = unixepoch()
          FROM (SELECT deck_id, quantity FROM deck_allocations
                 WHERE collection_entry_id = ?2) AS s
          WHERE t.deck_id = s.deck_id AND t.collection_entry_id = ?1",
        params![target, source],
    )?;
    tx.execute(
        "DELETE FROM deck_allocations
          WHERE collection_entry_id = ?2
            AND EXISTS (SELECT 1 FROM deck_allocations t
                         WHERE t.deck_id = deck_allocations.deck_id
                           AND t.collection_entry_id = ?1)",
        params![target, source],
    )?;
    tx.execute(
        "UPDATE deck_allocations SET collection_entry_id = ?1, updated_at = unixepoch()
          WHERE collection_entry_id = ?2",
        params![target, source],
    )?;
    tx.execute(
        "DELETE FROM collection_entries WHERE id = ?1",
        params![source],
    )?;
    Ok(())
}

#[tauri::command]
pub async fn collection_add(
    state: tauri::State<'_, Arc<AppState>>,
    entry: EntryInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| add_entry(c, &entry))
    })
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
        crate::collection_source::with_write_owned(&state, |c| set_quantity(c, id, quantity))
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
        crate::collection_source::with_write_owned(&state, |c| update_entry(c, id, &patch))
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
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| remove_entry(c, id))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// One transaction for a whole imported file — see [`commit_import`] for why added/updated are
/// counted rather than looked up on the grain.
#[tauri::command]
pub async fn collection_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<CollectionImportItem>,
    mode: String,
) -> Result<ImportCommitOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::collection_source::with_write_owned(&state, |c| commit_import(c, &items, &mode))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}

/// What one owned card is worth at the reader's marketplace, **by finish** — the entry's own
/// `e.finish`, handed to [`crate::sorting::price_expr`].
///
/// Never `cards.price_usd`: that column is a display/sort fallback chain
/// (`usd → usd_foil → usd_etched`) and would price a plain copy of a card whose only
/// listed price is its foil at the foil's price. A finish with no price is `NULL` —
/// which is a different statement from `0.00`, and is counted as such, in every marketplace.
pub const ENTRY_FINISH: &str = "e.finish";

/// Rows per page. The collection is not 116 k rows, but it can be tens of thousands, and
/// the table is virtualised for the same reason the search results are.
const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

/// Whether the list is narrowed to copies that are still the reader's to do something with.
///
/// **The vocabulary is about folders and nothing else.** `deck_allocations` is what "spoken for"
/// means today, but a `deck` folder is what it will mean once the deck-driven collection lands
/// (schema v24 created the kind; nothing writes one yet), and the two must not both be a filter
/// on this query — a list that could disagree with itself about which copies a deck holds is
/// worse than a list that cannot answer at all yet.
///
/// `All` is what every caller written before folders existed gets, and is what an absent field
/// means: a collection lists what its owner owns.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Allocation {
    /// Every row, wherever it is filed. Today's behaviour, and the default.
    All,
    /// Everything except the copies a deck holds — the root, every folder the reader made, and
    /// `Recently removed`, because all three are cards on the reader's desk. `removed` is on
    /// this side deliberately: a card that left the collection without leaving the database is
    /// not a card a deck is using, and the folder exists so the reader can put it back.
    Unallocated,
}

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
    /// One folder's direct members, or — absent — **every folder there is**.
    ///
    /// **The opposite convention to [`crate::wishlist::WishlistQuery::folder_id`]**, where
    /// `None` is the root and a second `all_folders` flag says "do not filter". That shape is
    /// the better one and this is not it, for one reason: this field is being added to a query
    /// that has always answered the whole collection, and every caller — the table, the export's
    /// paged sweep, the summary header — must keep getting exactly what it got. A `None` that
    /// meant the root would silently narrow all of them on the day it landed. The cost is that
    /// "the root, and only the root" is not expressible here yet; the collection page draws a
    /// tree rather than one folder at a time, so nothing asks the question.
    ///
    /// Direct members only — a folder's page lists what is filed *in* it, never what is filed in
    /// the folders inside it, which is `collection_folders::folder_summary`'s rule and
    /// `folderTree.ts`'s job.
    pub folder_id: Option<i64>,
    /// Whether to leave out the copies a deck holds. Absent is [`Allocation::All`], which is
    /// what every caller written before folders existed asked for without saying so.
    pub allocation: Option<Allocation>,
    /// How to order the list: columns in priority order, the first deciding and the rest
    /// breaking its ties. Empty or absent is name order. Keys outside [`COLLECTION_SORTS`]
    /// are dropped, never interpolated.
    pub sort: Option<Vec<crate::sorting::SortTerm>>,
    /// Where to quote prices from — the source of every figure on the page and the order the
    /// `value` and `price` sorts read. Absent, or anything this build does not recognise,
    /// means `tcgplayer`, which is what every caller had before there was a marketplace to
    /// pick. See [`crate::sorting::Marketplace`].
    pub marketplace: crate::sorting::Marketplace,
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
    /// The oracle card this printing is of — read straight off `cards.oracle_id`, never
    /// denormalised onto the entry.
    ///
    /// **`None` means exactly one thing: this entry is orphaned.** `cards.oracle_id` is
    /// NULLABLE by the JSON's own contract, but no live row is ever null (0 of 116,590,
    /// reversible printings included — see [`crate::card_row`]), so a healthy entry's card
    /// row always answers one. This is the fact the card menu's "View all printings" reads
    /// to tell "this printing has left the card database" from "the reader's copy is fine" —
    /// before this field existed every row read `None` and the menu could not draw that
    /// distinction at all.
    pub oracle_id: Option<String>,
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
    /// What state the copy is in — `e.condition`, straight off the entry, and always one of
    /// [`CONDITIONS`].
    ///
    /// **Not `Option`, because the column is `TEXT NOT NULL DEFAULT 'NM'`** (`schema.rs`) and no
    /// write in the crate can leave it unset: `valid_condition` turns an absent one into
    /// `DEFAULT_CONDITION` before either insert, and no patch can clear it. It was `Option` for
    /// three releases as a fence around the wire, which cost every reader of the row a branch
    /// that could not be reached and a `null` the export layer had to decide about. The reader
    /// who never stated a grade is not represented by a missing `condition`; they are
    /// represented by `condition_original` being `None`, which is the column that records what a
    /// file actually said.
    pub condition: String,
    pub quantity: i64,
    pub tradelist_quantity: i64,
    /// Per copy, per finish, at the marketplace the query named. `None` when that marketplace
    /// has no price for that finish — a fact about the marketplace, never filled in from
    /// another one.
    pub unit_price: Option<f64>,
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
    /// JSON, verbatim: Scryfall's `promo_types` for the printing this entry names — the column
    /// the **kind** of foil lives in, and `None` for an orphan whose card has left `cards`.
    ///
    /// From the *card*, unlike [`Self::finish`] two fields up, and the two are read together:
    /// the entry says which copy the reader owns and this says what that copy is called, so a
    /// `foil` entry on a Surge Foil printing is a Surge Foil and a `nonfoil` one on the same
    /// printing is not. `src/lib/treatment.ts` owns the naming.
    pub promo_types: Option<String>,
    /// JSON, verbatim: this printing's `legalities` object, the same blob
    /// [`crate::deck::DeckCard::legalities`] carries and for the same reason — a fact, read by
    /// TypeScript, never a verdict decided here.
    ///
    /// **It rides here for the Arena export filter and nothing else on this screen.** The
    /// collection view draws none of it; `src/features/transfer/export/arena.ts` is the one
    /// reader, and the export's paged sweep goes through this command like any other list. Its
    /// cost is on the record because it is the largest string on the row by some way — 483
    /// bytes on average and 528 at most, over the 116,712-printing corpus of 2026-08-22, where
    /// `promo_types` beside it averages 23. The blob rather than `cards.legal_mask`, which
    /// would have cost 8: bit positions are stored data this half of the app owns
    /// ([`crate::legalities`]), and a copy of them in TypeScript would be a second place for
    /// the frozen order to drift. Key *names* are Scryfall's public vocabulary and cannot.
    pub legalities: Option<String>,
    /// Which folder this row is filed in, `None` for the root — the eleventh term of
    /// [`COLLECTION_GRAIN`] since schema v24, and the reason two rows for one printing at one
    /// finish and condition can both be real.
    ///
    /// The table needs it to draw the row's filing menu with its own folder already ticked, and
    /// a drag needs it to tell a move from a drop that changes nothing.
    pub folder_id: Option<i64>,
    /// That folder's name, or `None` at the root — a correlated lookup rather than a second
    /// join, for the reason [`from_sql`] gives about widening the one `FROM`.
    ///
    /// **On the row rather than resolved on the page from `collection_folder_list`**, because a
    /// row and its folder have to be *one* answer: the list is paged and the census is a
    /// separate command, so a folder created, renamed or deleted between the two would print a
    /// row under a name the cabinet no longer has. `None` means the root and never "a folder
    /// whose name I could not find" — `collection_entries.folder_id` is a real foreign key, so
    /// the id and the name arrive together or not at all.
    pub folder_name: Option<String>,
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
    /// Copies, not rows. A row holding none contributes 0 here — which is the whole reason
    /// this sums `quantity` rather than counting rows. Rare since schema v24, because
    /// [`set_quantity`] deletes at zero and only [`update_entry`] still writes one, but the
    /// sum is the right arithmetic whether or not such a row exists this week.
    pub total_cards: i64,
    /// Distinct printings **recorded**, not distinct printings currently held: a row holding
    /// no copies still names a card the user has an entry for, and it is still on the screen
    /// this number captions. Counting only what has copies today would make the header
    /// disagree with the list under it.
    pub unique_cards: i64,
    pub entries: i64,
    pub tradelist_cards: i64,
    /// What the listed rows are worth at the marketplace the query named.
    pub value: f64,
    /// Copies that marketplace has no price for. Shown beside the value, because a total that
    /// silently omits 400 cards is a number that lies by rounding down — and the figure moves
    /// with the marketplace, which is the point of showing it.
    pub unpriced: i64,
    pub needs_review: i64,
}

/// The rows every statement here reads, and the only join any of them makes.
///
/// LEFT JOIN, always: an entry whose printing is gone is the case the denormalised columns
/// exist for, and an inner join would delete exactly those rows from the view that most
/// needs them. Nothing widens this — see [`scope`] for why even the text filter reaches
/// `cards_fts` through a subquery rather than a second join.
///
/// One function rather than a literal in three statements, because the page, the count and the
/// summary must all read the same rows: a `FROM` spelled out three times is three places for
/// the next change to reach two of.
fn from_sql() -> String {
    "collection_entries e LEFT JOIN cards c ON c.id = e.card_id".to_owned()
}

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
    if let Some(folder) = q.folder_id {
        p.push("e.folder_id = ?".to_owned(), Box::new(folder));
    }
    // A correlated lookup rather than a join, for [`from_sql`]'s reason: the page, the count
    // and the summary all read that one `FROM`, and widening it for a filter two of them do not
    // use is how a total comes to describe different rows than the list above it. `IS NULL`
    // first because the root is where most copies are and is not a folder to look up — a
    // `<> 'deck'` over a NULL id is NULL, which is not true, so the root would drop out of the
    // very list that is mostly root.
    if q.allocation == Some(Allocation::Unallocated) {
        p.wheres.push(
            "(e.folder_id IS NULL
              OR (SELECT f.kind FROM collection_folders f WHERE f.id = e.folder_id) <> 'deck')"
                .to_owned(),
        );
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

/// `value` and `price` — the two keys that turn on the reader's marketplace.
///
/// Both order by the **output alias** of the per-finish price expression the page already
/// selects, and never by any column of either table, so the order and the cell cannot come
/// from two marketplaces. That alias is what [`UNIT_PRICE_ALIAS`] names and what
/// [`crate::sorting::sorts_for`] fills the hole with.
///
/// The marketplace's own holes ride along: an etched row is NULL on Cardmarket — there is no
/// `eur_etched` key — and sorts last in both directions, where on TCGplayer it has a price and
/// does not. That is the marketplace being honest rather than the sort being wrong.
const COLLECTION_PRICE_SORTS: &[crate::sorting::PricedSort] = &[
    crate::sorting::PricedSort {
        key: "value",
        asc: "{price} * e.quantity ASC NULLS LAST",
        desc: "{price} * e.quantity DESC NULLS LAST",
    },
    crate::sorting::PricedSort {
        key: "price",
        asc: "{price} ASC NULLS LAST",
        desc: "{price} DESC NULLS LAST",
    },
];

/// What the page calls its price column, and therefore what its money sorts order by.
const UNIT_PRICE_ALIAS: &str = "unit_price";

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
    let from = from_sql();

    // The count first, while `params` holds exactly the filter parameters. Counted in
    // full — this is a collection, not a 116 k-row table, and a pager that says "1 240
    // cards" should mean it.
    let total: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM {from} WHERE {where_sql}"),
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sql = format!(
        "SELECT e.id, e.card_id, c.name, e.set_code, c.set_name, e.collector_number, e.lang,
                c.rarity, c.mana_cost, c.type_line, c.layout,
                e.finish, e.condition, e.quantity, e.tradelist_quantity,
                {price} AS {UNIT_PRICE_ALIAS},
                e.purchase_price, e.purchase_currency, e.acquired_at, e.acquisition_source,
                e.serial_number, e.altered, e.signed, e.proxy, e.misprint, e.grading,
                e.tags, e.notes, e.needs_review, e.updated_at, c.oracle_id, c.promo_types,
                c.legalities, e.folder_id,
                (SELECT f.name FROM collection_folders f WHERE f.id = e.folder_id)
         FROM {from} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
        price = crate::sorting::price_expr(q.marketplace, ENTRY_FINISH),
        order = crate::sorting::order_by(
            q.sort.as_deref(),
            &crate::sorting::sorts_for(COLLECTION_SORTS, COLLECTION_PRICE_SORTS, UNIT_PRICE_ALIAS),
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
                    unit_price: r.get(15)?,
                    purchase_price: r.get(16)?,
                    purchase_currency: r.get(17)?,
                    acquired_at: r.get(18)?,
                    acquisition_source: r.get(19)?,
                    serial_number: r.get(20)?,
                    altered: r.get(21)?,
                    signed: r.get(22)?,
                    proxy: r.get(23)?,
                    misprint: r.get(24)?,
                    grading: r.get(25)?,
                    tags: r.get(26)?,
                    notes: r.get(27)?,
                    needs_review: r.get(28)?,
                    updated_at: r.get(29)?,
                    // Appended rather than inserted at its logical place beside `name`, so
                    // every index above stays exactly what it was — one changed line instead
                    // of thirty.
                    oracle_id: r.get(30)?,
                    // 31, appended for the same reason — and `oracle_id` and this are both
                    // nullable TEXT, so an insertion above would have swapped two fields that
                    // each still held a plausible string.
                    promo_types: r.get(31)?,
                    // 32, appended for the third time and for the same reason.
                    legalities: r.get(32)?,
                    // 33 and 34, appended for the fourth and fifth. The rule this file has
                    // followed three times over is worth stating: **every new column goes on
                    // the end**, never at its logical place beside its neighbours, because an
                    // insertion shifts every `r.get(N)` below it and the compiler cannot see
                    // it — `oracle_id`, `promo_types` and `legalities` are all nullable TEXT,
                    // so two of them swapping would still hand back a plausible string.
                    folder_id: r.get(33)?,
                    folder_name: r.get(34)?,
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
                coalesce(sum(e.quantity * coalesce({price}, 0.0)), 0.0),
                coalesce(sum(CASE WHEN {price} IS NULL THEN e.quantity ELSE 0 END), 0),
                coalesce(sum(CASE WHEN e.needs_review IS NOT NULL THEN 1 ELSE 0 END), 0)
         FROM {from} WHERE {where_sql}",
        from = from_sql(),
        price = crate::sorting::price_expr(q.marketplace, ENTRY_FINISH)
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
                value: r.get(4)?,
                unpriced: r.get(5)?,
                needs_review: r.get(6)?,
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
        // A generic printing for `commit_import`'s tests, which name their cards `card-1`
        // rather than a real Lightning Bolt — the import commands operate on ids alone.
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,finishes,prices,raw)
             VALUES ('card-1','o2','Test Card','tst','1','en','normal','common',
                '[\"nonfoil\",\"foil\"]','{\"usd\":\"1.00\"}','{}')",
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

    /// **A collection row carries the printing's `promo_types` beside the entry's own
    /// `finish`, and the two are read together.**
    ///
    /// Issue #160: the entry says which copy the reader owns and this says what that copy is
    /// called, so the foil of a Surge Foil printing is a Surge Foil and the plain copy of the
    /// same printing is not. That distinction is `src/lib/treatment.ts`' to draw; this test is
    /// about the column arriving, and arriving at the right index.
    ///
    /// Appended after `c.oracle_id` on that field's own argument — every index above stays what
    /// it was. Both are **nullable TEXT**, which is exactly why it is worth an assertion: an
    /// insertion above would have swapped two fields that each still held a plausible string,
    /// and `oracle_id` is what the card menu reads to tell an orphan from a healthy row.
    #[test]
    fn a_collection_row_carries_the_printings_promo_types() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET promo_types = '[\"surgefoil\"]' WHERE id = 'bolt-jp'",
            [],
        )
        .unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 1)).unwrap();

        let rows = list_entries(&conn, &CollectionQuery::default())
            .unwrap()
            .items;
        let of = |card: &str, finish: &str| {
            rows.iter()
                .find(|r| r.card_id == card && r.finish == finish)
                .unwrap_or_else(|| panic!("no {finish} row for {card}"))
        };

        // Both copies of the treated printing carry the column — the printing is a Surge Foil
        // printing either way, and *which copy this is* is the other field on the same row.
        assert_eq!(
            of("bolt-jp", "foil").promo_types.as_deref(),
            Some(r#"["surgefoil"]"#)
        );
        assert_eq!(
            of("bolt-jp", "nonfoil").promo_types.as_deref(),
            Some(r#"["surgefoil"]"#)
        );
        // The neighbour an insertion would have displaced, and the field that is not the card's.
        assert_eq!(of("bolt-jp", "foil").oracle_id.as_deref(), Some("o1"));
        assert!(of("bolt-jp", "foil").updated_at > 0);

        // A printing with no treatment answers `None` rather than an empty array.
        assert_eq!(of("bolt-lea", "nonfoil").promo_types, None);
    }

    /// **A collection row carries the printing's `legalities`, at the index the appended
    /// column put it at.**
    ///
    /// Issue #192: the Arena export offers to leave out cards that are not in MTG Arena, and
    /// this blob is the only fact that answers it — `src/features/transfer/export/arena.ts`
    /// reads the key *names*, never a bit position. The verdict is TypeScript's; the column
    /// arriving is this test's.
    ///
    /// Appended after `c.promo_types` on that field's own argument, and worth an assertion for
    /// that field's own reason: it is the **third** nullable TEXT column on the end of the
    /// list, so a fourth inserted above rather than appended would swap two fields that each
    /// still held a plausible string. Both neighbours are asserted here for exactly that.
    #[test]
    fn a_collection_row_carries_the_printings_legalities() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET legalities = '{\"timeless\":\"legal\"}' WHERE id = 'bolt-lea'",
            [],
        )
        .unwrap();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();

        let rows = list_entries(&conn, &CollectionQuery::default())
            .unwrap()
            .items;
        let of = |card: &str| rows.iter().find(|r| r.card_id == card).unwrap();

        assert_eq!(
            of("bolt-lea").legalities.as_deref(),
            Some(r#"{"timeless":"legal"}"#)
        );
        // The two nullable TEXT neighbours an insertion would have displaced.
        assert_eq!(of("bolt-lea").oracle_id.as_deref(), Some("o1"));
        assert_eq!(of("bolt-lea").promo_types, None);
        // A printing the seed gave no legalities answers `None`, not an empty object.
        assert_eq!(of("bolt-jp").legalities, None);
    }

    /// One line of a bulk import, in the shape [`commit_import`]'s tests use it — the plain
    /// copy, which is what an absent field means on the wire and what every line of a file
    /// that says nothing about slabs or alterations describes.
    fn item(card_id: &str, quantity: i64, finish: &str) -> CollectionImportItem {
        CollectionImportItem {
            card_id: card_id.to_owned(),
            quantity,
            finish: finish.to_owned(),
            condition: None,
            condition_original: None,
            purchase_price: None,
            purchase_currency: None,
            acquired_at: None,
            acquisition_source: None,
            notes: None,
            serial_number: None,
            altered: false,
            signed: false,
            proxy: false,
            misprint: false,
            grading: None,
        }
    }

    /// **An import line carries the six grain columns it used to have written for it.**
    ///
    /// `commit_import` hard-coded `altered`, `signed`, `proxy`, `misprint`, `serial_number` and
    /// `grading` until schema v24, and the damage was not a dropped flag: an altered copy and a
    /// plain one are two rows of `COLLECTION_GRAIN`, so a file describing the altered one landed
    /// on the *plain* grain every time. A reader re-importing their own export got a second
    /// all-defaults row beside the row they already had, quietly, on the one screen whose whole
    /// job is not to duplicate what the collection already records.
    ///
    /// One altered line and one plain line for the same printing is the cheapest seed where the
    /// two answers differ: two rows if the column is carried, one folded row of two copies if it
    /// is not. The graded half is the same statement through the column that enters identity as
    /// **raw text** — [`canonical_grading`] is what makes `{"grade":10,"company":"PSA"}` and
    /// `{"company":"PSA","grade":"10"}` one row rather than two, and it runs inside the write
    /// rather than in the planner, so this proves the text reached it at all.
    #[test]
    fn an_import_line_lands_on_its_own_grain_rather_than_on_the_plain_one() {
        let conn = seeded();
        let altered = CollectionImportItem {
            altered: true,
            ..item("card-1", 2, "nonfoil")
        };
        let graded = CollectionImportItem {
            grading: Some(r#"{"grade":10,"company":"PSA"}"#.to_owned()),
            ..item("card-1", 1, "nonfoil")
        };

        let out = commit_import(
            &conn,
            &[item("card-1", 3, "nonfoil"), altered, graded],
            "add",
        )
        .unwrap();

        assert_eq!(
            (out.added, out.updated, out.removed),
            (3, 0, 0),
            "three lines, three grains, three rows"
        );
        let rows: Vec<(i64, bool, Option<String>)> = conn
            .prepare(
                "SELECT quantity, altered, grading FROM collection_entries
                  WHERE card_id = 'card-1' ORDER BY id",
            )
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            rows,
            vec![
                (3, false, None),
                (2, true, None),
                // Canonical, and in the struct's declaration order — not the order the file
                // spelled it in, which is the whole of why `grading` goes through `Grading`.
                (
                    1,
                    false,
                    Some(r#"{"company":"PSA","grade":"10"}"#.to_owned())
                ),
            ],
            "the plain copy, the altered one and the slab are three rows"
        );

        // The other half of the fix: re-importing the same three lines now folds onto the rows
        // it made, which is what a hard-coded default could never do.
        let again = commit_import(
            &conn,
            &[
                item("card-1", 1, "nonfoil"),
                CollectionImportItem {
                    altered: true,
                    ..item("card-1", 1, "nonfoil")
                },
            ],
            "add",
        )
        .unwrap();
        assert_eq!((again.added, again.updated), (0, 2));
        assert_eq!(entry_count(&conn), 3, "and made no fourth row");

        // Imports name no folder: a file says nothing about this reader's filing.
        let filed: Vec<Option<i64>> = conn
            .prepare("SELECT folder_id FROM collection_entries")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(filed.iter().all(Option::is_none), "every row at the root");
    }

    /// The one row a grain names, read back for the assertion.
    fn quantity_of(conn: &Connection, card_id: &str, finish: &str) -> i64 {
        conn.query_row(
            "SELECT quantity FROM collection_entries WHERE card_id = ?1 AND finish = ?2",
            params![card_id, finish],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn entry_count(conn: &Connection) -> i64 {
        conn.query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap()
    }

    /// One folder, straight into the table. `create_folder` is
    /// `collection_folders`' command and makes `user` rows only; a `deck` folder needs a deck
    /// to name — `collection_folders` CHECKs `(kind = 'deck') = (deck_id IS NOT NULL)` — so the
    /// two cannot be seeded apart, and nothing in this PR writes either kind.
    fn folder(conn: &Connection, kind: &str, name: &str) -> i64 {
        let deck_id: Option<i64> = (kind == "deck").then(|| {
            conn.query_row(
                "INSERT INTO decks (name, created_at, updated_at)
                 VALUES ('Mono red', unixepoch(), unixepoch()) RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap()
        });
        conn.query_row(
            "INSERT INTO collection_folders
                (parent_id, name, kind, deck_id, sort_order, created_at, updated_at)
             VALUES (NULL, ?1, ?2, ?3, 0, unixepoch(), unixepoch())
             RETURNING id",
            params![name, kind, deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One owned row, filed where the test says. Written straight into the table because
    /// `add_entry` cannot name a folder: filing is `collection_folders::set_entry_folder`'s act,
    /// and these tests want a filed row rather than the press that files it. Every column
    /// outside `folder_id` is held constant, so the folder **is** the grain as far as they are
    /// concerned — which is the point.
    fn filed_in(conn: &Connection, card_id: &str, folder_id: Option<i64>, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id, set_code, collector_number, lang, finish, condition, quantity,
                 folder_id, created_at, updated_at)
             VALUES (?1, 'lea', '161', 'en', 'nonfoil', 'NM', ?2, ?3, unixepoch(), unixepoch())
             RETURNING id",
            params![card_id, quantity, folder_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// **Adding into a folder is an *add*, and the eleventh grain term is what makes it one.**
    ///
    /// `EntryInput` is `#[serde(default)]` and not `deny_unknown_fields`, so before this field
    /// existed a page sending `folderId` on an add was answered by the field being **silently
    /// dropped**: every "Add to → Collection → \<binder\>" landed at the root, folded into
    /// whatever was already there, and reported success. Nothing raised, nothing logged, and
    /// the copies appear to *move* out of the binder the reader was pointing at — which is
    /// precisely the failure `COLLECTION_GRAIN`'s eleventh term exists to make impossible.
    ///
    /// Two rows for one printing at one finish, condition and language is therefore the whole
    /// assertion; the second half is that a *second* add into the same folder still folds, so
    /// the term narrows the grain rather than disabling the fold.
    #[test]
    fn adding_the_same_printing_into_a_folder_is_a_second_row() {
        let conn = seeded();
        let binder = folder(&conn, "user", "Binder");
        let in_folder = |quantity: i64| EntryInput {
            folder_id: Some(binder),
            ..input("bolt-lea", "nonfoil", quantity)
        };

        let at_root = add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        let filed = add_entry(&conn, &in_folder(3)).unwrap();

        assert_ne!(
            filed.id, at_root.id,
            "the folder is part of the grain, so this is a row and not a fold"
        );
        assert_eq!(
            filed.quantity, 3,
            "and none of the root's copies came with it"
        );
        assert_eq!(entry_count(&conn), 2);
        let where_they_are: Vec<(i64, Option<i64>, i64)> = conn
            .prepare("SELECT id, folder_id, quantity FROM collection_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            where_they_are,
            vec![(at_root.id, None, 2), (filed.id, Some(binder), 3)],
            "the column is written, not defaulted to the root"
        );

        // The same press again is "one more of these", which is what the fold is for.
        let again = add_entry(&conn, &in_folder(1)).unwrap();
        assert_eq!(again.id, filed.id, "the second add folds into the first");
        assert_eq!(again.quantity, 4);
        assert_eq!(entry_count(&conn), 2);

        // A folder that is not there is a sentence, not a constraint failure — and the refused
        // add writes nothing.
        assert_eq!(
            add_entry(
                &conn,
                &EntryInput {
                    folder_id: Some(404),
                    ..input("bolt-lea", "nonfoil", 1)
                },
            )
            .unwrap_err(),
            FOLDER_GONE
        );
        assert_eq!(entry_count(&conn), 2);
    }

    /// **An add may not file into a folder the app owns**, and the two kinds it refuses are the
    /// two nothing writes before v25: the folder standing for a deck, and `Recently removed`.
    ///
    /// The fence is `folder_named`'s and the wording is `collection_folders`', because the
    /// mistake is that module's: a `deck` folder's contents are what a built deck is made of and
    /// a `removed` one's are cards that left the collection, so an ordinary add landing in
    /// either would be asserting something only the app can make true. Those folders are written
    /// through `collection_folders::refile_entry`, which carries no such fence deliberately.
    ///
    /// **The pair is the assertion.** A check that only looked the folder up would pass a `deck`
    /// id happily — it exists — which is exactly the shape the bug had, so the root and a `user`
    /// folder are added into in the same test to prove the fence is about the *kind* and has not
    /// closed the door on the reader's own binders. Nothing is written by either refusal.
    #[test]
    fn an_add_refuses_a_folder_the_app_owns_and_still_takes_the_readers_own() {
        let conn = seeded();
        let binder = folder(&conn, "user", "Binder");
        let deck_folder = folder(&conn, "deck", "Mono red");
        let removed = folder(&conn, "removed", "Recently removed");

        let into = |id: i64| EntryInput {
            folder_id: Some(id),
            ..input("bolt-lea", "nonfoil", 1)
        };
        assert_eq!(
            add_entry(&conn, &into(deck_folder)).unwrap_err(),
            crate::collection_folders::FOLDER_NOT_YOURS
        );
        assert_eq!(
            add_entry(&conn, &into(removed)).unwrap_err(),
            crate::collection_folders::FOLDER_NOT_YOURS
        );
        assert_eq!(entry_count(&conn), 0, "a refused add writes nothing");

        // …and the reader's own two destinations still answer.
        add_entry(&conn, &into(binder)).unwrap();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 1)).unwrap();
        assert_eq!(entry_count(&conn), 2);
    }

    /// **`Unallocated` is about deck folders and nothing else.** The root, a folder the reader
    /// made and `Recently removed` are all cards on the reader's desk — the last one especially,
    /// because a card that left the collection without leaving the database is not a card a deck
    /// is using, and that folder exists so it can be put back.
    ///
    /// All four rows are the same printing at the same finish, condition and language, so they
    /// are four rows only because `coalesce(folder_id, 0)` is the eleventh term of
    /// `COLLECTION_GRAIN` — which makes the seed itself a check on schema v24.
    #[test]
    fn unallocated_excludes_only_deck_folders() {
        let conn = seeded();
        let user = folder(&conn, "user", "Binder");
        let removed = folder(&conn, "removed", "Recently removed");
        let deck = folder(&conn, "deck", "Mono red");
        let at_root = filed_in(&conn, "bolt-lea", None, 1);
        let in_binder = filed_in(&conn, "bolt-lea", Some(user), 1);
        let put_aside = filed_in(&conn, "bolt-lea", Some(removed), 1);
        let sleeved = filed_in(&conn, "bolt-lea", Some(deck), 1);

        let list = |allocation: Option<Allocation>| -> Vec<i64> {
            let page = list_entries(
                &conn,
                &CollectionQuery {
                    allocation,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                page.total,
                page.items.len() as i64,
                "the count agrees with the page it captions"
            );
            page.items.iter().map(|r| r.id).collect()
        };

        assert_eq!(
            list(Some(Allocation::Unallocated)),
            vec![at_root, in_binder, put_aside],
            "only the deck folder's copies are spoken for"
        );
        assert!(!list(Some(Allocation::Unallocated)).contains(&sleeved));
        // Both spellings of "do not filter", because an absent field is what every caller
        // written before folders existed sends.
        assert_eq!(
            list(Some(Allocation::All)),
            vec![at_root, in_binder, put_aside, sleeved]
        );
        assert_eq!(list(None), list(Some(Allocation::All)));

        // The header describes the same rows as the list under it, which is `scope`'s whole
        // reason for existing.
        let narrowed = summarise(
            &conn,
            &CollectionQuery {
                allocation: Some(Allocation::Unallocated),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((narrowed.total_cards, narrowed.entries), (3, 3));
    }

    /// The folder rides on the row, and the row can be narrowed to one folder.
    ///
    /// **Both fields are appended at indices 33 and 34**, which is this mapper's standing rule
    /// and the third time it has mattered: `oracle_id`, `promo_types` and `legalities` are all
    /// nullable TEXT on the end, so a column inserted at its logical place instead would swap
    /// two fields that each still held a plausible string. `folder_name` is asserted beside
    /// `legalities` here for exactly that.
    #[test]
    fn a_collection_row_carries_the_folder_it_is_filed_in() {
        let conn = seeded();
        let binder = folder(&conn, "user", "Binder");
        let at_root = filed_in(&conn, "bolt-lea", None, 2);
        let in_binder = filed_in(&conn, "bolt-lea", Some(binder), 3);
        conn.execute(
            "UPDATE cards SET legalities = '{\"modern\":\"legal\"}' WHERE id = 'bolt-lea'",
            [],
        )
        .unwrap();

        let all = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap()
        .items;
        let of = |id: i64| all.iter().find(|r| r.id == id).unwrap();
        assert_eq!(of(at_root).folder_id, None, "NULL is the root");
        assert_eq!(of(at_root).folder_name, None, "and the root has no name");
        assert_eq!(of(in_binder).folder_id, Some(binder));
        assert_eq!(of(in_binder).folder_name.as_deref(), Some("Binder"));
        // The nullable-TEXT neighbour an insertion above would have displaced.
        assert_eq!(
            of(in_binder).legalities.as_deref(),
            Some(r#"{"modern":"legal"}"#)
        );

        let only_binder = list_entries(
            &conn,
            &CollectionQuery {
                folder_id: Some(binder),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only_binder.total, 1);
        assert_eq!(only_binder.items[0].id, in_binder);
        // Absent is every folder there is, which is what every caller written before folders
        // existed asked for — the opposite of `WishlistQuery`, and its own field says why.
        assert_eq!(all.len(), 2);
    }

    /// The default query, priced somewhere other than the default.
    fn on(marketplace: crate::sorting::Marketplace) -> CollectionQuery {
        CollectionQuery {
            marketplace,
            ..Default::default()
        }
    }

    /// Rows in `marketplace_prices` — schema v10's table, which `migrate` has already made.
    ///
    /// Written by hand rather than through `crate::marketplace_feed`, because what these tests
    /// are about is what a *query* does with a feed's rows and not how they got there.
    fn seed_feed(conn: &Connection, rows: &[(&str, &str, &str, f64)]) {
        for (marketplace, card_id, finish, price) in rows {
            conn.execute(
                "INSERT OR REPLACE INTO marketplace_prices
                    (marketplace, card_id, finish, price) VALUES (?1,?2,?3,?4)",
                rusqlite::params![marketplace, card_id, finish, price],
            )
            .unwrap();
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

    /// **Zero is a removal, and it takes everything recorded on the row with it.**
    ///
    /// This test stood as `a_quantity_of_zero_keeps_the_row_and_everything_recorded_on_it` and
    /// asserted the opposite: that a stepper taken to zero was "I have none of these today", and
    /// that the condition, the price paid, the tags and the story of where the copies came from
    /// were all still true and all still there when the next one turned up. That was a
    /// deliberate ruling and it has been deliberately reversed, so the test is rewritten rather
    /// than deleted — and it is rewritten around the same columns, because **they are the
    /// price**. `condition`, `condition_original`, `purchase_price`, `purchase_currency`,
    /// `acquired_at`, `acquisition_source`, `notes` and `tags` go with the row. Nothing recovers
    /// them.
    ///
    /// [`update_entry`] is the one place zero still keeps the row, and the last third of this
    /// test is that exception rather than an oversight: an edit form sends every field at once,
    /// and nothing a reader types into a number field beside seven others should delete the row
    /// they are editing.
    #[test]
    fn a_quantity_of_zero_removes_the_row_and_everything_recorded_on_it() {
        let conn = seeded();
        let recorded = || EntryInput {
            purchase_price: Some(12.5),
            acquisition_source: Some("Local shop".into()),
            tags: Some(r#"["cube"]"#.into()),
            tradelist_quantity: 2,
            ..input("bolt-lea", "nonfoil", 3)
        };
        let added = add_entry(&conn, &recorded()).unwrap();

        let lowered = set_quantity(&conn, added.id, 1).unwrap();
        assert_eq!((lowered.quantity, lowered.removed), (1, false));
        assert_eq!(entry_count(&conn), 1);

        let emptied = set_quantity(&conn, added.id, 0).unwrap();

        assert_eq!(
            (emptied.id, emptied.quantity, emptied.removed),
            (added.id, 0, true),
            "the answer says the row is gone, which is what a list has to know"
        );
        assert_eq!(
            entry_count(&conn),
            0,
            "the row does not survive its own emptiness -- and the price paid, the source and \
             the tags are gone with it"
        );
        // A second press on a row that has already gone is `GONE` and not a success: an
        // adjustment to a row that is not there could not do what it was asked.
        assert_eq!(set_quantity(&conn, added.id, 0).unwrap_err(), GONE);

        // The edit form sends zero the same way and must never delete the row being edited.
        let editing = add_entry(&conn, &recorded()).unwrap();
        let kept = update_entry(
            &conn,
            editing.id,
            &EntryPatch {
                quantity: Some(0),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            (kept.id, kept.quantity, kept.removed),
            (editing.id, 0, false)
        );
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
        assert_eq!(rows, 1, "the edited row is still there");
        assert_eq!(qty, 0);
        assert_eq!(tradelist, 0, "nothing to offer from a pile of none");
        assert_eq!(
            (price, source.as_str(), tags.as_str()),
            (12.5, "Local shop", r#"["cube"]"#),
            "and the whole story with it"
        );

        // The unconditional delete still does what it always did.
        let gone = remove_entry(&conn, editing.id).unwrap();
        assert!(gone.removed);
        assert_eq!(entry_count(&conn), 0);
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

    /// **A malformed `tags` is refused in words, not reported as a row that is gone.**
    ///
    /// [`PATCH_SQL`]'s `OR IGNORE` from the other end: the column carries
    /// `CHECK (json_valid(tags))`, an ignored CHECK failure updates nothing, and "nothing was
    /// updated" is exactly what [`update_entry`] then reads as either a grain collision or a
    /// missing row. With nothing standing in front of it the reader was told the entry was not
    /// there any more — about the row this test reads back, unchanged, on the next line.
    #[test]
    fn an_edit_with_malformed_tags_says_so_rather_than_calling_the_row_gone() {
        let conn = seeded();
        let added = add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();

        let err = update_entry(
            &conn,
            added.id,
            &EntryPatch {
                tags: Some("cube, trade".into()),
                ..Default::default()
            },
        )
        .unwrap_err();

        assert!(err.contains("is not a tag list"), "{err}");
        assert!(
            !err.contains(GONE),
            "a row that is there must not be reported as deleted: {err}"
        );
        // And nothing was written on the way to the refusal — the guard runs before the
        // transaction, so there is no half-applied patch to roll back.
        let (quantity, tags): (i64, String) = conn
            .query_row(
                "SELECT quantity, tags FROM collection_entries WHERE id = ?1",
                params![added.id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((quantity, tags.as_str()), (2, "[]"));
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

    /// Editing a row onto a grain that already exists used to be the one edit that could not
    /// just be applied — it answered "You already have an entry for that printing at that finish
    /// and condition — change its quantity instead", which named the way out and left the reader
    /// to walk it. It folds now, and that sentence is deleted rather than left standing beside a
    /// state nothing can reach: a user-facing message for an impossible case is a half-deleted
    /// rule, and the next reader of `friendly()` would have had to work out which half.
    ///
    /// This is [`an_edit_onto_a_taken_grain_merges_instead_of_refusing`] through the *finish*
    /// rather than the condition, which is worth keeping: `finish` and `condition` are different
    /// terms of the grain reached by different holes of the same statement, and the patch here
    /// also carries a non-grain field — proving it lands on the folding row before it goes,
    /// rather than being dropped along with it.
    #[test]
    fn editing_a_row_onto_an_existing_grain_folds_the_two_together() {
        let conn = seeded();
        let nonfoil = add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();
        let foil = add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();

        let change = update_entry(
            &conn,
            nonfoil.id,
            &EntryPatch {
                finish: Some("foil".into()),
                quantity: Some(4),
                notes: Some("the good one".into()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(change.id, foil.id, "the answer names the surviving row");
        assert_eq!(
            change.quantity, 5,
            "the quantity the reader typed is what folded, not the one the row had"
        );
        assert_eq!(entry_count(&conn), 1);
        let notes: Option<String> = conn
            .query_row(
                "SELECT notes FROM collection_entries WHERE id = ?1",
                params![foil.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            notes.as_deref(),
            Some("the good one"),
            "the survivor had no note of its own, so it takes the folded row's"
        );
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
            "notes": "the good one",
            "folderId": 3
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
            folder_id,
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
        // The field the card menu sends on "Add to -> Collection -> <binder>". It is part of
        // the grain, so a name that does not match here is not a cosmetic miss: the add lands
        // at the root, folds into whatever is already there, and reports success.
        assert_eq!(folder_id, Some(3));
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

    /// Every write in this module goes through
    /// [`crate::collection_source::with_write_owned`], and this is what that
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
    /// The refusal is [`GONE`] rather than [`crate::db::BUSY`]: a busy write would need the
    /// lock held from another thread, and the point being pinned is the same either way.
    #[test]
    fn a_write_that_lands_refreshes_the_owned_facet_and_one_that_is_refused_does_not() {
        let state = crate::index::fixtures::state_with_seeded_cards("collection-owned");
        crate::index::lifecycle::build_now(&state).unwrap();
        let before = crate::index::lifecycle::current(&state).unwrap();
        assert_eq!(before.owned.count(), 0);

        crate::collection_source::with_write_owned(&state, |c| {
            add_entry(c, &input("1", "nonfoil", 2))
        })
        .unwrap();
        let refreshed = crate::index::lifecycle::current(&state).unwrap();
        assert_eq!(
            refreshed.owned.count(),
            1,
            "the index has to know about the row the command just wrote"
        );

        let refused =
            crate::collection_source::with_write_owned(&state, |c| set_quantity(c, 4_242, 3));
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
            (s.value - (2.0 * 400.50 + 3.0 * 90.00 + 12.00)).abs() < 0.005,
            "got {}",
            s.value
        );
        assert_eq!(s.unpriced, 0);

        // The same rows on Cardmarket: the Japanese printing has no EUR price of any kind, so
        // those four cards are counted as unpriced rather than valued at their dollar figure.
        let s = summarise(&conn, &on(crate::sorting::Marketplace::Cardmarket)).unwrap();
        assert!((s.value - 2.0 * 320.00).abs() < 0.005, "got {}", s.value);
        assert_eq!(s.unpriced, 4);
    }

    /// `eur_etched` is documented and **does not exist in the data**. An etched card is
    /// therefore unpriced on Cardmarket — never priced at the nonfoil rate, which is what a
    /// naive `coalesce` chain would do.
    #[test]
    fn an_etched_card_has_no_cardmarket_price_at_all() {
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
        assert!((s.value - 50.00).abs() < 0.005, "got {}", s.value);

        let s = summarise(&conn, &on(crate::sorting::Marketplace::Cardmarket)).unwrap();
        assert_eq!(s.value, 0.0, "there is no eur_etched key in the data");
        assert_eq!(s.unpriced, 2);
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

    /// A healthy entry's `oracleId` answers the card it names — the fact
    /// `card/cardMenu.tsx`'s "View all printings" needs, and the one `CollectionRow` never
    /// carried before this. `seeded()`'s `bolt-lea` is `oracle_id = 'o1'`.
    #[test]
    fn a_healthy_entrys_oracle_id_answers_the_card_it_names() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();

        let page = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(page.total, 1);
        assert_eq!(page.items[0].oracle_id.as_deref(), Some("o1"));
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
        assert_eq!(row.unit_price, None, "and no price either — not zero");
        // The distinction the card menu's null-oracle arm draws: an orphan's `oracleId` is
        // `None` for the honest reason (no live row is ever null — 0 of 116,590), never
        // because this DTO happened not to carry the column.
        assert_eq!(
            row.oracle_id, None,
            "there is no card row to answer it either"
        );
        let s = summarise(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(s.total_cards, 2, "the cards are still owned");
        assert_eq!(s.unpriced, 2);
    }

    /// **The zero-quantity ruling, reversed — and what the reversal costs.**
    ///
    /// This test replaces `a_row_emptied_to_zero_still_lists_and_is_still_a_printing_the_
    /// collection_knows`, which fenced the opposite rule and named three "tidy-ups" that
    /// would have broken it: a `WHERE e.quantity > 0` bolted onto [`scope`], a `count(*)` in
    /// place of `sum(e.quantity)`, and a `unique_cards` narrowed to what is held today. Those
    /// three are no longer traps — a row at zero cannot reach a reader through this module at
    /// all — and the test that guarded them is gone rather than quietly deleted, because the
    /// decision it recorded was deliberate and has been deliberately reversed.
    ///
    /// **What the reversal costs is the whole of what the old rule was preserving**: the row's
    /// `condition`, its `condition_original`, the purchase price and currency, `acquired_at`,
    /// the acquisition source, the notes and the tags all go with it. A reader who trades a
    /// playset away and buys it back next year retypes every one of them. That was the
    /// argument for keeping the row, it is still true, and it was weighed and overruled: a
    /// collection is what the reader *has*, a row saying they have none of something is a row
    /// that says nothing, and every list, count and total in the app had to carry a special
    /// case to describe it. [`remove_entry`] is no longer the only door out.
    ///
    /// `CHECK (quantity >= 0)` stays on the column, and that is not a leftover: the guard is
    /// the command, and an intermediate zero inside a transaction — [`commit_import`]'s `set`
    /// mode writes one before deleting it — is still legal SQL.
    #[test]
    fn a_quantity_taken_to_zero_removes_the_row() {
        let conn = seeded();
        let lea = add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 3)).unwrap();

        let before = summarise(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(
            (before.total_cards, before.unique_cards, before.entries),
            (5, 2, 2)
        );

        let change = set_quantity(&conn, lea.id, 0).unwrap();

        assert!(change.removed, "no copies means the reader does not own it");
        assert_eq!(change.quantity, 0);
        let left: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE id = ?1",
                params![lea.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "and the row itself is gone, story and all");

        let page = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 1, "the emptied row is not a row");
        assert!(page.items.iter().all(|r| r.id != lea.id));

        // Every aggregate follows the row out rather than describing it — which is the half
        // of the old ruling that needed three separate assertions and now needs none.
        let after = summarise(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(after.total_cards, 3, "the two Alpha copies are gone");
        assert_eq!(after.unique_cards, 1, "and so is the printing they were");
        assert_eq!(after.entries, 1);
        assert!(
            (after.value - 3.0 * 90.00).abs() < 0.005,
            "got {}",
            after.value
        );
    }

    /// **An edit that lands on a grain the collection already holds folds into it.**
    ///
    /// Until schema v24 this answered a refusal — "You already have an entry for that printing
    /// at that finish and condition" — and the reader was told to go and edit the other row
    /// themselves. `collection_folders::set_entry_folder` already merges rather than refusing
    /// when a card is filed into a folder that holds its printing, and an edit is the same
    /// fact from the other side: the reader has said these two rows are one row. The quantities
    /// sum, the source goes, and the answer names the row that survived — which is *not* the
    /// id the caller passed in, and is exactly why [`EntryChange`] carries an `id` at all.
    #[test]
    fn an_edit_onto_a_taken_grain_merges_instead_of_refusing() {
        let conn = seeded();
        let a = add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        let b = add_entry(
            &conn,
            &EntryInput {
                condition: Some("LP".into()),
                ..input("bolt-lea", "nonfoil", 1)
            },
        )
        .unwrap();
        assert_ne!(a.id, b.id, "two conditions are two rows");

        let change = update_entry(
            &conn,
            b.id,
            &EntryPatch {
                condition: Some("NM".into()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(change.id, a.id, "the answer names the surviving row");
        assert_eq!(change.quantity, 3, "and the quantities sum");
        assert_eq!(entry_count(&conn), 1, "the edited row folded away");
        assert_eq!(quantity_of(&conn, "bolt-lea", "nonfoil"), 3);
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
    /// earn this on their own: both order by the `unit_price` **output alias**, not by
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
        // Every marketplace, because each writes a *different expression* into the same
        // statement — and two of them reach a table `cards` does not join, so a spelling
        // mistake there is a prepare error that would only ever fire on one shop.
        for marketplace in MARKETPLACES {
            for (label, sort) in orders.clone() {
                let mut seen: Vec<i64> = Vec::new();
                for page in 0..2 {
                    let p = list_entries(
                        &conn,
                        &CollectionQuery {
                            sort: Some(sort.clone()),
                            marketplace,
                            limit: 2,
                            offset: page * 2,
                            ..Default::default()
                        },
                    )
                    .unwrap_or_else(|e| {
                        panic!("sorting by `{label}` on {marketplace:?} failed: {e}")
                    });
                    assert_eq!(p.total, 3, "the count is the same set whatever the order");
                    seen.extend(p.items.iter().map(|r| r.id));
                }
                let mut unique = seen.clone();
                unique.sort_unstable();
                unique.dedup();
                assert_eq!(
                    (unique.len(), seen.len()),
                    (3, 3),
                    "paging by `{label}` on {marketplace:?} \
                     returned a row twice or lost one: {seen:?}"
                );
            }
        }
    }

    /// Every marketplace a price can come from, so a loop over them cannot quietly miss the
    /// one that was added last.
    const MARKETPLACES: [crate::sorting::Marketplace; 4] = [
        crate::sorting::Marketplace::Tcgplayer,
        crate::sorting::Marketplace::Cardmarket,
        crate::sorting::Marketplace::Cardkingdom,
        crate::sorting::Marketplace::Manapool,
    ];

    /// `sorting`'s rule, applied to this table's list: a money clause with no `{price}` hole
    /// in it is a clause that quotes one marketplace whatever the reader picked.
    #[test]
    fn every_collection_money_sort_names_the_price_hole() {
        for p in COLLECTION_PRICE_SORTS {
            assert!(p.asc.contains(crate::sorting::PRICE_HOLE), "{}", p.asc);
            assert!(p.desc.contains(crate::sorting::PRICE_HOLE), "{}", p.desc);
        }
    }

    /// Three entries whose order disagrees between every pair of marketplaces, one of them
    /// **etched** — and the etched card's blob carries a perfectly good `$.eur`, which is
    /// exactly the number a naive fallback would charge for it.
    ///
    /// The feeds are seeded to make two further points. **Card Kingdom has never heard of the
    /// etched printing**, which is what "unpriced at this marketplace" looks like from a
    /// table; **Mana Pool prices it**, because that feed publishes an etched column where
    /// Scryfall's euro keys do not. The same card, three different right answers.
    fn seeded_marketplaces() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        for (id, prices) in [
            ("cheap-usd", r#"{"usd":"1.00","eur":"90.00"}"#),
            ("dear-usd", r#"{"usd":"50.00","eur":"2.00"}"#),
            (
                "etched",
                r#"{"usd":"9.00","usd_etched":"9.00","eur":"7.00"}"#,
            ),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    finishes,prices,raw)
                 VALUES (?1,?1,?1,'tst','1','en','normal','[\"nonfoil\",\"etched\"]',?2,'{}')",
                rusqlite::params![id, prices],
            )
            .unwrap();
        }
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "cheap-usd", "nonfoil", 3.00),
                ("cardkingdom", "dear-usd", "nonfoil", 20.00),
                // and no `cardkingdom` row for `etched` at all.
                ("manapool", "cheap-usd", "nonfoil", 8.00),
                ("manapool", "dear-usd", "nonfoil", 1.00),
                ("manapool", "etched", "etched", 4.00),
            ],
        );
        // Quantities chosen so `value` and `price` disagree as well: the cheapest card is
        // held ten times and the dearest once.
        add_entry(&conn, &input("cheap-usd", "nonfoil", 10)).unwrap();
        add_entry(&conn, &input("dear-usd", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("etched", "etched", 3)).unwrap();
        conn
    }

    /// Ordering happens inside SQLite, so the chosen marketplace is the one thing about it
    /// that has to cross the wire. Both keys, both directions, all four shops.
    #[test]
    fn the_value_and_price_sorts_order_by_the_marketplace_they_are_asked_for() {
        let conn = seeded_marketplaces();
        let ids = |key: &str, dir: &str, marketplace| -> Vec<String> {
            list_entries(
                &conn,
                &CollectionQuery {
                    sort: Some(vec![term(key, dir)]),
                    marketplace,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .into_iter()
            .map(|r| r.card_id)
            .collect()
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        // Per copy. TCGplayer $1 / $50 / $9; Cardmarket €90 / €2 / —; Card Kingdom
        // $3 / $20 / — (no feed row); Mana Pool $8 / $1 / $4.
        assert_eq!(
            ids("price", "asc", Tcgplayer),
            C("cheap-usd,etched,dear-usd")
        );
        assert_eq!(
            ids("price", "desc", Tcgplayer),
            C("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            ids("price", "asc", Cardmarket),
            C("dear-usd,cheap-usd,etched")
        );
        assert_eq!(
            ids("price", "desc", Cardmarket),
            C("cheap-usd,dear-usd,etched"),
            "the etched row has no euro price and stays last in both directions"
        );
        assert_eq!(
            ids("price", "asc", Cardkingdom),
            C("cheap-usd,dear-usd,etched"),
            "a card the feed has never listed is unpriced and sorts last"
        );
        assert_eq!(
            ids("price", "desc", Cardkingdom),
            C("dear-usd,cheap-usd,etched")
        );
        assert_eq!(
            ids("price", "asc", Manapool),
            C("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            ids("price", "desc", Manapool),
            C("cheap-usd,etched,dear-usd"),
            "Mana Pool prices the etched copies, so they place rather than trail"
        );

        // × copies: 10 / 1 / 3. TCGplayer $10 / $50 / $27; Cardmarket €900 / €2 / —;
        // Card Kingdom $30 / $20 / —; Mana Pool $80 / $1 / $12.
        assert_eq!(
            ids("value", "asc", Tcgplayer),
            C("cheap-usd,etched,dear-usd")
        );
        assert_eq!(
            ids("value", "desc", Tcgplayer),
            C("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            ids("value", "asc", Cardmarket),
            C("dear-usd,cheap-usd,etched")
        );
        assert_eq!(
            ids("value", "desc", Cardmarket),
            C("cheap-usd,dear-usd,etched")
        );
        assert_eq!(
            ids("value", "asc", Cardkingdom),
            C("dear-usd,cheap-usd,etched"),
            "`value` and `price` disagree on Card Kingdom, which is the point of the copies"
        );
        assert_eq!(
            ids("value", "desc", Cardkingdom),
            C("cheap-usd,dear-usd,etched")
        );
        assert_eq!(
            ids("value", "asc", Manapool),
            C("dear-usd,etched,cheap-usd")
        );
        assert_eq!(
            ids("value", "desc", Manapool),
            C("cheap-usd,etched,dear-usd")
        );
    }

    /// A comma-separated expectation, so an eight-way table of orders reads as a table.
    #[allow(non_snake_case)]
    fn C(ids: &str) -> Vec<String> {
        ids.split(',').map(str::to_owned).collect()
    }

    /// The etched contrast, on the row itself. **Every one of these four answers is right
    /// about its own marketplace**, and no two of them agree:
    ///
    /// * TCGplayer prices it through `usd_etched`;
    /// * Cardmarket cannot, **even though the blob names a `$.eur`** — there is no
    ///   `eur_etched` key and the nonfoil rate is not a stand-in for one;
    /// * Card Kingdom's feed has never listed the printing, so there is no row to read;
    /// * Mana Pool publishes an etched column, so there is.
    ///
    /// Nothing is filled in from a neighbour. That is the whole rule.
    #[test]
    fn an_etched_row_is_priced_or_not_by_each_marketplace_on_its_own() {
        let conn = seeded_marketplaces();
        let price = |id: &str, marketplace| {
            list_entries(&conn, &on(marketplace))
                .unwrap()
                .items
                .iter()
                .find(|r| r.card_id == id)
                .unwrap()
                .unit_price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(price("etched", Tcgplayer), Some(9.00));
        assert_eq!(
            price("etched", Cardmarket),
            None,
            "and not the €7.00 beside it"
        );
        assert_eq!(
            price("etched", Cardkingdom),
            None,
            "in `cards`, absent from the feed — unpriced, never another shop's number"
        );
        assert_eq!(
            price("etched", Manapool),
            Some(4.00),
            "this feed has an etched column, which is exactly the contrast"
        );

        // And the neighbouring row, so the NULLs above are about the etched printing rather
        // than about the marketplace having no rows at all.
        assert_eq!(price("cheap-usd", Cardmarket), Some(90.00));
        assert_eq!(price("cheap-usd", Cardkingdom), Some(3.00));
    }

    /// Absent means TCGplayer — the prices every caller had before there was a picker — and
    /// so does an id this build has never heard of. Deserialized from the wire, because it
    /// is the *payload* that omits the field.
    #[test]
    fn a_query_with_no_marketplace_quotes_tcgplayer() {
        let conn = seeded_marketplaces();
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

        let tcgplayer = C("cheap-usd,etched,dear-usd");
        assert_eq!(ids(&format!("{{{sort}}}")), tcgplayer, "absent");
        assert_eq!(
            ids(&format!(r#"{{{sort},"marketplace":"ebay"}}"#)),
            tcgplayer,
            "and an id this build has never heard of"
        );
        assert_eq!(
            ids(&format!(r#"{{{sort},"marketplace":"cardtrader"}}"#)),
            tcgplayer,
            "and one it lists but cannot price"
        );
        assert_eq!(
            ids(&format!(r#"{{{sort},"marketplace":"manapool"}}"#)),
            C("dear-usd,etched,cheap-usd")
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
            oracle_id: Some("o1".into()),
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
            unit_price: Some(400.5),
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
            // From the card, not the entry — and the entry above owns the plain copy, which is
            // the pair the two fields exist to tell apart.
            promo_types: Some(r#"["surgefoil"]"#.into()),
            legalities: Some(r#"{"timeless":"legal","standard":"not_legal"}"#.into()),
            folder_id: Some(3),
            folder_name: Some("Trade binder".into()),
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": 7, "cardId": "bolt-lea", "name": "Lightning Bolt", "oracleId": "o1",
                "setCode": "lea",
                "setName": "Limited Edition Alpha", "collectorNumber": "161", "lang": "en",
                "rarity": "common", "manaCost": "{R}", "typeLine": "Instant", "layout": "normal",
                "finish": "nonfoil", "condition": "NM", "quantity": 4, "tradelistQuantity": 1,
                "unitPrice": 400.5, "purchasePrice": 12.5,
                "purchaseCurrency": "USD", "acquiredAt": "2020-05-01",
                "acquisitionSource": "Local shop", "serialNumber": null, "altered": false,
                "signed": true, "proxy": false, "misprint": false, "grading": null,
                "tags": "[]", "notes": null, "needsReview": null,
                "updatedAt": 1800000000, "promoTypes": "[\"surgefoil\"]",
                "legalities": "{\"timeless\":\"legal\",\"standard\":\"not_legal\"}",
                "folderId": 3, "folderName": "Trade binder"
            })
        );

        let summary = serde_json::to_value(CollectionSummary {
            total_cards: 6,
            unique_cards: 2,
            entries: 3,
            tradelist_cards: 1,
            value: 1213.0,
            unpriced: 4,
            needs_review: 0,
        })
        .unwrap();
        assert_eq!(
            summary,
            serde_json::json!({
                "totalCards": 6, "uniqueCards": 2, "entries": 3, "tradelistCards": 1,
                "value": 1213.0, "unpriced": 4, "needsReview": 0
            })
        );
    }

    #[test]
    fn an_add_import_accumulates_quantities_on_the_grain() {
        let conn = seeded();
        let items = vec![item("card-1", 2, "nonfoil"), item("card-1", 3, "nonfoil")];
        let out = commit_import(&conn, &items, "add").unwrap();
        // Two items, one row: the file named the same grain twice and the copies add up.
        assert_eq!(out.added, 1);
        assert_eq!(out.updated, 1);
        assert_eq!(quantity_of(&conn, "card-1", "nonfoil"), 5);
    }

    #[test]
    fn a_set_import_writes_the_files_quantity_rather_than_adding_to_it() {
        let conn = seeded();
        commit_import(&conn, &[item("card-1", 4, "nonfoil")], "add").unwrap();
        commit_import(&conn, &[item("card-1", 1, "nonfoil")], "set").unwrap();
        assert_eq!(quantity_of(&conn, "card-1", "nonfoil"), 1);
    }

    /// **A `set` of 0 deletes the row, and `removed` counts it** — [`set_quantity`]'s reversal
    /// reaching the importer, and the path the counter was added for. A file saying a printing is
    /// at zero is a file saying the reader does not own it.
    #[test]
    fn a_set_of_zero_deletes_the_row_the_reader_owned_and_counts_it_removed() {
        let conn = seeded();
        commit_import(&conn, &[item("card-1", 4, "nonfoil")], "add").unwrap();

        let out = commit_import(&conn, &[item("card-1", 0, "nonfoil")], "set").unwrap();

        assert_eq!(
            (out.added, out.updated, out.removed),
            (0, 0, 1),
            "the row was emptied and deleted, not updated to zero"
        );
        assert_eq!(entry_count(&conn), 0);
    }

    /// **The same line for a printing the reader does *not* own spends its item twice**, and
    /// `updated` is clamped rather than allowed to go negative.
    ///
    /// The upsert inserts the row and the delete takes it away again inside the one transaction,
    /// so one item counts as both one `added` and one `removed` — statements that really ran —
    /// and `items.len() - added - removed` is `-1`. Unreachable from the shipped importer, since
    /// both parsers refuse a quantity below 1, which is precisely why the counter needs a test of
    /// its own: nothing a reader can do produces the file that reaches it, so nothing else would
    /// ever go red.
    #[test]
    fn a_set_of_zero_for_an_unowned_printing_never_answers_a_negative_updated() {
        let conn = seeded();

        let out = commit_import(&conn, &[item("card-1", 0, "nonfoil")], "set").unwrap();

        assert_eq!(
            (out.added, out.updated, out.removed),
            (1, 0, 1),
            "inserted and deleted inside the transaction, and nothing updated"
        );
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn a_foil_and_a_regular_copy_are_two_rows_in_both_modes() {
        let conn = seeded();
        commit_import(
            &conn,
            &[item("card-1", 1, "nonfoil"), item("card-1", 1, "foil")],
            "add",
        )
        .unwrap();
        assert_eq!(quantity_of(&conn, "card-1", "nonfoil"), 1);
        assert_eq!(quantity_of(&conn, "card-1", "foil"), 1);
    }

    #[test]
    fn a_refused_item_rolls_the_whole_file_back() {
        let conn = seeded();
        // A finish no CHECK will take. A half-imported collection is worse than a refused one.
        let items = vec![item("card-1", 1, "nonfoil"), item("card-1", 1, "glitter")];
        assert!(commit_import(&conn, &items, "add").is_err());
        assert_eq!(entry_count(&conn), 0);
    }

    #[test]
    fn an_unknown_mode_is_refused_rather_than_defaulted() {
        let conn = seeded();
        assert!(commit_import(&conn, &[item("card-1", 1, "nonfoil")], "replace").is_err());
    }
}
