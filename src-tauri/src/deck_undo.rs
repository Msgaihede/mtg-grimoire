//! Undo and redo for the deck editor: the journal, and the four primitives it replays.
//!
//! Three decisions shape this module, and each one is a thing that goes wrong if it is
//! reversed:
//!
//! * **A step restores rows; it does not run a command backwards.** There is no
//!   `unmove_card`, no `unswap_printing`. A step names a **scope** — the cells of `deck_cards`
//!   the write was about — and the rows that were in it, and applying the step deletes exactly
//!   that scope and inserts exactly those rows. That is what makes the swap's *fold* reversible
//!   (two rows became one; the step carries both), what makes a category delete reversible (the
//!   CASCADE took the cards; the step carries them), and what makes every one of these
//!   idempotent. An inverse-command design would need `deck_import_commit` to have an inverse,
//!   and it has none: `replace` cleared rows nothing recorded.
//! * **[`record_step`] is called inside the caller's transaction and never opens its own.**
//!   [`crate::deck_audit::record`]'s rule, for a sharper version of its reason. An audit row
//!   that outlives its change is a history that lies; a *step* that outlives its change is a
//!   reversal that would be applied into a deck that never had it done, and unlike the history
//!   row nobody would read it first.
//! * **Rust restores facts; it draws no conclusion about them.** Nothing here consults
//!   `autoCategoryFor`, decides which pile a card belongs in, or words a sentence — restoring
//!   the exact rows that were there is data plumbing, which is the side of CLAUDE.md's boundary
//!   this belongs on. `auditText.ts` is still the only thing that words an undo.
//!
//! # The cursor, and why redo is not in this table
//!
//! `deck_undo.undone_at` is NULL while a change is still applied, and the cursor is the newest
//! row of a deck that is still NULL ([`next_undo`]). It **persists**, so undo survives a restart
//! and carries on below where it stopped — "as far back as the history allows".
//!
//! **Redo is deliberately not derivable from this table.** A redo stack is the *reader's*
//! position in a session, not a fact about the deck: the webview holds the ids it has just
//! undone and hands one back to [`redo_apply`], and closing the window throws them away. That is
//! the asymmetry this feature was asked for, and it is why `undone_at` is a stamp rather than a
//! second cursor — a database-backed redo would resurrect a fortnight-old branch of edits the
//! reader had forgotten making.
//!
//! # An undo is a `deck` audit row and adds no kind
//!
//! [`crate::schema::AUDIT_KINDS`] stays at nine. `deck_audit.kind`'s CHECK cannot be altered —
//! SQLite has no `ALTER … CHECK` — so a tenth word means rebuilding every reader's whole deck
//! history for a spelling. [`crate::deck_import::commit_import`] met this first and reused
//! `add`/`remove` with a keyed payload; this reuses `deck` with
//! `{"field":"undo"|"redo","of":<audit_id>}`. `auditText.ts`'s `deckLine` already answers an
//! unrecognised field with "Changed the deck", so an older build degrades to a true sentence
//! rather than to a hole.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// What an apply says when the id it was handed is not the deck's cursor.
///
/// The id travels from the webview rather than being implied, so a window showing a stale
/// toolbar cannot undo something it was not looking at. The sentence names the situation rather
/// than the id, because the reader's next act is to look at the history and not to debug.
pub const MOVED_ON: &str =
    "That is not the most recent change any more — the deck has been edited since. \
     Open the history to see what happened.";

/// What an apply says when there is nothing at the cursor at all.
pub const NOTHING_TO_UNDO: &str = "There is nothing left to undo in this deck.";

/// What a redo says when the step it was handed is not undone.
pub const NOTHING_TO_REDO: &str = "That change has not been undone, so there is nothing to redo.";

/// What a step says when a row it was told to change back is not there.
///
/// A fence against a **refactor**, like [`DECK_FIELDS`]: the strict-stack cursor means a step
/// is only ever applied to the deck it was recorded against, in order, so a patch that finds
/// nothing is a step built wrong at its call site — and the alternative is a `0 rows changed`
/// that reports success and leaves the reader's deck half-reverted.
pub const MISSING_ROW: &str =
    "That change cannot be undone: part of what it changed is no longer in the deck.";

/// The `decks` columns a [`Op::Deck`] step may write, and the whole of the fence around it.
///
/// A step is JSON that came out of this database, so this is a fence against a **refactor**
/// rather than against a user — the same standing [`crate::deck_audit::record`]'s kind check
/// has. What it buys is that a column added to `decks` later cannot be written by a step
/// recorded before anyone thought about whether undoing it is meaningful: it has to be added
/// here on purpose.
///
/// **`updated_at` is deliberately absent.** Undo is an edit like any other and moves the deck to
/// the top of a gallery sorted by "most recently touched", because that is what happened.
const DECK_FIELDS: &[&str] = &[
    "name",
    "format_key",
    "description",
    "notes",
    "cover_card_id",
    "cover_kind",
    "cover_image_path",
    "folder_id",
    "theory_enabled",
    "is_built",
    "archived",
    "separate_x_group",
    "default_category_id",
    "last_variant",
    "last_group_by",
    "last_sort_by",
];

/// One `deck_cards` row, as a step carries it.
///
/// **`id`, `created_at` and `updated_at` are deliberately not here.** A restored row is a new
/// row: nothing in the schema points at `deck_cards.id` (`deck_allocations` holds
/// `collection_entry_id`s, and the allocator is rebuilt from scratch at the end of every apply),
/// so carrying the old id would buy nothing and would collide the first time an id had been
/// reused. `created_at` would claim the row had been there all along, which is the one thing
/// about it that is not true.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardRow {
    pub category_id: i64,
    pub variant: String,
    pub card_id: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
    pub name: String,
    pub tag_id: Option<i64>,
    pub quantity: i64,
    pub needs_review: Option<String>,
}

/// One slot of `deck_cards` a step is about — the unit a scope is built from.
///
/// `card_id: None` means **every card** of that `(variant, category)`, which is what a cleared
/// pile and a deleted category need. Spelling it as an absent id rather than as a second op kind
/// is what keeps [`Op::Cards`] one arm: a clear is a scope of one wide cell, and a quantity
/// change is a scope of one narrow one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub variant: String,
    pub category_id: i64,
    pub card_id: Option<String>,
}

impl Cell {
    /// One printing in one pile of one list — the shape almost every card write is about.
    pub fn card(variant: &str, category_id: i64, card_id: &str) -> Self {
        Self {
            variant: variant.to_owned(),
            category_id,
            card_id: Some(card_id.to_owned()),
        }
    }

    /// A whole pile of one list — what a clear and a category delete are about.
    pub fn pile(variant: &str, category_id: i64) -> Self {
        Self {
            variant: variant.to_owned(),
            category_id,
            card_id: None,
        }
    }
}

/// One `deck_categories` row, as a step carries it. `deck_id` is the step's, not the row's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CategoryRow {
    pub id: i64,
    pub name: String,
    pub kind: String,
    pub is_active: bool,
    pub sort_order: i64,
    pub origin: String,
}

/// One `deck_tags` row, as a step carries it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagRow {
    pub id: i64,
    pub name: String,
    pub color: String,
}

/// Which label one deck card wore.
///
/// Addressed by its **cell** rather than by `deck_cards.id`, because a step is replayed after
/// other steps may have deleted and reinserted that row — [`CardRow`] says why ids are not
/// restored. The cell is stable across all of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Carrier {
    pub variant: String,
    pub category_id: i64,
    pub card_id: String,
    pub tag_id: Option<i64>,
}

/// One reversal instruction. A step is a list of these, applied in order.
///
/// **Order inside a step is load-bearing**: `deck_cards.category_id` and `.tag_id` are real
/// foreign keys, so a [`Op::Categories`] or [`Op::Tags`] that restores a row has to run before
/// the [`Op::Cards`] that files cards under it. Every call site builds its list in that order,
/// and [`apply`] threads the id remap forward so the later ops see it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Op {
    /// Delete exactly `scope` and insert exactly `rows`.
    Cards {
        scope: Vec<Cell>,
        rows: Vec<CardRow>,
    },
    /// The same over a whole variant of the deck — an import, or the theory move.
    Variant { variant: String, rows: Vec<CardRow> },
    /// Bring categories back, set existing ones' columns, delete them, and optionally put
    /// `decks.default_category_id` back.
    ///
    /// **`restore` and `patch` are two lists because they are two intents, and one list cannot
    /// tell them apart.** A patch is a rename, a switch or a reorder: the row is there and its
    /// columns go back. A restore is a delete being undone: the row is *gone*, and whatever
    /// holds its id now is somebody else's pile — `deck_categories.id` is a rowid alias, so
    /// deleting the highest-numbered pile and making a new one reuses the number, and that new
    /// pile belongs to the same deck. A single list deciding by "is there a row at this id"
    /// therefore renames the reader's newest pile into the one they deleted, silently, and
    /// leaves the cards in it. That is not a hypothetical: it is what
    /// `a_restored_category_keeps_its_cards_even_when_its_id_was_reused` caught.
    Categories {
        #[serde(default)]
        restore: Vec<CategoryRow>,
        #[serde(default)]
        patch: Vec<CategoryRow>,
        #[serde(default)]
        delete: Vec<i64>,
        #[serde(default)]
        default_category_id: Option<i64>,
    },
    /// The same three lists over `deck_tags`, plus which cards wore them.
    Tags {
        #[serde(default)]
        restore: Vec<TagRow>,
        #[serde(default)]
        patch: Vec<TagRow>,
        #[serde(default)]
        delete: Vec<i64>,
        #[serde(default)]
        carriers: Vec<Carrier>,
    },
    /// Put named `decks` columns back. Keys are checked against [`DECK_FIELDS`].
    Deck {
        fields: serde_json::Map<String, Value>,
    },
}

/// One change, reversible both ways.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Step {
    pub undo: Vec<Op>,
    pub redo: Vec<Op>,
}

impl Step {
    pub fn new(undo: Vec<Op>, redo: Vec<Op>) -> Self {
        Self { undo, redo }
    }
}

/// Ids that moved while a step was being applied.
///
/// A restored category or tag keeps its own id whenever that id is free, which is the case
/// almost every time and is what lets the [`Op::Cards`] beside it name the id it recorded. When
/// the id has been **taken since** — `deck_categories.id` is a rowid alias, so deleting the
/// highest-numbered pile and making a new one reuses the number — the row comes back under a
/// fresh id and every later op in the same step is rewritten through this map. Without it the
/// cards would be filed under a pile belonging to somebody else's press, or refused outright by
/// the foreign key.
#[derive(Debug, Default)]
struct Remap {
    categories: HashMap<i64, i64>,
    tags: HashMap<i64, i64>,
}

impl Remap {
    fn category(&self, id: i64) -> i64 {
        self.categories.get(&id).copied().unwrap_or(id)
    }

    fn tag(&self, id: Option<i64>) -> Option<i64> {
        id.map(|t| self.tags.get(&t).copied().unwrap_or(t))
    }
}

/// Write one step, inside the transaction the caller already opened.
///
/// `audit_id` is the history row this reverses — [`crate::deck_audit::record`] writes that row,
/// so the call is `record_step(&tx, tx.last_insert_rowid(), …)` immediately after it. For the
/// three commands that write more than one audit row for one press
/// (`deck_update`, `deck_import_commit` in `replace` mode, `deck_folder_delete`), the id is the
/// **last** of them and the earlier rows get no step at all — one press is one Ctrl+Z, and a
/// cursor that could land mid-press would undo half of a reader's single act.
pub fn record_step(
    tx: &Connection,
    audit_id: i64,
    deck_id: i64,
    step: &Step,
) -> Result<(), String> {
    let json = serde_json::to_string(step).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO deck_undo (audit_id, deck_id, step) VALUES (?1, ?2, ?3)",
        params![audit_id, deck_id, json],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// The rows of `deck_cards` in these cells, as a step carries them.
///
/// Called **before** the write it is recording a reversal for, which is the whole discipline of
/// this module: the "before" side of a step is read inside the caller's transaction, after its
/// fences have passed and before its own statement runs.
pub fn read_cells(conn: &Connection, deck_id: i64, cells: &[Cell]) -> Result<Vec<CardRow>, String> {
    let mut rows = Vec::new();
    for cell in cells {
        let mut stmt = conn
            .prepare(
                "SELECT category_id, variant, card_id, set_code, collector_number, lang, name,
                        tag_id, quantity, needs_review
                   FROM deck_cards
                  WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3
                    AND (?4 IS NULL OR card_id = ?4)",
            )
            .map_err(|e| e.to_string())?;
        let found = stmt
            .query_map(
                params![deck_id, cell.variant, cell.category_id, cell.card_id],
                card_row,
            )
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        rows.extend(found);
    }
    Ok(rows)
}

/// Every row of one variant of one deck — an import's and the theory move's "before".
pub fn read_variant(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
) -> Result<Vec<CardRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT category_id, variant, card_id, set_code, collector_number, lang, name,
                    tag_id, quantity, needs_review
               FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, variant], card_row)
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn card_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<CardRow> {
    Ok(CardRow {
        category_id: r.get(0)?,
        variant: r.get(1)?,
        card_id: r.get(2)?,
        set_code: r.get(3)?,
        collector_number: r.get(4)?,
        lang: r.get(5)?,
        name: r.get(6)?,
        tag_id: r.get(7)?,
        quantity: r.get(8)?,
        needs_review: r.get(9)?,
    })
}

/// One `deck_categories` row, for the "before" side of a category step.
pub fn read_category(conn: &Connection, id: i64) -> Result<Option<CategoryRow>, String> {
    conn.query_row(
        "SELECT id, name, kind, is_active, sort_order, origin
           FROM deck_categories WHERE id = ?1",
        params![id],
        |r| {
            Ok(CategoryRow {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                is_active: r.get(3)?,
                sort_order: r.get(4)?,
                origin: r.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every category of a deck, in id order — what a reorder's step carries on both sides.
pub fn read_categories(conn: &Connection, deck_id: i64) -> Result<Vec<CategoryRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, is_active, sort_order, origin
               FROM deck_categories WHERE deck_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| {
            Ok(CategoryRow {
                id: r.get(0)?,
                name: r.get(1)?,
                kind: r.get(2)?,
                is_active: r.get(3)?,
                sort_order: r.get(4)?,
                origin: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One `deck_tags` row, for the "before" side of a tag step.
pub fn read_tag(conn: &Connection, id: i64) -> Result<Option<TagRow>, String> {
    conn.query_row(
        "SELECT id, name, color FROM deck_tags WHERE id = ?1",
        params![id],
        |r| {
            Ok(TagRow {
                id: r.get(0)?,
                name: r.get(1)?,
                color: r.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Every card wearing one tag, as cells — what a tag delete's `SET NULL` is about to clear.
pub fn read_carriers(conn: &Connection, tag_id: i64) -> Result<Vec<Carrier>, String> {
    let mut stmt = conn
        .prepare("SELECT variant, category_id, card_id FROM deck_cards WHERE tag_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![tag_id], |r| {
            Ok(Carrier {
                variant: r.get(0)?,
                category_id: r.get(1)?,
                card_id: r.get(2)?,
                tag_id: Some(tag_id),
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The named `decks` columns as they are now — an [`Op::Deck`]'s "before" or "after".
pub fn read_deck_fields(
    conn: &Connection,
    deck_id: i64,
    fields: &[&str],
) -> Result<serde_json::Map<String, Value>, String> {
    let mut out = serde_json::Map::new();
    for field in fields {
        if !DECK_FIELDS.contains(field) {
            return Err(format!(
                "`{field}` is not a deck column an undo step may write."
            ));
        }
        let value: Value = conn
            .query_row(
                &format!("SELECT {field} FROM decks WHERE id = ?1"),
                params![deck_id],
                |r| {
                    Ok(match r.get_ref(0)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(i) => json!(i),
                        rusqlite::types::ValueRef::Real(f) => json!(f),
                        rusqlite::types::ValueRef::Text(t) => {
                            json!(String::from_utf8_lossy(t).into_owned())
                        }
                        rusqlite::types::ValueRef::Blob(_) => Value::Null,
                    })
                },
            )
            .map_err(|e| e.to_string())?;
        out.insert((*field).to_owned(), value);
    }
    Ok(out)
}

/// Apply a list of ops, inside the caller's transaction.
///
/// The caller runs [`crate::deck::allocate_deck`] afterwards, once, for the whole step — the
/// same argument `deck_import::commit_import` makes for a decklist: a rebuild per op would be N
/// rebuilds of one deck's claims for one press.
pub fn apply(tx: &Connection, deck_id: i64, ops: &[Op]) -> Result<(), String> {
    let mut remap = Remap::default();
    for op in ops {
        match op {
            Op::Cards { scope, rows } => {
                for cell in scope {
                    tx.execute(
                        "DELETE FROM deck_cards
                          WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3
                            AND (?4 IS NULL OR card_id = ?4)",
                        params![
                            deck_id,
                            cell.variant,
                            remap.category(cell.category_id),
                            cell.card_id
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
                insert_cards(tx, deck_id, rows, &remap)?;
            }
            Op::Variant { variant, rows } => {
                tx.execute(
                    "DELETE FROM deck_cards WHERE deck_id = ?1 AND variant = ?2",
                    params![deck_id, variant],
                )
                .map_err(|e| e.to_string())?;
                insert_cards(tx, deck_id, rows, &remap)?;
            }
            Op::Categories {
                restore,
                patch,
                delete,
                default_category_id,
            } => {
                for id in delete {
                    tx.execute(
                        "DELETE FROM deck_categories WHERE id = ?1 AND deck_id = ?2",
                        params![remap.category(*id), deck_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                for row in restore {
                    restore_category(tx, deck_id, row, &mut remap)?;
                }
                for row in patch {
                    patch_category(tx, deck_id, row, &remap)?;
                }
                if let Some(id) = default_category_id {
                    tx.execute(
                        "UPDATE decks SET default_category_id = ?2 WHERE id = ?1",
                        params![deck_id, remap.category(*id)],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Op::Tags {
                restore,
                patch,
                delete,
                carriers,
            } => {
                for id in delete {
                    tx.execute(
                        "DELETE FROM deck_tags WHERE id = ?1 AND deck_id = ?2",
                        params![remap.tag(Some(*id)), deck_id],
                    )
                    .map_err(|e| e.to_string())?;
                }
                for row in restore {
                    restore_tag(tx, deck_id, row, &mut remap)?;
                }
                for row in patch {
                    let id = remap.tag(Some(row.id));
                    let changed = tx
                        .execute(
                            "UPDATE deck_tags SET name = ?2, color = ?3, updated_at = unixepoch()
                              WHERE id = ?1 AND deck_id = ?4",
                            params![id, row.name, row.color, deck_id],
                        )
                        .map_err(|e| e.to_string())?;
                    if changed == 0 {
                        return Err(MISSING_ROW.to_owned());
                    }
                }
                for carrier in carriers {
                    tx.execute(
                        "UPDATE deck_cards SET tag_id = ?5, updated_at = unixepoch()
                          WHERE deck_id = ?1 AND variant = ?2 AND category_id = ?3
                            AND card_id = ?4",
                        params![
                            deck_id,
                            carrier.variant,
                            remap.category(carrier.category_id),
                            carrier.card_id,
                            remap.tag(carrier.tag_id)
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
            Op::Deck { fields } => {
                for (field, value) in fields {
                    if !DECK_FIELDS.contains(&field.as_str()) {
                        return Err(format!(
                            "`{field}` is not a deck column an undo step may write."
                        ));
                    }
                    tx.execute(
                        &format!("UPDATE decks SET {field} = ?2 WHERE id = ?1"),
                        params![deck_id, JsonParam(value)],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    Ok(())
}

/// A JSON value bound as the SQLite value it came out of the database as.
///
/// `serde_json::Value` has no `ToSql`, and a blanket `to_string()` would write the *text*
/// `"true"` into `theory_enabled` — which SQLite accepts, and which every later read then sees
/// as neither 0 nor 1.
struct JsonParam<'a>(&'a Value);

impl rusqlite::ToSql for JsonParam<'_> {
    fn to_sql(&self) -> rusqlite::Result<rusqlite::types::ToSqlOutput<'_>> {
        use rusqlite::types::{ToSqlOutput, Value as SqlValue};
        Ok(match self.0 {
            Value::Null => ToSqlOutput::Owned(SqlValue::Null),
            Value::Bool(b) => ToSqlOutput::Owned(SqlValue::Integer(i64::from(*b))),
            Value::Number(n) => match n.as_i64() {
                Some(i) => ToSqlOutput::Owned(SqlValue::Integer(i)),
                None => ToSqlOutput::Owned(SqlValue::Real(n.as_f64().unwrap_or_default())),
            },
            Value::String(s) => ToSqlOutput::Owned(SqlValue::Text(s.clone())),
            // An array or an object in a `decks` column is not a state this app can produce;
            // storing its JSON text is the least surprising answer and cannot fail the step.
            other => ToSqlOutput::Owned(SqlValue::Text(other.to_string())),
        })
    }
}

fn insert_cards(
    tx: &Connection,
    deck_id: i64,
    rows: &[CardRow],
    remap: &Remap,
) -> Result<(), String> {
    for row in rows {
        tx.execute(
            "INSERT INTO deck_cards
                (deck_id, category_id, variant, card_id, set_code, collector_number, lang,
                 name, tag_id, quantity, needs_review, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, unixepoch(), unixepoch())",
            params![
                deck_id,
                remap.category(row.category_id),
                row.variant,
                row.card_id,
                row.set_code,
                row.collector_number,
                row.lang,
                row.name,
                remap.tag(row.tag_id),
                row.quantity,
                row.needs_review
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Bring one category back from a delete, keeping its own id where that id is free.
///
/// **Two cases, and the second is the whole reason this is not an upsert.**
///
/// 1. **Nothing holds that id** — insert with the id it had, and the cards restored beside it
///    resolve with no remap. This is what happens almost every time.
/// 2. **Something holds it** — insert under a fresh id and record the move in the remap, which
///    every later op in this step reads. `deck_categories.id` is a rowid alias, so deleting the
///    highest-numbered pile and creating another one reuses the number, and **that pile belongs
///    to the same deck** — which is why "is it this deck's row?" is not the question. Updating
///    it would rename the reader's newest pile into the one they deleted and hand it their old
///    cards.
///
/// A row that is merely being *changed back* — a rename, a switch, a reorder — is
/// [`patch_category`]'s, not this one's. The two are separate lists on [`Op::Categories`]
/// because no test of the database can tell the two intents apart after the fact.
fn restore_category(
    tx: &Connection,
    deck_id: i64,
    row: &CategoryRow,
    remap: &mut Remap,
) -> Result<(), String> {
    if taken(tx, "deck_categories", row.id)? {
        let fresh: i64 = tx
            .query_row(
                "INSERT INTO deck_categories
                    (deck_id, name, kind, is_active, sort_order, origin, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, unixepoch(), unixepoch())
                 RETURNING id",
                params![
                    deck_id,
                    row.name,
                    row.kind,
                    row.is_active,
                    row.sort_order,
                    row.origin
                ],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        remap.categories.insert(row.id, fresh);
    } else {
        tx.execute(
            "INSERT INTO deck_categories
                (id, deck_id, name, kind, is_active, sort_order, origin, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, unixepoch(), unixepoch())",
            params![
                row.id,
                deck_id,
                row.name,
                row.kind,
                row.is_active,
                row.sort_order,
                row.origin
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Put an existing category's columns back — a rename, a switch or a reorder, undone.
///
/// The row must be there. A patch that changes nothing means the step is being replayed against
/// a deck it does not describe, which the strict-stack cursor makes unreachable and which is
/// therefore a bug rather than a state to tolerate silently.
fn patch_category(
    tx: &Connection,
    deck_id: i64,
    row: &CategoryRow,
    remap: &Remap,
) -> Result<(), String> {
    let changed = tx
        .execute(
            "UPDATE deck_categories
                SET name = ?2, kind = ?3, is_active = ?4, sort_order = ?5, origin = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1 AND deck_id = ?7",
            params![
                remap.category(row.id),
                row.name,
                row.kind,
                row.is_active,
                row.sort_order,
                row.origin,
                deck_id
            ],
        )
        .map_err(|e| e.to_string())?;
    (changed > 0)
        .then_some(())
        .ok_or_else(|| MISSING_ROW.to_owned())
}

/// Bring one tag back from a delete — [`restore_category`]'s two cases, over `deck_tags`.
fn restore_tag(
    tx: &Connection,
    deck_id: i64,
    row: &TagRow,
    remap: &mut Remap,
) -> Result<(), String> {
    if taken(tx, "deck_tags", row.id)? {
        let fresh: i64 = tx
            .query_row(
                "INSERT INTO deck_tags (deck_id, name, color, created_at, updated_at)
                 VALUES (?1, ?2, ?3, unixepoch(), unixepoch()) RETURNING id",
                params![deck_id, row.name, row.color],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        remap.tags.insert(row.id, fresh);
    } else {
        tx.execute(
            "INSERT INTO deck_tags (id, deck_id, name, color, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())",
            params![row.id, deck_id, row.name, row.color],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Is anything at all sitting on this rowid?
///
/// **Deck-blind on purpose.** The question a restore asks is "may I have my id back", and the
/// answer is no whoever holds it — a pile of this very deck, made after the delete, is the
/// commonest holder and the one that made the deck-scoped version of this check wrong.
///
/// The table name is interpolated because `PRAGMA`-free SQLite has no parameter position for
/// one; both call sites pass a literal from this module and no caller reaches it.
fn taken(tx: &Connection, table: &str, id: i64) -> Result<bool, String> {
    tx.query_row(
        &format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?1)"),
        params![id],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// The audit id of the next thing Ctrl+Z would undo in this deck, or `None`.
///
/// The newest step of this deck that is still applied. `audit_id DESC` rather than a stamp:
/// `deck_audit.at` is `unixepoch()` and a single press can write two rows inside one second —
/// the same reason `deck_audit::list` tie-breaks on the id, one table over.
pub fn next_undo(conn: &Connection, deck_id: i64) -> Result<Option<i64>, String> {
    conn.query_row(
        "SELECT audit_id FROM deck_undo
          WHERE deck_id = ?1 AND undone_at IS NULL
          ORDER BY audit_id DESC LIMIT 1",
        params![deck_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The step stored for one history row, and whether it has been undone.
pub fn read_step(conn: &Connection, audit_id: i64) -> Result<Option<(Step, bool)>, String> {
    let found: Option<(String, Option<i64>)> = conn
        .query_row(
            "SELECT step, undone_at FROM deck_undo WHERE audit_id = ?1",
            params![audit_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match found {
        Some((json, undone_at)) => {
            let step: Step = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            Ok(Some((step, undone_at.is_some())))
        }
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::DeckInput;

    /// Two printings of one card and one of another — a swap needs two printings of one oracle
    /// card, and a move needs somewhere to go. `deck_audit`'s fixture, for its reasons.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,mana_cost,cmc,type_line,prices,raw)
               VALUES
                 ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                  '{R}',1.0,'Instant','{"usd":"400.00"}','{}'),
                 ('bolt-m10','o1','Lightning Bolt','m10','146','en','normal','common',
                  '{R}',1.5,'Instant','{"usd":"1.50"}','{}'),
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

    fn quantity(conn: &Connection, deck_id: i64, category_id: i64, card_id: &str) -> i64 {
        conn.query_row(
            "SELECT coalesce(sum(quantity), 0) FROM deck_cards
              WHERE deck_id = ?1 AND category_id = ?2 AND card_id = ?3 AND variant = 'live'",
            params![deck_id, category_id, card_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The primitive the whole module rests on: a scope is exact in both directions — every
    /// cell it names is emptied, and no cell it does not name is touched.
    #[test]
    fn a_cards_op_restores_exactly_the_cells_it_names_and_nothing_else() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        let draw = category(&conn, id, "Draw");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", 2).unwrap();
        crate::deck::add_card(&conn, id, "serra-lea", Some(draw), None, "live", 1).unwrap();

        let scope = vec![Cell::card("live", ramp, "bolt-lea")];
        let before = read_cells(&conn, id, &scope).unwrap();
        crate::deck::set_card_quantity(&conn, id, "bolt-lea", ramp, "live", 5).unwrap();
        assert_eq!(quantity(&conn, id, ramp, "bolt-lea"), 5);

        apply(
            &conn,
            id,
            &[Op::Cards {
                scope: scope.clone(),
                rows: before,
            }],
        )
        .unwrap();

        assert_eq!(
            quantity(&conn, id, ramp, "bolt-lea"),
            2,
            "the named cell is back as it was"
        );
        assert_eq!(
            quantity(&conn, id, draw, "serra-lea"),
            1,
            "a cell the scope did not name is untouched"
        );
    }

    /// A cell with no card id is the whole pile, which is what a clear and a category delete
    /// are about — and it must not reach the same printing in another pile.
    #[test]
    fn a_pile_cell_covers_every_card_of_that_category_and_no_other() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        let draw = category(&conn, id, "Draw");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", 2).unwrap();
        crate::deck::add_card(&conn, id, "serra-lea", Some(ramp), None, "live", 3).unwrap();
        crate::deck::add_card(&conn, id, "bolt-lea", Some(draw), None, "live", 1).unwrap();

        let scope = vec![Cell::pile("live", ramp)];
        let before = read_cells(&conn, id, &scope).unwrap();
        assert_eq!(before.len(), 2);
        crate::deck::clear_category(&conn, id, ramp, "live").unwrap();

        apply(
            &conn,
            id,
            &[Op::Cards {
                scope,
                rows: before,
            }],
        )
        .unwrap();

        assert_eq!(quantity(&conn, id, ramp, "bolt-lea"), 2);
        assert_eq!(quantity(&conn, id, ramp, "serra-lea"), 3);
        assert_eq!(
            quantity(&conn, id, draw, "bolt-lea"),
            1,
            "the same printing in another pile is a different cell"
        );
    }

    /// A category comes back with its own id, and the cards under it still resolve — the
    /// ordinary case, where nothing has taken the id.
    #[test]
    fn a_deleted_category_comes_back_with_its_own_id() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", 4).unwrap();

        let row = read_category(&conn, ramp).unwrap().unwrap();
        let cards = read_cells(&conn, id, &[Cell::pile("live", ramp)]).unwrap();
        crate::deck_meta::delete_category(&conn, ramp, None).unwrap();

        apply(
            &conn,
            id,
            &[
                Op::Categories {
                    restore: vec![row],
                    patch: vec![],
                    delete: vec![],
                    default_category_id: None,
                },
                Op::Cards {
                    scope: vec![Cell::pile("live", ramp)],
                    rows: cards,
                },
            ],
        )
        .unwrap();

        assert_eq!(quantity(&conn, id, ramp, "bolt-lea"), 4);
        assert_eq!(read_category(&conn, ramp).unwrap().unwrap().name, "Ramp");
    }

    /// The case the remap exists for. `deck_categories.id` is a rowid alias, so deleting the
    /// highest-numbered pile and creating another one **reuses the number** — and a step that
    /// re-inserted under its recorded id would either collide or file the reader's cards into
    /// a pile they made a moment ago. Neither is a thing a test would notice from row counts,
    /// which is why this one follows the cards.
    #[test]
    fn a_restored_category_keeps_its_cards_even_when_its_id_was_reused() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let ramp = category(&conn, id, "Ramp");
        crate::deck::add_card(&conn, id, "bolt-lea", Some(ramp), None, "live", 4).unwrap();

        let row = read_category(&conn, ramp).unwrap().unwrap();
        let cards = read_cells(&conn, id, &[Cell::pile("live", ramp)]).unwrap();
        crate::deck_meta::delete_category(&conn, ramp, None).unwrap();

        // The reader makes another pile, which takes the freed rowid.
        let usurper = crate::deck_meta::create_category(&conn, id, "Draw")
            .unwrap()
            .id;
        assert_eq!(
            usurper, ramp,
            "the fixture only tests anything if the id was reused"
        );

        apply(
            &conn,
            id,
            &[
                Op::Categories {
                    restore: vec![row],
                    patch: vec![],
                    delete: vec![],
                    default_category_id: None,
                },
                Op::Cards {
                    scope: vec![Cell::pile("live", ramp)],
                    rows: cards,
                },
            ],
        )
        .unwrap();

        let restored: i64 = conn
            .query_row(
                "SELECT id FROM deck_categories WHERE deck_id = ?1 AND name = 'Ramp'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_ne!(restored, ramp, "it had to move, because Draw holds that id");
        assert_eq!(
            quantity(&conn, id, restored, "bolt-lea"),
            4,
            "the cards followed it through the remap"
        );
        assert_eq!(
            quantity(&conn, id, usurper, "bolt-lea"),
            0,
            "and none of them landed in the pile that took the id"
        );
    }

    /// A `Deck` op writes the SQLite value the column came out as, never its JSON text — a
    /// `theory_enabled` of `"true"` is a string SQLite stores happily and every later read
    /// sees as neither 0 nor 1.
    #[test]
    fn a_deck_op_restores_a_flag_as_a_number_and_a_null_as_null() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let before = read_deck_fields(&conn, id, &["theory_enabled", "notes"]).unwrap();

        conn.execute(
            "UPDATE decks SET theory_enabled = 1, notes = 'x' WHERE id = ?1",
            params![id],
        )
        .unwrap();

        apply(&conn, id, &[Op::Deck { fields: before }]).unwrap();

        let (theory, notes): (i64, Option<String>) = conn
            .query_row(
                "SELECT theory_enabled, notes FROM decks WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(theory, 0);
        assert_eq!(notes, None);
    }

    /// The fence against a refactor, not against a user: a step naming a column nobody decided
    /// was undoable is refused by name rather than executed as SQL.
    #[test]
    fn a_deck_op_refuses_a_column_that_is_not_on_the_list() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let mut fields = serde_json::Map::new();
        fields.insert("updated_at".to_owned(), json!(0));

        let refused = apply(&conn, id, &[Op::Deck { fields }]).unwrap_err();

        assert!(refused.contains("updated_at"), "{refused}");
    }

    /// The cursor is the newest step still applied, and it is per deck — two decks edited in
    /// one sitting must not undo into each other.
    #[test]
    fn the_cursor_is_the_newest_applied_step_of_that_deck() {
        let conn = seeded();
        let burn = deck(&conn, "Burn");
        let angels = deck(&conn, "Angels");
        let step = Step::new(vec![], vec![]);
        let audit = |deck_id: i64| -> i64 {
            crate::deck_audit::record(
                &conn,
                deck_id,
                "live",
                crate::deck_audit::ADD,
                None,
                &json!({}),
                0,
            )
            .unwrap();
            conn.last_insert_rowid()
        };

        let first = audit(burn);
        record_step(&conn, first, burn, &step).unwrap();
        let second = audit(burn);
        record_step(&conn, second, burn, &step).unwrap();
        let other = audit(angels);
        record_step(&conn, other, angels, &step).unwrap();

        assert_eq!(next_undo(&conn, burn).unwrap(), Some(second));
        assert_eq!(next_undo(&conn, angels).unwrap(), Some(other));

        conn.execute(
            "UPDATE deck_undo SET undone_at = unixepoch() WHERE audit_id = ?1",
            params![second],
        )
        .unwrap();
        assert_eq!(
            next_undo(&conn, burn).unwrap(),
            Some(first),
            "an undone step is stepped over, not undone twice"
        );
    }

    /// The transaction rule, proven by breaking it — `deck_audit`'s own test one table over.
    /// A step that committed while the change it reverses rolled back would be applied into a
    /// deck that never had it done.
    #[test]
    fn a_recorded_step_that_rolls_back_leaves_no_journal_entry() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        crate::deck_audit::record(
            &conn,
            id,
            "live",
            crate::deck_audit::ADD,
            None,
            &json!({}),
            0,
        )
        .unwrap();
        let audit_id = conn.last_insert_rowid();

        let tx = conn.unchecked_transaction().unwrap();
        record_step(&tx, audit_id, id, &Step::new(vec![], vec![])).unwrap();
        drop(tx);

        assert_eq!(next_undo(&conn, id).unwrap(), None);
    }
}
