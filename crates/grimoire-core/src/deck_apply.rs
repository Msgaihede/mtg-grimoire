//! Many card writes to one list of one deck, as **one** write — the multi-card gestures' command
//! (`deck_apply`, issue #1164).
//!
//! Adding a picked set to a deck, dragging 200 cards onto another pile, Delete over a picked set,
//! a plural label or "add to the other list" row: each of those used to send one command per
//! card. That was N transactions, N history rows **and N undo steps** — and the journal keeps
//! [`crate::deck_undo::UNDO_STEPS_PER_DECK`] per deck, so adding 300 cards one at a time erased
//! every older step and undoing the add took 300 presses — plus N settles behind the host's
//! `with_write` and N re-reads in the page. Fired in parallel they also queued on the database
//! lock and could be told it was busy. [`apply`] is the one write instead.
//!
//! # What a batch is
//!
//! * **One transaction, the ops in the order given.** Order is part of the request: two adds
//!   filed by name into a pile that does not exist yet find-or-make it once, and every op sees
//!   what the ones before it did.
//! * **Each op is its single command's write, factored rather than copied** — [`DeckOp`] names
//!   which: [`crate::deck::add_row_in`] (and the token reroute,
//!   [`crate::deck_tokens::add_printing_logged`]), [`crate::deck::move_in`],
//!   [`crate::deck::remove_row_in`], [`crate::deck_meta::set_card_label_in`]. The commands are
//!   thin wrappers over the same functions, so the two cannot drift.
//! * **Each op in a savepoint of its own.** An op its command would refuse (a printing not in the
//!   card database, a stale pile, a row that is not there) is rolled back alone and answered in its
//!   [`DeckOpResult::refusal`] with that command's own sentence; the rest of the batch stands. What
//!   would refuse every op — a deck that is gone, a variant that is not one — fails the whole call.
//! * **A refusal is a sentence, never a database error.** The ops' writes answer
//!   [`crate::collection::ItemError`] — `Refused` for the sentences their commands deliberately
//!   answer, `Failed` for anything SQLite said (a constraint, a malformed row, an I/O error, a full
//!   disk) — and a failure fails the whole call with everything rolled back, whether or not it
//!   ended the transaction: a batch must not commit around a write the database would not take.
//!   The single commands answer the same text either way.
//! * **One `touch_deck`, one read of the deck's piles before, one undo step** — see below.
//! * **The history keeps a row per op**, the very row each single command writes (`add`, `move`,
//!   `remove`, `label`, and the token entry's `deck` row): N cheap inserts in the one transaction,
//!   and a History drawer that reads exactly as if the cards had gone one at a time. No new kind
//!   and no summary row — `auditText.ts` has an arm for each of these already.
//!
//! # One step
//!
//! The batch files **one** [`crate::deck_undo`] step, keyed on its last journalled history row
//! ([`crate::deck_undo::record_step`]'s rule for a press that writes several rows), so one Ctrl+Z
//! takes the whole press back and one Ctrl+Y puts it back. It is [`crate::deck_undo::record_cells`]'
//! shape rather than [`crate::deck_undo::record_variant`]'s whole-list snapshot: a scope of the
//! cells the ops touched ([`crate::deck_undo::CellLog`] — each read the first time an op names it,
//! so its "before" is the batch's), the piles the batch made, the token reconcile, and — the part a
//! card command never needs — the token entries the batch's rerouted adds filed
//! ([`crate::deck_tokens::TokenLog`], each token's net before and after). A whole-list snapshot
//! would be simpler and would be refused by any later write to any row of the list that files no
//! step (a cut, a sync pull); the narrow scope is refused only when something touched the cards
//! the press touched, which is what N single steps would have done.
//!
//! **A live cut files no step, here as in [`crate::collection_alloc::deck_to_collection`]** — see
//! [`DeckOp::Remove`] — and so a live cut lands only **ahead of** every write the step records. A
//! batch whose every landed op is a cut files none at all, and nor does one whose writes left
//! every cell, pile and token as they were.
//!
//! **The step's `delta` is the batch's**, the sum of its journalled rows'
//! ([`crate::deck_undo::Step::delta`]), so the reversal's history row undoes three hundred adds as
//! `−300` rather than as the last add's `−1`.

use crate::collection::{EntryChange, ItemError};
use crate::deck::{AddPile, NO_CATEGORY};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

/// One card write of a batch. Each arm is the arguments of the single command it stands for, less
/// the deck and the variant, which are the batch's.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DeckOp {
    /// `deck_add_card`'s arguments.
    Add {
        card_id: String,
        category_id: Option<i64>,
        category_name: Option<String>,
        finish: Option<String>,
        quantity: i64,
    },
    /// `deck_move_card`'s arguments.
    Move {
        card_id: String,
        from_category_id: i64,
        to_category_id: Option<i64>,
        to_category_name: Option<String>,
        finish: Option<String>,
    },
    /// Take the whole row out — what Delete / "Remove" does to one card today.
    ///
    /// **Which single command that is depends on the list, and this reproduces both.** The page
    /// (`useDeckCore.ts`' `setQuantity`) sends a removal from the **live** list of a deck that
    /// keeps cardboard through `deck_to_collection` with the row's whole quantity, and every other
    /// removal (a theory row, a virtual deck) through `deck_set_card_quantity(…, 0)`. Both delete
    /// the row, both give its displaced copies back to `Recently removed` through the one
    /// [`crate::deck::release_displaced_copies`], both write the same `remove` history row — the
    /// one difference is the undo step: the cut files **none**, by
    /// [`crate::collection_alloc::deck_to_collection`]'s argued decision (a step can put the list
    /// back and not the custody, and a half-step is worse than none), and the stepper files one.
    /// So a live cut here is [`crate::deck::remove_row_in`] with no cell noted, and any other
    /// removal is noted like any write. A row that is not there is `deck_set_card_quantity`'s
    /// zero: nothing written, answered `removed: true` with id `0`.
    ///
    /// **A live cut is refused ([`CUT_AFTER_A_WRITE`]) once an earlier op of the batch has noted
    /// anything for the step** — a cell or a token — and lands freely before. Kept out of a step
    /// that has already begun, a cut would leave half a step behind: `[move X A→B, cut X from B]`
    /// would undo to X back in A with its copies in `Recently removed` (the half-step
    /// `deck_to_collection` refuses to file); `[add X, cut X]` a step that changes nothing; and the
    /// token reconcile of `[add Z, cut Y]`, Y a token maker, would put Y's token into Z's step. So
    /// the cuts of a press come first, and — the backstop a single cut gets from its host's
    /// `with_write` — the list's tokens are reconciled after them, before the first other op, so
    /// that what the cuts stopped making is settled outside the step as a cut's always is. No
    /// gesture mixes the two today: Delete over a picked set sends cuts alone.
    Remove {
        card_id: String,
        category_id: i64,
        finish: Option<String>,
    },
    /// `deck_card_set_label`'s arguments.
    SetLabel {
        card_id: String,
        category_id: i64,
        finish: Option<String>,
        label_id: Option<i64>,
    },
    /// `deck_add_card_to_other_list`'s arguments: the batch's variant is the list the copies go
    /// **into**, and `from_category_id` the pile of the other list they sit in now.
    AddToOtherList {
        card_id: String,
        from_category_id: i64,
        finish: Option<String>,
        quantity: i64,
    },
}

/// What [`apply`] answers.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckApplyOutcome {
    /// One per op, in input order.
    pub results: Vec<DeckOpResult>,
    /// How many ops landed (results with no refusal).
    pub landed: i64,
    /// Whether any `collection_entries` row changed (a removal on a live list released copies),
    /// so the caller knows to re-read the collection.
    pub collection_moved: bool,
}

/// What one op of a batch did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckOpResult {
    /// What the single command would have answered, where it answers an `EntryChange`
    /// (add: id `0` for a token rerouted to a token entry; remove: `removed: true`). `None` for
    /// a refused op and for ops whose single command answers nothing useful.
    pub change: Option<EntryChange>,
    /// The pile the op's row ended in, where the op knows it (add: the pile found or created —
    /// `None` for a rerouted token; move: the target pile, i.e. what `deck_move_card` answers).
    pub category_id: Option<i64>,
    /// `Some(sentence)` when this op was refused — the same sentence the single command rejects
    /// with. The op was rolled back alone; the rest of the batch stands.
    pub refusal: Option<String>,
}

/// Whether a batch can change a `collection_entries` row — a removal on the live list — and so
/// whether its host has to refresh the facet index's `owned` dimension
/// (`collection_source::with_write_owned`) rather than take plain `with_write`.
///
/// Read off the request alone, before the lock is taken: a virtual deck answers `true` here and
/// moves nothing, which costs one index refresh and nothing else.
pub fn moves_copies(variant: &str, ops: &[DeckOp]) -> bool {
    variant == crate::schema::DECK_VARIANTS[0]
        && ops.iter().any(|op| matches!(op, DeckOp::Remove { .. }))
}

/// What a live cut that comes after a write of the same batch is answered — see [`DeckOp::Remove`].
pub const CUT_AFTER_A_WRITE: &str =
    "That card was not taken out of the deck: in one change, cards \
     come out of a deck that keeps its cardboard before anything else is changed. Remove it on \
     its own.";

/// The savepoint each op runs in. One name, reused: an op releases or rolls back to it before
/// the next one opens it again, so the nesting is never more than one deep.
const OP_SAVEPOINT: &str = "deck_apply_op";

/// Apply `ops` to list `variant` of deck `deck_id`, in order, in one transaction — see the module
/// doc. An empty batch answers at once and writes nothing, not even the deck's `updated_at`.
pub fn apply(
    conn: &Connection,
    deck_id: i64,
    variant: &str,
    ops: &[DeckOp],
) -> Result<DeckApplyOutcome, String> {
    let variant = crate::deck_meta::valid_variant(variant)?;
    if ops.is_empty() {
        return Ok(DeckApplyOutcome {
            results: Vec::new(),
            landed: 0,
            collection_moved: false,
        });
    }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // **Once for the batch**: the deck fence every card command opens with (a stale editor's dead
    // deck hears `GONE` here, for every op at once), and the piles as they stood — the diff an
    // undo takes the piles the batch made away by.
    crate::deck::touch_deck(&tx, deck_id)?;
    let categories_before = crate::deck_undo::category_ids(&tx, deck_id)?;
    // Whether a removal here is a cut — the deck's kind is the deck's, so once.
    let cuts = moves_copies(variant, ops) && !crate::deck::is_virtual(&tx, deck_id)?;

    let mut batch = Batch {
        deck_id,
        variant,
        cuts,
        cells: crate::deck_undo::CellLog::default(),
        tokens: crate::deck_tokens::TokenLog::default(),
    };
    let mut results = Vec::with_capacity(ops.len());
    let mut landed = 0;
    let mut wrote = false;
    let mut collection_moved = false;
    let mut journalled: Vec<i64> = Vec::new();
    // A cut landed since the list's tokens were last reconciled — see [`DeckOp::Remove`].
    let mut cut_unsettled = false;
    for op in ops {
        let is_cut = batch.cuts && matches!(op, DeckOp::Remove { .. });
        if cut_unsettled && !is_cut {
            // What the cuts stopped making, settled before anything is noted for the step — its
            // own transaction's backstop, as `with_write` runs one after a single cut. A
            // variant and the database are its only answers, and the variant is settled.
            crate::deck_tokens::reconcile_in(&tx, deck_id, &[variant])?;
            cut_unsettled = false;
        }
        let marks = (batch.cells.mark(), batch.tokens.mark());
        tx.execute_batch(&format!("SAVEPOINT {OP_SAVEPOINT}"))
            .map_err(|e| e.to_string())?;
        match batch.one(&tx, op) {
            Ok(done) => {
                tx.execute_batch(&format!("RELEASE {OP_SAVEPOINT}"))
                    .map_err(|e| e.to_string())?;
                wrote |= done.wrote;
                collection_moved |= done.copies_moved;
                cut_unsettled |= is_cut && done.wrote;
                journalled.extend(done.journalled);
                landed += 1;
                results.push(DeckOpResult {
                    change: done.change,
                    category_id: done.category_id,
                    refusal: None,
                });
            }
            // A database that failed under an op is not that op's refusal: nothing after it can
            // be expected to land, and nothing before it may commit around it. Dropped, the
            // transaction takes every op back.
            Err(ItemError::Failed(e)) => return Err(e),
            Err(ItemError::Refused(refusal)) => {
                // A refusal that somehow ended the transaction has nothing left to roll back to.
                if tx.is_autocommit() {
                    return Err(refusal);
                }
                tx.execute_batch(&format!(
                    "ROLLBACK TO {OP_SAVEPOINT}; RELEASE {OP_SAVEPOINT}"
                ))
                .map_err(|e| e.to_string())?;
                batch.cells.rewind(marks.0);
                batch.tokens.rewind(marks.1);
                results.push(DeckOpResult {
                    change: None,
                    category_id: None,
                    refusal: Some(refusal),
                });
            }
        }
    }
    // A batch that wrote nothing — every op refused, or every one a no-op its command writes
    // nothing for (a card moved onto its own pile, a removal of a row already gone) — leaves the
    // deck as it found it, `updated_at` included: dropped, the transaction rolls the touch back,
    // as each of those commands does alone.
    if !wrote {
        return Ok(DeckApplyOutcome {
            results,
            landed,
            collection_moved: false,
        });
    }
    if let Some(&audit_id) = journalled.last() {
        crate::deck_undo::record_logged(
            &tx,
            audit_id,
            deck_id,
            batch.cells,
            Some(categories_before),
            &batch.tokens,
            net_delta(&tx, &journalled)?,
        )?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(DeckApplyOutcome {
        results,
        landed,
        collection_moved,
    })
}

/// The copies the batch's journalled history rows add up to — the `delta` its step's reversal
/// negates. Read back rather than added up as the ops go, so it is exactly what the History
/// drawer's day header sums for those rows.
fn net_delta(tx: &Connection, journalled: &[i64]) -> Result<i64, String> {
    let mut stmt = tx
        .prepare_cached("SELECT delta FROM deck_audit WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    let mut net = 0;
    for id in journalled {
        let delta: i64 = stmt
            .query_row([id], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        net += delta;
    }
    Ok(net)
}

/// The batch's standing facts and the two logs its one step is built from.
struct Batch<'v> {
    deck_id: i64,
    variant: &'v str,
    /// A removal is a live cut — the live list of a deck that keeps cardboard — and files no step.
    cuts: bool,
    cells: crate::deck_undo::CellLog,
    tokens: crate::deck_tokens::TokenLog,
}

/// What one op did, for the batch's answer and its step.
#[derive(Default)]
struct Done {
    change: Option<EntryChange>,
    category_id: Option<i64>,
    /// The history row a step may key on — `None` for an op that wrote none, and for a cut.
    journalled: Option<i64>,
    /// Whether the op wrote anything at all.
    wrote: bool,
    copies_moved: bool,
}

impl Batch<'_> {
    /// One op, inside its savepoint: its command's refusal, or a failure that fails the batch.
    fn one(&mut self, tx: &Connection, op: &DeckOp) -> Result<Done, ItemError> {
        let (deck_id, variant) = (self.deck_id, self.variant);
        match op {
            DeckOp::Add {
                card_id,
                category_id,
                category_name,
                finish,
                quantity,
            } => {
                // `add_card`'s rule: the id wins when both arrive, and neither is `NO_CATEGORY`.
                let pile = match (category_id, category_name) {
                    (Some(id), _) => Some(AddPile::Id(*id)),
                    (None, Some(name)) => Some(AddPile::Name(name)),
                    (None, None) => None,
                };
                self.add(tx, card_id, pile, finish.as_deref(), *quantity)
            }
            DeckOp::AddToOtherList {
                card_id,
                from_category_id,
                finish,
                quantity,
            } => {
                let pile = Some(AddPile::CounterpartOf(*from_category_id));
                self.add(tx, card_id, pile, finish.as_deref(), *quantity)
            }
            DeckOp::Move {
                card_id,
                from_category_id,
                to_category_id,
                to_category_name,
                finish,
            } => {
                let finish =
                    crate::deck::normalise_finish(finish.as_deref()).map_err(ItemError::Refused)?;
                if to_category_id.is_none() && to_category_name.is_none() {
                    return Err(ItemError::Refused(NO_CATEGORY.to_owned()));
                }
                // A move into a switched-off pile changes what the list makes.
                self.tokens.list_changed();
                let moved = crate::deck::move_in(
                    tx,
                    deck_id,
                    card_id,
                    *from_category_id,
                    *to_category_id,
                    to_category_name.as_deref(),
                    variant,
                    finish.as_deref(),
                    &mut self.cells,
                )?;
                Ok(Done {
                    category_id: Some(moved.to),
                    journalled: moved.audit_id,
                    wrote: moved.audit_id.is_some(),
                    ..Done::default()
                })
            }
            DeckOp::Remove {
                card_id,
                category_id,
                finish,
            } => {
                let finish =
                    crate::deck::normalise_finish(finish.as_deref()).map_err(ItemError::Refused)?;
                let category =
                    crate::deck::category_of_deck_in(tx, deck_id, variant, *category_id)?;
                // After the command's own fences, so a stale pile still hears its own sentence.
                if self.cuts && !(self.cells.is_empty() && self.tokens.is_empty()) {
                    return Err(ItemError::Refused(CUT_AFTER_A_WRITE.to_owned()));
                }
                self.tokens.list_changed();
                let log = (!self.cuts).then_some(&mut self.cells);
                let removed = crate::deck::remove_row_in(
                    tx,
                    deck_id,
                    card_id,
                    *category_id,
                    &category,
                    variant,
                    finish.as_deref(),
                    log,
                )?;
                Ok(Done {
                    change: Some(EntryChange {
                        id: removed.as_ref().map_or(0, |r| r.id),
                        quantity: 0,
                        removed: true,
                    }),
                    journalled: removed.as_ref().filter(|_| !self.cuts).map(|r| r.audit_id),
                    wrote: removed.is_some(),
                    copies_moved: removed.as_ref().is_some_and(|r| r.released.moved > 0),
                    ..Done::default()
                })
            }
            DeckOp::SetLabel {
                card_id,
                category_id,
                finish,
                label_id,
            } => {
                // No `list_changed`: a label is not something a derivation reads.
                let finish =
                    crate::deck::normalise_finish(finish.as_deref()).map_err(ItemError::Refused)?;
                let audit_id = crate::deck_meta::set_card_label_in(
                    tx,
                    deck_id,
                    card_id,
                    *category_id,
                    variant,
                    finish.as_deref(),
                    *label_id,
                    false,
                    &mut self.cells,
                )?;
                Ok(Done {
                    category_id: Some(*category_id),
                    journalled: Some(audit_id),
                    wrote: true,
                    ..Done::default()
                })
            }
        }
    }

    /// `deck_add_card` and `deck_add_card_to_other_list`: [`crate::deck::add_fences`], then the
    /// token reroute or the deck-card write — `add_card_in`'s two halves.
    fn add(
        &mut self,
        tx: &Connection,
        card_id: &str,
        pile: Option<AddPile<'_>>,
        finish: Option<&str>,
        quantity: i64,
    ) -> Result<Done, ItemError> {
        let fenced = crate::deck::add_fences(tx, card_id, pile, self.variant, finish, quantity)?;
        if fenced.is_token {
            let (landed, audit_id) = crate::deck_tokens::add_printing_logged(
                tx,
                self.deck_id,
                self.variant,
                card_id,
                fenced.finish.as_deref(),
                quantity,
                &mut self.tokens,
            )?;
            // `add_card`'s contract for a reroute: id `0`, the entry's count, no pile.
            return Ok(Done {
                change: Some(EntryChange {
                    id: 0,
                    quantity: landed,
                    removed: false,
                }),
                journalled: audit_id,
                wrote: audit_id.is_some(),
                ..Done::default()
            });
        }
        self.tokens.list_changed();
        let added = crate::deck::add_row_in(
            tx,
            self.deck_id,
            card_id,
            fenced.pile,
            self.variant,
            fenced.finish.as_deref(),
            quantity,
            fenced.printing,
            &mut self.cells,
        )?;
        Ok(Done {
            change: Some(added.change),
            category_id: Some(added.category_id),
            journalled: Some(added.audit_id),
            wrote: true,
            ..Done::default()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::fixtures::{input, kind_of, main_of, seeded};
    use crate::deck::{add_card, create_deck};
    use rusqlite::params;
    use serde_json::json;

    const LIVE: &str = "live";
    const TREASURE: &str = "treasure-tok";

    /// [`seeded`], with a Treasure token printing beside its five cards — a printing nothing in
    /// any deck makes, so an add of it is filed as a hand-added (`manual`) token entry.
    fn db() -> Connection {
        let conn = seeded();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        conn.execute(
            "INSERT INTO cards
                 (id, oracle_id, name, type_line, layout, colors, oracle_text, set_code,
                  collector_number, lang, released_at, raw, set_name, rarity, finishes, prices)
             VALUES (?1, 'o-treasure', 'Treasure', 'Token Artifact — Treasure', 'token', '',
                     '', 'tcmm', '48', 'en', '2023-08-04', ?2, 'Commander Masters Tokens',
                     'common', '[\"nonfoil\"]', '{}')",
            params![
                TREASURE,
                crate::card_row::gzip_raw(
                    &json!({ "id": TREASURE, "name": "Treasure" }).to_string()
                )
            ],
        )
        .unwrap();
        conn
    }

    /// `n` plain printings `p0…`, for the batches that need many distinct cells.
    fn seed_many(conn: &Connection, n: usize) {
        let mut stmt = conn
            .prepare(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                    rarity, finishes, prices, raw)
                 VALUES (?1, ?2, ?3, 'tst', ?4, 'en', 'normal', 'common', '[\"nonfoil\"]',
                         '{}', '{}')",
            )
            .unwrap();
        for i in 0..n {
            stmt.execute(params![
                format!("p{i}"),
                format!("o-p{i}"),
                format!("Card {i}"),
                i.to_string()
            ])
            .unwrap();
        }
    }

    fn deck(conn: &Connection, name: &str) -> i64 {
        create_deck(conn, &input(name, "modern")).unwrap().id
    }

    /// A deck's list as content, piles by name — so two decks (or two databases) compare.
    type Row = (String, String, String, Option<String>, i64, Option<i64>);
    fn list(conn: &Connection, deck_id: i64) -> Vec<Row> {
        conn.prepare(
            "SELECT dc.variant, c.name, dc.card_id, dc.finish, dc.quantity, dc.label_id
               FROM deck_cards dc JOIN deck_categories c ON c.id = dc.category_id
              WHERE dc.deck_id = ?1
              ORDER BY dc.variant, c.name, dc.card_id, dc.finish",
        )
        .unwrap()
        .query_map(params![deck_id], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
            ))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn piles(conn: &Connection, deck_id: i64) -> Vec<(String, String, String)> {
        conn.prepare(
            "SELECT variant, name, origin FROM deck_categories WHERE deck_id = ?1
              ORDER BY variant, name",
        )
        .unwrap()
        .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn tokens(conn: &Connection, deck_id: i64) -> Vec<(String, String, String, i64)> {
        conn.prepare(
            "SELECT variant, card_id, finish, quantity FROM deck_token_printings
              WHERE deck_id = ?1 ORDER BY variant, card_id, finish",
        )
        .unwrap()
        .query_map(params![deck_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    fn token_states(conn: &Connection, deck_id: i64) -> Vec<(String, String)> {
        conn.prepare("SELECT oracle_id, state FROM deck_tokens WHERE deck_id = ?1 ORDER BY 1")
            .unwrap()
            .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    /// Everything one Ctrl+Z has to put back.
    type Whole = (
        Vec<Row>,
        Vec<(String, String, String)>,
        Vec<(String, String, String, i64)>,
        Vec<(String, String)>,
    );
    fn whole(conn: &Connection, deck_id: i64) -> Whole {
        (
            list(conn, deck_id),
            piles(conn, deck_id),
            tokens(conn, deck_id),
            token_states(conn, deck_id),
        )
    }

    fn steps(conn: &Connection, deck_id: i64) -> i64 {
        conn.query_row(
            "SELECT count(*) FROM deck_undo WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn audits(conn: &Connection, deck_id: i64) -> Vec<(String, Option<String>)> {
        conn.prepare("SELECT kind, card_id FROM deck_audit WHERE deck_id = ?1 ORDER BY id")
            .unwrap()
            .query_map(params![deck_id], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn undo(conn: &Connection, deck_id: i64) -> i64 {
        let cursor = crate::deck_undo::next_undo(conn, deck_id)
            .unwrap()
            .expect("a step to undo");
        crate::deck_undo::apply_reversal(conn, deck_id, cursor, true).unwrap();
        cursor
    }

    fn add_op(card_id: &str, category_id: Option<i64>, name: Option<&str>, qty: i64) -> DeckOp {
        DeckOp::Add {
            card_id: card_id.to_owned(),
            category_id,
            category_name: name.map(str::to_owned),
            finish: None,
            quantity: qty,
        }
    }

    fn ok(outcome: &DeckApplyOutcome) {
        let refused: Vec<_> = outcome
            .results
            .iter()
            .filter_map(|r| r.refusal.as_deref())
            .collect();
        assert!(refused.is_empty(), "nothing refused: {refused:?}");
    }

    /// The wire is the contract the TypeScript mirror is written against.
    #[test]
    fn the_ops_and_the_outcome_are_spelled_as_the_wire_spells_them() {
        let ops: Vec<DeckOp> = serde_json::from_value(json!([
            { "op": "add", "cardId": "a", "categoryId": null, "categoryName": "Ramp",
              "finish": null, "quantity": 2 },
            { "op": "move", "cardId": "a", "fromCategoryId": 1, "toCategoryId": 2,
              "toCategoryName": null, "finish": "foil" },
            { "op": "remove", "cardId": "a", "categoryId": 1, "finish": null },
            { "op": "setLabel", "cardId": "a", "categoryId": 1, "finish": null, "labelId": 3 },
            { "op": "addToOtherList", "cardId": "a", "fromCategoryId": 1, "finish": null,
              "quantity": 1 },
        ]))
        .unwrap();
        assert_eq!(ops.len(), 5);
        assert!(matches!(
            &ops[3],
            DeckOp::SetLabel {
                label_id: Some(3),
                ..
            }
        ));
        let answer = serde_json::to_value(DeckApplyOutcome {
            results: vec![DeckOpResult {
                change: Some(EntryChange {
                    id: 0,
                    quantity: 1,
                    removed: false,
                }),
                category_id: None,
                refusal: None,
            }],
            landed: 1,
            collection_moved: false,
        })
        .unwrap();
        assert_eq!(
            answer,
            json!({
                "results": [{ "change": { "id": 0, "quantity": 1, "removed": false },
                              "categoryId": null, "refusal": null }],
                "landed": 1, "collectionMoved": false,
            })
        );
    }

    /// (a) A batch of adds lands what the same adds one at a time land — two cards filed by name
    /// into a pile neither deck has yet make it once, and a token is rerouted to a token entry
    /// with id 0 and no pile — and journals one step where the singles journal one each.
    #[test]
    fn a_batch_of_adds_lands_what_the_same_adds_one_at_a_time_land() {
        let conn = db();
        let (one, many) = (deck(&conn, "Singles"), deck(&conn, "Batch"));
        let ops = |main: i64| {
            vec![
                add_op("bolt-m10", Some(main), None, 2),
                add_op("serra-lea", None, Some("Angels"), 1),
                add_op("serra-8ed", None, Some("Angels"), 3),
                add_op(TREASURE, Some(main), None, 2),
                add_op("bolt-m10", Some(main), None, 1),
                add_op(TREASURE, None, Some("Tokens"), 1),
            ]
        };
        let main_one = main_of(&conn, one);
        let before_one = steps(&conn, one);
        let mut singles = Vec::new();
        for op in ops(main_one) {
            let DeckOp::Add {
                card_id,
                category_id,
                category_name,
                quantity,
                ..
            } = op
            else {
                unreachable!()
            };
            singles.push(
                add_card(
                    &conn,
                    one,
                    &card_id,
                    category_id,
                    category_name.as_deref(),
                    LIVE,
                    None,
                    quantity,
                )
                .unwrap(),
            );
        }
        assert_eq!(steps(&conn, one) - before_one, 6, "one step a press");

        let main_many = main_of(&conn, many);
        let before_many = steps(&conn, many);
        let outcome = apply(&conn, many, LIVE, &ops(main_many)).unwrap();
        ok(&outcome);
        assert_eq!(outcome.landed, 6);
        assert!(!outcome.collection_moved);
        assert_eq!(
            steps(&conn, many) - before_many,
            1,
            "one step for the press"
        );
        assert_eq!(whole(&conn, many), whole(&conn, one));
        assert_eq!(
            audits(&conn, many).len(),
            audits(&conn, one).len(),
            "a history row per op, as the singles write"
        );

        let r = &outcome.results;
        assert_eq!(r[0].category_id, Some(main_many));
        let angels = r[1].category_id.expect("the pile made by name");
        assert_eq!(r[2].category_id, Some(angels), "found, not made twice");
        assert_eq!(
            piles(&conn, many)
                .iter()
                .filter(|(_, name, _)| name == "Angels")
                .count(),
            1
        );
        let token = r[3].change.as_ref().unwrap();
        assert_eq!(
            (token.id, token.quantity),
            (0, 2),
            "the reroute answers id 0"
        );
        assert_eq!(r[3].category_id, None);
        assert_eq!(r[5].change.as_ref().unwrap().quantity, 3);
        assert!(
            piles(&conn, many)
                .iter()
                .all(|(_, name, _)| name != "Tokens"),
            "a token's name arm makes no pile"
        );
        for (single, batched) in singles.iter().zip(r) {
            let b = batched.change.as_ref().unwrap();
            assert_eq!((single.quantity, single.removed), (b.quantity, b.removed));
            assert_eq!(single.id == 0, b.id == 0);
        }
    }

    /// (b) One Ctrl+Z after a 50-op mixed batch puts back exactly the list, the piles, the token
    /// entries and their state; one Ctrl+Y puts the batch back; exactly one step was journalled.
    #[test]
    fn one_undo_takes_a_mixed_batch_back_and_one_redo_puts_it_back() {
        let conn = db();
        seed_many(&conn, 40);
        let d = deck(&conn, "Mixed");
        let main = main_of(&conn, d);
        let side = kind_of(&conn, d, "side");
        for i in 0..10 {
            add_card(&conn, d, &format!("p{i}"), Some(main), None, LIVE, None, 2).unwrap();
        }
        // Theory off and a virtual deck, so removals are not cuts and file their step.
        conn.execute(
            "UPDATE decks SET virtual_only = 1 WHERE id = ?1",
            params![d],
        )
        .unwrap();
        let label = crate::deck_meta::create_label(&conn, None, "Flex", "amber")
            .unwrap()
            .id;
        let before = whole(&conn, d);
        let steps_before = steps(&conn, d);

        let mut ops = Vec::new();
        for i in 10..30 {
            let name = if i % 2 == 0 { "Ramp" } else { "Draw" };
            ops.push(add_op(&format!("p{i}"), None, Some(name), 1));
        }
        for i in 0..5 {
            ops.push(DeckOp::Move {
                card_id: format!("p{i}"),
                from_category_id: main,
                to_category_id: Some(side),
                to_category_name: None,
                finish: None,
            });
        }
        for i in 5..8 {
            ops.push(DeckOp::Remove {
                card_id: format!("p{i}"),
                category_id: main,
                finish: None,
            });
        }
        for i in 8..10 {
            ops.push(DeckOp::SetLabel {
                card_id: format!("p{i}"),
                category_id: main,
                finish: None,
                label_id: Some(label),
            });
        }
        ops.push(add_op(TREASURE, Some(main), None, 3));
        for i in 30..40 {
            ops.push(add_op(&format!("p{i}"), Some(main), None, 1));
        }
        // A card added and then moved in the same press, and one moved twice.
        ops.push(DeckOp::Move {
            card_id: "p30".into(),
            from_category_id: main,
            to_category_id: None,
            to_category_name: Some("Ramp".into()),
            finish: None,
        });
        ops.push(DeckOp::Move {
            card_id: "p0".into(),
            from_category_id: side,
            to_category_id: Some(main),
            to_category_name: None,
            finish: None,
        });
        ops.push(add_op("p1", Some(side), None, 1));
        ops.push(add_op(TREASURE, Some(main), None, 1));
        while ops.len() < 50 {
            ops.push(add_op("p31", Some(main), None, 1));
        }
        assert_eq!(ops.len(), 50);

        let outcome = apply(&conn, d, LIVE, &ops).unwrap();
        ok(&outcome);
        let after = whole(&conn, d);
        assert_ne!(after, before);
        assert_eq!(steps(&conn, d) - steps_before, 1, "exactly one step");

        undo(&conn, d);
        assert_eq!(
            whole(&conn, d),
            before,
            "one Ctrl+Z restores the list exactly"
        );
        let id = crate::deck_undo::next_redo(&conn, d)
            .unwrap()
            .expect("the batch to redo");
        crate::deck_undo::apply_reversal(&conn, d, id, false).unwrap();
        assert_eq!(whole(&conn, d), after, "one Ctrl+Y puts it back");
        undo(&conn, d);
        assert_eq!(whole(&conn, d), before, "and it goes back again");
    }

    /// (c) A refused op in the middle is answered at its index with its command's sentence and
    /// rolled back alone — the pile its name arm would have made included; the others land.
    #[test]
    fn a_refused_op_is_answered_at_its_index_and_the_rest_land() {
        let conn = db();
        let d = deck(&conn, "Refusals");
        let main = main_of(&conn, d);
        let single = add_card(&conn, d, "nope", None, Some("Ghosts"), LIVE, None, 1).unwrap_err();
        let ops = vec![
            add_op("bolt-m10", Some(main), None, 1),
            add_op("nope", None, Some("Ghosts"), 1),
            add_op("serra-lea", Some(main), None, 0),
            DeckOp::Remove {
                card_id: "serra-lea".into(),
                category_id: 999_999,
                finish: None,
            },
            add_op("serra-lea", Some(main), None, 1),
        ];
        let outcome = apply(&conn, d, LIVE, &ops).unwrap();
        assert_eq!(outcome.landed, 2);
        let refusals: Vec<_> = outcome.results.iter().map(|r| r.refusal.clone()).collect();
        assert_eq!(refusals[0], None);
        assert_eq!(refusals[1].as_deref(), Some(single.as_str()));
        assert_eq!(refusals[2].as_deref(), Some(crate::collection::ZERO_ADD));
        assert_eq!(
            refusals[3].as_deref(),
            Some(crate::deck_meta::CATEGORY_GONE)
        );
        assert_eq!(refusals[4], None);
        assert!(outcome.results[1].change.is_none());
        assert!(piles(&conn, d).iter().all(|(_, name, _)| name != "Ghosts"));
        assert_eq!(list(&conn, d).len(), 2);

        // A deck that is gone refuses the whole call, in `GONE`'s words.
        assert_eq!(
            apply(&conn, 424_242, LIVE, &ops).unwrap_err(),
            crate::deck::GONE
        );
        assert!(apply(&conn, d, "draft", &ops).is_err());
    }

    /// (d) Move, SetLabel and AddToOtherList each leave what their command leaves.
    #[test]
    fn move_label_and_the_other_list_match_their_commands() {
        let conn = db();
        let label = crate::deck_meta::create_label(&conn, None, "Cut", "red")
            .unwrap()
            .id;
        let mut theory_input = input("x", "modern");
        theory_input.theory_enabled = Some(true);
        let run = |batched: bool| {
            let d = create_deck(&conn, &theory_input).unwrap().id;
            let main = main_of(&conn, d);
            add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 2).unwrap();
            add_card(&conn, d, "serra-lea", Some(main), None, LIVE, None, 1).unwrap();
            let side = kind_of(&conn, d, "side");
            if batched {
                let outcome = apply(
                    &conn,
                    d,
                    LIVE,
                    &[
                        DeckOp::Move {
                            card_id: "bolt-m10".into(),
                            from_category_id: main,
                            to_category_id: Some(side),
                            to_category_name: None,
                            finish: None,
                        },
                        DeckOp::SetLabel {
                            card_id: "serra-lea".into(),
                            category_id: main,
                            finish: None,
                            label_id: Some(label),
                        },
                    ],
                )
                .unwrap();
                ok(&outcome);
                assert_eq!(outcome.results[0].category_id, Some(side));
                let other = apply(
                    &conn,
                    d,
                    crate::deck::THEORY,
                    &[DeckOp::AddToOtherList {
                        card_id: "serra-lea".into(),
                        from_category_id: main,
                        finish: None,
                        quantity: 2,
                    }],
                )
                .unwrap();
                ok(&other);
                assert_eq!(other.results[0].change.as_ref().unwrap().quantity, 2);
            } else {
                let to = crate::deck::move_card(
                    &conn,
                    d,
                    "bolt-m10",
                    main,
                    Some(side),
                    None,
                    LIVE,
                    None,
                )
                .unwrap();
                assert_eq!(to, side);
                crate::deck_meta::set_card_label(
                    &conn,
                    d,
                    "serra-lea",
                    main,
                    LIVE,
                    None,
                    Some(label),
                )
                .unwrap();
                crate::deck::add_card_to_other_list(
                    &conn,
                    d,
                    "serra-lea",
                    main,
                    crate::deck::THEORY,
                    None,
                    2,
                )
                .unwrap();
            }
            (whole(&conn, d), audits(&conn, d))
        };
        let singles = run(false);
        let batch = run(true);
        assert_eq!(batch.0, singles.0);
        assert_eq!(
            batch.1.iter().map(|a| &a.0).collect::<Vec<_>>(),
            singles.1.iter().map(|a| &a.0).collect::<Vec<_>>(),
            "the same history rows, in the same order"
        );
    }

    /// (d) A removal on the theory list (no copies, a step) and on a live list with copies held
    /// (the cut: the copies go where `deck_to_collection` puts them, no step) each match the
    /// command the page sends for them today.
    #[test]
    fn remove_matches_the_command_the_page_sends_for_it() {
        // Theory: `deck_set_card_quantity(…, 0)`.
        let conn = db();
        let mut theory_input = input("x", "modern");
        theory_input.theory_enabled = Some(true);
        let plan = |conn: &Connection| {
            let d = create_deck(conn, &theory_input).unwrap().id;
            let pile = crate::deck::fixtures::plan_pile(conn, d, main_of(conn, d));
            add_card(conn, d, "bolt-m10", Some(pile), None, "theory", None, 3).unwrap();
            (d, pile)
        };
        let (a, pile_a) = plan(&conn);
        crate::deck::set_card_quantity(&conn, a, "bolt-m10", pile_a, "theory", None, 0).unwrap();
        let (b, pile_b) = plan(&conn);
        let steps_b = steps(&conn, b);
        let outcome = apply(
            &conn,
            b,
            "theory",
            &[DeckOp::Remove {
                card_id: "bolt-m10".into(),
                category_id: pile_b,
                finish: None,
            }],
        )
        .unwrap();
        ok(&outcome);
        assert!(outcome.results[0].change.as_ref().unwrap().removed);
        assert!(!outcome.collection_moved);
        assert_eq!(whole(&conn, b), whole(&conn, a));
        assert_eq!(
            steps(&conn, b) - steps_b,
            1,
            "a theory removal files its step"
        );
        undo(&conn, b);
        assert_eq!(list(&conn, b).len(), 1, "and Ctrl+Z puts the row back");

        // Live, with copies held: `deck_to_collection(id, quantity)`, in two databases so the
        // one `Recently removed` folder is each run's own.
        let cut = |batched: bool| {
            let conn = db();
            let d = deck(&conn, "Cut");
            let main = main_of(&conn, d);
            let row = add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 3).unwrap();
            add_card(&conn, d, "serra-lea", Some(main), None, LIVE, None, 1).unwrap();
            let group: i64 = conn
                .query_row(
                    "SELECT id FROM collection_folders WHERE deck_id = ?1",
                    params![d],
                    |r| r.get(0),
                )
                .unwrap();
            let entry = crate::collection::add_entry(
                &conn,
                &crate::collection::EntryInput {
                    card_id: "bolt-m10".into(),
                    finish: "nonfoil".into(),
                    quantity: 2,
                    ..Default::default()
                },
            )
            .unwrap()
            .id;
            crate::collection_folders::refile_entry(&conn, entry, Some(group)).unwrap();
            let steps_before = steps(&conn, d);
            let moved = if batched {
                let outcome = apply(
                    &conn,
                    d,
                    LIVE,
                    &[DeckOp::Remove {
                        card_id: "bolt-m10".into(),
                        category_id: main,
                        finish: None,
                    }],
                )
                .unwrap();
                ok(&outcome);
                assert_eq!(outcome.results[0].change.as_ref().unwrap().id, row.id);
                outcome.collection_moved
            } else {
                crate::collection_alloc::deck_to_collection(&conn, row.id, 3)
                    .unwrap()
                    .quantity
                    > 0
            };
            let copies: Vec<(String, String, i64)> = conn
                .prepare(
                    "SELECT f.kind, e.card_id, e.quantity FROM collection_entries e
                       LEFT JOIN collection_folders f ON f.id = e.folder_id
                      ORDER BY f.kind, e.card_id",
                )
                .unwrap()
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            (
                whole(&conn, d),
                copies,
                moved,
                steps(&conn, d) - steps_before,
                audits(&conn, d),
            )
        };
        let single = cut(false);
        let batch = cut(true);
        assert_eq!(batch.0, single.0, "the same list");
        assert_eq!(
            batch.1, single.1,
            "the copies where a single Delete puts them"
        );
        assert!(single
            .1
            .iter()
            .any(|(kind, _, q)| kind == "removed" && *q == 2));
        assert!(batch.2, "collection_moved");
        assert_eq!(single.3, 0, "the cut files no step");
        assert_eq!(batch.3, 0, "nor does a batch of one");
        assert_eq!(
            batch.4.iter().map(|a| &a.0).collect::<Vec<_>>(),
            single.4.iter().map(|a| &a.0).collect::<Vec<_>>()
        );
    }

    /// (d) A live cut files no step at all, and one ahead of an add stays out of the add's step:
    /// Ctrl+Z takes back the add and leaves the cut. Behind the add it is refused.
    #[test]
    fn a_live_cut_stays_out_of_the_step() {
        let conn = db();
        let d = deck(&conn, "Cuts");
        let main = main_of(&conn, d);
        add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 1).unwrap();
        let steps_before = steps(&conn, d);
        let cut = DeckOp::Remove {
            card_id: "bolt-m10".into(),
            category_id: main,
            finish: None,
        };
        let outcome = apply(&conn, d, LIVE, std::slice::from_ref(&cut)).unwrap();
        ok(&outcome);
        assert_eq!(steps(&conn, d), steps_before, "a cut files no step");
        assert!(list(&conn, d).is_empty());

        add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 1).unwrap();
        let steps_before = steps(&conn, d);
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[cut.clone(), add_op("serra-lea", Some(main), None, 1)],
        )
        .unwrap();
        ok(&outcome);
        assert_eq!(steps(&conn, d) - steps_before, 1);
        undo(&conn, d);
        assert!(
            list(&conn, d).is_empty(),
            "the add undone, the cut left standing"
        );

        // Behind a write the step records, the cut is refused and the write stands.
        add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 1).unwrap();
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[add_op("serra-lea", Some(main), None, 1), cut],
        )
        .unwrap();
        assert_eq!(outcome.landed, 1);
        assert_eq!(
            outcome.results[1].refusal.as_deref(),
            Some(CUT_AFTER_A_WRITE)
        );
        assert_eq!(list(&conn, d).len(), 2, "both cards still in the deck");
    }

    /// `qty` copies of `card` filed in deck `d`'s collection group — cardboard the deck keeps.
    fn hold(conn: &Connection, d: i64, card: &str, qty: i64) {
        let group: i64 = conn
            .query_row(
                "SELECT id FROM collection_folders WHERE deck_id = ?1",
                params![d],
                |r| r.get(0),
            )
            .unwrap();
        let entry = crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card.into(),
                finish: "nonfoil".into(),
                quantity: qty,
                ..Default::default()
            },
        )
        .unwrap()
        .id;
        crate::collection_folders::refile_entry(conn, entry, Some(group)).unwrap();
    }

    /// Every copy in the collection, by folder kind.
    fn copies(conn: &Connection) -> Vec<(Option<String>, String, i64)> {
        conn.prepare(
            "SELECT f.kind, e.card_id, e.quantity FROM collection_entries e
               LEFT JOIN collection_folders f ON f.id = e.folder_id
              ORDER BY f.kind, e.card_id",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect()
    }

    /// The newest history row of a deck: its `field` (`undo`/`redo` for a reversal) and `delta`.
    fn newest_row(conn: &Connection, deck_id: i64) -> (Option<String>, i64) {
        conn.query_row(
            "SELECT json_extract(payload, '$.field'), delta FROM deck_audit
              WHERE deck_id = ?1 ORDER BY id DESC LIMIT 1",
            params![deck_id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap()
    }

    fn redo(conn: &Connection, deck_id: i64) {
        let id = crate::deck_undo::next_redo(conn, deck_id)
            .unwrap()
            .expect("a step to redo");
        crate::deck_undo::apply_reversal(conn, deck_id, id, false).unwrap();
    }

    /// Finding 1 of the review: the reversal of a batch carries the batch's net `delta`, not its
    /// last row's — so the day header, which sums `delta`, reads `+300 / −300` for 300 adds undone
    /// — the right sign each way through undo, redo and undo again. A single press's step carries
    /// none and its reversal reads its one row, as it always did.
    #[test]
    fn undoing_a_batch_reverses_its_net_delta() {
        let conn = db();
        seed_many(&conn, 300);
        let d = deck(&conn, "Net");
        let main = main_of(&conn, d);
        let ops: Vec<DeckOp> = (0..300)
            .map(|i| add_op(&format!("p{i}"), Some(main), None, 1))
            .collect();
        ok(&apply(&conn, d, LIVE, &ops).unwrap());
        undo(&conn, d);
        assert_eq!(newest_row(&conn, d), (Some("undo".into()), -300));
        redo(&conn, d);
        assert_eq!(newest_row(&conn, d), (Some("redo".into()), 300));
        undo(&conn, d);
        assert_eq!(newest_row(&conn, d), (Some("undo".into()), -300));

        // A batch of moves and an add: the moves are 0 apiece, the add its copies.
        let side = kind_of(&conn, d, "side");
        add_card(&conn, d, "p0", Some(main), None, LIVE, None, 2).unwrap();
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[
                add_op("p1", Some(main), None, 3),
                DeckOp::Move {
                    card_id: "p0".into(),
                    from_category_id: main,
                    to_category_id: Some(side),
                    to_category_name: None,
                    finish: None,
                },
            ],
        )
        .unwrap();
        ok(&outcome);
        undo(&conn, d);
        assert_eq!(
            newest_row(&conn, d),
            (Some("undo".into()), -3),
            "keyed on the move, undone as the press"
        );

        // A single press: no `delta` on its step, and its reversal reads its own row.
        let single = add_card(&conn, d, "p2", Some(main), None, LIVE, None, 2).unwrap();
        assert!(single.id > 0);
        let stored: String = conn
            .query_row(
                "SELECT step FROM deck_undo WHERE deck_id = ?1 ORDER BY audit_id DESC LIMIT 1",
                params![d],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !stored.contains("\"delta\""),
            "a single step's JSON is as it was"
        );
        undo(&conn, d);
        assert_eq!(newest_row(&conn, d), (Some("undo".into()), -2));
        redo(&conn, d);
        assert_eq!(newest_row(&conn, d), (Some("redo".into()), 2));
    }

    /// Finding 2: a database error under an op fails the whole call with nothing written — the
    /// pile a name arm made, the ops before it, `updated_at` — where an ordinary refusal still
    /// lands the rest. The single command answers the same text it always did.
    #[test]
    fn a_database_failure_under_an_op_fails_the_batch_and_writes_nothing() {
        let conn = db();
        let d = deck(&conn, "Failing");
        let main = main_of(&conn, d);
        add_card(&conn, d, "serra-8ed", Some(main), None, LIVE, None, 1).unwrap();
        conn.execute("UPDATE decks SET updated_at = 1 WHERE id = ?1", params![d])
            .unwrap();
        let (before, audits_before, steps_before) =
            (whole(&conn, d), audits(&conn, d), steps(&conn, d));
        // A history insert that fails for one card — a constraint by SQLite's code, as a trigger's
        // RAISE is, and nothing any command answers on purpose.
        conn.execute_batch(
            "CREATE TEMP TRIGGER fail_serra BEFORE INSERT ON main.deck_audit
              WHEN NEW.card_id = 'serra-lea'
             BEGIN SELECT RAISE(ABORT, 'the disk caught fire'); END;",
        )
        .unwrap();
        let ops = [
            add_op("bolt-m10", None, Some("Burn"), 1),
            add_op("serra-lea", Some(main), None, 1),
            add_op("serra-8ed", Some(main), None, 1),
        ];
        let err = apply(&conn, d, LIVE, &ops).unwrap_err();
        assert!(err.contains("the disk caught fire"), "{err}");
        assert_eq!(whole(&conn, d), before, "no card, no pile");
        assert_eq!(audits(&conn, d), audits_before);
        assert_eq!(steps(&conn, d), steps_before);
        let touched: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![d],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touched, 1, "the touch rolled back with the rest");
        // A label write and a move fail the same way.
        let label = crate::deck_meta::create_label(&conn, None, "Hot", "red")
            .unwrap()
            .id;
        conn.execute_batch(
            "CREATE TEMP TRIGGER fail_label BEFORE UPDATE OF label_id ON main.deck_cards
             BEGIN SELECT RAISE(ABORT, 'the label broke'); END;",
        )
        .unwrap();
        let err = apply(
            &conn,
            d,
            LIVE,
            &[
                add_op("bolt-m10", Some(main), None, 1),
                DeckOp::SetLabel {
                    card_id: "serra-8ed".into(),
                    category_id: main,
                    finish: None,
                    label_id: Some(label),
                },
            ],
        )
        .unwrap_err();
        assert!(err.contains("the label broke"), "{err}");
        assert_eq!(whole(&conn, d), before);

        // The single press: the same sentence it answered before the split.
        let single = add_card(&conn, d, "serra-lea", Some(main), None, LIVE, None, 1).unwrap_err();
        assert!(single.contains("the disk caught fire"), "{single}");

        // An ordinary refusal is still one op's.
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[
                add_op("nope", Some(main), None, 1),
                add_op("bolt-m10", Some(main), None, 1),
            ],
        )
        .unwrap();
        assert_eq!(outcome.landed, 1);
        assert!(outcome.results[0].refusal.is_some());
    }

    /// Finding 3, (a): `[move X A→B, cut X from B]` on a live deck that keeps cardboard. The cut
    /// is refused — kept out of a step the move began, it would undo to X back in A with its
    /// copies in `Recently removed` — so the move lands alone, the copies stay with the deck, and
    /// one Ctrl+Z puts the deck back exactly.
    #[test]
    fn a_cut_behind_a_move_of_the_same_card_is_refused() {
        let conn = db();
        let d = deck(&conn, "Move then cut");
        let main = main_of(&conn, d);
        let side = kind_of(&conn, d, "side");
        add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 2).unwrap();
        hold(&conn, d, "bolt-m10", 2);
        let (before, copies_before) = (whole(&conn, d), copies(&conn));
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[
                DeckOp::Move {
                    card_id: "bolt-m10".into(),
                    from_category_id: main,
                    to_category_id: Some(side),
                    to_category_name: None,
                    finish: None,
                },
                DeckOp::Remove {
                    card_id: "bolt-m10".into(),
                    category_id: side,
                    finish: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(outcome.landed, 1);
        assert_eq!(
            outcome.results[1].refusal.as_deref(),
            Some(CUT_AFTER_A_WRITE)
        );
        assert!(!outcome.collection_moved);
        assert_eq!(copies(&conn), copies_before, "no copy left the deck");
        undo(&conn, d);
        assert_eq!(whole(&conn, d), before);
        assert_eq!(copies(&conn), copies_before);
    }

    /// Finding 3, (b): `[add X, cut X]` — the cut is refused, so the step is the add's and Ctrl+Z
    /// takes it back, rather than an empty step whose undo changes nothing.
    #[test]
    fn a_cut_behind_an_add_of_the_same_card_is_refused() {
        let conn = db();
        let d = deck(&conn, "Add then cut");
        let main = main_of(&conn, d);
        let before = whole(&conn, d);
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[
                add_op("bolt-m10", Some(main), None, 1),
                DeckOp::Remove {
                    card_id: "bolt-m10".into(),
                    category_id: main,
                    finish: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            outcome.results[1].refusal.as_deref(),
            Some(CUT_AFTER_A_WRITE)
        );
        assert_eq!(steps(&conn, d), 1);
        assert_eq!(list(&conn, d).len(), 1);
        undo(&conn, d);
        assert_eq!(whole(&conn, d), before);
    }

    /// Finding 3, (c): a cut of a token maker. Behind an add of another card it is refused (its
    /// token reconcile would ride the add's step); ahead of it, it lands, its token entry is
    /// settled before the add is noted, and Ctrl+Z takes the add back without bringing back the
    /// entry of a token nothing makes — what a single cut and a single add leave.
    #[test]
    fn a_token_makers_cut_keeps_its_reconcile_out_of_the_step() {
        let conn = db();
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, type_line, layout, set_code,
                                collector_number, lang, rarity, finishes, prices, raw)
             VALUES ('maker', 'o-maker', 'Treasure Maker', 'Artifact', 'normal', 'tst', '900',
                     'en', 'common', '[\"nonfoil\"]', '{}', ?1)",
            params![crate::card_row::gzip_raw(
                &json!({
                    "id": "maker",
                    "name": "Treasure Maker",
                    "all_parts": [{ "id": TREASURE, "component": "token", "name": "Treasure" }]
                })
                .to_string()
            )],
        )
        .unwrap();
        let d = deck(&conn, "Maker");
        let main = main_of(&conn, d);
        add_card(&conn, d, "maker", Some(main), None, LIVE, None, 1).unwrap();
        // The token's one entry, stepped to zero — what the reconcile deletes once nothing makes it.
        conn.execute(
            "INSERT INTO deck_token_printings
                 (deck_id, variant, oracle_id, card_id, finish, quantity, created_at, updated_at)
             VALUES (?1, 'live', 'o-treasure', ?2, 'nonfoil', 0, 0, 0)",
            params![d, TREASURE],
        )
        .unwrap();
        let cut = DeckOp::Remove {
            card_id: "maker".into(),
            category_id: main,
            finish: None,
        };

        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[add_op("serra-lea", Some(main), None, 1), cut.clone()],
        )
        .unwrap();
        assert_eq!(
            outcome.results[1].refusal.as_deref(),
            Some(CUT_AFTER_A_WRITE)
        );
        assert_eq!(
            tokens(&conn, d).len(),
            1,
            "the maker stands, so does its token"
        );
        undo(&conn, d);

        let steps_before = steps(&conn, d);
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[cut, add_op("serra-lea", Some(main), None, 1)],
        )
        .unwrap();
        ok(&outcome);
        assert!(tokens(&conn, d).is_empty(), "settled after the cut");
        assert_eq!(steps(&conn, d) - steps_before, 1);
        let stored: String = conn
            .query_row(
                "SELECT step FROM deck_undo WHERE deck_id = ?1 ORDER BY audit_id DESC LIMIT 1",
                params![d],
                |r| r.get(0),
            )
            .unwrap();
        assert!(
            !stored.contains("tokens"),
            "no token half on the add's step: {stored}"
        );
        undo(&conn, d);
        assert!(
            list(&conn, d).is_empty(),
            "the add undone, the cut standing"
        );
        assert!(
            tokens(&conn, d).is_empty(),
            "and no entry of a token nothing makes"
        );
    }

    /// A batch whose writes leave every cell as they found it files no step: an add and a
    /// removal of one card on a virtual deck, where the removal is journalled.
    #[test]
    fn a_batch_that_changes_nothing_files_no_step() {
        let conn = db();
        let d = deck(&conn, "Round trip");
        conn.execute(
            "UPDATE decks SET virtual_only = 1 WHERE id = ?1",
            params![d],
        )
        .unwrap();
        let main = main_of(&conn, d);
        let audits_before = audits(&conn, d).len();
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[
                add_op("bolt-m10", Some(main), None, 1),
                DeckOp::Remove {
                    card_id: "bolt-m10".into(),
                    category_id: main,
                    finish: None,
                },
            ],
        )
        .unwrap();
        ok(&outcome);
        assert_eq!(steps(&conn, d), 0);
        assert_eq!(
            audits(&conn, d).len() - audits_before,
            2,
            "the history keeps both rows"
        );
    }

    /// A rolled-back op's cells leave the log, and a later op naming the same cell reads it
    /// afresh — `CellLog::rewind` after a `note`.
    #[test]
    fn a_rewound_note_leaves_the_log_and_is_read_again() {
        let conn = db();
        let d = deck(&conn, "Rewind");
        let main = main_of(&conn, d);
        add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 1).unwrap();
        let cell = |card: &str| crate::deck_undo::Cell::card(LIVE, main, card);
        let mut log = crate::deck_undo::CellLog::default();
        log.note(&conn, d, cell("bolt-m10")).unwrap();
        let mark = log.mark();
        log.note(&conn, d, cell("serra-lea")).unwrap();
        log.rewind(mark);
        add_card(&conn, d, "serra-lea", Some(main), None, LIVE, None, 2).unwrap();
        log.note(&conn, d, cell("serra-lea")).unwrap();
        let (cells, before) = log.into_parts();
        assert_eq!(cells, vec![cell("bolt-m10"), cell("serra-lea")]);
        let quantities: Vec<_> = before
            .iter()
            .map(|r| (r.card_id.as_str(), r.quantity))
            .collect();
        assert_eq!(
            quantities,
            vec![("bolt-m10", 1), ("serra-lea", 2)],
            "read afresh"
        );
    }

    /// Redo of a batch on a live deck that keeps cardboard, with copies held: one Ctrl+Z and one
    /// Ctrl+Y move the list both ways, and the copies stay with the deck throughout.
    #[test]
    fn redoing_a_batch_on_a_deck_with_copies_held_keeps_the_copies() {
        let conn = db();
        let d = deck(&conn, "Held");
        let main = main_of(&conn, d);
        let side = kind_of(&conn, d, "side");
        add_card(&conn, d, "bolt-m10", Some(main), None, LIVE, None, 3).unwrap();
        add_card(&conn, d, "serra-lea", Some(main), None, LIVE, None, 1).unwrap();
        hold(&conn, d, "bolt-m10", 2);
        let label = crate::deck_meta::create_label(&conn, None, "Flex", "amber")
            .unwrap()
            .id;
        let (before, held) = (whole(&conn, d), copies(&conn));
        let outcome = apply(
            &conn,
            d,
            LIVE,
            &[
                DeckOp::Move {
                    card_id: "bolt-m10".into(),
                    from_category_id: main,
                    to_category_id: Some(side),
                    to_category_name: None,
                    finish: None,
                },
                add_op("serra-8ed", Some(main), None, 2),
                add_op("bolt-m10", Some(main), None, 1),
                DeckOp::SetLabel {
                    card_id: "serra-lea".into(),
                    category_id: main,
                    finish: None,
                    label_id: Some(label),
                },
            ],
        )
        .unwrap();
        ok(&outcome);
        let after = whole(&conn, d);
        undo(&conn, d);
        assert_eq!(whole(&conn, d), before);
        assert_eq!(copies(&conn), held);
        redo(&conn, d);
        assert_eq!(whole(&conn, d), after);
        assert_eq!(copies(&conn), held);
        undo(&conn, d);
        assert_eq!(whole(&conn, d), before);
    }

    /// (e) An empty batch answers at once and writes nothing — not even `updated_at`.
    #[test]
    fn an_empty_batch_writes_nothing() {
        let conn = db();
        let d = deck(&conn, "Empty");
        conn.execute("UPDATE decks SET updated_at = 1 WHERE id = ?1", params![d])
            .unwrap();
        let audits_before = audits(&conn, d).len();
        let outcome = apply(&conn, d, LIVE, &[]).unwrap();
        assert!(outcome.results.is_empty());
        assert_eq!(outcome.landed, 0);
        assert!(!outcome.collection_moved);
        let touched: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![d],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touched, 1);
        assert_eq!(steps(&conn, d), 0);
        assert_eq!(audits(&conn, d).len(), audits_before);
        // And a batch of nothing but refusals writes nothing either.
        let refused = apply(&conn, d, LIVE, &[add_op("nope", None, Some("X"), 1)]).unwrap();
        assert_eq!(refused.landed, 0);
        let touched: i64 = conn
            .query_row(
                "SELECT updated_at FROM decks WHERE id = ?1",
                params![d],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(touched, 1);
    }

    /// (f) A thousand adds in one batch: one step, a thousand history rows, and the time it took.
    #[test]
    fn a_thousand_adds_journal_one_step() {
        let conn = db();
        seed_many(&conn, 1000);
        let d = deck(&conn, "Thousand");
        let main = main_of(&conn, d);
        let ops: Vec<DeckOp> = (0..1000)
            .map(|i| add_op(&format!("p{i}"), Some(main), None, 1))
            .collect();
        let audits_before = audits(&conn, d).len();
        let clock = crate::platform::clock::Tick::now();
        let outcome = apply(&conn, d, LIVE, &ops).unwrap();
        eprintln!(
            "deck_apply: 1000 adds in {} ms",
            clock.elapsed().as_millis()
        );
        ok(&outcome);
        assert_eq!(outcome.landed, 1000);
        assert_eq!(steps(&conn, d), 1);
        assert_eq!(list(&conn, d).len(), 1000);
        assert_eq!(audits(&conn, d).len() - audits_before, 1000);
        undo(&conn, d);
        assert!(list(&conn, d).is_empty());
    }
}
