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
//! not fetched `/sets` since the column arrived, a set Scryfall publishes no printed run for, and
//! the whole browser build (which never fills `sets`). There is no run to be inside, and a count
//! of what is held is still true; the widget draws no bar for a `null` size.
//!
//! **A set whose every owned printing is outside the run is still answered, with `owned: 0`.**
//! The reader does hold a card of that set, and the contract is "every set the collection holds a
//! card of"; a showcase-only set reading `0 / 280` is the honest sentence, where dropping it would
//! make a set they own a card of disappear from the list.

use crate::collection_source::{self, Availability};
#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// One set the collection holds at least one card of.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCompletion {
    /// Scryfall's set code, lower case — `cards.set_code`.
    pub set_code: String,
    /// `sets.name`, falling back to the printing's own `cards.set_name` and then to the code, so a
    /// set `sets` does not list (the browser build, or a corpus that has not fetched `/sets`) still
    /// has something to be called.
    pub name: String,
    /// `YYYY-MM-DD` — the set's own date where `sets` has one, else the earliest printing's.
    pub released_at: Option<String>,
    /// Distinct slots owned — see the module doc for exactly what a slot is.
    pub owned: i64,
    /// Scryfall's `printed_size`, or `None` where it is unknown.
    pub size: Option<i64>,
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
                s.printed_size
           FROM held h
           LEFT JOIN sets s ON s.code = h.set_code
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
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The Set completion widget's read. **Read-only** connection, blocking pool — as every read in
/// this app is, so the home page never queues behind a sync.
///
/// **No arguments**, and the page sends none: an argument object sent to a command that declares
/// only the managed state is a deserialisation error (`src/lib/ipc.test.ts` pins it).
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn set_completion(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<SetCompletion>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        set_completion_of(&crate::sync::lock_db_read(&state))
    })
    .await
    .map_err(|e| format!("set completion could not be read: {e}"))?
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
            "INSERT INTO sets (code, name, released_at, printed_size) VALUES
                 ('dom', 'Dominaria', '2018-04-27', 269),
                 ('sld', 'Secret Lair Drop', '2019-12-02', NULL);",
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
        conn.execute(
            "INSERT INTO collection_entries (card_id, set_code, collector_number, lang, finish,
                                             condition, quantity, created_at, updated_at)
             VALUES (?1, 'x', '0', 'en', ?2, 'NM', 1, 0, 0)",
            params![card_id, finish],
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
    }

    /// A set `sets` does not list — the browser build, or a corpus that has never fetched `/sets`
    /// — is named from the printing and has an unknown size, rather than dropping out.
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
        })
        .unwrap();
        assert_eq!(
            v,
            serde_json::json!({
                "setCode": "dom", "name": "Dominaria", "releasedAt": null, "owned": 3, "size": 269
            })
        );
    }
}
