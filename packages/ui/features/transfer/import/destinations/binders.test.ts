import { describe, expect, it } from "vitest";
import type { ImportResolveRow } from "@/lib/ipc";
import { match } from "../fixtures";
import { parseDecklist, type ParsedList } from "../parse";
import { hasBinders, planBinderImport } from "./binders";

/** The reader's two dropdown answers, as `planCollectionImport`'s own suite fixes them. */
const OPTIONS = { condition: "NM" as const, finish: null };

/**
 * A ManaBox collection export of the issue's shape (issue #873): a binder, a deck, the same
 * binder again after the deck, a second deck, and a row filed nowhere. Comma-separated, which is
 * what ManaBox itself writes; the parser's own suite covers the tab-separated paste.
 */
const EXPORT = [
  "Binder Name,Binder Type,Name,Set code,Collector number,Foil,Quantity,Condition",
  "Value Binder,binder,Fellwar Stone,DRK,102,normal,3,near_mint",
  "Yuna,deck,Sol Ring,3ED,274,normal,1,near_mint",
  "Yuna,deck,Swords to Plowshares,ICE,54,normal,1,near_mint",
  "Value Binder,binder,Sol Ring,3ED,274,normal,2,near_mint",
  "Sephiroth,deck,Swamp,FIN,300,normal,1,near_mint",
  ",,Eerie Interlude,SOI,16,foil,1,near_mint",
  "",
].join("\n");

/** Every line matched, each to a printing named after the card — and a type line, so the deck's
 *  planner has something to file a pile by. */
function resolveAll(list: ParsedList): ImportResolveRow[] {
  return list.lines.map((line, index) => ({
    index,
    matched: match({
      name: line.name,
      typeLine: line.name === "Swamp" ? "Basic Land" : "Artifact",
    }),
    hintMissed: false,
  }));
}

describe("planBinderImport", () => {
  it("offers nothing for a file that names no binder", () => {
    expect(hasBinders(parseDecklist("4 Lightning Bolt\n"))).toBe(false);
    expect(hasBinders(parseDecklist(EXPORT))).toBe(true);
  });

  it("groups rows by binder in the file's order, a deck kept apart from a folder", () => {
    const list = parseDecklist(EXPORT);
    const plan = planBinderImport(list, resolveAll(list), [], OPTIONS);
    expect(plan.groups.map((g) => [g.name, g.target, g.totalCards])).toEqual([
      // The binder's second row, after the deck, joins its first — one folder, not two.
      ["Value Binder", "folder", 5],
      ["Yuna", "deck", 2],
      ["Sephiroth", "deck", 1],
      // A blank binder cell stays at the root.
      [null, "folder", 1],
    ]);
    expect([plan.folders, plan.decks]).toEqual([1, 2]);
  });

  it("plans each group's copies at the collection's grain, and only its own", () => {
    const list = parseDecklist(EXPORT);
    const plan = planBinderImport(list, resolveAll(list), [], OPTIONS);
    const [binder, yuna, , root] = plan.groups;
    expect(binder.collectionItems.map((i) => [i.cardId, i.quantity, i.condition])).toEqual([
      ["fellwar-stone", 3, "NM"],
      ["sol-ring", 2, "NM"],
    ]);
    // The deck's Sol Ring is the deck's: the binder's two copies did not fold into it.
    expect(yuna.collectionItems.map((i) => [i.cardId, i.quantity])).toEqual([
      ["sol-ring", 1],
      ["swords-to-plowshares", 1],
    ]);
    expect(root.collectionItems).toEqual([
      expect.objectContaining({ cardId: "eerie-interlude", finish: "foil" }),
    ]);
  });

  it("plans a deck's list beside its copies, and no list for a folder", () => {
    const list = parseDecklist(EXPORT);
    const plan = planBinderImport(list, resolveAll(list), [], OPTIONS);
    expect(plan.groups[0].deckItems).toEqual([]);
    expect(plan.groups[1].deckItems.map((i) => [i.cardId, i.quantity])).toEqual([
      ["sol-ring", 1],
      ["swords-to-plowshares", 1],
    ]);
    // Filed by the deck planner's own rule, so the pile is the one any other door would pick.
    expect(plan.groups[2].deckItems[0].categoryName).toBe("Land");
  });

  /**
   * A deck's cards are filed by the app's own auto-sort, exactly as an add would file them: the
   * card's Oracle tags first, its type line beneath them. ManaBox names no pile, so nothing in
   * the file outranks the rule — and the piles it names are made by `deck_import_commit` as
   * `'auto'` categories, the same find-or-create every other import goes through.
   */
  it("files a deck's cards into the auto-sort's piles, Oracle tags first", () => {
    const list = parseDecklist(EXPORT);
    const tags = [
      { cardId: "swords-to-plowshares", slugs: ["removal"] },
      { cardId: "sol-ring", slugs: ["ramp"] },
    ];
    const plan = planBinderImport(list, resolveAll(list), tags, OPTIONS);
    expect(plan.groups[1].deckItems.map((i) => [i.cardId, i.categoryName])).toEqual([
      ["sol-ring", "Ramp"],
      ["swords-to-plowshares", "Removal"],
    ]);
    // With no taxonomy, the type line is the floor — never an import refused.
    const untagged = planBinderImport(list, resolveAll(list), [], OPTIONS);
    expect(untagged.groups[1].deckItems.map((i) => i.categoryName)).toEqual([
      "Artifact",
      "Artifact",
    ]);
  });

  /**
   * The re-index is the whole of what makes a sub-list safe: a resolver row carried across with
   * its original `index` would point at whichever line sits there in the shorter list. Here the
   * second deck's only line is line 4 of the file and line 0 of its group, so a row left at 4
   * would match nothing at all and the deck would be dropped as empty.
   */
  it("matches each group's lines to their own resolver rows", () => {
    const list = parseDecklist(EXPORT);
    const rows = resolveAll(list);
    const plan = planBinderImport(list, rows, [], OPTIONS);
    expect(plan.groups.find((g) => g.name === "Sephiroth")?.collectionItems[0].cardId).toBe(
      "swamp",
    );
  });

  it("files ManaBox's other kinds as folders", () => {
    const list = parseDecklist(
      "Binder Name,Binder Type,Name,Quantity\nWants,list,Sol Ring,1\nOdd,shoebox,Island,1\n",
    );
    const plan = planBinderImport(list, resolveAll(list), [], OPTIONS);
    expect(plan.groups.map((g) => [g.name, g.target])).toEqual([
      ["Wants", "folder"],
      ["Odd", "folder"],
    ]);
  });

  it("drops a binder none of whose rows matched, rather than make an empty folder or deck", () => {
    const list = parseDecklist(EXPORT);
    const rows = resolveAll(list).map((row) =>
      list.lines[row.index].binder?.name === "Yuna" ? { ...row, matched: null } : row,
    );
    const plan = planBinderImport(list, rows, [], OPTIONS);
    expect(plan.groups.map((g) => g.name)).toEqual(["Value Binder", "Sephiroth", null]);
    expect(plan.decks).toBe(1);
  });
});
