//! The home page's **Coming soon** read — sets with printings announced for the next N days.
//!
//! **Over `cards`, not `sets`**, because the browser build never fills `sets`
//! (`sync::insert_sets` is gated off the wasm target) while every card row carries its own
//! `set_code`, `set_name` and `released_at`. `sets` is `LEFT JOIN`ed for the one thing only it
//! knows — a `set_type` — and where it has no row the layout filter is the whole rule.
//!
//! * **Which cards**: paper, released after today and on or before today + N, N clamped into
//!   `1..=365`; `search.rs`' `NON_CARD_LAYOUTS` (tokens, double-faced tokens, emblems, art
//!   series, front cards) left out. "Today" is SQLite's UTC `date('now')`, read once and bound
//!   into the window, so [`UpcomingSets::today`] is exactly the date the window was measured
//!   from.
//! * **Which sets**: only one **none of whose paper cards has released yet**, asked of every card
//!   the set has rather than of the window's — The List, Foundations Commander and Special Guests
//!   each gained future-dated printings on the dev corpus, and a card date alone would have
//!   announced a set from 2020 as coming soon. Asked of `cards` too, so it holds in a browser.
//!   Where `sets` has a row, `set_type` `token`, `promo`, `memorabilia` and `minigame` drop out
//!   as well; a row with no type is kept.
//! * **`previewed`** is the number the search draws for the set: its chip on `Any card`, every
//!   paper printing in the set's code, one per card (`search.rs`' `COLLAPSE_KEY`). A press on the
//!   row opens exactly that search, and the live pass read `461 seen` for one set beside a search
//!   saying `285 cards` (2026-09-26) — the set's 461 collector numbers were 285 cards and their
//!   showcase and borderless printings. So the window decides which sets are coming, and never
//!   what a set counts.
//! * **`in_decks`** is `new_printings`' defaults: decks that are not virtual, live and theory rows
//!   alike, basic lands left out through [`crate::new_printings::BASIC_LAND_LIKE`].
//!
//! **The window is found through a `rowid` subquery because the plain `WHERE` read every
//! printing out of `cards` while holding the one read-only connection every other read queues
//! on** — ~1.4 s against ~60 ms on the dev corpus's 118,610 printings, measured 2026-09-26
//! through `node:sqlite` 3.53.0 (a release build of SQLite, not the app's debug one), answers
//! identical.
//!
//! Connection in, DTO out, and no clock but SQLite's — so it answers in a browser as on the
//! desktop.

// Layouts that are not a card anyone plays — `search.rs`' ranking list, shared rather than
// copied, so a layout Scryfall adds is left out of the search's ranking and this window by one
// edit. It carries `front_card` as well as the four the widget's spec named. And the search's
// spelling of "the same card", which `previewed` counts with so it is the search's number.
use crate::search::{COLLAPSE_KEY, NON_CARD_LAYOUTS};
#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The longest window the read answers, in days — the widget offers 30, 90 and 365, and a
/// hand-edited `config` cannot ask for more.
const MAX_DAYS: i64 = 365;

/// `sets.set_type`s that are not a release a reader waits for, as an SQL list.
const NON_RELEASE_SET_TYPES: &str = "('token','promo','memorabilia','minigame')";

/// The read: the date it was measured from, and the sets.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingSets {
    /// SQLite's `date('now')`, `YYYY-MM-DD`, UTC — what the widget counts days from.
    pub today: String,
    /// Soonest first, then by code.
    pub sets: Vec<UpcomingSet>,
}

/// One set with printings inside the window.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpcomingSet {
    pub code: String,
    /// `cards.set_name`, or the code where no card in the window carries one.
    pub name: String,
    /// The set's earliest card date in the window, `YYYY-MM-DD`.
    pub released_at: String,
    /// The number the search draws for the set's chip on `Any card`: every paper printing of the
    /// set, **one per card** (`search.rs`' `COLLAPSE_KEY`) — so a showcase, a borderless or a
    /// second language of one card is not a second card, and a card of the set dated past the
    /// window still counts, as it does there.
    pub previewed: i64,
    /// Distinct oracle cards in the window that a deck which is not virtual already holds,
    /// basic lands left out.
    pub in_decks: i64,
}

/// The sets announced for the next `days` days, clamped into `1..=MAX_DAYS`.
pub fn upcoming_sets_for(conn: &Connection, days: i64) -> Result<UpcomingSets, String> {
    let days = days.clamp(1, MAX_DAYS);
    let today: String = conn
        .query_row("SELECT date('now')", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let window = format!("+{days} days");
    // **The window is a `rowid` subquery (the module doc has the figure).** Every column it reads
    // — `is_paper`, `released_at` and the rowid — is in `idx_cards_collapse`, so it scans that
    // index instead of `cards`, whose rows carry the `raw` blob, and only the printings inside the
    // window are read from the table. With the same terms in the outer `WHERE`, the planner walks
    // `idx_cards_set_cn` to satisfy the `GROUP BY` and looks every printing up. No `INDEXED BY`:
    // a corpus without the index scans `cards` once, which the plain `WHERE` costs anyway.
    //
    // **The released-set rule is a `HAVING`, once per set, and never a term in `upcoming`.** It
    // seeks `idx_cards_set_cn` on the set code and reads each of that set's cards until it meets a
    // released paper one: +9 ms at 90 days (63 → 72 ms, the module doc's corpus and build). As a
    // row term it ran that walk once per printing in the window instead — 2.5 s.
    //
    // `held` is `new_printings::feed`'s `held` CTE with that widget's defaults fixed:
    // every deck that is not virtual, both lists, basics out. `count(DISTINCT h.oracle_id)` is the
    // held cards among the window's — `held` is distinct, so the join never multiplies a row.
    //
    // **`previewed` is not asked of the window at all.** It is the search's own count for the
    // set's chip on `Any card` — every paper printing of the set, one per `COLLAPSE_KEY` — because
    // a press on the row opens exactly that search, and a row reading `461 seen` over a search
    // reading `285 cards` is one set counted two ways (the live pass, 2026-09-26: FRA's 461
    // collector numbers are 285 cards and their showcase and borderless printings). A correlated
    // subquery rather than an aggregate over `upcoming`, which would count only the window's
    // printings of the window's layouts; it is a result column, so it runs for the sets `HAVING`
    // keeps and seeks `idx_cards_set_cn` on the code the released-set rule has already walked.
    let sql = format!(
        "WITH upcoming AS (
             SELECT c.set_code AS set_code, c.set_name AS set_name,
                    c.released_at AS released_at, c.oracle_id AS oracle_id
               FROM cards c
               LEFT JOIN sets s ON s.code = c.set_code
              WHERE c.rowid IN (SELECT rowid FROM cards
                                 WHERE is_paper = 1
                                   AND released_at > ?1
                                   AND released_at <= date(?1, ?2))
                AND c.layout NOT IN {NON_CARD_LAYOUTS}
                AND coalesce(s.set_type, '') NOT IN {NON_RELEASE_SET_TYPES}
         ),
         held AS (
             SELECT DISTINCT c.oracle_id AS oracle_id
               FROM deck_cards dc
               JOIN decks d ON d.id = dc.deck_id
               JOIN cards c ON c.id = dc.card_id
              WHERE d.virtual_only = 0
                AND c.oracle_id IS NOT NULL AND c.oracle_id <> ''
                AND coalesce(c.type_line, '') NOT LIKE ?3
         )
         SELECT u.set_code,
                coalesce(max(u.set_name), u.set_code),
                min(u.released_at),
                (SELECT count(DISTINCT {COLLAPSE_KEY}) FROM cards c
                  WHERE c.set_code = u.set_code AND c.is_paper = 1),
                count(DISTINCT h.oracle_id)
           FROM upcoming u
           LEFT JOIN held h ON h.oracle_id = u.oracle_id
          GROUP BY u.set_code
          HAVING NOT EXISTS (SELECT 1 FROM cards o
                              WHERE o.set_code = u.set_code
                                AND o.is_paper = 1
                                AND o.released_at <= ?1)
          ORDER BY min(u.released_at) ASC, u.set_code ASC"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            params![today, window, crate::new_printings::BASIC_LAND_LIKE],
            |r| {
                Ok(UpcomingSet {
                    code: r.get(0)?,
                    name: r.get(1)?,
                    released_at: r.get(2)?,
                    previewed: r.get(3)?,
                    in_decks: r.get(4)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let sets = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(UpcomingSets { today, sets })
}

/// Coming soon's read. **Read-only** connection, blocking pool. `days` is narrowed here as well as
/// in TypeScript, because it arrives from a `config` a reader can hand-edit.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn upcoming_sets(
    state: tauri::State<'_, Arc<AppState>>,
    days: i64,
) -> Result<UpcomingSets, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        upcoming_sets_for(&crate::sync::lock_db_read(&state), days)
    })
    .await
    .map_err(|e| format!("the upcoming sets could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    // new_printings.rs:571-573 — the real pair, because the read joins `deck_cards` in the user
    // file to `cards` in the attached corpus.
    fn conn() -> Connection {
        crate::schema::memory_pair()
    }

    // new_printings.rs:597-615 (`printing`) — one paper printing, dated relative to SQLite's own
    // `date('now')` so a window is testable without a clock injected into the read. A negative
    // `days_ahead` is the past; zero is today. `type_line` and `lang` are set by UPDATE where a
    // test needs them, which keeps this at seven arguments.
    fn card(
        c: &Connection,
        id: &str,
        oracle: &str,
        set: &str,
        cn: &str,
        days_ahead: i64,
        layout: &str,
    ) {
        c.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, set_name, collector_number, lang,
                                layout, released_at, is_paper, type_line, raw)
             VALUES (?1, ?2, ?2, ?3, 'Set ' || upper(?3), ?4, 'en', ?5,
                     date('now', ?6), 1, 'Artifact', '{}')",
            params![id, oracle, set, cn, layout, format!("{days_ahead:+} days")],
        )
        .unwrap();
    }

    // new_printings.rs:619-633 (`deck`) — one deck and the one pile its cards are filed under.
    fn deck(c: &Connection, id: i64, name: &str, virtual_only: bool) {
        c.execute(
            "INSERT INTO decks (id, name, format_key, virtual_only, created_at, updated_at)
             VALUES (?1, ?2, 'commander', ?3, 0, 0)",
            params![id, name, virtual_only],
        )
        .unwrap();
        c.execute(
            "INSERT INTO deck_categories (id, deck_id, name, kind, is_active, sort_order,
                                          created_at, updated_at)
             VALUES (?1, ?1, 'Main deck', 'main', 1, 0, 0, 0)",
            params![id],
        )
        .unwrap();
    }

    // new_printings.rs:635-644 (`holds`) — one deck holding one printing, at `variant`.
    fn holds(c: &Connection, deck_id: i64, card_id: &str, qty: i64, variant: &str) {
        c.execute(
            "INSERT INTO deck_cards (deck_id, category_id, variant, card_id, set_code,
                                     collector_number, lang, name, quantity, created_at, updated_at)
             VALUES (?1, ?1, ?2, ?3, 'x', '1', 'en', ?3, ?4, 0, 0)",
            params![deck_id, variant, card_id, qty],
        )
        .unwrap();
    }

    fn codes(out: &UpcomingSets) -> Vec<&str> {
        out.sets.iter().map(|s| s.code.as_str()).collect()
    }

    /// **Both edges, and the clamp.** Today is not upcoming, the window's last day is, the day
    /// after it is not — and a hand-edited window is narrowed into `1..=365` rather than refused
    /// or passed through.
    #[test]
    fn the_window_is_after_today_up_to_its_last_day() {
        let c = conn();
        card(&c, "past", "o1", "old", "1", -5, "normal");
        card(&c, "today", "o2", "tdy", "1", 0, "normal");
        card(&c, "soon", "o3", "son", "1", 1, "normal");
        card(&c, "edge", "o4", "edg", "1", 90, "normal");
        card(&c, "late", "o5", "lat", "1", 91, "normal");
        assert_eq!(codes(&upcoming_sets_for(&c, 90).unwrap()), ["son", "edg"]);
        assert_eq!(codes(&upcoming_sets_for(&c, 89).unwrap()), ["son"]);
        assert_eq!(
            codes(&upcoming_sets_for(&c, 0).unwrap()),
            ["son"],
            "zero is one day"
        );
        assert_eq!(
            codes(&upcoming_sets_for(&c, -30).unwrap()),
            ["son"],
            "and so is a negative"
        );

        card(&c, "year", "o6", "yer", "1", 365, "normal");
        card(&c, "beyond", "o7", "bey", "1", 366, "normal");
        assert_eq!(
            codes(&upcoming_sets_for(&c, 99_999).unwrap()),
            ["son", "edg", "lat", "yer"],
            "a year at most"
        );
    }

    /// **Each excluded layout, and a printing that is not paper.** Only a real card can make a set
    /// coming soon, so a set of nothing but tokens is no set at all. **What the set then counts is
    /// the search's number** — see `previewed_is_the_number_the_search_draws_for_the_set` — which
    /// draws every paper printing in the set's own code on `Any card`, non-cards included; the
    /// digital one is left out of both.
    #[test]
    fn each_excluded_layout_and_a_digital_printing_are_left_out() {
        let c = conn();
        card(&c, "real", "o-real", "tdm", "1", 10, "normal");
        for (i, layout) in [
            "token",
            "double_faced_token",
            "emblem",
            "art_series",
            "front_card",
        ]
        .iter()
        .enumerate()
        {
            card(
                &c,
                &format!("x{i}"),
                &format!("o-x{i}"),
                "tdm",
                &format!("t{i}"),
                10,
                layout,
            );
        }
        card(&c, "arena", "o-arena", "tdm", "9", 10, "normal");
        c.execute("UPDATE cards SET is_paper = 0 WHERE id = 'arena'", [])
            .unwrap();
        card(&c, "tok", "o-tok", "ttdm", "1", 10, "token");

        let out = upcoming_sets_for(&c, 90).unwrap();
        assert_eq!(codes(&out), ["tdm"]);
        assert_eq!(
            out.sets[0].previewed, 6,
            "the real card and the five non-cards filed under its code, as the search draws them"
        );
    }

    /// **`set_type` decides only where `sets` has a row.** The browser build never fills `sets`,
    /// so there the layout filter is the whole rule; on the desktop the four non-release types
    /// drop out, and a row with no type is kept.
    #[test]
    fn a_sets_row_drops_the_four_non_release_types_and_no_row_drops_nothing() {
        let c = conn();
        for code in ["exp", "prm", "mem", "mng", "tkn", "unk"] {
            card(
                &c,
                &format!("{code}-1"),
                &format!("o-{code}"),
                code,
                "1",
                10,
                "normal",
            );
        }
        assert_eq!(
            codes(&upcoming_sets_for(&c, 90).unwrap()),
            ["exp", "mem", "mng", "prm", "tkn", "unk"],
            "no `sets` rows, nothing dropped — same day, so by code"
        );

        c.execute_batch(
            "INSERT INTO sets (code, name, set_type) VALUES
               ('exp', 'Expansion', 'expansion'),
               ('prm', 'Promos', 'promo'),
               ('mem', 'Memorabilia', 'memorabilia'),
               ('mng', 'Minigames', 'minigame'),
               ('tkn', 'Tokens', 'token'),
               ('unk', 'Unknown', NULL);",
        )
        .unwrap();
        assert_eq!(codes(&upcoming_sets_for(&c, 90).unwrap()), ["exp", "unk"]);
    }

    /// **`in_decks` is `new_printings`' defaults**: a card counts once however many printings or
    /// languages of it the set previews, a theory row counts, and a card held only by a virtual
    /// deck or a basic land does not. `previewed` counts cards, so neither a second language nor
    /// a showcase printing of one card is a second card.
    #[test]
    fn in_decks_counts_held_cards_once_and_skips_basics_and_virtual_decks() {
        let c = conn();
        card(&c, "old-ring", "o-ring", "lea", "1", -900, "normal");
        card(&c, "old-bird", "o-bird", "lea", "2", -900, "normal");
        card(&c, "old-forest", "o-forest", "lea", "3", -900, "normal");
        card(&c, "old-angel", "o-angel", "lea", "4", -900, "normal");
        card(&c, "new-ring", "o-ring", "tdm", "1", 20, "normal");
        card(&c, "new-ring-ja", "o-ring", "tdm", "1", 20, "normal");
        card(&c, "new-ring-show", "o-ring", "tdm", "301", 20, "normal");
        card(&c, "new-bird", "o-bird", "tdm", "2", 20, "normal");
        card(&c, "new-forest", "o-forest", "tdm", "3", 20, "normal");
        card(&c, "new-angel", "o-angel", "tdm", "4", 20, "normal");
        card(&c, "new-other", "o-other", "tdm", "5", 20, "normal");
        c.execute_batch(
            "UPDATE cards SET lang = 'ja' WHERE id = 'new-ring-ja';
             UPDATE cards SET type_line = 'Basic Land — Forest' WHERE oracle_id = 'o-forest';",
        )
        .unwrap();
        deck(&c, 1, "Atraxa", false);
        holds(&c, 1, "old-ring", 1, "live");
        holds(&c, 1, "old-forest", 10, "live");
        deck(&c, 2, "Proxies", true);
        holds(&c, 2, "old-bird", 1, "live");
        deck(&c, 3, "Plan", false);
        holds(&c, 3, "old-angel", 1, "theory");

        let out = upcoming_sets_for(&c, 90).unwrap();
        assert_eq!(codes(&out), ["tdm"]);
        assert_eq!(
            out.sets[0].previewed, 5,
            "Sol Ring, the bird, the Forest, the angel and the other — Sol Ring's Japanese and \
             showcase printings are Sol Ring"
        );
        assert_eq!(
            out.sets[0].in_decks, 2,
            "Sol Ring and Serra Angel; the bird is only in a virtual deck and the Forest is basic"
        );
    }

    /// **Soonest first, then by code; a set's date is its earliest card's; `today` is SQLite's
    /// UTC date, and a set with no name in `cards` answers its code.**
    #[test]
    fn sets_are_soonest_first_and_today_is_sqlite_s_date() {
        let c = conn();
        card(&c, "b1", "o1", "bbb", "1", 30, "normal");
        card(&c, "a1", "o2", "aaa", "1", 30, "normal");
        card(&c, "z1", "o3", "zzz", "1", 5, "normal");
        card(&c, "z2", "o4", "zzz", "2", 40, "normal");
        c.execute(
            "UPDATE cards SET set_name = NULL WHERE set_code = 'aaa'",
            [],
        )
        .unwrap();

        let out = upcoming_sets_for(&c, 90).unwrap();
        assert_eq!(codes(&out), ["zzz", "aaa", "bbb"]);
        let (today, in_five): (String, String) = c
            .query_row("SELECT date('now'), date('now', '+5 days')", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .unwrap();
        assert_eq!(out.today, today);
        assert_eq!(out.sets[0].released_at, in_five, "the earliest card's date");
        assert_eq!(out.sets[0].previewed, 2);
        assert_eq!(out.sets[0].name, "Set ZZZ");
        assert_eq!(
            out.sets[1].name, "aaa",
            "no set name falls back to the code"
        );
    }

    /// **A set is coming soon only while none of its paper cards has released.** The List,
    /// Foundations Commander and Special Guests each gained future-dated printings on the dev
    /// corpus, and a row for them would read as an unreleased set. The released card is outside
    /// the window, so only a rule over *every* card of the set can see it; a card dated today
    /// counts as released, and a digital printing released long ago does not.
    #[test]
    fn a_set_with_a_released_paper_card_is_not_coming_soon() {
        let c = conn();
        card(&c, "old-1", "o-old-1", "old", "1", -30, "normal");
        card(&c, "old-2", "o-old-2", "old", "2", 10, "normal");
        card(&c, "old-3", "o-old-3", "old", "3", 12, "normal");
        card(&c, "tdy-1", "o-tdy-1", "tdy", "1", 0, "normal");
        card(&c, "tdy-2", "o-tdy-2", "tdy", "2", 10, "normal");
        card(&c, "new-1", "o-new-1", "new", "1", 10, "normal");
        card(&c, "new-2", "o-new-2", "new", "2", 12, "normal");
        card(&c, "new-arena", "o-new-arena", "new", "A-1", -30, "normal");
        c.execute("UPDATE cards SET is_paper = 0 WHERE id = 'new-arena'", [])
            .unwrap();

        let out = upcoming_sets_for(&c, 90).unwrap();
        assert_eq!(codes(&out), ["new"], "only the wholly future set");
        assert_eq!(out.sets[0].previewed, 2);
    }

    /// **`previewed` is the number the search draws for that set**, because pressing the row opens
    /// exactly that search: the set's chip on `Any card`, collapsed to one row per card. So it is
    /// asked of [`crate::search::run_search`] here rather than restated — the live pass read
    /// `461 seen` beside a search saying `285 cards` for one set, where the difference was the
    /// set's showcase and borderless printings (2026-09-26, FRA). The fixture has what made the
    /// two disagree and what could still: a card in three printings, a second language of it, a
    /// second card, a card of the set dated **past** the window, which the search counts and the
    /// window does not reach, and a token in the set's own code, which the window's layout rule
    /// leaves out and the search on `Any card` does not.
    #[test]
    fn previewed_is_the_number_the_search_draws_for_the_set() {
        let c = conn();
        card(&c, "bolt-1", "o-bolt", "fra", "1", 10, "normal");
        card(&c, "bolt-showcase", "o-bolt", "fra", "301", 10, "normal");
        card(&c, "bolt-borderless", "o-bolt", "fra", "402", 10, "normal");
        card(&c, "bolt-ja", "o-bolt", "fra", "1", 10, "normal");
        card(&c, "ring-2", "o-ring", "fra", "2", 10, "normal");
        card(&c, "late-3", "o-late", "fra", "3", 200, "normal");
        // A token filed under the set's own code: the window's layout rule never lets it decide
        // that a set is coming, and the search on `Any card` still draws it.
        card(&c, "token-t1", "o-token", "fra", "T1", 10, "token");
        c.execute("UPDATE cards SET lang = 'ja' WHERE id = 'bolt-ja'", [])
            .unwrap();

        let out = upcoming_sets_for(&c, 90).unwrap();
        let search = crate::search::run_search(
            &c,
            &crate::search::SearchRequest {
                sets: Some(vec!["fra".into()]),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(codes(&out), ["fra"]);
        assert_eq!(
            search.total, 4,
            "the fixture is what it says: three cards however printed, and the token"
        );
        assert_eq!(out.sets[0].previewed, search.total);
    }

    /// An empty corpus is an ordinary answer — today, and no sets.
    #[test]
    fn nothing_announced_is_an_empty_list_not_an_error() {
        let c = conn();
        let out = upcoming_sets_for(&c, 90).unwrap();
        assert!(out.sets.is_empty());
        assert_eq!(out.today.len(), 10, "YYYY-MM-DD");
    }

    /// The wire names the page reads.
    #[test]
    fn upcoming_sets_serialise_under_the_names_the_page_reads() {
        let wire = serde_json::to_value(UpcomingSets {
            today: "2026-09-26".into(),
            sets: vec![UpcomingSet {
                code: "tdm".into(),
                name: "Tarkir: Dragonstorm".into(),
                released_at: "2026-10-08".into(),
                previewed: 79,
                in_decks: 3,
            }],
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "today": "2026-09-26",
                "sets": [{
                    "code": "tdm", "name": "Tarkir: Dragonstorm", "releasedAt": "2026-10-08",
                    "previewed": 79, "inDecks": 3
                }]
            })
        );
    }
}
