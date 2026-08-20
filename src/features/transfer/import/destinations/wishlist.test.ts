import { describe, expect, it } from "vitest";
import type { ImportResolveRow } from "@/lib/ipc";
import type { ParsedLine, ParsedList } from "../parse";
import { planWishlistImport } from "./wishlist";

const OPTIONS = { finish: null };

/** A whole `ParsedLine`. Four of `ParsedList`'s fields are easy to forget — `totalCards` and
 *  `suggestedName` are not optional. */
const line = (over: Partial<ParsedLine> = {}): ParsedLine => ({
  lineNumber: 1, raw: "1 Sol Ring", quantity: 1, name: "Sol Ring", setCode: null,
  collectorNumber: null, section: "deck", categoryName: null, finish: null, excluded: false,
  extra: {}, ...over,
});

const listOf = (...lines: ParsedLine[]): ParsedList => ({
  lines, issues: [],
  totalCards: lines.reduce((n, l) => n + l.quantity, 0),
  suggestedName: null,
});

const hit = (index: number, cardId: string): ImportResolveRow =>
  ({ index, hintMissed: false,
     matched: { cardId, oracleId: "o1", name: "Sol Ring", setCode: "LTC",
       collectorNumber: "285" } } as unknown as ImportResolveRow);

describe("planWishlistImport", () => {
  it("wishes for any printing when the file named none", () => {
    // `1 Sol Ring` is a wish for the card. `card_id IS NULL` is what the wishlist's grain
    // already means by that, and it is a different wish from a pinned one rather than a
    // looser version of it.
    const plan = planWishlistImport(listOf(line()), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].cardId).toBeNull();
    expect(plan.items[0].oracleId).toBe("o1");
  });

  it("pins the printing when the file named one", () => {
    const plan = planWishlistImport(
      listOf(line({ setCode: "LTC", collectorNumber: "285" })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].cardId).toBe("c1");
  });

  it("keeps a pinned wish and an any-printing wish apart", () => {
    const plan = planWishlistImport(
      listOf(line(), line({ lineNumber: 2, setCode: "LTC" })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(2);
  });

  it("folds two lines that name the same wish", () => {
    const plan = planWishlistImport(
      listOf(line({ quantity: 1 }), line({ lineNumber: 2, quantity: 2 })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].quantity).toBe(3);
  });
});
