/**
 * The whole-deck golden: `../__golden__/whole-deck.json` — `validateDeck` and `validateForMarks`
 * over decks that hold a companion, so the full pipeline (size, sideboard, copies, the pool, the
 * command zone **and** the companion) is held together, which neither `validation.json` (no
 * companions) nor `companions.json` (`companionIssues` alone) does on its own.
 * `crates/grimoire-core/src/deck_rules/engine.rs` must reproduce it. See `golden.ts` for the file
 * shape and why a golden is never edited by hand.
 */
import { describe, expect, it } from "vitest";
import type { CategoryKind, DeckCard } from "@/lib/ipc";
import { goldenText, type GoldenCase } from "./golden";
import {
  CATEGORIES,
  SPECS,
  card,
  commander,
  islands,
  padTo,
  resetRowIds,
} from "../validation/fixtures";
import { validateDeck, validateForMarks } from "../validation/engine";

type Facts = Partial<DeckCard>;

const REMINDER =
  " (If this card is your chosen companion, you may put it into your hand from outside the " +
  "game for {3} as a sorcery.)";

const LURRUS: Facts = {
  name: "Lurrus of the Dream-Den",
  manaCost: "{1}{W/B}{W/B}",
  cmc: 3,
  typeLine: "Legendary Creature — Cat Nightmare",
  oracleText:
    "Companion — Each permanent card in your starting deck has mana value 2 or less." + REMINDER,
  colors: "BW",
  colorIdentity: "BW",
};

const YORION: Facts = {
  name: "Yorion, Sky Nomad",
  manaCost: "{3}{W/U}{W/U}",
  cmc: 5,
  typeLine: "Legendary Creature — Bird Serpent",
  oracleText:
    "Companion — Your starting deck contains at least twenty cards more than the minimum deck " +
    "size." +
    REMINDER,
  colors: "UW",
  colorIdentity: "UW",
};

const JEGANTHA: Facts = {
  name: "Jegantha, the Wellspring",
  manaCost: "{4}{R/G}",
  cmc: 5,
  typeLine: "Legendary Creature — Elemental Elk",
  oracleText:
    "Companion — No card in your starting deck has more than one of the same mana symbol in its " +
    "mana cost." +
    REMINDER,
  colors: "GR",
  colorIdentity: "BGRUW",
};

const WRATH: Facts = {
  name: "Wrath of God",
  manaCost: "{2}{W}{W}",
  cmc: 4,
  typeLine: "Sorcery",
  oracleText: "Destroy all creatures. They can't be regenerated.",
  colors: "W",
  colorIdentity: "W",
};

const SERRA: Facts = {
  name: "Serra Angel",
  manaCost: "{3}{W}{W}",
  cmc: 5,
  typeLine: "Creature — Angel",
  oracleText: "Flying, vigilance",
  colors: "W",
  colorIdentity: "W",
};

const BOLT: Facts = { name: "Lightning Bolt" };

function inKind(kind: CategoryKind, facts: Facts, extra: Facts = {}): DeckCard {
  return card({
    ...facts,
    categoryKind: kind,
    categoryId: CATEGORIES[kind].id,
    categoryName: CATEGORIES[kind].name,
    ...extra,
  });
}

const companion = (facts: Facts, extra: Facts = {}) => inKind("companion", facts, extra);

const cases: GoldenCase[] = [];

function add(name: string, spec: keyof typeof SPECS, build: () => DeckCard[]): void {
  resetRowIds();
  const cards = build();
  cases.push({
    name,
    spec,
    cards,
    deck: validateDeck(cards, SPECS[spec]),
    marks: validateForMarks(cards, SPECS[spec]),
  });
}

add("a Lurrus deck that keeps its condition", "modern", () =>
  padTo(60, [companion(LURRUS), inKind("main", BOLT, { quantity: 4 })]),
);
add("a Lurrus deck that breaks it, with fourteen Bolts in the sideboard beside it", "modern", () =>
  padTo(60, [
    companion(LURRUS),
    inKind("main", SERRA, { quantity: 2 }),
    inKind("side", BOLT, { quantity: 14 }),
  ]),
);
add("a companion takes the sixteenth sideboard slot", "modern", () =>
  padTo(60, [companion(LURRUS), inKind("side", BOLT, { quantity: 15 })]),
);
add("Lurrus as companion and four in the main deck is five copies", "modern", () =>
  padTo(60, [companion(LURRUS), inKind("main", LURRUS, { quantity: 4 })]),
);
add("Yorion short of twenty over the minimum", "modern", () => padTo(70, [companion(YORION)]));
add("Yorion at eighty cards", "modern", () => padTo(80, [companion(YORION)]));
add("two companions", "modern", () => padTo(80, [companion(YORION), companion(LURRUS)]));
add("Gladiator has no companions", "gladiator", () => padTo(100, [companion(LURRUS)]));
add("a commander deck's companion inside the identity", "commander", () =>
  padTo(100, [commander(), companion(JEGANTHA)]),
);
add("a commander deck's companion outside a narrower identity", "commander", () =>
  padTo(100, [
    card({
      name: "Teysa Karlov",
      categoryKind: "commander",
      typeLine: "Legendary Creature — Human Advisor",
      manaCost: "{2}{W}{B}",
      cmc: 4,
      colors: "BW",
      colorIdentity: "BW",
    }),
    companion(YORION),
    inKind("main", WRATH),
  ]),
);
add("a switched-off companion pile counts toward nothing", "modern", () =>
  padTo(60, [companion(LURRUS, { categoryActive: false }), inKind("main", SERRA)]),
);
add("a switched-on Maybeboard is in Lurrus's starting deck", "modern", () =>
  padTo(60, [companion(LURRUS), inKind("maybe", SERRA, { categoryActive: true })]),
);
add("a Jegantha deck with a repeated symbol and a banned card", "modern", () =>
  padTo(60, [
    companion(JEGANTHA),
    inKind("main", WRATH),
    inKind("main", BOLT, {
      legalities: JSON.stringify({ modern: "banned", vintage: "legal", commander: "legal" }),
    }),
  ]),
);
add("an under-sized deck with a companion and a parked banned card", "modern", () => [
  companion(LURRUS),
  islands(40),
  inKind("maybe", BOLT, {
    legalities: JSON.stringify({ modern: "banned", vintage: "legal", commander: "legal" }),
  }),
]);

describe("the whole-deck golden", () => {
  it("holds a companion in every case", () => {
    expect(
      cases
        .filter((c) => !c.cards.some((row) => row.categoryKind === "companion"))
        .map((c) => c.name),
    ).toEqual([]);
  });

  it("write whole-deck.json", async () => {
    const text = goldenText(
      "Written by packages/ui/features/decks/golden/whole-deck.golden.test.ts from validateDeck " +
        "and validateForMarks over decks with a companion; read by " +
        "crates/grimoire-core/src/deck_rules/engine.rs. Never edit by hand.",
      cases,
      SPECS,
    );
    await expect(text).toMatchFileSnapshot("../__golden__/whole-deck.json");
  });
});
