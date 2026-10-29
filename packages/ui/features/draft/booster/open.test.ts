import { describe, expect, it } from "vitest";
import type { BoosterProduct, BoosterSheet } from "@/lib/ipc";
import { colorsOf, PRODUCT, SET } from "./fixture";
import { draftProduct, openBooster, openSealed, SEALED_SHEET } from "./open";
import { mulberry32, randomSeed } from "./rng";

/** A product of one slot of `sheet`. */
function oneSlot(sheet: Partial<BoosterSheet>, count: number): BoosterProduct {
  const full: BoosterSheet = {
    name: "s",
    foil: false,
    fixed: false,
    allowDuplicates: false,
    balanceColors: false,
    totalWeight: 0,
    cards: [],
    ...sheet,
  };
  return {
    key: "p",
    name: "P",
    totalWeight: 1,
    variants: [{ weight: 1, slots: [{ sheet: full.name, count }] }],
    sheets: [full],
  };
}

describe("mulberry32", () => {
  it("is deterministic per seed and stays in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const c = mulberry32(43);
    const first = Array.from({ length: 100 }, a);
    expect(Array.from({ length: 100 }, b)).toEqual(first);
    expect(Array.from({ length: 100 }, c)).not.toEqual(first);
    for (const x of first) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it("randomSeed is a 32-bit unsigned integer", () => {
    const seed = randomSeed();
    expect(Number.isInteger(seed)).toBe(true);
    expect(seed).toBeGreaterThanOrEqual(0);
    expect(seed).toBeLessThan(2 ** 32);
  });
});

describe("openBooster", () => {
  it("opens the same pack from the same seed", () => {
    expect(openBooster(PRODUCT, mulberry32(7))).toEqual(openBooster(PRODUCT, mulberry32(7)));
  });

  it("opens seven cards in either variant, the land once, foil only from the foil sheet", () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 500; i++) {
      const pack = openBooster(PRODUCT, rng);
      expect(pack).toHaveLength(7);
      expect(pack.filter((c) => c.cardId === "land")).toHaveLength(1);
      expect(pack.filter((c) => c.sheet === "rare")).toHaveLength(1);
      for (const card of pack) expect(card.foil).toBe(card.sheet === "foil");
    }
  });

  it("honours the variants' and the cards' weights", () => {
    const rng = mulberry32(2024);
    const n = 8000;
    let variantB = 0;
    let mythic = 0;
    let f2 = 0;
    for (let i = 0; i < n; i++) {
      const pack = openBooster(PRODUCT, rng);
      if (pack.some((c) => c.sheet === "foil")) variantB++;
      if (pack.some((c) => c.cardId === "mythic")) mythic++;
      if (pack.some((c) => c.cardId === "f2")) f2++;
    }
    expect(variantB / n).toBeCloseTo(0.25, 1);
    expect(Math.abs(mythic / n - 1 / 8)).toBeLessThan(0.015);
    // f2 is three of the foil sheet's four weights, in the quarter of packs that have a foil.
    expect(Math.abs(f2 / n - 0.25 * 0.75)).toBeLessThan(0.015);
  });

  it("never opens a card twice from a sheet without duplicates", () => {
    const rng = mulberry32(5);
    for (let i = 0; i < 500; i++) {
      const commons = openBooster(PRODUCT, rng)
        .filter((c) => c.sheet === "common")
        .map((c) => c.cardId);
      expect(new Set(commons).size).toBe(commons.length);
    }
  });

  it("balances a slot of five commons across the colours, given colours", () => {
    const rng = mulberry32(9);
    for (let i = 0; i < 300; i++) {
      const pack = openBooster(PRODUCT, rng, colorsOf);
      const commons = pack.filter((c) => c.sheet === "common");
      if (commons.length !== 5) continue;
      const colours = new Set(commons.map((c) => colorsOf(c.cardId)));
      expect([...colours].sort()).toEqual(["B", "G", "R", "U", "W"]);
    }
  });

  it("does not balance without colours: some packs miss a colour", () => {
    const rng = mulberry32(9);
    let unbalanced = 0;
    for (let i = 0; i < 300; i++) {
      const commons = openBooster(PRODUCT, rng).filter((c) => c.sheet === "common");
      if (commons.length === 5 && new Set(commons.map((c) => colorsOf(c.cardId))).size < 5) {
        unbalanced++;
      }
    }
    expect(unbalanced).toBeGreaterThan(0);
  });

  it("draws with replacement where the sheet allows duplicates", () => {
    const product = oneSlot({ allowDuplicates: true, cards: [{ cardId: "x", weight: 1 }] }, 3);
    expect(openBooster(product, mulberry32(1)).map((c) => c.cardId)).toEqual(["x", "x", "x"]);
  });

  it("holds only what a small sheet has, without replacement", () => {
    const product = oneSlot(
      {
        cards: [
          { cardId: "x", weight: 1 },
          { cardId: "y", weight: 1000 },
        ],
      },
      3,
    );
    const ids = openBooster(product, mulberry32(1)).map((c) => c.cardId);
    expect(ids.sort()).toEqual(["x", "y"]);
  });

  it("gives every card of a fixed sheet its weight in copies", () => {
    const product = oneSlot(
      {
        fixed: true,
        cards: [
          { cardId: "a", weight: 2 },
          { cardId: "b", weight: 1 },
        ],
      },
      3,
    );
    expect(openBooster(product, mulberry32(1)).map((c) => c.cardId)).toEqual(["a", "a", "b"]);
  });

  it("skips weightless cards", () => {
    const product = oneSlot(
      {
        allowDuplicates: true,
        cards: [
          { cardId: "never", weight: 0 },
          { cardId: "always", weight: 1 },
        ],
      },
      50,
    );
    expect(new Set(openBooster(product, mulberry32(3)).map((c) => c.cardId))).toEqual(
      new Set(["always"]),
    );
  });
});

describe("openSealed", () => {
  it("opens a box's own boosters, and its bundle's, and reports what it cannot open", () => {
    const opened = openSealed(SET, "box", mulberry32(11));
    // Three in the box and two in the bundle; another set's two and the unlisted product skipped.
    expect(opened.boosters).toHaveLength(5);
    expect(opened.boosters.every((b) => b.product === "play" && b.set === "tst")).toBe(true);
    expect(opened.boosters.every((b) => b.cards.length === 7)).toBe(true);
    expect(opened.extras).toEqual([{ cardId: "promo", foil: true, sheet: SEALED_SHEET }]);
    expect(opened.skipped).toBe(3);
  });

  it("answers nothing for a product the set does not list", () => {
    expect(openSealed(SET, "nope", mulberry32(1))).toEqual({
      boosters: [],
      extras: [],
      skipped: 0,
    });
  });
});

describe("draftProduct", () => {
  it("prefers play, then draft, then default, then set", () => {
    const keyed = (...keys: string[]) => ({
      ...SET,
      products: keys.map((key) => ({ ...PRODUCT, key })),
    });
    expect(draftProduct(keyed("collector", "set", "draft", "play"))?.key).toBe("play");
    expect(draftProduct(keyed("collector", "set", "draft"))?.key).toBe("draft");
    expect(draftProduct(keyed("set", "default"))?.key).toBe("default");
    expect(draftProduct(keyed("collector", "set"))?.key).toBe("set");
    expect(draftProduct(keyed("collector"))).toBeNull();
  });
});
