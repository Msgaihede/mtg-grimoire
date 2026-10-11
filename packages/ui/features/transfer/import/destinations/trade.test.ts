import { describe, expect, it } from "vitest";
import type { ImportResolveRow } from "@/lib/ipc";
import type { ParsedLine, ParsedList } from "../parse";
import { planTradeImport } from "./trade";

/** A whole `ParsedLine` — `wishlist.test.ts`'s own factory. */
const line = (over: Partial<ParsedLine> = {}): ParsedLine => ({
  lineNumber: 1, raw: "1 Sol Ring", quantity: 1, name: "Sol Ring", setCode: null,
  collectorNumber: null, section: "deck", categoryName: null, finish: null, excluded: false,
  labelName: null, labelColor: null, extra: {}, ...over,
});

const listOf = (...lines: ParsedLine[]): ParsedList => ({
  lines, issues: [],
  totalCards: lines.reduce((n, l) => n + l.quantity, 0),
  suggestedName: null,
});

const hit = (index: number, cardId: string, hintMissed = false): ImportResolveRow =>
  ({ index, hintMissed,
     matched: { cardId, oracleId: "o1", name: "Sol Ring", setCode: "ltc",
       collectorNumber: "285" } } as unknown as ImportResolveRow);

const miss = (index: number): ImportResolveRow => ({ index, hintMissed: false, matched: null });

describe("planTradeImport", () => {
  it("puts the answered printing on the side, as a regular copy unless the line said otherwise", () => {
    const plan = planTradeImport(
      listOf(line({ quantity: 2 }), line({ lineNumber: 2, name: "Bolt", finish: "foil" })),
      [hit(0, "c1"), hit(1, "c2")],
    );
    expect(plan.items).toEqual([
      { cardId: "c1", finish: "nonfoil", quantity: 2, source: "search" },
      { cardId: "c2", finish: "foil", quantity: 1, source: "search" },
    ]);
    expect(plan.totalCards).toBe(3);
  });

  it("folds two lines naming one printing and finish, and keeps another finish apart", () => {
    const plan = planTradeImport(
      listOf(
        line({ quantity: 1 }),
        line({ lineNumber: 2, quantity: 2, section: "sideboard" }),
        line({ lineNumber: 3, finish: "etched" }),
      ),
      [hit(0, "c1"), hit(1, "c1"), hit(2, "c1")],
    );
    expect(plan.items).toEqual([
      { cardId: "c1", finish: "nonfoil", quantity: 3, source: "search" },
      { cardId: "c1", finish: "etched", quantity: 1, source: "search" },
    ]);
  });

  it("lists a line nothing answered, and a printing hint that was not used, without losing either", () => {
    const plan = planTradeImport(
      listOf(
        line({ raw: "1 Nonsense", name: "Nonsense" }),
        line({ lineNumber: 2, setCode: "xyz", collectorNumber: "1" }),
      ),
      [miss(0), hit(1, "c1", true)],
    );
    expect(plan.unmatched).toEqual([{ lineNumber: 1, raw: "1 Nonsense", name: "Nonsense" }]);
    expect(plan.hintMisses).toEqual([{ lineNumber: 2, name: "Sol Ring", used: "LTC 285" }]);
    expect(plan.items).toHaveLength(1);
  });
});
