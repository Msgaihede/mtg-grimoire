//! Scan history — every pile the scanner's tray put away, kept so a reader can go back and see
//! what they scanned. User schema v64,
//! [issue #989](https://github.com/Msgaihede/mtg-grimoire/issues/989).
//!
//! [`crate::trade`]'s file shape: pure functions over a [`Connection`] and nothing of a window.
//! The wrappers are the desktop host's (`apps/desktop/src-tauri/src/scan_history/mod.rs`) and the
//! table's (`crate::commands`).
//!
//! # A batch is one press, and it is written by the press
//!
//! The tray empties in two ways that keep its cards, and each records **one batch** — the rows
//! that press took, folded to one line per printing and finish:
//!
//! * **Add to collection** ([`crate::scanner::tray_commit`]) records a [`FILED`] batch **inside the
//!   import's own transaction**, beside the tray that is left — so the history can never name a
//!   pile the collection does not hold, nor miss one it does.
//! * **Archive** ([`crate::scanner::tray_archive`]) records an [`ARCHIVED`] batch and stores what
//!   is left of the tray, in one savepoint, and touches the collection not at all: the trade
//!   page's *Archive puts one away without touching the collection*, for a pile the reader wants
//!   a record of and does not own — a friend's binder, a store's case, a box they are pricing.
//!
//! **Nothing else writes a batch.** *Clear all…* files nothing and keeps nothing; a scan onto a
//! trade's side is the trade's own record (`trade_lines.source = 'scan'`).
//!
//! # A batch is a record, not a tray
//!
//! Its lines cannot be edited. The two writes are the name ([`rename_batch`]) and the whole
//! batch ([`delete_batch`]) — deleting one takes nothing out of the collection, because the
//! history describes the collection's past and owns none of its rows.
//!
//! **A line remembers the printing in the terms printed on it**, read from `cards` when the batch
//! is written — `trade_lines`' insurance, so a batch from last year still says what was scanned
//! when a sync has dropped the printing it names.
//!
//! # Neither table syncs
//!
//! A batch describes what was in front of one device's camera. The collection rows an Add files
//! are captured by `collection_entries`' own triggers, as any other write to it is.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

use crate::collection::CollectionImportItem;
use crate::schema::FINISHES;

/// What a batch is: the two presses that record one.
pub const STATUSES: [&str; 2] = ["filed", "archived"];
/// `STATUSES[0]` — Add to collection: the lines were filed into the collection.
pub const FILED: &str = STATUSES[0];
/// `STATUSES[1]` — Archive: the lines were kept here and filed nowhere.
pub const ARCHIVED: &str = STATUSES[1];

/// A batch that was deleted, or never existed. The page's read answers `None` for one instead.
pub const GONE: &str = "that scan is not in your history any more";
/// [`record_batch`] over no lines. The page never sends one — a press with nothing left to put
/// away answers before it writes — so this is a caller's mistake, said in words.
pub const NOTHING_TO_KEEP: &str = "there are no scanned cards to keep";
/// A line naming a printing `cards` does not hold. An Add has already refused it by then, in the
/// import's own words; this is Archive's.
pub const NO_SUCH_CARD: &str = "no card with that id is in the card database";
/// A line for fewer than one copy.
pub const NO_COPIES: &str = "a scanned card needs a quantity of at least one";
/// A finish that is not one of the collection's three. A tray row whose finish was never
/// decided is not put away by either press, so this too is a caller's mistake.
pub const UNKNOWN_FINISH: &str = "a scanned card needs a finish before it can be kept";

/// One line of a batch: a printing in a finish, and how many were put away.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatchLine {
    pub id: i64,
    pub card_id: String,
    /// `None` when the printing has left `cards`.
    pub oracle_id: Option<String>,
    /// The card's name as `cards` has it, or as the line remembered it when the printing has
    /// left the database — and the same for `set_code` and `collector_number`.
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub layout: Option<String>,
    pub finish: String,
    pub quantity: i64,
}

/// One batch in the list: who it is, what put it away, and how much of it there is.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatchSummary {
    pub id: i64,
    pub name: String,
    /// [`FILED`] or [`ARCHIVED`].
    pub status: String,
    /// Where an Add filed it — `None` for the collection's root, and always for an archive.
    pub folder_id: Option<i64>,
    /// The folder's name when the batch was written, so a batch still says where its cards went
    /// after the folder is renamed or deleted. `None` for the root and for an archive.
    pub folder_name: Option<String>,
    /// The one condition the press filed at (the tray's Defaults popover), as the import's
    /// lines carried it. `None` when the lines carried none.
    pub condition: Option<String>,
    /// How many lines the batch has — printings in a finish.
    pub line_count: i64,
    /// How many copies, every line's quantity added.
    pub copies: i64,
    /// The first line's printing, for a picture beside the row. `None` for a batch with no
    /// lines, which only a hand-edited database holds.
    pub cover_card_id: Option<String>,
    pub created_at: i64,
}

/// A whole batch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatch {
    /// The list's row for it, so the two cannot describe one batch two ways.
    pub summary: ScanBatchSummary,
    /// In the order the tray held them — newest scanned first.
    pub lines: Vec<ScanBatchLine>,
}

/// The printing a line names, as it is printed on the card.
struct Printing {
    name: String,
    set_code: String,
    collector_number: String,
}

fn printing(conn: &Connection, card_id: &str) -> Result<Option<Printing>, String> {
    conn.query_row(
        "SELECT name, set_code, collector_number FROM cards WHERE id = ?1",
        params![card_id],
        |r| {
            Ok(Printing {
                name: r.get(0)?,
                set_code: r.get(1)?,
                collector_number: r.get(2)?,
            })
        },
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The folder's name when it is a folder at all. A deck's group is named by its deck elsewhere;
/// here it is whatever the row says, which is the name the folder picker drew.
fn folder_name(conn: &Connection, folder_id: Option<i64>) -> Result<Option<String>, String> {
    let Some(id) = folder_id else {
        return Ok(None);
    };
    conn.query_row(
        "SELECT name FROM collection_folders WHERE id = ?1",
        params![id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The press's lines folded to the history's grain — one per printing and finish, in the order
/// each first appears — and checked. Every refusal is made here, before anything is written.
fn folded(items: &[CollectionImportItem]) -> Result<Vec<(&str, &'static str, i64)>, String> {
    if items.is_empty() {
        return Err(NOTHING_TO_KEEP.to_owned());
    }
    let mut lines: Vec<(&str, &'static str, i64)> = Vec::new();
    for item in items {
        if item.quantity < 1 {
            return Err(NO_COPIES.to_owned());
        }
        let finish = FINISHES
            .into_iter()
            .find(|f| *f == item.finish)
            .ok_or_else(|| UNKNOWN_FINISH.to_owned())?;
        match lines
            .iter_mut()
            .find(|(card, f, _)| *card == item.card_id && *f == finish)
        {
            Some(line) => line.2 = line.2.saturating_add(item.quantity),
            None => lines.push((item.card_id.as_str(), finish, item.quantity)),
        }
    }
    Ok(lines)
}

/// Write one batch for a press's lines and answer its id.
///
/// `status` is [`FILED`] or [`ARCHIVED`]; `folder_id` is where an Add filed the lines and is
/// written only for one. The batch is named `Scan N`, N its own id — a trade's `Trade N` rule —
/// and the condition is the first line's, since a press files at one.
///
/// **Inside the caller's transaction, never one of its own**: an Add calls this from
/// `commit_import_with`'s closure, so the batch commits with the import or not at all. A savepoint
/// is still taken, so a refusal half-way leaves no header without its lines on a connection that
/// is in autocommit.
pub fn record_batch(
    conn: &Connection,
    items: &[CollectionImportItem],
    status: &str,
    folder_id: Option<i64>,
) -> Result<i64, String> {
    let status = STATUSES
        .into_iter()
        .find(|s| *s == status)
        .ok_or_else(|| format!("a scan is either filed or archived, not {status:?}"))?;
    let lines = folded(items)?;
    let mut printings = Vec::with_capacity(lines.len());
    for (card_id, _, _) in &lines {
        printings.push(printing(conn, card_id)?.ok_or_else(|| NO_SUCH_CARD.to_owned())?);
    }
    let folder_id = if status == FILED { folder_id } else { None };
    let folder = folder_name(conn, folder_id)?;
    let condition = items
        .first()
        .and_then(|item| crate::filters::nonblank(&item.condition))
        .map(str::to_owned);
    crate::db::in_savepoint(conn, "scan_batch_record", || {
        let id: i64 = conn
            .query_row(
                "INSERT INTO scan_batches (name, status, folder_id, folder_name, condition, created_at)
                 VALUES ('', ?1, ?2, ?3, ?4, unixepoch()) RETURNING id",
                params![status, folder_id, folder, condition],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE scan_batches SET name = 'Scan ' || id WHERE id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        let mut insert = conn
            .prepare_cached(
                "INSERT INTO scan_batch_lines
                     (batch_id, card_id, name, set_code, collector_number, finish, quantity, position)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| e.to_string())?;
        for (position, ((card_id, finish, quantity), printed)) in
            lines.iter().zip(&printings).enumerate()
        {
            insert
                .execute(params![
                    id,
                    card_id,
                    printed.name,
                    printed.set_code,
                    printed.collector_number,
                    finish,
                    quantity,
                    position as i64,
                ])
                .map_err(|e| e.to_string())?;
        }
        Ok(id)
    })
}

/// The header columns and the two sums, in [`summary_of`]'s order.
const SUMMARY_SQL: &str = "SELECT b.id, b.name, b.status, b.folder_id, b.folder_name, b.condition,
            (SELECT count(*) FROM scan_batch_lines l WHERE l.batch_id = b.id),
            (SELECT coalesce(sum(l.quantity), 0) FROM scan_batch_lines l WHERE l.batch_id = b.id),
            (SELECT l.card_id FROM scan_batch_lines l WHERE l.batch_id = b.id
              ORDER BY l.position, l.id LIMIT 1),
            b.created_at
       FROM scan_batches b";

fn summary_of(r: &rusqlite::Row<'_>) -> rusqlite::Result<ScanBatchSummary> {
    Ok(ScanBatchSummary {
        id: r.get(0)?,
        name: r.get(1)?,
        status: r.get(2)?,
        folder_id: r.get(3)?,
        folder_name: r.get(4)?,
        condition: r.get(5)?,
        line_count: r.get(6)?,
        copies: r.get(7)?,
        cover_card_id: r.get(8)?,
        created_at: r.get(9)?,
    })
}

/// Every batch, newest first.
pub fn list_batches(conn: &Connection) -> Result<Vec<ScanBatchSummary>, String> {
    let mut stmt = conn
        .prepare_cached(&format!(
            "{SUMMARY_SQL} ORDER BY b.created_at DESC, b.id DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], summary_of).map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One batch with its lines, or `None` when it is gone.
///
/// A line's printing is read from `cards` where it still resolves, and from what the line
/// remembered where it does not.
pub fn get_batch(conn: &Connection, id: i64) -> Result<Option<ScanBatch>, String> {
    let summary = conn
        .query_row(
            &format!("{SUMMARY_SQL} WHERE b.id = ?1"),
            params![id],
            summary_of,
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(summary) = summary else {
        return Ok(None);
    };
    let mut stmt = conn
        .prepare_cached(
            "SELECT l.id, l.card_id, c.oracle_id, coalesce(c.name, l.name),
                    coalesce(c.set_code, l.set_code), c.set_name,
                    coalesce(c.collector_number, l.collector_number), c.rarity, c.layout,
                    l.finish, l.quantity
               FROM scan_batch_lines l
               LEFT JOIN cards c ON c.id = l.card_id
              WHERE l.batch_id = ?1
              ORDER BY l.position, l.id",
        )
        .map_err(|e| e.to_string())?;
    let lines = stmt
        .query_map(params![id], |r| {
            Ok(ScanBatchLine {
                id: r.get(0)?,
                card_id: r.get(1)?,
                oracle_id: r.get(2)?,
                name: r.get(3)?,
                set_code: r.get(4)?,
                set_name: r.get(5)?,
                collector_number: r.get(6)?,
                rarity: r.get(7)?,
                layout: r.get(8)?,
                finish: r.get(9)?,
                quantity: r.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(Some(ScanBatch { summary, lines }))
}

/// Rename a batch. A blank name is the one it was made with, `Scan N` — `trade::rename_trade`'s
/// rule: clearing the field is how a reader asks for the default back.
pub fn rename_batch(conn: &Connection, id: i64, name: &str) -> Result<(), String> {
    let name = match name.trim() {
        "" => format!("Scan {id}"),
        named => named.to_owned(),
    };
    let changed = conn
        .execute(
            "UPDATE scan_batches SET name = ?2 WHERE id = ?1",
            params![id, name],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(GONE.to_owned());
    }
    Ok(())
}

/// Delete a batch and its lines. **The collection is not touched**: the history records what was
/// put away, and owns none of the rows an Add filed. A batch already gone is a success, so a
/// second press — or another window's — is not an error.
///
/// **The lines are deleted by name and not left to `ON DELETE CASCADE`**, `trade::delete_trade`'s
/// reason: `foreign_keys` is a per-connection pragma.
pub fn delete_batch(conn: &Connection, id: i64) -> Result<(), String> {
    crate::db::in_savepoint(conn, "scan_batch_delete", || {
        conn.execute(
            "DELETE FROM scan_batch_lines WHERE batch_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM scan_batches WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::fixtures::seed_card;

    fn open() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        seed_card(&conn, "bolt", "lea", "161");
        seed_card(&conn, "goyf", "fut", "153");
        conn.execute(
            "UPDATE cards SET name = 'Tarmogoyf', set_name = 'Future Sight' WHERE id = 'goyf'",
            [],
        )
        .unwrap();
        conn
    }

    fn item(card_id: &str, finish: &str, quantity: i64) -> CollectionImportItem {
        CollectionImportItem {
            card_id: card_id.into(),
            quantity,
            finish: finish.into(),
            condition: Some("NM".into()),
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
            tradelist_quantity: None,
            tags: None,
        }
    }

    fn count(conn: &Connection, table: &str) -> i64 {
        conn.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn a_batch_folds_its_lines_names_itself_and_reads_back_newest_first() {
        let conn = open();
        let first = record_batch(
            &conn,
            &[
                item("bolt", "nonfoil", 2),
                item("goyf", "foil", 1),
                item("bolt", "nonfoil", 1),
                item("bolt", "foil", 1),
            ],
            ARCHIVED,
            Some(99),
        )
        .unwrap();
        let second = record_batch(&conn, &[item("goyf", "nonfoil", 4)], ARCHIVED, None).unwrap();

        let list = list_batches(&conn).unwrap();
        assert_eq!(
            list.iter().map(|b| b.id).collect::<Vec<_>>(),
            vec![second, first],
            "newest first, the id breaking a tie within one second"
        );
        let batch = get_batch(&conn, first).unwrap().unwrap();
        assert_eq!(batch.summary.name, format!("Scan {first}"));
        assert_eq!(batch.summary.status, ARCHIVED);
        assert_eq!(
            batch.summary.folder_id, None,
            "an archive files nowhere, whatever it was handed"
        );
        assert_eq!(batch.summary.condition.as_deref(), Some("NM"));
        assert_eq!((batch.summary.line_count, batch.summary.copies), (3, 5));
        assert_eq!(batch.summary.cover_card_id.as_deref(), Some("bolt"));
        let lines: Vec<_> = batch
            .lines
            .iter()
            .map(|l| (l.card_id.as_str(), l.finish.as_str(), l.quantity))
            .collect();
        assert_eq!(
            lines,
            vec![
                ("bolt", "nonfoil", 3),
                ("goyf", "foil", 1),
                ("bolt", "foil", 1)
            ],
            "one line per printing and finish, in the order each first appeared"
        );
        assert_eq!(batch.lines[1].name, "Tarmogoyf");
        assert_eq!(batch.lines[1].set_name.as_deref(), Some("Future Sight"));
    }

    #[test]
    fn a_filed_batch_remembers_its_folder_by_name() {
        let conn = open();
        conn.execute(
            "INSERT INTO collection_folders (id, name, sort_order, created_at, updated_at)
             VALUES (7, 'Binder', 0, 0, 0)",
            [],
        )
        .unwrap();
        let id = record_batch(&conn, &[item("bolt", "nonfoil", 1)], FILED, Some(7)).unwrap();
        conn.execute("DELETE FROM collection_folders WHERE id = 7", [])
            .unwrap();
        let batch = get_batch(&conn, id).unwrap().unwrap();
        assert_eq!(batch.summary.status, FILED);
        assert_eq!(batch.summary.folder_id, Some(7));
        assert_eq!(
            batch.summary.folder_name.as_deref(),
            Some("Binder"),
            "a deleted folder still names where the cards went"
        );
    }

    #[test]
    fn a_line_still_reads_when_its_printing_has_left_cards() {
        let conn = open();
        let id = record_batch(&conn, &[item("goyf", "nonfoil", 1)], ARCHIVED, None).unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'goyf'", [])
            .unwrap();
        let line = &get_batch(&conn, id).unwrap().unwrap().lines[0];
        assert_eq!(line.name, "Tarmogoyf");
        assert_eq!(
            (line.set_code.as_str(), line.collector_number.as_str()),
            ("fut", "153")
        );
        assert_eq!(line.oracle_id, None);
    }

    #[test]
    fn every_refusal_is_made_before_anything_is_written() {
        let conn = open();
        for (items, sentence) in [
            (vec![], NOTHING_TO_KEEP),
            (vec![item("bolt", "nonfoil", 0)], NO_COPIES),
            (vec![item("bolt", "unknown", 1)], UNKNOWN_FINISH),
            (
                vec![item("bolt", "nonfoil", 1), item("nope", "nonfoil", 1)],
                NO_SUCH_CARD,
            ),
        ] {
            assert_eq!(
                record_batch(&conn, &items, ARCHIVED, None).unwrap_err(),
                sentence
            );
        }
        assert!(record_batch(&conn, &[item("bolt", "nonfoil", 1)], "open", None).is_err());
        assert_eq!(count(&conn, "scan_batches"), 0);
        assert_eq!(count(&conn, "scan_batch_lines"), 0);
    }

    #[test]
    fn rename_and_delete() {
        let conn = open();
        let id = record_batch(&conn, &[item("bolt", "nonfoil", 1)], ARCHIVED, None).unwrap();
        rename_batch(&conn, id, "  Bob's binder ").unwrap();
        assert_eq!(
            get_batch(&conn, id).unwrap().unwrap().summary.name,
            "Bob's binder"
        );
        rename_batch(&conn, id, "   ").unwrap();
        assert_eq!(
            get_batch(&conn, id).unwrap().unwrap().summary.name,
            format!("Scan {id}"),
            "a blank name is the default back"
        );
        assert_eq!(rename_batch(&conn, id + 1, "x").unwrap_err(), GONE);

        delete_batch(&conn, id).unwrap();
        assert_eq!(get_batch(&conn, id).unwrap(), None);
        assert_eq!(count(&conn, "scan_batch_lines"), 0);
        delete_batch(&conn, id).unwrap();
    }
}
