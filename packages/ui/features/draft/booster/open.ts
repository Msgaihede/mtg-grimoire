/**
 * Opening a booster, and a sealed product of boosters — the one generator Packs and Draft share,
 * so a drafted booster is collated exactly as an opened one
 * (`docs/superpowers/specs/2026-10-29-draft-and-packs-design.md` §3).
 *
 * **MTGJSON's model, read as it is written.** A product is a set of variants, each drawn with its
 * weight; a variant is slots, each `count` cards of one sheet; a sheet is cards with weights. The
 * flags on a sheet change how its slot draws: `fixed` puts every card in `weight` times,
 * `allowDuplicates` draws with replacement, and `balanceColors` — set on the commons of most play
 * and draft boosters — makes sure a slot of five or more commons holds a card of each colour.
 *
 * Pure over the wire's `BoosterProduct`: nothing here reads a price, a window or the clock. The
 * random numbers come in as a seeded {@link Rng}, so a test can pin the exact cards.
 */
import type { BoosterProduct, BoosterSet, BoosterSheet, SealedCard } from "@/lib/ipc";
import type { Rng } from "./rng";

/** One card out of a pack: which printing, in which finish, from which sheet. */
export interface OpenedCard {
  cardId: string;
  /** From a `foil` sheet — or a sealed product's foil extra. */
  foil: boolean;
  /** The sheet's name, or {@link SEALED_SHEET} for a card a sealed product always holds. */
  sheet: string;
}

/** The sheet name an {@link OpenedCard} carries when a sealed product held it outright. */
export const SEALED_SHEET = "sealed";

/** A card's colours as the corpus stores them (`"WU"`; `""` for colourless), `null` unknown. */
export type ColorsOf = (cardId: string) => string | null;

/** The colours `balanceColors` guarantees, in WUBRG order. */
const BALANCE = ["W", "U", "B", "R", "G"] as const;

/** The least slot `balanceColors` is applied to — MTGJSON's own threshold. */
export const BALANCE_MIN = 5;

/**
 * A sheet made ready for thousands of draws: the weights' running sums for a binary search, and
 * for `balanceColors` the cards of each colour.
 *
 * Built once per product (and colour lookup) and kept in a `WeakMap`, so the 10 000 packs of a
 * simulation pay for it once rather than per pack.
 */
export interface PreparedSheet {
  sheet: BoosterSheet;
  /** `cumulative[i]` is the weight of cards `0..=i`. */
  cumulative: Float64Array;
  total: number;
  /** Per colour of {@link BALANCE}, the indices of cards of that colour — mono-coloured ones
   *  where the sheet has any, else every card that has the colour at all. */
  byColor: number[][] | null;
}

/** A product made ready: its variants' running sums and its sheets by name. */
export interface PreparedProduct {
  product: BoosterProduct;
  variantCumulative: Float64Array;
  variantTotal: number;
  sheets: Map<string, PreparedSheet>;
}

function cumulativeOf(weights: readonly number[]): Float64Array {
  const out = new Float64Array(weights.length);
  let run = 0;
  for (let i = 0; i < weights.length; i++) {
    run += Math.max(0, weights[i]);
    out[i] = run;
  }
  return out;
}

/** The index whose running sum is the first past `target` — a weighted pick in `O(log n)`. */
function search(cumulative: Float64Array, target: number): number {
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumulative[mid] > target) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

function prepareSheet(sheet: BoosterSheet, colorsOf: ColorsOf | undefined): PreparedSheet {
  const cumulative = cumulativeOf(sheet.cards.map((c) => c.weight));
  const total = cumulative.length > 0 ? cumulative[cumulative.length - 1] : 0;
  let byColor: number[][] | null = null;
  if (sheet.balanceColors && colorsOf !== undefined) {
    const colors = sheet.cards.map((c) => colorsOf(c.cardId) ?? "");
    byColor = BALANCE.map((letter) => {
      const mono: number[] = [];
      const any: number[] = [];
      colors.forEach((c, i) => {
        if (sheet.cards[i].weight <= 0 || !c.includes(letter)) return;
        any.push(i);
        if (c === letter) mono.push(i);
      });
      return mono.length > 0 ? mono : any;
    });
  }
  return { sheet, cumulative, total, byColor };
}

const PREPARED = new WeakMap<
  BoosterProduct,
  { colorsOf: ColorsOf | undefined; prepared: PreparedProduct }
>();

/** {@link PreparedProduct} for `product`, from the cache when the same colour lookup made it. */
export function prepareProduct(product: BoosterProduct, colorsOf?: ColorsOf): PreparedProduct {
  const held = PREPARED.get(product);
  if (held !== undefined && held.colorsOf === colorsOf) return held.prepared;
  const variantCumulative = cumulativeOf(product.variants.map((v) => v.weight));
  const prepared: PreparedProduct = {
    product,
    variantCumulative,
    variantTotal:
      variantCumulative.length > 0 ? variantCumulative[variantCumulative.length - 1] : 0,
    sheets: new Map(product.sheets.map((s) => [s.name, prepareSheet(s, colorsOf)])),
  };
  PREPARED.set(product, { colorsOf, prepared });
  return prepared;
}

/** How many tries a rejected (already taken) draw gets before the slot walks what is left. */
const REJECTIONS = 32;

/**
 * One card of the sheet by weight, leaving out `taken` — sampling without replacement as
 * rejection sampling, which is exact: a draw from the whole sheet that is redrawn whenever it lands
 * on a taken card is a draw from the cards left, in their weights. A sheet nearly used up would
 * reject for a long time, so after {@link REJECTIONS} misses the cards left are walked directly.
 * `-1` when nothing is left.
 */
function drawOne(sheet: PreparedSheet, rng: Rng, taken: Set<number> | null): number {
  if (sheet.total <= 0) return -1;
  for (let i = 0; i < REJECTIONS; i++) {
    const at = search(sheet.cumulative, rng() * sheet.total);
    if (taken === null || !taken.has(at)) return at;
  }
  let left = 0;
  const weights = sheet.sheet.cards;
  for (let i = 0; i < weights.length; i++)
    if (!taken!.has(i)) left += Math.max(0, weights[i].weight);
  if (left <= 0) return -1;
  let target = rng() * left;
  for (let i = 0; i < weights.length; i++) {
    if (taken!.has(i)) continue;
    const w = Math.max(0, weights[i].weight);
    if (w <= 0) continue;
    if (target < w) return i;
    target -= w;
  }
  return -1;
}

/** One card of `among` (indices into the sheet) by weight, leaving out `taken`; `-1` for none. */
function drawAmong(
  sheet: PreparedSheet,
  among: readonly number[],
  rng: Rng,
  taken: Set<number> | null,
): number {
  let total = 0;
  for (const i of among) if (taken === null || !taken.has(i)) total += sheet.sheet.cards[i].weight;
  if (total <= 0) return -1;
  let target = rng() * total;
  let last = -1;
  for (const i of among) {
    if (taken !== null && taken.has(i)) continue;
    const w = sheet.sheet.cards[i].weight;
    if (w <= 0) continue;
    if (target < w) return i;
    target -= w;
    last = i;
  }
  // Rounding left the target a hair past the end: the last card left is the draw.
  return last;
}

/**
 * The cards one slot holds, as indices into its sheet, each passed to `emit`.
 *
 * **A `fixed` sheet ignores `count`**: it is a list rather than a draw (a Jumpstart pack's theme,
 * a box topper's one card), and MTGJSON writes its `count` as the sum of its weights anyway.
 */
export function drawSlot(
  sheet: PreparedSheet,
  count: number,
  rng: Rng,
  emit: (index: number) => void,
): void {
  const cards = sheet.sheet.cards;
  if (sheet.sheet.fixed) {
    cards.forEach((c, i) => {
      for (let k = 0; k < c.weight; k++) emit(i);
    });
    return;
  }
  const taken = sheet.sheet.allowDuplicates ? null : new Set<number>();
  let drawn = 0;
  if (sheet.byColor !== null && count >= BALANCE_MIN) {
    for (const among of sheet.byColor) {
      if (drawn >= count) break;
      if (among.length === 0) continue;
      const at = drawAmong(sheet, among, rng, taken);
      if (at < 0) continue;
      taken?.add(at);
      emit(at);
      drawn++;
    }
  }
  for (; drawn < count; drawn++) {
    const at = drawOne(sheet, rng, taken);
    // A sheet smaller than its slot, without replacement: the slot holds what the sheet has.
    if (at < 0) return;
    taken?.add(at);
    emit(at);
  }
}

/** The variant a pack is, by weight; `-1` for a product with none. */
export function drawVariant(prepared: PreparedProduct, rng: Rng): number {
  if (prepared.variantTotal <= 0) return -1;
  return search(prepared.variantCumulative, rng() * prepared.variantTotal);
}

/**
 * One booster of `product`: a variant by weight, then every slot of it from its sheet, in the
 * variant's slot order. `colorsOf` is what `balanceColors` reads; without it a balanced slot draws
 * by weight alone.
 */
export function openBooster(product: BoosterProduct, rng: Rng, colorsOf?: ColorsOf): OpenedCard[] {
  const prepared = prepareProduct(product, colorsOf);
  const v = drawVariant(prepared, rng);
  if (v < 0) return [];
  const out: OpenedCard[] = [];
  for (const slot of product.variants[v].slots) {
    const sheet = prepared.sheets.get(slot.sheet);
    if (sheet === undefined) continue;
    drawSlot(sheet, slot.count, rng, (i) =>
      out.push({ cardId: sheet.sheet.cards[i].cardId, foil: sheet.sheet.foil, sheet: slot.sheet }),
    );
  }
  return out;
}

/** A sealed product opened: each booster it held, and the cards it held outright. */
export interface OpenedSealed {
  boosters: { product: string; set: string; cards: OpenedCard[] }[];
  extras: OpenedCard[];
  /**
   * What it held that could not be opened: a booster of another set, or of a product this set's
   * file does not describe, counts one per booster; a sealed product inside it that the file does
   * not list counts one per copy. The page says so rather than pretending the box was smaller.
   */
  skipped: number;
}

/** How deep sealed products may nest — a case of boxes of packs is three; a cycle stops here. */
const MAX_DEPTH = 6;

/** What {@link walkSealed} hands its caller, in the order the product holds it. */
export interface SealedVisitor {
  booster: (product: BoosterProduct) => void;
  card: (card: SealedCard) => void;
  skip: (count: number) => void;
}

/**
 * Every booster and fixed card a sealed product holds, recursively — the one walk
 * {@link openSealed} and `value.ts`' figures share, so the two never disagree about a box.
 * Only this set's own products can be opened: the set file describes no other set's boosters.
 */
export function walkSealed(set: BoosterSet, uuid: string, visit: SealedVisitor, depth = 0): void {
  const sealed = set.sealed.find((s) => s.uuid === uuid);
  if (sealed === undefined) return;
  const own = set.code.toLowerCase();
  for (const pack of sealed.packs) {
    const product =
      pack.set.toLowerCase() === own ? set.products.find((p) => p.key === pack.product) : undefined;
    if (product === undefined) {
      visit.skip(pack.count);
      continue;
    }
    for (let i = 0; i < pack.count; i++) visit.booster(product);
  }
  for (const inner of sealed.sealed) {
    const known = set.sealed.some((s) => s.uuid === inner.uuid);
    if (!known || depth >= MAX_DEPTH) {
      visit.skip(inner.count);
      continue;
    }
    for (let i = 0; i < inner.count; i++) walkSealed(set, inner.uuid, visit, depth + 1);
  }
  for (const card of sealed.cards) visit.card(card);
}

/** A sealed product of `set`, opened: every booster in it, and its fixed cards. */
export function openSealed(
  set: BoosterSet,
  uuid: string,
  rng: Rng,
  colorsOf?: ColorsOf,
): OpenedSealed {
  const out: OpenedSealed = { boosters: [], extras: [], skipped: 0 };
  walkSealed(set, uuid, {
    booster: (product) =>
      out.boosters.push({
        product: product.key,
        set: set.code,
        cards: openBooster(product, rng, colorsOf),
      }),
    card: (card) => out.extras.push({ cardId: card.cardId, foil: card.foil, sheet: SEALED_SHEET }),
    skip: (count) => {
      out.skipped += count;
    },
  });
  return out;
}

/** The products a draft would open, in the order it prefers them. */
const DRAFT_KEYS = ["play", "draft", "default", "set"] as const;

/**
 * The booster a draft opens of `set`: its play booster, else its draft booster, else MTGJSON's
 * `default` (an older set's only booster), else its set booster; `null` when it has none of them
 * — a set of collector boosters alone is not drafted.
 */
export function draftProduct(set: BoosterSet): BoosterProduct | null {
  for (const key of DRAFT_KEYS) {
    const found = set.products.find((p) => p.key === key);
    if (found !== undefined) return found;
  }
  return null;
}
