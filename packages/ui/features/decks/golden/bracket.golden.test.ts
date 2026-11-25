/**
 * The bracket golden, `../__golden__/bracket.json` — read by `crates/grimoire-core/src/deck_rules/
 * bracket.rs`, which must answer every case the same. Per case: the cards, the combos,
 * `estimateBracket`'s answer, each reason's `describeReason`, `bracketWarning` at set brackets 0–5
 * (`null` where it answers nothing), and each combo's `comboBrackets`.
 *
 * Cards named after printings carry their oracle text — verbatim from
 * `../validation/bracket.test.ts` where that suite probed them, and as printed otherwise; the golden
 * pins the port, not Scryfall. A name starting `Edge:` is a string written to reach one branch of a
 * matcher. As in that suite, a combo's `bracketTag` is the case's input, not a claim about
 * Spellbook's classification.
 *
 * Regenerate with `pnpm exec vitest run -u` on this file; never by hand.
 */
import { describe, expect, it } from "vitest";
import type { DeckCombo } from "@/lib/ipc";
import {
  bracketWarning,
  comboBrackets,
  describeReason,
  estimateBracket,
} from "../validation/bracket";
import { GAME_CHANGERS, card, gameChanger, islands, resetRowIds } from "../validation/fixtures";
import type { CardFacts } from "../validation/types";
import { goldenText, type GoldenCase } from "./golden";

/** The set brackets every case's warning is asked at: Auto, then 1–5. */
const SET_BRACKETS = [0, 1, 2, 3, 4, 5];

let nextCombo = 1;

/** One row of `combos_for_cards` — `bracket.test.ts`' own builder. */
function combo(overrides: Partial<DeckCombo> = {}): DeckCombo {
  return {
    id: `v-${nextCombo++}`,
    bracketTag: "C",
    cards: ["Basalt Monolith", "Rings of Brighthearth"],
    templateCount: 0,
    produces: "Infinite colorless mana",
    popularity: 4200,
    ...overrides,
  };
}

/** A letter outside `ComboBracketTag`, as a later Spellbook file could carry one. */
function unknownTag(tag: string): DeckCombo["bracketTag"] {
  return tag as DeckCombo["bracketTag"];
}

/** A string written to reach a branch: a sorcery with the given text and nothing else. */
function edge(name: string, oracleText: string | null, more: Partial<CardFacts> = {}): CardFacts {
  return card({ name: `Edge: ${name}`, typeLine: "Sorcery", oracleText, ...more });
}

// --- The printings -------------------------------------------------------------------------------

const armageddon = (more: Partial<CardFacts> = {}) =>
  card({
    name: "Armageddon",
    manaCost: "{3}{W}",
    cmc: 4,
    typeLine: "Sorcery",
    oracleText: "Destroy all lands.",
    colors: "W",
    colorIdentity: "W",
    ...more,
  });

const jokulhaups = () =>
  card({
    name: "Jokulhaups",
    manaCost: "{4}{R}{R}",
    cmc: 6,
    typeLine: "Sorcery",
    oracleText: "Destroy all artifacts, creatures, and lands. They can't be regenerated.",
    colors: "R",
    colorIdentity: "R",
  });

const ruination = () =>
  card({
    name: "Ruination",
    manaCost: "{3}{R}",
    cmc: 4,
    typeLine: "Sorcery",
    oracleText: "Destroy all nonbasic lands.",
    colors: "R",
    colorIdentity: "R",
  });

const wildfire = () =>
  card({
    name: "Wildfire",
    manaCost: "{4}{R}{R}",
    cmc: 6,
    typeLine: "Sorcery",
    oracleText:
      "Each player sacrifices four lands of their choice. Wildfire deals 4 damage to each creature.",
    colors: "R",
    colorIdentity: "R",
  });

const timeWarp = (more: Partial<CardFacts> = {}) =>
  card({
    name: "Time Warp",
    manaCost: "{3}{U}{U}",
    cmc: 5,
    typeLine: "Sorcery",
    oracleText: "Target player takes an extra turn after this one.",
    colors: "U",
    colorIdentity: "U",
    ...more,
  });

const nexusOfFate = () =>
  card({
    name: "Nexus of Fate",
    manaCost: "{5}{U}{U}",
    cmc: 7,
    typeLine: "Instant",
    oracleText:
      "Take an extra turn after this one.\nIf Nexus of Fate would be put into a graveyard from " +
      "anywhere, reveal Nexus of Fate and shuffle it into its owner's library instead.",
    colors: "U",
    colorIdentity: "U",
  });

const temporalManipulation = () =>
  card({
    name: "Temporal Manipulation",
    manaCost: "{3}{U}{U}",
    cmc: 5,
    typeLine: "Sorcery",
    oracleText: "Take an extra turn after this one.",
    colors: "U",
    colorIdentity: "U",
  });

const captureOfJingzhou = () =>
  card({
    name: "Capture of Jingzhou",
    manaCost: "{3}{U}{U}",
    cmc: 5,
    typeLine: "Sorcery",
    oracleText: "Target player takes an extra turn after this one.",
    colors: "U",
    colorIdentity: "U",
  });

const timeStretch = () =>
  card({
    name: "Time Stretch",
    manaCost: "{8}{U}{U}",
    cmc: 10,
    typeLine: "Sorcery",
    oracleText: "Target player takes two extra turns after this one.",
    colors: "U",
    colorIdentity: "U",
  });

const rampantGrowth = () =>
  card({
    name: "Rampant Growth",
    manaCost: "{1}{G}",
    cmc: 2,
    typeLine: "Sorcery",
    oracleText:
      "Search your library for a basic land card, put that card onto the battlefield tapped, " +
      "then shuffle.",
    colors: "G",
    colorIdentity: "G",
  });

const demonicTutor = () =>
  card({
    name: "Demonic Tutor",
    manaCost: "{1}{B}",
    cmc: 2,
    typeLine: "Sorcery",
    oracleText: "Search your library for a card, put that card into your hand, then shuffle.",
    colors: "B",
    colorIdentity: "B",
    gameChanger: false,
  });

const vampiricTutor = () =>
  card({
    name: "Vampiric Tutor",
    manaCost: "{B}",
    cmc: 1,
    typeLine: "Instant",
    oracleText:
      "Search your library for a card, then shuffle and put that card on top. You lose 2 life.",
    colors: "B",
    colorIdentity: "B",
    gameChanger: false,
  });

const grizzlyBears = () =>
  card({
    name: "Grizzly Bears",
    manaCost: "{1}{G}",
    cmc: 2,
    typeLine: "Creature — Bear",
    oracleText: "",
    colors: "G",
    colorIdentity: "G",
  });

const walkTheAeons = () =>
  card({
    name: "Walk the Aeons",
    manaCost: "{3}{U}{U}",
    cmc: 5,
    typeLine: "Sorcery",
    oracleText:
      "Take an extra turn after this one.\nBuyback—Sacrifice three Islands. (You may " +
      "sacrifice three Islands in addition to any other costs as you cast this spell. If " +
      "you do, put this card into your hand as it resolves.)",
    colors: "U",
    colorIdentity: "U",
  });

const boil = () =>
  card({
    name: "Boil",
    manaCost: "{3}{R}",
    cmc: 4,
    typeLine: "Instant",
    oracleText: "Destroy all Islands.",
    colors: "R",
    colorIdentity: "R",
  });

const apocalypseChime = () =>
  card({
    name: "Apocalypse Chime",
    manaCost: "{2}",
    cmc: 2,
    typeLine: "Artifact",
    oracleText:
      "{2}, {T}, Sacrifice this artifact: Destroy all nontoken permanents with a name " +
      "originally printed in the Homelands expansion. They can't be regenerated.",
    colors: null,
    colorIdentity: "",
  });

const bontusLastReckoning = () =>
  card({
    name: "Bontu's Last Reckoning",
    manaCost: "{1}{B}{B}",
    cmc: 3,
    typeLine: "Sorcery",
    oracleText: "Destroy all creatures. Lands you control don't untap during your next untap step.",
    colors: "B",
    colorIdentity: "B",
  });

const lotusField = () =>
  card({
    name: "Lotus Field",
    manaCost: null,
    cmc: 0,
    typeLine: "Land",
    oracleText:
      "Hexproof\nThis land enters tapped.\nWhen this land enters, sacrifice two lands.\n" +
      "{T}: Add three mana of any one color.",
    colors: null,
    colorIdentity: "",
  });

const lotusVale = () =>
  card({
    name: "Lotus Vale",
    manaCost: null,
    cmc: 0,
    typeLine: "Land",
    oracleText:
      "If this land would enter, sacrifice two untapped lands instead. If you do, put this " +
      "land onto the battlefield. If you don't, put it into its owner's graveyard.\n" +
      "{T}: Add three mana of any one color.",
    colors: null,
    colorIdentity: "",
  });

const devastatingSummons = () =>
  card({
    name: "Devastating Summons",
    manaCost: "{R}",
    cmc: 1,
    typeLine: "Sorcery",
    oracleText:
      "As an additional cost to cast this spell, sacrifice X lands.\n" +
      "Create two X/X red Elemental creature tokens.",
    colors: "R",
    colorIdentity: "R",
  });

const scourglass = () =>
  card({
    name: "Scourglass",
    manaCost: "{3}{W}{W}",
    cmc: 5,
    typeLine: "Artifact",
    oracleText:
      "{T}, Sacrifice this artifact: Destroy all permanents except for artifacts and lands. " +
      "Activate only during your turn, before attackers are declared.",
    colors: "W",
    colorIdentity: "W",
  });

const keldonFirebombers = () =>
  card({
    name: "Keldon Firebombers",
    manaCost: "{3}{R}",
    cmc: 4,
    typeLine: "Creature — Human Rebel",
    oracleText:
      "When this creature enters, each player sacrifices all lands they control except for " +
      "three.",
    colors: "R",
    colorIdentity: "R",
  });

const zuranOrb = () =>
  card({
    name: "Zuran Orb",
    manaCost: "{0}",
    cmc: 0,
    typeLine: "Artifact",
    oracleText: "Sacrifice a land: You gain 2 life.",
    colors: null,
    colorIdentity: "",
  });

const wrathOfGod = () =>
  card({
    name: "Wrath of God",
    manaCost: "{2}{W}{W}",
    cmc: 4,
    typeLine: "Sorcery",
    oracleText: "Destroy all creatures. They can't be regenerated.",
    colors: "W",
    colorIdentity: "W",
  });

const deathCloud = () =>
  card({
    name: "Death Cloud",
    manaCost: "{X}{B}{B}{B}",
    cmc: 3,
    typeLine: "Sorcery",
    oracleText:
      "Each player loses X life, discards X cards, sacrifices X creatures, then sacrifices X " +
      "lands.",
    colors: "B",
    colorIdentity: "B",
  });

const pox = () =>
  card({
    name: "Pox",
    manaCost: "{B}{B}{B}",
    cmc: 3,
    typeLine: "Sorcery",
    oracleText:
      "Each player loses a third of their life, rounded up. Then each player discards a third " +
      "of the cards in their hand, rounded up. Then each player sacrifices a third of the " +
      "creatures they control, rounded up. Then each player sacrifices a third of the lands " +
      "they control, rounded up.",
    colors: "B",
    colorIdentity: "B",
  });

const stranglehold = () =>
  card({
    name: "Stranglehold",
    manaCost: "{2}{R}{R}",
    cmc: 4,
    typeLine: "Enchantment",
    oracleText:
      "Your opponents can't search libraries.\nIf an opponent would begin an extra turn, " +
      "that player skips that turn instead.",
    colors: "R",
    colorIdentity: "R",
  });

const troubleInPairs = () =>
  card({
    name: "Trouble in Pairs",
    manaCost: "{2}{W}{W}",
    cmc: 4,
    typeLine: "Enchantment",
    oracleText:
      "If an opponent would begin an extra turn, that player skips that turn instead.\n" +
      "Whenever an opponent attacks you with two or more creatures, draws their second card " +
      "each turn, or casts their second spell each turn, you draw a card.",
    colors: "W",
    colorIdentity: "W",
  });

const gerrardsHourglassPendant = () =>
  card({
    name: "Gerrard's Hourglass Pendant",
    manaCost: "{1}",
    cmc: 1,
    typeLine: "Legendary Artifact",
    oracleText:
      "Flash\nIf a player would begin an extra turn, that player skips that turn instead.\n" +
      "{1}, {T}, Exile Gerrard's Hourglass Pendant: Return to the battlefield tapped all " +
      "artifact, creature, enchantment, and land cards in your graveyard that were put there " +
      "from anywhere this turn.",
    colors: null,
    colorIdentity: "",
  });

const uginsNexus = () =>
  card({
    name: "Ugin's Nexus",
    manaCost: "{5}",
    cmc: 5,
    typeLine: "Legendary Artifact",
    oracleText:
      "If a player would begin an extra turn, that player skips that turn instead.\n" +
      "If Ugin's Nexus would be put into a graveyard from the battlefield, instead exile it " +
      "and take an extra turn after this one.",
    colors: null,
    colorIdentity: "",
  });

const FOUR_GAME_CHANGERS = ["Rhystic Study", "Cyclonic Rift", "The One Ring", "Ancient Tomb"];

// --- The cases -----------------------------------------------------------------------------------

interface Inputs {
  cards: () => CardFacts[];
  combos?: () => DeckCombo[];
}

/** One case, built from fresh row and combo ids so a case's file text does not depend on its
 *  neighbours. */
function bracketCase(name: string, { cards, combos = () => [] }: Inputs): GoldenCase {
  resetRowIds();
  nextCombo = 1;
  const deck = cards();
  const list = combos();
  const estimate = estimateBracket(deck, list);
  return {
    name,
    cards: deck,
    combos: list,
    estimate,
    reasons: estimate.reasons.map(describeReason),
    warnings: SET_BRACKETS.map((set) => bracketWarning(set, estimate)),
    comboBrackets: list.map((c) => comboBrackets(c.bracketTag)),
  };
}

function cases(): GoldenCase[] {
  return [
    // The base floor: no rule fires, so 2 with no reason, and set 1 is told nothing.
    bracketCase("an empty deck", { cards: () => [] }),
    bracketCase("a deck that flags nothing", {
      cards: () => [grizzlyBears(), rampantGrowth(), islands(60)],
    }),
    bracketCase("tutors are no signal", {
      cards: () => [demonicTutor(), vampiricTutor(), rampantGrowth(), islands(60)],
    }),
    bracketCase("a row whose game changer flag is unknown", {
      cards: () => [card({ name: "Gone Card", gameChanger: null }), islands(60)],
    }),

    // Game Changers: 1–3 force 3, a fourth forces 4.
    bracketCase("one game changer", {
      cards: () => [gameChanger("Rhystic Study"), islands(60)],
    }),
    bracketCase("three game changers", {
      cards: () => [
        gameChanger("Rhystic Study"),
        gameChanger("Cyclonic Rift"),
        gameChanger("The One Ring"),
        islands(60),
      ],
    }),
    bracketCase("four game changers", {
      cards: () => [...FOUR_GAME_CHANGERS.map((n) => gameChanger(n)), grizzlyBears(), islands(60)],
    }),
    bracketCase("five game changers name three and count the rest", {
      cards: () => [...FOUR_GAME_CHANGERS.map((n) => gameChanger(n)), gameChanger("Demonic Tutor")],
    }),
    bracketCase("every game changer in the fixtures", {
      cards: () => Object.keys(GAME_CHANGERS).map((n) => gameChanger(n)),
    }),
    bracketCase("a game changer in two piles is one card", {
      cards: () => [gameChanger("Rhystic Study"), gameChanger("Rhystic Study", "side")],
    }),
    bracketCase("a game changer on the switched-off maybeboard", {
      cards: () => [gameChanger("Rhystic Study", "maybe"), islands(60)],
    }),
    bracketCase("a game changer on a switched-on maybeboard", {
      cards: () => [
        { ...gameChanger("Rhystic Study", "maybe"), categoryActive: true },
        islands(60),
      ],
    }),
    bracketCase("a game changer in a main pile switched off", {
      cards: () => [{ ...gameChanger("Cyclonic Rift"), categoryActive: false }, islands(60)],
    }),
    bracketCase("a name's first active row is the one read", {
      cards: () => [
        card({ name: "Rhystic Study", gameChanger: false }),
        gameChanger("Rhystic Study", "side"),
        armageddon(),
        armageddon({ oracleText: null, categoryKind: "side" }),
      ],
    }),
    bracketCase("a switched-off first row gives way to an active one", {
      cards: () => [
        { ...gameChanger("Rhystic Study"), categoryActive: false },
        gameChanger("Rhystic Study", "side"),
        timeWarp({ categoryActive: false }),
        timeWarp({ oracleText: null, categoryKind: "side" }),
      ],
    }),

    // Mass land denial: any forces 4.
    bracketCase("armageddon", { cards: () => [armageddon(), grizzlyBears(), islands(60)] }),
    bracketCase("the four printed shapes of mass land denial", {
      cards: () => [armageddon(), jokulhaups(), ruination(), wildfire()],
    }),
    bracketCase("table-facing sacrifices", { cards: () => [deathCloud(), pox(), islands(60)] }),
    bracketCase("denial with a remainder", { cards: () => [keldonFirebombers()] }),
    bracketCase("a sweeper that spares lands", { cards: () => [scourglass(), wrathOfGod()] }),
    bracketCase("sacrificing your own lands is a cost", {
      cards: () => [
        lotusField(),
        lotusVale(),
        devastatingSummons(),
        zuranOrb(),
        edge(
          "kicker",
          "Kicker—Sacrifice two lands. (You may sacrifice two lands in addition to any other " +
            "costs as you cast this spell.)\nCreate a 3/3 green Beast creature token. If this " +
            "spell was kicked, destroy all creatures instead.",
        ),
      ],
    }),
    bracketCase("destroy all and lands in two sentences", {
      cards: () => [bontusLastReckoning(), islands(60)],
    }),
    bracketCase("islands and homelands are not lands", {
      cards: () => [walkTheAeons(), boil(), apocalypseChime(), islands(60)],
    }),
    bracketCase("highlands are not lands", {
      cards: () => [
        edge("highlands", "Destroy all Highlands."),
        edge("each highlands", "Each player sacrifices all Highlands they control."),
      ],
    }),
    bracketCase("javascript's ascii word boundary", {
      cards: () => [
        edge("non-ascii before", "Destroy all élands."),
        edge("non-ascii after", "Destroy all landsé."),
        edge("underscore before", "Destroy all _lands."),
        edge("digit after", "Destroy all lands2."),
        edge("dash after", "Destroy all lands—now."),
        edge("landscape", "Destroy all landscapes."),
        edge("uppercase", "DESTROY ALL LANDS!"),
      ],
    }),
    bracketCase("an except decides by what comes first", {
      cards: () => [
        edge("lands before except", "Destroy all lands except Islands."),
        edge("except inside a word", "Destroy all exceptional lands."),
        edge("lands on both sides", "Each player sacrifices lands except for lands they tapped."),
        edge("lands then exceptlands", "Destroy all landsexcept lands."),
      ],
    }),
    bracketCase("all lands is table-facing on its own", {
      cards: () => [
        edge("sacrifice all lands", "Sacrifice all lands you control."),
        edge("each opponent", "Each opponent sacrifices two lands."),
        edge("sacrific stem", "Each player sacrificed lands this turn."),
      ],
    }),

    // Extra turns: 1–2 force 2, a third forces 4.
    bracketCase("one extra-turn card", { cards: () => [timeWarp(), grizzlyBears(), islands(60)] }),
    bracketCase("two extra-turn cards", { cards: () => [timeWarp(), nexusOfFate(), islands(60)] }),
    bracketCase("three extra-turn cards", {
      cards: () => [timeWarp(), nexusOfFate(), temporalManipulation(), islands(60)],
    }),
    bracketCase("four extra-turn cards name three and count the rest", {
      cards: () => [timeWarp(), nexusOfFate(), temporalManipulation(), captureOfJingzhou()],
    }),
    bracketCase("an extra-turn card in two piles is one card", {
      cards: () => [timeWarp(), timeWarp({ categoryKind: "side" }), nexusOfFate()],
    }),
    bracketCase("an extra-turn card on the switched-off maybeboard", {
      cards: () => [timeWarp({ categoryKind: "maybe" }), grizzlyBears()],
    }),
    bracketCase("two extra turns on one card", { cards: () => [timeStretch()] }),
    bracketCase("cards that only deny extra turns", {
      cards: () => [stranglehold(), troubleInPairs(), gerrardsHourglassPendant(), islands(60)],
    }),
    bracketCase("a card that denies and then takes an extra turn", {
      cards: () => [uginsNexus(), islands(60)],
    }),
    bracketCase("a denial is read inside one clause", {
      cards: () => [
        edge(
          "denial split by a line",
          "If a player would begin an extra turn\nthat player skips that turn instead.",
        ),
        edge("skip then instead", "That player skips that turn instead of taking an extra turn."),
        edge(
          "turn instead of a skip",
          "If a player would skip a turn, that player takes an extra turn instead.",
        ),
        edge("skip before the turn", "A player who skips that turn takes an extra turn."),
        edge("no space", "Take an extraturn."),
      ],
    }),

    // Faces: the row's text and every face's, a line each.
    bracketCase("an mdfc whose text is on its faces", {
      cards: () => [
        card({
          name: "Ravage // Ruin",
          layout: "modal_dfc",
          oracleText: null,
          faces: JSON.stringify([
            { name: "Ravage", oracle_text: "Destroy all lands." },
            { name: "Ruin", oracle_text: "Ruin enters tapped." },
          ]),
        }),
      ],
    }),
    bracketCase("a back face takes the extra turn", {
      cards: () => [
        card({
          name: "Front // Back",
          layout: "transform",
          oracleText: "Draw a card.",
          faces: JSON.stringify([
            { oracle_text: "Draw a card." },
            { oracle_text: "Take an extra turn after this one." },
          ]),
        }),
      ],
    }),
    bracketCase("unreadable faces are no faces", {
      cards: () => [
        edge("not json", null, { faces: "{not json" }),
        edge("empty string", null, { faces: "" }),
        edge("an object", null, { faces: JSON.stringify({ oracle_text: "Destroy all lands." }) }),
        edge("a string", null, { faces: JSON.stringify("Destroy all lands.") }),
        edge("bad json but good text", "Destroy all lands.", { faces: "[" }),
      ],
    }),
    bracketCase("faces without a string oracle text add nothing", {
      cards: () => [
        edge("odd faces", null, {
          faces: JSON.stringify([
            null,
            3,
            "Destroy all lands.",
            ["Destroy all lands."],
            { oracle_text: 7 },
            { oracle_text: null },
            { name: "No text" },
          ]),
        }),
      ],
    }),
    bracketCase("each face is its own line", {
      cards: () => [
        edge("split across faces", "Destroy all", {
          faces: JSON.stringify([{ oracle_text: "lands." }]),
        }),
        edge("extra across faces", "Take an extra", {
          faces: JSON.stringify([{ oracle_text: "turn after this one." }]),
        }),
      ],
    }),
    bracketCase("a repeated key in a face is its last value", {
      cards: () => [
        edge("last is text", null, {
          faces: '[{"oracle_text": 5, "oracle_text": "Take an extra turn after this one."}]',
        }),
        edge("last is a number", null, {
          faces: '[{"oracle_text": "Destroy all lands.", "oracle_text": 5}]',
        }),
      ],
    }),

    // Combos: each letter, and the definite/possible split.
    bracketCase("a combo tagged R", {
      cards: () => [islands(60)],
      combos: () => [
        combo({
          bracketTag: "R",
          cards: ["Thassa's Oracle", "Demonic Consultation"],
          produces: "Win the game",
        }),
      ],
    }),
    bracketCase("a combo tagged S", {
      cards: () => [islands(60)],
      combos: () => [combo({ bracketTag: "S" })],
    }),
    bracketCase("a combo tagged P", {
      cards: () => [islands(60)],
      combos: () => [combo({ bracketTag: "P", popularity: null })],
    }),
    bracketCase("a combo tagged O", {
      cards: () => [islands(60)],
      combos: () => [combo({ bracketTag: "O" })],
    }),
    bracketCase("a combo tagged C", {
      cards: () => [islands(60)],
      combos: () => [combo({ bracketTag: "C" })],
    }),
    bracketCase("a combo tagged E raises nothing and is still listed", {
      cards: () => [islands(60)],
      combos: () => [combo({ bracketTag: "E", cards: ["Squirrel Nest", "Earthcraft"] })],
    }),
    bracketCase("a combo tagged B raises nothing and is still listed", {
      cards: () => [islands(60)],
      combos: () => [combo({ bracketTag: "B", cards: ["Flash", "Protean Hulk"] })],
    }),
    bracketCase("letters this build does not know raise nothing", {
      cards: () => [islands(60)],
      combos: () => [
        combo({ bracketTag: unknownTag("Z") }),
        combo({ bracketTag: unknownTag("r") }),
        combo({ bracketTag: unknownTag("") }),
      ],
    }),
    bracketCase("a combo that needs a template is only possible", {
      cards: () => [islands(60)],
      combos: () => [
        combo({
          bracketTag: "R",
          templateCount: 1,
          cards: ["Kiki-Jiki, Mirror Breaker"],
          produces: "Infinite creature tokens",
        }),
      ],
    }),
    bracketCase("a mixed combo list splits on a template count of zero", {
      cards: () => [islands(60)],
      combos: () => [
        combo({ bracketTag: "P", templateCount: 0 }),
        combo({ bracketTag: "R", templateCount: 2 }),
        combo({ bracketTag: "R", templateCount: -1 }),
        combo({ bracketTag: "E", templateCount: 0 }),
      ],
    }),
    bracketCase("several combos at the floor are several reasons", {
      cards: () => [islands(60)],
      combos: () => [
        combo({ bracketTag: "C" }),
        combo({ bracketTag: "R", cards: ["Thassa's Oracle", "Demonic Consultation"] }),
        combo({ bracketTag: "O" }),
        combo({ bracketTag: "R", cards: ["Dramatic Reversal", "Isochron Scepter"] }),
      ],
    }),
    bracketCase("a combo names all of its cards", {
      cards: () => [islands(60)],
      combos: () => [
        combo({
          bracketTag: "R",
          cards: ["Thassa's Oracle", "Demonic Consultation", "Lotus Petal", "Brainstorm"],
        }),
      ],
    }),
    bracketCase("a one-card combo", {
      cards: () => [islands(60)],
      combos: () => [
        combo({ bracketTag: "S", cards: ["Kiki-Jiki, Mirror Breaker"], popularity: null }),
      ],
    }),

    // Combinations: the highest rung wins, and only the rules at it are reasons.
    bracketCase("a combo outranks the cards", {
      cards: () => [gameChanger("Rhystic Study"), islands(60)],
      combos: () => [combo({ bracketTag: "R" })],
    }),
    bracketCase("the cards outrank a combo", {
      cards: () => [armageddon(), islands(60)],
      combos: () => [combo({ bracketTag: "C" })],
    }),
    bracketCase("a game changer and a combo tie at 3", {
      cards: () => [gameChanger("Smothering Tithe"), islands(60)],
      combos: () => [combo({ bracketTag: "P" }), combo({ bracketTag: "O" })],
    }),
    bracketCase("an extra turn and a combo tie at 2", {
      cards: () => [timeWarp(), islands(60)],
      combos: () => [combo({ bracketTag: "C" })],
    }),
    bracketCase("a combo alone sets 2 with a reason", {
      cards: () => [grizzlyBears(), islands(60)],
      combos: () => [combo({ bracketTag: "O" })],
    }),
    bracketCase("a game changer and mass land denial", {
      cards: () => [gameChanger("Rhystic Study"), armageddon(), islands(60)],
    }),
    bracketCase("two game changers over an extra turn", {
      cards: () => [
        timeWarp(),
        gameChanger("Rhystic Study"),
        gameChanger("Cyclonic Rift"),
        islands(60),
      ],
    }),
    bracketCase("three extra turns over two game changers", {
      cards: () => [
        gameChanger("Rhystic Study"),
        gameChanger("Cyclonic Rift"),
        timeWarp(),
        nexusOfFate(),
        temporalManipulation(),
      ],
    }),
    bracketCase("every rule at 4", {
      cards: () => [
        ...FOUR_GAME_CHANGERS.map((n) => gameChanger(n)),
        armageddon(),
        timeWarp(),
        nexusOfFate(),
        temporalManipulation(),
        islands(60),
      ],
      combos: () => [combo({ bracketTag: "R" })],
    }),
    bracketCase("never 5, whatever the deck holds", {
      cards: () => [
        ...Object.keys(GAME_CHANGERS).map((n) => gameChanger(n)),
        armageddon(),
        jokulhaups(),
        timeWarp(),
        nexusOfFate(),
        temporalManipulation(),
      ],
      combos: () => [combo({ bracketTag: "R" }), combo({ bracketTag: "R" })],
    }),
  ];
}

describe("the bracket golden", () => {
  it("matches the committed file", async () => {
    const text = goldenText(
      "Written by packages/ui/features/decks/golden/bracket.golden.test.ts from " +
        "validation/bracket.ts and read by crates/grimoire-core/src/deck_rules/bracket.rs; " +
        "regenerate with vitest -u, never by hand.",
      cases(),
    );
    await expect(text).toMatchFileSnapshot("../__golden__/bracket.json");
  });
});
