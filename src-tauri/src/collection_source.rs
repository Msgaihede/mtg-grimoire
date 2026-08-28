//! Where "what does the reader own" is read from.
//!
//! One rule — **a card the reader owns is a row in `collection_entries`** — presented as the
//! four correlated fragments the crate's readers actually ask for, plus the one write wrapper
//! that rebuilds the facet index after a write that can move ownership.
//!
//! **What it owns is those five things, not every mention of the table.** Three statements
//! elsewhere name `collection_entries` themselves, each because it asks a question no fragment
//! here answers — so a change to the table's *shape* has to reach this file **and** all three
//! of them:
//!
//! - [`crate::collection`]'s `from_sql` — the collection page, its count and its summary read
//!   the entries as their `FROM`, with the printing LEFT-JOINed on. Not a correlated
//!   subquery about ownership; the rows themselves.
//! - [`crate::wishlist`]'s `OWNED_SQL` — how much of a wish is already filled, narrowed by
//!   **finish**, which none of the fragments here does.
//! - [`crate::deck_theory`]'s `OWNED_SPARE_SQL` — copies **no deck's group holds**, so it
//!   narrows by finish *and* by where each row is filed, neither of which any fragment here
//!   does. (It subtracted a claim ledger until schema v25 dropped one; the question is now a
//!   `collection_folders.kind` lookup, and it is still its own statement.)
//!
//! Each of the three binds its own aliases and does not go through the paragraph below.
//! `src-tauri/CLAUDE.md` carries the short form of this rule.
//!
//! **The `conn` argument is vestigial, and it is kept on purpose.** These four took a
//! connection while the source was switchable and read a stored flag off it; nothing branches
//! any more. Dropping the parameter would edit every call site in the crate to remove an
//! argument, so it stays — spelled `_conn` — rather than being taken out and put back.
//!
//! **Two table aliases are spoken for, and a caller cannot see that from where it stands.**
//! Every builder binds `collection_entries e`, and [`copies_of_oracle`] binds `cards k` beside
//! it. So a `card_col` or `oracle_col` argument that itself begins `e.` or `k.` is captured by
//! the **inner** alias rather than the caller's — which quietly turns [`owns_printing`] into a
//! tautology, with no compile error and no runtime error, because the SQL that results is
//! perfectly valid and simply asks a different question. Nothing collides today
//! (`crate::search` binds only `c` and `cards_fts`, and `c` looks deliberately chosen), and
//! that is the whole reason to write it down: `e` and `k` are taken.

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// `EXISTS (…)` — does the reader own this printing at all?
///
/// `card_col` is the column or literal holding the printing id, spelled by the caller
/// (`c.id`, `'p1'`). No `GROUP BY`, because the question is existence.
pub fn owns_printing(_conn: &Connection, card_col: &str) -> String {
    format!("EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = {card_col})")
}

/// Copies of one printing, every finish and language together. `0` when none.
pub fn copies_of_printing(_conn: &Connection, card_col: &str) -> String {
    format!(
        "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                    WHERE e.card_id = {card_col}), 0)"
    )
}

/// Copies of every printing of one oracle card — a Bolt is a Bolt. `0` when none.
pub fn copies_of_oracle(_conn: &Connection, oracle_col: &str) -> String {
    format!(
        "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                     JOIN cards k ON k.id = e.card_id
                    WHERE k.oracle_id = {oracle_col}), 0)"
    )
}

/// The facet index's `owned` dimension — one `cards.rowid` per card the reader owns.
///
/// A whole statement rather than a fragment, because [`crate::index::CardIndex::rebuild_owned`]
/// prepares it as one. The join reads `cards`' primary-key index for the rowid and never the
/// row.
pub fn owned_rowids(_conn: &Connection) -> String {
    "SELECT DISTINCT c.rowid FROM collection_entries e JOIN cards c ON c.id = e.card_id".to_owned()
}

/// `crate::sync::with_write`, plus the facet index's `owned` rebuild on success.
///
/// Only on success. A refusal — [`crate::db::BUSY`], a `GONE`, a rejected quantity — changed
/// nothing, and re-reading after one would be a copy of the whole index to arrive at the same
/// answer.
///
/// Lives here rather than in [`crate::collection`] because its callers are a collection write,
/// [`crate::reset::collection_clear`] and anything else that can move what the reader owns, and
/// the thing they have in common is this module rather than that one.
pub(crate) fn with_write_owned<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);
    if answer.is_ok() {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    /// Two printings of one oracle card, and a hand-built collection holding **only the
    /// first**: 4 regular and 1 foil Sol Ring. `p2` gets no row, so every builder below is
    /// asked one question it must answer yes to and one it must answer no to.
    ///
    /// `cards` is seeded here because a worktree database has never synced — and these rows are
    /// torn down with the connection, so no later measurement is made a fiction by them.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate_single_file(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                                rarity,finishes,prices,raw)
             VALUES ('p1','o1','Sol Ring','cmr','472','en','normal','uncommon',
                     '[\"nonfoil\",\"foil\"]','{}','{}'),
                    ('p2','o1','Sol Ring','ltr','300','en','normal','uncommon',
                     '[\"nonfoil\"]','{}','{}');

             INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, created_at, updated_at)
                  VALUES ('p1','cmr','472','en','nonfoil','NM',4,0,0),
                         ('p1','cmr','472','en','foil','NM',1,0,0);",
        )
        .unwrap();
        conn
    }

    /// One scalar out of a fragment builder. `EXISTS` answers `0` or `1`, so the one helper
    /// serves all three of them.
    fn scalar(conn: &Connection, expr: &str) -> i64 {
        conn.query_row(&format!("SELECT {expr}"), [], |r| r.get(0))
            .unwrap()
    }

    /// The rowids the facet index's `owned` dimension would light up.
    fn rowids(conn: &Connection) -> Vec<i64> {
        conn.prepare(&owned_rowids(conn))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn owns_printing_is_true_only_for_a_printing_with_a_row() {
        let conn = db();
        let ask = |card: &str| scalar(&conn, &owns_printing(&conn, &format!("'{card}'")));
        assert_eq!(ask("p1"), 1);
        assert_eq!(ask("p2"), 0, "never acquired");
    }

    #[test]
    fn copies_of_printing_sums_every_finish_of_the_one_printing() {
        let conn = db();
        let ask = |card: &str| scalar(&conn, &copies_of_printing(&conn, &format!("'{card}'")));
        assert_eq!(ask("p1"), 5, "4 regular and 1 foil");
        assert_eq!(ask("p2"), 0);
    }

    /// Both printings share `o1`, so this is also the assertion that the join does not
    /// double-count: `p2` contributes nothing because the reader owns none of it.
    #[test]
    fn copies_of_oracle_crosses_printings() {
        let conn = db();
        assert_eq!(scalar(&conn, &copies_of_oracle(&conn, "'o1'")), 5);
        assert_eq!(scalar(&conn, &copies_of_oracle(&conn, "'o2'")), 0);
    }

    /// Two rows for one printing and one rowid out of them — `DISTINCT` is what does that.
    #[test]
    fn owned_rowids_lists_each_owned_card_once() {
        let conn = db();
        let p1: i64 = conn
            .query_row("SELECT rowid FROM cards WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rowids(&conn), vec![p1]);
    }
}
