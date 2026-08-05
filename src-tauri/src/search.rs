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
    /// `Some(true)` narrows to printings the collection has an entry for, `Some(false)` to
    /// those it does not. Spec §7's owned/wishlist status filter, buildable at last now
    /// that the table exists.
    ///
    /// **An entry, not a copy.** A row emptied to zero is a row the collection keeps (see
    /// [`crate::collection::set_quantity`]), and this filter counts it as owned — the same
    /// reading as `CollectionSummary::unique_cards`, "printings recorded, not printings
    /// currently held". So a card whose only entry sits at zero passes `owned: true` while
    /// its [`CardSummary::owned_quantity`] reads `0`, and does *not* appear under
    /// `owned: false`. Deliberate, and the one place it could surprise a reader is a "what
    /// am I missing" list, which is the wishlist's `fulfilled` filter — that one counts
    /// copies, because a wish is filled by copies rather than by paperwork.
    pub owned: Option<bool>,
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
    /// The oracle card this printing is of. Nullable, because a reversible card has none.
    ///
    /// Here so a result row can be wished for as *any* printing without opening the card
    /// first — a wishlist usually means the card rather than the cardboard.
    pub oracle_id: Option<String>,
    /// The finishes this printing exists in, as the JSON array `cards.finishes` stores
    /// (`["nonfoil","foil"]`); `None` when the column is empty.
    ///
    /// A quick-add offers exactly these and nothing else. Without it the grid and the table
    /// offered nonfoil for every row, and a foil-only printing — UNF 449, whose blob really
    /// is `["foil"]` — took a nonfoil entry that then priced through a `usd` key its blob
    /// does not have, quietly under-reporting the collection's value.
    ///
    /// The two columns together average **50 bytes a row** over the live 116 k-card database
    /// (`oracle_id` is most of it), so a 50-row page carries ~2.5 KB more. That is the whole
    /// price of the trade the brief declined; it buys a correct entry on every surface.
    pub finishes: Option<String>,
    /// Copies the collection holds of **this printing**, across every finish and
    /// condition. `0` rather than `Option`: "you own none of these" is a fact, not an
    /// absence, and a badge that has to distinguish `null` from `0` is a badge with a bug
    /// waiting in it.
    pub owned_quantity: i64,
    /// Whether a wish covers this printing — pinned to it, or unpinned on its oracle card.
    pub wishlisted: bool,
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
    // `EXISTS` rather than a join: a card with four collection rows must still be one
    // result row, and this way the count subquery carries the same predicate for free.
    // Not in `filters.rs` because it is a statement about the *user*, not about a card.
    //
    // The probe itself is indexed (`idx_collection_card`), but the *driver* is still
    // `cards`, so `owned: true` over a browse walks the whole table looking for matches it
    // mostly does not find — and the fewer it can find, the further it walks, because the
    // count's cap is then unreachable and nothing stops it early. Kept anyway, and the
    // measurements say why the obvious fix is not one. Medians on the real 116 k-row
    // database, `EXISTS` as written against
    // `JOIN (SELECT DISTINCT card_id FROM collection_entries)`:
    //
    //   printings owned │ count EXISTS   count JOIN │ page 50 EXISTS   page 50 JOIN
    //   ────────────────┼───────────────────────────┼──────────────────────────────
    //            12 000 │     149 ms        26 ms   │      5.7 ms         54 ms
    //             2 000 │     336 ms        15 ms   │       28 ms         17 ms
    //               200 │     373 ms       2.1 ms   │      259 ms        2.2 ms
    //
    // The join wins every count and *loses* the page for the collector who has most —
    // driving from the collection means sorting its rows by name, which is exactly the work
    // `idx_cards_name` does for free when `cards` drives. The two statements therefore want
    // opposite shapes, and one predicate shared by both (which is what makes the count agree
    // with the page) cannot be both. Any future fix has to split them, not swap them.
    //
    // None of it touches the default browse: this filter is opt-in, and narrowed by any text
    // at all it is 0.1 ms. `owned: false` is 17 ms at every collection size, because a
    // predicate most rows satisfy reaches the cap immediately.
    match req.owned {
        Some(true) => p
            .wheres
            .push("EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = c.id)".to_owned()),
        Some(false) => p.wheres.push(
            "NOT EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = c.id)".to_owned(),
        ),
        None => {}
    }
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

    // The two status columns ride on the page query and **never on the count**, which does
    // not need them: they are correlated subqueries costing two indexed probes per row the
    // page *produces*, rather than per row counted — and the count walks to 5 001 on every
    // keystroke, which is where the ~10 ms browse budget already goes.
    //
    // Produces, not returns: `OFFSET` discards rows the query has already built, so a deep
    // page pays for its offset too. Measured on the 116 k-row database against a
    // 12 000-printing collection: the first page of 50 goes 0.16 ms → 1.6 ms, 200 rows cost
    // 3.5 ms, and page 100 (offset 5 000) goes 35 ms → 53 ms. The pager stops at the cap,
    // so that last figure is the worst one there is.
    let sql = format!(
        "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                c.type_line, c.mana_cost, c.price_usd, c.layout, c.oracle_id, c.finishes,
                coalesce((SELECT sum(e.quantity) FROM collection_entries e
                           WHERE e.card_id = c.id), 0),
                EXISTS (SELECT 1 FROM wishlist_entries w
                         WHERE w.card_id = c.id
                            OR (w.card_id IS NULL AND w.oracle_id IS NOT NULL
                                AND w.oracle_id = c.oracle_id))
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
            oracle_id: row.get(10).map_err(|e| e.to_string())?,
            finishes: row.get(11).map_err(|e| e.to_string())?,
            owned_quantity: row.get(12).map_err(|e| e.to_string())?,
            wishlisted: row.get(13).map_err(|e| e.to_string())?,
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
                oracle_id: Some("o-bolt".into()),
                finishes: Some(r#"["nonfoil","foil"]"#.into()),
                owned_quantity: 0,
                wishlisted: false,
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
                    "manaCost": null, "priceUsd": 400.5, "layout": "normal",
                    "oracleId": "o-bolt", "finishes": "[\"nonfoil\",\"foil\"]",
                    "ownedQuantity": 0, "wishlisted": false
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
    /// the write connection — under WAL the reader sees the last committed snapshot and
    /// never waits, and the only thing that used to serialise them was sharing one
    /// `Mutex<Connection>`. This test holds that lock outright, which is the guarantee
    /// being pinned: the chunked ingest releases it between batches, so a search that only
    /// answered in those gaps would still pass a gentler test and still stall a reader for
    /// the length of a batch. Run from another thread, as the real command is, so a
    /// regression to the shared lock fails here in five seconds rather than hanging the
    /// suite.
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
        let req: SearchRequest = serde_json::from_str(
            r#"{"text":"bolt","setCode":"lea","paperOnly":true,"owned":false}"#,
        )
        .unwrap();
        assert_eq!(req.set_code.as_deref(), Some("lea"));
        assert_eq!(req.paper_only, Some(true));
        // `Some(false)` and `None` are different filters — "the ones I do not have" against
        // "no opinion" — so this pins the value, not merely that the key parsed.
        assert_eq!(req.owned, Some(false));
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

    /// Spec §7: owned and wishlisted status travel with the result row, so the grid can
    /// badge a card the reader already has without a second round trip per tile.
    #[test]
    fn results_carry_what_the_user_owns_and_wants() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('1','lea','161','en','nonfoil','NM',3,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('1','lea','161','en','foil','NM',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        // An any-printing wish, matched through the oracle id rather than the printing.
        conn.execute("UPDATE cards SET oracle_id='o-bolt' WHERE id='1'", [])
            .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o-bolt',NULL,'Lightning Bolt',4,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let bolt = r.items.iter().find(|c| c.id == "1").unwrap();
        let helix = r.items.iter().find(|c| c.id == "2").unwrap();

        assert_eq!(bolt.owned_quantity, 4, "both finishes count toward 'owned'");
        assert!(bolt.wishlisted);
        assert_eq!(helix.owned_quantity, 0);
        assert!(!helix.wishlisted);
    }

    /// What a quick-add from a result row needs to be honest.
    ///
    /// Without `finishes` on this DTO the art grid and the search table offered nonfoil for
    /// every printing — the backend's `valid_finish` only checks the enum, so a foil-only
    /// printing (UNF 449, measured in the app) took a nonfoil entry, which then priced
    /// through a `usd` key its blob does not have and under-reported the collection's value.
    /// Without `oracle_id` the same two surfaces could only wish for *this* printing.
    /// Carried on the row, because a per-tile round trip for 50 tiles is 50 round trips.
    #[test]
    fn results_carry_the_finishes_a_printing_exists_in_and_its_oracle_card() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET finishes='[\"foil\"]', oracle_id='o-bolt' WHERE id='1'",
            [],
        )
        .unwrap();

        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let bolt = r.items.iter().find(|c| c.id == "1").unwrap();
        let helix = r.items.iter().find(|c| c.id == "2").unwrap();

        assert_eq!(bolt.finishes.as_deref(), Some(r#"["foil"]"#));
        assert_eq!(bolt.oracle_id.as_deref(), Some("o-bolt"));
        // Both columns are nullable, and a row that has neither is not a row that has
        // nonfoil: the caller reads `None` as "unknown" and offers its own default.
        assert_eq!(helix.finishes, None);
        assert_eq!(helix.oracle_id, None);
    }

    /// A wish pinned to one printing badges *that* printing, and not its siblings — which
    /// is the whole difference between "I want a Lightning Bolt" and "I want the Alpha
    /// one", carried through to the grid. The unpinned case is above; this is its twin, and
    /// the two together are what the `OR` in that subquery is for.
    #[test]
    fn a_pinned_wish_badges_only_the_printing_it_names() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET oracle_id='o-bolt' WHERE id IN ('1','2')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,set_code,name,quantity,
                created_at,updated_at)
             VALUES ('o-bolt','1','lea','Lightning Bolt',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let wished = |id: &str| r.items.iter().find(|c| c.id == id).unwrap().wishlisted;
        assert!(wished("1"));
        assert!(
            !wished("2"),
            "a wish for one printing is not a wish for every printing of the oracle card"
        );
    }

    /// The zero-row ruling, reaching the search: the collection keeps an entry taken to
    /// zero (`collection::set_quantity`), so this filter — which asks whether the
    /// collection has an *entry* for a printing, the same reading as
    /// `CollectionSummary::unique_cards` — still calls it owned, while `owned_quantity`
    /// counts copies and reads 0. Pinned rather than assumed, because the two halves
    /// disagreeing is exactly the kind of thing a badge would render as a bug.
    #[test]
    fn an_entry_emptied_to_zero_is_still_an_entry_the_collection_has() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('1','lea','161','en','nonfoil','NM',0,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let owned = run_search(
            &conn,
            &SearchRequest {
                owned: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(owned.items.len(), 1);
        assert_eq!(owned.items[0].id, "1");
        assert_eq!(
            owned.items[0].owned_quantity, 0,
            "an entry, but no copies — the badge and the filter answer different questions"
        );

        let missing = run_search(
            &conn,
            &SearchRequest {
                owned: Some(false),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            missing
                .items
                .iter()
                .map(|c| c.id.as_str())
                .collect::<Vec<_>>(),
            ["2"],
            "a printing the collection has a record of is not one it is missing"
        );
    }

    /// The filter §7 promised and Plan 2 could not build, because the table did not exist.
    /// Both directions, and the capped count has to agree with the page.
    #[test]
    fn the_owned_filter_narrows_in_both_directions() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('1','lea','161','en','nonfoil','NM',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let owned = run_search(
            &conn,
            &SearchRequest {
                owned: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(owned.total, 1);
        assert_eq!(owned.items[0].id, "1");

        let missing = run_search(
            &conn,
            &SearchRequest {
                owned: Some(false),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(missing.total, 1);
        assert_eq!(missing.items[0].id, "2");
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
