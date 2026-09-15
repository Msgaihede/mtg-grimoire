//! The cards this device opened most recently — the home page's **Recently viewed** widget.
//!
//! **[`crate::home`]'s shape with a list instead of a document**, and [`crate::nav`]'s two rules:
//! one `app_meta` row, a read that can never fail, and a write whose only refusal is a blank.
//!
//! * **The row holds ids and times and nothing else.** `[{ "cardId": …, "at": … }]`, newest first,
//!   each id once, at most [`MAX_RECENT`]. A card's *name* and *set* are joined off the corpus at
//!   read time rather than denormalised into the row, because `cards` is rebuilt on every sync and
//!   a stored name would be a second copy of a fact the corpus already holds — one that goes stale
//!   the day Scryfall corrects a name. What the join costs is that **a printing the corpus no
//!   longer holds is skipped** rather than drawn as a frame with nothing in it; the id stays in
//!   the row, and comes back the day the card does, which is `reconcile::sweep_orphans`' rule for
//!   a user table applied to a list nobody has to review.
//! * **Reading can never fail.** A missing row, a row that is not JSON, a row holding anything but
//!   a list of `{cardId, at}` — every one of them reads as *no cards*, and so does a corpus that
//!   cannot be queried. [`recent`] answers a bare `Vec` rather than a `Result`: the widget's empty
//!   state is exactly what a reader who has opened nothing sees, and there is nothing it could do
//!   with an error that is not that.
//! * **Writing moves a card to the front.** Opening a card already on the list takes its old entry
//!   out rather than leaving two, so the list is a set ordered by recency — which is what a tile
//!   row can draw without a key collision, and what a reader means by *recently*.
//!
//! **No clock in Rust.** `SystemTime::now()` panics on `wasm32-unknown-unknown` rather than
//! erroring, and this module is on the every-target half of the map, so the time is SQLite's own
//! `unixepoch()` — the clock every `created_at` in the schema is written from. [`record`] takes the
//! time as an argument so a test can say when; [`record_now`] is what both targets' commands call.
//!
//! **Not synced**, for [`crate::home`]'s reason: `app_meta` is in no `SYNCED_TABLES` entry, and
//! which cards were open on *this* screen is a fact about the screen rather than the collection.
//! No migration either — this is a key in schema v6's table.

#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// The `app_meta` key.
pub const K_RECENT_CARDS: &str = "recent_cards";

/// How many cards the list remembers, and the most [`recent`] will answer.
///
/// Three times the widget's largest `count` (8), so a reader who opens a card the corpus later
/// loses still has a full row of tiles behind it; small enough that the row stays a few kilobytes
/// and the join in [`recent`] is two dozen primary-key lookups.
pub const MAX_RECENT: usize = 24;

/// A blank id is a bug in the caller, not a card — [`crate::home`]'s `NO_ID`.
const NO_ID: &str = "A recently viewed card needs an id, and this one has none.";

/// One entry in the stored row, as written. **The row's shape, not the page's** — the page reads
/// [`RecentCard`], which is this joined with the corpus.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewed {
    /// The printing — `cards.id`, soft like every card id in a user table.
    pub card_id: String,
    /// Unix seconds of the most recent open.
    pub at: i64,
}

/// One recently opened card, as the home page draws it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCard {
    /// The printing that was opened.
    pub card_id: String,
    /// Its name, off the corpus at read time.
    pub name: String,
    /// Its set code, off the corpus at read time.
    pub set_code: String,
    /// Unix seconds of the most recent open.
    pub viewed_at: i64,
}

/// The stored list, newest first, deduplicated and capped — or empty.
///
/// **The normalisation runs on the read as well as the write**, because the row is not only ever
/// written by [`record`]: a hand-edit or another build can leave a duplicate or a blank id behind,
/// and a duplicate here is two tiles with one React key on the page. The first occurrence of an id
/// wins, since the list is newest first.
pub fn stored(conn: &Connection) -> Vec<Viewed> {
    let Some(list) = crate::app_meta::get_app_meta(conn, K_RECENT_CARDS)
        .and_then(|raw| serde_json::from_str::<Vec<Viewed>>(&raw).ok())
    else {
        return Vec::new();
    };
    let mut out: Vec<Viewed> = Vec::with_capacity(list.len().min(MAX_RECENT));
    for entry in list {
        if out.len() == MAX_RECENT {
            break;
        }
        if entry.card_id.trim().is_empty() || out.iter().any(|v| v.card_id == entry.card_id) {
            continue;
        }
        out.push(entry);
    }
    out
}

/// Remember that `card_id` was opened at `now`.
///
/// The card goes to the front and any older entry for it is taken out, then the list is cut to
/// [`MAX_RECENT`]. **Nothing checks the id against the corpus** — a card the corpus does not hold
/// is skipped at read time, which is the same answer without a query on the write path.
///
/// The one refusal is a blank id, in a sentence, before the row is touched.
pub fn record(conn: &Connection, card_id: &str, now: i64) -> Result<(), String> {
    if card_id.trim().is_empty() {
        return Err(NO_ID.to_owned());
    }
    let mut list = stored(conn);
    list.retain(|v| v.card_id != card_id);
    list.insert(
        0,
        Viewed {
            card_id: card_id.to_owned(),
            at: now,
        },
    );
    list.truncate(MAX_RECENT);
    let json = serde_json::to_string(&list)
        .map_err(|e| format!("could not remember the card you opened: {e}"))?;
    crate::app_meta::set_app_meta(conn, K_RECENT_CARDS, &json)
        .map_err(|e| format!("could not remember the card you opened: {e}"))
}

/// [`record`] at SQLite's `unixepoch()` — the call both targets' commands make.
///
/// The clock is asked of the database rather than of the process because `SystemTime::now()`
/// panics on wasm; see the module doc.
pub fn record_now(conn: &Connection, card_id: &str) -> Result<(), String> {
    let now: i64 = conn
        .query_row("SELECT unixepoch()", [], |r| r.get(0))
        .map_err(|e| format!("could not remember the card you opened: {e}"))?;
    record(conn, card_id, now)
}

/// The stored list joined with the corpus, in list order, skipping cards the corpus lacks.
///
/// **One statement for the whole list**: the ids go in as one bound JSON array and `json_each`
/// walks it, so each id is a primary-key lookup into `cards` and `j.key` — the array index — is
/// the order. That keeps the list's order without sorting in Rust, and it is why the `LIMIT` can
/// sit in the statement: a skipped card does not use up a place, so a widget asking for eight
/// tiles gets eight whenever the list holds eight the corpus knows.
///
/// `limit` is clamped to `1..=`[`MAX_RECENT`], `activity::recent`'s rule and for its reason: **the
/// low end is load-bearing**, because SQLite reads a negative `LIMIT` as no limit at all and a
/// `LIMIT 0` as no rows — a `0` from a page that had not finished reading its config would draw an
/// empty widget over a full list.
///
/// Infallible: a corpus with no `cards` table, or any other failure of the statement, is no cards.
pub fn recent(conn: &Connection, limit: u32) -> Vec<RecentCard> {
    let limit = limit.clamp(1, MAX_RECENT as u32);
    let list = stored(conn);
    if list.is_empty() {
        return Vec::new();
    }
    let ids: Vec<&str> = list.iter().map(|v| v.card_id.as_str()).collect();
    let Ok(ids) = serde_json::to_string(&ids) else {
        return Vec::new();
    };
    let joined = || -> rusqlite::Result<Vec<RecentCard>> {
        let mut stmt = conn.prepare(
            "SELECT j.key, c.id, c.name, c.set_code
               FROM json_each(?1) AS j
               JOIN cards AS c ON c.id = j.value
              ORDER BY j.key
              LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![ids, limit], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
            ))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (index, card_id, name, set_code) = row?;
            // The index came from the array this function built, so it is always in range; a
            // `get` rather than an index is only so that a statement that ever answered otherwise
            // drops a row instead of panicking the IPC thread.
            if let Some(viewed) = usize::try_from(index).ok().and_then(|i| list.get(i)) {
                out.push(RecentCard {
                    card_id,
                    name,
                    set_code,
                    viewed_at: viewed.at,
                });
            }
        }
        Ok(out)
    };
    joined().unwrap_or_default()
}

/// The cards this device opened most recently, newest first, at most `limit`.
///
/// **Infallible by signature**, [`crate::home::home_layout`]'s contract and for its reason, and
/// `#[tauri::command(async)]` for that command's reason too: it takes `db_read`'s mutex, which a
/// search may hold, while the home page is drawing.
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn recent_cards(state: tauri::State<'_, Arc<AppState>>, limit: u32) -> Vec<RecentCard> {
    recent(&crate::sync::lock_db_read(state.inner()), limit)
}

/// Remember that a card was opened. Answers [`crate::db::BUSY`] if a sync holds the write
/// connection — the bound every write command in this crate takes.
///
/// **The caller ignores a refusal**, [`crate::nav::set_nav_collapsed`]'s reading: a missed entry
/// costs one tile on the home page and nothing the reader is looking at now, and a card modal that
/// raised an error because a sync was running would be a far worse trade.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn record_recent_card(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| record_now(conn, &card_id))
    })
    .await
    .map_err(|e| format!("the card you opened could not be remembered: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_meta::{get_app_meta, set_app_meta};

    /// The real pair, because [`recent`] reads `cards` out of the attached corpus and `app_meta`
    /// out of the user file — a single hand-built database could not see a join that reached for
    /// the wrong one.
    fn conn() -> Connection {
        crate::schema::memory_pair()
    }

    /// One printing in the corpus.
    fn card(conn: &Connection, id: &str, name: &str, set_code: &str) {
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES (?1, ?2, ?3, '1', 'en', 'normal', '{}')",
            params![id, name, set_code],
        )
        .unwrap();
    }

    fn ids(cards: &[RecentCard]) -> Vec<&str> {
        cards.iter().map(|c| c.card_id.as_str()).collect()
    }

    /// Newest first, each joined with its name, set and the time it was opened.
    #[test]
    fn the_list_answers_newest_first_with_the_corpus_facts() {
        let c = conn();
        card(&c, "bolt", "Lightning Bolt", "lea");
        card(&c, "ring", "Sol Ring", "cmr");
        card(&c, "path", "Swords to Plowshares", "ice");
        record(&c, "bolt", 100).unwrap();
        record(&c, "ring", 200).unwrap();
        record(&c, "path", 300).unwrap();

        let got = recent(&c, 24);
        assert_eq!(ids(&got), ["path", "ring", "bolt"]);
        assert_eq!(
            got[1],
            RecentCard {
                card_id: "ring".into(),
                name: "Sol Ring".into(),
                set_code: "cmr".into(),
                viewed_at: 200,
            }
        );
    }

    /// **The order is the list's, not the corpus's.** Written so the ids sort one way, the rowids
    /// another and the list a third — a join that let the planner walk `cards` would come back in
    /// one of the first two and still pass a `len()` check.
    #[test]
    fn the_join_keeps_the_lists_order() {
        let c = conn();
        for (id, name) in [("b", "Bee"), ("c", "Sea"), ("a", "Ay")] {
            card(&c, id, name, "tst");
        }
        for (at, id) in [(1, "a"), (2, "c"), (3, "b")] {
            record(&c, id, at).unwrap();
        }
        assert_eq!(ids(&recent(&c, 24)), ["b", "c", "a"]);
    }

    /// Opening a card already on the list moves it to the front, with its new time, and leaves
    /// one entry for it — never two tiles for one card.
    #[test]
    fn opening_a_card_again_moves_it_to_the_front() {
        let c = conn();
        for id in ["a", "b", "c"] {
            card(&c, id, id, "tst");
        }
        record(&c, "a", 1).unwrap();
        record(&c, "b", 2).unwrap();
        record(&c, "c", 3).unwrap();
        record(&c, "a", 4).unwrap();

        let got = recent(&c, 24);
        assert_eq!(ids(&got), ["a", "c", "b"]);
        assert_eq!(got[0].viewed_at, 4, "with the time of the latest open");
        assert_eq!(stored(&c).len(), 3, "and one entry for it in the row");
    }

    /// The row keeps [`MAX_RECENT`] and drops the oldest past it.
    #[test]
    fn the_list_is_capped_and_the_oldest_go() {
        let c = conn();
        for i in 0..30 {
            record(&c, &format!("card-{i}"), i).unwrap();
        }
        let list = stored(&c);
        assert_eq!(list.len(), MAX_RECENT);
        assert_eq!(list[0].card_id, "card-29", "the newest is first");
        assert_eq!(
            list[MAX_RECENT - 1].card_id,
            "card-6",
            "and the six oldest are gone"
        );
    }

    /// `0` must mean one card, not none and not all; anything past the cap is the cap.
    #[test]
    fn the_limit_is_clamped_to_one_through_the_cap() {
        let c = conn();
        for i in 0..MAX_RECENT as i64 {
            let id = format!("card-{i}");
            card(&c, &id, &id, "tst");
            record(&c, &id, i).unwrap();
        }
        assert_eq!(recent(&c, 0).len(), 1, "0 means one, never none");
        assert_eq!(recent(&c, 1).len(), 1);
        assert_eq!(recent(&c, 8).len(), 8);
        assert_eq!(
            recent(&c, 10_000).len(),
            MAX_RECENT,
            "and nothing past the cap"
        );
    }

    /// A printing the corpus no longer holds is skipped — **and does not use up a place**, so a
    /// widget asking for two tiles still gets two while the list holds two the corpus knows. The
    /// id stays in the row, so the card comes back the day the corpus does.
    #[test]
    fn a_card_the_corpus_no_longer_holds_is_skipped_and_kept() {
        let c = conn();
        card(&c, "a", "Ay", "tst");
        card(&c, "c", "Sea", "tst");
        record(&c, "a", 1).unwrap();
        record(&c, "gone", 2).unwrap();
        record(&c, "c", 3).unwrap();
        record(&c, "also-gone", 4).unwrap();

        assert_eq!(ids(&recent(&c, 2)), ["c", "a"]);
        assert_eq!(stored(&c).len(), 4, "the missing ids are still remembered");

        card(&c, "gone", "Back Again", "tst");
        assert_eq!(ids(&recent(&c, 24)), ["c", "gone", "a"]);
    }

    /// A row this build cannot make sense of is no cards, never an error — and a junk row is not
    /// sticky: the next open writes a good one over it.
    #[test]
    fn junk_reads_as_no_cards_and_the_next_write_repairs_it() {
        let c = conn();
        card(&c, "a", "Ay", "tst");
        assert!(recent(&c, 8).is_empty(), "a missing row is no cards");
        for junk in [
            "",
            "null",
            "{}",
            "\"a string\"",
            "[1,2,3]",
            r#"[{"cardId":"a"}]"#,
            "{not json",
        ] {
            set_app_meta(&c, K_RECENT_CARDS, junk).unwrap();
            assert!(recent(&c, 8).is_empty(), "`{junk}` reads as no cards");
        }
        record(&c, "a", 9).unwrap();
        assert_eq!(ids(&recent(&c, 8)), ["a"]);
    }

    /// A duplicate or a blank id a hand-edit left behind is folded away on the read — the first
    /// occurrence wins, because the list is newest first.
    #[test]
    fn a_hand_edited_duplicate_or_blank_is_folded_on_the_read() {
        let c = conn();
        card(&c, "a", "Ay", "tst");
        card(&c, "b", "Bee", "tst");
        set_app_meta(
            &c,
            K_RECENT_CARDS,
            r#"[{"cardId":"a","at":5},{"cardId":" ","at":4},{"cardId":"b","at":3},{"cardId":"a","at":2}]"#,
        )
        .unwrap();
        let got = recent(&c, 24);
        assert_eq!(ids(&got), ["a", "b"]);
        assert_eq!(got[0].viewed_at, 5);
    }

    /// A corpus with no `cards` table at all — the state between a destroyed corpus and its first
    /// sync — is no cards, not a failure.
    #[test]
    fn a_corpus_without_cards_reads_as_no_cards() {
        let c = conn();
        record(&c, "a", 1).unwrap();
        c.execute_batch("DROP TABLE corpus.cards").unwrap();
        assert!(recent(&c, 8).is_empty());
    }

    /// A blank id is refused in a sentence, and the row is left exactly as it stood.
    #[test]
    fn a_blank_id_is_refused_and_the_row_is_left_alone() {
        let c = conn();
        record(&c, "a", 1).unwrap();
        let before = get_app_meta(&c, K_RECENT_CARDS);
        for blank in ["", "   "] {
            let err = record(&c, blank, 2).unwrap_err();
            assert_eq!(err, NO_ID);
            assert_eq!(
                get_app_meta(&c, K_RECENT_CARDS),
                before,
                "`{blank}` touched the row"
            );
        }
        assert!(record_now(&c, "").is_err());
    }

    /// [`record_now`] takes SQLite's clock, so a card opened now reads back with a real time.
    #[test]
    fn record_now_stamps_the_databases_clock() {
        let c = conn();
        card(&c, "a", "Ay", "tst");
        record_now(&c, "a").unwrap();
        let got = recent(&c, 8);
        assert_eq!(got.len(), 1);
        // 2020-01-01, well before any machine this runs on.
        assert!(got[0].viewed_at > 1_577_836_800, "{}", got[0].viewed_at);
    }

    /// The wire names are the ones `ipc.ts`'s `RecentCard` reads, and the row's are the ones this
    /// module's own reader expects — `ipc.test.ts` compares field lists and cannot see a dropped
    /// `rename_all`, so the serialisation is asserted here.
    #[test]
    fn both_shapes_serialise_under_camel_case_names() {
        let wire = serde_json::to_value(RecentCard {
            card_id: "a".into(),
            name: "Ay".into(),
            set_code: "tst".into(),
            viewed_at: 7,
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({ "cardId": "a", "name": "Ay", "setCode": "tst", "viewedAt": 7 })
        );

        let c = conn();
        record(&c, "a", 7).unwrap();
        assert_eq!(
            get_app_meta(&c, K_RECENT_CARDS).as_deref(),
            Some(r#"[{"cardId":"a","at":7}]"#)
        );
    }
}
