//! The home page's **Deck completion** read: for every deck, how many copies its measured list
//! wants, how many the reader holds, and what the rest would cost — and, at the foot of the file,
//! **To review**'s count of deck rows flagged for review ([`review_count`]).
//!
//! **Owned is exactly what the deck editor calls owned**, rule for rule — a widget reading
//! *4 missing* over a deck that opens reading *6 missing* is a bug report (spec
//! `2026-09-26-home-widgets-round-two-design.md` §3.1):
//!
//! * A deck without a theory plan measures its **live** list against its own group,
//!   [`crate::deck::owned_by_printing`]. A deck with `theory_enabled` measures its **theory**
//!   list against every copy it could be built from, [`crate::deck::available_by_printing`] —
//!   the same choice `get_deck` makes by variant.
//! * **Every active pile counts**, sideboard and companion included: this is `DeckStats`'
//!   `missing`, and deliberately not [`crate::deck::deck_values_for`]'s narrower
//!   main + commander + maybe.
//! * The key is `(card_id, finish)`, a NULL deck finish meaning [`crate::schema::FINISHES`]`[0]`.
//!   `attribute_owned` hands a scarce pool down the read order, so summed over one key it owns
//!   `min(Σ wanted, pool)` — which is what this read computes directly.
//! * A missing copy costs its row's own price, [`crate::sorting::deck_card_price_expr`], which
//!   depends on the key alone. `missing_cost` is `None` exactly when nothing on the measured list
//!   is priced — `DeckStats`' `missingPrice`, `priced === 0 ? null : …`.
//!
//! **The pools are read through `deck.rs`'s own two functions, one statement per deck, and not
//! restated as one correlated statement over every deck.** [`crate::collection_source`]'s
//! `ForDeck` arm interpolates a literal deck id, so a single statement would need a second
//! spelling of "what this deck can use" — the drift that module exists to prevent. What is
//! aggregated in SQL is what can be: the wanted copies and the price per key, in one statement.
//!
//! **Virtual decks answer no row** — they hold nothing by definition, and 0% of every deck is not
//! a finding. **Tokens never count**: they are `deck_tokens`, which nothing here reads. A deck
//! with nothing on its measured list answers a row of zeros and reads no pool at all.
//!
//! Connection in, DTO out, no clock and no network, so it answers in a browser as on the desktop.

use crate::sorting::Marketplace;
#[cfg(not(target_family = "wasm"))]
use crate::sync::AppState;
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// `deck_cards.variant` for the list that is sleeved up.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// `deck_cards.variant` for the plan.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];
/// What a NULL deck-row finish is on the collection side — `attribute_owned`'s translation.
const REGULAR: &str = crate::schema::FINISHES[0];

/// One deck's completion.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckCompletion {
    pub deck_id: i64,
    /// `live` | `theory` — which list was measured.
    pub list: String,
    /// Copies the measured list asks for, active piles only.
    pub wanted: i64,
    /// Of those, copies the pool covers.
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

/// One key of one deck's measured list: the copies wanted and what one costs.
struct Want {
    card_id: String,
    finish: String,
    wanted: i64,
    unit_price: Option<f64>,
}

/// Every non-virtual deck's completion at `marketplace`, ascending by id.
pub fn deck_completion_for(
    conn: &Connection,
    marketplace: Marketplace,
) -> Result<Vec<DeckCompletion>, String> {
    let decks = measured_decks(conn)?;
    let mut wants = wanted_by_deck(conn, marketplace)?;
    let mut out = Vec::with_capacity(decks.len());
    for (deck_id, theory) in decks {
        let wants = wants.remove(&deck_id).unwrap_or_default();
        // The editor's one line (`get_deck`, deck.rs:4932-4936): the list picks the pool.
        let pool = if wants.is_empty() {
            HashMap::new()
        } else if theory {
            crate::deck::available_by_printing(conn, deck_id)?
        } else {
            crate::deck::owned_by_printing(conn, deck_id)?
        };
        out.push(measure(deck_id, theory, &wants, &pool));
    }
    Ok(out)
}

/// Every deck this read answers for, and whether it measures its plan. `virtual_only = 0` also
/// drops the kindless `1/1` pair, which `deckKind.ts` reads as virtual.
fn measured_decks(conn: &Connection) -> Result<Vec<(i64, bool)>, String> {
    let mut stmt = conn
        .prepare("SELECT id, theory_enabled FROM decks WHERE virtual_only = 0 ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The copies every deck's measured list wants, per `(card_id, finish)`, with the key's price.
///
/// **The pile filter sits in the join**, `deck_values_for`'s arrangement: only active piles, and
/// only rows of the list the deck is measured by. The price is a bare column beside the `sum()`
/// — every row of a group shares `dc.card_id` and `dc.finish`, and so the `cards` row and the
/// price. `GROUP BY dc.finish` groups the NULLs together, which is the regular copy's one key.
fn wanted_by_deck(
    conn: &Connection,
    marketplace: Marketplace,
) -> Result<HashMap<i64, Vec<Want>>, String> {
    let price = crate::sorting::deck_card_price_expr(marketplace);
    let sql = format!(
        "SELECT dc.deck_id, dc.card_id, coalesce(dc.finish, '{REGULAR}'), sum(dc.quantity),
                {price}
           FROM decks d
           JOIN deck_categories cat
             ON cat.deck_id = d.id
            AND cat.is_active = 1
           JOIN deck_cards dc
             ON dc.category_id = cat.id
            AND dc.deck_id = d.id
            AND dc.variant = CASE WHEN d.theory_enabled = 1 THEN '{THEORY}' ELSE '{LIVE}' END
           LEFT JOIN cards c ON c.id = dc.card_id
          WHERE d.virtual_only = 0
          GROUP BY dc.deck_id, dc.card_id, dc.finish"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                Want {
                    card_id: r.get(1)?,
                    finish: r.get(2)?,
                    wanted: r.get(3)?,
                    unit_price: r.get(4)?,
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

/// One deck's numbers from its wanted keys and its pool — `deckStats`' loop at the key's grain.
fn measure(
    deck_id: i64,
    theory: bool,
    wants: &[Want],
    pool: &HashMap<(String, String), i64>,
) -> DeckCompletion {
    let mut row = DeckCompletion {
        deck_id,
        list: if theory { THEORY } else { LIVE }.to_owned(),
        wanted: 0,
        owned: 0,
        missing: 0,
        missing_cost: None,
        unpriced_missing: 0,
    };
    let mut priced = false;
    let mut cost = 0.0;
    for want in wants {
        let held = pool
            .get(&(want.card_id.clone(), want.finish.clone()))
            .copied()
            .unwrap_or(0);
        // `attribute_owned`'s `min(remaining, quantity).max(0)`, summed over the key.
        let have = held.min(want.wanted).max(0);
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

/// Every deck's completion, for the home page. **Read-only** connection, blocking pool, as every
/// read in this app is — [`crate::deck::deck_values`]' shape exactly, marketplace and fallback
/// included: anything this build does not recognise quotes TCGplayer rather than failing.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_completion(
    state: tauri::State<'_, Arc<AppState>>,
    marketplace: Option<String>,
) -> Result<Vec<DeckCompletion>, String> {
    let state = state.inner().clone();
    let marketplace = Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        deck_completion_for(&crate::sync::lock_db_read(&state), marketplace)
    })
    .await
    .map_err(|e| format!("the deck completion could not be read: {e}"))?
}

/// How many `deck_cards` rows carry a `needs_review` sentence — any deck, either list.
///
/// **`sync_engine/commands.rs:111`'s count for this one table**, so To review's row and the Needs
/// review panel it opens say one number. Not `sync_relay_status.reviewCount` itself: that sums six
/// tables into one figure, is desktop-only and takes the write lock (spec §4.1).
pub fn review_count(conn: &Connection) -> Result<i64, String> {
    conn.query_row(
        "SELECT count(*) FROM deck_cards WHERE needs_review IS NOT NULL",
        [],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// To review's deck-card count. **Read-only** connection, blocking pool.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn deck_review_count(state: tauri::State<'_, Arc<AppState>>) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || review_count(&crate::sync::lock_db_read(&state)))
        .await
        .map_err(|e| format!("the deck cards to review could not be counted: {e}"))?
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
    ///   rate and keyed at `nonfoil`, so the foil copy filed in that deck's own group does not own
    ///   it — the one copy the deck could reach, in the one finish its row does not ask for.
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

    // deck.rs:6605-6607 (`main_of`) — a pile by name, made on first ask.
    fn pile(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, name).unwrap()
    }

    // deck.rs:6590-6597 (`kind_of`) — a seeded pile by kind.
    fn seeded_pile(conn: &Connection, deck_id: i64, kind: &str) -> i64 {
        conn.query_row(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND kind = ?2",
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

    /// **The fence (spec §3.1).** For every deck, this read's `missing` and `missing_cost` are what
    /// `get_deck` plus the editor's arithmetic answer — over a live deck, a theory deck, a foil
    /// and a NULL-finish row of one printing, a foil-only printing on a NULL row, an inactive
    /// pile, a sideboard sharing the main pile's pool, a copy in `Recently removed`, copies in
    /// another deck's group, a locked folder, an unpriced printing, an empty deck and a virtual
    /// one. The numbers are pinned as well as compared, because a comparison alone passes over a
    /// fixture that built something other than what it says.
    #[test]
    fn every_deck_answers_what_its_editor_draws() {
        let conn = seeded();
        let a = make_deck(&conn, "Live", false, false);
        let b = make_deck(&conn, "Plan", true, false);
        let c = make_deck(&conn, "Other", false, false);
        let v = make_deck(&conn, "Proxies", false, true);
        let e = make_deck(&conn, "Empty", false, false);

        // A — the live list, measured against its own group.
        let a_main = pile(&conn, a, "Main deck");
        let a_side = seeded_pile(&conn, a, "side");
        let a_cuts = pile(&conn, a, "Cuts");
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

        // B — the plan is measured; its one live row is not.
        let b_main = pile(&conn, b, "Main deck");
        put(&conn, b, b_main, THEORY, "bolt", None, 4);
        put(&conn, b, b_main, THEORY, "ring", None, 1);
        put(&conn, b, b_main, THEORY, "angel", None, 1);
        put(&conn, b, b_main, THEORY, "bolt", Some("foil"), 1);
        put(&conn, b, b_main, LIVE, "bird", None, 1);

        // C — complete, and its group holds copies B may not count.
        let c_main = pile(&conn, c, "Main deck");
        put(&conn, c, c_main, LIVE, "ring", None, 2);

        // V — virtual, and answers no row whatever it lists.
        let v_main = pile(&conn, v, "Main deck");
        put(&conn, v, v_main, LIVE, "bird", None, 2);

        // The collection: every refiled copy first, then the reader's folders, then the root.
        copies(&conn, "bolt", "nonfoil", 2, Some(group(&conn, a)));
        copies(&conn, "bolt", "foil", 1, Some(group(&conn, a)));
        copies(&conn, "ring", "nonfoil", 1, Some(group(&conn, a)));
        copies(&conn, "bird", "nonfoil", 1, Some(group(&conn, a)));
        // In A's own box and in the wrong finish: A's `shiny` row names none, which is `nonfoil`.
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

        let rows = deck_completion_for(&conn, Marketplace::Tcgplayer).unwrap();
        assert_eq!(
            rows.iter().map(|r| r.deck_id).collect::<Vec<_>>(),
            [a, b, c, e],
            "every deck but the virtual one, by id"
        );
        let row = |id: i64| rows.iter().find(|r| r.deck_id == id).unwrap();

        // A: wanted 4+2+2+2+1 over its active piles; its group owns 2 Bolts, 1 foil Bolt and
        // 1 Sol Ring. Its foil Shiny Relic owns nothing — the row wants the regular copy — and
        // Recently removed, the binder and the root are not its box.
        let got = row(a);
        assert_eq!(
            (
                got.list.as_str(),
                got.wanted,
                got.owned,
                got.missing,
                got.unpriced_missing
            ),
            ("live", 11, 4, 7, 2)
        );
        assert_money(
            got.missing_cost,
            Some(24.0),
            "A: 2×2.00 + 1×10.00 + 1×3.00 + 1×7.00",
        );

        // B: its own group, Recently removed and the binder give 3 Bolts; the root gives the
        // Angel; A's and C's groups and the locked vault give nothing.
        let got = row(b);
        assert_eq!(
            (
                got.list.as_str(),
                got.wanted,
                got.owned,
                got.missing,
                got.unpriced_missing
            ),
            ("theory", 7, 4, 3, 0)
        );
        assert_money(got.missing_cost, Some(15.0), "B: 1×2.00 + 1×3.00 + 1×10.00");

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

        // And the fence itself, at a shop that quotes these cards and at one that quotes none.
        for market in [Marketplace::Tcgplayer, Marketplace::Cardmarket] {
            for got in deck_completion_for(&conn, market).unwrap() {
                let want = editor(&conn, got.deck_id, &got.list, market);
                let what = format!("deck {} at {market:?}", got.deck_id);
                assert_eq!(
                    (got.wanted, got.owned, got.missing, got.unpriced_missing),
                    (want.wanted, want.owned, want.missing, want.unpriced_missing),
                    "{what}"
                );
                assert_money(got.missing_cost, want.missing_cost, &what);
            }
        }
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
        let live_main = pile(&conn, live, "Main deck");
        let plan_main = pile(&conn, plan, "Main deck");
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
