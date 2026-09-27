/**
 * The validation engine's findings, turned round so a card can ask about itself.
 *
 * `validateForMarks` answers a list of sentences and **collapses** the rows that produce the
 * same one into a single finding whose `rowIds` names all of them — which is right for a
 * panel that lists problems and exactly wrong for a list that marks cards. Every view marks
 * cards, so the inversion happens once, here, rather than in four of them.
 */
import type { DeckCard } from "@/lib/ipc";
import { deckCardSlot } from "./dnd";
import type { ValidationIssue } from "./validation/types";

/**
 * Every finding, filed under each **row** it marks, by that row's slot ({@link deckCardSlot}).
 *
 * By the row and never by the printing, which is what this used to key on (issue #554). One
 * printing is often several rows, and the two passes behind the marks judge different ones —
 * `validateForMarks` stamps each finding with the `rowIds` its own pass judged — so filing by
 * `cardIds` put an active pile's singleton break on the parked copy beside it, a mark about a
 * pile on the one card the rules say is judged only on its own facts.
 *
 * The slot rather than the row id because the slot is how every other mark on a deck card is
 * addressed — the picked ring, the pane's context, the walk — and it is stable across a re-read
 * where a story's or a test's generated row id is not. `cards` is the deck read the findings came
 * from, and is what turns a row id into a slot.
 *
 * Findings that mark no row are dropped: an issue about the deck itself (its size, its
 * sideboard's size) deliberately carries no ids, because highlighting sixty rows says nothing
 * the sentence did not.
 *
 * Order is preserved, both between rows and within one — the engine reports worst-first by
 * rule, and a mark that reordered them would put a different sentence in the tooltip depending
 * on which pass built the map.
 */
export function violationsBySlot(
  issues: readonly ValidationIssue[],
  cards: readonly DeckCard[],
): Map<string, ValidationIssue[]> {
  const slotOf = new Map(
    cards.map((card) => [card.id, deckCardSlot(card.categoryId, card.cardId, card.finish)]),
  );
  const bySlot = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    for (const rowId of issue.rowIds ?? []) {
      const slot = slotOf.get(rowId);
      if (slot === undefined) continue;
      const seen = bySlot.get(slot);
      if (!seen) bySlot.set(slot, [issue]);
      else if (!seen.includes(issue)) seen.push(issue);
    }
  }
  return bySlot;
}

/** One row's findings out of {@link violationsBySlot}'s map — the lookup every view makes, written
 *  once so no view can key it by the printing again. */
export function violationsFor(
  violations: ReadonlyMap<string, ValidationIssue[]> | undefined,
  card: Pick<DeckCard, "categoryId" | "cardId" | "finish">,
): ValidationIssue[] | undefined {
  return violations?.get(deckCardSlot(card.categoryId, card.cardId, card.finish));
}

/**
 * What a card's `RULE BREAK` mark says, or `null` when it does not draw one.
 *
 * **Errors only, and that is the spec's own requirement**: the mark has to be
 * distinguishable from the game-changer badge beside it, because one is a problem and the
 * other is a fact about a powerful card. A *warning* is neither — an orphaned row or a
 * legality blob this app cannot read is worth a look, not a red frame — so it is reported in
 * the validation panel and marks no card.
 *
 * Takes `undefined` as well as an empty list, so a call site can hand a `Map.get` straight
 * in: a card with nothing wrong with it is the common case.
 */
export function ruleBreak(issues: readonly ValidationIssue[] | undefined): string | null {
  const errors = (issues ?? []).filter((issue) => issue.severity === "error");
  // One sentence once. Filing by row already keeps the two passes' findings apart, so this is a
  // backstop rather than the fix — but a sentence said twice in a tooltip, and twice in the
  // accessible name `deckCardName` builds from this, is the symptom issue #554 reported.
  const sentences = [...new Set(errors.map((issue) => issue.message))];
  return sentences.length === 0 ? null : sentences.join(" ");
}
