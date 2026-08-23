//! The deck history: one row per change, written by the write that made it.
//!
//! Spec §7 asks the deck editor to "log ALL changes", and this is that log. Three decisions
//! shape the whole module, and each one is a thing that goes wrong if it is reversed:
//!
//! * **[`record`] is called inside the caller's transaction and never opens its own.** An
//!   audit row that committed while the change it describes rolled back is a history that
//!   lies — and it lies in the one direction a reader cannot check, because the row it names
//!   is not there to disagree with it. Every call site in [`crate::deck`] and
//!   [`crate::deck_meta`] already holds a transaction; this joins it, the way
//!   [`crate::deck_undo::record_step`] does beside it.
//! * **Rust records facts; TypeScript writes the sentence.** That is why [`payload`] is JSON
//!   and why there is no `summary` column: a sentence is domain logic (CLAUDE.md's boundary),
//!   it changes with the wording and with the reader's language, and a table that stored one
//!   would be a table full of the phrasing of whichever release wrote each row. `auditText.ts`
//!   renders these facts; nothing here writes prose a user reads.
//! * **Every deck write records exactly one row per change it made.** A write that silently
//!   records nothing is precisely the bug this table exists to prevent, so the rule is a rule
//!   and not a preference — `every_deck_write_leaves_exactly_one_audit_row` drives each command
//!   once and counts. Two commands make more than one change in a call and so owe more than one
//!   row, each pinned by a test of its own: [`crate::deck::update_deck`] records one row per
//!   changed **field**, and [`crate::import::commit_import`] in `replace` mode records the
//!   `remove` and the `add` it did — opposite deltas, which one signed row cannot carry.
//!   **Seven** writes deliberately record nothing, and each says why on its own doc:
//!   [`crate::deck::delete_deck`] (the row would CASCADE away with the deck it describes);
//!   [`crate::deck::set_view_state`] (the history holds changes to the deck, and which tab was
//!   open is not one — it is not an edit at all, which is why it moves no `updated_at` either);
//!   [`crate::deck::missing_to_wishlist`] and [`crate::deck_theory::missing_to_wishlist`]
//!   (they write the wishlist, not the deck); and three of `deck_meta`'s four folder writes —
//!   [`crate::deck_meta::create_folder`], [`crate::deck_meta::rename_folder`] and
//!   [`crate::deck_meta::move_folder`] — because a folder belongs to no deck and
//!   `deck_audit.deck_id` is `NOT NULL`, so there is nothing to file the row under. The fourth,
//!   [`crate::deck_meta::delete_folder`], is **not** exempt: `decks.folder_id` is
//!   `ON DELETE SET NULL`, so it re-files N decks and writes one `folder` row per deck it
//!   un-filed — N ids, and they are exactly the rows that changed.
//!
//! [`payload`]: DeckAuditEntry::payload

use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;

/// The nine kinds, named rather than indexed at every call site.
///
/// Each is `crate::schema::AUDIT_KINDS[n]` by **index and not by spelling**, the discipline
/// `deck::LIVE` applies to the variants: the CHECK on `deck_audit.kind` was built from that
/// array, so a name here that drifted from it would be a runtime constraint failure at the
/// first write of that kind rather than a compile error.
/// `the_kind_constants_are_the_schemas_own` walks the pair.
pub const ADD: &str = crate::schema::AUDIT_KINDS[0];
pub const REMOVE: &str = crate::schema::AUDIT_KINDS[1];
pub const QUANTITY: &str = crate::schema::AUDIT_KINDS[2];
pub const MOVE: &str = crate::schema::AUDIT_KINDS[3];
pub const SWAP: &str = crate::schema::AUDIT_KINDS[4];
pub const TAG: &str = crate::schema::AUDIT_KINDS[5];
pub const CATEGORY: &str = crate::schema::AUDIT_KINDS[6];
pub const FOLDER: &str = crate::schema::AUDIT_KINDS[7];
pub const DECK: &str = crate::schema::AUDIT_KINDS[8];

/// The variant a change that is about no card list at all is recorded under.
///
/// `deck_audit.variant` is `NOT NULL` with a CHECK over the two, so a category rename, a tag
/// write, a folder move and a deck rename all have to carry *something* — and none of them is
/// a fact about one variant's cards. They carry `live`, which is the column's own DDL default
/// and the variant the editor opens on. `deck_meta::READBACK_VARIANT` says the same thing for
/// the same reason one layer up.
///
/// Read from [`crate::schema::DECK_VARIANTS`] by index rather than spelled, so this and the
/// CHECK cannot drift.
pub const DECK_LEVEL: &str = crate::schema::DECK_VARIANTS[0];

/// Most history a drawer will ask for at once, and the ceiling on what it may ask for.
///
/// A cap rather than a page cursor because this table grows by one row per edit: a deck a
/// person has actually built is hundreds of rows, not millions, and the drawer shows the most
/// recent day or two. The clamp is what keeps a caller from turning "show me the history" into
/// a full-table read of every deck edit ever made — and, at the other end, what keeps a `0` or
/// a negative from meaning *no limit at all*, which is exactly what SQLite reads a negative
/// `LIMIT` as.
const MAX_LIMIT: i64 = 500;

/// One recorded change, as the history drawer reads it.
#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckAuditEntry {
    pub id: i64,
    pub deck_id: i64,
    /// Unix seconds, from SQLite's own `unixepoch()` — the same clock every other
    /// `created_at`/`updated_at` in this schema is written from, so the history and the rows
    /// it describes can be compared without a timezone in between.
    pub at: i64,
    /// `live` | `theory` for a card change; [`DECK_LEVEL`] for everything else.
    pub variant: String,
    /// One of [`crate::schema::AUDIT_KINDS`].
    pub kind: String,
    /// The printing this is about, or `None` — a category rename is about no card. Soft, like
    /// every card id in a user table: the printing can leave `cards` and the row still reads.
    pub card_id: Option<String>,
    /// The card's name **as it was at the time**, denormalized for [`Self::card_id`]'s reason
    /// at one remove — a history line that can only say `e7f8…` once the id stops resolving is
    /// not a history.
    pub card_name: Option<String>,
    /// JSON, and the whole of what happened. Read it in TypeScript; `auditText.ts` renders the
    /// sentence. The shape per kind is documented on [`record`].
    pub payload: String,
    /// Signed copies, for the day header's `+7 / −6` roll-up: `+n` on an add, `−n` on a
    /// remove, the difference on a quantity change, and **`+n` on the one [`DECK`] row that
    /// records a theory copy** ([`crate::deck_theory::copy_from_live`] carries the copies it
    /// seeded). **0** on everything else: a move, a swap, a tag and every other deck- or
    /// category-level edit change no count, and a roll-up that pretended otherwise would
    /// double a card that only ever changed pile.
    ///
    /// The theory copy is the exception to the shape of that list — every other nonzero delta
    /// belongs to a card-shaped kind — and it is named here because this comment previously
    /// said "0 on everything else" without it, and `ipc.ts` mirrored the mistake cleanly.
    pub delta: i64,
}

/// Write one history row, inside the transaction the caller already opened.
///
/// **Never opens a transaction of its own**, for the reason at the top of this file, and takes
/// `&Connection` rather than `&Transaction` because `Transaction` derefs to it — so
/// `record(&tx, …)` is the call at every site, exactly as `record_step(&tx, …)` is on the line
/// after it.
///
/// `card` is `(card_id, card_name)` or `None`: the two travel together or not at all, because
/// a name with no id names nothing and an id with no name cannot be read once its printing
/// leaves `cards`.
///
/// `kind` and `variant` are validated here rather than left to the CHECK constraints. Both are
/// written by this crate and neither can be wrong at runtime, so this is not a fence against a
/// user — it is a fence against a *refactor*, and it answers a sentence instead of
/// `CHECK constraint failed: deck_audit`, which names the table and not the mistake.
///
/// # Payload shapes, by kind
///
/// `auditText.ts` is written against exactly these. Values are recorded **as stored** — a set
/// code is the lowercase `cards.set_code` it came from, not the uppercase a tile draws; a
/// category is the user's own name for it. Casing and word order are the renderer's.
///
/// | kind | payload |
/// |---|---|
/// | `add` | `{ "category": "Ramp", "quantity": 1 }` |
/// | `remove` | `{ "category": "Ramp", "quantity": 1, "reason": null }` |
/// | `quantity` | `{ "category": "Ramp", "from": 1, "to": 2 }` |
/// | `move` | `{ "from": "Creature", "to": "Maybeboard" }` |
/// | `swap` | `{ "category": "Ramp", "fromSet": "cmm", "toSet": "3ed", "folded": false }` |
/// | `tag` | `{ "tag": "Cut candidate", "previous": null }` |
/// | `category` | `{ "action": "create\|rename\|delete\|activate\|deactivate\|reorder", "name": "Draw", "previousName": "Value", "cards": 7 }` |
/// | `folder` | `{ "action": "move", "folder": "Commander › Legends" }` |
/// | `deck` | `{ "field": "name\|format\|cover\|description\|notes\|built\|archived\|theory", "from": "…", "to": "…" }` |
///
/// **`built` is a value nothing writes any more and the renderer must keep reading.** Schema v25
/// dropped `decks.is_built` — a deck no longer *claims* copies, it holds the ones filed in its
/// group — so no new row carries it, and every row a reader wrote before the upgrade still does.
/// The history is a record of what happened, not of what the app can do today.
///
/// Two of those rows carry keys the brief's table did not, and both are additions rather than
/// changes — a renderer written against the shapes above still reads every row it knew:
///
/// * **`tag` gains an `action`** (`create` | `rename` | `delete`) on the rows where `card_id`
///   is NULL. A tag is two different events: labelling a *card* (`card_id` set, `tag` and
///   `previous` are the labels) and creating, renaming or deleting the label itself. They
///   share a kind because they share a subject, and `card_id` is what tells them apart — but a
///   renderer that could not see the verb would report "deleted the Cut candidate tag" as
///   "tagged as Cut candidate".
/// * **`deck.field` gains `description` and `archived`.** Both are editable today
///   ([`crate::deck::DeckPatch`]) and both are deck writes, so the alternative was a write that
///   records nothing — the one thing this table exists to prevent. `description` is the v5
///   column the "New deck" dialog fills; `notes` is the separate v8 one.
///
/// # An import is `add` and `remove` with an `import` payload
///
/// [`crate::import::commit_import`] reuses those two kinds rather than adding a tenth —
/// no new [`crate::schema::AUDIT_KINDS`] value, so no CHECK rebuild and no migration — and
/// tells itself apart by the single `import` key its payload nests everything under:
///
/// | kind | payload |
/// |---|---|
/// | `add` | `{ "import": { "mode": "merge"\|"replace", "lines": 105, "cards": 117, "categories": 6 } }` |
/// | `remove` | `{ "import": { "mode": "replace", "cleared": 42 } }` |
///
/// `card_id` and `card_name` are **NULL** on both, because an import is about no one card, and
/// `delta` is `+cards` / `−cleared`. `lines` is how many items the list handed over and `cards`
/// is the copies they asked for — a list naming one card twice is 2 lines and can be 5 cards —
/// while `categories` counts the **distinct piles touched**, not the ones created (that number
/// is the outcome's, and the drawer is a record of what happened rather than of what was new).
/// The `remove` row exists only when a `replace` actually cleared something: a history of a
/// removal that removed nothing is a line the drawer would have to explain.
/// # It answers the id of the row it wrote
///
/// Which is what [`crate::deck_undo::record_step`] files its reversal under — the journal is
/// keyed 1:1 on this table's `id`. Reaching for `last_insert_rowid()` at each of the fifteen
/// call sites would have worked and would have been wrong the first time somebody put an
/// INSERT between the two lines; an explicit return cannot drift. Every call site that wants
/// nothing back still reads `record(…)?;`, which discards it.
pub fn record(
    tx: &Connection,
    deck_id: i64,
    variant: &str,
    kind: &str,
    card: Option<(&str, &str)>,
    payload: &serde_json::Value,
    delta: i64,
) -> Result<i64, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    if !crate::schema::AUDIT_KINDS.contains(&kind) {
        return Err(format!(
            "`{kind}` is not a deck change this app records. Use one of: {}.",
            crate::schema::AUDIT_KINDS.join(", ")
        ));
    }
    let (card_id, card_name) = match card {
        Some((id, name)) => (Some(id), Some(name)),
        None => (None, None),
    };
    tx.execute(
        "INSERT INTO deck_audit
            (deck_id, at, variant, kind, card_id, card_name, payload, delta)
         VALUES (?1, unixepoch(), ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            deck_id,
            variant,
            kind,
            card_id,
            card_name,
            payload.to_string(),
            delta
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(tx.last_insert_rowid())
}

/// The nine columns a [`DeckAuditEntry`] is, in [`entry_from_row`]'s order.
///
/// One constant because two readers want the same row: [`list`], and [`by_id`] for the delta
/// a reversal negates. A tenth column is one edit here and one in the mapper below.
const AUDIT_SELECT: &str =
    "SELECT id, deck_id, at, variant, kind, card_id, card_name, payload, delta FROM deck_audit";

/// One row of [`AUDIT_SELECT`], in its column order.
fn entry_from_row(r: &rusqlite::Row) -> rusqlite::Result<DeckAuditEntry> {
    Ok(DeckAuditEntry {
        id: r.get(0)?,
        deck_id: r.get(1)?,
        at: r.get(2)?,
        variant: r.get(3)?,
        kind: r.get(4)?,
        card_id: r.get(5)?,
        card_name: r.get(6)?,
        payload: r.get(7)?,
        delta: r.get(8)?,
    })
}

/// One history row by id, or `None` if there is no such row.
///
/// [`crate::deck_undo`]'s, for the state command and for the delta a reversal negates. `None`
/// rather than an error for [`list`]'s reason: the history of something that is not there is
/// nothing, and `deck_audit.deck_id` CASCADEs.
pub(crate) fn by_id(conn: &Connection, audit_id: i64) -> Result<Option<DeckAuditEntry>, String> {
    conn.query_row(
        &format!("{AUDIT_SELECT} WHERE id = ?1"),
        params![audit_id],
        entry_from_row,
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// One deck's history, newest first.
///
/// `id DESC` after `at DESC` is not decoration: `unixepoch()` has one-second resolution and a
/// single click can write two rows inside it (a rename and a reorder, a delete and its
/// reallocation). Without the tiebreaker the drawer's order inside a second would be whatever
/// the planner felt like, which is the one ordering a reader would notice and could not
/// explain. `idx_deck_audit_deck` is `(deck_id, at DESC)` and answers the leading terms.
///
/// A deck that is not there answers an empty list rather than an error: the history of a deck
/// that does not exist is nothing, and `deck_audit.deck_id` CASCADEs, so "no rows" is the
/// truthful answer to both readings of the question.
pub fn list(conn: &Connection, deck_id: i64, limit: i64) -> Result<Vec<DeckAuditEntry>, String> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let mut stmt = conn
        .prepare(&format!(
            "{AUDIT_SELECT}
              WHERE deck_id = ?1
              ORDER BY at DESC, id DESC
              LIMIT ?2"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, limit], entry_from_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One deck's history. **Read-only** connection, blocking pool — as every read in this app is,
/// so opening the history drawer never queues behind a sync.
#[tauri::command]
pub async fn deck_audit_list(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    limit: i64,
) -> Result<Vec<DeckAuditEntry>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list(&crate::sync::lock_db_read(&state), deck_id, limit)
    })
    .await
    .map_err(|e| format!("the deck history could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::{DeckInput, DeckPatch};
    use serde_json::{json, Value};

    /// Two printings of one card and one of another — enough for a swap (two printings, one
    /// oracle card) and for a move that has somewhere to go.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,mana_cost,cmc,type_line,prices,raw)
               VALUES
                 ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                  '{R}',1.0,'Instant','{"usd":"400.00"}','{}'),
                 ('bolt-m10','o1','Lightning Bolt','m10','146','en','normal','common',
                  '{R}',1.0,'Instant','{"usd":"1.50"}','{}'),
                 ('serra-lea','o2','Serra Angel','lea','175','en','normal','uncommon',
                  '{3}{W}{W}',5.0,'Creature — Angel','{"usd":"120.00"}','{}');"#,
        )
        .unwrap();
        conn
    }

    fn deck(conn: &Connection, name: &str) -> i64 {
        crate::deck::create_deck(
            conn,
            &DeckInput {
                name: name.to_owned(),
                format_key: "modern".to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    fn category(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, name).unwrap()
    }

    fn kind_of(conn: &Connection, deck_id: i64, kind: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND kind = ?2",
            params![deck_id, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// Every history row this deck has, newest first — [`list`] with the cap it ships with.
    fn history(conn: &Connection, deck_id: i64) -> Vec<DeckAuditEntry> {
        list(conn, deck_id, MAX_LIMIT).unwrap()
    }

    /// The newest row, with its payload parsed — what a payload test asserts against.
    fn newest(conn: &Connection, deck_id: i64) -> (DeckAuditEntry, Value) {
        let mut rows = history(conn, deck_id);
        assert!(!rows.is_empty(), "expected a history row and found none");
        let row = rows.remove(0);
        let payload = serde_json::from_str(&row.payload).expect("payload must be JSON");
        (row, payload)
    }

    /// How many rows this deck's history holds.
    fn rows(conn: &Connection, deck_id: i64) -> usize {
        history(conn, deck_id).len()
    }

    /// The names are the schema's, by index — so a tenth kind, or a reordering of the array,
    /// cannot leave a constant here pointing at the wrong word while everything still compiles.
    #[test]
    fn the_kind_constants_are_the_schemas_own() {
        assert_eq!(
            [ADD, REMOVE, QUANTITY, MOVE, SWAP, TAG, CATEGORY, FOLDER, DECK],
            crate::schema::AUDIT_KINDS
        );
        assert_eq!(DECK_LEVEL, "live");
    }

    /// The rule this table exists for. Each command is driven **once**, over a deck whose
    /// history is emptied first, and each must leave behind exactly the rows it owes — no more
    /// (a double-record is a history that counts a change twice) and, far more importantly, no
    /// fewer.
    ///
    /// Written as a list of closures rather than as **twenty-five** tests because the claim is
    /// about the *set* of commands: a new deck write that records nothing fails here the moment
    /// its line is added, and forgetting to add the line is the only way to slip past — which
    /// is cheaper to notice in review than a missing test file. **Count the list, never a
    /// remembered number**; it has been written down wrong twice.
    ///
    /// **Every case owes one row but one**, so the count rides in the case rather than in the
    /// assertion. `deck_import_commit` in `replace` mode had two *effects* — it cleared a
    /// variant and it filled it — with opposite deltas, and one signed row cannot carry both;
    /// it owes a `remove` and an `add`. That is the same reading of "exactly one" that
    /// `a_patch_that_changes_two_fields_records_both` already pins for `deck_update`: the rule
    /// is one row per **change**, not per call. Its `merge` sibling is here beside it precisely
    /// so the pair shows where the split falls.
    #[test]
    fn every_deck_write_leaves_exactly_one_audit_row() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let side = kind_of(&conn, id, "side");
        let folder = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;
        // A scratch covers directory for the one case that writes a file. Process-unique, for
        // the reason `deck::tests::covers` gives.
        let covers = std::env::temp_dir().join(format!("mtgtest-audit-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&covers);
        std::fs::create_dir_all(&covers).unwrap();
        image::RgbaImage::new(8, 8)
            .save(covers.join("source.png"))
            .unwrap();
        // `set_cover_image` takes bytes, not a path — the encode belongs outside the write
        // lock and its signature is what says so.
        let cover_bytes = crate::images::encode_cover(&covers.join("source.png")).unwrap();

        /// One command under test: what to call it in a failure, how many rows it owes, and
        /// how to drive it.
        type Case<'a> = (&'a str, i64, Box<dyn Fn() + 'a>);

        /// One line of an imported decklist.
        fn imported(card_id: &str, quantity: i64, category: &str) -> crate::import::ImportItem {
            crate::import::ImportItem {
                card_id: card_id.to_owned(),
                quantity,
                category_name: category.to_owned(),
                // An ordinary, counted pile: this sweep is about which commands write history,
                // and switching a pile off is not one of the effects it counts. The finish is
                // out of scope for the same reason.
                inactive: false,
                finish: None,
            }
        }

        // Every command that writes to a deck, each paired with the state it needs. The
        // fixture work in each closure runs *before* the history is cleared, so only the one
        // call under test can leave a row.
        let cases: Vec<Case<'_>> = vec![
            (
                "deck_create",
                1,
                Box::new(|| {
                    deck(&conn, "Another");
                }),
            ),
            (
                "deck_update",
                1,
                Box::new(|| {
                    crate::deck::update_deck(
                        &conn,
                        id,
                        &DeckPatch {
                            name: Some("Burn v2".to_owned()),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                }),
            ),
            (
                "deck_update (folder)",
                1,
                Box::new(|| {
                    crate::deck::update_deck(
                        &conn,
                        id,
                        &DeckPatch {
                            folder_id: Some(folder),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                }),
            ),
            (
                // The move rides along inside this one write — switching the theory list on
                // moves the live deck into it — and it must still be **one** line. N `move`
                // rows for one press would read as a deck somebody re-filed by hand.
                "deck_update (theory)",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 4)
                        .unwrap();
                    crate::deck::add_card(
                        &conn,
                        id,
                        "serra-lea",
                        Some(main),
                        None,
                        "live",
                        None,
                        2,
                    )
                    .unwrap();
                    clear(&conn);
                    crate::deck::update_deck(
                        &conn,
                        id,
                        &DeckPatch {
                            theory_enabled: Some(true),
                            ..Default::default()
                        },
                    )
                    .unwrap();
                }),
            ),
            (
                "deck_theory_copy_from_live",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 4)
                        .unwrap();
                    clear(&conn);
                    crate::deck_theory::copy_from_live(&conn, id).unwrap();
                }),
            ),
            (
                "deck_duplicate",
                1,
                Box::new(|| {
                    crate::deck::duplicate_deck(&conn, id, None).unwrap();
                }),
            ),
            (
                "deck_set_cover_image",
                1,
                Box::new(|| {
                    crate::deck::set_cover_image(&conn, &covers, id, &cover_bytes).unwrap();
                }),
            ),
            (
                "deck_set_folder",
                1,
                Box::new(|| {
                    crate::deck::set_folder(&conn, id, Some(folder)).unwrap();
                    clear(&conn);
                    crate::deck::set_folder(&conn, id, None).unwrap();
                }),
            ),
            (
                "deck_add_card",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 2)
                        .unwrap();
                }),
            ),
            (
                "deck_set_card_quantity",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 2)
                        .unwrap();
                    clear(&conn);
                    crate::deck::set_card_quantity(&conn, id, "bolt-lea", main, "live", None, 3)
                        .unwrap();
                }),
            ),
            (
                "deck_set_card_quantity (zero)",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 2)
                        .unwrap();
                    clear(&conn);
                    crate::deck::set_card_quantity(&conn, id, "bolt-lea", main, "live", None, 0)
                        .unwrap();
                }),
            ),
            (
                "deck_move_card",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 2)
                        .unwrap();
                    clear(&conn);
                    crate::deck::move_card(
                        &conn,
                        id,
                        "bolt-lea",
                        main,
                        Some(side),
                        None,
                        "live",
                        None,
                    )
                    .unwrap();
                }),
            ),
            (
                "deck_swap_printing",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 2)
                        .unwrap();
                    clear(&conn);
                    crate::deck::swap_printing(
                        &conn, id, "bolt-lea", "bolt-m10", main, "live", None,
                    )
                    .unwrap();
                }),
            ),
            (
                "deck_card_set_tag",
                1,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 2)
                        .unwrap();
                    let tag = crate::deck_meta::create_tag(&conn, id, "Cut candidate", "amber")
                        .unwrap()
                        .id;
                    clear(&conn);
                    crate::deck_meta::set_card_tag(
                        &conn,
                        id,
                        "bolt-lea",
                        main,
                        "live",
                        None,
                        Some(tag),
                    )
                    .unwrap();
                }),
            ),
            (
                "deck_category_create",
                1,
                Box::new(|| {
                    crate::deck_meta::create_category(&conn, id, "Ramp").unwrap();
                }),
            ),
            (
                "deck_category_rename",
                1,
                Box::new(|| {
                    let cat = crate::deck_meta::create_category(&conn, id, "Value")
                        .unwrap()
                        .id;
                    clear(&conn);
                    crate::deck_meta::rename_category(&conn, cat, "Draw").unwrap();
                }),
            ),
            (
                "deck_category_set_active",
                1,
                Box::new(|| {
                    let cat = crate::deck_meta::create_category(&conn, id, "Off")
                        .unwrap()
                        .id;
                    clear(&conn);
                    crate::deck_meta::set_category_active(&conn, cat, false).unwrap();
                }),
            ),
            (
                "deck_category_reorder",
                1,
                Box::new(|| {
                    crate::deck_meta::reorder_categories(&conn, id, &[side, main]).unwrap();
                }),
            ),
            (
                "deck_category_delete",
                1,
                Box::new(|| {
                    let cat = crate::deck_meta::create_category(&conn, id, "Doomed")
                        .unwrap()
                        .id;
                    clear(&conn);
                    crate::deck_meta::delete_category(&conn, cat, None).unwrap();
                }),
            ),
            (
                "deck_tag_create",
                1,
                Box::new(|| {
                    crate::deck_meta::create_tag(&conn, id, "Fresh", "amber").unwrap();
                }),
            ),
            (
                "deck_tag_update",
                1,
                Box::new(|| {
                    let tag = crate::deck_meta::create_tag(&conn, id, "Old", "amber")
                        .unwrap()
                        .id;
                    clear(&conn);
                    crate::deck_meta::update_tag(&conn, id, tag, "New", "jade").unwrap();
                }),
            ),
            (
                "deck_tag_delete",
                1,
                Box::new(|| {
                    let tag = crate::deck_meta::create_tag(&conn, id, "Doomed", "amber")
                        .unwrap()
                        .id;
                    clear(&conn);
                    crate::deck_meta::delete_tag(&conn, id, tag).unwrap();
                }),
            ),
            (
                // The one folder write that is a deck write. Create and rename and move change
                // no deck and are exempt; a delete re-files every deck in the folder through
                // `decks.folder_id`'s SET NULL, and one deck in it is one row.
                "deck_folder_delete",
                1,
                Box::new(|| {
                    let doomed = crate::deck_meta::create_folder(&conn, None, "Retired")
                        .unwrap()
                        .id;
                    crate::deck::set_folder(&conn, id, Some(doomed)).unwrap();
                    clear(&conn);
                    crate::deck_meta::delete_folder(&conn, doomed).unwrap();
                }),
            ),
            (
                // A whole decklist is still **one** change to a deck. N `add` rows for one
                // paste would bury every other event of that day under the import.
                "deck_import_commit (merge)",
                1,
                Box::new(|| {
                    crate::import::commit_import(
                        &conn,
                        id,
                        "live",
                        "merge",
                        &[
                            imported("bolt-lea", 4, "Main deck"),
                            imported("serra-lea", 2, "Main deck"),
                        ],
                    )
                    .unwrap();
                }),
            ),
            (
                // The one case in this list that owes **two** rows, and the doc above says why:
                // a replace over a non-empty variant cleared cards and added cards, and one
                // signed `delta` cannot be both −6 and +4.
                "deck_import_commit (replace)",
                2,
                Box::new(|| {
                    crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 6)
                        .unwrap();
                    clear(&conn);
                    crate::import::commit_import(
                        &conn,
                        id,
                        "live",
                        "replace",
                        &[imported("serra-lea", 4, "Main deck")],
                    )
                    .unwrap();
                }),
            ),
        ];

        /// Empty every deck's history, so the next case counts only its own row.
        fn clear(conn: &Connection) {
            conn.execute("DELETE FROM deck_audit", []).unwrap();
        }

        for (name, owed, drive) in cases {
            clear(&conn);
            drive();
            let written: i64 = conn
                .query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
                .unwrap();
            assert_eq!(
                written, owed,
                "`{name}` must record exactly {owed} audit row(s)"
            );
        }
        let _ = std::fs::remove_dir_all(&covers);
    }

    #[test]
    fn the_add_kind_records_the_category_and_the_copies() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");

        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, ADD);
        assert_eq!(row.variant, "live");
        assert_eq!(row.card_id.as_deref(), Some("bolt-lea"));
        assert_eq!(row.card_name.as_deref(), Some("Lightning Bolt"));
        assert_eq!(row.delta, 1, "an add is +copies");
        assert_eq!(payload, json!({ "category": "Ramp", "quantity": 1 }));
    }

    /// The category name travels even when the caller never wrote one: the add path's other
    /// arm asks for a category *by name*, and the row has to say which pile the card went into
    /// whichever arm put it there.
    #[test]
    fn the_add_kind_names_the_category_the_name_arm_found() {
        let conn = seeded();
        let id = deck(&conn, "Burn");

        crate::deck::add_card(
            &conn,
            id,
            "bolt-lea",
            None,
            Some("  Ramp  "),
            "live",
            None,
            3,
        )
        .unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.delta, 3);
        assert_eq!(
            payload,
            json!({ "category": "Ramp", "quantity": 3 }),
            "the trimmed name, which is the one the category was stored under"
        );
    }

    #[test]
    fn the_remove_kind_records_what_was_taken_out() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 2).unwrap();

        crate::deck::set_card_quantity(&conn, id, "bolt-lea", main, "live", None, 0).unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, REMOVE);
        assert_eq!(row.card_name.as_deref(), Some("Lightning Bolt"));
        assert_eq!(row.delta, -2, "a remove is −copies");
        assert_eq!(
            payload,
            json!({ "category": "Ramp", "quantity": 2, "reason": null })
        );
    }

    /// A stepper that lands on a slot already empty removed nothing, so there is nothing to
    /// record — the one place "exactly one row" gives way, and it gives way to the truth.
    /// `set_card_quantity` treats a delete that finds no row as a success (the caller wanted
    /// the slot empty and it is), and a `remove` row for zero copies would be a history of a
    /// change that never happened.
    #[test]
    fn removing_a_card_that_is_not_there_records_nothing() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        crate::deck::set_card_quantity(&conn, id, "bolt-lea", main, "live", None, 0).unwrap();

        assert_eq!(rows(&conn, id), 0);
    }

    #[test]
    fn the_quantity_kind_records_both_numbers() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();

        crate::deck::set_card_quantity(&conn, id, "bolt-lea", main, "live", None, 2).unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, QUANTITY);
        assert_eq!(row.delta, 1, "the difference, not the new total");
        assert_eq!(payload, json!({ "category": "Ramp", "from": 1, "to": 2 }));
    }

    #[test]
    fn the_move_kind_records_both_categories() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Creature");
        let maybe = kind_of(&conn, id, "maybe");
        crate::deck::add_card(&conn, id, "serra-lea", Some(main), None, "live", None, 1).unwrap();

        crate::deck::move_card(
            &conn,
            id,
            "serra-lea",
            main,
            Some(maybe),
            None,
            "live",
            None,
        )
        .unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, MOVE);
        assert_eq!(row.card_name.as_deref(), Some("Serra Angel"));
        assert_eq!(row.delta, 0, "a move changes no count");
        assert_eq!(payload, json!({ "from": "Creature", "to": "Maybeboard" }));
    }

    #[test]
    fn the_swap_kind_records_both_sets_and_whether_it_folded() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();

        crate::deck::swap_printing(&conn, id, "bolt-lea", "bolt-m10", main, "live", None).unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, SWAP);
        assert_eq!(
            row.card_id.as_deref(),
            Some("bolt-m10"),
            "the printing the deck plays now"
        );
        assert_eq!(row.delta, 0);
        assert_eq!(
            payload,
            json!({ "category": "Ramp", "fromSet": "lea", "toSet": "m10", "folded": false }),
            "set codes as `cards` stores them — the uppercase is the renderer's"
        );

        // The other half of `folded`: the target category already holds that printing, so the
        // two rows become one and the history says so.
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();
        crate::deck::swap_printing(&conn, id, "bolt-lea", "bolt-m10", main, "live", None).unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(payload["folded"], json!(true));
    }

    #[test]
    fn the_tag_kind_records_the_label_and_the_one_it_replaced() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();
        let cut = crate::deck_meta::create_tag(&conn, id, "Cut candidate", "amber")
            .unwrap()
            .id;
        let keep = crate::deck_meta::create_tag(&conn, id, "Keep", "jade")
            .unwrap()
            .id;

        crate::deck_meta::set_card_tag(&conn, id, "bolt-lea", main, "live", None, Some(cut))
            .unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, TAG);
        assert_eq!(row.card_name.as_deref(), Some("Lightning Bolt"));
        assert_eq!(row.delta, 0);
        assert_eq!(payload, json!({ "tag": "Cut candidate", "previous": null }));

        // Replacing one label with another, and then clearing it: `previous` is what makes
        // either readable, and `tag: null` is how the row says the card wears nothing now.
        crate::deck_meta::set_card_tag(&conn, id, "bolt-lea", main, "live", None, Some(keep))
            .unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "tag": "Keep", "previous": "Cut candidate" })
        );

        crate::deck_meta::set_card_tag(&conn, id, "bolt-lea", main, "live", None, None).unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(payload, json!({ "tag": null, "previous": "Keep" }));
    }

    /// The other half of the `tag` kind: the label itself, created, renamed and deleted. These
    /// rows carry no `card_id` — that is what tells a renderer "the tag" from "a card wearing
    /// the tag" — and an `action` verb, because without one a delete would read as a labelling.
    #[test]
    fn a_tag_of_its_own_records_the_verb_and_no_card() {
        let conn = seeded();
        let id = deck(&conn, "Burn");

        let tag = crate::deck_meta::create_tag(&conn, id, "Cut candidate", "amber")
            .unwrap()
            .id;
        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, TAG);
        assert_eq!(row.card_id, None, "a tag write is about no card");
        assert_eq!(
            payload,
            json!({ "action": "create", "tag": "Cut candidate", "previous": null })
        );

        crate::deck_meta::update_tag(&conn, id, tag, "Cut", "jade").unwrap();
        let (_, payload) = newest(&conn, id);
        // `color` rides along since v21: one row means one colour, so a recolour is a change a
        // reader may come back looking for — and a rename that also recoloured says both.
        assert_eq!(
            payload,
            json!({ "action": "rename", "tag": "Cut", "previous": "Cut candidate",
                    "color": "jade" })
        );

        // Same name, different colour: the other verb, and `previous` is null because nothing
        // was renamed.
        crate::deck_meta::update_tag(&conn, id, tag, "Cut", "amber").unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "action": "recolour", "tag": "Cut", "previous": null, "color": "amber" })
        );

        crate::deck_meta::delete_tag(&conn, id, tag).unwrap();
        let (_, payload) = newest(&conn, id);
        // `cards` is what `auditText` renders "N cards untagged" from. It reads the key for a
        // delete and always has; nothing wrote it until the reach became app-wide.
        assert_eq!(
            payload,
            json!({ "action": "delete", "tag": "Cut", "previous": null, "cards": 0 })
        );
    }

    #[test]
    fn the_category_kind_records_the_action_and_the_name() {
        let conn = seeded();
        let id = deck(&conn, "Burn");

        let cat = crate::deck_meta::create_category(&conn, id, "Value")
            .unwrap()
            .id;
        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, CATEGORY);
        assert_eq!(row.card_id, None);
        assert_eq!(row.delta, 0);
        assert_eq!(payload, json!({ "action": "create", "name": "Value" }));

        crate::deck_meta::rename_category(&conn, cat, "Draw").unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "action": "rename", "name": "Draw", "previousName": "Value" })
        );

        crate::deck_meta::set_category_active(&conn, cat, false).unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(payload, json!({ "action": "deactivate", "name": "Draw" }));

        crate::deck_meta::set_category_active(&conn, cat, true).unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(payload, json!({ "action": "activate", "name": "Draw" }));

        crate::deck_meta::reorder_categories(&conn, id, &[cat]).unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "action": "reorder" }),
            "a reorder names no category — every one of them moved"
        );

        // A delete says how many copies went with it, which is the number the confirm dialog
        // warned about and the only part of the category a reader cannot get back.
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 4).unwrap();
        crate::deck::add_card(&conn, id, "serra-lea", Some(main), None, "theory", None, 3).unwrap();
        crate::deck_meta::delete_category(&conn, main, None).unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "action": "delete", "name": "Ramp", "cards": 7 }),
            "copies, both variants — everything the CASCADE took"
        );
    }

    #[test]
    fn the_deck_kind_records_the_field_that_changed() {
        let conn = seeded();
        let id = deck(&conn, "Burn");

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, DECK);
        assert_eq!(
            payload,
            json!({ "field": "name", "from": null, "to": "Burn" }),
            "a deck begins with its name, and there was no previous one"
        );

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                name: Some("Burn v2".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "field": "name", "from": "Burn", "to": "Burn v2" })
        );

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "field": "archived", "from": false, "to": true })
        );

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                format_key: Some("legacy".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "field": "format", "from": "modern", "to": "legacy" })
        );

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                cover_card_id: Some("serra-lea".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "field": "cover", "from": null, "to": "serra-lea" })
        );

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                notes: Some("Needs a second Bolt.".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "field": "notes", "from": null, "to": "Needs a second Bolt." })
        );

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                theory_enabled: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        let (_, payload) = newest(&conn, id);
        assert_eq!(
            payload,
            json!({ "field": "theory", "from": false, "to": true })
        );
    }

    /// A patch that asks for the value a field already has changed nothing, and a history that
    /// said otherwise would fill the drawer with edits nobody made — every "save" press on an
    /// untouched form.
    #[test]
    fn a_patch_that_changes_nothing_records_nothing() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                name: Some("Burn".to_owned()),
                format_key: Some("modern".to_owned()),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(rows(&conn, id), 0);
    }

    /// Two fields changed in one call are two facts, and the drawer shows both. The "exactly
    /// one row" rule is per *change*, not per call — the editor sends one field at a time, and
    /// a form that batches them must not have to choose which half of its edit is remembered.
    #[test]
    fn a_patch_that_changes_two_fields_records_both() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                name: Some("Burn v2".to_owned()),
                archived: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        let fields: Vec<String> = history(&conn, id)
            .iter()
            .map(|r| {
                serde_json::from_str::<Value>(&r.payload).unwrap()["field"]
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(fields.len(), 2);
        assert!(fields.contains(&"name".to_owned()), "{fields:?}");
        assert!(fields.contains(&"archived".to_owned()), "{fields:?}");
    }

    #[test]
    fn the_folder_kind_records_where_the_deck_was_filed() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let commander = crate::deck_meta::create_folder(&conn, None, "Commander")
            .unwrap()
            .id;
        let legends = crate::deck_meta::create_folder(&conn, Some(commander), "Legends")
            .unwrap()
            .id;

        crate::deck::update_deck(
            &conn,
            id,
            &DeckPatch {
                folder_id: Some(legends),
                ..Default::default()
            },
        )
        .unwrap();

        let (row, payload) = newest(&conn, id);
        assert_eq!(row.kind, FOLDER);
        assert_eq!(row.delta, 0);
        assert_eq!(
            payload,
            json!({ "action": "move", "folder": "Commander › Legends" }),
            "the whole path, because a bare `Legends` names nothing on a tree with two of them"
        );
    }

    /// The transaction rule, proven by breaking it — and it can only be proven this way.
    ///
    /// If [`record`] opened a transaction of its own, which is the obvious implementation and
    /// the one every helper in this crate is *not*, the row below would commit and outlive the
    /// change it describes. That is a history that lies in the one direction a reader cannot
    /// check: the row it names is not there to disagree with it. Rolling the caller's
    /// transaction back is the whole test.
    #[test]
    fn a_recorded_change_that_rolls_back_leaves_no_history() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        let tx = conn.unchecked_transaction().unwrap();
        record(
            &tx,
            id,
            "live",
            ADD,
            Some(("bolt-lea", "Lightning Bolt")),
            &json!({ "category": "Ramp", "quantity": 1 }),
            1,
        )
        .unwrap();
        drop(tx);

        assert_eq!(rows(&conn, id), 0);
    }

    /// The same rule from the outside: a write refused part-way through takes its history with
    /// it, because the history was written inside the transaction that rolled back.
    #[test]
    fn a_refused_write_leaves_no_history_behind() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        // Another printing of another card: refused inside the transaction, after `touch_deck`
        // and the category fence have both already written.
        let refused =
            crate::deck::swap_printing(&conn, id, "bolt-lea", "serra-lea", main, "live", None)
                .unwrap_err();

        assert!(refused.contains("not another printing"), "{refused}");
        assert_eq!(
            rows(&conn, id),
            0,
            "a rolled-back change must leave no history"
        );
    }

    /// `deck_audit.deck_id` CASCADEs, which is why [`crate::deck::delete_deck`] records
    /// nothing: there is no history of a deck that is not there, and a row written to say so
    /// would be deleted by the same statement that made it true.
    #[test]
    fn deleting_a_deck_takes_its_history_with_it() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();
        assert!(rows(&conn, id) > 0);

        crate::deck::delete_deck(&conn, id, None).unwrap();

        let left: i64 = conn
            .query_row("SELECT count(*) FROM deck_audit", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }

    /// Newest first, and the tiebreaker inside one second is what makes that a total order —
    /// `unixepoch()` has one-second resolution, so a test writing three rows in a row writes
    /// them all at the same `at`.
    #[test]
    fn the_history_reads_newest_first_even_inside_one_second() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1).unwrap();
        crate::deck::add_card(&conn, id, "serra-lea", Some(main), None, "live", None, 1).unwrap();

        let names: Vec<Option<String>> = history(&conn, id)
            .into_iter()
            .map(|r| r.card_name)
            .collect();
        assert_eq!(
            names,
            vec![
                Some("Serra Angel".to_owned()),
                Some("Lightning Bolt".to_owned()),
                None, // the deck's own creation
            ]
        );
    }

    /// A limit is clamped rather than obeyed: SQLite reads a negative `LIMIT` as *no limit*,
    /// so a caller sending `0` or `-1` — a form field left empty, a page size computed from a
    /// zero-height drawer — would silently ask for every row instead of none.
    #[test]
    fn a_limit_is_clamped_at_both_ends() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Ramp");
        for _ in 0..4 {
            crate::deck::add_card(&conn, id, "bolt-lea", Some(main), None, "live", None, 1)
                .unwrap();
        }

        assert_eq!(list(&conn, id, 0).unwrap().len(), 1, "0 is not `no limit`");
        assert_eq!(list(&conn, id, -1).unwrap().len(), 1);
        assert_eq!(list(&conn, id, 2).unwrap().len(), 2);
        assert_eq!(
            list(&conn, id, i64::MAX).unwrap().len(),
            5,
            "everything there is, and never more than the cap"
        );
    }

    /// The fence against a refactor, not against a user: a kind that is not one of the nine
    /// answers a sentence naming them, rather than SQLite's own `CHECK constraint failed`.
    #[test]
    fn an_unknown_kind_is_refused_by_name() {
        let conn = seeded();
        let id = deck(&conn, "Burn");

        let refused = record(&conn, id, "live", "renamed", None, &json!({}), 0).unwrap_err();

        assert!(refused.contains("`renamed`"), "{refused}");
        assert!(refused.contains("quantity"), "{refused}");
    }

    /// `by_id` and `list` read the same row. They were two hand-written copies of one
    /// nine-column SELECT until 2026-08-16; this is what stops them becoming two again.
    #[test]
    fn by_id_answers_the_row_list_answers_and_none_for_an_id_that_is_not_there() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        // `deck()` already left the deck's own creation row; cleared so the assertion below is
        // about the one row this test writes, not about that one too.
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        let id = record(
            &conn,
            d,
            "live",
            ADD,
            Some(("bolt-lea", "Lightning Bolt")),
            &json!({}),
            4,
        )
        .unwrap();

        let listed = list(&conn, d, 10).unwrap();
        assert_eq!(
            listed.len(),
            1,
            "the deck has exactly the one row just written"
        );
        let fetched = by_id(&conn, id)
            .unwrap()
            .expect("the row it just wrote is findable");
        assert_eq!(
            fetched, listed[0],
            "by_id and list must answer the same row"
        );

        assert!(
            by_id(&conn, id + 1000).unwrap().is_none(),
            "an id with no row is None, not an error"
        );
    }
}
