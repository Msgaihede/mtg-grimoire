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
 * also in the plan. A live 2-of against a planned 4-of is the planned card, half-acquired, and
 * the `Compare` dialog is what counts the shortfall.
 */
import type { DeckCard } from "@/lib/ipc";

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
 * The plan as a lookup, or `undefined` for a deck that has no plan to compare against.
 *
 * Takes the slots {@link ipc.deckTheorySlots} answers with — already `group_key` strings, so this
 * builds no key of its own; {@link theorySlot} is for the *live* row being looked up.
 *
 * `undefined` rather than an empty set, and the two are genuinely different: an empty set is a
 * plan that asks for nothing, which every card fails to match, while `undefined` is *there is no
 * question here* — a deck with the theory list switched off, or the Theory tab itself, where
 * every row is the plan by definition and a mark saying so on all of them would be noise. The
 * views take it optional and draw nothing for the absent case, which is `violations`' own
 * arrangement one prop over.
 */
export function theoryMatchSet(
  slots: readonly string[] | undefined,
): ReadonlySet<string> | undefined {
  if (slots === undefined) return undefined;
  return new Set(slots);
}

/** Whether this row is one the plan asks for. A deck with no plan answers `false` for every row,
 *  which is the honest reading of "nothing here matches the theory list". */
export function matchesTheory(
  matches: ReadonlySet<string> | undefined,
  card: Pick<DeckCard, "cardId" | "finish">,
): boolean {
  return matches !== undefined && matches.has(theorySlot(card));
}
