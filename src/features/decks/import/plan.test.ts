import { describe, expect, it } from "vitest";
import type { FormatSpec, ImportMatch, ImportResolveRow } from "@/lib/ipc";
import { PREDEFINED_CATEGORY_NAMES } from "../autoCategory";
import { spec } from "../validation/fixtures";
import { parseDecklist } from "./parse";
import { SECTION_CATEGORY, buildImportPlan, toImportItems, type ImportPlan } from "./plan";

/**
 * One resolved printing, with everything the plan does not read filled in as nothing.
 *
 * Local rather than borrowed from `.storybook/fake/fixtures`: this is domain logic under
 * Vitest, and a test that reached into the Storybook fake would tie the parser's contract to
 * the workbench's.
 */
function match(over: Partial<ImportMatch> & { name: string }): ImportMatch {
  return {
    cardId: over.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    setCode: "tst",
    collectorNumber: "1",
    lang: "en",
    oracleId: null,
    manaCost: null,
    cmc: null,
    typeLine: null,
    oracleText: null,
    colors: null,
    colorIdentity: null,
    legalities: null,
    power: null,
    toughness: null,
    layout: null,
    rarity: null,
    faces: null,
    gameChanger: false,
    everUncommon: false,
    unitPriceUsd: null,
    ownedQuantity: 0,
    printingCount: 1,
    ...over,
  };
}

/** A pasted list, resolved by a lookup on the name each line wrote. A name this record has
 *  never heard of resolves to nothing, which is how an unmatched line is staged. */
function planFor(
  text: string,
  cards: Record<string, ImportMatch>,
  format: FormatSpec | null = null,
): ImportPlan {
  const parsed = parseDecklist(text);
  const rows: ImportResolveRow[] = parsed.lines.map((line, index) => ({
    index,
    matched: cards[line.name] ?? null,
    hintMissed: false,
  }));
  return buildImportPlan(parsed, rows, format);
}

const SOL_RING = match({ name: "Sol Ring", typeLine: "Artifact" });
const FOREST = match({ name: "Forest", typeLine: "Basic Land — Forest" });
const ELVES = match({ name: "Llanowar Elves", typeLine: "Creature — Elf Druid" });
const BOLT = match({ name: "Lightning Bolt", typeLine: "Instant" });
const KENRITH = match({
  name: "Kenrith, the Returned King",
  typeLine: "Legendary Creature — Human Noble",
  power: "5",
  toughness: "5",
  colorIdentity: "BGRUW",
});
const SISAY = match({
  name: "Captain Sisay",
  typeLine: "Legendary Creature — Human Legend",
  power: "2",
  toughness: "2",
  colorIdentity: "GW",
});

describe("buildImportPlan", () => {
  it("files a card by its type line when the file said nothing", () => {
    const plan = planFor("1 Sol Ring\n6 Forest\n4 Llanowar Elves", {
      "Sol Ring": SOL_RING,
      Forest: FOREST,
      "Llanowar Elves": ELVES,
    });

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Sol Ring", "Artifact"],
      ["Forest", "Land"],
      ["Llanowar Elves", "Creature"],
    ]);
  });

  /** `autoCategoryFor`'s own rule, and the reason its match order leads with Land: no decklist
   *  ever written puts Dryad Arbor in the creature column. */
  it("files a land creature as a land", () => {
    const plan = planFor("1 Dryad Arbor", {
      "Dryad Arbor": match({ name: "Dryad Arbor", typeLine: "Land Creature — Forest Dryad" }),
    });

    expect(plan.cards[0].categoryName).toBe("Land");
  });

  /**
   * A resolved line always has its printing's type line in hand, so `null` here is a card that
   * genuinely has none — never the "the caller said nothing" case `DEFAULT_CATEGORY_NAME`
   * answers for a single add.
   */
  it("files a card with no type line as Uncategorised", () => {
    const plan = planFor("1 Undercity", { Undercity: match({ name: "Undercity" }) });

    expect(plan.cards[0].categoryName).toBe("Uncategorised");
  });

  it("lets a file section name the category", () => {
    const plan = planFor(
      `Commander
1 Captain Sisay

Deck
1 Sol Ring

Sideboard
1 Lightning Bolt

Companion
1 Llanowar Elves

Maybeboard
6 Forest`,
      {
        "Captain Sisay": SISAY,
        "Sol Ring": SOL_RING,
        "Lightning Bolt": BOLT,
        "Llanowar Elves": ELVES,
        Forest: FOREST,
      },
    );

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Captain Sisay", "Commander"],
      ["Sol Ring", "Artifact"],
      ["Lightning Bolt", "Sideboard"],
      ["Llanowar Elves", "Companion"],
      ["Forest", "Maybeboard"],
    ]);
  });

  /**
   * The four names have to be `schema::PREDEFINED_CATEGORIES` **verbatim**, because
   * `category_for_name` finds-or-creates by name alone: a fifth spelling would build a second
   * pile beside the seeded one, with a `main` kind and the switch on.
   */
  it("names the sections the way a deck seeds them", () => {
    for (const name of Object.values(SECTION_CATEGORY)) {
      expect(PREDEFINED_CATEGORY_NAMES).toContain(name);
    }
  });

  /** The Maybeboard is the one seeded category that arrives switched off — a fact about that
   *  row's `is_active`, never about its kind. */
  it("marks the Maybeboard tally inactive and no other", () => {
    const plan = planFor(
      `Commander
1 Captain Sisay

Sideboard
1 Lightning Bolt

Companion
1 Llanowar Elves

Maybeboard
6 Forest`,
      {
        "Captain Sisay": SISAY,
        "Lightning Bolt": BOLT,
        "Llanowar Elves": ELVES,
        Forest: FOREST,
      },
    );

    expect(plan.categories.filter((c) => c.inactive).map((c) => c.name)).toEqual(["Maybeboard"]);
    expect(plan.categories.filter((c) => !c.inactive)).toHaveLength(3);
  });

  it("orders the tally: sections first, then the type buckets in reading order", () => {
    const plan = planFor(
      `Commander
1 Captain Sisay

Deck
6 Forest
1 Lightning Bolt
1 Sol Ring
1 Llanowar Elves
1 Undercity

Sideboard
1 Path to Exile

Companion
1 Lurrus of the Dream-Den

Maybeboard
1 Shock`,
      {
        "Captain Sisay": SISAY,
        Forest: FOREST,
        "Lightning Bolt": BOLT,
        "Sol Ring": SOL_RING,
        "Llanowar Elves": ELVES,
        Undercity: match({ name: "Undercity" }),
        "Path to Exile": match({ name: "Path to Exile", typeLine: "Instant" }),
        "Lurrus of the Dream-Den": match({
          name: "Lurrus of the Dream-Den",
          typeLine: "Legendary Creature — Cat Nightmare",
        }),
        Shock: match({ name: "Shock", typeLine: "Instant" }),
      },
    );

    expect(plan.categories.map((c) => c.name)).toEqual([
      "Commander",
      "Sideboard",
      "Companion",
      "Maybeboard",
      "Creature",
      "Artifact",
      "Instant",
      "Land",
      "Uncategorised",
    ]);
  });

  /** Quoted back, never an error: the import proceeds without it, and the copies it asked for
   *  are not counted as landing. */
  it("quotes a line that resolved to nothing and keeps it out of the cards", () => {
    const plan = planFor("1 Sol Ring\n2 Definitely Not A Card", { "Sol Ring": SOL_RING });

    expect(plan.unmatched).toEqual([
      { lineNumber: 2, raw: "2 Definitely Not A Card", name: "Definitely Not A Card" },
    ]);
    expect(plan.cards.map((c) => c.match.name)).toEqual(["Sol Ring"]);
    expect(plan.totalCards).toBe(1);
  });

  it("quotes a missed printing hint and names what was used instead", () => {
    const parsed = parseDecklist("1 Sol Ring (XYZ) 999");
    const plan = buildImportPlan(
      parsed,
      [
        {
          index: 0,
          matched: match({
            name: "Sol Ring",
            typeLine: "Artifact",
            setCode: "ltc",
            collectorNumber: "285",
          }),
          hintMissed: true,
        },
      ],
      null,
    );

    // Capitals, the way a set code is printed on a card — `cards.set_code` holds it lowercase.
    expect(plan.hintMisses).toEqual([{ lineNumber: 1, name: "Sol Ring", used: "LTC 285" }]);
    // A missed hint is never a reason to lose the card.
    expect(plan.cards).toHaveLength(1);
  });

  /** A missed hint whose name also matched nothing has no printing to name, which is why
   *  `HintMiss.used` is not nullable: that line is an unmatched one and nothing else. */
  it("records no hint miss for a line that resolved to nothing at all", () => {
    const parsed = parseDecklist("1 Definitely Not A Card (XYZ) 999");
    const plan = buildImportPlan(parsed, [{ index: 0, matched: null, hintMissed: true }], null);

    expect(plan.hintMisses).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
  });

  it("carries the parse issues through untouched", () => {
    const parsed = parseDecklist("1 Sol Ring\n0 Shock");
    const plan = buildImportPlan(
      parsed,
      parsed.lines.map((_, index) => ({ index, matched: SOL_RING, hintMissed: false })),
      null,
    );

    expect(plan.parseIssues).toEqual(parsed.issues);
    expect(plan.parseIssues).toEqual([
      { lineNumber: 2, raw: "0 Shock", reason: "A count of zero is not an import." },
    ]);
  });

  /** Two lines, one pile: the tally counts copies, because the deck's grain folds the two rows
   *  into one and a preview that said "2 cards" would disagree with the deck it built. */
  it("sums the quantities of a card named twice into one tally", () => {
    const plan = planFor("4 Forest\n2 Forest", { Forest: FOREST });

    expect(plan.categories).toEqual([{ name: "Land", cards: 6, inactive: false }]);
    expect(plan.cards).toHaveLength(2);
    expect(plan.totalCards).toBe(6);
  });
});

describe("the commander", () => {
  it("says nothing when the format has no commander rule", () => {
    const plan = planFor("1 Captain Sisay", { "Captain Sisay": SISAY }, spec("modern"));

    expect(plan.commander).toEqual({ kind: "notApplicable" });
  });

  it("defers to the file when a Commander section named one", () => {
    const plan = planFor(
      `Commander
1 Captain Sisay

Deck
1 Kenrith, the Returned King`,
      { "Captain Sisay": SISAY, "Kenrith, the Returned King": KENRITH },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "fromFile" });
    expect(plan.cards[0].categoryName).toBe("Commander");
  });

  it("picks the only eligible card by itself", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Sol Ring\n6 Forest\n1 Lightning Bolt",
      { "Captain Sisay": SISAY, "Sol Ring": SOL_RING, Forest: FOREST, "Lightning Bolt": BOLT },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "automatic", cardIds: [SISAY.cardId] });
  });

  /** Never from position: "the first line is the commander" and "the last line is" are both
   *  real export conventions and each is wrong about half the lists in the wild. */
  it("asks when more than one card is eligible", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Kenrith, the Returned King\n1 Sol Ring",
      { "Captain Sisay": SISAY, "Kenrith, the Returned King": KENRITH, "Sol Ring": SOL_RING },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "ask", candidates: [SISAY, KENRITH] });
  });

  /** One card named twice is one candidate. An ask between a card and itself is not a
   *  question, and it would demote a perfectly clear list out of `automatic`. */
  it("counts a card named on two lines once", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Captain Sisay",
      { "Captain Sisay": SISAY },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "automatic", cardIds: [SISAY.cardId] });
  });

  it("asks with no candidates when nothing is eligible", () => {
    const plan = planFor(
      "1 Sol Ring\n6 Forest\n1 Lightning Bolt",
      { "Sol Ring": SOL_RING, Forest: FOREST, "Lightning Bolt": BOLT },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "ask", candidates: [] });
  });
});

describe("toImportItems", () => {
  it("moves the chosen commanders into Commander and leaves the rest", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Sol Ring\n6 Forest",
      { "Captain Sisay": SISAY, "Sol Ring": SOL_RING, Forest: FOREST },
      spec("commander"),
    );

    expect(toImportItems(plan, [SISAY.cardId])).toEqual([
      { cardId: SISAY.cardId, quantity: 1, categoryName: "Commander" },
      { cardId: SOL_RING.cardId, quantity: 1, categoryName: "Artifact" },
      { cardId: FOREST.cardId, quantity: 6, categoryName: "Land" },
    ]);
  });

  it("is empty when the plan matched nothing", () => {
    const plan = planFor("1 Definitely Not A Card", {});

    expect(toImportItems(plan, [])).toEqual([]);
  });

  /** One item per line, whatever the copy count — `deck_import_commit` sums two items that
   *  land on the same grain, so a per-copy item list would be 117 rows of arithmetic nobody
   *  needs. */
  it("emits one item per planned card, not per copy", () => {
    const plan = planFor("6 Forest", { Forest: FOREST });

    expect(toImportItems(plan, [])).toEqual([
      { cardId: FOREST.cardId, quantity: 6, categoryName: "Land" },
    ]);
  });
});
