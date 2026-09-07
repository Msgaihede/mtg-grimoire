import { describe, expect, it } from "vitest";
import type {
  WishlistOptimizePlan,
  WishOptimizeMove,
  WishOptimizeResult,
  WishOptimizeStatus,
} from "@/lib/ipc";
import {
  defaultTicked,
  everyMove,
  NOTHING_TICKED,
  optimizeScope,
  selectionOf,
  summariseOutcome,
  toggleTicked,
} from "./optimizePlan";

/**
 * One move, built from the two facts every case here actually varies: what it is worth, and how
 * many copies it is worth that over.
 *
 * `savedPerCopy` and `saved` move together because the contract says they do — `saved` is
 * `savedPerCopy × quantity`, and both are `null` exactly when `from.price` is. Deriving them here
 * rather than passing them in is what keeps a fixture from encoding a state the backend cannot
 * produce.
 */
function move(
  wishId: number,
  {
    name = `Card ${wishId}`,
    quantity = 1,
    perCopy,
    fromPrice,
    toPrice = 2,
    folderId = null,
  }: {
    name?: string;
    quantity?: number;
    /** `null` is the unpriced-current case: no figure on either field. */
    perCopy: number | null;
    fromPrice?: number | null;
    toPrice?: number;
    folderId?: number | null;
  },
): WishOptimizeMove {
  return {
    wishId,
    name,
    quantity,
    preferredFinish: null,
    folderId,
    from: {
      cardId: `from-${wishId}`,
      setCode: "lea",
      collectorNumber: "161",
      lang: "en",
      price: perCopy === null ? null : (fromPrice ?? toPrice + perCopy),
    },
    to: {
      cardId: `to-${wishId}`,
      setCode: "2x2",
      collectorNumber: "117",
      lang: "ja",
      price: toPrice,
    },
    savedPerCopy: perCopy,
    saved: perCopy === null ? null : perCopy * quantity,
  };
}

const planOf = (
  moves: WishOptimizeMove[],
  over: Partial<Omit<WishlistOptimizePlan, "moves">> = {},
): WishlistOptimizePlan => ({
  moves,
  considered: moves.length,
  alreadyCheapest: 0,
  skipped: 0,
  ...over,
});

const result = (wishId: number, status: WishOptimizeStatus): WishOptimizeResult => ({
  wishId,
  status,
});

describe("defaultTicked", () => {
  it("ticks every move that carries a figure and leaves the unpriced ones alone", () => {
    const ticked = defaultTicked(planOf([move(1, { perCopy: 3 }), move(2, { perCopy: null })]));
    expect([...ticked]).toEqual([1]);
  });

  it("answers the empty set before the read has landed", () => {
    expect(defaultTicked(undefined)).toBe(NOTHING_TICKED);
    expect(defaultTicked(planOf([]))).toBe(NOTHING_TICKED);
  });
});

describe("everyMove", () => {
  it("takes the unpriced rows too — the reader is saying so by hand", () => {
    const moves = [move(1, { perCopy: 3 }), move(2, { perCopy: null })];
    expect([...everyMove(moves)]).toEqual([1, 2]);
  });
});

describe("toggleTicked", () => {
  it("adds and removes", () => {
    const on = toggleTicked(NOTHING_TICKED, 7, true);
    expect(on.has(7)).toBe(true);
    expect([...toggleTicked(on, 7, false)]).toEqual([]);
  });

  it("returns the same reference when nothing changes, so an idempotent write is free", () => {
    const on = toggleTicked(NOTHING_TICKED, 7, true);
    expect(toggleTicked(on, 7, true)).toBe(on);
    expect(toggleTicked(NOTHING_TICKED, 7, false)).toBe(NOTHING_TICKED);
  });
});

describe("selectionOf", () => {
  const moves = [
    move(1, { perCopy: 3, quantity: 4 }),
    move(2, { perCopy: 1 }),
    move(3, { perCopy: null }),
  ];

  it("sums the saving over the ticked rows only, over every copy", () => {
    const selection = selectionOf(moves, new Set([1]));
    // 3 per copy × 4 copies, and nothing from the two rows nobody ticked.
    expect(selection.saved).toBe(12);
    expect(selection.count).toBe(1);
  });

  it("carries fromCardId and toCardId on every item, in the plan's order", () => {
    expect(selectionOf(moves, new Set([2, 1])).items).toEqual([
      { wishId: 1, fromCardId: "from-1", toCardId: "to-1" },
      { wishId: 2, fromCardId: "from-2", toCardId: "to-2" },
    ]);
  });

  it("counts a ticked unpriced row as no saving and says how many there are", () => {
    const selection = selectionOf(moves, new Set([2, 3]));
    expect(selection.saved).toBe(1);
    expect(selection.unpriced).toBe(1);
    expect(selection.count).toBe(2);
  });

  it("reads the select-all as all, none or some", () => {
    expect(selectionOf(moves, new Set([1, 2, 3])).all).toBe("all");
    expect(selectionOf(moves, NOTHING_TICKED).all).toBe("none");
    expect(selectionOf(moves, new Set([1])).all).toBe("some");
    // No moves is "none": there is nothing ticked, which is true.
    expect(selectionOf([], new Set([1])).all).toBe("none");
  });

  it("ignores a ticked id that names no move, so a refetch cannot strand the set", () => {
    const selection = selectionOf(moves, new Set([1, 999]));
    expect(selection.count).toBe(1);
    expect(selection.all).toBe("some");
  });

  it("hands out fresh items rather than anything the rendered plan can reach", () => {
    const first = selectionOf(moves, new Set([1])).items[0];
    const second = selectionOf(moves, new Set([1])).items[0];
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe("summariseOutcome", () => {
  const moves = [
    move(1, { name: "Lightning Bolt", perCopy: 3, quantity: 2 }),
    move(2, { name: "Rhystic Study", perCopy: 5 }),
    move(3, { name: "Ancestral Recall", perCopy: 7 }),
    move(4, { name: "Sol Ring", perCopy: null }),
  ];

  it("counts the four statuses apart", () => {
    const outcome = summariseOutcome(
      [result(1, "changed"), result(2, "merged"), result(3, "stale"), result(4, "missing")],
      moves,
    );
    expect(outcome).toMatchObject({ changed: 1, merged: 1, stale: 1, missing: 1 });
  });

  it("counts a merged row's saving — the wish still moved to the cheaper printing", () => {
    const outcome = summariseOutcome([result(1, "changed"), result(2, "merged")], moves);
    expect(outcome.saved).toBe(11);
  });

  it("counts nothing for a stale or missing row", () => {
    const outcome = summariseOutcome([result(3, "stale"), result(1, "missing")], moves);
    expect(outcome.saved).toBe(0);
  });

  it("names every row that was left alone, with what happened to it", () => {
    const outcome = summariseOutcome([result(2, "stale"), result(3, "missing")], moves);
    expect(outcome.skipped).toEqual([
      { wishId: 2, name: "Rhystic Study", status: "stale" },
      { wishId: 3, name: "Ancestral Recall", status: "missing" },
    ]);
  });

  it("qualifies the figure with the moved rows it could not price", () => {
    const outcome = summariseOutcome([result(1, "changed"), result(4, "changed")], moves);
    expect(outcome.saved).toBe(6);
    expect(outcome.unpriced).toBe(1);
  });

  it("reports a result whose move the snapshot has lost rather than throwing", () => {
    const outcome = summariseOutcome([result(99, "changed"), result(98, "stale")], moves);
    expect(outcome.changed).toBe(1);
    expect(outcome.unpriced).toBe(1);
    expect(outcome.skipped).toEqual([{ wishId: 98, name: null, status: "stale" }]);
  });
});

describe("optimizeScope", () => {
  it("names the folder the list is drawn at", () => {
    expect(optimizeScope({ flatten: false, folder: "Ordered", filtered: false })).toBe("Ordered");
  });

  it("says Every folder while the list is flattened, whatever folder was last open", () => {
    expect(optimizeScope({ flatten: true, folder: "Ordered", filtered: false })).toBe(
      "Every folder",
    );
  });

  it("takes the root's own word from the caller", () => {
    expect(optimizeScope({ flatten: false, folder: "Wishlist", filtered: false })).toBe("Wishlist");
  });

  it("says so when filters are narrowing the sweep", () => {
    expect(optimizeScope({ flatten: true, folder: "Wishlist", filtered: true })).toBe(
      "Every folder, matching your filters",
    );
  });
});
