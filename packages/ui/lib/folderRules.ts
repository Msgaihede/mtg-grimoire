/**
 * Folder rules (issue #980) — the TypeScript half: words for a rule, the inheritance walk, the
 * sub-tree's conflict count and the refusals the dialog greys Save with.
 *
 * **Not deck validation, not tags, not the lock** (`docs/agent/DOMAIN_VOCABULARY.md`). A rule is
 * a criterion a card filed in a collection or wishlist folder is *expected* to meet; breaking one
 * never stops a filing, it only marks the card. Rust decides which cards break a rule
 * (`collection_rule_conflicts`); this module explains a folder's rules to the reader.
 */
import { BORDERS, BORDER_LABEL, type Border } from "@/lib/border";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { count, verb } from "@/lib/counts";
import { FINISHES, FINISH_LABEL, type Finish } from "@/lib/finish";
import type { FolderConflicts, FolderRule, FolderRuleKind } from "@/lib/ipc";
import { MANA_KEYS, MANA_LABEL, type ManaKey } from "@/lib/mana";

/** The order `Add rule` offers the kinds in, and the order a fresh reader meets them. */
export const RULE_KINDS: readonly FolderRuleKind[] = [
  "price",
  "manaValue",
  "colors",
  "types",
  "sets",
  "rarities",
  "finishes",
  "conditions",
  "borders",
  "released",
];

export const RULE_KIND_LABEL: Record<FolderRuleKind, string> = {
  price: "Price",
  manaValue: "Mana value",
  colors: "Colour",
  types: "Card type",
  sets: "Set",
  rarities: "Rarity",
  finishes: "Finish",
  conditions: "Condition",
  borders: "Border",
  released: "Release date",
};

/**
 * `folder_rules::MAX_RULES` — the tidy refuses a twenty-first rule, so the dialog stops offering
 * one at twenty rather than letting Save find out.
 */
export const MAX_RULES = 20;

/** A wish has no condition (spec §1): the wishlist's editor never offers the kind. */
const WISHLIST_KINDS = RULE_KINDS.filter((k) => k !== "conditions");

export function kindsFor(scope: "collection" | "wishlist"): readonly FolderRuleKind[] {
  return scope === "wishlist" ? WISHLIST_KINDS : RULE_KINDS;
}

/** The kinds whose payload is a `values` list rather than a pair of ends. */
export type ValuesRuleKind = Exclude<FolderRuleKind, "price" | "manaValue" | "released">;
export type ValuesRule = Extract<FolderRule, { kind: ValuesRuleKind }>;
export type RangeRule = Extract<FolderRule, { kind: "price" | "manaValue" }>;
export type DateRule = Extract<FolderRule, { kind: "released" }>;

export function isValuesRule(rule: FolderRule): rule is ValuesRule {
  return rule.kind !== "price" && rule.kind !== "manaValue" && rule.kind !== "released";
}

/** `cardtypes::TYPE_KEYS`, in its order (alphabetical). */
const TYPE_KEYS = [
  "Artifact",
  "Battle",
  "Creature",
  "Enchantment",
  "Instant",
  "Land",
  "Planeswalker",
  "Sorcery",
] as const;

/**
 * All six of Scryfall's rarities, where the search's chips offer four: a folder "for specials" is
 * a sensible drawer even though no search chip narrows to one.
 */
const RARITY_KEYS = ["common", "uncommon", "rare", "mythic", "special", "bonus"] as const;
const RARITY_LABEL: Record<(typeof RARITY_KEYS)[number], string> = {
  common: "Common",
  uncommon: "Uncommon",
  rare: "Rare",
  mythic: "Mythic",
  special: "Special",
  bonus: "Bonus",
};

/**
 * Each chip kind's vocabulary, in the order its chips are drawn — the same words the Rust tidy
 * keeps (spec §4). `sets` is open (any set code) and so has no entry here.
 */
export const RULE_VALUES: Record<Exclude<ValuesRuleKind, "sets">, readonly string[]> = {
  colors: MANA_KEYS,
  types: TYPE_KEYS,
  rarities: RARITY_KEYS,
  finishes: FINISHES,
  conditions: CONDITIONS,
  borders: BORDERS,
};

/** One value as a reader reads it — `Blue`, `Near mint`, `Full art`, `LEA`. */
export function valueLabel(kind: ValuesRuleKind, value: string): string {
  switch (kind) {
    case "colors":
      return MANA_LABEL[value as ManaKey] ?? value;
    case "rarities":
      return RARITY_LABEL[value as keyof typeof RARITY_LABEL] ?? value;
    case "finishes":
      return FINISH_LABEL[value as Finish] ?? value;
    case "conditions":
      return CONDITION_LABEL[value as Condition] ?? value;
    case "borders":
      return BORDER_LABEL[value as Border] ?? value;
    case "sets":
      return value.toUpperCase();
    case "types":
      return value;
  }
}

/** What `Add rule` appends: no ends, no values — invalid until the reader fills it in, which is
 *  what greys Save with the reason rather than saving a rule that matches everything. */
export function blankRule(kind: FolderRuleKind): FolderRule {
  switch (kind) {
    case "price":
    case "manaValue":
      return { kind, min: null, max: null };
    case "released":
      return { kind, from: null, to: null };
    default:
      return { kind, values: [] };
  }
}

/** `Blue`, `Blue or Red`, `White, Blue or Red` — a rule's values are ORed, so the words are too. */
function orList(words: readonly string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}

/** A pair of ends in words. `upTo` and `orMore` are the one-sided phrasings, which differ for a
 *  date (`through 2000`, `2000 onwards`) from a number (`up to $1.00`, `$1.00 or more`). */
function rangeWords(
  lo: string | null,
  hi: string | null,
  upTo: (hi: string) => string,
  orMore: (lo: string) => string,
  same: (v: string) => string = (v) => v,
): string {
  if (lo !== null && hi !== null) return lo === hi ? same(lo) : `${lo}–${hi}`;
  if (hi !== null) return upTo(hi);
  if (lo !== null) return orMore(lo);
  return "any";
}

/**
 * One rule in a phrase: `Price up to $1.00`, `Mana value 2–4`, `Colour: Blue or Red`,
 * `Released 2001–2005`, `Border: Borderless or Full art`.
 *
 * `money` is the caller's — `formatPrice` at the page's marketplace — because a price rule holds a
 * bare number and the currency it is read in is the page's, not the rule's.
 */
export function describeRule(rule: FolderRule, money: (value: number) => string): string {
  const label = RULE_KIND_LABEL[rule.kind];
  switch (rule.kind) {
    case "price":
    case "manaValue": {
      const fmt = rule.kind === "price" ? money : (v: number) => String(v);
      const words = rangeWords(
        rule.min === null ? null : fmt(rule.min),
        rule.max === null ? null : fmt(rule.max),
        (hi) => `up to ${hi}`,
        (lo) => `${lo} or more`,
      );
      return words === "any" ? `${label}: any` : `${label} ${words}`;
    }
    case "released": {
      const words = rangeWords(
        rule.from,
        rule.to,
        (hi) => `through ${hi}`,
        (lo) => `${lo} onwards`,
        (v) => `in ${v}`,
      );
      return words === "any" ? `${label}: any` : `Released ${words}`;
    }
    default: {
      const kind = rule.kind;
      if (rule.values.length === 0) return `${label}: none picked`;
      return `${label}: ${orList(rule.values.map((v) => valueLabel(kind, v)))}`;
    }
  }
}

/**
 * The slice of a folder this module reads — `CollectionFolder` and `WishlistFolder` both answer
 * it. No `sortOrder`, which is why {@link subtreeConflicts} walks the tree itself rather than
 * through `folderTree.ts`' `folderDescendants` (whose `FolderLike` asks for one).
 */
export interface RuleFolder {
  id: number;
  parentId: number | null;
  name: string;
  rules: readonly FolderRule[];
}

export interface InheritedRules {
  folderId: number;
  folderName: string;
  rules: readonly FolderRule[];
}

/**
 * A folder's own rules and those it adopts from above (spec §2). `inherited` is nearest ancestor
 * first, and an ancestor with no rules of its own is left out — it has nothing to say under its
 * name.
 */
export interface EffectiveRules {
  own: readonly FolderRule[];
  inherited: readonly InheritedRules[];
}

const NO_RULES: EffectiveRules = { own: [], inherited: [] };

/**
 * Walk up from `id` collecting each ancestor's rules.
 *
 * **Cycle-safe with a visited set**, for `lockedFolderIds`' reason: `move_folder` refuses to write
 * a cycle, so only a hand-edited database holds one — and a badge that hung the window over it
 * would be worse than the corruption.
 */
export function effectiveRules(folders: readonly RuleFolder[], id: number): EffectiveRules {
  const byId = new Map(folders.map((f) => [f.id, f]));
  const folder = byId.get(id);
  if (folder === undefined) return NO_RULES;
  const inherited: InheritedRules[] = [];
  const seen = new Set<number>([id]);
  let parentId = folder.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent === undefined) break;
    if (parent.rules.length > 0) {
      inherited.push({ folderId: parent.id, folderName: parent.name, rules: parent.rules });
    }
    parentId = parent.parentId;
  }
  return { own: folder.rules, inherited };
}

export function hasRules(effective: EffectiveRules): boolean {
  return effective.own.length > 0 || effective.inherited.length > 0;
}

/**
 * The conflicts a folder card stands for: its own and every descendant's (spec §5).
 *
 * The backend counts each folder **alone** — a card filed in `Foils` is not also counted under
 * `Binder` — because a sub-tree sum is a fact about the tree the reader is looking at, and the
 * tree is this side's. Breadth-first with a visited set, so a corrupt cycle terminates.
 */
export function subtreeConflicts(
  folders: readonly RuleFolder[],
  conflicts: readonly FolderConflicts[],
  id: number,
): { entries: number; copies: number } {
  const inTree = new Set<number>([id]);
  let frontier = [id];
  while (frontier.length > 0) {
    const level = new Set(frontier);
    frontier = [];
    for (const f of folders) {
      if (f.parentId === null || !level.has(f.parentId) || inTree.has(f.id)) continue;
      inTree.add(f.id);
      frontier.push(f.id);
    }
  }
  let entries = 0;
  let copies = 0;
  for (const c of conflicts) {
    if (!inTree.has(c.folderId)) continue;
    entries += c.entries;
    copies += c.copies;
  }
  return { entries, copies };
}

/**
 * `1 card doesn't match this folder's rules`, `3 cards don't match this folder's rules`.
 * `nouns` is the plural, passed rather than derived for `plural`'s reason (`wish` → `wishes`).
 */
export function conflictSentence(n: number, noun = "card", nouns = `${noun}s`): string {
  return `${count(n)} ${n === 1 ? noun : nouns} ${verb(n, "doesn't", "don't")} match this folder's rules`;
}

/**
 * What a card that breaks its folder's rules says, beside its name — the wall tile's and the table
 * row's accessible description (spec §5). One sentence for every surface, so a screen reader hears
 * the outline the same way wherever it is drawn.
 */
export const RULE_BREAK = "Doesn't match its folder's rules";

/**
 * A table row's red left edge, for a row whose card breaks its folder's rules (spec §5). **An
 * inset shadow rather than a `border-l`**: a row is a grid whose columns line up with the header's,
 * and a 2px border would push one row's cells 2px right of every other row's.
 */
export const RULE_BREAK_EDGE = "shadow-[inset_2px_0_0_var(--color-destructive)]";

/** The tidy's four sentences (spec §4), spelled once so the dialog and its tests agree. */
export const RULE_REFUSAL = {
  tooMany: `A folder can hold at most ${MAX_RULES} rules.`,
  noValues: "Pick at least one value for each rule.",
  range: "Give each range at least one end, with the lower end first.",
  date: "Write dates as YYYY, YYYY-MM or YYYY-MM-DD.",
} as const;

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, with a month and a day that can exist. */
const DATE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;

/** The values a values rule would keep after the tidy — its vocabulary's words, or for sets any
 *  non-blank code. */
function keptValues(rule: ValuesRule): string[] {
  if (rule.kind === "sets") return rule.values.map((v) => v.trim()).filter((v) => v !== "");
  const vocabulary = RULE_VALUES[rule.kind];
  return rule.values.filter((v) => vocabulary.includes(v));
}

/**
 * Why the backend would refuse this rule, or `null` — the same refusals as `folder_rules::tidy`
 * (spec §4), so the dialog greys Save with the reason before a round trip finds it.
 *
 * Two dates are ordered on their common prefix: `to` is read through the end of its own length
 * (`2000` is all of 2000), so `from: "2000-06", to: "2000"` is a range and not a reversal.
 */
export function validateRule(rule: FolderRule): string | null {
  switch (rule.kind) {
    case "price":
    case "manaValue": {
      const { min, max } = rule;
      if (min === null && max === null) return RULE_REFUSAL.range;
      if (
        (min !== null && (!Number.isFinite(min) || min < 0)) ||
        (max !== null && (!Number.isFinite(max) || max < 0))
      ) {
        return RULE_REFUSAL.range;
      }
      if (min !== null && max !== null && min > max) return RULE_REFUSAL.range;
      return null;
    }
    case "released": {
      const { from, to } = rule;
      if (from === null && to === null) return RULE_REFUSAL.range;
      if ((from !== null && !DATE.test(from)) || (to !== null && !DATE.test(to))) {
        return RULE_REFUSAL.date;
      }
      if (from !== null && to !== null) {
        const n = Math.min(from.length, to.length);
        if (from.slice(0, n) > to.slice(0, n)) return RULE_REFUSAL.range;
      }
      return null;
    }
    default:
      return keptValues(rule).length === 0 ? RULE_REFUSAL.noValues : null;
  }
}

/** The first refusal over a whole list — the count first, then each rule in order. */
export function validateRules(rules: readonly FolderRule[]): string | null {
  if (rules.length > MAX_RULES) return RULE_REFUSAL.tooMany;
  for (const rule of rules) {
    const reason = validateRule(rule);
    if (reason !== null) return reason;
  }
  return null;
}
