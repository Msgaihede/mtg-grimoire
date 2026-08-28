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
#[cfg(not(target_family = "wasm"))]
use crate::sync::{lock_db_read, AppState};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
#[cfg(not(target_family = "wasm"))]
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
    /// Every printing of one oracle card. Absent means unset, like every other filter here;
    /// it ANDs with the rest. See [`crate::filters::CardFilters::oracle_id`].
    pub oracle_id: Option<String>,
    /// Set codes to include. ORed with each other, ANDed with every other filter — two
    /// sets means "printed in either", which is what a multi-select means everywhere else.
    pub sets: Option<Vec<String>>,
    /// Mana-value chips. 0–7 match `cmc` exactly; [`filters::MANA_VALUE_OPEN_ENDED`] means
    /// "or more". A card with no `cmc` matches none of them.
    pub mana_values: Option<Vec<u8>>,
    /// The X chip: `Some(true)` also matches cards whose printed cost carries an `{X}`.
    ///
    /// **ORed with [`Self::mana_values`], not ANDed with it** — one more alternative in the
    /// same group, so a request naming `3` and `X` returns cards that are either. X is
    /// additive: Scryfall counts it as 0 in `cmc`, so an X card keeps whatever value chip it
    /// already matched. See [`crate::filters::CardFilters::mana_x`].
    pub mana_x: Option<bool>,
    pub rarity: Option<String>,
    /// Rarities to include — ORed with each other, ANDed with every other filter, exactly as
    /// [`Self::sets`] is. The filter bar's four chips; absent or empty means no rarity filter.
    /// See [`crate::filters::CardFilters::rarities`] for why it is a field beside
    /// [`Self::rarity`] rather than a widening of it.
    pub rarities: Option<Vec<String>>,
    /// The cheapest and dearest a printing may cost at [`Self::marketplace`] and still match.
    ///
    /// Inclusive on both ends, either half usable alone, and **an unpriced printing matches
    /// neither** — `NULL >= ?` is NULL, which is what a shop that does not list a card has
    /// said about it. That is the one place this filter narrows more than a reader might
    /// expect, and it is the honest reading: the range names a price, and a printing with no
    /// price at the chosen marketplace has none to be inside it.
    ///
    /// **Applied in [`run_search`] rather than in [`crate::filters::push_card_filters`]**,
    /// because the expression is a function of the marketplace — `c.price_usd` on TCGplayer,
    /// `c.price_eur` on Cardmarket, a correlated subquery over `marketplace_prices` on the two
    /// feeds ([`crate::sorting::printing_price_expr`]). `CardFilters` is shared with the
    /// collection and the wishlist, which price a *copy* by its finish rather than a printing,
    /// so a price field on that struct would have to carry SQL to mean anything there.
    ///
    /// **Not a facet dimension, and the counts fail open under it** — see
    /// [`crate::index::facets::base`], which spells out why and in which direction.
    pub price_min: Option<f64>,
    pub price_max: Option<f64>,
    /// Defaults to true: digital-only printings are hidden unless asked for.
    pub paper_only: Option<bool>,
    /// Narrow to printings that are legal or restricted in **at least one** format —
    /// `legal_mask != 0`, which is what hides art series, tokens, emblems and memorabilia.
    ///
    /// **Defaults to false**, unlike [`Self::paper_only`]: absent is what this command has
    /// always answered, so no existing caller changes. The search view sends `true` unless
    /// its Unplayable chip is pressed. See [`crate::filters::CardFilters::playable_only`].
    pub playable_only: Option<bool>,
    /// Scryfall **art** tags — what the picture shows. `include` intersects, `exclude`
    /// subtracts, and both are matched through the pre-flattened closure, so a query for a
    /// parent tag answers the cards tagged only with its children. Absent means no filter.
    /// See [`crate::filters::TagTerms`].
    pub art_tags: Option<filters::TagTerms>,
    /// Scryfall **oracle** tags — what the card does. [`Self::art_tags`]' shape over the other
    /// taxonomy; the two AND with each other, so "a dog that ramps" is one request.
    pub oracle_tags: Option<filters::TagTerms>,
    /// `"strong"` drops the art matches Scryfall called `weak`; absent or `"any"` keeps them.
    /// **Nothing else on this request is affected** — not the excludes, and not the oracle
    /// tags, whose closure has no weight at all. See
    /// [`crate::filters::CardFilters::art_weight_floor`].
    pub art_weight_floor: Option<String>,
    /// `Some(true)` narrows to printings the collection has an entry for, `Some(false)` to
    /// those it does not. Spec §7's owned/wishlist status filter, buildable at last now
    /// that the table exists.
    ///
    /// **An entry, not a copy** — the same reading as `CollectionSummary::unique_cards`,
    /// "printings recorded, not printings currently held". So a card whose only entry holds no
    /// copies passes `owned: true` while its [`CardSummary::owned_quantity`] reads `0`, and does
    /// *not* appear under `owned: false`. Deliberate, and the one place it could surprise a
    /// reader is a "what am I missing" list, which is the wishlist's `fulfilled` filter — that
    /// one counts copies, because a wish is filled by copies rather than by paperwork.
    ///
    /// **That distinction narrowed at schema v24 and did not disappear.** It used to be the
    /// everyday case: a row stepped to zero was a row the collection kept. Now
    /// [`crate::collection::set_quantity`] deletes at zero and the v24 rung swept the stored
    /// ones, so the two answers part company only on a row written some other way — an
    /// `update_entry` patch, which still keeps the row it is editing, or direct SQL. The filter's
    /// rule is unchanged and is a rule about *this* filter rather than about what the collection
    /// happens to store, which is why it is worth keeping written down.
    pub owned: Option<bool>,
    /// How to order the page: columns in priority order, the first deciding and the rest
    /// breaking its ties. Empty or absent is the default — relevance when `text` is set,
    /// name order when it is not. Keys outside [`SEARCH_SORTS`] are dropped, never
    /// interpolated.
    pub sort: Option<Vec<crate::sorting::SortTerm>>,
    /// Where to quote prices from — the source of [`CardSummary::price`] and of the range
    /// beside it, and what a `price` sort orders by. Absent, or anything this build does not
    /// recognise, means `tcgplayer`, which is what every caller before the marketplace picker
    /// existed depended on. See [`crate::sorting::Marketplace`].
    pub marketplace: crate::sorting::Marketplace,
    /// Fold every printing of one card into a single row, represented by the cheapest
    /// printing of the card's latest release — see [`collapse_rep`], and note that *which*
    /// printing that is depends on [`Self::marketplace`].
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
            oracle_id: self.oracle_id.clone(),
            sets: self.sets.clone(),
            mana_values: self.mana_values.clone(),
            mana_x: self.mana_x,
            rarity: self.rarity.clone(),
            rarities: self.rarities.clone(),
            paper_only: self.paper_only,
            playable_only: self.playable_only,
            art_tags: self.art_tags.clone(),
            oracle_tags: self.oracle_tags.clone(),
            art_weight_floor: self.art_weight_floor.clone(),
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
    /// The row's own price at the marketplace [`SearchRequest::marketplace`] named — a
    /// display/sort **fallback chain** (`nonfoil → foil → etched`) and never a per-finish
    /// figure, because a result row is a printing rather than a copy of one. See
    /// [`crate::sorting::printing_price_expr`].
    ///
    /// `None` is far commoner on some marketplaces than on others and that is the answer, not
    /// a gap: **there is no `eur_etched` key in Scryfall's data at all**, so an etched-only
    /// printing has no Cardmarket chain to fall through to, and a printing Card Kingdom has
    /// never listed is unpriced there while TCGplayer quotes it. Nothing is filled in from
    /// another marketplace.
    pub price: Option<f64>,
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
    /// JSON, verbatim: Scryfall's `promo_types`, the column the **kind** of foil lives in.
    ///
    /// [`Self::finishes`] has three words for how shiny a copy is and no way to say *which*
    /// shiny — a Surge Foil and an ordinary foil were one glyph and one word until issue #160.
    /// Handed over unread: naming these is a judgement, so `src/lib/treatment.ts` owns the
    /// table and this is copied the way `legalities` is on the card pane's DTO.
    ///
    /// **22.7 bytes on the 32 174 of 116 712 rows that carry one**, so a 50-row page grows by
    /// under 1 KB — the same trade [`Self::finishes`] records above it, at a fifth the size.
    /// 5 428 of 107 355 paper printings carry a member this app names.
    pub promo_types: Option<String>,
    /// One of the cards the Commander bracket system counts as a **game changer** — the
    /// wall and the table draw a crown from it, beside the foil and etched finish marks.
    ///
    /// An **oracle-level** fact, not a property of the cardboard: every printing of a card
    /// agrees, so a collapsed row takes it from the representative printing's own `c.`
    /// column like `rarity` or `type_line`, and no aggregate is needed to make the group
    /// agree with itself.
    ///
    /// `bool` and not `Option<bool>`, though `cards.game_changer` is nullable: a NULL there
    /// means *not on the list* — the column is only ever set for the cards Wizards named —
    /// so it is read as an `Option` and flattened here rather than handed to TypeScript as a
    /// third state every crown would have to fence. Same reading, and the same flattening, as
    /// [`crate::import::ImportMatch::game_changer`].
    pub game_changer: bool,
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
    /// Cheapest and dearest price among the printings this row stands for. Both ends equal
    /// [`Self::price`] uncollapsed, where a row stands for one printing.
    ///
    /// [`Self::price`] stays what it always was — the representative printing's own value, a
    /// fallback chain that must never be summed.
    ///
    /// **The span covers the printings the chosen marketplace prices**, because `min`/`max`
    /// skip NULLs: a card's Cardmarket span can be narrower than its TCGplayer one, or absent
    /// while the other exists. That is the honest answer rather than a defect — a card whose
    /// only printings are etched is priced on TCGplayer and unpriced on Cardmarket, and a
    /// range that pretended otherwise would be inventing a number.
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
/// **The card's latest release, and the cheapest printing of it** — three keys, in priority
/// order: `released_at` DESC, then price ASC at the reader's marketplace, then `c.id` DESC.
/// A collapsed row stands for a card the reader might buy, so it shows the current cardboard
/// at what the current cardboard actually costs, rather than whichever UUID happened to sort
/// highest among a modern set's dozen showcase variants.
///
/// Measured over the live database 2026-08-14 (Windows, 116 703 cards / 37 556 paper oracle
/// groups): **4 011 groups — 10.7 % — change representative, and none becomes dearer.** The
/// second half is a property of the key rather than a lucky corpus: every printing the old
/// `released_at DESC, id DESC` rule could have picked is still a candidate here, and price
/// only ever breaks a tie the old rule broke by id. 163 of those groups trade an *unpriced*
/// representative for a priced one.
///
/// ### There is no `set_code` term, deliberately
///
/// The obvious fourth key — "the latest *set*, then the cheapest printing of that set" —
/// needs a tiebreak when two sets share a release date, and every available one is wrong.
/// Promo sets are `p`-prefixed (`pkhm` beside `khm`, `pfrf` beside `frf`), so `set_code`
/// DESC hands the row to the promo: Icebreaker Kraken went `khm 63` at $0.36 to `pkhm 63p`
/// at $0.88, a rule called "cheapest" making the row dearer. 2 503 cards have a latest date
/// spanning more than one set. Weighing all of that date's printings together instead is
/// both simpler and cheaper — 1 155 groups cross to the cheaper side of a same-day pair
/// (`pfrf 143s` $2.59 → `frf 143` $0.35, `peld 185s` $0.82 → `eld 185` $0.34) — and every
/// candidate is still a printing of a set released that day, so it is still "the latest set".
///
/// ### Why the string
///
/// `released_at` is a fixed-width ISO date and the price segment is padded to twelve, so the
/// concatenation compares exactly as those three keys and the prefix is always **22**
/// characters — which is what makes `substr(…, 23)` *be* the winning row's id, and the join
/// back a **primary-key** lookup: 108 ms, against 767 ms for joining on the group key and
/// matching the composite expression a second time.
///
/// The price is **inverted** (`999999999999 - cents`) because the aggregate is `max()` and
/// the cheapest printing has to carry the greatest key, and `coalesce(…, 0)` puts an
/// unpriced printing at the bottom of it: a shop that does not quote a printing has not
/// offered it for free, so it loses to every priced sibling and represents the card only
/// when nothing of that date is priced — where the id tiebreak decides, as it always did.
///
/// The scalar `min`/`max` around the cast are a **width** fence and not a price rule.
/// `printf('%012d', …)` pads to twelve but never truncates: it is twelve characters down to
/// `-99999999999` and thirteen below that, so cents outside `0 … 999999999999` would widen
/// the prefix, `substr(…, 23)` would slice into the middle of a UUID and the primary-key
/// join would drop the card off the page — silently, which is the only reason a clamp is
/// worth one comparison per row. `marketplace_prices.price` carries no `CHECK`, so the low
/// end is fenced too. Both are pinned by
/// `tests::a_price_outside_the_keys_range_still_resolves_to_a_real_printing`.
///
/// Ties still break to the **greatest** id, where [`ORDER_NAME`] breaks them to the least.
/// Ids are UUIDs, so both are arbitrary; this is the one that is written down.
///
/// ### `{price}` appears exactly once
///
/// On Card Kingdom and Mana Pool [`crate::sorting::printing_price_expr`] expands to a
/// correlated scalar subquery over `marketplace_prices`. The group step already evaluates it
/// twice for the range it shows, and every further occurrence is another per-row subquery on
/// the search's hot path — so this is a function of the price expression rather than a
/// constant, and it interpolates it in one place.
///
/// **The pick is therefore marketplace-dependent**: two shops can disagree about which
/// printing of the same release is cheapest, and each answer is right about its own shop.
/// Switching marketplace changes which printing represents a card, and refetches rather than
/// going stale, because `marketplace` is part of the search query's key.
///
/// Every column named here — `released_at`, `id`, and `price_usd` on the default
/// marketplace — is already in `idx_cards_collapse`
/// ([`crate::schema::CARDS_INDEXES`]), so the unfiltered browse's group scan stays covering —
/// `EXPLAIN QUERY PLAN` still opens `SCAN c USING COVERING INDEX idx_cards_collapse`.
///
/// Measured 2026-08-14 on the live 116 703-card database, unfiltered — the worst case, since
/// every group is built before the `LIMIT`: **108 → 127 ms** at TCGplayer, 548 → 577 ms at
/// Cardmarket, 891 → **1 044 ms** at a feed marketplace. A *narrowed* browse is a wash
/// (`name LIKE '%dragon%'`: 24 → 24 ms, 27 → 28 ms). So the third evaluation costs ~19 ms
/// where the expression is an indexed column and ~150 ms where it is a correlated subquery,
/// and the ~890 ms a feed marketplace already cost unfiltered dwarfs what this added to it.
/// Provenance and the synthetic-feed caveat:
/// [data-and-sync.md](../../docs/reference/data-and-sync.md).
fn collapse_rep(price: &str) -> String {
    format!(
        "substr(max(coalesce(c.released_at,'0000-00-00') \
         || printf('%012d', coalesce(999999999999 - \
              max(0, min(999999999999, CAST(round({price} * 100) AS INTEGER))), 0)) \
         || c.id), 23)"
    )
}

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
///
/// **[`SearchRequest::playable_only`] is the filter, and it is not this list.** The two overlap
/// and neither replaces the other: this one is a hand-kept list of Scryfall layout words, which
/// has to be updated by hand when Scryfall invents another and is in no index; that one is
/// `legal_mask != 0`, computed from the card's own legalities on every sync and carried by
/// `idx_cards_collapse`. Ranking still needs a list, because it applies to a corpus the reader
/// has asked to include the unplayable printings in — and an art card that outranks the card it
/// depicts is wrong whether or not it was asked for.
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
/// **`manaValue` and `released` have no column of their own to press, and are reached from
/// the filter bar's sort picker instead** — exactly as the collection's `added` and `price`
/// keys are. That is why they are not "dead code an order nothing can reach", which is what
/// this paragraph said about `released` while the table's headers were the only way to ask
/// for an order at all. A picker key still has to be here: [`crate::sorting::order_by`]
/// drops a key this list does not carry, silently, so the control would simply do nothing.
///
/// `price` is not here: it is the one key whose SQL depends on the reader's marketplace, so
/// it lives in [`SEARCH_PRICE_SORT`] and is appended by [`crate::sorting::sorts_for`].
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
        key: "manaValue",
        asc: "c.cmc ASC NULLS LAST",
        desc: "c.cmc DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "released",
        asc: "c.released_at ASC NULLS LAST",
        desc: "c.released_at DESC NULLS LAST",
    },
];

/// `price` — the column the Price header sorts by.
///
/// The **expression** rather than the page's `price` alias, unlike the collection and the
/// wishlist, and for one reason: on TCGplayer it expands to `c.price_usd`, which is a real
/// column of `cards` and of `idx_cards_collapse`, and the orders in this file are the ones
/// whose costs are written down. A printing the chosen marketplace does not price sorts last
/// in both directions, unchanged.
const SEARCH_PRICE_SORT: &[crate::sorting::PricedSort] = &[crate::sorting::PricedSort {
    key: "price",
    asc: "{price} ASC NULLS LAST",
    desc: "{price} DESC NULLS LAST",
}];

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
///
/// **`manaValue` and `released` are here rather than in [`REPRESENTATIVE_SORTS`], and each
/// has its own reason** — the next reader will otherwise file them beside `rarity` and pay
/// the whole-join price for nothing:
///
/// - `min(c.cmc)` is **exact, not an approximation**. [`COLLAPSE_KEY`] is
///   `coalesce(c.oracle_id, c.id)` and mana value is a fact about the *oracle card*, so every
///   printing in a group carries the same `cmc` and `min` is that one value. (A printing with
///   no `oracle_id` is a group of one, where `min` is trivially its own.) Sorting by an
///   aggregate is only wrong when the group disagrees with itself, and **0 of 31 894 groups
///   do**: `HAVING min(c.cmc) IS NOT max(c.cmc)` over the live database on 2026-08-20
///   (98 323 paper printings legal somewhere) returned nothing.
/// - `max(c.released_at)` is **the representative's own release date**, not an aggregate
///   standing in for one. [`collapse_rep`] picks by `released_at` DESC before anything else,
///   so the representative *is* the group's newest printing — and **0 of those same 31 894
///   groups** have a `max(c.released_at)` differing from the `released_at` of the printing
///   `collapse_rep` actually returns.
///
/// Both counts are facts about *this* corpus on *that* day rather than proofs, which is why
/// each argument is structural first and counted second, and why
/// `a_collapsed_released_sort_agrees_with_the_representative_it_shows` checks the second one
/// against the query rather than trusting the expression.
///
/// Both therefore answer inside the group step, where the `LIMIT` is, instead of costing the
/// 37 553-group join before it. Every column named is already in `idx_cards_collapse`, so the
/// group scan stays covering. Which order the *page* then comes back in is
/// [`SEARCH_SORTS_JOINED`]'s half.
const SEARCH_SORTS_COLLAPSED: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "min(c.name) ASC",
        desc: "min(c.name) DESC",
    },
    crate::sorting::SortColumn {
        key: "manaValue",
        asc: "min(c.cmc) ASC NULLS LAST",
        desc: "min(c.cmc) DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "released",
        asc: "max(c.released_at) ASC NULLS LAST",
        desc: "max(c.released_at) DESC NULLS LAST",
    },
];

/// The collapsed `price` order — the ends of the range the row shows.
///
/// The aggregates span only the printings the chosen marketplace prices, because `min`/`max`
/// skip NULLs. A group whose printings are all etched therefore has no Cardmarket range at all
/// and sorts last, which is the same statement [`CardSummary::price_low`] makes.
const SEARCH_PRICE_SORT_COLLAPSED: &[crate::sorting::PricedSort] = &[crate::sorting::PricedSort {
    key: "price",
    asc: "min({price}) ASC NULLS LAST",
    desc: "max({price}) DESC NULLS LAST",
}];

/// The **outer** half of a group-step order: the same keys again, written against the joined
/// row instead of against the aggregates.
///
/// The group step decides *which* groups the page holds; this decides what order they come
/// back in, and the two have to agree or the reader gets the right 50 cards shuffled.
/// [`run_search`] used to restate only the two fallbacks by hand — `g.nm ASC, c.id ASC`
/// unranked, the score triple when ranked — and had nothing to restate an *explicit* sort
/// with, so the outer `ORDER BY` quietly overrode it: a collapsed `price` DESC returned the
/// dearest groups **in name order**. Found 2026-08-20 while adding the picker's two keys, by
/// probing two groups whose price order and name order disagree; nothing was red because the
/// fixture in `a_collapsed_price_sort_orders_by_the_ends_of_the_range` sorts the same way
/// both ways, which is exactly the vacuity CLAUDE.md warns a test can hide.
///
/// One [`crate::sorting::order_by`] call over this list replaces both hand-rolled strings —
/// they are what it emits for an empty sort — so the third case cannot go missing again.
/// Each clause re-reads the group's own expression off the joined row, exactly rather than
/// approximately:
///
/// * `name` → `g.nm`, which **is** `min(c.name)`: the CTE's column, never `c.name`, because
///   71 groups span two names and the row displays `g.nm` (see [`ORDER_NAME_COLLAPSED`]).
/// * `price` → `g.lo`/`g.hi`, the CTE's own aggregates. That is why it is an ordinary
///   [`crate::sorting::SortColumn`] here and not a [`crate::sorting::PricedSort`]: the
///   marketplace was folded in when they were computed, so there is no
///   [`crate::sorting::PRICE_HOLE`] left to fill.
/// * `manaValue` → `c.cmc`, `released` → `c.released_at`, the representative's own columns,
///   for the two arguments [`SEARCH_SORTS_COLLAPSED`] makes and counts.
///
/// `set`, `rarity` and `type` are absent because naming one takes the other branch entirely —
/// see `sorts_after_join` in [`run_search`].
const SEARCH_SORTS_JOINED: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "g.nm ASC",
        desc: "g.nm DESC",
    },
    crate::sorting::SortColumn {
        key: "price",
        asc: "g.lo ASC NULLS LAST",
        desc: "g.hi DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "manaValue",
        asc: "c.cmc ASC NULLS LAST",
        desc: "c.cmc DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "released",
        asc: "c.released_at ASC NULLS LAST",
        desc: "c.released_at DESC NULLS LAST",
    },
];

/// The sort keys a collapsed search must resolve **after** the join, because they belong to
/// the representative printing rather than to the group.
///
/// Naming one costs the whole 37 553-group join before the limit: 600–620 ms on a completely
/// unfiltered browse against 108 ms for the group-step orders, and ~40 ms as soon as any text
/// narrows the set (measured 2026-08-11).
const REPRESENTATIVE_SORTS: [&str; 3] = ["set", "rarity", "type"];

/// The denominator statement, for one `FROM` and one `WHERE`.
///
/// **A named function rather than two `format!`s inside [`run_search`], so a test can plan
/// the statement this search really runs.** The query plan is the only thing anyone checks
/// about the count — it is the half that walks to the cap on every keystroke — and a plan
/// test that builds its own SQL is a test of SQLite, not of this crate: whatever
/// `push_card_filters` starts emitting, a hand-written copy keeps planning the old string
/// and stays green. See `the_oracle_id_filter_uses_its_index`.
fn count_sql_for(from_sql: &str, where_sql: &str, collapse: bool) -> String {
    let cap = TOTAL_CAP + 1;
    if collapse {
        format!(
            "SELECT count(*) FROM (SELECT 1 FROM {from_sql} WHERE {where_sql} \
             GROUP BY {COLLAPSE_KEY} LIMIT {cap})"
        )
    } else {
        format!("SELECT count(*) FROM (SELECT 1 FROM {from_sql} WHERE {where_sql} LIMIT {cap})")
    }
}

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
    //
    // `NOT EXISTS (…)` and `NOT (EXISTS (…))` are the same plan to SQLite, which is what lets
    // the negative arm come out of the same builder rather than out of a second literal.
    match req.owned {
        Some(true) => p
            .wheres
            .push(crate::collection_source::owns_printing(conn, "c.id")),
        Some(false) => p.wheres.push(format!(
            "NOT {}",
            crate::collection_source::owns_printing(conn, "c.id")
        )),
        None => {}
    }

    // The price range, at the marketplace this request quotes from.
    //
    // **Built here rather than in `filters.rs` because the expression is the marketplace's**,
    // and [`crate::sorting::printing_price_expr`] is the one place that mapping is written —
    // the same expression the Price column shows and the `price` sort orders by, so a card
    // inside the range cannot be a card the wall prices outside it.
    //
    // Interpolated as SQL and bound as a parameter: `printing_price_expr` returns a *fragment*
    // built from a closed enum with no user text anywhere in it, and the number is bound. On the
    // two feed marketplaces the fragment is a correlated scalar subquery, so a bounded search
    // there costs one extra probe of `marketplace_prices` per surviving row — indexed, since
    // that table's primary key leads with `(marketplace, card_id)`.
    //
    // Two half-open bounds rather than a `BETWEEN`, so a reader who has moved only one end
    // sends only one predicate — and so an inverted pair (`min` above `max`) narrows to nothing
    // rather than being silently reordered into a range nobody asked for.
    if req.price_min.is_some() || req.price_max.is_some() {
        let price = crate::sorting::printing_price_expr(req.marketplace);
        if let Some(min) = req.price_min {
            p.push(format!("{price} >= ?"), Box::new(min));
        }
        if let Some(max) = req.price_max {
            p.push(format!("{price} <= ?"), Box::new(max));
        }
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
    // One expression, built once and used three times: the page selects it, the money order
    // reads it, and the collapsed group step aggregates it. Building it in one place is what
    // keeps the cell and its header quoting the same marketplace.
    let price = crate::sorting::printing_price_expr(req.marketplace);
    let sorts = crate::sorting::sorts_for(SEARCH_SORTS, SEARCH_PRICE_SORT, &price);
    let order = crate::sorting::order_by(req.sort.as_deref(), &sorts, &fallback, "c.id ASC");

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
    let count_sql = count_sql_for(from_sql, &where_sql, collapse);
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
        // id — the cheapest printing of the card's latest release, [`collapse_rep`] — and it
        // takes the `LIMIT`, so at most 50 rows are ever fetched out of `cards`. Then one
        // primary-key join back for that row's own columns.
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

        // The representative reads the same `price` the aggregates beside it do, which is
        // what keeps the row's own figure and the shop it was chosen at from being spelled
        // apart. See [`collapse_rep`] — the pick is marketplace-dependent by construction.
        let rep = collapse_rep(&price);
        let group_fallback = format!("{score_term}{ORDER_NAME_COLLAPSED}");
        let group_sorts =
            crate::sorting::sorts_for(SEARCH_SORTS_COLLAPSED, SEARCH_PRICE_SORT_COLLAPSED, &price);
        let group_order = crate::sorting::order_by(
            req.sort.as_deref(),
            &group_sorts,
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
        // Otherwise the group step has already chosen and limited the page, and the join
        // only has to hand it back in the order it was chosen in — restated against `g` and
        // the representative, because the aggregates are not in scope out here. An empty
        // sort emits the two strings this used to hard-code, which is the point: the
        // fallbacks and an explicit order now come out of one list instead of one being
        // written down and the other forgotten. See [`SEARCH_SORTS_JOINED`].
        //
        // No priced half, and no price to fold: `g.lo`/`g.hi` were computed inside the CTE
        // with the marketplace's own expression.
        let joined_sorts = crate::sorting::sorts_for(SEARCH_SORTS_JOINED, &[], "");
        let joined_fallback = if ranked {
            "g.nc ASC, g.score ASC, g.nm ASC"
        } else {
            "g.nm ASC"
        };
        let final_order = if sorts_after_join {
            format!("{order} LIMIT ? OFFSET ?")
        } else {
            crate::sorting::order_by(
                req.sort.as_deref(),
                &joined_sorts,
                joined_fallback,
                "c.id ASC",
            )
        };

        // The owned badge, by **oracle card** because the row stands for a whole group of
        // printings — built by [`crate::collection_source`] rather than written out, so the
        // wall and the Collection page cannot disagree about what the reader has.
        let owned_by_oracle = crate::collection_source::copies_of_oracle(conn, "c.oracle_id");
        format!(
            "{cte} g AS (
                SELECT {COLLAPSE_KEY} AS oid, count(*) AS printings,
                       min({price}) AS lo, max({price}) AS hi,
                       min(c.name) AS nm,
                       {score_select}
                       {rep} AS rep
                FROM {group_from} WHERE {group_where}
                GROUP BY {COLLAPSE_KEY}
                ORDER BY {group_order} {group_limit}
             )
             SELECT c.id, g.nm, c.set_code, c.set_name, c.collector_number, c.rarity,
                    c.type_line, c.mana_cost, {price} AS price, c.layout,
                    c.oracle_id, c.finishes, c.promo_types,
                    -- `c.`, not an aggregate: being a game changer is a fact about the
                    -- oracle card, so every printing in the group already agrees and the
                    -- representative's own column is the group's answer. Position 13 in
                    -- **both** branches — the two share one row mapping, and only the three
                    -- collapse-only aggregates may follow it.
                    c.game_changer,
                    {owned_by_oracle},
                    EXISTS (SELECT 1 FROM wishlist_entries w
                             WHERE (w.oracle_id IS NOT NULL AND w.oracle_id = c.oracle_id)
                                OR w.card_id IN (SELECT id FROM cards
                                                  WHERE oracle_id = c.oracle_id)),
                    g.printings, g.lo, g.hi
             FROM g JOIN cards c ON c.id = g.rep
             ORDER BY {final_order}"
        )
    } else {
        // The same badge, by **printing**: an uncollapsed row is one printing, so the count
        // beside it is that printing's.
        let owned_by_printing = crate::collection_source::copies_of_printing(conn, "c.id");
        format!(
            "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                    c.type_line, c.mana_cost, {price} AS price, c.layout,
                    c.oracle_id, c.finishes, c.promo_types, c.game_changer,
                    {owned_by_printing},
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
            price: row.get(8).map_err(|e| e.to_string())?,
            layout: row.get(9).map_err(|e| e.to_string())?,
            oracle_id: row.get(10).map_err(|e| e.to_string())?,
            finishes: row.get(11).map_err(|e| e.to_string())?,
            promo_types: row.get(12).map_err(|e| e.to_string())?,
            // Read as an `Option` and flattened: the column is nullable and a NULL means
            // "not on the list". A bare `row.get::<_, bool>` is not a `false` there, it is
            // an `InvalidColumnType` that fails the whole search.
            game_changer: row
                .get::<_, Option<bool>>(13)
                .map_err(|e| e.to_string())?
                .unwrap_or(false),
            owned_quantity: row.get(14).map_err(|e| e.to_string())?,
            wishlisted: row.get(15).map_err(|e| e.to_string())?,
            // Uncollapsed, a row is a printing: it stands for one, and the "range" is its own
            // price. Collapsed, the three ride on the group step's aggregates.
            printings: if collapse {
                row.get(16).map_err(|e| e.to_string())?
            } else {
                1
            },
            price_low: if collapse {
                row.get(17).map_err(|e| e.to_string())?
            } else {
                row.get(8).map_err(|e| e.to_string())?
            },
            price_high: if collapse {
                row.get(18).map_err(|e| e.to_string())?
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
#[cfg(not(target_family = "wasm"))]
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
#[cfg(not(target_family = "wasm"))]
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
        let conn = crate::schema::memory_pair();
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
    /// would feed the set code to the format's mask test and silently match nothing.
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

    /// The printings that are legal in **no** format — art series, tokens, emblems,
    /// memorabilia — are what `playableOnly` hides, and there is no other way to name them:
    /// they carry ordinary names, ordinary sets and (for an art card) the name of the card
    /// they depict, twice.
    ///
    /// **The default still answers with them**, which is the asymmetry with `paperOnly` and
    /// the reason this test asks both questions. Every other caller of this command omits the
    /// field, and a default of `true` would quietly drop cards out of the deck panel, the
    /// wishlist's picker and anything else that grows a search later.
    ///
    /// `restricted` is the edge the mask already encodes and this is where it is asked of a
    /// real query: a card restricted in Vintage and legal nowhere else is playable, so a
    /// Vintage player's search must keep returning it.
    #[test]
    fn playable_only_hides_the_printings_that_are_legal_nowhere() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,type_line,
                is_paper,legalities,search_text,raw)
             VALUES ('30','Lightning Bolt // Lightning Bolt','astx','76s','en','art_series',
                     'Card',1,'{\"modern\":\"not_legal\"}','Lightning Bolt','{}'),
                    ('31','Black Lotus','lea','232','en','normal','Artifact',
                     1,'{\"vintage\":\"restricted\",\"legacy\":\"banned\"}','Black Lotus','{}')",
            [],
        )
        .unwrap();
        fill_legal_mask(&conn);

        let default = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(
            default.total, 4,
            "absent means the art card still comes back"
        );

        let playable = run_search(
            &conn,
            &SearchRequest {
                playable_only: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let names: Vec<&str> = playable.items.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(
            names,
            ["Black Lotus", "Lightning Bolt", "Lightning Helix"],
            "the art card is gone and the restricted card is not"
        );
        assert_eq!(playable.total, 3, "the count agrees with the page");

        // `false` is the same request as no request at all — the frontend sends the field
        // only when it means it, and either spelling has to answer the same way.
        let explicit_off = run_search(
            &conn,
            &SearchRequest {
                playable_only: Some(false),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(explicit_off.total, 4);

        // And collapsed, which is the mode the search view actually runs in: the filter
        // narrows printings *before* they are grouped, so a card whose every printing is
        // unplayable has no group left at all.
        let collapsed = run_search(
            &conn,
            &SearchRequest {
                playable_only: Some(true),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(collapsed.total, 3);
        assert!(
            !collapsed
                .items
                .iter()
                .any(|c| c.name.contains("// Lightning Bolt")),
            "art series carry their own oracle_id, so collapsing alone never hid this row"
        );
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
        let orders: [(&str, Vec<crate::sorting::SortTerm>); 8] = [
            ("name", vec![term("name", "asc")]),
            ("set", vec![term("set", "desc")]),
            ("type", vec![term("type", "asc")]),
            ("rarity", vec![term("rarity", "asc")]),
            ("price", vec![term("price", "desc")]),
            // The picker's two, which have no header to press and were therefore easy to
            // leave off a list that says "every single-column order". These six Forests
            // agree on both — same `released_at`, no `cmc` at all — so they are exactly
            // the tie this test is about.
            ("manaValue", vec![term("manaValue", "asc")]),
            ("released", vec![term("released", "desc")]),
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
                price: Some(400.5),
                layout: "normal".into(),
                oracle_id: Some("o-bolt".into()),
                finishes: Some(r#"["nonfoil","foil"]"#.into()),
                // Alpha carries none, so the payload is invented — the point of pinning it
                // against a value rather than `null` is that `promoTypes` and `promo` are one
                // letter apart on the wire and only one of them is on this DTO.
                promo_types: Some(r#"["surgefoil"]"#.into()),
                game_changer: true,
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
                    "manaCost": null, "price": 400.5,
                    "layout": "normal",
                    "oracleId": "o-bolt", "finishes": "[\"nonfoil\",\"foil\"]",
                    "promoTypes": "[\"surgefoil\"]",
                    "gameChanger": true,
                    "ownedQuantity": 0, "wishlisted": false,
                    "printings": 1,
                    "priceLow": 400.5, "priceHigh": 400.5
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
        assert_eq!(card.price_low, card.price);
        assert_eq!(card.price_high, card.price);
    }

    /// Four printings of one card become one row, and the row says how many it stands for
    /// and what the cheapest and dearest of them cost.
    ///
    /// `b3` and `b4` are the same day's printings and `b4` is the greater id, so the row the
    /// old `released_at DESC, id DESC` rule produced was `b4` — this fixture discriminates
    /// between the two rules rather than agreeing with both.
    #[test]
    fn collapse_folds_every_printing_of_a_card_into_one_row() {
        let conn = seeded();
        for (id, set, released, price) in [
            ("b1", "lea", "1993-08-05", 400.0),
            ("b2", "m10", "2009-07-17", 5.0),
            ("b3", "m11", "2010-07-16", 1.5),
            ("b4", "m11", "2010-07-16", 3.0),
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
        assert_eq!(shocks.len(), 1, "four printings, one row");
        assert_eq!(shocks[0].printings, 4);
        assert_eq!(
            shocks[0].id, "b3",
            "the cheapest of the latest release's printings represents the card"
        );
        assert_eq!(shocks[0].price_low, Some(1.5));
        assert_eq!(shocks[0].price_high, Some(400.0));
    }

    /// **`promo_types` comes back from both branches, and the three collapse aggregates still
    /// land where they were.**
    ///
    /// Issue #160: the column names *which* foil a printing's shiny copy is — Surge, Halo,
    /// Serialized — where `finishes` only has three words for how shiny it is. Rust hands it
    /// over unread; `src/lib/treatment.ts` does the naming.
    ///
    /// The test is about **positions**, not about the value. This read is positional and the
    /// two branches share one row mapping, so a column added to one and not the other, or
    /// added without renumbering, is silent: `promo_types` went in at 13, which pushed
    /// `game_changer` to 13→14 (`Option<bool>`, which would have taken a JSON *string* as a
    /// hard error) and the three collapse-only aggregates from 15/16/17 to 16/17/18 — where
    /// `printings` and `wishlisted` would have collided on 15 and answered each other's
    /// question as plausible integers.
    #[test]
    fn a_promo_type_survives_both_branches_of_the_row_mapping() {
        let conn = seeded();
        // Two printings of one oracle card, one treated and one not, so the collapsed branch
        // has a group to represent — MUL 133's real payload against MUL 3's absent one.
        for (id, cn, released, promo) in [
            ("halo", "133", "2023-04-21", Some(r#"["halofoil"]"#)),
            ("plain", "3", "2023-04-20", None),
        ] {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                    layout, released_at, rarity, finishes, promo_types, price_usd, is_paper,
                    search_text, raw)
                 VALUES (?1,'o-norn','Elesh Norn','mul',?2,'en','normal',?3,'mythic',
                    '[\"foil\"]', ?4, 95.79, 1, 'Elesh Norn', '{}')",
                rusqlite::params![id, cn, released, promo],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        let uncollapsed = run_search(
            &conn,
            &SearchRequest {
                text: Some("elesh".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let treated = uncollapsed.items.iter().find(|c| c.id == "halo").unwrap();
        assert_eq!(treated.promo_types.as_deref(), Some(r#"["halofoil"]"#));
        // The neighbours on either side of the new column, which is what an off-by-one moves.
        assert_eq!(treated.finishes.as_deref(), Some(r#"["foil"]"#));
        assert!(!treated.game_changer);
        assert_eq!(treated.owned_quantity, 0);
        assert!(!treated.wishlisted);
        assert_eq!(treated.printings, 1, "uncollapsed, a row is one printing");
        // Untreated is `None`, not an empty array: the column is NULL on four fifths of the
        // corpus, and that is the shape every reader fences on.
        let plain = uncollapsed.items.iter().find(|c| c.id == "plain").unwrap();
        assert_eq!(plain.promo_types, None);

        let collapsed = run_search(
            &conn,
            &SearchRequest {
                text: Some("elesh".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let group: Vec<&CardSummary> = collapsed
            .items
            .iter()
            .filter(|c| c.name == "Elesh Norn")
            .collect();
        assert_eq!(group.len(), 1, "two printings, one row");
        assert_eq!(
            group[0].promo_types.as_deref(),
            Some(r#"["halofoil"]"#),
            "the representative's own column, like `game_changer` beside it"
        );
        // The three aggregates that had to renumber past it.
        assert_eq!(group[0].printings, 2);
        assert_eq!(group[0].price_low, Some(95.79));
        assert_eq!(group[0].price_high, Some(95.79));
    }

    /// Printings of one card, in the shape the representative rule is argued over: a set, a
    /// release date and a price each. Ids are chosen per test so that the rule this file uses
    /// and the `released_at DESC, id DESC` one it replaced cannot agree by accident.
    fn seed_printings(
        conn: &Connection,
        name: &str,
        oracle: &str,
        rows: &[(&str, &str, &str, Option<f64>)],
    ) {
        for (id, set, released, price) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,released_at,
                                    price_usd,is_paper,oracle_id,search_text,raw)
                 VALUES (?1,?2,?3,?1,'en','normal',?4,?5,1,?6,?2,'{}')",
                rusqlite::params![id, name, set, released, price, oracle],
            )
            .unwrap();
        }
    }

    /// An empty database with the schema on it — the collapse fixtures below seed every row
    /// they reason about, so [`seeded`]'s three cards would only be noise to filter back out.
    fn bare() -> Connection {
        crate::schema::memory_pair()
    }

    /// The id of the printing that represents `name` in a collapsed browse of `conn`.
    fn representative(
        conn: &Connection,
        name: &str,
        marketplace: crate::sorting::Marketplace,
    ) -> String {
        run_search(
            conn,
            &SearchRequest {
                collapse: Some(true),
                marketplace,
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap()
        .items
        .into_iter()
        .find(|c| c.name == name)
        .unwrap_or_else(|| panic!("{name} did not come back from the collapsed browse"))
        .id
    }

    /// The row stands for the printing a reader would actually buy: the card's latest release,
    /// and the cheapest printing of it. Three printings share that date here and the middle
    /// one is the cheapest, so neither "newest" nor "greatest id" can produce this answer.
    #[test]
    fn the_representative_is_the_cheapest_printing_of_the_latest_release() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("p1", "lea", "1993-08-05", Some(0.10)),
                ("p9", "m21", "2020-07-03", Some(9.00)),
                ("p2", "m21", "2020-07-03", Some(2.00)),
                ("p5", "m21", "2020-07-03", Some(5.00)),
            ],
        );
        assert_eq!(
            representative(&conn, "Shock", crate::sorting::Marketplace::Tcgplayer),
            "p2",
            "the cheapest of the three that share the latest date"
        );
    }

    /// The release date is weighed **before** the price. A $50 printing of this year's set
    /// represents the card over a $0.10 printing from 1993 — the row is about which cardboard
    /// is current — and the cheap one is still the low end of the range beside it.
    #[test]
    fn the_release_date_is_weighed_before_the_price() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("p1", "lea", "1993-08-05", Some(0.10)),
                ("p2", "m21", "2020-07-03", Some(50.00)),
            ],
        );
        let r = run_search(
            &conn,
            &SearchRequest {
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items[0].id, "p2");
        assert_eq!(r.items[0].price, Some(50.0), "and quotes what it costs");
        assert_eq!(
            r.items[0].price_low,
            Some(0.10),
            "the 1993 printing is still the low end of the range"
        );
    }

    /// A printing the marketplace does not price is not a free printing: it loses to every
    /// priced sibling of the same date. It represents the card only when nothing of that date
    /// is priced at all, and that case still resolves — to the greatest id, deterministically.
    #[test]
    fn an_unpriced_printing_loses_to_a_priced_one_and_still_resolves_alone() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("q9", "m21", "2020-07-03", None),
                ("q1", "m21", "2020-07-03", Some(900.00)),
            ],
        );
        seed_printings(
            &conn,
            "Terror",
            "o-terror",
            &[
                ("t1", "m21", "2020-07-03", None),
                ("t8", "m21", "2020-07-03", None),
                ("t4", "lea", "1993-08-05", Some(0.10)),
            ],
        );
        use crate::sorting::Marketplace::Tcgplayer;
        assert_eq!(
            representative(&conn, "Shock", Tcgplayer),
            "q1",
            "$900 beats no price at all, greater id or not"
        );
        assert_eq!(
            representative(&conn, "Terror", Tcgplayer),
            "t8",
            "and an entirely unpriced date falls back on the id tiebreak"
        );
    }

    /// Two sets can share a release date — a set and its promos, `frf` and `pfrf`. They are
    /// weighed **together**: the cheapest printing of that date wins whichever set it is in.
    ///
    /// The key deliberately carries no `set_code` term, and this is the fixture that says why.
    /// Promo sets are `p`-prefixed, so a `set_code DESC` tiebreak would hand every same-day
    /// pair to the promo — `pfrf 143s` at $2.59 over `frf 143` at $0.35 — and a rule called
    /// "cheapest" would have made 1 155 rows dearer (measured 2026-08-14, live database).
    #[test]
    fn two_sets_sharing_the_latest_release_date_are_weighed_together() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("f9", "pfrf", "2014-11-28", Some(2.59)),
                ("f1", "frf", "2014-11-28", Some(0.35)),
            ],
        );
        assert_eq!(
            representative(&conn, "Shock", crate::sorting::Marketplace::Tcgplayer),
            "f1",
            "the cheaper of the pair, and neither the greater id nor the greater set code"
        );
    }

    /// Which printing represents a card is a **marketplace** decision. The same three
    /// printings of one set are cheapest in a different order at each shop, and every answer
    /// is right about its own — the query key carries the marketplace, so switching refetches.
    #[test]
    fn the_representative_follows_the_marketplace() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("m1", "m21", "2020-07-03", Some(1.00)),
                ("m2", "m21", "2020-07-03", Some(2.00)),
                ("m3", "m21", "2020-07-03", Some(3.00)),
            ],
        );
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "m1", "nonfoil", 30.00),
                ("cardkingdom", "m2", "nonfoil", 20.00),
                ("cardkingdom", "m3", "nonfoil", 10.00),
                ("manapool", "m1", "nonfoil", 7.00),
                ("manapool", "m2", "nonfoil", 4.00),
                ("manapool", "m3", "nonfoil", 8.00),
            ],
        );
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};
        assert_eq!(representative(&conn, "Shock", Tcgplayer), "m1");
        assert_eq!(representative(&conn, "Shock", Cardkingdom), "m3");
        assert_eq!(representative(&conn, "Shock", Manapool), "m2");
        assert_eq!(
            representative(&conn, "Shock", Cardmarket),
            "m3",
            "no euro price anywhere in the set, so the id tiebreak decides — not another \
             shop's ordering"
        );
    }

    /// Filters narrow printings first and the survivors are grouped, so the representative is
    /// always a printing that **matched**. A search narrowed to an old set is represented by
    /// that set's cheapest printing, never by the newest one the database happens to hold.
    #[test]
    fn the_representative_is_a_printing_that_matched_the_filters() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("f1", "lea", "1993-08-05", Some(300.00)),
                ("f2", "lea", "1993-08-05", Some(400.00)),
                ("f3", "m21", "2020-07-03", Some(0.10)),
            ],
        );
        let r = run_search(
            &conn,
            &SearchRequest {
                set_code: Some("lea".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(
            r.items[0].printings, 2,
            "the two lea printings, not all three"
        );
        assert_eq!(
            r.items[0].id, "f1",
            "the cheaper lea printing — the m21 one did not match and cannot represent it"
        );
    }

    /// A ranked collapsed search runs its group step over the `MATERIALIZED` CTE rather than
    /// over `cards`, so the representative is picked by the same expression against a
    /// different relation. It must answer what the browse answers.
    #[test]
    fn a_ranked_collapsed_search_picks_the_same_representative() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("p1", "lea", "1993-08-05", Some(0.10)),
                ("p9", "m21", "2020-07-03", Some(9.00)),
                ("p2", "m21", "2020-07-03", Some(2.00)),
            ],
        );
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        let r = run_search(
            &conn,
            &SearchRequest {
                text: Some("shock".into()),
                collapse: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(r.items.len(), 1);
        assert_eq!(
            r.items[0].id, "p2",
            "the ranked path picks what the browse picks"
        );
    }

    /// `printf('%012d', …)` pads to twelve characters but never *truncates*: a value below
    /// `-99999999999` is thirteen (measured in this build's SQLite by the test below). A
    /// wider segment would move the id, `substr(…, 23)` would slice into the middle of a
    /// UUID, and the primary-key join would then drop the card off the page altogether —
    /// silently. Both ends of the cents are clamped, so the row survives instead.
    #[test]
    fn a_price_outside_the_keys_range_still_resolves_to_a_real_printing() {
        let conn = bare();
        seed_printings(
            &conn,
            "Shock",
            "o-shock",
            &[
                ("w1", "m21", "2020-07-03", Some(99_999_999_999.99)),
                ("w2", "m21", "2020-07-03", Some(-5.00)),
            ],
        );
        seed_printings(
            &conn,
            "Terror",
            "o-terror",
            &[
                ("v1", "m21", "2020-07-03", Some(1e12)),
                ("v2", "m21", "2020-07-03", Some(4.00)),
            ],
        );
        use crate::sorting::Marketplace::Tcgplayer;
        assert_eq!(
            representative(&conn, "Shock", Tcgplayer),
            "w2",
            "a price below zero clamps to zero cents, the cheapest key there is"
        );
        assert_eq!(
            representative(&conn, "Terror", Tcgplayer),
            "v2",
            "and one past the base clamps to the dearest, losing to a real price"
        );
    }

    /// The two facts the key's fixed widths rest on, asserted against the SQLite this crate
    /// actually links rather than against the documentation. `printf` pads a negative to
    /// twelve *including* the sign but widens past it, which is the whole reason
    /// [`collapse_rep`] clamps; the scalar `min`/`max` return NULL for a NULL argument, which
    /// is what carries an unpriced printing through to the `coalesce`.
    #[test]
    fn the_price_segment_is_twelve_characters_and_null_survives_the_clamp() {
        let conn = Connection::open_in_memory().unwrap();
        let width = |n: &str| -> i64 {
            conn.query_row(&format!("SELECT length(printf('%012d', {n}))"), [], |r| {
                r.get(0)
            })
            .unwrap()
        };
        assert_eq!(width("0"), 12);
        assert_eq!(width("999999999999"), 12);
        assert_eq!(width("-1"), 12, "the sign eats a digit, not a column");
        assert_eq!(
            width("-100000000000"),
            13,
            "and past that it widens, which is what the clamp exists for"
        );
        let clamped: Option<i64> = conn
            .query_row(
                "SELECT max(0, min(999999999999, CAST(round(NULL * 100) AS INTEGER)))",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            clamped, None,
            "an unpriced printing stays NULL through both"
        );
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
        let conn = crate::schema::memory_pair();
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

    /// Three cards in one set, two printings apiece, with **crossing** price ranges:
    /// `(id, name, oracle_id, price_usd)`.
    ///
    /// Every number here is load-bearing, and the arithmetic is the test rather than the
    /// decoration — `Alpha` spans 5–60, `Bravo` 1–10, `Charlie` 3–100, so:
    ///
    /// | order | answer | why it is not something else |
    /// | --- | --- | --- |
    /// | `min` ASC | Bravo, Charlie, Alpha | `max` ASC would be Bravo, Alpha, Charlie |
    /// | `max` DESC | Charlie, Alpha, Bravo | `min` DESC would be Alpha, Charlie, Bravo |
    ///
    /// and the alphabet — Alpha, Bravo, Charlie — is neither of them, in either direction.
    /// That is four ways to be wrong that this fixture can see and the `Shock`/`Terror` pair
    /// it replaced could not: those two sorted `["Shock", "Terror"]` under `min` ASC, under
    /// `max` DESC **and** under the alphabet, so the test named for the ends of the range
    /// asserted neither end, and stayed green through the whole life of the bug
    /// [`SEARCH_SORTS_JOINED`] describes. A fixture that cannot distinguish the order it
    /// names is not a weak test, it is the reason the next one goes unnoticed.
    #[rustfmt::skip]
    fn seed_crossing_price_ranges(conn: &Connection) {
        let rows = [
            ("a-lo", "Alpha",     "o-a",   5.0),
            ("a-hi", "Alpha",     "o-a",  60.0),
            ("b-lo", "Bravo",     "o-b",   1.0),
            ("b-hi", "Bravo",     "o-b",  10.0),
            ("c-lo", "Charlie",   "o-c",   3.0),
            ("c-hi", "Charlie",   "o-c", 100.0),
        ];
        for (id, name, oracle, price) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,price_usd,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'zzz',?1,'en','normal',?3,1,?4,'{}')",
                rusqlite::params![id, name, price, oracle],
            ).unwrap();
        }
    }

    /// The page `seed_crossing_price_ranges` produces under one collapsed sort, as names.
    fn collapsed_order(conn: &Connection, key: &str, dir: &str) -> Vec<String> {
        run_search(
            conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                collapse: Some(true),
                sort: Some(vec![term(key, dir)]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap()
        .items
        .into_iter()
        .map(|c| c.name)
        .collect()
    }

    /// Sorting a collapsed list by price sorts by the **range**: cheapest-first ascending,
    /// dearest-available first descending. That is what pressing a range column means in
    /// each direction, and it is what the column shows.
    ///
    /// Both directions, over ranges that cross, so `min` and `max` are each observable on
    /// their own — see `seed_crossing_price_ranges` for the arithmetic and for what this
    /// test used to fail to say.
    #[test]
    fn a_collapsed_price_sort_orders_by_the_ends_of_the_range() {
        let conn = seeded();
        seed_crossing_price_ranges(&conn);
        assert_eq!(
            collapsed_order(&conn, "price", "asc"),
            ["Bravo", "Charlie", "Alpha"],
            "cheapest end first — 1, 3, 5 — and not the cheapest group's dearest printing"
        );
        assert_eq!(
            collapsed_order(&conn, "price", "desc"),
            ["Charlie", "Alpha", "Bravo"],
            "dearest end first — 100, 60, 10 — which is not the ascending order reversed"
        );
    }

    /// A collapsed `name` DESC has to actually reverse.
    ///
    /// The other half of what the join's own `ORDER BY` used to override: it restated the
    /// *fallback* `g.nm ASC` whatever was asked for, so a reversed name order fetched the
    /// Z-end of the corpus and then presented it ascending — right rows, wrong order, on the
    /// default search. Reproduced against the live 98 323-printing database on 2026-08-20.
    /// Nothing else in this file asks a collapsed list to reverse a group-step order.
    /// See [`SEARCH_SORTS_JOINED`].
    #[test]
    fn a_collapsed_name_sort_reverses_when_it_is_asked_to() {
        let conn = seeded();
        seed_crossing_price_ranges(&conn);
        assert_eq!(
            collapsed_order(&conn, "name", "asc"),
            ["Alpha", "Bravo", "Charlie"]
        );
        assert_eq!(
            collapsed_order(&conn, "name", "desc"),
            ["Charlie", "Bravo", "Alpha"],
            "reversed, rather than the ascending order the group step was limited on"
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

    /// Two printings per card, in one set, with the release dates and the names deliberately
    /// disagreeing: `(id, name, oracle_id, released_at, cmc)`.
    ///
    /// `cmc` is the **same within each group**, because that is what the corpus says and what
    /// [`SEARCH_SORTS_COLLAPSED`]'s `min(c.cmc)` rests on — a fixture that disagreed with
    /// itself would be testing a card that cannot exist.
    #[rustfmt::skip]
    fn seed_two_printings_apiece(conn: &Connection) {
        let rows = [
            ("a-old", "Aaa", "o-a", "2001-01-01", 2.0),
            ("a-new", "Aaa", "o-a", "2015-05-05", 2.0),
            ("b-old", "Bbb", "o-b", "1999-09-09", 4.0),
            ("b-new", "Bbb", "o-b", "2020-02-02", 4.0),
        ];
        for (id, name, oracle, released, cmc) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,released_at,cmc,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'zzz',?1,'en','normal',?3,?4,1,?5,'{}')",
                rusqlite::params![id, name, released, cmc, oracle],
            ).unwrap();
        }
    }

    /// The collapsed `released` order is `max(c.released_at)` — an aggregate — while the row
    /// shows a single printing, and the two agree only because [`collapse_rep`] picks by
    /// `released_at` DESC before anything else. This checks that against the query rather
    /// than trusting the expression: the assertion is on the **ids the search returned**, so
    /// it fails both if the groups come back in the wrong order and if the printing each row
    /// shows is not the one whose date decided its place.
    ///
    /// Alphabetical order would answer `["a-new", "b-new"]`, which is what a dropped key
    /// falls back to.
    ///
    /// The second page is asked for as well, and it is the assertion that bites hardest:
    /// [`SEARCH_SORTS_JOINED`] re-states this order after the join, so a `released` missing
    /// from [`SEARCH_SORTS_COLLAPSED`] still comes back looking right on a single page —
    /// it is only which groups the group step's `LIMIT` took that gives it away. Measured by
    /// misspelling the key on 2026-08-20: page one passed, page two did not.
    #[test]
    fn a_collapsed_released_sort_agrees_with_the_representative_it_shows() {
        let conn = seeded();
        seed_two_printings_apiece(&conn);
        let req = |limit: u32, offset: u32| SearchRequest {
            set_code: Some("zzz".into()),
            collapse: Some(true),
            sort: Some(vec![term("released", "desc")]),
            limit,
            offset,
            ..Default::default()
        };

        let r = run_search(&conn, &req(50, 0)).unwrap();
        let ids: Vec<&str> = r.items.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["b-new", "a-new"],
            "newest group first, each row showing the printing that dated it"
        );
        assert!(
            r.items.iter().all(|c| c.printings == 2),
            "and both rows really are groups of two"
        );

        let page2 = run_search(&conn, &req(1, 1)).unwrap();
        let ids: Vec<&str> = page2.items.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["a-new"], "the second page of the release order");
    }

    /// A collapsed `manaValue` sort is answered **inside the group step**, where the `LIMIT`
    /// is, rather than after the 37 553-group join.
    ///
    /// **Which property distinguishes the two paths, and why the ordering alone does not.**
    /// Every printing of a card carries the same `cmc` — that is the whole argument for
    /// `min(c.cmc)` — so the group step and the representative path would return the same
    /// page in the same order, and an ordering assertion passes on either. The property that
    /// actually decides is `sorts_after_join` in [`run_search`], and it is
    /// [`REPRESENTATIVE_SORTS`] membership and nothing else: on that list the group CTE gives
    /// up its `LIMIT` and every group is joined before the page is cut. So this test asserts
    /// both halves, and neither is redundant — the membership check is the path, and the
    /// ordering is what says the key is wired at all, since
    /// [`crate::sorting::order_by`] drops a key its whitelist misses **silently** and a
    /// picker entry that sorts nothing would otherwise fail nowhere.
    ///
    /// The paged assertion is the third: with the `LIMIT` inside the CTE the offset walks the
    /// *sorted* groups, not the ones that led in name order.
    #[test]
    fn a_collapsed_mana_value_sort_uses_the_group_step() {
        assert!(
            !REPRESENTATIVE_SORTS.contains(&"manaValue"),
            "listing it there moves the LIMIT to after the join, at ~5.5× the cost"
        );

        let conn = seeded();
        seed_two_printings_apiece(&conn);
        let req = |limit: u32, offset: u32| SearchRequest {
            set_code: Some("zzz".into()),
            collapse: Some(true),
            sort: Some(vec![term("manaValue", "desc")]),
            limit,
            offset,
            ..Default::default()
        };

        let all = run_search(&conn, &req(50, 0)).unwrap();
        let ids: Vec<&str> = all.items.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            ["b-new", "a-new"],
            "the higher mana value first — `Bbb` is 4, `Aaa` is 2 — and not the alphabet"
        );

        let page2 = run_search(&conn, &req(1, 1)).unwrap();
        let ids: Vec<&str> = page2.items.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(ids, ["a-new"], "the second page of the mana-value order");
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
        crate::split::convert(&dir).unwrap();

        let write = crate::db::open_write(&dir).unwrap();
        write.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw) VALUES ('1','Lightning Bolt','lea','161','en','normal',1,'{}')", []).unwrap();
        let read = crate::db::open_read(&dir).unwrap();

        // **Hooked up, so what these fixtures drive runs with the cross-file fence
        // armed.** `crate::sync::with_write`'s `debug_assert` reads it, so a command
        // that committed to both files fails its own test rather than printing a line
        // nobody reads. The mask rides along because SQLite allows one update hook per
        // connection, and nothing here looks at it.
        let mirror = std::sync::Arc::new(crate::mirror::watch::Mask::default());
        let fence = std::sync::Arc::new(crate::db::CrossFileFence::new());
        crate::mirror::watch::install_hook(&write, mirror.clone(), fence.clone());
        let state = Arc::new(AppState {
            db: Mutex::new(write),
            db_read: Mutex::new(read),
            data_dir: dir.clone(),
            syncing: AtomicBool::new(true),
            client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            images: crate::images::Cache::new(dir.join("images")),
            index: std::sync::RwLock::default(),
            // The mirror is never started in these tests; a clean mask and an empty record are
            // what an `AppState` looks like before the first pass.
            mirror,
            mirror_status: std::sync::Mutex::new(crate::mirror::watch::LastPass::default()),
            fence,
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
        let mut req: SearchRequest = serde_json::from_str(
            r#"{"text":"bolt","setCode":"lea","oracleId":"o1","paperOnly":true,"playableOnly":true,"owned":false}"#,
        )
        .unwrap();
        assert_eq!(req.set_code.as_deref(), Some("lea"));
        // Pins the wire spelling `oracleId`, not merely that the struct carries a field of
        // that name: `#[serde(rename_all = "camelCase")]` makes a mismatch silent — the field
        // reads `None` with no error anywhere, and `oracleId === undefined` on the TypeScript
        // side is the failure `ipc.ts`'s own module doc warns about, returning the whole
        // corpus rather than one card's printings.
        assert_eq!(req.oracle_id.as_deref(), Some("o1"));
        assert_eq!(req.paper_only, Some(true));
        // Two adjacent `…Only` flags whose defaults are opposites, so the spelling is pinned
        // here as well as the value: a typo lands on `None`, which is the *off* state for
        // this one and the *on* state for its neighbour.
        assert_eq!(req.playable_only, Some(true));
        // `Some(false)` and `None` are different filters — "the ones I do not have" against
        // "no opinion" — so this pins the value, not merely that the key parsed.
        assert_eq!(req.owned, Some(false));
        assert_eq!(req.limit, 0, "omitted limit means unset, not a parse error");
        assert_eq!(req.offset, 0);

        // `seeded()`'s rows carry no `oracle_id` (NULL, like most fixtures in this file that
        // predate this filter), so it is cleared before the search half of this test runs —
        // this block is pinning "unset behaves as the default page size", not the oracle_id
        // filter itself, which has its own tests above.
        req.oracle_id = None;
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

    /// Cards for the two picker-only orders: `(id, name, cmc, released_at)`.
    ///
    /// A set of its own so [`seeded`]'s three rows — none of which carries either column —
    /// cannot pad the answer, and names deliberately at odds with both orders, because
    /// alphabetical is what a dropped key falls back to and a fixture that agrees with the
    /// fallback proves nothing.
    #[rustfmt::skip]
    fn seed_picker_orders(conn: &Connection) {
        let rows = [
            ("q1", "Alpha",   Some(3.0), Some("2019-01-01")),
            ("q2", "Bravo",   None,      None),
            ("q3", "Charlie", Some(0.0), Some("1993-08-05")),
            ("q4", "Delta",   Some(7.0), Some("2024-06-14")),
        ];
        for (id, name, cmc, released) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,released_at,
                                    is_paper,oracle_id,raw)
                 VALUES (?1,?2,'zzz',?1,'en','normal',?3,?4,1,?1,'{}')",
                rusqlite::params![id, name, cmc, released],
            ).unwrap();
        }
    }

    /// The page `seed_picker_orders` produces under one sort, as names.
    fn picker_order(conn: &Connection, key: &str, dir: &str) -> Vec<String> {
        run_search(
            conn,
            &SearchRequest {
                set_code: Some("zzz".into()),
                sort: Some(vec![term(key, dir)]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap()
        .items
        .into_iter()
        .map(|c| c.name)
        .collect()
    }

    /// `cmc` is nullable, and this key has no table header of its own — it is reached from
    /// the filter bar's sort picker, so nothing else in the app would notice if
    /// [`crate::sorting::order_by`] dropped it.
    #[test]
    fn mana_value_sorts_ascending_and_descending_with_nulls_last() {
        let conn = seeded();
        seed_picker_orders(&conn);
        assert_eq!(
            picker_order(&conn, "manaValue", "asc"),
            ["Charlie", "Alpha", "Delta", "Bravo"],
            "0, 3, 7 — and the card with no mana value last"
        );
        assert_eq!(
            picker_order(&conn, "manaValue", "desc"),
            ["Delta", "Alpha", "Charlie", "Bravo"],
            "the rows reversed, not the hole moved"
        );
    }

    /// Same shape for `released_at`, whose holes are commoner: a card the sync has no
    /// release date for is not a card printed at the dawn of time.
    #[test]
    fn released_sorts_ascending_and_descending_with_nulls_last() {
        let conn = seeded();
        seed_picker_orders(&conn);
        assert_eq!(
            picker_order(&conn, "released", "asc"),
            ["Charlie", "Alpha", "Delta", "Bravo"],
            "1993, 2019, 2024 — and the undated card last"
        );
        assert_eq!(
            picker_order(&conn, "released", "desc"),
            ["Delta", "Alpha", "Charlie", "Bravo"],
            "the rows reversed, not the hole moved"
        );
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
    ///
    /// The unpriced card is named `Aa Unpriced` and both directions are asked for, and both
    /// of those are deliberate. It was `Unpriced Card`, which sorts last **alphabetically
    /// too**, so the expected answer was also the fallback's answer and the assertion could
    /// not tell a working price sort from a dropped one; and descending is the direction
    /// SQLite would get right on its own, since its own rule is NULLs last descending.
    /// Ascending is the half that needs the words `NULLS LAST` written down, and it was the
    /// half not being asked (2026-08-20).
    #[test]
    fn price_sort_puts_unpriced_cards_last() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,raw)
             VALUES ('4','Aa Unpriced','lea','2','en','normal',1,'{}')",
            [],
        )
        .unwrap();
        let names = |dir: &str| -> Vec<String> {
            run_search(
                &conn,
                &SearchRequest {
                    sort: Some(vec![term("price", dir)]),
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .into_iter()
            .map(|c| c.name)
            .collect()
        };
        assert_eq!(
            names("desc"),
            ["Lightning Bolt", "Lightning Helix", "Aa Unpriced"],
            "descending by price — $400.50, $1.50 — and the hole last"
        );
        assert_eq!(
            names("asc"),
            ["Lightning Helix", "Lightning Bolt", "Aa Unpriced"],
            "the rows reversed, and the hole did not move to the top with them"
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
        let conn = crate::schema::memory_pair();
        // The printed cost rides along with `cmc` because the two are separate claims and the
        // X chip reads the first while the value chips read the second — a fixture carrying
        // only `cmc` can prove nothing about a filter that never looks at it. `Jinnie Fay`
        // keeps a NULL in *both*, which is the column's contract on both sides.
        // `(id, name, set_code, cmc, mana_cost, color_identity)`. Named because
        // `clippy::type_complexity` will not take a six-element tuple written out, and a
        // `type` definition is the remedy the lint itself asks for —
        // `index::fixtures::Printing`'s reason, verbatim.
        type Costed = (
            &'static str,
            &'static str,
            &'static str,
            Option<f64>,
            Option<&'static str>,
            &'static str,
        );
        let rows: [Costed; 4] = [
            ("1", "Lightning Bolt",  "lea", Some(1.0),  Some("{R}"),           "R"),
            ("2", "Wrath of God",    "lea", Some(4.0),  Some("{2}{W}{W}"),     "W"),
            ("3", "Emrakul",         "roe", Some(15.0), Some("{15}"),          ""),
            ("4", "Jinnie Fay",      "sld", None,       None,                  "G"),
        ];
        for (id, name, set, cmc, cost, ci) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,mana_cost,
                    color_identity,legalities,is_paper,search_text,raw)
                 VALUES (?1,?2,?3,'1','en','normal',?4,?5,?6,'{\"modern\":\"legal\"}',1,?2,'{}')",
                rusqlite::params![id, name, set, cmc, cost, ci],
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

    /// The X chip against a real query, which is where the OR has to hold: `{X}{B}{B}{B}` is
    /// **mana value 3 and variable at once** (Scryfall scores X as 0), so pressing "3" finds
    /// it, pressing "X" finds it, and pressing both finds it exactly once.
    ///
    /// The last of those three is the one an `AND` term would get wrong invisibly: it would
    /// still return the card here — it satisfies both — while dropping every ordinary
    /// three-drop the reader also asked for. Hence the assertion on the *other* card too.
    #[test]
    fn the_x_chip_matches_a_variable_cost_and_ors_with_the_value_chips() {
        let conn = seeded_costs();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,mana_cost,
                color_identity,legalities,is_paper,search_text,raw)
             VALUES ('5','Crux of Fate','ktk','2','en','normal',3.0,'{X}{B}{B}{B}','B',
                     '{\"modern\":\"legal\"}',1,'Crux of Fate','{}'),
                    ('6','Doom Blade','m10','3','en','normal',3.0,'{1}{B}{B}','B',
                     '{\"modern\":\"legal\"}',1,'Doom Blade','{}')",
            [],
        )
        .unwrap();
        let search = |f: fn(&mut SearchRequest)| {
            let mut req = SearchRequest {
                limit: 50,
                ..Default::default()
            };
            f(&mut req);
            let r = run_search(&conn, &req).unwrap();
            let mut got = names(&r).iter().map(|s| s.to_string()).collect::<Vec<_>>();
            got.sort();
            (got, r.total)
        };

        let (x, total) = search(|r| r.mana_x = Some(true));
        assert_eq!(x, ["Crux of Fate"], "the printed `{{X}}`, and only it");
        assert_eq!(total, 1, "and the count subquery carries the same filter");

        let (three, _) = search(|r| r.mana_values = Some(vec![3]));
        assert_eq!(
            three,
            ["Crux of Fate", "Doom Blade"],
            "X costs nothing towards `cmc`, so the variable card is a three-drop too"
        );

        let (both, both_total) = search(|r| {
            r.mana_values = Some(vec![1]);
            r.mana_x = Some(true);
        });
        assert_eq!(
            both,
            ["Crux of Fate", "Lightning Bolt"],
            "either, not both — an AND term would have lost the one-drop"
        );
        assert_eq!(both_total, 2, "and returns the X card once, not twice");

        // Omitted and explicitly-false are the same answer: every list that has never heard of
        // this chip keeps the rows it had.
        let all = search(|_| {}).1;
        assert_eq!(search(|r| r.mana_x = Some(false)).1, all);
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
            r#"{"text":"bolt","sets":["lea","2ed"],"manaValues":[0,8],"manaX":true,"paperOnly":true,"limit":50,"offset":0}"#,
        )
        .unwrap();

        assert_eq!(req.sets.unwrap(), vec!["lea".to_owned(), "2ed".to_owned()]);
        assert_eq!(req.mana_values.unwrap(), vec![0u8, 8]);
        assert_eq!(req.mana_x, Some(true));

        // …and a payload from before the chip existed leaves it off, which is `None` and adds
        // no predicate — the omitted-means-false half of the contract.
        let old: SearchRequest = serde_json::from_str(r#"{"manaValues":[2]}"#).unwrap();
        assert_eq!(old.mana_x, None);
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

    /// The crown the search wall and table draw beside the finish marks, on the row rather
    /// than behind a per-tile round trip — as `finishes` and `oracle_id` are, and for the
    /// same reason.
    ///
    /// Both query shapes, because they are two different select lists feeding one row
    /// mapping: a column added to only one of them, or added at a different position, comes
    /// back as another column's value rather than as an error. And all three states of a
    /// **nullable** column, because a NULL here means *not on the list* — reading it as a
    /// bare `bool` is not a `false`, it is an `InvalidColumnType` that fails the search.
    #[test]
    fn results_say_which_cards_are_game_changers() {
        let conn = seeded();
        // Rhystic Study is the printing the bulk fixture publishes `"game_changer": true`
        // for (`cm1 15` — see `card_row`'s test); Sol Ring is the explicit `false`, and the
        // third row leaves the column unwritten, as every hand-seeded fixture here does.
        for (id, name, gc) in [
            ("gc1", "Rhystic Study", Some(1)),
            ("gc2", "Sol Ring", Some(0)),
            ("gc3", "Unwritten Card", None),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,is_paper,
                                    oracle_id,game_changer,raw)
                 VALUES (?1,?2,'cm1',?1,'en','normal',1,?1,?3,'{}')",
                rusqlite::params![id, name, gc],
            )
            .unwrap();
        }

        for collapse in [None, Some(true)] {
            let r = run_search(
                &conn,
                &SearchRequest {
                    collapse,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            let flag = |id: &str| r.items.iter().find(|c| c.id == id).unwrap().game_changer;
            assert!(flag("gc1"), "a named card wears the crown ({collapse:?})");
            assert!(!flag("gc2"), "and an ordinary card does not ({collapse:?})");
            assert!(
                !flag("gc3"),
                "a NULL is `not on the list`, never a third state ({collapse:?})"
            );
            assert!(!flag("1"), "the fixture's own rows too ({collapse:?})");

            // The neighbours on either side of the new column still land in their own
            // fields — the failure a shifted index actually produces.
            let bolt = r.items.iter().find(|c| c.id == "1").unwrap();
            assert_eq!(bolt.name, "Lightning Bolt", "{collapse:?}");
            assert_eq!(bolt.owned_quantity, 0, "{collapse:?}");
            assert!(!bolt.wishlisted, "{collapse:?}");
        }
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

    /// This filter asks whether the collection has an **entry** for a printing — the same
    /// reading as `CollectionSummary::unique_cards` — so a row holding no copies is owned, while
    /// `owned_quantity` counts copies and reads 0. Pinned rather than assumed, because the two
    /// halves disagreeing is exactly the kind of thing a badge would render as a bug.
    ///
    /// **The row is written in SQL rather than through `set_quantity`, and that is the point
    /// since schema v24**: that command now *deletes* at zero, so it can no longer produce the
    /// state this test is about. `update_entry` still can (it keeps the row it is editing), and
    /// so can a hand-written statement — which is what the column's `CHECK (quantity >= 0)` is
    /// left permitting. The filter's rule is about entries and not about how rare a zero row is.
    #[test]
    fn an_entry_with_no_copies_is_still_an_entry_the_collection_has() {
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

    // -- every marketplace -------------------------------------------------------------------

    /// Insert printings the way the ingest would: the bulk line is **parsed by
    /// [`crate::card_row`]**, so `price_usd` and `price_eur` are its own fallback chains
    /// rather than figures this fixture chose. That is what makes the etched line's euro
    /// NULL evidence — the parser found no `eur_etched` key because Scryfall publishes none
    /// (0 occurrences across 4 513 card objects), and no test here had to assert it by hand.
    fn seed_priced(conn: &Connection, lines: &[&str]) {
        for line in lines {
            let v: serde_json::Value = serde_json::from_str(line).unwrap();
            let r = crate::card_row::CardRow::from_json(&v).unwrap();
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,oracle_id,
                                    released_at,prices,price_usd,price_eur,is_paper,
                                    search_text,raw)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,1,?2,'{}')",
                rusqlite::params![
                    r.id,
                    r.name,
                    r.set_code,
                    r.collector_number,
                    r.lang,
                    r.layout,
                    r.oracle_id,
                    r.released_at,
                    r.prices,
                    r.price_usd,
                    r.price_eur,
                ],
            )
            .unwrap();
        }
    }

    /// One line, spelled the way the bulk file does.
    fn priced_line(id: &str, name: &str, oracle: &str, released: &str, prices: &str) -> String {
        format!(
            r#"{{"object":"card","id":"{id}","oracle_id":"{oracle}","name":"{name}","lang":"en",
                "layout":"normal","set":"lea","collector_number":"{id}",
                "released_at":"{released}","games":["paper"],"prices":{prices}}}"#
        )
    }

    /// Rows in `marketplace_prices` — [`crate::collection`]'s helper, kept per module.
    fn seed_feed(conn: &Connection, rows: &[(&str, &str, &str, f64)]) {
        for (marketplace, card_id, finish, price) in rows {
            conn.execute(
                "INSERT OR REPLACE INTO marketplace_prices
                    (marketplace, card_id, finish, price) VALUES (?1,?2,?3,?4)",
                rusqlite::params![marketplace, card_id, finish, price],
            )
            .unwrap();
        }
    }

    /// Every marketplace a price can come from — the collection's list, kept per module so
    /// neither can be extended without the other noticing.
    const MARKETPLACES: [crate::sorting::Marketplace; 4] = [
        crate::sorting::Marketplace::Tcgplayer,
        crate::sorting::Marketplace::Cardmarket,
        crate::sorting::Marketplace::Cardkingdom,
        crate::sorting::Marketplace::Manapool,
    ];

    /// Three printings whose order disagrees between marketplaces, and one of them etched-only
    /// — priced on TCGplayer, unpriced on Cardmarket, **missing from Card Kingdom's feed**,
    /// and priced by Mana Pool, which publishes an etched column.
    fn seeded_marketplaces() -> Connection {
        let conn = crate::schema::memory_pair();
        let lines = [
            priced_line(
                "a",
                "Alpha",
                "o-a",
                "2020-01-01",
                r#"{"usd":"1.00","eur":"90.00"}"#,
            ),
            priced_line(
                "b",
                "Beta",
                "o-b",
                "2020-01-02",
                r#"{"usd":"50.00","eur":"2.00"}"#,
            ),
            priced_line(
                "c",
                "Gamma",
                "o-c",
                "2020-01-03",
                r#"{"usd":null,"usd_foil":null,"usd_etched":"0.71","eur":null,"eur_foil":null}"#,
            ),
        ];
        seed_priced(&conn, &lines.iter().map(String::as_str).collect::<Vec<_>>());
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "a", "nonfoil", 0.50),
                ("cardkingdom", "b", "nonfoil", 5.00),
                // and no `cardkingdom` row for `c` at all.
                ("manapool", "a", "nonfoil", 2.00),
                ("manapool", "b", "nonfoil", 7.00),
                ("manapool", "c", "etched", 3.00),
            ],
        );
        conn
    }

    /// The price band, over the marketplace's **own** figure — and an unpriced printing fails a
    /// bound end rather than counting as free.
    ///
    /// The corpus is the same three printings every marketplace case here uses, and the point is
    /// that one band means two different things: at TCGplayer Alpha is $1.00 and Beta $50.00,
    /// while Card Kingdom's feed has them at $0.50 and $5.00 and has never listed Gamma at all.
    /// A filter written against `cards.price_usd` would have answered the same for both.
    ///
    /// **Gamma is the arm that matters.** `NULL >= ?` is NULL, so a shop that does not quote a
    /// printing has not offered it for nothing — it simply is not in a band. That is the one way
    /// this filter narrows more than a reader might expect, and it is the honest reading.
    #[test]
    fn a_price_band_reads_the_marketplace_it_was_asked_for_and_drops_the_unpriced() {
        let conn = seeded_marketplaces();
        let band = |marketplace, min: Option<f64>, max: Option<f64>| {
            let r = run_search(
                &conn,
                &SearchRequest {
                    marketplace,
                    price_min: min,
                    price_max: max,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            let mut got: Vec<String> = names(&r).iter().map(|s| s.to_string()).collect();
            got.sort();
            (got, r.total)
        };

        use crate::sorting::Marketplace::{Cardkingdom, Tcgplayer};

        // TCGplayer: Alpha 1.00, Beta 50.00, Gamma 0.71 (through `usd_etched`).
        assert_eq!(band(Tcgplayer, Some(0.80), Some(2.00)).0, ["Alpha"]);
        assert_eq!(
            band(Tcgplayer, Some(0.50), None).0,
            ["Alpha", "Beta", "Gamma"]
        );
        assert_eq!(band(Tcgplayer, None, Some(0.80)).0, ["Gamma"]);

        // Card Kingdom: Alpha 0.50, Beta 5.00, and no row at all for Gamma.
        assert_eq!(
            band(Cardkingdom, Some(0.80), Some(2.00)).0,
            Vec::<String>::new()
        );
        assert_eq!(band(Cardkingdom, Some(0.40), Some(1.00)).0, ["Alpha"]);
        assert_eq!(
            band(Cardkingdom, None, Some(9_999.0)).0,
            ["Alpha", "Beta"],
            "a printing the feed has never listed is in no band, however wide"
        );

        // The count subquery carries the same predicate, or the caption describes other rows
        // than the wall under it.
        let (rows, total) = band(Tcgplayer, Some(0.80), Some(2.00));
        assert_eq!(total as usize, rows.len());

        // Both ends absent is no filter at all — the request every other caller sends.
        assert_eq!(band(Tcgplayer, None, None).0.len(), 3);

        // An inverted pair narrows to nothing rather than being quietly reordered into a band
        // nobody asked for.
        assert!(band(Tcgplayer, Some(50.0), Some(1.0)).0.is_empty());
    }

    /// The rarity chips against a real query: **OR within, AND without.**
    ///
    /// Two chips mean "either", which is what a multi-select means everywhere else on the row —
    /// and the rarities the row does not offer (`special`, `bonus`) are matched by no chip, which
    /// is the same answer they get from a search that names none.
    #[test]
    fn the_rarity_chips_or_within_and_leave_the_unoffered_rarities_alone() {
        let conn = crate::schema::memory_pair();
        for (id, name, rarity) in [
            ("1", "Common Card", "common"),
            ("2", "Rare Card", "rare"),
            ("3", "Mythic Card", "mythic"),
            ("4", "Special Card", "special"),
        ] {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,rarity,
                                    is_paper,search_text,raw)
                 VALUES (?1,?2,'lea',?1,'en','normal',?3,1,?2,'{}')",
                rusqlite::params![id, name, rarity],
            )
            .unwrap();
        }
        let pick = |rarities: Option<Vec<String>>| {
            let r = run_search(
                &conn,
                &SearchRequest {
                    rarities,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            let mut got: Vec<String> = names(&r).iter().map(|s| s.to_string()).collect();
            got.sort();
            got
        };

        assert_eq!(pick(None).len(), 4, "no chip pressed is no filter");
        assert_eq!(pick(Some(vec![])).len(), 4, "and neither is an empty list");
        assert_eq!(
            pick(Some(vec!["rare".into(), "mythic".into()])),
            ["Mythic Card", "Rare Card"],
            "either, never both"
        );
        assert_eq!(
            pick(Some(vec!["MYTHIC".into()])),
            ["Mythic Card"],
            "the request is lower-cased, because SQLite's `=` on text is not"
        );
        // `special` has no *chip*, but it is a real value and the backend has no vocabulary of
        // its own — a payload naming it filters by it. What has no chip is the control, which is
        // why a `special` printing is untouched by every rarity a reader can actually press.
        assert_eq!(pick(Some(vec!["special".into()])), ["Special Card"]);
        assert_eq!(
            pick(Some(vec!["common".into(), "rare".into(), "mythic".into()])).len(),
            3,
            "and every chip pressed at once still leaves it out"
        );
    }

    /// One price per row, and it is the marketplace's own — no two of these four answers about
    /// the etched-only printing agree, and every one of them is right:
    ///
    /// * TCGplayer falls through its chain to `usd_etched`;
    /// * Cardmarket has no `eur_etched` key to fall through to;
    /// * Card Kingdom's feed has never listed the printing, so there is no row;
    /// * Mana Pool publishes an etched column, so there is.
    ///
    /// **Nothing is filled in from a neighbour.**
    #[test]
    fn a_row_carries_one_price_and_it_is_the_marketplace_it_was_asked_for() {
        let conn = seeded_marketplaces();
        let price = |id: &str, marketplace| {
            run_search(
                &conn,
                &SearchRequest {
                    marketplace,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .iter()
            .find(|c| c.id == id)
            .unwrap()
            .price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(price("a", Tcgplayer), Some(1.0));
        assert_eq!(price("a", Cardmarket), Some(90.0));
        assert_eq!(price("a", Cardkingdom), Some(0.50));
        assert_eq!(price("a", Manapool), Some(2.00));

        assert_eq!(
            price("c", Tcgplayer),
            Some(0.71),
            "the chain falls through to `usd_etched`"
        );
        assert_eq!(
            price("c", Cardmarket),
            None,
            "and there is no euro key to fall through to"
        );
        assert_eq!(
            price("c", Cardkingdom),
            None,
            "in `cards`, absent from the feed — unpriced, never another shop's number"
        );
        assert_eq!(
            price("c", Manapool),
            Some(3.00),
            "this feed has an etched column, which is exactly the contrast"
        );

        // Uncollapsed the range is the row's own price, whatever the marketplace.
        for marketplace in MARKETPLACES {
            let r = run_search(
                &conn,
                &SearchRequest {
                    marketplace,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            for card in &r.items {
                assert_eq!(
                    (card.price_low, card.price_high),
                    (card.price, card.price),
                    "{marketplace:?} {}",
                    card.id
                );
            }
        }
    }

    /// A collapsed row's range is taken over **the printings the chosen marketplace prices**:
    /// `min`/`max` skip NULLs, so a printing that shop does not quote drops out of the span
    /// while staying in another's. The middle Shock here is etched-only, and Card Kingdom's
    /// feed does not list it either.
    #[test]
    fn a_collapsed_range_spans_the_printings_that_marketplace_prices() {
        let conn = crate::schema::memory_pair();
        let lines = [
            priced_line(
                "s1",
                "Shock",
                "o-shock",
                "2009-07-17",
                r#"{"usd":"400.00","eur":"300.00"}"#,
            ),
            priced_line(
                "s2",
                "Shock",
                "o-shock",
                "2010-07-16",
                r#"{"usd":null,"usd_etched":"5.00","eur":null}"#,
            ),
            priced_line(
                "s3",
                "Shock",
                "o-shock",
                "2011-07-15",
                r#"{"usd":"3.00","eur":"4.00"}"#,
            ),
            priced_line(
                "e1",
                "Etched Only",
                "o-etched",
                "2021-01-01",
                r#"{"usd":null,"usd_etched":"0.71","eur":null}"#,
            ),
        ];
        seed_priced(&conn, &lines.iter().map(String::as_str).collect::<Vec<_>>());
        seed_feed(
            &conn,
            &[
                ("cardkingdom", "s1", "nonfoil", 200.00),
                ("cardkingdom", "s3", "nonfoil", 2.00),
                // `s2` and `e1` are not in this feed at all.
            ],
        );

        let range = |name: &str, marketplace| {
            let r = run_search(
                &conn,
                &SearchRequest {
                    marketplace,
                    collapse: Some(true),
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap();
            let c = r.items.iter().find(|c| c.name == name).unwrap();
            (c.printings, c.price_low, c.price_high)
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Tcgplayer};

        assert_eq!(
            range("Shock", Tcgplayer),
            (3, Some(3.0), Some(400.0)),
            "all three printings have a TCGplayer price"
        );
        assert_eq!(
            range("Shock", Cardmarket),
            (3, Some(4.0), Some(300.0)),
            "the etched printing is not in the Cardmarket span at all"
        );
        assert_eq!(
            range("Shock", Cardkingdom),
            (3, Some(2.0), Some(200.0)),
            "and the feed's two rows are the whole of its span — the count is still three"
        );

        assert_eq!(range("Etched Only", Tcgplayer), (1, Some(0.71), Some(0.71)));
        assert_eq!(
            range("Etched Only", Cardmarket),
            (1, None, None),
            "unpriced on Cardmarket, never valued at the nonfoil rate"
        );
        assert_eq!(
            range("Etched Only", Cardkingdom),
            (1, None, None),
            "and unpriced by a feed that never listed it"
        );
    }

    /// The one price decision that cannot be made in TypeScript. Both directions, because a
    /// marketplace that only took effect ascending would be half a feature.
    #[test]
    fn the_price_sort_orders_by_the_marketplace_it_is_asked_for() {
        let conn = seeded_marketplaces();
        let ids = |marketplace, dir: &str| -> Vec<String> {
            run_search(
                &conn,
                &SearchRequest {
                    sort: Some(vec![term("price", dir)]),
                    marketplace,
                    limit: 50,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .into_iter()
            .map(|c| c.id)
            .collect()
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        // $0.71 / $1 / $50 · —€ / €90 / €2 · —/$0.50/$5 · $3 / $2 / $7.
        assert_eq!(ids(Tcgplayer, "asc"), ["c", "a", "b"]);
        assert_eq!(ids(Tcgplayer, "desc"), ["b", "a", "c"]);
        assert_eq!(ids(Cardmarket, "asc"), ["b", "a", "c"]);
        assert_eq!(
            ids(Cardmarket, "desc"),
            ["a", "b", "c"],
            "and the unpriced printing stays last in both directions"
        );
        assert_eq!(ids(Cardkingdom, "asc"), ["a", "b", "c"]);
        assert_eq!(ids(Cardkingdom, "desc"), ["b", "a", "c"]);
        assert_eq!(ids(Manapool, "asc"), ["a", "c", "b"]);
        assert_eq!(
            ids(Manapool, "desc"),
            ["b", "c", "a"],
            "Mana Pool prices the etched printing, so it places rather than trails"
        );
    }

    /// Collapsed, the order is decided in the **group step** over aggregates rather than over
    /// a column — a separate sort table, and therefore a separate chance to have wired one
    /// marketplace and not another.
    ///
    /// Read through a `limit` of one: *which* group survives the limit is what the group
    /// order decides, and it is the thing that matters, since it is what puts the dearest
    /// card on page one.
    ///
    /// **This paragraph used to give a second reason, and that reason was a bug being
    /// written down as a rule** — "the group step takes the `LIMIT` and the outer join then
    /// re-orders the page by name". It did, for every collapsed sort, and the page really
    /// did come back alphabetical; the workaround was reached for here instead of the
    /// defect being seen. Fixed 2026-08-20 ([`SEARCH_SORTS_JOINED`]), so the page's order is
    /// now readable too — `a_collapsed_price_sort_orders_by_the_ends_of_the_range` reads it.
    /// The `limit` of one stays because it is the sharper observable, not because the other
    /// one lies.
    #[test]
    fn a_collapsed_price_sort_orders_by_the_marketplace_it_is_asked_for() {
        let conn = seeded_marketplaces();
        let leader = |marketplace, dir: &str| -> String {
            run_search(
                &conn,
                &SearchRequest {
                    sort: Some(vec![term("price", dir)]),
                    marketplace,
                    collapse: Some(true),
                    limit: 1,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .remove(0)
            .id
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(leader(Tcgplayer, "asc"), "c");
        assert_eq!(leader(Tcgplayer, "desc"), "b");
        assert_eq!(leader(Cardmarket, "asc"), "b");
        assert_eq!(leader(Cardmarket, "desc"), "a");
        assert_eq!(leader(Cardkingdom, "asc"), "a");
        assert_eq!(leader(Cardkingdom, "desc"), "b");
        assert_eq!(leader(Manapool, "asc"), "a");
        assert_eq!(leader(Manapool, "desc"), "b");
    }

    /// Every caller that existed before the marketplace picker sends no `marketplace` at all,
    /// and must keep the prices and the order it has always had. Deserialized from the wire
    /// rather than built in Rust, because it is the *payload* that omits the field.
    #[test]
    fn a_request_with_no_marketplace_quotes_tcgplayer() {
        let conn = seeded_marketplaces();
        let ids = |json: &str| -> Vec<String> {
            let req: SearchRequest = serde_json::from_str(json).unwrap();
            run_search(&conn, &req)
                .unwrap()
                .items
                .into_iter()
                .map(|c| c.id)
                .collect()
        };
        let sort = r#""sort":[{"key":"price","dir":"asc"}],"limit":50"#;

        assert_eq!(ids(&format!("{{{sort}}}")), ["c", "a", "b"], "absent");
        assert_eq!(
            ids(&format!(r#"{{{sort},"marketplace":"ebay"}}"#)),
            ["c", "a", "b"],
            "and an id this build has never heard of"
        );
        assert_eq!(
            ids(&format!(r#"{{{sort},"marketplace":"cardtrader"}}"#)),
            ["c", "a", "b"],
            "and one it lists but cannot price"
        );
        assert_eq!(
            ids(&format!(r#"{{{sort},"marketplace":"manapool"}}"#)),
            ["a", "c", "b"]
        );
    }

    /// `sorting`'s rule over this file's two money lists — the collapsed one included, which
    /// is the half that is easy to forget because it lives in a second table.
    #[test]
    fn every_search_money_sort_names_the_price_hole() {
        for list in [SEARCH_PRICE_SORT, SEARCH_PRICE_SORT_COLLAPSED] {
            for p in list {
                assert!(p.asc.contains(crate::sorting::PRICE_HOLE), "{}", p.asc);
                assert!(p.desc.contains(crate::sorting::PRICE_HOLE), "{}", p.desc);
            }
        }
    }

    /// Cards for the `oracleId` filter's own tests: `(id, oracle_id, name, set_code,
    /// collector_number)`. A fixture of its own rather than [`seeded`]'s three pinned rows,
    /// because those three do not repeat an oracle id and this filter's whole point is two
    /// printings that share one.
    #[rustfmt::skip]
    fn fixture_with_cards(rows: &[(&str, &str, &str, &str, &str)]) -> Connection {
        let conn = crate::schema::memory_pair();
        for (id, oracle_id, name, set_code, collector_number) in rows {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,is_paper,search_text,raw)
                 VALUES (?1,?2,?3,?4,?5,'en','normal',1,?3,'{}')",
                rusqlite::params![id, oracle_id, name, set_code, collector_number],
            ).unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');").unwrap();
        conn
    }

    #[test]
    fn an_oracle_id_filter_answers_only_that_cards_printings() {
        let conn = fixture_with_cards(&[
            ("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "161"),
            ("bolt-4ed", "o-bolt", "Lightning Bolt", "4ed", "209"),
            ("shock-m21", "o-shock", "Shock", "m21", "159"),
        ]);
        let req = SearchRequest {
            oracle_id: Some("o-bolt".into()),
            limit: 50,
            ..Default::default()
        };
        let page = run_search(&conn, &req).unwrap();
        assert_eq!(page.total, 2, "both Bolt printings, and no Shock");
        assert!(page.items.iter().all(|c| c.name == "Lightning Bolt"));
    }

    #[test]
    fn no_oracle_id_filter_is_no_filter() {
        let conn = fixture_with_cards(&[
            ("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "161"),
            ("shock-m21", "o-shock", "Shock", "m21", "159"),
        ]);
        let req = SearchRequest {
            limit: 50,
            ..Default::default()
        };
        assert_eq!(run_search(&conn, &req).unwrap().total, 2);
    }

    /// A cleared control sends `Some("")`, not `None` — `useCardSearch`'s `resetAll` does
    /// exactly this — and it must read as no filter, like every other string filter here
    /// (`format`, `colors`, `setCode`, `rarity`). Binding it literally as `oracle_id = ''`
    /// would fail *closed*: an empty result with nothing on screen to explain it, the
    /// opposite of what a cleared filter means everywhere else in this file.
    #[test]
    fn a_blank_oracle_id_is_no_filter() {
        let conn = fixture_with_cards(&[
            ("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "161"),
            ("shock-m21", "o-shock", "Shock", "m21", "159"),
        ]);
        let req = SearchRequest {
            oracle_id: Some("".into()),
            limit: 50,
            ..Default::default()
        };
        assert_eq!(run_search(&conn, &req).unwrap().total, 2);
    }

    /// The filter has to ride an index on `oracle_id` rather than scan, which is the whole
    /// reason this filter costs nothing to add — `idx_cards_oracle` has carried one since
    /// schema v1.
    ///
    /// **Planned against the SQL this search really builds.** The predicate comes from
    /// [`filters::push_card_filters`] over a real [`SearchRequest`] and the statement from
    /// [`count_sql_for`] — the two pieces `run_search` itself puts together — because the
    /// version of this test that shipped first planned a *literal string* that appeared
    /// nowhere else in the crate, and so could not go red for any edit to this repo. It was
    /// asserting a fact about SQLite. Changing `filters.rs` to
    /// `lower({alias}.oracle_id) = ?` — a plausible "match the id case-insensitively" — costs
    /// the index and full-scans ~116 k rows on every "View all printings" press; that mutation
    /// is what this test now catches.
    ///
    /// **Not pinned to `idx_cards_oracle` by name.** `id` is also the fourth column of
    /// `idx_cards_collapse` ([`crate::schema::CARDS_INDEXES`]), so the planner may prefer that
    /// one instead — it is *covering* (the row lookup `idx_cards_oracle` alone would still owe
    /// is already inside the index), which is the cheaper plan, not a worse one. What this
    /// pins is the fact that would break either way: `cards` is reached by a `SEARCH` keyed on
    /// `oracle_id=?`, never by a `SCAN`.
    #[test]
    fn the_oracle_id_filter_uses_its_index() {
        let conn = fixture_with_cards(&[("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "161")]);
        let req = SearchRequest {
            oracle_id: Some("o-bolt".into()),
            limit: 50,
            ..Default::default()
        };
        let mut p = filters::Predicates::default();
        filters::push_card_filters(&mut p, &req.card_filters(), "c", None);
        // `cards c`, uncollapsed — what `run_search` picks when no text is typed, which is
        // exactly this filter's case: "View all printings" sends an oracle id and nothing else.
        let sql = count_sql_for("cards c", &p.where_sql(), false);

        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            // Bound even though nothing runs: the planner is asked about *this* statement, and
            // rusqlite refuses a parameter count that does not match.
            .query_map(
                rusqlite::params_from_iter(p.params.iter().map(|b| b.as_ref())),
                |r| r.get::<_, String>(3),
            )
            .unwrap()
            .map(Result::unwrap)
            .collect();

        // `oracle_id=?` unparenthesised: the paper filter rides the same covering index, so
        // the planner prints `(oracle_id=? AND is_paper=?)` — the leading key is the claim.
        assert!(
            plan.iter()
                .any(|step| step.starts_with("SEARCH c") && step.contains("oracle_id=?")),
            "the filter must ride an index keyed on oracle_id: {plan:#?}\n{sql}"
        );
        assert!(
            !plan.iter().any(|step| step.starts_with("SCAN c")),
            "and `cards` must never be scanned for it: {plan:#?}\n{sql}"
        );
    }

    /// Four printings and both tag closures over them. `illus-none` is deliberately absent
    /// from `art_tag_illustrations` and `bolt-nil` carries no `illustration_id` at all — the
    /// two ways a row can fail an art tag, one of which is 4 977 of the live 116 712
    /// printings (measured 2026-08-20 against the dev database).
    #[rustfmt::skip]
    fn fixture_with_tags() -> Connection {
        let conn = crate::schema::memory_pair();
        let rows = [
            ("bolt-strong", "o-bolt",  "Lightning Bolt",  Some("illus-strong")),
            ("bolt-weak",   "o-bolt",  "Lightning Bolt",  Some("illus-weak")),
            ("shock",       "o-shock", "Shock",           Some("illus-none")),
            ("bolt-nil",    "o-bolt",  "Lightning Bolt",  None),
        ];
        for (id, oracle_id, name, illustration) in rows {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,is_paper,illustration_id,search_text,raw)
                 VALUES (?1,?2,?3,'tst',?1,'en','normal',1,?4,?3,'{}')",
                rusqlite::params![id, oracle_id, name, illustration],
            ).unwrap();
        }
        conn.execute_batch(
            "INSERT INTO art_tag_illustrations (illustration_id,slug,weight) VALUES
                 ('illus-strong','dog','strong'), ('illus-weak','dog','weak');
             INSERT INTO oracle_tag_cards (oracle_id,slug) VALUES ('o-shock','removal');
             INSERT INTO cards_fts(cards_fts) VALUES('rebuild');",
        ).unwrap();
        conn
    }

    /// The **wire shape**, which no test in `filters` can see: a field spelled differently
    /// here from `src/lib/ipc.ts` is a filter that silently does nothing, and this is the
    /// whole reason the Tags page can reuse `search_cards` instead of growing a second search
    /// stack.
    ///
    /// Both lists are `#[serde(default)]`, so `{"artTags":{"include":["dog"]}}` — a chip row
    /// with nothing excluded, which is the common payload — deserializes rather than failing
    /// the request. The predicates themselves are pinned in `filters::tests`.
    #[test]
    fn tag_terms_arrive_over_the_wire_and_narrow_the_page() {
        let conn = fixture_with_tags();
        let ids = |payload: &str| {
            let req: SearchRequest = serde_json::from_str(payload).unwrap();
            let page = run_search(&conn, &req).unwrap();
            let mut ids: Vec<String> = page.items.into_iter().map(|c| c.id).collect();
            ids.sort();
            ids
        };

        assert_eq!(ids(r#"{"limit":50}"#).len(), 4, "no tag terms is no filter");
        assert_eq!(
            ids(r#"{"artTags":{"include":["dog"]},"limit":50}"#),
            ["bolt-strong", "bolt-weak"],
            "`shock` holds no dog and `bolt-nil` has no illustration to hold one"
        );
        assert_eq!(
            ids(r#"{"artTags":{"include":["dog"]},"artWeightFloor":"strong","limit":50}"#),
            ["bolt-strong"]
        );
        assert_eq!(
            ids(r#"{"artTags":{"exclude":["dog"]},"artWeightFloor":"strong","limit":50}"#),
            ["bolt-nil", "shock"],
            "an exclude ignores the floor: a weak dog is still a dog"
        );
        assert_eq!(
            ids(r#"{"oracleTags":{"exclude":["removal"]},"limit":50}"#),
            ["bolt-nil", "bolt-strong", "bolt-weak"]
        );
        // A mixed request ANDs the two taxonomies, and the floor reaches only the art half —
        // `oracle_tag_cards` has no `weight` column, so a floor copied onto that arm would be
        // a `no such column` error rather than a wrong answer.
        assert_eq!(
            ids(
                r#"{"artTags":{"include":["dog"]},"oracleTags":{"exclude":["removal"]},"artWeightFloor":"strong","limit":50}"#
            ),
            ["bolt-strong"]
        );
    }

    /// An include reads its closure **once, by slug** and then drives `cards` through an index
    /// on the subject id — it never scans either closure, and it never scans `cards`.
    ///
    /// This is the assertion no test about ids can make, and it is the *whole* of why the
    /// includes are `IN (SELECT …)` rather than a correlated `EXISTS`. Both answer a four-row
    /// fixture identically. In the field the correlated form scans the whole `cards` table and
    /// probes the closure once per row: on `dog` against the real 952 729-row art taxonomy it
    /// measured **315 ms unfloored and 882–1 147 ms floored**, against **8 ms either way** for
    /// this form, because the floor's extra column costs nothing once the slug is read a single
    /// time. Measured 2026-08-20 through `node:sqlite` against the dev database — SQLite's own
    /// numbers, no debug-build multiplier — and the gain narrows on a wide motif, which is why
    /// `filters.rs` carries the whole table rather than a headline. It also carries the reason
    /// the `(slug, weight)` index that shape seemed to want is a trap.
    ///
    /// So the plan this pins is three steps and each is load-bearing:
    ///
    /// - `LIST SUBQUERY` — the closure is materialised once, not per card;
    /// - `SEARCH ati … (slug=?)` — and it is read by an index while doing so;
    /// - `SEARCH c USING INDEX idx_cards_illustration` — and `cards` is *driven* by the answer
    ///   rather than scanned past it. `idx_cards_illustration` is v20's and exists for this.
    ///
    /// A regression to the correlated shape shows up here as `SCAN c`, and a lost index as
    /// `SCAN ati`/`SCAN otc` — the two things asserted against below.
    #[test]
    fn a_tag_filter_reads_its_closure_once_and_drives_cards_by_the_answer() {
        let conn = fixture_with_tags();
        let req = SearchRequest {
            art_tags: Some(filters::TagTerms {
                include: vec!["dog".into()],
                exclude: Vec::new(),
            }),
            oracle_tags: Some(filters::TagTerms {
                include: vec!["removal".into()],
                exclude: Vec::new(),
            }),
            limit: 50,
            ..Default::default()
        };
        let mut p = filters::Predicates::default();
        filters::push_card_filters(&mut p, &req.card_filters(), "c", None);
        let sql = count_sql_for("cards c", &p.where_sql(), false);

        let plan: Vec<String> = conn
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(
                rusqlite::params_from_iter(p.params.iter().map(|b| b.as_ref())),
                |r| r.get::<_, String>(3),
            )
            .unwrap()
            .map(Result::unwrap)
            .collect();

        for alias in ["ati", "otc"] {
            let probe = plan
                .iter()
                .find(|step| step.starts_with(&format!("SEARCH {alias} ")))
                .unwrap_or_else(|| panic!("no indexed read of {alias}: {plan:#?}\n{sql}"));
            assert!(probe.contains("slug=?"), "{probe}");
        }
        assert_eq!(
            plan.iter()
                .filter(|step| step.starts_with("LIST SUBQUERY"))
                .count(),
            2,
            "each closure must be read once into a list, not once per card: {plan:#?}\n{sql}"
        );
        assert!(
            !plan
                .iter()
                .any(|step| step.starts_with("SCAN ati") || step.starts_with("SCAN otc")),
            "neither closure may be scanned: {plan:#?}\n{sql}"
        );
        // The other half, and the one a correlated `EXISTS` fails: `cards` is driven by the
        // list rather than walked past it. A fixture this small can plan either way, so this
        // asserts the *index* is available and used rather than the absence of a scan alone.
        assert!(
            plan.iter().any(|step| step.starts_with("SEARCH c ")),
            "cards must be driven by a closure's answer, never scanned: {plan:#?}\n{sql}"
        );
    }
}
