/**
 * Which cards in the live list the plan also asks for — the deckbuilder's fourth card mark.
 *
 * A deck with the theory list switched on holds two lists in one table, and the reader flipping
 * to `Live` is looking at what they have actually sleeved up. The one thing that list cannot say
 * about itself is which of its rows are *the plan* and which are the substitutes, the proxies and
 * the experiments standing in until the real card arrives. That is the whole of what this answers.
 *
 * ## Two tiers since 2026-09-07, and the number's grain follows the tier
 *
 * A live row resolves to **exactly one** mark, or to none:
 *
 * | The row | Tier | The number it carries |
 * | --- | --- | --- |
 * | Its `(cardId, finish)` is a slot in the plan | `exact` | `live − planned` at the `(cardId, finish)` grain |
 * | Its **name** is in the plan, but this `(cardId, finish)` is not | `name` | `live − planned` with every printing and finish of that name summed on both sides |
 * | Neither | — | none |
 *
 * **That the grain follows the tier is the whole rule**, and it is why {@link theoryMatchMark} is
 * one function rather than a tier test standing beside a delta lookup. An `exact` row is the
 * printing the plan named and its number is about that printing; a `name` row is another printing
 * of a planned card and its number is about the *card*. The reader was shown the case it costs
 * the most in — a plan asking for eight Forests of one printing against a list holding eight over
 * four printings, so the planned rows read `-6` and the other six read `0` — and chose it over one
 * name-grain number on both tiers.
 *
 * **The maps are built once and read; nothing is consumed.** Every one of those eight Forests
 * carries a mark, which is a property a lookup that deleted an entry as it served it would not
 * have — it would mark one row and pass every other test in this file. It is already how the
 * exact tier worked and it is what the land case is a test for.
 *
 * ## The grain is the printing and the finish, and it is deliberately not the category
 *
 * `deck_cards`' unique index is `(deck, card, category, variant, finish)`. Drop the deck (one
 * editor, one deck) and the variant (the two lists *are* the comparison) and you are left with
 * three, and the category is the one this must not keep: a reader who files their Sol Ring under
 * `Ramp` in the plan and drops it into `Main deck` when it arrives has still acquired the card
 * they planned for, and a mark that went dark because a pile was renamed would be a mark nobody
 * could learn to trust. **That holds at both grains** — the name tier drops the category for the
 * same reason, and sums every pile on each side before subtracting.
 *
 * So `cardId` and `finish` — the printing and the object. Both are the reader's own statements
 * rather than facts about the corpus: a plan calling for the Alpha Bolt is not satisfied by the
 * M10 one, and a plan calling for the foil is not satisfied by the regular copy. `finish` is read
 * raw and **never** through `playedFinish`, which is the rule this file would otherwise get
 * subtly wrong: `playedFinish` falls back to `soleFinish(finishes)` so a *surface* can draw
 * "this printing only exists in foil", and folding that in here would match a plan's explicit
 * `foil` against a live row the reader never said anything about. The address is what the reader
 * wrote; two rows that both say `null` are two regular copies and match each other. The second
 * tier does not weaken any of that — it says those two rows are the same *card*, which is a
 * different sentence and is drawn in a different colour.
 *
 * **The plan's half of the key is not built here at all.** `deck_theory_slots` answers
 * `deck_theory.rs`'s own `group_key` strings, so the only thing this file spells is the *live*
 * row being looked up — and it has to spell it identically or every lookup misses. That is the
 * point of taking the keys from the backend rather than a list of rows: "the same planned card"
 * is one function, in Rust, and the tick and the shopping list are both spelling it with that
 * code instead of with two conventions that agree today. `GROUP_SEPARATOR` there is where it
 * would change; `theoryMatch.test.ts` and `deck_theory.rs`'s own tests write the same literals
 * on both sides of the boundary so that a change fails one of them.
 *
 * **The name half is the exception, and the fold is written here precisely so that it is not.**
 * Rust answers `cards.name` verbatim and {@link theoryNameKey} folds both sides in one language —
 * its own note carries the reasoning, and it is the only place that rule is written.
 *
 * **What is emphatically not shared is the question.** The shopping list subtracts *quantities*
 * and answers "what would I have to buy"; this answers "is the card in front of me the one I
 * planned". Neither is derivable from the other, in either direction: a card fully acquired is
 * **absent** from the diff and is still in the plan, and a card half-acquired is on the diff and
 * also in the plan.
 *
 * **Since 2026-08-26 the mark carries a number too, and that does not collapse the two.**
 * [Issue #212](https://github.com/Msgaihede/mtg-grimoire/issues/212) asked for the shortfall on
 * the card — a live 2-of against a planned 4-of drawing `-2` where an exact match draws a tick —
 * so this module now subtracts as well. What keeps it a different question is *which rows it is
 * asked about*: the diff lists only what the plan is short of, in one direction, while this
 * answers for **every** planned card, a surplus (`+2`) included, and answers `0` rather than
 * nothing for the card that matches. The diff is still what the reader buys from; this is still
 * what tells the real card from the proxy standing in for it. {@link theoryMatchPlan} carries the
 * arithmetic, at both grains.
 */
import type { DeckCard, TheorySlot } from "@/lib/ipc";

/** Which of the two statements a mark is making about its row — see the module note's table. */
export type TheoryTier = "exact" | "name";

/** What the plan says about one live row: which tier it is in and how far it is from the plan
 *  **at that tier's grain**. `0` is the tick; anything else is drawn as a signed number. */
export interface TheoryMark {
  tier: TheoryTier;
  /** `live − planned` at {@link TheoryMark.tier}'s own grain. */
  delta: number;
}

/**
 * The deck's two per-card-mark switches, both defaulting on —
 * `DeckRow.theoryMarkExact` / `DeckRow.theoryMarkName`.
 *
 * **Two booleans rather than one three-valued field**, which is the schema's own argument carried
 * up: `none | exact | both` cannot spell blue *without* green, and blue without green is a real
 * answer — a reader who cares that the card is present and not which printing it is.
 */
export interface TheoryMarkSwitches {
  /** Draw the **exact** tier as itself. Off, an exact row is re-resolved as a name row rather
   *  than silenced — see {@link theoryMatchMark}. */
  exact: boolean;
  /** Draw the **name** tier at all. Off, a name-only row draws nothing and an exact row is
   *  unaffected. */
  name: boolean;
}

/** The plan as two lookups and the switches that decide which of them a row may use. */
export interface TheoryPlan {
  /** {@link theorySlot}'s key → `live − planned` at the printing-and-finish grain. */
  exact: ReadonlyMap<string, number>;
  /** {@link theoryNameKey}'s key → `live − planned` with every printing and finish summed.
   *  A slot with no name is not in here at all; see {@link theoryNameKey}. */
  byName: ReadonlyMap<string, number>;
  /** The deck's own switches, carried so that {@link theoryMatchMark} needs no second argument
   *  at every call site in four views. */
  marks: TheoryMarkSwitches;
}

/**
 * One row's address across the two lists — see the module note for why these two fields and no
 * others.
 *
 * **`|` is not a choice this file gets to make.** `deck_theory_slots` answers the plan as
 * `deck_theory.rs`'s `group_key` strings, and this has to spell a live row the same way or every
 * lookup misses. That module's own note carries the reasoning — a Scryfall card id is a UUID and
 * a finish is one of two words, so neither half can contain the character and no two pairs can
 * spell one key — and `GROUP_SEPARATOR` there is where it would change.
 *
 * (The first draft of this used a NUL, back when both halves were built here. It is a perfectly
 * good separator and a terrible one to *debug*: ripgrep called this file binary, so a grep for
 * `theorySlot` answered nothing, and a test hand-spelling a key could not type the character it
 * needed. A key nobody can write down by hand is a key nobody can check.)
 */
export function theorySlot(card: Pick<DeckCard, "cardId" | "finish">): string {
  return `${card.cardId}|${card.finish ?? ""}`;
}

/**
 * A card's identity across printings, folded — the name tier's key.
 *
 * **The fold happens here and nowhere else.** `deck_theory.rs` answers `cards.name` verbatim and
 * this side lowercases both halves, because SQLite's `lower()` is ASCII-only and this one is not:
 * a plan folded in SQL and a live row folded here would spell two keys for `Lim-Dûl's Vault` and
 * `Æther Vial`, and the mark would go dark on exactly the names nobody thinks to check.
 *
 * A name rather than an `oracle_id` because Scryfall omits that field on reversible cards — on
 * both sides — and an identity with a fallback chain is two rules for two sides to disagree
 * about. What it costs: two distinct oracle cards that share a printed name would collapse into
 * one name tier. That is a blue tick that should not be there, on a pair no deck holds both of.
 *
 * **A slot whose `nameKey` is `null` is an orphan and never reaches this function** — its
 * printing has left the corpus, so it names no card to be another printing *of*. It can still be
 * matched exactly and must match nothing loosely: a `null` folded to `""` and put in the map as a
 * key would make every unnamed live row match every orphan in the plan.
 */
export function theoryNameKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * The smallest count at which a *difference* is worth drawing —
 * [issue #212](https://github.com/Msgaihede/mtg-grimoire/issues/212)'s own rule, in one place.
 *
 * "Do not use this difference indicator for quantities of `1` or `0`; use it only when the theory
 * or live quantity is greater than `1`." Read literally that is `max(live, planned) > 1`, and it
 * is **nearly vacuous by arithmetic**: the only pairs it excludes are `1 → 0` and `0 → 1`, and
 * neither is reachable through the front door — `deck_cards` has `CHECK (quantity > 0)`, and a
 * plan asking for none of a card has no slot for the tick to be drawn on at all.
 *
 * It is written down anyway, and not as a formality. What it is really about is the singleton
 * deck: in Commander every row is a 1-of, so a reader there must never meet this mark at all, and
 * a rule stated as "only above one" is the one a future edit cannot quietly widen. It is also the
 * fence around the one state that *can* exist — an inactive live pile summing to zero against a
 * plan that asks for one (see {@link theoryMatchPlan} on why the live side excludes those piles),
 * where `-1` on a row visibly holding a card would read as a bug rather than as a fact.
 *
 * **It is applied per tier, at that tier's own sums**, which is the same sentence as the grain
 * following the tier: a Commander singleton is a 1-of at both grains and meets no number on
 * either, while a card the plan names two printings of clears the floor loosely and not exactly.
 */
const DIFFERENCE_FLOOR = 1;

/** `live − planned` where the pair is worth a number, and `0` — the tick — where it is not. */
function floored(have: number, wanted: number): number {
  return Math.max(have, wanted) > DIFFERENCE_FLOOR ? have - wanted : 0;
}

/**
 * The plan as a lookup at both grains — every card it asks for, against **how far the live list
 * is from it** — or `undefined` for a deck that has no plan to compare against.
 *
 * Takes the slots {@link ipc.deckTheorySlots} answers with, whose keys are already `group_key`
 * strings, so this builds no key for the plan's exact half; {@link theorySlot} is for the *live*
 * rows. Both halves of the **name** grain are built here, by {@link theoryNameKey}, for the
 * reason written at that function.
 *
 * `undefined` rather than an empty map, and the two are genuinely different: an empty map is a
 * plan that asks for nothing, which every card fails to match, while `undefined` is *there is no
 * question here* — a deck with the theory list switched off, or the Theory tab itself, where
 * every row is the plan by definition and a mark saying so on all of them would be noise. The
 * views take it optional and draw nothing for the absent case, which is `violations`' own
 * arrangement one prop over.
 *
 * ## The value is `live − planned`, at each grain and never at a row's
 *
 * Both sides are summed across the piles they are filed in before they are subtracted, which is
 * this module's grain (the category is the term it must not keep) and `deck_theory.rs`'s
 * `grouped_diff`'s. Doing it per **row** instead is the version that looks simpler and is wrong
 * on the ordinary case: a plan calling for four Bolts in Main deck and one in the Sideboard,
 * matched exactly, would draw `-1` on the first row and `-4` on the second — two numbers, both
 * false, about a card the reader has got exactly right.
 *
 * So every live row of one slot wears the **same** mark, which is the honest reading: the fact is
 * about the planned card rather than about the pile it happens to be in. The name grain is that
 * argument one step further out — every row of one *card* reads one number.
 *
 * ## An inactive pile counts on neither side of either tier
 *
 * `theory_slots` excludes them on `diff_select`'s stated rule — *a card parked in the theory
 * Maybeboard is not something the user has decided to play* — and that function excludes them
 * from **both** sides of its own comparison for the mirror of it: a card parked in the *live*
 * Maybeboard is not something the deck has. Filtering one side and not the other is how a
 * scratchpad comes to fill a shopping list, and it would do the same to these numbers. The
 * **`!card.categoryActive` `continue` in the live loop** is what makes it true of both grains at
 * once: it drops the row before either `sleeved*` map has seen it, so one line answers for the
 * printing grain and the name grain together. There is a second `continue` a few lines above it
 * and it is a different rule entirely — the orphan skip in the *plan* loop, which keeps a slot
 * with no name out of the name grain alone. This sentence said "the one `continue` below" while
 * there was one.
 *
 * That leaves the one state {@link DIFFERENCE_FLOOR} is a fence around, and it is why the fence
 * is not merely a formality: a plan that asks for one copy of a card the reader has filed only in
 * a switched-off pile sums to `0 − 1`, and `-1` printed on a row visibly holding a card would
 * read as a broken mark. `max(live, planned) > 1` is `false` there, so the tick is drawn instead
 * — "this is the card you planned", which is true, said without a number nobody can act on.
 */
export function theoryMatchPlan(
  slots: readonly TheorySlot[] | undefined,
  live: readonly Pick<DeckCard, "cardId" | "finish" | "name" | "quantity" | "categoryActive">[],
  marks: TheoryMarkSwitches,
): TheoryPlan | undefined {
  if (slots === undefined) return undefined;
  const plannedExact = new Map<string, number>();
  const plannedName = new Map<string, number>();
  for (const slot of slots) {
    // Accumulated rather than assigned. The command groups, so a repeated key should not reach
    // here — but a `Vec` is what crosses the boundary, and a sum is the answer that stays right
    // if it ever stops grouping, where the last-one-wins of an assignment silently halves a plan.
    plannedExact.set(slot.key, (plannedExact.get(slot.key) ?? 0) + slot.quantity);
    // An orphan names no card, so it takes no place in the name grain at all — never a `""` key,
    // which would be one bucket every unnamed row and every orphan fell into together.
    if (slot.nameKey === null) continue;
    // Summed for a second reason the exact grain does not have: two printings of one card are two
    // slots on the wire *by design*, and at this grain they are one order for one card.
    const named = theoryNameKey(slot.nameKey);
    plannedName.set(named, (plannedName.get(named) ?? 0) + slot.quantity);
  }
  const sleevedExact = new Map<string, number>();
  const sleevedName = new Map<string, number>();
  for (const card of live) {
    if (!card.categoryActive) continue;
    // Only what the plan asks for is ever looked up, so a live card the plan has no row for costs
    // one map entry and is never read. Filtering first would be a second pass over the same list.
    const key = theorySlot(card);
    sleevedExact.set(key, (sleevedExact.get(key) ?? 0) + card.quantity);
    const named = theoryNameKey(card.name);
    sleevedName.set(named, (sleevedName.get(named) ?? 0) + card.quantity);
  }
  const exact = new Map<string, number>();
  for (const [key, wanted] of plannedExact) {
    exact.set(key, floored(sleevedExact.get(key) ?? 0, wanted));
  }
  const byName = new Map<string, number>();
  for (const [key, wanted] of plannedName) {
    byName.set(key, floored(sleevedName.get(key) ?? 0, wanted));
  }
  return { exact, byName, marks };
}

/**
 * What the plan says about this row: `null` where it says nothing, and otherwise which tier the
 * row is in and how far it is from the plan **at that tier's grain**.
 *
 * ## The tier decides the colour and the number together
 *
 * That is the whole rule, and it is why this is one function rather than a tier test beside a
 * delta lookup. An **exact** row is the printing the plan named, and its number is about that
 * printing: two of the eight planned Forests of that art is `-6`, which is true. A **name** row is
 * another printing of a planned card, and its number is about the *card*: eight Forests against
 * eight planned is `0`, which is also true. The reader chose this arrangement on 2026-09-07 over
 * one name-grain number for both tiers, having been shown the case it costs the most in.
 *
 * ## Turning the exact mark off does not silence the row
 *
 * It re-resolves it as a name one — blue, with blue's number. An exact match *is* a name match,
 * so the fact survives the switch; what the switch turns off is the finer statement. This is why
 * the fallback needs no arithmetic of its own: it is the same call, one tier down.
 *
 * `null` and `0` are the distinction every caller turns on, and they are deliberately not the
 * same falsy value: `null` draws no mark, `0` draws the tick. A deck with no plan answers `null`
 * for every row, which is the honest reading of "nothing here matches the theory list", and so
 * does a deck with both switches off.
 *
 * Two things this body gets right by construction rather than by a branch: a slot with
 * `nameKey === null` never entered `byName`, so an orphan can never be matched loosely; and
 * **nothing is consumed** — every read leaves both maps as they were, which is what marks all
 * eight Forests rather than the last one.
 */
export function theoryMatchMark(
  plan: TheoryPlan | undefined,
  card: Pick<DeckCard, "cardId" | "finish" | "name">,
): TheoryMark | null {
  if (plan === undefined) return null;
  const exact = plan.exact.get(theorySlot(card));
  if (exact !== undefined && plan.marks.exact) return { tier: "exact", delta: exact };
  if (!plan.marks.name) return null;
  const byName = plan.byName.get(theoryNameKey(card.name));
  return byName === undefined ? null : { tier: "name", delta: byName };
}
