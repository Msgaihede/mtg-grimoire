//! A theory deck's **managed wishlist** — user schema v47,
//! [issue #512](https://github.com/Msgaihede/mtg-grimoire/issues/512).
//!
//! A deck whose kind is `Theory + Actual` and whose `decks.managed_wishlist` is on keeps one
//! wishlist folder, named after the deck, holding exactly what its Compare dialog lists:
//! [`crate::deck_theory::wanted`], which is [`crate::deck_theory::missing_to_wishlist`]'s rows
//! with the folder and the feed line taken off. The folder is the **deck's**, not the reader's:
//! this module is the only thing that writes to it, and every other write is refused in words
//! ([`MANAGED`]).
//!
//! ## Derived per device, never synced
//!
//! The switch syncs — it is the reader's answer about a deck. The folder and its wishes do not:
//! they are a function of `deck_cards`, which syncs, and `src-tauri/CLAUDE.md`'s rule is that a
//! write every device derives for itself must not be captured. Captured, two devices would each
//! insert the same wish under two `sync_uid`s and the grain's upsert would sum them. So every
//! write here runs inside [`crate::sync_engine::capture::suppressed`], and
//! `wishlist_folders.managed_deck_id` is on no capture spec.
//!
//! ## How "whenever the deck changes" is noticed
//!
//! **Per-connection `TEMP` triggers**, installed by [`arm`] on the write connection the first
//! time [`crate::sync::with_write`] hands it out. They mark a deck dirty on any write to its
//! `deck_cards`, to the `decks` columns that decide eligibility or the folder's name, and to a
//! category's switch (an inactive pile counts toward nothing, so it changes the diff). Every
//! user-facing write goes through `with_write` — sync's `run_once` and the web target's routes
//! included — so [`settle`] runs after each one and rewrites only the decks it touched. A sweep
//! of every theory deck after every write would put a diff per deck behind a zoom press.
//!
//! Triggers rather than a call at each deck command because there are dozens of those, in
//! several modules, and a new one would have to remember; a trigger cannot forget.
//!
//! ## The guard
//!
//! The same [`arm`] installs `BEFORE` triggers on `wishlist_entries` and `wishlist_folders` that
//! refuse, with [`MANAGED`], any insert, update or delete touching a managed folder or a wish in
//! one — unless this module is the writer (a row in `temp.managed_wishlist_open`) or sync's
//! apply/reconcile is (`sync_state.applying`, [`crate::sync_engine::capture::APPLYING`]).
//! A backstop behind the frontend, which draws no editing control for a managed row: there are
//! many wishlist writes and one refusal is cheaper than a fence at each. The `UPDATE` guards
//! name their columns (`BEFORE UPDATE OF …`), so bookkeeping — `sync_uid`, `needs_review`,
//! `updated_at` — is never refused.

use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

/// What every refused hand-made write to a managed folder or wish says. The frontend's fake
/// carries the same sentence.
pub const MANAGED: &str = "A managed wishlist follows its deck, so it can't be edited by hand.";

/// The per-connection trigger set. `TEMP`, so it lives exactly as long as the connection and
/// needs no schema rung: nothing about it is stored.
///
/// `IF NOT EXISTS` is safe here, unlike on the persistent capture triggers — a temp trigger
/// cannot outlive the build that created it.
fn arm_sql() -> String {
    let managed = "(SELECT id FROM main.wishlist_folders WHERE managed_deck_id IS NOT NULL)";
    let free = "NOT EXISTS (SELECT 1 FROM temp.managed_wishlist_open)
                AND NOT EXISTS (SELECT 1 FROM main.sync_state WHERE key = 'applying')";
    let refuse = format!("SELECT RAISE(ABORT, '{}');", MANAGED.replace('\'', "''"));
    format!(
        "-- No key, on purpose: a trigger body's conflict clause is overridden by the outer
         -- statement's, so an `INSERT OR IGNORE` fired by `deck::add_card`'s UPSERT fails on a
         -- duplicate. Duplicates are harmless here and `settle` reads DISTINCT.
         CREATE TEMP TABLE IF NOT EXISTS managed_wishlist_dirty (deck_id INTEGER);
         CREATE TEMP TABLE IF NOT EXISTS managed_wishlist_open (x INTEGER);

         CREATE TEMP TRIGGER IF NOT EXISTS mw_card_ins AFTER INSERT ON main.deck_cards BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (NEW.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_card_upd AFTER UPDATE ON main.deck_cards BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (NEW.deck_id);
             INSERT INTO temp.managed_wishlist_dirty VALUES (OLD.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_card_del AFTER DELETE ON main.deck_cards BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (OLD.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_cat_upd
             AFTER UPDATE OF is_active ON main.deck_categories BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (NEW.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_cat_del AFTER DELETE ON main.deck_categories BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (OLD.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_deck_ins AFTER INSERT ON main.decks BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (NEW.id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_deck_upd
             AFTER UPDATE OF name, theory_enabled, virtual_only, managed_wishlist ON main.decks
         BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (NEW.id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_deck_del AFTER DELETE ON main.decks BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (OLD.id);
         END;

         CREATE TEMP TRIGGER IF NOT EXISTS mw_guard_wish_ins
             BEFORE INSERT ON main.wishlist_entries
             WHEN {free} AND NEW.folder_id IN {managed}
         BEGIN {refuse} END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_guard_wish_upd
             BEFORE UPDATE OF oracle_id, card_id, set_code, collector_number, lang, name,
                              quantity, preferred_finish, notes, folder_id
             ON main.wishlist_entries
             WHEN {free} AND (OLD.folder_id IN {managed} OR NEW.folder_id IN {managed})
         BEGIN {refuse} END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_guard_wish_del
             BEFORE DELETE ON main.wishlist_entries
             WHEN {free} AND OLD.folder_id IN {managed}
         BEGIN {refuse} END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_guard_folder_ins
             BEFORE INSERT ON main.wishlist_folders
             WHEN {free} AND (NEW.managed_deck_id IS NOT NULL OR NEW.parent_id IN {managed})
         BEGIN {refuse} END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_guard_folder_upd
             BEFORE UPDATE OF parent_id, name, sort_order, managed_deck_id
             ON main.wishlist_folders
             WHEN {free} AND (OLD.managed_deck_id IS NOT NULL
                              OR NEW.managed_deck_id IS NOT NULL
                              OR NEW.parent_id IN {managed})
         BEGIN {refuse} END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_guard_folder_del
             BEFORE DELETE ON main.wishlist_folders
             WHEN {free} AND OLD.managed_deck_id IS NOT NULL
         BEGIN {refuse} END;"
    )
}

/// Install the triggers on this connection if they are not there yet. One read of
/// `temp.sqlite_master` when they are, which is what every [`crate::sync::with_write`] pays.
pub fn arm(conn: &Connection) -> Result<(), String> {
    if armed(conn)? {
        return Ok(());
    }
    conn.execute_batch(&arm_sql()).map_err(|e| e.to_string())
}

fn armed(conn: &Connection) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM temp.sqlite_master
                        WHERE type = 'trigger' AND name = 'mw_guard_folder_del')",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Rewrite the managed folder of every deck a write since the last call touched. A no-op on a
/// connection [`arm`] never ran on.
pub fn settle(conn: &Connection) -> Result<(), String> {
    if !armed(conn)? {
        return Ok(());
    }
    let dirty: Vec<i64> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT deck_id FROM temp.managed_wishlist_dirty ORDER BY deck_id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>()
            .map_err(|e| e.to_string())?
    };
    if dirty.is_empty() {
        return Ok(());
    }
    conn.execute("DELETE FROM temp.managed_wishlist_dirty", [])
        .map_err(|e| e.to_string())?;
    let mut first_err = None;
    for deck_id in dirty {
        if let Err(e) = settle_deck(conn, deck_id) {
            // Left marked, so the next write tries again rather than the folder staying wrong
            // until this deck is next edited.
            let _ = conn.execute(
                "INSERT INTO temp.managed_wishlist_dirty VALUES (?1)",
                params![deck_id],
            );
            first_err.get_or_insert(e);
        }
    }
    first_err.map_or(Ok(()), Err)
}

/// [`settle`] with its failure written to stderr rather than returned — what
/// [`crate::sync::with_write`] calls, because the reader's own write has already committed and
/// a managed folder that could not be rewritten is not a reason to report that write failed.
pub fn settle_logged(conn: &Connection) {
    if let Err(e) = settle(conn) {
        eprintln!("a managed wishlist could not be brought up to date: {e}");
    }
}

/// Every deck and every managed folder, settled — the launch pass, from
/// [`crate::schema::prepare_database`]. It is what builds the folders the v47 rung's `DEFAULT 1`
/// promises every existing theory deck, and what sweeps a folder whose deck left while another
/// build (or a sync with no connection armed) was running.
pub fn settle_all(conn: &Connection) -> Result<(), String> {
    arm(conn)?;
    conn.execute_batch(
        "INSERT INTO temp.managed_wishlist_dirty SELECT id FROM main.decks;
         INSERT INTO temp.managed_wishlist_dirty
             SELECT managed_deck_id FROM main.wishlist_folders
              WHERE managed_deck_id IS NOT NULL;",
    )
    .map_err(|e| e.to_string())?;
    settle(conn)
}

/// Whether this deck should have a managed folder, and what it is called.
fn eligible(conn: &Connection, deck_id: i64) -> Result<Option<String>, String> {
    conn.query_row(
        "SELECT name FROM decks
          WHERE id = ?1 AND theory_enabled = 1 AND virtual_only = 0 AND managed_wishlist = 1",
        params![deck_id],
        |r| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// The rows of `temp.managed_wishlist_open` are what switch the guard off; this is the one
/// thing that writes one, and it takes it away however the settle ends.
struct Open<'a>(&'a Connection);

impl<'a> Open<'a> {
    fn begin(conn: &'a Connection) -> Result<Self, String> {
        conn.execute("INSERT INTO temp.managed_wishlist_open VALUES (1)", [])
            .map_err(|e| e.to_string())?;
        Ok(Self(conn))
    }
}

impl Drop for Open<'_> {
    fn drop(&mut self) {
        let _ = self.0.execute("DELETE FROM temp.managed_wishlist_open", []);
    }
}

type Key = (String, String, Option<String>);

/// One wish already in a managed folder: id, oracle card, printing, finish, copies.
type Held = (i64, Option<String>, Option<String>, Option<String>, i64);

/// Bring one deck's folder to what the deck says, in one transaction.
fn settle_deck(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let _open = Open::begin(conn)?;
    crate::sync_engine::capture::suppressed(conn, || {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let folder: Option<(i64, String)> = tx
            .query_row(
                "SELECT id, name FROM wishlist_folders WHERE managed_deck_id = ?1",
                params![deck_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(name) = eligible(&tx, deck_id)? else {
            // Gone, switched off, or no longer a theory deck: the wishes first, so
            // `wishlist_entries.folder_id`'s SET NULL has nothing to surface at the root.
            if let Some((id, _)) = folder {
                tx.execute(
                    "DELETE FROM wishlist_entries WHERE folder_id = ?1",
                    params![id],
                )
                .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM wishlist_folders WHERE id = ?1", params![id])
                    .map_err(|e| e.to_string())?;
            }
            return tx.commit().map_err(|e| e.to_string());
        };
        let folder_id = match folder {
            Some((id, current)) => {
                if current != name {
                    tx.execute(
                        "UPDATE wishlist_folders SET name = ?2, updated_at = unixepoch()
                          WHERE id = ?1",
                        params![id, name],
                    )
                    .map_err(|e| e.to_string())?;
                }
                id
            }
            None => tx
                .query_row(
                    "INSERT INTO wishlist_folders
                         (parent_id, name, sort_order, created_at, updated_at, managed_deck_id)
                     VALUES (NULL, ?1,
                             (SELECT coalesce(max(sort_order), -1) + 1 FROM wishlist_folders
                               WHERE parent_id IS NULL),
                             unixepoch(), unixepoch(), ?2)
                     RETURNING id",
                    params![name, deck_id],
                    |r| r.get(0),
                )
                .map_err(|e| e.to_string())?,
        };

        let mut want: HashMap<Key, crate::deck_theory::Wanted> = HashMap::new();
        for w in crate::deck_theory::wanted(&tx, deck_id)? {
            want.insert(
                (w.oracle_id.clone(), w.card_id.clone(), w.finish.clone()),
                w,
            );
        }
        let have: Vec<Held> = {
            let mut stmt = tx
                .prepare(
                    "SELECT id, oracle_id, card_id, preferred_finish, quantity
                       FROM wishlist_entries WHERE folder_id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let rows = stmt
                .query_map(params![folder_id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })
                .map_err(|e| e.to_string())?;
            rows.collect::<rusqlite::Result<_>>()
                .map_err(|e| e.to_string())?
        };
        for (id, oracle_id, card_id, finish, quantity) in have {
            let key = oracle_id.zip(card_id).map(|(o, c)| (o, c, finish));
            match key.and_then(|k| want.remove(&k)) {
                Some(w) if w.quantity == quantity => {}
                Some(w) => {
                    tx.execute(
                        "UPDATE wishlist_entries SET quantity = ?2, updated_at = unixepoch()
                          WHERE id = ?1",
                        params![id, w.quantity],
                    )
                    .map_err(|e| e.to_string())?;
                }
                None => {
                    tx.execute("DELETE FROM wishlist_entries WHERE id = ?1", params![id])
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        // What is left is new. Through the wishlist's own quiet door, so the grain, the
        // canonicalisation and the denormalised columns are that module's — and no feed line,
        // because nobody pressed anything.
        let mut fresh: Vec<_> = want.into_values().collect();
        fresh.sort_by(|a, b| a.name.cmp(&b.name).then(a.card_id.cmp(&b.card_id)));
        for w in fresh {
            crate::wishlist::add_wish_silent(
                &tx,
                &crate::wishlist::WishInput {
                    oracle_id: Some(w.oracle_id),
                    card_id: Some(w.card_id),
                    name: Some(w.name),
                    quantity: w.quantity,
                    preferred_finish: w.finish,
                    folder_id: Some(folder_id),
                    ..Default::default()
                },
            )?;
        }
        tx.commit().map_err(|e| e.to_string())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A pair with the capture triggers installed and a device in a group, so a captured write
    /// would leave an op — which is what the "never synced" test needs to be able to see.
    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        crate::sync_engine::capture::install(&conn).unwrap();
        // A device with no group records nothing, so the capture test needs one — capture.rs's
        // own fixture.
        conn.execute_batch(
            "INSERT INTO sync_identity (id, device_id, secret_key, public_key, name, created_at)
             VALUES (1, 'dev-a', x'00', x'01', 'A', 0);
             INSERT INTO sync_group (id, group_id, epoch, group_key, joined_at)
             VALUES (1, 'g', 0, x'02', 0);",
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO corpus.cards (id, oracle_id, name, set_code, collector_number, lang,
                                       layout, type_line, raw)
             VALUES ('bolt', 'o-bolt', 'Lightning Bolt', 'lea', '161', 'en', 'normal',
                     'Instant', '{}'),
                    ('ring', 'o-ring', 'Sol Ring', 'lea', '270', 'en', 'normal',
                     'Artifact', '{}');",
        )
        .unwrap();
        arm(&conn).unwrap();
        conn
    }

    /// A deck made and switched through the real commands, so what the triggers see is what a
    /// press would make them see.
    fn deck(conn: &Connection, name: &str, theory: bool) -> i64 {
        let id = crate::deck::create_deck(
            conn,
            &crate::deck::DeckInput {
                name: name.to_owned(),
                format_key: "modern".to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        if theory {
            crate::deck::update_deck(
                conn,
                id,
                &crate::deck::DeckPatch {
                    theory_enabled: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        id
    }

    /// Add `qty` more copies to one list, through `deck::add_card`.
    fn put(conn: &Connection, deck_id: i64, variant: &str, card: &str, qty: i64) {
        let cat = crate::deck_meta::category_for_name(conn, deck_id, "Main deck").unwrap();
        crate::deck::add_card(conn, deck_id, card, Some(cat), None, variant, None, qty).unwrap();
    }

    fn folder(conn: &Connection, deck_id: i64) -> Option<(i64, String)> {
        conn.query_row(
            "SELECT id, name FROM wishlist_folders WHERE managed_deck_id = ?1",
            params![deck_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap()
    }

    fn wishes(conn: &Connection, folder_id: i64) -> Vec<(String, i64)> {
        let mut stmt = conn
            .prepare(
                "SELECT card_id, quantity FROM wishlist_entries WHERE folder_id = ?1
                  ORDER BY card_id",
            )
            .unwrap();
        stmt.query_map(params![folder_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    #[test]
    fn a_theory_deck_gets_a_folder_holding_what_the_plan_is_short_of() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "bolt", 4);
        put(&conn, d, "theory", "ring", 1);
        put(&conn, d, "live", "bolt", 1);
        settle(&conn).unwrap();

        let (f, name) = folder(&conn, d).expect("a folder for the deck");
        assert_eq!(name, "Izzet");
        assert_eq!(
            wishes(&conn, f),
            vec![("bolt".to_owned(), 3), ("ring".to_owned(), 1)]
        );

        // The deck changes, and the folder follows: one more Bolt sleeved, the Ring acquired.
        put(&conn, d, "live", "bolt", 1);
        put(&conn, d, "live", "ring", 1);
        settle(&conn).unwrap();
        assert_eq!(wishes(&conn, f), vec![("bolt".to_owned(), 2)]);
    }

    #[test]
    fn a_regular_deck_and_a_switched_off_one_have_no_folder() {
        let conn = db();
        let regular = deck(&conn, "Plain", false);
        put(&conn, regular, "live", "bolt", 1);
        let off = deck(&conn, "Off", true);
        conn.execute(
            "UPDATE decks SET managed_wishlist = 0 WHERE id = ?1",
            params![off],
        )
        .unwrap();
        put(&conn, off, "theory", "bolt", 1);
        settle(&conn).unwrap();
        assert!(folder(&conn, regular).is_none());
        assert!(folder(&conn, off).is_none());
    }

    #[test]
    fn switching_it_off_or_deleting_the_deck_takes_the_folder_and_its_wishes_away() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "bolt", 2);
        settle(&conn).unwrap();
        assert!(folder(&conn, d).is_some());

        conn.execute(
            "UPDATE decks SET managed_wishlist = 0 WHERE id = ?1",
            params![d],
        )
        .unwrap();
        settle(&conn).unwrap();
        assert!(folder(&conn, d).is_none());
        let loose: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(loose, 0, "no wish surfaced at the root");

        conn.execute(
            "UPDATE decks SET managed_wishlist = 1 WHERE id = ?1",
            params![d],
        )
        .unwrap();
        settle(&conn).unwrap();
        assert!(folder(&conn, d).is_some(), "switching back rebuilds it");

        conn.execute("DELETE FROM decks WHERE id = ?1", params![d])
            .unwrap();
        settle(&conn).unwrap();
        let left: i64 = conn
            .query_row(
                "SELECT (SELECT count(*) FROM wishlist_folders)
                      + (SELECT count(*) FROM wishlist_entries)",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn a_rename_of_the_deck_renames_the_folder() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        settle(&conn).unwrap();
        conn.execute(
            "UPDATE decks SET name = 'Izzet Storm' WHERE id = ?1",
            params![d],
        )
        .unwrap();
        settle(&conn).unwrap();
        assert_eq!(folder(&conn, d).unwrap().1, "Izzet Storm");
    }

    #[test]
    fn a_hand_made_edit_is_refused_and_an_ordinary_wish_is_not() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "bolt", 2);
        settle(&conn).unwrap();
        let (f, _) = folder(&conn, d).unwrap();

        for sql in [
            format!("UPDATE wishlist_entries SET quantity = 9 WHERE folder_id = {f}"),
            format!("DELETE FROM wishlist_entries WHERE folder_id = {f}"),
            format!("UPDATE wishlist_folders SET name = 'x' WHERE id = {f}"),
            format!("DELETE FROM wishlist_folders WHERE id = {f}"),
            format!(
                "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at,
                                               updated_at)
                 VALUES ({f}, 'inside', 0, 0, 0)"
            ),
            format!(
                "INSERT INTO wishlist_entries (oracle_id, name, quantity, folder_id,
                                               created_at, updated_at)
                 VALUES ('o-ring', 'Sol Ring', 1, {f}, 0, 0)"
            ),
        ] {
            let err = conn.execute(&sql, []).unwrap_err().to_string();
            assert!(err.contains(MANAGED), "{sql}: {err}");
        }

        // The reader's own wishlist is untouched by the guard.
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
             VALUES ('o-ring', 'Sol Ring', 1, 0, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE wishlist_entries SET quantity = 2 WHERE folder_id IS NULL",
            [],
        )
        .unwrap();
    }

    /// Settings' "Clear the wishlist" is the reader's own list; the deck's folder stays, where
    /// without the narrowed sweep the guard would have refused the whole clear.
    #[test]
    fn clearing_the_wishlist_leaves_a_managed_folder_standing() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "bolt", 2);
        settle(&conn).unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id, name, quantity, created_at, updated_at)
             VALUES ('o-ring', 'Sol Ring', 1, 0, 0)",
            [],
        )
        .unwrap();
        assert_eq!(crate::reset::clear_wishlist(&conn).unwrap(), 1);
        let (f, _) = folder(&conn, d).expect("the deck's folder survives");
        assert_eq!(wishes(&conn, f), vec![("bolt".to_owned(), 2)]);
    }

    #[test]
    fn the_folder_is_never_captured_for_sync() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "bolt", 2);
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        // The deck's own write *is* captured — without this the assertion below could pass on a
        // device that captures nothing at all.
        assert!(count("SELECT count(*) FROM sync_ops WHERE tbl = 'deck_cards'") > 0);
        settle(&conn).unwrap();
        assert!(folder(&conn, d).is_some());
        assert_eq!(
            count(
                "SELECT count(*) FROM sync_ops
                  WHERE tbl IN ('wishlist_entries', 'wishlist_folders')"
            ),
            0,
            "a derived wish must not become an op"
        );
    }

    #[test]
    fn settle_all_builds_the_folders_an_upgrade_promises() {
        let conn = db();
        // Marked and then forgotten — the shape of a database that has just climbed to v47 with
        // theory decks already in it, written by a connection nothing armed.
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "ring", 1);
        conn.execute("DELETE FROM temp.managed_wishlist_dirty", [])
            .unwrap();
        settle(&conn).unwrap();
        assert!(folder(&conn, d).is_none(), "nothing marked, nothing done");
        settle_all(&conn).unwrap();
        let (f, _) = folder(&conn, d).unwrap();
        assert_eq!(wishes(&conn, f), vec![("ring".to_owned(), 1)]);
    }
}
