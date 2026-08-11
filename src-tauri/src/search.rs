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
    /// How to order the page: columns in priority order, the first deciding and the rest
    /// breaking its ties. Empty or absent is the default — relevance when `text` is set,
    /// name order when it is not. Keys outside [`SEARCH_SORTS`] are dropped, never
    /// interpolated.
    pub sort: Option<Vec<crate::sorting::SortTerm>>,
    /// Fold every printing of one card into a single row, represented by the newest
    /// printing.
    ///
    /// Absent means **false** — uncollapsed is what this command has always answered, so
    /// every caller that does not ask keeps the shape and the behaviour it had. The search
    /// view sends `true` explicitly.
    pub collapse: Option<bool>,
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
    /// The oracle card this printing is of.
    ///
    /// `Option` mirrors `cards.oracle_id`'s nullability and nothing else — **not** the
    /// belief that a reversible card has none, which is false and travelled through this
    /// codebase (see [`crate::card::list_printings`]). Scryfall omits only the *top-level*
    /// id, and [`crate::card_row`] falls back to `card_faces[0]`, so the column is filled:
    /// 0 of 116 590 live rows are NULL, all 81 reversible printings included. The
    /// nullability is a contract with a JSON shape, not a population, and every `None` arm
    /// downstream is a fence around the type rather than around a card you can find.
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
    /// How many printings this row stands for. `1` uncollapsed, always — a row *is* a
    /// printing then, and `1` is the true answer rather than a filler.
    ///
    /// Collapsed, it counts the printings that **matched the filters**, not every printing
    /// that exists: filters narrow printings first and the survivors are grouped, so a
    /// search restricted to one set reports how many printings are in that set. The row
    /// summarises the answer, never the database.
    pub printings: i64,
    /// Cheapest and dearest `price_usd` among the printings this row stands for. Both equal
    /// [`Self::price_usd`] uncollapsed.
    ///
    /// [`Self::price_usd`] stays what it always was — the representative printing's own
    /// value, itself a nonfoil→foil→etched fallback chain that must never be summed.
    pub price_low: Option<f64>,
    pub price_high: Option<f64>,
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

/// Columns of `cards` in name order, the default for a browse. The `id` tiebreak that used
/// to end this string is now appended by [`crate::sorting::order_by`], which every order
/// here goes through — one place, so no order can be written without one.
///
/// **This costs a full table scan, and it is the one order in this file that does.**
/// `idx_cards_name` can satisfy a leading `c.name` and block-sort *one* trailing term
/// within each group of identically-named printings; with two, SQLite gives up and sorts
/// all 107 k paper rows — and this string plus its tiebreak is three terms. Measured on the
/// live database 2026-08-09: **277 ms**, against **0.1 ms** for `c.name ASC, c.id ASC`,
/// which is what the Name column's own header sends. Left as it is deliberately: dropping
/// `released_at` would change which printing of a card the browse opens on, which is a
/// product decision and not a performance one.
const ORDER_NAME: &str = "c.name ASC, c.released_at DESC";

/// What makes two printings the same card.
///
/// `coalesce`, and not a bare `c.oracle_id`: the column is NULLABLE, and a bare `GROUP BY`
/// puts **every** null-oracle printing into one group — not a wrong row but a *merged* one,
/// showing unrelated cards under a single name with a printing count and a price range
/// spanning all of them, and nothing anywhere would flag it.
///
/// No live row is null (0 of 116 590, reversible printings included), so this is 69 ms —
/// 108 ms against 38 ms for the bare column — spent on a population of zero. Spent anyway,
/// because the failure is silent, and because the collapsed browse is still 2.3× faster than
/// today's uncollapsed one with it.
///
/// An **expression index** on this does not recover the 69 ms: SQLite will scan such an
/// index but will not treat it as *covering*, and the page went to 700 ms (measured
/// 2026-08-11). [`crate::schema::CARDS_INDEXES`]' `idx_cards_collapse` leads with the plain
/// `oracle_id` column, and the group step computes the coalesce as it scans.
const COLLAPSE_KEY: &str = "coalesce(c.oracle_id, c.id)";

/// The representative printing's `id`, straight out of the aggregate that picks it.
///
/// `released_at` is a fixed-width ISO date, so coalescing it to `'0000-00-00'` makes the
/// concatenation order exactly as `released_at DESC, id DESC` — and because that prefix is
/// always ten characters, `substr(…, 11)` **is** the winning row's id. That is what turns
/// the join back into a *primary-key* lookup: 108 ms, against 767 ms for joining on the
/// group key and matching the composite expression a second time.
///
/// Ties on `released_at` break to the **greatest** id, where [`ORDER_NAME`] breaks them to
/// the least. Ids are UUIDs, so both are arbitrary; this is the one that is written down.
const COLLAPSE_REP: &str = "substr(max(coalesce(c.released_at,'0000-00-00') || c.id), 11)";

/// Name order for a collapsed browse: the group's own name, which is also what it displays.
///
/// `min(c.name)`, not the representative's `c.name`. 71 of the 37 553 paper groups span two
/// names — all reversible cards, `Command Tower` beside `Command Tower // Command Tower` —
/// and `min` picks the canonical spelling in every one. Sorting by one and showing the other
/// would file a row under a name it does not read as.
const ORDER_NAME_COLLAPSED: &str = "min(c.name) ASC";

/// Layouts that are not a card anyone plays: art series and their front cards, tokens,
/// double-faced tokens, emblems.
///
/// A **ranking** term and never a filter — every printing that matched is still returned, in
/// both modes. This only decides what a relevance-ranked page puts first.
const NON_CARD_LAYOUTS: &str = "('art_series','front_card','token','double_faced_token','emblem')";

/// 1 for a non-card, 0 for a card — the first term of the relevance fallback.
///
/// It exists because searching `lightning bolt` returned
/// **`Lightning Bolt // Lightning Bolt` (`astx 76s`, `art_series`) above the real Lightning
/// Bolt**: the art card's name field holds the phrase twice, and bm25 rewards that.
/// Collapsing does not fix it — art series carry their own `oracle_id`, so they survive
/// grouping as their own rows.
///
/// Applied to the relevance fallback **only**. An explicit sort is what the reader asked
/// for, and name order already files an art card beside the card it depicts. Measured
/// 2026-08-11: the top five for "lightning bolt" went from two art cards and three real
/// ones to five real ones, at **0.2 ms either way**.
fn non_card_rank(alias: &str) -> String {
    format!("(CASE WHEN {alias}.layout IN {NON_CARD_LAYOUTS} THEN 1 ELSE 0 END)")
}

/// The columns the search table's headers can sort on, and nothing else.
///
/// `set` is the binder order — set code, then *natural* collector number, which is a `CAST`
/// because ~9% of collector numbers are not numeric (`741z`, `1★`, `A-123`) and a plain
/// string sort puts `100` before `2`. The same expression the collection has used since it
/// grew a set order.
///
/// Rarity is a **rank**: alphabetically `mythic` sits between `common` and `rare`, which is
/// an order describing nothing anybody wants. `special` and `bonus` are real values with no
/// place in the printed hierarchy and sort after it; anything unknown sorts last.
///
/// Every nullable column states its null rule in both directions rather than inheriting
/// SQLite's (NULLs first ascending, last descending): a reader reversing a sort expects the
/// rows reversed, not the holes moved.
///
/// There is no `released` key. The table has no Released column to press, the frontend has
/// never sent one, and an order nothing can reach is dead code.
const SEARCH_SORTS: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "c.name ASC",
        desc: "c.name DESC",
    },
    crate::sorting::SortColumn {
        key: "set",
        asc: "c.set_code ASC, CAST(c.collector_number AS INTEGER) ASC, c.collector_number ASC",
        desc: "c.set_code DESC, CAST(c.collector_number AS INTEGER) DESC, c.collector_number DESC",
    },
    crate::sorting::SortColumn {
        key: "type",
        asc: "c.type_line ASC NULLS LAST",
        desc: "c.type_line DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "rarity",
        asc: "CASE c.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 \
              WHEN 'mythic' THEN 3 WHEN 'special' THEN 4 WHEN 'bonus' THEN 5 ELSE 6 END ASC",
        desc: "CASE c.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 \
               WHEN 'mythic' THEN 3 WHEN 'special' THEN 4 WHEN 'bonus' THEN 5 ELSE 6 END DESC",
    },
    crate::sorting::SortColumn {
        key: "price",
        asc: "c.price_usd ASC NULLS LAST",
        desc: "c.price_usd DESC NULLS LAST",
    },
];

/// The sorts a **collapsed** search can answer inside its own group step.
///
/// The same keys as [`SEARCH_SORTS`], different SQL: a group has no `c.name` or
/// `c.price_usd` of its own, it has aggregates. Price sorts by the **ends of the range the
/// row shows** — cheapest-first ascending, dearest-available first descending — which is
/// what pressing a range column means in each direction, and what CLAUDE.md's rule requires:
/// a header sorts by what its column shows.
///
/// `set`, `rarity` and `type` are **deliberately absent**. They belong to the representative
/// printing, which the group step has not resolved yet, so they are applied after the join
/// instead (see [`run_search`]). Listing them here would sort by an aggregate — "the best
/// rarity this card was ever printed at" — which is not what the column shows.
const SEARCH_SORTS_COLLAPSED: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "min(c.name) ASC",
        desc: "min(c.name) DESC",
    },
    crate::sorting::SortColumn {
        key: "price",
        asc: "min(c.price_usd) ASC NULLS LAST",
        desc: "max(c.price_usd) DESC NULLS LAST",
    },
];

/// The sort keys a collapsed search must resolve **after** the join, because they belong to
/// the representative printing rather than to the group.
///
/// Naming one costs the whole 37 553-group join before the limit: 600–620 ms on a completely
/// unfiltered browse against 108 ms for the group-step orders, and ~40 ms as soon as any text
/// narrows the set (measured 2026-08-11).
const REPRESENTATIVE_SORTS: [&str; 3] = ["set", "rarity", "type"];

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

    // Matched against literals, never interpolated from `req.sort` — see `sorting`, which
    // also appends the `c.id` tiebreak that makes ties (at 116 k printings the common case,
    // not the exception) page deterministically.
    //
    // The fallback when nothing is asked for. `bm25` returns *smaller* numbers for better
    // matches, so plain ascending order is best-first. The weights are (name, type_line,
    // search_text): a card whose name is what was typed beats one that merely mentions it
    // in its rules text, which alphabetical order had no way to express.
    //
    // [`non_card_rank`] leads it: an art card whose name repeats the query outscores the card
    // it depicts, and relevance is the only order where that is wrong. See the constant.
    let fallback = if ranked {
        format!(
            "{} ASC, bm25(cards_fts, 10.0, 1.0, 1.0) ASC, c.name ASC",
            non_card_rank("c")
        )
    } else {
        ORDER_NAME.to_owned()
    };
    let order = crate::sorting::order_by(req.sort.as_deref(), SEARCH_SORTS, &fallback, "c.id ASC");

    let collapse = req.collapse.unwrap_or(false);

    // Which half of the collapsed query owns the ordering. A sort naming set, rarity or type
    // is about the *representative printing*, which the group step has not resolved yet — so
    // it cannot be applied until after the join, and every group is therefore joined and
    // sorted before the limit. See [`REPRESENTATIVE_SORTS`] for what that costs.
    let sorts_after_join = collapse
        && req
            .sort
            .as_deref()
            .unwrap_or(&[])
            .iter()
            .any(|t| REPRESENTATIVE_SORTS.contains(&t.key.as_str()));

    // The count runs first, while `params` still holds exactly the filter parameters and
    // nothing else. `LIMIT` inside the subquery is what bounds the work: SQLite stops
    // producing rows at the cap, so the count costs the cap, not the table.
    //
    // Collapsed, the denominator is a count of **cards**: the pager divides by it and the
    // caption prints it, so counting printings over a list of cards would be a lie in both
    // places. The cap still bounds it — SQLite stops producing *groups* at 5 001.
    let count_sql = if collapse {
        format!(
            "SELECT count(*) FROM (SELECT 1 FROM {from_sql} WHERE {where_sql} \
             GROUP BY {COLLAPSE_KEY} LIMIT {cap})",
            cap = TOTAL_CAP + 1
        )
    } else {
        format!(
            "SELECT count(*) FROM (SELECT 1 FROM {from_sql} WHERE {where_sql} LIMIT {cap})",
            cap = TOTAL_CAP + 1
        )
    };
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
    let sql = if collapse {
        // Two steps. The group step computes every aggregate **and** the representative's
        // id, and it takes the `LIMIT` — so at most 50 rows are ever fetched out of
        // `cards`. Then one primary-key join back for that row's own columns.
        //
        // **The two status subqueries probe `c.oracle_id` — the joined representative's own
        // indexed column — and never `g.oid`.** Writing them against the group key cost
        // 1 514 ms on the browse and 12 729 ms on the rarity sort (measured 2026-08-11),
        // because `coalesce(…)` is not indexable and each of 37 553 groups then re-scanned
        // `cards`. It is the most expensive mistake available in this file.
        //
        // The cost of that choice is one edge case: a card whose `oracle_id` is NULL reads
        // `0` copies rather than merging with another card's. A fence around the type,
        // which is how the rest of the app treats a null `oracle_id` too.
        //
        // `g.nm` is `min(c.name)` and is what the row *displays*, so the browse sorts and
        // reads by the same string — see `ORDER_NAME_COLLAPSED`.
        // Ranked collapsed searches need the score aggregated per group, and **`bm25()`
        // cannot be aggregated**: `min(bm25(…))`, the same expression in a subquery, and an
        // ordinary CTE all fail with "unable to use function bm25 in the requested context"
        // (all four forms measured 2026-08-11). Only `MATERIALIZED` works, so it is
        // load-bearing syntax rather than a tidiness hint.
        //
        // FTS5's `rank` column *does* aggregate — and carries the table's default weights,
        // which would silently throw away the 10× name weighting that
        // `relevance_puts_the_card_that_is_named_for_the_query_first` exists to protect.
        // **The CTE exists only when the search is ranked**, and that is a performance
        // decision as much as a correctness one: `MATERIALIZED` means "build this into a
        // temp table first", which is right for a text search (FTS has already narrowed it
        // to a handful of rows) and catastrophic for a browse, where it would materialise
        // all 107 k paper rows before the grouping could touch the covering index. Unranked,
        // the group step reads `cards` directly and `idx_cards_collapse` does its job.
        //
        // `min()` over the non-card rank is exact rather than approximate, and the
        // measurement is why: **no oracle group mixes the two kinds** — 3 610 groups are
        // represented by an art or token row and 0 of them also contains a real printing
        // (measured 2026-08-11). If that ever stopped holding, the term would degrade to
        // "demote a group if any of its printings is a non-card", which is a ranking nudge
        // and not a correctness failure.
        let (cte, group_from, group_where, score_select, score_term) = if ranked {
            (
                format!(
                    "WITH m AS MATERIALIZED (
                        SELECT c.*, bm25(cards_fts, 10.0, 1.0, 1.0) AS score
                        FROM {from_sql} WHERE {where_sql}
                     ),"
                ),
                "m c".to_owned(),
                "1=1".to_owned(),
                format!("min(c.score) AS score, min{} AS nc,", non_card_rank("c")),
                format!("min{} ASC, min(c.score) ASC, ", non_card_rank("c")),
            )
        } else {
            (
                "WITH".to_owned(),
                from_sql.to_owned(),
                where_sql.clone(),
                String::new(),
                String::new(),
            )
        };

        let group_fallback = format!("{score_term}{ORDER_NAME_COLLAPSED}");
        let group_order = crate::sorting::order_by(
            req.sort.as_deref(),
            SEARCH_SORTS_COLLAPSED,
            &group_fallback,
            &format!("{COLLAPSE_KEY} ASC"),
        );
        // When the sort lands after the join the group step must not take the limit, or it
        // would limit the wrong 50 groups — the ones that lead in *name* order.
        let group_limit = if sorts_after_join {
            ""
        } else {
            "LIMIT ? OFFSET ?"
        };
        let final_order = if sorts_after_join {
            format!("{order} LIMIT ? OFFSET ?")
        } else if ranked {
            "g.nc ASC, g.score ASC, g.nm ASC, c.id ASC".to_owned()
        } else {
            "g.nm ASC, c.id ASC".to_owned()
        };

        format!(
            "{cte} g AS (
                SELECT {COLLAPSE_KEY} AS oid, count(*) AS printings,
                       min(c.price_usd) AS lo, max(c.price_usd) AS hi, min(c.name) AS nm,
                       {score_select}
                       {COLLAPSE_REP} AS rep
                FROM {group_from} WHERE {group_where}
                GROUP BY {COLLAPSE_KEY}
                ORDER BY {group_order} {group_limit}
             )
             SELECT c.id, g.nm, c.set_code, c.set_name, c.collector_number, c.rarity,
                    c.type_line, c.mana_cost, c.price_usd, c.layout, c.oracle_id, c.finishes,
                    coalesce((SELECT sum(e.quantity) FROM collection_entries e
                               JOIN cards k ON k.id = e.card_id
                              WHERE k.oracle_id = c.oracle_id), 0),
                    EXISTS (SELECT 1 FROM wishlist_entries w
                             WHERE (w.oracle_id IS NOT NULL AND w.oracle_id = c.oracle_id)
                                OR w.card_id IN (SELECT id FROM cards
                                                  WHERE oracle_id = c.oracle_id)),
                    g.printings, g.lo, g.hi
             FROM g JOIN cards c ON c.id = g.rep
             ORDER BY {final_order}"
        )
    } else {
        format!(
            "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                    c.type_line, c.mana_cost, c.price_usd, c.layout, c.oracle_id, c.finishes,
                    coalesce((SELECT sum(e.quantity) FROM collection_entries e
                               WHERE e.card_id = c.id), 0),
                    EXISTS (SELECT 1 FROM wishlist_entries w
                             WHERE w.card_id = c.id
                                OR (w.card_id IS NULL AND w.oracle_id IS NOT NULL
                                    AND w.oracle_id = c.oracle_id))
             FROM {from_sql} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
        )
    };
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
            // Uncollapsed, a row is a printing: it stands for one, and its "range" is its
            // own price. Collapsed, the three ride on the group step's aggregates.
            printings: if collapse {
                row.get(14).map_err(|e| e.to_string())?
            } else {
                1
            },
            price_low: if collapse {
                row.get(15).map_err(|e| e.to_string())?
            } else {
                row.get(8).map_err(|e| e.to_string())?
            },
            price_high: if collapse {
                row.get(16).map_err(|e| e.to_string())?
            } else {
                row.get(8).map_err(|e| e.to_string())?
            },
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
/// writer's longest job is the ingest, ~80 s of a 92–99 s sync, and a search sharing its
/// mutex would queue behind it — the app would stop answering searches once a day for the
/// length of a sync. Chunking the ingest bounded that wait to one 2 000-row batch, but a
/// search must not wait for a batch either: 20 timed searches across a live sync, every
/// one correct, none stalled. Under WAL a reader sees the last committed snapshot
/// without blocking, so it
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

    /// One sort term, in the shape the UI sends.
    fn term(key: &str, dir: &str) -> crate::sorting::SortTerm {
        crate::sorting::SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

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
        fill_legal_mask(&conn);
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');").unwrap();
        conn
    }

    /// The `legal_mask` the ingest writes beside `legalities`, filled the way the v9
    /// migration fills it: [`crate::legalities::mask_sql`] over the column the fixture rows
    /// already carry.
    ///
    /// Every fixture here writes its rows by hand, so nothing has computed a mask — and the
    /// format filter reads the mask now rather than the JSON. Without this a format search
    /// over a fixture answers with an empty list, which is a fixture that is wrong rather
    /// than a filter that is.
    fn fill_legal_mask(conn: &Connection) {
        conn.execute_batch(&format!(
            "UPDATE cards SET legal_mask = {};",
            crate::legalities::mask_sql("legalities")
        ))
        .unwrap();
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

    /// `restricted` counts as playable — a Vintage search that hid Black Lotus would be
    /// wrong. The rule survived the move to `legal_mask` because the **mask** encodes it
    /// (`legalities::PLAYABLE`), which is why the SQL no longer says so and why this test is
    /// the one that would notice if it stopped being true.
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
        assert_eq!(
            r.items[0].name, "Lightning Bolt",
            "the restricted card is the one that came back, not some other row"
        );
    }

    /// A format this build has never heard of matches nothing. `json_extract` of an absent
    /// key was NULL and `NULL IN (…)` is NULL, so the old form returned no rows; the mask
    /// form has to be *told* to, because a key with no bit has nothing to test and leaving
    /// the clause out would turn an unknown format into no filter at all — the whole corpus,
    /// silently, which is the failure nobody reports because a list showing too much still
    /// looks like a list.
    #[test]
    fn a_format_the_build_does_not_know_matches_nothing() {
        let conn = seeded();
        let unfiltered = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            unfiltered.total, 2,
            "there is something here to over-return"
        );

        let r = run_search(
            &conn,
            &SearchRequest {
                format: Some("some_format_scryfall_invented".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 0);
        assert!(r.items.is_empty());
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
                sort: Some(vec![term("name", "asc")]),
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

        // Every single-column order, and a two-key one — which is the case a multi-key
        // sort adds and the one where a missing tiebreak would be easiest to miss, because
        // the second key makes the order *look* more determined than it is.
        let orders: [(&str, Vec<crate::sorting::SortTerm>); 6] = [
            ("name", vec![term("name", "asc")]),
            ("set", vec![term("set", "desc")]),
            ("type", vec![term("type", "asc")]),
            ("rarity", vec![term("rarity", "asc")]),
            ("price", vec![term("price", "desc")]),
            (
                "rarity+price",
                vec![term("rarity", "asc"), term("price", "desc")],
            ),
        ];
        for (label, sort) in orders {
            let mut seen: Vec<String> = Vec::new();
            for page in 0..4 {
                let r = run_search(
                    &conn,
                    &SearchRequest {
                        sort: Some(sort.clone()),
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
                "paging by `{label}` returned a row twice: {seen:?}"
            );
            assert_eq!(seen.len(), 8, "four pages of two, sorted by `{label}`");
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
                printings: 1,
                price_low: Some(400.5),
                price_high: Some(400.5),
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
                    "ownedQuantity": 0, "wishlisted": false,
                    "printings": 1, "priceLow": 400.5, "priceHigh": 400.5
                }],
                "total": 5000,
                "totalIsCapped": true
            })
        );
    }

    /// Uncollapsed, a row stands for exactly one printing and its "range" is its own price.
    /// One DTO shape for both modes, so no consumer has to know which produced a row.
    #[test]
    fn an_uncollapsed_row_reports_one_printing_and_a_degenerate_price_range() {
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
        let card = &r.items[0];
        assert_eq!(card.printings, 1);
        assert_eq!(card.price_low, card.price_usd);
        assert_eq!(card.price_high, card.price_usd);
    }

    /// Three printings of one card become one row, and the row says how many it stands for
    /// and what the cheapest and dearest of them cost.
    #[test]
    fn collapse_folds_every_printing_of_a_card_into_one_row() {
        let conn = seeded();
        for (id, set, released, price) in [
            ("b1", "lea", "1993-08-05", 400.0),
            ("b2", "m10", "2009-07-17", 5.0),
            ("b3", "m11", "2010-07-16", 3.0),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,released_at,
                                    price_usd,is_paper,oracle_id,raw)
                 VALUES (?1,'Shock',?2,'1','en','normal',?3,?4,1,'o-shock','{}')",
                rusqlite::params![id, set, released, price],
            )
            .unwrap();
        }

        let r = run_search(
            &conn,
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        let shocks: Vec<&CardSummary> = r.items.iter().filter(|c| c.name == "Shock").collect();
        assert_eq!(shocks.len(), 1, "three printings, one row");
        assert_eq!(shocks[0].printings, 3);
        assert_eq!(
            shocks[0].id, "b3",
            "the newest printing represents the card"
        );
        assert_eq!(shocks[0].price_low, Some(3.0));
        assert_eq!(shocks[0].price_high, Some(400.0));
    }

    /// `total` is a count of **cards** when the rows are cards. A caption reading "5 cards"
    /// over three rows would be the pager's denominator lying to the reader.
    #[test]
    fn the_total_counts_cards_when_the_search_is_collapsed() {
        let conn = seeded();
        for id in ["b1", "b2", "b3"] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                    oracle_id,raw)
                 VALUES (?1,'Shock','lea',?1,'en','normal',1,'o-shock','{}')",
                rusqlite::params![id],
            )
            .unwrap();
        }
        let flat = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let collapsed = run_search(
            &conn,
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        // The fixture's own two paper rows carry no `oracle_id`, so each is its own card.
        assert_eq!(flat.total, 5, "two fixture printings plus three Shocks");
        assert_eq!(collapsed.total, 3, "two fixture cards plus one Shock");
        assert_eq!(collapsed.total as usize, collapsed.items.len());
    }

    /// `cards.oracle_id` is NULLABLE. A bare `GROUP BY c.oracle_id` puts every null-oracle
    /// printing in one group — not a wrong row but a *merged* one, showing unrelated cards
    /// under a single name with a printing count spanning all of them, and nothing anywhere
    /// would flag it. No live row is null (0 of 116 590), so this case exists only here —
    /// and [`COLLAPSE_KEY`]'s `coalesce` is what it pins.
    #[test]
    fn printings_with_no_oracle_id_are_each_their_own_card() {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        for (id, name) in [("n1", "Alpha"), ("n2", "Beta")] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
                 VALUES (?1,?2,'lea','1','en','normal',1,'{}')",
                rusqlite::params![id, name],
            )
            .unwrap();
        }
        let r = run_search(
            &conn,
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.total, 2, "two cards, not one merged group");
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "Beta"]);
        assert!(r.items.iter().all(|c| c.printings == 1));
    }

    /// Filters narrow printings first; the survivors are grouped. So the count and the
    /// range describe what matched, and never the whole database.
    #[test]
    fn the_printing_count_describes_what_matched_and_not_the_database() {
        let conn = seeded();
        for (id, set, price) in [("b1", "lea", 400.0), ("b2", "m10", 5.0), ("b3", "m10", 3.0)] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,price_usd,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,'Shock',?2,?1,'en','normal',?3,1,'o-shock','{}')",
                rusqlite::params![id, set, price],
            )
            .unwrap();
        }
        let r = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("m10".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(
            r.items[0].printings, 2,
            "the two m10 printings, not all three"
        );
        assert_eq!(
            r.items[0].price_high,
            Some(5.0),
            "and priced across those two"
        );
    }

    /// "Do I have this card" is the question a collapsed row asks, so copies of *any*
    /// printing count toward it. Uncollapsed the same fixture still answers per printing.
    #[test]
    fn a_collapsed_row_counts_copies_of_every_printing_of_the_card() {
        let conn = seeded();
        for (id, set) in [("b1", "lea"), ("b2", "m10")] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                    oracle_id,released_at,search_text,raw)
                 VALUES (?1,'Shock',?2,?1,'en','normal',1,'o-shock','2009-01-01','Shock','{}')",
                rusqlite::params![id, set],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,
                 created_at,updated_at)
             VALUES ('b1','lea','b1','en','nonfoil','NM',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let collapsed = run_search(
            &conn,
            &SearchRequest {
                text: Some("shock".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(collapsed.items.len(), 1);
        assert_eq!(
            collapsed.items[0].owned_quantity, 2,
            "copies of any printing of the card"
        );

        let flat = run_search(
            &conn,
            &SearchRequest {
                text: Some("shock".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let b2 = flat.items.iter().find(|c| c.id == "b2").unwrap();
        assert_eq!(b2.owned_quantity, 0, "uncollapsed is still per printing");
    }

    /// Sorting a collapsed list by price sorts by the **range**: cheapest-first ascending,
    /// dearest-available first descending. That is what pressing a range column means in
    /// each direction, and it is what the column shows.
    #[test]
    fn a_collapsed_price_sort_orders_by_the_ends_of_the_range() {
        let conn = seeded();
        for (id, name, oracle, price) in [
            ("s1", "Shock", "o-shock", 1.0),
            ("s2", "Shock", "o-shock", 90.0),
            ("t1", "Terror", "o-terror", 10.0),
            ("t2", "Terror", "o-terror", 20.0),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,price_usd,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'zzz',?1,'en','normal',?3,1,?4,'{}')",
                rusqlite::params![id, name, price, oracle],
            )
            .unwrap();
        }
        let up = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                collapse: Some(true),
                sort: Some(vec![term("price", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = up.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Shock", "Terror"],
            "cheapest printing first: 1 before 10"
        );

        let down = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                collapse: Some(true),
                sort: Some(vec![term("price", "desc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = down.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Shock", "Terror"],
            "dearest printing first: 90 before 20"
        );
    }

    /// Rarity, set and type belong to the **representative printing**, so the collapsed
    /// query sorts after the join rather than inside the group step — and the rank order
    /// (not the alphabet) still decides.
    #[test]
    fn a_collapsed_rarity_sort_uses_the_representative_and_keeps_the_rank_order() {
        let conn = seeded();
        for (id, name, oracle, rarity) in [
            ("r1", "Aa Rare", "o-rare", "rare"),
            ("r2", "Bb Common", "o-common", "common"),
            ("r3", "Cc Mythic", "o-mythic", "mythic"),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,rarity,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'zzz',?1,'en','normal',?3,1,?4,'{}')",
                rusqlite::params![id, name, rarity, oracle],
            )
            .unwrap();
        }
        let r = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                collapse: Some(true),
                sort: Some(vec![term("rarity", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let rarities: Vec<&str> = r.items.iter().filter_map(|c| c.rarity.as_deref()).collect();
        assert_eq!(
            rarities,
            ["common", "rare", "mythic"],
            "rank order, not alphabetical"
        );
    }

    /// A representative-column sort must page as one list: the group step gives up its
    /// `LIMIT` so the offset applies to the *sorted* rows and not to the 50 that happened to
    /// lead in name order.
    #[test]
    fn a_representative_sort_pages_over_the_sorted_list_and_not_the_first_50_by_name() {
        let conn = seeded();
        for (i, rarity) in ["mythic", "rare", "uncommon", "common"].iter().enumerate() {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,rarity,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'zzz',?1,'en','normal',?3,1,?1,'{}')",
                rusqlite::params![format!("z{i}"), format!("Card {i}"), rarity],
            )
            .unwrap();
        }
        let page2 = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                collapse: Some(true),
                sort: Some(vec![term("rarity", "asc")]),
                limit: 2,
                offset: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let rarities: Vec<&str> = page2
            .items
            .iter()
            .filter_map(|c| c.rarity.as_deref())
            .collect();
        assert_eq!(
            rarities,
            ["rare", "mythic"],
            "the second page of the rank order"
        );
    }

    /// A collapsed text search is still ranked by relevance, the group taking the best score
    /// any of its printings scored.
    ///
    /// `bm25()` **cannot be aggregated** outside a `MATERIALIZED` CTE — a plain CTE, a
    /// subquery and a direct `min(bm25(…))` all raise "unable to use function bm25 in the
    /// requested context". This test is what fails if that CTE is ever "simplified", and it
    /// fails as a hard SQL error rather than as a bad ordering.
    #[test]
    fn a_collapsed_text_search_is_ranked_by_its_best_printing() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,type_line,is_paper,
                                oracle_id,search_text,raw)
             VALUES ('e1','Emeritus of Conflict // Lightning Bolt','sos','7','en','normal',
                     'Creature',1,'o-emeritus','Emeritus of Conflict Lightning Bolt','{}')",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("lightning bolt".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Lightning Bolt", "Emeritus of Conflict // Lightning Bolt"],
            "the exact name outranks the card that merely contains it, collapsed too"
        );
    }

    /// `Lightning Bolt // Lightning Bolt` (`astx 76s`, layout `art_series`) outranked the
    /// real Lightning Bolt for the query "lightning bolt", because its name field contains
    /// the phrase twice and bm25 rewards that. Collapse does not fix it — art series carry
    /// their own `oracle_id` — so relevance demotes them instead.
    ///
    /// Nothing is hidden: the art card is still returned, below the card it depicts.
    #[test]
    fn art_cards_rank_below_the_card_they_depict() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                oracle_id,search_text,raw)
             VALUES ('art','Lightning Bolt // Lightning Bolt','astx','76s','en','art_series',1,
                     'o-art','Lightning Bolt Lightning Bolt','{}')",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        for collapse in [None, Some(true)] {
            let r = run_search(
                &conn,
                &SearchRequest {
                    text: Some("lightning bolt".into()),
                    collapse,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            assert_eq!(
                r.items[0].name, "Lightning Bolt",
                "the real card leads (collapse: {collapse:?})"
            );
            assert!(
                r.items.iter().any(|c| c.id == "art"),
                "and the art card is still returned, not hidden (collapse: {collapse:?})"
            );
        }
    }

    /// The demotion is on the relevance *fallback* only. An explicit sort is what the reader
    /// asked for, and name order files an art card beside the card it depicts, which is
    /// where it belongs.
    #[test]
    fn an_explicit_sort_is_not_demoted() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                oracle_id,search_text,raw)
             VALUES ('art','Aardvark Art','astx','1','en','art_series',1,'o-art',
                     'Aardvark Art','{}')",
            [],
        )
        .unwrap();
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        let r = run_search(
            &conn,
            &SearchRequest {
                sort: Some(vec![term("name", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items[0].id, "art", "alphabetical is alphabetical");
    }

    /// `collapse` is optional in the payload and absent means false, so every existing
    /// caller sends what it always sent and gets what it always got.
    #[test]
    fn collapse_is_absent_by_default_and_parses_when_sent() {
        let bare: SearchRequest = serde_json::from_str(r#"{"text":"bolt"}"#).unwrap();
        assert_eq!(bare.collapse, None);
        let set: SearchRequest = serde_json::from_str(r#"{"collapse":true}"#).unwrap();
        assert_eq!(set.collapse, Some(true));
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
            index: std::sync::RwLock::default(),
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

    /// The default browse still puts the newest printing of a name first, which is what
    /// `ORDER_NAME`'s `released_at DESC` is for. Pinned because that term is also what
    /// costs the browse a full table scan (see the constant), so the temptation to drop it
    /// is real and the behaviour it buys should fail loudly if anyone does.
    #[test]
    fn the_default_browse_puts_the_newest_printing_of_a_name_first() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,released_at,is_paper,raw)
             VALUES ('old','Lightning Bolt','lea','161','en','normal','1993-08-05',1,'{}'),
                    ('new','Lightning Bolt','m11','149','en','normal','2010-07-16',1,'{}')",
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
        let bolts: Vec<&str> = r
            .items
            .iter()
            .filter(|c| c.name == "Lightning Bolt")
            .map(|c| c.id.as_str())
            .collect();
        assert_eq!(
            bolts,
            ["new", "old", "1"],
            "newest release first, then NULL"
        );
    }

    /// Alphabetically `mythic` sits between `common` and `rare`, which is an order
    /// describing nothing anybody wants.
    #[test]
    fn rarity_sorts_by_rank_and_not_alphabetically() {
        let conn = seeded();
        let r = run_search(
            &conn,
            &SearchRequest {
                paper_only: Some(false),
                sort: Some(vec![term("rarity", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let rarities: Vec<&str> = r.items.iter().filter_map(|c| c.rarity.as_deref()).collect();
        assert_eq!(rarities, ["common", "uncommon", "rare"]);

        let down = run_search(
            &conn,
            &SearchRequest {
                paper_only: Some(false),
                sort: Some(vec![term("rarity", "desc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let rarities: Vec<&str> = down
            .items
            .iter()
            .filter_map(|c| c.rarity.as_deref())
            .collect();
        assert_eq!(rarities, ["rare", "uncommon", "common"]);
    }

    /// The whole point of a list rather than one key: cheapest *within* each rarity is a
    /// question one sort key cannot ask.
    #[test]
    fn a_second_term_breaks_the_first_ones_ties() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,rarity,price_usd,is_paper,raw)
             VALUES ('c1','Cheap Common','lea','2','en','normal','common',1.0,1,'{}'),
                    ('c2','Dear Common','lea','3','en','normal','common',9.0,1,'{}')",
            [],
        )
        .unwrap();
        let r = run_search(
            &conn,
            &SearchRequest {
                sort: Some(vec![term("rarity", "asc"), term("price", "desc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = r.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            [
                // The fixture's Lightning Bolt is a $400 common, so it leads them.
                "Lightning Bolt",
                "Dear Common",
                "Cheap Common",
                // And the uncommon follows every common however cheap.
                "Lightning Helix"
            ],
            "commons first, dearest within them, then the uncommon"
        );
    }

    /// `set` is the binder order, and a collector number is TEXT: a plain string sort puts
    /// `100` before `2`, which is not how a binder is laid out.
    #[test]
    fn the_set_order_counts_collector_numbers_rather_than_spelling_them() {
        let conn = seeded();
        for cn in ["2", "10", "100"] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
                 VALUES (?1,'Numbered','zzz',?2,'en','normal',1,'{}')",
                rusqlite::params![format!("zzz-{cn}"), cn],
            )
            .unwrap();
        }
        let r = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                sort: Some(vec![term("set", "asc")]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let numbers: Vec<&str> = r
            .items
            .iter()
            .map(|c| c.collector_number.as_str())
            .collect();
        assert_eq!(numbers, ["2", "10", "100"]);
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
                sort: Some(vec![term("c.name; DROP TABLE cards", "asc")]),
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
                sort: Some(vec![term("price", "desc")]),
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
    /// "no filter": `set_code = ''` matches nothing, and `""` is a format no build knows,
    /// which the mask filter spells `0` — an empty list rather than an absent filter. Before
    /// the mask it was worse still: a blank made the json path `'$.'`, which SQLite rejects,
    /// failing the entire search rather than one filter.
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

    /// Four printings across three sets with known mana values, including a NULL one.
    ///
    /// The NULL is here for the *column*, not for a kind of card: `cmc` is nullable in the
    /// JSON contract, so the mana-value chips and the `NULLS LAST` sorts have to place a
    /// row that has none — but no live row does. [`crate::card_row`] falls back to
    /// `card_faces[0].cmc` exactly as it does for `oracle_id`, and 0 of 116 590 rows are
    /// NULL, reversible printings included. A fixture is where that case can be exercised
    /// at all.
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
        fill_legal_mask(&conn);
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
