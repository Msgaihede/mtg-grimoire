//! The theory list: the deck a user is building toward, and what stands between it and the
//! deck they have.
//!
//! Schema v8 gave `deck_cards` a `variant` — `live` is what is sleeved up, `theory` is the
//! plan — and widened [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) with it, so the two
//! lists are the same table and never the same row. Everything that makes a deck *real* reads
//! `live` and only `live`: the gallery's count, [`crate::deck::allocate_deck`]'s claims,
//! [`crate::deck::missing_to_wishlist`]'s shopping list. A plan is not a deck the user has.
//!
//! This module is the three things that are only true of the *pair*:
//!
//! * **Seeding.** Switching the theory list on for a deck that has none copies the live list
//!   into it, in the same transaction as the flag ([`crate::deck::update_deck`] is the caller).
//!   An empty theory list beside a full live one is not a blank page, it reads as data loss.
//! * **The difference.** [`theory_diff`] answers what theory holds that live does not — **one
//!   direction only**, because this is a shopping list rather than a reconciliation. What live
//!   has and theory dropped is a cut the user already made; it needs no row.
//! * **Buying it.** [`missing_to_wishlist`] turns that difference into wishes — the difference
//!   itself, with nothing netted out of it. See that function on why subtracting
//!   [`TheoryDiffRow::owned_spare`] there counts the live list twice.
//!
//! **Switching the theory list off keeps every row.** It hides a switch; it does not delete a
//! list. Nothing in this module or in `deck.rs` deletes a `theory` row except the ordinary card
//! writes the user makes against it.

use crate::sync::AppState;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// What is actually sleeved up — `DECK_VARIANTS[0]` by index, [`crate::deck`]'s discipline.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// What the deck is being built toward.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];

/// One card the theory list wants more of than the live list has.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TheoryDiffRow {
    /// The printing **the theory row names**, which is the printing the user would be buying.
    /// The grouping below is by oracle card, so this is the first theory row's printing when
    /// the same card is filed in two categories — see [`theory_diff`].
    pub card_id: String,
    pub name: String,
    /// The category the theory row is filed under — the pile this card is wanted *for*, which
    /// is what makes a shopping list readable ("2 more Ramp, 1 more Removal").
    pub category_name: String,
    /// How many more copies theory wants than live has. Always positive: a card live has as
    /// many of is not on this list at all, and one it has *more* of is a cut, not a purchase.
    pub quantity: i64,
    /// Nonfoil `usd` from this printing's `prices` blob — `DeckCardRow::unit_price_usd`'s rule,
    /// and never `cards.price_usd`, which is a display fallback chain and must not be summed.
    pub unit_price_usd: Option<f64>,
    pub set_code: String,
    pub collector_number: String,
    /// Copies of this oracle card the collection holds and **no built deck has claimed**.
    ///
    /// The number that turns "I need two more Sol Rings" into "and one of them is in the box
    /// already". Built is the whole of the test, and it is [`crate::deck::allocate_deck`]'s own
    /// rule read from the other end: a deck on a table has its cards, a deck being planned is
    /// planning with copies it may share with every other draft — so an unbuilt deck's claim
    /// does not make a copy unavailable to this plan.
    ///
    /// **A display field, and never a term in an arithmetic.** It is deliberately *not* netted
    /// out of [`Self::quantity`] anywhere, least of all by [`missing_to_wishlist`]: `quantity`
    /// has already subtracted the live list and this number has not — an unbuilt deck's own live
    /// copies read as spare here, which is right for a person and wrong for a subtraction. It is
    /// for a reader, beside a price.
    pub owned_spare: i64,
}

/// A diff row and the oracle id its group was built on.
///
/// The oracle id is deliberately **not** on [`TheoryDiffRow`]: the webview draws a printing and
/// a count and has no use for it, while [`missing_to_wishlist`] cannot do without it — a wish
/// is oracle-grained ("any printing"), because a shopping list is not a printing preference.
struct Grouped {
    oracle_id: Option<String>,
    row: TheoryDiffRow,
}

/// What makes two deck rows the same *card* for the purpose of a difference.
///
/// **Oracle id when there is one, the printing's id when there is not**, and the two are told
/// apart by a prefix so that a card id can never be mistaken for an oracle id — both are UUIDs
/// out of the same generator, and a bare string key would be one collision away from comparing
/// a printing with an unrelated card.
///
/// Comparing by oracle is the whole point of the direction this list is read in: needing a
/// second Sol Ring is not answered by owning a *different printing* of one already in the live
/// list. An orphan — a row whose printing has left `cards` — has no oracle id and falls back to
/// its own id, which is as far as the data can honestly go: two orphans of the same card look
/// like two cards, and the alternative is guessing.
fn group_key(oracle_id: Option<&str>, card_id: &str) -> String {
    match oracle_id {
        Some(oracle) => format!("o:{oracle}"),
        None => format!("c:{card_id}"),
    }
}

/// Every row of one deck, both variants, in the editor's own order — [`theory_diff`]'s input.
///
/// **Inactive categories are excluded from both sides**, which is the rule stated once in
/// `deck.rs` and read here for both halves of a comparison: an inactive category counts toward
/// nothing, so a card parked in the theory Maybeboard is not something the user has decided to
/// play, and a card parked in the *live* Maybeboard is not something the deck has. Filtering
/// one side and not the other is how a scratchpad would come to fill a shopping list.
const DIFF_SELECT: &str = "SELECT dc.variant, dc.card_id, dc.name, dc.set_code,
            dc.collector_number, dc.quantity, cat.name, c.oracle_id,
            CAST(json_extract(c.prices, '$.usd') AS REAL)
       FROM deck_cards dc
       JOIN deck_categories cat ON cat.id = dc.category_id
       LEFT JOIN cards c ON c.id = dc.card_id
      WHERE dc.deck_id = ?1 AND cat.is_active = 1
      ORDER BY cat.sort_order, cat.id, dc.name, dc.id";

/// Copies of one card the collection holds that no **built** deck has spoken for.
///
/// One statement rather than two so the subtraction cannot see two different moments of the
/// collection. `min(a.quantity, e.quantity)` is [`crate::deck::allocate_deck`]'s clamp, per
/// claim and not per total: a deck that reserved four copies of an entry the user has since
/// stepped to one has one of them, and charging the plan for the other three would be charging
/// it for copies that do not exist.
///
/// The `?1 IS NULL` arm is the orphan's: a row whose printing has left `cards` is matched by
/// **exact printing** against the collection instead, because that is the only identity it has
/// left. `LEFT JOIN cards` is what lets that arm find an entry whose own card is missing too.
const OWNED_SPARE_SQL: &str = "SELECT coalesce(sum(e.quantity), 0) -
            coalesce((SELECT sum(min(a.quantity, e2.quantity))
                        FROM deck_allocations a
                        JOIN decks d ON d.id = a.deck_id
                        JOIN collection_entries e2 ON e2.id = a.collection_entry_id
                        LEFT JOIN cards c2 ON c2.id = e2.card_id
                       WHERE d.is_built = 1
                         AND (c2.oracle_id = ?1 OR (?1 IS NULL AND e2.card_id = ?2))), 0)
       FROM collection_entries e
       LEFT JOIN cards c ON c.id = e.card_id
      WHERE c.oracle_id = ?1 OR (?1 IS NULL AND e.card_id = ?2)";

/// Cards the **theory** list holds that **live** does not.
///
/// One direction only, which is what the spec asks for: this is a shopping list, not a
/// reconciliation. A card live plays and theory dropped is a cut the user already made and
/// needs no line; a card theory wants two more of is one line saying two.
///
/// **Compared by oracle card, not by printing.** Needing a second Sol Ring is not answered by
/// owning a different printing of one already in the live list, so the two sides are summed per
/// oracle card and subtracted — see [`group_key`], including what an orphan falls back to.
///
/// The same card filed in two theory categories is **one line**, for the sum, named by the
/// category the editor lists first. That is the same choice [`crate::deck::missing_to_wishlist`]
/// makes and for the same reason: a reader counting copies of a card counts copies of a card.
///
/// Ordered by where the representative row falls in the editor's own reading order, so the
/// shopping list runs down the deck the way the deck is drawn.
pub fn theory_diff(conn: &Connection, deck_id: i64) -> Result<Vec<TheoryDiffRow>, String> {
    Ok(grouped_diff(conn, deck_id)?
        .into_iter()
        .map(|g| g.row)
        .collect())
}

/// [`theory_diff`]'s working form — see [`Grouped`] for why the oracle id stays.
fn grouped_diff(conn: &Connection, deck_id: i64) -> Result<Vec<Grouped>, String> {
    // Both variants in one read: two reads could not be compared, because a card write between
    // them would put a copy on one side of the subtraction and not the other.
    let mut stmt = conn.prepare(DIFF_SELECT).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id], |r| {
            Ok((
                r.get::<_, String>(0)?,         // variant
                r.get::<_, String>(1)?,         // card_id
                r.get::<_, String>(2)?,         // name
                r.get::<_, String>(3)?,         // set_code
                r.get::<_, String>(4)?,         // collector_number
                r.get::<_, i64>(5)?,            // quantity
                r.get::<_, String>(6)?,         // category name
                r.get::<_, Option<String>>(7)?, // oracle_id
                r.get::<_, Option<f64>>(8)?,    // unit price
            ))
        })
        .map_err(|e| e.to_string())?;

    // `wanted` and `held` are copies per card; `order` is the theory rows in reading order, and
    // it is what decides both which printing represents a group and where its line lands.
    let mut wanted: HashMap<String, i64> = HashMap::new();
    let mut held: HashMap<String, i64> = HashMap::new();
    let mut order: Vec<(String, Grouped)> = Vec::new();
    for row in rows {
        let (variant, card_id, name, set_code, collector_number, quantity, category, oracle, price) =
            row.map_err(|e| e.to_string())?;
        let key = group_key(oracle.as_deref(), &card_id);
        if variant == THEORY {
            *wanted.entry(key.clone()).or_insert(0) += quantity;
            if !order.iter().any(|(k, _)| *k == key) {
                order.push((
                    key,
                    Grouped {
                        oracle_id: oracle,
                        row: TheoryDiffRow {
                            card_id,
                            name,
                            category_name: category,
                            // Filled below, once both sides are summed.
                            quantity: 0,
                            unit_price_usd: price,
                            set_code,
                            collector_number,
                            owned_spare: 0,
                        },
                    },
                ));
            }
        } else {
            *held.entry(key).or_insert(0) += quantity;
        }
    }

    let mut spare = conn.prepare(OWNED_SPARE_SQL).map_err(|e| e.to_string())?;
    let mut diff = Vec::new();
    for (key, mut grouped) in order {
        let short = wanted.get(&key).copied().unwrap_or(0) - held.get(&key).copied().unwrap_or(0);
        if short <= 0 {
            continue;
        }
        grouped.row.quantity = short;
        // Floored at zero: a collection stepped down under a built deck's stored claim can make
        // the subtraction negative, and "you own −1 of these" is not a thing to tell anyone.
        grouped.row.owned_spare = spare
            .query_row(params![grouped.oracle_id, grouped.row.card_id], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())?
            .max(0);
        diff.push(grouped);
    }
    Ok(diff)
}

/// Copy the live list into the theory one, leaving whatever theory already holds alone.
///
/// **Takes the caller's connection and opens no transaction**, exactly as
/// [`crate::deck::allocate_deck`] does, because its most important caller is
/// [`crate::deck::update_deck`]: switching the theory list on and filling it are one fact and
/// have to be one write. A copy that committed while the flag rolled back would be a theory
/// list nobody asked for; a flag that committed while the copy rolled back is the empty list
/// this exists to prevent.
///
/// `ON CONFLICT … DO NOTHING` on [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) rather
/// than a fold: a theory row the user already made is *their plan for that card*, and topping
/// it up with the live count would silently overwrite the very edit the theory list exists to
/// hold. So this is a seed that can also top up — idempotent, never destructive, and returning
/// how many rows it actually wrote.
///
/// `tag_id` and `needs_review` travel with the copy. A label is the user's word about this card
/// in this deck and a plan inherits it; the flag says the printing left the card database, which
/// is as true of the copy as of the original.
///
/// **Allocates nothing**, and must not: the allocator reserves collection copies for `live`
/// only, so a theory list that claimed anything would take copies away from decks that are real.
///
/// Answers the number of **rows** written, which is what `execute` counts. [`copy_from_live`]
/// wants **copies** for its history and measures them itself with [`theory_copies`] — a row is
/// a line and a copy is a card, and this app counts decks in cards everywhere else.
pub(crate) fn seed_from_live(tx: &Connection, deck_id: i64) -> Result<usize, String> {
    let sql = format!(
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             tag_id, quantity, needs_review, created_at, updated_at)
         SELECT deck_id, category_id, ?2, card_id, set_code, collector_number, lang, name,
                tag_id, quantity, needs_review, unixepoch(), unixepoch()
           FROM deck_cards
          WHERE deck_id = ?1 AND variant = ?3
         ON CONFLICT({grain}) DO NOTHING",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    tx.execute(&sql, params![deck_id, THEORY, LIVE])
        .map_err(|e| e.to_string())
}

/// Does this deck's theory list hold anything at all? The condition on the seeding rule: a
/// theory list with rows in it is a plan the user has started, and switching the flag back on
/// must not pour the live deck over it.
pub(crate) fn theory_is_empty(conn: &Connection, deck_id: i64) -> Result<bool, String> {
    conn.query_row(
        "SELECT NOT EXISTS(SELECT 1 FROM deck_cards WHERE deck_id = ?1 AND variant = ?2)",
        params![deck_id, THEORY],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// Copies the theory list holds, summed. The unit a deck is counted in everywhere else in this
/// app — two printings at 2 and 3 is 5 cards, not 2.
fn theory_copies(conn: &Connection, deck_id: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT coalesce(sum(quantity), 0) FROM deck_cards
          WHERE deck_id = ?1 AND variant = ?2",
        params![deck_id, THEORY],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}

/// [`seed_from_live`] as a command of its own — "copy my deck into the plan", pressed.
///
/// Opens the transaction its callee will not, and moves `updated_at` through
/// [`crate::deck::touch_deck`] so the gallery surfaces the edit and a stale deck id is answered
/// with [`crate::deck::GONE`] rather than with a silent no-op.
///
/// **Records exactly one history row**, kind `deck`, field `theory`, carrying the copies it
/// added — and it has to, for a reason worth stating because the opposite was tried first. The
/// toggle's own row is a fact about a *switch*, written once per deck whether the deck holds
/// forty cards or none; on an already-seeded list, which is the only state where this button is
/// meaningfully pressed, the toggle's row was written long ago and nothing else would be. "Log
/// ALL changes" is the whole point of the table, and a press that moves forty cards into a list
/// is a change.
///
/// One row and not one per card: N `add` rows would read as a deck somebody typed out, and the
/// toggle path — where the same copy rides along inside `update_deck` — records one row for the
/// same reason. `copied` is in the payload **and** in `delta`, which is [`crate::deck_audit`]'s
/// established shape (an `add` carries its quantity in both): `delta` is the day header's
/// arithmetic, the payload is the sentence's facts.
pub fn copy_from_live(conn: &Connection, deck_id: i64) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    // Measured either side of the insert rather than derived from its row count: `execute`
    // counts rows and a row is a line, while what a reader (and `delta`) wants is cards.
    let before = theory_copies(&tx, deck_id)?;
    let rows = seed_from_live(&tx, deck_id)?;
    let copied = theory_copies(&tx, deck_id)? - before;
    crate::deck_audit::record(
        &tx,
        deck_id,
        THEORY,
        crate::deck_audit::DECK,
        None,
        &serde_json::json!({ "field": "theory", "copied": copied }),
        copied,
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Everything the plan is short of, onto the wishlist. Returns how many wishes were touched.
///
/// [`crate::deck::missing_to_wishlist`]'s twin, and the difference is what a plan is: what it
/// wants is measured against the **live list** rather than against the allocator's claims, a
/// theory row reserving nothing and so having no claims to measure.
///
/// **The wish is [`TheoryDiffRow::quantity`] and nothing is subtracted from it.** That is not an
/// oversight and it was wrong once: subtracting [`TheoryDiffRow::owned_spare`] here counts the
/// live list's copies **twice**, because `quantity` is already *wanted minus held* and
/// `owned_spare` nets out only the claims of decks that are **built**. An unbuilt deck's own
/// live copies are therefore spare by that definition, so live 2 / owned 2 / theory 3 asked for
/// nothing while the user needed one — `missing_to_wishlist_does_not_count_the_live_list_twice`
/// is that arithmetic pinned. `owned_spare` is a **display** field: the diff row's way of saying
/// "one of these is in the box already", for a person to read beside a price. It is not a term
/// in this sum.
///
/// **Any printing**, always: written through [`crate::wishlist::add_wish`] with an oracle id, so
/// the grain, the canonicalisation and the fold all stay in the one module that owns them, and
/// pressing twice raises one line rather than making two.
///
/// An orphaned row is skipped, [`crate::deck::missing_to_wishlist`]'s rule: a wish needs an
/// oracle card, and an orphan has none. It is already carrying a `needs_review` sentence.
pub fn missing_to_wishlist(conn: &Connection, deck_id: i64) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let exists: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM decks WHERE id = ?1)",
            params![deck_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !exists {
        return Err(crate::deck::GONE.to_owned());
    }
    let mut touched = 0;
    for grouped in grouped_diff(&tx, deck_id)? {
        let Some(oracle_id) = grouped.oracle_id else {
            continue;
        };
        crate::wishlist::add_wish(
            &tx,
            &crate::wishlist::WishInput {
                oracle_id: Some(oracle_id),
                // The deck row's own name, which is the one name an orphan-safe row always has
                // and the same name the list would show for it.
                name: Some(grouped.row.name),
                quantity: grouped.row.quantity,
                ..Default::default()
            },
        )?;
        touched += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(touched)
}

/// Run `f` with the write connection, or answer [`crate::collection::BUSY`] —
/// [`crate::deck`]'s definition, kept per-module the way every other one in this crate is.
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(crate::collection::BUSY.to_owned()),
    }
}

/// What a write here says when its worker thread died under it.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck could not be written: {e}")
}

/// What the plan wants and the deck does not have. **Read-only** connection.
#[tauri::command]
pub async fn deck_theory_diff(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<TheoryDiffRow>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        theory_diff(&crate::sync::lock_db_read(&state), deck_id)
    })
    .await
    .map_err(|e| format!("the theory list could not be read: {e}"))?
}

/// Seed the theory list from the live one. Answers how many rows were written.
#[tauri::command]
pub async fn deck_theory_copy_from_live(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| copy_from_live(c, deck_id)))
        .await
        .map_err(unfinished)?
}

/// The one click: everything the plan is short of, onto the wishlist.
#[tauri::command]
pub async fn deck_theory_missing_to_wishlist(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| missing_to_wishlist(c, deck_id))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::{DeckInput, DeckPatch};

    /// Two printings of one oracle card, plus a second card — the second printing is what
    /// `the_diff_compares_oracle_cards_not_printings` turns on.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,mana_cost,cmc,type_line,prices,raw)
               VALUES
                 ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                  '{R}',1.0,'Instant','{"usd":"400.00"}','{}'),
                 ('bolt-m10','o1','Lightning Bolt','m10','146','en','normal','common',
                  '{R}',1.0,'Instant','{"usd":"1.50"}','{}'),
                 ('serra-lea','o2','Serra Angel','lea','175','en','normal','uncommon',
                  '{3}{W}{W}',5.0,'Creature — Angel','{"usd":"120.00"}','{}');"#,
        )
        .unwrap();
        conn
    }

    fn deck(conn: &Connection, name: &str) -> i64 {
        crate::deck::create_deck(
            conn,
            &DeckInput {
                name: name.to_owned(),
                format_key: "modern".to_owned(),
                description: None,
            },
        )
        .unwrap()
        .id
    }

    fn category(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, name).unwrap()
    }

    fn add(conn: &Connection, deck_id: i64, card: &str, cat: i64, variant: &str, quantity: i64) {
        crate::deck::add_card(conn, deck_id, card, Some(cat), None, variant, quantity).unwrap();
    }

    fn set_theory(conn: &Connection, deck_id: i64, on: bool) {
        crate::deck::update_deck(
            conn,
            deck_id,
            &DeckPatch {
                theory_enabled: Some(on),
                ..Default::default()
            },
        )
        .unwrap();
    }

    /// Every card in one variant of a deck, as `(card_id, quantity)` sorted by id.
    fn cards_in(conn: &Connection, deck_id: i64, variant: &str) -> Vec<(String, i64)> {
        conn.prepare(
            "SELECT card_id, quantity FROM deck_cards
              WHERE deck_id = ?1 AND variant = ?2 ORDER BY card_id",
        )
        .unwrap()
        .query_map(params![deck_id, variant], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// One collection row of one printing.
    fn own(conn: &Connection, card_id: &str, quantity: i64) -> i64 {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: "nonfoil".to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// The whole of rule 1: a theory list that is switched on with nothing in it is not a
    /// blank page, it is the deck the user already has — anything else reads as data loss.
    #[test]
    fn enabling_theory_seeds_it_from_live() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        add(&conn, id, "serra-lea", main, LIVE, 1);

        set_theory(&conn, id, true);

        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 4), ("serra-lea".to_owned(), 1)]
        );
        assert_eq!(
            cards_in(&conn, id, LIVE),
            vec![("bolt-lea".to_owned(), 4), ("serra-lea".to_owned(), 1)],
            "seeding copies, it never moves"
        );
    }

    /// The other half of the rule, and the one a naive implementation gets wrong: a theory
    /// list that already holds something is a plan the user started, and switching the flag
    /// back on must not pour the live deck over it.
    #[test]
    fn enabling_theory_again_leaves_a_started_plan_alone() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        add(&conn, id, "serra-lea", main, THEORY, 1);

        set_theory(&conn, id, true);

        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("serra-lea".to_owned(), 1)],
            "the plan the user started, untouched"
        );
    }

    /// Rule 4. Switching the list off hides a switch; a list the user spent an evening on is
    /// not something a checkbox may throw away.
    #[test]
    fn disabling_theory_keeps_the_rows() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        set_theory(&conn, id, true);
        add(&conn, id, "serra-lea", main, THEORY, 2);

        set_theory(&conn, id, false);

        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 4), ("serra-lea".to_owned(), 2)]
        );
        // And switching it back on finds the plan still there rather than re-seeding over it.
        set_theory(&conn, id, true);
        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 4), ("serra-lea".to_owned(), 2)]
        );
    }

    /// One direction only: what theory wants more of. A card live plays and theory dropped is
    /// a cut the user already made, and a card the two agree on is not a purchase.
    #[test]
    fn the_diff_only_reports_what_theory_has_more_of() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        add(&conn, id, "serra-lea", main, LIVE, 2);
        // The plan: one more Bolt, one fewer Angel, and a card live does not play at all.
        add(&conn, id, "bolt-lea", main, THEORY, 5);
        add(&conn, id, "serra-lea", main, THEORY, 1);
        add(&conn, id, "bolt-m10", main, THEORY, 3);

        let diff = theory_diff(&conn, id).unwrap();

        // `bolt-m10` is another printing of `bolt-lea`'s card, so the two theory rows are one
        // group: 5 + 3 wanted against 4 held is 4 short. The Angel is a cut and is not here.
        assert_eq!(diff.len(), 1, "{diff:?}");
        assert_eq!(diff[0].name, "Lightning Bolt");
        assert_eq!(diff[0].quantity, 4);
        assert_eq!(diff[0].category_name, "Main deck");
    }

    /// Rule 2, and the reason it is a rule: a second Sol Ring is not answered by owning a
    /// different printing of one you already play. Live holds `bolt-lea`; theory asks for a
    /// `bolt-m10` as well, and the diff must see one card at two copies rather than a new one.
    #[test]
    fn the_diff_compares_oracle_cards_not_printings() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 1);
        add(&conn, id, "bolt-lea", main, THEORY, 1);
        add(&conn, id, "bolt-m10", main, THEORY, 1);

        let diff = theory_diff(&conn, id).unwrap();

        assert_eq!(diff.len(), 1, "one card, not two printings: {diff:?}");
        assert_eq!(diff[0].quantity, 1, "two wanted, one held");
        assert_eq!(
            diff[0].card_id, "bolt-lea",
            "named by the theory row the editor lists first"
        );

        // The same comparison from the other side: swapping the live printing for the other
        // one changes nothing, because the card is the same card.
        crate::deck::swap_printing(&conn, id, "bolt-lea", "bolt-m10", main, LIVE).unwrap();
        assert_eq!(theory_diff(&conn, id).unwrap()[0].quantity, 1);
    }

    /// An inactive category counts toward nothing — on **both** sides. A card parked in the
    /// theory Maybeboard is not a decision the user made, and one parked in the live
    /// Maybeboard is not a card the deck has.
    #[test]
    fn the_diff_reads_neither_sides_inactive_categories() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let maybe: i64 = conn
            .query_row(
                "SELECT id FROM deck_categories WHERE deck_id = ?1 AND kind = 'maybe'",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        add(&conn, id, "bolt-lea", main, LIVE, 1);
        add(&conn, id, "serra-lea", maybe, THEORY, 2);

        assert!(
            theory_diff(&conn, id).unwrap().is_empty(),
            "a scratchpad is not a shopping list"
        );

        // Live's copy parked in the Maybeboard is not a copy the deck has, either.
        add(&conn, id, "bolt-lea", maybe, LIVE, 3);
        add(&conn, id, "bolt-lea", main, THEORY, 2);
        let diff = theory_diff(&conn, id).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(
            diff[0].quantity, 1,
            "2 wanted against the 1 live really has"
        );
    }

    /// Rule 3. The binder's copies less what decks *on a table* have spoken for — an unbuilt
    /// deck's claim leaves a copy available, because a deck being planned is planning with
    /// cards it may share with every other draft.
    #[test]
    fn owned_spare_is_what_no_built_deck_has_claimed() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        own(&conn, "bolt-lea", 3);
        add(&conn, id, "bolt-lea", main, THEORY, 4);

        assert_eq!(
            theory_diff(&conn, id).unwrap()[0].owned_spare,
            3,
            "nothing is built, so every copy is spare"
        );

        // A second deck, sleeved up, taking two of them.
        let other = deck(&conn, "Other");
        let other_main = category(&conn, other, "Main deck");
        add(&conn, other, "bolt-lea", other_main, LIVE, 2);
        crate::deck::update_deck(
            &conn,
            other,
            &DeckPatch {
                is_built: Some(true),
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(theory_diff(&conn, id).unwrap()[0].owned_spare, 1);
    }

    /// Another printing of the same card counts: `owned_spare` is per oracle card, exactly as
    /// the diff itself is, so a Bolt in the binder answers a Bolt in the plan.
    #[test]
    fn owned_spare_counts_every_printing_of_the_card() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        own(&conn, "bolt-m10", 2);
        add(&conn, id, "bolt-lea", main, THEORY, 3);

        assert_eq!(theory_diff(&conn, id).unwrap()[0].owned_spare, 2);
    }

    /// Every wish this deck raised, oldest first.
    fn wishes(conn: &Connection) -> Vec<(Option<String>, i64)> {
        conn.prepare("SELECT oracle_id, quantity FROM wishlist_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    /// The shopping list asks for the difference, and only for cards there is a difference on.
    #[test]
    fn missing_to_wishlist_asks_for_the_difference() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, THEORY, 3);
        // A card the plan agrees with the deck about is not a purchase.
        add(&conn, id, "serra-lea", main, LIVE, 1);
        add(&conn, id, "serra-lea", main, THEORY, 1);

        let touched = missing_to_wishlist(&conn, id).unwrap();

        assert_eq!(touched, 1);
        assert_eq!(wishes(&conn), vec![(Some("o1".to_owned()), 3)]);
    }

    /// **The live list is subtracted once.** Netting `owned_spare` out of the wish as well is
    /// the bug this pins, and it hides from any fixture where the deck plays none of the card:
    /// [`TheoryDiffRow::quantity`] is already *wanted minus held*, while `owned_spare` nets out
    /// only the claims of decks that are **built** — so an unbuilt deck's own live copies read
    /// as spare and are charged against the wish a second time.
    ///
    /// **Two cards, because the bug has two shapes and one fixture hides the other.** The Bolt
    /// (live 2, binder 2, plan 3) makes the subtraction negative, which the old code skipped
    /// outright — no wish at all. The Angel (live 1, binder 3, plan 5) makes it merely *small*:
    /// 4 needed, 1 asked for. A fixture with only the first would still pass a half-reverted
    /// fix, because `wishlist::add_wish` clamps a non-positive quantity to **1** — so the
    /// negative arm's wrong answer and the right answer can be the same number, and only the
    /// wish's absence tells them apart.
    #[test]
    fn missing_to_wishlist_does_not_count_the_live_list_twice() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        own(&conn, "bolt-lea", 2);
        add(&conn, id, "bolt-lea", main, LIVE, 2);
        add(&conn, id, "bolt-lea", main, THEORY, 3);
        own(&conn, "serra-lea", 3);
        add(&conn, id, "serra-lea", main, LIVE, 1);
        add(&conn, id, "serra-lea", main, THEORY, 5);

        // The premise: the deck is not built, so nothing has *claimed* those copies and every
        // one of them reads spare — which is right for a reader and is the whole trap for a
        // subtraction, since `quantity` has already taken the live list off.
        let diff = theory_diff(&conn, id).unwrap();
        assert_eq!((diff[0].quantity, diff[0].owned_spare), (1, 2));
        assert_eq!((diff[1].quantity, diff[1].owned_spare), (4, 3));

        let touched = missing_to_wishlist(&conn, id).unwrap();

        assert_eq!(touched, 2, "the Bolt is a wish, not a skipped negative");
        assert_eq!(
            wishes(&conn),
            vec![(Some("o1".to_owned()), 1), (Some("o2".to_owned()), 4)],
            "and the Angel asks for four, not for four less what is in the box"
        );
    }

    /// Rule 1 of the audit table reaches this button too: a press that moves forty cards into
    /// the plan is a change, and on an already-seeded list the toggle's row was written long
    /// ago. One row, carrying **copies** rather than rows — a line is not a card.
    #[test]
    fn copying_from_live_records_one_row_carrying_the_copies() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        add(&conn, id, "serra-lea", main, LIVE, 2);
        conn.execute("DELETE FROM deck_audit", []).unwrap();

        copy_from_live(&conn, id).unwrap();

        let history = crate::deck_audit::list(&conn, id, 100).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].kind, crate::deck_audit::DECK);
        assert_eq!(history[0].variant, THEORY);
        assert_eq!(history[0].delta, 6, "copies, not the two rows");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&history[0].payload).unwrap(),
            serde_json::json!({ "field": "theory", "copied": 6 })
        );
    }

    /// An explicit copy tops the plan up without touching a row the user changed — the
    /// `DO NOTHING` half of [`seed_from_live`], which a fold would get wrong invisibly.
    #[test]
    fn copying_from_live_leaves_a_changed_theory_row_alone() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        add(&conn, id, "serra-lea", main, LIVE, 2);
        add(&conn, id, "bolt-lea", main, THEORY, 1);

        let copied = copy_from_live(&conn, id).unwrap();

        assert_eq!(copied, 1, "only the row theory did not have");
        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 1), ("serra-lea".to_owned(), 2)],
            "the user's own count for the Bolt survives"
        );
    }

    /// A plan reserves nothing. This is the rule every other module states and this one has
    /// the sharpest way to break: seeding writes a pile of `theory` rows in one statement, and
    /// an allocator run over them would take copies away from decks that are real.
    #[test]
    fn seeding_the_plan_claims_no_collection_copy() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        own(&conn, "bolt-lea", 4);
        add(&conn, id, "serra-lea", main, THEORY, 1);
        let before: i64 = conn
            .query_row("SELECT count(*) FROM deck_allocations", [], |r| r.get(0))
            .unwrap();

        copy_from_live(&conn, id).unwrap();

        let after: i64 = conn
            .query_row("SELECT count(*) FROM deck_allocations", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
    }

    /// A stale deck id is answered in words by every entry point here, rather than by an empty
    /// list that reads like a deck with nothing in it.
    #[test]
    fn a_deck_that_is_gone_is_refused_by_name() {
        let conn = seeded();

        assert_eq!(copy_from_live(&conn, 404).unwrap_err(), crate::deck::GONE);
        assert_eq!(
            missing_to_wishlist(&conn, 404).unwrap_err(),
            crate::deck::GONE
        );
    }
}
