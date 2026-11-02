import type { BelowMinimum, CollectionValue } from "@/lib/ipc";
import { parsePurchasePrice } from "@/lib/prices";

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
 *
 * **A bulk price is Open Packs' alone** (issue #1477, {@link ReducedSettings}): each card under the
 * minimum is counted at it rather than at nothing. The collection's setting has none.
 */

/** No reduced price: every card counted, at full price. `collection_value::CollectionValue`'s own
 *  default, repeated for a read still in flight. */
export const DEFAULT_COLLECTION_VALUE: CollectionValue = { sellPercent: 100, minimumValue: 0 };

/**
 * The settings {@link reducedValue} reduces by: the collection's two figures, and a bulk price that
 * only Open Packs sets (`features/draft/packs/reducedPick.ts`, issue #1477). Absent or `0`, a card
 * under the minimum is taken out, as it always was.
 */
export interface ReducedSettings extends CollectionValue {
  /** What each card under the minimum is worth instead of its market price. A sale figure — what a
   *  buyer pays a card for bulk — so the sell percentage never reduces it again. Only counted while
   *  a minimum is set. */
  bulkPrice?: number;
}

/** The bulk price as the sum counts it: `undefined` with none, or with no minimum to be under. */
export function bulkOf(settings: ReducedSettings): number | undefined {
  const bulk = settings.bulkPrice ?? 0;
  return bulk > 0 && minimumOf(settings) !== undefined ? bulk : undefined;
}

/** Whether these settings change anything at all. Neither set, the app reads as it always did. */
export function reducesValue(settings: CollectionValue): boolean {
  return settings.sellPercent < 100 || settings.minimumValue > 0;
}

/** The minimum as a query asks it: `undefined` when there is none, so a read's key and payload are
 *  exactly what they were before this setting existed. */
export function minimumOf(settings: CollectionValue): number | undefined {
  return settings.minimumValue > 0 ? settings.minimumValue : undefined;
}

/** A sell percentage as a box reads it: `70`, `70%` or `70.5`. Empty is the default (100), and
 *  anything outside above 0 and at most 100 is `null`, a refusal. */
export function parseSellPercent(text: string): number | null {
  const trimmed = text.replace("%", "").trim();
  if (trimmed === "") return DEFAULT_COLLECTION_VALUE.sellPercent;
  const value = Number(trimmed.replace(",", "."));
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
}

/** A minimum card value as a box reads it. Empty is no minimum; an unreadable price is `null`. */
export function parseMinimumValue(text: string): number | null {
  if (text.trim() === "") return DEFAULT_COLLECTION_VALUE.minimumValue;
  const value = parsePurchasePrice(text);
  return value === undefined ? null : value;
}

/** A bulk price as a box reads it — the minimum's rule: empty is none (`0`), an unreadable price is
 *  `null`. */
export function parseBulkPrice(text: string): number | null {
  return parseMinimumValue(text);
}

/** What `values` leave under `minimum`: each priced copy strictly below it, at its own price. An
 *  unpriced copy (`null`) is not below anything — the collection's rule, which SQL answers there. */
export function belowMinimumOf(
  values: Iterable<number | null>,
  minimum: number,
): BelowMinimum {
  let cards = 0;
  let value = 0;
  for (const v of values) {
    if (v !== null && v < minimum) {
      cards += 1;
      value += v;
    }
  }
  return { cards, value };
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
  /** The cards under the minimum counted back at the bulk price, and what they add; `null` with no
   *  bulk price (or no minimum). Added after the percentage, which never reduces it. */
  bulk: { price: number; cards: number; value: number } | null;
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
 *
 * **A bulk price is added after the percentage** (issue #1477): `(full − below) × percent + cards
 * below × bulk`. It is already what a buyer pays for such a card, so taking a percentage off it
 * would reduce it twice.
 */
export function reducedValue(
  full: number | null,
  below: BelowMinimum | undefined,
  settings: ReducedSettings,
): ReducedValue | null {
  if (full === null || !reducesValue(settings)) return null;
  const minimum = minimumOf(settings);
  if (minimum !== undefined && below === undefined) return null;
  const whole = cents(full);
  const under = minimum === undefined || below === undefined ? null : below;
  const taken = under === null ? 0 : cents(under.value);
  const counted = Math.max(0, cents(whole - taken));
  const sold = settings.sellPercent < 100 ? cents((counted * settings.sellPercent) / 100) : counted;
  const bulkPrice = bulkOf(settings);
  const bulk =
    bulkPrice === undefined || under === null
      ? null
      : { price: bulkPrice, cards: under.cards, value: cents(under.cards * bulkPrice) };
  const reduced = bulk === null ? sold : cents(sold + bulk.value);
  return {
    full: whole,
    below:
      minimum === undefined || under === null
        ? null
        : { minimum, cards: under.cards, value: taken },
    sale:
      settings.sellPercent < 100
        ? { percent: settings.sellPercent, lost: cents(counted - sold) }
        : null,
    bulk,
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
