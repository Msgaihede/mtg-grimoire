import { describe, expect, it } from "vitest";
import type {
  FormatSpec,
  ImportItem,
  ImportMatch,
  ImportResolveRow,
  PrintingTags,
} from "@/lib/ipc";
import { PREDEFINED_CATEGORY_NAMES, UNCATEGORIZED } from "@/features/decks/autoCategory";
import { DEFAULT_LABEL_COLOR } from "@/features/decks/labelColors";
import { spec } from "@/features/decks/validation/fixtures";
// `match` is the stubbed resolver, and it lives beside the corpus because `decklists.test.ts`
// needs the same one — see its doc for what it claims and what it refuses to claim.
import { ARCHIDEKT_LABELLED, ARCHIDEKT_SECTIONED, REFERENCE_LIST, match } from "../fixtures";
import { parseDecklist } from "../parse";
import {
  SECTION_CATEGORY,
  buildImportPlan,
  tallyOf,
  toImportItems,
  type CategoryTally,
  type ImportPlan,
} from "./deck";

/**
 * A pasted list, resolved by a lookup on the name each line wrote. A name this record has
 * never heard of resolves to nothing, which is how an unmatched line is staged.
 *
 * `tags` is what one `oracle_tags_for_printings` over the resolved ids answered, and it
 * **defaults to nothing** — which is the state of every test written before the taxonomy
 * existed and of every app that has never downloaded it. Passing none files the whole list by
 * type line, which is the floor this feature stands on rather than a special case.
 *
 * `forced` is the pile a right-click aimed the import at, and it defaults to nothing for the
 * same reason: every case written before it passes none and reads exactly as it did.
 */
function planFor(
  text: string,
  cards: Record<string, ImportMatch>,
  format: FormatSpec | null = null,
  tags: readonly PrintingTags[] = [],
  forced?: string,
): ImportPlan {
  const parsed = parseDecklist(text);
  const rows: ImportResolveRow[] = parsed.lines.map((line, index) => ({
    index,
    matched: cards[line.name] ?? null,
    hintMissed: false,
  }));
  return buildImportPlan(parsed, rows, format, tags, forced);
}

/** The piles a preview would draw for this plan and this commander choice — the two calls the
 *  dialog makes, in the order it makes them, because the tally is a fact about the items. */
function tallyFor(plan: ImportPlan, commanderIds: readonly string[] = []): CategoryTally[] {
  return tallyOf(toImportItems(plan, commanderIds));
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
/** A legendary creature whose *function* is ramp — Scryfall tags her `ramp` and
 *  `mana-producer` — so the auto rule files her under Ramp and the command zone has to outrank
 *  that. Solemn Simulacrum, the card everyone reaches for here, is not legendary. */
const SELVALA = match({
  name: "Selvala, Heart of the Wilds",
  typeLine: "Legendary Creature — Elf Scout",
  power: "2",
  toughness: "3",
  colorIdentity: "G",
});
/** The measured reason Land is pinned by type line before a tag is read: 52% of lands carry a
 *  functional tag, and this one searches, so a rule that asked the tags first would file a
 *  fetchland under Tutor and scatter the mana base across a dozen columns. */
const VISTA = match({ name: "Prismatic Vista", typeLine: "Land" });

/** What `oracle_tags_for_printings` answered, in the shape it answers it: one entry per
 *  **distinct** card id, in whatever order the statement came back in. */
function tags(...entries: [ImportMatch, string[]][]): PrintingTags[] {
  return entries.map(([card, slugs]) => ({ cardId: card.cardId, slugs }));
}

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
  it("files a card with no type line as Uncategorized", () => {
    const plan = planFor("1 Undercity", { Undercity: match({ name: "Undercity" }) });

    expect(plan.cards[0].categoryName).toBe("Uncategorized");
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

    const categories = tallyFor(plan);
    expect(categories.filter((c) => c.inactive).map((c) => c.name)).toEqual(["Maybeboard"]);
    expect(categories.filter((c) => !c.inactive)).toHaveLength(3);
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

    expect(tallyFor(plan).map((c) => c.name)).toEqual([
      "Commander",
      "Sideboard",
      "Companion",
      "Maybeboard",
      "Creature",
      "Artifact",
      "Instant",
      "Land",
      "Uncategorized",
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

    expect(tallyFor(plan)).toEqual([{ name: "Land", cards: 6, inactive: false }]);
    expect(plan.cards).toHaveLength(2);
    expect(plan.totalCards).toBe(6);
  });
});

/**
 * The piles a decklist is really written in.
 *
 * `autoCategoryFor` reads a land's type line, then what the card **does**, then what it is —
 * and an imported line has to get the same answer a plain add and a column-less drag get, or
 * one deck files one card two ways. What is asserted here is the *wiring*: that the slugs
 * reach the rule, matched to the right card. Which slug means which pile is
 * `autoCategory.test.ts`'s job and is deliberately not re-asserted here.
 */
describe("filing an imported line by what the card does", () => {
  it("files a card by its tags rather than its type line", () => {
    const plan = planFor(
      "1 Lightning Bolt\n1 Sol Ring",
      { "Lightning Bolt": BOLT, "Sol Ring": SOL_RING },
      null,
      tags([BOLT, ["removal"]], [SOL_RING, ["ramp", "mana-producer"]]),
    );

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Lightning Bolt", "Removal"],
      ["Sol Ring", "Ramp"],
    ]);
  });

  /** **The floor, not an error case.** An untagged card, an id `cards` has never heard of and a
   *  printing with a NULL oracle id all answer with no slugs, and the rule's response to all
   *  three is the one it had before the taxonomy existed. */
  it("files a card the tag read said nothing about by its type line", () => {
    const plan = planFor(
      "1 Lightning Bolt\n1 Llanowar Elves",
      { "Lightning Bolt": BOLT, "Llanowar Elves": ELVES },
      null,
      // Elves is simply absent from the answer, which is how an untagged card comes back.
      tags([BOLT, ["removal"]]),
    );

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Lightning Bolt", "Removal"],
      ["Llanowar Elves", "Creature"],
    ]);
  });

  /** An empty slug list is an *answer*, and it means the same as no entry at all. */
  it("files a card answered with no slugs by its type line", () => {
    const plan = planFor("1 Lightning Bolt", { "Lightning Bolt": BOLT }, null, tags([BOLT, []]));

    expect(plan.cards[0].categoryName).toBe("Instant");
  });

  /**
   * **Land is pinned by type line before a single tag is consulted**, and Prismatic Vista is the
   * measured case: it searches, so it is tagged `tutor`, and a mana base scattered across a
   * Tutor column and a Draw column is the one pile every decklist draws whole.
   */
  it("keeps a land in Land however its tags read", () => {
    const plan = planFor(
      "1 Prismatic Vista",
      { "Prismatic Vista": VISTA },
      null,
      tags([VISTA, ["tutor", "fetchland"]]),
    );

    expect(plan.cards[0].categoryName).toBe("Land");
  });

  /**
   * **The match-by-id case, and it is the ordinary one rather than a corner.**
   * `oracle_tags_for_printings` drops duplicate ids, so a list naming a card on two lines gets
   * back **fewer** entries than it asked about — two answers here against three lines. Reading
   * `tags[i]` against the lines would file the third line by whatever the second card does, and
   * the last line by nothing at all.
   */
  it("files both lines when the same card is named twice", () => {
    const plan = planFor(
      "1 Lightning Bolt\n1 Llanowar Elves\n2 Lightning Bolt",
      { "Lightning Bolt": BOLT, "Llanowar Elves": ELVES },
      null,
      tags([BOLT, ["removal"]], [ELVES, ["ramp", "mana-producer"]]),
    );

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Lightning Bolt", "Removal"],
      ["Llanowar Elves", "Ramp"],
      ["Lightning Bolt", "Removal"],
    ]);
    // One pile, both lines, copies summed — the deck's grain folds them into one row.
    expect(tallyFor(plan)).toEqual([
      { name: "Removal", cards: 3, inactive: false },
      { name: "Ramp", cards: 1, inactive: false },
    ]);
  });

  /** The other half of the same rule: nothing may depend on the order the answers came back
   *  in. One statement per 500 ids answers in whatever order SQLite hands them over. */
  it("matches the answers by id and not by the order they arrived in", () => {
    const plan = planFor(
      "1 Lightning Bolt\n1 Llanowar Elves\n1 Sol Ring",
      { "Lightning Bolt": BOLT, "Llanowar Elves": ELVES, "Sol Ring": SOL_RING },
      null,
      tags([SOL_RING, ["ramp"]], [BOLT, ["removal"]]),
    );

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Lightning Bolt", "Removal"],
      ["Llanowar Elves", "Creature"],
      ["Sol Ring", "Ramp"],
    ]);
  });

  /**
   * **A refused tag read is not a refused import.** `useImport` answers `tags: []` when the
   * command rejects, and what that plans is the whole list, complete, filed exactly as this
   * app filed it before Oracle tags existed. An import is a large deliberate action and must
   * never be lost to a taxonomy fetch.
   */
  it("plans the whole list by type line when no tags arrived at all", () => {
    const list = "1 Lightning Bolt\n1 Sol Ring\n6 Forest\n4 Llanowar Elves";
    const cards = {
      "Lightning Bolt": BOLT,
      "Sol Ring": SOL_RING,
      Forest: FOREST,
      "Llanowar Elves": ELVES,
    };
    const byTypeLine = [
      ["Lightning Bolt", "Instant"],
      ["Sol Ring", "Artifact"],
      ["Forest", "Land"],
      ["Llanowar Elves", "Creature"],
    ];

    // The refusal's answer, and the same list with the argument simply absent — every caller
    // that has no tags to give passes one of these two, and they must not differ.
    expect(planFor(list, cards, null, []).cards.map((c) => [c.match.name, c.categoryName])).toEqual(
      byTypeLine,
    );
    expect(planFor(list, cards).cards.map((c) => [c.match.name, c.categoryName])).toEqual(
      byTypeLine,
    );
    expect(planFor(list, cards, null, []).totalCards).toBe(12);
  });

  /** The functional piles sort above the type ones, and Land stays last — `TALLY_ORDER` is
   *  derived from `AUTO_CATEGORY_DISPLAY_ORDER`, so the preview reads in the order the editor
   *  draws its columns in. */
  it("lists a functional pile above the type buckets and Land below them", () => {
    const plan = planFor(
      "6 Forest\n1 Llanowar Elves\n1 Lightning Bolt",
      { Forest: FOREST, "Llanowar Elves": ELVES, "Lightning Bolt": BOLT },
      null,
      tags([BOLT, ["removal"]]),
    );

    expect(tallyFor(plan).map((c) => c.name)).toEqual(["Removal", "Creature", "Land"]);
  });
});

/**
 * The piles a decklist wrote down for itself.
 *
 * An Archidekt export names a pile on every line — in the line's own `[bracket]`, and again in
 * the heading above it — and those names are the reader's filing, made weeks ago in somebody
 * else's deck builder. The app's rule has always been that an add naming a category is untouched,
 * so they sit one rung above {@link autoCategoryFor}, which answers for every line that named
 * nothing.
 *
 * Which text produces which `categoryName` is `parse.test.ts`'s job; what is asserted here is the
 * **chain** — that the name reaches the pile, that a zone and a right-click each outrank it, and
 * that `{noDeck}` rides all the way to the item.
 */
describe("filing an imported line by the pile its file named", () => {
  it("takes the pile the file named over the auto rule, and the auto rule when it named none", () => {
    const plan = planFor("1x Sol Ring (fic) 358 [Flash Enabler]\n1 Lightning Bolt", {
      "Sol Ring": SOL_RING,
      "Lightning Bolt": BOLT,
    });

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Sol Ring", "Flash Enabler"],
      ["Lightning Bolt", "Instant"],
    ]);
  });

  /** The other route to the same rung: Archidekt's sectioned export writes the pile as a heading
   *  as well as in each line's bracket, and a heading the section vocabulary has never heard of
   *  is a pile rather than a card. Llanowar Elves is the contrast — `Creature` by type line. */
  it("files a line by the heading it was printed under", () => {
    const plan = planFor("Deck\n1 Sol Ring\n\nRamp\n1 Llanowar Elves", {
      "Sol Ring": SOL_RING,
      "Llanowar Elves": ELVES,
    });

    expect(plan.cards.map((c) => [c.match.name, c.categoryName])).toEqual([
      ["Sol Ring", "Artifact"],
      ["Llanowar Elves", "Ramp"],
    ]);
  });

  it("lets a zone outrank a name, and a forced pile outrank both", () => {
    // A bracket naming one of the four zones is the **section**, and the parser keeps
    // `categoryName` null there — so `[Commander{top}]` reaches the command zone through the one
    // mechanism the seeded piles already use, rather than making a pile spelled the same way.
    const zoned = planFor("1x Captain Sisay (mmq) 231 [Commander{top}]", {
      "Captain Sisay": SISAY,
    });
    expect(zoned.cards[0].categoryName).toBe("Commander");

    // A pile the reader right-clicked a moment ago is the later and more specific naming.
    const forced = planFor(
      "1x Sol Ring (fic) 358 [Flash Enabler]",
      { "Sol Ring": SOL_RING },
      null,
      [],
      "Removal",
    );
    expect(forced.cards[0].categoryName).toBe("Removal");
  });

  it("carries the excluded flag onto the item it sends", () => {
    const plan = planFor("1x Sol Ring (fic) 358 [(New) Maybeboard{noDeck}{noPrice},Artifact]", {
      "Sol Ring": SOL_RING,
    });

    expect(plan.cards[0].excluded).toBe(true);
    expect(toImportItems(plan, [])).toEqual([
      {
        cardId: SOL_RING.cardId,
        quantity: 1,
        finish: null,
        categoryName: "(New) Maybeboard",
        inactive: true,
      },
    ]);
  });

  /** The command zone outranks the pile, so the flag that came with the pile goes with it: a
   *  commander in a switched-off category is a deck with no commander. */
  it("never sends an excluded commander", () => {
    const plan = planFor(
      "1x Captain Sisay (mmq) 231 [(New) Maybeboard{noDeck}{noPrice},Creature]",
      { "Captain Sisay": SISAY },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "automatic", cardIds: [SISAY.cardId] });
    expect(toImportItems(plan, [SISAY.cardId])).toEqual([
      {
        cardId: SISAY.cardId,
        quantity: 1,
        finish: null,
        categoryName: "Commander",
        inactive: false,
      },
    ]);
  });

  /** Two sources, one sentence: the seeded Maybeboard arrives switched off, and a `{noDeck}` pile
   *  the import is about to make will be. The preview owes the reader the same words for both. */
  it("counts a pile the file switched off as inactive, beside the seeded one", () => {
    const items: ImportItem[] = [
      { cardId: "a", quantity: 3, categoryName: "(New) Maybeboard", inactive: true },
      { cardId: "b", quantity: 2, categoryName: "Ramp" },
      { cardId: "c", quantity: 1, categoryName: "Maybeboard" },
    ];

    expect(tallyOf(items)).toEqual([
      { name: "Maybeboard", cards: 1, inactive: true },
      { name: "Ramp", cards: 2, inactive: false },
      { name: "(New) Maybeboard", cards: 3, inactive: true },
    ]);
  });

  /** **OR**ed across the items rather than read off the first one. Archidekt writes the same
   *  bracket on every card of a category, so agreement is the ordinary case — but a list that
   *  disagreed with itself still said `{noDeck}` about that pile, and a row quietly counted as
   *  ordinary is the one sentence the reader needed before pressing Import. */
  it("ORs the flag across the items of one pile", () => {
    expect(
      tallyOf([
        { cardId: "a", quantity: 1, categoryName: "Cuts" },
        { cardId: "b", quantity: 1, categoryName: "Cuts", inactive: true },
      ]),
    ).toEqual([{ name: "Cuts", cards: 2, inactive: true }]);
  });

  /**
   * The whole sectioned Archidekt export through the chain — 14 headings, a bracket on every
   * line and 17 `{noDeck}` cards, planned in one call.
   *
   * The resolver is stubbed by name, which is the same stand-in {@link planFor} makes and says
   * only "a printing answered this line". Nothing here asserts *which* printing: that is
   * `resolve_lines`' question and no TypeScript test can answer it.
   */
  it("plans the sectioned Archidekt export into the piles it names", () => {
    const parsed = parseDecklist(ARCHIDEKT_SECTIONED);
    const rows: ImportResolveRow[] = parsed.lines.map((line, index) => ({
      index,
      matched: match({ name: line.name }),
      hintMissed: false,
    }));

    const plan = buildImportPlan(parsed, rows, null);
    const items = toImportItems(plan, []);

    expect(plan.cards).toHaveLength(105);
    expect(plan.totalCards).toBe(117);
    // The 10 cards under the `Maybeboard` heading reach the seeded pile through the section; the
    // 7 under `(New) Maybeboard` are a pile the import will have to make, switched off.
    expect(items.filter((i) => i.inactive === true)).toHaveLength(17);
    expect(tallyOf(items).filter((t) => t.inactive)).toEqual([
      { name: "Maybeboard", cards: 10, inactive: true },
      { name: "(New) Maybeboard", cards: 7, inactive: true },
    ]);
    expect(items.filter((i) => i.categoryName === "Commander")).toHaveLength(1);
    // Every other line named a pile of the file's own, so nothing fell through to the type-line
    // fallback these stubbed printings would otherwise all land in.
    //
    // **The constant, never the word.** This read `"Uncategorised"` until 2026-08-16, when the
    // fallback pile was respelled `Uncategorized` on another branch — after which the filter
    // matched nothing whatever the planner did, and the assertion passed by being vacuous. A
    // rename is exactly the event that hollows out a string-literal assertion with nothing
    // going red.
    expect(items.filter((i) => i.categoryName === UNCATEGORIZED)).toHaveLength(0);
  });
});

/**
 * Archidekt's labels — `^Keeper,#4aab08^` — from the parsed line to the item the backend writes.
 *
 * The three questions this side owns: which distinct labels a list carries, what the reader's
 * ticks do to them, and which of the two channels a label survives. `commit_import` owns the
 * fourth — find or create — and its tests are in `import.rs`, because "is that the same label" is
 * `deck_labels.name_key`'s question and the UNIQUE index is the authority on it.
 */
describe("imported labels", () => {
  const labelled = (text: string, format: FormatSpec | null = null) => {
    const parsed = parseDecklist(text);
    const rows: ImportResolveRow[] = parsed.lines.map((line, index) => ({
      index,
      matched: match({ name: line.name }),
      hintMissed: false,
    }));
    return buildImportPlan(parsed, rows, format);
  };

  it("folds the labelled export into five labels, in the order the file first named each", () => {
    const plan = labelled(ARCHIDEKT_LABELLED);
    expect(plan.labels).toEqual([
      // 28 Snow-Covered Plains and four singles — **copies, not lines**, which is the whole of
      // why the fixture carries a 28× line.
      { key: "keeper", name: "Keeper", color: "#4aab08", copies: 32 },
      { key: "fence", name: "Fence", color: "#fffc19", copies: 1 },
      { key: "replace art", name: "Replace Art", color: "#d00dfa", copies: 4 },
      { key: "getting", name: "Getting", color: "#2ccce4", copies: 2 },
      // Not a restatement of `Fence`: two labels, two keys, two rows in the picker.
      { key: "fence (flavor)", name: "Fence (flavor)", color: "#fa890d", copies: 1 },
    ]);
  });

  it("folds two spellings of one label onto one row, keeping the first", () => {
    // `deck_labels.name_key` is the grain, so `Keeper` and `keeper` are one label — and offering
    // the reader two boxes for it would let them tick one and untick the other over a
    // distinction the database does not have.
    const plan = labelled("1 Sol Ring ^Keeper,#4aab08^\n2 Shock ^keeper,#ff0000^");
    expect(plan.labels).toEqual([
      { key: "keeper", name: "Keeper", color: "#4aab08", copies: 3 },
    ]);
  });

  it("gives a label with no colour the app's own first one", () => {
    // `deck_labels.color` is NOT NULL and picking what a colour *is* belongs to the webview, so
    // the default is applied here rather than at the write — which is what makes the swatch on
    // the step the colour the row would really be made with.
    const plan = labelled("1 Sol Ring ^Keeper^");
    expect(plan.labels).toEqual([
      { key: "keeper", name: "Keeper", color: DEFAULT_LABEL_COLOR.hex, copies: 1 },
    ]);
  });

  it("offers no label for a line nothing resolved", () => {
    const parsed = parseDecklist("1 Sol Ring ^Keeper,#4aab08^\n1 Nonesuch ^Ghost,#ffffff^");
    const rows: ImportResolveRow[] = parsed.lines.map((line, index) => ({
      index,
      matched: line.name === "Sol Ring" ? SOL_RING : null,
      hintMissed: false,
    }));
    // A label worn only by lines nothing matched is not a label this import can bring across.
    expect(buildImportPlan(parsed, rows, null).labels.map((l) => l.key)).toEqual(["keeper"]);
  });

  it("carries no labels at all for a list that has none", () => {
    expect(labelled(REFERENCE_LIST).labels).toEqual([]);
  });

  it("sends the name and colour on every item wearing a ticked label", () => {
    const plan = labelled("1 Sol Ring ^Keeper,#4aab08^\n1 Lightning Bolt");
    const [ring, bolt] = toImportItems(plan, []);
    expect(ring).toMatchObject({ labelName: "Keeper", labelColor: "#4aab08" });
    // Absent, not null: an item that says nothing about a label is one `commit_import` leaves
    // alone, which is what makes a merge keep a label the reader put on by hand.
    expect(bolt.labelName).toBeUndefined();
    expect(bolt.labelColor).toBeUndefined();
  });

  it("drops the label off every item when the reader unticks it", () => {
    const plan = labelled("1 Sol Ring ^Keeper,#4aab08^\n1 Lightning Bolt ^Fence,#fffc19^");
    const items = toImportItems(plan, [], new Set(["fence"]));
    expect(items.map((i) => i.labelName)).toEqual([undefined, "Fence"]);
  });

  it("tells an empty tick set from nobody having been asked", () => {
    // The distinction `toImportItems` refuses to collapse: `null` is a caller that draws no
    // picker, an empty set is a reader who unticked every box.
    const plan = labelled("1 Sol Ring ^Keeper,#4aab08^");
    expect(toImportItems(plan, [], null)[0].labelName).toBe("Keeper");
    expect(toImportItems(plan, [], new Set())[0].labelName).toBeUndefined();
  });

  it("keeps a commander's label when the command zone takes the card", () => {
    // The pile and the `{noDeck}` flag are filing and the command zone outranks filing; a label
    // is what the reader thinks of the card, and a commander they marked `Keeper` is still a
    // keeper.
    const plan = labelled("1 Captain Sisay ^Keeper,#4aab08^", spec("commander"));
    const [item] = toImportItems(plan, [plan.cards[0].match.cardId]);
    expect(item).toMatchObject({ categoryName: "Commander", labelName: "Keeper" });
  });

  it("labels a card in a pile that counts toward nothing", () => {
    const plan = labelled(ARCHIDEKT_LABELLED);
    const arkenstone = toImportItems(plan, []).find(
      (i) => plan.cards.find((c) => c.match.cardId === i.cardId)?.labelName === "Getting",
    );
    expect(arkenstone).toMatchObject({ inactive: true, labelName: "Getting" });
  });
});

/**
 * The bug the live pass found: the preview counted the piles **before** the commander was
 * chosen and never again, so its two headline numbers described an import nobody asked for.
 * Measured against the reference list (**debug** build, 2026-08-12): the step read
 * `117 cards · 6 categories` with `Creature 56`, and the deck it wrote had **7** categories,
 * `Creature 55` and `Commander 1`.
 *
 * All three arms that can move a card are covered, because the old shape got exactly one of
 * them right by accident.
 */
describe("the tally over what will actually be written", () => {
  it("moves a chosen commander out of its type-line pile", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Kenrith, the Returned King\n1 Sol Ring",
      { "Captain Sisay": SISAY, "Kenrith, the Returned King": KENRITH, "Sol Ring": SOL_RING },
      spec("commander"),
    );

    // Nothing picked yet: both legends are creatures, which is what the reader is choosing over.
    expect(tallyFor(plan)).toEqual([
      { name: "Creature", cards: 2, inactive: false },
      { name: "Artifact", cards: 1, inactive: false },
    ]);
    expect(tallyFor(plan, [SISAY.cardId])).toEqual([
      { name: "Commander", cards: 1, inactive: false },
      { name: "Creature", cards: 1, inactive: false },
      { name: "Artifact", cards: 1, inactive: false },
    ]);
  });

  /** **The worst arm, because the reader presses nothing.** The dialog states "«card» goes in
   *  the command zone" and the tally has to agree with the sentence directly above it. */
  it("counts an automatic commander in the command zone", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Sol Ring\n6 Forest",
      { "Captain Sisay": SISAY, "Sol Ring": SOL_RING, Forest: FOREST },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "automatic", cardIds: [SISAY.cardId] });
    expect(tallyFor(plan, [SISAY.cardId])).toEqual([
      { name: "Commander", cards: 1, inactive: false },
      { name: "Artifact", cards: 1, inactive: false },
      { name: "Land", cards: 6, inactive: false },
    ]);
  });

  /** The one arm that was right before, and it stays right: the card already carries the
   *  Commander category name, so there is nothing for the choice to move. */
  it("leaves a from-file commander where the file filed it", () => {
    const plan = planFor(
      `Commander
1 Captain Sisay

Deck
1 Sol Ring`,
      { "Captain Sisay": SISAY, "Sol Ring": SOL_RING },
      spec("commander"),
    );

    expect(plan.commander).toEqual({ kind: "fromFile" });
    expect(tallyFor(plan)).toEqual([
      { name: "Commander", cards: 1, inactive: false },
      { name: "Artifact", cards: 1, inactive: false },
    ]);
  });

  /** A partner pair is two commanders and one pile — the sum, not two rows. */
  it("sums a partner pair into the one Commander pile", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Kenrith, the Returned King",
      { "Captain Sisay": SISAY, "Kenrith, the Returned King": KENRITH },
      spec("commander"),
    );

    expect(tallyFor(plan, [SISAY.cardId, KENRITH.cardId])).toEqual([
      { name: "Commander", cards: 2, inactive: false },
    ]);
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

  /**
   * **The command zone outranks every functional pile, and eligibility never reads a tag.**
   * Selvala, Heart of the Wilds is tagged `ramp`, so the auto rule files her under Ramp — which
   * is the right answer for a card in the 99 and the wrong one for the card the deck is built
   * around. Eligibility is `commanderIneligibility` and nothing else, exactly as it was; the
   * choice is applied in `toImportItems`, which knows nothing about slugs.
   */
  it("offers a tagged legendary creature and files her in the command zone when chosen", () => {
    const plan = planFor(
      "1 Selvala, Heart of the Wilds\n1 Sol Ring\n6 Forest",
      { "Selvala, Heart of the Wilds": SELVALA, "Sol Ring": SOL_RING, Forest: FOREST },
      spec("commander"),
      tags([SELVALA, ["ramp", "mana-producer"]], [SOL_RING, ["ramp"]]),
    );

    // Filed by what she does, like any other card, until the command zone claims her.
    expect(plan.cards[0].categoryName).toBe("Ramp");
    expect(plan.commander).toEqual({ kind: "automatic", cardIds: [SELVALA.cardId] });
    expect(toImportItems(plan, [SELVALA.cardId])[0]).toEqual({
      cardId: SELVALA.cardId,
      quantity: 1,
      // Untouched by the commander choice, unlike the pile and the flag beside it: those two
      // are filing, which the command zone outranks, and a finish is a fact about the object.
      finish: null,
      categoryName: "Commander",
      inactive: false,
    });
    expect(tallyFor(plan, [SELVALA.cardId])).toEqual([
      { name: "Commander", cards: 1, inactive: false },
      // Sol Ring is still ramp; only the one card the reader confirmed moves.
      { name: "Ramp", cards: 1, inactive: false },
      { name: "Land", cards: 6, inactive: false },
    ]);
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

    // `inactive` is on every item and is `false` for a list that said nothing about it — the
    // field is optional on the wire so an older caller still deserialises, not so this one may
    // leave it out.
    expect(toImportItems(plan, [SISAY.cardId])).toEqual([
      {
        cardId: SISAY.cardId,
        quantity: 1,
        finish: null,
        categoryName: "Commander",
        inactive: false,
      },
      {
        cardId: SOL_RING.cardId,
        quantity: 1,
        finish: null,
        categoryName: "Artifact",
        inactive: false,
      },
      { cardId: FOREST.cardId, quantity: 6, finish: null, categoryName: "Land", inactive: false },
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
      { cardId: FOREST.cardId, quantity: 6, finish: null, categoryName: "Land", inactive: false },
    ]);
  });
});

/**
 * The importer aimed at one pile — a right-click on a category heading, "Import cards…".
 *
 * The argument is trailing and optional so that the toolbar's Import, which passes nothing,
 * behaves exactly as it did: every case above is that caller.
 */
describe("buildImportPlan aimed at one pile", () => {
  it("files every line into the named pile, whatever the card does", () => {
    const plan = planFor(
      "1 Sol Ring\n6 Forest\n4 Llanowar Elves",
      { "Sol Ring": SOL_RING, Forest: FOREST, "Llanowar Elves": ELVES },
      null,
      [],
      "Removal",
    );

    expect(new Set(plan.cards.map((c) => c.categoryName))).toEqual(new Set(["Removal"]));
  });

  it("files by what the card does when no pile is named", () => {
    // The toolbar's Import passes nothing, and must behave exactly as it does today.
    const plan = planFor("1 Sol Ring\n6 Forest\n4 Llanowar Elves", {
      "Sol Ring": SOL_RING,
      Forest: FOREST,
      "Llanowar Elves": ELVES,
    });

    expect(new Set(plan.cards.map((c) => c.categoryName)).size).toBeGreaterThan(1);
  });

  /** A pile the reader pointed at outranks a heading in somebody else's file: they right-clicked
   *  *this* column, which is a later and more specific act than whatever the export wrote. */
  it("outranks a section heading in the pasted list", () => {
    const plan = planFor(
      `Commander
1 Captain Sisay

Sideboard
1 Lightning Bolt

Maybeboard
6 Forest`,
      { "Captain Sisay": SISAY, "Lightning Bolt": BOLT, Forest: FOREST },
      null,
      [],
      "Removal",
    );

    expect(plan.cards.map((c) => c.categoryName)).toEqual(["Removal", "Removal", "Removal"]);
  });

  /** The tags are still read and still cost their round trip; they simply decide nothing here.
   *  A forced pile that quietly stopped the caller fetching them would be a second rule. */
  it("ignores the tag answers rather than skipping them", () => {
    const plan = planFor(
      "1 Lightning Bolt",
      { "Lightning Bolt": BOLT },
      null,
      tags([BOLT, ["removal", "burn"]]),
      "Sideboard",
    );

    expect(plan.cards[0].categoryName).toBe("Sideboard");
  });

  /**
   * **The command zone still outranks the named pile**, and this is the one edge worth pinning
   * rather than discovering. `toImportItems` is where a confirmed commander is moved, and a
   * forced pile does not reach it: a Commander deck whose paste holds exactly one eligible card
   * files that card in the command zone, as it does from the toolbar.
   */
  it("still lets the command zone claim a confirmed commander", () => {
    const plan = planFor(
      "1 Captain Sisay\n1 Sol Ring",
      { "Captain Sisay": SISAY, "Sol Ring": SOL_RING },
      spec("commander"),
      [],
      "Removal",
    );

    expect(plan.cards.map((c) => c.categoryName)).toEqual(["Removal", "Removal"]);
    expect(toImportItems(plan, [SISAY.cardId]).map((i) => i.categoryName)).toEqual([
      "Commander",
      "Removal",
    ]);
  });
});
