import { describe, expect, it } from "vitest";
import { applySort, ariaSortOf, sortRankOf, sortTermOf, type SortSpec } from "./sort";

const asc = { additive: false, firstDir: "asc" } as const;
const desc = { additive: false, firstDir: "desc" } as const;
const addAsc = { additive: true, firstDir: "asc" } as const;

describe("applySort", () => {
  it("starts a column in the direction that column asks for first", () => {
    expect(applySort([], "name", asc)).toEqual([{ key: "name", dir: "asc" }]);
    // Money and count columns open descending: "highest first" is what clicking one means.
    expect(applySort([], "price", desc)).toEqual([{ key: "price", dir: "desc" }]);
  });

  it("cycles a lone column through both directions and then off", () => {
    const one = applySort([], "name", asc);
    const two = applySort(one, "name", asc);
    expect(two).toEqual([{ key: "name", dir: "desc" }]);
    // Off, not back to ascending: the third press has to be able to mean "never mind",
    // or a reader who sorted by accident has no way back to the view's own order.
    expect(applySort(two, "name", asc)).toEqual([]);
  });

  it("replaces the whole sort when a plain click lands on another column", () => {
    const spec: SortSpec = [
      { key: "name", dir: "asc" },
      { key: "price", dir: "desc" },
    ];
    expect(applySort(spec, "rarity", asc)).toEqual([{ key: "rarity", dir: "asc" }]);
  });

  /**
   * A plain press on a column that is already *part* of a multi-key sort narrows to it
   * rather than cycling it — the reader who did not hold Shift asked for one column, and
   * flipping this one in place would leave the other keys silently deciding the order.
   */
  it("narrows to one column when a plain click lands on one already in the sort", () => {
    const spec: SortSpec = [
      { key: "rarity", dir: "asc" },
      { key: "price", dir: "desc" },
    ];
    expect(applySort(spec, "price", desc)).toEqual([{ key: "price", dir: "desc" }]);
  });

  it("appends with shift, keeping the terms already there and their order", () => {
    const spec = applySort([], "rarity", asc);
    expect(applySort(spec, "price", { additive: true, firstDir: "desc" })).toEqual([
      { key: "rarity", dir: "asc" },
      { key: "price", dir: "desc" },
    ]);
  });

  it("cycles a shifted column in place, and removes only that one", () => {
    const spec: SortSpec = [
      { key: "rarity", dir: "asc" },
      { key: "price", dir: "desc" },
    ];
    const flipped = applySort(spec, "rarity", addAsc);
    // In place: a column that jumped to the end of the sort when you changed its direction
    // would silently re-order the other keys.
    expect(flipped).toEqual([
      { key: "rarity", dir: "desc" },
      { key: "price", dir: "desc" },
    ]);
    expect(applySort(flipped, "rarity", addAsc)).toEqual([{ key: "price", dir: "desc" }]);
  });

  it("treats a shift-click on the only remaining column exactly like a plain one", () => {
    const spec = applySort([], "name", asc);
    expect(applySort(spec, "name", addAsc)).toEqual([{ key: "name", dir: "desc" }]);
  });

  it("never mutates the spec it was given", () => {
    const spec: SortSpec = [{ key: "name", dir: "asc" }];
    applySort(spec, "price", { additive: true, firstDir: "desc" });
    expect(spec).toEqual([{ key: "name", dir: "asc" }]);
  });
});

describe("reading a spec", () => {
  const spec: SortSpec = [
    { key: "rarity", dir: "asc" },
    { key: "price", dir: "desc" },
  ];

  it("finds a term and its 1-based rank", () => {
    expect(sortTermOf(spec, "price")).toEqual({ key: "price", dir: "desc" });
    expect(sortRankOf(spec, "rarity")).toBe(1);
    expect(sortRankOf(spec, "price")).toBe(2);
    expect(sortRankOf(spec, "name")).toBeNull();
  });

  it("says none for a column nothing sorts by", () => {
    expect(ariaSortOf(sortTermOf(spec, "rarity"))).toBe("ascending");
    expect(ariaSortOf(sortTermOf(spec, "price"))).toBe("descending");
    expect(ariaSortOf(sortTermOf(spec, "name"))).toBe("none");
  });
});
