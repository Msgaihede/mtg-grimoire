/**
 * A hand-made booster for the suites: small enough to work its figures out by hand (the numbers in
 * `value.test.ts` are written from this file), with every flag a sheet can carry.
 *
 * - `common`: ten commons, two of each colour, `balanceColors`, 10¢ each.
 * - `rare`: a rare (weight 7, $1) and a mythic (weight 1, $9) — a mythic one pack in eight.
 * - `foil`: two foils, weights 1 and 3, $2 and $6 in foil.
 * - `land`: a fixed sheet of one basic, 50¢.
 *
 * Variant A (weight 3): 5 commons, a rare, the land. Variant B (weight 1): 4 commons, a rare, a
 * foil, the land.
 */
import type { BoosterProduct, BoosterSet, FinishPrices } from "@/lib/ipc";
import type { PriceOf } from "./value";
import { finishPrice } from "./value";

const COMMONS = ["w1", "w2", "u1", "u2", "b1", "b2", "r1", "r2", "g1", "g2"];

export const PRODUCT: BoosterProduct = {
  key: "play",
  name: "Test Play Booster",
  totalWeight: 4,
  variants: [
    {
      weight: 3,
      slots: [
        { sheet: "common", count: 5 },
        { sheet: "rare", count: 1 },
        { sheet: "land", count: 1 },
      ],
    },
    {
      weight: 1,
      slots: [
        { sheet: "common", count: 4 },
        { sheet: "rare", count: 1 },
        { sheet: "foil", count: 1 },
        { sheet: "land", count: 1 },
      ],
    },
  ],
  sheets: [
    {
      name: "common",
      foil: false,
      fixed: false,
      allowDuplicates: false,
      balanceColors: true,
      totalWeight: 10,
      cards: COMMONS.map((id) => ({ cardId: `c-${id}`, weight: 1 })),
    },
    {
      name: "rare",
      foil: false,
      fixed: false,
      allowDuplicates: false,
      balanceColors: false,
      totalWeight: 8,
      cards: [
        { cardId: "rare", weight: 7 },
        { cardId: "mythic", weight: 1 },
      ],
    },
    {
      name: "foil",
      foil: true,
      fixed: false,
      allowDuplicates: false,
      balanceColors: false,
      totalWeight: 4,
      cards: [
        { cardId: "f1", weight: 1 },
        { cardId: "f2", weight: 3 },
      ],
    },
    {
      name: "land",
      foil: false,
      fixed: true,
      allowDuplicates: false,
      balanceColors: false,
      totalWeight: 1,
      cards: [{ cardId: "land", weight: 1 }],
    },
  ],
};

/** `c-w1` → `"W"`; everything else colourless. */
export const colorsOf = (cardId: string): string | null =>
  cardId.startsWith("c-") ? cardId[2].toUpperCase() : "";

const price = (nonfoil: number | null, foil: number | null = null): FinishPrices => ({
  nonfoil,
  foil,
  etched: null,
});

export const PRICES = new Map<string, FinishPrices>([
  ...COMMONS.map((id): [string, FinishPrices] => [`c-${id}`, price(0.1)]),
  ["rare", price(1)],
  ["mythic", price(9)],
  ["f1", price(null, 2)],
  ["f2", price(null, 6)],
  ["land", price(0.5)],
  ["promo", price(null, 4)],
]);

export const priceOf: PriceOf = (cardId, foil) => finishPrice(PRICES.get(cardId), foil);

/**
 * A set around {@link PRODUCT}: a box of three of its boosters, two of another set's (which cannot
 * be opened) and a bundle; the bundle holds two boosters and a foil promo, and names a sealed
 * product the file does not list.
 */
export const SET: BoosterSet = {
  code: "tst",
  name: "Test Set",
  releaseDate: "2026-01-01",
  products: [PRODUCT, { ...PRODUCT, key: "collector", name: "Test Collector Booster" }],
  sealed: [
    {
      uuid: "box",
      name: "Test Play Booster Box",
      category: "booster_box",
      subtype: "play",
      packs: [
        { set: "tst", product: "play", count: 3 },
        { set: "oth", product: "play", count: 2 },
      ],
      sealed: [
        { uuid: "bundle", set: "tst", count: 1 },
        { uuid: "missing", set: "tst", count: 1 },
      ],
      cards: [],
    },
    {
      uuid: "bundle",
      name: "Test Bundle",
      category: "bundle",
      subtype: null,
      packs: [{ set: "TST", product: "play", count: 2 }],
      sealed: [],
      cards: [{ cardId: "promo", foil: true }],
    },
  ],
  cards: [],
  fetchedAt: 0,
};
