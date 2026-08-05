//! Scryfall's id migrations, applied to the user's own rows.
//!
//! The rule the whole module exists to keep, from CLAUDE.md and spec §4.7: **a merge
//! repoints, a delete flags, and nothing here ever removes a row the user created.** A
//! collection tracker that silently drops a card because an upstream database tidied its
//! identifiers has destroyed the only record of something the user paid for.
//!
//! Two halves, and only the first needs the network:
//!
//! * [`apply`] walks `/migrations`, Scryfall's log of the ids it changed *deliberately*.
//!   It is authoritative but incomplete, and it is a growing list that is re-read on every
//!   poll — so `card_migrations` records what has been applied, and that bookkeeping is
//!   the only thing standing between a re-poll and a collection that grows on its own.
//! * [`sweep_orphans`] asks the question the log cannot answer — does this `card_id` still
//!   resolve? — of every user row, after every ingest, for free.
//!
//! The one place a row *is* removed is a fold: two rows that upstream now says are one
//! card become one row with both quantities, so nothing the user recorded is lost. That is
//! the same resolution `collection::add` and `wishlist::add_wish` already apply when a
//! quick-add lands on a grain that is taken.

use crate::scryfall::Migration;
use rusqlite::{params, Connection, OptionalExtension};

/// What one pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileStats {
    pub repointed: usize,
    pub folded: usize,
    pub flagged: usize,
    /// Migrations already applied, or of a strategy this app does not know.
    pub skipped: usize,
}

/// Is there any user data to reconcile at all?
///
/// Scryfall asks applications not to make requests they do not need, and a database with no
/// collection and no wishlist has nothing an id migration could be about.
///
/// A count that cannot be read answers `1`, so an unreadable database is treated as having
/// rows: skipping the poll on a failed `count(*)` would make a broken read look like an
/// empty collection and quietly stop reconciling forever.
pub fn user_data_is_empty(conn: &Connection) -> bool {
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(1);
    count("SELECT count(*) FROM collection_entries") == 0
        && count("SELECT count(*) FROM wishlist_entries") == 0
}

/// Apply every migration this database has not already applied.
///
/// One transaction for the whole pass: half-applied merges would leave rows pointing at
/// ids that no longer describe what they own.
pub fn apply(conn: &mut Connection, migrations: &[Migration]) -> rusqlite::Result<ReconcileStats> {
    let mut stats = ReconcileStats::default();
    let tx = conn.transaction()?;
    for m in migrations {
        let already: bool = tx
            .query_row(
                "SELECT 1 FROM card_migrations WHERE id = ?1",
                params![m.id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        // Re-polling the log is normal — it is a growing list, not a queue. Applying a
        // *fold* twice would double a quantity, so "have I seen this?" is the only thing
        // standing between a re-poll and a collection that grows on its own.
        if already {
            stats.skipped += 1;
            continue;
        }
        match (m.strategy.as_str(), m.new_card_id.as_deref()) {
            // A blank id is no id (the same rule `wishlist::add_wish` applies to what a
            // form sends): repointing a row at `''` would orphan it permanently and put
            // every other blank-id row on the same grain.
            ("merge", Some(new_id)) if !new_id.trim().is_empty() => {
                merge(&tx, m, new_id.trim(), &mut stats)?
            }
            ("delete", _) => stats.flagged += flag_deleted(&tx, m)?,
            // A strategy this app has never heard of, or a merge with nowhere to merge to.
            // Recorded as applied all the same: guessing at it later would be no better
            // informed than guessing at it now.
            _ => stats.skipped += 1,
        }
        tx.execute(
            "INSERT OR IGNORE INTO card_migrations
                (id, performed_at, strategy, old_card_id, new_card_id, note, applied_at)
             VALUES (?1,?2,?3,?4,?5,?6, unixepoch())",
            params![
                m.id,
                m.performed_at,
                // The CHECK on the table only knows two strategies, and an unknown one must
                // not fail the pass — it is stored as what it did, which is nothing.
                if m.strategy == "delete" {
                    "delete"
                } else {
                    "merge"
                },
                m.old_card_id,
                m.new_card_id,
                m.note
            ],
        )?;
    }
    tx.commit()?;
    Ok(stats)
}

/// Repoint every row on `old_card_id`, folding any that collide with a row already at the
/// new id.
fn merge(
    tx: &rusqlite::Transaction<'_>,
    m: &Migration,
    new_id: &str,
    stats: &mut ReconcileStats,
) -> rusqlite::Result<()> {
    // The printing as the *new* card describes it. `None` when that card has not arrived in
    // a bulk file yet, which is a real state: the migration log is published before the
    // next bulk rotation carries the card.
    let printing: Option<(String, String, String)> = tx
        .query_row(
            "SELECT set_code, collector_number, lang FROM cards WHERE id = ?1",
            params![new_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let note = match &printing {
        Some(_) => None,
        None => Some(format!(
            "Scryfall merged this printing into {new_id}, which is not in the card database \
             yet. It should arrive with the next card-data sync."
        )),
    };
    let (set_code, collector_number, lang) = match &printing {
        Some((s, c, l)) => (Some(s.as_str()), Some(c.as_str()), Some(l.as_str())),
        None => (None, None, None),
    };

    let ids: Vec<i64> = tx
        .prepare("SELECT id FROM collection_entries WHERE card_id = ?1")?
        .query_map(params![m.old_card_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in ids {
        let repointed = tx.execute(
            "UPDATE OR IGNORE collection_entries
                SET card_id = ?2,
                    set_code = coalesce(?3, set_code),
                    collector_number = coalesce(?4, collector_number),
                    lang = coalesce(?5, lang),
                    needs_review = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![id, new_id, set_code, collector_number, lang, note],
        )?;
        if repointed == 1 {
            stats.repointed += 1;
            continue;
        }
        // `OR IGNORE` swallowed a unique-constraint violation, which can only mean the
        // collection already holds this exact grain at the new id. Two rows for what
        // upstream now says is one card is one row with both quantities.
        if fold_into_existing(tx, id, new_id, lang)? {
            stats.folded += 1;
        } else {
            stats.flagged += flag_unfoldable(tx, "collection_entries", id, new_id)?;
        }
    }

    let wishes: Vec<i64> = tx
        .prepare("SELECT id FROM wishlist_entries WHERE card_id = ?1")?
        .query_map(params![m.old_card_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in wishes {
        let moved = tx.execute(
            "UPDATE OR IGNORE wishlist_entries
                SET card_id = ?2,
                    set_code = coalesce(?3, set_code),
                    collector_number = coalesce(?4, collector_number),
                    lang = coalesce(?5, lang),
                    needs_review = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![id, new_id, set_code, collector_number, lang, note],
        )?;
        if moved == 1 {
            stats.repointed += 1;
        } else if fold_wish_into_existing(tx, id, new_id)? {
            stats.folded += 1;
        } else {
            stats.flagged += flag_unfoldable(tx, "wishlist_entries", id, new_id)?;
        }
    }
    Ok(())
}

/// The row a repointed collection entry would collide with, if there is one.
///
/// The grain is spelled out here rather than shared with `schema::COLLECTION_GRAIN`: that
/// constant is a list of *expressions over one row*, and this needs the same list compared
/// *between two rows*.
///
/// `new_lang` is what makes this the grain of the row **after** the repoint rather than
/// before it. The update rewrites `lang` from the new printing, so a source row in one
/// language colliding with a target in another is matched on the target's language, not the
/// source's — compare `s.lang` and the target is missed, which is the difference between
/// folding a row and (before the guard in [`fold_into_existing`]) losing it.
fn collision_target(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
    new_lang: Option<&str>,
) -> rusqlite::Result<Option<i64>> {
    tx.query_row(
        "SELECT t.id FROM collection_entries t, collection_entries s
          WHERE s.id = ?1 AND t.id <> s.id AND t.card_id = ?2
            AND t.finish = s.finish AND t.condition = s.condition
            AND t.lang = coalesce(?3, s.lang)
            AND t.altered = s.altered AND t.signed = s.signed AND t.proxy = s.proxy
            AND t.misprint = s.misprint
            AND coalesce(t.serial_number,'') = coalesce(s.serial_number,'')
            AND coalesce(t.grading,'') = coalesce(s.grading,'')",
        params![source, new_id, new_lang],
        |r| r.get(0),
    )
    .optional()
}

/// Add a row's quantities to the row that blocked its repointing, then delete it. `false`
/// when no such row could be found.
///
/// The delete is *conditional on the fold having happened*, and that is the load-bearing
/// part: an unconditional delete here is a user row destroyed with its quantity, which is
/// exactly what this module exists not to do. The caller flags instead.
fn fold_into_existing(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
    new_lang: Option<&str>,
) -> rusqlite::Result<bool> {
    let Some(target) = collision_target(tx, source, new_id, new_lang)? else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE collection_entries SET
            quantity = quantity + (SELECT quantity FROM collection_entries WHERE id = ?2),
            tradelist_quantity = tradelist_quantity
                + (SELECT tradelist_quantity FROM collection_entries WHERE id = ?2),
            updated_at = unixepoch()
          WHERE id = ?1",
        params![target, source],
    )?;
    tx.execute(
        "DELETE FROM collection_entries WHERE id = ?1",
        params![source],
    )?;
    Ok(true)
}

/// The wishlist's fold. Same shape, the wishlist's own grain, and the same rule: the
/// quantity moves before the row does.
///
/// A wish *does* have a quantity — "three copies wanted" — so dropping the duplicate
/// outright would quietly shrink a shopping list. Summing is what [`crate::wishlist`]'s own
/// `ON CONFLICT` already does when a quick-add lands on a taken grain, and notes are kept
/// the same way it keeps them: the survivor's, falling back to the folded row's.
fn fold_wish_into_existing(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
) -> rusqlite::Result<bool> {
    let target: Option<i64> = tx
        .query_row(
            "SELECT t.id FROM wishlist_entries t, wishlist_entries s
              WHERE s.id = ?1 AND t.id <> s.id
                AND coalesce(t.oracle_id,'') = coalesce(s.oracle_id,'')
                AND coalesce(t.card_id,'') = ?2
                AND coalesce(t.preferred_finish,'') = coalesce(s.preferred_finish,'')",
            params![source, new_id],
            |r| r.get(0),
        )
        .optional()?;
    let Some(target) = target else {
        return Ok(false);
    };
    tx.execute(
        "UPDATE wishlist_entries SET
            quantity = quantity + (SELECT quantity FROM wishlist_entries WHERE id = ?2),
            notes = coalesce(notes, (SELECT notes FROM wishlist_entries WHERE id = ?2)),
            updated_at = unixepoch()
          WHERE id = ?1",
        params![target, source],
    )?;
    tx.execute(
        "DELETE FROM wishlist_entries WHERE id = ?1",
        params![source],
    )?;
    Ok(true)
}

/// A row that could neither be repointed nor folded. Defensive: [`collision_target`] and
/// its wishlist twin describe the grains the repoint would violate exactly, so there should
/// always be a row to fold into. If one is ever missed, the row stays where it is and says
/// so — it is never the row that gets thrown away to resolve the disagreement.
fn flag_unfoldable(
    tx: &rusqlite::Transaction<'_>,
    table: &str,
    id: i64,
    new_id: &str,
) -> rusqlite::Result<usize> {
    tx.execute(
        &format!("UPDATE {table} SET needs_review = ?2, updated_at = unixepoch() WHERE id = ?1"),
        params![
            id,
            format!(
                "Scryfall merged this printing into {new_id}, but this entry could not be \
                 moved there. It is unchanged — check it against your other entries for \
                 that card."
            )
        ],
    )
}

/// Flag every row that referred to a discarded id. Returns how many were flagged.
fn flag_deleted(tx: &rusqlite::Transaction<'_>, m: &Migration) -> rusqlite::Result<usize> {
    let when = m.performed_at.as_deref().unwrap_or("an earlier date");
    let note = format!(
        "Scryfall removed this printing from its database on {when}. \
         Your copies are still recorded — check the printing and re-add it if you can \
         identify it, or remove this entry."
    );
    let mut flagged = 0;
    for table in ["collection_entries", "wishlist_entries"] {
        flagged += tx.execute(
            &format!(
                "UPDATE {table} SET needs_review = ?2, updated_at = unixepoch()
                  WHERE card_id = ?1 AND needs_review IS NULL"
            ),
            params![m.old_card_id, note],
        )?;
    }
    Ok(flagged)
}

/// Flag every row whose `card_id` no longer resolves, and clear every flag whose card is
/// back. Returns `(flagged, cleared)`.
///
/// Run after every ingest. `/migrations` explains the ids Scryfall changed *deliberately*;
/// this asks the only question the user cares about — can this row still be shown? — and
/// it needs no network at all.
pub fn sweep_orphans(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    const MISSING: &str =
        "This printing is not in the card database. It may have been removed by the last \
         card-data sync, or it may return with the next one.";
    let mut flagged = 0;
    let mut cleared = 0;
    for table in ["collection_entries", "wishlist_entries"] {
        // `card_id IS NOT NULL` is not redundant on the wishlist: a wish for *any*
        // printing carries no card id at all (spec §6), and it resolves to whatever
        // printing the list joins to — it is not an orphan and must never be flagged as one.
        flagged += conn.execute(
            &format!(
                "UPDATE {table} SET needs_review = ?1, updated_at = unixepoch()
                  WHERE needs_review IS NULL AND card_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM cards WHERE cards.id = {table}.card_id)"
            ),
            params![MISSING],
        )?;
        // The other direction, and the reason a flag is a sentence rather than a boolean: a
        // printing that comes back — a bad bulk file, a re-added card — clears its own
        // flag, so a transient gap does not leave a permanent scar on the row.
        cleared += conn.execute(
            &format!(
                "UPDATE {table} SET needs_review = NULL, updated_at = unixepoch()
                  WHERE needs_review IS NOT NULL AND card_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM cards WHERE cards.id = {table}.card_id)"
            ),
            [],
        )?;
    }
    Ok((flagged, cleared))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn migration(id: &str, strategy: &str, old: &str, new: Option<&str>) -> Migration {
        Migration {
            id: id.to_owned(),
            performed_at: Some("2026-07-01T00:00:00Z".to_owned()),
            strategy: strategy.to_owned(),
            old_card_id: old.to_owned(),
            new_card_id: new.map(str::to_owned),
            note: None,
        }
    }

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn own(conn: &Connection, card_id: &str, finish: &str, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES (?1,'lea','161','en',?2,'NM',?3,unixepoch(),unixepoch()) RETURNING id",
            rusqlite::params![card_id, finish, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A merge repoints the row *and* refreshes the printing denormalised beside it — the
    /// card the user owns is now known by a different id and, usually, a different set and
    /// number, and leaving the old ones would make the row describe a printing that no
    /// longer exists.
    #[test]
    fn a_merge_repoints_the_row_and_refreshes_its_printing() {
        let mut conn = seeded();
        let id = own(&conn, "old-id", "foil", 3);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!(stats.repointed, 1);
        let (card, set, cn, review): (String, String, String, Option<String>) = conn
            .query_row(
                "SELECT card_id, set_code, collector_number, needs_review
                 FROM collection_entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!(
            (card.as_str(), set.as_str(), cn.as_str()),
            ("new-id", "2ed", "162")
        );
        assert_eq!(review, None, "a repointed row needs no review");
    }

    /// The case a naive `UPDATE` gets wrong: the user already owns the printing the merge
    /// points at, at the same grain. Repointing would be a unique-constraint violation, so
    /// the two rows become one and the quantities add — a merge upstream is one card, not
    /// two.
    #[test]
    fn a_merge_onto_a_row_that_already_exists_folds_the_two_together() {
        let mut conn = seeded();
        let old = own(&conn, "old-id", "foil", 3);
        let existing = own(&conn, "new-id", "foil", 2);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded), (0, 1));
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE id = ?1",
                [existing],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 5, "three plus two, in the row that survived");
        let gone: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE id = ?1",
                [old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0, "and the folded row is gone, not duplicated");
    }

    /// The promise CLAUDE.md makes: a delete **flags**. The user paid for that card; a
    /// tracker that quietly removes it because an upstream database tidied its ids has
    /// destroyed the only record of it.
    #[test]
    fn a_delete_flags_the_row_and_never_removes_it() {
        let mut conn = seeded();
        let id = own(&conn, "gone-id", "nonfoil", 1);
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o9','gone-id','Vanished',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let stats = apply(&mut conn, &[migration("m2", "delete", "gone-id", None)]).unwrap();

        assert_eq!(stats.flagged, 2, "both tables");
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let review = review.expect("the row must be flagged");
        assert!(review.contains("2026-07-01"), "{review}");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "flagged, never deleted");
    }

    /// `/migrations` is a growing log that is re-read on every poll. Applying a merge twice
    /// would be harmless; applying a *fold* twice would double a quantity. The applied set
    /// is recorded, and this is what keeps the second poll a no-op.
    #[test]
    fn a_migration_that_has_already_been_applied_is_skipped() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 3);
        let m = [migration("m1", "merge", "old-id", Some("new-id"))];

        let first = apply(&mut conn, &m).unwrap();
        let second = apply(&mut conn, &m).unwrap();

        assert_eq!(first.repointed, 1);
        assert_eq!((second.repointed, second.folded, second.skipped), (0, 0, 1));
        let quantity: i64 = conn
            .query_row("SELECT sum(quantity) FROM collection_entries", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            quantity, 3,
            "a re-poll must not add cards to the collection"
        );
    }

    /// A merge into an id this database has never seen — Scryfall moved a card to a
    /// printing that arrives in a later bulk file. The row is repointed anyway (the id is
    /// the truth) but flagged, because until that card lands the row cannot be priced or
    /// pictured and the user should know why.
    #[test]
    fn a_merge_into_an_unknown_card_is_repointed_and_flagged() {
        let mut conn = seeded();
        let id = own(&conn, "old-id", "foil", 1);

        apply(
            &mut conn,
            &[migration("m3", "merge", "old-id", Some("not-here-yet"))],
        )
        .unwrap();

        let (card, review): (String, Option<String>) = conn
            .query_row(
                "SELECT card_id, needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(card, "not-here-yet");
        assert!(
            review.is_some(),
            "the user should know the card is not here"
        );
    }

    /// The half that does not need Scryfall's log at all: after every ingest, a row whose
    /// `card_id` no longer resolves is flagged, and one that resolves again is cleared.
    /// The second direction matters — a printing can come back (a bad bulk file, a
    /// re-added card), and a flag nobody can clear is a permanent scar.
    #[test]
    fn the_orphan_sweep_flags_what_vanished_and_clears_what_came_back() {
        let conn = seeded();
        let id = own(&conn, "new-id", "foil", 1);

        assert_eq!(
            sweep_orphans(&conn).unwrap(),
            (0, 0),
            "nothing is wrong yet"
        );

        conn.execute("DELETE FROM cards WHERE id = 'new-id'", [])
            .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap().0, 1);
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(review.unwrap().contains("card database"));

        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 1), "and it clears again");
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(review, None);
    }

    /// Scryfall asks applications not to make requests they do not need. A user with no
    /// rows has nothing to reconcile, so the poll does not happen at all.
    #[test]
    fn a_database_with_no_user_rows_is_not_worth_a_request() {
        let conn = seeded();
        assert!(user_data_is_empty(&conn));
        own(&conn, "new-id", "foil", 1);
        assert!(!user_data_is_empty(&conn));
    }

    /// An any-printing wish (spec §6) has no `card_id` at all, so there is no id to
    /// migrate and nothing to orphan. It must survive both halves untouched — a wishlist
    /// that flags every open wish as "not in the card database" has flagged the whole list.
    #[test]
    fn a_wish_for_any_printing_is_neither_repointed_nor_orphaned() {
        let mut conn = seeded();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o1',NULL,'Lightning Bolt',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        apply(
            &mut conn,
            &[
                migration("m1", "merge", "old-id", Some("new-id")),
                migration("m2", "delete", "gone-id", None),
            ],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 0));

        let (card_id, review): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT card_id, needs_review FROM wishlist_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(card_id, None, "an open wish is not pinned by a migration");
        assert_eq!(review, None);
    }

    /// The wishlist's own grain collision. A wish *has* a quantity — "three copies
    /// wanted" — so a duplicate produced by a repoint folds its quantity into the survivor
    /// exactly as `wishlist::add_wish` does. Dropping the row outright would shrink a
    /// shopping list the user never edited.
    #[test]
    fn a_merged_wish_folds_its_quantity_into_the_wish_already_there() {
        let mut conn = seeded();
        let wish = |card_id: &str, quantity: i64, notes: Option<&str>| -> i64 {
            conn.query_row(
                "INSERT INTO wishlist_entries
                    (oracle_id,card_id,name,quantity,preferred_finish,notes,created_at,updated_at)
                 VALUES ('o1',?1,'Lightning Bolt',?2,'foil',?3,unixepoch(),unixepoch())
                 RETURNING id",
                rusqlite::params![card_id, quantity, notes],
                |r| r.get(0),
            )
            .unwrap()
        };
        let old = wish("old-id", 3, Some("from the trade binder"));
        let target = wish("new-id", 2, None);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded), (0, 1));
        let (quantity, notes): (i64, Option<String>) = conn
            .query_row(
                "SELECT quantity, notes FROM wishlist_entries WHERE id = ?1",
                [target],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(quantity, 5, "three wanted plus two, not two");
        assert_eq!(
            notes.as_deref(),
            Some("from the trade binder"),
            "the folded row's note is kept when the survivor has none"
        );
        let rows: i64 = conn
            .query_row(
                "SELECT count(*) FROM wishlist_entries WHERE id = ?1",
                [old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// The repoint rewrites `lang` from the new printing, so the row it collides with is
    /// the one at the *new* language — matching on the source row's own language finds
    /// nothing, and "found nothing" used to mean the source row was deleted with its
    /// quantity. Three Japanese copies folding into an English row is odd; three copies
    /// vanishing is unacceptable.
    #[test]
    fn a_fold_across_languages_finds_the_row_the_repoint_would_have_collided_with() {
        let mut conn = seeded();
        let old: i64 = conn
            .query_row(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     created_at,updated_at)
                 VALUES ('old-id','lea','161','ja','foil','NM',3,unixepoch(),unixepoch())
                 RETURNING id",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let target = own(&conn, "new-id", "foil", 2);

        let stats = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        )
        .unwrap();

        assert_eq!((stats.repointed, stats.folded), (0, 1));
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE id = ?1",
                [target],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 5, "the copies moved, they did not evaporate");
        let total: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, 1);
        assert_eq!(
            conn.query_row(
                "SELECT count(*) FROM collection_entries WHERE id = ?1",
                [old],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
    }

    /// The guard that makes "never delete a user row" a property of the code rather than
    /// of the query being right: with no row to fold into, the fold reports failure and
    /// **leaves the source alone**. An unconditional delete here would be a quantity
    /// destroyed every time the grain comparison missed a term.
    #[test]
    fn a_fold_with_nowhere_to_fold_to_deletes_nothing() {
        let mut conn = seeded();
        let lonely = own(&conn, "old-id", "foil", 3);
        let tx = conn.transaction().unwrap();

        assert!(!fold_into_existing(&tx, lonely, "nobody-here", Some("en")).unwrap());

        let (rows, quantity): (i64, i64) = tx
            .query_row(
                "SELECT count(*), coalesce(sum(quantity),0) FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((rows, quantity), (1, 3));
    }

    /// Every applied migration is written down, because the bookkeeping *is* the
    /// idempotency. A strategy this app does not know is recorded too — it did nothing,
    /// and looking at it again tomorrow would be no better informed.
    #[test]
    fn every_migration_considered_is_written_down_including_the_ones_it_could_not_act_on() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 1);

        let stats = apply(
            &mut conn,
            &[
                migration("m1", "merge", "old-id", Some("new-id")),
                migration("m2", "delete", "gone-id", None),
                migration("m3", "sideways", "odd-id", Some("new-id")),
                // A merge with a blank destination is a merge to nowhere: repointing a row
                // at `''` orphans it permanently.
                migration("m4", "merge", "old-id", Some("  ")),
            ],
        )
        .unwrap();

        assert_eq!(stats.skipped, 2, "the unknown strategy and the blank id");
        let recorded: Vec<(String, String)> = conn
            .prepare("SELECT id, strategy FROM card_migrations ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(
            recorded,
            vec![
                ("m1".to_owned(), "merge".to_owned()),
                ("m2".to_owned(), "delete".to_owned()),
                // Stored as `merge` because the table's CHECK knows two strategies, and an
                // unknown one must not fail the pass.
                ("m3".to_owned(), "merge".to_owned()),
                ("m4".to_owned(), "merge".to_owned()),
            ]
        );
        // ...and the blank-id merge left the row where the real one had put it.
        let card: String = conn
            .query_row("SELECT card_id FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(card, "new-id");
    }

    /// One transaction for the whole pass. A merge that failed halfway would leave some
    /// rows repointed, some not, and a `card_migrations` table claiming the lot was
    /// applied — so the next poll would never revisit them.
    #[test]
    fn a_pass_that_fails_leaves_neither_the_rows_nor_the_bookkeeping_behind() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 3);
        // The bookkeeping insert is what fails: a row that is already there is fine
        // (`INSERT OR IGNORE`), so the table is dropped instead — nothing in the pass can
        // then be recorded, and the whole transaction has to roll back.
        conn.execute("DROP TABLE card_migrations", []).unwrap();

        let err = apply(
            &mut conn,
            &[migration("m1", "merge", "old-id", Some("new-id"))],
        );

        assert!(err.is_err(), "a pass that cannot record itself must fail");
        let card: String = conn
            .query_row("SELECT card_id FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(card, "old-id", "the repoint rolled back with the pass");
    }
}
