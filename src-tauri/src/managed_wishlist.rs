//! A theory deck's **managed wishlist** — user schema v48, v49's mode and v57's tokens switch,
//! [issue #512](https://github.com/Msgaihede/mtg-grimoire/issues/512) and
//! [issue #617](https://github.com/Msgaihede/mtg-grimoire/issues/617).
//!
//! A deck whose kind is `Theory + Actual` and whose `decks.managed_wishlist_mode` names one of the
//! Compare dialog's three card views — `all`, `missing` or `other` (Different printing) — keeps
//! one wishlist folder, named after the deck, holding that view's cards:
//! [`crate::deck_theory::wanted`]. `off`, the default since v49, is no folder. The folder is the
//! **deck's**, not the reader's: this module is the only thing that writes to it, and every other
//! write is refused in words ([`MANAGED`]).
//!
//! ## The Tokens subfolder
//!
//! **Since user schema v55 a deck can own a second folder, inside the first** (the
//! token-improvements spec §3.8): a child named **Tokens** holding the token printings the plan is
//! short of. **Since v57 it is filled by `decks.managed_wishlist_tokens`, a switch of its own,
//! under whichever of the three modes the deck follows** (issue #617). Until then tokens were a
//! fact about the mode — **All** counted them, **Missing** and **Different printing** did not,
//! and a fifth word, `tokens`, meant the child alone with nothing in the deck's folder — so a
//! reader who wanted their missing cards *and* their tokens had no word for it. The switch is
//! stored whatever the mode says and acts only when the mode is not `off`, so turning a mode back
//! on brings the tokens back with it. The child exists only while there is a token to want.
//!
//! **Its identity is `wishlist_folders.managed_tokens = 1`, never its name**, and it carries the
//! deck's `managed_deck_id` as well — which is what lets the guard, [`settle_all`]'s sweep and the
//! frontend's `isManaged` cover it without a word about it. The cost is on the other side: a
//! lookup of *the deck's* folder by `managed_deck_id` alone now answers either row, so every such
//! lookup names `managed_tokens = 0` ([`managed_folder`]). A lookup that means *any managed
//! folder* — the guard, `reset::clear_wishlist`, the optimize preview, quick add — reads
//! `managed_deck_id IS NOT NULL` and is right to cover both.
//!
//! ## Derived per device, never synced
//!
//! The mode syncs — it is the reader's answer about a deck. The folder and its wishes do not:
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
//! `deck_cards`, to the `decks` columns that decide eligibility or the folder's name, to a
//! category's switch (an inactive pile counts toward nothing, so it changes the diff), and — since
//! the Tokens subfolder — to its `deck_token_printings` and `deck_tokens`, because a token stepper
//! writes nothing a card trigger watches. **The token marks go to a table of their own**, which
//! only [`settle`] reads: the card marks are also `deck_tokens::reconcile_dirty`'s input, and a
//! token write gives that reconcile nothing to do. Every user-facing write goes through
//! `with_write` — sync's `run_once` included — so [`settle`] runs after each one and rewrites only
//! the decks it touched. A sweep of every theory deck after every write would put a diff per deck
//! behind a zoom press.
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

/// The four words `decks.managed_wishlist_mode` holds, `off` first — the frontend's
/// `MANAGED_WISHLIST_MODES`, and the Compare dialog's `DiffView` words for the other three.
///
/// **`tokens` was a fifth from user schema v55 to v56** (the token-improvements spec §3.8) and
/// is one no longer: v57's rung turned every deck holding it into `missing` with
/// `managed_wishlist_tokens = 1` (issue #617). A peer still on v56 can send it after this device
/// climbed, and [`read_mode`] reads it as [`OFF`] like any word this build does not know — the
/// standing rule that every device is updated before it syncs across a token-model change.
pub const MODES: [&str; 4] = [OFF, "all", "missing", "other"];

/// No managed wishlist — the column's default since v49.
pub const OFF: &str = "off";

/// What a patch naming a word outside [`MODES`] is told.
pub const BAD_MODE: &str =
    "A managed wishlist follows All, Missing, Different printing or nothing.";

/// The name of the deck's **Tokens** subfolder. **Its identity is `managed_tokens = 1`, never
/// this name**: a reader's own folder called `Tokens`, or a deck called `Tokens`, must never be
/// taken for it (user schema v55).
const TOKENS_FOLDER: &str = "Tokens";

/// A stored mode, read **leniently**: a word this build does not know came from a newer peer
/// (the column carries no CHECK, because it syncs) and reads as [`OFF`] — a folder this build
/// cannot describe is better absent than guessed at.
pub fn read_mode(stored: String) -> String {
    if MODES.contains(&stored.as_str()) {
        stored
    } else {
        OFF.to_owned()
    }
}

/// A patched mode, read **strictly**: this build naming a word it does not know is its own bug.
pub fn valid_mode(mode: &str) -> Result<&str, String> {
    MODES
        .iter()
        .copied()
        .find(|m| *m == mode)
        .ok_or_else(|| BAD_MODE.to_owned())
}

/// The Compare view a stored mode names, or `None` for [`OFF`] and anything unknown.
fn view_of(mode: &str) -> Option<crate::deck_theory::DiffView> {
    use crate::deck_theory::DiffView;
    match mode {
        "all" => Some(DiffView::All),
        "missing" => Some(DiffView::Missing),
        "other" => Some(DiffView::Other),
        _ => None,
    }
}

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
             AFTER UPDATE OF name, theory_enabled, virtual_only, managed_wishlist_mode,
                             managed_wishlist_tokens ON main.decks
         BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (NEW.id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_deck_del AFTER DELETE ON main.decks BEGIN
             INSERT INTO temp.managed_wishlist_dirty VALUES (OLD.id);
         END;

         -- The two token tables (the token-improvements spec §3.8): a stepper, a swap, an add
         -- or a remove writes `deck_token_printings` and nothing a card trigger watches, and a
         -- token's legacy count on `deck_tokens` is an implicit entry's quantity. **Their own
         -- table**, which `settle` alone reads: `deck_tokens::reconcile_dirty` reads the one
         -- above, and a token write has no card to reconcile against — marked there, every
         -- stepper press on any deck would run a derivation over both lists for nothing.
         CREATE TEMP TABLE IF NOT EXISTS managed_wishlist_token_dirty (deck_id INTEGER);
         CREATE TEMP TRIGGER IF NOT EXISTS mw_entry_ins AFTER INSERT ON main.deck_token_printings
         BEGIN
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (NEW.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_entry_upd AFTER UPDATE ON main.deck_token_printings
         BEGIN
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (NEW.deck_id);
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (OLD.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_entry_del AFTER DELETE ON main.deck_token_printings
         BEGIN
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (OLD.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_token_ins AFTER INSERT ON main.deck_tokens BEGIN
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (NEW.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_token_upd AFTER UPDATE ON main.deck_tokens BEGIN
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (NEW.deck_id);
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (OLD.deck_id);
         END;
         CREATE TEMP TRIGGER IF NOT EXISTS mw_token_del AFTER DELETE ON main.deck_tokens BEGIN
             INSERT INTO temp.managed_wishlist_token_dirty VALUES (OLD.deck_id);
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
         -- `managed_tokens` is identity, not bookkeeping: it is what tells the deck's folder
         -- from its Tokens child, so a hand-made write to it is refused like one to the deck id.
         CREATE TEMP TRIGGER IF NOT EXISTS mw_guard_folder_upd
             BEFORE UPDATE OF parent_id, name, sort_order, managed_deck_id, managed_tokens
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
///
/// **Two dirty tables, both read and both emptied here**: the card marks, which
/// `deck_tokens::reconcile_dirty` also reads (and never clears, so it must run first), and the
/// token marks, which nothing else reads — see [`arm_sql`] on why they are kept apart.
pub fn settle(conn: &Connection) -> Result<(), String> {
    if !armed(conn)? {
        return Ok(());
    }
    let dirty: Vec<i64> = {
        let mut stmt = conn
            .prepare(
                "SELECT deck_id FROM temp.managed_wishlist_dirty
                 UNION
                 SELECT deck_id FROM temp.managed_wishlist_token_dirty
                 ORDER BY deck_id",
            )
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
    conn.execute_batch(
        "DELETE FROM temp.managed_wishlist_dirty;
         DELETE FROM temp.managed_wishlist_token_dirty;",
    )
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
/// [`crate::schema::prepare_database`]. It is what built the folders the v48 rung's `DEFAULT 1`
/// promised every existing theory deck, what removes them now v49's `off` default has taken
/// that back, and what sweeps a folder whose deck left while another
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

/// What a deck's managed folders should hold: the folder's name, the Compare view its cards
/// follow, and whether the plan's tokens are filed too.
struct Wants {
    name: String,
    view: crate::deck_theory::DiffView,
    tokens: bool,
}

/// Whether this deck should have a managed folder, and what it holds. `None` for a deck that is
/// gone, is not a theory deck, or is `off` — **whatever its tokens switch says**: the switch is
/// the reader's answer about a folder, and `off` is no folder (issue #617).
fn eligible(conn: &Connection, deck_id: i64) -> Result<Option<Wants>, String> {
    let row: Option<(String, String, bool)> = conn
        .query_row(
            "SELECT name, managed_wishlist_mode, managed_wishlist_tokens FROM decks
              WHERE id = ?1 AND theory_enabled = 1 AND virtual_only = 0",
            params![deck_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    Ok(
        row.and_then(|(name, mode, tokens)| {
            view_of(&mode).map(|view| Wants { name, view, tokens })
        }),
    )
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

/// One of a deck's two managed folders, by `managed_tokens`: `(id, name)`.
///
/// **Every lookup of a deck's managed folder names the column**, since user schema v55 gave a deck
/// a second managed row: `managed_deck_id = ?` alone answers either folder, and `query_row` would
/// hand back whichever SQLite found first. `0` is the deck's own folder and `1` its **Tokens**
/// child.
fn managed_folder(
    conn: &Connection,
    deck_id: i64,
    tokens: bool,
) -> Result<Option<(i64, String)>, String> {
    conn.query_row(
        "SELECT id, name FROM wishlist_folders
          WHERE managed_deck_id = ?1 AND managed_tokens = ?2",
        params![deck_id, i64::from(tokens)],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .map_err(|e| e.to_string())
}

/// Delete one managed folder, **its wishes first**, so `wishlist_entries.folder_id`'s SET NULL
/// has nothing to surface at the root.
fn drop_folder(tx: &Connection, folder_id: i64) -> Result<(), String> {
    tx.execute(
        "DELETE FROM wishlist_entries WHERE folder_id = ?1",
        params![folder_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM wishlist_folders WHERE id = ?1",
        params![folder_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Bring one deck's folders to what the deck says, in one transaction.
///
/// **Two folders since user schema v55** (the token-improvements spec §3.8): the deck's own, named
/// after it, holding the card rows of its Compare view, and inside it a child named **Tokens**
/// holding the token rows — **when the deck's tokens switch is on** (v57, issue #617), under any
/// of the three views. The child is made when there is a token to want and deleted when there is
/// none, so a deck that wants no token has no empty drawer.
///
/// **The child goes before the parent, always**, and each folder's wishes before the folder:
/// `wishlist_folders.parent_id` CASCADEs, so a parent deleted first would take the child with it
/// and the child's wishes — `ON DELETE SET NULL` — would surface at the root.
fn settle_deck(conn: &Connection, deck_id: i64) -> Result<(), String> {
    let _open = Open::begin(conn)?;
    crate::sync_engine::capture::suppressed(conn, || {
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let folder = managed_folder(&tx, deck_id, false)?;
        let tokens_folder = managed_folder(&tx, deck_id, true)?.map(|(id, _)| id);
        let Some(Wants { name, view, tokens }) = eligible(&tx, deck_id)? else {
            // Gone, `off`, or no longer a theory deck: the child, then the parent.
            if let Some(id) = tokens_folder {
                drop_folder(&tx, id)?;
            }
            if let Some((id, _)) = folder {
                drop_folder(&tx, id)?;
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

        // One read of the view, split by kind: the cards to the deck's folder, the tokens to its
        // child. With the switch off `wanted` reads no token wall, so the child's half is empty
        // and the match below takes the child away.
        let (tokens, cards): (Vec<_>, Vec<_>) =
            crate::deck_theory::wanted(&tx, deck_id, view, tokens)?
                .into_iter()
                .partition(|w| w.is_token);
        fill(&tx, folder_id, cards)?;
        match (tokens_folder, tokens.is_empty()) {
            (Some(id), true) => drop_folder(&tx, id)?,
            (None, true) => {}
            (Some(id), false) => fill(&tx, id, tokens)?,
            (None, false) => {
                let id = tx
                    .query_row(
                        "INSERT INTO wishlist_folders
                             (parent_id, name, sort_order, created_at, updated_at,
                              managed_deck_id, managed_tokens)
                         VALUES (?1, ?2,
                                 (SELECT coalesce(max(sort_order), -1) + 1 FROM wishlist_folders
                                   WHERE parent_id = ?1),
                                 unixepoch(), unixepoch(), ?3, 1)
                         RETURNING id",
                        params![folder_id, TOKENS_FOLDER, deck_id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                fill(&tx, id, tokens)?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    })
}

/// Bring one managed folder's wishes to `wants`: a wish on the same `(oracle card, printing,
/// finish)` keeps its row and takes the new count, one no longer wanted goes, and what is left is
/// added.
fn fill(
    tx: &Connection,
    folder_id: i64,
    wants: Vec<crate::deck_theory::Wanted>,
) -> Result<(), String> {
    let mut want: HashMap<Key, crate::deck_theory::Wanted> = HashMap::new();
    for w in wants {
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
    // because nobody pressed anything. Sorted to the whole key, finish included, so a foil and a
    // regular want of one printing are inserted in the same order on every device and every run
    // rather than in the map's.
    let mut fresh: Vec<_> = want.into_values().collect();
    fresh.sort_by(|a, b| {
        a.name
            .cmp(&b.name)
            .then(a.card_id.cmp(&b.card_id))
            .then(a.finish.cmp(&b.finish))
    });
    for w in fresh {
        crate::wishlist::add_wish_silent(
            tx,
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
    Ok(())
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
                     'Artifact', '{}'),
                    ('bolt-m10', 'o-bolt', 'Lightning Bolt', 'm10', '146', 'en', 'normal',
                     'Instant', '{}');",
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
                    // `off` is the column's default, so a test that wants a folder asks for one.
                    managed_wishlist: Some("missing".to_owned()),
                    ..Default::default()
                },
            )
            .unwrap();
        }
        id
    }

    /// Point a deck's managed wishlist at another Compare view, through the real patch.
    fn mode(conn: &Connection, deck_id: i64, mode: &str) {
        crate::deck::update_deck(
            conn,
            deck_id,
            &crate::deck::DeckPatch {
                managed_wishlist: Some(mode.to_owned()),
                ..Default::default()
            },
        )
        .unwrap();
    }

    /// Turn a deck's managed tokens on or off (user schema v57), through the real patch.
    fn tokens_switch(conn: &Connection, deck_id: i64, on: bool) {
        crate::deck::update_deck(
            conn,
            deck_id,
            &crate::deck::DeckPatch {
                managed_wishlist_tokens: Some(on),
                ..Default::default()
            },
        )
        .unwrap();
    }

    /// Add `qty` more copies to one list, through `deck::add_card`.
    fn put(conn: &Connection, deck_id: i64, variant: &str, card: &str, qty: i64) {
        let cat = crate::deck_meta::category_for_name(conn, deck_id, variant, "Main deck").unwrap();
        crate::deck::add_card(conn, deck_id, card, Some(cat), None, variant, None, qty).unwrap();
    }

    /// The deck's own folder — `managed_tokens = 0`, since v55 gave a deck a second managed row.
    fn folder(conn: &Connection, deck_id: i64) -> Option<(i64, String)> {
        conn.query_row(
            "SELECT id, name FROM wishlist_folders
              WHERE managed_deck_id = ?1 AND managed_tokens = 0",
            params![deck_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .unwrap()
    }

    /// The deck's **Tokens** subfolder, as `(id, parent, name)` — found by its column, never by
    /// its name.
    fn tokens_folder(conn: &Connection, deck_id: i64) -> Option<(i64, Option<i64>, String)> {
        conn.query_row(
            "SELECT id, parent_id, name FROM wishlist_folders
              WHERE managed_deck_id = ?1 AND managed_tokens = 1",
            params![deck_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .unwrap()
    }

    /// A card that makes a Treasure, and the Treasure, `all_parts` and all — a token want is
    /// derived from the deck's cards, and every card [`db`] seeds carries `raw = '{}'` and so
    /// makes nothing.
    fn with_treasure(conn: &Connection) {
        let tithe = serde_json::json!({
            "id": "tithe",
            "name": "Smothering Tithe",
            "all_parts": [{
                "object": "related_card", "id": "treasure", "component": "token",
                "name": "Treasure"
            }],
        });
        conn.execute(
            "INSERT INTO corpus.cards (id, oracle_id, name, set_code, collector_number, lang,
                                       layout, type_line, raw)
             VALUES ('tithe', 'o-tithe', 'Smothering Tithe', 'cmm', '693', 'en', 'normal',
                     'Enchantment', ?1)",
            params![crate::card_row::gzip_raw(&tithe.to_string())],
        )
        .unwrap();
        conn.execute_batch(
            r#"INSERT INTO corpus.cards (id, oracle_id, name, set_code, collector_number, lang,
                                         layout, type_line, finishes, raw)
               VALUES ('treasure', 'o-treasure', 'Treasure', 'tmom', '12', 'en', 'token',
                       'Token Artifact — Treasure', '["nonfoil"]', '{}');"#,
        )
        .unwrap();
    }

    /// A theory deck that plans a Tithe, two Bolts and three Treasures and sleeves a Tithe and
    /// one Treasure — short of two Bolts and two Treasures — in `mode`, with its tokens switch
    /// at `tokens`.
    fn tithe_deck(conn: &Connection, mode_word: &str, tokens: bool) -> i64 {
        let d = deck(conn, "Tithe", true);
        mode(conn, d, mode_word);
        tokens_switch(conn, d, tokens);
        put(conn, d, "theory", "tithe", 1);
        put(conn, d, "live", "tithe", 1);
        put(conn, d, "theory", "bolt", 2);
        // A token printing handed to `add_card` is filed as a token entry of that list.
        put(conn, d, "theory", "treasure", 3);
        put(conn, d, "live", "treasure", 1);
        d
    }

    /// A folder's wishes as `(printing, finish, copies)`.
    fn pinned(conn: &Connection, folder_id: i64) -> Vec<(String, Option<String>, i64)> {
        let mut stmt = conn
            .prepare(
                "SELECT card_id, preferred_finish, quantity FROM wishlist_entries
                  WHERE folder_id = ?1 ORDER BY card_id",
            )
            .unwrap();
        stmt.query_map(params![folder_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    /// Every wish for a Treasure, anywhere — the root included, where a folder deleted ahead of
    /// its wishes would surface them.
    fn treasure_wishes(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM wishlist_entries WHERE oracle_id = 'o-treasure'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// **All with the tokens switch on** fills two folders: the deck's own with the cards and a
    /// child called **Tokens** with the tokens — never a token among the cards.
    #[test]
    fn all_fills_a_tokens_subfolder_with_the_plans_missing_tokens() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "all", true);
        settle(&conn).unwrap();

        let (parent, _) = folder(&conn, d).expect("the deck's own folder");
        assert_eq!(wishes(&conn, parent), vec![("bolt".to_owned(), 2)]);
        let (child, parent_id, name) = tokens_folder(&conn, d).expect("a Tokens subfolder");
        assert_eq!((parent_id, name.as_str()), (Some(parent), "Tokens"));
        assert_eq!(
            pinned(&conn, child),
            vec![("treasure".to_owned(), Some("nonfoil".to_owned()), 2)],
            "three planned, one sleeved — pinned to the printing and its finish"
        );
    }

    /// **The switch files tokens under every view** (issue #617) — Missing and Different printing
    /// included, which had no way to want a token while the switch was a fact about the mode.
    /// The deck's own folder holds that view's cards and nothing else, whichever it is.
    #[test]
    fn the_tokens_switch_files_tokens_under_missing_and_different_printing() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "missing", true);
        settle(&conn).unwrap();
        let (parent, _) = folder(&conn, d).unwrap();
        assert_eq!(wishes(&conn, parent), vec![("bolt".to_owned(), 2)]);
        let (child, parent_id, _) = tokens_folder(&conn, d).expect("a Tokens subfolder");
        assert_eq!(parent_id, Some(parent));
        assert_eq!(wishes(&conn, child), vec![("treasure".to_owned(), 2)]);

        mode(&conn, d, "other");
        settle(&conn).unwrap();
        assert_eq!(
            wishes(&conn, parent),
            vec![],
            "no Bolt is played as another printing"
        );
        let (child, _, _) = tokens_folder(&conn, d).expect("still there under Other");
        assert_eq!(wishes(&conn, child), vec![("treasure".to_owned(), 2)]);
    }

    /// **The switch off is no subfolder under any view** — All included, which filed tokens
    /// unasked until v57.
    #[test]
    fn without_the_switch_no_view_has_a_tokens_subfolder() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "all", false);
        for word in ["all", "missing", "other"] {
            mode(&conn, d, word);
            settle(&conn).unwrap();
            assert!(
                folder(&conn, d).is_some(),
                "{word}: the deck's folder stands"
            );
            assert!(tokens_folder(&conn, d).is_none(), "{word}: no Tokens child");
        }
        assert_eq!(treasure_wishes(&conn), 0);
    }

    /// Review Focus 5, read against the switch: **turning it off takes the Tokens subfolder and
    /// its wishes away and keeps the card wishes** — in the same folder, not a rebuilt one, and as
    /// the same row rather than a deleted and re-added one, with no Treasure left over at the
    /// root, which is where the child's wishes would land if the child went first. And a change
    /// of view with the switch on leaves the child where it is.
    #[test]
    fn turning_the_switch_off_removes_the_subfolder_and_keeps_the_card_wishes() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "all", true);
        settle(&conn).unwrap();
        let (parent, _) = folder(&conn, d).unwrap();
        let (child, _, _) = tokens_folder(&conn, d).expect("the premise: the switch made it");
        let bolt_wish = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT id FROM wishlist_entries WHERE folder_id = ?1 AND card_id = 'bolt'",
                params![parent],
                |r| r.get(0),
            )
            .unwrap()
        };
        let kept = bolt_wish(&conn);

        mode(&conn, d, "missing");
        settle(&conn).unwrap();
        assert_eq!(
            tokens_folder(&conn, d).map(|f| f.0),
            Some(child),
            "All to Missing keeps the child"
        );

        tokens_switch(&conn, d, false);
        settle(&conn).unwrap();

        assert!(tokens_folder(&conn, d).is_none());
        assert_eq!(treasure_wishes(&conn), 0, "the child's wishes went with it");
        assert_eq!(folder(&conn, d).map(|f| f.0), Some(parent));
        assert_eq!(wishes(&conn, parent), vec![("bolt".to_owned(), 2)]);
        assert_eq!(bolt_wish(&conn), kept, "the card wish is the row it was");
    }

    /// **The switch alone marks the deck dirty** — `mw_deck_upd` names
    /// `managed_wishlist_tokens` — so a press that changes nothing else still reaches the folder.
    #[test]
    fn the_switch_alone_re_settles_the_wishlist() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "missing", false);
        settle(&conn).unwrap();
        assert!(tokens_folder(&conn, d).is_none());
        tokens_switch(&conn, d, true);
        settle(&conn).unwrap();
        assert!(tokens_folder(&conn, d).is_some());
    }

    /// **A step on a token re-settles the wishlist**, like a step on a card: the dirty triggers
    /// watch `deck_token_printings` — where a stepper writes, and nothing else does — and
    /// `deck_tokens`, where a token's legacy count lives.
    #[test]
    fn a_token_step_re_settles_the_wishlist() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "all", true);
        settle(&conn).unwrap();
        let (child, _, _) = tokens_folder(&conn, d).unwrap();
        assert_eq!(wishes(&conn, child), vec![("treasure".to_owned(), 2)]);

        let sleeved = |quantity: i64| {
            crate::deck_tokens::set_quantity(
                &conn,
                d,
                "live",
                "o-treasure",
                Some(&crate::deck_tokens::TokenEntryKey {
                    card_id: "treasure".to_owned(),
                    finish: "nonfoil".to_owned(),
                }),
                quantity,
            )
            .unwrap();
        };
        sleeved(2);
        settle(&conn).unwrap();
        assert_eq!(wishes(&conn, child), vec![("treasure".to_owned(), 1)]);
        sleeved(3);
        settle(&conn).unwrap();
        assert!(
            tokens_folder(&conn, d).is_none(),
            "every planned Treasure is sleeved"
        );

        // `deck_tokens`: a plan that makes a Treasure and counts none, until a legacy count
        // arrives on the token's own row — what a pull from a peer on an older build can write.
        let other = deck(&conn, "Other", true);
        mode(&conn, other, "all");
        tokens_switch(&conn, other, true);
        put(&conn, other, "theory", "tithe", 1);
        settle(&conn).unwrap();
        assert!(tokens_folder(&conn, other).is_none());
        conn.execute(
            "INSERT INTO deck_tokens (deck_id, oracle_id, quantity, state, created_at, updated_at)
             VALUES (?1, 'o-treasure', 2, 'auto', 0, 0)",
            params![other],
        )
        .unwrap();
        settle(&conn).unwrap();
        let (child, _, _) = tokens_folder(&conn, other).expect("the count made a want");
        assert_eq!(wishes(&conn, child), vec![("treasure".to_owned(), 2)]);
    }

    /// **No token want, no subfolder** — not an empty one. A plan that makes a Treasure counts
    /// none until the reader steps it, and a plan whose every token is sleeved wants none.
    #[test]
    fn no_token_want_no_subfolder() {
        let conn = db();
        with_treasure(&conn);
        let d = deck(&conn, "Tithe", true);
        mode(&conn, d, "all");
        tokens_switch(&conn, d, true);
        put(&conn, d, "theory", "tithe", 1);
        put(&conn, d, "theory", "bolt", 1);
        settle(&conn).unwrap();
        assert!(folder(&conn, d).is_some());
        assert!(
            tokens_folder(&conn, d).is_none(),
            "an untouched token counts 0"
        );

        put(&conn, d, "theory", "treasure", 2);
        settle(&conn).unwrap();
        assert!(
            tokens_folder(&conn, d).is_some(),
            "the premise: a want makes it"
        );
        put(&conn, d, "live", "treasure", 2);
        settle(&conn).unwrap();
        assert!(tokens_folder(&conn, d).is_none(), "and none takes it away");
        assert_eq!(treasure_wishes(&conn), 0);
    }

    /// Switching off and deleting the deck take the child as well as the parent — the child's
    /// wishes, the child, then the parent's wishes and the parent — and leave nothing behind.
    #[test]
    fn off_and_a_deleted_deck_take_the_tokens_subfolder_with_the_folder() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "all", true);
        settle(&conn).unwrap();
        assert!(tokens_folder(&conn, d).is_some());
        let left = |conn: &Connection| -> i64 {
            conn.query_row(
                "SELECT (SELECT count(*) FROM wishlist_folders)
                      + (SELECT count(*) FROM wishlist_entries)",
                [],
                |r| r.get(0),
            )
            .unwrap()
        };

        mode(&conn, d, "off");
        settle(&conn).unwrap();
        assert_eq!(left(&conn), 0);

        mode(&conn, d, "all");
        settle(&conn).unwrap();
        assert!(
            tokens_folder(&conn, d).is_some(),
            "switching back rebuilds both — `off` left the tokens switch where it was"
        );
        conn.execute("DELETE FROM decks WHERE id = ?1", params![d])
            .unwrap();
        settle(&conn).unwrap();
        assert_eq!(left(&conn), 0);
    }

    /// The guard covers the child because it carries the deck's `managed_deck_id` — and its
    /// `UPDATE` guard names `managed_tokens`, the column that says which folder is which, so a
    /// hand-made write cannot turn the deck's folder into its Tokens child or back.
    #[test]
    fn the_tokens_subfolder_is_refused_to_a_hand_made_edit() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "all", true);
        settle(&conn).unwrap();
        let (parent, _) = folder(&conn, d).unwrap();
        let (child, _, _) = tokens_folder(&conn, d).unwrap();

        for sql in [
            format!("UPDATE wishlist_entries SET quantity = 9 WHERE folder_id = {child}"),
            format!("DELETE FROM wishlist_entries WHERE folder_id = {child}"),
            format!("UPDATE wishlist_folders SET name = 'x' WHERE id = {child}"),
            format!("DELETE FROM wishlist_folders WHERE id = {child}"),
            format!("UPDATE wishlist_folders SET managed_tokens = 2 WHERE id = {child}"),
            format!("UPDATE wishlist_folders SET managed_tokens = 2 WHERE id = {parent}"),
            format!(
                "INSERT INTO wishlist_folders (parent_id, name, sort_order, created_at,
                                               updated_at)
                 VALUES ({child}, 'inside', 0, 0, 0)"
            ),
        ] {
            let err = conn.execute(&sql, []).unwrap_err().to_string();
            assert!(err.contains(MANAGED), "{sql}: {err}");
        }
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

    /// **Missing**, not **All**: a card the deck already plays as another printing is not a card
    /// to buy, so only the copies no printing covers are wished for.
    #[test]
    fn a_card_played_as_another_printing_is_not_missing() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "bolt", 3);
        put(&conn, d, "live", "bolt-m10", 1);
        settle(&conn).unwrap();
        let (f, _) = folder(&conn, d).unwrap();
        assert_eq!(
            wishes(&conn, f),
            vec![("bolt".to_owned(), 2)],
            "three planned, one already played as M10: two left to find"
        );

        put(&conn, d, "live", "bolt-m10", 2);
        settle(&conn).unwrap();
        assert_eq!(
            wishes(&conn, f),
            vec![],
            "every planned copy is played in some printing, so nothing is missing"
        );
    }

    /// Each view carries its own copies: **All** the whole shortfall, **Different printing** only
    /// the copies the deck plays as another printing — the ones to swap.
    #[test]
    fn the_folder_follows_whichever_view_the_deck_names() {
        let conn = db();
        let d = deck(&conn, "Izzet", true);
        put(&conn, d, "theory", "bolt", 3);
        put(&conn, d, "theory", "ring", 1);
        put(&conn, d, "live", "bolt-m10", 1);

        mode(&conn, d, "all");
        settle(&conn).unwrap();
        let (f, _) = folder(&conn, d).unwrap();
        assert_eq!(
            wishes(&conn, f),
            vec![("bolt".to_owned(), 3), ("ring".to_owned(), 1)]
        );

        mode(&conn, d, "other");
        settle(&conn).unwrap();
        assert_eq!(
            wishes(&conn, f),
            vec![("bolt".to_owned(), 1)],
            "one Bolt is played as M10; the Ring is played in no printing at all"
        );

        mode(&conn, d, "missing");
        settle(&conn).unwrap();
        assert_eq!(
            wishes(&conn, f),
            vec![("bolt".to_owned(), 2), ("ring".to_owned(), 1)]
        );
    }

    /// `off` is the default, and a word outside the four is refused by a patch but read as `off`
    /// off the row, where it would have come from a newer peer — or, for `tokens`, from a peer
    /// still on v56 (issue #617).
    #[test]
    fn off_is_the_default_and_an_unknown_mode_is_refused_or_read_as_off() {
        let conn = db();
        let id = crate::deck::create_deck(
            &conn,
            &crate::deck::DeckInput {
                name: "Fresh".to_owned(),
                format_key: "modern".to_owned(),
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        let read = |conn: &Connection| {
            crate::deck::read_deck(conn, id)
                .unwrap()
                .unwrap()
                .managed_wishlist
        };
        assert_eq!(read(&conn), OFF);
        let err = crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                managed_wishlist: Some("everything".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, BAD_MODE);
        let err = crate::deck::update_deck(
            &conn,
            id,
            &crate::deck::DeckPatch {
                managed_wishlist: Some("tokens".to_owned()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert_eq!(err, BAD_MODE, "v57 retired the fifth word");
        for word in ["someday", "tokens"] {
            conn.execute(
                "UPDATE decks SET managed_wishlist_mode = ?2 WHERE id = ?1",
                params![id, word],
            )
            .unwrap();
            assert_eq!(read(&conn), OFF, "{word}");
        }
    }

    #[test]
    fn a_regular_deck_and_a_switched_off_one_have_no_folder() {
        let conn = db();
        let regular = deck(&conn, "Plain", false);
        put(&conn, regular, "live", "bolt", 1);
        let off = deck(&conn, "Off", true);
        mode(&conn, off, "off");
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

        mode(&conn, d, "off");
        settle(&conn).unwrap();
        assert!(folder(&conn, d).is_none());
        let loose: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(loose, 0, "no wish surfaced at the root");

        mode(&conn, d, "missing");
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

    /// The same promise for the **Tokens** subfolder, both ways: the child's insert with its
    /// wishes, and its drop when the tokens switch goes off, leave no op — the child is as
    /// derived as its parent.
    #[test]
    fn the_tokens_subfolder_is_never_captured_for_sync() {
        let conn = db();
        with_treasure(&conn);
        let d = tithe_deck(&conn, "all", true);
        let count = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap() };
        // The token entries *are* captured, so this device records ops at all.
        assert!(count("SELECT count(*) FROM sync_ops WHERE tbl = 'deck_token_printings'") > 0);
        let wishlist_ops = "SELECT count(*) FROM sync_ops
                             WHERE tbl IN ('wishlist_entries', 'wishlist_folders')";

        settle(&conn).unwrap();
        let (child, _, _) = tokens_folder(&conn, d).expect("the switch with a token want makes it");
        assert_eq!(wishes(&conn, child), vec![("treasure".to_owned(), 2)]);
        assert_eq!(count(wishlist_ops), 0, "the child's insert is not an op");

        tokens_switch(&conn, d, false);
        settle(&conn).unwrap();
        assert!(tokens_folder(&conn, d).is_none());
        assert_eq!(count(wishlist_ops), 0, "and neither is its drop");
    }

    /// **A token write marks only the settle's own table**, never the card table
    /// `deck_tokens::reconcile_dirty` reads — so a stepper press on a deck with no managed
    /// wishlist runs no reconcile — while a card write still marks the card table (the control,
    /// without which an empty table proves nothing). `a_token_step_re_settles_the_wishlist` is
    /// the other half: the token mark still reaches the settle.
    #[test]
    fn a_token_step_marks_only_the_settles_own_table() {
        let conn = db();
        with_treasure(&conn);
        let d = deck(&conn, "Plain", false);
        put(&conn, d, "live", "tithe", 1);
        settle(&conn).unwrap();
        let marks = |table: &str| -> i64 {
            conn.query_row(&format!("SELECT count(*) FROM temp.{table}"), [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(
            (
                marks("managed_wishlist_dirty"),
                marks("managed_wishlist_token_dirty")
            ),
            (0, 0),
            "the premise: settled"
        );

        // The implicit Treasure, materialised and stepped: `deck_token_printings` alone.
        crate::deck_tokens::set_quantity(&conn, d, "live", "o-treasure", None, 2).unwrap();
        assert_eq!(
            marks("managed_wishlist_dirty"),
            0,
            "nothing for the reconcile"
        );
        assert!(marks("managed_wishlist_token_dirty") > 0);
        settle(&conn).unwrap();
        assert_eq!(
            marks("managed_wishlist_token_dirty"),
            0,
            "the settle drains it"
        );

        put(&conn, d, "live", "bolt", 1);
        assert!(
            marks("managed_wishlist_dirty") > 0,
            "a card write still marks"
        );
    }

    #[test]
    fn settle_all_builds_the_folders_an_upgrade_promises() {
        let conn = db();
        // Marked and then forgotten — the shape of a database that has just climbed to v48 with
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
