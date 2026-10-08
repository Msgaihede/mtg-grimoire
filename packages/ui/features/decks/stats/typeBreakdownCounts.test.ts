import { describe, expect, it } from "vitest";
import { deckStats } from "../DeckStats";
import { MODAL_DFC } from "../deckBuckets";
import { card } from "../validation/fixtures";
import { creatureSplit, NO_BASIC_TYPE, subtypes, typeBreakdown } from "./typeBreakdownCounts";

/** Slice label → copies, for the cases about the partition's arithmetic. */
const slices = (cards: Parameters<typeof typeBreakdown>[0]) =>
  Object.fromEntries(typeBreakdown(cards).landSlices.map((s) => [s.label, s.count]));

const land = (name: string, typeLine: string, quantity = 1) =>
  card({ name, typeLine, quantity, manaCost: null, cmc: 0, colors: null });

const creature = (name: string, typeLine: string, quantity = 1, cmc = 2) =>
  card({ name, typeLine, quantity, cmc, manaCost: `{${cmc}}` });

describe("subtypes", () => {
  /** Scryfall prints an em dash; fixtures and hand-typed lines print ` - `. A bare hyphen is part
   *  of a word, and `Assembly-Worker` is the creature type that proves it matters. */
  it("reads the words after an em dash or a spaced hyphen, and keeps a hyphenated word whole", () => {
    expect(subtypes("Creature — Human Wizard")).toEqual(["Human", "Wizard"]);
    expect(subtypes("Creature - Human Wizard")).toEqual(["Human", "Wizard"]);
    expect(subtypes("Artifact Creature — Assembly-Worker")).toEqual(["Assembly-Worker"]);
    expect(subtypes("Artifact Creature")).toEqual([]);
    expect(subtypes("")).toEqual([]);
  });

  it("keeps the one two-word creature type as one type", () => {
    expect(subtypes("Legendary Creature — Time Lord Doctor")).toEqual(["Time Lord", "Doctor"]);
  });
});

describe("typeBreakdown — creatures", () => {
  /** A copy with two subtypes is counted under both, and each row is **copies**, not rows. */
  it("tallies every subtype of every copy, count descending then name", () => {
    const result = typeBreakdown([
      creature("Snapcaster Mage", "Creature — Human Wizard", 4),
      creature("Thraben Inspector", "Creature — Human Soldier", 3),
      creature("Delver", "Creature — Human Wizard", 2),
      creature("Ornithopter", "Artifact Creature — Thopter", 2),
    ]);

    expect(result.creatures).toBe(11);
    expect(result.creatureTypes).toEqual([
      { name: "Human", count: 9 },
      { name: "Wizard", count: 6 },
      { name: "Soldier", count: 3 },
      // A tie on count is broken by name, so two machines draw one deck the same way round.
      { name: "Thopter", count: 2 },
    ]);
  });

  /** The front face is the one a deck is cast from. A modal DFC with a creature on the back is a
   *  spell; a creature with a noncreature back is a creature of its front's types only. */
  it("reads the front face of a double-faced card and nothing after the //", () => {
    const result = typeBreakdown([
      creature("Bala Ged Recovery", "Sorcery // Land", 1, 3),
      creature("Delver of Secrets", "Creature — Human Wizard // Creature — Human Insect", 2),
      creature("Agadeem's Awakening", "Sorcery // Creature — Zombie Horror", 1),
    ]);

    expect(result.creatures).toBe(2);
    expect(result.creatureTypes.map((r) => r.name)).toEqual(["Human", "Wizard"]);
  });

  /** Dryad Arbor is a land to the pie and to the curve, so it is not also a creature here — the
   *  panel would otherwise grow a `Forest` row and the creature count would outrun the band's. */
  it("leaves a land creature to the Land panel", () => {
    const result = typeBreakdown([
      land("Dryad Arbor", "Land Creature — Forest Dryad", 1),
      creature("Llanowar Elves", "Creature — Elf Druid", 4),
    ]);

    expect(result.creatures).toBe(4);
    expect(result.creatureTypes.map((r) => r.name)).toEqual(["Druid", "Elf"]);
    expect(result.lands).toBe(1);
    expect(slices([land("Dryad Arbor", "Land Creature — Forest Dryad")])).toEqual({ Forest: 1 });
  });

  /** A tribal spell names a creature type and is not a creature. */
  it("counts no noncreature, however creature-like its subtypes", () => {
    const result = typeBreakdown([
      card({ name: "Elvish Promenade", typeLine: "Kindred Sorcery — Elf" }),
    ]);
    expect(result.creatures).toBe(0);
    expect(result.creatureTypes).toEqual([]);
  });
});

describe("typeBreakdown — lands", () => {
  /** The partition is by the **set** of basic types, so a dual is its own slice rather than half
   *  of two, and the slices sum to the land count exactly. */
  it("partitions lands by their basic land types, duals as their own slice", () => {
    const deck = [
      land("Island", "Basic Land — Island", 8),
      land("Mountain", "Basic Land — Mountain", 6),
      land("Steam Vents", "Land — Island Mountain", 4),
      land("Snow-Covered Island", "Basic Snow Land — Island", 1),
      land("Spirebluff Canal", "Land", 2),
      land("Urza's Saga", "Legendary Enchantment Land — Urza's", 1),
    ];
    const result = typeBreakdown(deck);

    expect(slices(deck)).toEqual({
      Island: 9,
      Mountain: 6,
      "Island Mountain": 4,
      [NO_BASIC_TYPE]: 3,
    });
    expect(result.lands).toBe(22);
    expect(result.landSlices.reduce((n, s) => n + s.count, 0)).toBe(result.lands);
  });

  /** The types are joined in WUBRG order whatever order the type line printed them in, so one
   *  pair of types is one slice. */
  it("names a multi-type slice in WUBRG order, and keys it by its mana", () => {
    const result = typeBreakdown([
      land("Backwards dual", "Land — Mountain Island", 1),
      land("Steam Vents", "Land — Island Mountain", 1),
      land("Triome", "Land — Forest Plains Island", 1),
    ]);

    expect(result.landSlices).toEqual([
      { key: "UR", label: "Island Mountain", types: ["U", "R"], count: 2 },
      { key: "WUG", label: "Plains Island Forest", types: ["W", "U", "G"], count: 1 },
    ]);
  });

  it("reads a hyphen-separated type line the way it reads an em dash", () => {
    expect(slices([land("Hand-typed", "Basic Land - Forest", 3)])).toEqual({ Forest: 3 });
  });

  /**
   * A modal DFC's land back is `mdfcLands` and never a slice: `deckStats` keeps it out of
   * `lands`, and the pie's total is the ledger's first Lands term. A Pathway's front **is** a
   * land, so it is one land of its front's type.
   */
  it("keeps modal DFC lands out of the pie and counts them beside it", () => {
    const deck = [
      card({
        name: "Turntimber Symbiosis",
        typeLine: "Sorcery // Land",
        layout: MODAL_DFC,
        cmc: 7,
        quantity: 2,
      }),
      land("Barkchannel Pathway", "Land // Land", 1),
      land("Forest", "Basic Land — Forest", 10),
    ];
    const result = typeBreakdown(deck);

    expect(result.lands).toBe(11);
    expect(result.mdfcLands).toBe(2);
    expect(slices(deck)).toEqual({ Forest: 10, [NO_BASIC_TYPE]: 1 });
    // One definition with the ledger's, rather than a second one that agrees today.
    const stats = deckStats(deck);
    expect(result.lands).toBe(stats.lands);
    expect(result.mdfcLands).toBe(stats.mdfcLands);
  });

  it("orders slices by count, and a tie by type count, WUBRG, then no type last", () => {
    const result = typeBreakdown([
      land("Wastes", "Basic Land", 2),
      land("Forest", "Basic Land — Forest", 2),
      land("Plains", "Basic Land — Plains", 2),
      land("Hallowed Fountain", "Land — Plains Island", 2),
      land("Island", "Basic Land — Island", 5),
    ]);

    expect(result.landSlices.map((s) => s.label)).toEqual([
      "Island",
      "Plains",
      "Forest",
      "Plains Island",
      NO_BASIC_TYPE,
    ]);
  });
});

describe("typeBreakdown — which copies", () => {
  /** The same rows the distribution bars are drawn over: a sideboard counts, a switched-off pile
   *  does not, and a row of four is four. */
  it("counts copies in active piles only", () => {
    const result = typeBreakdown([
      creature("Goblin Guide", "Creature — Goblin Scout", 4),
      creature("Maybe Goblin", "Creature — Goblin", 3, 1),
      land("Mountain", "Basic Land — Mountain", 20),
      land("Off Mountain", "Basic Land — Mountain", 5),
    ].map((row) =>
      row.name.startsWith("Maybe") || row.name.startsWith("Off")
        ? { ...row, categoryActive: false }
        : row,
    ));

    expect(result.creatures).toBe(4);
    expect(result.creatureTypes).toEqual([
      { name: "Goblin", count: 4 },
      { name: "Scout", count: 4 },
    ]);
    expect(result.lands).toBe(20);
  });

  it("counts a sideboard, which is cards the reader owns and sleeves", () => {
    const result = typeBreakdown([
      { ...creature("Side Elf", "Creature — Elf", 2), categoryKind: "side", categoryActive: true },
    ]);
    expect(result.creatures).toBe(2);
  });
});

describe("creatureSplit", () => {
  /** Read off the curve, so it is the curve's number — including an X spell, wherever `Split X`
   *  files it — and a land creature and a land are in neither half. */
  it("takes both halves from the curve, with or without the X bar split out", () => {
    const deck = [
      creature("Bear", "Creature — Bear", 4, 2),
      creature("Hydra", "Creature — Hydra", 2, 0),
      card({ name: "Bolt", typeLine: "Instant", quantity: 4 }),
      land("Dryad Arbor", "Land Creature — Forest Dryad", 1),
      land("Forest", "Basic Land — Forest", 10),
    ].map((row) => (row.name === "Hydra" ? { ...row, manaCost: "{X}{G}{G}" } : row));

    for (const split of [false, true]) {
      expect(creatureSplit(deckStats(deck, split))).toEqual({
        creatures: 6,
        noncreatures: 4,
        total: 10,
      });
    }
  });

  it("is all zeroes for a deck of nothing but lands", () => {
    expect(creatureSplit(deckStats([land("Forest", "Basic Land — Forest", 3)]))).toEqual({
      creatures: 0,
      noncreatures: 0,
      total: 0,
    });
  });
});
