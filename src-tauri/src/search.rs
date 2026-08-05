//! Card search: FTS5 prefix matching plus format/colour/set/rarity filters.
//!
//! The query is assembled from fragments rather than written out once, because every
//! filter is optional and SQLite plans `col = ?` far better than `(? IS NULL OR col = ?)`.
//! Only four things are ever interpolated into the SQL string — a colour letter from a
//! fixed array, a `FROM` clause picked from two literals, an `ORDER BY` picked from four,
//! and the constant row cap on the count — plus two `?`-placeholder lists whose *length*
//! is the only thing they carry. No user text reaches the parser; everything else is bound.
//!
//! Two decisions here are about the shape of the answer rather than the filters:
//!
//! * **Text searches are ranked, browses are not.** With a query to be relevant to, the
//!   page is ordered by FTS5's `bm25` with the name column weighted ten times the type
//!   line and oracle text, so `Lightning Bolt` outranks the cards that merely mention it.
//!   Without one, alphabetical order is both what a browse wants and what `idx_cards_name`
//!   can deliver without sorting 116 k rows.
//! * **`total` is capped.** It is a pager's denominator and a caption, and neither needs
//!   an exact figure past a few thousand. Counting to the end cost a full scan on every
//!   keystroke (measured: 382 ms for the default browse); stopping at [`TOTAL_CAP`] costs
//!   ~10 ms, and [`SearchResponse::total_is_capped`] tells the UI to render `5,000+`
//!   rather than a number that would be a lie.

use crate::filters;
use crate::sync::{lock_db_read, AppState};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// What the UI asks for.
///
/// `#[serde(default)]` so every field is optional in the invoke payload — `limit` and
/// `offset` are bare `u32`, and without it a caller that omits them fails to deserialize
/// rather than getting the documented "`limit: 0` means unset" behaviour.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SearchRequest {
    /// Free text. Prefix-matched against name, type line and oracle/face text.
    pub text: Option<String>,
    /// A `legalities` key (`"modern"`, `"vintage"`, …). Matches `legal` *or* `restricted`.
    pub format: Option<String>,
    /// Colour identity filter, e.g. `"WU"`. `"C"` means colourless only.
    pub colors: Option<String>,
    pub set_code: Option<String>,
    /// Set codes to include. ORed with each other, ANDed with every other filter — two
    /// sets means "printed in either", which is what a multi-select means everywhere else.
    pub sets: Option<Vec<String>>,
    /// Mana-value chips. 0–7 match `cmc` exactly; [`filters::MANA_VALUE_OPEN_ENDED`] means
    /// "or more". A card with no `cmc` matches none of them.
    pub mana_values: Option<Vec<u8>>,
    pub rarity: Option<String>,
    /// Defaults to true: digital-only printings are hidden unless asked for.
    pub paper_only: Option<bool>,
    /// `"name"` | `"released"` | `"price"`. Anything else — including nothing at all —
    /// is the default: relevance when `text` is set, name order when it is not.
    pub sort: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

impl SearchRequest {
    /// The card half of this request, in the shape every other list uses.
    ///
    /// Cloned rather than borrowed, and the fields stay flat on this struct rather than
    /// moving behind a `#[serde(flatten)]`: the wire shape is what `src/lib/ipc.ts` sends
    /// and thirty tests construct, and a request is a handful of small strings.
    fn card_filters(&self) -> filters::CardFilters {
        filters::CardFilters {
            text: None, // handled above, with the join it needs
            format: self.format.clone(),
            colors: self.colors.clone(),
            set_code: self.set_code.clone(),
            sets: self.sets.clone(),
            mana_values: self.mana_values.clone(),
            rarity: self.rarity.clone(),
            paper_only: self.paper_only,
        }
    }
}

/// One row of a result page — the columns a card grid needs, not the whole card.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSummary {
    pub id: String,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub type_line: Option<String>,
    pub mana_cost: Option<String>,
    pub price_usd: Option<f64>,
    pub layout: String,
}

/// A page of results plus the size of the whole match set, for the pager.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub items: Vec<CardSummary>,
    /// Matches, counted no further than [`TOTAL_CAP`]. Read together with
    /// [`Self::total_is_capped`]: a `total` of 5000 means "5000" or "at least 5000"
    /// depending on it.
    pub total: i64,
    /// The count stopped at the cap — there are `total` matches *or more*. A pager must
    /// keep asking for pages while this is true, and stop on the first short page
    /// instead; a caption should render `5,000+`.
    pub total_is_capped: bool,
}

/// Page size when the caller does not choose one, and the ceiling when it does.
const DEFAULT_LIMIT: u32 = 50;
const MAX_LIMIT: u32 = 200;

/// How far [`run_search`] will count matches before it stops and says "or more".
///
/// The count exists to size a scrollbar and caption a list; past a few thousand rows no
/// reader is served better by an exact figure than by `5,000+`, and getting one meant
/// scanning every remaining row on every keystroke.
const TOTAL_CAP: i64 = 5_000;

/// Columns of `cards` in name order, the default for a browse.
///
/// `idx_cards_name` supplies the leading term, so SQLite sorts only within each group of
/// identically-named printings rather than the whole table. `id` last makes paging
/// deterministic: without a total order, two printings that tie on every earlier key can
/// swap places between the request for page 1 and the request for page 2, which shows the
/// reader one of them twice and the other never.
const ORDER_NAME: &str = "c.name ASC, c.released_at DESC, c.id ASC";

/// Search `cards`, newest schema assumed. Pure over the connection so it is testable
/// without a Tauri app; [`search_cards`] is the only caller in production.
///
/// Two statements, not one. The page and the count share their `FROM`, their `WHERE` and
/// their parameters, but the count carries its own `LIMIT` so it can stop early — which a
/// `count(*) OVER ()` riding on the page cannot do, because a window function is
/// evaluated over the whole result set before the page's `LIMIT` applies. That window
/// function was what made every search a full scan.
pub fn run_search(conn: &Connection, req: &SearchRequest) -> Result<SearchResponse, String> {
    let limit = if req.limit == 0 {
        DEFAULT_LIMIT
    } else {
        req.limit.min(MAX_LIMIT)
    };

    let mut p = filters::Predicates::default();
    // Joined only when there is something to match, because the join is also what makes
    // `bm25(cards_fts, …)` legal: naming an FTS table's auxiliary function in a query that
    // does not read that table is a *prepare* error, not a bad ranking.
    let mut from_sql = "cards c";
    let mut ranked = false;
    if let Some(text) = filters::nonblank(&req.text) {
        // All-punctuation input leaves nothing to match on. Dropping the clause searches
        // everything, which is what an empty search box does anyway.
        if let Some(query) = filters::fts_query(text) {
            from_sql = "cards c JOIN cards_fts ON cards_fts.rowid = c.rowid";
            p.push("cards_fts MATCH ?".to_owned(), Box::new(query));
            ranked = true;
        }
    }
    // `None`: this query reads `cards` and nothing else, so there is no second place a set
    // code could come from — see `push_card_filters`.
    filters::push_card_filters(&mut p, &req.card_filters(), "c", None);
    let where_sql = p.where_sql();
    let mut params = p.params;

    // Matched against literals, never interpolated from `req.sort`. `released_at` and
    // `price_usd` are both nullable, so each has an explicit null rule; every sort ends in
    // `name, id` so that ties — which at 116 k printings are the common case, not the
    // exception — page deterministically.
    let order = match req.sort.as_deref() {
        Some("released") => "c.released_at DESC, c.name ASC, c.id ASC",
        Some("price") => "c.price_usd DESC NULLS LAST, c.name ASC, c.id ASC",
        Some("name") => ORDER_NAME,
        // The default. `bm25` returns *smaller* numbers for better matches, so plain
        // ascending order is best-first. The weights are (name, type_line, search_text):
        // a card whose name is what was typed beats one that merely mentions it in its
        // rules text, which alphabetical order had no way to express.
        _ if ranked => "bm25(cards_fts, 10.0, 1.0, 1.0) ASC, c.name ASC, c.id ASC",
        _ => ORDER_NAME,
    };

    // The count runs first, while `params` still holds exactly the filter parameters and
    // nothing else. `LIMIT` inside the subquery is what bounds the work: SQLite stops
    // producing rows at the cap, so the count costs the cap, not the table.
    let count_sql = format!(
        "SELECT count(*) FROM (SELECT 1 FROM {from_sql} WHERE {where_sql} LIMIT {cap})",
        cap = TOTAL_CAP + 1
    );
    let counted: i64 = conn
        .query_row(
            &count_sql,
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let total_is_capped = counted > TOTAL_CAP;
    let total = counted.min(TOTAL_CAP);

    let sql = format!(
        "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                c.type_line, c.mana_cost, c.price_usd, c.layout
         FROM {from_sql} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    // Pushed last, because `?` binds by position and these are the last two in the SQL.
    params.push(Box::new(limit));
    params.push(Box::new(req.offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt
        .query(rusqlite::params_from_iter(
            params.iter().map(|p| p.as_ref()),
        ))
        .map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        items.push(CardSummary {
            id: row.get(0).map_err(|e| e.to_string())?,
            name: row.get(1).map_err(|e| e.to_string())?,
            set_code: row.get(2).map_err(|e| e.to_string())?,
            set_name: row.get(3).map_err(|e| e.to_string())?,
            collector_number: row.get(4).map_err(|e| e.to_string())?,
            rarity: row.get(5).map_err(|e| e.to_string())?,
            type_line: row.get(6).map_err(|e| e.to_string())?,
            mana_cost: row.get(7).map_err(|e| e.to_string())?,
            price_usd: row.get(8).map_err(|e| e.to_string())?,
            layout: row.get(9).map_err(|e| e.to_string())?,
        });
    }
    Ok(SearchResponse {
        items,
        total,
        total_is_capped,
    })
}

/// Search the card database.
///
/// Runs on the **read-only** connection, which is the whole reason there is one: the
/// writer's longest job is a 44 s ingest, and a search sharing its mutex would queue
/// behind that — the app would stop answering searches once a day for the length of a
/// sync. Under WAL a reader sees the last committed snapshot without blocking, so it
/// answers immediately with the pre-swap card data, which is exactly right.
///
/// `async` + `spawn_blocking`, not a plain sync command: a sync command body runs inline
/// on the IPC thread, and SQLite work is blocking. `lock_db_read` is shared with `sync`
/// so poison recovery has one definition.
#[tauri::command]
pub async fn search_cards(
    state: tauri::State<'_, Arc<AppState>>,
    req: SearchRequest,
) -> Result<SearchResponse, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_search(&lock_db_read(&state), &req))
        .await
        .map_err(|e| format!("search could not be run: {e}"))?
}

/// One row of the set picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSummary {
    /// Lowercase, as `cards.set_code` stores it — the value the filter sends back.
    pub code: String,
    pub name: String,
    pub set_type: Option<String>,
    pub released_at: Option<String>,
    /// **Paper** printings of this set in the local database.
    ///
    /// Not decoration, and not a plain row count: `sets` carries every set Scryfall knows,
    /// and two different kinds of them can never answer a search. Memorabilia and
    /// token-only sets have no rows in `cards` at all, because `default_cards` holds
    /// nothing for them. The 61 Arena/MTGO sets have hundreds of rows each — and every one
    /// of them is filtered out again by the `paper_only` default that [`run_search`]
    /// applies unless a caller says otherwise. So the count is taken over `is_paper = 1`:
    /// a picker whose numbers do not agree with what clicking the row returns is worse
    /// than no numbers at all.
    pub card_count: i64,
}

/// Every set, newest first, for the search filter's picker.
///
/// One grouped pass over `cards` rather than a correlated count per set: 1 050 subqueries
/// against a 116 k-row table is a visible pause on a control that opens instantly.
pub fn run_list_sets(conn: &Connection) -> Result<Vec<SetSummary>, String> {
    let mut stmt = conn
        .prepare(
            // `FILTER`, not a `WHERE` on the subquery: a set whose every printing is
            // digital has to come back as a `0` row, and a `WHERE` would drop the group
            // entirely — which the `LEFT JOIN` would then coalesce to the same 0, but only
            // by accident. Stated once, in the place that means it.
            "SELECT s.code, s.name, s.set_type, s.released_at, coalesce(n.cards, 0)
             FROM sets s
             LEFT JOIN (SELECT set_code, count(*) FILTER (WHERE is_paper = 1) AS cards
                          FROM cards GROUP BY set_code) n
                    ON n.set_code = s.code
             ORDER BY s.released_at DESC, s.name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SetSummary {
                code: r.get(0)?,
                name: r.get(1)?,
                set_type: r.get(2)?,
                released_at: r.get(3)?,
                card_count: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The set list, for the search filter. Read-only connection, blocking pool — as
/// [`search_cards`] is, and for the same reason.
#[tauri::command]
pub async fn list_sets(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<SetSummary>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_list_sets(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("set list could not be read: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three rows chosen to pin the tricky cases: a restricted-in-Vintage card, a
    /// two-colour card, and a digital-only one with a non-Latin name.
    #[rustfmt::skip]
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows = [
            ("1","Lightning Bolt","lea","161","Instant","R","R","common", 400.5, r#"{"vintage":"restricted","modern":"legal","standard":"not_legal"}"#, 1),
            ("2","Lightning Helix","rav","213","Instant","RW","RW","uncommon", 1.5, r#"{"modern":"legal"}"#, 1),
            ("3","Черная Молния","alc","1","Sorcery","B","B","rare", 0.5, r#"{"alchemy":"legal"}"#, 0),
        ];
        for (id,name,set,cn,tl,c,ci,r,usd,leg,paper) in rows {
            conn.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,type_line,colors,color_identity,rarity,price_usd,legalities,is_paper,search_text,raw)
                VALUES (?1,?2,?3,?4,'en','normal',?5,?6,?7,?8,?9,?10,?11,?2,'{}')",
                rusqlite::params![id,name,set,cn,tl,c,ci,r,usd,leg,paper]).unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');").unwrap();
        conn
    }

    #[test]
    fn text_prefix_search_matches() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("light bol".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Lightning Bolt");
    }

    /// Names carrying the punctuation real card names carry. Added per-test and
    /// re-indexed, so the shared fixture's pinned counts stay as they are. The rebuild
    /// is required: `cards_fts` is external-content with no triggers, so a row inserted
    /// after the fixture's rebuild is invisible to search until the index is redone.
    #[rustfmt::skip]
    fn seed_punctuated_names(conn: &Connection) {
        let rows = [
            ("10", "Ajani's Pridemate"),
            ("11", "God-Pharaoh's Gift"),
        ];
        for (id, name) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,search_text,raw)
                 VALUES (?1,?2,'m21','1','en','normal',1,?2,'{}')",
                rusqlite::params![id, name],
            ).unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');").unwrap();
    }

    /// The tokenizer (`unicode61`) splits `Ajani's` into `ajani` + `s`, so a sanitizer
    /// that *deletes* the apostrophe rather than splitting on it searches for the token
    /// `ajanis`, which is indexed nowhere — the natural spelling would find nothing.
    #[test]
    fn an_apostrophe_splits_a_word_instead_of_welding_it() {
        let conn = seeded();
        seed_punctuated_names(&conn);
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("Ajani's".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Ajani's Pridemate");
    }

    /// Same failure mode for hyphens, which are everywhere in card names: `God-Pharaoh`
    /// must search `god` AND `pharaoh`, not the unindexable `godpharaoh`.
    #[test]
    fn a_hyphen_splits_a_word_instead_of_welding_it() {
        let conn = seeded();
        seed_punctuated_names(&conn);
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("God-Pharaoh".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "God-Pharaoh's Gift");
    }

    #[test]
    fn format_filter_includes_restricted() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                format: Some("vintage".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
    }

    #[test]
    fn color_subset_filter() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                colors: Some("RW".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2); // R and RW both ⊆ RW
    }

    /// The empty set is a subset of every set, so colourless cards belong in *every*
    /// colour search — a Boros deck can still run Sol Ring. `"C"` is the one filter that
    /// means "only these". Identity is `''` for a card Scryfall sends an empty array for
    /// and NULL when the key is missing; both must land on the colourless side.
    #[test]
    fn colorless_cards_match_every_color_filter_and_c_matches_only_them() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,color_identity,is_paper,raw)
             VALUES ('4','Sol Ring','lea','270','en','normal','',1,'{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('5','Unknown Identity','lea','271','en','normal',1,'{}')",
            [],
        )
        .unwrap();

        let rw = run_search(
            &conn,
            &SearchRequest {
                colors: Some("RW".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(rw.total, 4, "R, RW and both colourless cards fit in RW");

        let c = run_search(
            &conn,
            &SearchRequest {
                colors: Some("C".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(c.total, 2, "only the colourless cards");
    }

    /// Filters are ANDed, and every `?` must bind to the clause that pushed it: the SQL
    /// fragments and their parameters are appended in one pass, so a mis-ordered push
    /// would feed the set code to the format's json path and silently match nothing.
    #[test]
    fn filters_combine_and_parameters_bind_in_order() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("light".into()),
                format: Some("modern".into()),
                set_code: Some("rav".into()),
                rarity: Some("uncommon".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Lightning Helix");
    }

    #[test]
    fn paper_only_default_excludes_digital() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2);
    }

    /// `total` must describe the whole match set, not the page — it is what the pager
    /// divides by. A `count(*)` placed after the `LIMIT` would report 1 here.
    #[test]
    fn total_counts_every_match_not_just_the_page() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.total, 2);
        assert!(!r.total_is_capped);

        // And the second page is the *other* row, not the same one again.
        let p2 = run_search(
            &conn,
            &SearchRequest {
                limit: 1,
                offset: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(p2.total, 2);
        assert_ne!(p2.items[0].id, r.items[0].id);

        // The count is its own statement now, so it no longer rides on the returned rows
        // — a page past the end reports the real total instead of 0.
        let past = run_search(
            &conn,
            &SearchRequest {
                limit: 1,
                offset: 99,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(past.items.is_empty());
        assert_eq!(past.total, 2);
    }

    /// Relevance is the whole point of ranking a text search: alphabetical order put
    /// `Emeritus of Conflict // Lightning Bolt` above `Lightning Bolt` for the query
    /// "lightning bolt", which is the answer no one was looking for. The name column is
    /// weighted 10× in `bm25`, and bm25 favours the shorter field for the same terms, so
    /// the card actually called Lightning Bolt wins.
    #[test]
    fn relevance_puts_the_card_that_is_named_for_the_query_first() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,type_line,is_paper,search_text,raw)
             VALUES ('20','Emeritus of Conflict // Lightning Bolt','sos','7','en','normal','Creature',1,
                     'Emeritus of Conflict Lightning Bolt','{}')",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("lightning bolt".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Lightning Bolt", "Emeritus of Conflict // Lightning Bolt"],
            "the exact name outranks the card that merely contains it"
        );

        // An explicit sort still wins over the default — alphabetical order is the one
        // that puts Emeritus first, so this fails if `sort` stopped being honoured.
        let by_name = run_search(
            &conn,
            &SearchRequest {
                text: Some("lightning bolt".into()),
                sort: Some("name".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            by_name.items[0].name,
            "Emeritus of Conflict // Lightning Bolt"
        );
    }

    /// The count stops at `TOTAL_CAP` instead of scanning to the end of 116 k rows, and
    /// says so — a bare `5000` would be a number the UI would render as fact.
    #[test]
    fn a_match_set_past_the_cap_is_counted_no_further_and_flagged() {
        let mut conn = seeded();
        let tx = conn.transaction().unwrap();
        for i in 0..TOTAL_CAP + 5 {
            tx.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
                 VALUES (?1,?2,'m21',?1,'en','normal',1,'{}')",
                rusqlite::params![format!("bulk-{i}"), format!("Bulk Card {i:05}")],
            )
            .unwrap();
        }
        tx.commit().unwrap();

        let capped = run_search(
            &conn,
            &SearchRequest {
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(capped.total, TOTAL_CAP);
        assert!(capped.total_is_capped);
        assert_eq!(capped.items.len(), 10, "the page itself is unaffected");

        // A set that fits under the cap is still counted exactly.
        let exact = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("lea".into()),
                limit: 10,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(exact.total, 1);
        assert!(!exact.total_is_capped);
    }

    /// Rows that tie on the sort key are the common case at 116 k printings — one card
    /// name covers dozens of them. Without a total order SQLite may return tied rows in
    /// any order it likes, and it need not pick the same one twice: a reader paging
    /// through would see some printings repeated and others never. Every sort therefore
    /// ends in `name, id`.
    #[test]
    fn tied_rows_page_without_repeating_or_dropping_any() {
        let conn = seeded();
        // Six printings that agree on every sort key there is: same name, same release
        // date, same (absent) price.
        for i in 0..6 {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,released_at,is_paper,raw)
                 VALUES (?1,'Forest','m21',?1,'en','normal','2020-07-03',1,'{}')",
                rusqlite::params![format!("forest-{i}")],
            )
            .unwrap();
        }

        for sort in ["name", "released", "price"] {
            let mut seen: Vec<String> = Vec::new();
            for page in 0..4 {
                let r = run_search(
                    &conn,
                    &SearchRequest {
                        sort: Some(sort.into()),
                        limit: 2,
                        offset: page * 2,
                        ..Default::default()
                    },
                )
                .unwrap();
                seen.extend(r.items.into_iter().map(|c| c.id));
            }
            let mut unique = seen.clone();
            unique.sort();
            unique.dedup();
            assert_eq!(
                unique.len(),
                seen.len(),
                "paging by `{sort}` returned a row twice: {seen:?}"
            );
            assert_eq!(seen.len(), 8, "four pages of two, sorted by `{sort}`");
        }
    }

    /// The frontend mirrors these names by hand in `src/lib/ipc.ts`; a rename here that is
    /// not mirrored there is a silently `undefined` field in the UI.
    #[test]
    fn search_response_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(SearchResponse {
            items: vec![CardSummary {
                id: "1".into(),
                name: "Lightning Bolt".into(),
                set_code: "lea".into(),
                set_name: None,
                collector_number: "161".into(),
                rarity: None,
                type_line: Some("Instant".into()),
                mana_cost: None,
                price_usd: Some(400.5),
                layout: "normal".into(),
            }],
            total: 5000,
            total_is_capped: true,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "items": [{
                    "id": "1", "name": "Lightning Bolt", "setCode": "lea", "setName": null,
                    "collectorNumber": "161", "rarity": null, "typeLine": "Instant",
                    "manaCost": null, "priceUsd": 400.5, "layout": "normal"
                }],
                "total": 5000,
                "totalIsCapped": true
            })
        );
    }

    /// The set picker goes through the same hand-written mirror, and it is the one of these
    /// DTOs whose drift a reader would never report: a picker whose `cardCount` all arrive
    /// as `undefined` still looks like a working picker, just one where every set is
    /// suddenly blank. Whole-value equality rather than field-by-field, so a field added
    /// here and never mirrored in `src/lib/ipc.ts` fails the test as loudly as a rename.
    #[test]
    fn set_summary_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(SetSummary {
            code: "roe".into(),
            name: "Rise of the Eldrazi".into(),
            set_type: Some("expansion".into()),
            released_at: Some("2010-04-23".into()),
            card_count: 248,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "code": "roe",
                "name": "Rise of the Eldrazi",
                "setType": "expansion",
                "releasedAt": "2010-04-23",
                "cardCount": 248
            })
        );

        // What `sets` holds for a set `default_cards` carries nothing for: no type, no
        // release date, no printings. Both optionals arrive as an explicit `null` — no
        // field here is `skip_serializing_if`, and the TypeScript side declares them
        // `string | null`, so a key that simply vanished would be a different contract.
        let sparse = serde_json::to_value(SetSummary {
            code: "mem".into(),
            name: "Memorabilia".into(),
            set_type: None,
            released_at: None,
            card_count: 0,
        })
        .unwrap();
        assert_eq!(
            sparse,
            serde_json::json!({
                "code": "mem",
                "name": "Memorabilia",
                "setType": null,
                "releasedAt": null,
                "cardCount": 0
            })
        );
    }

    /// The reason there are two connections. A search must answer while an ingest holds
    /// the write connection for its whole 44 s run — under WAL the reader sees the last
    /// committed snapshot and never waits, and the only thing that used to serialise them
    /// was sharing one `Mutex<Connection>`. Run from another thread, as the real command
    /// is, so a regression to the shared lock fails here in five seconds rather than
    /// hanging the suite.
    #[test]
    fn a_search_answers_while_an_ingest_holds_the_write_connection() {
        use crate::sync::lock_db_read;
        use std::sync::atomic::AtomicBool;
        use std::sync::Mutex;

        let dir = std::env::temp_dir().join("mtgtest-search-concurrent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mtg.db");

        let write = crate::db::open(&path).unwrap();
        crate::schema::migrate(&write).unwrap();
        write.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw) VALUES ('1','Lightning Bolt','lea','161','en','normal',1,'{}')", []).unwrap();
        let read = crate::db::open_read_only(&path).unwrap();

        let state = Arc::new(AppState {
            db: Mutex::new(write),
            db_read: Mutex::new(read),
            data_dir: dir.clone(),
            syncing: AtomicBool::new(true),
            client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            images: crate::images::Cache::new(dir.join("images")),
        });

        // Stands in for the ingest, which holds this exact lock for the length of a sync.
        let held = state.db.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let state = state.clone();
            std::thread::spawn(move || {
                let req = SearchRequest {
                    limit: 10,
                    ..Default::default()
                };
                let _ = tx.send(run_search(&lock_db_read(&state), &req));
            });
        }
        let answered = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("search must not queue behind the write connection");
        drop(held);
        drop(state);
        let _ = std::fs::remove_dir_all(&dir);

        let r = answered.unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Lightning Bolt");
    }

    /// The invoke payload the UI actually sends omits every field it has no value for.
    /// `limit`/`offset` are bare `u32`, so without `#[serde(default)]` this is a
    /// deserialization *error*, and the "`limit: 0` means unset" contract is unreachable
    /// from the front end. Also pins the camelCase spelling Task 10 has to mirror.
    #[test]
    fn a_partial_camel_case_payload_deserializes_and_takes_the_default_page_size() {
        let req: SearchRequest =
            serde_json::from_str(r#"{"text":"bolt","setCode":"lea","paperOnly":true}"#).unwrap();
        assert_eq!(req.set_code.as_deref(), Some("lea"));
        assert_eq!(req.paper_only, Some(true));
        assert_eq!(req.limit, 0, "omitted limit means unset, not a parse error");
        assert_eq!(req.offset, 0);

        // And "unset" has to behave as the default page size, not as "return nothing".
        let r = run_search(&seeded(), &req).unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(r.items[0].name, "Lightning Bolt");
    }

    #[test]
    fn released_sort_is_newest_first() {
        let conn = seeded();
        conn.execute("UPDATE cards SET released_at='1993-08-05' WHERE id='1'", [])
            .unwrap();
        conn.execute("UPDATE cards SET released_at='2005-10-07' WHERE id='2'", [])
            .unwrap();
        let r = run_search(
            &conn,
            &SearchRequest {
                sort: Some("released".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Lightning Helix", "Lightning Bolt"]);
    }

    #[test]
    fn paper_only_false_includes_digital_printings() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                paper_only: Some(false),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 3);
    }

    /// An unrecognised sort falls back to name order rather than erroring — and, since
    /// the value here would be a syntax error if it ever reached the SQL, this also
    /// pins that `sort` is *matched* against literals and never interpolated.
    #[test]
    fn an_unknown_sort_falls_back_to_name_order() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                sort: Some("c.name; DROP TABLE cards".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Lightning Bolt", "Lightning Helix"]);
    }

    /// `NULLS LAST` needs SQLite ≥ 3.30 — older builds reject it at *prepare* time, so
    /// this fails loudly rather than silently sorting priceless cards to the top.
    #[test]
    fn price_sort_puts_unpriced_cards_last() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('4','Unpriced Card','lea','2','en','normal',1,'{}')",
            [],
        )
        .unwrap();
        let r = run_search(
            &conn,
            &SearchRequest {
                sort: Some("price".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Lightning Bolt", "Lightning Helix", "Unpriced Card"],
            "descending by price, NULLs last"
        );
    }

    /// An "Any …" dropdown option with an empty value sends `Some("")`. Blank must mean
    /// "no filter": `set_code = ''` matches nothing, and a blank format would make the
    /// json path `'$.'`, which SQLite rejects — failing the entire search, not one filter.
    #[test]
    fn blank_filters_are_ignored_not_matched() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("  ".into()),
                format: Some("".into()),
                colors: Some("".into()),
                set_code: Some("".into()),
                rarity: Some("".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2);
    }

    #[test]
    fn fts_special_chars_do_not_panic() {
        let conn = seeded();
        for evil in ["\"", "OR", "name:", "( ", "*"] {
            run_search(
                &conn,
                &SearchRequest {
                    text: Some(evil.into()),
                    limit: 10,
                    ..Default::default()
                },
            )
            .unwrap();
        }
    }

    /// Four printings across three sets with known mana values, including a NULL one —
    /// `cmc` is nullable and reversible cards genuinely have none.
    #[rustfmt::skip]
    fn seeded_costs() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows: [(&str, &str, &str, Option<f64>, &str); 4] = [
            ("1", "Lightning Bolt",  "lea", Some(1.0),  "R"),
            ("2", "Wrath of God",    "lea", Some(4.0),  "W"),
            ("3", "Emrakul",         "roe", Some(15.0), ""),
            ("4", "Jinnie Fay",      "sld", None,       "G"),
        ];
        for (id, name, set, cmc, ci) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,color_identity,
                    legalities,is_paper,search_text,raw)
                 VALUES (?1,?2,?3,'1','en','normal',?4,?5,'{\"modern\":\"legal\"}',1,?2,'{}')",
                rusqlite::params![id, name, set, cmc, ci],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        conn
    }

    fn names(r: &SearchResponse) -> Vec<&str> {
        r.items.iter().map(|c| c.name.as_str()).collect()
    }

    /// Two sets means "either", not "both" — the latter is always empty, and a filter that
    /// can only ever return nothing is a filter nobody would ship.
    #[test]
    fn several_sets_are_ored_together() {
        let conn = seeded_costs();
        let r = run_search(
            &conn,
            &SearchRequest {
                sets: Some(vec!["lea".into(), "roe".into()]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(r.total, 3);
        assert_eq!(names(&r), ["Emrakul", "Lightning Bolt", "Wrath of God"]);
    }

    /// The chips are discrete: 8 is the open-ended one, and everything below it is an
    /// exact match. `cast(cmc as int)` would put a 0.5 un-card under "0", which is a
    /// different claim than the one the chip makes.
    #[test]
    fn mana_value_chips_match_exactly_except_the_open_ended_one() {
        let conn = seeded_costs();

        let one = run_search(
            &conn,
            &SearchRequest {
                mana_values: Some(vec![1]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(names(&one), ["Lightning Bolt"]);

        let eight_plus = run_search(
            &conn,
            &SearchRequest {
                mana_values: Some(vec![8]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(names(&eight_plus), ["Emrakul"], "8 means 8 or more");

        let either = run_search(
            &conn,
            &SearchRequest {
                mana_values: Some(vec![1, 4]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(either.total, 2);
    }

    /// A card with no mana value is not a card with a mana value of zero. `NULL IN (…)`
    /// and `NULL >= 8` are both NULL, so this falls out of SQL's own semantics — the test
    /// is here so a later rewrite into `coalesce(cmc, 0)` fails loudly.
    #[test]
    fn a_null_mana_value_matches_no_chip() {
        let conn = seeded_costs();
        for chips in [vec![0u8], vec![8], vec![0, 1, 2, 3, 4, 5, 6, 7, 8]] {
            let r = run_search(
                &conn,
                &SearchRequest {
                    mana_values: Some(chips.clone()),
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            assert!(
                !names(&r).contains(&"Jinnie Fay"),
                "chips {chips:?} matched a NULL cmc"
            );
        }
    }

    /// Filters AND, including the new ones, and the capped count has to agree with the
    /// page — they share one `WHERE`, and this is what proves it stays that way.
    #[test]
    fn the_new_filters_combine_with_the_old_ones_and_the_count_agrees() {
        let conn = seeded_costs();
        let r = run_search(
            &conn,
            &SearchRequest {
                sets: Some(vec!["lea".into()]),
                mana_values: Some(vec![1, 4]),
                colors: Some("W".into()),
                format: Some("modern".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(names(&r), ["Wrath of God"]);
        assert_eq!(r.total, 1, "the count subquery must carry the same filters");
    }

    /// A picker whose "clear" state sends `[]` or `[""]` must not become a filter that
    /// matches nothing.
    #[test]
    fn empty_filter_lists_are_not_filters() {
        let conn = seeded_costs();
        let all = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap()
        .total;

        for req in [
            SearchRequest {
                sets: Some(vec![]),
                limit: 50,
                ..Default::default()
            },
            SearchRequest {
                sets: Some(vec!["".into(), "  ".into()]),
                limit: 50,
                ..Default::default()
            },
            SearchRequest {
                mana_values: Some(vec![]),
                limit: 50,
                ..Default::default()
            },
        ] {
            assert_eq!(run_search(&conn, &req).unwrap().total, all);
        }
    }

    /// `invoke` matches by name and serde renames to camelCase; a field the frontend
    /// spells differently deserializes to `None` with no error anywhere.
    #[test]
    fn the_request_deserializes_the_names_the_frontend_sends() {
        let req: SearchRequest = serde_json::from_str(
            r#"{"text":"bolt","sets":["lea","2ed"],"manaValues":[0,8],"paperOnly":true,"limit":50,"offset":0}"#,
        )
        .unwrap();

        assert_eq!(req.sets.unwrap(), vec!["lea".to_owned(), "2ed".to_owned()]);
        assert_eq!(req.mana_values.unwrap(), vec![0u8, 8]);
    }

    /// What the set picker is built from: every set, newest first, with the number of
    /// printings the local database actually holds for it.
    #[test]
    fn list_sets_reports_every_set_newest_first_with_its_card_count() {
        let conn = seeded_costs();
        conn.execute_batch(
            "INSERT INTO sets (code, name, set_type, released_at) VALUES
                ('lea','Limited Edition Alpha','core','1993-08-05'),
                ('roe','Rise of the Eldrazi','expansion','2010-04-23'),
                ('sld','Secret Lair Drop','box','2019-12-02'),
                ('tok','Token Set','token','2021-01-01');",
        )
        .unwrap();

        let sets = run_list_sets(&conn).unwrap();

        assert_eq!(sets.len(), 4);
        assert_eq!(
            sets.iter().map(|s| s.code.as_str()).collect::<Vec<_>>(),
            ["tok", "sld", "roe", "lea"],
            "newest first"
        );
        assert_eq!(sets[3].card_count, 2, "two Alpha printings are in `cards`");
        // A set the local database has no printings for still appears — it is the count
        // that lets the picker decide, not this function.
        assert_eq!(sets[0].card_count, 0);
    }

    /// The count is the picker's only signal, and the picker sits above a search that
    /// hides digital-only printings unless asked. Counting every row would put the 61
    /// Arena/MTGO sets in the list showing hundreds of cards and answering every query
    /// with nothing — `card_count` has to agree with what a default search can return,
    /// not with how many rows `cards` happens to hold.
    #[test]
    fn list_sets_counts_only_the_printings_a_default_search_can_return() {
        let conn = seeded_costs();
        conn.execute_batch(
            "INSERT INTO sets (code, name, set_type, released_at) VALUES
                ('lea','Limited Edition Alpha','core','1993-08-05'),
                ('ymid','Alchemy: Innistrad','alchemy','2021-12-09');",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('d1','Digital Only','ymid','1','en','normal',0,'{}')",
            [],
        )
        .unwrap();

        let sets = run_list_sets(&conn).unwrap();
        let count_of = |code: &str| sets.iter().find(|s| s.code == code).unwrap().card_count;

        assert_eq!(count_of("lea"), 2, "both Alpha printings are paper");
        assert_eq!(count_of("ymid"), 0, "its only printing is digital-only");
    }
}
