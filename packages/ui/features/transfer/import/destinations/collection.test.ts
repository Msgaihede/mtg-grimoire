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

  /**
   * **A decimal comma is a decimal point**, which is how a spreadsheet in a Danish or German
   * locale writes every price in the column. The importer stripped every comma, so `4,50` was
   * stored as a purchase price of 450 — silently, on every row. `prices.ts`' one parser is what
   * reads it now; its own test carries the whole table.
   */
  it("reads a decimal-comma purchase price, with or without a symbol", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { purchasePrice: "4,50" } }),
        line({ lineNumber: 2, extra: { purchasePrice: "€1.234,50" } }),
      ),
      [hit(0, "c1"), hit(1, "c2")],
      OPTIONS,
    );
    expect(plan.items.map((i) => i.purchasePrice)).toEqual([4.5, 1234.5]);
    expect(plan.unreadablePrices).toEqual([]);
  });

  /**
   * **A price cell the file filled and this could not read is said, not dropped** — the
   * `unknownConditions` row's reasoning: silence here is indistinguishable from a file with no
   * price column at all. The copy still lands, with no price, which is what a refusal means. A
   * blank cell never reaches the planner (`parseCsvGrid` keeps only non-empty cells), so it is
   * not flagged.
   */
  it("flags a price cell it could not read, and still files the copy", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { purchasePrice: "1,2,3" } }),
        line({ lineNumber: 2, name: "Bolt", extra: { purchasePrice: "0.99" } }),
      ),
      [hit(0, "c1"), hit(1, "c2")],
      OPTIONS,
    );
    expect(plan.items.map((i) => i.purchasePrice)).toEqual([undefined, 0.99]);
    expect(plan.unreadablePrices).toEqual([{ lineNumber: 1, name: "Sol Ring", said: "1,2,3" }]);
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

/**
 * **A purchase price through the collection's own CSV and back, losslessly.** A price recorded
 * with exactly three decimals is written `1.1250` (`priceText`), because `1.125` is how a Danish
 * spreadsheet writes eleven hundred and twenty-five and the parser refuses it as ambiguous. A file
 * an older build wrote still says `1.125`, and that one is **listed** rather than read as 1125.
 */
describe("a purchase price round-trips through the collection's own CSV", () => {
  const rowOf = (name: string, purchasePrice: number): CollectionRow =>
    ({
      name, quantity: 1, setCode: "LTC", collectorNumber: "285", finish: "nonfoil", lang: "en",
      condition: "NM", purchasePrice, purchaseCurrency: "EUR",
    }) as unknown as CollectionRow;

  const exported = () =>
    formatExport(
      [rowOf("Sol Ring", 4.25), rowOf("Arcane Signet", 1.125), rowOf("Command Tower", 1.2345)].map(
        fromCollectionRow,
      ),
      "csv",
      // The default set leaves the column off; a reader backing up what they paid switches it on.
      [...defaultFields("csv", "collection"), "purchasePrice"],
    );
  const planOf = (text: string) =>
    planCollectionImport(parseDecklist(text), [0, 1, 2].map((i) => hit(i, `c${i}`)), {
      condition: CONDITION_NOT_SET,
      finish: null,
    });

  it("writes every price so it reads back as itself, three decimals included", () => {
    const text = exported();
    expect(text.split("\n")[0]).toContain("Purchase price");
    expect(text).toContain("1.1250");

    const plan = planOf(text);
    expect(plan.items.map((i) => i.purchasePrice)).toEqual([4.25, 1.125, 1.2345]);
    expect(plan.unreadablePrices).toEqual([]);
  });

  it("lists the three-decimal cell an older build wrote, rather than reading it as 1125", () => {
    const plan = planOf(exported().replace("1.1250", "1.125"));
    expect(plan.items.map((i) => i.purchasePrice)).toEqual([4.25, undefined, 1.2345]);
    expect(plan.unreadablePrices).toEqual([{ lineNumber: 3, name: "Arcane Signet", said: "1.125" }]);
  });
});

/** A resolved row at a named language — `hit`'s own shape plus the `lang` the language check
 *  reads. `hit` leaves `lang` out, which is safe only because a line with no `Language` cell is
 *  never checked. */
const hitIn = (index: number, cardId: string, lang: string): ImportResolveRow =>
  ({ index, hintMissed: false,
     matched: { cardId, oracleId: "o1", name: "Lightning Bolt", setCode: "2X2",
       collectorNumber: "117", lang } } as unknown as ImportResolveRow);

/**
 * **Issue #555: the collection CSV is a restore, and two of its columns were never read back.**
 * `Tags` and `Tradelist quantity` are written by this app's own export and were dropped on the way
 * in; a backup that loses what the reader typed is a backup of everything else.
 */
describe("tags and the tradelist", () => {
  const planOf = (extra: ParsedLine["extra"]) =>
    planCollectionImport(listOf(line({ extra })), [hit(0, "c1")], OPTIONS);

  it("reads this app's own JSON cell verbatim", () => {
    expect(planOf({ tags: '["cube","trade"]' }).items[0].tags).toBe('["cube","trade"]');
  });

  /** Another app's words, both separators, with the whitespace and the repeat a hand-edited
   *  spreadsheet carries. */
  it("reads comma- and semicolon-separated words as one trimmed, distinct list", () => {
    expect(planOf({ tags: " cube, trade;cube ,, binder " }).items[0].tags).toBe(
      '["cube","trade","binder"]',
    );
  });

  /** The JSON spelling is what lets a tag hold a comma, so it must not be split as words. */
  it("keeps a comma inside a JSON tag", () => {
    expect(planOf({ tags: '["red, aggro"]' }).items[0].tags).toBe('["red, aggro"]');
  });

  /**
   * An explicit `[]` is this app's own export saying *no tags*, which a `set` restore should make
   * true; silence — no column, or a cell of nothing but separators — must never touch a row's tags.
   */
  it("tells an explicit empty list from silence", () => {
    expect(planOf({ tags: "[]" }).items[0].tags).toBe("[]");
    expect(planOf({ tags: " , ; " }).items[0].tags).toBeUndefined();
    expect(planOf({}).items[0].tags).toBeUndefined();
  });

  it("reads a whole tradelist quantity, zero included", () => {
    expect(planOf({ tradelistQuantity: "2" }).items[0].tradelistQuantity).toBe(2);
    expect(planOf({ tradelistQuantity: "0" }).items[0].tradelistQuantity).toBe(0);
    expect(planOf({}).items[0].tradelistQuantity).toBeUndefined();
  });

  /** Refused rather than rounded — `2.5` copies offered for trade is not a number anybody meant —
   *  and said, like an unreadable price, while the copy still lands. */
  it("lists a tradelist that is not a whole number and still files the copy", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { tradelistQuantity: "2.5" } }),
        line({ lineNumber: 2, name: "Bolt", extra: { tradelistQuantity: "-1" } }),
        line({ lineNumber: 3, name: "Shock", extra: { tradelistQuantity: "some" } }),
      ),
      [hit(0, "c1"), hit(1, "c2"), hit(2, "c3")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(3);
    expect(plan.items.map((i) => i.tradelistQuantity)).toEqual([undefined, undefined, undefined]);
    expect(plan.unreadableTradelists).toEqual([
      { lineNumber: 1, name: "Sol Ring", said: "2.5" },
      { lineNumber: 2, name: "Bolt", said: "-1" },
      { lineNumber: 3, name: "Shock", said: "some" },
    ]);
  });
});

/**
 * Deckbox writes a flag column's own name as its only non-empty value — `signed` in `Signed` —
 * and every such copy used to import as the plain one, which on the grain is a different row.
 */
describe("a flag column that says its own word", () => {
  it("reads altered, alter, signed, proxy and misprint as yes in their own columns", () => {
    const plan = planCollectionImport(
      listOf(
        line({
          extra: { altered: "Altered", signed: "signed", proxy: "PROXY", misprint: "misprint" },
        }),
        line({ lineNumber: 2, extra: { altered: "alter" } }),
      ),
      [hit(0, "c1"), hit(1, "c2")],
      OPTIONS,
    );
    expect(plan.items[0]).toMatchObject({
      altered: true,
      signed: true,
      proxy: true,
      misprint: true,
    });
    expect(plan.items[1].altered).toBe(true);
  });

  /** Only the column's *own* word: `signed` in the Altered column says nothing about an
   *  alteration. */
  it("does not read another column's word as a yes", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { altered: "signed", proxy: "misprint" } })),
      [hit(0, "c1")],
      OPTIONS,
    );
    expect(plan.items[0]).toMatchObject({ altered: false, proxy: false });
  });
});

/**
 * **Two lines at one grain are one copy described twice, and the fold used to keep the first
 * line's words and drop the second's** — its notes, its price, where it came from. Every column is
 * merged now, and the merge itself is listed.
 */
describe("the fold keeps what both lines said", () => {
  it("combines distinct notes and acquisition sources, and names each line it merged", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { notes: "from Bob", acquisitionSource: "LGS" } }),
        line({ lineNumber: 2, extra: { notes: "trade bait", acquisitionSource: "LGS" } }),
        line({ lineNumber: 3, extra: { notes: "from Bob" } }),
      ),
      [hit(0, "c1"), hit(1, "c1"), hit(2, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      quantity: 3,
      notes: "from Bob; trade bait",
      acquisitionSource: "LGS",
    });
    expect(plan.folded).toEqual([
      { lineNumber: 2, into: 1, name: "Sol Ring" },
      { lineNumber: 3, into: 1, name: "Sol Ring" },
    ]);
  });

  it("unions the tags and sums the tradelists, counting only the lines that said one", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { tags: '["cube"]', tradelistQuantity: "1" } }),
        line({ lineNumber: 2, extra: { tags: "trade, cube", tradelistQuantity: "2" } }),
        line({ lineNumber: 3 }),
      ),
      [hit(0, "c1"), hit(1, "c1"), hit(2, "c1")],
      OPTIONS,
    );
    expect(plan.items[0]).toMatchObject({ tags: '["cube","trade"]', tradelistQuantity: 3 });
  });

  /** 1 copy at 4 and 3 at 2 is 10 spent on 4 copies; the unpriced line's 2 copies say nothing
   *  about what the others cost, so they are not in the divisor. */
  it("prices the copy at the quantity-weighted mean of the lines that carried a price", () => {
    const plan = planCollectionImport(
      listOf(
        line({ quantity: 1, extra: { purchasePrice: "4" } }),
        line({ lineNumber: 2, quantity: 3, extra: { purchasePrice: "2" } }),
        line({ lineNumber: 3, quantity: 2 }),
      ),
      [hit(0, "c1"), hit(1, "c1"), hit(2, "c1")],
      OPTIONS,
    );
    expect(plan.items[0]).toMatchObject({ quantity: 6, purchasePrice: 2.5 });
  });

  /** A repeating mean is rounded to cents; a price written to four places keeps all four, which
   *  is what this app's own CSV writes and what a restore must not round away. */
  it("rounds the mean to the file's own precision, never below cents", () => {
    const thirds = planCollectionImport(
      listOf(
        line({ quantity: 1, extra: { purchasePrice: "1" } }),
        line({ lineNumber: 2, quantity: 2, extra: { purchasePrice: "2" } }),
      ),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(thirds.items[0].purchasePrice).toBe(1.67);

    const precise = planCollectionImport(
      listOf(
        line({ quantity: 1, extra: { purchasePrice: "1.2345" } }),
        line({ lineNumber: 2, quantity: 2, extra: { purchasePrice: "1.2345" } }),
      ),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(precise.items[0].purchasePrice).toBe(1.2345);
  });

  /** A mean across currencies is a number in no currency. The first price sets the copy's;
   *  `usd` and `USD` are one currency; a price in another is listed and left out. */
  it("keeps the first price's currency and lists a merged price in another", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { purchasePrice: "4", purchaseCurrency: "USD" } }),
        line({ lineNumber: 2, extra: { purchasePrice: "2", purchaseCurrency: "usd" } }),
        line({ lineNumber: 3, extra: { purchasePrice: "3", purchaseCurrency: "EUR" } }),
      ),
      [hit(0, "c1"), hit(1, "c1"), hit(2, "c1")],
      OPTIONS,
    );
    expect(plan.items[0]).toMatchObject({ purchasePrice: 3, purchaseCurrency: "USD" });
    expect(plan.droppedPrices).toEqual([
      { lineNumber: 3, into: 1, name: "Sol Ring", said: "3", currency: "EUR", kept: "USD" },
    ]);
  });

  it("takes the price from a later line when the first carried none", () => {
    const plan = planCollectionImport(
      listOf(
        line(),
        line({ lineNumber: 2, extra: { purchasePrice: "5", purchaseCurrency: "EUR" } }),
      ),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items[0]).toMatchObject({ purchasePrice: 5, purchaseCurrency: "EUR" });
    expect(plan.droppedPrices).toEqual([]);
  });

  /** A copy acquired in two batches was first acquired at the first. Two dates nobody can order
   *  keep the one the file wrote first rather than a guess. */
  it("keeps the earliest acquisition date, and the first when either cannot be read", () => {
    const iso = planCollectionImport(
      listOf(
        line({ extra: { acquiredAt: "2024-05-01" } }),
        line({ lineNumber: 2, extra: { acquiredAt: "2023-11-20" } }),
      ),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(iso.items[0].acquiredAt).toBe("2023-11-20");

    const vague = planCollectionImport(
      listOf(
        line({ extra: { acquiredAt: "sometime" } }),
        line({ lineNumber: 2, extra: { acquiredAt: "2023-01-01" } }),
      ),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(vague.items[0].acquiredAt).toBe("sometime");
  });

  it("lists nothing when no two lines name one copy", () => {
    const plan = planCollectionImport(
      listOf(line(), line({ lineNumber: 2, finish: "foil" })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.folded).toEqual([]);
  });
});

/**
 * **A `Language` cell was a fact the export wrote and the import ignored.** The resolver is sent
 * it as a preference now, so a printing in another language means the corpus held none in the
 * file's — and the row takes its language from the printing, so the reader is told.
 */
describe("the file's language against the printing it got", () => {
  it("lists a line whose printing is in another language than the file names", () => {
    const plan = planCollectionImport(
      listOf(line({ name: "Lightning Bolt", extra: { lang: "Japanese" } })),
      [hitIn(0, "bolt", "en")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.languageMismatches).toEqual([
      { lineNumber: 1, name: "Lightning Bolt", said: "ja", used: "en" },
    ]);
    expect(plan.unknownLanguages).toEqual([]);
  });

  it("lists a language it cannot read, and still files the copy", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { lang: "Klingon" } })),
      [hitIn(0, "c1", "en")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.unknownLanguages).toEqual([{ lineNumber: 1, name: "Sol Ring", said: "Klingon" }]);
    expect(plan.languageMismatches).toEqual([]);
  });

  /** Every spelling `languageCode` knows is the same answer as the code itself. */
  it("says nothing when the printing is in the file's language, however it is spelt", () => {
    const plan = planCollectionImport(
      listOf(
        line({ extra: { lang: "JP" } }),
        line({ lineNumber: 2, extra: { lang: "English" } }),
        line({ lineNumber: 3, extra: { lang: "en" } }),
      ),
      [hitIn(0, "c1", "ja"), hitIn(1, "c2", "en"), hitIn(2, "c3", "en")],
      OPTIONS,
    );
    expect(plan.languageMismatches).toEqual([]);
    expect(plan.unknownLanguages).toEqual([]);
  });
});

/** Tags and the tradelist through the collection's own CSV and back — the restore the issue is
 *  about, over the two columns it found missing. The tag with a comma in it is the one a
 *  words-only reader would split. */
describe("tags and the tradelist round-trip through the collection's own CSV", () => {
  it("reads back exactly what it wrote", () => {
    const row = {
      name: "Sol Ring", quantity: 3, setCode: "LTC", collectorNumber: "285", finish: "nonfoil",
      lang: "en", condition: "NM", tags: '["cube","red, aggro"]', tradelistQuantity: 2,
    } as unknown as CollectionRow;
    const text = formatExport([fromCollectionRow(row)], "csv", [
      ...defaultFields("csv", "collection"),
      "tags",
      "tradelistQuantity",
    ]);
    const plan = planCollectionImport(parseDecklist(text), [hit(0, "c1")], {
      condition: CONDITION_NOT_SET,
      finish: null,
    });
    expect(plan.items[0]).toMatchObject({
      quantity: 3,
      tags: '["cube","red, aggro"]',
      tradelistQuantity: 2,
    });
    expect(plan.unreadableTradelists).toEqual([]);
  });
});
