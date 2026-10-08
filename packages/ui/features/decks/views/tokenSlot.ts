/**
 * The token pile's place in the rail as **arithmetic alone** — split out of `tokenRail.tsx` so the
 * deck's walk (`deckWalk.ts`) can ask where the pile is drawn without importing a grip, two
 * drag hooks and `DeckTokensPanel`. That walk is reached from `features/card`'s two modals, and a
 * rail slot is the one thing they need from here. `tokenRail.tsx` re-exports all three, so the
 * views still find them beside `TOKEN_ITEM`.
 */

/**
 * Where the pile sits among `railLength` rail piles: `stored` when it is a slot the rail has,
 * else `railLength` (last). `-1` is last by definition.
 *
 * **Anything that is not a whole number in `[0, railLength]` is last**, and that is one rule
 * rather than three: `-1` (the column's default and what a move to the end writes), an index the
 * rail has since lost (the reader put the pile at 3, then switched two piles back on — review
 * focus 2), and a `NaN` or a fraction that no write of this app produces but a synced row from a
 * build that does not know the column could. Last is where every deck's pile was before the
 * column existed, so it is the one answer that is never a surprise.
 */
export function tokenRailSlot(stored: number, railLength: number): number {
  return Number.isInteger(stored) && stored >= 0 && stored <= railLength ? stored : railLength;
}

/**
 * The value to store for slot `slot` of a rail of `railLength`: `-1` for the last slot.
 *
 * **Last is stored as `-1` and never as the length**, so the pile *stays* last: a pile switched
 * on or off later changes the rail's length, and a stored `2` on a rail that grew to three would
 * leave the tokens above the newcomer, which is not where the reader put them.
 */
export function storedRailIndex(slot: number, railLength: number): number {
  return slot >= railLength ? -1 : slot;
}

/**
 * `items` with `pile` inserted at `slot`.
 *
 * Total in the same way {@link tokenRailSlot} is — a slot the list does not have puts the pile
 * last — because a view draws what this answers and a pile that went missing is the one bug the
 * index must never be able to cause.
 */
export function withTokenPile<T, P>(items: readonly T[], slot: number, pile: P): (T | P)[] {
  const at = tokenRailSlot(slot, items.length);
  return [...items.slice(0, at), pile, ...items.slice(at)];
}
