import { beforeEach, describe, expect, it } from "vitest";
import type { CardFacts } from "./types";
import { card, commander, islands, padTo, resetRowIds, spec } from "./fixtures";
import { validateDeck } from "./engine";
import { companionIssues } from "./companions";

/**
 * Every fixture below is a **real printing** — mana cost, type line, oracle text and colour
 * identity copied out of the card database this app syncs (probed read-only on 2026-08-05),
 * including all ten companions themselves. The ten conditions are ten different readings of
 * a deck, and a paraphrased fixture proves nothing about the reading it stands in for.
 */

beforeEach(resetRowIds);

// ------------------------------------------------------------------------------------------
// The ten, as printed.
// ------------------------------------------------------------------------------------------

/** The reminder every companion prints after its condition; kept out of the ten literals
 *  below so each of them shows its own sentence and nothing else. */
const REMINDER =
  " (If this card is your chosen companion, you may put it into your hand from outside the " +
  "game for {3} as a sorcery.)";

const COMPANION_FIXTURES: Record<string, Partial<CardFacts>> = {
  "Gyruda, Doom of Depths": {
    manaCost: "{4}{U/B}{U/B}",
    cmc: 6,
    typeLine: "Legendary Creature — Demon Kraken",
    oracleText:
      "Companion — Your starting deck contains only cards with even mana values." + REMINDER,
    colors: "BU",
    colorIdentity: "BU",
  },
  "Jegantha, the Wellspring": {
    manaCost: "{4}{R/G}",
    cmc: 5,
    typeLine: "Legendary Creature — Elemental Elk",
    oracleText:
      "Companion — No card in your starting deck has more than one of the same mana " +
      "symbol in its mana cost." +
      REMINDER +
      "\n{T}: Add {W}{U}{B}{R}{G}. This mana can't be spent to pay generic mana costs.",
    colors: "GR",
    // Five colours from one activated ability — Scryfall's own answer, and what makes
    // Jegantha the companion a mono-coloured commander cannot have.
    colorIdentity: "BGRUW",
  },
  "Kaheera, the Orphanguard": {
    manaCost: "{1}{G/W}{G/W}",
    cmc: 3,
    typeLine: "Legendary Creature — Cat Beast",
    oracleText:
      "Companion — Each creature card in your starting deck is a Cat, Elemental, " +
      "Nightmare, Dinosaur, or Beast card." +
      REMINDER,
    colors: "GW",
    colorIdentity: "GW",
  },
  "Keruga, the Macrosage": {
    manaCost: "{3}{G/U}{G/U}",
    cmc: 5,
    typeLine: "Legendary Creature — Dinosaur Hippo",
    oracleText:
      "Companion — Your starting deck contains only cards with mana value 3 or greater " +
      "and land cards." +
      REMINDER,
    colors: "GU",
    colorIdentity: "GU",
  },
  "Lurrus of the Dream-Den": {
    manaCost: "{1}{W/B}{W/B}",
    cmc: 3,
    typeLine: "Legendary Creature — Cat Nightmare",
    oracleText:
      "Companion — Each permanent card in your starting deck has mana value 2 or less." + REMINDER,
    colors: "BW",
    colorIdentity: "BW",
  },
  "Lutri, the Spellchaser": {
    manaCost: "{1}{U/R}{U/R}",
    cmc: 3,
    typeLine: "Legendary Creature — Elemental Otter",
    oracleText:
      "Companion — Each nonland card in your starting deck has a different name." + REMINDER,
    colors: "RU",
    colorIdentity: "RU",
  },
  "Obosh, the Preypiercer": {
    manaCost: "{3}{B/R}{B/R}",
    cmc: 5,
    typeLine: "Legendary Creature — Hellion Horror",
    oracleText:
      "Companion — Your starting deck contains only cards with odd mana values and land " +
      "cards." +
      REMINDER,
    colors: "BR",
    colorIdentity: "BR",
  },
  "Umori, the Collector": {
    manaCost: "{2}{B/G}{B/G}",
    cmc: 4,
    typeLine: "Legendary Creature — Ooze",
    oracleText:
      "Companion — Each nonland card in your starting deck shares a card type." + REMINDER,
    colors: "BG",
    colorIdentity: "BG",
  },
  "Yorion, Sky Nomad": {
    manaCost: "{3}{W/U}{W/U}",
    cmc: 5,
    typeLine: "Legendary Creature — Bird Serpent",
    oracleText:
      "Companion — Your starting deck contains at least twenty cards more than the " +
      "minimum deck size." +
      REMINDER,
    colors: "UW",
    colorIdentity: "UW",
  },
  "Zirda, the Dawnwaker": {
    manaCost: "{1}{R/W}{R/W}",
    cmc: 3,
    typeLine: "Legendary Creature — Elemental Fox",
    oracleText:
      "Companion — Each permanent card in your starting deck has an activated ability." +
      REMINDER +
      "\nAbilities you activate that aren't mana abilities cost {2} less to activate.\n" +
      "{1}, {T}: Target creature can't block this turn.",
    colors: "RW",
    colorIdentity: "RW",
  },
};

/** One of the ten in the companion category. */
function companionCard(name: keyof typeof COMPANION_FIXTURES): CardFacts {
  return card({ ...COMPANION_FIXTURES[name], name, categoryKind: "companion" });
}

// ------------------------------------------------------------------------------------------
// The deck cards the conditions are read against — real printings, one job each.
// ------------------------------------------------------------------------------------------

const DECK_FIXTURES = {
  /** {1}, Artifact, `{T}: Add {C}{C}` — odd MV, a cheap permanent, an activated ability. */
  solRing: {
    name: "Sol Ring",
    manaCost: "{1}",
    cmc: 1,
    typeLine: "Artifact",
    oracleText: "{T}: Add {C}{C}.",
    colors: null,
    colorIdentity: "",
  },
  /** {U}{U}, Instant, MV 2 — even, not a permanent, and a repeated mana symbol. */
  counterspell: {
    name: "Counterspell",
    manaCost: "{U}{U}",
    cmc: 2,
    typeLine: "Instant",
    oracleText: "Counter target spell.",
    colors: "U",
    colorIdentity: "U",
  },
  /** {2}{W}{W}, Sorcery, MV 4 — even, a nonland at 4, and a repeated symbol. */
  wrathOfGod: {
    name: "Wrath of God",
    manaCost: "{2}{W}{W}",
    cmc: 4,
    typeLine: "Sorcery",
    oracleText: "Destroy all creatures. They can't be regenerated.",
    colors: "W",
    colorIdentity: "W",
  },
  /** {1}{W}{W}, Creature — the brief's own Jegantha failure, and a non-Kaheera creature type. */
  fiendHunter: {
    name: "Fiend Hunter",
    manaCost: "{1}{W}{W}",
    cmc: 3,
    typeLine: "Creature — Human Cleric",
    oracleText:
      "When this creature enters, you may exile another target creature.\nWhen this creature " +
      "leaves the battlefield, return the exiled card to the battlefield under its owner's " +
      "control.",
    colors: "W",
    colorIdentity: "W",
  },
  /** {W}{U}{B}{R}{G} — five different symbols, so Jegantha's condition is about repeats and
   *  not about how many symbols a cost has. */
  childOfAlara: {
    name: "Child of Alara",
    manaCost: "{W}{U}{B}{R}{G}",
    cmc: 5,
    typeLine: "Legendary Creature — Avatar",
    oracleText:
      "Trample\nWhen Child of Alara dies, destroy all nonland permanents. They can't be " +
      "regenerated.",
    colors: "BGRUW",
    colorIdentity: "BGRUW",
  },
  /** A vanilla creature: no oracle text at all, so no activated ability. */
  grizzlyBears: {
    name: "Grizzly Bears",
    manaCost: "{1}{G}",
    cmc: 2,
    typeLine: "Creature — Bear",
    oracleText: "",
    colors: "G",
    colorIdentity: "G",
  },
  /** A Cat, which is one of Kaheera's five. */
  savannahLions: {
    name: "Savannah Lions",
    manaCost: "{W}",
    cmc: 1,
    typeLine: "Creature — Cat",
    oracleText: "",
    colors: "W",
    colorIdentity: "W",
  },
  /** Every creature type at once, and its type line says none of them. */
  mothdustChangeling: {
    name: "Mothdust Changeling",
    manaCost: "{U}",
    cmc: 1,
    typeLine: "Creature — Shapeshifter",
    oracleText:
      "Changeling (This card is every creature type.)\nTap an untapped creature you control: " +
      "This creature gains flying until end of turn.",
    colors: "U",
    colorIdentity: "U",
  },
  /** Equipment: an activated ability (equip) that Scryfall prints with no colon anywhere. */
  skullclamp: {
    name: "Skullclamp",
    manaCost: "{1}",
    cmc: 1,
    typeLine: "Artifact — Equipment",
    oracleText:
      "Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}",
    colors: null,
    colorIdentity: "",
  },
  /** A land whose only colon sits inside reminder text, inside quotes. */
  dryadArbor: {
    name: "Dryad Arbor",
    manaCost: null,
    cmc: 0,
    typeLine: "Land Creature — Forest Dryad",
    oracleText:
      "(This land isn't a spell, it's affected by summoning sickness, and it has \"{T}: Add " +
      '{G}.")',
    colors: "G",
    colorIdentity: "G",
  },
  /** A split card: two costs that each repeat nothing, joined by a top-level `//` string that
   *  reads as a repeat if you parse it as one cost. */
  fireIce: {
    name: "Fire // Ice",
    manaCost: "{1}{R} // {1}{U}",
    cmc: 4,
    typeLine: "Instant // Instant",
    oracleText: null,
    colors: "RU",
    colorIdentity: "RU",
    layout: "split",
    faces: JSON.stringify([
      {
        mana_cost: "{1}{R}",
        name: "Fire",
        oracle_text: "Fire deals 2 damage divided as you choose among one or two targets.",
        type_line: "Instant",
      },
      {
        mana_cost: "{1}{U}",
        name: "Ice",
        oracle_text: "Tap target permanent.\nDraw a card.",
        type_line: "Instant",
      },
    ]),
  },
  /** An adventure whose front face repeats {U} — the repeat is on a face, not at the top. */
  brazenBorrower: {
    name: "Brazen Borrower // Petty Theft",
    manaCost: "{1}{U}{U} // {1}{U}",
    cmc: 3,
    typeLine: "Creature — Faerie Rogue // Instant — Adventure",
    oracleText: null,
    colors: "U",
    colorIdentity: "U",
    layout: "adventure",
    faces: JSON.stringify([
      {
        mana_cost: "{1}{U}{U}",
        name: "Brazen Borrower",
        oracle_text: "Flash\nFlying\nThis creature can block only creatures with flying.",
        power: "3",
        toughness: "1",
        type_line: "Creature — Faerie Rogue",
      },
      {
        mana_cost: "{1}{U}",
        name: "Petty Theft",
        oracle_text: "Return target nonland permanent an opponent controls to its owner's hand.",
        type_line: "Instant — Adventure",
      },
    ]),
  },
} satisfies Record<string, Partial<CardFacts>>;

function deckCard(key: keyof typeof DECK_FIXTURES, overrides: Partial<CardFacts> = {}): CardFacts {
  return card({ ...DECK_FIXTURES[key], ...overrides });
}

/** The one thing every condition test wants: the sentences a companion produced, in order. */
function messages(
  companionName: keyof typeof COMPANION_FIXTURES,
  deck: CardFacts[],
  format: Parameters<typeof spec>[0] = "modern",
): string[] {
  return companionIssues([companionCard(companionName)], deck, spec(format)).map((i) => i.message);
}

// ------------------------------------------------------------------------------------------
// The zone.
// ------------------------------------------------------------------------------------------

describe("the companion zone", () => {
  it("refuses a companion in a format that has no sideboard to hold one", () => {
    // Gladiator is the seeded row where `allows_companion` is 0, and the cell beside it says
    // why: `sideboard_max` 0. Read from the row, never from the key.
    const issues = companionIssues(
      [companionCard("Lurrus of the Dream-Den")],
      [islands(100)],
      spec("gladiator"),
    );

    expect(issues).toEqual([
      {
        severity: "error",
        code: "companion-zone",
        message: "Gladiator has no sideboard, so it has no companions.",
        cardIds: ["c-Lurrus of the Dream-Den"],
      },
    ]);
  });

  it("allows exactly one companion", () => {
    const two = companionIssues(
      [companionCard("Lurrus of the Dream-Den"), companionCard("Zirda, the Dawnwaker")],
      [islands(60)],
      spec("modern"),
    );

    expect(two.map((i) => i.message)).toContain("Modern decks have one companion; you have 2.");
    expect(two[0].code).toBe("companion-count");
  });

  it("refuses a card that is not a companion", () => {
    const issues = companionIssues(
      [card({ name: "Lightning Bolt", categoryKind: "companion" })],
      [islands(60)],
      spec("modern"),
    );

    expect(issues).toEqual([
      {
        severity: "error",
        code: "companion-eligibility",
        message: "Lightning Bolt has no companion ability, so it cannot be your companion.",
        cardIds: ["c-Lightning Bolt"],
      },
    ]);
  });

  /**
   * The corpus holds three cards that print a companion line and are not one of the ten —
   * two playtest cards and a Heroes of the Realm promo, all `not_legal` everywhere. A card
   * this app cannot read a condition for is **evidence of nothing**, so it warns rather than
   * accusing, exactly as an unreadable legality does.
   */
  it("warns rather than accuses when a companion ability is one it does not know", () => {
    const issues = companionIssues(
      [
        card({
          name: "Treizeci, Sun of Serra",
          categoryKind: "companion",
          typeLine: "Legendary Creature — Human Knight",
          oracleText:
            "Companion — Your starting deck contains only nostalgic cards. (Retro frames, " +
            "legends, and artifacts are nostalgic.)",
        }),
      ],
      [islands(60)],
      spec("modern"),
    );

    expect(issues).toEqual([
      {
        severity: "warning",
        code: "companion-unknown",
        message:
          "Treizeci, Sun of Serra's companion ability is one this app does not know, so your " +
          "deck was not checked against it.",
        cardIds: ["c-Treizeci, Sun of Serra"],
      },
    ]);
  });

  /**
   * The third card outside the ten that prints a companion ability prints a *different* one:
   * `"Old Companion — …"`, which the line anchor deliberately does not match. It gets the
   * ordinary refusal rather than the warning, and this test is what keeps the module docblock
   * honest about which of the three lands where.
   */
  it("refuses an Old Companion rather than warning about it", () => {
    const issues = companionIssues(
      [
        card({
          name: "The Companion of the Wilds",
          categoryKind: "companion",
          typeLine: "Legendary Creature — Beast Noble",
          oracleText:
            "Old Companion — Your starting deck contains only cards from WOE, WOC, and " +
            "playtest cards. (You may cast this from outside the game if this is companion " +
            "without paying {3} first.)",
        }),
      ],
      [islands(60)],
      spec("modern"),
    );

    expect(issues).toEqual([
      {
        severity: "error",
        code: "companion-eligibility",
        message:
          "The Companion of the Wilds has no companion ability, so it cannot be your companion.",
        cardIds: ["c-The Companion of the Wilds"],
      },
    ]);
  });

  it("says nothing about an empty companion zone", () => {
    expect(companionIssues([], [islands(60)], spec("modern"))).toEqual([]);
  });

  /** A row whose printing left the card database has no text to read, and the engine has
   *  already said so. Guessing that it "has no companion ability" would be a second, wrong
   *  sentence about a card nothing is known about. */
  it("leaves an orphaned row to the reconciler", () => {
    const orphan = card({
      name: "Gone Card",
      categoryKind: "companion",
      oracleId: null,
      layout: null,
      rarity: null,
      legalities: null,
      typeLine: null,
      oracleText: null,
      cmc: null,
      manaCost: null,
    });

    expect(companionIssues([orphan], [islands(60)], spec("modern"))).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// The ten conditions.
// ------------------------------------------------------------------------------------------

describe("Gyruda, Doom of Depths — even mana values", () => {
  it("passes a deck of even costs and lands", () => {
    // A land's mana value is 0, which is even, so Gyruda needs no land clause of its own.
    expect(messages("Gyruda, Doom of Depths", [deckCard("counterspell"), islands(58)])).toEqual([]);
  });

  it("names the odd cards", () => {
    expect(
      messages("Gyruda, Doom of Depths", [deckCard("solRing"), deckCard("counterspell")]),
    ).toEqual([
      "Gyruda, Doom of Depths needs every card in your deck to have an even mana value; " +
        "Sol Ring does not.",
    ]);
  });
});

describe("Jegantha, the Wellspring — no repeated mana symbol", () => {
  it("passes five different symbols and fails two of one", () => {
    expect(messages("Jegantha, the Wellspring", [deckCard("childOfAlara")])).toEqual([]);
    expect(messages("Jegantha, the Wellspring", [deckCard("fiendHunter")])).toEqual([
      "Jegantha, the Wellspring needs no mana cost in your deck to repeat a mana symbol; " +
        "Fiend Hunter repeats one.",
    ]);
  });

  /** Generic mana is one symbol however large it is: `{4}{R/G}` is Jegantha's own cost. */
  it("counts a generic symbol once", () => {
    const four = card({ name: "Ugin's Conjurant", manaCost: "{4}", cmc: 4, typeLine: "Creature" });

    expect(messages("Jegantha, the Wellspring", [four])).toEqual([]);
  });

  /**
   * A split card's two halves are two costs, and the top-level string joins them with `//`.
   * Read as one cost, `{1}{R} // {1}{U}` repeats `{1}` and Fire // Ice would be refused — so
   * the costs are read apart, which is also what makes an adventure's front face count.
   */
  it("reads each face's cost on its own", () => {
    expect(messages("Jegantha, the Wellspring", [deckCard("fireIce")])).toEqual([]);
    expect(messages("Jegantha, the Wellspring", [deckCard("brazenBorrower")])).toEqual([
      "Jegantha, the Wellspring needs no mana cost in your deck to repeat a mana symbol; " +
        "Brazen Borrower // Petty Theft repeats one.",
    ]);
  });
});

describe("Kaheera, the Orphanguard — five creature types", () => {
  it("passes its five and names anything else", () => {
    expect(messages("Kaheera, the Orphanguard", [deckCard("savannahLions"), islands(20)])).toEqual(
      [],
    );
    expect(messages("Kaheera, the Orphanguard", [deckCard("grizzlyBears")])).toEqual([
      "Kaheera, the Orphanguard needs every creature card in your deck to be a Cat, Elemental, " +
        "Nightmare, Dinosaur or Beast; Grizzly Bears is not.",
    ]);
  });

  it("ignores noncreature cards entirely", () => {
    expect(messages("Kaheera, the Orphanguard", [deckCard("wrathOfGod")])).toEqual([]);
  });

  /** A changeling is every creature type (CR 702.73a), and its printed subtype line says
   *  "Shapeshifter" — the keyword is what makes it a Cat, so the keyword is what is read. */
  it("accepts a changeling on its keyword rather than its subtypes", () => {
    expect(messages("Kaheera, the Orphanguard", [deckCard("mothdustChangeling")])).toEqual([]);
  });

  it("lists several offenders in one sentence", () => {
    const deck = [
      deckCard("grizzlyBears"),
      deckCard("fiendHunter"),
      card({ name: "Serra Angel", typeLine: "Creature — Angel", cmc: 5, manaCost: "{3}{W}{W}" }),
    ];

    expect(messages("Kaheera, the Orphanguard", deck)).toEqual([
      "Kaheera, the Orphanguard needs every creature card in your deck to be a Cat, Elemental, " +
        "Nightmare, Dinosaur or Beast; Grizzly Bears, Fiend Hunter and Serra Angel are not.",
    ]);
  });

  it("counts past three offenders instead of listing them all", () => {
    const deck = ["A", "B", "C", "D", "E"].map((n) =>
      card({ name: n, typeLine: "Creature — Bear", cmc: 2 }),
    );

    expect(messages("Kaheera, the Orphanguard", deck)[0]).toContain("A, B, C and 2 others are not");
  });
});

describe("Keruga, the Macrosage — mana value 3 or greater, and lands", () => {
  it("passes lands and big spells, and names the cheap ones", () => {
    expect(messages("Keruga, the Macrosage", [deckCard("wrathOfGod"), islands(30)])).toEqual([]);
    expect(messages("Keruga, the Macrosage", [deckCard("counterspell")])).toEqual([
      "Keruga, the Macrosage needs every nonland card in your deck to have mana value 3 or " +
        "greater; Counterspell does not.",
    ]);
  });
});

describe("Lurrus of the Dream-Den — permanents at mana value 2 or less", () => {
  it("ignores nonpermanents however expensive they are", () => {
    // Wrath of God is mana value 4 and a Sorcery, so Lurrus has nothing to say about it.
    expect(
      messages("Lurrus of the Dream-Den", [deckCard("wrathOfGod"), deckCard("solRing")]),
    ).toEqual([]);
  });

  it("names an expensive permanent", () => {
    const study = card({
      name: "Rhystic Study",
      manaCost: "{2}{U}",
      cmc: 3,
      typeLine: "Enchantment",
    });

    expect(messages("Lurrus of the Dream-Den", [study])).toEqual([
      "Lurrus of the Dream-Den needs every permanent card in your deck to have mana value 2 or " +
        "less; Rhystic Study does not.",
    ]);
  });
});

describe("Lutri, the Spellchaser — different names", () => {
  it("lets any number of lands repeat and refuses a repeated spell", () => {
    expect(messages("Lutri, the Spellchaser", [islands(60)])).toEqual([]);
    expect(messages("Lutri, the Spellchaser", [deckCard("counterspell", { quantity: 2 })])).toEqual(
      [
        "Lutri, the Spellchaser needs every nonland card in your deck to have a different name; " +
          "Counterspell appears more than once.",
      ],
    );
  });

  /** Two rows of one card in two categories are two copies of it, the same way the copy limit
   *  counts them. */
  it("adds up rows in different categories", () => {
    const deck = [deckCard("solRing"), deckCard("solRing", { categoryKind: "commander" })];

    expect(messages("Lutri, the Spellchaser", deck)[0]).toContain(
      "Sol Ring appears more than once",
    );
  });
});

describe("Obosh, the Preypiercer — odd mana values, and lands", () => {
  it("passes odd spells and lands, and names the even ones", () => {
    expect(messages("Obosh, the Preypiercer", [deckCard("solRing"), islands(30)])).toEqual([]);
    expect(messages("Obosh, the Preypiercer", [deckCard("counterspell")])).toEqual([
      "Obosh, the Preypiercer needs every nonland card in your deck to have an odd mana value; " +
        "Counterspell does not.",
    ]);
  });
});

describe("Umori, the Collector — one shared card type", () => {
  it("passes a deck whose nonlands are all creatures", () => {
    const deck = [deckCard("savannahLions"), deckCard("grizzlyBears"), islands(30)];

    expect(messages("Umori, the Collector", deck)).toEqual([]);
  });

  /** An artifact creature shares "Creature" with the creatures — sharing *a* type is the
   *  rule, not sharing every type. */
  it("passes a card that shares one of its several types", () => {
    const memnite = card({
      name: "Memnite",
      manaCost: "{0}",
      cmc: 0,
      typeLine: "Artifact Creature — Construct",
    });

    expect(messages("Umori, the Collector", [deckCard("grizzlyBears"), memnite])).toEqual([]);
  });

  it("names the odd one out against the type the rest share", () => {
    const deck = [deckCard("savannahLions"), deckCard("grizzlyBears"), deckCard("wrathOfGod")];

    expect(messages("Umori, the Collector", deck)).toEqual([
      "Umori, the Collector needs every nonland card in your deck to share a card type; most of " +
        "yours are Creature, but Wrath of God is not.",
    ]);
  });
});

describe("Yorion, Sky Nomad — twenty over the minimum", () => {
  /** The one condition that reads the format spec rather than the cards. */
  it("reads the format's own minimum", () => {
    expect(messages("Yorion, Sky Nomad", [islands(80)])).toEqual([]);
    expect(messages("Yorion, Sky Nomad", [islands(79)])).toEqual([
      "Yorion, Sky Nomad needs at least 80 cards in your deck, twenty more than Modern's " +
        "minimum of 60; you have 79.",
    ]);
  });

  /** Research doc: Yorion is unusable in Commander, because its minimum is also its maximum.
   *  The engine says both true things rather than picking one. */
  it("is unusable in a format whose minimum is its maximum", () => {
    expect(messages("Yorion, Sky Nomad", [commander(), islands(99)], "commander")).toEqual([
      "Yorion, Sky Nomad needs at least 120 cards in your deck, twenty more than Commander's " +
        "minimum of 100; you have 100.",
    ]);
  });
});

describe("Zirda, the Dawnwaker — activated abilities", () => {
  it("passes permanents with an activated ability, including basic lands", () => {
    // A basic land's whole printed text is the reminder for its intrinsic mana ability.
    expect(messages("Zirda, the Dawnwaker", [deckCard("solRing"), islands(30)])).toEqual([]);
  });

  it("names a vanilla permanent", () => {
    expect(messages("Zirda, the Dawnwaker", [deckCard("grizzlyBears")])).toEqual([
      "Zirda, the Dawnwaker needs every permanent card in your deck to have an activated " +
        "ability; Grizzly Bears does not.",
    ]);
  });

  it("ignores instants and sorceries, which are not permanents", () => {
    expect(messages("Zirda, the Dawnwaker", [deckCard("counterspell")])).toEqual([]);
  });

  /** Equip is an activated ability that Scryfall prints with no colon anywhere — 329 paper
   *  cards read that way. A colon-only test refuses the whole Equipment archetype, which is
   *  the archetype Zirda was printed for. */
  it("reads the keyword activated abilities that print without a colon", () => {
    expect(messages("Zirda, the Dawnwaker", [deckCard("skullclamp")])).toEqual([]);
  });

  /**
   * The thirteen "Job select" Equipment print their equip ability behind a flavour name, so
   * the keyword does not start its line: `"Murasame — Equip {5}"`. A line anchor alone misses
   * every one of them.
   */
  it("reads a keyword that sits behind a flavour name", () => {
    const katana = card({
      name: "Samurai's Katana",
      manaCost: "{2}",
      cmc: 2,
      typeLine: "Artifact — Equipment",
      oracleText:
        "When this Equipment enters, attach it to target creature you control.\nEquipped " +
        "creature gets +2/+0 and has first strike.\nMurasame — Equip {5}",
      colors: null,
      colorIdentity: "",
    });

    expect(messages("Zirda, the Dawnwaker", [katana])).toEqual([]);
  });

  /** Saddle is an activated ability, and six colonless permanents carry it. */
  it("reads saddle", () => {
    const steed = card({
      name: "Fortune, Loyal Steed",
      manaCost: "{2}{W}",
      cmc: 3,
      typeLine: "Legendary Creature — Horse",
      oracleText:
        "Whenever this creature attacks while saddled, target creature you control gains " +
        "protection from a color of your choice until end of turn.\nSaddle 1",
      colors: "W",
      colorIdentity: "W",
    });

    expect(messages("Zirda, the Dawnwaker", [steed])).toEqual([]);
  });

  /** Morph is a special action rather than an activated ability, and a card that only has
   *  one is genuinely a Zirda offender. The keyword list is not a list of every keyword. */
  it("still refuses a permanent whose only keyword is a special action", () => {
    const beast = card({
      name: "Ainok Survivalist",
      manaCost: "{1}{G}",
      cmc: 2,
      typeLine: "Creature — Hound Scout",
      oracleText:
        "Megamorph {2}{G} (You may cast this card face down as a 2/2 creature for {3}. Turn " +
        "it face up any time for its megamorph cost and put a +1/+1 counter on it.)",
      colors: "G",
      colorIdentity: "G",
    });

    expect(messages("Zirda, the Dawnwaker", [beast])).toEqual([
      "Zirda, the Dawnwaker needs every permanent card in your deck to have an activated " +
        "ability; Ainok Survivalist does not.",
    ]);
  });

  /** Dryad Arbor's only colon is inside reminder text, inside quotes — and the ability it
   *  describes is real. Stripping reminders would refuse it and every basic land with it. */
  it("counts an ability that is only stated in reminder text", () => {
    expect(messages("Zirda, the Dawnwaker", [deckCard("dryadArbor")])).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// The companion as a card of the deck: colour identity and singleton.
// ------------------------------------------------------------------------------------------

describe("a companion in a Commander deck", () => {
  /** Research doc: the companion is "effectively a 101st card", so it is held to the
   *  commander's colour identity like every other card. */
  it("must fit the commander's colour identity", () => {
    const zone = [companionCard("Jegantha, the Wellspring")];
    const mono = card({
      name: "Talrand, Sky Summoner",
      categoryKind: "commander",
      typeLine: "Legendary Creature — Merfolk Wizard",
      manaCost: "{2}{U}",
      cmc: 3,
      colors: "U",
      colorIdentity: "U",
    });

    const issues = companionIssues(zone, [mono, islands(99)], spec("commander"));

    expect(issues).toEqual([
      {
        severity: "error",
        code: "color-identity",
        message:
          "Jegantha, the Wellspring's color identity (WUBRG) is outside your commander's (U).",
        cardIds: ["c-Jegantha, the Wellspring"],
      },
    ]);
  });

  it("says nothing about colour identity where the format has no commander", () => {
    // Jegantha is five colours and Modern does not care.
    expect(messages("Jegantha, the Wellspring", [islands(60)])).toEqual([]);
  });

  /**
   * The hole Task 8 left open on purpose: the `companion` kind is out of the deck's *size*,
   * so a companion that is also in the 99 has to be caught somewhere, and copy counting is
   * where. Umori's own condition passes here (every nonland in the deck is a creature), so
   * the only thing left to say is that there are two of it.
   */
  it("is a copy of itself when it is also in the deck", () => {
    const deck = [
      commander(),
      card({ ...COMPANION_FIXTURES["Umori, the Collector"], name: "Umori, the Collector" }),
      companionCard("Umori, the Collector"),
      islands(98),
    ];

    expect(validateDeck(deck, spec("commander"))).toEqual([
      {
        severity: "error",
        code: "singleton",
        message: "Commander decks are singleton: max 1 copy of Umori, the Collector; you have 2.",
        cardIds: ["c-Umori, the Collector"],
      },
    ]);
  });

  /** CR 100.4a in the formats that have a real sideboard: the companion sits in one of its
   *  slots, so it is a fifth copy there too. */
  it("counts toward the four-of limit in a sixty-card format", () => {
    const deck = padTo(60, [
      card({
        ...COMPANION_FIXTURES["Lurrus of the Dream-Den"],
        name: "Lurrus of the Dream-Den",
        quantity: 4,
      }),
      companionCard("Lurrus of the Dream-Den"),
    ]);

    expect(validateDeck(deck, spec("modern")).map((i) => i.message)).toContain(
      "Modern decks allow up to 4 copies of Lurrus of the Dream-Den; you have 5.",
    );
  });

  /** A clean deck stays clean: the companion is a legal card of a legal deck and the engine
   *  says nothing at all. Kenrith is the deck's one nonland card and Umori's one shared type
   *  is his, and BG sits inside his WUBRG. */
  it("passes a legal Commander deck with a legal companion", () => {
    const deck = [commander(), islands(99), companionCard("Umori, the Collector")];

    expect(validateDeck(deck, spec("commander"))).toEqual([]);
  });
});
