import type { BelowMinimum, CollectionValue } from "@/lib/ipc";

/**
 * The reduced price: what a reader expects to get for their cards rather than what the market
 * lists them at (issues #1449, #1450).
 *
 * **One sum, here, and every surface calls it.** Cards priced below the minimum are taken out, then
 * the sell percentage is applied to what is left, so the collection header, a folder heading and a
 * home widget cannot come to three answers. The minimum goes first because it is a fact about each
 * card's market price: a $0.60 card at 70% is still a card worth selling.
 *
 * **Rust answers the part only SQL can**: {@link BelowMinimum} is compared per copy. The percentage
 * never reaches a statement, so changing it asks nothing of the database.
 */

/** No reduced price: every card counted, at full price. `collection_value::CollectionValue`'s own
 *  default, repeated for a read still in flight. */
export const DEFAULT_COLLECTION_VALUE: CollectionValue = { sellPercent: 100, minimumValue: 0 };

/** Whether these settings change anything at all. Neither set, the app reads as it always did. */
export function reducesValue(settings: CollectionValue): boolean {
  return settings.sellPercent < 100 || settings.minimumValue > 0;
}

/** The minimum as a query asks it: `undefined` when there is none, so a read's key and payload are
 *  exactly what they were before this setting existed. */
export function minimumOf(settings: CollectionValue): number | undefined {
  return settings.minimumValue > 0 ? settings.minimumValue : undefined;
}

/** Whole cents. Each line of a breakdown is rounded before the next is taken from it, so the lines
 *  on screen add up to the total on screen. */
function cents(x: number): number {
  return Math.round(x * 100) / 100 + 0;
}

/** One value and how it was reduced, in the order a breakdown states it. */
export interface ReducedValue {
  /** The value as the market lists it. */
  full: number;
  /** The minimum and what fell under it; `null` with no minimum set. */
  below: (BelowMinimum & { minimum: number }) | null;
  /** The percentage and the money it took; `null` at 100%. */
  sale: { percent: number; lost: number } | null;
  /** What is left. */
  reduced: number;
}

/**
 * `full` reduced by `settings`, or `null` where there is nothing to say: the settings change
 * nothing, nothing is priced, or the read that answered predates the minimum now set.
 *
 * **`below` missing under a minimum is `null` rather than a guess.** A minimum just set is a new
 * query, and `keepPreviousData` holds the old answer for a moment. A figure that ignored the
 * minimum for that moment would be a wrong number that then jumps.
 */
export function reducedValue(
  full: number | null,
  below: BelowMinimum | undefined,
  settings: CollectionValue,
): ReducedValue | null {
  if (full === null || !reducesValue(settings)) return null;
  const minimum = minimumOf(settings);
  if (minimum !== undefined && below === undefined) return null;
  const whole = cents(full);
  const under = minimum === undefined || below === undefined ? null : below;
  const taken = under === null ? 0 : cents(under.value);
  const counted = Math.max(0, cents(whole - taken));
  const reduced = settings.sellPercent < 100 ? cents((counted * settings.sellPercent) / 100) : counted;
  return {
    full: whole,
    below:
      minimum === undefined || under === null
        ? null
        : { minimum, cards: under.cards, value: taken },
    sale:
      settings.sellPercent < 100
        ? { percent: settings.sellPercent, lost: cents(counted - reduced) }
        : null,
    reduced,
  };
}

/** Two {@link BelowMinimum}s added — a folder's and what is under it. `undefined` is a read that was
 *  asked no minimum, and it stays that way only while both are. */
export function addBelow(
  a: BelowMinimum | undefined,
  b: BelowMinimum | undefined,
): BelowMinimum | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { cards: a.cards + b.cards, value: a.value + b.value };
}

/** A point on the value graph, reduced: {@link reducedValue}'s sum over a period's own figures,
 *  with no breakdown to write. */
export function reducedPoint(
  total: number,
  below: number | undefined,
  settings: CollectionValue,
): number {
  return (Math.max(0, total - (minimumOf(settings) === undefined ? 0 : (below ?? 0))) *
    settings.sellPercent) /
    100;
}
