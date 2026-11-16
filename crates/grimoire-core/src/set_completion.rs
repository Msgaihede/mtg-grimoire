//! How much of each set the reader owns — the home page's Set completion widget.
//!
//! **One grouped read and no table of its own.** Every figure is derived at read time from the
//! collection and two corpus tables, `cards` and `sets`, so there is nothing to keep in step and
//! nothing a sync can leave stale. Rust answers the counts; which sets to show, in what order and
//! what "complete" means is the widget's (TypeScript's) — the crate's facts/conclusions line.
//!
//! # What is counted
//!
//! * **"Owned" is any copy, anywhere.** The owned printings come from
//!   [`crate::collection_source::copies_by_printing_and_finish`] under
//!   [`Availability::Everything`], the fragment every reader outside the deck builder asks — so a
//!   copy in a binder, a deck's group or `Recently removed` counts, in any finish, language or
//!   condition. A set is a question about cardboard the reader has, not about where it is filed.
//! * **Digital printings are not excluded**, because the collection does not exclude them:
//!   `crate::collection` forces `paper_only` off, on the rule that the reader owns what the reader
//!   owns. A set the collection holds a card of is a set this answers.
//! * **The unit is a collector-number *slot*, not a printing.** Two finishes of one card are one
//!   slot, which is the obvious half. The less obvious half is the variants, and it is decided
//!   here rather than left to whatever `CAST` happens to do:
//!
//! # Variants beyond the printed run
//!
//! `size` is Scryfall's `printed_size` — the `/280` printed at a card's foot (corpus schema 4).
//! Plenty of printings in a set carry collector numbers outside that run: extended-art and
//! showcase cards numbered `281`–`400`, lettered variants like `123a`, star-suffixed ones like
//! `12★`, and prefixed ones like `★12` or `A-12`. With a size known:
//!
//! * a number is counted as the slot its **leading digits** name, when it has leading digits and
//!   that slot is inside `1..=size` — so `123a` and `12★` fill slots 123 and 12, **the same slots
//!   `123` and `12` fill**, and owning both the plain and the variant printing of one slot counts
//!   it once. That is what keeps `owned <= size` true by construction, which a completion bar needs;
//! * a number with **no** leading digit (`★12`, `A-12`, `S1`) names no slot of the printed run and
//!   is not counted, and nor is a number past the run (`281` in a set of 280).
//!
//! SQLite's `CAST('123a' AS INTEGER)` is 123 and `CAST('★12' AS INTEGER)` is 0, so the slot is that
//! cast, guarded by `GLOB '[0-9]*'` so a `0` from a non-numeric string can never be mistaken for a
//! number (and `BETWEEN 1 AND size` drops a literal `0` anyway).
//!
//! **With no size, every distinct collector number counts**, verbatim. That is the corpus that has
//! not fetched `/sets` since the column arrived, and a set Scryfall publishes no printed run for.
//! There is no run to be inside, and a count of what is held is still true; the widget draws no
//! bar for a `null` size.
//!
//! **A set whose every owned printing is outside the run is still answered, with `owned: 0`.**
//! The reader does hold a card of that set, and the contract is "every set the collection holds a
//! card of"; a showcase-only set reading `0 / 280` is the honest sentence, where dropping it would
//! make a set they own a card of disappear from the list.
//!
//! # The whole set, beside the printed run (issue #1692)
//!
//! **Scryfall stopped publishing `printed_size` with Phyrexia: All Will Be One** (February 2023),
//! because the cards stopped printing a denominator: on `/sets` of 2026-11-16, 169 of 1,068 sets
//! carried one and none released after `one` did. So `size` is `null` for every set of the last
//! few years, and a widget that could measure only against it drew no percentage for any of them
//! and sorted them last — under every row the card had room for. Adding a card from a new set
//! moved nothing a reader could see, and adding a showcase or a Commander reprint of an old one
//! (numbered past its run: `voc`'s printed size is 38 of 188 numbers) moved nothing either.
//!
//! **No main run is derived for a set without a size, deliberately.** Where the variants begin is
//! a different number in every set — `dsk`'s first booster-fun printing is 302, `blb`'s is 282 with
//! plain cards numbered after it, `fdn`'s is 292 with a starter collection after that — so any rule
//! would be a guess written down as a fact. What the corpus *does* know exactly is the set whole,
//! so this answers that beside the run and lets the widget choose:
//!
//! * **`total`** — every distinct collector number `cards` holds for the set, variants, prefixed
//!   and lettered numbers and every language's own numbers included. Never zero for an answered
//!   set: the printing that made it answered is one of them.
//! * **`owned_all`** — how many of those the reader holds a copy of, every number verbatim, so
//!   `owned_all <= total` by construction for the reason `owned <= size` is.
//!
//! Two more facts ride along for the widget's settings, neither of them a conclusion: **`set_type`**
//! (`sets.set_type` — `expansion`, `token`, `promo`, …; `null` where `sets` does not list the set)
//! and **`changed_at`**, the latest `updated_at` among the reader's copies of the set (Unix seconds),
//! which is what puts the set a reader just added to at the top of a *Recently changed* order.

use crate::collection_source::{self, Availability};
use rusqlite::Connection;
use serde::Serialize;

/// One set the collection holds at least one card of.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCompletion {
    /// Scryfall's set code, lower case — `cards.set_code`.
    pub set_code: String,
    /// `sets.name`, falling back to the printing's own `cards.set_name` and then to the code, so a
    /// set `sets` does not list (a corpus that has not fetched `/sets`) still has something to be
    /// called.
    pub name: String,
    /// `YYYY-MM-DD` — the set's own date where `sets` has one, else the earliest printing's.
    pub released_at: Option<String>,
    /// Distinct slots owned — see the module doc for exactly what a slot is.
    pub owned: i64,
    /// Scryfall's `printed_size`, or `None` where it is unknown — every set since early 2023.
    pub size: Option<i64>,
    /// Distinct collector numbers held, **every number verbatim** — variants and numbers past the
    /// printed run included. Always `<= total`.
    pub owned_all: i64,
    /// Every distinct collector number the corpus's `cards` holds for this set: the set whole,
    /// variants and all. Always at least `1` for an answered set.
    pub total: i64,
    /// `sets.set_type` (`expansion`, `core`, `token`, `promo`, …), or `None` where `sets` does not
    /// list the set.
    pub set_type: Option<String>,
    /// Unix seconds of the latest change to any of the reader's copies of this set — the largest
    /// `collection_entries.updated_at` among them.
    pub changed_at: i64,
}

/// The statement, with the owned-copies fragment spliced in.
///
/// **`WITH owned(card_id, finish, copies)`** names the fragment's three columns, because its
/// third is `sum(e.quantity)` and a CTE column list is the one way to give an unaliased
/// aggregate a name without editing the shared fragment. `copies > 0` is belt and braces — a
/// zero quantity deletes its row since schema v24 — and costs nothing.
///
/// **`LEFT JOIN sets`**, so a set the corpus's `sets` table does not list is answered with a
/// fallback name and an unknown size rather than dropped. `s.*` beside a `GROUP BY h.set_code` is
/// well-defined because `sets.code` is the primary key: every row in a group joins the same set
/// row or none.
///
/// **`whole`** counts the set's collector numbers in `cards` for the held sets only, which
/// `idx_cards_set_cn` answers without reading a row. **`changed`** is the copies' latest
/// `updated_at` per set, read off `collection_entries` beside the fragment rather than through it,
/// because the fragment's three columns are shared and carry no time; it counts the same copies
/// (`quantity > 0` under [`Availability::Everything`], whose arm is empty). Each is one row per
/// set, so reading its column beside the `GROUP BY` is well-defined for the reason `s.*` is.
///
/// Newest set first and then by code, so the order is deterministic; the widget re-sorts by its
/// own `sort` pick either way.
fn statement(conn: &Connection) -> String {
    format!(
        "WITH owned(card_id, finish, copies) AS ({owned}),
         held AS (
             SELECT c.set_code AS set_code, c.collector_number AS cn,
                    c.set_name AS set_name, c.released_at AS released_at
               FROM owned o
               JOIN cards c ON c.id = o.card_id
              WHERE o.copies > 0
         ),
         whole AS (
             SELECT set_code, count(DISTINCT collector_number) AS total
               FROM cards
              WHERE set_code IN (SELECT set_code FROM held)
              GROUP BY set_code
         ),
         changed AS (
             SELECT c.set_code AS set_code, max(e.updated_at) AS at
               FROM collection_entries e
               JOIN cards c ON c.id = e.card_id
              WHERE e.quantity > 0
              GROUP BY c.set_code
         )
         SELECT h.set_code,
                coalesce(s.name, max(h.set_name), h.set_code),
                coalesce(s.released_at, min(h.released_at)),
                CASE WHEN s.printed_size IS NULL
                     THEN count(DISTINCT h.cn)
                     ELSE count(DISTINCT CASE
                              WHEN h.cn GLOB '[0-9]*'
                               AND CAST(h.cn AS INTEGER) BETWEEN 1 AND s.printed_size
                              THEN CAST(h.cn AS INTEGER) END)
                END,
                s.printed_size,
                count(DISTINCT h.cn),
                coalesce(w.total, count(DISTINCT h.cn)),
                s.set_type,
                coalesce(ch.at, 0)
           FROM held h
           LEFT JOIN sets s ON s.code = h.set_code
           LEFT JOIN whole w ON w.set_code = h.set_code
           LEFT JOIN changed ch ON ch.set_code = h.set_code
          GROUP BY h.set_code
          ORDER BY coalesce(s.released_at, min(h.released_at)) DESC, h.set_code",
        owned = collection_source::copies_by_printing_and_finish(conn, Availability::Everything)
    )
}

/// Every set the collection holds a card of, with how much of it is owned.
pub fn set_completion_of(conn: &Connection) -> Result<Vec<SetCompletion>, String> {
    let mut stmt = conn.prepare(&statement(conn)).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SetCompletion {
                set_code: r.get(0)?,
                name: r.get(1)?,
                released_at: r.get(2)?,
                owned: r.get(3)?,
                size: r.get(4)?,
                owned_all: r.get(5)?,
                total: r.get(6)?,
                set_type: r.get(7)?,
                changed_at: r.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    /// A pair with two sets, a third set `sets` does not list, and printings covering every
    /// collector-number shape the module doc names. Nothing is owned yet.
    fn conn() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "INSERT INTO sets (code, name, released_at, printed_size, set_type) VALUES
                 ('dom', 'Dominaria', '2018-04-27', 269, 'expansion'),
                 ('sld', 'Secret Lair Drop', '2019-12-02', NULL, 'box');",
        )
        .unwrap();
        for (id, set, cn) in [
            ("dom-1", "dom", "1"),
            ("dom-2", "dom", "2"),
            ("dom-2a", "dom", "2a"),
            ("dom-12s", "dom", "12★"),
            ("dom-star", "dom", "★12"),
            ("dom-270", "dom", "270"),
            ("dom-269", "dom", "269"),
            ("sld-1", "sld", "1"),
            ("sld-x", "sld", "★7"),
            ("unl-1", "zzz", "5"),
        ] {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number,
                                    lang, layout, released_at, raw)
                 VALUES (?1, 'o-' || ?1, ?1, ?2, 'Set ' || ?2, ?3, 'en', 'normal', '2020-01-01', '{}')",
                params![id, set, cn],
            )
            .unwrap();
        }
        conn
    }

    /// One owned copy of `card_id` in `finish`, filed at the root.
    fn own(conn: &Connection, card_id: &str, finish: &str) {
        own_at(conn, card_id, finish, 0);
    }

    /// [`own`], last changed at `updated_at` (Unix seconds).
    fn own_at(conn: &Connection, card_id: &str, finish: &str, updated_at: i64) {
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, created_at, updated_at)
             VALUES (?1, 'x', '0', 'en', ?2, 'NM', 1, 0, ?3)",
            params![card_id, finish, updated_at],
        )
        .unwrap();
    }

    fn find<'a>(rows: &'a [SetCompletion], code: &str) -> Option<&'a SetCompletion> {
        rows.iter().find(|r| r.set_code == code)
    }

    #[test]
    fn a_set_with_nothing_owned_is_absent_and_an_empty_collection_answers_nothing() {
        let conn = conn();
        assert!(set_completion_of(&conn).unwrap().is_empty());

        own(&conn, "dom-1", "nonfoil");
        let rows = set_completion_of(&conn).unwrap();
        assert_eq!(rows.len(), 1, "sld and zzz hold nothing the reader owns");
        assert_eq!(
            rows[0],
            SetCompletion {
                set_code: "dom".into(),
                name: "Dominaria".into(),
                released_at: Some("2018-04-27".into()),
                owned: 1,
                size: Some(269),
                owned_all: 1,
                total: 7,
                set_type: Some("expansion".into()),
                changed_at: 0,
            }
        );
    }

    /// Finishes of one printing are one slot, and a lettered or star-suffixed variant fills the
    /// slot its leading digits name — never a second one.
    #[test]
    fn a_slot_is_counted_once_across_finishes_and_suffixed_variants() {
        let conn = conn();
        own(&conn, "dom-2", "nonfoil");
        own(&conn, "dom-2", "foil");
        own(&conn, "dom-2a", "nonfoil");
        own(&conn, "dom-12s", "foil");
        let dom = set_completion_of(&conn).unwrap();
        let dom = find(&dom, "dom").unwrap();
        assert_eq!(dom.owned, 2, "slots 2 and 12, nothing else");
        assert_eq!(
            dom.owned_all, 3,
            "the whole set counts `2`, `2a` and `12★` as the three numbers they are"
        );
    }

    /// Numbers past the printed run and numbers with no leading digit are outside it — and a set
    /// whose only owned cards are out there is still listed, at zero.
    #[test]
    fn variants_beyond_the_printed_size_are_excluded_but_the_set_is_still_answered() {
        let conn = conn();
        own(&conn, "dom-270", "nonfoil");
        own(&conn, "dom-star", "nonfoil");
        let rows = set_completion_of(&conn).unwrap();
        let dom = find(&rows, "dom").expect("the reader holds a card of this set");
        assert_eq!(dom.owned, 0);
        assert_eq!(dom.size, Some(269));
        assert_eq!(
            (dom.owned_all, dom.total),
            (2, 7),
            "measured whole, the two variants are two of the set's seven numbers"
        );

        own(&conn, "dom-269", "nonfoil");
        let rows = set_completion_of(&conn).unwrap();
        assert_eq!(
            find(&rows, "dom").unwrap().owned,
            1,
            "the last slot of the run is inside it"
        );
    }

    /// With no printed size every distinct collector number counts, verbatim — including the
    /// ones a known size would have excluded.
    #[test]
    fn a_null_size_counts_every_collector_number_held() {
        let conn = conn();
        own(&conn, "sld-1", "nonfoil");
        own(&conn, "sld-x", "foil");
        let rows = set_completion_of(&conn).unwrap();
        let sld = find(&rows, "sld").unwrap();
        assert_eq!(sld.size, None);
        assert_eq!(sld.owned, 2);
        assert_eq!(
            (sld.owned_all, sld.total),
            (2, 2),
            "the whole set, held whole"
        );
    }

    /// A set `sets` does not list — a corpus that has never fetched `/sets` — is named from the
    /// printing and has an unknown size, rather than dropping out.
    #[test]
    fn a_set_the_sets_table_does_not_list_falls_back_to_the_printing() {
        let conn = conn();
        own(&conn, "unl-1", "nonfoil");
        let rows = set_completion_of(&conn).unwrap();
        assert_eq!(
            rows,
            [SetCompletion {
                set_code: "zzz".into(),
                name: "Set zzz".into(),
                released_at: Some("2020-01-01".into()),
                owned: 1,
                size: None,
                owned_all: 1,
                total: 1,
                set_type: None,
                changed_at: 0,
            }]
        );
    }

    /// A copy in a deck's group counts as much as one at the root: this is `Everything`.
    #[test]
    fn a_copy_filed_in_a_deck_group_counts() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO decks (id, name, format_key, created_at, updated_at)
                 VALUES (9, 'D', 'modern', 0, 0);
             INSERT INTO collection_folders (id, parent_id, name, kind, deck_id, sort_order,
                                             created_at, updated_at)
                 VALUES (50, NULL, 'D', 'deck', 9, 0, 0, 0);
             INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, folder_id, created_at, updated_at)
                 VALUES ('dom-1', 'dom', '1', 'en', 'nonfoil', 'NM', 1, 50, 0, 0);",
        )
        .unwrap();
        let rows = set_completion_of(&conn).unwrap();
        assert_eq!(find(&rows, "dom").unwrap().owned, 1);
    }

    /// Issue #1692: a set Scryfall publishes no printed size for — every set since early 2023 —
    /// is still measured whole. `total` is every number the corpus holds for it, the borderless
    /// printing past the main run included, so the widget has a denominator to draw.
    #[test]
    fn a_set_with_no_printed_size_is_measured_against_every_number_it_has() {
        let conn = conn();
        conn.execute_batch(
            "INSERT INTO sets (code, name, released_at, printed_size, set_type)
                 VALUES ('dsk', 'Duskmourn: House of Horror', '2024-09-27', NULL, 'expansion');",
        )
        .unwrap();
        for (id, cn) in [("dsk-1", "1"), ("dsk-2", "2"), ("dsk-302", "302")] {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number,
                                    lang, layout, released_at, raw)
                 VALUES (?1, 'o-' || ?1, ?1, 'dsk', 'Duskmourn', ?2, 'en', 'normal',
                         '2024-09-27', '{}')",
                params![id, cn],
            )
            .unwrap();
        }
        own(&conn, "dsk-302", "foil");
        own(&conn, "dom-1", "nonfoil");
        let rows = set_completion_of(&conn).unwrap();
        let dsk = find(&rows, "dsk").unwrap();
        assert_eq!(dsk.size, None);
        assert_eq!((dsk.owned_all, dsk.total), (1, 3));
        assert_eq!(dsk.set_type.as_deref(), Some("expansion"));
        assert_eq!(
            rows[0].set_code, "dsk",
            "and it is the newest set, so it is answered first"
        );
    }

    /// A collector number is one number of the set whatever language it is printed in, so a
    /// Japanese printing of `dom` 1 adds nothing to the whole and owning both is one number held.
    #[test]
    fn the_whole_set_is_counted_by_number_across_languages() {
        let conn = conn();
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number,
                                lang, layout, released_at, raw)
             VALUES ('dom-1-ja', 'o-dom-1', 'dom-1', 'dom', 'Set dom', '1', 'ja', 'normal',
                     '2020-01-01', '{}')",
            [],
        )
        .unwrap();
        own(&conn, "dom-1", "nonfoil");
        own(&conn, "dom-1-ja", "nonfoil");
        let rows = set_completion_of(&conn).unwrap();
        let dom = find(&rows, "dom").unwrap();
        assert_eq!((dom.owned, dom.owned_all, dom.total), (1, 1, 7));
    }

    /// `changed_at` is the latest change to any copy of the set, per set — what a *Recently
    /// changed* order reads to put the set a reader just added to first.
    #[test]
    fn changed_at_is_the_latest_change_to_a_copy_of_each_set() {
        let conn = conn();
        own_at(&conn, "dom-1", "nonfoil", 100);
        own_at(&conn, "dom-2", "nonfoil", 300);
        own_at(&conn, "sld-1", "nonfoil", 200);
        let rows = set_completion_of(&conn).unwrap();
        assert_eq!(find(&rows, "dom").unwrap().changed_at, 300);
        assert_eq!(find(&rows, "sld").unwrap().changed_at, 200);
    }

    /// The wire names the page reads — the half `ipc.test.ts`'s field parity cannot see, because
    /// it applies the camel step whether or not serde does.
    #[test]
    fn the_dto_serialises_under_the_names_the_page_reads() {
        let v = serde_json::to_value(SetCompletion {
            set_code: "dom".into(),
            name: "Dominaria".into(),
            released_at: None,
            owned: 3,
            size: Some(269),
            owned_all: 4,
            total: 300,
            set_type: Some("expansion".into()),
            changed_at: 1_760_000_000,
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "setCode": "dom", "name": "Dominaria", "releasedAt": null, "owned": 3, "size": 269,
                "ownedAll": 4, "total": 300, "setType": "expansion", "changedAt": 1_760_000_000
            })
        );
    }
}
