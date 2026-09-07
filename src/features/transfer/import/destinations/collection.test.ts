import { describe, expect, it } from "vitest";
import { CONDITION_NOT_SET } from "@/lib/conditions";
import type { CollectionRow, ImportResolveRow } from "@/lib/ipc";
import { formatExport } from "../../export/format";
import { defaultFields } from "../../fields";
import { fromCollectionRow } from "../../TransferCard";
import { parseDecklist, type ParsedLine, type ParsedList } from "../parse";
import { planCollectionImport } from "./collection";

/** Deliberately **not** the store's own default: these are the reader's answers to the two
 *  dropdowns, and a fixture that happened to match the default would leave every "the dropdown
 *  wins" case below asserting nothing. The not-set default has its own cases. */
const OPTIONS = { condition: "NM" as const, finish: null };

/** A whole `ParsedLine`. Four of `ParsedList`'s fields are easy to forget — `totalCards` and
 *  `suggestedName` are not optional. */
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

const hit = (index: number, cardId: string): ImportResolveRow =>
  ({ index, hintMissed: false,
     matched: { cardId, oracleId: "o1", name: "Sol Ring", setCode: "LTC",
       collectorNumber: "285" } } as unknown as ImportResolveRow);

describe("planCollectionImport", () => {
  it("gives a line with no condition the reader's chosen default", () => {
    const plan = planCollectionImport(listOf(line({ quantity: 2 })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0]).toMatchObject({ cardId: "c1", quantity: 2, condition: "NM" });
  });

  /**
   * The shape a plain decklist takes since schema v35, and the state the dropdown opens on.
   *
   * A text list carries no Condition column at all, so every line of one lands here — and what
   * it records now is that nobody said, rather than the best grade on the scale written on the
   * reader's behalf three hundred times.
   */
  it("records no grade at all when the file says nothing and the reader has not chosen one", () => {
    const plan = planCollectionImport(
      listOf(line({ quantity: 2 })),
      [hit(0, "c1")],
      { condition: CONDITION_NOT_SET, finish: null },
    );
    expect(plan.items[0]).toMatchObject({ condition: "NONE" });
    // Nothing to warn about: a file that said nothing is a file this app read correctly.
    expect(plan.unknownConditions).toEqual([]);
    // `conditionOriginal` stays absent — there is no original, and `undefined` rather than
    // `null` is the seam `CollectionImportItem`'s optional fields want.
    expect(plan.items[0].conditionOriginal).toBeUndefined();
  });

  /**
   * A blank Condition cell takes the **dropdown's** answer, not `normalizeCondition`'s.
   *
   * The two agree by accident today — both are `NONE` when the reader has not touched the
   * dropdown — so the only way to tell which road a blank took is to set the dropdown to
   * something else and look. `parseCsvGrid` drops an empty cell before it becomes an `extra`,
   * which is what makes the dropdown win; this pins that, because the difference is invisible in
   * the default case and one edit to `parse.ts` away from being visible again.
   */
  it("gives a blank Condition cell the reader's chosen default, not the sentinel", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: {} })),
      [hit(0, "c1")],
      { condition: "LP", finish: null },
    );
    expect(plan.items[0].condition).toBe("LP");
  });

  /**
   * A file that spells the absence out loud is read, not flagged.
   *
   * This app's own CSV writes an empty cell for an ungraded copy, so this is about somebody
   * else's file — but `Not set` is a word `SYNONYMS` knows, and reading it as an unknown grade
   * would put a warning row on every line of one.
   */
  it("reads a `Not set` cell as no grade, and does not call it unrecognised", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { condition: "Not set" } })),
      [hit(0, "c1")],
      { condition: "LP", finish: null },
    );
    expect(plan.items[0].condition).toBe("NONE");
    expect(plan.unknownConditions).toEqual([]);
  });

  /** The grain's third term is a value like any other, so an ungraded copy and a Near Mint one
   *  of the same printing are two rows — which is the whole reason the sentinel is a string and
   *  not a NULL. */
  it("keeps an ungraded copy apart from a graded one", () => {
    const plan = planCollectionImport(
      listOf(line(), line({ lineNumber: 2, extra: { condition: "NM" } })),
      [hit(0, "c1"), hit(1, "c1")],
      { condition: CONDITION_NOT_SET, finish: null },
    );
    expect(plan.items).toHaveLength(2);
    expect(plan.items.map((i) => i.condition)).toEqual(["NONE", "NM"]);
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
    // all-defaults entry beside it. `import-export.md`'s **"The narrow fold"** called this
    // latent; PR 4's import toggle makes it live.
    //
    // **Named rather than numbered, because the number had already rotted.** This read
    // `import-export.md:225-262`, and by 2026-09-07 that range had become the middle of the
    // inactive-category filter — a section about something else entirely, inserted above it by
    // an unrelated PR. A line range into a prose file is a fact about a *document revision*,
    // and a prose-only edit routes to neither CI job, so nothing can ever go red for it.
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

/**
 * Writer → file → parser → planner, over one ungraded copy and one Near Mint one.
 *
 * **The golden corpus cannot be asked this**, and it is worth being exact about why: its
 * scenarios hold already-built `TransferCard`s, so `fromCollectionRow` runs *upstream* of every
 * golden case and the fence never sees a collection row at all. Growing the corpus a not-set row
 * in the same commit as the writers that would generate it is how a fence stops fencing anyway.
 * So the round trip is asserted here, on rows built in the test — the corpus proves bytes from a
 * card, and this proves the value survives the trip from a row out to a file and back.
 */
describe("an ungraded copy round-trips through the collection's own CSV", () => {
  const rowOf = (condition: string): CollectionRow =>
    ({
      name: "Sol Ring", quantity: 1, setCode: "LTC", collectorNumber: "285",
      finish: "nonfoil", lang: "en", condition,
    }) as unknown as CollectionRow;

  it("writes an empty Condition cell, never the sentinel, and reads it back as no grade", () => {
    const text = formatExport(
      [fromCollectionRow(rowOf(CONDITION_NOT_SET)), fromCollectionRow(rowOf("NM"))],
      "csv",
      defaultFields("csv", "collection"),
    );

    // The written **cell**, not just the field it came from: every other tool the reader opens
    // this CSV in would show a column of `NONE` where the truthful answer is a blank, and this
    // unit test plus the one on `mirror/read.rs` are the whole of what holds the two
    // implementations of that substitution together.
    const [header, ...rows] = text.trimEnd().split("\n");
    const at = header.split(",").indexOf("Condition");
    expect(at).toBeGreaterThan(-1);
    expect(rows[0].split(",")[at]).toBe("");
    expect(rows[1].split(",")[at]).toBe("NM");
    expect(text).not.toContain("NONE");
    // Two lines, not one — the grain's third term still tells them apart, which is the whole
    // reason the sentinel is a string rather than a NULL.
    const list = parseDecklist(text);
    expect(list.lines).toHaveLength(2);
    expect(list.lines[0].extra.condition).toBeUndefined();
    expect(list.lines[1].extra.condition).toBe("NM");

    const plan = planCollectionImport(list, [hit(0, "c1"), hit(1, "c1")], {
      condition: CONDITION_NOT_SET,
      finish: null,
    });
    expect(plan.items.map((i) => i.condition)).toEqual(["NONE", "NM"]);
    // An empty cell is a file this app read correctly, not a grade it failed to.
    expect(plan.unknownConditions).toEqual([]);
  });
});
