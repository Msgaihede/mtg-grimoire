import { describe, expect, it } from "vitest";
import type { FolderRule } from "@/lib/ipc";
import {
  blankRule,
  conflictSentence,
  describeRule,
  effectiveRules,
  hasRules,
  kindsFor,
  MAX_RULES,
  RULE_KINDS,
  RULE_KIND_LABEL,
  RULE_REFUSAL,
  subtreeConflicts,
  validateRule,
  validateRules,
  type RuleFolder,
} from "./folderRules";

const money = (v: number) => `$${v.toFixed(2)}`;

describe("RULE_KINDS and kindsFor", () => {
  it("offers every kind to the collection and all but conditions to the wishlist", () => {
    expect(kindsFor("collection")).toEqual(RULE_KINDS);
    expect(kindsFor("wishlist")).toEqual(RULE_KINDS.filter((k) => k !== "conditions"));
    expect(Object.keys(RULE_KIND_LABEL).sort()).toEqual([...RULE_KINDS].sort());
  });

  it("makes a blank rule of each kind that validation refuses until it is filled in", () => {
    for (const kind of RULE_KINDS) {
      const rule = blankRule(kind);
      expect(rule.kind).toBe(kind);
      expect(validateRule(rule)).not.toBeNull();
    }
  });
});

describe("describeRule", () => {
  it.each<[FolderRule, string]>([
    [{ kind: "price", min: null, max: 1 }, "Price up to $1.00"],
    [{ kind: "price", min: 0, max: 1 }, "Price $0.00–$1.00"],
    [{ kind: "price", min: 1, max: null }, "Price $1.00 or more"],
    [{ kind: "price", min: 2, max: 2 }, "Price $2.00"],
    [{ kind: "price", min: null, max: null }, "Price: any"],
    [{ kind: "manaValue", min: 2, max: 4 }, "Mana value 2–4"],
    [{ kind: "manaValue", min: null, max: 3 }, "Mana value up to 3"],
    [{ kind: "manaValue", min: 5, max: null }, "Mana value 5 or more"],
    [{ kind: "released", from: null, to: "2000" }, "Released through 2000"],
    [{ kind: "released", from: "2001", to: "2005" }, "Released 2001–2005"],
    [{ kind: "released", from: "2000", to: null }, "Released 2000 onwards"],
    [{ kind: "released", from: "2003-05", to: "2003-05" }, "Released in 2003-05"],
    [{ kind: "colors", values: ["U", "R"] }, "Colour: Blue or Red"],
    [{ kind: "colors", values: ["W", "U", "C"] }, "Colour: White, Blue or Colorless"],
    [{ kind: "types", values: ["Creature"] }, "Card type: Creature"],
    [{ kind: "sets", values: ["lea", "arn"] }, "Set: LEA or ARN"],
    [{ kind: "rarities", values: ["mythic", "special"] }, "Rarity: Mythic or Special"],
    [{ kind: "finishes", values: ["foil", "etched"] }, "Finish: Foil or Etched"],
    [{ kind: "conditions", values: ["NM", "LP"] }, "Condition: Near mint or Lightly played"],
    [{ kind: "borders", values: ["borderless", "fullart"] }, "Border: Borderless or Full art"],
    [{ kind: "borders", values: [] }, "Border: none picked"],
  ])("%j reads %s", (rule, words) => {
    expect(describeRule(rule, money)).toBe(words);
  });

  it("writes an unknown value as it is rather than dropping it", () => {
    expect(describeRule({ kind: "rarities", values: ["timeshifted"] }, money)).toBe(
      "Rarity: timeshifted",
    );
  });
});

/** A three-deep chain with a rule-less middle, and a sibling. */
const TREE: RuleFolder[] = [
  { id: 1, parentId: null, name: "Binder", rules: [{ kind: "colors", values: ["U"] }] },
  { id: 2, parentId: 1, name: "Middle", rules: [] },
  { id: 3, parentId: 2, name: "Cheap", rules: [{ kind: "price", min: null, max: 1 }] },
  { id: 4, parentId: 1, name: "Sibling", rules: [] },
  { id: 5, parentId: null, name: "Elsewhere", rules: [] },
];

describe("effectiveRules", () => {
  it("lists the folder's own rules and its ancestors', nearest first, skipping empty ones", () => {
    const eff = effectiveRules(TREE, 3);
    expect(eff.own).toEqual([{ kind: "price", min: null, max: 1 }]);
    expect(eff.inherited).toEqual([
      { folderId: 1, folderName: "Binder", rules: [{ kind: "colors", values: ["U"] }] },
    ]);
    expect(hasRules(eff)).toBe(true);
  });

  it("orders several ancestors nearest first", () => {
    const tree = TREE.map((f) =>
      f.id === 2 ? { ...f, rules: [{ kind: "types", values: ["Land"] } as FolderRule] } : f,
    );
    expect(effectiveRules(tree, 3).inherited.map((i) => i.folderName)).toEqual([
      "Middle",
      "Binder",
    ]);
  });

  it("has nothing for a rule-less root, or for a folder it does not know", () => {
    expect(hasRules(effectiveRules(TREE, 5))).toBe(false);
    expect(effectiveRules(TREE, 99)).toEqual({ own: [], inherited: [] });
  });

  it("adopts a parent's rules with none of its own", () => {
    const eff = effectiveRules(TREE, 4);
    expect(eff.own).toEqual([]);
    expect(hasRules(eff)).toBe(true);
  });

  it("terminates on a corrupt cycle", () => {
    const cycle: RuleFolder[] = [
      { id: 1, parentId: 2, name: "A", rules: [{ kind: "sets", values: ["lea"] }] },
      { id: 2, parentId: 1, name: "B", rules: [{ kind: "sets", values: ["arn"] }] },
    ];
    expect(effectiveRules(cycle, 1).inherited.map((i) => i.folderId)).toEqual([2]);
  });
});

describe("subtreeConflicts", () => {
  const conflicts = [
    { folderId: 1, entries: 1, copies: 4 },
    { folderId: 3, entries: 2, copies: 3 },
    { folderId: 5, entries: 7, copies: 7 },
  ];

  it("sums the folder and every descendant, and nothing outside them", () => {
    expect(subtreeConflicts(TREE, conflicts, 1)).toEqual({ entries: 3, copies: 7 });
    expect(subtreeConflicts(TREE, conflicts, 2)).toEqual({ entries: 2, copies: 3 });
    expect(subtreeConflicts(TREE, conflicts, 4)).toEqual({ entries: 0, copies: 0 });
  });

  it("terminates on a corrupt cycle", () => {
    const cycle: RuleFolder[] = [
      { id: 1, parentId: 2, name: "A", rules: [] },
      { id: 2, parentId: 1, name: "B", rules: [] },
    ];
    expect(subtreeConflicts(cycle, conflicts, 1)).toEqual({ entries: 1, copies: 4 });
  });
});

describe("conflictSentence", () => {
  it("agrees with its count", () => {
    expect(conflictSentence(1)).toBe("1 card doesn't match this folder's rules");
    expect(conflictSentence(3)).toBe("3 cards don't match this folder's rules");
    expect(conflictSentence(1200)).toBe("1,200 cards don't match this folder's rules");
    expect(conflictSentence(2, "wish", "wishes")).toBe("2 wishes don't match this folder's rules");
  });
});

describe("validateRule", () => {
  it.each<[FolderRule, string | null]>([
    [{ kind: "price", min: null, max: 1 }, null],
    [{ kind: "price", min: 0, max: 0 }, null],
    [{ kind: "price", min: null, max: null }, RULE_REFUSAL.range],
    [{ kind: "price", min: 2, max: 1 }, RULE_REFUSAL.range],
    [{ kind: "price", min: -1, max: null }, RULE_REFUSAL.range],
    [{ kind: "manaValue", min: Number.NaN, max: null }, RULE_REFUSAL.range],
    [{ kind: "manaValue", min: 3, max: 3 }, null],
    [{ kind: "released", from: "2001", to: "2005-06-30" }, null],
    [{ kind: "released", from: "2000-06", to: "2000" }, null],
    [{ kind: "released", from: "2005", to: "2001" }, RULE_REFUSAL.range],
    [{ kind: "released", from: null, to: null }, RULE_REFUSAL.range],
    [{ kind: "released", from: "01/2000", to: null }, RULE_REFUSAL.date],
    [{ kind: "released", from: "2000-13", to: null }, RULE_REFUSAL.date],
    [{ kind: "colors", values: ["U"] }, null],
    [{ kind: "colors", values: ["X"] }, RULE_REFUSAL.noValues],
    [{ kind: "types", values: ["creature"] }, RULE_REFUSAL.noValues],
    [{ kind: "sets", values: ["  "] }, RULE_REFUSAL.noValues],
    [{ kind: "sets", values: ["LEA"] }, null],
    [{ kind: "conditions", values: ["NONE"] }, null],
    [{ kind: "borders", values: [] }, RULE_REFUSAL.noValues],
  ])("%j → %s", (rule, reason) => {
    expect(validateRule(rule)).toBe(reason);
  });

  it("refuses more than MAX_RULES rules before looking at any of them", () => {
    const one: FolderRule = { kind: "colors", values: ["U"] };
    expect(validateRules(Array.from({ length: MAX_RULES }, () => one))).toBeNull();
    expect(validateRules(Array.from({ length: MAX_RULES + 1 }, () => one))).toBe(
      RULE_REFUSAL.tooMany,
    );
    expect(validateRules([one, blankRule("sets")])).toBe(RULE_REFUSAL.noValues);
  });
});
