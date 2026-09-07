//! Re-point every pinned wish at the cheapest printing of the same card — as a **preview**
//! first, and as a write only over the rows the reader ticked.
//!
//! [Issue #352](https://github.com/Msgaihede/mtg-grimoire/issues/352). Two commands rather than
//! one button, and the split is the whole feature: a sweep that repointed forty wishes the
//! moment it was pressed would be a shopping list rewritten by a rule the reader never saw
//! applied to a row they never looked at. [`plan`] writes nothing and says what *would* change;
//! [`apply`] takes the subset back and commits it in one transaction.
//!
//! **The scope is exactly the rows the list is currently showing**, which is why [`plan`] takes
//! the page's own [`WishlistQuery`] and reads it through [`crate::wishlist::wishlist_scope`] —
//! the same `FROM` and `WHERE` [`crate::wishlist::list_wishes`] draws with, not a second copy of
//! the folder rule and the filter terms. `limit` and `offset` are ignored, so `considered`
//! equals the `total` the page header shows and the preview cannot quietly stop at the end of
//! page one.
//!
//! **Only *pinned* wishes can move.** A wish with `card_id IS NULL` is already drawn and priced
//! at the cheapest printing of its oracle card by that join, so there is nothing to find; it is
//! counted in [`WishlistOptimizePlan::already_cheapest`] and never offered.
//!
//! Every figure is at the marketplace the query named, at the **wish's own finish** — the same
//! [`crate::sorting::row_price_expr`] over [`WISH_PREFERRED_FINISH`] that
//! [`crate::wishlist::WishRow::unit_price`] is. A foil wish is compared foil to foil, and a wish
//! that names no finish is priced through the `nonfoil → foil → etched` chain rather than at the
//! nonfoil rate.

#[cfg(not(target_family = "wasm"))]
use crate::sync::{with_write, AppState};
use crate::wishlist::{set_printing_inner, wishlist_scope, WishlistQuery, WISH_PREFERRED_FINISH};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
#[cfg(not(target_family = "wasm"))]
use std::sync::Arc;

/// One printing in a plan — the one a wish is pinned to now, or the one the sweep would move
/// it to.
///
/// **The three descriptive columns are `cards`', never the wish's denormalised copies.** A plan
/// is about printings that exist *today*, and `wishlist_entries.set_code`/`collector_number`/
/// `lang` can still describe a printing Scryfall has since removed — which is exactly the state
/// `needs_review` exists to mark. So `from` is read off the wish's printing **through the
/// join**, and a wish pinned to an id `cards` no longer has is skipped rather than described
/// from memory.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizePrinting {
    pub card_id: String,
    pub set_code: String,
    pub collector_number: String,
    pub lang: String,
    /// Per copy, at the plan's marketplace and at the wish's finish.
    ///
    /// `None` is *unpriced there*, and it can only ever appear on a [`WishOptimizeMove::from`]:
    /// a candidate with no price is not a candidate at all — see [`plan`]'s second pass — so a
    /// `to` always carries a number.
    pub price: Option<f64>,
}

/// One row of the preview: a wish, where it is, and where one press would put it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishOptimizeMove {
    pub wish_id: i64,
    /// The wish's own name, as the list draws it — `wishlist_entries.name`, which a wish
    /// carries whether or not any printing of it survives.
    pub name: String,
    pub quantity: i64,
    /// `None` is "the reader has not said", and it is **never coalesced to nonfoil** on the way
    /// into the price expression — [`crate::sorting::row_price_expr`]'s doc has the bug that
    /// cost.
    pub preferred_finish: Option<String>,
    /// Where the wish is filed; `None` is the root. On the row rather than implied by the query
    /// because a flattened preview has to say which drawer each row is in.
    pub folder_id: Option<i64>,
    pub from: OptimizePrinting,
    pub to: OptimizePrinting,
    /// `from.price - to.price`, per copy — and `None` **exactly when `from.price` is**.
    ///
    /// A wish whose current printing this marketplace does not list is still offered as a move
    /// and counted as no saving: an unlisted printing may be cheap rather than dear, and a
    /// figure invented for it would inflate the headline over rows nobody can check.
    pub saved_per_copy: Option<f64>,
    /// [`Self::saved_per_copy`] times [`Self::quantity`], or `None` with it. `f64` throughout,
    /// so the rounding is the presentation's — this is arithmetic over two quoted prices and
    /// not a currency type.
    pub saved: Option<f64>,
}

/// What [`plan`] answers: every improvement available over the rows the list is showing, and an
/// account of the ones it passed over.
///
/// The three counts partition [`Self::considered`]: `moves.len() + already_cheapest + skipped`.
///
/// **It does not echo the marketplace back, deliberately.** Every price here was quoted at the
/// one the query carried, and the query is in the caller's key — a second copy of that fact
/// travelling in the answer is one more thing that can disagree with the hook the dialog renders
/// from.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistOptimizePlan {
    pub moves: Vec<WishOptimizeMove>,
    /// How many wishes the sweep looked at — the list's own `total` for the same query.
    pub considered: i64,
    /// Already on the cheapest priced printing, **plus every any-printing wish**, which is
    /// cheapest by construction.
    pub already_cheapest: i64,
    /// Passed over: a wish with no `oracle_id` (nothing to find siblings by), a wish pinned to a
    /// printing `cards` no longer has (nothing to compare against), and an oracle card no
    /// printing of which this marketplace prices at this wish's finish.
    pub skipped: i64,
}

/// One ticked row on its way to [`apply`].
///
/// **[`Self::from_card_id`] is a guard, not a description.** Between the preview and the press a
/// sync can land or another pane can repoint the same wish; applying regardless would move a
/// printing the reader never saw. A wish whose `card_id` no longer matches is left exactly as it
/// is and reported [`WishOptimizeStatus::Stale`].
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WishOptimizeApplyItem {
    pub wish_id: i64,
    pub from_card_id: String,
    pub to_card_id: String,
}

/// What became of one ticked row.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WishOptimizeStatus {
    /// Repointed — the ordinary answer.
    Changed,
    /// The cheaper printing collided with a wish already in the same folder at the same finish,
    /// so the two quantities summed into that row and this one was deleted.
    /// [`crate::wishlist::set_wish_printing`]'s documented merge rather than a failure, and the
    /// saving still stands.
    Merged,
    /// The wish had moved on since the preview; nothing was written.
    Stale,
    /// The wish is not on the list any more; nothing was written.
    Missing,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishOptimizeResult {
    pub wish_id: i64,
    pub status: WishOptimizeStatus,
}

/// The outcome of one press of Apply — **one result per item sent, in the order they were
/// sent**, so the caller can sum the saving over exactly the rows that moved rather than over
/// the rows it hoped would.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistOptimizeOutcome {
    pub results: Vec<WishOptimizeResult>,
}

/// One wish as the first pass reads it, before anything has been decided about it.
struct Scanned {
    id: i64,
    name: String,
    quantity: i64,
    preferred_finish: Option<String>,
    folder_id: Option<i64>,
    /// `None` is an **any-printing** wish, and it is the first thing [`plan`] branches on.
    card_id: Option<String>,
    oracle_id: Option<String>,
    /// The printing the join resolved — `(id, set_code, collector_number, lang)`, all four of
    /// them `cards`' own and non-null together. `None` is a pinned wish whose printing has left
    /// `cards`.
    printing: Option<(String, String, String, String)>,
    /// What one copy costs **on the printing the wish is on now**, which for a pinned wish is
    /// its own. `None` is unpriced at this marketplace in this finish.
    cur_price: Option<f64>,
}

/// What re-pricing the list on screen would change. **Writes nothing.**
///
/// Two passes, and the second is one prepared statement reused per wish.
pub fn plan(conn: &Connection, q: &WishlistQuery) -> Result<WishlistOptimizePlan, String> {
    // The same expression [`crate::wishlist::WishRow::unit_price`] is, over the wish's own
    // finish column handed across **bare**: `row_price_expr` has to be able to tell "the reader
    // has not said" from "the reader said nonfoil", which on a printing sold only in foil are
    // two different answers. It also chooses the printing an any-printing wish is drawn as,
    // inside `wishlist_scope`'s join, which is why it is built here and passed in.
    let price = crate::sorting::row_price_expr(q.marketplace, WISH_PREFERRED_FINISH);
    let (from, where_sql, params) = wishlist_scope(q, &price);

    // `ORDER BY w.name` is `list_wishes`' *fallback* order rather than the reader's chosen sort.
    // The money sorts order by output aliases (`unit_price`, `owned_quantity`) this statement
    // does not select, so honouring `q.sort` here would mean selecting columns the preview has
    // no use for; a preview is a list of changes rather than a second rendering of the page.
    let sql = format!(
        "SELECT w.id, w.name, w.quantity, w.preferred_finish, w.folder_id,
                w.card_id, w.oracle_id,
                c.id, c.set_code, c.collector_number, c.lang,
                ({price}) AS cur_price
           FROM {from} WHERE {where_sql}
          ORDER BY w.name ASC, w.id ASC"
    );
    // Collected whole rather than classified as the rows arrive: a wishlist is tens of rows, so
    // holding them costs nothing and keeps the two questions apart — which wish is in scope, and
    // what the cheapest printing of its card is.
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let scanned: Vec<Scanned> = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| {
                // `set_code`, `collector_number` and `lang` are `NOT NULL` on `cards`, so they
                // are non-null exactly when `c.id` is — one `Option` decides all four, and a
                // `LEFT JOIN` that found nothing yields `None` rather than three empty strings
                // describing a printing that is not there.
                let printing = r
                    .get::<_, Option<String>>(7)?
                    .map(|id| Ok::<_, rusqlite::Error>((id, r.get(8)?, r.get(9)?, r.get(10)?)))
                    .transpose()?;
                Ok(Scanned {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    quantity: r.get(2)?,
                    preferred_finish: r.get(3)?,
                    folder_id: r.get(4)?,
                    card_id: r.get(5)?,
                    oracle_id: r.get(6)?,
                    printing,
                    cur_price: r.get(11)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;

    // ── Pass 2: the cheapest printing of one oracle card ────────────────────────────────
    //
    // **`?1` in place of the finish column, so one statement serves every wish.**
    // `row_price_expr` takes the caller's SQL for the finish being priced, and a bound
    // parameter is legal SQL there — which is what turns N statement compilations into one
    // `prepare` and N binds. `price_expr` hard-codes the alias `c` for the printing being
    // priced, so the candidate wears that name.
    //
    // **`c.digital = 0` states the intent and excludes nothing today.** Measured in the live
    // corpus 2026-09-03: 9 355 digital printings of 117 621, **0** of which carry a `price_usd`
    // — so the `IS NOT NULL` above already drops every one of them. It is a fence against a
    // feed that one day prices them, because an Arena-only printing is not a piece of cardboard
    // a reader can put in a sleeve, and arithmetic that happens to agree today is not a rule.
    //
    // **No language fence, deliberately, and the reader chose it.** A cheaper printing in
    // another language is a candidate: 1 073 non-English printings carry a USD price (same
    // corpus, same day), so this is a live case rather than a theoretical one. What makes it
    // safe is that the preview shows `lang` on **both** sides — the swap is visible before the
    // press, which is the whole reason this feature is two commands.
    //
    // `schema::CARDS_INDEXES`' `idx_cards_oracle` covers `cards(oracle_id)`, so each lookup is a
    // range on the index rather than a corpus scan, and it runs once per **pinned** wish in
    // scope — tens, not the 117 621 printings the table holds.
    let price_p = crate::sorting::row_price_expr(q.marketplace, "?1");
    let cheapest_sql = format!(
        "SELECT c.id, c.set_code, c.collector_number, c.lang, ({price_p}) AS p
           FROM cards c
          -- \"a card without a price should not be considered the cheapest printing\" — issue
          -- #352's own sentence. A hole in a pricelist is not a bargain, and without this the
          -- sweep would offer every reader the one printing nobody quotes.
          WHERE c.oracle_id = ?2 AND c.digital = 0 AND ({price_p}) IS NOT NULL
          ORDER BY p ASC, c.released_at DESC, c.id ASC
          LIMIT 1"
    );
    let mut cheapest = conn.prepare(&cheapest_sql).map_err(|e| e.to_string())?;

    let considered = scanned.len() as i64;
    let mut moves: Vec<WishOptimizeMove> = Vec::new();
    let mut already_cheapest: i64 = 0;
    let mut skipped: i64 = 0;

    for row in scanned {
        // **An any-printing wish is already cheapest by construction.** `wishlist_scope`'s join
        // draws and prices it at the cheapest printing of its oracle card, so there is no saving
        // to find — and pinning it would take away the very flexibility that makes it cheap: the
        // day a cheaper printing is released, the wish that names none follows it and the wish
        // this sweep pinned does not.
        let Some(from_card_id) = row.card_id else {
            already_cheapest += 1;
            continue;
        };
        // No oracle id: there is nothing to find sibling printings *by*. A wish can be in this
        // state legitimately — the table's CHECK asks for one identifier, not both.
        let Some(oracle_id) = row.oracle_id else {
            skipped += 1;
            continue;
        };
        // Pinned to a printing `cards` no longer has, which is what `needs_review` marks. There
        // is no price to compare against, and describing it from the wish's denormalised columns
        // would put a printing on screen that does not exist.
        let Some((_, set_code, collector_number, lang)) = row.printing else {
            skipped += 1;
            continue;
        };

        let best: Option<(String, String, String, String, f64)> = cheapest
            .query_row(params![row.preferred_finish, oracle_id], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        // No printing of this card is priced here at this finish at all. Not a saving of nothing
        // — a question this marketplace cannot answer.
        let Some((best_id, best_set, best_cn, best_lang, best_price)) = best else {
            skipped += 1;
            continue;
        };

        // **Strictly cheaper.** Without the `<`, a printing tied at the same price sorts ahead
        // of the one the reader is already on — `ORDER BY p ASC` breaks the tie by release date
        // — and the preview offers a "saving" of 0.00 on a swap that buys nothing. The wish's
        // own printing is a candidate like any other, which is what makes the comparison
        // meaningful rather than a special case.
        let saved_per_copy = match row.cur_price {
            Some(cur) if best_price < cur => Some(cur - best_price),
            // Priced, and nothing beats it. Its own printing usually *is* the winner.
            Some(_) => {
                already_cheapest += 1;
                continue;
            }
            // Unpriced where it stands. Still a move — an unlisted printing may be cheap rather
            // than dear, so the saving is unknown rather than zero, and the row is drawn
            // `— → $2.00` for the reader to decide about.
            None => None,
        };

        moves.push(WishOptimizeMove {
            wish_id: row.id,
            name: row.name,
            quantity: row.quantity,
            preferred_finish: row.preferred_finish,
            folder_id: row.folder_id,
            from: OptimizePrinting {
                card_id: from_card_id,
                set_code,
                collector_number,
                lang,
                price: row.cur_price,
            },
            to: OptimizePrinting {
                card_id: best_id,
                set_code: best_set,
                collector_number: best_cn,
                lang: best_lang,
                price: Some(best_price),
            },
            saved: saved_per_copy.map(|per| per * row.quantity as f64),
            saved_per_copy,
        });
    }

    Ok(WishlistOptimizePlan {
        moves,
        considered,
        already_cheapest,
        skipped,
    })
}

/// Commit the ticked rows of a plan.
///
/// **One transaction for the whole batch**, `wishlist::commit_import`'s rule: a sweep seen half
/// done is a shopping list nobody can reason about, and a reader who pressed once must not have
/// to work out which half of their list moved.
///
/// Every item gets a [`WishOptimizeResult`], in the order it was sent. A genuine `Err` from the
/// repoint — the likeliest being the target printing having left `cards` since the preview —
/// rolls the whole batch back and surfaces the message, which is what one transaction *means*.
pub fn apply(
    conn: &Connection,
    items: &[WishOptimizeApplyItem],
) -> Result<WishlistOptimizeOutcome, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut results = Vec::with_capacity(items.len());
    for item in items {
        // Read the wish's *current* printing rather than trusting the item. This is the guard
        // `from_card_id` exists for: between the preview and the press a sync can land or
        // another pane can repoint the same wish, and applying regardless would move a printing
        // the reader never saw.
        let current: Option<Option<String>> = tx
            .query_row(
                "SELECT card_id FROM wishlist_entries WHERE id = ?1",
                params![item.wish_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let status = match current {
            None => WishOptimizeStatus::Missing,
            Some(card_id) if card_id.as_deref() != Some(item.from_card_id.as_str()) => {
                WishOptimizeStatus::Stale
            }
            Some(_) => {
                // Through `set_printing_inner` and never a second `UPDATE`: the merge onto a
                // taken grain, the `needs_review` clear and the four-column refresh from `cards`
                // are that function's, and a repoint written here would be a second spelling of
                // all three. It answers the **destination's** id, so an id that is not the one
                // asked about is the merge having happened.
                let change = set_printing_inner(&tx, item.wish_id, Some(item.to_card_id.clone()))?;
                if change.id == item.wish_id {
                    WishOptimizeStatus::Changed
                } else {
                    WishOptimizeStatus::Merged
                }
            }
        };
        results.push(WishOptimizeResult {
            wish_id: item.wish_id,
            status,
        });
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(WishlistOptimizeOutcome { results })
}

/// The preview. **Read-only** connection, blocking pool — `wishlist_list`'s shape, because it is
/// the same question asked about the same rows.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_optimize_plan(
    state: tauri::State<'_, Arc<AppState>>,
    query: WishlistQuery,
) -> Result<WishlistOptimizePlan, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || plan(&crate::sync::lock_db_read(&state), &query))
        .await
        .map_err(|e| format!("the wishlist could not be read: {e}"))?
}

/// The press. `wishlist_set_printing`'s shape — plain [`with_write`], because a wish is
/// something the reader does *not* have and nothing here changes what is owned.
#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn wishlist_optimize_apply(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<WishOptimizeApplyItem>,
) -> Result<WishlistOptimizeOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| apply(c, &items)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sorting::Marketplace;
    use crate::wishlist::{add_wish, WishInput};

    /// One printing of `oracle`, with its own release date and price blob.
    ///
    /// `digital` is left at the DDL's default of 0. The candidate query fences on it and a
    /// fixture that set it on every row would be asserting against its own constant.
    fn seed(conn: &Connection, id: &str, oracle: Option<&str>, released_at: &str, prices: &str) {
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                released_at,prices,raw)
             VALUES (?1,?2,'Bolt','tst',?1,'en','normal',?3,?4,'{}')",
            params![id, oracle, released_at, prices],
        )
        .unwrap();
    }

    /// A wish pinned to one printing, at an optional finish, at the root.
    fn pin(conn: &Connection, card_id: &str, finish: Option<&str>, quantity: i64) -> i64 {
        pin_in(conn, card_id, finish, quantity, None)
    }

    /// The same, filed in a folder — `None` is the root, which is a place and not an omission.
    fn pin_in(
        conn: &Connection,
        card_id: &str,
        finish: Option<&str>,
        quantity: i64,
        folder_id: Option<i64>,
    ) -> i64 {
        add_wish(
            conn,
            &WishInput {
                card_id: Some(card_id.to_owned()),
                preferred_finish: finish.map(str::to_owned),
                quantity,
                folder_id,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// An any-printing wish for `oracle`, at the root.
    fn any_printing(conn: &Connection, oracle: &str) {
        add_wish(
            conn,
            &WishInput {
                oracle_id: Some(oracle.to_owned()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
    }

    /// A wishlist folder, written straight into the table — `wishlist_folders` owns the
    /// commands that make one, and these tests need nothing from them but somewhere to file a
    /// wish.
    fn folder(conn: &Connection, id: i64, name: &str) {
        conn.execute(
            "INSERT INTO wishlist_folders (id, parent_id, name, sort_order, created_at, updated_at)
             VALUES (?1, NULL, ?2, 0, unixepoch(), unixepoch())",
            params![id, name],
        )
        .unwrap();
    }

    /// The page's default query: the root, unflattened, TCGplayer.
    fn root() -> WishlistQuery {
        WishlistQuery {
            marketplace: Marketplace::Tcgplayer,
            ..Default::default()
        }
    }

    /// Two printings of one card at two prices — the fixture most of these tests want.
    fn dear_and_cheap() -> Connection {
        let conn = crate::schema::memory_pair();
        seed(&conn, "dear", Some("o1"), "2020-01-01", r#"{"usd":"5.00"}"#);
        seed(
            &conn,
            "cheap",
            Some("o1"),
            "2019-01-01",
            r#"{"usd":"2.00"}"#,
        );
        conn
    }

    #[test]
    fn a_pinned_wish_on_a_dearer_printing_is_one_move_worth_the_difference_per_copy() {
        let conn = dear_and_cheap();
        let id = pin(&conn, "dear", None, 3);

        let out = plan(&conn, &root()).unwrap();

        assert_eq!(out.considered, 1);
        assert_eq!(out.already_cheapest, 0);
        assert_eq!(out.skipped, 0);
        assert_eq!(out.moves.len(), 1);
        let m = &out.moves[0];
        assert_eq!(m.wish_id, id);
        assert_eq!(m.quantity, 3);
        assert_eq!(m.from.card_id, "dear");
        assert_eq!(m.to.card_id, "cheap");
        assert_eq!(m.from.price, Some(5.0));
        assert_eq!(m.to.price, Some(2.0));
        assert_eq!(m.saved_per_copy, Some(3.0));
        // The whole reason the quantity is carried: three copies of a $3 saving is $9, and a
        // headline summed over `savedPerCopy` alone would understate the sweep by two thirds.
        assert_eq!(m.saved, Some(9.0));
    }

    /// The strict `<`. `ORDER BY p ASC, c.released_at DESC` breaks a tie by release date, so
    /// the *newer* of two printings at one price sorts ahead of the one the reader is on —
    /// and a `<=` would offer that swap as a saving of 0.00.
    #[test]
    fn a_printing_tied_at_the_same_price_is_not_a_move() {
        let conn = crate::schema::memory_pair();
        seed(&conn, "old", Some("o1"), "2019-01-01", r#"{"usd":"5.00"}"#);
        seed(&conn, "new", Some("o1"), "2024-01-01", r#"{"usd":"5.00"}"#);
        pin(&conn, "old", None, 1);

        let out = plan(&conn, &root()).unwrap();

        assert!(out.moves.is_empty(), "a tie is not an improvement");
        assert_eq!(out.already_cheapest, 1);
        assert_eq!(out.considered, 1);
    }

    /// Issue #352's own sentence: "a card without a price should not be considered the
    /// cheapest printing". The unpriced sibling is the only other printing there is, and it is
    /// still not the answer.
    #[test]
    fn a_candidate_with_no_price_at_that_marketplace_is_never_chosen() {
        let conn = crate::schema::memory_pair();
        seed(
            &conn,
            "priced",
            Some("o1"),
            "2020-01-01",
            r#"{"usd":"5.00"}"#,
        );
        seed(&conn, "nothing", Some("o1"), "2024-01-01", "{}");
        pin(&conn, "priced", None, 1);

        let out = plan(&conn, &root()).unwrap();

        assert!(out.moves.is_empty());
        assert_eq!(out.already_cheapest, 1);
    }

    /// Foil to foil. The nonfoil figures are deliberately the other way round: priced at
    /// nonfoil this wish is already on the cheapest printing, so only a foil comparison finds
    /// the $10 saving.
    #[test]
    fn a_foil_wish_is_priced_and_compared_at_foil() {
        let conn = crate::schema::memory_pair();
        seed(
            &conn,
            "dear-foil",
            Some("o1"),
            "2020-01-01",
            r#"{"usd":"1.00","usd_foil":"20.00"}"#,
        );
        seed(
            &conn,
            "cheap-foil",
            Some("o1"),
            "2019-01-01",
            r#"{"usd":"9.00","usd_foil":"10.00"}"#,
        );
        pin(&conn, "dear-foil", Some("foil"), 2);

        let out = plan(&conn, &root()).unwrap();

        assert_eq!(out.moves.len(), 1);
        let m = &out.moves[0];
        assert_eq!(m.preferred_finish.as_deref(), Some("foil"));
        assert_eq!(m.to.card_id, "cheap-foil");
        assert_eq!(m.from.price, Some(20.0));
        assert_eq!(m.to.price, Some(10.0));
        assert_eq!(m.saved, Some(20.0));
    }

    /// The other half of the same rule: a printing sold **only** in foil is unpriced at
    /// nonfoil, and a wish that named nonfoil must not be handed its foil rate.
    /// `price_expr`'s named arm has no fallback chain, which is what makes that a NULL rather
    /// than a bargain.
    #[test]
    fn a_foil_only_candidate_is_not_offered_to_a_nonfoil_wish() {
        let conn = crate::schema::memory_pair();
        seed(
            &conn,
            "plain",
            Some("o1"),
            "2020-01-01",
            r#"{"usd":"5.00"}"#,
        );
        seed(
            &conn,
            "foil-only",
            Some("o1"),
            "2024-01-01",
            r#"{"usd_foil":"1.00"}"#,
        );
        pin(&conn, "plain", Some("nonfoil"), 1);

        let out = plan(&conn, &root()).unwrap();

        assert!(
            out.moves.is_empty(),
            "$1.00 is the foil's price and this wish is for the nonfoil"
        );
        assert_eq!(out.already_cheapest, 1);
    }

    /// An any-printing wish is drawn and priced at the cheapest printing already, so there is
    /// no saving to find — and pinning it would take the flexibility away.
    #[test]
    fn an_any_printing_wish_is_already_cheapest_and_never_a_move() {
        let conn = dear_and_cheap();
        any_printing(&conn, "o1");

        let out = plan(&conn, &root()).unwrap();

        assert!(out.moves.is_empty());
        assert_eq!(out.already_cheapest, 1);
        assert_eq!(out.skipped, 0);
    }

    /// No oracle id: there is nothing to find sibling printings *by*. The table's CHECK asks
    /// for one identifier, not both, so this row is legitimate rather than corrupt.
    #[test]
    fn a_wish_with_no_oracle_id_is_skipped() {
        let conn = crate::schema::memory_pair();
        seed(&conn, "orphan", None, "2020-01-01", r#"{"usd":"5.00"}"#);
        seed(
            &conn,
            "cheap",
            Some("o1"),
            "2019-01-01",
            r#"{"usd":"2.00"}"#,
        );
        pin(&conn, "orphan", None, 1);

        let out = plan(&conn, &root()).unwrap();

        assert!(out.moves.is_empty());
        assert_eq!(out.skipped, 1);
        assert_eq!(out.already_cheapest, 0);
    }

    /// Pinned to a printing `cards` has lost — which is what `needs_review` marks. There is no
    /// price to compare against, and describing it from the wish's denormalised columns would
    /// put a printing on screen that does not exist.
    #[test]
    fn a_wish_pinned_to_a_printing_the_card_database_lost_is_skipped() {
        let conn = dear_and_cheap();
        pin(&conn, "dear", None, 1);
        conn.execute("DELETE FROM cards WHERE id = 'dear'", [])
            .unwrap();

        let out = plan(&conn, &root()).unwrap();

        assert!(out.moves.is_empty());
        assert_eq!(out.skipped, 1);
        assert_eq!(out.considered, 1);
    }

    /// An oracle card **no** printing of which this marketplace prices: not a saving of
    /// nothing, a question the marketplace cannot answer.
    #[test]
    fn a_card_no_printing_of_which_is_priced_is_skipped() {
        let conn = crate::schema::memory_pair();
        seed(&conn, "a", Some("o1"), "2020-01-01", "{}");
        seed(&conn, "b", Some("o1"), "2019-01-01", "{}");
        pin(&conn, "a", None, 1);

        let out = plan(&conn, &root()).unwrap();

        assert!(out.moves.is_empty());
        assert_eq!(out.skipped, 1);
    }

    /// The three counts partition the wishes looked at — which is what lets a dialog say
    /// "1 of 4" without a second count that can disagree with it.
    #[test]
    fn the_three_counts_partition_the_wishes_considered() {
        let conn = dear_and_cheap();
        seed(&conn, "lonely", None, "2020-01-01", r#"{"usd":"7.00"}"#);
        pin(&conn, "dear", None, 1); // a move
        pin(&conn, "cheap", None, 1); // already cheapest
        pin(&conn, "lonely", None, 1); // skipped: no oracle id
        any_printing(&conn, "o1"); // already cheapest: any printing

        let out = plan(&conn, &root()).unwrap();

        assert_eq!(out.moves.len(), 1);
        assert_eq!(out.already_cheapest, 2);
        assert_eq!(out.skipped, 1);
        assert_eq!(
            out.moves.len() as i64 + out.already_cheapest + out.skipped,
            out.considered
        );
    }

    /// The scope is the list's, folder rule included: a wish in a drawer is not in the root's
    /// plan, and **Flatten** is what reaches it.
    #[test]
    fn the_plan_is_scoped_to_the_folder_the_list_is_showing() {
        let conn = dear_and_cheap();
        folder(&conn, 1, "Ordered");
        pin_in(&conn, "dear", None, 1, Some(1));

        let at_root = plan(&conn, &root()).unwrap();
        assert_eq!(at_root.considered, 0);
        assert!(at_root.moves.is_empty());

        let in_folder = plan(
            &conn,
            &WishlistQuery {
                folder_id: Some(1),
                ..root()
            },
        )
        .unwrap();
        assert_eq!(in_folder.moves.len(), 1);
        assert_eq!(in_folder.moves[0].folder_id, Some(1));

        let flattened = plan(
            &conn,
            &WishlistQuery {
                flatten: true,
                ..root()
            },
        )
        .unwrap();
        assert_eq!(flattened.moves.len(), 1);
    }

    /// A preview that stopped at the end of page one would quietly leave wishes un-optimised
    /// and the reader would have no way to tell — so the plan ignores both paging fields.
    #[test]
    fn limit_and_offset_do_not_shrink_the_plan() {
        let conn = dear_and_cheap();
        seed(
            &conn,
            "dear2",
            Some("o2"),
            "2020-01-01",
            r#"{"usd":"5.00"}"#,
        );
        seed(
            &conn,
            "cheap2",
            Some("o2"),
            "2019-01-01",
            r#"{"usd":"2.00"}"#,
        );
        seed(
            &conn,
            "dear3",
            Some("o3"),
            "2020-01-01",
            r#"{"usd":"5.00"}"#,
        );
        seed(
            &conn,
            "cheap3",
            Some("o3"),
            "2019-01-01",
            r#"{"usd":"2.00"}"#,
        );
        pin(&conn, "dear", None, 1);
        pin(&conn, "dear2", None, 1);
        pin(&conn, "dear3", None, 1);

        let out = plan(
            &conn,
            &WishlistQuery {
                limit: 1,
                offset: 2,
                ..root()
            },
        )
        .unwrap();

        assert_eq!(out.considered, 3);
        assert_eq!(out.moves.len(), 3);
    }

    /// An unlisted printing may be cheap rather than dear, so the row is still a move and the
    /// saving is **unknown** rather than zero — a figure invented for it would inflate the
    /// headline over rows nobody can check.
    #[test]
    fn an_unpriced_current_printing_is_a_move_with_no_saving() {
        let conn = crate::schema::memory_pair();
        seed(&conn, "unlisted", Some("o1"), "2020-01-01", "{}");
        seed(
            &conn,
            "cheap",
            Some("o1"),
            "2019-01-01",
            r#"{"usd":"2.00"}"#,
        );
        pin(&conn, "unlisted", None, 4);

        let out = plan(&conn, &root()).unwrap();

        assert_eq!(out.moves.len(), 1);
        let m = &out.moves[0];
        assert_eq!(m.from.price, None);
        assert_eq!(m.to.price, Some(2.0));
        assert_eq!(m.saved_per_copy, None);
        assert_eq!(m.saved, None);
    }

    // ── apply ───────────────────────────────────────────────────────────────────────────

    fn item(wish_id: i64, from: &str, to: &str) -> WishOptimizeApplyItem {
        WishOptimizeApplyItem {
            wish_id,
            from_card_id: from.to_owned(),
            to_card_id: to.to_owned(),
        }
    }

    /// Which printing a wish is on now — `None` for a row that is not there, and for one that
    /// names no printing. The tests below only ever ask it about pinned wishes.
    fn card_of(conn: &Connection, wish_id: i64) -> Option<String> {
        conn.query_row(
            "SELECT card_id FROM wishlist_entries WHERE id = ?1",
            params![wish_id],
            |r| r.get(0),
        )
        .optional()
        .unwrap()
        .flatten()
    }

    #[test]
    fn apply_repoints_the_wish_and_answers_changed() {
        let conn = dear_and_cheap();
        let id = pin(&conn, "dear", None, 2);

        let out = apply(&conn, &[item(id, "dear", "cheap")]).unwrap();

        assert_eq!(out.results.len(), 1);
        assert_eq!(out.results[0].wish_id, id);
        assert_eq!(out.results[0].status, WishOptimizeStatus::Changed);
        assert_eq!(card_of(&conn, id).as_deref(), Some("cheap"));
        // The four printing columns move together — `set_printing_inner`'s refresh, rather than
        // a second `UPDATE` written here that could refresh three of them.
        let cn: String = conn
            .query_row(
                "SELECT collector_number FROM wishlist_entries WHERE id = ?1",
                params![id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cn, "cheap");
    }

    /// The merge, reached through `set_printing_inner`: repointing onto a grain a wish already
    /// holds sums the quantities into that row rather than raising `UNIQUE constraint failed`.
    #[test]
    fn apply_folds_onto_a_wish_already_at_that_grain_and_answers_merged() {
        let conn = dear_and_cheap();
        let moving = pin(&conn, "dear", None, 2);
        let sitting = pin(&conn, "cheap", None, 3);

        let out = apply(&conn, &[item(moving, "dear", "cheap")]).unwrap();

        assert_eq!(out.results[0].status, WishOptimizeStatus::Merged);
        // The result still names the **item's** wish, not the survivor: the caller ticked that
        // row and has to be able to match the answer back to what it sent.
        assert_eq!(out.results[0].wish_id, moving);
        assert_eq!(card_of(&conn, moving), None, "the source row is gone");
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM wishlist_entries WHERE id = ?1",
                params![sitting],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 5);
    }

    /// The guard `from_card_id` exists for: a sync landing or another pane repointing the wish
    /// between the preview and the press must not cost the reader a printing they never saw.
    #[test]
    fn apply_refuses_a_wish_that_moved_since_the_preview() {
        let conn = dear_and_cheap();
        seed(
            &conn,
            "third",
            Some("o1"),
            "2021-01-01",
            r#"{"usd":"4.00"}"#,
        );
        let id = pin(&conn, "third", None, 1);

        let out = apply(&conn, &[item(id, "dear", "cheap")]).unwrap();

        assert_eq!(out.results[0].status, WishOptimizeStatus::Stale);
        assert_eq!(
            card_of(&conn, id).as_deref(),
            Some("third"),
            "nothing was written"
        );
    }

    #[test]
    fn apply_answers_missing_for_a_wish_that_is_not_there_any_more() {
        let conn = dear_and_cheap();

        let out = apply(&conn, &[item(9999, "dear", "cheap")]).unwrap();

        assert_eq!(out.results[0].wish_id, 9999);
        assert_eq!(out.results[0].status, WishOptimizeStatus::Missing);
    }

    /// One result per item, in the order they were sent — which is what lets the caller sum the
    /// saving over exactly the rows that moved.
    #[test]
    fn apply_answers_one_result_per_item_in_order() {
        let conn = dear_and_cheap();
        let a = pin(&conn, "dear", None, 1);

        let out = apply(
            &conn,
            &[
                item(9999, "dear", "cheap"),
                item(a, "dear", "cheap"),
                item(a, "dear", "cheap"),
            ],
        )
        .unwrap();

        let got: Vec<(i64, WishOptimizeStatus)> =
            out.results.iter().map(|r| (r.wish_id, r.status)).collect();
        assert_eq!(
            got,
            vec![
                (9999, WishOptimizeStatus::Missing),
                (a, WishOptimizeStatus::Changed),
                // The second press over the same row is stale against its own first: the wish
                // is on `cheap` now, and `from_card_id` still says `dear`.
                (a, WishOptimizeStatus::Stale),
            ]
        );
    }

    /// One transaction for the whole batch: a target printing that has left `cards` since the
    /// preview rolls the earlier items back rather than leaving a shopping list half swept.
    #[test]
    fn a_failed_item_rolls_the_whole_batch_back() {
        let conn = dear_and_cheap();
        seed(
            &conn,
            "dear2",
            Some("o2"),
            "2020-01-01",
            r#"{"usd":"5.00"}"#,
        );
        seed(
            &conn,
            "cheap2",
            Some("o2"),
            "2019-01-01",
            r#"{"usd":"2.00"}"#,
        );
        let first = pin(&conn, "dear", None, 1);
        let second = pin(&conn, "dear2", None, 1);

        let err = apply(
            &conn,
            &[
                item(first, "dear", "cheap"),
                item(second, "dear2", "gone-from-cards"),
            ],
        )
        .unwrap_err();

        assert!(err.contains("card database"), "{err}");
        assert_eq!(
            card_of(&conn, first).as_deref(),
            Some("dear"),
            "the first item was rolled back with the second"
        );
    }
}
