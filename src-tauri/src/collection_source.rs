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
//! that is the whole reason to write it down: `e` and `k` are taken — **and so are `f` and
//! `locked_folders`**, which [`Availability::and_arm`] binds whenever a caller asks about a
//! deck.
//!
//! **[`Availability`] is the one axis these fragments take, and it is not a fourth filter.**
//! It does not narrow *which cards* a statement answers about; it narrows which of the
//! reader's copies count as theirs for the surface asking. Every caller but one asks
//! [`Availability::Everything`], which emits no SQL at all.

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// **Which** copies a fragment counts — "owned" against "owned and free to use".
///
/// The three builders below have always answered the first question, and every reader outside
/// the deck builder still asks it: a collection lists what its owner owns, wherever it is
/// filed. [`Availability::ForDeck`] is the second, and it exists for one surface — the deck
/// builder's card search, where a badge reading `×4` over a card whose every copy is sleeved
/// into another deck told the reader they had something they could not use
/// ([#349](https://github.com/Msgaihede/mtg-grimoire/issues/349)).
///
/// **A scope on the builders rather than three more builders beside them**, so that "which
/// copies count" is a decision each call site makes in words. Three parallel `_for_deck`
/// functions would let a new reader pick the wrong one by omission, which is the failure this
/// module already exists to prevent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Availability {
    /// Every copy the reader owns, wherever it is filed. What every caller written before the
    /// deck builder's badge asked for, and what an absent request field still means.
    Everything,
    /// Only the copies **this deck** can use — see [`Availability::and_arm`] for the three
    /// arms and why each is there.
    ForDeck(i64),
}

impl Availability {
    /// The `AND` arm that narrows `collection_entries e` to the copies this scope counts.
    ///
    /// **Empty for [`Self::Everything`]**, deliberately: every reader that has not asked about
    /// a deck sends byte-for-byte the SQL it always did, so none of the plans measured against
    /// this module (`crate::search`'s `owned: true` table, `crate::import`'s `MATCH_ORDER`)
    /// changes underneath a figure taken before this existed.
    ///
    /// Three arms, ORed, and each has to let a row through on its own:
    ///
    /// - **`e.folder_id IS NULL` — the root.** First, and its own arm, because the root is
    ///   where most copies are and is not a folder to look up: a `<>` or a `NOT IN` over a
    ///   NULL is NULL rather than true, so an unfiled collection would drop out of the very
    ///   count it is most of. [`crate::deck_theory`]'s `OWNED_SPARE_SQL` and
    ///   [`crate::collection`]'s `scope` both write the same arm for the same reason.
    /// - **This deck's own group counts, and that is the whole difference from
    ///   `OWNED_SPARE_SQL`.** A copy filed into the open deck's folder is a copy that deck
    ///   has; the row one column over already says *you own 2 of the 4 this deck wants*, and a
    ///   badge reading `×0` beside it would be two numbers about one card disagreeing. The
    ///   theory diff excludes every deck group including its own because its live list is
    ///   counted separately — a different question, so a different arm.
    /// - **Anywhere else, provided it is neither another deck's group nor set aside.** The
    ///   `<> 'deck'` half is [`crate::collection::Allocation::Unallocated`]'s own term, which
    ///   is what the Collection tab in the same panel already filters by; the locked half is
    ///   [`crate::collection_folders::LOCKED_FOLDER_IDS`], the **effective** lock, so a
    ///   subfolder of a display case is set aside too. `Recently removed` is a `kind` of its
    ///   own and therefore stays counted, exactly as it does in both of those.
    ///
    /// **The deck id is interpolated rather than bound**, which is safe on the only ground
    /// that counts: it is an `i64` off a `serde` field, so there is no text in it to escape.
    /// Binding it is what would be dangerous here — these fragments land in the middle of
    /// statements whose `?`s are pushed positionally by their callers, and a parameter buried
    /// in a `SELECT` list is one nobody can see when they add the next one.
    ///
    /// **`f` and `locked_folders` are bound inside**, on top of the `e` and `k` the module
    /// header already reserves. Nothing may pass a column spelled with those prefixes.
    fn and_arm(self) -> String {
        let Self::ForDeck(deck_id) = self else {
            return String::new();
        };
        format!(
            " AND (e.folder_id IS NULL
                   OR e.folder_id IN (SELECT f.id FROM collection_folders f
                                       WHERE f.deck_id = {deck_id})
                   OR ((SELECT f.kind FROM collection_folders f
                         WHERE f.id = e.folder_id) <> '{deck}'
                       AND e.folder_id NOT IN ({locked})))",
            deck = crate::schema::COLLECTION_FOLDER_KINDS[1],
            locked = crate::collection_folders::LOCKED_FOLDER_IDS,
        )
    }
}

/// `EXISTS (…)` — does the reader own this printing at all?
///
/// `card_col` is the column or literal holding the printing id, spelled by the caller
/// (`c.id`, `'p1'`). No `GROUP BY`, because the question is existence.
///
/// **An entry and not a copy**, which is what makes `scope` worth thinking about here: a row
/// this deck cannot reach is not an entry this deck owns, so the filter and the count beside
/// it have to be narrowed by the same scope or a card can sit under the Owned chip showing a
/// badge of `×0`.
pub fn owns_printing(_conn: &Connection, card_col: &str, scope: Availability) -> String {
    format!(
        "EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = {card_col}{arm})",
        arm = scope.and_arm()
    )
}

/// Copies of one printing, every finish and language together. `0` when none.
pub fn copies_of_printing(_conn: &Connection, card_col: &str, scope: Availability) -> String {
    format!(
        "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                    WHERE e.card_id = {card_col}{arm}), 0)",
        arm = scope.and_arm()
    )
}

/// Copies of every printing of one oracle card — a Bolt is a Bolt. `0` when none.
pub fn copies_of_oracle(_conn: &Connection, oracle_col: &str, scope: Availability) -> String {
    format!(
        "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                     JOIN cards k ON k.id = e.card_id
                    WHERE k.oracle_id = {oracle_col}{arm}), 0)",
        arm = scope.and_arm()
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
/// **Compiled for wasm with no caller there yet, and that is the point.** The web target
/// routes four of the app's commands, so every write in the crate still reaches this
/// only on desktop — but the wasm build type-checking the path is what proves
/// [`crate::db::lock_for`]'s wasm arm compiles against its real caller rather than in
/// isolation. `Instant::now()` panics on `wasm32-unknown-unknown`, so that arm exists
/// before the first web write rather than after it.
#[cfg_attr(target_family = "wasm", allow(dead_code))]
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

    /// Two printings of one oracle card, and a hand-built collection holding **only the
    /// first**: 4 regular and 1 foil Sol Ring. `p2` gets no row, so every builder below is
    /// asked one question it must answer yes to and one it must answer no to.
    ///
    /// `cards` is seeded here because a worktree database has never synced — and these rows are
    /// torn down with the connection, so no later measurement is made a fiction by them.
    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
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
        let ask = |card: &str| {
            scalar(
                &conn,
                &owns_printing(&conn, &format!("'{card}'"), EVERYTHING),
            )
        };
        assert_eq!(ask("p1"), 1);
        assert_eq!(ask("p2"), 0, "never acquired");
    }

    #[test]
    fn copies_of_printing_sums_every_finish_of_the_one_printing() {
        let conn = db();
        let ask = |card: &str| {
            scalar(
                &conn,
                &copies_of_printing(&conn, &format!("'{card}'"), EVERYTHING),
            )
        };
        assert_eq!(ask("p1"), 5, "4 regular and 1 foil");
        assert_eq!(ask("p2"), 0);
    }

    /// Both printings share `o1`, so this is also the assertion that the join does not
    /// double-count: `p2` contributes nothing because the reader owns none of it.
    #[test]
    fn copies_of_oracle_crosses_printings() {
        let conn = db();
        assert_eq!(
            scalar(&conn, &copies_of_oracle(&conn, "'o1'", EVERYTHING)),
            5
        );
        assert_eq!(
            scalar(&conn, &copies_of_oracle(&conn, "'o2'", EVERYTHING)),
            0
        );
    }

    /// The scope every reader outside the deck builder asks for, named once so the tests above
    /// read as the questions they were before it existed.
    const EVERYTHING: Availability = Availability::Everything;

    /// Deck 1 is the open deck; deck 2 is somebody else's. Six places one copy of `p1` can
    /// sit, one copy each, so every figure below is a count of *arms that let a row through*
    /// rather than a sum somebody has to re-derive.
    ///
    /// `foreign_keys` is left off, as [`crate::db::open`] would not — the two `decks` rows are
    /// inserted anyway, because a folder pointing at a deck that does not exist is not a state
    /// this fragment should ever be asked about.
    ///
    /// **`Recently removed` is looked up, never inserted.** The head schema seeds exactly one
    /// and a partial unique index on `kind` refuses a second, so this fixture has to find the
    /// row rather than write it — which is also why the folder ids here start at 11 instead of
    /// colliding with the seeded one.
    fn filed() -> Connection {
        let conn = db();
        conn.execute_batch(
            "DELETE FROM collection_entries;

             INSERT INTO decks (id, name, created_at, updated_at)
                  VALUES (1, 'Mine', 0, 0), (2, 'Theirs', 0, 0);

             INSERT INTO collection_folders (id, parent_id, name, kind, deck_id, sort_order,
                                             locked, created_at, updated_at)
                  VALUES (11, NULL, 'Mine',         'deck',    1, 0, 0, 0, 0),
                         (12, NULL, 'Theirs',       'deck',    2, 1, 0, 0, 0),
                         (13, NULL, 'Binder',       'user', NULL, 2, 0, 0, 0),
                         (14, NULL, 'Display case', 'user', NULL, 3, 1, 0, 0),
                         (15,   14, 'Top shelf',    'user', NULL, 4, 0, 0, 0);

             INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, folder_id, created_at,
                                             updated_at)
                  VALUES ('p1','cmr','472','en','nonfoil','NM',1,NULL,0,0),
                         ('p1','cmr','472','en','nonfoil','NM',1,  11,0,0),
                         ('p1','cmr','472','en','nonfoil','NM',1,  12,0,0),
                         ('p1','cmr','472','en','nonfoil','NM',1,  13,0,0),
                         ('p1','cmr','472','en','nonfoil','NM',1,  14,0,0),
                         ('p1','cmr','472','en','nonfoil','NM',1,  15,0,0),
                         ('p1','cmr','472','en','nonfoil','NM',1,
                          (SELECT id FROM collection_folders WHERE kind = 'removed'),0,0);",
        )
        .unwrap();
        conn
    }

    /// Seven copies filed in seven places, and the scope is the whole difference between them.
    ///
    /// The three that drop out are the two locked drawers — the case and the shelf *inside* it,
    /// which is the effective lock rather than the folder's own flag — and the other deck's
    /// group. `Recently removed` stays, for `Allocation::Unallocated`'s reason: a card that
    /// left the collection without leaving the database is back on the reader's desk.
    #[test]
    fn for_deck_drops_another_decks_group_and_every_locked_drawer() {
        let conn = filed();
        assert_eq!(
            scalar(&conn, &copies_of_printing(&conn, "'p1'", EVERYTHING)),
            7,
            "the scope is the only thing that can change this"
        );
        assert_eq!(
            scalar(
                &conn,
                &copies_of_printing(&conn, "'p1'", Availability::ForDeck(1))
            ),
            4,
            "root, this deck's group, the binder and Recently removed"
        );
    }

    /// The arm that separates this from [`crate::deck_theory`]'s `OWNED_SPARE_SQL`: asked for
    /// deck 2, the copy in deck 1's group is the one that drops and deck 2's own is the one
    /// that stays. Neither figure is symmetric with the other by accident.
    #[test]
    fn for_deck_counts_the_asking_decks_own_group() {
        let conn = filed();
        let ask = |deck: i64| {
            scalar(
                &conn,
                &copies_of_oracle(&conn, "'o1'", Availability::ForDeck(deck)),
            )
        };
        assert_eq!(ask(1), 4);
        assert_eq!(ask(2), 4);
        let held = |deck: i64| {
            scalar(
                &conn,
                &format!(
                    "(SELECT count(*) FROM collection_entries e
                       WHERE e.folder_id = (SELECT f.id FROM collection_folders f
                                             WHERE f.deck_id = {deck}))"
                ),
            )
        };
        assert_eq!(
            (held(1), held(2)),
            (1, 1),
            "one copy each, so 4 = 3 + its own"
        );
    }

    /// A deck with no group at all counts what is on the desk and nothing else — the state
    /// every deck is in until a copy is filed into it, and the one where a missing arm would
    /// look like a working one.
    #[test]
    fn for_deck_without_a_group_still_counts_the_desk() {
        let conn = filed();
        assert_eq!(
            scalar(
                &conn,
                &copies_of_printing(&conn, "'p1'", Availability::ForDeck(99))
            ),
            3,
            "root, the binder and Recently removed"
        );
    }

    /// The `EXISTS` half, narrowed by the same scope — which is what keeps the Owned chip and
    /// the badge from disagreeing. `p2` is the control: nobody owns it under either scope.
    #[test]
    fn owns_printing_follows_the_scope() {
        let conn = filed();
        conn.execute_batch(
            "DELETE FROM collection_entries WHERE folder_id IS NULL OR folder_id <> 12;",
        )
        .unwrap();
        let ask = |scope| scalar(&conn, &owns_printing(&conn, "'p1'", scope));
        assert_eq!(ask(EVERYTHING), 1, "the reader does own one");
        assert_eq!(
            ask(Availability::ForDeck(1)),
            0,
            "and it is sleeved into the other deck"
        );
    }

    /// **The fence the whole lock feature rests on**, named in
    /// [collection-folders.md](../../docs/reference/collection-folders.md) since v34 and written
    /// down here at last: a locked drawer's copies are still copies the reader **owns**, so
    /// every unscoped reader of these fragments — the card search's pip, both owned badges, the
    /// import's printing ranking — goes on counting them.
    ///
    /// It matters more now than it did, because there is finally a scope that does not: this is
    /// the assertion that the exclusion stayed inside [`Availability::ForDeck`] and was not
    /// "tidied" into the fragments themselves, which would silently deny the reader cardboard
    /// on their own shelf everywhere in the app.
    #[test]
    fn a_locked_folders_copies_are_still_owned() {
        let conn = filed();
        conn.execute_batch("DELETE FROM collection_entries WHERE folder_id IS NOT 15;")
            .unwrap();

        assert_eq!(
            scalar(&conn, &copies_of_printing(&conn, "'p1'", EVERYTHING)),
            1,
            "one copy, on a shelf inside a locked display case"
        );
        assert_eq!(scalar(&conn, &owns_printing(&conn, "'p1'", EVERYTHING)), 1);
        assert_eq!(
            scalar(
                &conn,
                &copies_of_printing(&conn, "'p1'", Availability::ForDeck(1))
            ),
            0,
            "and it is only the deck builder's own question that passes it over"
        );
    }

    /// [`Availability::Everything`] emits nothing, so every statement written before this axis
    /// existed is byte-for-byte the statement it was. The measurements in `crate::search` and
    /// `crate::import` are taken against those exact plans.
    #[test]
    fn everything_changes_no_sql_at_all() {
        let conn = db();
        assert_eq!(
            copies_of_oracle(&conn, "'o1'", EVERYTHING),
            "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                     JOIN cards k ON k.id = e.card_id
                    WHERE k.oracle_id = 'o1'), 0)"
        );
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
