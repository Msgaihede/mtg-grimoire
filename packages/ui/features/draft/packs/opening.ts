/**
 * The Packs page's conclusions, pure: what one press opened, what the product is worth, and the
 * order the opened cards are laid out in. The components only draw these.
 */
import {
  belowMinimumOf,
  minimumOf,
  reducedCopy,
  reducedValue,
  reducesValue,
  type ReducedSettings,
  type ReducedValue,
} from "@/lib/collectionValue";
import type { BoosterCard, BoosterSet } from "@/lib/ipc";
import { rarityRank } from "@/lib/rarity";
import {
  openBooster,
  openSealed,
  walkSealed,
  type ColorsOf,
  type OpenedCard,
} from "../booster/open";
import { mulberry32 } from "../booster/rng";
import {
  expectedPrices,
  expectedValue,
  median,
  packValue,
  sealedFigures,
  simulate,
  variance,
  type PriceOf,
} from "../booster/value";
import type { Openable } from "./products";

/** Packs the distribution is simulated from — spec §3's n. */
export const SIMULATED = 10_000;

/**
 * The simulation's seed, fixed: the figures beside a pack are the product's, not the press's, so
 * opening another must not move the expected value by a cent of sampling noise.
 */
const SIMULATION_SEED = 0x5eed;

/** `colorsOf` over the set's own cards — what `balanceColors` reads. */
export function colorLookup(set: BoosterSet): ColorsOf {
  const colors = new Map(set.cards.map((c) => [c.cardId, c.colors]));
  return (cardId) => colors.get(cardId) ?? null;
}

/** What one press opened. */
export interface Opened {
  openable: Openable;
  seed: number;
  /** Every card, the boosters' in order and then the sealed product's own. */
  cards: OpenedCard[];
  /** Boosters opened — 1 for a booster. */
  boosters: number;
  /** Boosters (or sealed products) it held that could not be opened. */
  skipped: number;
}

/** Open `openable` of `set` from `seed`. */
export function openOne(set: BoosterSet, openable: Openable, seed: number): Opened {
  const rng = mulberry32(seed);
  const colorsOf = colorLookup(set);
  if (openable.kind === "booster") {
    const product = set.products.find((p) => p.key === openable.id);
    const cards = product === undefined ? [] : openBooster(product, rng, colorsOf);
    return { openable, seed, cards, boosters: product === undefined ? 0 : 1, skipped: 0 };
  }
  const sealed = openSealed(set, openable.id, rng, colorsOf);
  return {
    openable,
    seed,
    cards: [...sealed.boosters.flatMap((b) => b.cards), ...sealed.extras],
    boosters: sealed.boosters.length,
    skipped: sealed.skipped,
  };
}

/**
 * The expected value of `openable` alone — what the session's tally adds per press, without the
 * ten thousand packs {@link figuresOf} simulates.
 */
export function theoreticalValue(set: BoosterSet, openable: Openable, priceOf: PriceOf): number {
  const colorsOf = colorLookup(set);
  if (openable.kind === "booster") {
    const product = set.products.find((p) => p.key === openable.id);
    return product === undefined ? 0 : expectedValue(product, priceOf, colorsOf);
  }
  let ev = 0;
  walkSealed(set, openable.id, {
    booster: (product) => {
      ev += expectedValue(product, priceOf, colorsOf);
    },
    card: (card) => {
      ev += priceOf(card.cardId, card.foil) ?? 0;
    },
    skip: () => {},
  });
  return ev;
}

/**
 * Expected copies by price for `openable` — price → cards at it one press opens on average
 * (`expectedPrices`, a sealed product's boosters and its own cards added). `Σ price × copies` is
 * {@link theoreticalValue}; the session's tally keeps these so its expected total can be repriced
 * at the page's reduction after the set's sheets are gone (issue #1502).
 */
export function expectedOpening(
  set: BoosterSet,
  openable: Openable,
  priceOf: PriceOf,
): Map<number, number> {
  const colorsOf = colorLookup(set);
  const into = new Map<number, number>();
  if (openable.kind === "booster") {
    const product = set.products.find((p) => p.key === openable.id);
    return product === undefined ? into : expectedPrices(product, priceOf, colorsOf, into);
  }
  walkSealed(set, openable.id, {
    booster: (product) => {
      expectedPrices(product, priceOf, colorsOf, into);
    },
    card: (card) => {
      const p = priceOf(card.cardId, card.foil);
      if (p !== null) into.set(p, (into.get(p) ?? 0) + 1);
    },
    skip: () => {},
  });
  return into;
}

/** Two sets of expected copies added, as the tally keeps them: `[price, copies]` pairs. */
export function addExpected(
  kept: readonly (readonly [number, number])[],
  more: ReadonlyMap<number, number>,
): [number, number][] {
  const sum = new Map<number, number>(kept.map(([p, n]) => [p, n]));
  for (const [p, n] of more) sum.set(p, (sum.get(p) ?? 0) + n);
  return [...sum];
}

/** The expected value of what `copies` describe, each copy at `settings`' reduced price
 *  (`reducedCopy`) — the full price where they reduce nothing. */
export function expectedAt(
  copies: Iterable<readonly [number, number]>,
  settings: ReducedSettings,
): number {
  let sum = 0;
  for (const [p, n] of copies) sum += (reducedCopy(p, settings) ?? 0) * n;
  return sum;
}

/**
 * `priceOf` at the page's sell percentage, minimum and bulk price, card by card (`reducedCopy`):
 * what the expected value, the simulation, the histogram and the chance to beat a price are
 * figured at (issue #1502), so every figure on the page is the money the reader would see. The
 * same function back where the settings reduce nothing.
 */
export function reducedPrices(priceOf: PriceOf, settings: ReducedSettings): PriceOf {
  if (!reducesValue(settings)) return priceOf;
  return (cardId, foil) => reducedCopy(priceOf(cardId, foil), settings);
}

/** A product's figures, theoretical and simulated. */
export interface Figures {
  ev: number;
  sd: number;
  /** {@link SIMULATED} values, sorted ascending. */
  simulated: Float64Array;
  simulatedMean: number;
  median: number;
}

/** {@link Figures} for `openable` at these prices. */
export function figuresOf(
  set: BoosterSet,
  openable: Openable,
  priceOf: PriceOf,
  n: number = SIMULATED,
): Figures {
  const rng = mulberry32(SIMULATION_SEED);
  const colorsOf = colorLookup(set);
  let ev = 0;
  let sd = 0;
  let simulated: Float64Array = new Float64Array(0);
  if (openable.kind === "booster") {
    const product = set.products.find((p) => p.key === openable.id);
    if (product !== undefined) {
      ev = expectedValue(product, priceOf, colorsOf);
      sd = Math.sqrt(variance(product, priceOf, colorsOf));
      simulated = simulate(product, priceOf, n, rng, colorsOf);
    }
  } else {
    ({ ev, sd, simulated } = sealedFigures(set, openable.id, priceOf, n, rng, colorsOf));
  }
  let sum = 0;
  for (const v of simulated) sum += v;
  return {
    ev,
    sd,
    simulated,
    simulatedMean: simulated.length > 0 ? sum / simulated.length : 0,
    median: median(simulated),
  };
}

/** How the opened cards are laid out. */
export type CardSort = "price" | "rarity" | "number";

const NUMBER = new Intl.Collator("en", { numeric: true });

/**
 * The opened cards in `by` order, each with where it came from (`index`, for a stable key) —
 * price high to low (an unpriced card last), rarity high to low, or collector number. Ties fall
 * back to price, then to the opened order, so a pack lays out the same way every render.
 */
export function sortOpened(
  cards: readonly OpenedCard[],
  by: CardSort,
  priceOf: PriceOf,
  facts: ReadonlyMap<string, BoosterCard>,
): { card: OpenedCard; index: number; price: number | null }[] {
  const rows = cards.map((card, index) => ({
    card,
    index,
    price: priceOf(card.cardId, card.foil),
  }));
  const byPrice = (a: (typeof rows)[number], b: (typeof rows)[number]) =>
    (b.price ?? -1) - (a.price ?? -1);
  rows.sort((a, b) => {
    let d = 0;
    if (by === "rarity") {
      d =
        rarityRank(facts.get(a.card.cardId)?.rarity) - rarityRank(facts.get(b.card.cardId)?.rarity);
    } else if (by === "number") {
      const fa = facts.get(a.card.cardId);
      const fb = facts.get(b.card.cardId);
      d =
        (fa?.setCode ?? "").localeCompare(fb?.setCode ?? "") ||
        NUMBER.compare(fa?.collectorNumber ?? "", fb?.collectorNumber ?? "");
    }
    return d || byPrice(a, b) || a.index - b.index;
  });
  return rows;
}

/** What the opened cards are worth together. */
export function openedValue(opened: Opened, priceOf: PriceOf): number {
  return packValue(opened.cards, priceOf);
}

/** Each opened card's price, in the opened order — `null` for an unpriced one. */
export function openedPrices(opened: Opened, priceOf: PriceOf): (number | null)[] {
  return opened.cards.map((c) => priceOf(c.cardId, c.foil));
}

/**
 * `full` at the page's own sell percentage, minimum and bulk price (`reducedPick.ts`), from the
 * prices of the copies that make it up: the collection's sum (`reducedValue`), with the minimum
 * compared here per copy rather than in SQL. `null` where the figures reduce nothing.
 */
export function reducedOpening(
  full: number,
  prices: Iterable<number | null>,
  settings: ReducedSettings,
): ReducedValue | null {
  const minimum = minimumOf(settings);
  return reducedValue(
    full,
    minimum === undefined ? undefined : belowMinimumOf(prices, minimum),
    settings,
  );
}
