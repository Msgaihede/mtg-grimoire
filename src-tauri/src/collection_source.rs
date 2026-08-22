//! Where "what does the reader own" is read from — the table, or the decks.
//!
//! [`crate::deck_driven`] owns the bit; this module owns the **rule**, which is one
//! predicate ([`LIVE`]) presented in two shapes. Every query in the crate that asks about
//! ownership builds its SQL through one of the functions here rather than naming a table, so
//! there is exactly one place the rule lives and exactly one place a future variant would go.
//!
//! **Why two shapes rather than one.** The obvious design is a single `FROM` fragment that is
//! either the table or a `GROUP BY` over the live deck lists, swapped in everywhere. It is
//! right for the two commands that list whole rows and wrong for the other five, which read
//! ownership from inside a *correlated subquery*: `crate::search`'s owned badge sits in a
//! query over 116 000 cards, and a correlated read of an aggregate recomputes the whole deck
//! sum once per candidate row. So [`rows`] is the grouped shape, the four builders below are
//! the direct shape, and `the_two_shapes_agree_on_the_same_database` is what holds them to
//! one answer.
//!
//! **What a derived row cannot carry.** `deck_cards` supplies `card_id`, `finish` and `lang`
//! and nothing else the collection grain names — no condition, no purchase price, no
//! acquisition story, no grading, no proxy or altered or signed flag. [`rows`] emits those as
//! constants, and `condition` as NULL rather than as the column's `'NM'` default, because a
//! default written into an export is a fact the reader never stated.
//!
//! **Three table aliases are spoken for, and a caller cannot see that from where it stands.**
//! The hand-kept arms bind `collection_entries e`; the derived arms bind `deck_cards dc`, and
//! [`copies_of_oracle`] binds `cards k` beside it. So a `card_col` or `oracle_col` argument
//! that itself begins `e.`, `dc.` or `k.` is captured by the **inner** alias rather than the
//! caller's — which quietly turns [`owns_printing`] into a tautology, with no compile error and
//! no runtime error, because the SQL that results is perfectly valid and simply asks a
//! different question. Nothing collides today (`crate::search` binds only `c` and `cards_fts`,
//! and `c` looks deliberately chosen), and that is the whole reason to write it down: `e`, `dc`
//! and `k` are taken.

use crate::sync::AppState;
use rusqlite::Connection;
use std::sync::Arc;

/// The whole rule, once: **a card the reader owns is a card in a `live` deck list.**
///
/// No `deck_categories` join and no `is_active` term — an inactive Maybeboard is a statement
/// about how the *deck* is read, not about whether the cards are in the reader's hands, and
/// this is the one place in the crate that deliberately departs from
/// [`crate::deck::allocate_deck`]'s rule. No `decks.archived` term either: archiving is
/// filing, not disassembling. And no `theory_enabled` term, because none is needed — a deck
/// with no theory list keeps every row as `live`, so "a deck without a plan counts in full"
/// falls out of this predicate rather than needing a clause.
///
/// Spelled against the alias `dc`, which every builder below binds to `deck_cards`.
///
/// **It is not the same kind of value as `deck::LIVE` or `deck_theory::LIVE`, which share its
/// name**, and three files now see both. Those two are `crate::schema::DECK_VARIANTS[0]` — the
/// bare variant *value* `live`, bound as a query parameter. This one is a whole **predicate**,
/// interpolated into a SQL string. Both are `&'static str`, so binding this as a parameter (it
/// would match no row) or interpolating one of those (it would be a syntax error, on a good
/// day) is a mistake nothing but the reading catches.
pub const LIVE: &str = "dc.variant = 'live'";

/// The grouped row source — a `FROM` fragment aliased as the caller spells it.
///
/// Off, the table. On, a subquery emitting **every column the table has**, so the caller's
/// `WHERE`, `ORDER BY`, price expression and `LEFT JOIN cards` are untouched — **plus one the
/// table does not have**. `deck_count` is the derived arm's alone, and `collection_entries` has
/// no column for it: that is exactly why `crate::collection` picks `e.deck_count` or the
/// literal `NULL` per mode rather than naming it unconditionally. A caller who read "the same
/// columns" and wrote `e.deck_count` straight would get `no such column` in the **hand-kept**
/// mode only — the half of the switch that a derived-mode test never reaches.
///
/// `min(dc.id) AS id` is unique per group because the groups partition disjoint sets of rows,
/// which is all a React key and a virtualiser need. **It is not a `collection_entries.id`** —
/// which is exactly why the five collection writes refuse while this is on: they address rows
/// by primary key, and the reader's hidden hand-built rows are still on disk.
///
/// **`set_code` and `collector_number` are bare columns in an aggregate.** They sit outside the
/// `GROUP BY` with more than one aggregate function present, so SQLite's `min`/`max`
/// bare-column rule does not apply and each is taken from an arbitrary row of its group. That
/// is harmless here by construction rather than by luck: `deck_cards` denormalises both from
/// the one `cards` row its `card_id` names, so every row of a group carries the same pair and
/// the arbitrary choice cannot be observed. A column that is *not* constant per `card_id` may
/// not be added to this list the same way.
pub fn rows(conn: &Connection, alias: &str) -> String {
    if !crate::deck_driven::stored(conn) {
        return format!("collection_entries {alias}");
    }
    format!(
        "(SELECT min(dc.id) AS id,
                 dc.card_id AS card_id,
                 dc.set_code AS set_code,
                 dc.collector_number AS collector_number,
                 dc.lang AS lang,
                 coalesce(dc.finish, 'nonfoil') AS finish,
                 NULL AS condition,
                 NULL AS condition_original,
                 sum(dc.quantity) AS quantity,
                 0 AS tradelist_quantity,
                 count(DISTINCT dc.deck_id) AS deck_count,
                 NULL AS purchase_price,
                 NULL AS purchase_currency,
                 NULL AS acquired_at,
                 NULL AS acquisition_source,
                 NULL AS serial_number,
                 0 AS altered,
                 0 AS signed,
                 0 AS proxy,
                 0 AS misprint,
                 NULL AS grading,
                 '[]' AS tags,
                 NULL AS notes,
                 max(dc.needs_review) AS needs_review,
                 min(dc.created_at) AS created_at,
                 max(dc.updated_at) AS updated_at
            FROM deck_cards dc
           WHERE {LIVE}
           GROUP BY dc.card_id, coalesce(dc.finish, 'nonfoil'), dc.lang) {alias}"
    )
}

/// `EXISTS (…)` — does the reader own this printing at all?
///
/// `card_col` is the column or literal holding the printing id, spelled by the caller
/// (`c.id`, `'p1'`). The derived arm reads `deck_cards` directly through
/// `idx_deck_cards_card`; there is no `GROUP BY` because the question is existence.
pub fn owns_printing(conn: &Connection, card_col: &str) -> String {
    if crate::deck_driven::stored(conn) {
        format!("EXISTS (SELECT 1 FROM deck_cards dc WHERE dc.card_id = {card_col} AND {LIVE})")
    } else {
        format!("EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = {card_col})")
    }
}

/// Copies of one printing, every finish and language together. `0` when none.
pub fn copies_of_printing(conn: &Connection, card_col: &str) -> String {
    if crate::deck_driven::stored(conn) {
        format!(
            "coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                        WHERE dc.card_id = {card_col} AND {LIVE}), 0)"
        )
    } else {
        format!(
            "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                        WHERE e.card_id = {card_col}), 0)"
        )
    }
}

/// Copies of every printing of one oracle card — a Bolt is a Bolt. `0` when none.
pub fn copies_of_oracle(conn: &Connection, oracle_col: &str) -> String {
    if crate::deck_driven::stored(conn) {
        format!(
            "coalesce((SELECT sum(dc.quantity) FROM deck_cards dc
                         JOIN cards k ON k.id = dc.card_id
                        WHERE k.oracle_id = {oracle_col} AND {LIVE}), 0)"
        )
    } else {
        format!(
            "coalesce((SELECT sum(e.quantity) FROM collection_entries e
                         JOIN cards k ON k.id = e.card_id
                        WHERE k.oracle_id = {oracle_col}), 0)"
        )
    }
}

/// The facet index's `owned` dimension — one `cards.rowid` per card the reader owns.
///
/// A whole statement rather than a fragment, because [`crate::index::CardIndex::rebuild_owned`]
/// prepares it as one. The join reads `cards`' primary-key index for the rowid and never the
/// row, in both arms.
pub fn owned_rowids(conn: &Connection) -> String {
    if crate::deck_driven::stored(conn) {
        format!(
            "SELECT DISTINCT c.rowid FROM deck_cards dc
               JOIN cards c ON c.id = dc.card_id
              WHERE {LIVE}"
        )
    } else {
        "SELECT DISTINCT c.rowid FROM collection_entries e JOIN cards c ON c.id = e.card_id"
            .to_owned()
    }
}

/// `crate::sync::with_write`, plus the facet index's `owned` rebuild on success.
///
/// Only on success. A refusal — [`crate::db::BUSY`], a `GONE`, a rejected quantity — changed
/// nothing, and re-reading after one would be a copy of the whole index to arrive at the same
/// answer.
///
/// Moved here from `crate::collection` when the source became switchable: its three callers
/// are now a collection write, [`crate::reset::collection_clear`], and the setting itself,
/// and the thing they have in common is this module rather than that one.
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

/// The same, for a **deck** write — which moves what the reader owns only while the
/// collection is derived from the decks.
///
/// Rebuilding the dimension after every deck edit in the hand-kept mode would be a full index
/// clone for nothing, and *not* rebuilding it in the derived mode is the search Owned facet
/// answering from before the edit with nothing on screen to notice. So the wrapper asks.
///
/// The flag is read after the write rather than before, on the read pool, so it cannot
/// contend with the write that has already finished. Nothing a deck write does can change it.
///
/// **Thirteen deck commands go through this**, and they are the ones that can move
/// `deck_cards.quantity`, `.variant` or `.card_id` — every card write, plus `deck_update`
/// (which carries the theory move), `deck_delete`, `deck_duplicate`, `deck_category_delete`
/// and both halves of undo. `deck_meta::set_category_active` deliberately does not: see the
/// comment there.
pub(crate) fn with_write_owned_if_derived<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);
    if answer.is_ok() && crate::deck_driven::stored(&crate::sync::lock_db_read(state)) {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema;

    /// Three decks, and **the hand-built collection that matches their live lists copy for
    /// copy**: 4 regular and 1 foil Sol Ring, which is exactly what the `live` rows sum to.
    /// `p2` gets no collection row, because deck 3 only ever *plans* it — a theory list is not
    /// cards the reader has, on either side of the switch.
    ///
    /// Both sources in one database is what lets a test ask one builder the same question
    /// twice and compare the two numbers, which is the only measurement that can catch the arms
    /// drifting apart. It also turns every ON-arm assertion below into a second claim: that the
    /// derived arm is **blind** to these rows. (Until 2026-08-22 this comment promised the
    /// collection and the fixture inserted none, so the hand-kept arm of all four direct
    /// builders was unexecuted anywhere in the module that owns the rule.)
    ///
    /// `cards` is seeded here because a worktree database has never synced — and these rows
    /// are torn down with the connection, so no later measurement is made a fiction by them.
    fn db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::migrate(&conn).unwrap();
        conn.execute_batch(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                                rarity,finishes,prices,raw)
             VALUES ('p1','o1','Sol Ring','cmr','472','en','normal','uncommon',
                     '[\"nonfoil\",\"foil\"]','{}','{}'),
                    ('p2','o1','Sol Ring','ltr','300','en','normal','uncommon',
                     '[\"nonfoil\"]','{}','{}');

             INSERT INTO decks (id, name, created_at, updated_at)
                  VALUES (1,'Atraxa',0,0), (2,'Krenko',0,0), (3,'Plan only',0,0);
             INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
                  VALUES (10,1,'Ramp','main',1,0,0,0),
                         (11,1,'Maybeboard','maybe',0,1,0,0),
                         (12,2,'Ramp','main',1,0,0,0),
                         (13,3,'Ramp','main',1,0,0,0);
             INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, finish,
                                     created_at, updated_at)
                  VALUES (1,10,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (1,11,'live','p1','cmr','472','en','Sol Ring',2,NULL,0,0),
                         (1,10,'live','p1','cmr','472','en','Sol Ring',1,'foil',0,0),
                         (2,12,'live','p1','cmr','472','en','Sol Ring',1,NULL,0,0),
                         (3,13,'theory','p2','ltr','300','en','Sol Ring',4,NULL,0,0);

             INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, created_at, updated_at)
                  VALUES ('p1','cmr','472','en','nonfoil','NM',4,0,0),
                         ('p1','cmr','472','en','foil','NM',1,0,0);",
        )
        .unwrap();
        conn
    }

    /// `sum(quantity)` for one printing+finish+lang out of whichever source is live.
    fn copies(conn: &Connection, card_id: &str, finish: &str) -> i64 {
        let sql = format!(
            "SELECT coalesce(sum(e.quantity), 0) FROM {}
              WHERE e.card_id = ?1 AND e.finish = ?2",
            rows(conn, "e")
        );
        conn.query_row(&sql, rusqlite::params![card_id, finish], |r| r.get(0))
            .unwrap()
    }

    /// One scalar out of a fragment builder, in whichever mode the connection is in. `EXISTS`
    /// answers `0` or `1`, so the one helper serves all four of them.
    fn scalar(conn: &Connection, expr: &str) -> i64 {
        conn.query_row(&format!("SELECT {expr}"), [], |r| r.get(0))
            .unwrap()
    }

    /// The rowids the facet index's `owned` dimension would light up, either way round.
    fn rowids(conn: &Connection) -> Vec<i64> {
        conn.prepare(&owned_rowids(conn))
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    #[test]
    fn off_it_is_the_table() {
        let conn = db();
        assert_eq!(rows(&conn, "e"), "collection_entries e");
    }

    // ---------------------------------------------------------------------------------
    // Parity — every builder run in **both** modes against the one database.
    //
    // The fixture's hand-built rows are its live deck rows' exact equivalent, so each of these
    // is one number asked twice. Two different answers is the two arms having drifted, and
    // that is a failure no string comparison can see: `off_it_is_the_table` above would go on
    // passing through any amount of it. They are also what executes the hand-kept arm at all.
    // ---------------------------------------------------------------------------------

    #[test]
    fn the_grouped_source_answers_the_same_in_both_modes() {
        let conn = db();
        assert_eq!(copies(&conn, "p1", "nonfoil"), 4, "hand kept");
        assert_eq!(copies(&conn, "p1", "foil"), 1, "hand kept");
        assert_eq!(copies(&conn, "p2", "nonfoil"), 0, "hand kept");

        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(copies(&conn, "p1", "nonfoil"), 4, "derived");
        assert_eq!(copies(&conn, "p1", "foil"), 1, "derived");
        assert_eq!(copies(&conn, "p2", "nonfoil"), 0, "derived");
    }

    #[test]
    fn owns_printing_answers_the_same_in_both_modes() {
        let conn = db();
        let ask = |c: &Connection, card: &str| scalar(c, &owns_printing(c, &format!("'{card}'")));
        assert_eq!(ask(&conn, "p1"), 1, "hand kept");
        assert_eq!(
            ask(&conn, "p2"),
            0,
            "hand kept: never acquired, only planned"
        );

        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(ask(&conn, "p1"), 1, "derived");
        assert_eq!(
            ask(&conn, "p2"),
            0,
            "derived: a theory row is not a card in hand"
        );
    }

    #[test]
    fn copies_of_printing_answers_the_same_in_both_modes() {
        let conn = db();
        let ask =
            |c: &Connection, card: &str| scalar(c, &copies_of_printing(c, &format!("'{card}'")));
        assert_eq!(ask(&conn, "p1"), 5, "hand kept: 4 regular and 1 foil");
        assert_eq!(ask(&conn, "p2"), 0, "hand kept");

        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(ask(&conn, "p1"), 5, "derived");
        assert_eq!(ask(&conn, "p2"), 0, "derived");
    }

    /// Both printings share `o1`, so this is also the assertion that neither arm double-counts
    /// the join: `p2` contributes nothing on either side, for two different reasons.
    #[test]
    fn copies_of_oracle_answers_the_same_in_both_modes() {
        let conn = db();
        assert_eq!(
            scalar(&conn, &copies_of_oracle(&conn, "'o1'")),
            5,
            "hand kept"
        );
        assert_eq!(
            scalar(&conn, &copies_of_oracle(&conn, "'o2'")),
            0,
            "hand kept"
        );

        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(
            scalar(&conn, &copies_of_oracle(&conn, "'o1'")),
            5,
            "derived"
        );
        assert_eq!(
            scalar(&conn, &copies_of_oracle(&conn, "'o2'")),
            0,
            "derived"
        );
    }

    /// Two hand-built rows for one printing against three live deck rows for it, and one rowid
    /// out of both — `DISTINCT` is doing the same work on each side.
    #[test]
    fn owned_rowids_answers_the_same_in_both_modes() {
        let conn = db();
        let p1: i64 = conn
            .query_row("SELECT rowid FROM cards WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rowids(&conn), vec![p1], "hand kept");

        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(rowids(&conn), vec![p1], "derived");
    }

    /// Three live rows of the regular printing across two decks — one of them in an
    /// **inactive** category, which counts, because the reader still has the cards.
    #[test]
    fn on_it_sums_every_live_row_including_inactive_categories() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(copies(&conn, "p1", "nonfoil"), 4);
    }

    /// A theory row is a plan, not a card the reader has.
    #[test]
    fn on_it_excludes_theory() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(copies(&conn, "p2", "nonfoil"), 0);
    }

    /// `deck_cards.finish` is NULL for the regular copy and the collection spells it
    /// `nonfoil`. Binding the NULL through would make every regular line read zero.
    #[test]
    fn on_a_foil_and_a_regular_copy_are_two_rows() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        assert_eq!(copies(&conn, "p1", "nonfoil"), 4);
        assert_eq!(copies(&conn, "p1", "foil"), 1);
    }

    #[test]
    fn on_deck_count_is_the_decks_the_printing_appears_in() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let sql = format!(
            "SELECT e.deck_count FROM {} WHERE e.card_id = 'p1' AND e.finish = 'nonfoil'",
            rows(&conn, "e")
        );
        let n: i64 = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2, "two decks hold the regular printing");
    }

    #[test]
    fn on_condition_is_null_rather_than_an_invented_nm() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let sql = format!(
            "SELECT e.condition FROM {} WHERE e.card_id = 'p1' AND e.finish = 'nonfoil'",
            rows(&conn, "e")
        );
        let c: Option<String> = conn.query_row(&sql, [], |r| r.get(0)).unwrap();
        assert_eq!(c, None);
    }

    /// The whole point of §2a: the grouped source and the correlated fragment are two
    /// spellings of one rule, and two spellings is how a rule drifts.
    #[test]
    fn the_two_shapes_agree_on_the_same_database() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();

        let grouped: i64 = conn
            .query_row(
                &format!(
                    "SELECT coalesce(sum(e.quantity), 0) FROM {} WHERE e.card_id = 'p1'",
                    rows(&conn, "e")
                ),
                [],
                |r| r.get(0),
            )
            .unwrap();
        let direct: i64 = conn
            .query_row(
                &format!("SELECT {}", copies_of_printing(&conn, "'p1'")),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(grouped, direct, "5 copies of p1: 4 regular and 1 foil");
        assert_eq!(grouped, 5);
    }

    #[test]
    fn on_owns_printing_is_true_for_a_live_card_and_false_for_a_theory_one() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let ask = |card: &str| -> bool {
            conn.query_row(
                &format!("SELECT {}", owns_printing(&conn, &format!("'{card}'"))),
                [],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert!(ask("p1"));
        assert!(!ask("p2"), "a theory row is not a card the reader has");
    }

    #[test]
    fn on_copies_of_oracle_crosses_printings() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let n: i64 = conn
            .query_row(
                &format!("SELECT {}", copies_of_oracle(&conn, "'o1'")),
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(n, 5, "p2's four copies are theory and do not count");
    }

    #[test]
    fn on_owned_rowids_lists_the_live_cards_only() {
        let conn = db();
        crate::deck_driven::store(&conn, true).unwrap();
        let mut stmt = conn.prepare(&owned_rowids(&conn)).unwrap();
        let got: Vec<i64> = stmt
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        let p1: i64 = conn
            .query_row("SELECT rowid FROM cards WHERE id = 'p1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(got, vec![p1]);
    }

    /// The wrapper's whole question, on both answers it can get.
    ///
    /// Asserted on the published `Arc`'s **identity**, `collection.rs`'s
    /// `a_write_that_lands_refreshes_the_owned_facet_and_one_that_is_refused_does_not`'s
    /// device for its reason: neither write here changes a `collection_entries` row, so the
    /// `owned` bits are the same either way and a count is blind to whether the ~1 MB copy
    /// was made at all. A new `Arc` is the only visible trace of it.
    #[test]
    fn a_deck_write_refreshes_the_owned_facet_only_while_the_collection_is_derived() {
        let state = crate::index::fixtures::state_with_seeded_cards("collection-source-derived");
        crate::index::lifecycle::build_now(&state).unwrap();

        let hand_kept = crate::index::lifecycle::current(&state).unwrap();
        with_write_owned_if_derived(&state, |_| Ok(())).unwrap();
        let after_off = crate::index::lifecycle::current(&state).unwrap();
        assert!(
            Arc::ptr_eq(&hand_kept, &after_off),
            "a deck write moves nothing the reader owns while the collection is hand kept"
        );

        crate::sync::with_write(&state, |c| crate::deck_driven::store(c, true)).unwrap();
        let derived = crate::index::lifecycle::current(&state).unwrap();
        with_write_owned_if_derived(&state, |_| Ok(())).unwrap();
        let after_on = crate::index::lifecycle::current(&state).unwrap();
        assert!(
            !Arc::ptr_eq(&derived, &after_on),
            "with the collection derived from the decks, a deck write is an ownership change"
        );
    }
}
