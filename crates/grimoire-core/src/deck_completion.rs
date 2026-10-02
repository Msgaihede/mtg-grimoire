//! The home page's **Deck completion** read: for every deck, how many copies its measured list
//! wants, how many of them a pool covers, and what the rest would cost — and, at the foot of the
//! file, **To review**'s count of deck rows flagged for review ([`review_count`]).
//!
//! **Two comparisons and one arithmetic** ([issue #600](https://github.com/Msgaihede/mtg-grimoire/issues/600)).
//! The widget's setting is a [`Compare`], and a mode decides exactly three things: which decks
//! answer, which list is measured, and what that list is measured against. Everything after the
//! choice is [`measure`], shared, so the two modes cannot come to count differently.
//!
//! * **[`Compare::Collection`], the default: every non-virtual deck's _actual_ (live) list
//!   against the copies filed in that deck's own group**, [`crate::deck::owned_by_printing`] —
//!   what the editor's Actual tab calls owned, rule for rule. A widget reading *4 missing* over a
//!   deck that opens reading *6 missing* is a bug report (spec
//!   `2026-09-26-home-widgets-round-two-design.md` §3.1). **A deck with a plan is measured on its
//!   live list here too, and that reverses what this read did until issue #600**: it measured the
//!   plan against every copy the deck could be built from
//!   ([`crate::deck::available_by_printing`], the Theory tab's pool), `get_deck`'s choice by
//!   variant. One figure meaning two things depending on a flag the widget does not draw made
//!   every row ambiguous — *83%* of the cardboard, or of the plan? — and the plan's progress is a
//!   mode of its own now. **Virtual decks answer no row**: they hold nothing by definition, and
//!   0% of every deck is not a finding.
//! * **[`Compare::Theory`]: every deck with `theory_enabled` — virtual ones included — its
//!   _theory_ list against its _actual_ one**: how much of the plan is already sleeved. The plan
//!   is what is wanted and the live list is the pool, so a planned copy counts only where the
//!   actual list plays that exact printing in that exact finish. That is
//!   [`crate::deck_theory::theory_diff`]'s subtraction summed — `missing` is the Compare dialog's
//!   card lines added up, `missing_cost` those lines priced — and it is fenced against that
//!   function rather than restated beside it. **Virtual decks answer here** because
//!   actual-against-plan is a question about two lists and never about cardboard: a proxy pile
//!   the reader is sleeving toward a plan has a perfectly good answer. **A deck without the
//!   switch answers no row**, theory rows or not — rows kept from before the switch went off are
//!   a plan the editor no longer draws.
//!
//! What holds in both modes:
//!
//! * **Every active pile counts, on both sides**, sideboard and companion included: this is
//!   `DeckStats`' `missing`, and deliberately not [`crate::deck::deck_values_for`]'s narrower
//!   main + commander + maybe. An inactive pile wants nothing and, in Theory, sleeves nothing —
//!   `theory_diff`'s `diff_select` drops it from both lists for the same reason.
//! * The key is `(card_id, finish)`, the finish being the one each row plays in the collection's
//!   spelling — [`crate::deck::entry_finish`], so a NULL deck finish is
//!   [`crate::schema::FINISHES`]`[0]` on a printing sold in it and the sole finish on one that is
//!   not. Every pool is keyed the same way. `attribute_owned` hands a scarce pool down the read
//!   order, so summed over one key it owns `min(Σ wanted, pool)` — and this read walks the same
//!   scarce pool, because an unsaid row and a `foil` row of one foil-only printing are two SQL
//!   groups and one key. Over one key that is also `theory_diff`'s `max(0, wanted − held)`, which
//!   is why one walk serves both modes.
//! * A missing copy costs its row's own price, [`crate::sorting::deck_card_price_expr`], which
//!   depends on the key alone. `missing_cost` is `None` exactly when nothing on the measured list
//!   is priced — `DeckStats`' `missingPrice`, `priced === 0 ? null : …`. In Theory the price is
//!   the **plan's** row's: the plan names what would be bought.
//!
//! **The measured lists are one statement across every deck** ([`lists_by_deck`]), and so is
//! Theory's pool, because the live list is a `deck_cards` read of the same shape. **Collection's
//! pool is read through `deck.rs`'s own function, one statement per deck, and not restated as one
//! correlated statement over every deck** — a second spelling of "what is in this deck's box" is
//! the drift [`crate::deck::owned_by_printing`]'s callers exist to avoid. **All of it is one read
//! transaction**, `theory_diff`'s arrangement: in autocommit each statement is its own snapshot,
//! and a card write landing between the plan's read and the live list's would put a copy on one
//! side of the subtraction and not the other.
//!
//! **Tokens never count**: a token or emblem is a `deck_token_printings` entry, which nothing here
//! reads — so Theory's `missing` is `theory_diff`'s card lines and never its `is_token` ones. A
//! deck with nothing on its measured list answers a row of zeros and reads no pool at all.

use crate::sorting::Marketplace;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;

/// `deck_cards.variant` for the list that is sleeved up.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// `deck_cards.variant` for the plan.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];

/// Which comparison the widget asks for — see the module doc for the two in full.
///
/// **A word on the wire and forgiving about it**, [`Marketplace::from_opt`]'s shape: `"theory"`
/// is [`Self::Theory`] and anything else — absent, a typo, a mode a newer build added — is
/// [`Self::Collection`]. A layout document written by a newer build must draw the default rather
/// than fail the whole widget.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum Compare {
    /// Every non-virtual deck's live list against the copies in its own group.
    #[default]
    Collection,
    /// Every deck with a plan switched on, its theory list against its live list.
    Theory,
}

impl Compare {
    /// The command argument, which may simply not be there.
    pub fn from_opt(word: Option<&str>) -> Compare {
        match word {
            Some("theory") => Compare::Theory,
            _ => Compare::Collection,
        }
    }

    /// Which decks answer — a `WHERE` over `decks d`, and **the one spelling of it**:
    /// [`measured_decks`] and [`lists_by_deck`] both splice this, so the rows answered and the
    /// lists read cannot come to name different decks. `virtual_only = 0` also drops the
    /// kindless `1/1` pair, which `deckKind.ts` reads as virtual; `theory_enabled = 1` keeps it,
    /// because a plan is a plan whatever else the deck says.
    fn decks(self) -> &'static str {
        match self {
            Compare::Collection => "d.virtual_only = 0",
            Compare::Theory => "d.theory_enabled = 1",
        }
    }

    /// The list that is measured — and so `DeckCompletion::list`.
    fn measured(self) -> &'static str {
        match self {
            Compare::Collection => LIVE,
            Compare::Theory => THEORY,
        }
    }
}

/// One deck's completion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCompletion {
    pub deck_id: i64,
    /// `live` | `theory` — which list was measured, and so which [`Compare`] asked: `live` is
    /// [`Compare::Collection`]'s, measured against the deck's own group, and `theory` is
    /// [`Compare::Theory`]'s, measured against the live list. Never both for one mode, which is
    /// what issue #600 changed: a plan used to be measured under the default.
    pub list: String,
    /// Copies the measured list asks for, active piles only.
    pub wanted: i64,
    /// Of those, copies the pool covers — the deck's group under [`Compare::Collection`], the
    /// live list's copies of the exact printing and finish under [`Compare::Theory`].
    pub owned: i64,
    /// `wanted − owned`.
    pub missing: i64,
    /// What the missing copies cost at the marketplace, summed over the priced ones.
    ///
    /// **`None` exactly when nothing on the measured list is priced**, which is the editor's rule
    /// and not "no missing copy is priced": a complete, priced deck is `Some(0.0)`, and so is a
    /// deck whose only missing copies are unpriced — beside a non-zero
    /// [`Self::unpriced_missing`].
    pub missing_cost: Option<f64>,
    /// Missing copies the marketplace has no price for — the widget's hint.
    pub unpriced_missing: i64,
}

/// One key of one deck's list: the copies it holds and what one costs.
struct Want {
    card_id: String,
    finish: String,
    wanted: i64,
    unit_price: Option<f64>,
}

/// Every answering deck's completion at `marketplace`, ascending by id.
pub fn deck_completion_for(
    conn: &Connection,
    marketplace: Marketplace,
    compare: Compare,
) -> Result<Vec<DeckCompletion>, String> {
    // Deferred, so it takes the read snapshot at the first statement and writes nothing — see the
    // module doc. No caller holds a transaction here.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let decks = measured_decks(&tx, compare)?;
    let mut wants = lists_by_deck(&tx, Some(marketplace), compare, compare.measured())?;
    // Theory's pool is the live list, read once for every deck. The price is not asked for: a
    // copy the deck already plays costs nothing to find.
    let mut sleeved = match compare {
        Compare::Theory => lists_by_deck(&tx, None, compare, LIVE)?,
        Compare::Collection => HashMap::new(),
    };
    let mut out = Vec::with_capacity(decks.len());
    for deck_id in decks {
        let wants = wants.remove(&deck_id).unwrap_or_default();
        let pool = if wants.is_empty() {
            HashMap::new()
        } else {
            match compare {
                Compare::Collection => crate::deck::owned_by_printing(&tx, deck_id)?,
                Compare::Theory => pool_of(sleeved.remove(&deck_id).unwrap_or_default()),
            }
        };
        out.push(measure(deck_id, compare.measured(), &wants, &pool));
    }
    Ok(out)
}

/// Every deck `compare` answers for, ascending by id.
fn measured_decks(conn: &Connection, compare: Compare) -> Result<Vec<i64>, String> {
    let sql = format!(
        "SELECT d.id FROM decks d WHERE {} ORDER BY d.id",
        compare.decks()
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The copies one list of every deck `compare` answers for holds, per `(card_id, finish)`, with
/// the key's price at `marketplace` — or no price at all when `marketplace` is `None`, which is
/// what Theory's pool asks for.
///
/// **The pile filter sits in the join**, `deck_values_for`'s arrangement: only active piles, and
/// only rows of `variant`. The price is a bare column beside the `sum()` — every row of a group
/// shares `dc.card_id` and `dc.finish`, and so the `cards` row and the price. `GROUP BY dc.finish`
/// groups the NULLs together; the key each group is measured under is [`crate::deck::entry_finish`]
/// of that finish and the printing's `finishes`, folded in Rust, so a group's price stays the one
/// its own rows are quoted at — and, on the pool side, [`pool_of`] sums two groups that fold to
/// one key.
fn lists_by_deck(
    conn: &Connection,
    marketplace: Option<Marketplace>,
    compare: Compare,
    variant: &str,
) -> Result<HashMap<i64, Vec<Want>>, String> {
    let price = marketplace.map_or_else(|| "NULL".to_owned(), crate::sorting::deck_card_price_expr);
    let sql = format!(
        "SELECT dc.deck_id, dc.card_id, dc.finish, c.finishes, sum(dc.quantity),
                {price}
           FROM decks d
           JOIN deck_categories cat
             ON cat.deck_id = d.id
            AND cat.is_active = 1
           JOIN deck_cards dc
             ON dc.category_id = cat.id
            AND dc.deck_id = d.id
            AND dc.variant = ?1
           LEFT JOIN cards c ON c.id = dc.card_id
          WHERE {decks}
          GROUP BY dc.deck_id, dc.card_id, dc.finish",
        decks = compare.decks()
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([variant], |r| {
            let finish: Option<String> = r.get(2)?;
            let finishes: Option<String> = r.get(3)?;
            Ok((
                r.get::<_, i64>(0)?,
                Want {
                    card_id: r.get(1)?,
                    finish: crate::deck::entry_finish(finish.as_deref(), finishes.as_deref()),
                    wanted: r.get(4)?,
                    unit_price: r.get(5)?,
                },
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut out: HashMap<i64, Vec<Want>> = HashMap::new();
    for row in rows {
        let (deck_id, want) = row.map_err(|e| e.to_string())?;
        out.entry(deck_id).or_default().push(want);
    }
    Ok(out)
}

/// One deck's live list as a pool, keyed as [`crate::deck::owned_by_printing`]'s map is.
///
/// **Summed rather than inserted**, `fold_by_played_finish`'s reason one table over: an unsaid
/// row and a `foil` row of one foil-only printing are two SQL groups and one key, and a pool that
/// kept only the second would let the plan's foil ask for a copy the live list already plays.
fn pool_of(list: Vec<Want>) -> HashMap<(String, String), i64> {
    let mut pool = HashMap::new();
    for held in list {
        *pool.entry((held.card_id, held.finish)).or_insert(0) += held.wanted;
    }
    pool
}

/// One deck's numbers from its wanted keys and its pool — `deckStats`' loop at the key's grain.
fn measure(
    deck_id: i64,
    list: &str,
    wants: &[Want],
    pool: &HashMap<(String, String), i64>,
) -> DeckCompletion {
    let mut row = DeckCompletion {
        deck_id,
        list: list.to_owned(),
        wanted: 0,
        owned: 0,
        missing: 0,
        missing_cost: None,
        unpriced_missing: 0,
    };
    let mut priced = false;
    let mut cost = 0.0;
    // Scarce, as `attribute_owned`'s is: two groups can share a key — an unsaid row and a `foil`
    // row of one foil-only printing — and one copy must not own a copy in each.
    let mut left = pool.clone();
    for want in wants {
        let remaining = left
            .entry((want.card_id.clone(), want.finish.clone()))
            .or_insert(0);
        // `attribute_owned`'s `min(remaining, quantity).max(0)`.
        let have = (*remaining).min(want.wanted).max(0);
        *remaining -= have;
        let short = want.wanted - have;
        row.wanted += want.wanted;
        row.owned += have;
        row.missing += short;
        match want.unit_price {
            Some(price) => {
                priced = true;
                cost += price * short as f64;
            }
            None => row.unpriced_missing += short,
        }
    }
    row.missing_cost = priced.then_some(cost);
    row
}

/// How many `deck_cards` rows carry a `needs_review` sentence — any deck, either list.
///
/// **`sync_engine/commands.rs:111`'s count for this one table**, so To review's row and the Needs
/// review panel it opens say one number. Not `sync_relay_status.reviewCount` itself: that sums six
/// tables into one figure and takes the write lock (spec §4.1).
pub fn review_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT count(*) FROM deck_cards WHERE needs_review IS NOT NULL",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    // deck.rs:6552-6585 (`seeded`) — the column set every deck test seeds `cards` with.
    /// Five printings, each there for one rule.
    ///
    /// * `bolt` sells in both finishes at two prices, so its NULL-finish row and its foil row are
    ///   two keys at two rates.
    /// * `angel` has **no price** anywhere — the unpriced printing.
    /// * `shiny` is foil-only: a NULL-finish row of it is priced through the chain at its foil
    ///   rate and keyed at `foil` — the finish it plays, `deck::entry_finish` — so the foil copy
    ///   filed in that deck's own group owns it. (It was keyed at `nonfoil` until issue #563's
    ///   follow-up, and the copy in the deck's own box owned nothing.)
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,power,toughness,prices,finishes,raw)
               VALUES
                 ('bolt','o-bolt','Lightning Bolt','m10','146','en','normal','common',
                  'Instant',NULL,NULL,'{"usd":"2.00","usd_foil":"10.00"}',
                  '["nonfoil","foil"]','{}'),
                 ('ring','o-ring','Sol Ring','c21','263','en','normal','uncommon',
                  'Artifact',NULL,NULL,'{"usd":"3.00"}','["nonfoil"]','{}'),
                 ('angel','o-angel','Serra Angel','lea','175','en','normal','uncommon',
                  'Creature — Angel','4','4',NULL,'["nonfoil"]','{}'),
                 ('bird','o-bird','Birds of Paradise','m12','165','en','normal','rare',
                  'Creature — Bird','0','1','{"usd":"0.50"}','["nonfoil"]','{}'),
                 ('shiny','o-shiny','Shiny Relic','sld','900','en','normal','rare',
                  'Artifact',NULL,NULL,'{"usd":null,"usd_foil":"7.00"}','["foil"]','{}');"#,
        )
        .unwrap();
        conn
    }

    // deck.rs:1797 (`create_deck`) — a deck that is not virtual is born with its group, and with
    // the four predefined piles, Sideboard active and Maybeboard off (schema.rs:989-994).
    fn make_deck(conn: &Connection, name: &str, theory: bool, virtual_only: bool) -> i64 {
        crate::deck::create_deck(
            conn,
            &crate::deck::DeckInput {
                name: name.to_owned(),
                format_key: "commander".to_owned(),
                theory_enabled: Some(theory),
                virtual_only: Some(virtual_only),
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    // deck.rs's `main_of` — a pile by name in one list, made on first ask. A pile belongs to
    // one list since user schema v53, so a theory card needs the plan's own pile.
    fn pile(conn: &Connection, deck_id: i64, variant: &str, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, variant, name).unwrap()
    }

    // deck.rs's `kind_of` — a seeded live pile by kind.
    fn seeded_pile(conn: &Connection, deck_id: i64, kind: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_categories
              WHERE deck_id = ?1 AND variant = 'live' AND kind = ?2",
            params![deck_id, kind],
            |r| r.get(0),
        )
        .unwrap()
    }

    // deck.rs:6612-6652 (`add`, `add_foil`) — the app's own card write, at an explicit pile.
    fn put(
        conn: &Connection,
        deck_id: i64,
        pile: i64,
        variant: &str,
        card: &str,
        finish: Option<&str>,
        quantity: i64,
    ) {
        crate::deck::add_card(
            conn,
            deck_id,
            card,
            Some(pile),
            None,
            variant,
            finish,
            quantity,
        )
        .unwrap();
    }

    // deck.rs:6685-6691 (`file_into_group`) — added at the root, then refiled. **The root must
    // not already hold this grain**: `add_entry` folds onto `COLLECTION_GRAIN`, so the add would
    // merge into that row and the refile would carry both. The fixture below writes every
    // refiled copy before the loose ones for exactly that reason.
    fn copies(
        conn: &Connection,
        card: &str,
        finish: &str,
        quantity: i64,
        folder: Option<i64>,
    ) -> i64 {
        let entry = crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card.to_owned(),
                finish: finish.to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        match folder {
            Some(folder) => {
                crate::collection_folders::refile_entry(conn, entry, Some(folder))
                    .unwrap()
                    .id
            }
            None => entry,
        }
    }

    // collection.rs:88-133 (`EntryInput::folder_id`) — straight into one of the reader's own
    // folders, the only kind `add_entry` files into.
    fn filed(conn: &Connection, card: &str, finish: &str, quantity: i64, folder: i64) {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card.to_owned(),
                finish: finish.to_owned(),
                quantity,
                folder_id: Some(folder),
                ..Default::default()
            },
        )
        .unwrap();
    }

    // deck.rs:1341 (`deck_group`).
    fn group(conn: &Connection, deck_id: i64) -> i64 {
        crate::deck::deck_group(conn, deck_id)
            .unwrap()
            .expect("a deck that is not virtual has a group")
    }

    // deck.rs:6746-6753 (`removed_group`).
    fn removed(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// What the deck editor draws for one deck: `get_deck` (deck.rs:4914), then `deckStats`'
    /// copies-and-money loop (src/features/decks/DeckStats.tsx:455-509) — active rows only,
    /// `have = min(owned, quantity)`, a missing copy at its row's `unitPrice`, and the money
    /// `null` exactly when no counted row is priced. `unpriced_missing` is the missing copies of
    /// the unpriced rows, which is the contract's field and one step narrower than `unpriced`.
    struct Editor {
        wanted: i64,
        owned: i64,
        missing: i64,
        missing_cost: Option<f64>,
        unpriced_missing: i64,
    }

    fn editor(conn: &Connection, deck_id: i64, list: &str, market: Marketplace) -> Editor {
        let detail = crate::deck::get_deck(conn, deck_id, list, market)
            .unwrap()
            .expect("the deck is there");
        let (mut wanted, mut owned, mut missing, mut unpriced_missing, mut priced) =
            (0, 0, 0, 0, 0);
        let mut cost = 0.0;
        for card in detail.cards.iter().filter(|c| c.category_active) {
            let have = card.owned_quantity.min(card.quantity);
            let short = card.quantity - have;
            wanted += card.quantity;
            owned += have;
            missing += short;
            match card.unit_price {
                Some(price) => {
                    priced += card.quantity;
                    cost += price * short as f64;
                }
                None => unpriced_missing += short,
            }
        }
        Editor {
            wanted,
            owned,
            missing,
            missing_cost: (priced > 0).then_some(cost),
            unpriced_missing,
        }
    }

    /// Two sums of the same money taken in different orders, so equal to the float and no finer.
    fn assert_money(got: Option<f64>, want: Option<f64>, what: &str) {
        match (got, want) {
            (Some(g), Some(w)) => assert!((g - w).abs() < 1e-9, "{what}: {g} against {w}"),
            _ => assert_eq!(got, want, "{what}"),
        }
    }

    /// **The fence (spec §3.1), in [`Compare::Collection`].** For every deck, this read's
    /// `missing` and `missing_cost` are what `get_deck` of the **live** list plus the editor's
    /// arithmetic answer — over a live deck, a theory deck (measured on its live list since issue
    /// #600, its plan ignored), a foil and a NULL-finish row of one printing, a foil-only printing
    /// on a NULL row, an inactive pile, a sideboard sharing the main pile's pool, a copy in
    /// `Recently removed`, copies in another deck's group, a locked folder, an unpriced printing,
    /// an empty deck and a virtual one. The numbers are pinned as well as compared, because a
    /// comparison alone passes over a fixture that built something other than what it says.
    #[test]
    fn every_deck_answers_what_its_editor_draws() {
        let conn = seeded();
        let a = make_deck(&conn, "Live", false, false);
        let b = make_deck(&conn, "Plan", true, false);
        let c = make_deck(&conn, "Other", false, false);
        let v = make_deck(&conn, "Proxies", false, true);
        let e = make_deck(&conn, "Empty", false, false);

        // A — the live list, measured against its own group.
        let a_main = pile(&conn, a, LIVE, "Main deck");
        let a_side = seeded_pile(&conn, a, "side");
        let a_cuts = pile(&conn, a, LIVE, "Cuts");
        crate::deck_meta::set_category_active(&conn, a_cuts, false).unwrap();
        put(&conn, a, a_main, LIVE, "bolt", None, 3);
        put(&conn, a, a_main, LIVE, "bolt", Some("foil"), 2);
        put(&conn, a, a_main, LIVE, "ring", None, 1);
        put(&conn, a, a_main, LIVE, "angel", None, 2);
        put(&conn, a, a_main, LIVE, "shiny", None, 1);
        put(&conn, a, a_side, LIVE, "bolt", None, 1);
        put(&conn, a, a_side, LIVE, "ring", None, 1);
        // Switched off: counts toward nothing and takes nothing from the pool.
        put(&conn, a, a_cuts, LIVE, "bird", None, 4);
        put(&conn, a, a_cuts, LIVE, "bolt", None, 1);

        // B — a deck with a plan, measured on its one live row: the plan is Theory's question.
        let b_main = pile(&conn, b, THEORY, "Main deck");
        let b_live = pile(&conn, b, LIVE, "Main deck");
        put(&conn, b, b_main, THEORY, "bolt", None, 4);
        put(&conn, b, b_main, THEORY, "ring", None, 1);
        put(&conn, b, b_main, THEORY, "angel", None, 1);
        put(&conn, b, b_main, THEORY, "bolt", Some("foil"), 1);
        put(&conn, b, b_live, LIVE, "bird", None, 1);

        // C — complete, and its group holds copies no other deck may count.
        let c_main = pile(&conn, c, LIVE, "Main deck");
        put(&conn, c, c_main, LIVE, "ring", None, 2);

        // V — virtual, and answers no row whatever it lists.
        let v_main = pile(&conn, v, LIVE, "Main deck");
        put(&conn, v, v_main, LIVE, "bird", None, 2);

        // The collection: every refiled copy first, then the reader's folders, then the root.
        copies(&conn, "bolt", "nonfoil", 2, Some(group(&conn, a)));
        copies(&conn, "bolt", "foil", 1, Some(group(&conn, a)));
        copies(&conn, "ring", "nonfoil", 1, Some(group(&conn, a)));
        copies(&conn, "bird", "nonfoil", 1, Some(group(&conn, a)));
        // In A's own box, and the finish A's unsaid `shiny` row plays: foil is all it is sold in.
        copies(&conn, "shiny", "foil", 1, Some(group(&conn, a)));
        copies(&conn, "bolt", "nonfoil", 1, Some(group(&conn, b)));
        copies(&conn, "ring", "nonfoil", 5, Some(group(&conn, c)));
        copies(&conn, "bolt", "foil", 3, Some(group(&conn, c)));
        copies(&conn, "bolt", "nonfoil", 1, Some(removed(&conn)));
        let binder = crate::collection_folders::create_folder(&conn, None, "Binder")
            .unwrap()
            .id;
        filed(&conn, "bolt", "nonfoil", 1, binder);
        // Filed before it is locked, so the add is not the thing under test.
        let vault = crate::collection_folders::create_folder(&conn, None, "Vault")
            .unwrap()
            .id;
        filed(&conn, "ring", "nonfoil", 2, vault);
        filed(&conn, "bolt", "nonfoil", 5, vault);
        crate::collection_folders::set_folder_locked(&conn, vault, true).unwrap();
        copies(&conn, "angel", "nonfoil", 1, None);

        let rows = deck_completion_for(&conn, Marketplace::Tcgplayer, Compare::Collection).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.deck_id).collect::<Vec<_>>(),
            [a, b, c, e],
            "every deck but the virtual one, by id"
        );
        let row = |id: i64| rows.iter().find(|r| r.deck_id == id).unwrap();

        // A: wanted 4+2+2+2+1 over its active piles; its group owns 2 Bolts, 1 foil Bolt, 1 Sol
        // Ring and the foil Shiny Relic its unsaid row can only be. Recently removed, the binder
        // and the root are not its box.
        let got = row(a);
        assert_eq!(
            (
                got.list.as_str(),
                got.wanted,
                got.owned,
                got.missing,
                got.unpriced_missing
            ),
            ("live", 11, 5, 6, 2)
        );
        assert_money(got.missing_cost, Some(17.0), "A: 2×2.00 + 1×10.00 + 1×3.00");

        // B: its live list is one Birds of Paradise, and its own group holds a Bolt and no Bird —
        // A's group has one, which is not B's box. Its seven planned copies are not counted, and
        // neither is the wider pool the plan was measured against before issue #600 (its group,
        // Recently removed, the binder and the root owned four of them).
        let got = row(b);
        assert_eq!(
            (
                got.list.as_str(),
                got.wanted,
                got.owned,
                got.missing,
                got.unpriced_missing
            ),
            ("live", 1, 0, 1, 0)
        );
        assert_money(got.missing_cost, Some(0.5), "B: 1×0.50");

        // C: complete, and priced, so the money is a zero rather than nothing.
        let got = row(c);
        assert_eq!(
            (
                got.list.as_str(),
                got.wanted,
                got.owned,
                got.missing,
                got.unpriced_missing
            ),
            ("live", 2, 2, 0, 0)
        );
        assert_money(got.missing_cost, Some(0.0), "C");

        // E: a deck with nothing in it is a row of zeros, and prices nothing.
        let got = row(e);
        assert_eq!(
            (
                got.list.as_str(),
                got.wanted,
                got.owned,
                got.missing,
                got.unpriced_missing
            ),
            ("live", 0, 0, 0, 0)
        );
        assert_eq!(got.missing_cost, None);

        // And the fence itself, at a shop that quotes these cards and at one that quotes none —
        // every row against the editor's **Actual** tab, the theory deck's included.
        for market in [Marketplace::Tcgplayer, Marketplace::Cardmarket] {
            for got in deck_completion_for(&conn, market, Compare::Collection).unwrap() {
                let what = format!("deck {} at {market:?}", got.deck_id);
                assert_eq!(got.list, LIVE, "{what}");
                let want = editor(&conn, got.deck_id, LIVE, market);
                assert_eq!(
                    (got.wanted, got.owned, got.missing, got.unpriced_missing),
                    (want.wanted, want.owned, want.missing, want.unpriced_missing),
                    "{what}"
                );
                assert_money(got.missing_cost, want.missing_cost, &what);
            }
        }
    }

    /// **An unsaid row and a `foil` row of one foil-only printing are one key with one pool**, so
    /// one foil copy owns one of the two, never one each. `attribute_owned` walks a scarce pool
    /// down the read; a per-key `min(wanted, pool)` taken once per SQL group would have handed the
    /// same copy to both rows the moment they stopped being two keys.
    #[test]
    fn two_spellings_of_one_foil_only_printing_share_one_pool() {
        let conn = seeded();
        let d = make_deck(&conn, "Bling", false, false);
        let main = pile(&conn, d, LIVE, "Main deck");
        let side = seeded_pile(&conn, d, "side");
        put(&conn, d, main, LIVE, "shiny", None, 1);
        put(&conn, d, side, LIVE, "shiny", Some("foil"), 1);
        copies(&conn, "shiny", "foil", 1, Some(group(&conn, d)));

        let got = deck_completion_for(&conn, Marketplace::Tcgplayer, Compare::Collection).unwrap();
        let got = got.iter().find(|r| r.deck_id == d).unwrap();
        assert_eq!((got.wanted, got.owned, got.missing), (2, 1, 1));
        assert_money(got.missing_cost, Some(7.0), "one foil Shiny Relic to buy");
        let want = editor(&conn, d, LIVE, Marketplace::Tcgplayer);
        assert_eq!(
            (got.wanted, got.owned, got.missing),
            (want.wanted, want.owned, want.missing),
            "and the editor agrees"
        );
    }

    /// **The fence in [`Compare::Theory`]: every plan against its own actual list, and
    /// [`crate::deck_theory::theory_diff`] is the other side of it.** For every row, `missing` is
    /// the Compare dialog's card lines summed, `unpriced_missing` its unpriced ones, and
    /// `missing_cost` its priced ones at their own price — `None` only where the diff has no
    /// priced line either. Over a planned Bolt the live list plays in full and then some, a foil
    /// Bolt it plays only in the *regular* finish, a foil-only printing planned unsaid and played
    /// as `foil`, a Sol Ring sleeved only in a switched-off pile, a Serra Angel (unpriced) half
    /// played from the sideboard, a switched-off plan pile, a Treasure planned as a token, a
    /// virtual deck with a plan, a plan with nothing priced on it, and a deck with no plan
    /// switched on. Pinned as well as compared, for the Collection fence's reason.
    ///
    /// The collection is filled to show it is not asked: T's own group holds every foil Bolt the
    /// plan wants, and they own nothing here.
    #[test]
    fn every_plan_answers_what_its_compare_dialog_lists() {
        let conn = seeded();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,type_line,power,toughness,prices,finishes,raw)
               VALUES ('treasure','o-treasure','Treasure','tmom','12','en','token','common',
                       'Token Artifact — Treasure',NULL,NULL,'{"usd":"0.25"}','["nonfoil"]',
                       '{}');"#,
        )
        .unwrap();
        let t = make_deck(&conn, "Plan", true, false);
        let w = make_deck(&conn, "Proxy plan", true, true);
        let n = make_deck(&conn, "No plan", false, false);
        let u = make_deck(&conn, "Unpriced plan", true, false);

        // T — the plan, and an actual list that plays part of it.
        let t_plan = pile(&conn, t, THEORY, "Main deck");
        let t_plan_cuts = pile(&conn, t, THEORY, "Cuts");
        crate::deck_meta::set_category_active(&conn, t_plan_cuts, false).unwrap();
        put(&conn, t, t_plan, THEORY, "bolt", None, 4);
        put(&conn, t, t_plan, THEORY, "bolt", Some("foil"), 2);
        put(&conn, t, t_plan, THEORY, "ring", None, 1);
        put(&conn, t, t_plan, THEORY, "angel", None, 2);
        put(&conn, t, t_plan, THEORY, "shiny", None, 1);
        // A token printing handed to `add_card` is filed as a token entry, never a deck card —
        // so it is a line of the diff (`is_token`) and wants nothing here.
        put(&conn, t, t_plan, THEORY, "treasure", None, 3);
        // Switched off: the plan does not ask for these.
        put(&conn, t, t_plan_cuts, THEORY, "bird", None, 3);
        let t_live = pile(&conn, t, LIVE, "Main deck");
        let t_side = seeded_pile(&conn, t, "side");
        let t_live_cuts = pile(&conn, t, LIVE, "Cuts");
        crate::deck_meta::set_category_active(&conn, t_live_cuts, false).unwrap();
        // Five regular Bolts: four answer the plan's four, and the fifth is not a foil one.
        put(&conn, t, t_live, LIVE, "bolt", None, 5);
        // The foil the plan's unsaid Shiny Relic can only be.
        put(&conn, t, t_live, LIVE, "shiny", Some("foil"), 1);
        put(&conn, t, t_side, LIVE, "angel", None, 1);
        // Not played: a switched-off pile sleeves nothing.
        put(&conn, t, t_live_cuts, LIVE, "ring", None, 1);
        // Played and not planned — a cut the plan made, and no line.
        put(&conn, t, t_live, LIVE, "bird", None, 2);
        copies(&conn, "bolt", "foil", 2, Some(group(&conn, t)));

        // W — virtual (`1/1`, which `create_deck` does not cross-check), and still answers.
        let w_plan = pile(&conn, w, THEORY, "Main deck");
        let w_live = pile(&conn, w, LIVE, "Main deck");
        put(&conn, w, w_plan, THEORY, "ring", None, 2);
        put(&conn, w, w_plan, THEORY, "angel", None, 1);
        put(&conn, w, w_live, LIVE, "ring", None, 1);

        // N — no plan switched on, so no row, whatever theory rows it keeps.
        let n_plan = pile(&conn, n, THEORY, "Main deck");
        let n_live = pile(&conn, n, LIVE, "Main deck");
        put(&conn, n, n_plan, THEORY, "bolt", None, 1);
        put(&conn, n, n_live, LIVE, "ring", None, 1);

        // U — a plan with nothing priced on it, and nothing sleeved.
        let u_plan = pile(&conn, u, THEORY, "Main deck");
        put(&conn, u, u_plan, THEORY, "angel", None, 1);

        let rows = deck_completion_for(&conn, Marketplace::Tcgplayer, Compare::Theory).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.deck_id).collect::<Vec<_>>(),
            [t, w, u],
            "every deck with a plan, the virtual one included, by id"
        );
        let row = |id: i64| rows.iter().find(|r| r.deck_id == id).unwrap();
        let numbers = |got: &DeckCompletion| {
            (
                got.list.clone(),
                got.wanted,
                got.owned,
                got.missing,
                got.unpriced_missing,
            )
        };

        // T: wanted 4+2+1+2+1 over the active plan pile. Owned: 4 regular Bolts, 0 foil Bolts,
        // 0 Sol Rings, 1 Angel, 1 Shiny Relic. Missing 2 foil Bolts, 1 Sol Ring and 1 Angel —
        // the Angel unpriced. The Treasure and the switched-off Birds want nothing.
        assert_eq!(numbers(row(t)), (THEORY.to_owned(), 10, 6, 4, 1));
        assert_money(row(t).missing_cost, Some(23.0), "T: 2×10.00 + 1×3.00");

        // W: two Sol Rings and an Angel planned, one Sol Ring sleeved.
        assert_eq!(numbers(row(w)), (THEORY.to_owned(), 3, 1, 2, 1));
        assert_money(row(w).missing_cost, Some(3.0), "W: 1×3.00");

        // U: nothing on the plan is priced, so the money is nothing rather than a zero.
        assert_eq!(numbers(row(u)), (THEORY.to_owned(), 1, 0, 1, 1));
        assert_eq!(row(u).missing_cost, None);

        // The fence is about something: T's diff carries a token line, and it counts for nothing.
        let diff = crate::deck_theory::theory_diff(&conn, t, Marketplace::Tcgplayer).unwrap();
        assert!(
            diff.iter()
                .any(|r| r.is_token && r.card_id == "treasure" && r.quantity == 3),
            "the planned Treasures are a token line: {diff:?}"
        );

        for market in [Marketplace::Tcgplayer, Marketplace::Cardmarket] {
            for got in deck_completion_for(&conn, market, Compare::Theory).unwrap() {
                let what = format!("deck {} at {market:?}", got.deck_id);
                assert_eq!(got.list, THEORY, "{what}");
                assert_eq!(got.owned + got.missing, got.wanted, "{what}");
                let diff = crate::deck_theory::theory_diff(&conn, got.deck_id, market).unwrap();
                let cards = diff.iter().filter(|r| !r.is_token);
                let missing: i64 = cards.clone().map(|r| r.quantity).sum();
                let unpriced: i64 = cards
                    .clone()
                    .filter(|r| r.unit_price.is_none())
                    .map(|r| r.quantity)
                    .sum();
                let priced: Vec<f64> = cards
                    .filter_map(|r| r.unit_price.map(|p| p * r.quantity as f64))
                    .collect();
                assert_eq!(
                    (got.missing, got.unpriced_missing),
                    (missing, unpriced),
                    "{what}: {diff:?}"
                );
                match got.missing_cost {
                    Some(cost) => assert_money(Some(cost), Some(priced.iter().sum()), &what),
                    None => assert!(priced.is_empty(), "{what}: nothing priced, {diff:?}"),
                }
            }
        }
    }

    /// The widget's word, forgiving: only `theory` is Theory, and anything else — nothing at all,
    /// the default's own name, a word from a newer build — compares against the collection.
    #[test]
    fn compare_reads_theory_and_nothing_else_as_theory() {
        assert_eq!(Compare::from_opt(None), Compare::Collection);
        assert_eq!(Compare::from_opt(Some("collection")), Compare::Collection);
        assert_eq!(Compare::from_opt(Some("theory")), Compare::Theory);
        assert_eq!(Compare::from_opt(Some("bogus")), Compare::Collection);
    }

    /// The wire names the page reads — `ipc.test.ts`' struct table cannot see whether serde
    /// actually camel-cases.
    #[test]
    fn a_completion_serialises_under_the_names_the_page_reads() {
        let wire = serde_json::to_value(DeckCompletion {
            deck_id: 7,
            list: "theory".into(),
            wanted: 100,
            owned: 96,
            missing: 4,
            missing_cost: None,
            unpriced_missing: 1,
        })
        .unwrap();
        assert_eq!(
            wire,
            serde_json::json!({
                "deckId": 7, "list": "theory", "wanted": 100, "owned": 96, "missing": 4,
                "missingCost": null, "unpricedMissing": 1
            })
        );
    }

    /// **To review's deck row** (spec §4.1): every `deck_cards` row carrying a sentence, either
    /// list, any deck — `sync_engine/commands.rs:111`'s per-table count for `deck_cards`, so the
    /// widget and the Needs review panel it opens agree. A flagged binder row is the collection's
    /// count and not this one.
    #[test]
    fn the_review_count_counts_flagged_deck_rows_and_nothing_else() {
        let conn = seeded();
        assert_eq!(review_count(&conn).unwrap(), 0, "an empty database");
        let live = make_deck(&conn, "Live", false, false);
        let plan = make_deck(&conn, "Plan", true, false);
        let live_main = pile(&conn, live, LIVE, "Main deck");
        let plan_main = pile(&conn, plan, THEORY, "Main deck");
        put(&conn, live, live_main, LIVE, "bolt", None, 1);
        put(&conn, live, live_main, LIVE, "ring", None, 1);
        put(&conn, plan, plan_main, THEORY, "angel", None, 1);
        assert_eq!(
            review_count(&conn).unwrap(),
            0,
            "a row with no sentence is not flagged"
        );

        conn.execute(
            "UPDATE deck_cards SET needs_review = 'That printing left the card database.'
              WHERE card_id IN ('bolt', 'angel')",
            [],
        )
        .unwrap();
        assert_eq!(
            review_count(&conn).unwrap(),
            2,
            "a flagged row in either list"
        );

        let entry = copies(&conn, "ring", "nonfoil", 1, None);
        conn.execute(
            "UPDATE collection_entries SET needs_review = 'Folded.' WHERE id = ?1",
            params![entry],
        )
        .unwrap();
        assert_eq!(
            review_count(&conn).unwrap(),
            2,
            "a flagged binder row is not a deck row"
        );
    }
}
