/**
 * The validation engine's findings, turned round so a card can ask about itself.
 *
 * `validateDeck` answers a list of sentences and **collapses** the rows that produce the
 * same one into a single finding whose `cardIds` names all of them — which is right for a
 * panel that lists problems and exactly wrong for a list that marks cards. Every view marks
 * cards, so the inversion happens once, here, rather than in four of them.
 */
import type { ValidationIssue } from "./validation/types";

/**
 * Every finding, filed under each card it names.
 *
 * Findings that name no card are dropped: an issue about the deck itself (its size, its
 * sideboard's size) deliberately carries no ids, because highlighting sixty rows says
 * nothing the sentence did not.
 *
 * Order is preserved, both between cards and within one — the engine reports worst-first by
 * rule, and a mark that reordered them would put a different sentence in the tooltip
 * depending on which pass built the map.
 */
export function violationsByCard(
  issues: readonly ValidationIssue[],
): Map<string, ValidationIssue[]> {
  const byCard = new Map<string, ValidationIssue[]>();
  for (const issue of issues) {
    for (const cardId of issue.cardIds ?? []) {
      const seen = byCard.get(cardId);
      if (seen) seen.push(issue);
      else byCard.set(cardId, [issue]);
    }
  }
  return byCard;
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
  return errors.length === 0 ? null : errors.map((issue) => issue.message).join(" ");
}
