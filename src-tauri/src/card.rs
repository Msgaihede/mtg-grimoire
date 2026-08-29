//! One printing in full, and every printing of the same oracle card.
//!
//! Shaped exactly like [`crate::search`]: pure functions over a `Connection` so they are
//! testable without a Tauri app, wrapped in `async` commands that run on the blocking
//! pool against the **read-only** connection.
//!
//! What is deliberately *not* computed here: grouping printings by `illustration_id`. That is
//! domain logic, and CLAUDE.md puts domain logic in TypeScript where the tests are fast — Rust
//! hands over the field and the frontend decides what it means.
//!
//! **Prices are the exception, and they stopped being one the day a marketplace could be
//! something other than a key of `cards.prices`.** These two commands used to answer that blob
//! verbatim and let the pane look a finish up in it; that works for TCGplayer and Cardmarket and
//! is simply blind to Card Kingdom and Mana Pool, whose prices live in `marketplace_prices` and
//! which the webview cannot read. So both commands take a `marketplace` like every list query in
//! the crate, and both answer [`FinishPrices`] — one figure per finish, from the one place the
//! rest of the crate gets a price, [`crate::sorting::price_expr`].
//!
//! Nothing here reads `raw`: `artist` has had a column of its own since schema v3, which
//! was the last thing this module took out of that blob.
//!
//! **One setting lives here too** — [`K_PRINTING_GROUP_BY`], how the pane groups the list
//! [`card_printings`] answers. It is in this module rather than a module of its own because it
//! is a fact about *this list*: nothing else in the crate reads it, and the command that
//! answers the rows it groups is three functions up. It is shaped exactly like
//! [`crate::marketplace`]'s — one `app_meta` row, a read that can never fail, a write that
//! validates — and for the same two reasons, which are written out on [`stored_group_by`] and
//! [`store_group_by`].

use crate::sorting::Marketplace;
use crate::sync::{lock_db_read, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;

/// Printings returned for one oracle card. A bound on a pane, not a pager.
///
/// Measured against the live database (116 k rows), counting **paper only** as
/// [`PRINTINGS_WHERE`] does: exactly five oracle cards exceed this, and they are the five
/// basic lands — Forest at 862, then Mountain 840, Swamp 832, Island 827, Plains 818.
/// Seven cards in the whole library have more than 100 paper printings. So the cap
/// truncates a list nobody scrolls and never touches a real card.
///
/// Two things keep the truncation honest: the `ORDER BY` runs *before* the `LIMIT`, so
/// what is dropped is the oldest printings rather than an arbitrary slice, and
/// [`PrintingsResponse::total`] reports the full count so a capped list can say what it is
/// a truncation of.
const MAX_PRINTINGS: usize = 400;

/// The ceiling an explicitly asked-for page is clamped to — the printings modal's page, and
/// the fence around it.
///
/// **Chosen against the measurement [`MAX_PRINTINGS`] already carries** rather than for the
/// feel of the number: counting paper only, exactly five oracle cards exceed 400, and they are
/// the five basic lands — Forest at 862, then Mountain 840, Swamp 832, Island 827, Plains 818.
/// So 1000 clears the largest list in the corpus with room to spare, and nothing in the library
/// reaches it.
///
/// The modal needs the wider page for a reason the card pane does not have: it **filters**, and
/// a filter over a truncated list lies. Narrowing to a set that fell outside the newest 400
/// would draw an empty wall that reads as an answer rather than as a truncation — where the
/// pane, which offers no filter, can say "400 of 862" in its caption and be honest.
const MAX_PRINTINGS_HARD: usize = 1000;

/// The page size for one request, from what the caller asked for.
///
/// Absent is [`MAX_PRINTINGS`] — the card pane's page, unchanged, so that command's query and
/// its cache key are byte-identical to what they were before the modal existed. Anything else
/// is clamped into `1..=MAX_PRINTINGS_HARD`.
///
/// **A zero or a negative is a caller bug rather than a request for an empty list, and is
/// answered with the default.** An empty page here would be indistinguishable from "this card
/// has no printings", which is the one thing this list must never say by accident. The negative
/// is the sharper half of the same rule: SQLite reads a negative `LIMIT` as *no limit at all*
/// — the trap [`crate::deck_audit`]'s `clamp(1, 500)` exists for — so passing one through
/// would hand out the whole table instead of an empty page.
fn page_size(limit: Option<i64>) -> i64 {
    match limit {
        Some(n) if n > 0 => n.min(MAX_PRINTINGS_HARD as i64),
        _ => MAX_PRINTINGS as i64,
    }
}

/// The rows a printings list is about, stated once because the page and the count must
/// agree — a `total` taken over a wider `WHERE` than the page is exactly the lie the
/// `total` was added to prevent.
///
/// **Paper only.** Measured against the live database: 6 533 oracle cards have both paper
/// and digital printings (Lightning Bolt: 62 paper, 9 digital), and the digital ones are
/// MTGO and Arena rows that cannot be owned in paper and carry no paper price. Left in,
/// this pane would offer a reader an Arena printing to record as a copy they own and
/// render its price as `—`. `search` already defaults to paper for the same reason, and
/// the spec tracks a paper collection.
const PRINTINGS_WHERE: &str = "oracle_id = ?1 AND is_paper = 1";

/// What one printing costs per **finish**, at the marketplace the request named.
///
/// Three nullable numbers rather than a blob, because a blob only ever had two of the four
/// marketplaces in it. `null` is *unpriced at that marketplace* and is drawn as an em dash —
/// never a reason to reach for another marketplace's figure, and the holes are not the same at
/// any two of them: Scryfall has no `eur_etched` key at all, so etched is NULL on Cardmarket for
/// every card in the game, while Mana Pool publishes 1 198 real etched prices and Card Kingdom
/// 1 162, and either feed can simply never have listed a printing this database has.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FinishPrices {
    pub nonfoil: Option<f64>,
    pub foil: Option<f64>,
    pub etched: Option<f64>,
}

/// The three price expressions as a `SELECT` list, for a query whose `cards` is aliased `c`.
///
/// [`crate::sorting::finish_literals`] is the finish list and its order, which is
/// [`FinishPrices`]' own field order — kept beside the builder that consumes it rather than
/// here, so that this pane and the deck's chain across the same three cannot come to disagree
/// about what a finish is called.
///
/// Built by [`crate::sorting::price_expr`] and never by hand, which is the crate rule and is
/// what keeps this pane's etched hole on Cardmarket, and its lookups into `marketplace_prices`,
/// identical to the ones the collection and the decks already draw.
fn finish_price_columns(market: Marketplace) -> String {
    crate::sorting::finish_literals()
        .map(|finish| crate::sorting::price_expr(market, &finish))
        .join(", ")
}

/// The three columns [`finish_price_columns`] appended, read back from index `at`.
fn read_finish_prices(row: &rusqlite::Row, at: usize) -> rusqlite::Result<FinishPrices> {
    Ok(FinishPrices {
        nonfoil: row.get(at)?,
        foil: row.get(at + 1)?,
        etched: row.get(at + 2)?,
    })
}

/// One physical side of a card, for the flip control and the credit line.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFace {
    pub name: String,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub mana_cost: Option<String>,
    /// Per face: a double-faced card's two sides are not always the same illustrator.
    pub artist: Option<String>,
}

/// Everything the detail pane renders about the printing in front of the reader.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDetail {
    pub id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub layout: String,
    pub lang: String,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub illustration_id: Option<String>,
    /// Required by Scryfall's image policy wherever art is shown.
    pub artist: Option<String>,
    pub released_at: Option<String>,
    /// JSON, verbatim. 23 keys today and the set grows — the day this becomes columns is
    /// the day a new format needs a migration.
    pub legalities: Option<String>,
    /// Per finish, at the marketplace the request named. **Not** `cards.prices`: that blob is
    /// two of the four marketplaces, and the pane has to be able to quote the other two.
    pub finish_prices: FinishPrices,
    pub finishes: Option<String>,
    /// JSON, verbatim: Scryfall's `promo_types`, which is where the **kind** of foil lives.
    ///
    /// `finishes` says how shiny a copy is and has only three words for it; this says whether
    /// the shiny one is a Surge Foil, a Halo Foil or a Serialized card. Handed over unread —
    /// naming these is a judgement and CLAUDE.md puts those in TypeScript, so `src/lib/
    /// treatment.ts` owns the table and this column is copied the way `legalities` is.
    ///
    /// Open-ended by construction: 113 distinct members are live and Scryfall adds more without
    /// asking. 32 174 of 116 712 rows carry one, averaging 22.7 bytes.
    pub promo_types: Option<String>,
    pub image_status: Option<String>,
    /// Empty for a single-faced card.
    pub faces: Vec<CardFace>,
}

/// One row of the printings list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Printing {
    pub id: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub released_at: Option<String>,
    pub rarity: Option<String>,
    /// What "alternate art" is actually keyed on: two printings differ in art iff this
    /// differs. `variation` is true on 0.09% of cards and is no help at all.
    pub illustration_id: Option<String>,
    pub artist: Option<String>,
    pub lang: String,
    pub finishes: Option<String>,
    /// Per finish, at the marketplace the request named — the same figures [`CardDetail`]
    /// carries, for the printing this row is. See [`FinishPrices`].
    pub finish_prices: FinishPrices,
    pub promo: bool,
    /// JSON, verbatim — the **kind** of foil this printing's shiny copy is. See the identical
    /// field on [`CardDetail`]; read on the other side with `src/lib/treatment.ts`.
    ///
    /// Distinct from [`Self::promo`] despite the name they share: that is a boolean about how
    /// the card was *distributed*, this is a list of what the cardboard *is*. 5 428 of 107 355
    /// paper printings carry a member this app names.
    pub promo_types: Option<String>,
    pub full_art: bool,
    pub frame_effects: Option<String>,
    pub border_color: Option<String>,
    pub layout: String,
}

/// A printings list and the size of the list it was taken from.
///
/// `total` exists because the page truncates silently otherwise: Forest has 862
/// paper printings, and a pane that returns 400 of them with no way to say so tells the
/// reader those 400 are all there are. With this it can caption "400 of 862". Mirrors
/// [`crate::search::SearchResponse`], minus its cap flag — see [`list_printings`] for why
/// this count needs no ceiling.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintingsResponse {
    /// Newest first, at most one page of them — [`MAX_PRINTINGS`] unless the caller named a
    /// wider one, and never more than [`MAX_PRINTINGS_HARD`]. See [`page_size`].
    pub items: Vec<Printing>,
    /// Every paper printing of this oracle card, counted in full. `items.len() < total`
    /// means the list was truncated.
    pub total: i64,
}

/// One printing by id, or `None` if there is no such row.
///
/// Deliberately **not** filtered to paper, unlike [`list_printings`]: an id asked for by
/// name has to resolve. A digital printing can be reached from a search with `paperOnly`
/// off, and answering `None` for a row that plainly exists would look like a broken
/// database rather than a policy.
pub fn get_card(
    conn: &Connection,
    id: &str,
    market: Marketplace,
) -> Result<Option<CardDetail>, String> {
    // `cards` is aliased `c` because `price_expr` names that alias: every priced query in the
    // crate joins the printing that way, and hard-coding it there is what keeps the join key
    // and the price from being spelled apart.
    let sql = format!(
        "SELECT c.id, c.oracle_id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                c.layout, c.lang, c.mana_cost, c.cmc, c.type_line, c.oracle_text,
                c.illustration_id, c.artist, c.released_at, c.legalities, c.finishes,
                c.image_status, c.faces, c.promo_types, {prices}
         FROM cards c WHERE c.id = ?1",
        prices = finish_price_columns(market)
    );
    conn.query_row(&sql, params![id], |r| {
        let faces: Option<String> = r.get(19)?;
        Ok(CardDetail {
            id: r.get(0)?,
            oracle_id: r.get(1)?,
            name: r.get(2)?,
            set_code: r.get(3)?,
            set_name: r.get(4)?,
            collector_number: r.get(5)?,
            rarity: r.get(6)?,
            layout: r.get(7)?,
            lang: r.get(8)?,
            mana_cost: r.get(9)?,
            cmc: r.get(10)?,
            type_line: r.get(11)?,
            oracle_text: r.get(12)?,
            illustration_id: r.get(13)?,
            artist: r.get(14)?,
            released_at: r.get(15)?,
            legalities: r.get(16)?,
            finish_prices: read_finish_prices(r, 21)?,
            finishes: r.get(17)?,
            promo_types: r.get(20)?,
            image_status: r.get(18)?,
            faces: parse_faces(faces.as_deref()),
        })
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// `card_faces` as the pane needs it. A blob that will not parse yields no faces rather
/// than an error: a card with unreadable face data is still a card worth showing.
fn parse_faces(json: Option<&str>) -> Vec<CardFace> {
    let Some(value) = json.and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok()) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|faces| {
            faces
                .iter()
                .map(|f| CardFace {
                    // Defaulted, never dropped. The flip control addresses faces by
                    // index, so a face skipped here would shift every face after it —
                    // the back of a three-face card rendering as its middle, silently
                    // and only for the malformed rows nobody is looking at. A nameless
                    // face is a broken face, not a missing one.
                    name: str_field(f, "name").unwrap_or_default(),
                    type_line: str_field(f, "type_line"),
                    oracle_text: str_field(f, "oracle_text"),
                    // Present but empty on a transform's back, which is not the same
                    // as absent and should not render as a cost of `{}`.
                    mana_cost: str_field(f, "mana_cost").filter(|s| !s.is_empty()),
                    artist: str_field(f, "artist"),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// Every **paper** printing of one oracle card, newest first, plus how many there are.
///
/// A blank `oracle_id` returns nothing rather than matching. The column is NULLABLE, and a
/// query that let `''` through would be one `IS NULL` away from returning every card that
/// lacked one as a "printing" of each other.
///
/// **Not because reversible cards have none** — that belief travelled through this codebase
/// and it is wrong. Scryfall omits the *top-level* `oracle_id` on `reversible_card`, and
/// [`crate::card_row`] falls back to `card_faces[0].oracle_id` exactly as it does for `cmc`,
/// `type_line` and `mana_cost`, so the column is filled. Measured on the live database:
/// **0 of 116 590 rows (2026-08-05)** have a NULL `oracle_id`, all 81 reversible printings
/// included. The nullability is a contract with a JSON shape, not a population; this guard
/// is a fence around a case that does not currently occur.
///
/// Two statements over one `WHERE`: the page, and an uncapped count so a truncated list
/// can say what it is a truncation *of*. The count is cheap in a way
/// [`crate::search::run_search`]'s is not — `idx_cards_oracle` narrows it to one card's
/// printings (946 rows at the very worst) instead of scanning toward 116 k — so there is
/// nothing here to cap and no `total_is_capped` to report.
///
/// **The `LIMIT` is the caller's, within the ceiling** — [`page_size`] turns `limit` into it,
/// and `None` is [`MAX_PRINTINGS`], so a caller that says nothing gets exactly the page this
/// function has always answered. `total` is taken over the same `WHERE` with no limit at all
/// either way, which is what lets a caption tell a truncation from a filter.
pub fn list_printings(
    conn: &Connection,
    oracle_id: &str,
    market: Marketplace,
    limit: Option<i64>,
) -> Result<PrintingsResponse, String> {
    if oracle_id.trim().is_empty() {
        return Ok(PrintingsResponse::default());
    }
    let sql = format!(
        "SELECT c.id, c.set_code, c.set_name, c.collector_number, c.released_at, c.rarity,
                c.illustration_id, c.artist, c.lang, c.finishes, c.promo, c.full_art,
                c.frame_effects, c.border_color, c.layout, c.promo_types, {prices}
         FROM cards c WHERE {PRINTINGS_WHERE}
         ORDER BY released_at DESC, set_code ASC, collector_number ASC, id ASC
         LIMIT ?2",
        prices = finish_price_columns(market)
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![oracle_id, page_size(limit)], |r| {
            Ok(Printing {
                id: r.get(0)?,
                set_code: r.get(1)?,
                set_name: r.get(2)?,
                collector_number: r.get(3)?,
                released_at: r.get(4)?,
                rarity: r.get(5)?,
                illustration_id: r.get(6)?,
                artist: r.get(7)?,
                lang: r.get(8)?,
                finishes: r.get(9)?,
                finish_prices: read_finish_prices(r, 16)?,
                promo: r.get(10)?,
                promo_types: r.get(15)?,
                full_art: r.get(11)?,
                frame_effects: r.get(12)?,
                border_color: r.get(13)?,
                layout: r.get(14)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    let total = conn
        .query_row(
            &format!("SELECT count(*) FROM cards WHERE {PRINTINGS_WHERE}"),
            params![oracle_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(PrintingsResponse { items, total })
}

/// One printing in full, priced at `marketplace`. Read-only connection, blocking pool — see
/// [`crate::search::search_cards`].
///
/// The marketplace is resolved by [`Marketplace::from_opt`], which is the crate's one rule and
/// never fails: absent, null, a typo, a future id and `cardtrader` all mean TCGplayer, because a
/// card the reader asked to see must not refuse to open over a setting.
#[tauri::command]
pub async fn card_detail(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
    marketplace: Option<String>,
) -> Result<Option<CardDetail>, String> {
    let state = state.inner().clone();
    let market = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || get_card(&lock_db_read(&state), &id, market))
        .await
        .map_err(|e| format!("card could not be read: {e}"))?
}

/// Every paper printing of one oracle card, priced at `marketplace`. Read-only connection,
/// blocking pool.
///
/// **`limit` is the page size, and absent is the card pane's [`MAX_PRINTINGS`].** The pane
/// reads a list it cannot narrow and captions what it dropped, so 400 has always been enough
/// for it; the printings modal asks for [`MAX_PRINTINGS_HARD`] because it filters client-side,
/// and a filter over a truncated list draws an empty wall that reads as an answer. Whatever a
/// caller sends is clamped by [`page_size`], so the number is a request rather than a promise.
#[tauri::command]
pub async fn card_printings(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
    marketplace: Option<String>,
    limit: Option<i64>,
) -> Result<PrintingsResponse, String> {
    let state = state.inner().clone();
    let market = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        list_printings(&lock_db_read(&state), &oracle_id, market, limit)
    })
    .await
    .map_err(|e| format!("printings could not be read: {e}"))?
}

/// The Scryfall CDN URL for one printing at one size, or `None`.
///
/// **A command rather than a field on five list DTOs.** These URLs are ~100 bytes each and
/// are wanted on a deliberate user act — one menu press — so putting them on `CardSummary`,
/// `DeckCard`, `CollectionRow`, `WishRow` and `Printing` would pay for them on every row of
/// every list to serve a press that mostly never happens.
///
/// **Face 0's image, with the top-level blob as the fallback — spec §5's rule, exactly as
/// [`crate::images::resolve`] applies it.** A menu points at a *printing*, and a printing's
/// picture is its front face. This is not a refinement: **3.7% of printings carry no
/// top-level `image_uris` at all** — `transform`, `modal_dfc`, `double_faced_token`,
/// `art_series` and `reversible_card` put them on the faces instead (`images.rs`'s header) —
/// so a lookup that reads only the column answers `None` for ~4 300 live printings.
///
/// Three ways to `None`, and all three are answers rather than faults: the card is unknown,
/// it carries no images anywhere (neither column holds the variant), or the variant is JSON
/// `null` — which `card_row::webp_uris` writes for a variant the source lacked, so a present
/// key is not a present URL.
///
/// **A face-only printing was a fourth way, and it *was* a fault** — the version of this list
/// that ended at "all three are answers" is what kept it invisible for a release, because it
/// argued the absence was always benign and there was nothing left to check. Right-clicking
/// any Innistrad transform card copied nothing, silently, since `copyCardImage` treats a
/// missing URI as "nothing to do". If a fifth `None` ever appears here, say which kind it is.
///
/// The variant is checked against [`crate::schema::IMAGE_VARIANTS`] and **never
/// interpolated**: it reaches SQL as a `json_extract` path, so an unchecked one is an
/// injection point. There are four; `png` is not among them, because the ingest keeps four
/// of Scryfall's eleven image keys and drops the legacy JPG/PNG family its own docs mark as
/// replaced.
///
/// Read-only connection, blocking pool — as [`card_detail`] is, and for the same reason.
#[tauri::command]
pub async fn card_image_uri(
    state: tauri::State<'_, Arc<AppState>>,
    card_id: String,
    variant: String,
) -> Result<Option<String>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        card_image_uri_inner(&lock_db_read(&state), &card_id, &variant)
    })
    .await
    .map_err(|e| format!("the image URL could not be read: {e}"))?
}

fn card_image_uri_inner(
    conn: &Connection,
    card_id: &str,
    variant: &str,
) -> Result<Option<String>, String> {
    if !crate::schema::IMAGE_VARIANTS.contains(&variant) {
        return Err(format!("unknown image variant: {variant}"));
    }
    // The face index is the literal `0`: this command takes no face, and face 0 is the whole
    // of what a printing's picture means here.
    let row = crate::image_uri::row(conn, card_id, variant, 0)?;
    // Face first, top-level second — literally `image_uri::for_face` with the face pinned to
    // 0, which is the same call `images::resolve` makes, so the two cannot answer differently
    // about the front of a card. A `meld` printing carries both, and its top-level image is
    // its front and nothing else.
    //
    // **Deliberately without `resolve`'s host fence.** That function answers `NoImage` for a
    // URI off `cards.scryfall.io` or one with no `?<epoch>` cache-buster, because it is about
    // to cache the bytes; this command hands a URL back to a caller who is not caching, and
    // refusing one here would be a policy `resolve` owns and this does not. The query is
    // shared; the policy is not.
    Ok(row.and_then(|(top, face)| crate::image_uri::for_face(top, face, 0)))
}

// ---------------------------------------------------------------------------------------
// Meld — the one relationship `cards` has no column for
// ---------------------------------------------------------------------------------------

/// The two `all_parts` components a meld relationship is made of, and the whole of what
/// [`meld_parts`] answers.
///
/// Scryfall's `component` vocabulary is wider than this — a meld card also carries
/// `combo_piece` entries (the Eldritch Moon checklist card is one, on every `emn` meld row)
/// and other cards carry `token`. Those are real relationships and simply not this one: the
/// pane offers to swap the *picture* to a card that melds with the open one, and a checklist
/// is not a card anybody melds with.
const MELD_COMPONENTS: [&str; 2] = ["meld_part", "meld_result"];

/// One card a meld printing is related to — the other half of the pair, or the thing the
/// pair becomes.
///
/// **`artist` is on this struct, and it is not a convenience.** The pane swaps the *picture*
/// to the melded card while keeping the open card's facts on screen, and Scryfall's image
/// policy requires the credit to name the illustrator whose art is being shown. Without this
/// field the pane would print the open card's artist under a different card's picture — the
/// wrong name under the right image, which is the one failure that policy is about.
/// `CardDetailPane.tsx` already carries that rule in prose for double-faced cards, where the
/// same swap happens between two faces of one row; this field is what lets it hold across two
/// *rows*, which is what a meld is.
///
/// It costs one indexed lookup per relation and there are at most two or three of them —
/// [`meld_parts`] measures that bound rather than assuming it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeldRelation {
    pub id: String,
    pub name: String,
    /// Scryfall's `component`, verbatim: `meld_part` or `meld_result`.
    ///
    /// Verbatim because which of the two a relation is, is a *fact*, and what the pane calls
    /// it — "Melds with", "Melds into" — is a conclusion, which this module's own header puts
    /// in TypeScript.
    pub component: String,
    /// The illustrator of the printing at `id`, from `cards` — `None` when that row has none,
    /// and `None` when the corpus has no such row at all.
    pub artist: Option<String>,
}

/// Every meld relationship of one printing, in Scryfall's own order.
///
/// **Gated on `layout = 'meld'` before the blob is touched, and that gate is the whole reason
/// this is cheap.** `raw` is a gzip BLOB from schema v3 on, so answering this question at all
/// means inflating and parsing ~2 KB in Rust — [`crate::card_row::raw_json`] over
/// `CAST(raw AS BLOB)`, because `json_extract` over a gzip member is a hard `malformed JSON`
/// error rather than a NULL (CLAUDE.md). Measured against the live corpus: **72 of 116 590
/// rows** are `meld` — 48 parts and 24 results — so the gate turns a decompression on every
/// card the reader opens into one on six ten-thousandths of them. This is
/// [`crate::deck::may_have_a_power_toughness_box`]'s argument with a much sharper number
/// behind it: there, the type gate rules out the majority; here, the layout gate rules out
/// all but 0.06%.
///
/// **Every way this can fail is `Ok(vec![])`, never an `Err`.** An unknown id, a `raw` that
/// will not inflate or will not parse, a missing `all_parts`, an `all_parts` that is not an
/// array — a card the reader asked to see must not fail to open over a control that is not
/// there for most cards anyway. That is [`card_detail`]'s rule about the marketplace applied
/// to a second setting.
///
/// Three filters, and the third is the one worth reading twice:
///
/// - `component` must be one of [`MELD_COMPONENTS`].
/// - An entry with no `id` or no `name` is dropped: the pane needs both to draw anything.
/// - **Self is excluded by `name`, never by `id`.** `all_parts` includes the card itself, and
///   the obvious exclusion — the entry whose `id` equals the row's — is wrong on real data:
///   `Brisela, Voice of Nightmares` printing `0cd83c0e-…` names a `meld_result` with id
///   `bbcd6747-…`, which is *a different printing of Brisela*. An id comparison keeps it, and
///   the pane then offers the reader "melds into Brisela" while they are looking at Brisela.
///   Names are what a meld is defined on — the melded card is one card however many times it
///   has been printed — so the name is the comparison that matches the fact.
///
/// Order is Scryfall's array order, untouched. Which relation to show first is a display
/// decision, and this module's header says where those live.
pub fn meld_parts(conn: &Connection, id: &str) -> Result<Vec<MeldRelation>, String> {
    // `name` rides along with the gate rather than costing a second query: it is what self is
    // excluded by, and this row is already being read.
    let row: Option<(String, Option<String>, Option<Vec<u8>>)> = conn
        .query_row(
            "SELECT layout, name, CAST(raw AS BLOB) FROM cards WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    // An unknown id is an answer: no relationships, because there is no card.
    let Some((layout, name, stored)) = row else {
        return Ok(Vec::new());
    };
    if layout != "meld" {
        return Ok(Vec::new());
    }
    let Some(json) = stored.as_deref().and_then(crate::card_row::raw_json) else {
        return Ok(Vec::new());
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&json) else {
        return Ok(Vec::new());
    };
    let Some(parts) = value.get("all_parts").and_then(serde_json::Value::as_array) else {
        return Ok(Vec::new());
    };

    let own_name = name.unwrap_or_default();
    let mut out: Vec<MeldRelation> = Vec::new();
    for part in parts {
        let (Some(part_id), Some(part_name), Some(component)) = (
            str_field(part, "id"),
            str_field(part, "name"),
            str_field(part, "component"),
        ) else {
            continue;
        };
        if !MELD_COMPONENTS.contains(&component.as_str()) || part_name == own_name {
            continue;
        }
        out.push(MeldRelation {
            id: part_id,
            name: part_name,
            component,
            artist: None,
        });
    }

    // At most two or three lookups — a meld part names its sibling and the result, a result
    // names its two parts — so one prepared statement over the primary key, and no attempt to
    // batch. A relation whose id is not in `cards` keeps its `None` and is still returned: the
    // frontend draws a "no image yet" panel for it rather than hiding a real relationship,
    // which is the same choice `reconcile` makes about an orphan (flagged, never deleted).
    if !out.is_empty() {
        let mut stmt = conn
            .prepare("SELECT artist FROM cards WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        for relation in out.iter_mut() {
            relation.artist = stmt
                .query_row(params![relation.id], |r| r.get::<_, Option<String>>(0))
                .optional()
                .map_err(|e| e.to_string())?
                .flatten();
        }
    }
    Ok(out)
}

/// The meld relationships of one printing. Read-only connection, blocking pool — as
/// [`card_detail`] is, and for the same reason.
///
/// Takes no `marketplace`: this answers who a card melds with, not what anything costs.
#[tauri::command]
pub async fn card_meld_parts(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Vec<MeldRelation>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || meld_parts(&lock_db_read(&state), &id))
        .await
        .map_err(|e| format!("meld parts could not be read: {e}"))?
}

// ---------------------------------------------------------------------------------------
// How the pane groups that list — one `app_meta` row
// ---------------------------------------------------------------------------------------

/// Every way the card pane groups its printings list, in the order the picker offers them.
///
/// The mirror of the `PrintingGroupBy` union in `src/features/card/printings.ts`, and
/// deliberately a flat list of strings rather than an enum with headings and orderings: what a
/// mode *means* — which key the rows bucket on, what a group's heading reads, how the buckets
/// are ordered against each other — is domain logic, and this module's own header is the rule
/// that puts domain logic in TypeScript. The only question Rust has to answer about a mode is
/// whether it is one of these.
pub const PRINTING_GROUP_BY_MODES: [&str; 4] = ["artist", "released", "price", "set"];

/// What the pane groups by when nobody has chosen.
///
/// `artist` because it is the closest thing to what the list already did: the pane folded a
/// card's printings by art identity long before there was a picker
/// (`printings.ts`'s `groupByIllustration`), so a reader who never opens the selector gets the
/// list they had rather than a new one on the first launch after an update.
pub const DEFAULT_PRINTING_GROUP_BY: &str = "artist";

/// The `app_meta` key.
///
/// `app_meta` is the *application's* key/value table (schema v6), deliberately not `sync_meta`
/// — a row in that one the sync did not write makes every later timing claim a fiction. **No
/// migration**: this is a key in a table that has existed since v6, and a preference that
/// needed a schema step would be a preference that could fail a launch.
pub const K_PRINTING_GROUP_BY: &str = "printing_group_by";

/// Is this a grouping this build knows?
pub fn is_known_group_by(mode: &str) -> bool {
    PRINTING_GROUP_BY_MODES.contains(&mode)
}

/// The stored grouping, or [`DEFAULT_PRINTING_GROUP_BY`].
///
/// Three cases collapse into the fallback and it matters that they do: no row at all (a fresh
/// install, and the common one), an unreadable row (`get_app_meta` swallows the error), and a
/// row holding a mode this build does not recognise — what a *newer* build pointed at the same
/// `mtg.db` leaves behind, or what a hand-edit leaves behind.
///
/// None of the three is worth failing over, and the reason is what the pane *is*: a reader
/// opened it to look at a card. A stale preference may cost them the grouping they picked; it
/// must never cost them the printings list.
pub fn stored_group_by(conn: &Connection) -> String {
    crate::app_meta::get_app_meta(conn, K_PRINTING_GROUP_BY)
        .filter(|mode| is_known_group_by(mode))
        .unwrap_or_else(|| DEFAULT_PRINTING_GROUP_BY.to_owned())
}

/// Write the setting, refusing a mode this build does not know.
///
/// The refusal is the whole point of the function, and it is the exact complement of
/// [`stored_group_by`]'s silence: that one discards an unrecognised value without a word, so
/// without this a typo'd mode would look like it saved, survive a restart in the table, and
/// read back as `artist` forever with nothing anywhere to say why.
pub fn store_group_by(conn: &Connection, mode: &str) -> Result<(), String> {
    if !is_known_group_by(mode) {
        return Err(format!(
            "\"{mode}\" is not a way this app groups printings. Expected one of: {}.",
            PRINTING_GROUP_BY_MODES.join(", ")
        ));
    }
    crate::app_meta::set_app_meta(conn, K_PRINTING_GROUP_BY, mode)
        .map_err(|e| format!("could not save the printing grouping: {e}"))
}

/// How the card pane groups its printings, as a raw stored mode.
///
/// A `String` and not a narrowed value, for [`stored_group_by`]'s reason: the row may have been
/// written by a build that offered a mode this one has never heard of, and narrowing it is the
/// frontend's job (`isPrintingGroupBy`, `src/features/card/printings.ts`) on the other side of
/// a wire that carries strings anyway.
///
/// Read-only connection on the blocking pool, exactly as [`card_printings`] runs — the two are
/// read together when the pane opens, and a preference that queued behind an ~80 s ingest on
/// the write connection would hold the whole pane behind it. The `Result` is `spawn_blocking`'s
/// join and nothing else; the read itself has no failure mode left, because every way it could
/// go wrong is already a reason to answer the default.
#[tauri::command]
pub async fn printing_group_by(state: tauri::State<'_, Arc<AppState>>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || stored_group_by(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("the printing grouping could not be read: {e}"))
}

/// Choose how the pane groups printings. Rejects a mode this build does not know, and answers
/// [`crate::db::BUSY`] if a sync holds the write connection — the bound every write
/// command in this crate takes.
///
/// **The lock comes first and the mode is checked inside it**, which is
/// [`crate::marketplace::set_marketplace`]'s order and not an accident: a bad mode sent while a
/// sync holds the connection answers BUSY, because nothing has looked at the mode yet. Getting
/// that backwards would mean the same call answered two different sentences depending on
/// whether an ingest happened to be running.
#[tauri::command]
pub async fn set_printing_group_by(
    state: tauri::State<'_, Arc<AppState>>,
    mode: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| store_group_by(conn, &mode))
    })
    .await
    .map_err(|e| format!("the printing grouping could not be saved: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Three paper printings of one oracle card — two sharing an illustration, one with
    /// its own — plus an MTGO printing of the same card that must never be offered as a
    /// copy to own, and a double-faced card, which is the shape `faces` has to survive.
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        let rows = [
            ("p1", "o1", "lea", "161", "1993-08-05", "art-a"),
            ("p2", "o1", "2ed", "162", "1993-12-01", "art-a"),
            ("p3", "o1", "m10", "146", "2009-07-17", "art-b"),
        ];
        for (id, oracle, set, cn, released, illus) in rows {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                    released_at, illustration_id, rarity, type_line, oracle_text, mana_cost,
                    legalities, finishes, prices, artist, search_text, raw)
                 VALUES (?1, ?2, 'Lightning Bolt', ?3, ?4, 'en', 'normal', ?5, ?6, 'common',
                    'Instant', 'Lightning Bolt deals 3 damage to any target.', '{R}',
                    '{\"modern\":\"legal\",\"vintage\":\"restricted\",\"standard\":\"not_legal\"}',
                    '[\"nonfoil\",\"foil\"]',
                    '{\"usd\":\"5.00\",\"usd_foil\":\"40.00\",\"usd_etched\":null,\"eur\":\"4.20\",\"eur_foil\":\"35.00\",\"tix\":\"0.03\"}',
                    'Christopher Rush', 'Lightning Bolt', '{}')",
                rusqlite::params![id, oracle, set, cn, released, illus],
            )
            .unwrap();
        }
        conn.execute(
            // No top-level artist in the source JSON — a transform carries it per face —
            // so the `artist` column holds what `CardRow`'s front-face fallback resolved
            // at parse time, which is the whole reason that fallback exists.
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                faces, artist, search_text, raw)
             VALUES ('dfc','o2','Delver of Secrets // Insectile Aberration','isd','51','en',
                'transform',
                json_array(
                  json_object('name','Delver of Secrets','type_line','Creature — Human Wizard',
                              'oracle_text','At the beginning of your upkeep…',
                              'mana_cost','{U}','artist','Nils Hamm'),
                  json_object('name','Insectile Aberration','type_line','Creature — Human Insect',
                              'oracle_text','Flying','mana_cost','','artist','Nils Hamm')),
                'Nils Hamm', 'Delver', '{}')",
            [],
        )
        .unwrap();
        // Same oracle card, digital-only: an MTGO printing, dated newest of all so that a
        // query which forgets `is_paper` puts it at the very top of the list rather than
        // somewhere a test might miss it.
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                released_at, illustration_id, rarity, is_paper, digital, search_text, raw)
             VALUES ('p4-mtgo','o1','Lightning Bolt','pmtg1','7','en','normal','2014-06-16',
                'art-a','common', 0, 1, 'Lightning Bolt', '{}')",
            [],
        )
        .unwrap();
        conn
    }

    /// The default, which is what all but the marketplace tests below are asking about.
    const TCG: Marketplace = Marketplace::Tcgplayer;

    /// One printing that exists in all three finishes, with a real `usd_etched` — the shape the
    /// etched contrast needs, and the one the three-printing seed above deliberately does not
    /// have (its `usd_etched` is null, like most of the corpus).
    ///
    /// Cardmarket's half of the contrast needs nothing seeded: **there is no `eur_etched` key in
    /// Scryfall's data at all**, so the euro price of an etched card is structurally absent
    /// rather than missing from this fixture.
    fn seed_etched(conn: &Connection) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                released_at, rarity, finishes, prices, search_text, raw)
             VALUES ('etch','o-etch','Counterspell','mh2','267','en','normal','2021-06-18',
                'common', '[\"nonfoil\",\"foil\",\"etched\"]',
                '{\"usd\":\"2.95\",\"usd_foil\":\"3.19\",\"usd_etched\":\"3.25\",
                  \"eur\":\"2.10\",\"eur_foil\":\"2.60\",\"tix\":\"0.03\"}',
                'Counterspell', '{}')",
            [],
        )
        .unwrap();
    }

    /// One printing carrying `promo_types` — the column the *kind* of foil is read from, and
    /// the one the three-printing seed above deliberately leaves NULL, like 84 538 of the
    /// corpus's 116 712 rows.
    ///
    /// MUL 133's real payload. It is the second card in issue #160's screenshot, where it drew
    /// the same glyph as every other foil.
    fn seed_promo(conn: &Connection) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                released_at, rarity, finishes, promo_types, prices, search_text, raw)
             VALUES ('halo','o-halo','Elesh Norn, Grand Cenobite','mul','133','en','normal',
                '2023-04-21','mythic', '[\"foil\"]', '[\"halofoil\"]',
                '{\"usd\":\"95.79\",\"usd_foil\":\"95.79\"}',
                'Elesh Norn', '{}')",
            [],
        )
        .unwrap();
    }

    /// **Both reads of `cards` carry `promo_types` through, at the position each SELECT put
    /// it.** Issue #160: `finishes` has three words for how shiny a copy is and none for
    /// *which* shiny, so a Surge Foil and an ordinary foil were one glyph with one word behind
    /// it. The naming is TypeScript's (`src/lib/treatment.ts`); this is the fact reaching it.
    ///
    /// Worth a test of its own rather than leaning on the two camelCase pins, which serialise a
    /// hand-built struct and never run the SQL. Both statements are read **positionally**, and
    /// both had to renumber to take this column: `list_printings` moved `read_finish_prices`
    /// from 15 to 16 and `get_card` from 20 to 21. A wrong offset there does not fail — SQLite
    /// hands back whatever is at the index, and `Option<String>` accepts a great deal.
    #[test]
    fn a_printings_promo_types_reach_both_reads() {
        let conn = seeded();
        seed_promo(&conn);

        let listed = list_printings(&conn, "o-halo", TCG, None).unwrap();
        assert_eq!(listed.items.len(), 1);
        assert_eq!(
            listed.items[0].promo_types.as_deref(),
            Some(r#"["halofoil"]"#),
            "the printings list carries the column the treatment is named from"
        );
        // The neighbouring fields, because a one-off index would still have produced *a*
        // string: `promo` is the boolean one letter away, and `frame_effects` is the other
        // nullable JSON column in the same SELECT.
        assert!(!listed.items[0].promo);
        assert_eq!(listed.items[0].frame_effects, None);
        assert_eq!(listed.items[0].collector_number, "133");
        // And the prices still land where the shifted offset says they do.
        assert_eq!(listed.items[0].finish_prices.foil, Some(95.79));

        let detail = get_card(&conn, "halo", TCG).unwrap().unwrap();
        assert_eq!(detail.promo_types.as_deref(), Some(r#"["halofoil"]"#));
        assert_eq!(detail.finishes.as_deref(), Some(r#"["foil"]"#));
        assert_eq!(detail.image_status, None);
        assert_eq!(detail.finish_prices.foil, Some(95.79));

        // A printing with no treatment answers `None` rather than an empty array — the column
        // is NULL on four fifths of the corpus and that is the shape every reader fences on.
        let plain = get_card(&conn, "p1", TCG).unwrap().unwrap();
        assert_eq!(plain.promo_types, None);
        assert_eq!(
            list_printings(&conn, "o1", TCG, None).unwrap().items[0].promo_types,
            None
        );
    }

    /// One row of `marketplace_prices` — what `marketplace_feed.rs` writes, and the only thing
    /// the feed-backed arms of `price_expr` read.
    fn seed_feed(conn: &Connection, feed: &str, card_id: &str, finish: &str, price: f64) {
        conn.execute(
            "INSERT INTO marketplace_prices (marketplace, card_id, finish, price)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![feed, card_id, finish, price],
        )
        .unwrap();
    }

    /// `count` paper printings of one oracle card, ids `<oracle_id>-<n>`.
    ///
    /// Lifted out of the truncation test below, which was the only thing that needed it until
    /// the page became the caller's to name. The columns are the fewest [`list_printings`]
    /// reads without answering NULL where [`Printing`] says `String`; every row is dated the
    /// same day, because these cases ask how many rows come back and never which.
    fn seed_printings(conn: &Connection, oracle_id: &str, count: usize) {
        for n in 0..count {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang,
                    layout, released_at, search_text, raw)
                 VALUES (?1, ?2, 'Forest', 'set', ?3, 'en', 'normal', '2020-01-01', 'Forest', '{}')",
                rusqlite::params![format!("{oracle_id}-{n}"), oracle_id, n.to_string()],
            )
            .unwrap();
        }
    }

    #[test]
    fn a_card_comes_back_with_the_blobs_the_ui_parses() {
        let conn = seeded();
        let c = get_card(&conn, "p1", TCG).unwrap().unwrap();

        assert_eq!(c.name, "Lightning Bolt");
        assert_eq!(c.set_code, "lea");
        assert_eq!(c.oracle_id.as_deref(), Some("o1"));
        // Still a blob: legalities has 23 keys and grows. Prices are not one any more — a blob
        // could only ever have carried two of the four marketplaces.
        assert!(c.legalities.as_deref().unwrap().contains("\"vintage\""));
        // Its own column since v3; the image policy needs it on this pane.
        assert_eq!(c.artist.as_deref(), Some("Christopher Rush"));
        assert!(c.faces.is_empty(), "a single-faced card has no faces");
    }

    /// Every finish, from every marketplace's own source — the whole of what this module gained.
    ///
    /// Two shapes behind one answer: TCGplayer and Cardmarket are keys of `cards.prices`, Card
    /// Kingdom and Mana Pool are rows of `marketplace_prices`, and the pane cannot tell which.
    #[test]
    fn each_marketplace_prices_every_finish_from_its_own_source() {
        let conn = seeded();
        seed_etched(&conn);
        for (feed, nonfoil, foil, etched) in [
            ("cardkingdom", 3.49, 3.99, 4.25),
            ("manapool", 2.71, 2.93, 2.99),
        ] {
            seed_feed(&conn, feed, "etch", "nonfoil", nonfoil);
            seed_feed(&conn, feed, "etch", "foil", foil);
            seed_feed(&conn, feed, "etch", "etched", etched);
        }

        let at = |m| get_card(&conn, "etch", m).unwrap().unwrap().finish_prices;

        let tcg = at(Marketplace::Tcgplayer);
        assert_eq!(
            (tcg.nonfoil, tcg.foil, tcg.etched),
            (Some(2.95), Some(3.19), Some(3.25))
        );
        let ck = at(Marketplace::Cardkingdom);
        assert_eq!(
            (ck.nonfoil, ck.foil, ck.etched),
            (Some(3.49), Some(3.99), Some(4.25))
        );
        let mp = at(Marketplace::Manapool);
        assert_eq!(
            (mp.nonfoil, mp.foil, mp.etched),
            (Some(2.71), Some(2.93), Some(2.99))
        );
        // Cardmarket prices the two finishes it has keys for, and only those.
        let cm = at(Marketplace::Cardmarket);
        assert_eq!((cm.nonfoil, cm.foil), (Some(2.10), Some(2.60)));
    }

    /// **The etched contrast**, which is the one place the four marketplaces visibly disagree
    /// about what is knowable rather than about a number.
    ///
    /// The same card, in the same finish: TCGplayer quotes it from `usd_etched`, Mana Pool from a
    /// real `price_cents_nm_etched` column (1 198 cards carry one live), and Cardmarket cannot
    /// quote it at all — **`eur_etched` does not exist in Scryfall's data**, so the answer is
    /// NULL rather than the nonfoil rate the blob does carry and which a fallback would quietly
    /// charge.
    #[test]
    fn etched_is_priced_where_it_exists_and_null_on_cardmarket_because_the_key_does_not() {
        let conn = seeded();
        seed_etched(&conn);
        seed_feed(&conn, "manapool", "etch", "etched", 2.99);

        let etched = |m| {
            get_card(&conn, "etch", m)
                .unwrap()
                .unwrap()
                .finish_prices
                .etched
        };

        assert_eq!(etched(Marketplace::Tcgplayer), Some(3.25));
        assert_eq!(etched(Marketplace::Manapool), Some(2.99));
        assert_eq!(
            etched(Marketplace::Cardmarket),
            None,
            "there is no `eur_etched` key, so an etched card is unpriced in euros"
        );
        // And the euro nonfoil price is right there in the same blob, unused: the hole is the
        // answer, not a reason to reach one key over.
        assert_eq!(
            get_card(&conn, "etch", Marketplace::Cardmarket)
                .unwrap()
                .unwrap()
                .finish_prices
                .nonfoil,
            Some(2.10)
        );
    }

    /// A printing a feed has never listed is **unpriced at that marketplace**, and nothing fills
    /// it in from another one. The card is in `cards` with a full `prices` blob, so a fallback
    /// would have plenty to reach for.
    #[test]
    fn a_card_a_feed_never_listed_reads_null_rather_than_another_marketplaces_number() {
        let conn = seeded();
        // Card Kingdom lists the nonfoil and nothing else; Mana Pool has never heard of it.
        seed_feed(&conn, "cardkingdom", "p1", "nonfoil", 6.49);

        let ck = get_card(&conn, "p1", Marketplace::Cardkingdom)
            .unwrap()
            .unwrap()
            .finish_prices;
        assert_eq!(ck.nonfoil, Some(6.49));
        assert_eq!(
            ck.foil, None,
            "listed nonfoil only — never the $40 foil blob price"
        );
        assert_eq!(ck.etched, None);

        let mp = get_card(&conn, "p1", Marketplace::Manapool)
            .unwrap()
            .unwrap()
            .finish_prices;
        assert_eq!((mp.nonfoil, mp.foil, mp.etched), (None, None, None));
    }

    /// The marketplace argument, resolved by the crate's one rule: **anything that is not one of
    /// the three named ids is TCGplayer** — absent, a future id, `cardtrader`, a typo. A card the
    /// reader asked to open must not refuse over a setting a newer build wrote.
    #[test]
    fn an_absent_or_unknown_marketplace_prices_at_tcgplayer() {
        let conn = seeded();
        seed_etched(&conn);
        // Feed rows exist, so a resolution that fell through to one would be visible.
        seed_feed(&conn, "cardkingdom", "etch", "nonfoil", 3.49);

        for id in [None, Some("cardtrader"), Some("ebay"), Some("Cardmarket")] {
            let c = get_card(&conn, "etch", Marketplace::from_opt(id))
                .unwrap()
                .unwrap();
            assert_eq!(c.finish_prices.nonfoil, Some(2.95), "{id:?}");
        }
    }

    /// The faces a flip control needs, in order, with the artist per face — `card_faces`
    /// carries its own artist and a DFC's two sides are not always the same illustrator.
    #[test]
    fn a_double_faced_card_carries_both_faces_in_order() {
        let conn = seeded();
        let c = get_card(&conn, "dfc", TCG).unwrap().unwrap();

        assert_eq!(c.faces.len(), 2);
        assert_eq!(c.faces[0].name, "Delver of Secrets");
        assert_eq!(c.faces[1].name, "Insectile Aberration");
        assert_eq!(c.faces[1].artist.as_deref(), Some("Nils Hamm"));
        // The card-level credit is still there for a card whose JSON has none at the top
        // level: the fallback runs once, at parse time (`CardRow`'s `pick`) or in the v3
        // backfill, and the column carries the answer. Scryfall's image policy requires
        // the credit line wherever art is shown, so this must never come back empty.
        assert_eq!(c.artist.as_deref(), Some("Nils Hamm"));
        // Scryfall gives a transform's back face `"mana_cost": ""`, which is not the same
        // as having a cost of nothing to render — a `Some("")` here is a cost pill on the
        // back of every DFC in the game.
        assert_eq!(c.faces[0].mana_cost.as_deref(), Some("{U}"));
        assert!(c.faces[1].mana_cost.is_none(), "an empty cost is no cost");
    }

    #[test]
    fn an_unknown_id_is_none_not_an_error() {
        let conn = seeded();
        assert!(get_card(&conn, "nope", TCG).unwrap().is_none());
    }

    /// Every printing of the oracle card, newest first — the order a "which printing do I
    /// own" list wants, and the one that puts the reprint someone just opened at the top.
    #[test]
    fn printings_come_back_newest_first_with_their_art_identity() {
        let conn = seeded();
        let all = list_printings(&conn, "o1", TCG, None).unwrap().items;

        assert_eq!(all.len(), 3);
        assert_eq!(all[0].set_code, "m10", "newest first");
        assert_eq!(all[2].set_code, "lea");
        // Grouping by illustration is the frontend's job, but the field it groups on has
        // to arrive — two of these share an illustration and one does not.
        assert_eq!(all[0].illustration_id.as_deref(), Some("art-b"));
        assert_eq!(all[1].illustration_id.as_deref(), Some("art-a"));
        // Per finish, never `price_usd` — which is a nonfoil→foil→etched display chain and
        // would quote this plain copy at its $40 foil rate.
        assert_eq!(all[0].finish_prices.nonfoil, Some(5.00));
        assert_eq!(all[0].finish_prices.foil, Some(40.00));
        assert_eq!(
            all[0].finish_prices.etched, None,
            "`usd_etched` is null on this row"
        );
        assert!(all[0].finishes.as_deref().unwrap().contains("foil"));
    }

    /// The printings list prices at the marketplace it was asked for, row by row — the half of
    /// this pane a reader compares printings *by*.
    ///
    /// Seeded so the two feeds disagree with the blob and with each other: a list that quoted
    /// TCGplayer under a Card Kingdom heading would look perfectly plausible.
    #[test]
    fn every_printings_row_is_priced_at_the_marketplace_the_list_was_asked_for() {
        let conn = seeded();
        seed_feed(&conn, "cardkingdom", "p3", "nonfoil", 5.49);
        seed_feed(&conn, "cardkingdom", "p3", "foil", 44.00);
        // Mana Pool lists p3's foil and never its nonfoil — the hole a feed has, per finish.
        seed_feed(&conn, "manapool", "p3", "foil", 36.80);

        let newest = |m| {
            list_printings(&conn, "o1", m, None)
                .unwrap()
                .items
                .into_iter()
                .next()
                .unwrap()
        };

        let tcg = newest(Marketplace::Tcgplayer).finish_prices;
        assert_eq!((tcg.nonfoil, tcg.foil), (Some(5.00), Some(40.00)));
        let cm = newest(Marketplace::Cardmarket).finish_prices;
        assert_eq!((cm.nonfoil, cm.foil), (Some(4.20), Some(35.00)));
        let ck = newest(Marketplace::Cardkingdom).finish_prices;
        assert_eq!((ck.nonfoil, ck.foil), (Some(5.49), Some(44.00)));
        let mp = newest(Marketplace::Manapool).finish_prices;
        assert_eq!((mp.nonfoil, mp.foil), (None, Some(36.80)));

        // And the printings a feed has never listed are unpriced there rather than quoted from
        // the blob every one of them still carries.
        let rest = list_printings(&conn, "o1", Marketplace::Cardkingdom, None)
            .unwrap()
            .items;
        assert!(
            rest[1..]
                .iter()
                .all(|p| p.finish_prices.nonfoil.is_none() && p.finish_prices.foil.is_none()),
            "only p3 was seeded into the feed"
        );
    }

    /// `oracle_id` is NULLABLE, so an id nothing answers to must give an empty list rather
    /// than a query that matches every row whose `oracle_id` is also null. (No live row has
    /// one — see [`list_printings`] — which is why the blank case needs a test rather than
    /// a search of the database to find it.)
    #[test]
    fn an_unknown_oracle_id_returns_nothing() {
        let conn = seeded();
        for absent in ["", "o-none"] {
            let r = list_printings(&conn, absent, TCG, None).unwrap();
            assert!(r.items.is_empty(), "{absent}");
            assert_eq!(r.total, 0, "{absent}");
        }
    }

    /// This pane offers printings as copies to record, so a digital one is an offer to own
    /// something that does not physically exist — and it would price as `—`, because there
    /// is no paper price for an MTGO row. 6 533 oracle cards in the live database have both
    /// kinds, so this is the common case, not an edge.
    #[test]
    fn digital_printings_are_not_offered_as_copies_to_own() {
        let conn = seeded();
        let r = list_printings(&conn, "o1", TCG, None).unwrap();

        assert_eq!(r.items.len(), 3, "the MTGO printing does not belong here");
        assert!(
            !r.items.iter().any(|p| p.id == "p4-mtgo"),
            "a digital printing reached the printings list: {:?}",
            r.items.iter().map(|p| &p.id).collect::<Vec<_>>()
        );
        // It is dated newest of the four, so a missing `is_paper` shows up as the wrong
        // row at the top rather than as a count that happens to match.
        assert_eq!(r.items[0].id, "p3");
        // The count is taken over the same rows as the page: a `total` of 4 here would be
        // the pane reporting a printing it refuses to show.
        assert_eq!(r.total, 3, "the count must agree with the filter");
    }

    /// Asked for by id, a digital printing still resolves — a search with `paperOnly` off
    /// can reach one, and answering `None` for a row that plainly exists reads as a broken
    /// database. The paper rule belongs to the printings list, not to "show me this card".
    #[test]
    fn a_digital_printing_still_opens_when_it_is_asked_for_by_id() {
        let conn = seeded();
        let c = get_card(&conn, "p4-mtgo", TCG).unwrap().unwrap();
        assert_eq!(c.set_code, "pmtg1");
    }

    /// The number a truncated list is a truncation *of*. Without it a capped pane says
    /// "400 printings" when there are 946, and nothing on the wire contradicts it.
    #[test]
    fn the_total_counts_past_the_page_so_a_capped_list_can_say_so() {
        let conn = seeded();
        seed_printings(&conn, "o3", MAX_PRINTINGS + 5);
        let r = list_printings(&conn, "o3", TCG, None).unwrap();

        assert_eq!(r.items.len(), MAX_PRINTINGS, "the page is capped");
        assert_eq!(r.total, MAX_PRINTINGS as i64 + 5, "the count is not");
    }

    /// A caller that asks for more than the default gets it — this is what the printings
    /// modal's filters stand on. Filtering a truncated list draws an empty wall that looks
    /// like an answer rather than like a truncation.
    #[test]
    fn an_explicit_limit_widens_the_page() {
        let conn = seeded();
        seed_printings(&conn, "o3", MAX_PRINTINGS + 20);
        let r = list_printings(&conn, "o3", TCG, Some(1000)).unwrap();

        assert_eq!(
            r.items.len(),
            MAX_PRINTINGS + 20,
            "the wider page is honoured"
        );
        assert_eq!(r.total, MAX_PRINTINGS as i64 + 20, "the count is unchanged");
    }

    /// The ceiling is the fence, not the caller. A limit past it is clamped rather than
    /// obeyed, so no caller can ask this query to walk the whole table.
    #[test]
    fn a_limit_past_the_ceiling_is_clamped() {
        let conn = seeded();
        seed_printings(&conn, "o3", MAX_PRINTINGS_HARD + 5);
        let r = list_printings(&conn, "o3", TCG, Some(99_999)).unwrap();

        assert_eq!(r.items.len(), MAX_PRINTINGS_HARD, "clamped to the ceiling");
        assert_eq!(
            r.total,
            MAX_PRINTINGS_HARD as i64 + 5,
            "the count is still uncapped"
        );
    }

    /// Absent is the card pane's page, byte for byte. The pane must not change because the
    /// modal arrived.
    #[test]
    fn no_limit_is_still_the_default_page() {
        let conn = seeded();
        seed_printings(&conn, "o3", MAX_PRINTINGS + 5);
        let r = list_printings(&conn, "o3", TCG, None).unwrap();

        assert_eq!(r.items.len(), MAX_PRINTINGS);
    }

    /// Zero and negatives are a caller bug, not a request for an empty list — an empty page
    /// here would read as "this card has no printings", which is the one thing it must never
    /// say. The negative is the sharper half: SQLite reads a negative `LIMIT` as *no limit at
    /// all*, so passing one straight through would widen the page rather than empty it.
    #[test]
    fn a_nonsense_limit_falls_back_to_the_default() {
        let conn = seeded();
        seed_printings(&conn, "o3", MAX_PRINTINGS + 5);
        for bad in [Some(0), Some(-1)] {
            let r = list_printings(&conn, "o3", TCG, bad).unwrap();
            assert_eq!(r.items.len(), MAX_PRINTINGS, "{bad:?} falls back");
        }
    }

    /// A face with no name must not be dropped: the flip control addresses faces by index,
    /// so dropping one silently renumbers every face after it and shows the wrong side.
    #[test]
    fn a_nameless_face_keeps_its_place_rather_than_shifting_the_rest() {
        let faces = parse_faces(Some(
            r#"[{"name":"Front","artist":"A"},{"artist":"B"},{"name":"Back","artist":"C"}]"#,
        ));

        assert_eq!(faces.len(), 3, "no face is dropped");
        assert_eq!(faces[0].name, "Front");
        assert_eq!(faces[1].name, "");
        assert_eq!(faces[2].name, "Back", "still the third face");
        assert_eq!(faces[2].artist.as_deref(), Some("C"));
    }

    /// Unparseable and non-array blobs are no faces rather than an error — a card whose
    /// face data is broken is still a card worth showing.
    #[test]
    fn a_face_blob_that_makes_no_sense_is_no_faces_and_no_error() {
        assert!(parse_faces(None).is_empty());
        assert!(parse_faces(Some("not json")).is_empty());
        assert!(parse_faces(Some(r#"{"name":"an object, not an array"}"#)).is_empty());
    }

    /// `src/lib/ipc.ts` mirrors these names by hand and nothing checks that the two still
    /// agree — a `rename_all` lost in a refactor turns every field of the detail pane into
    /// an `undefined` TypeScript is perfectly happy with, and the pane renders blank
    /// instead of failing. Compared as one whole value, so a field *added* on this side and
    /// never mirrored fails here too; a field-by-field check reads straight past that.
    ///
    /// The nulls are part of the shape. Nothing here carries `skip_serializing_if`, so an
    /// absent `oracleText` arrives as an explicit `null` rather than a missing key — which
    /// is what `string | null` on the TypeScript side promises, and what the difference
    /// between "this card has no rules text" and "the backend forgot to send it" rests on.
    ///
    /// A double-faced card, because it is the only shape that pins [`CardFace`] as well.
    #[test]
    fn card_detail_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(CardDetail {
            id: "dfc".into(),
            oracle_id: Some("o2".into()),
            name: "Delver of Secrets // Insectile Aberration".into(),
            set_code: "isd".into(),
            set_name: Some("Innistrad".into()),
            collector_number: "51".into(),
            rarity: Some("common".into()),
            layout: "transform".into(),
            lang: "en".into(),
            // A transform has no cost of its own; the front face carries it.
            mana_cost: None,
            cmc: Some(1.0),
            type_line: Some("Creature — Human Wizard // Creature — Human Insect".into()),
            oracle_text: None,
            illustration_id: Some("art-c".into()),
            artist: Some("Nils Hamm".into()),
            released_at: Some("2011-09-30".into()),
            legalities: Some(r#"{"modern":"legal"}"#.into()),
            // A priced nonfoil, a priced foil and an unpriced etched — the third is the shape
            // the em dash is drawn from, and `null` is how the pane is told.
            finish_prices: FinishPrices {
                nonfoil: Some(0.35),
                foil: Some(4.10),
                etched: None,
            },
            finishes: Some(r#"["nonfoil","foil"]"#.into()),
            // A real payload rather than `None`: `promo_types` is the column the *kind* of
            // foil is read from, and pinning it against a value says which of the two similarly
            // named fields this is — `promo` is a boolean about distribution, this is a list.
            promo_types: Some(r#"["prerelease"]"#.into()),
            image_status: Some("highres_scan".into()),
            faces: vec![
                CardFace {
                    name: "Delver of Secrets".into(),
                    type_line: Some("Creature — Human Wizard".into()),
                    oracle_text: Some("At the beginning of your upkeep…".into()),
                    mana_cost: Some("{U}".into()),
                    artist: Some("Nils Hamm".into()),
                },
                CardFace {
                    name: "Insectile Aberration".into(),
                    type_line: Some("Creature — Human Insect".into()),
                    oracle_text: Some("Flying".into()),
                    // The back of a transform: no cost to render, and `null` is how the
                    // flip control is told so.
                    mana_cost: None,
                    artist: Some("Nils Hamm".into()),
                },
            ],
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": "dfc",
                "oracleId": "o2",
                "name": "Delver of Secrets // Insectile Aberration",
                "setCode": "isd",
                "setName": "Innistrad",
                "collectorNumber": "51",
                "rarity": "common",
                "layout": "transform",
                "lang": "en",
                "manaCost": null,
                // A `1` here would not compare equal: `cmc` is an `f64` on the wire, and
                // the TypeScript `number` covers both.
                "cmc": 1.0,
                "typeLine": "Creature — Human Wizard // Creature — Human Insect",
                "oracleText": null,
                "illustrationId": "art-c",
                "artist": "Nils Hamm",
                "releasedAt": "2011-09-30",
                "legalities": r#"{"modern":"legal"}"#,
                "finishPrices": { "nonfoil": 0.35, "foil": 4.10, "etched": null },
                "finishes": r#"["nonfoil","foil"]"#,
                "promoTypes": r#"["prerelease"]"#,
                "imageStatus": "highres_scan",
                "faces": [
                    {
                        "name": "Delver of Secrets",
                        "typeLine": "Creature — Human Wizard",
                        "oracleText": "At the beginning of your upkeep…",
                        "manaCost": "{U}",
                        "artist": "Nils Hamm"
                    },
                    {
                        "name": "Insectile Aberration",
                        "typeLine": "Creature — Human Insect",
                        "oracleText": "Flying",
                        "manaCost": null,
                        "artist": "Nils Hamm"
                    }
                ]
            })
        );
    }

    /// The list half of the same hand-mirrored contract, pinned whole for the same reason:
    /// `fullArt` and `borderColor` are the names a printings row is *distinguished* by, and
    /// a printing whose art variant renders wrong looks like a data problem rather than a
    /// rename.
    ///
    /// The empty answer is pinned too. [`PrintingsResponse::default()`] is what a blank
    /// `oracle_id` returns, and `items` has to reach a pane that maps over it as `[]` — an
    /// `Option<Vec<_>>` here, or a `skip_serializing_if` on an empty one, would send
    /// `null`/nothing and crash the map instead of rendering an empty list.
    #[test]
    fn printings_response_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(PrintingsResponse {
            items: vec![Printing {
                id: "p1".into(),
                set_code: "lea".into(),
                set_name: Some("Limited Edition Alpha".into()),
                collector_number: "161".into(),
                released_at: Some("1993-08-05".into()),
                rarity: Some("common".into()),
                illustration_id: Some("art-a".into()),
                artist: Some("Christopher Rush".into()),
                lang: "en".into(),
                finishes: Some(r#"["nonfoil"]"#.into()),
                // Alpha exists in nonfoil only, so the other two are `null` at every
                // marketplace — a finish that does not exist and one a marketplace has no price
                // for are the same answer here, and the pane draws neither.
                finish_prices: FinishPrices {
                    nonfoil: Some(400.50),
                    foil: None,
                    etched: None,
                },
                promo: false,
                // Absent for the same reason as `frame_effects` below: Alpha predates every
                // treatment this column names, so `null` is the true answer and not a gap.
                promo_types: None,
                full_art: false,
                // Absent, not empty: an Alpha printing has no frame effects at all.
                frame_effects: None,
                border_color: Some("black".into()),
                layout: "normal".into(),
            }],
            // Larger than `items`, which is the whole signal that a list was truncated.
            total: 862,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "items": [{
                    "id": "p1",
                    "setCode": "lea",
                    "setName": "Limited Edition Alpha",
                    "collectorNumber": "161",
                    "releasedAt": "1993-08-05",
                    "rarity": "common",
                    "illustrationId": "art-a",
                    "artist": "Christopher Rush",
                    "lang": "en",
                    "finishes": r#"["nonfoil"]"#,
                    "finishPrices": { "nonfoil": 400.50, "foil": null, "etched": null },
                    "promo": false,
                    "promoTypes": null,
                    "fullArt": false,
                    "frameEffects": null,
                    "borderColor": "black",
                    "layout": "normal"
                }],
                "total": 862
            })
        );

        assert_eq!(
            serde_json::to_value(PrintingsResponse::default()).unwrap(),
            serde_json::json!({"items": [], "total": 0})
        );
    }

    // -----------------------------------------------------------------------------------
    // The grouping setting
    // -----------------------------------------------------------------------------------

    /// The schema and nothing else. The setting lives in `app_meta`, which no card row is
    /// involved in, so seeding printings here would only make the failures harder to read.
    fn meta_db() -> Connection {
        crate::schema::memory_pair()
    }

    /// The setting outlives the process, so the only thing that matters about it is that what
    /// went in comes back out — for every mode the picker offers, not just the default.
    #[test]
    fn every_grouping_mode_round_trips() {
        let conn = meta_db();
        for mode in PRINTING_GROUP_BY_MODES {
            store_group_by(&conn, mode).unwrap();
            assert_eq!(stored_group_by(&conn), mode);
        }
    }

    /// A database nobody has told groups by artist — which is what the pane's list was folded
    /// by before the selector existed.
    #[test]
    fn a_missing_grouping_row_reads_as_the_default() {
        let conn = meta_db();
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_PRINTING_GROUP_BY),
            None
        );
        assert_eq!(stored_group_by(&conn), "artist");
    }

    /// A newer build's mode must not brick an older one pointed at the same `mtg.db`, and
    /// neither must a hand-edited row. Written past `store_group_by` deliberately — this is the
    /// row a *different* build left behind, which no validation of ours was ever in a position
    /// to refuse.
    #[test]
    fn a_grouping_this_build_does_not_know_reads_as_the_default_rather_than_failing() {
        let conn = meta_db();
        for junk in ["rarity", "", "Artist", "artist ", "null", "released_at"] {
            crate::app_meta::set_app_meta(&conn, K_PRINTING_GROUP_BY, junk).unwrap();
            assert_eq!(
                stored_group_by(&conn),
                "artist",
                "an unrecognised `{junk}` must read as the default, not fail the pane"
            );
        }
    }

    /// The refusal, and the half of it that is easy to forget: a rejected write must leave the
    /// previous choice alone. `stored_group_by` discards junk silently, so a write that
    /// half-landed would look like a save and read back as `artist` forever.
    #[test]
    fn an_unknown_grouping_is_refused_and_leaves_the_stored_one_intact() {
        let conn = meta_db();
        store_group_by(&conn, "price").unwrap();

        let err = store_group_by(&conn, "rarity").unwrap_err();
        assert!(err.contains("rarity"), "{err}");
        assert!(
            err.contains("released"),
            "the message lists what is valid: {err}"
        );

        assert_eq!(stored_group_by(&conn), "price");
        assert_eq!(
            crate::app_meta::get_app_meta(&conn, K_PRINTING_GROUP_BY).as_deref(),
            Some("price"),
            "nothing was written to `app_meta`"
        );
    }

    /// Case and whitespace are not forgiven on the way in either — the mode is a key the
    /// frontend matches verbatim, so "close enough" would store something no lookup finds and
    /// `stored_group_by` would then throw away.
    #[test]
    fn a_near_miss_grouping_is_still_a_refusal() {
        let conn = meta_db();
        for near in ["Artist", " artist", "artist\n", "set_code"] {
            assert!(
                store_group_by(&conn, near).is_err(),
                "`{near}` must not be stored"
            );
        }
        assert_eq!(stored_group_by(&conn), DEFAULT_PRINTING_GROUP_BY);
    }

    /// The default has to be a member of the list it falls back into, or `stored_group_by`
    /// would return a value `set_printing_group_by` refuses to write.
    #[test]
    fn the_default_grouping_is_one_of_the_known_modes() {
        assert!(is_known_group_by(DEFAULT_PRINTING_GROUP_BY));
        let conn = meta_db();
        store_group_by(&conn, DEFAULT_PRINTING_GROUP_BY).unwrap();
        assert_eq!(stored_group_by(&conn), DEFAULT_PRINTING_GROUP_BY);
    }

    /// The grouping and the marketplace are two rows of one table, and each has to survive the
    /// other being written — an `app_meta` write that used the wrong key, or a read that
    /// matched on none, would look exactly like the default until someone changed both.
    #[test]
    fn the_grouping_row_and_the_marketplace_row_do_not_collide() {
        let conn = meta_db();
        store_group_by(&conn, "set").unwrap();
        crate::marketplace::store(&conn, "cardmarket").unwrap();

        assert_eq!(stored_group_by(&conn), "set");
        assert_eq!(crate::marketplace::stored(&conn), "cardmarket");
    }

    /// One card row with a real `image_uris` blob, for [`card_image_uri_inner`]'s tests.
    fn fixture_with_image_uris(id: &str, image_uris_json: &str) -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, raw)
             VALUES (?1, 'Test Card', 'tst', '1', 'en', 'normal', ?2, '{}')",
            rusqlite::params![id, image_uris_json],
        )
        .unwrap();
        conn
    }

    /// A card whose `image_uris` column is `NULL` — it carried none at all, as opposed to a
    /// present key holding JSON `null`.
    fn fixture_with_no_image_uris(id: &str) -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES (?1, 'Test Card', 'tst', '1', 'en', 'normal', '{}')",
            rusqlite::params![id],
        )
        .unwrap();
        conn
    }

    #[test]
    fn the_image_uri_command_answers_the_variant_asked_for() {
        let conn = fixture_with_image_uris(
            "bolt-lea",
            r#"{"thumb":"https://cards.scryfall.io/thumb/x.webp?1",
                "grid":"https://cards.scryfall.io/grid/x.webp?1",
                "display":"https://cards.scryfall.io/display/x.webp?1",
                "art":"https://cards.scryfall.io/art/x.webp?1"}"#,
        );
        let got = card_image_uri_inner(&conn, "bolt-lea", "display").unwrap();
        assert_eq!(
            got.as_deref(),
            Some("https://cards.scryfall.io/display/x.webp?1")
        );
    }

    #[test]
    fn a_json_null_variant_is_none_rather_than_the_string_null() {
        let conn = fixture_with_image_uris(
            "odd",
            r#"{"thumb":null,"grid":null,"display":null,"art":null}"#,
        );
        assert_eq!(card_image_uri_inner(&conn, "odd", "display").unwrap(), None);
    }

    #[test]
    fn a_card_with_no_image_uris_column_is_none() {
        let conn = fixture_with_no_image_uris("artless");
        assert_eq!(
            card_image_uri_inner(&conn, "artless", "display").unwrap(),
            None
        );
    }

    #[test]
    fn an_unknown_card_is_none_rather_than_an_error() {
        let conn = fixture_with_no_image_uris("artless");
        assert_eq!(
            card_image_uri_inner(&conn, "nobody", "display").unwrap(),
            None
        );
    }

    #[test]
    fn an_unknown_variant_is_refused_rather_than_interpolated() {
        let conn = fixture_with_image_uris("bolt-lea", r#"{"display":"u"}"#);
        assert!(card_image_uri_inner(&conn, "bolt-lea", "png").is_err());
    }

    /// One card row with images on its **faces** — optionally with a top-level blob too, which
    /// is how a `meld` printing is shaped. `face_image_uris` is a JSON array, one entry per
    /// face in `card_faces` order, and a face the source gave no images for is a `null` in
    /// place (`card_row::webp_uris`).
    fn fixture_with_faces(id: &str, top: Option<&str>, face_json: &str) -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout,
                                image_uris, face_image_uris, raw)
             VALUES (?1, 'Test Card', 'tst', '1', 'en', 'transform', ?2, ?3, '{}')",
            rusqlite::params![id, top, face_json],
        )
        .unwrap();
        conn
    }

    /// 3.7% of printings carry **no top-level `image_uris` at all** — `transform`,
    /// `modal_dfc`, `double_faced_token`, `art_series` and `reversible_card` put them on the
    /// faces (`images.rs`'s header). Reading only the column answered `None` for every one of
    /// them, silently: the menu's `copyCardImage` does `if (!uri) return;`, so ~4 300 live
    /// printings copied nothing with no error and no toast.
    #[test]
    fn a_face_only_printing_answers_its_front_faces_image() {
        let conn = fixture_with_faces(
            "delver-isd",
            None,
            r#"[{"thumb":"https://cards.scryfall.io/thumb/front.webp?1",
                 "grid":"https://cards.scryfall.io/grid/front.webp?1",
                 "display":"https://cards.scryfall.io/display/front.webp?1",
                 "art":"https://cards.scryfall.io/art/front.webp?1"},
                {"display":"https://cards.scryfall.io/display/back.webp?1"}]"#,
        );
        assert_eq!(
            card_image_uri_inner(&conn, "delver-isd", "display")
                .unwrap()
                .as_deref(),
            Some("https://cards.scryfall.io/display/front.webp?1"),
            "a printing whose art lives on its faces has a picture, and it is the front one"
        );
    }

    /// The same precedence [`crate::images::resolve`] applies: **face first**, top-level only
    /// as the fallback. A `meld` printing carries both, and its top-level image is its front
    /// and nothing else — so the two must never disagree about which URL face 0 has.
    #[test]
    fn the_front_face_wins_over_the_top_level_image() {
        let conn = fixture_with_faces(
            "meld-eld",
            Some(r#"{"display":"https://cards.scryfall.io/display/top.webp?1"}"#),
            r#"[{"display":"https://cards.scryfall.io/display/face0.webp?1"}]"#,
        );
        assert_eq!(
            card_image_uri_inner(&conn, "meld-eld", "display")
                .unwrap()
                .as_deref(),
            Some("https://cards.scryfall.io/display/face0.webp?1")
        );
        // Matched rather than compared: `Resolution` carries no `PartialEq`, and the point of
        // asserting it here is that the two code paths agree — a future edit to either that
        // changed the precedence would have to change this test to land.
        let via_cache = crate::images::resolve(
            &conn,
            &crate::images::ImageKey {
                card_id: "meld-eld".to_owned(),
                face: 0,
                variant: crate::images::Variant::Display,
            },
        )
        .unwrap();
        assert!(
            matches!(&via_cache, crate::images::Resolution::Uri(u)
                     if u == "https://cards.scryfall.io/display/face0.webp?1"),
            "and the two answers are the same answer: {via_cache:?}"
        );
    }

    /// The fallback half of the rule: a face array that holds nothing for the variant asked
    /// for leaves the top-level blob answering, as it did before faces were consulted at all.
    #[test]
    fn a_front_face_without_the_variant_falls_back_to_the_top_level_image() {
        let conn = fixture_with_faces(
            "partial",
            Some(r#"{"display":"https://cards.scryfall.io/display/top.webp?1"}"#),
            r#"[{"art":"https://cards.scryfall.io/art/face0.webp?1"}]"#,
        );
        assert_eq!(
            card_image_uri_inner(&conn, "partial", "display")
                .unwrap()
                .as_deref(),
            Some("https://cards.scryfall.io/display/top.webp?1")
        );
    }

    // -----------------------------------------------------------------------------------
    // Meld
    // -----------------------------------------------------------------------------------

    /// Scryfall's ids for the Eldritch Moon meld trio, as measured against the live corpus.
    const BRUNA: &str = "27907985-b5f6-4098-ab43-15a0c2bf94d5";
    const GISELA: &str = "c75c035a-7da9-4b36-982d-fca8220b1797";
    /// The Brisela printing Bruna's own `all_parts` names.
    const BRISELA: &str = "5a7a212e-e0b6-4f12-a95c-173cae023f93";
    /// A *second* Brisela printing, and the third id in the story: only the first group of
    /// each of these two was measured, so the tail is zeroed rather than invented — nothing
    /// here should read as a uuid somebody could look up.
    const BRISELA_ALT: &str = "0cd83c0e-0000-0000-0000-000000000000";
    /// What `BRISELA_ALT`'s `all_parts` calls its own `meld_result`: a different printing of
    /// itself, which is the whole reason self is excluded by name.
    const BRISELA_SELF_REF: &str = "bbcd6747-0000-0000-0000-000000000000";

    /// One `all_parts` entry, in the shape the bulk file writes it.
    fn related(component: &str, id: &str, name: &str) -> String {
        format!(
            r#"{{"object":"related_card","id":"{id}","component":"{component}","name":"{name}","type_line":"Legendary Creature — Angel Horror","uri":"https://api.scryfall.com/cards/{id}"}}"#
        )
    }

    /// A bulk line carrying nothing this command reads but `name` and `all_parts`.
    fn raw_with_parts(name: &str, parts: &[String]) -> String {
        format!(
            r#"{{"object":"card","name":"{name}","layout":"meld","all_parts":[{}]}}"#,
            parts.join(",")
        )
    }

    /// A `cards` row whose `raw` is written **gzipped**, exactly as the ingest writes it
    /// ([`crate::card_row::gzip_raw`]), so these tests inflate through the same path the
    /// shipped app does rather than over a text column no live database has had since v3.
    fn insert_card_with_raw(
        conn: &Connection,
        id: &str,
        name: &str,
        layout: &str,
        artist: Option<&str>,
        raw: &[u8],
    ) {
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                released_at, rarity, artist, search_text, raw)
             VALUES (?1, ?2, ?3, 'emn', ?4, 'en', ?5, '2016-07-22', 'rare', ?6, ?3, ?7)",
            rusqlite::params![id, format!("o-{name}"), name, id, layout, artist, raw],
        )
        .unwrap();
    }

    /// The trio, with **two** printings of Brisela — the fixture's whole point.
    ///
    /// Every row is `layout = 'meld'` and every one is credited to Clint Cearley, who
    /// illustrated all three cards.
    fn seeded_meld() -> Connection {
        let conn = crate::schema::memory_pair();
        let art = Some("Clint Cearley");

        // Bruna's list, in Scryfall's order: the result first, then itself, then its
        // sibling — and the set's checklist card, which is a `combo_piece` and not a meld.
        let bruna = raw_with_parts(
            "Bruna, the Fading Light",
            &[
                related("meld_result", BRISELA, "Brisela, Voice of Nightmares"),
                related("meld_part", BRUNA, "Bruna, the Fading Light"),
                related("meld_part", GISELA, "Gisela, the Broken Blade"),
                related("combo_piece", "checklist-emn", "Eldritch Moon Checklist"),
            ],
        );
        insert_card_with_raw(
            &conn,
            BRUNA,
            "Bruna, the Fading Light",
            "meld",
            art,
            &crate::card_row::gzip_raw(&bruna),
        );

        let gisela = raw_with_parts(
            "Gisela, the Broken Blade",
            &[
                related("meld_part", GISELA, "Gisela, the Broken Blade"),
                related("meld_part", BRUNA, "Bruna, the Fading Light"),
                related("meld_result", BRISELA, "Brisela, Voice of Nightmares"),
            ],
        );
        insert_card_with_raw(
            &conn,
            GISELA,
            "Gisela, the Broken Blade",
            "meld",
            art,
            &crate::card_row::gzip_raw(&gisela),
        );

        // The printing Bruna points at. Nothing reads its `all_parts`, so it carries none.
        insert_card_with_raw(
            &conn,
            BRISELA,
            "Brisela, Voice of Nightmares",
            "meld",
            art,
            &crate::card_row::gzip_raw(
                r#"{"object":"card","name":"Brisela, Voice of Nightmares"}"#,
            ),
        );

        // The other printing of the same card — the one whose own list names a *third* id
        // for itself.
        let brisela_alt = raw_with_parts(
            "Brisela, Voice of Nightmares",
            &[
                related(
                    "meld_result",
                    BRISELA_SELF_REF,
                    "Brisela, Voice of Nightmares",
                ),
                related("meld_part", BRUNA, "Bruna, the Fading Light"),
                related("meld_part", GISELA, "Gisela, the Broken Blade"),
            ],
        );
        insert_card_with_raw(
            &conn,
            BRISELA_ALT,
            "Brisela, Voice of Nightmares",
            "meld",
            art,
            &crate::card_row::gzip_raw(&brisela_alt),
        );
        conn
    }

    /// `(component, id, name, artist)` per relation, which is the whole DTO and is easier to
    /// read in a failure than four parallel asserts.
    fn shape(rows: &[MeldRelation]) -> Vec<(&str, &str, &str, Option<&str>)> {
        rows.iter()
            .map(|r| {
                (
                    r.component.as_str(),
                    r.id.as_str(),
                    r.name.as_str(),
                    r.artist.as_deref(),
                )
            })
            .collect()
    }

    /// The worked example, verbatim: `Bruna, the Fading Light` (`emn` 15) answers exactly
    /// two rows, in Scryfall's own array order — its `meld_result` first, then its sibling
    /// `meld_part`.
    ///
    /// Both drops are asserted by the length as much as by the contents: **itself**, which
    /// `all_parts` always includes, and the set's `combo_piece` checklist, which is a real
    /// relationship and simply not a meld.
    #[test]
    fn a_meld_part_answers_its_result_and_its_sibling_in_scryfall_order() {
        let conn = seeded_meld();
        let rows = meld_parts(&conn, BRUNA).unwrap();
        assert_eq!(
            shape(&rows),
            vec![
                (
                    "meld_result",
                    BRISELA,
                    "Brisela, Voice of Nightmares",
                    Some("Clint Cearley")
                ),
                (
                    "meld_part",
                    GISELA,
                    "Gisela, the Broken Blade",
                    Some("Clint Cearley")
                ),
            ],
            "the result, then the sibling, with self and the checklist dropped"
        );
    }

    /// The regression an id-based exclusion passes and a name-based one catches.
    ///
    /// `BRISELA_ALT`'s `all_parts` names a `meld_result` called `Brisela, Voice of
    /// Nightmares` whose id is `BRISELA_SELF_REF` — *a different printing of the card being
    /// asked about*. Comparing ids keeps that entry, and the pane then offers "melds into
    /// Brisela" to a reader who is looking at Brisela.
    #[test]
    fn a_meld_result_excludes_itself_by_name_not_by_id() {
        let conn = seeded_meld();
        let rows = meld_parts(&conn, BRISELA_ALT).unwrap();
        assert_eq!(
            shape(&rows),
            vec![
                (
                    "meld_part",
                    BRUNA,
                    "Bruna, the Fading Light",
                    Some("Clint Cearley")
                ),
                (
                    "meld_part",
                    GISELA,
                    "Gisela, the Broken Blade",
                    Some("Clint Cearley")
                ),
            ],
            "both parts, and the third printing of itself is not one of them"
        );
        assert!(
            !rows.iter().any(|r| r.id == BRISELA_SELF_REF),
            "excluding by id would have kept {BRISELA_SELF_REF}"
        );
    }

    /// The `layout` gate, pinned two ways — and the second row is the one that would actually
    /// go red.
    ///
    /// `garbage` holds bytes that begin like a gzip member and will not inflate, so a build
    /// that read the blob at all would have to survive it. But an unreadable blob answers
    /// `[]` through the *filters* as well, so on its own it proves nothing about the gate:
    /// `melder` is a non-meld row carrying a perfectly good `all_parts`, and only the gate
    /// keeps it at `[]`. 72 of 116 590 live rows are `meld`; this is the other 116 518.
    #[test]
    fn a_non_meld_layout_never_reads_its_raw() {
        let conn = seeded_meld();
        insert_card_with_raw(
            &conn,
            "garbage",
            "Not A Meld",
            "normal",
            None,
            &[0x1f, 0x8b, 0x0b, 0xad, 0xbe, 0xef],
        );
        let melder = raw_with_parts(
            "Also Not A Meld",
            &[related(
                "meld_result",
                BRISELA,
                "Brisela, Voice of Nightmares",
            )],
        );
        insert_card_with_raw(
            &conn,
            "melder",
            "Also Not A Meld",
            "normal",
            None,
            &crate::card_row::gzip_raw(&melder),
        );

        assert!(
            crate::card_row::raw_json(&[0x1f, 0x8b, 0x0b, 0xad, 0xbe, 0xef]).is_none(),
            "the fixture's bytes really are unreadable, so reading them could not have worked"
        );
        assert!(
            meld_parts(&conn, "garbage").unwrap().is_empty(),
            "an unreadable blob behind a non-meld layout is never touched, let alone failed on"
        );
        assert!(
            meld_parts(&conn, "melder").unwrap().is_empty(),
            "and a non-meld row with real meld data in `raw` is still not a meld"
        );
    }

    /// An id no row answers to is an answer — no relationships, because there is no card.
    /// A card the reader opened must never fail to open over this.
    #[test]
    fn an_unknown_id_has_no_meld_relations() {
        let conn = seeded_meld();
        assert!(meld_parts(&conn, "no-such-printing").unwrap().is_empty());
    }

    /// `artist` is looked up on the printing the relation *names*, and its absence has two
    /// causes that must both survive: the corpus has no such row, and the row has a NULL
    /// `artist`. Neither hides the relationship — the pane draws a "no image yet" panel for
    /// one rather than dropping a real meld off the card.
    ///
    /// The field exists because the pane swaps the picture and keeps the open card's facts,
    /// and Scryfall's image policy wants the credit to name the illustrator on screen.
    #[test]
    fn a_relation_is_credited_to_the_artist_of_the_printing_it_names() {
        let conn = seeded_meld();
        // A printing that exists and is credited to nobody.
        insert_card_with_raw(
            &conn,
            "uncredited",
            "Uncredited Half",
            "meld",
            None,
            &crate::card_row::gzip_raw(r#"{"object":"card","name":"Uncredited Half"}"#),
        );
        let asker = raw_with_parts(
            "Asker of Artists",
            &[
                related("meld_part", GISELA, "Gisela, the Broken Blade"),
                related("meld_part", "uncredited", "Uncredited Half"),
                related("meld_result", "never-synced", "Never Synced"),
            ],
        );
        insert_card_with_raw(
            &conn,
            "asker",
            "Asker of Artists",
            "meld",
            Some("Clint Cearley"),
            &crate::card_row::gzip_raw(&asker),
        );

        assert_eq!(
            shape(&meld_parts(&conn, "asker").unwrap()),
            vec![
                (
                    "meld_part",
                    GISELA,
                    "Gisela, the Broken Blade",
                    Some("Clint Cearley")
                ),
                ("meld_part", "uncredited", "Uncredited Half", None),
                ("meld_result", "never-synced", "Never Synced", None),
            ],
            "credited from the named row; None both when that row has no artist and when \
             there is no such row — and the relationship survives either way"
        );
    }
}
