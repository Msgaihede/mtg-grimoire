/**
 * The coverage fence over the deck goldens: a rule with no golden case is a rule the Rust port is
 * not held to, so this fails when one goes missing. `crates/grimoire-core/src/deck_rules/mod.rs`'
 * `the_goldens_cover_every_rule` holds the same lists on the Rust side.
 *
 * Read from the committed files rather than from the suites that write them, so it judges what
 * the Rust reads.
 */
import { describe, expect, it } from "vitest";
import { SPECS } from "../validation/fixtures";
import bracketText from "../__golden__/bracket.json?raw";
import companionsText from "../__golden__/companions.json?raw";
import validationText from "../__golden__/validation.json?raw";
import wholeDeckText from "../__golden__/whole-deck.json?raw";

interface Issue {
  code: string;
}
interface Row {
  name: string;
  categoryKind?: string;
}
interface File<C> {
  specs?: Record<string, { key: string; commanderRule: string | null }>;
  cases: C[];
}

const validation = JSON.parse(validationText) as File<{
  spec: string;
  deck: Issue[];
  marks: Issue[];
}>;
const wholeDeck = JSON.parse(wholeDeckText) as File<{
  spec: string;
  deck: Issue[];
  marks: Issue[];
}>;
const companions = JSON.parse(companionsText) as File<{
  spec: string;
  cards: Row[];
  issues: Issue[];
}>;
const bracket = JSON.parse(bracketText) as File<{
  combos: { bracketTag: string }[];
  estimate: { reasons: { code: string }[] };
}>;

/** `types.ts`' vocabulary, every module's codes together. */
const ISSUE_CODES = [
  "deck-size",
  "sideboard-size",
  "copy-limit",
  "singleton",
  "restricted",
  "banned",
  "not-legal",
  "unknown-legality",
  "unknown-copy-limit",
  "orphan",
  "mana-value",
  "commander-zone",
  "commander-missing",
  "commander-count",
  "commander-eligibility",
  "commander-partner",
  "commander-banned",
  "color-identity",
  "companion-zone",
  "companion-count",
  "companion-eligibility",
  "companion-unknown",
  "companion-condition",
];

/** `companions.ts`' `COMPANIONS`, which it does not export. */
const COMPANION_NAMES = [
  "Gyruda, Doom of Depths",
  "Jegantha, the Wellspring",
  "Kaheera, the Orphanguard",
  "Keruga, the Macrosage",
  "Lurrus of the Dream-Den",
  "Lutri, the Spellchaser",
  "Obosh, the Preypiercer",
  "Umori, the Collector",
  "Yorion, Sky Nomad",
  "Zirda, the Dawnwaker",
];

const REASON_CODES = ["game-changers", "mass-land-denial", "extra-turns", "combo"];
const COMBO_LETTERS = ["R", "S", "P", "O", "C", "E", "B"];

const missing = (wanted: readonly string[], seen: Iterable<string>) => {
  const have = new Set(seen);
  return wanted.filter((w) => !have.has(w));
};

describe("the deck goldens cover every rule", () => {
  it("every issue code appears in an answer", () => {
    const codes = [
      ...validation.cases.flatMap((c) => [...c.deck, ...c.marks]),
      ...wholeDeck.cases.flatMap((c) => [...c.deck, ...c.marks]),
      ...companions.cases.flatMap((c) => c.issues),
    ].map((i) => i.code);
    expect(missing(ISSUE_CODES, codes)).toEqual([]);
    expect(missing(codes, ISSUE_CODES)).toEqual([]);
  });

  it("every fixture spec, and so every commander rule, is a case's", () => {
    const named = validation.cases.map((c) => validation.specs?.[c.spec]?.key ?? c.spec);
    expect(missing(Object.keys(SPECS), named)).toEqual([]);
    const rules = Object.values(SPECS).flatMap((s) => (s.commanderRule ? [s.commanderRule] : []));
    const judged = validation.cases.flatMap((c) => validation.specs?.[c.spec]?.commanderRule ?? []);
    expect(missing(rules, judged)).toEqual([]);
  });

  it("every companion sits in a companion zone", () => {
    const zoned = companions.cases.flatMap((c) =>
      c.cards.filter((r) => r.categoryKind === "companion").map((r) => r.name),
    );
    expect(missing(COMPANION_NAMES, zoned)).toEqual([]);
  });

  it("every bracket reason fires and every combo letter is read", () => {
    const reasons = bracket.cases.flatMap((c) => c.estimate.reasons.map((r) => r.code));
    expect(missing(REASON_CODES, reasons)).toEqual([]);
    const letters = bracket.cases.flatMap((c) => c.combos.map((combo) => combo.bracketTag));
    expect(missing(COMBO_LETTERS, letters)).toEqual([]);
  });
});
