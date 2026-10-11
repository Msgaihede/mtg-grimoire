/**
 * A **real, whole** ManaBox collection export (issue #873), run through the parser and every
 * planner the sorted import uses — the file the reader exported on 2026-10-11, unedited:
 * 9,583 rows, 30,656 copies, five binders and four decks, comma-separated.
 *
 * The hand-written fixtures in `parse.test.ts` and `destinations/binders.test.ts` pin each rule;
 * this pins that the rules add up to the file people actually have. It is what caught the two
 * things they could not: the file is **1.76 MB**, over the one-megabyte cap the importer had
 * until this issue, and the whole-file merge list claimed 382 merges across binders that the
 * sorted press never makes.
 *
 * **No resolver here.** Which printing a row names is `import_resolve`'s question and needs the
 * corpus; each row is matched to a printing keyed on its own set and collector number, which is
 * the answer a corpus that has every card would give. What is under test is everything around
 * that answer.
 */
import { describe, expect, it } from "vitest";
import { MAX_DECKLIST_BYTES } from "@/lib/core/browserFiles";
import type { ImportResolveRow } from "@/lib/ipc";
import text from "./__fixtures__/manabox-collection.csv?raw";
import { planBinderImport } from "./destinations/binders";
import { planCollectionImport } from "./destinations/collection";
import { match } from "./fixtures";
import { parseDecklist } from "./parse";

const OPTIONS = { condition: "NONE" as const, finish: null };

const list = parseDecklist(text);
const resolved: ImportResolveRow[] = list.lines.map((line, index) => ({
  index,
  hintMissed: false,
  matched: match({
    name: line.name,
    cardId: `${line.setCode}-${line.collectorNumber}-${line.name}`,
    typeLine: /^(Plains|Island|Swamp|Mountain|Forest)$/.test(line.name) ? "Basic Land" : null,
  }),
}));

describe("a whole ManaBox collection export", () => {
  it("fits under the import cap, which the old megabyte did not", () => {
    const bytes = new TextEncoder().encode(text).length;
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(bytes).toBeLessThanOrEqual(MAX_DECKLIST_BYTES);
  });

  it("reads every row, and every column it can", () => {
    expect(list.issues).toEqual([]);
    expect(list.lines).toHaveLength(9583);
    expect(list.totalCards).toBe(30656);
    expect(list.csv).toEqual({
      delimiter: ",",
      hasQuantity: true,
      ignoredColumns: ["Set name", "Rarity", "ManaBox ID", "Scryfall ID", "Added"],
    });
    // Every row is filed somewhere, as one of ManaBox's two kinds.
    expect(new Set(list.lines.map((l) => l.binder?.type))).toEqual(new Set(["binder", "deck"]));
  });

  it("reads every grade, language and price ManaBox wrote", () => {
    const plan = planCollectionImport(list, resolved, OPTIONS);
    expect(new Set(list.lines.map((l) => l.extra.condition))).toEqual(
      new Set(["near_mint", "excellent", "light_played", "good", "played", "poor"]),
    );
    expect(plan.unknownConditions).toEqual([]);
    expect(new Set(list.lines.map((l) => l.extra.lang))).toEqual(
      new Set(["en", "de", "fr", "zh_CN", "ja"]),
    );
    expect(plan.unknownLanguages).toEqual([]);
    expect(plan.unreadablePrices).toEqual([]);
    expect(plan.items.reduce((n, item) => n + item.quantity, 0)).toBe(30656);
  });

  it("sorts into five folders and four decks, every copy accounted for", () => {
    const plan = planBinderImport(list, resolved, [], OPTIONS);
    expect(plan.groups.map((g) => [g.name, g.target, g.totalCards])).toEqual([
      ["Value Binder", "folder", 310],
      ["High Value", "folder", 79],
      ["Bulk", "folder", 26945],
      ["Staples", "folder", 1352],
      ["Valuable Cards", "folder", 1570],
      ["Ashling", "deck", 100],
      ["Sephiroth", "deck", 100],
      ["Yuna", "deck", 100],
      ["Veyran's Prismari", "deck", 100],
    ]);
    expect([plan.folders, plan.decks]).toEqual([5, 4]);
    expect(plan.groups.reduce((n, g) => n + g.totalCards, 0)).toBe(30656);
  });

  it("gives each deck a hundred-card list, every card in a pile", () => {
    const plan = planBinderImport(list, resolved, [], OPTIONS);
    for (const deck of plan.groups.filter((g) => g.target === "deck")) {
      expect(deck.deckItems.reduce((n, item) => n + item.quantity, 0)).toBe(100);
      expect(deck.deckItems.every((item) => item.categoryName !== "")).toBe(true);
    }
    // Sephiroth's twenty-odd Swamps are each their own printing, and all land in one pile.
    const sephiroth = plan.groups.find((g) => g.name === "Sephiroth")!;
    expect(
      new Set(
        sephiroth.deckItems
          .filter((item) => item.cardId.endsWith("-Swamp"))
          .map((item) => item.categoryName),
      ),
    ).toEqual(new Set(["Land"]));
  });

  /** The preview's merge list, sorted: the binders' own folds, never one across two binders. */
  it("merges only within a binder", () => {
    const whole = planCollectionImport(list, resolved, OPTIONS);
    const plan = planBinderImport(list, resolved, [], OPTIONS);
    expect(whole.folded).toHaveLength(382);
    expect(plan.folded).toHaveLength(118);
    const binderOf = new Map(list.lines.map((l) => [l.lineNumber, l.binder?.name]));
    for (const fold of plan.folded) {
      expect(binderOf.get(fold.lineNumber)).toBe(binderOf.get(fold.into));
    }
  });
});
