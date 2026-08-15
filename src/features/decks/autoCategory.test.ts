import { describe, expect, it } from "vitest";
import { card } from "./validation/fixtures";
import {
  AUTO_CATEGORIES,
  AUTO_CATEGORY_DISPLAY_ORDER,
  autoCategoryDisplayOrder,
  autoCategoryFor,
  AUTO_CATEGORY_NAMES,
  ORACLE_CATEGORIES,
  ORACLE_CATEGORY_NAMES,
  PREDEFINED_CATEGORY_NAMES,
  UNCATEGORIZED,
} from "./autoCategory";

/**
 * One card as the rule sees it — a type line and the slugs the caller has already expanded to
 * their ancestors.
 *
 * Built on `card()` rather than on a two-field literal so the fixture stays the shape every
 * call site actually holds: the rule takes a `Pick` of a whole deck row, and a test that
 * handed it exactly the two fields it reads would stop proving that a real row still fits.
 */
function tagged(typeLine: string | null, oracleTags: readonly string[]) {
  return { ...card({ typeLine }), oracleTags };
}

/**
 * Real cards with their real anchor slugs, **verified against Scryfall's live Oracle Tags on
 * 2026-08-14**, and every one of them chosen because it matches more than one entry in the
 * list or because somebody would guess it wrong.
 *
 * The `regrowth` slug on the two recursion cards is a leaf this rule has no column for; it is
 * here because it is the reason those two arrive matching both `recursion` and
 * `card-advantage` (it has two parents), and a fixture that hid it would hide the case.
 */
const CARDS: readonly { name: string; typeLine: string; tags: string[]; expected: string }[] = [
  // `recursion` and `card-advantage` both, and Recursion is above Draw for these two.
  {
    name: "Eternal Witness",
    typeLine: "Creature — Human Shaman",
    tags: ["regrowth", "recursion", "card-advantage"],
    expected: "Recursion",
  },
  {
    name: "Regrowth",
    typeLine: "Sorcery",
    tags: ["regrowth", "recursion", "card-advantage"],
    expected: "Recursion",
  },
  // A counterspell is removal in the only sense a deck builder counts: it answers a card.
  { name: "Counterspell", typeLine: "Instant", tags: ["counterspell"], expected: "Removal" },
  {
    name: "Swords to Plowshares",
    typeLine: "Instant",
    tags: ["removal", "lifegain"],
    expected: "Removal",
  },
  {
    name: "Path to Exile",
    typeLine: "Instant",
    tags: ["removal", "ramp", "tutor"],
    expected: "Removal",
  },
  // The card that makes Burn last worth writing down.
  { name: "Lightning Bolt", typeLine: "Instant", tags: ["removal", "burn"], expected: "Removal" },
  { name: "Cultivate", typeLine: "Sorcery", tags: ["ramp", "tutor"], expected: "Ramp" },
  {
    name: "Arcane Signet",
    typeLine: "Artifact",
    tags: ["ramp", "mana-producer"],
    expected: "Ramp",
  },
  {
    name: "Smothering Tithe",
    typeLine: "Enchantment",
    tags: ["ramp", "tax", "hate", "repeatable-token-generator"],
    expected: "Ramp",
  },
  {
    name: "Rhystic Study",
    typeLine: "Enchantment",
    tags: ["card-advantage", "tax"],
    expected: "Draw",
  },
  {
    name: "Garruk's Uprising",
    typeLine: "Enchantment",
    tags: ["card-advantage", "keyword-anthem"],
    expected: "Draw",
  },
  {
    name: "Solemn Simulacrum",
    typeLine: "Artifact Creature — Golem",
    tags: ["ramp", "card-advantage", "tutor"],
    expected: "Ramp",
  },
  {
    name: "Ashnod's Altar",
    typeLine: "Artifact",
    tags: ["ramp", "mana-producer", "adds-multiple-mana", "sacrifice-outlet"],
    expected: "Ramp",
  },
  {
    name: "Winter Orb",
    typeLine: "Artifact",
    tags: ["mass-land-denial", "stasis"],
    expected: "Stax",
  },
  { name: "Ghostly Prison", typeLine: "Enchantment", tags: ["pillowfort"], expected: "Stax" },
  {
    name: "Krenko, Mob Boss",
    typeLine: "Legendary Creature — Goblin Warrior",
    tags: ["repeatable-token-generator"],
    expected: "Tokens",
  },
  {
    name: "Blood Artist",
    typeLine: "Creature — Vampire",
    tags: ["lifegain"],
    expected: "Lifegain",
  },
  // The three that prove the pin: two lands carrying a functional tag, one with none, one
  // that is also a creature.
  {
    name: "Prismatic Vista",
    typeLine: "Land",
    tags: ["tutor", "sacrifice-self"],
    expected: "Land",
  },
  {
    name: "Savai Triome",
    typeLine: "Land — Mountain Plains Swamp",
    tags: ["card-advantage"],
    expected: "Land",
  },
  { name: "Dryad Arbor", typeLine: "Land Creature — Forest Dryad", tags: [], expected: "Land" },
  { name: "Command Tower", typeLine: "Land", tags: [], expected: "Land" },
];

describe("autoCategoryFor, by what the card does", () => {
  /**
   * The whole functional rule as a table of real cards, judged all at once so a failure names
   * every card that moved rather than the first.
   *
   * Nearly every row matches two or three entries in the list — that is the point of the
   * fixtures, and it is why the order in `ORACLE_CATEGORIES` is the rule rather than a
   * presentation detail.
   */
  it("files real cards by their oracle tags", () => {
    const answers = CARDS.map((c) => `${c.name}: ${autoCategoryFor(tagged(c.typeLine, c.tags))}`);
    expect(answers).toEqual(CARDS.map((c) => `${c.name}: ${c.expected}`));
  });

  /**
   * **Recursion outranks Draw, and the two cards it is about are the two most famous cards in
   * the category.** Scryfall's `regrowth` tag has two parents, `recursion` and
   * `card-advantage`, so Eternal Witness and Regrowth arrive matching both. Draw first would
   * leave the Recursion column empty of exactly the cards a reader opened it for.
   *
   * The mirror case is beside it: a card that genuinely only draws still lands in Draw, so the
   * ordering costs nothing on the other side.
   */
  it("prefers Recursion over Draw for a card tagged both", () => {
    expect(
      autoCategoryFor(tagged("Creature — Human Shaman", ["recursion", "card-advantage"])),
    ).toBe("Recursion");
    expect(autoCategoryFor(tagged("Enchantment", ["card-advantage"]))).toBe("Draw");
    expect(autoCategoryFor(tagged("Instant", ["force-draw"]))).toBe("Draw");
  });

  /**
   * **Burn is last on purpose and Lightning Bolt is Removal.** `burn-creature`'s parents are
   * `removal-burn` and `removal-creature`, so nearly every burn spell carries `removal` too
   * and Removal takes it first. What is left under Burn is the burn that points at a player —
   * which is the only burn a deck builder counts separately.
   */
  it("files a burn spell that also removes a creature under Removal", () => {
    expect(autoCategoryFor(tagged("Instant", ["removal", "burn"]))).toBe("Removal");
    expect(autoCategoryFor(tagged("Sorcery", ["burn"]))).toBe("Burn");
  });

  /**
   * Every entry in the list is reachable from its own first anchor. A priority list nothing
   * exercises end to end is a list that can lose an arm — and an entry that can never win is
   * indistinguishable from one that was deleted.
   */
  it("can answer with every one of the thirteen functional buckets", () => {
    const answers = ORACLE_CATEGORIES.map((rule) =>
      autoCategoryFor(tagged("Instant", rule.anchors)),
    );
    expect(answers).toEqual([...ORACLE_CATEGORY_NAMES]);
  });

  /**
   * Every anchor on its own reaches the entry that claims it — not just the first one of each.
   * A typo in the sixth slug of `Stax` is invisible to any test that only tries the first.
   */
  it("reaches an entry from any one of its anchors", () => {
    for (const rule of ORACLE_CATEGORIES) {
      for (const anchor of rule.anchors) {
        // Every anchor is judged against the whole list above it, so this also asserts that
        // no earlier entry claims the same slug.
        expect([anchor, autoCategoryFor(tagged("Instant", [anchor]))]).toEqual([anchor, rule.name]);
      }
    }
  });

  /**
   * The slugs arrive expanded, deduped and **in no meaningful order** — the caller makes no
   * promise about it, so the rule may not depend on one.
   */
  it("does not care what order the slugs arrive in", () => {
    expect(autoCategoryFor(tagged("Instant", ["burn", "lifegain", "removal"]))).toBe("Removal");
    expect(autoCategoryFor(tagged("Instant", ["removal", "lifegain", "burn"]))).toBe("Removal");
  });

  /**
   * **The land pin runs before a single tag is read, and it is measured rather than tidy.**
   * 52% of lands carry a functional tag — Prismatic Vista is tagged `tutor` because it
   * searches, Savai Triome `card-advantage` because it cycles — so consulting tags first
   * scatters a deck's mana base across a dozen columns: fetchlands under Tutor, Triomes under
   * Draw. A mana base is the one pile every decklist draws whole.
   */
  it("pins a land by its type line before any tag is consulted", () => {
    expect(autoCategoryFor(tagged("Land", ["tutor", "sacrifice-self"]))).toBe("Land");
    expect(autoCategoryFor(tagged("Land — Mountain Plains Swamp", ["card-advantage"]))).toBe(
      "Land",
    );
    // Same card without the pin, to show the pin is what answered.
    expect(autoCategoryFor(tagged("Artifact", ["tutor", "sacrifice-self"]))).toBe("Tutor");
    // Dryad Arbor keeps its old answer for its old reason, tags or no tags.
    expect(autoCategoryFor(tagged("Land Creature — Forest Dryad", ["ramp", "mana-producer"]))).toBe(
      "Land",
    );
  });

  /**
   * **The pin reads the front face, like every other half of this rule.** The back of a modal
   * DFC is routinely a land while its front is a spell, and a pin that read the whole string
   * would file every MDFC spell under Land — the hardest possible version of the bug the
   * `//` split has always existed to prevent.
   */
  it("does not pin a modal DFC whose back face is the land", () => {
    expect(autoCategoryFor(tagged("Sorcery // Land", []))).toBe("Sorcery");
    expect(autoCategoryFor(tagged("Sorcery // Land", ["removal"]))).toBe("Removal");
    expect(autoCategoryFor(tagged("Creature — Human // Land", ["ramp"]))).toBe("Ramp");
  });

  /**
   * **The path the app runs on before the tag dataset has ever been downloaded, and for ever
   * if the download never succeeds.** No slugs is not an error state and must never become
   * one: it is the old rule, whole, and the old rule is the floor this feature sits on.
   */
  it("falls through to the type line when no slugs arrived", () => {
    for (const tags of [undefined, [] as string[]]) {
      expect(autoCategoryFor({ ...card({ typeLine: "Instant" }), oracleTags: tags })).toBe(
        "Instant",
      );
      expect(
        autoCategoryFor({ ...card({ typeLine: "Artifact Creature — Golem" }), oracleTags: tags }),
      ).toBe("Creature");
      expect(autoCategoryFor({ ...card({ typeLine: "Enchantment" }), oracleTags: tags })).toBe(
        "Enchantment",
      );
      expect(autoCategoryFor({ ...card({ typeLine: "Land" }), oracleTags: tags })).toBe("Land");
    }
    // And the same card with the field simply absent, which is what every call site that has
    // no tags to give passes.
    expect(autoCategoryFor(card({ typeLine: "Sorcery" }))).toBe("Sorcery");
  });

  /**
   * Most of Tagger's vocabulary is not functional at all — `triggered-ability` describes a
   * template, `meme` and `flavors-of-vanilla` describe a joke. A card carrying only those is
   * a card this rule knows nothing about, and it is filed exactly as it was before the tags
   * existed rather than into a bucket picked at random.
   */
  it("ignores slugs it has no column for", () => {
    const noise = ["triggered-ability", "meme", "flavors-of-vanilla"];
    expect(autoCategoryFor(tagged("Instant", noise))).toBe("Instant");
    expect(autoCategoryFor(tagged("Creature — Human Shaman", noise))).toBe("Creature");
    expect(autoCategoryFor(tagged(null, noise))).toBe(UNCATEGORIZED);
    // Noise beside an anchor changes nothing: the anchor still decides.
    expect(autoCategoryFor(tagged("Instant", [...noise, "removal"]))).toBe("Removal");
  });

  /**
   * **An orphan still has a function.** A row whose printing has left `cards` has no type line
   * at all, but the slugs travelled with the add — so a card the app can no longer describe is
   * still filed by what it does, and only a card it knows nothing about at all falls to the
   * fallback.
   */
  it("files a row with no type line by its tags, and only then Uncategorized", () => {
    expect(autoCategoryFor(tagged(null, ["removal"]))).toBe("Removal");
    expect(autoCategoryFor(tagged("", ["ramp", "mana-producer"]))).toBe("Ramp");
    expect(autoCategoryFor(tagged(null, []))).toBe(UNCATEGORIZED);
    expect(autoCategoryFor(tagged("", []))).toBe(UNCATEGORIZED);
  });
});

describe("autoCategoryFor, by what the card is", () => {
  /**
   * The fallback rule, stated as a table: every type bucket is reachable from the plainest
   * type line that means it. A rule nothing exercises end to end is a rule that can lose an
   * arm — and this one is now reached only when the tags say nothing, which is the arm most
   * easily lost.
   */
  it("files a card under the first bucket its type line names", () => {
    const answers = AUTO_CATEGORIES.map((bucket) =>
      autoCategoryFor(card({ typeLine: bucket as string })),
    );
    expect(answers).toEqual([...AUTO_CATEGORIES]);
  });

  /**
   * The order in {@link AUTO_CATEGORIES} is the whole of the rule for a card with two types,
   * and these are the three pairs that actually ship in quantity.
   */
  it("resolves a card with two types by the order of the list", () => {
    expect(autoCategoryFor(card({ typeLine: "Artifact Creature — Golem" }))).toBe("Creature");
    expect(autoCategoryFor(card({ typeLine: "Legendary Enchantment Creature — God" }))).toBe(
      "Creature",
    );
    // Dryad Arbor, and every artifact land: a land is a land before it is anything else,
    // which is why `Land` leads the list — and why it is now pinned ahead of the tags too.
    expect(autoCategoryFor(card({ typeLine: "Land Creature — Forest Dryad" }))).toBe("Land");
    expect(autoCategoryFor(card({ typeLine: "Artifact Land" }))).toBe("Land");
  });

  /**
   * The front face decides. `type_line` carries both halves of a double-faced card separated
   * by `//`, and the back of a modal DFC is routinely a land while its front is a spell — a
   * deck's curve is cast from the front, so reading the whole string would file every MDFC
   * spell under Land.
   */
  it("reads the front face of a double-faced type line", () => {
    expect(autoCategoryFor(card({ typeLine: "Sorcery // Land" }))).toBe("Sorcery");
    expect(autoCategoryFor(card({ typeLine: "Creature — Human // Land" }))).toBe("Creature");
  });

  /**
   * The type line and the tags, and **nothing else**: a card whose oracle text, cost, colours
   * and rarity all say "removal spell" is filed by the two words printed under its art until
   * a curated slug says otherwise. No rule here ever reads rules text — that is the heuristic
   * this module has always refused, because a regex over oracle text files one removal spell
   * and misses the next.
   */
  it("reads nothing but the type line and the slugs", () => {
    const pathToExile = card({
      typeLine: "Instant",
      name: "Path to Exile",
      oracleText: "Exile target creature.",
      manaCost: "{W}",
      rarity: "uncommon",
    });
    expect(autoCategoryFor(pathToExile)).toBe("Instant");
    expect(autoCategoryFor({ ...pathToExile, oracleTags: ["removal", "ramp", "tutor"] })).toBe(
      "Removal",
    );
  });

  /**
   * An orphan — a row whose printing has left `cards` — has no type line at all, and the one
   * thing it must never answer is `""`: the backend's find-or-create matches on
   * `(deck_id, name)`, and a blank name is a category nobody can see, name or switch back on.
   */
  it("answers Uncategorized for a row with no type line", () => {
    expect(autoCategoryFor(card({ typeLine: null }))).toBe(UNCATEGORIZED);
    expect(autoCategoryFor(card({ typeLine: "" }))).toBe(UNCATEGORIZED);
    expect(autoCategoryFor(card({ typeLine: "Dungeon" }))).toBe(UNCATEGORIZED);
  });

  /**
   * The trap this module is fenced against.
   *
   * `schema::DECK_CATEGORY_GRAIN` is `(deck_id, name)` and **ignores kind**, so the add
   * path's find-or-create resolves a name to whichever category already carries it. If this
   * rule ever answered `"Sideboard"` or `"Maybeboard"`, a plain add would file the card into
   * a pile the reader did not choose — and in the Maybeboard's case an *inactive* one, which
   * is a card gone from every number in the app without having left the deck.
   *
   * A sweep rather than a review note, for `layers.test.ts`' reason: the failure is silent
   * everywhere it would happen. It sweeps the **thirteen new names too**, which is the whole
   * reason `AUTO_CATEGORY_NAMES` had to grow with them.
   */
  it("never answers with the name of a predefined category", () => {
    const collisions = AUTO_CATEGORY_NAMES.filter((name) =>
      PREDEFINED_CATEGORY_NAMES.includes(name),
    );
    expect(collisions).toEqual([]);
  });

  /**
   * The sweep is only a fence if the list it sweeps is the list of answers. Every name the
   * rule can reach — the thirteen functions, the eight types, the fallback — has to be on it,
   * and nothing else may be.
   */
  it("sweeps every name the rule can answer with", () => {
    expect([...AUTO_CATEGORY_NAMES]).toEqual([
      ...ORACLE_CATEGORY_NAMES,
      ...AUTO_CATEGORIES,
      UNCATEGORIZED,
    ]);
    expect(AUTO_CATEGORY_NAMES).toHaveLength(ORACLE_CATEGORIES.length + AUTO_CATEGORIES.length + 1);
    expect(new Set(AUTO_CATEGORY_NAMES).size).toBe(AUTO_CATEGORY_NAMES.length);
  });

  /** The mirror is only worth having if it is the real list. */
  it("mirrors the four names the backend seeds", () => {
    expect([...PREDEFINED_CATEGORY_NAMES]).toEqual([
      "Commander",
      "Sideboard",
      "Companion",
      "Maybeboard",
    ]);
  });
});

describe("the matching order and the reading order", () => {
  /**
   * **The order of the functional list is the rule**, so it is pinned as data rather than
   * described in prose: reordering these thirteen lines re-files hundreds of cards, and the
   * two lines that look wrong (Recursion above Draw, Burn last) are the ones a tidy-up would
   * reach for first.
   */
  it("holds the thirteen functional buckets in priority order", () => {
    expect([...ORACLE_CATEGORY_NAMES]).toEqual([
      "Removal",
      "Ramp",
      "Recursion",
      "Draw",
      "Tutor",
      "Protection",
      "Anthem",
      "Stax",
      "Tokens",
      "Sacrifice",
      "Lifegain",
      "Mill",
      "Burn",
    ]);
    expect(ORACLE_CATEGORY_NAMES.indexOf("Recursion")).toBeLessThan(
      ORACLE_CATEGORY_NAMES.indexOf("Draw"),
    );
    expect(ORACLE_CATEGORY_NAMES[ORACLE_CATEGORY_NAMES.length - 1]).toBe("Burn");
  });

  /**
   * No slug may be claimed by two entries. A duplicated anchor is not a type error and not a
   * crash — it is an entry lower down the list that can never win, silently, for the cards
   * that carry it.
   */
  it("gives every anchor slug to exactly one bucket", () => {
    const anchors = ORACLE_CATEGORIES.flatMap((rule) => [...rule.anchors]);
    expect(new Set(anchors).size).toBe(anchors.length);
  });

  /**
   * The type list and its reading order are the same eight words and differ **only** about
   * Land, and both answers are deliberate. Written as a test rather than left to a comment
   * because the obvious tidy-up — folding them back into one constant — passes type-checking
   * and breaks whichever job loses.
   */
  it("holds the same eight type buckets, and differs only about where Land goes", () => {
    const types = AUTO_CATEGORY_DISPLAY_ORDER.slice(ORACLE_CATEGORY_NAMES.length);
    expect([...types].sort()).toEqual([...AUTO_CATEGORIES].sort());
    expect(AUTO_CATEGORIES[0]).toBe("Land");
    expect(types[types.length - 1]).toBe("Land");
    // Everything else is in the order it was written in.
    expect(types.slice(0, -1)).toEqual(AUTO_CATEGORIES.filter((bucket) => bucket !== "Land"));
  });

  /**
   * The reading order is the functional list unchanged, then the types. A function's priority
   * and its place on screen want the same order — only Land ever wanted two answers — so
   * there is one transformation here, applied to the type half alone.
   */
  it("draws the functional buckets first, in the order the rule tries them", () => {
    expect(AUTO_CATEGORY_DISPLAY_ORDER.slice(0, ORACLE_CATEGORY_NAMES.length)).toEqual([
      ...ORACLE_CATEGORY_NAMES,
    ]);
    expect(autoCategoryDisplayOrder("Removal")).toBe(0);
    expect(autoCategoryDisplayOrder("Removal")).toBeLessThan(autoCategoryDisplayOrder("Creature"));
  });

  /**
   * **Dryad Arbor is why the matching order checks Land first.** Its type line is
   * `Land Creature — Forest Dryad`; a list that checked `Creature` first would file it in the
   * creature column, where no decklist has ever put it, and every artifact land is the same
   * card.
   *
   * And it is filed under a heading that is drawn **last** — last of all twenty-one, not
   * merely last of the eight it used to share a list with. The lands are where a decklist
   * stops counting, and thirteen new headings above it changed nothing about that.
   */
  it("files Dryad Arbor as a land, and draws lands last", () => {
    expect(autoCategoryFor(card({ typeLine: "Land Creature — Forest Dryad" }))).toBe("Land");
    expect(autoCategoryDisplayOrder("Land")).toBeGreaterThan(autoCategoryDisplayOrder("Creature"));
    expect(autoCategoryDisplayOrder("Land")).toBeGreaterThan(autoCategoryDisplayOrder("Burn"));
    expect(autoCategoryDisplayOrder("Land")).toBe(AUTO_CATEGORY_DISPLAY_ORDER.length - 1);
  });

  /** An unknown sorts with the unknowns at the foot, not at the head — including the
   *  fallback the orphan gets. */
  it("sorts the fallback and anything it has never heard of after every bucket", () => {
    expect(autoCategoryDisplayOrder(UNCATEGORIZED)).toBe(AUTO_CATEGORY_DISPLAY_ORDER.length);
    expect(autoCategoryDisplayOrder("Dungeon")).toBe(AUTO_CATEGORY_DISPLAY_ORDER.length);
    expect(autoCategoryDisplayOrder(UNCATEGORIZED)).toBeGreaterThan(
      autoCategoryDisplayOrder("Land"),
    );
  });

  /** The reading order is the twenty-one buckets and nothing else — the fallback earns its
   *  place at the foot by being absent from the list, not by being written into the end of it. */
  it("keeps the fallback out of the reading order entirely", () => {
    expect(AUTO_CATEGORY_DISPLAY_ORDER).not.toContain(UNCATEGORIZED);
    expect(AUTO_CATEGORY_DISPLAY_ORDER).toHaveLength(
      ORACLE_CATEGORIES.length + AUTO_CATEGORIES.length,
    );
  });

  /**
   * **The two lists cannot drift**, which is the invariant the whole "derived, never typed out
   * a second time" discipline exists to buy: every name the rule can answer with has a place
   * on screen, and every place on screen belongs to a name the rule can answer with. The
   * single exception is the fallback, which is absent on purpose and tested above.
   */
  it("gives every answerable name a position, and no position a name it cannot answer", () => {
    for (const name of AUTO_CATEGORY_NAMES) {
      const placed = autoCategoryDisplayOrder(name) < AUTO_CATEGORY_DISPLAY_ORDER.length;
      expect([name, placed]).toEqual([name, name !== UNCATEGORIZED]);
    }
    expect([...AUTO_CATEGORY_DISPLAY_ORDER].sort()).toEqual(
      AUTO_CATEGORY_NAMES.filter((name) => name !== UNCATEGORIZED).sort(),
    );
  });
});
