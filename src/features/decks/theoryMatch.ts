/**
 * Which cards in the live list the plan also asks for — the deckbuilder's fourth card mark.
 *
 * A deck with the theory list switched on holds two lists in one table, and the reader flipping
 * to `Live` is looking at what they have actually sleeved up. The one thing that list cannot say
 * about itself is which of its rows are *the plan* and which are the substitutes, the proxies and
 * the experiments standing in until the real card arrives. That is the whole of what this answers.
 *
 * ## The grain is the printing and the finish, and it is deliberately not the category
 *
 * `deck_cards`' unique index is `(deck, card, category, variant, finish)`. Drop the deck (one
 * editor, one deck) and the variant (the two lists *are* the comparison) and you are left with
 * three, and the category is the one this must not keep: a reader who files their Sol Ring under
 * `Ramp` in the plan and drops it into `Main deck` when it arrives has still acquired the card
 * they planned for, and a mark that went dark because a pile was renamed would be a mark nobody
 * could learn to trust.
 *
 * So `cardId` and `finish` — the printing and the object. Both are the reader's own statements
 * rather than facts about the corpus: a plan calling for the Alpha Bolt is not satisfied by the
 * M10 one, and a plan calling for the foil is not satisfied by the regular copy. `finish` is read
 * raw and **never** through `playedFinish`, which is the rule this file would otherwise get
 * subtly wrong: `playedFinish` falls back to `soleFinish(finishes)` so a *surface* can draw
 * "this printing only exists in foil", and folding that in here would match a plan's explicit
 * `foil` against a live row the reader never said anything about. The address is what the reader
 * wrote; two rows that both say `null` are two regular copies and match each other.
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
 * arithmetic.
 */
import type { DeckCard, TheorySlot } from "@/lib/ipc";

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
 */
const DIFFERENCE_FLOOR = 1;

/**
 * The plan as a lookup — every card it asks for, against **how far the live list is from it** —
 * or `undefined` for a deck that has no plan to compare against.
 *
 * Takes the slots {@link ipc.deckTheorySlots} answers with, whose keys are already `group_key`
 * strings, so this builds no key for the plan's half; {@link theorySlot} is for the *live* rows.
 *
 * `undefined` rather than an empty map, and the two are genuinely different: an empty map is a
 * plan that asks for nothing, which every card fails to match, while `undefined` is *there is no
 * question here* — a deck with the theory list switched off, or the Theory tab itself, where
 * every row is the plan by definition and a mark saying so on all of them would be noise. The
 * views take it optional and draw nothing for the absent case, which is `violations`' own
 * arrangement one prop over.
 *
 * ## The value is `live − planned`, at the slot's grain and never at a row's
 *
 * Both sides are summed across the piles they are filed in before they are subtracted, which is
 * this module's grain (the category is the term it must not keep) and `deck_theory.rs`'s
 * `grouped_diff`'s. Doing it per **row** instead is the version that looks simpler and is wrong
 * on the ordinary case: a plan calling for four Bolts in Main deck and one in the Sideboard,
 * matched exactly, would draw `-1` on the first row and `-4` on the second — two numbers, both
 * false, about a card the reader has got exactly right.
 *
 * So every live row of one slot wears the **same** mark, which is the honest reading: the fact is
 * about the planned card rather than about the pile it happens to be in.
 *
 * ## An inactive pile counts on neither side
 *
 * `theory_slots` excludes them on `diff_select`'s stated rule — *a card parked in the theory
 * Maybeboard is not something the user has decided to play* — and that function excludes them
 * from **both** sides of its own comparison for the mirror of it: a card parked in the *live*
 * Maybeboard is not something the deck has. Filtering one side and not the other is how a
 * scratchpad comes to fill a shopping list, and it would do the same to this number.
 *
 * That leaves the one state {@link DIFFERENCE_FLOOR} is a fence around, and it is why the fence
 * is not merely a formality: a plan that asks for one copy of a card the reader has filed only in
 * a switched-off pile sums to `0 − 1`, and `-1` printed on a row visibly holding a card would
 * read as a broken mark. `max(live, planned) > 1` is `false` there, so the tick is drawn instead
 * — "this is the card you planned", which is true, said without a number nobody can act on.
 */
export function theoryMatchPlan(
  slots: readonly TheorySlot[] | undefined,
  live: readonly Pick<DeckCard, "cardId" | "finish" | "quantity" | "categoryActive">[],
): ReadonlyMap<string, number> | undefined {
  if (slots === undefined) return undefined;
  const planned = new Map<string, number>();
  for (const slot of slots) {
    // Accumulated rather than assigned. The command groups, so a repeated key should not reach
    // here — but a `Vec` is what crosses the boundary, and a sum is the answer that stays right
    // if it ever stops grouping, where the last-one-wins of an assignment silently halves a plan.
    planned.set(slot.key, (planned.get(slot.key) ?? 0) + slot.quantity);
  }
  const sleeved = new Map<string, number>();
  for (const card of live) {
    if (!card.categoryActive) continue;
    const key = theorySlot(card);
    // Only what the plan asks for is ever looked up, so a live card the plan has no row for costs
    // one map entry and is never read. Filtering first would be a second pass over the same list.
    sleeved.set(key, (sleeved.get(key) ?? 0) + card.quantity);
  }
  const deltas = new Map<string, number>();
  for (const [key, wanted] of planned) {
    const have = sleeved.get(key) ?? 0;
    deltas.set(key, Math.max(have, wanted) > DIFFERENCE_FLOOR ? have - wanted : 0);
  }
  return deltas;
}

/**
 * What the plan says about this row: `null` where it does not ask for the card at all, and
 * otherwise how many copies the live list is **over** (positive) or **short** (negative) — `0`
 * for the card that matches.
 *
 * `null` and `0` are the distinction every caller turns on, and they are deliberately not the
 * same falsy value: `null` draws no mark, `0` draws the tick. A deck with no plan answers `null`
 * for every row, which is the honest reading of "nothing here matches the theory list".
 */
export function theoryMatchDelta(
  matches: ReadonlyMap<string, number> | undefined,
  card: Pick<DeckCard, "cardId" | "finish">,
): number | null {
  if (matches === undefined) return null;
  return matches.get(theorySlot(card)) ?? null;
}
