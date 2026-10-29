/**
 * What a booster is worth: on average, how widely, and where one opened pack stands among
 * ten thousand (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §3) — botbox.dev's
 * *Expected Value & Pack Statistics*, drawn from the same sheets the packs are opened from.
 *
 * **Prices come in as a function** ({@link PriceOf}), at the reader's marketplace, so nothing here
 * knows where a figure was read. An unpriced card counts 0 in every sum — the em dash on its tile
 * says so; a sum cannot.
 */
import type { BoosterProduct, BoosterSet, FinishPrices } from "@/lib/ipc";
import {
  drawSlot,
  drawVariant,
  prepareProduct,
  walkSealed,
  type ColorsOf,
  type OpenedCard,
} from "./open";
import type { Rng } from "./rng";

/** A printing's price in a finish, or `null` when the marketplace quotes none. */
export type PriceOf = (cardId: string, foil: boolean) => number | null;

/**
 * The figure an opened card is worth, from its per-finish prices (spec §2): a foil card at its foil
 * price, else nonfoil, else etched; a non-foil card at its nonfoil price, else foil, else etched.
 *
 * **The fallback is a finish, never a marketplace** — a printing only made in foil is opened from a
 * non-foil sheet now and then (MTGJSON's sheets do not say finish per card), and its one price is
 * the price of the card that was opened. `undefined` prices (a card the read did not answer) are
 * `null`.
 */
export function finishPrice(prices: FinishPrices | undefined, foil: boolean): number | null {
  if (prices === undefined) return null;
  return foil
    ? (prices.foil ?? prices.nonfoil ?? prices.etched)
    : (prices.nonfoil ?? prices.foil ?? prices.etched);
}

/** The price a sum counts: an unpriced card is 0. */
function counted(priceOf: PriceOf, cardId: string, foil: boolean): number {
  return priceOf(cardId, foil) ?? 0;
}

/** One sheet's mean and variance per card drawn, and what a `fixed` sheet always adds. */
interface SheetMoments {
  mean: number;
  variance: number;
  /** A fixed sheet: the whole of what one slot of it is worth (and its variance is 0). */
  fixedSum: number | null;
}

function sheetMoments(product: BoosterProduct, priceOf: PriceOf): Map<string, SheetMoments> {
  const out = new Map<string, SheetMoments>();
  for (const sheet of product.sheets) {
    if (sheet.fixed) {
      let sum = 0;
      for (const c of sheet.cards) sum += c.weight * counted(priceOf, c.cardId, sheet.foil);
      out.set(sheet.name, { mean: 0, variance: 0, fixedSum: sum });
      continue;
    }
    let total = 0;
    let first = 0;
    let second = 0;
    for (const c of sheet.cards) {
      if (c.weight <= 0) continue;
      const p = counted(priceOf, c.cardId, sheet.foil);
      total += c.weight;
      first += c.weight * p;
      second += c.weight * p * p;
    }
    const mean = total > 0 ? first / total : 0;
    const variance = total > 0 ? Math.max(0, second / total - mean * mean) : 0;
    out.set(sheet.name, { mean, variance, fixedSum: null });
  }
  return out;
}

/** Each variant's probability, mean and variance. */
function variantMoments(
  product: BoosterProduct,
  priceOf: PriceOf,
): { p: number; mean: number; variance: number }[] {
  const sheets = sheetMoments(product, priceOf);
  const total = product.variants.reduce((s, v) => s + Math.max(0, v.weight), 0);
  if (total <= 0) return [];
  return product.variants.map((v) => {
    let mean = 0;
    let variance = 0;
    for (const slot of v.slots) {
      const m = sheets.get(slot.sheet);
      if (m === undefined) continue;
      if (m.fixedSum !== null) {
        mean += m.fixedSum;
      } else {
        mean += slot.count * m.mean;
        variance += slot.count * m.variance;
      }
    }
    return { p: Math.max(0, v.weight) / total, mean, variance };
  });
}

/**
 * The average value of one booster: per sheet the weighted mean price, times the slot's count,
 * summed per variant, and the variants weighted by how often they are opened. A fixed sheet adds
 * every card `weight` times. `balanceColors` is not in the figure — it moves which commons are
 * opened, and the simulation, which honours it, is the check.
 */
export function expectedValue(product: BoosterProduct, priceOf: PriceOf): number {
  return variantMoments(product, priceOf).reduce((s, v) => s + v.p * v.mean, 0);
}

/**
 * The variance of one booster's value: within a variant `Σ count·Var(sheet)`, as if each card were
 * drawn with replacement, averaged over the variants, plus the variance of the variants' means
 * (the law of total variance). Drawing without replacement makes the true figure a little smaller;
 * the simulation does not make that approximation.
 */
export function variance(product: BoosterProduct, priceOf: PriceOf): number {
  const vs = variantMoments(product, priceOf);
  const ev = vs.reduce((s, v) => s + v.p * v.mean, 0);
  return vs.reduce((s, v) => s + v.p * (v.variance + (v.mean - ev) ** 2), 0);
}

/** What these cards are worth together — unpriced cards count 0. */
export function packValue(cards: readonly OpenedCard[], priceOf: PriceOf): number {
  let sum = 0;
  for (const c of cards) sum += counted(priceOf, c.cardId, c.foil);
  return sum;
}

/**
 * `n` boosters' values, opened exactly as {@link openBooster} opens one (variants, slots, without
 * replacement, colour balance), sorted ascending. Prices are read once per sheet card up front,
 * so ten thousand packs cost a few milliseconds of draws rather than a hundred thousand lookups.
 */
export function simulate(
  product: BoosterProduct,
  priceOf: PriceOf,
  n: number,
  rng: Rng,
  colorsOf?: ColorsOf,
): Float64Array {
  const prepared = prepareProduct(product, colorsOf);
  const prices = new Map<string, Float64Array>();
  for (const sheet of product.sheets) {
    prices.set(
      sheet.name,
      Float64Array.from(sheet.cards, (c) => counted(priceOf, c.cardId, sheet.foil)),
    );
  }
  const out = new Float64Array(Math.max(0, n));
  for (let k = 0; k < out.length; k++) {
    const v = drawVariant(prepared, rng);
    if (v < 0) continue;
    let sum = 0;
    for (const slot of product.variants[v].slots) {
      const sheet = prepared.sheets.get(slot.sheet);
      const worth = prices.get(slot.sheet);
      if (sheet === undefined || worth === undefined) continue;
      drawSlot(sheet, slot.count, rng, (i) => {
        sum += worth[i];
      });
    }
    out[k] = sum;
  }
  return out.sort();
}

/** The least index whose value is `>= value` (`lower`) or `> value` (`upper`). */
function bound(sorted: Float64Array, value: number, upper: boolean): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (upper ? sorted[mid] <= value : sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where `value` stands among the sorted values, 0–100: the share below it plus half the share equal
 * to it (the mid-rank). Mid-rank because pack values tie often — a pack of bulk is worth exactly
 * what many others are — and a pack tied with half the table is the 50th percentile, not the 0th
 * or the 100th. `0` for no values.
 */
export function percentileOf(sorted: Float64Array, value: number): number {
  if (sorted.length === 0) return 0;
  const below = bound(sorted, value, false);
  const equal = bound(sorted, value, true) - below;
  return ((below + equal / 2) / sorted.length) * 100;
}

/** The middle of the sorted values (the mean of the middle two for an even count); `0` for none. */
export function median(sorted: Float64Array): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = n >>> 1;
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The chance, 0–1, that a pack is worth **more** than `price` — what botbox.dev calls the chance to
 * beat what you paid. A pack worth exactly the price has not beaten it.
 */
export function chanceToBeat(sorted: Float64Array, price: number): number {
  if (sorted.length === 0) return 0;
  return (sorted.length - bound(sorted, price, true)) / sorted.length;
}

/** One bar of {@link histogram}: values in `[from, to)` (the last bin also holds `to`). */
export interface HistogramBin {
  from: number;
  to: number;
  count: number;
}

/** The share of the values the equal-width bins span; the rest is folded into the last bin. */
const TAIL_CUT = 0.99;

/**
 * The sorted values in `bins` bars.
 *
 * **Equal width from the least value to the 99th percentile, with the tail folded into the last
 * bin** (whose `to` is the greatest value). A booster's value is skewed hard right — one pack in
 * a few hundred holds the chase mythic, and a collector booster's best is a hundred times its
 * median — so bins across the whole range would put nearly every pack in the first bar and leave
 * the rest of the chart empty air. Cutting at the 99th percentile keeps the shape of the bulk
 * readable on a plain linear axis, where a log axis would make a reader decode the scale first;
 * the folded tail is the last bar, and the chart says so.
 */
export function histogram(sorted: Float64Array, bins: number): HistogramBin[] {
  const n = sorted.length;
  if (n === 0 || bins < 1) return [];
  const lo = sorted[0];
  const max = sorted[n - 1];
  const cut = sorted[Math.min(n - 1, Math.floor(TAIL_CUT * (n - 1)))];
  if (cut <= lo || bins === 1) return [{ from: lo, to: max, count: n }];
  const width = (cut - lo) / bins;
  const out: HistogramBin[] = Array.from({ length: bins }, (_, i) => ({
    from: lo + i * width,
    to: i === bins - 1 ? max : lo + (i + 1) * width,
    count: 0,
  }));
  for (let i = 0; i < n; i++) {
    const at = Math.min(bins - 1, Math.floor((sorted[i] - lo) / width));
    out[at].count++;
  }
  return out;
}

/**
 * A sealed product's figures: the sum of its boosters' (and its fixed cards'). The mean and
 * variance add, the boosters being independent; the simulated values are `n` boxes, each the sum
 * of one draw per booster from that product's own `n` simulated packs — a box's distribution
 * built from its packs' rather than by opening every pack of every box again.
 */
export function sealedFigures(
  set: BoosterSet,
  uuid: string,
  priceOf: PriceOf,
  n: number,
  rng: Rng,
  colorsOf?: ColorsOf,
): { ev: number; sd: number; simulated: Float64Array } {
  const counts = new Map<BoosterProduct, number>();
  let fixed = 0;
  walkSealed(set, uuid, {
    booster: (product) => counts.set(product, (counts.get(product) ?? 0) + 1),
    card: (card) => {
      fixed += counted(priceOf, card.cardId, card.foil);
    },
    skip: () => {},
  });
  let ev = fixed;
  let v = 0;
  const pools: { values: Float64Array; count: number }[] = [];
  for (const [product, count] of counts) {
    ev += count * expectedValue(product, priceOf);
    v += count * variance(product, priceOf);
    pools.push({ values: simulate(product, priceOf, n, rng, colorsOf), count });
  }
  const simulated = new Float64Array(Math.max(0, n));
  for (let k = 0; k < simulated.length; k++) {
    let sum = fixed;
    for (const pool of pools) {
      const m = pool.values.length;
      if (m === 0) continue;
      for (let i = 0; i < pool.count; i++) sum += pool.values[Math.floor(rng() * m)];
    }
    simulated[k] = sum;
  }
  return { ev, sd: Math.sqrt(v), simulated: simulated.sort() };
}
