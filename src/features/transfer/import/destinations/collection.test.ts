import { describe, expect, it } from "vitest";
import type { ImportResolveRow } from "@/lib/ipc";
import type { ParsedLine, ParsedList } from "../parse";
import { planCollectionImport } from "./collection";

const OPTIONS = { condition: "NM" as const, finish: null };

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

describe("planCollectionImport", () => {
  it("gives a line with no condition the reader's chosen default", () => {
    const plan = planCollectionImport(listOf(line({ quantity: 2 })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0]).toMatchObject({ cardId: "c1", quantity: 2, condition: "NM" });
  });

  it("lets a CSV column override the default, per row", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { condition: "LP" } })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].condition).toBe("LP");
  });

  it("normalises an EU grade and keeps what the file actually said", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { condition: "GD" } })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].condition).toBe("MP");
    expect(plan.items[0].conditionOriginal).toBe("GD");
  });

  it("folds a file that names the same grain twice, so `add` cannot double-count", () => {
    const plan = planCollectionImport(
      listOf(line({ quantity: 1 }), line({ lineNumber: 2, quantity: 2 })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].quantity).toBe(3);
  });

  it("keeps a foil apart from a regular copy, because the grain does", () => {
    const plan = planCollectionImport(
      listOf(line(), line({ lineNumber: 2, finish: "foil" })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(2);
  });

  it("leaves an unmatched line out of the items and names it in the plan", () => {
    const plan = planCollectionImport(
      listOf(line({ name: "Nonesuch" })),
      [{ index: 0, matched: null, hintMissed: false } as ImportResolveRow],
      OPTIONS,
    );
    expect(plan.items).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
    expect(plan.totalCards).toBe(0);
  });

  it("falls back to the reader's chosen default for a grade this app does not recognise, and flags it", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { condition: "Mediocre" } })),
      [hit(0, "c1")],
      { condition: "LP", finish: null },
    );
    // The reader's own default — never `normalizeCondition`'s internal NM fallback, which is
    // the best grade on the scale and the least likely answer for an unreadable one.
    expect(plan.items[0].condition).toBe("LP");
    expect(plan.items[0].conditionOriginal).toBe("Mediocre");
    expect(plan.unknownConditions).toEqual([{ lineNumber: 1, name: "Sol Ring", said: "Mediocre" }]);
  });

  it("does not write a second all-defaults row beside an altered copy", () => {
    // The fold key was `(cardId, finish, condition)` while the real grain is eleven columns,
    // and `commit_import` hard-coded altered/signed/proxy/misprint/serial/grading to defaults
    // — so a re-import could never land on the reader's altered row and wrote a second
    // all-defaults entry beside it. `import-export.md:225-262` called this latent; PR 4's
    // import toggle makes it live.
    const plan = planCollectionImport(
      listOf(line({ extra: { altered: "yes" } })),
      [hit(0, "bolt")],
      OPTIONS,
    );
    expect(plan.items.filter((i) => i.cardId === "bolt")).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({ altered: true });
  });

  it("reads all six of the grain columns a CSV can carry", () => {
    const plan = planCollectionImport(
      listOf(
        line({
          extra: {
            altered: "yes",
            signed: "no",
            proxy: "true",
            misprint: "1",
            serialNumber: "042/500",
            grading: '{"company":"PSA","grade":"10"}',
          },
        }),
      ),
      [hit(0, "c1")],
      OPTIONS,
    );
    expect(plan.items[0]).toMatchObject({
      altered: true,
      signed: false,
      proxy: true,
      misprint: true,
      serialNumber: "042/500",
      grading: '{"company":"PSA","grade":"10"}',
    });
  });

  it("keeps an altered copy apart from a plain one, because the grain does", () => {
    const plan = planCollectionImport(
      listOf(line(), line({ lineNumber: 2, quantity: 2, extra: { altered: "yes" } })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(2);
    expect(plan.items.map((i) => i.quantity)).toEqual([1, 2]);
  });

  it("keeps two slabs of one printing apart, and a bare copy apart from both", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { grading: '{"company":"PSA","grade":"10"}' } }),
        line({ lineNumber: 2, extra: { grading: '{"company":"BGS","grade":"9.5"}' } }),
        line({ lineNumber: 3 }),
      ),
      [hit(0, "c1"), hit(1, "c1"), hit(2, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(3);
  });

  it("reads a flag that says no and a column that says nothing at all as one answer", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { altered: "no" } }), line({ lineNumber: 2 })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    // Both lines are the same grain — `no` and silence are the same answer — so the file names
    // one intention twice and folds, exactly as two bare lines do.
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].quantity).toBe(2);
  });

  it("reads a currency-prefixed, thousand-separated purchase price", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { purchasePrice: "$1,234.50" } })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].purchasePrice).toBe(1234.5);
  });

  it("leaves a purchase price it cannot make sense of unset", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { purchasePrice: "ask seller" } })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].purchasePrice).toBeUndefined();
  });
});
