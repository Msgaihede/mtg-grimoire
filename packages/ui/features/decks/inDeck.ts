/**
 * How many copies of each **card** the open deck's drawn list holds — what the docked search
 * column's tiles mark as already in the deck (issue #1672).
 *
 * **Keyed by oracle id, not by printing**: a reader asking "is Lightning Bolt in my deck?" means
 * the card, and the search column collapses printings to one tile per card, so a Bolt from another
 * set has to mark it too. A row with no oracle id (an orphan whose printing left the corpus) is in
 * no search result either, so it is skipped rather than keyed by something no tile carries.
 *
 * **Every pile, active or not.** The mark answers "is it in here", and a card waiting in Maybe or
 * the Sideboard is a card the reader has already put somewhere — the deck's totals and validation
 * are a different question with their own rule (`is_active`).
 */
export function inDeckByOracle(
  cards: readonly { oracleId: string | null; quantity: number }[],
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const { oracleId, quantity } of cards) {
    if (oracleId === null || quantity <= 0) continue;
    counts.set(oracleId, (counts.get(oracleId) ?? 0) + quantity);
  }
  return counts;
}

/** The one empty map, so a panel mounted with no deck in hand hands its tiles a stable answer. */
export const NOTHING_IN_DECK: ReadonlyMap<string, number> = new Map();
