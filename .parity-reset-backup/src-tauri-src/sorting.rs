//! What the selected marketplace does to a query: the price expression, and the `ORDER BY`.
//!
//! Two jobs, one module, because they are the same decision read twice. The marketplace
//! decides *where a price comes from*, and a money sort has to order by the very figure the
//! row shows — so the expression and the order that reads it cannot be chosen in two places.
//!
//! **Rust returns one price per row.** An earlier build carried a USD twin and a EUR twin on
//! every row and let TypeScript pick, which was right while a price was one of two keys of
//! one JSON blob. Card Kingdom and Mana Pool prices live in a *table*, so that shape would
//! mean four figures per row today and five the day Card trader lands, each one ignored by
//! four out of five renders. The marketplace is a query parameter now, and switching it
//! refetches — against local SQLite, like every other filter in this app.
//!
//! The `ORDER BY` builder itself is unchanged in the property that matters: a sort arrives
//! from the UI as an ordered list of `{key, dir}`, nothing in it is ever interpolated, a key
//! is looked up in the calling table's whitelist and dropped when it misses, and a direction
//! picks one of two literals. The only thing a *request* can influence is which of a fixed
//! set of clauses is used and in what order. The price expression folded into a money clause
//! is built by [`price_expr`] from an enum, never from a string off the wire.

use serde::Deserialize;

/// One term of a sort, as the UI sends it.
///
/// `dir` is a string rather than an enum because a bad value must be a *default*, not a
/// deserialization failure: a list that refuses to load is a worse answer to a typo in a
/// payload than a list in ascending order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortTerm {
    pub key: String,
    pub dir: String,
}

/// A column a table will sort on: the key the UI sends, and the SQL for each direction.
///
/// Both directions are written out rather than one clause plus an appended `DESC`, because
/// half of them are not one column — `set` is three — and every nullable column states its
/// null rule in both directions rather than inheriting SQLite's (NULLs first ascending,
/// last descending, which reads as a different sort rather than as the same one reversed).
#[derive(Debug, Clone, Copy)]
pub struct SortColumn {
    pub key: &'static str,
    pub asc: &'static str,
    pub desc: &'static str,
}

/// A **money** column: a [`SortColumn`] with [`PRICE_HOLE`] standing in for the selected
/// marketplace's price.
///
/// One spelling per key, not one per marketplace. The previous shape wrote each money sort
/// out twice, in dollars and in euros, and the failure mode of that copy was silent — a sort
/// added to one half and forgotten in the other is a header that quietly stops working the
/// day the reader picks the other marketplace, and no test that only ever asks in dollars
/// would notice. With four marketplaces and a fifth coming that copy is four spellings, so
/// the whole class of mistake is spelled away instead: there is one clause, and
/// [`sorts_for`] fills the hole.
#[derive(Debug, Clone, Copy)]
pub struct PricedSort {
    pub key: &'static str,
    pub asc: &'static str,
    pub desc: &'static str,
}

/// What [`sorts_for`] replaces in a [`PricedSort`]'s clauses.
///
/// A money clause that does not contain it is a clause that ignores the marketplace, which is
/// exactly the bug the templates exist to make impossible — so every table's list is checked
/// for it (`a_priced_sort_names_the_price_hole`, run per table in that table's own module).
pub const PRICE_HOLE: &str = "{price}";

/// A resolved sort column: a [`SortColumn`] verbatim, or a [`PricedSort`] with the
/// marketplace's price folded in.
///
/// Owned strings rather than `&'static str`, and that is the one property this type gives up
/// against [`SortColumn`]. What it does **not** give up is where the text comes from: every
/// `Sort` in the crate is built by [`sorts_for`] out of a `&'static str` template plus the
/// output of [`price_expr`]/[`printing_price_expr`], which are `match`es over an enum. No
/// byte of a request reaches either.
#[derive(Debug, Clone)]
pub struct Sort {
    pub key: &'static str,
    pub asc: String,
    pub desc: String,
}

/// Where the app quotes prices from.
///
/// **The one thing about the marketplace setting that has to cross into SQL**, and now it
/// crosses for every price and not just for an order: a price site returns the figure this
/// names and nothing else.
///
/// Not a `Deserialize` derive, and for [`SortTerm::dir`]'s reason turned up one level: an
/// unrecognised id must be a *default*, not a deserialization failure. A build that learns a
/// fifth marketplace would otherwise make every list an older build draws fail to load rather
/// than fall back to the TCGplayer prices it has always shown. So **anything that is not one
/// of the three named ids is `Tcgplayer`** — absent, null, a typo, a number, a future id.
///
/// `cardtrader` lands here too. It is a marketplace the *setting* knows and the picker lists
/// (`crate::marketplace::MARKETPLACE_IDS`), and it has no feed: its API needs a per-user JWT
/// and offers no bulk download. Quoting TCGplayer for it is what this app did before any of
/// this existed, and it is a listing decision rather than a pricing one.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Marketplace {
    #[default]
    Tcgplayer,
    Cardmarket,
    Cardkingdom,
    Manapool,
}

/// `marketplace_prices.marketplace` for the two table-backed feeds. Written out rather than
/// derived from the enum's name so that a rename in Rust cannot silently stop matching rows
/// `crate::marketplace_feed` wrote.
const CARDKINGDOM: &str = "cardkingdom";
const MANAPOOL: &str = "manapool";

impl Marketplace {
    /// The id as `crate::marketplace` stores it, or the default for anything else.
    pub fn from_id(id: &str) -> Marketplace {
        match id {
            "cardmarket" => Marketplace::Cardmarket,
            CARDKINGDOM => Marketplace::Cardkingdom,
            MANAPOOL => Marketplace::Manapool,
            _ => Marketplace::Tcgplayer,
        }
    }

    /// The same, for a command argument that may simply not be there.
    pub fn from_opt(id: Option<&str>) -> Marketplace {
        id.map_or(Marketplace::Tcgplayer, Marketplace::from_id)
    }
}

impl<'de> Deserialize<'de> for Marketplace {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        // Through `Value` rather than `String` so that a payload sending the wrong *type*
        // lands on the default too, instead of failing the whole request.
        let raw = serde_json::Value::deserialize(d)?;
        Ok(raw
            .as_str()
            .map_or(Marketplace::Tcgplayer, Marketplace::from_id))
    }
}

/// What one copy of a card costs at `market`, per **finish**.
///
/// The one SQL fragment every price site in this crate uses. `finish` is the caller's SQL for
/// the finish being priced — [`crate::collection::ENTRY_FINISH`] (`e.finish`) on the collection,
/// [`crate::wishlist::WISH_PREFERRED_FINISH`] (`w.preferred_finish`, **bare**, reaching here
/// through [`row_price_expr`]'s named arm) on the wishlist, and each of [`finish_literals`] in
/// turn where the caller holds a printing rather than a copy of one
/// ([`printing_price_by_finish_expr`], the card pane's `FinishPrices`).
///
/// **A caller wraps its column in nothing.** `coalesce(w.preferred_finish, 'nonfoil')` was the
/// wishlist's spelling and was the bug: it reads "the reader has not said" as "the reader said
/// nonfoil", which are two different wishes and, on a printing sold only in foil, two different
/// answers.
///
/// **The printing itself is always the alias `c`**: every list in this crate joins `cards` as
/// `c`, and hard-coding it here is what keeps the join key and the price from being spelled
/// apart.
///
/// Four marketplaces, two shapes:
///
/// * **TCGplayer and Cardmarket** read `cards.prices` by finish. Never `cards.price_usd`,
///   which is a display/sort fallback chain (`usd → usd_foil → usd_etched`) and would price a
///   plain copy of a card whose only listed price is its foil at the foil's price.
/// * **Card Kingdom and Mana Pool** read `marketplace_prices`, which survives the sync's
///   `cards` swap because it is keyed by `scryfall_id` and is not part of the corpus.
///
/// The euro expression carries **the hole the data actually has: there is no `eur_etched` key
/// in Scryfall's data**, so an etched card is unpriced in euros rather than valued at the
/// nonfoil rate. Mana Pool publishes `price_cents_nm_etched` and so *does* quote etched — the
/// two answers differ for the same card, and both are right about their own marketplace.
///
/// **A card in `cards` but absent from a feed reads NULL, and nothing fills it in.** That is a
/// fact about the marketplace, not a gap: there is no cross-marketplace fallback anywhere in
/// this file, and a price surface renders the NULL as an em dash.
///
/// The feed arm is a correlated scalar subquery rather than a `LEFT JOIN` in the caller's
/// `FROM`, and the difference is only in where it is written: `marketplace_prices`' primary
/// key is `(marketplace, card_id, finish)`, so the subquery matches at most one row and means
/// exactly what that join would. Written this way it composes — six call sites keep their
/// `FROM` clauses, the collection's summary can name it inside a `sum()`, and a query that
/// prices *by finish* cannot accidentally multiply its own rows by the two or three finishes a
/// printing is listed in.
pub fn price_expr(market: Marketplace, finish: &str) -> String {
    match market {
        Marketplace::Tcgplayer => format!(
            "CAST(json_extract(c.prices,
        CASE {finish} WHEN 'foil' THEN '$.usd_foil'
                      WHEN 'etched' THEN '$.usd_etched'
                      ELSE '$.usd' END) AS REAL)"
        ),
        Marketplace::Cardmarket => format!(
            "CASE {finish} WHEN 'etched' THEN NULL ELSE
        CAST(json_extract(c.prices,
            CASE {finish} WHEN 'foil' THEN '$.eur_foil' ELSE '$.eur' END) AS REAL) END"
        ),
        Marketplace::Cardkingdom => feed_price(CARDKINGDOM, finish),
        Marketplace::Manapool => feed_price(MANAPOOL, finish),
    }
}

fn feed_price(feed: &str, finish: &str) -> String {
    format!(
        "(SELECT mp.price FROM marketplace_prices mp
           WHERE mp.marketplace = '{feed}' AND mp.card_id = c.id AND mp.finish = {finish})"
    )
}

/// The three finishes as the SQL literals [`price_expr`] takes, in the order a chain across
/// them reads: `nonfoil → foil → etched`, cheapest first.
///
/// That builder's `finish` argument is normally the *caller's expression* for the finish being
/// priced — `e.finish` on the collection, which always names one, and `w.preferred_finish` on the
/// wishlist, which may not and is therefore handed over **bare**, through [`row_price_expr`], so
/// that "has not said" is told from "said nonfoil". The two callers here price a printing in all
/// three at once instead, so each is a constant: [`printing_price_by_finish_expr`], and the card
/// pane's `FinishPrices`, whose field order this also is.
///
/// **Derived from [`crate::schema::FINISHES`] rather than respelled**, which is the rule the
/// rest of the crate's CHECK vocabularies already follow (`deck_audit::ADD` is
/// `schema::AUDIT_KINDS[0]`, `deck::LIVE` is `DECK_VARIANTS[0]`). Quoting here rather than in
/// the constant because a SQL literal is this module's concern and not the schema's — the
/// three `format!`s are built once per query alongside a SQL string of several kilobytes.
pub(crate) fn finish_literals() -> [String; 3] {
    crate::schema::FINISHES.map(|finish| format!("'{finish}'"))
}

/// What one copy of a **printing** costs at `market`, in whatever finish it is *sold* in.
///
/// [`price_expr`] once per [`finish_literals`] entry, coalesced — so a printing quoted nonfoil
/// is quoted nonfoil, and one that exists only in foil is quoted at its foil rate instead of
/// reading as unpriced.
///
/// **This is the figure for a row that names no finish**, which since schema v18 is one
/// of the two arms of [`row_price_expr`] rather than the whole answer — for a wish as well as
/// for a deck row, since the wishlist adopted it. `deck_cards.finish`
/// is NULL on every row that predates that version and on every row a reader has not spoken
/// about, and this chain is what such a row has always been priced at.
///
/// **Passing the literal `'nonfoil'` instead was a bug.** Before v18 `deck_cards`' grain named a
/// printing and stopped there, so there was no finish to price at — but
/// "no finish" was read as "nonfoil", and **13 515 foil-only and 892 etched-only printings have
/// no nonfoil price at any marketplace**. Measured against a synced corpus on 2026-08-15: all
/// 13 515 have a null `$.usd` and 11 860 of them a real `$.usd_foil`, so a foil-only card in a
/// deck drew an em dash beside a search wall quoting that same printing at $1.57.
///
/// It is [`printing_price_expr`]'s answer read from the finish-grained source rather than off
/// the sort column, and the two agree by construction: `cards.price_usd` is
/// `usd → usd_foil → usd_etched` precomputed by [`crate::card_row`], `price_eur` is the same two
/// links this coalesce has, and the feed arm walks the same order. **A deck reads this one
/// because a deck total is a `sum()`**, and summing the display column is what the rest of the
/// crate forbids — while `printing_price_expr` stays what the search sorts by, because that
/// column is in `idx_cards_collapse` and this expression is not.
///
/// **The euro etched hole survives, because it lives in [`price_expr`] rather than here**: on
/// Cardmarket the third link is `NULL` by construction, so an etched-only printing is unpriced
/// in euros and priced at every marketplace that does quote it.
pub fn printing_price_by_finish_expr(market: Marketplace) -> String {
    let links = finish_literals()
        .map(|finish| price_expr(market, &finish))
        .join(",\n");
    format!("coalesce({links})")
}

/// What one copy of a row that **may or may not name a finish** costs at `market`.
///
/// Two arms, told apart by whether the row has said:
///
/// * **NULL** — the row has not said, so it is [`printing_price_by_finish_expr`]'s chain,
///   `nonfoil → foil → etched`, **quoted rather than respelled**, so each marketplace's own
///   holes travel with it. A foil-only printing is quoted at its foil rate instead of
///   reading as unpriced.
/// * **named** — [`price_expr`] at that finish and no other. **No fallback of any kind**,
///   which is this crate's rule wherever a finish is named: the reader has said which object
///   is in the sleeve, a row quoted at another finish's rate is a price nobody quoted, and the
///   em dash a null answer draws means "this marketplace does not quote this printing in this
///   finish".
///
/// `finish_col` is the caller's column — `dc.finish` for a deck row, `w.preferred_finish` for a
/// wish. **The printing is always the alias `c`**, which is [`price_expr`]'s rule and not this
/// function's to relax.
///
/// **It was `deck_card_price_expr` and the deck was the only caller for one release.** The
/// wishlist coalesced its null to `'nonfoil'` instead, which is the same bug v18 fixed for decks
/// arriving one table over: 12 849 of 116 843 printings are priced only in foil or etched.
/// Generalizing is what stops it being fixed twice and spelled twice.
///
/// Cardmarket's missing `eur_etched` survives into both arms for free, because that hole lives in
/// [`price_expr`] rather than here: an etched row is unpriced in euros and priced at every
/// marketplace that does quote it.
pub fn row_price_expr(market: Marketplace, finish_col: &str) -> String {
    format!(
        "CASE WHEN {finish_col} IS NULL THEN {chain} ELSE {named} END",
        chain = printing_price_by_finish_expr(market),
        named = price_expr(market, finish_col),
    )
}

/// What one copy of a **deck row** costs at `market` — [`row_price_expr`] over `deck_cards`, and
/// the deck's figure since schema v18.
///
/// The NULL arm is every row that predates that version and every row a reader has not spoken
/// about, which is the majority of them.
///
/// `dc` is the caller's alias for `deck_cards`, which is [`crate::deck`]'s throughout.
pub fn deck_card_price_expr(market: Marketplace) -> String {
    row_price_expr(market, "dc.finish")
}

/// What a **printing** costs at `market`, with no finish to price it at.
///
/// The search's figure, and the only place a fallback chain is the right answer: a result row
/// is a printing rather than a copy of one, so it quotes the cheapest thing it can be — the
/// nonfoil price, or the foil's if the printing is foil-only, or the etched one. `price_usd`
/// and `price_eur` are those chains precomputed by [`crate::card_row`] into columns of
/// `cards`, and the feed arm walks the same order over `marketplace_prices`.
///
/// **`c.price_usd` is a column of `idx_cards_collapse`**, which is what makes the collapsed
/// browse's group step a covering scan (`crate::schema::CARDS_INDEXES`). No other marketplace
/// is in that index, so a collapsed browse costs row lookups on the other three. That was
/// already true of Cardmarket before the feeds landed; it is not measured for either feed.
pub fn printing_price_expr(market: Marketplace) -> String {
    match market {
        Marketplace::Tcgplayer => "c.price_usd".to_owned(),
        Marketplace::Cardmarket => "c.price_eur".to_owned(),
        Marketplace::Cardkingdom => feed_printing_price(CARDKINGDOM),
        Marketplace::Manapool => feed_printing_price(MANAPOOL),
    }
}

/// A feed's version of `cards.price_usd`: the same `nonfoil → foil → etched` order, resolved
/// by `ORDER BY … LIMIT 1` because the finishes are rows here rather than keys.
fn feed_printing_price(feed: &str) -> String {
    format!(
        "(SELECT mp.price FROM marketplace_prices mp
           WHERE mp.marketplace = '{feed}' AND mp.card_id = c.id
           ORDER BY CASE mp.finish WHEN 'nonfoil' THEN 0 WHEN 'foil' THEN 1 ELSE 2 END
           LIMIT 1)"
    )
}

/// A table's sort whitelist, with its money columns written for the price it shows.
///
/// `price` is the SQL a money clause's [`PRICE_HOLE`] is replaced with. Two kinds of caller,
/// and both are deliberate:
///
/// * a list that **selects** its price under an alias passes the alias, so the order and the
///   cell cannot disagree — the collection's `unit_price`, the wishlist's;
/// * a list whose order has to reach the expression itself passes [`price_expr`]'s or
///   [`printing_price_expr`]'s output — the search, whose `ORDER BY c.price_usd` is what the
///   `cards` index can answer.
///
/// The result is still a whitelist keyed by `&'static str` and built from `&'static str`
/// clauses, so [`order_by`]'s safety property is untouched.
pub fn sorts_for(shared: &[SortColumn], priced: &[PricedSort], price: &str) -> Vec<Sort> {
    let mut out: Vec<Sort> = shared
        .iter()
        .map(|c| Sort {
            key: c.key,
            asc: c.asc.to_owned(),
            desc: c.desc.to_owned(),
        })
        .collect();
    out.extend(priced.iter().map(|p| Sort {
        key: p.key,
        asc: p.asc.replace(PRICE_HOLE, price),
        desc: p.desc.replace(PRICE_HOLE, price),
    }));
    out
}

/// Build an `ORDER BY` body — no `ORDER BY` keyword, just the list.
///
/// `fallback` is what an empty or wholly unrecognised sort means, which is the view's own
/// order rather than nothing. `tiebreak` is the table's unique key and is always appended:
/// the pagers use `OFFSET`, and two rows tying on every stated key can otherwise swap
/// places between the request for page 1 and the request for page 2 — showing the reader
/// one of them twice and the other never.
pub fn order_by(
    terms: Option<&[SortTerm]>,
    allowed: &[Sort],
    fallback: &str,
    tiebreak: &str,
) -> String {
    let mut parts: Vec<&str> = Vec::new();
    let mut used: Vec<&'static str> = Vec::new();

    for term in terms.unwrap_or(&[]) {
        let Some(column) = allowed.iter().find(|c| c.key == term.key) else {
            continue;
        };
        // A repeated key is dead SQL whose second copy reads, to a human, like the one that
        // won. First appearance is the one the reader built first.
        if used.contains(&column.key) {
            continue;
        }
        used.push(column.key);
        // Anything that is not "desc" is ascending, for the reason `SortTerm::dir` gives.
        parts.push(if term.dir == "desc" {
            &column.desc
        } else {
            &column.asc
        });
    }

    if parts.is_empty() {
        return format!("{fallback}, {tiebreak}");
    }
    format!("{}, {tiebreak}", parts.join(", "))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SHARED: &[SortColumn] = &[SortColumn {
        key: "name",
        asc: "c.name ASC",
        desc: "c.name DESC",
    }];

    const PRICED: &[PricedSort] = &[PricedSort {
        key: "price",
        asc: "{price} ASC NULLS LAST",
        desc: "{price} DESC NULLS LAST",
    }];

    fn columns() -> Vec<Sort> {
        sorts_for(SHARED, PRICED, "c.price_usd")
    }

    const FALLBACK: &str = "c.name ASC";
    const TIEBREAK: &str = "c.id ASC";

    fn term(key: &str, dir: &str) -> SortTerm {
        SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

    #[test]
    fn no_terms_is_the_view_default() {
        let columns = columns();
        assert_eq!(
            order_by(None, &columns, FALLBACK, TIEBREAK),
            "c.name ASC, c.id ASC"
        );
        assert_eq!(
            order_by(Some(&[]), &columns, FALLBACK, TIEBREAK),
            "c.name ASC, c.id ASC"
        );
    }

    #[test]
    fn terms_are_joined_in_the_order_they_arrive() {
        let terms = [term("price", "desc"), term("name", "asc")];
        assert_eq!(
            order_by(Some(&terms), &columns(), FALLBACK, TIEBREAK),
            "c.price_usd DESC NULLS LAST, c.name ASC, c.id ASC"
        );
    }

    /// The whole safety property in one test: a key is a lookup, never a fragment. The
    /// frontend cannot reach the parser, and a request built by hand cannot either.
    #[test]
    fn an_unknown_key_is_dropped_rather_than_interpolated() {
        let terms = [
            term("c.name; DROP TABLE cards", "asc"),
            term("released_at", "desc"),
        ];
        let sql = order_by(Some(&terms), &columns(), FALLBACK, TIEBREAK);
        assert_eq!(sql, "c.name ASC, c.id ASC");
        assert!(!sql.contains("DROP"));
    }

    /// Same reason: a direction is two literals, so anything else is `asc` and not a clause.
    #[test]
    fn an_unknown_direction_is_ascending() {
        let terms = [term("name", "descending; --")];
        assert_eq!(
            order_by(Some(&terms), &columns(), FALLBACK, TIEBREAK),
            "c.name ASC, c.id ASC"
        );
    }

    /// A UI cannot produce this, and a duplicate key in an `ORDER BY` is dead SQL whose
    /// second copy would be read by a human as the one that won.
    #[test]
    fn a_repeated_key_keeps_only_its_first_appearance() {
        let terms = [
            term("name", "asc"),
            term("price", "desc"),
            term("name", "desc"),
        ];
        assert_eq!(
            order_by(Some(&terms), &columns(), FALLBACK, TIEBREAK),
            "c.name ASC, c.price_usd DESC NULLS LAST, c.id ASC"
        );
    }

    /// Paging is `OFFSET`-based, so a sort that is not a total order shows one row twice
    /// and another never. The tiebreak is not the caller's to forget.
    #[test]
    fn the_tiebreak_is_always_last() {
        let columns = columns();
        let terms = [term("name", "asc")];
        assert!(order_by(Some(&terms), &columns, FALLBACK, TIEBREAK).ends_with("c.id ASC"));
        assert!(order_by(None, &columns, FALLBACK, TIEBREAK).ends_with("c.id ASC"));
    }

    /// The whole of the marketplace contract in one place: absent, null, a typo and a wrong
    /// type all mean TCGplayer, because an id this build has not heard of must not make a list
    /// fail to load. Only the three exact ids move it.
    #[test]
    fn anything_that_is_not_a_known_id_is_tcgplayer() {
        #[derive(Debug, Default, Deserialize)]
        #[serde(default)]
        struct Req {
            marketplace: Marketplace,
        }
        let parse = |json: &str| serde_json::from_str::<Req>(json).unwrap().marketplace;

        assert_eq!(parse("{}"), Marketplace::Tcgplayer, "absent");
        assert_eq!(
            parse(r#"{"marketplace":null}"#),
            Marketplace::Tcgplayer,
            "null"
        );
        assert_eq!(
            parse(r#"{"marketplace":"tcgplayer"}"#),
            Marketplace::Tcgplayer
        );
        assert_eq!(
            parse(r#"{"marketplace":"ebay"}"#),
            Marketplace::Tcgplayer,
            "a future id"
        );
        assert_eq!(
            parse(r#"{"marketplace":"cardtrader"}"#),
            Marketplace::Tcgplayer,
            "listed in the picker, and it has no feed"
        );
        assert_eq!(
            parse(r#"{"marketplace":"Cardmarket"}"#),
            Marketplace::Tcgplayer,
            "case matters"
        );
        assert_eq!(
            parse(r#"{"marketplace":7}"#),
            Marketplace::Tcgplayer,
            "type"
        );
        assert_eq!(
            parse(r#"{"marketplace":"cardmarket"}"#),
            Marketplace::Cardmarket
        );
        assert_eq!(
            parse(r#"{"marketplace":"cardkingdom"}"#),
            Marketplace::Cardkingdom
        );
        assert_eq!(
            parse(r#"{"marketplace":"manapool"}"#),
            Marketplace::Manapool
        );
        assert_eq!(Marketplace::default(), Marketplace::Tcgplayer);
        assert_eq!(Marketplace::from_opt(None), Marketplace::Tcgplayer);
        assert_eq!(
            Marketplace::from_opt(Some("manapool")),
            Marketplace::Manapool
        );
    }

    /// The money column follows the price it is given and the rest of the table does not move.
    #[test]
    fn sorts_for_fills_only_the_priced_columns() {
        let usd = sorts_for(SHARED, PRICED, "c.price_usd");
        let eur = sorts_for(SHARED, PRICED, "c.price_eur");
        assert_eq!(usd.len(), 2);
        assert_eq!(eur.len(), 2);

        let terms = [term("price", "desc"), term("name", "asc")];
        assert_eq!(
            order_by(Some(&terms), &usd, FALLBACK, TIEBREAK),
            "c.price_usd DESC NULLS LAST, c.name ASC, c.id ASC"
        );
        assert_eq!(
            order_by(Some(&terms), &eur, FALLBACK, TIEBREAK),
            "c.price_eur DESC NULLS LAST, c.name ASC, c.id ASC"
        );
        // The unpriced keys are the same SQL either way — a marketplace reorders money, not
        // names.
        let name = [term("name", "desc")];
        assert_eq!(
            order_by(Some(&name), &usd, FALLBACK, TIEBREAK),
            order_by(Some(&name), &eur, FALLBACK, TIEBREAK)
        );
    }

    /// Each marketplace's per-finish expression, checked for the things that are easy to get
    /// wrong rather than for its exact text.
    #[test]
    fn price_expr_reads_each_marketplace_from_its_own_source() {
        let tcg = price_expr(Marketplace::Tcgplayer, "e.finish");
        assert!(tcg.contains("$.usd_foil") && tcg.contains("$.usd_etched"));
        assert!(!tcg.contains("marketplace_prices"));

        // The hole the data has: `eur_etched` does not exist, so etched is NULL — never the
        // nonfoil rate, which the blob does carry and which a fallback would quietly charge.
        let cm = price_expr(Marketplace::Cardmarket, "e.finish");
        assert!(cm.contains("WHEN 'etched' THEN NULL"));
        assert!(!cm.contains("eur_etched"));

        for (market, feed) in [
            (Marketplace::Cardkingdom, "cardkingdom"),
            (Marketplace::Manapool, "manapool"),
        ] {
            let sql = price_expr(market, "e.finish");
            assert!(sql.contains("marketplace_prices"), "{sql}");
            assert!(sql.contains(&format!("mp.marketplace = '{feed}'")), "{sql}");
            assert!(sql.contains("mp.finish = e.finish"), "{sql}");
            // No cross-marketplace fallback: a feed that has never heard of a card reads
            // NULL, and there is nowhere else for the expression to look.
            assert!(!sql.contains("json_extract"), "{sql}");
            assert!(!sql.contains("coalesce"), "{sql}");
        }
    }

    /// A deck row's figure since v18, which is two rules rather than one.
    ///
    /// **Unsaid is the chain**, unchanged and quoted rather than respelled — the arm every row
    /// that predates v18 takes. **Said is that finish alone**, with no fallback at either end:
    /// a foil row quoted at the nonfoil rate is a price nobody quoted.
    #[test]
    fn a_deck_card_prices_at_its_own_finish_and_falls_back_only_when_it_has_none() {
        for market in [
            Marketplace::Tcgplayer,
            Marketplace::Cardmarket,
            Marketplace::Cardkingdom,
            Marketplace::Manapool,
        ] {
            let sql = deck_card_price_expr(market);
            assert!(
                sql.contains("dc.finish IS NULL"),
                "the two arms are told apart by the column itself, never by a coalesce that \
                 would price an unsaid row as nonfoil: {sql}"
            );
            assert!(
                sql.contains(&printing_price_by_finish_expr(market)),
                "the unsaid arm must be `printing_price_by_finish_expr`'s own text, so each \
                 marketplace's holes travel with it: {sql}"
            );
            assert!(
                sql.contains(&price_expr(market, "dc.finish")),
                "the said arm must be `price_expr` reading the row's own column, exactly as \
                 the collection passes `e.finish`: {sql}"
            );
        }

        // Cardmarket's `eur_etched` hole reaches both arms rather than being papered over with
        // the nonfoil rate — it lives in `price_expr`, so it is inherited and never restated.
        let cm = deck_card_price_expr(Marketplace::Cardmarket);
        assert!(cm.contains("WHEN 'etched' THEN NULL"), "{cm}");
        assert!(!cm.contains("eur_etched"), "{cm}");
    }

    /// The printing-level chain, which is the search's figure. Same `nonfoil → foil → etched`
    /// order on all four, expressed as a column pair on the blob-backed two and as an ordered
    /// lookup on the feeds.
    #[test]
    fn printing_price_expr_is_a_fallback_chain_on_every_marketplace() {
        assert_eq!(
            printing_price_expr(Marketplace::Tcgplayer),
            "c.price_usd",
            "the column `idx_cards_collapse` covers"
        );
        assert_eq!(printing_price_expr(Marketplace::Cardmarket), "c.price_eur");
        for market in [Marketplace::Cardkingdom, Marketplace::Manapool] {
            let sql = printing_price_expr(market);
            assert!(sql.contains("WHEN 'nonfoil' THEN 0"), "{sql}");
            assert!(sql.contains("WHEN 'foil' THEN 1"), "{sql}");
            assert!(sql.contains("LIMIT 1"), "{sql}");
        }
    }

    /// The deck's chain: the same three links on every marketplace, built out of [`price_expr`]
    /// so that each marketplace's own holes travel with it rather than being restated here.
    #[test]
    fn printing_price_by_finish_expr_chains_the_three_finishes() {
        let tcg = printing_price_by_finish_expr(Marketplace::Tcgplayer);
        assert!(tcg.starts_with("coalesce("), "{tcg}");
        for key in ["$.usd", "$.usd_foil", "$.usd_etched"] {
            assert!(tcg.contains(key), "{tcg}");
        }

        // Cardmarket's third link is the `eur_etched` hole, so an etched-only printing is
        // unpriced in euros — the one thing a chain must not paper over with the nonfoil rate.
        let cm = printing_price_by_finish_expr(Marketplace::Cardmarket);
        assert_eq!(cm.matches("WHEN 'etched' THEN NULL").count(), 3, "{cm}");
        assert!(!cm.contains("eur_etched"), "{cm}");

        // A feed's chain is three lookups into its own rows and nothing else: no `json_extract`
        // anywhere, and no reaching across marketplaces for a price this one does not quote.
        for market in [Marketplace::Cardkingdom, Marketplace::Manapool] {
            let sql = printing_price_by_finish_expr(market);
            assert_eq!(sql.matches("marketplace_prices").count(), 3, "{sql}");
            assert!(!sql.contains("json_extract"), "{sql}");
        }

        // Every link is `price_expr`'s, in `finish_literals()` order. A chain assembled by hand
        // here is how one marketplace's hole comes to be spelled differently in two places.
        for market in [
            Marketplace::Tcgplayer,
            Marketplace::Cardmarket,
            Marketplace::Cardkingdom,
            Marketplace::Manapool,
        ] {
            let sql = printing_price_by_finish_expr(market);
            for finish in finish_literals() {
                assert!(sql.contains(&price_expr(market, &finish)), "{sql}");
            }
        }
    }

    /// A money clause with no [`PRICE_HOLE`] in it is a clause that ignores the marketplace —
    /// the whole failure the templates replace. Every table checks its own list; this is the
    /// rule itself.
    #[test]
    fn a_priced_sort_names_the_price_hole() {
        for p in PRICED {
            assert!(p.asc.contains(PRICE_HOLE), "{}", p.asc);
            assert!(p.desc.contains(PRICE_HOLE), "{}", p.desc);
        }
    }
}
