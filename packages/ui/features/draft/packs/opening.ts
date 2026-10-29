/**
 * The Packs page's conclusions, pure: what one press opened, what the product is worth, and the
 * order the opened cards are laid out in. The components only draw these.
 */
import type { BoosterCard, BoosterSet } from "@/lib/ipc";
import { openBooster, openSealed, type ColorsOf, type OpenedCard } from "../booster/open";
import { mulberry32 } from "../booster/rng";
import {
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
  let simulated = new Float64Array(0);
  if (openable.kind === "booster") {
    const product = set.products.find((p) => p.key === openable.id);
    if (product !== undefined) {
      ev = expectedValue(product, priceOf);
      sd = Math.sqrt(variance(product, priceOf));
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

/** Mythic first; a rarity the four do not name (`special`, `bonus`) after common. */
const RARITY_RANK = new Map([
  ["mythic", 0],
  ["rare", 1],
  ["uncommon", 2],
  ["common", 3],
]);

function rarityRank(rarity: string | null | undefined): number {
  return (rarity == null ? undefined : RARITY_RANK.get(rarity)) ?? RARITY_RANK.size;
}

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
      d = rarityRank(facts.get(a.card.cardId)?.rarity) - rarityRank(facts.get(b.card.cardId)?.rarity);
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
