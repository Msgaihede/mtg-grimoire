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
//! **"Not a deck the user has" is about cardboard and never about arithmetic**, and 2026-09-09
//! is where the two came apart ([#435](https://github.com/Msgaihede/mtg-grimoire/issues/435)).
//! A plan's rows now report an owned figure of their own, attributed from every copy the reader
//! could put behind them — [`crate::deck::get_deck`] picks that pool by variant. Nothing in this
//! module followed it, deliberately: [`OWNED_SPARE_SQL`] still drops every deck group including
//! this deck's own, because [`theory_diff`] has already subtracted the live list and counting
//! the group as spare on top would count it twice. That warning is on both of them.
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
//!   the player, and the one question this module answers at the oracle card's grain. **The
//!   plan's tokens and emblems are compared too** (the token-improvements spec §3.7), after the
//!   cards and by the same arithmetic ([`Tally`]): an entry of the plan's token wall is as much
//!   a thing to go and find as a card is.
//! * **Buying it.** [`missing_to_wishlist`] turns that difference into wishes — the difference
//!   itself, with nothing netted out of it, pinned to the printings the plan names, and
//!   optionally narrowed to the rows the reader ticked. See that function on why subtracting
//!   [`TheoryDiffRow::owned_spare`] there counts the live list twice.
//!
//! **Switching the theory list off keeps every row.** It hides a switch; it does not delete a
//! list. Nothing in this module or in `deck.rs` deletes a `theory` row except the ordinary card
//! writes the user makes against it.

use crate::deck::{entry_finish, entry_spellings, played_finish};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;

/// What is actually sleeved up — `DECK_VARIANTS[0]` by index, [`crate::deck`]'s discipline.
const LIVE: &str = crate::schema::DECK_VARIANTS[0];
/// What the deck is being built toward.
const THEORY: &str = crate::schema::DECK_VARIANTS[1];

/// One card the plan asks for — [`theory_slots`]' row, and the deck editor's theory tick.
///
/// **Three fields since 2026-09-07, and the third is the name.** This carried two until the mark
/// grew a second tier: a green tick for the printing the plan named and a blue one for the same
/// card in a printing it did not. The loose tier needs an identity that survives a different
/// printing, and the name is it. What is still *not* here is everything a mark would have to be
/// told to ignore — the set, the price, the pile.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TheorySlot {
    /// [`group_key`]'s own string — `` `{card_id}|{finish}` ``, the regular copy spelling its
    /// half empty and the finish being the one the row plays ([`played_finish`]), which
    /// `theoryMatch.ts`' `theorySlot` spells the same way for a live row.
    /// **This module's function rather than a pair the caller reassembles**, which
    /// is what stops the tick and the shopping list drifting apart: "the same planned card" is
    /// one definition, and both surfaces spell it with this code.
    pub key: String,
    /// The card's printed name, exactly as `cards.name` holds it — or `None` for an orphan whose
    /// printing has left the corpus.
    ///
    /// **The second grain, and the loose tier's whole input.** `key` above answers *is this the
    /// printing I planned*; this answers *is this the card I planned*, which is the question a
    /// reader holding a different Forest is asking. It is a name rather than an `oracle_id`
    /// because Scryfall omits that field on reversible cards, on both sides of the comparison,
    /// and an identity with a fallback chain is two rules for two sides to disagree about.
    ///
    /// **Unfolded on purpose.** SQLite's `lower()` is ASCII-only; the webview's `toLowerCase()`
    /// is not. Folded here, `Lim-Dûl's Vault` and `Æther Vial` would spell one key in the plan
    /// and another in the live list, and the mark would go dark on exactly the cards whose
    /// absence is hardest to notice. `theoryMatch.ts`'s `theoryNameKey` folds both sides, in one
    /// language, and is the only place the rule is written.
    pub name_key: Option<String>,
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
    /// Which **object** this line is for — the finish the theory row **plays** ([`played_finish`]),
    /// so `None` is the regular copy and the other two are `foil` and `etched`
    /// ([`crate::schema::FINISHES`] less `nonfoil`, which [`crate::deck::normalise_finish`] stores
    /// as NULL). A row that stored no finish on a printing sold only in foil reads `foil` here,
    /// because that is the only object it can be (issue #563).
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
    /// Whether this line is a **token or emblem entry** rather than a deck card — the
    /// token-improvements spec §3.7, and what the dialog's **Tokens** view filters on.
    ///
    /// A token row is [`token_diff`]'s: one entry of the plan's token wall less the live list's,
    /// at the same `(card_id, finish)` grain and by the same subtraction as a card row, filed
    /// under [`TOKEN_CATEGORY`] because a token sits in no pile. **Every other field means what
    /// it means on a card row**, [`Self::finish`]'s spelling of the regular copy included — so
    /// the dialog's key, the owned figure and the price read a token line exactly as they read a
    /// card line, and this flag is the one thing that tells the two apart.
    pub is_token: bool,
}

/// The category every token row is filed under — the deck editor's band, by its own name.
///
/// A token entry sits in no pile: `deck_token_printings` has no `category_id`, and the band is
/// where the reader counts it. So the caption a card row takes from its category, a token row
/// takes from here.
const TOKEN_CATEGORY: &str = "Tokens & Emblems";

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
/// quoted per finish), and are two rows in `deck_cards` for exactly that reason. **It is the
/// finish the row plays, [`played_finish`], not the column as stored** (issue #563): the one place
/// this key is wider than the grain, where a foil-only printing's unsaid row and its `foil` row are
/// two rows of the table and one object.
///
/// [`GROUP_SEPARATOR`] is what keeps the pair a pair. An orphan — a row whose printing has left
/// `cards` — needs no special case, which is the simplification the change bought: its
/// `card_id` is its identity like everything else's, so the prefix that used to keep oracle ids
/// and card ids apart went with the oracle key.
///
/// The oracle id survives on *this* struct because two things need it, and neither draws it.
///
/// **The wish.** [`missing_to_wishlist`] writes through [`crate::wishlist::add_wish_silent`],
/// whose grain is `(oracle_id, card_id, preferred_finish)` — so a wish pinned to this row's exact
/// printing still carries the oracle card that printing is of. That wish stopped being
/// oracle-grained on **2026-08-22**: this paragraph used to end "a wish is oracle-grained ('any
/// printing'), because a shopping list is not a printing preference", and that argument had
/// already lost on 2026-08-20, when the comparison itself became per printing. Two printings of
/// one card are two lines here and now **two** wishes.
///
/// **The substitution count.** [`TheoryDiffRow::held_as_other_printing`] is per oracle card by
/// definition, so the pool it draws from is keyed on it — through [`Self::pool`], which is the
/// oracle id on every card row and on every token row but one kind (below).
///
/// It is deliberately **not** on [`TheoryDiffRow`]: the webview draws a printing, a count and
/// two figures, and has no use for a uuid it cannot show.
struct Grouped {
    oracle_id: Option<String>,
    /// What [`Tally`] pools live copies under for [`TheoryDiffRow::held_as_other_printing`] — the
    /// oracle id, except for a token row read at [`TokenPool::Name`], where it is the token's
    /// name (issue #675). `None` for an orphan, which is not another printing of anything.
    pool: Option<String>,
    /// The printing's `cards.finishes`, for [`OWNED_SPARE_SQL`]'s [`entry_spellings`] — not on
    /// [`TheoryDiffRow`] for `oracle_id`'s reason.
    finishes: Option<String>,
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
            -- Beside the finish it completes: [`played_finish`] reads the two together.
            c.finishes,
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
/// ⚠️ **This deck's own group is on the *not*-spare side and must stay there, which stopped
/// looking obvious on 2026-09-09** ([#435](https://github.com/Msgaihede/mtg-grimoire/issues/435)).
/// That day a `theory` row's *owned figure* started counting this deck's own group — through
/// [`crate::collection_source::Availability::ForDeck`], which differs from this statement in
/// exactly that one arm — and the tempting next edit is to make the two agree. It would be a
/// double count. [`theory_diff`] has already netted the live list out before this figure is
/// read: `short = wanted − held`, where `held` is what the live list holds, so folding the same
/// copies in again as "spare" counts them twice. See [`missing_to_wishlist`], which subtracts
/// nothing for the same reason and argues it at length. **Two surfaces, two questions**: the
/// diff compares the plan against the *list* that is sleeved, the owned figure compares it
/// against the *cardboard* the reader can reach. Both may be right about one row at once.
///
/// **On exactly [`Grouped`]'s key, because the figure strip sums this field down the list.**
/// It was per oracle card until 2026-08-20 — which stopped being defensible the moment a
/// different printing became a difference — and any answer *wider* than the row's own identity
/// counts one binder copy once per row that could have used it. The two halves of a line may
/// not disagree about what a card is: "buy the foil retro-frame one" over a spare count earned
/// by regular precon copies is a sentence about two different objects.
///
/// **`?2` and `?3` are the words a copy of the line's finish may carry** —
/// [`crate::deck::entry_spellings`] of the finish the line plays, in the collection's spelling
/// ([`crate::deck::entry_finish`]). That is the translation between two spellings of the regular
/// copy: the deck spells it NULL ([`crate::deck::normalise_finish`], so the grain's
/// `coalesce(finish, '')` has one thing to compare) while `collection_entries.finish` is `NOT NULL`
/// and spells it `nonfoil` outright, and binding the deck's NULL straight through would make every
/// regular line read zero spare. It is the *played* finish rather than the stored one for the same
/// reason one level up: an unsaid row of a foil-only printing bound as `nonfoil` counted none of
/// the foil copies the binder holds, which are the only copies of it there are. And it is **both**
/// spellings on such a printing, because a binder row stored `nonfoil` for a card sold only in foil
/// is that foil too (2026-09-27) — the quick add, an import that named no finish and the scanner's
/// default all wrote one. Everywhere else the two holes carry one word twice.
///
/// No `LEFT JOIN cards` and no orphan arm: `collection_entries.card_id` is the printing, so an
/// entry whose card has left the corpus is matched by exactly the same equality as every other.
///
/// **The kind is interpolated from [`crate::schema::COLLECTION_FOLDER_KINDS`]`[1]` rather than
/// typed**, which is why this is a `LazyLock<String>` and not a `const`. It read `'deck'` as a
/// literal, and a literal here is not the migration ladder's kind of literal: a rung is history
/// and must not move when a constant does, while this is a **live read** that has to mean
/// whatever the DDL's `CHECK` means today. The `format!` is spent once per process.
///
/// **A locked folder's copies are not spare either, and the second arm is the first one's device
/// for the first one's reason.** This statement already means *the copies this plan can count
/// on*; a card in a display case, or one held for a trade, is not one of them — the reader set
/// that drawer aside, and a shopping list that quietly spends its contents is offering them
/// cardboard they have already promised somewhere else. It reads the **effective** lock, so a
/// subfolder of a locked folder counts as locked, through
/// [`crate::collection_folders::LOCKED_FOLDER_IDS`] rather than a second copy of that rule here
/// — the same statement [`crate::collection::scope`] pushes, so the page's list and this figure
/// cannot come to disagree about which drawers are set aside.
///
/// **Its own `IS NULL` arm, because the two conditions are ANDed** and each has to let the root
/// through on its own: the root is where most copies are, and a `NOT IN` over a NULL is NULL
/// rather than true.
///
/// **Unconditional, unlike [`crate::collection::CollectionQuery::exclude_locked`] one module
/// over**, and the asymmetry is deliberate rather than an oversight: no backup and no export
/// reads this figure. `owned_spare` is a **display** field — [`TheoryDiffRow::owned_spare`] is
/// "for a reader, beside a price" and is forbidden from being a term in any arithmetic — so
/// widening it cannot move a number anywhere else, where widening a *list* read is exactly how a
/// whole-collection backup silently loses rows.
static OWNED_SPARE_SQL: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "SELECT coalesce(sum(e.quantity), 0)
       FROM collection_entries e
      WHERE e.card_id = ?1 AND e.finish IN (?2, ?3)
        AND (e.folder_id IS NULL
             OR (SELECT f.kind FROM collection_folders f
                  WHERE f.id = e.folder_id) <> '{deck}')
        AND (e.folder_id IS NULL
             OR e.folder_id NOT IN ({locked}))",
        deck = crate::schema::COLLECTION_FOLDER_KINDS[1],
        locked = crate::collection_folders::LOCKED_FOLDER_IDS
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
///
/// **Then the token rows** ([`token_diff`], the token-improvements spec §3.7), after every card
/// row and flagged [`TheoryDiffRow::is_token`]: the plan's token entries less the live list's,
/// on the same grain and by the same subtraction. The dialog's **All** is the whole answer,
/// **Tokens** the flagged rows alone, and **Missing** and **Different printing** the rest.
///
/// **One read transaction over every read**, because this is no longer one statement. The card
/// rows are one `SELECT` for [`grouped_diff`]'s reason, but each token wall is a derivation of
/// its own over that list's cards, and in autocommit every read is its own snapshot of the deck —
/// a card write landing between them would put a Treasure on one side of the subtraction and its
/// maker on neither. Deferred, so it takes SQLite's read snapshot at the first statement and
/// writes nothing; `CardIndex::build` is the same arrangement on the same read connection.
/// **No caller holds a transaction here** — the two writes that read the difference inside one,
/// [`missing_to_wishlist`] and [`wanted`], call [`grouped_diff`] and [`token_diff`] themselves.
pub fn theory_diff(
    conn: &Connection,
    deck_id: i64,
    marketplace: crate::sorting::Marketplace,
) -> Result<Vec<TheoryDiffRow>, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let mut rows = grouped_diff(&tx, deck_id, marketplace)?;
    rows.extend(token_diff(&tx, deck_id, marketplace, TokenPool::Oracle)?);
    Ok(rows.into_iter().map(|g| g.row).collect())
}

/// Both sides of one comparison, summed per [`group_key`] — the whole of the arithmetic, which
/// [`grouped_diff`] feeds with the card rows and [`token_diff`] with the token entries.
///
/// **Written once so the two cannot subtract differently.** A token line is the spec's "same
/// grain and the same subtraction the card rows use", and that includes the least obvious part
/// of it: [`TheoryDiffRow::held_as_other_printing`]'s pool, where one live copy can excuse at
/// most one row's copy and a copy an exact line already matched excuses none. A second copy of
/// that walk for tokens would be free to come to count a sleeved nonfoil Treasure as standing in
/// for a planned foil one as well as for the nonfoil one it already answers.
///
/// **One tally per comparison, never one for both**: a card and a token never share an oracle
/// card, and keeping their pools apart means a legacy `deck_cards` row naming a token printing —
/// from before `deck::add_card` rerouted tokens — cannot be subtracted from a token entry.
#[derive(Default)]
struct Tally {
    /// Copies per key the plan asks for.
    wanted: HashMap<String, i64>,
    /// Copies per key the live list holds.
    held: HashMap<String, i64>,
    /// Live copies per **oracle card** — the grain `held_as_other_printing` is asked at, and the
    /// only figure here that is not about the exact card. Summed in the same pass as the two
    /// above and never by a second query over the live list, for the reason [`grouped_diff`]'s
    /// one statement gives: two reads are two moments of the deck, and a write between them would
    /// put a copy on one side of an arithmetic and not the other.
    live_by_oracle: HashMap<String, i64>,
    /// The plan's lines in reading order: it is what decides both which row represents a group
    /// and where its line lands.
    order: Vec<(String, Grouped)>,
}

impl Tally {
    /// One plan row of `quantity` copies. `line` is called only for the first plan row of its
    /// key, which is the one that represents the line — the rest add their copies to it.
    fn want(&mut self, key: String, quantity: i64, line: impl FnOnce() -> Grouped) {
        *self.wanted.entry(key.clone()).or_insert(0) += quantity;
        if !self.order.iter().any(|(k, _)| *k == key) {
            self.order.push((key, line()));
        }
    }

    /// One live row of `quantity` copies, and the pool it feeds — [`Grouped::pool`]: the oracle
    /// card it is a copy of, or a token's name.
    fn hold(&mut self, key: String, oracle: Option<&str>, quantity: i64) {
        // An orphan contributes nothing to the pool: a row whose printing has left `cards`
        // names no oracle card, so it is not another printing *of* anything.
        if let Some(oracle) = oracle {
            *self.live_by_oracle.entry(oracle.to_owned()).or_insert(0) += quantity;
        }
        *self.held.entry(key).or_insert(0) += quantity;
    }

    /// The subtraction: every line the plan is short on, with its owned figure and its
    /// substitution count, in the plan's reading order.
    fn settle(self, conn: &Connection) -> Result<Vec<Grouped>, String> {
        let Tally {
            wanted,
            held,
            live_by_oracle,
            order,
        } = self;
        let mut spare = conn.prepare(&OWNED_SPARE_SQL).map_err(|e| e.to_string())?;
        let mut diff = Vec::new();
        // What the **exact** lines have already spoken for, per oracle card. Accumulated over
        // every group, including the ones that drop out just below: a plan the deck answers card
        // for card still spends those live copies, and leaving them in the pool would let them
        // excuse a second row as well. Only a group with a plan row can be non-zero — `wanted`
        // is 0 for every other key — and a group with a plan row is a group whose oracle id is
        // known.
        let mut matched_by_oracle: HashMap<String, i64> = HashMap::new();
        for (key, mut grouped) in order {
            let wanted_here = wanted.get(&key).copied().unwrap_or(0);
            let held_here = held.get(&key).copied().unwrap_or(0);
            if let Some(oracle) = &grouped.pool {
                *matched_by_oracle.entry(oracle.clone()).or_insert(0) += wanted_here.min(held_here);
            }
            let short = wanted_here - held_here;
            if short <= 0 {
                continue;
            }
            grouped.row.quantity = short;
            // No floor, and there was one until schema v25: the old statement *subtracted* a
            // built deck's stored claims and a collection stepped down under one went negative.
            // This one sums quantities off a column with `CHECK (quantity >= 0)`, so there is no
            // arithmetic left that can produce a number with no reading.
            let played = entry_finish(grouped.row.finish.as_deref(), grouped.finishes.as_deref());
            let [said, legacy] = entry_spellings(&played, grouped.finishes.as_deref());
            grouped.row.owned_spare = spare
                .query_row(params![grouped.row.card_id, said, legacy], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|e| e.to_string())?;
            diff.push(grouped);
        }

        // Live copies of each oracle card that no exact line already claimed — the pool a
        // surviving row draws [`TheoryDiffRow::held_as_other_printing`] out of. Floored at zero
        // for `owned_spare`'s reason: a negative here would be a number with no reading.
        let mut pool = live_by_oracle;
        for (oracle, matched) in matched_by_oracle {
            let left = pool.entry(oracle).or_insert(0);
            *left = (*left - matched).max(0);
        }
        // **Walked in the surviving rows' own reading order, and that is what makes the answer
        // deterministic.** The pool belongs to the oracle card, so when two lines of one card
        // both qualify for it the first one down the page takes it and the second reads what is
        // left — which is how one live copy comes to excuse one row's copy and never two.
        // Spreading it instead would tell the reader that two rows are half-covered when one is
        // covered and the other is not.
        for grouped in &mut diff {
            // An orphan is never a substitution: it names no oracle card to be another printing
            // of.
            let Some(oracle) = grouped.pool.as_deref() else {
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
}

/// [`theory_diff`]'s card rows, in their working form — see [`Grouped`] for why the oracle id
/// stays.
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
                r.get::<_, Option<String>>(8)?, // finish, as stored
                r.get::<_, Option<String>>(9)?, // the printing's finishes
                r.get::<_, Option<f64>>(10)?,   // unit price
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut tally = Tally::default();
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
            finishes,
            unit_price,
        ) = row.map_err(|e| e.to_string())?;
        // The finish the row *plays*, not the one it happened to store — issue #563, and
        // [`played_finish`]'s whole argument. It is also what the line reports and what its wish
        // is pinned to, so a foil-only printing is bought as the foil it can only be.
        let finish = played_finish(finish, finishes.as_deref());
        // The exact card — printing and finish — see [`Grouped`]. `category` is read for the
        // row's caption and is deliberately *not* in the key: where a card sits is placement,
        // not possession, so a plan that moved a Bolt from Burn to Removal is short of no Bolts.
        let key = group_key(&card_id, finish.as_deref());
        if variant == THEORY {
            tally.want(key, quantity, || Grouped {
                pool: oracle.clone(),
                oracle_id: oracle,
                finishes,
                row: TheoryDiffRow {
                    card_id,
                    name,
                    category_name: category,
                    // Filled by the tally, once both sides are summed.
                    quantity: 0,
                    unit_price,
                    set_code,
                    collector_number,
                    finish,
                    owned_spare: 0,
                    held_as_other_printing: 0,
                    is_token: false,
                },
            });
        } else {
            // Inactive categories are already off both sides — `diff_select` does that once, for
            // both.
            tally.hold(key, oracle.as_deref(), quantity);
        }
    }
    tally.settle(conn)
}

/// [`theory_diff`]'s **token rows** (the token-improvements spec §3.7): for each
/// `(card_id, finish)` of a token entry, the plan's entries less the live list's, positive only —
/// [`grouped_diff`]'s grain and, through [`Tally`], its subtraction.
///
/// **Both walls are [`crate::deck_tokens::deck_token_rows`]' own, implicit entries included**,
/// so what is compared is what the band draws: a derived token no entry has touched counts its
/// implicit entry at `0` since user schema v55 and asks for nothing, and a hand-added one counts
/// only in a list that holds an entry of it. **A `hidden` state is not read**: nothing hides a
/// token since v55, and a dismissal an older peer synced in counts like any other token until
/// the launch pass retires it. Inactive categories are already off both sides — the derivation
/// reads active piles only, which is [`diff_select`]'s rule from the other table.
///
/// **The regular copy is spelled `None`**, as a card row spells it, where an entry always names
/// its finish: so the dialog's key, [`OWNED_SPARE_SQL`]'s [`entry_spellings`] and the Compare
/// views read a token line exactly as they read a card line — the entry's printing's
/// `cards.finishes` rides on [`Grouped`] for the spare count, as a card row's does. [`wish_finish`]
/// spells it back out for the wish.
///
/// **An entry whose printing has left the corpus is an orphan**, [`grouped_diff`]'s kind: its
/// chin reads `None` ([`crate::deck_tokens::DeckTokenRow::set_code`]'s rule), so it carries no
/// oracle card, is never another printing of anything and files no wish — `add_wish` refuses a
/// `card_id` the corpus does not hold, and from inside a press that refusal would abort the
/// whole press rather than skip one line.
///
/// **`pool` decides only [`TheoryDiffRow::held_as_other_printing`]**, never the shortfall: every
/// row is still one printing and finish less the live list's copies of that printing and finish.
/// [`TokenPool::Oracle`] is the Compare dialog's reading; [`TokenPool::Name`] is a managed
/// wishlist following Missing's (issue #675), and is why a token row's pool is not simply its
/// oracle id.
fn token_diff(
    conn: &Connection,
    deck_id: i64,
    marketplace: crate::sorting::Marketplace,
    pool: TokenPool,
) -> Result<Vec<Grouped>, String> {
    // The pool key of one token row: `None` for an orphan — [`Tally::hold`]'s rule, it is not a
    // printing *of* anything — and otherwise the oracle card or the name, as `pool` says.
    let pool_of = |token: &crate::deck_tokens::DeckTokenRow| {
        token.set_code.as_ref().map(|_| match pool {
            TokenPool::Oracle => token.oracle_id.clone(),
            TokenPool::Name => token.name.clone(),
        })
    };
    let mut tally = Tally::default();
    for token in crate::deck_tokens::deck_token_rows(conn, deck_id, THEORY, marketplace)? {
        let finish = regular_as_none(token.finish.clone());
        let key = group_key(&token.card_id, finish.as_deref());
        let pooled = pool_of(&token);
        let oracle = token.set_code.is_some().then_some(token.oracle_id);
        tally.want(key, token.quantity, || Grouped {
            pool: pooled,
            oracle_id: oracle,
            finishes: token.finishes,
            row: TheoryDiffRow {
                card_id: token.card_id,
                name: token.name,
                category_name: TOKEN_CATEGORY.to_owned(),
                quantity: 0,
                unit_price: token.unit_price,
                set_code: token.set_code.unwrap_or_default(),
                collector_number: token.collector_number.unwrap_or_default(),
                finish,
                owned_spare: 0,
                held_as_other_printing: 0,
                is_token: true,
            },
        });
    }
    for token in crate::deck_tokens::deck_token_rows(conn, deck_id, LIVE, marketplace)? {
        let pooled = pool_of(&token);
        let finish = regular_as_none(token.finish);
        let key = group_key(&token.card_id, finish.as_deref());
        tally.hold(key, pooled.as_deref(), token.quantity);
    }
    tally.settle(conn)
}

/// What [`token_diff`] counts a live token as "another printing of" — the grain
/// [`TheoryDiffRow::held_as_other_printing`] is paid out at for token rows.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TokenPool {
    /// The same oracle card — a card row's grain, and the Compare dialog's reading.
    Oracle,
    /// The same **name**, whatever the printing, the finish or the oracle card (issue #675): a
    /// managed wishlist following **Missing** asks whether the deck holds *a* Treasure, not that
    /// Treasure. Wider than the oracle card on purpose — two Soldier tokens with different stats
    /// are two oracle cards and, to a reader asking "do I have Soldiers", one answer.
    Name,
}

/// A token entry's finish as a deck row spells it: `nonfoil` — [`crate::schema::FINISHES`]`[0]`
/// — is the regular copy and reads `None`, the other two pass through.
fn regular_as_none(finish: String) -> Option<String> {
    (finish != crate::schema::FINISHES[0]).then_some(finish)
}

/// The `preferred_finish` a wish for this line files.
///
/// **A card row's is the finish the deck row plays** ([`played_finish`]: as stored, or the only
/// finish a printing is sold in), the regular copy pinning none — [`missing_to_wishlist`]'s rule,
/// so the wish lands on the same wishlist grain as every other wish the app makes for that card. **A token row's is spelled out, `nonfoil` included**: an
/// entry always names its finish (`deck_token_printings.finish` is `NOT NULL`), so the plan asked
/// for that finish of that printing, and a wish naming none is one a foil copy fills.
fn wish_finish(row: &TheoryDiffRow) -> Option<String> {
    if row.is_token {
        Some(
            row.finish
                .clone()
                .unwrap_or_else(|| crate::schema::FINISHES[0].to_owned()),
        )
    } else {
        row.finish.clone()
    }
}

/// Every live pile of a deck, in the order the Actual tab draws them — what the theory switch
/// clones, empty piles included.
fn live_piles(tx: &Connection, deck_id: i64) -> Result<Vec<i64>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT id FROM deck_categories WHERE deck_id = ?1 AND variant = ?2
              ORDER BY sort_order, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![deck_id, LIVE], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// **Move** the live list into the theory one: the same rows, re-labelled, leaving `live`
/// empty.
///
/// **Every live pile is cloned into the plan and each card is filed into its clone** (user
/// schema v53, issue #561) — [`crate::deck_meta::counterpart_in`], so a plan pile of the same name
/// (or, for a predefined zone, the same kind) is used where one exists and made otherwise, as a
/// copy of the live one. The live piles **stay**, empty: the Actual list keeps the structure the
/// reader built, and from this press on the two lists' piles are independent — renaming one, or
/// switching a Sideboard off, touches one tab. Empty live piles are cloned too, because the
/// columns the reader made are part of the deck they built and the plan is that deck. The piles
/// this makes are undone by the caller's step (`deck_undo::push_made_categories`).
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
/// Answers the number of **rows** moved, which is what `execute` counts — lines, not cards. A
/// row is a line and a copy is a card, and this app counts decks in cards everywhere else, so the
/// number is not one to put in front of a reader as it stands.
pub(crate) fn move_live_into_theory(tx: &Connection, deck_id: i64) -> Result<usize, String> {
    let mut moved = 0;
    for pile in live_piles(tx, deck_id)? {
        let plan_pile = crate::deck_meta::counterpart_in(tx, deck_id, THEORY, pile)?;
        moved += tx
            .execute(
                "UPDATE deck_cards SET variant = ?2, category_id = ?4, updated_at = unixepoch()
                  WHERE deck_id = ?1 AND variant = ?3 AND category_id = ?5",
                params![deck_id, THEORY, LIVE, plan_pile, pile],
            )
            .map_err(|e| e.to_string())?;
    }
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
/// **`folder_id` says where the wishes land, and `None` is the root** (2026-09-09,
/// [issue #437](https://github.com/Msgaihede/mtg-grimoire/issues/437)). The root is where every
/// wish this command ever wrote went — spec §1 accepted it, and the dialog had no folder to
/// offer — and it is still where a press that names nothing puts them, so every caller written
/// before the folder existed means exactly what it always meant. The id goes straight into
/// [`crate::wishlist::WishInput::folder_id`]: one field on the struct the write path already
/// owns, rather than a second way into the table.
///
/// **A named folder makes a *second* wish rather than moving the first**, which is
/// [`WISHLIST_GRAIN`](crate::schema::WISHLIST_GRAIN)'s fourth term — `coalesce(folder_id, 0)` —
/// doing the one job it was widened to do. The folder is part of the conflict target, so a card
/// the reader filed into *Ordered* last week and the same card sent to the root today are two
/// rows, and the `DO UPDATE` clause touches neither one's folder. Without that term this press
/// would land on the row they had already filed and raise its quantity: the wish would appear to
/// **move**, as a side effect of shopping, where moving a wish between folders is its own
/// explicit act ([`crate::wishlist_folders::set_wish_folder`]).
///
/// **The folder is looked up once, up front, and [`crate::wishlist::add_wish_silent`]'s own
/// check is not a substitute for it.** That one runs per row — and a plan that is short of nothing writes
/// no rows at all, so a reader who picked a folder another window had just deleted would be told
/// the press touched **0 wishes** by a command that never got far enough to notice. "There was
/// nothing to buy" and "that folder is not there any more" are different answers, and only one
/// of them would have been true.
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
/// the reader is going out to find — and so does the finish an unsaid row of a foil-only printing
/// plays, which is `foil` ([`played_finish`], issue #563) rather than a regular copy nobody sells.
///
/// A pinned wish and an any-printing one are **different rows** on that grain, so a reader who
/// pressed this before the change keeps their old any-printing line and gains a pinned one.
/// Nothing is lost and nothing is double-counted: each folds into its own row on the upsert.
///
/// **A token line is sent like a card line** (the token-improvements spec §3.7): addressed by the
/// same [`group_key`], it files one wish pinned to the token's printing, its oracle card and its
/// name — with one difference, [`wish_finish`]'s: its finish is spelled out, `nonfoil` included,
/// because a token entry always names the finish the plan asked for.
///
/// **It records one [`crate::activity`] line for the whole press**, through
/// [`crate::wishlist::add_wish_silent`] and [`crate::wishlist::record_wishes_added`], and only
/// where a wish was actually written — [`crate::deck::missing_to_wishlist`]'s paragraph, and the
/// same bug closed on the same day in both files: the loop below went through
/// [`crate::wishlist::add_wish`], so a plan short of forty cards wrote forty feed lines.
///
/// An orphaned row is skipped, [`crate::deck::missing_to_wishlist`]'s rule — and that guard is
/// now doing double duty, which is the non-obvious part. A wish needs an oracle card and an
/// orphan has none; *and* an orphan is exactly a row whose printing has left `cards`, while
/// [`crate::wishlist::add_wish`] **refuses** a `card_id` it cannot find there ("no card with that
/// id is in the card database"). From inside this transaction that refusal would abort the whole
/// press rather than skip one line. It is already carrying a `needs_review` sentence.
///
/// # A virtual deck is refused, and it is the only entry point in this module that is
///
/// [`crate::deck::VIRTUAL_HOLDS_NOTHING`] (issue #401). A virtual deck tracks a deck the reader
/// owns no cardboard for, so it has no shopping list — the wishlist is a record of cardboard to
/// go out and buy, and there is none to buy for a deck that is played on a screen or in proxies.
/// **This is the module's one write that leaves it**, which is what makes it the module's one
/// refusal: [`theory_slots`] and [`theory_diff`] are the plan-vs-live comparison, a thing a
/// virtual deck does not have at all (its `theory_enabled` is 0), so they are already unreachable
/// for one and a fence there would be a rule kept in step for a case that cannot arise. The
/// fence is on the press that reaches another table, exactly where
/// [`crate::collection_alloc::THEORY_HOLDS_NOTHING`] sits for the same kind of reason one table
/// over.
pub fn missing_to_wishlist(
    conn: &Connection,
    deck_id: i64,
    only: Option<&[String]>,
    folder_id: Option<i64>,
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
    // Behind the existence check and ahead of the diff: "that deck is gone" and "that deck keeps
    // no cardboard" are different things to be told, and a deck the reader owns nothing for has
    // nothing to put on a shopping list. Nothing below this line writes to `wishlist_entries`
    // for a deck that answers yes.
    if crate::deck::is_virtual(&tx, deck_id)? {
        return Err(crate::deck::VIRTUAL_HOLDS_NOTHING.to_owned());
    }
    // Behind both of those and still ahead of the diff, because it is a **third** thing to be
    // told: "that deck is gone", "that deck keeps no cardboard" and "that folder is not there
    // any more" are three different mistakes and each is owed its own sentence.
    // [`crate::wishlist::add_wish_silent`] fences this column too, but per row — and a plan
    // short of nothing reaches that door not once, so without this line a reader who named a
    // folder another window had just deleted would be told the press touched 0 wishes and never
    // that their folder had gone. Inside the transaction, unlike the deck kind above: this reads a
    // table the loop below is about to write against, and the answer has to be the one that
    // write will see.
    if let Some(id) = folder_id {
        crate::wishlist_folders::require_folder(&tx, id)?;
    }
    let mut touched = 0;
    let mut copies = 0i64;
    // The default marketplace, for [`crate::deck::missing_to_wishlist`]'s reason: this reads
    // names and counts, never a price, and a shopping list must not depend on where the reader
    // shops. **The token rows ride with the card rows**, [`theory_diff`]'s whole answer, so a key
    // the dialog sends for a token line finds that line here.
    let market = crate::sorting::Marketplace::default();
    let mut lines = grouped_diff(&tx, deck_id, market)?;
    lines.extend(token_diff(&tx, deck_id, market, TokenPool::Oracle)?);
    for grouped in lines {
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
        let wanted = grouped.row.quantity;
        let preferred_finish = wish_finish(&grouped.row);
        // **The quiet door**, [`crate::deck::missing_to_wishlist`]'s rule and for its reason: this
        // loop wrote one feed line per planned card until 2026-09-10, so a plan short of forty
        // cards buried the feed under one press. The run is recorded once, below.
        crate::wishlist::add_wish_silent(
            &tx,
            &crate::wishlist::WishInput {
                oracle_id: Some(oracle_id),
                // The printing the plan named, and the object it named — the whole of the
                // 2026-08-22 change, argued above.
                card_id: Some(grouped.row.card_id.clone()),
                // The deck row's own name, which is the one name an orphan-safe row always has
                // and the same name the list would show for it — a token's own, for a token line.
                name: Some(grouped.row.name),
                quantity: wanted,
                // A card row's finish as played, a token row's spelled out — [`wish_finish`].
                preferred_finish,
                // Where the reader pointed, straight through — and the root when they pointed
                // nowhere, which is what this field's absence meant on every press before
                // 2026-09-09. It is a grain term, so naming a folder adds a wish rather than
                // moving one; the argument is in this function's doc.
                folder_id,
                ..Default::default()
            },
        )?;
        touched += 1;
        // `max(1)` is [`crate::wishlist::add_wish`]'s own normalisation restated, and it is not
        // theoretical here: [`TheoryDiffRow::quantity`] is *wanted minus held* and
        // `missing_to_wishlist_does_not_count_the_live_list_twice` is written around the arm
        // where that arithmetic goes non-positive. The line's count has to be what landed.
        copies += wanted.max(1);
    }
    // **One line for the press**, and only where something was actually added — a plan short of
    // nothing has changed neither list, and `Added 0 cards to your wishlist` is a press the
    // reader never made. [`crate::deck::missing_to_wishlist`]'s closing lines, verbatim.
    if touched > 0 {
        crate::wishlist::record_wishes_added(&tx, touched as i64, copies, folder_id)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(touched)
}

/// One line of a deck's **managed wishlist** — what [`missing_to_wishlist`] would write for it,
/// minus the folder and the feed line. See [`crate::managed_wishlist`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Wanted {
    pub oracle_id: String,
    pub card_id: String,
    pub name: String,
    /// The wish's `preferred_finish` — [`wish_finish`], [`missing_to_wishlist`]'s rule: a card
    /// row's is the finish the deck row plays ([`played_finish`]), NULL for the regular copy, and
    /// a token row's is spelled out.
    pub finish: Option<String>,
    pub quantity: i64,
    /// Whether this is a token line — which of the managed wishlist's two folders it is filed in:
    /// the deck's own, or its **Tokens** child ([`crate::managed_wishlist`]).
    pub is_token: bool,
}

/// Which of the Compare dialog's card views a managed wishlist follows — `TheoryDiffDialog.tsx`'s
/// `DiffView`, in Rust, less its **Tokens** tab.
///
/// **Card rows only since user schema v57** (issue #617). Until then this enum had a fourth
/// variant, `Tokens`, and All counted token rows too, so whether a managed wishlist wanted tokens
/// was a fact about the view. It is a switch of its own now, `decks.managed_wishlist_tokens`,
/// and [`wanted`] takes it beside the view. The dialog's Tokens tab is unchanged: it still asks
/// which tokens the plan is short of, which is the question the switch answers into a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiffView {
    /// Every card row, at its whole quantity.
    All,
    /// The copies no printing in the deck covers: `quantity − held_as_other_printing`, the
    /// dialog's `quantity > heldAsOtherPrinting`.
    Missing,
    /// The copies the deck plays as a different printing: `held_as_other_printing`, the dialog's
    /// `heldAsOtherPrinting > 0` — the cardboard to swap for the printing the plan names.
    Other,
}

/// One Compare view of the plan against the live list, as wishes pinned to the printing and
/// finish the plan names — what [`crate::managed_wishlist`] files.
///
/// **Each view's quantity is that view's own, not the row's** (the reader's correction to
/// issue #512: a managed wishlist following `Missing` was listing `All`). The dialog filters rows
/// and still shows each row's whole count; a wishlist line is a count of cardboard to go and get,
/// so it carries only the copies the view is about, and a line with none is dropped.
///
/// **`tokens` adds the token rows under whichever view the cards follow** (user schema v57, issue
/// #617), and **the view decides how a token is compared** (issue #675):
///
/// - **Missing compares the name only.** A token row wants `quantity − held_as_other_printing`
///   out of a pool keyed on the token's name ([`TokenPool::Name`]), so a deck that holds three
///   Treasures of any printing, finish or art wants no fourth for a plan of three — the question
///   Missing asks of a card, asked one grain wider, because a token's printing is its art and
///   nothing else.
/// - **All and Different printing compare the exact printing and finish**: a token row wants its
///   whole shortfall of that printing in that finish, which is what the Compare dialog's Tokens
///   view lists. Different printing's card reading — copies played as another printing — has no
///   token counterpart worth filing: a reader who pinned a token's art wants that art.
///
/// `false` reads no token wall at all.
///
/// Reads [`grouped_diff`] and [`token_diff`] rather than a query of its own, so the folder and
/// the dialog beside it cannot come to disagree about which rows a view holds — and reads the
/// token wall only when it is asked for, because this runs after every write that touches a deck
/// with a managed wishlist, and a token wall is a derivation over the deck's cards.
pub(crate) fn wanted(
    conn: &Connection,
    deck_id: i64,
    view: DiffView,
    tokens: bool,
) -> Result<Vec<Wanted>, String> {
    let market = crate::sorting::Marketplace::default();
    let mut lines = grouped_diff(conn, deck_id, market)?;
    if tokens {
        let pool = match view {
            DiffView::Missing => TokenPool::Name,
            DiffView::All | DiffView::Other => TokenPool::Oracle,
        };
        lines.extend(token_diff(conn, deck_id, market, pool)?);
    }
    Ok(lines
        .into_iter()
        .filter_map(|g| {
            let finish = wish_finish(&g.row);
            let oracle_id = g.oracle_id?;
            let held = g.row.held_as_other_printing;
            let quantity = match view {
                // A token's `held` is paid out of its name's pool here — see above.
                DiffView::Missing => g.row.quantity - held,
                _ if g.row.is_token => g.row.quantity,
                DiffView::All => g.row.quantity,
                DiffView::Other => held,
            };
            (quantity > 0).then_some(Wanted {
                oracle_id,
                card_id: g.row.card_id,
                name: g.row.name,
                finish,
                quantity,
                is_token: g.row.is_token,
            })
        })
        .collect())
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
/// five columns, a LEFT JOIN to `cards` for the name and the printing's finishes, and no
/// marketplace. The join arrived with the loose tier on 2026-09-07 (the finishes rode it on
/// 2026-09-27, for [`played_finish`]) and is a primary-key lookup per group; what the founding
/// argument was really against is still absent — this does not price a row, does not roll up what
/// the group holds, and does not become a second `deck_get`. `DeckEditor.test.tsx` pins the first
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
/// out of them, and would be a silently halved quantity now. `GROUP BY dc.card_id, dc.finish` does
/// most of it — SQLite groups two NULL finishes together, which is the regular copy — so the same
/// card filed as Ramp and as Main deck is still **one** planned card, with both piles counted
/// rather than one key printed twice. It is no longer the whole of [`group_key`]'s grain, which is
/// what the next paragraph is about.
///
/// **The SQL groups on the stored finish and Rust finishes the fold on the played one** (issue
/// #563). A foil-only printing the plan holds once unsaid and once as `foil` is two SQL groups and
/// one [`group_key`] — [`played_finish`] is what makes them one — so the second is summed into the
/// first rather than pushed beside it, for the halved-plan reason above. The printing's finishes
/// ride the group as a bare column, which SQLite allows and which is one value per `card_id`.
///
/// Still a `Vec` rather than a map: a JSON array is what crosses the IPC boundary anyway, and the
/// caller builds the lookup it wants.
pub fn theory_slots(conn: &Connection, deck_id: i64) -> Result<Vec<TheorySlot>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT dc.card_id, dc.finish, SUM(dc.quantity), c.name, c.finishes
               FROM deck_cards dc
               JOIN deck_categories cat ON cat.id = dc.category_id
               LEFT JOIN cards c ON c.id = dc.card_id
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
                r.get::<_, Option<String>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut slots: Vec<TheorySlot> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for row in rows {
        let (card_id, finish, quantity, name, finishes) = row.map_err(|e| e.to_string())?;
        let key = group_key(
            &card_id,
            played_finish(finish, finishes.as_deref()).as_deref(),
        );
        if let Some(&i) = at.get(&key) {
            slots[i].quantity += quantity;
            continue;
        }
        at.insert(key.clone(), slots.len());
        slots.push(TheorySlot {
            key,
            name_key: name,
            quantity,
        });
    }
    Ok(slots)
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

    /// The **live** list's pile of this name, found or made. A case hands it to [`add`] for
    /// either list and [`in_list`] carries it across — the lists keep separate piles since user
    /// schema v53 (issue #561), and one name per case reads better than two ids.
    fn category(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, LIVE, name).unwrap()
    }

    /// The **theory** list's pile of this name, found or made — for the cases that write to the
    /// plan's pile itself rather than filing a card into it, such as switching it off.
    fn theory_category(conn: &Connection, deck_id: i64, name: &str) -> i64 {
        crate::deck_meta::category_for_name(conn, deck_id, THEORY, name).unwrap()
    }

    /// The pile of `variant` standing for `cat` — `cat` itself when it is already that list's,
    /// else the other list's pile of the same name (or kind), made there if it is missing. Every
    /// card write refuses a pile of the other list (`deck_meta::CATEGORY_WRONG_LIST`), so a
    /// theory write goes through this.
    fn in_list(conn: &Connection, deck_id: i64, variant: &str, cat: i64) -> i64 {
        crate::deck_meta::counterpart_in(conn, deck_id, variant, cat).unwrap()
    }

    fn add(conn: &Connection, deck_id: i64, card: &str, cat: i64, variant: &str, quantity: i64) {
        add_finish(conn, deck_id, card, cat, variant, None, quantity);
    }

    /// The same add, naming the object played — `None` is the regular copy, which
    /// `deck::normalise_finish` stores as NULL. `cat` is carried into the list being written by
    /// [`in_list`], so a case may name the live pile for a theory add.
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
            Some(in_list(conn, deck_id, variant, cat)),
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
        let plan_removal = in_list(&conn, id, THEORY, removal);
        crate::deck::set_card_quantity(&conn, id, "bolt-lea", plan_removal, THEORY, None, 2)
            .unwrap();
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

    /// A printing Scryfall sells **only** in foil — issue #563's Palantír of Orthanc, HOC 85, a
    /// Surge Foil — added to `cards` beside the fixture's three.
    fn foil_only(conn: &Connection) {
        conn.execute(
            r#"INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    rarity,mana_cost,cmc,type_line,prices,finishes,raw)
               VALUES ('palantir-hoc','o3','Palantír of Orthanc','hoc','85','en','normal',
                       'mythic','{3}',3.0,'Legendary Artifact','{"usd_foil":"12.00"}',
                       '["foil"]','{}')"#,
            [],
        )
        .unwrap();
    }

    /// **[Issue #563](https://github.com/Msgaihede/mtg-grimoire/issues/563): a foil-only printing
    /// is one card whichever list left its finish unsaid.** `deck_cards.finish` is NULL where a
    /// write named no finish, and for a printing sold only in foil that NULL can only be the foil
    /// — the deck's own views draw it with the foil mark (`playedFinish`). Keyed on the raw
    /// column, the plan's `palantir-hoc|` and the live list's `palantir-hoc|foil` were two
    /// cards, so the one the reader had in both lists was on the Compare dialog, on the wishlist
    /// press and in the managed wishlist folder all at once.
    ///
    /// Both directions, because either list can be the one that said nothing: an add from the
    /// search names no finish, and an add out of the binder carries the copy's own `foil`.
    #[test]
    fn a_foil_only_printing_is_one_card_whichever_list_left_its_finish_unsaid() {
        let conn = seeded();
        foil_only(&conn);
        for (plan, deck_has) in [(None, Some("foil")), (Some("foil"), None)] {
            let id = deck(&conn, &format!("Palantír {plan:?}"));
            let main = category(&conn, id, "Main deck");
            add_finish(&conn, id, "palantir-hoc", main, THEORY, plan, 1);
            add_finish(&conn, id, "palantir-hoc", main, LIVE, deck_has, 1);

            let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
            assert!(
                diff.is_empty(),
                "plan {plan:?} against {deck_has:?}: {diff:?}"
            );
            assert!(
                wanted(&conn, id, DiffView::All, true).unwrap().is_empty(),
                "the managed wishlist follows the diff"
            );
            assert_eq!(
                missing_to_wishlist(&conn, id, None, None).unwrap(),
                0,
                "and the press finds nothing to buy"
            );
            assert_eq!(
                theory_slots(&conn, id)
                    .unwrap()
                    .into_iter()
                    .map(|s| (s.key, s.quantity))
                    .collect::<Vec<_>>(),
                vec![("palantir-hoc|foil".to_owned(), 1)],
                "the slot spells the foil, which is what `theoryMatch.ts` looks the live row up by"
            );
        }
        assert!(wishes(&conn).is_empty(), "{:?}", wishes(&conn));
    }

    /// The same rule inside **one** list: a plan holding the foil-only printing once unsaid and
    /// once as `foil` is asking for two of one card, so it is one slot and one line — pinned to
    /// the foil, and counting the foil copies the binder holds as spare. The spare figure read `0`
    /// for the unsaid half before, because its NULL bound through to `nonfoil`.
    #[test]
    fn a_foil_only_printing_unsaid_and_foil_in_one_plan_is_one_line() {
        let conn = seeded();
        foil_only(&conn);
        own_finish(&conn, "palantir-hoc", "foil", 1);
        let id = deck(&conn, "Palantír");
        let main = category(&conn, id, "Main deck");
        let ramp = category(&conn, id, "Ramp");
        add_finish(&conn, id, "palantir-hoc", main, THEORY, None, 1);
        add_finish(&conn, id, "palantir-hoc", ramp, THEORY, Some("foil"), 1);

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!(
            diff.iter()
                .map(|r| (r.finish.as_deref(), r.quantity, r.owned_spare, r.unit_price))
                .collect::<Vec<_>>(),
            vec![(Some("foil"), 2, 1, Some(12.0))],
            "{diff:?}"
        );
        assert_eq!(
            theory_slots(&conn, id)
                .unwrap()
                .into_iter()
                .map(|s| (s.key, s.quantity))
                .collect::<Vec<_>>(),
            vec![("palantir-hoc|foil".to_owned(), 2)]
        );
    }

    /// **A `nonfoil` binder copy of a foil-only printing is the foil too**, on this side of the
    /// comparison as on the deck's: the quick add, *Add missing to collection*, an import that
    /// named no finish and the scanner all wrote that word for a card that has no such copy.
    /// `crate::deck::entry_finish` reads both tables the same way, so the spare figure counts it.
    #[test]
    fn a_legacy_nonfoil_copy_of_a_foil_only_printing_counts_as_spare() {
        let conn = seeded();
        foil_only(&conn);
        own_finish(&conn, "palantir-hoc", "nonfoil", 1);
        let id = deck(&conn, "Palantír");
        let main = category(&conn, id, "Main deck");
        add_finish(&conn, id, "palantir-hoc", main, THEORY, None, 1);

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!(
            diff.iter()
                .map(|r| (r.finish.as_deref(), r.owned_spare))
                .collect::<Vec<_>>(),
            vec![(Some("foil"), 1)],
            "{diff:?}"
        );
    }

    /// The press the Compare dialog makes, for issue #563's card. Its `only` keys are built off the
    /// diff rows, whose finish is the played one, so the dialog ticks `palantir-hoc|foil`, and that
    /// is the spelling the press has to find. The wish is pinned to the foil, the only finish the
    /// printing exists in. The pre-fix spelling `palantir-hoc|` names nothing now and writes nothing.
    #[test]
    fn the_press_finds_a_foil_only_line_by_its_played_key() {
        let conn = seeded();
        foil_only(&conn);
        let id = deck(&conn, "Palantír");
        let main = category(&conn, id, "Main deck");
        add_finish(&conn, id, "palantir-hoc", main, THEORY, None, 2);
        add_finish(&conn, id, "palantir-hoc", main, LIVE, Some("foil"), 1);

        let stale = ["palantir-hoc|".to_owned()];
        assert_eq!(
            missing_to_wishlist(&conn, id, Some(&stale), None).unwrap(),
            0
        );

        let ticked = ["palantir-hoc|foil".to_owned()];
        assert_eq!(
            missing_to_wishlist(&conn, id, Some(&ticked), None).unwrap(),
            1
        );
        assert_eq!(
            pinned_wishes(&conn),
            vec![(
                "o3".to_owned(),
                "palantir-hoc".to_owned(),
                Some("foil".to_owned()),
                1
            )],
            "one copy short, wished for as the foil"
        );
    }

    /// **Only a printing with no choice is folded.** One sold in both finishes keeps the regular
    /// copy and the foil apart exactly as `the_diff_tells_a_foil_from_the_regular_copy` says —
    /// an unsaid row there is the regular copy, and the plan's foil is not answered by it.
    #[test]
    fn a_printing_sold_in_both_finishes_still_tells_them_apart() {
        let conn = seeded();
        conn.execute(
            r#"UPDATE cards SET finishes = '["nonfoil","foil"]' WHERE id = 'bolt-lea'"#,
            [],
        )
        .unwrap();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add_finish(&conn, id, "bolt-lea", main, THEORY, Some("foil"), 1);
        add_finish(&conn, id, "bolt-lea", main, LIVE, None, 1);

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();
        assert_eq!(
            diff.iter()
                .map(|r| (r.finish.as_deref(), r.quantity))
                .collect::<Vec<_>>(),
            vec![(Some("foil"), 1)],
            "{diff:?}"
        );
        assert_eq!(
            theory_slots(&conn, id).unwrap()[0].key,
            "bolt-lea|foil",
            "and the regular copy in the live list keeps its own key, `bolt-lea|`"
        );
    }

    /// An inactive category counts toward nothing — on **both** sides. A card parked in the
    /// theory Maybeboard is not a decision the user made, and one parked in the live
    /// Maybeboard is not a card the deck has. Each list has its own Maybeboard since user schema
    /// v53, and the plan's is made by [`add`] as a copy of the live one — switched off with it.
    #[test]
    fn the_diff_reads_neither_sides_inactive_categories() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let maybe: i64 = conn
            .query_row(
                "SELECT id FROM deck_categories
                  WHERE deck_id = ?1 AND variant = 'live' AND kind = 'maybe'",
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

    /// Set a folder aside, straight into the column — `collection_folders::set_folder_locked` is
    /// the reader's press and that module's to test, where this one wants a folder that **is**
    /// locked. The affected count is asserted because an `UPDATE` naming an id that is not there
    /// succeeds and changes nothing, which would make every figure below it a statement about an
    /// unlocked folder.
    fn set_locked(conn: &Connection, id: i64, locked: bool) {
        assert_eq!(
            conn.execute(
                "UPDATE collection_folders SET locked = ?2 WHERE id = ?1",
                params![id, i64::from(locked)],
            )
            .unwrap(),
            1,
            "the folder the test means to set aside is there"
        );
    }

    /// **A locked folder's copies are not spare.** [`a_copy_in_a_deck_group_is_not_spare`] one
    /// folder over, and the same sentence: `owned_spare` means the copies this plan can count
    /// on, and a card in a display case or held for a trade is not one of them — a shopping list
    /// that quietly spends a set-aside drawer is offering the reader cardboard they have already
    /// promised somewhere else.
    ///
    /// **The unlock at the end is what makes this about the lock rather than about the folder.**
    /// A binder is already spare — that is the test directly above — so the *same* folder
    /// answering 2, then 0, and then every copy again across two writes to one column is the
    /// whole of the evidence, and no part of it can be read as the copies having moved.
    ///
    /// **The subfolder is the half a `locked <> 0` lookup would get wrong** while passing every
    /// other assertion here: the shelf carries no flag of its own and is set aside only because
    /// its parent is, which is what the recursive CTE exists for.
    ///
    /// **And the copy bought afterwards is the half the missing `IS NULL` arm would get wrong**,
    /// which is the one case the tests above cannot reach: `a_copy_in_a_deck_group_is_not_spare`
    /// counts a root copy while nothing is locked at all, and `x NOT IN (<empty>)` is *true* even
    /// for a NULL `x` — so the arm only starts carrying weight once a locked folder exists, and
    /// only a root row alongside one can show it. Without it the root drops out of the very
    /// figure that is mostly root, and every other assertion here still passes.
    #[test]
    fn a_locked_folders_copies_are_not_spare() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let entry = own(&conn, "bolt-lea", 2);
        add(&conn, id, "bolt-lea", main, THEORY, 4);

        let case = binder(&conn, "Display case");
        let shelf = crate::collection_folders::create_folder(&conn, Some(case), "Top shelf")
            .unwrap()
            .id;
        file_into(&conn, entry, Some(case));
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            2,
            "an unlocked folder is a binder, and a binder's copies are spare"
        );

        set_locked(&conn, case, true);
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            0,
            "a drawer the reader set aside holds no copies this plan can count on"
        );

        // A copy bought afterwards lands at the root, which is not a folder to look up: the
        // `IS NULL` arm is what keeps it counted now that a locked folder exists at all.
        own(&conn, "bolt-lea", 1);
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            1,
            "the new copy is at the root and spare; only the set-aside ones are not"
        );

        file_into(&conn, entry, Some(shelf));
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            1,
            "and the lock inherits, so the shelf inside the drawer is set aside too"
        );

        set_locked(&conn, case, false);
        assert_eq!(
            theory_diff(&conn, id, ANY_MARKET).unwrap()[0].owned_spare,
            3,
            "one column write on the parent hands the shelf's two back — nothing moved"
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

        let touched = missing_to_wishlist(&conn, id, None, None).unwrap();

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

        let touched = missing_to_wishlist(&conn, id, None, None).unwrap();

        assert_eq!(touched, 2, "the Bolt is a wish, not a skipped negative");
        assert_eq!(
            wishes(&conn),
            vec![(Some("o1".to_owned()), 1), (Some("o2".to_owned()), 4)],
            "and the Angel asks for four, not for four less what is in the box"
        );
    }

    /// Every wish there is as `(oracle card, pinned printing, pinned finish, copies)` — three
    /// of [`WISHLIST_GRAIN`](crate::schema::WISHLIST_GRAIN)'s **four** columns and the count.
    /// The fourth is `folder_id`, added at schema v23, and it is left out because every case
    /// that reads this helper passes `folder_id: None` — **not** because the command has no
    /// choice, which is what this said until 2026-09-09 and what the Compare dialog learning to
    /// name a folder made false. The term really is NULL on every row these cases write, so
    /// asserting it here would be asserting the same constant over and over; the cases that are
    /// *about* the folder read [`filed_wishes`] instead. The first two are read as `String` on
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

        assert_eq!(missing_to_wishlist(&conn, id, None, None).unwrap(), 2);

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
        assert_eq!(
            missing_to_wishlist(&conn, id, Some(&only), None).unwrap(),
            1
        );

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
        assert_eq!(
            missing_to_wishlist(&conn, id, Some(&unknown), None).unwrap(),
            0
        );
        assert_eq!(pinned_wishes(&conn).len(), 1, "nothing written, no refusal");
    }

    // ---------------------------------------------------------------------------------------
    // The destination. Until 2026-09-09 this press had none — every wish it wrote landed at the
    // wishlist's root, and the Compare dialog had no folder to offer
    // ([issue #437](https://github.com/Msgaihede/mtg-grimoire/issues/437)). What the cases below
    // are really about is `WISHLIST_GRAIN`'s **fourth** term: a destination is only a safe thing
    // to offer because `coalesce(folder_id, 0)` is in the conflict target, so naming one adds a
    // wish instead of quietly moving the one the reader filed last week.
    // ---------------------------------------------------------------------------------------

    /// One folder at the root of the **wishlist's** tree. Named apart from [`binder`] on
    /// purpose: this file already makes `collection_folders` rows, and the two cabinets are
    /// different furniture that would read alike at a glance under one name.
    fn wish_folder(conn: &Connection, name: &str) -> i64 {
        crate::wishlist_folders::create_folder(conn, None, name)
            .unwrap()
            .id
    }

    /// Every wish as `(pinned printing, folder, copies)` in write order — [`pinned_wishes`]
    /// with [`WISHLIST_GRAIN`](crate::schema::WISHLIST_GRAIN)'s **fourth** column in place of
    /// the oracle id and the finish, for the cases that are about where a wish was filed. The
    /// folder is read as an `Option<i64>`, so the root is a `None` rather than a magic number
    /// and a row that quietly acquired a folder fails the comparison instead of passing a count.
    fn filed_wishes(conn: &Connection) -> Vec<(String, Option<i64>, i64)> {
        conn.prepare(
            "SELECT card_id, folder_id, quantity
               FROM wishlist_entries ORDER BY id",
        )
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap()
    }

    /// **The wishes land in the folder the press named**, which is the whole of what picking
    /// one in the dialog does: the id rides on every [`crate::wishlist::WishInput`] the loop
    /// builds. Two cards short rather than one, so that a build which carried the folder on the
    /// first wish and lost it afterwards has somewhere to fail.
    #[test]
    fn missing_to_wishlist_files_the_wishes_in_the_folder_it_was_given() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let ordered = wish_folder(&conn, "Ordered");
        add(&conn, id, "bolt-lea", main, THEORY, 3);
        add(&conn, id, "serra-lea", main, THEORY, 1);

        assert_eq!(
            missing_to_wishlist(&conn, id, None, Some(ordered)).unwrap(),
            2
        );

        assert_eq!(
            filed_wishes(&conn),
            vec![
                ("bolt-lea".to_owned(), Some(ordered), 3),
                ("serra-lea".to_owned(), Some(ordered), 1),
            ],
            "both wishes are in the folder the reader pointed at, and neither is at the root"
        );
    }

    /// **A press that names no folder still files at the root**, which is where every wish this
    /// command wrote before the argument existed went, and what every caller that has not been
    /// taught about it still means.
    ///
    /// **The folder in the fixture is made and deliberately not named.** A database with no
    /// folders in it could not tell "the reader chose the root" from "there was nowhere else a
    /// wish could have gone", and it is the first of those two this case is pinning.
    #[test]
    fn missing_to_wishlist_still_files_at_the_root_when_no_folder_is_named() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        wish_folder(&conn, "Ordered");
        add(&conn, id, "bolt-lea", main, THEORY, 3);

        assert_eq!(missing_to_wishlist(&conn, id, None, None).unwrap(), 1);

        assert_eq!(
            filed_wishes(&conn),
            vec![("bolt-lea".to_owned(), None, 3)],
            "the root, exactly as it was before this command could be told anything else"
        );
    }

    /* ---------------------------------------------------------------------------------- *
     * What the press says in the activity feed. **One line, whatever it bought.**
     * ---------------------------------------------------------------------------------- */

    /// The wishlist lines in the feed, newest first.
    ///
    /// Filtered, because [`crate::activity::recent`] is a `UNION ALL` over `deck_audit` and every
    /// press that builds a fixture here writes a deck row — and `own` writes a *collection* one.
    /// An unfiltered `len()` would be counting the fixture.
    fn wishlist_feed(conn: &Connection) -> Vec<crate::activity::ActivityEntry> {
        crate::activity::recent(conn, crate::activity::MAX_LIMIT)
            .unwrap()
            .into_iter()
            .filter(|r| r.scope == crate::activity::WISHLIST)
            .collect()
    }

    /// **A plan short of two cards writes one feed line, not two.**
    ///
    /// This press records no `deck_audit` row — nothing about the deck changed — so there was
    /// nothing to suppress against and the loop wrote one `activity` row per planned card until
    /// 2026-09-10, burying the feed the reader had just pressed the button to check.
    ///
    /// **The two shortfalls are deliberately unequal**, because `rows` and `cards` are different
    /// units and a fixture where they coincide cannot tell them apart: two planned cards short by
    /// three copies and one is `rows: 2` against `cards: 4`.
    #[test]
    fn missing_to_wishlist_records_one_activity_row_for_the_whole_press() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, THEORY, 3);
        add(&conn, id, "serra-lea", main, THEORY, 1);

        let touched = missing_to_wishlist(&conn, id, None, None).unwrap();

        assert_eq!(touched, 2, "two planned cards are short");
        let rows = wishlist_feed(&conn);
        assert_eq!(rows.len(), 1, "and the press is one line, not two");
        assert_eq!(
            rows[0].kind,
            crate::activity::ADD,
            "an `add`: the reader put cards on a list, they did not import a file"
        );
        assert_eq!(rows[0].card_name, None, "a run names no one card");
        assert_eq!(rows[0].delta, 4);
        let payload: serde_json::Value = serde_json::from_str(&rows[0].payload).unwrap();
        assert_eq!(payload["rows"], 2, "two wishes");
        assert_eq!(payload["cards"], 4, "four copies across them");
        assert_eq!(payload["folder"], serde_json::Value::Null);
    }

    /// The folder the run was filed into is the one clause the line borrows from a single add.
    #[test]
    fn the_press_names_the_folder_its_run_was_filed_into() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let ordered = wish_folder(&conn, "Ordered");
        add(&conn, id, "bolt-lea", main, THEORY, 3);

        missing_to_wishlist(&conn, id, None, Some(ordered)).unwrap();

        // The `add`, not the `folder` row `wish_folder` wrote making the drawer — both are
        // wishlist-scoped, and the run is the one this case is about.
        let run = wishlist_feed(&conn)
            .into_iter()
            .find(|r| r.kind == crate::activity::ADD)
            .expect("the run is in the feed");
        let payload: serde_json::Value = serde_json::from_str(&run.payload).unwrap();
        assert_eq!(payload["folder"], "Ordered");
    }

    /// **A plan short of nothing writes no line at all.**
    ///
    /// The other half of the rule: the press succeeds, answers `0`, and has changed neither list
    /// — so *Added 0 cards to your wishlist* would be a feed row for a press the reader never
    /// made. The comparison is against a plan that *is* short in the same database, so "no line"
    /// cannot be read as the feed answering nothing whatever.
    #[test]
    fn a_plan_short_of_nothing_writes_no_activity_row() {
        let conn = seeded();
        let settled = deck(&conn, "Settled");
        let settled_main = category(&conn, settled, "Main deck");
        add(&conn, settled, "serra-lea", settled_main, LIVE, 2);
        add(&conn, settled, "serra-lea", settled_main, THEORY, 2);

        assert_eq!(missing_to_wishlist(&conn, settled, None, None).unwrap(), 0);
        assert!(
            wishlist_feed(&conn).is_empty(),
            "a press that bought nothing says nothing"
        );

        // And the feed is not simply mute: a plan that really is short writes its one line.
        let short = deck(&conn, "Burn");
        add(
            &conn,
            short,
            "bolt-lea",
            category(&conn, short, "Main deck"),
            THEORY,
            3,
        );
        assert_eq!(missing_to_wishlist(&conn, short, None, None).unwrap(), 1);
        assert_eq!(wishlist_feed(&conn).len(), 1);
    }

    /// **The tick list and the folder compose, and neither reads the other**: `only` decides
    /// *which* rows are sent, `folder_id` decides *where they land*. Three cards short, one of
    /// them ticked, one folder named — so a build that dropped either argument writes a
    /// different row from the one asserted here and cannot pass on the other argument's
    /// strength.
    #[test]
    fn the_ticked_rows_and_the_named_folder_compose() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let ordered = wish_folder(&conn, "Ordered");
        add(&conn, id, "bolt-lea", main, THEORY, 1);
        add(&conn, id, "bolt-m10", main, THEORY, 1);
        add(&conn, id, "serra-lea", main, THEORY, 1);

        let only = vec![group_key("bolt-m10", None)];
        assert_eq!(
            missing_to_wishlist(&conn, id, Some(&only), Some(ordered)).unwrap(),
            1
        );

        assert_eq!(
            filed_wishes(&conn),
            vec![("bolt-m10".to_owned(), Some(ordered), 1)],
            "the one row the reader left ticked, in the one folder they pointed at"
        );
    }

    /// **A folder that is not there is refused by name, before anything is written** — and the
    /// second deck is the half only the up-front check can answer.
    ///
    /// [`crate::wishlist::add_wish_silent`] fences this column too, but **per row**, and a plan
    /// that is short of nothing never reaches it: without the lookup at the top of the
    /// transaction the
    /// reader would be told the press touched `0` wishes, with nothing anywhere to say that the
    /// folder they had picked was gone. "There was nothing to buy" and "that folder is not there
    /// any more" are different answers and only one of them would have been true.
    ///
    /// The folder is **made and then deleted** rather than invented as a stray id, because that
    /// is the situation the check is for: another window emptied the cabinet between the dialog
    /// opening and the button being pressed.
    #[test]
    fn a_folder_that_is_gone_is_refused_before_a_wish_is_written() {
        let conn = seeded();
        let short = deck(&conn, "Burn");
        let short_main = category(&conn, short, "Main deck");
        add(&conn, short, "bolt-lea", short_main, THEORY, 3);

        // A deck whose plan and live list agree card for card. The premise is asserted as the
        // press itself rather than as an empty diff, because what the case turns on is that
        // this press reaches [`crate::wishlist::add_wish_silent`] **not once** — and a `0` from
        // a successful press is exactly the answer a deleted folder must not be able to hide
        // behind three lines further down.
        let settled = deck(&conn, "Settled");
        let settled_main = category(&conn, settled, "Main deck");
        add(&conn, settled, "serra-lea", settled_main, LIVE, 1);
        add(&conn, settled, "serra-lea", settled_main, THEORY, 1);
        assert_eq!(
            missing_to_wishlist(&conn, settled, None, None).unwrap(),
            0,
            "the fixture's premise: this deck is short of nothing at all"
        );

        let gone = wish_folder(&conn, "Ordered");
        crate::wishlist_folders::delete_folder(&conn, gone).unwrap();

        assert_eq!(
            missing_to_wishlist(&conn, short, None, Some(gone)).unwrap_err(),
            crate::deck_meta::FOLDER_GONE
        );
        assert_eq!(
            missing_to_wishlist(&conn, settled, None, Some(gone)).unwrap_err(),
            crate::deck_meta::FOLDER_GONE,
            "the deck with nothing to buy is told about the folder, not handed a 0"
        );
        assert!(
            wishes(&conn).is_empty(),
            "and neither press wrote a wish — not in the folder, and not at the root either"
        );
    }

    /// **The same card at the root and then in a folder is two wishes, not one folded row.**
    /// This is what [`WISHLIST_GRAIN`](crate::schema::WISHLIST_GRAIN)'s fourth term is for, and
    /// the reason a destination on this button is an *add* rather than a move: take
    /// `coalesce(folder_id, 0)` out of the conflict target and the second press lands on the row
    /// the first one wrote and raises it to six — the reader watching three copies they had
    /// filed at the root walk into *Ordered* as a side effect of pressing a shopping button.
    ///
    /// **The two presses are identical apart from the folder, deliberately.** Nothing about the
    /// deck changes between them — a wish moves no cardboard — so the diff is re-read to the
    /// same three copies of the same printing in the same finish, and the grain's other three
    /// terms all match. Two rows can therefore only have been separated by the fourth; a fixture
    /// that varied the quantity or the printing would have passed with that term gone.
    ///
    /// **The third press is what says the fold still works**, so that "two rows" cannot be read
    /// as the upsert having been switched off: it repeats the *first* press exactly, and lands
    /// on the root's row and nowhere else.
    #[test]
    fn the_same_card_at_the_root_and_in_a_folder_is_two_wishes() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        let ordered = wish_folder(&conn, "Ordered");
        add(&conn, id, "bolt-lea", main, THEORY, 3);

        assert_eq!(missing_to_wishlist(&conn, id, None, None).unwrap(), 1);
        assert_eq!(
            missing_to_wishlist(&conn, id, None, Some(ordered)).unwrap(),
            1
        );

        assert_eq!(
            filed_wishes(&conn),
            vec![
                ("bolt-lea".to_owned(), None, 3),
                ("bolt-lea".to_owned(), Some(ordered), 3),
            ],
            "two rows of three copies, not one row of six"
        );

        assert_eq!(missing_to_wishlist(&conn, id, None, None).unwrap(), 1);
        assert_eq!(
            filed_wishes(&conn),
            vec![
                ("bolt-lea".to_owned(), None, 6),
                ("bolt-lea".to_owned(), Some(ordered), 3),
            ],
            "the root's wish doubled on the repeat and the folder's was not touched"
        );
    }

    /// A stale deck id is answered in words by every entry point here, rather than by an empty
    /// list that reads like a deck with nothing in it.
    #[test]
    fn a_deck_that_is_gone_is_refused_by_name() {
        let conn = seeded();

        assert_eq!(
            missing_to_wishlist(&conn, 404, None, None).unwrap_err(),
            crate::deck::GONE
        );
    }

    /// Turn a deck into one the reader tracks without owning — `decks.virtual_only`, schema v40.
    ///
    /// An `UPDATE` rather than a field on [`DeckInput`], so a case that wants one says so on its
    /// own line and every other case in this file is untouched.
    fn make_virtual(conn: &Connection, deck_id: i64) {
        conn.execute(
            "UPDATE decks SET virtual_only = 1 WHERE id = ?1",
            params![deck_id],
        )
        .unwrap();
    }

    /// A virtual deck has no shopping list, because it is not made of cardboard.
    ///
    /// **The one refusal in this module**, and the fixture is
    /// `missing_to_wishlist_asks_for_the_difference`'s: a plan asking for three copies the deck
    /// does not have, which is a wish the press would otherwise write. [`theory_slots`] and
    /// [`theory_diff`] get no fence of their own and no case here — a virtual deck's
    /// `theory_enabled` is 0, so there is no plan to compare and they are unreachable for one.
    #[test]
    fn a_virtual_deck_sends_nothing_to_the_wishlist() {
        let conn = seeded();
        let id = deck(&conn, "Burn");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "bolt-lea", main, THEORY, 3);
        make_virtual(&conn, id);

        assert_eq!(
            missing_to_wishlist(&conn, id, None, None).unwrap_err(),
            crate::deck::VIRTUAL_HOLDS_NOTHING
        );
        assert!(wishes(&conn).is_empty(), "and no wish was written");
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
    /// not swell the number the tick counts down from. **The plan's own Maybeboard** is the one
    /// switched off: each list has its own since user schema v53, and the live one's switch
    /// reaches no theory row.
    #[test]
    fn theory_slots_leave_a_switched_off_pile_out_of_the_count() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        let maybe = theory_category(&conn, d, "Maybeboard");
        add(&conn, d, "bolt-lea", main, THEORY, 2);
        add(&conn, d, "bolt-lea", maybe, THEORY, 3);
        conn.execute(
            "UPDATE deck_categories SET is_active = 0 WHERE id = ?1",
            params![maybe],
        )
        .unwrap();

        assert_eq!(slot_counts(&conn, d), vec![("bolt-lea|".to_owned(), 2)]);
    }

    /// The name travels with the slot so the *loose* tier has something to match on, and it
    /// travels **verbatim**: SQLite's `lower()` is ASCII-only and the webview's `toLowerCase()`
    /// is not, so a name folded here and a live row folded there would spell two keys for one
    /// card — and they would differ on exactly the names with diacritics, which is the failure
    /// nobody notices. `theoryMatch.ts`'s `theoryNameKey` is the one place the fold happens.
    #[test]
    fn a_slot_carries_the_printed_name_unfolded() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        add(&conn, d, "bolt-lea", main, THEORY, 4);

        let slots = theory_slots(&conn, d).unwrap();
        assert_eq!(slots.len(), 1);
        assert_eq!(slots[0].name_key.as_deref(), Some("Lightning Bolt"));
    }

    /// Two printings of one card are still two slots — the exact grain is untouched by this
    /// change — and both carry the same name, which is what lets the loose tier fold them.
    #[test]
    fn two_printings_are_two_slots_with_one_name() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        add(&conn, d, "bolt-lea", main, THEORY, 2);
        add(&conn, d, "bolt-m10", main, THEORY, 2);

        let mut names: Vec<_> = theory_slots(&conn, d)
            .unwrap()
            .into_iter()
            .map(|s| s.name_key)
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                Some("Lightning Bolt".to_owned()),
                Some("Lightning Bolt".to_owned())
            ]
        );
    }

    /// **The join is LEFT and this is why.** A theory row whose printing has left the corpus is
    /// an orphan — `deck_cards.card_id` is a soft reference — and an inner join would drop it
    /// from the plan entirely, taking its *exact* tick with it. It keeps its `group_key` and
    /// simply has no loose tier: `None` is "this card cannot be matched by name", which is the
    /// honest answer when the app does not know what the card is called.
    #[test]
    fn an_orphan_keeps_its_exact_key_and_has_no_name() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        add(&conn, d, "bolt-m10", main, THEORY, 1);
        // What the next sync does to a printing Scryfall stopped publishing.
        conn.execute("DELETE FROM cards WHERE id = 'bolt-m10'", [])
            .unwrap();

        let slots = theory_slots(&conn, d).unwrap();
        assert_eq!(slots.len(), 1, "an orphan must not vanish from the plan");
        assert_eq!(slots[0].key, group_key("bolt-m10", None));
        assert_eq!(slots[0].name_key, None);
    }

    /// `diff_select`'s rule, read by the same reasoning: a card parked in an inactive pile is
    /// not something the user has decided to play, so the plan is not asking for it. The pile is
    /// the plan's own, for the reason the case above gives.
    #[test]
    fn theory_slots_skips_a_switched_off_pile() {
        let conn = seeded();
        let d = deck(&conn, "Burn");
        set_theory(&conn, d, true);
        let main = category(&conn, d, "Main deck");
        let maybe = theory_category(&conn, d, "Maybeboard");
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

    // ── Token rows (the token-improvements spec §3.7) ─────────────────────────────────────

    /// A card that makes a Treasure, and two printings of the Treasure, with `raw` as ingest
    /// stores it — gzip, `all_parts` and all — because a token row is derived from the deck's
    /// cards, and every card in [`seeded`] carries `raw = '{}'` and so makes nothing.
    ///
    /// `treasure-tmom` is sold and priced in both finishes, so a row's price can be seen to
    /// follow its finish; `treasure-tmkm` is the other printing a substitution needs. The
    /// fixture lives in the `:memory:` pair [`seeded`] made, which is dropped with the test.
    fn with_treasures(conn: &Connection) {
        let tithe = serde_json::json!({
            "id": "tithe",
            "name": "Smothering Tithe",
            "all_parts": [{
                "object": "related_card", "id": "treasure-tmom", "component": "token",
                "name": "Treasure"
            }],
        });
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                type_line, raw)
             VALUES ('tithe', 'o-tithe', 'Smothering Tithe', 'cmm', '693', 'en', 'normal',
                     'Enchantment', ?1)",
            params![crate::card_row::gzip_raw(&tithe.to_string())],
        )
        .unwrap();
        conn.execute_batch(
            r#"INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                                  type_line, finishes, prices, released_at, raw)
               VALUES ('treasure-tmom', 'o-treasure', 'Treasure', 'tmom', '12', 'en', 'token',
                       'Token Artifact — Treasure', '["nonfoil","foil"]',
                       '{"usd":"0.25","usd_foil":"1.10"}', '2023-04-21', '{}'),
                      ('treasure-tmkm', 'o-treasure', 'Treasure', 'tmkm', '9', 'en', 'token',
                       'Token Artifact — Treasure', '["nonfoil"]', '{"usd":"0.40"}',
                       '2024-02-09', '{}');"#,
        )
        .unwrap();
    }

    /// **The plan's token entries less the live list's, per printing and finish** — the card
    /// rows' own grain and subtraction, answered after them. Three nonfoil Treasures and a foil
    /// one planned against one nonfoil sleeved is two lines: two nonfoil, one foil.
    ///
    /// The foil line is the one that tells the grain apart: the live list's nonfoil copy answers
    /// a planned nonfoil copy exactly, so it stands in for nothing else — the foil line reads
    /// `held_as_other_printing: 0`, where a count taken over "every other printing and finish"
    /// would have spent that one copy twice.
    #[test]
    fn the_diff_answers_token_rows_at_the_printing_and_finish_grain() {
        let conn = seeded();
        with_treasures(&conn);
        let id = deck(&conn, "Tithe");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "tithe", main, THEORY, 1);
        add(&conn, id, "tithe", main, LIVE, 1);
        add(&conn, id, "bolt-lea", main, THEORY, 2);
        // A token printing handed to `add_card` is filed as a token entry, never a deck card.
        add(&conn, id, "treasure-tmom", main, THEORY, 3);
        add_finish(&conn, id, "treasure-tmom", main, THEORY, Some("foil"), 1);
        add(&conn, id, "treasure-tmom", main, LIVE, 1);
        own(&conn, "treasure-tmom", 2);
        own_finish(&conn, "treasure-tmom", "foil", 1);

        let diff = theory_diff(&conn, id, ANY_MARKET).unwrap();

        assert_eq!(
            diff.iter()
                .map(|r| (
                    r.card_id.as_str(),
                    r.finish.as_deref(),
                    r.quantity,
                    r.is_token
                ))
                .filter(|r| !r.3)
                .collect::<Vec<_>>(),
            vec![("bolt-lea", None, 2, false)],
            "the card rows are what they were, and carry no token flag: {diff:?}"
        );
        let first_token = diff.iter().position(|r| r.is_token).expect("a token row");
        assert!(
            diff[..first_token].iter().all(|r| !r.is_token)
                && diff[first_token..].iter().all(|r| r.is_token),
            "token rows come after every card row: {diff:?}"
        );
        let tokens: Vec<&TheoryDiffRow> = diff.iter().filter(|r| r.is_token).collect();
        assert_eq!(tokens.len(), 2, "{tokens:?}");
        let line = |finish: Option<&str>| {
            *tokens
                .iter()
                .find(|r| r.finish.as_deref() == finish)
                .unwrap_or_else(|| panic!("no {finish:?} line in {tokens:?}"))
        };

        let plain = line(None);
        assert_eq!(
            (
                plain.card_id.as_str(),
                plain.name.as_str(),
                plain.category_name.as_str(),
                plain.set_code.as_str(),
                plain.collector_number.as_str(),
            ),
            (
                "treasure-tmom",
                "Treasure",
                "Tokens & Emblems",
                "tmom",
                "12"
            )
        );
        assert_eq!(
            (plain.quantity, plain.unit_price, plain.owned_spare),
            (2, Some(0.25), 2),
            "three planned less one sleeved; the nonfoil price; the two nonfoil in the binder"
        );
        assert_eq!(plain.held_as_other_printing, 0);

        let foil = line(Some("foil"));
        assert_eq!(foil.category_name, "Tokens & Emblems");
        assert_eq!(
            (foil.quantity, foil.unit_price, foil.owned_spare),
            (1, Some(1.10), 1),
            "the foil is its own line, at the foil price, counting the foil copy alone"
        );
        assert_eq!(
            foil.held_as_other_printing, 0,
            "the sleeved nonfoil copy already answers a planned nonfoil one"
        );
    }

    /// **A plan that counts no tokens adds no token rows** — and a plan that makes a Treasure
    /// counts none until the reader steps it: its implicit entry is at zero since user schema
    /// v55. One direction, like the cards: Treasures sleeved and not planned are no line either,
    /// and neither is a planned token stepped back down to nothing.
    #[test]
    fn a_plan_counting_no_tokens_adds_no_token_rows() {
        let conn = seeded();
        with_treasures(&conn);
        let id = deck(&conn, "Tithe");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "tithe", main, THEORY, 1);
        add(&conn, id, "bolt-lea", main, THEORY, 2);
        add(&conn, id, "treasure-tmkm", main, LIVE, 2);
        // The premise: the plan does make the Treasure, at its implicit zero.
        let planned = crate::deck_tokens::deck_token_rows(&conn, id, THEORY, ANY_MARKET).unwrap();
        assert_eq!(
            planned
                .iter()
                .map(|t| (t.name.as_str(), t.quantity, t.implicit))
                .collect::<Vec<_>>(),
            vec![("Treasure", 0, true)]
        );

        let cards_only = |conn: &Connection| {
            theory_diff(conn, id, ANY_MARKET)
                .unwrap()
                .iter()
                .map(|r| (r.card_id.clone(), r.is_token))
                .collect::<Vec<_>>()
        };
        let expected = vec![("bolt-lea".to_owned(), false), ("tithe".to_owned(), false)];
        assert_eq!(cards_only(&conn), expected);

        // Counted, then stepped back to nothing: the entry stays at zero and asks for nothing.
        add(&conn, id, "treasure-tmom", main, THEORY, 1);
        crate::deck_tokens::set_quantity(
            &conn,
            id,
            THEORY,
            "o-treasure",
            Some(&crate::deck_tokens::TokenEntryKey {
                card_id: "treasure-tmom".to_owned(),
                finish: "nonfoil".to_owned(),
            }),
            0,
        )
        .unwrap();
        assert_eq!(cards_only(&conn), expected);
    }

    /// **A token the live list keeps in another printing is held as another printing**, on the
    /// card rows' rule: the pool is the live list's copies of the token less the ones an exact
    /// line already matched, and a row takes at most its own quantity out of it.
    #[test]
    fn held_as_other_printing_counts_the_actual_lists_other_printings_of_the_token() {
        let conn = seeded();
        with_treasures(&conn);
        let id = deck(&conn, "Tithe");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "tithe", main, THEORY, 1);
        add(&conn, id, "tithe", main, LIVE, 1);
        add(&conn, id, "treasure-tmom", main, THEORY, 3);
        // One of the exact printing, which answers one planned copy and is no substitute...
        add(&conn, id, "treasure-tmom", main, LIVE, 1);
        // ...and one of another printing of the same token, which is.
        add(&conn, id, "treasure-tmkm", main, LIVE, 1);

        let token_line = |conn: &Connection| {
            let diff = theory_diff(conn, id, ANY_MARKET).unwrap();
            let tokens: Vec<_> = diff
                .into_iter()
                .filter(|r| r.is_token)
                .map(|r| (r.card_id, r.quantity, r.held_as_other_printing))
                .collect();
            tokens
        };
        assert_eq!(
            token_line(&conn),
            vec![("treasure-tmom".to_owned(), 2, 1)],
            "two short of the planned printing, and one of them played as MKM"
        );

        // More of the other printing than the line is short of: capped at the line's quantity.
        add(&conn, id, "treasure-tmkm", main, LIVE, 4);
        assert_eq!(token_line(&conn), vec![("treasure-tmom".to_owned(), 2, 2)]);
    }

    /// **Send to wishlist takes a token row by its key**, which is spelled like every other
    /// row's — `` `{card_id}|{finish}` ``, the regular copy's half empty — and files a wish
    /// pinned to the token's printing, its oracle card and its name. **The finish is spelled
    /// out, `nonfoil` included**: a token's entry always names one, so the wish does too.
    #[test]
    fn sending_a_token_row_to_the_wishlist_files_a_wish_pinned_to_its_printing_and_finish() {
        let conn = seeded();
        with_treasures(&conn);
        let id = deck(&conn, "Tithe");
        let main = category(&conn, id, "Main deck");
        add(&conn, id, "tithe", main, THEORY, 1);
        add(&conn, id, "treasure-tmom", main, THEORY, 3);
        add_finish(&conn, id, "treasure-tmom", main, THEORY, Some("foil"), 1);
        add(&conn, id, "treasure-tmom", main, LIVE, 1);

        let foil = vec![group_key("treasure-tmom", Some("foil"))];
        assert_eq!(
            missing_to_wishlist(&conn, id, Some(&foil), None).unwrap(),
            1
        );
        let plain = vec![group_key("treasure-tmom", None)];
        assert_eq!(
            missing_to_wishlist(&conn, id, Some(&plain), None).unwrap(),
            1
        );

        assert_eq!(
            pinned_wishes(&conn),
            vec![
                (
                    "o-treasure".to_owned(),
                    "treasure-tmom".to_owned(),
                    Some("foil".to_owned()),
                    1
                ),
                (
                    "o-treasure".to_owned(),
                    "treasure-tmom".to_owned(),
                    Some("nonfoil".to_owned()),
                    2
                ),
            ],
            "the Tithe's own card row was not ticked and is not here"
        );
        let names: Vec<String> = conn
            .prepare("SELECT name FROM wishlist_entries ORDER BY id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(names, vec!["Treasure", "Treasure"]);
    }

    /// The hand-mirrored wire contract, pinned so a field added here and never mirrored in
    /// `packages/ui/lib/ipc.ts` fails the suite rather than rendering as `undefined`.
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
            is_token: false,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "cardId": "bolt-lea", "name": "Lightning Bolt", "categoryName": "Main deck",
                "quantity": 2, "unitPrice": 400.0,
                "setCode": "lea", "collectorNumber": "161", "finish": "foil", "ownedSpare": 1,
                "heldAsOtherPrinting": 1,
                "isToken": false
            })
        );
    }

    /// The tick's own wire contract, pinned for [`TheoryDiffRow`]'s reason — this one crosses to
    /// `packages/ui/lib/ipc.ts`'s `TheorySlot` and to `packages/fake/db.ts`, and a renamed field would
    /// otherwise reach the mark as `undefined` and read as a deck with no plan.
    #[test]
    fn theory_slot_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(TheorySlot {
            key: "bolt-lea|foil".to_owned(),
            name_key: Some("Lightning Bolt".to_owned()),
            quantity: 4,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "key": "bolt-lea|foil", "nameKey": "Lightning Bolt", "quantity": 4
            })
        );
    }
}
