//! The theory list: the deck a user is building toward, and what stands between it and the
//! deck they have.
//!
//! Schema v8 gave `deck_cards` a `variant` — `live` is what is sleeved up, `theory` is the
//! plan — and widened [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) with it, so the two
//! lists are the same table and never the same row. Everything that makes a deck *real* reads
//! `live` and only `live`: the gallery's count, [`crate::collection_alloc`]'s two moves across
//! the deck boundary, [`crate::deck::missing_to_wishlist`]'s shopping list. A plan is not a deck
//! the user has — and since schema v25 the sharpest statement of that is
//! [`crate::collection_alloc::THEORY_HOLDS_NOTHING`], which refuses in words when a theory row
//! is asked to give copies back.
//!
//! This module is the three things that are only true of the *pair*:
//!
//! * **The move.** Switching the theory list on for a deck that has none **moves** the live
//!   list into it, in the same transaction as the flag ([`crate::deck::update_deck`] is the
//!   caller). The deck the reader has built **is the plan**; what is sleeved up is what they
//!   have actually acquired, so the live list starts empty and fills as cards arrive. Copying
//!   instead would claim, on the reader's behalf, that they already own a deck they have only
//!   designed. **The copies themselves do not move**, and that is a real change of answer:
//!   before schema v25 the move had to release what the live list had reserved, and a group is
//!   custody rather than a reservation — the cards stay in the box with the deck's name on it,
//!   because nobody unsleeved anything.
//! * **The difference.** [`theory_diff`] answers what theory holds that live does not — **one
//!   direction only**, because this is a shopping list rather than a reconciliation. What live
//!   has and theory dropped is a cut the user already made; it needs no row. Each row also says
//!   how much of itself the deck is already *playing*, as a different printing or finish of the
//!   same card ([`TheoryDiffRow::held_as_other_printing`]) — a hole for the buyer and not for
//!   the player, and the one question this module answers at the oracle card's grain.
//! * **Buying it.** [`missing_to_wishlist`] turns that difference into wishes — the difference
//!   itself, with nothing netted out of it, pinned to the printings the plan names, and
//!   optionally narrowed to the rows the reader ticked. See that function on why subtracting
//!   [`TheoryDiffRow::owned_spare`] there counts the live list twice.
//!
//! **Switching the theory list off keeps every row.** It hides a switch; it does not delete a
//! list. Nothing in this module or in `deck.rs` deletes a `theory` row except the ordinary card
//! writes the user makes against it.

use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;

/// What is actually sleeved up — `DECK_VARIANTS[0]` by index, [`crate::deck`]'s discipline.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// What the deck is being built toward.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];

/// One card the plan asks for — [`theory_slots`]' row, and the deck editor's theory tick.
///
/// Two fields and no third: this is a mark's whole input, and every column that is *not* here
/// (the name, the set, the price, the pile) is one the tick would have to be told to ignore.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TheorySlot {
    /// [`group_key`]'s own string — `` `{card_id}|{finish}` ``, the regular copy spelling its
    /// half empty. **This module's function rather than a pair the caller reassembles**, which
    /// is what stops the tick and the shopping list drifting apart: "the same planned card" is
    /// one definition, and both surfaces spell it with this code.
    pub key: String,
    /// How many copies the plan asks for, **summed across every active pile it filed them in** —
    /// see [`theory_slots`] on why the fold is here rather than in the caller.
    pub quantity: i64,
}

/// One card the theory list wants more of than the live list has.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TheoryDiffRow {
    /// The printing **the theory row names**, which is the printing the user would be buying.
    /// The same printing filed in two theory categories is one row, named by the category the
    /// editor lists first. **Not unique across the list on its own** — see [`Self::finish`].
    pub card_id: String,
    pub name: String,
    /// The category the theory row is filed under — the pile this card is wanted *for*, which
    /// is what makes a shopping list readable ("2 more Ramp, 1 more Removal").
    pub category_name: String,
    /// How many more copies theory wants than live has. Always positive: a card live has as
    /// many of is not on this list at all, and one it has *more* of is a cut, not a purchase.
    pub quantity: i64,
    /// What one copy costs at the marketplace the read was given —
    /// `DeckCardRow::unit_price`'s rule, [`crate::sorting::deck_card_price_expr`]: the theory
    /// row's own finish where it names one, and the `nonfoil → foil → etched` chain where it
    /// does not, so a foil-only printing is quoted at its foil rate rather than reading as
    /// unpriced. Never `cards.price_usd`, which is that chain precomputed for the search's sort.
    ///
    /// **The finish is part of what is being bought.** A plan that calls for the foil is a
    /// shopping list for the foil, and quoting the plain copy's price against it would understate
    /// the row by whatever the premium is.
    ///
    /// `None` where that marketplace does not price the printing, which is a fact about the
    /// shop rather than a hole: a shopping list quoting a price from somewhere the reader is
    /// not buying is worse than an em dash.
    pub unit_price: Option<f64>,
    pub set_code: String,
    pub collector_number: String,
    /// Which **object** this line is for — `deck_cards.finish`, so `None` is the regular copy
    /// and the other two are `foil` and `etched` ([`crate::schema::FINISHES`] less `nonfoil`,
    /// which [`crate::deck::normalise_finish`] stores as NULL).
    ///
    /// **Part of the identity, with [`Self::card_id`]**: the pair is what makes two deck rows
    /// one line here, and either alone is not unique across the list. A foil Sol Ring and a
    /// regular one are two different pieces of cardboard to go and find, they are two rows in
    /// `deck_cards` on [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN), and they cost
    /// different money — [`Self::unit_price`] is already quoted per finish, so folding them
    /// would have been one line priced at whichever of the two the first theory row happened
    /// to name.
    pub finish: Option<String>,
    /// Copies of **this printing, in this finish**, the collection holds that **no deck's group
    /// holds**.
    ///
    /// The number that turns "I need two more of these" into "and one of them is in the box
    /// already". It answers on exactly [`Grouped`]'s key, and the two cannot disagree: a line
    /// that asks for the foil retro-frame Sol Ring over a spare-count taken across every
    /// printing and finish would be describing a different object, and the figure strip **sums**
    /// `owned_spare` across rows — so any answer wider than the row's own identity counts one
    /// binder copy once per row that could have used it.
    ///
    /// **Where the row sits is the whole of it** (schema v25, replacing "no *built* deck has
    /// claimed"): a deck on a table has its cards, so a copy filed in a deck's group is not one
    /// this plan can count on. Everywhere else is — the root, a folder the reader made, and
    /// `Recently removed`, which exists precisely so a card that left a deck is available again.
    /// [`OWNED_SPARE_SQL`] is the statement and argues the arms.
    ///
    /// **A display field, and never a term in an arithmetic.** It is deliberately *not* netted
    /// out of [`Self::quantity`] anywhere, least of all by [`missing_to_wishlist`]: `quantity`
    /// has already subtracted the live list and this number has not — copies the reader has not
    /// yet sleeved into *this* deck read as spare here, which is right for a person and wrong
    /// for a subtraction. It is for a reader, beside a price.
    pub owned_spare: i64,
    /// How many of this row's [`Self::quantity`] the **live list already plays**, as a different
    /// printing or finish of the same oracle card — the copies that are an upgrade rather than a
    /// hole.
    ///
    /// The comparison above is on the exact card, so a plan naming one Sol Ring against a deck
    /// sleeving another is a full row and reads as a card the reader has not got. **That is
    /// right for buying and wrong for playing** — they would still have to find that printing,
    /// and meanwhile the deck runs — and this field is the difference between the two readings.
    /// It is the one number on this struct asked at the *oracle card's* grain, because "the deck
    /// already plays a different printing of this" is a sentence about the card rather than
    /// about the cardboard.
    ///
    /// **`0 <= held_as_other_printing <= quantity`, and one live copy can excuse at most one
    /// row's copy.** Copies are claimed per oracle card out of a pool sized as *live copies of
    /// that card, less the ones an exact line already matched*, walked in the list's own reading
    /// order — see [`grouped_diff`], which is where both invariants are enforced.
    ///
    /// A row can be **partly both**: theory 2× printing A against live 1× printing B is
    /// `quantity: 2`, `held_as_other_printing: 1` — one copy to go and find, one already on the
    /// table.
    ///
    /// **`0` for an orphan**, whose printing has left `cards`: it names no oracle card, so there
    /// is no card for another printing to be a printing *of*.
    ///
    /// **A display field, and never a term in an arithmetic** — [`Self::owned_spare`]'s rule,
    /// for a sharper reason. [`missing_to_wishlist`] writes [`Self::quantity`] whole, because a
    /// reader who asked for that printing asked for that printing; netting this out would turn
    /// the button into the app deciding the substitution is good enough.
    pub held_as_other_printing: i64,
}

/// A diff row and the oracle id its group was built on.
///
/// **The group is keyed on `(card_id, finish)`** — the exact card, in the exact object the plan
/// calls for. This was the oracle card until 2026-08-20 and is deliberately no longer: the rule
/// is "everything the plan holds that the deck has not got", and a plan that names the foil
/// retro-frame Sol Ring is a plan for *that* piece of cardboard. Answering it with the
/// Commander-precon one, or with the regular copy, is the app deciding a substitution on the
/// reader's behalf — the whole reason a deck keeps two lists is that the reader is tracking
/// which cardboard they actually hold. Oracle grouping also put this command permanently at odds
/// with the editor's own readout, which never grouped that way.
///
/// **It is [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) less `deck_id`, `variant` and
/// `category_id`**, and each of those three is dropped for its own reason: the deck is the
/// question, the variant is the two sides of the subtraction, and the category is *placement*
/// rather than possession. `finish` stays because it is not placement — a foil copy and a
/// regular one are two objects, cost different money ([`TheoryDiffRow::unit_price`] is already
/// quoted per finish), and are two rows in `deck_cards` for exactly that reason.
///
/// [`GROUP_SEPARATOR`] is what keeps the pair a pair. An orphan — a row whose printing has left
/// `cards` — needs no special case, which is the simplification the change bought: its
/// `card_id` is its identity like everything else's, so the prefix that used to keep oracle ids
/// and card ids apart went with the oracle key.
///
/// The oracle id survives on *this* struct because two things need it, and neither draws it.
///
/// **The wish.** [`missing_to_wishlist`] writes through [`crate::wishlist::add_wish`], whose
/// grain is `(oracle_id, card_id, preferred_finish)` — so a wish pinned to this row's exact
/// printing still carries the oracle card that printing is of. That wish stopped being
/// oracle-grained on **2026-08-22**: this paragraph used to end "a wish is oracle-grained ('any
/// printing'), because a shopping list is not a printing preference", and that argument had
/// already lost on 2026-08-20, when the comparison itself became per printing. Two printings of
/// one card are two lines here and now **two** wishes.
///
/// **The substitution count.** [`TheoryDiffRow::held_as_other_printing`] is per oracle card by
/// definition, so the pool it draws from is keyed here and nowhere else.
///
/// It is deliberately **not** on [`TheoryDiffRow`]: the webview draws a printing, a count and
/// two figures, and has no use for a uuid it cannot show.
struct Grouped {
    oracle_id: Option<String>,
    row: TheoryDiffRow,
}

/// What joins a printing id to a finish in [`Grouped`]'s key.
///
/// A `card_id` is a Scryfall UUID and a finish is one of two words, so no value on either side
/// can contain this character and no two different pairs can spell the same key. Written down
/// rather than inlined because a separator that *could* appear in either half is the kind of
/// collision that shows up as one shopping-list line quietly standing for two cards.
const GROUP_SEPARATOR: char = '|';

/// [`Grouped`]'s key for one deck row: the exact card, in the exact object the row plays.
fn group_key(card_id: &str, finish: Option<&str>) -> String {
    format!("{card_id}{GROUP_SEPARATOR}{}", finish.unwrap_or(""))
}

/// Every row of one deck, both variants, in the editor's own order — [`theory_diff`]'s input.
///
/// **Inactive categories are excluded from both sides**, which is the rule stated once in
/// `deck.rs` and read here for both halves of a comparison: an inactive category counts toward
/// nothing, so a card parked in the theory Maybeboard is not something the user has decided to
/// play, and a card parked in the *live* Maybeboard is not something the deck has. Filtering
/// one side and not the other is how a scratchpad would come to fill a shopping list.
///
/// **That switch is the only thing a category decides here.** The join is otherwise for
/// `cat.name`, which captions a row, and for the reading order — the comparison itself never
/// looks at a pile, so re-filing a card in one list and not the other is not a difference.
fn diff_select(marketplace: crate::sorting::Marketplace) -> String {
    format!(
        "SELECT dc.variant, dc.card_id, dc.name, dc.set_code,
            dc.collector_number, dc.quantity, cat.name, c.oracle_id, dc.finish,
            {price}
       FROM deck_cards dc
       JOIN deck_categories cat ON cat.id = dc.category_id
       LEFT JOIN cards c ON c.id = dc.card_id
      WHERE dc.deck_id = ?1 AND cat.is_active = 1
      ORDER BY cat.sort_order, cat.id, dc.name, dc.id",
        price = crate::sorting::deck_card_price_expr(marketplace)
    )
}

/// Copies of one **printing in one finish** the collection holds that **no deck's group holds**.
///
/// **"Spare" is a fact about where a row sits, and schema v25 is what made it one.** This was
/// the binder's copies *less what a built deck had claimed* — a subtraction over
/// `deck_allocations`, clamped per claim because the ledger could out-claim a row the reader had
/// since stepped down. There is no ledger: a deck holds the copies filed in its
/// `collection_folders` row, so the question is one `kind` lookup and there is nothing left for
/// a second moment of the collection to disagree with.
///
/// **The root, a folder the reader made and `Recently removed` are all spare; only a `deck`
/// folder is not.** The `IS NULL` arm comes first because the root is where most copies are and
/// is not a folder to look up — a `<> 'deck'` over a NULL id is NULL, which is not true, so the
/// root would drop out of exactly the list that is mostly root.
/// [`crate::collection::Allocation::Unallocated`] narrows the collection page by this same
/// sentence, and the two are the same rule read from two ends.
///
/// `Recently removed` is on the spare side deliberately: a card that left a deck without leaving
/// the database is back on the reader's desk, and the folder exists so they can put it somewhere
/// else.
///
/// **On exactly [`Grouped`]'s key, because the figure strip sums this field down the list.**
/// It was per oracle card until 2026-08-20 — which stopped being defensible the moment a
/// different printing became a difference — and any answer *wider* than the row's own identity
/// counts one binder copy once per row that could have used it. The two halves of a line may
/// not disagree about what a card is: "buy the foil retro-frame one" over a spare count earned
/// by regular precon copies is a sentence about two different objects.
///
/// **`?2` is `deck_cards.finish`, and the `coalesce` is the translation between two spellings
/// of the regular copy**: `deck_cards.finish` is NULL for it ([`crate::deck::normalise_finish`],
/// so the grain's `coalesce(finish, '')` has one thing to compare) while
/// `collection_entries.finish` is `NOT NULL` and spells it `nonfoil` outright. Binding the
/// deck's NULL straight through would make every regular line read zero spare.
///
/// No `LEFT JOIN cards` and no orphan arm: `collection_entries.card_id` is the printing, so an
/// entry whose card has left the corpus is matched by exactly the same equality as every other.
///
/// **The kind is interpolated from [`crate::schema::COLLECTION_FOLDER_KINDS`]`[1]` rather than
/// typed**, which is why this is a `LazyLock<String>` and not a `const`. It read `'deck'` as a
/// literal, and a literal here is not the migration ladder's kind of literal: a rung is history
/// and must not move when a constant does, while this is a **live read** that has to mean
/// whatever the DDL's `CHECK` means today. The `format!` is spent once per process.
static OWNED_SPARE_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "SELECT coalesce(sum(e.quantity), 0)
       FROM collection_entries e
      WHERE e.card_id = ?1 AND e.finish = coalesce(?2, 'nonfoil')
        AND (e.folder_id IS NULL
             OR (SELECT f.kind FROM collection_folders f
                  WHERE f.id = e.folder_id) <> '{}')",
        crate::schema::COLLECTION_FOLDER_KINDS[1]
    )
});

/// Cards the **theory** list holds that **live** does not.
///
/// One direction only, which is what the spec asks for: this is a shopping list, not a
/// reconciliation. A card live plays and theory dropped is a cut the user already made and
/// needs no line; a card theory wants two more of is one line saying two.
///
/// **Compared on the exact card — printing *and* finish** (changed 2026-08-20, from the oracle
/// card): a plan that names the foil retro-frame Sol Ring is not answered by a different
/// printing of one, nor by the regular copy. The two sides are summed per [`group_key`] and
/// subtracted — see [`Grouped`] for the whole of why.
///
/// **Categories are not compared at all.** The same card filed in two theory categories is
/// **one line**, for the sum, named by the category the editor lists first — so moving a card
/// from Ramp to Removal in the plan and not in the deck is not a difference, because it is not a
/// card the reader has to find. That is the same choice [`crate::deck::missing_to_wishlist`]
/// makes and for the same reason: a reader counting copies of a card counts copies of a card.
/// The one thing a category still decides is whether a row is read at all — see [`diff_select`].
///
/// Ordered by where the representative row falls in the editor's own reading order, so the
/// shopping list runs down the deck the way the deck is drawn.
pub fn theory_diff(
    conn: &Connection,
    deck_id: i64,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<TheoryDiffRow>, String> {
    Ok(grouped_diff(conn, deck_id, marketplace)?
        .into_iter()
        .map(|g| g.row)
        .collect())
}

/// [`theory_diff`]'s working form — see [`Grouped`] for why the oracle id stays.
fn grouped_diff(
    conn: &Connection,
    deck_id: i64,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<Grouped>, String> {
    // Both variants in one read: two reads could not be compared, because a card write between
    // them would put a copy on one side of the subtraction and not the other.
    let sql = diff_select(marketplace);
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
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
                r.get::<_, Option<String>>(8)?, // finish
                r.get::<_, Option<f64>>(9)?,    // unit price
            ))
        })
        .map_err(|e| e.to_string())?;

    // `wanted` and `held` are copies per card; `order` is the theory rows in reading order, and
    // it is what decides both which printing represents a group and where its line lands.
    let mut wanted: HashMap<String, i64> = HashMap::new();
    let mut held: HashMap<String, i64> = HashMap::new();
    // Live copies per **oracle card** — the grain `held_as_other_printing` is asked at, and the
    // only figure in this function that is not about the exact card. Summed in *this* pass and
    // not by a second query over `deck_cards`, for the reason the one statement above already
    // gives: two reads are two moments of the deck, and a card write between them would put a
    // copy on one side of an arithmetic and not the other.
    let mut live_by_oracle: HashMap<String, i64> = HashMap::new();
    let mut order: Vec<(String, Grouped)> = Vec::new();
    for row in rows {
        let (
            variant,
            card_id,
            name,
            set_code,
            collector_number,
            quantity,
            category,
            oracle,
            finish,
            unit_price,
        ) = row.map_err(|e| e.to_string())?;
        // The exact card — printing and finish — see [`Grouped`]. `category` is read for the
        // row's caption and is deliberately *not* in the key: where a card sits is placement,
        // not possession, so a plan that moved a Bolt from Burn to Removal is short of no Bolts.
        let key = group_key(&card_id, finish.as_deref());
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
                            unit_price,
                            set_code,
                            collector_number,
                            finish,
                            owned_spare: 0,
                            held_as_other_printing: 0,
                        },
                    },
                ));
            }
        } else {
            // An orphan contributes nothing to the pool: a row whose printing has left `cards`
            // names no oracle card, so it is not another printing *of* anything. Inactive
            // categories are already off both sides — `diff_select` does that once, for both.
            if let Some(oracle) = &oracle {
                *live_by_oracle.entry(oracle.clone()).or_insert(0) += quantity;
            }
            *held.entry(key).or_insert(0) += quantity;
        }
    }

    let mut spare = conn.prepare(&OWNED_SPARE_SQL).map_err(|e| e.to_string())?;
    let mut diff = Vec::new();
    // What the **exact** lines have already spoken for, per oracle card. Accumulated over every
    // group, including the ones that drop out just below: a plan the deck answers card for card
    // still spends those live copies, and leaving them in the pool would let them excuse a
    // second row as well. Only a group with a theory row can be non-zero — `wanted` is 0 for
    // every other key — and a group with a theory row is a group whose oracle id is known.
    let mut matched_by_oracle: HashMap<String, i64> = HashMap::new();
    for (key, mut grouped) in order {
        let wanted_here = wanted.get(&key).copied().unwrap_or(0);
        let held_here = held.get(&key).copied().unwrap_or(0);
        if let Some(oracle) = &grouped.oracle_id {
            *matched_by_oracle.entry(oracle.clone()).or_insert(0) += wanted_here.min(held_here);
        }
        let short = wanted_here - held_here;
        if short <= 0 {
            continue;
        }
        grouped.row.quantity = short;
        // No floor, and there was one until schema v25: the old statement *subtracted* a built
        // deck's stored claims and a collection stepped down under one went negative. This one
        // sums quantities off a column with `CHECK (quantity >= 0)`, so there is no arithmetic
        // left that can produce a number with no reading.
        grouped.row.owned_spare = spare
            .query_row(params![grouped.row.card_id, grouped.row.finish], |r| {
                r.get::<_, i64>(0)
            })
            .map_err(|e| e.to_string())?;
        diff.push(grouped);
    }

    // Live copies of each oracle card that no exact line already claimed — the pool a surviving
    // row draws [`TheoryDiffRow::held_as_other_printing`] out of. Floored at zero for
    // `owned_spare`'s reason: a negative here would be a number with no reading.
    let mut pool = live_by_oracle;
    for (oracle, matched) in matched_by_oracle {
        let left = pool.entry(oracle).or_insert(0);
        *left = (*left - matched).max(0);
    }
    // **Walked in the surviving rows' own reading order, and that is what makes the answer
    // deterministic.** The pool belongs to the oracle card, so when two lines of one card both
    // qualify for it the first one down the page takes it and the second reads what is left —
    // which is how one live copy comes to excuse one row's copy and never two. Spreading it
    // instead would tell the reader that two rows are half-covered when one is covered and the
    // other is not.
    for grouped in &mut diff {
        // An orphan is never a substitution: it names no oracle card to be another printing of.
        let Some(oracle) = grouped.oracle_id.as_deref() else {
            continue;
        };
        let Some(left) = pool.get_mut(oracle) else {
            continue;
        };
        // The `min` is the whole of `0 <= held_as_other_printing <= quantity`.
        let take = grouped.row.quantity.min(*left);
        grouped.row.held_as_other_printing = take;
        *left -= take;
    }
    Ok(diff)
}

/// Copy the live list into the theory one, leaving whatever theory already holds alone.
///
/// **Takes the caller's connection and opens no transaction**, exactly as
/// [`crate::deck_audit::record`] does, because its caller [`copy_from_live`] pairs it with a
/// `touch_deck` and a history row and the three are one fact: a copy that committed while the
/// history rolled back is a change with no line against it.
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
/// **Moves no cardboard**, and must not: it writes `deck_cards` rows and nothing else. Copies
/// cross the deck boundary only through [`crate::collection_alloc`]'s two writes, which a plan
/// cannot reach — so a seed that touched the collection would file a second set of copies the
/// reader does not own into a group that already holds theirs.
///
/// Answers the number of **rows** written, which is what `execute` counts. [`copy_from_live`]
/// wants **copies** for its history and measures them itself with [`theory_copies`] — a row is
/// a line and a copy is a card, and this app counts decks in cards everywhere else.
pub(crate) fn seed_from_live(tx: &Connection, deck_id: i64) -> Result<usize, String> {
    let sql = format!(
        // `finish` comes across with the row: the plan is what is sleeved up, and a plan that
        // quietly turned every foil into a regular copy would price differently from the deck
        // it was copied from.
        "INSERT INTO deck_cards
            (deck_id, category_id, variant, card_id, set_code, collector_number, lang, name,
             tag_id, quantity, needs_review, finish, created_at, updated_at)
         SELECT deck_id, category_id, ?2, card_id, set_code, collector_number, lang, name,
                tag_id, quantity, needs_review, finish, unixepoch(), unixepoch()
           FROM deck_cards
          WHERE deck_id = ?1 AND variant = ?3
         ON CONFLICT({grain}) DO NOTHING",
        grain = crate::schema::DECK_CARD_GRAIN
    );
    tx.execute(&sql, params![deck_id, THEORY, LIVE])
        .map_err(|e| e.to_string())
}

/// **Move** the live list into the theory one: the same rows, re-labelled, leaving `live`
/// empty.
///
/// What switching the theory list on actually does. The deck the reader has spent their evening
/// building **is the plan** — they typed it out of a list, not out of a box — and the live list
/// is what they have since sleeved up, which on the day the switch is pressed is nothing.
/// Copying would leave the app asserting the reader owns a second copy of every card in it.
///
/// **Safe against the [`DECK_CARD_GRAIN`](crate::schema::DECK_CARD_GRAIN) unique index only
/// because the caller has already checked the theory list is empty**, and that is the whole
/// reason [`crate::deck::update_deck`]'s guard cannot be dropped. `variant` is *in* that grain,
/// so re-labelling a live row `theory` collides with a theory row of the same deck, category
/// and printing — and this is a bare `UPDATE` with no `ON CONFLICT` clause, so a collision is a
/// `UNIQUE constraint failed` that fails the caller's whole write. Adding one here would be the
/// wrong repair twice over: it would hide the guard's removal, and either arm of it (skip, or
/// fold) silently rewrites a plan the reader started.
///
/// **It also sets the deck's `last_variant`**, because after the move the live tab is empty and
/// everything the reader recognises is in the other one. Landing them on a blank page they did
/// not empty is the failure this line prevents — the columns are all still there, one tab
/// across, and nothing on screen would say so.
///
/// **It moves no collection row, and its caller owes none either** — reversed at schema v25,
/// and worth stating rather than deleting because the old rule is the intuitive one. Claims were
/// held for `live` only, so emptying the live list stranded every claim the deck held and
/// [`crate::deck::update_deck`] had to reallocate in the same transaction. A group is custody:
/// the copies are physically in the box with the deck's name on it, the plan moving does not
/// unsleeve them, and `enabling_theory_leaves_the_copies_in_the_decks_group` pins it.
///
/// Answers the number of **rows** moved, which is what `execute` counts — [`seed_from_live`]'s
/// unit, and for its reason.
pub(crate) fn move_live_into_theory(tx: &Connection, deck_id: i64) -> Result<usize, String> {
    let moved = tx
        .execute(
            "UPDATE deck_cards SET variant = ?2, updated_at = unixepoch()
              WHERE deck_id = ?1 AND variant = ?3",
            params![deck_id, THEORY, LIVE],
        )
        .map_err(|e| e.to_string())?;
    tx.execute(
        "UPDATE decks SET last_variant = ?2 WHERE id = ?1",
        params![deck_id, THEORY],
    )
    .map_err(|e| e.to_string())?;
    Ok(moved)
}

/// Does this deck's theory list hold anything at all? The condition on the move: a theory list
/// with rows in it is a plan the user has started, and switching the flag back on must neither
/// pour the live deck over it nor — see [`move_live_into_theory`] — collide with it.
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

/// [`seed_from_live`] as a command of its own — "copy what I have sleeved up into the plan",
/// pressed.
///
/// **This is the copy, and it stays a copy**, which is what tells it apart from
/// [`move_live_into_theory`] now that switching the list on is a move. That one runs once, on a
/// deck whose live list *is* the plan the reader typed out; this one is pressed later, on a deck
/// that has both lists, and it means "the cards I actually own should be in the plan too". Live
/// keeps every row, exactly as the button says.
///
/// Opens the transaction its callee will not, and moves `updated_at` through
/// [`crate::deck::touch_deck`] so the gallery surfaces the edit and a stale deck id is answered
/// with [`crate::deck::GONE`] rather than with a silent no-op.
///
/// **Records exactly one history row**, kind `deck`, field `theory`, carrying the copies it
/// added — and it has to, for a reason worth stating because the opposite was tried first. The
/// toggle's own row is a fact about a *switch*, written once per deck whether the deck holds
/// forty cards or none; on a list that already exists, which is the only state where this button
/// is meaningfully pressed, the toggle's row was written long ago and nothing else would be.
/// "Log ALL changes" is the whole point of the table, and a press that copies forty cards into a
/// list is a change.
///
/// One row and not one per card: N `add` rows would read as a deck somebody typed out, and the
/// toggle path — where the move rides along inside `update_deck` — records one row for the
/// same reason. `copied` is in the payload **and** in `delta`, which is [`crate::deck_audit`]'s
/// established shape (an `add` carries its quantity in both): `delta` is the day header's
/// arithmetic, the payload is the sentence's facts.
pub fn copy_from_live(conn: &Connection, deck_id: i64) -> Result<usize, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    crate::deck::touch_deck(&tx, deck_id)?;
    // Measured either side of the insert rather than derived from its row count: `execute`
    // counts rows and a row is a line, while what a reader (and `delta`) wants is cards.
    let before = theory_copies(&tx, deck_id)?;
    // The plan as it stood. `copied` is a count and cannot rebuild a list — and this command's
    // whole job is to pour one list into another, so what an undo has to put back is the
    // *other* list's rows rather than a number of them.
    let cards_before = crate::deck_undo::read_variant(&tx, deck_id, THEORY)?;
    let rows = seed_from_live(&tx, deck_id)?;
    let copied = theory_copies(&tx, deck_id)? - before;
    let audit_id = crate::deck_audit::record(
        &tx,
        deck_id,
        THEORY,
        crate::deck_audit::DECK,
        None,
        &serde_json::json!({ "field": "theory", "copied": copied }),
        copied,
    )?;
    // `None` for the pile diff: `seed_from_live` re-labels rows into categories the deck
    // already has, so this command cannot invent one.
    crate::deck_undo::record_variant(&tx, audit_id, deck_id, THEORY, cards_before, None, None)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(rows)
}

/// Everything the plan is short of, onto the wishlist. Returns how many wishes were touched.
///
/// [`crate::deck::missing_to_wishlist`]'s twin, and the difference is what a plan is: what it
/// wants is measured against the **live list** rather than against the copies the deck's group
/// holds, a plan holding no cardboard at all
/// ([`crate::collection_alloc::THEORY_HOLDS_NOTHING`] is that refusal in words).
///
/// **The wish is [`TheoryDiffRow::quantity`] and nothing is subtracted from it.** That is not an
/// oversight and it was wrong once: subtracting [`TheoryDiffRow::owned_spare`] here counts the
/// live list's copies **twice**, because `quantity` is already *wanted minus held* and
/// `owned_spare` nets out only what a deck's **group** holds. Copies the reader owns and has not
/// filed into this deck are therefore spare by that definition, so live 2 / owned 2 / theory 3
/// asked for nothing while the user needed one —
/// `missing_to_wishlist_does_not_count_the_live_list_twice`
/// is that arithmetic pinned. `owned_spare` is a **display** field: the diff row's way of saying
/// "one of these is in the box already", for a person to read beside a price. It is not a term
/// in this sum.
///
/// **`only` narrows the press to the rows the reader ticked** — [`group_key`] strings, which is
/// the spelling [`theory_slots`] already answers in, so the dialog and this command name a
/// planned card with the same code and nothing new crosses the IPC boundary. `None` is the whole
/// difference, which is what every caller written before the dialog meant and still means.
///
/// **A key naming no row of the *current* difference writes nothing rather than refusing.** The
/// diff is re-read inside this transaction, so a row the reader ticked and then acquired in
/// another window is simply not short any more — that is the button working, not a stale request
/// to reject.
///
/// **It is an include list, even though the gesture it serves is exclusion** ("let me drop three
/// of these and send the rest"). The two spellings differ only for rows that appeared between
/// the read and the press, and those are rows the reader never saw: an exclude list would have
/// the dialog sending cards on its own initiative.
///
/// **The wish is pinned to the printing the plan names** (2026-08-22), and to its finish. This
/// wrote an any-printing wish until then, on the argument that a shopping list is not a printing
/// preference — an argument that had already lost on **2026-08-20**, when the comparison itself
/// became per printing and per finish. A plan naming a printing is a plan for *that* cardboard,
/// and answering it with a wish for any printing hands the reader back the very substitution the
/// two lists exist to track. Still written through [`crate::wishlist::add_wish`], so the grain,
/// the canonicalisation and the fold all stay in the one module that owns them, and pressing
/// twice raises one line rather than making two.
///
/// **The regular copy pins no finish.** `deck_cards.finish` is NULL for it
/// ([`crate::deck::normalise_finish`]) and writing `nonfoil` here would put this wish on a
/// different row of [`WISHLIST_GRAIN`](crate::schema::WISHLIST_GRAIN) from every other wish the
/// app makes for that card. `foil` and `etched` pass straight through, because those *are* what
/// the reader is going out to find.
///
/// A pinned wish and an any-printing one are **different rows** on that grain, so a reader who
/// pressed this before the change keeps their old any-printing line and gains a pinned one.
/// Nothing is lost and nothing is double-counted: each folds into its own row on the upsert.
///
/// An orphaned row is skipped, [`crate::deck::missing_to_wishlist`]'s rule — and that guard is
/// now doing double duty, which is the non-obvious part. A wish needs an oracle card and an
/// orphan has none; *and* an orphan is exactly a row whose printing has left `cards`, while
/// [`crate::wishlist::add_wish`] **refuses** a `card_id` it cannot find there ("no card with that
/// id is in the card database"). From inside this transaction that refusal would abort the whole
/// press rather than skip one line. It is already carrying a `needs_review` sentence.
pub fn missing_to_wishlist(
    conn: &Connection,
    deck_id: i64,
    only: Option<&[String]>,
) -> Result<usize, String> {
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
    // The default marketplace, for [`crate::deck::missing_to_wishlist`]'s reason: this reads
    // names and counts, never a price, and a shopping list must not depend on where the reader
    // shops.
    for grouped in grouped_diff(&tx, deck_id, crate::sorting::Marketplace::default())? {
        // Recomputed rather than carried out of `grouped_diff`, which answers rows and not keys:
        // `group_key` is the one place "the same planned card" is spelled, and spelling it twice
        // here is how the tick, the dialog and this write stay one convention.
        if let Some(only) = only {
            let key = group_key(&grouped.row.card_id, grouped.row.finish.as_deref());
            if !only.contains(&key) {
                continue;
            }
        }
        let Some(oracle_id) = grouped.oracle_id else {
            continue;
        };
        crate::wishlist::add_wish(
            &tx,
            &crate::wishlist::WishInput {
                oracle_id: Some(oracle_id),
                // The printing the plan named, and the object it named — the whole of the
                // 2026-08-22 change, argued above.
                card_id: Some(grouped.row.card_id.clone()),
                // The deck row's own name, which is the one name an orphan-safe row always has
                // and the same name the list would show for it.
                name: Some(grouped.row.name),
                quantity: grouped.row.quantity,
                preferred_finish: grouped.row.finish.clone(),
                ..Default::default()
            },
        )?;
        touched += 1;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(touched)
}

/// What a write here says when its worker thread died under it.
fn unfinished(e: tauri::Error) -> String {
    format!("the deck could not be written: {e}")
}

/// Every card the plan asks for, as a [`group_key`] and the number of copies it wants.
///
/// The deck editor's theory tick: a reader on the **Live** list wants to know which of the cards
/// in front of them are the deck they designed and which are the proxies standing in until the
/// real one arrives. That is a question about *rows*, and it is the one question about the pair
/// that [`theory_diff`] cannot answer — in either direction. A card the reader has fully acquired
/// is **absent** from the diff and is still in the plan; a card half-acquired is on the diff and
/// also in the plan. "On the shopping list" and "in the plan" are independent facts.
///
/// ## Why this exists rather than a second `deck_get`
///
/// The editor read the other variant's whole deck for a while and that was removed on 2026-08-20,
/// for two reasons worth keeping apart. One was a **duplicate rule** — it re-implemented the
/// comparison this module owns, and disagreed with it. The other was **cost**: `deck_get` prices
/// every row, joins categories and rolls up what the deck's group holds, which is a great deal
/// of work for a mark.
/// This command answers neither a comparison nor a priced row: one indexed scan of `deck_cards`,
/// three columns, no join to `cards` and no marketplace. `DeckEditor.test.tsx` pins the first
/// reason from the frontend side — nothing may call `deck_get` for the list the reader is not on.
///
/// **It answers [`group_key`] itself rather than a pair**, which is the whole reason the tick and
/// the shopping list cannot drift: "the same planned card" is one function in this file, and both
/// surfaces are spelling it with the same code rather than with two agreeing conventions. The
/// frontend's `theoryMatch.ts` builds the same string for a live row and looks it up.
///
/// **Inactive categories are excluded, exactly as [`diff_select`] excludes them**, and for that
/// function's stated reason: a card parked in the theory Maybeboard is not something the user has
/// decided to play, so the plan is not asking for it. A pile is otherwise invisible here — the
/// same card filed as Ramp in the plan and Main deck in the deck is one planned card, which is
/// what makes the mark survive a re-filing.
///
/// ## The quantity joined the key on 2026-08-26, and the folding moved here with it
///
/// [Issue #212](https://github.com/Msgaihede/mtg-grimoire/issues/212) asked the tick to say *how
/// far off* the live count is wherever the two lists disagree about a card they both hold — which
/// is a question no list of keys can answer. So a slot carries what the plan asks for.
///
/// **The rows therefore fold here rather than in the caller**, which is the one thing that had to
/// change with it: two `Vec` entries spelling one key were harmless while a set was being built
/// out of them, and would be a silently halved quantity now. `GROUP BY dc.card_id, dc.finish` is
/// exactly [`group_key`]'s own grain — SQLite groups two NULL finishes together, which is the
/// regular copy — so the same card filed as Ramp and as Main deck is still **one** planned card,
/// now with both piles counted rather than one key printed twice.
///
/// Still a `Vec` rather than a map: a JSON array is what crosses the IPC boundary anyway, and the
/// caller builds the lookup it wants.
pub fn theory_slots(conn: &Connection, deck_id: i64) -> Result<Vec<TheorySlot>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT dc.card_id, dc.finish, SUM(dc.quantity)
               FROM deck_cards dc
               JOIN deck_categories cat ON cat.id = dc.category_id
              WHERE dc.deck_id = ?1 AND dc.variant = ?2 AND cat.is_active = 1
              GROUP BY dc.card_id, dc.finish",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, THEORY], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut slots = Vec::new();
    for row in rows {
        let (card_id, finish, quantity) = row.map_err(|e| e.to_string())?;
        slots.push(TheorySlot {
            key: group_key(&card_id, finish.as_deref()),
            quantity,
        });
    }
    Ok(slots)
}

/// [`theory_slots`]'s command. **Read-only** connection, and no marketplace: nothing here is
/// priced.
#[tauri::command]
pub async fn deck_theory_slots(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
) -> Result<Vec<TheorySlot>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        theory_slots(&crate::sync::lock_db_read(&state), deck_id)
    })
    .await
    .map_err(|e| format!("the theory list could not be read: {e}"))?
}

/// What the plan wants and the deck does not have. **Read-only** connection.
#[tauri::command]
pub async fn deck_theory_diff(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    marketplace: Option<String>,
) -> Result<Vec<TheoryDiffRow>, String> {
    let state = state.inner().clone();
    let marketplace = crate::sorting::Marketplace::from_opt(marketplace.as_deref());
    tauri::async_runtime::spawn_blocking(move || {
        theory_diff(&crate::sync::lock_db_read(&state), deck_id, marketplace)
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

/// The one click: everything the plan is short of, onto the wishlist — or, with `only`, the
/// rows the reader left ticked, as [`group_key`] strings. Absent means the whole difference.
#[tauri::command]
pub async fn deck_theory_missing_to_wishlist(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    only: Option<Vec<String>>,
) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| missing_to_wishlist(c, deck_id, only.as_deref()))
    })
    .await
    .map_err(unfinished)?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::deck::{DeckInput, DeckPatch};

    /// The marketplace a test that is **not about prices** reads through —
    /// [`crate::deck`]'s constant, kept per module.
    const ANY_MARKET: crate::sorting::Marketplace = crate::sorting::Marketplace::Tcgplayer;

    /// Two printings of one oracle card, plus a second card — the second printing is what
    /// `the_diff_compares_printings_not_oracle_cards` turns on.
    fn seeded() -> Connection {
        let conn = crate::schema::memory_pair();
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
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    fn category(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, name).unwrap()
    }

    fn add(conn: &Connection, deck_id: i64, card: &str, cat: i64, variant: &str, quantity: i64) {
        add_finish(conn, deck_id, card, cat, variant, None, quantity);
    }

    /// The same add, naming the object played — `None` is the regular copy, which
    /// `deck::normalise_finish` stores as NULL.
    fn add_finish(
        conn: &Connection,
        deck_id: i64,
        card: &str,
        cat: i64,
        variant: &str,
        finish: Option<&str>,
        quantity: i64,
    ) {
        crate::deck::add_card(
            conn,
            deck_id,
            card,
            Some(cat),
            None,
            variant,
            finish,
            quantity,
        )
        .unwrap();
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

    /// Which list this deck would open on — `decks.last_variant`, schema v12.
    fn last_variant(conn: &Connection, deck_id: i64) -> String {
        conn.query_row(
            "SELECT last_variant FROM decks WHERE id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One collection row of one printing, in the regular finish.
    fn own(conn: &Connection, card_id: &str, quantity: i64) -> i64 {
        own_finish(conn, card_id, "nonfoil", quantity)
    }

    /// The same, in a named finish — `collection_entries.finish` is NOT NULL and spells the
    /// regular copy `nonfoil`, where `deck_cards` spells it NULL.
    fn own_finish(conn: &Connection, card_id: &str, finish: &str, quantity: i64) -> i64 {
        crate::collection::add_entry(
            conn,
            &crate::collection::EntryInput {
                card_id: card_id.to_owned(),
                finish: finish.to_owned(),
                quantity,
                ..Default::default()
            },
        )
        .unwrap()
        .id
    }

    /// The whole of rule 1: switching the theory list on **moves** the live deck into it. What
    /// the reader has built is the plan — they typed it out of a list, not out of a box — and
    /// what is sleeved up starts empty and fills as they acquire cards.
    ///
    /// **The second assertion is the test.** A copy passes the first one just as well, and a
    /// copy is what this used to do: it left the app claiming the reader owned a second Bolt for
    /// every Bolt in the plan.
    #[test]
    fn enabling_theory_moves_the_live_deck_into_it() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        add(&conn, id, "serra-lea", main, LIVE, 1);

        set_theory(&conn, id, true);

        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 4), ("serra-lea".to_owned(), 1)],
            "the plan is the deck that was there"
        );
        assert!(
            cards_in(&conn, id, LIVE).is_empty(),
            "and the live list is what has actually been sleeved up: nothing, yet"
        );
    }

    /// After the move the live tab is empty and everything the reader recognises is one tab
    /// across, so the deck has to open there. Landing them on a blank page they did not empty is
    /// the failure this pins — the columns are all still there and nothing on screen says so.
    #[test]
    fn enabling_theory_leaves_the_deck_opening_on_the_theory_tab() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        assert_eq!(
            last_variant(&conn, id),
            LIVE,
            "a deck opens on the deck the reader has, until there is a reason not to"
        );

        set_theory(&conn, id, true);

        assert_eq!(last_variant(&conn, id), THEORY);
    }

    /// **The move leaves the copies exactly where they physically are, and that reverses what
    /// this test asserted until schema v25.** The old rule was a claim ledger held for `live`
    /// only, so emptying the live list stranded every claim the deck held and the move had to
    /// release them in the same transaction. A group is *custody*: the cards are in the box with
    /// the deck's name on it, and re-planning a deck does not put them back in the binder,
    /// because nobody unsleeved anything.
    ///
    /// **The copies are asserted before the switch as well as after**, so the test can tell
    /// "left alone" from "never there" — an implementation that filed nothing anywhere would
    /// pass a one-sided assertion just as well.
    #[test]
    fn enabling_theory_leaves_the_copies_in_the_decks_group() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let entry = own(&conn, "bolt-lea", 4);
        add(&conn, id, "bolt-lea", main, LIVE, 4);
        file_into(&conn, entry, Some(group_of(&conn, id)));
        assert_eq!(
            copies_in(&conn, Some(group_of(&conn, id))),
            vec![("bolt-lea".to_owned(), 4)],
            "the deck must really hold the copies for the switch to have anything to lose"
        );

        set_theory(&conn, id, true);

        assert!(
            cards_in(&conn, id, LIVE).is_empty(),
            "the list really did move, so the switch did the thing this test is about"
        );
        assert_eq!(
            copies_in(&conn, Some(group_of(&conn, id))),
            vec![("bolt-lea".to_owned(), 4)],
            "and the cardboard is still in the deck's box"
        );
    }

    /// The other half of the rule, and the one a naive implementation gets wrong: a theory
    /// list that already holds something is a plan the user started, and switching the flag
    /// back on must neither pour the live deck over it nor collide with it.
    ///
    /// **Live keeps its rows here**, and that is the same guard read from the other side: no
    /// move happened, so nothing left the deck the user has.
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
        assert_eq!(
            cards_in(&conn, id, LIVE),
            vec![("bolt-lea".to_owned(), 4)],
            "and the deck they have, untouched with it"
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
        // The Bolt arrives in the plan by the move, not by a copy — so live is empty from here
        // on, and the Angel is an edit the reader makes to the plan afterwards.
        set_theory(&conn, id, true);
        add(&conn, id, "serra-lea", main, THEORY, 2);

        set_theory(&conn, id, false);

        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 4), ("serra-lea".to_owned(), 2)]
        );
        // And switching it back on finds the plan still there rather than moving over it.
        set_theory(&conn, id, true);
        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 4), ("serra-lea".to_owned(), 2)]
        );
        assert!(
            cards_in(&conn, id, LIVE).is_empty(),
            "and nothing re-appears in the live list either way"
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

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();

        // Two lines, because `bolt-m10` is a different printing and so a different thing to go
        // and find: `bolt-lea` is 5 wanted against 4 held, `bolt-m10` is 3 wanted against none.
        // The Angel is a cut and is not here at all.
        assert_eq!(
            diff.iter()
                .map(|r| (r.card_id.as_str(), r.quantity))
                .collect::<Vec<_>>(),
            vec![("bolt-lea", 1), ("bolt-m10", 3)],
            "{diff:?}"
        );
        assert_eq!(diff[0].name, "Lightning Bolt");
        assert_eq!(diff[0].category_name, "Main deck");
    }

    /// **A card the two lists file in different piles is not a difference.** Placement is not
    /// possession: the reader is being told what to go and buy, and a Bolt that moved from Burn
    /// to Removal in the plan is a Bolt they already have. This is the half the editor's own
    /// readout used to get wrong — it keyed rows on `(category, printing)` and counted both
    /// directions, so one re-filed card scored two and a hundred-card deck read as a hundred
    /// and fifty differences.
    #[test]
    fn the_diff_ignores_which_pile_a_card_is_in() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let burn = category(&conn, id, "Burn");
        let removal = category(&conn, id, "Removal");
        add(&conn, id, "bolt-lea", burn, LIVE, 4);
        add(&conn, id, "bolt-lea", removal, THEORY, 4);

        assert!(
            theory_diff(&conn, id, ANY_MARKET).unwrap().is_empty(),
            "the same four cards, in a different column"
        );

        // And each side is summed across its piles rather than compared pile by pile: two here
        // and two there is four wanted, which is what the deck has.
        crate::deck::set_card_quantity(&conn, id, "bolt-lea", removal, THEORY, None, 2).unwrap();
        add(&conn, id, "bolt-lea", burn, THEORY, 2);
        assert!(theory_diff(&conn, id, ANY_MARKET).unwrap().is_empty());
    }

    /// Rule 2, **reversed on 2026-08-20**: the comparison is by printing. A plan that names
    /// the Alpha Bolt is a plan for that piece of cardboard, and the M10 one in the live list
    /// does not answer it. Live holds `bolt-lea`; theory asks for both printings, and only the
    /// one the deck has not got is a line.
    #[test]
    fn the_diff_compares_printings_not_oracle_cards() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 1);
        add(&conn, id, "bolt-lea", main, THEORY, 1);
        add(&conn, id, "bolt-m10", main, THEORY, 1);

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();

        assert_eq!(diff.len(), 1, "the Alpha one is held: {diff:?}");
        assert_eq!(diff[0].card_id, "bolt-m10", "and the M10 one is not");
        assert_eq!(diff[0].quantity, 1);

        // The same comparison from the other side, and the whole of what changed: swapping the
        // live printing for the other one moves the difference onto the printing the deck
        // stopped holding, where an oracle-grained answer saw nothing happen at all.
        crate::deck::swap_printing(&conn, id, "bolt-lea", "bolt-m10", main, LIVE, None).unwrap();
        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(
            (diff[0].card_id.as_str(), diff[0].quantity),
            ("bolt-lea", 1)
        );
    }

    /// **The finish is part of the identity too**, which is the other half of "the exact card".
    /// A plan calling for the foil is a plan for the foil: the regular copy in the live list
    /// does not answer it, the two are separate lines, and they are priced apart — `unit_price`
    /// has always been quoted per finish, so folding them would have charged one of them at the
    /// other's rate.
    #[test]
    fn the_diff_tells_a_foil_from_the_regular_copy() {
        let conn = seeded();
        conn.execute(
            "UPDATE cards SET prices = '{\"usd\":\"400.00\",\"usd_foil\":\"900.00\"}'
              WHERE id = 'bolt-lea'",
            [],
        )
        .unwrap();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add_finish(&conn, id, "bolt-lea", main, LIVE, None, 2);
        add_finish(&conn, id, "bolt-lea", main, THEORY, None, 2);
        add_finish(&conn, id, "bolt-lea", main, THEORY, Some("foil"), 1);

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();

        assert_eq!(diff.len(), 1, "the regular copies are held: {diff:?}");
        assert_eq!(diff[0].card_id, "bolt-lea");
        assert_eq!(diff[0].finish.as_deref(), Some("foil"), "the foil is not");
        assert_eq!(diff[0].quantity, 1);
        assert_eq!(
            diff[0].unit_price,
            Some(900.0),
            "and it is quoted at the foil rate, not the plain one"
        );

        // Both objects wanted and neither held: two lines for one printing, told apart by the
        // finish and by nothing else. The regular copy's `finish` is `None`, not `\"nonfoil\"`.
        crate::deck::set_card_quantity(&conn, id, "bolt-lea", main, LIVE, None, 0).unwrap();
        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!(
            diff.iter()
                .map(|r| (r.finish.as_deref(), r.quantity, r.unit_price))
                .collect::<Vec<_>>(),
            vec![(None, 2, Some(400.0)), (Some("foil"), 1, Some(900.0))],
            "{diff:?}"
        );
    }

    /// `owned_spare` answers on the whole of the row's identity, finish included — the strip
    /// sums it, so anything wider counts one binder copy once per row that could have used it.
    ///
    /// **The `coalesce(?2, 'nonfoil')` in [`OWNED_SPARE_SQL`] is what the first assertion pins**:
    /// `deck_cards.finish` is NULL for the regular copy and `collection_entries.finish` spells
    /// it `nonfoil`, so binding the deck's NULL straight through reads every regular line as
    /// zero spare.
    #[test]
    fn owned_spare_answers_for_the_finish_the_line_is_for() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        own_finish(&conn, "bolt-lea", "nonfoil", 3);
        own_finish(&conn, "bolt-lea", "foil", 1);
        add_finish(&conn, id, "bolt-lea", main, THEORY, None, 4);
        add_finish(&conn, id, "bolt-lea", main, THEORY, Some("foil"), 4);

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();

        assert_eq!(
            diff.iter()
                .map(|r| (r.finish.as_deref(), r.owned_spare))
                .collect::<Vec<_>>(),
            vec![(None, 3), (Some("foil"), 1)],
            "each line answers for its own object, so the strip's sum is 4 and not 8"
        );
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
            theory_diff(&conn, id, ANY_MARKET).unwrap().is_empty(),
            "a scratchpad is not a shopping list"
        );

        // Live's copy parked in the Maybeboard is not a copy the deck has, either.
        add(&conn, id, "bolt-lea", maybe, LIVE, 3);
        add(&conn, id, "bolt-lea", main, THEORY, 2);
        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!(diff.len(), 1);
        assert_eq!(
            diff[0].quantity, 1,
            "2 wanted against the 1 live really has"
        );
    }

    /// The `collection_folders` row that stands for a deck. Every deck has one — schema v25
    /// gave one to every deck that existed and `deck::create_deck` gives one to every deck made
    /// since — and it is where "this deck holds these copies" is now recorded.
    fn group_of(conn: &Connection, deck_id: i64) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE deck_id = ?1",
            params![deck_id],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// The one holding area — `kind = 'removed'`, inserted by schema v25 into every database.
    fn removed_folder(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT id FROM collection_folders WHERE kind = 'removed'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// One folder the reader made, at the root.
    fn binder(conn: &Connection, name: &str) -> i64 {
        crate::collection_folders::create_folder(conn, None, name)
            .unwrap()
            .id
    }

    /// File an owned row somewhere — the app's own write, so the merge rule is the app's.
    fn file_into(conn: &Connection, entry: i64, folder: Option<i64>) {
        crate::collection_folders::refile_entry(conn, entry, folder).unwrap();
    }

    /// The **cardboard** one folder holds, as `(printing, copies)` sorted by id — `None` is the
    /// root. [`cards_in`]'s twin one table over: that one reads a deck's *list*, this reads the
    /// copies that physically sit in a place, and since schema v25 the difference between the
    /// two is the whole subject.
    fn copies_in(conn: &Connection, folder: Option<i64>) -> Vec<(String, i64)> {
        conn.prepare(
            "SELECT card_id, sum(quantity) FROM collection_entries
              WHERE coalesce(folder_id, 0) = coalesce(?1, 0)
              GROUP BY card_id ORDER BY card_id",
        )
        .unwrap()
        .query_map(params![folder], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// **Rule 3, and schema v25 is what rewrote it.** "Spare" was *the binder's copies less
    /// what a built deck had claimed*; a claim ledger no longer exists, and a deck holds the
    /// copies that sit in its group. So spare is now **not in any deck's group** — one
    /// `collection_folders.kind` lookup rather than a subtraction, and there is no second
    /// answer left to disagree with it.
    ///
    /// The copies really do have to *move* for the deck to hold them: adding a card to another
    /// deck's live list is not by itself a claim on anything, which is the half of this a
    /// reader coming from the old rule will expect to be false.
    #[test]
    fn a_copy_in_a_deck_group_is_not_spare() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let entry = own(&conn, "bolt-lea", 3);
        add(&conn, id, "bolt-lea", main, THEORY, 4);

        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            3,
            "at the root, every copy is spare"
        );

        // A second deck sleeves them up: the copies leave the reader's desk and take up
        // residence in that deck's group.
        let other = deck(&conn, "Other");
        file_into(&conn, entry, Some(group_of(&conn, other)));

        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            0,
            "a deck on a table has its cards, and this plan cannot count on them"
        );

        // And a copy bought afterwards lands at the root, where it is spare — so the answer is
        // about *where each row sits* rather than about the printing being spoken for at all.
        own(&conn, "bolt-lea", 1);
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            1,
            "the new copy is spare and the sleeved ones are still not"
        );
    }

    /// **The other three places a copy can sit are all spare**, and this is the half a naive
    /// `folder_id IS NULL` would get wrong while passing every assertion above.
    ///
    /// A binder is filing the reader did, not a claim. `Recently removed` is on this side
    /// deliberately and it is the sharper case: a card that left a deck without leaving the
    /// database is *back on the desk*, and the folder exists precisely so the reader can put it
    /// somewhere else — telling them a shopping-list line has no copies in the box while the
    /// copies are sitting in the holding area would be the app hiding its own undo.
    #[test]
    fn a_copy_in_a_binder_or_recently_removed_is_still_spare() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let entry = own(&conn, "bolt-lea", 2);
        add(&conn, id, "bolt-lea", main, THEORY, 4);

        file_into(&conn, entry, Some(binder(&conn, "Long box")));
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            2,
            "a binder is where the reader keeps cards, not a deck that is using them"
        );

        file_into(&conn, entry, Some(removed_folder(&conn)));
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            2,
            "and a card put aside is a card on the desk"
        );
    }

    /// **`owned_spare` counts this printing and no other**, exactly as the diff itself does —
    /// and it was per oracle card until 2026-08-20, which stopped being defensible the moment a
    /// different printing became a difference. A line asking for the Alpha Bolt over an
    /// "already owned" earned from two M10 ones describes two different objects.
    ///
    /// **The second half is the arithmetic the figure strip does**, and it is why this is not
    /// merely a matter of taste: `diffTotals` sums `ownedSpare` down the list, so an
    /// oracle-wide answer on a plan holding two printings of one card counted the same binder
    /// copies twice.
    #[test]
    fn owned_spare_counts_this_printing_and_no_other() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        own(&conn, "bolt-m10", 2);
        add(&conn, id, "bolt-lea", main, THEORY, 3);

        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            0,
            "a different printing of the card is not this printing"
        );

        add(&conn, id, "bolt-m10", main, THEORY, 1);
        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!(
            diff.iter().map(|r| r.owned_spare).collect::<Vec<_>>(),
            vec![0, 2],
            "each line answers for its own printing, so the strip's sum is 2 and not 4"
        );
    }

    /// Each diff row as `(printing, finish, quantity, held as another printing)`, in the
    /// editor's own reading order — the four figures every substitution test below turns on.
    fn substitutions(conn: &Connection, deck_id: i64) -> Vec<(String, Option<String>, i64, i64)> {
        theory_diff(conn, deck_id, ANY_MARKET)
            .unwrap()
            .into_iter()
            .map(|r| (r.card_id, r.finish, r.quantity, r.held_as_other_printing))
            .collect()
    }

    /// **A card the deck is already playing, in another printing, is still a full row — and says
    /// so.** The comparison is per printing (2026-08-20), so a plan naming the Alpha Bolt against
    /// a live list sleeving the M10 one is a card to go and find. That is right for *buying* and
    /// wrong for *playing*, because the deck runs; `held_as_other_printing` is the difference
    /// between the two readings, and it is the whole of what this row's reader needs to tell
    /// "missing" from "upgrade".
    #[test]
    fn a_row_the_deck_plays_another_printing_of_says_so() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-m10", main, LIVE, 1);
        add(&conn, id, "bolt-lea", main, THEORY, 1);

        assert_eq!(
            substitutions(&conn, id),
            vec![("bolt-lea".to_owned(), None, 1, 1)],
            "one Bolt to buy, and the deck is not missing a Bolt today"
        );

        // **The upper half of the invariant**, which the line above cannot tell apart from "the
        // pool, whatever it is": a second M10 Bolt on the table does not make the row two-thirds
        // covered, because there is only one copy on it. `0 <= held_as_other_printing <=
        // quantity`, and this is the clamp at the top.
        crate::deck::set_card_quantity(&conn, id, "bolt-m10", main, LIVE, None, 2).unwrap();
        assert_eq!(
            substitutions(&conn, id),
            vec![("bolt-lea".to_owned(), None, 1, 1)]
        );
    }

    /// **A row can be partly both.** Two wanted against one different printing held is one copy
    /// to go and find and one already on the table: `quantity` keeps its full value — that is
    /// what a press writes — and this field says how much of it is an upgrade rather than a hole.
    #[test]
    fn a_partly_substituted_row_keeps_its_whole_quantity() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-m10", main, LIVE, 1);
        add(&conn, id, "bolt-lea", main, THEORY, 2);

        assert_eq!(
            substitutions(&conn, id),
            vec![("bolt-lea".to_owned(), None, 2, 1)],
            "two to buy, one of which the deck is already playing"
        );
    }

    /// **One live copy excuses one row's copy and never two.** The pool is per oracle card and is
    /// drawn down as the list is walked, so two lines of the same card competing for one live
    /// copy are settled by the editor's own reading order rather than both being told they are
    /// covered. Spreading it instead would report two half-covered rows where one is covered and
    /// the other is not.
    ///
    /// The two theory lines are two **objects** of one printing — the regular copy and the foil,
    /// which is [`group_key`]'s other half — so the fixture needs no third `cards` row to make
    /// the point, and the live copy is a third object again.
    #[test]
    fn one_live_copy_cannot_excuse_two_rows() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-m10", main, LIVE, 1);
        // Added regular-first, because `diff_select` breaks the name tie on `dc.id` and the
        // order of these two adds *is* the reading order the pool is spent in.
        add_finish(&conn, id, "bolt-lea", main, THEORY, None, 1);
        add_finish(&conn, id, "bolt-lea", main, THEORY, Some("foil"), 1);

        assert_eq!(
            substitutions(&conn, id),
            vec![
                ("bolt-lea".to_owned(), None, 1, 1),
                ("bolt-lea".to_owned(), Some("foil".to_owned()), 1, 0),
            ],
            "one M10 Bolt on the table covers one of the two lines, not both"
        );
    }

    /// **An exact match is not also a substitute.** The copy that answered the row card for card
    /// was already spent by the subtraction that produced `quantity`, so it may not be counted a
    /// second time from the other side — only what is left over of the oracle card's live copies
    /// can excuse a remainder.
    ///
    /// Two live copies, one of them the very printing the plan names: 2 wanted less 1 held is one
    /// to buy, and the *other* printing is what covers it.
    #[test]
    fn an_exact_match_is_not_counted_as_a_substitute_as_well() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 1);
        add(&conn, id, "bolt-m10", main, LIVE, 1);
        add(&conn, id, "bolt-lea", main, THEORY, 2);

        assert_eq!(
            substitutions(&conn, id),
            vec![("bolt-lea".to_owned(), None, 1, 1)],
            "the Alpha copy paid for the subtraction; the M10 one covers what is left"
        );
    }

    /// **An orphan reads zero**, however many copies of anything the live list holds: a row whose
    /// printing has left `cards` names no oracle card, so there is no card for another printing
    /// to be a printing *of*. The live Bolt below would excuse an ordinary row of its own card
    /// and cannot reach this one.
    #[test]
    fn an_orphaned_row_is_never_held_as_another_printing() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, LIVE, 1);
        add(&conn, id, "bolt-m10", main, THEORY, 1);
        // What the next sync does to a printing Scryfall stopped publishing.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-m10'", [])
            .unwrap();

        assert_eq!(
            substitutions(&conn, id),
            vec![("bolt-m10".to_owned(), None, 1, 0)],
            "an orphan has no oracle card to be matched by"
        );
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

        let touched = missing_to_wishlist(&conn, id, None).unwrap();

        assert_eq!(touched, 1);
        assert_eq!(wishes(&conn), vec![(Some("o1".to_owned()), 3)]);
    }

    /// **The live list is subtracted once.** Netting `owned_spare` out of the wish as well is
    /// the bug this pins, and it hides from any fixture where the deck plays none of the card:
    /// [`TheoryDiffRow::quantity`] is already *wanted minus held*, while `owned_spare` nets out
    /// only what a deck's **group** holds — so copies the reader owns and has not filed into
    /// this deck read as spare and are charged against the wish a second time.
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

        // The premise: the copies are at the root rather than in this deck's group, so every one
        // of them reads spare — which is right for a reader and is the whole trap for a
        // subtraction, since `quantity` has already taken the live list off.
        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!((diff[0].quantity, diff[0].owned_spare), (1, 2));
        assert_eq!((diff[1].quantity, diff[1].owned_spare), (4, 3));

        let touched = missing_to_wishlist(&conn, id, None).unwrap();

        assert_eq!(touched, 2, "the Bolt is a wish, not a skipped negative");
        assert_eq!(
            wishes(&conn),
            vec![(Some("o1".to_owned()), 1), (Some("o2".to_owned()), 4)],
            "and the Angel asks for four, not for four less what is in the box"
        );
    }

    /// Every wish there is as `(oracle card, pinned printing, pinned finish, copies)` — three
    /// of [`WISHLIST_GRAIN`](crate::schema::WISHLIST_GRAIN)'s **four** columns and the count.
    /// The fourth is `folder_id`, added at schema v23, and it is left out because this command
    /// cannot name a folder: `missing_to_wishlist` adds at the root, which spec §1 accepts, so
    /// the term is NULL on every row this helper will ever read and asserting it would be
    /// asserting the same constant over and over. The first two are read as `String` on
    /// purpose: this command writes both on every wish now, so a NULL there is a failure and
    /// reads as one.
    fn pinned_wishes(conn: &Connection) -> Vec<(String, String, Option<String>, i64)> {
        conn.prepare(
            "SELECT oracle_id, card_id, preferred_finish, quantity
               FROM wishlist_entries ORDER BY id",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// **The wish is pinned to the printing the plan names, and to its finish** (2026-08-22).
    /// This wrote an any-printing wish until then, on an argument the comparison itself had
    /// already abandoned on 2026-08-20: a plan naming a printing is a plan for that cardboard,
    /// and a wish for any printing hands the reader back the substitution the two lists exist to
    /// track.
    ///
    /// **The regular copy pins no finish**, and that is the second assertion. `deck_cards.finish`
    /// is NULL for it, and writing `nonfoil` would put this wish on a different row of the
    /// wishlist grain from every other wish the app makes for that card.
    #[test]
    fn missing_to_wishlist_pins_the_printing_and_the_finish() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add_finish(&conn, id, "bolt-lea", main, THEORY, Some("foil"), 1);
        add_finish(&conn, id, "serra-lea", main, THEORY, None, 2);

        assert_eq!(missing_to_wishlist(&conn, id, None).unwrap(), 2);

        assert_eq!(
            pinned_wishes(&conn),
            vec![
                (
                    "o1".to_owned(),
                    "bolt-lea".to_owned(),
                    Some("foil".to_owned()),
                    1
                ),
                ("o2".to_owned(), "serra-lea".to_owned(), None, 2),
            ],
            "the Alpha Bolt in foil and the Angel plain — not two wishes for any printing"
        );
    }

    /// **`only` writes just the rows the reader left ticked**, named in [`group_key`]'s own
    /// spelling so the dialog and this write cannot drift apart.
    ///
    /// **And a key naming no row of the current difference writes nothing rather than refusing**,
    /// which is the second half: the diff is re-read inside the write, so a row ticked and then
    /// acquired in another window is simply not short any more. A press that finds nothing to do
    /// is the button working.
    #[test]
    fn missing_to_wishlist_writes_only_the_keys_it_was_given() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, THEORY, 1);
        add(&conn, id, "bolt-m10", main, THEORY, 1);
        add(&conn, id, "serra-lea", main, THEORY, 1);

        let only = vec![group_key("bolt-m10", None)];
        assert_eq!(missing_to_wishlist(&conn, id, Some(&only)).unwrap(), 1);

        assert_eq!(
            pinned_wishes(&conn),
            vec![("o1".to_owned(), "bolt-m10".to_owned(), None, 1)],
            "the two rows the reader unticked stayed off the list"
        );

        // A key for a card this deck's difference does not hold — and one for a *finish* it does
        // not hold, which is the near miss the shared `group_key` is there to make impossible to
        // spell by accident.
        let unknown = vec![
            group_key("serra-lea", Some("foil")),
            group_key("nothing-at-all", None),
        ];
        assert_eq!(missing_to_wishlist(&conn, id, Some(&unknown)).unwrap(), 0);
        assert_eq!(pinned_wishes(&conn).len(), 1, "nothing written, no refusal");
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

    /// **A plan moves no cardboard**, which is what this rule became at schema v25. It used to
    /// read "a plan reserves nothing" against a claim ledger; there is no ledger, and the way a
    /// plan could now go wrong is sharper — [`seed_from_live`] writes a pile of `theory` rows in
    /// one statement, and any of that copying reaching the collection would file a second set of
    /// copies the reader does not own into a group that already holds theirs.
    ///
    /// **The deck has to really hold the copies, or the test cannot fail.** Eight owned against
    /// four sleeved up, so a seed that duplicated the group's contents would come out at eight
    /// in the box — a fixture with everything in the group already at its maximum could not tell
    /// a doubling from a no-op.
    #[test]
    fn seeding_the_plan_moves_no_collection_copy() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        // Four sleeved up and four still in the binder. **The split is what makes a doubling
        // visible**: a group already holding everything the reader owns reads the same whether
        // the seed filed a second set or nothing at all. Filed first and topped up after,
        // because `own` lands on the eleven-term grain — a second add at the root while the
        // first row is still there is one row of eight, not two rows of four.
        let sleeved = own(&conn, "bolt-lea", 4);
        file_into(&conn, sleeved, Some(group_of(&conn, id)));
        own(&conn, "bolt-lea", 4);
        add(&conn, id, "bolt-lea", main, LIVE, 4);

        copy_from_live(&conn, id).unwrap();

        assert_eq!(
            cards_in(&conn, id, THEORY),
            vec![("bolt-lea".to_owned(), 4)],
            "the plan holds the same four copies"
        );
        assert_eq!(
            copies_in(&conn, Some(group_of(&conn, id))),
            vec![("bolt-lea".to_owned(), 4)],
            "and the box still holds four, not eight"
        );
        assert_eq!(
            copies_in(&conn, None),
            vec![("bolt-lea".to_owned(), 4)],
            "the binder is untouched too — a plan is a list, and lists move no cardboard"
        );
    }

    /// A stale deck id is answered in words by every entry point here, rather than by an empty
    /// list that reads like a deck with nothing in it.
    #[test]
    fn a_deck_that_is_gone_is_refused_by_name() {
        let conn = seeded();

        assert_eq!(copy_from_live(&conn, 404).unwrap_err(), crate::deck::GONE);
        assert_eq!(
            missing_to_wishlist(&conn, 404, None).unwrap_err(),
            crate::deck::GONE
        );
    }

    /// A shopping list is priced at the marketplace the reader shops at, and at nowhere else —
    /// one figure per line, out of the printing the theory row names, never `cards.price_usd`.
    ///
    /// The second line is an etched-only printing, and it is what separates the four. A theory
    /// row is a **printing**, priced in the finish it is sold in, so TCGplayer quotes it at
    /// `usd_etched` and Card Kingdom at its own etched row — while Cardmarket has no
    /// `eur_etched` key to quote and Mana Pool has never listed the card. **A shopping list must
    /// not borrow a figure across that line**: the reader is buying where they shop.
    #[test]
    fn a_diff_line_is_priced_by_the_marketplace_it_was_asked_for() {
        let conn = seeded();
        conn.execute_batch(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    prices,price_usd,price_eur,raw)
               VALUES
                 ('both','o3','Both','tst','1','en','normal',
                  '{"usd":"10.00","eur":"7.50"}',10.0,7.5,'{}'),
                 ('etched-only','o4','Etched Only','tst','2','en','normal',
                  '{"usd":null,"usd_etched":"0.71","eur":null,"eur_foil":null}',
                  0.71,NULL,'{}');"#,
        )
        .unwrap();
        conn.execute_batch(
            "INSERT INTO marketplace_prices VALUES
                ('cardkingdom','both','nonfoil',9.0),
                ('cardkingdom','etched-only','etched',0.6),
                ('manapool','both','nonfoil',11.0),
                ('manapool','bolt-lea','nonfoil',390.0);",
        )
        .unwrap();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        set_theory(&conn, id, true);
        add(&conn, id, "both", main, THEORY, 1);
        add(&conn, id, "etched-only", main, THEORY, 1);
        // `bolt-lea`'s blob is dollars only — the ordinary case for an older printing.
        add(&conn, id, "bolt-lea", main, THEORY, 1);

        let price = |card: &str, marketplace| {
            theory_diff(&conn, id, marketplace)
                .unwrap()
                .iter()
                .find(|r| r.card_id == card)
                .unwrap()
                .unit_price
        };
        use crate::sorting::Marketplace::{Cardkingdom, Cardmarket, Manapool, Tcgplayer};

        assert_eq!(price("both", Tcgplayer), Some(10.0));
        assert_eq!(price("both", Cardmarket), Some(7.5));
        assert_eq!(price("both", Cardkingdom), Some(9.0));
        assert_eq!(price("both", Manapool), Some(11.0));

        assert_eq!(price("etched-only", Tcgplayer), Some(0.71));
        assert_eq!(price("etched-only", Cardkingdom), Some(0.6));
        for marketplace in [Cardmarket, Manapool] {
            assert_eq!(
                price("etched-only", marketplace),
                None,
                "{marketplace:?} quotes this printing in no finish it is sold in, and the 0.71 \
                 the other two carry is not this shop's number"
            );
        }

        assert_eq!(price("bolt-lea", Tcgplayer), Some(400.0));
        assert_eq!(
            price("bolt-lea", Cardmarket),
            None,
            "a blob with no `eur` is unpriced there, never the dollar figure"
        );
        assert_eq!(
            price("bolt-lea", Cardkingdom),
            None,
            "and a printing the feed has never listed is unpriced too"
        );
        assert_eq!(price("bolt-lea", Manapool), Some(390.0));
    }

    /// The keys alone, sorted — `theory_slots` answers in whatever order the scan returns and
    /// most assertions below are about the *set*. [`slot_counts`] is for the ones that are about
    /// what the plan asks for.
    fn slots(conn: &Connection, deck_id: i64) -> Vec<String> {
        let mut out: Vec<String> = theory_slots(conn, deck_id)
            .unwrap()
            .into_iter()
            .map(|s| s.key)
            .collect();
        out.sort();
        out
    }

    /// The same rows as `(key, quantity)` pairs, sorted.
    fn slot_counts(conn: &Connection, deck_id: i64) -> Vec<(String, i64)> {
        let mut out: Vec<(String, i64)> = theory_slots(conn, deck_id)
            .unwrap()
            .into_iter()
            .map(|s| (s.key, s.quantity))
            .collect();
        out.sort();
        out
    }

    /// The tick's whole job: the plan's rows, and only the plan's.
    #[test]
    fn theory_slots_answers_the_plan_and_never_the_live_list() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        add(&conn, d, "bolt-lea", main, THEORY, 4);
        add(&conn, d, "serra-lea", main, LIVE, 1);

        assert_eq!(slots(&conn, d), vec!["bolt-lea|"]);
    }

    /// The grain, from the side the mark reads it: a plan naming the foil is not answered by the
    /// regular copy, and the regular copy's key is the one `group_key` spells with an empty half.
    #[test]
    fn theory_slots_tells_a_finish_from_the_regular_copy() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        add_finish(&conn, d, "bolt-lea", main, THEORY, Some("foil"), 1);
        add_finish(&conn, d, "serra-lea", main, THEORY, None, 1);

        assert_eq!(slots(&conn, d), vec!["bolt-lea|foil", "serra-lea|"]);
    }

    /// **The key is `group_key`'s own**, which is what stops the tick and the shopping list
    /// drifting apart — this asserts they are the same string rather than two conventions that
    /// happen to agree today.
    #[test]
    fn theory_slots_answers_group_keys_rather_than_a_second_spelling() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        add_finish(&conn, d, "bolt-lea", main, THEORY, Some("etched"), 1);

        assert_eq!(slots(&conn, d), vec![group_key("bolt-lea", Some("etched"))]);
    }

    /// A pile is invisible to this, which is what lets the mark survive a re-filing — the same
    /// card planned as Ramp and sleeved into Main deck is one planned card. One key, not two.
    ///
    /// **And the two piles are *summed* rather than folded to one of them** — the fold moved
    /// into the SQL when the quantity joined the key, and a plan asking for two Bolts across two
    /// piles asks for two Bolts.
    #[test]
    fn theory_slots_does_not_care_which_pile_the_plan_files_a_card_in() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let ramp = category(&conn, d, "Ramp");
        let main = category(&conn, d, "Main deck");
        add(&conn, d, "bolt-lea", ramp, THEORY, 1);
        add(&conn, d, "bolt-lea", main, THEORY, 1);

        assert_eq!(slot_counts(&conn, d), vec![("bolt-lea|".to_owned(), 2)]);
    }

    /// The number the tick's difference is measured against — what the plan asks for, per slot,
    /// with the finishes told apart exactly as the key tells them apart.
    #[test]
    fn theory_slots_answer_how_many_copies_the_plan_asks_for() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        add_finish(&conn, d, "bolt-lea", main, THEORY, None, 4);
        add_finish(&conn, d, "bolt-lea", main, THEORY, Some("foil"), 1);

        assert_eq!(
            slot_counts(&conn, d),
            vec![("bolt-lea|".to_owned(), 4), ("bolt-lea|foil".to_owned(), 1)]
        );
    }

    /// An inactive pile is excluded from the **quantity** too, not merely from the key list —
    /// the plan is not asking for a card it has parked in the Maybeboard, so those copies may
    /// not swell the number the tick counts down from.
    #[test]
    fn theory_slots_leave_a_switched_off_pile_out_of_the_count() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        let maybe = category(&conn, d, "Maybeboard");
        add(&conn, d, "bolt-lea", main, THEORY, 2);
        add(&conn, d, "bolt-lea", maybe, THEORY, 3);
        conn.execute(
            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
            params![maybe],
        )
        .unwrap();

        assert_eq!(slot_counts(&conn, d), vec![("bolt-lea|".to_owned(), 2)]);
    }

    /// `diff_select`'s rule, read by the same reasoning: a card parked in an inactive pile is
    /// not something the user has decided to play, so the plan is not asking for it.
    #[test]
    fn theory_slots_skips_a_switched_off_pile() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        let maybe = category(&conn, d, "Maybeboard");
        add(&conn, d, "bolt-lea", main, THEORY, 1);
        add(&conn, d, "serra-lea", maybe, THEORY, 1);
        conn.execute(
            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
            params![maybe],
        )
        .unwrap();

        assert_eq!(slots(&conn, d), vec!["bolt-lea|"]);
    }

    /// A deck with no plan answers nothing rather than erroring — which is the honest reading,
    /// and what lets the frontend gate on the switch alone.
    #[test]
    fn theory_slots_answers_nothing_for_a_deck_with_no_plan() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        let main = category(&conn, d, "Main deck");
        add(&conn, d, "bolt-lea", main, LIVE, 4);

        assert!(theory_slots(&conn, d).unwrap().is_empty());
    }

    /// The hand-mirrored wire contract, pinned so a field added here and never mirrored in
    /// `src/lib/ipc.ts` fails the suite rather than rendering as `undefined`.
    #[test]
    fn theory_diff_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(TheoryDiffRow {
            card_id: "bolt-lea".to_owned(),
            name: "Lightning Bolt".to_owned(),
            category_name: "Main deck".to_owned(),
            quantity: 2,
            unit_price: Some(400.0),
            set_code: "lea".to_owned(),
            collector_number: "161".to_owned(),
            finish: Some("foil".to_owned()),
            owned_spare: 1,
            held_as_other_printing: 1,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "cardId": "bolt-lea", "name": "Lightning Bolt", "categoryName": "Main deck",
                "quantity": 2, "unitPrice": 400.0,
                "setCode": "lea", "collectorNumber": "161", "finish": "foil", "ownedSpare": 1,
                "heldAsOtherPrinting": 1
            })
        );
    }

    /// The tick's own wire contract, pinned for [`TheoryDiffRow`]'s reason — this one crosses to
    /// `src/lib/ipc.ts`'s `TheorySlot` and to `.storybook/fake/db.ts`, and a renamed field would
    /// otherwise reach the mark as `undefined` and read as a deck with no plan.
    #[test]
    fn theory_slot_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(TheorySlot {
            key: "bolt-lea|foil".to_owned(),
            quantity: 4,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({ "key": "bolt-lea|foil", "quantity": 4 })
        );
    }
}
