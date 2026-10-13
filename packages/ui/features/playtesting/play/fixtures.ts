/**
 * Playtest views for stories and tests — the board drawn without the engine.
 *
 * **The goldfish's fixtures' arrangement** (`../goldfish/fixtures.ts`): real printings from the
 * fake's card rows, so Storybook's `live` and `bundled` modes draw real pictures, and views shaped
 * as the engine answers them. There is no rules engine here and no AI; a story that is clicked
 * through records what the board asks rather than playing it.
 */
import type { GameCard, PlaytestSeat, PlaytestView } from "@/lib/ipc";
import { gameCard } from "../goldfish/fixtures";

/** A Mountain: not among the fake's rows, so named and typed by hand (drawn as a plain tile). */
function mountain(over: Partial<GameCard> = {}): GameCard {
  return gameCard("Mountain", {
    typeLine: "Basic Land — Mountain",
    lane: "land",
    isLand: true,
    isToken: false,
    ...over,
  });
}

function seat(over: Partial<PlaytestSeat>): PlaytestSeat {
  return {
    life: 20,
    poison: 0,
    hand: [],
    handCount: 0,
    battlefield: [],
    graveyard: [],
    exile: [],
    command: [],
    library: 0,
    libraryCards: [],
    manaOpen: 0,
    ...over,
  };
}

function library(n: number): GameCard[] {
  const names = ["Forest", "Island", "Llanowar Elves", "Counterspell", "Tarmogoyf"];
  return Array.from({ length: n }, (_, i) => gameCard(names[i % names.length]));
}

/** The reader's ids the stories and tests click, kept so a test can name them. */
export interface TurnFive {
  view: PlaytestView;
  /** The reader's untapped creatures: Tarmogoyf, Llanowar Elves, Delver. */
  goyf: GameCard;
  elves: GameCard;
  delver: GameCard;
  /** The opponent's creatures: Ragavan and Boros Reckoner. */
  ragavan: GameCard;
  reckoner: GameCard;
}

/** Turn 5, the reader's first main phase: both tables populated, nothing on the stack. */
export function turnFive(): TurnFive {
  const goyf = gameCard("Tarmogoyf", { power: 3, toughness: 4 });
  const elves = gameCard("Llanowar Elves");
  const delver = gameCard("Delver of Secrets // Insectile Aberration", { power: 1, toughness: 1 });
  const ragavan = gameCard("Ragavan, Nimble Pilferer", { power: 2, toughness: 1 });
  const reckoner = gameCard("Boros Reckoner", { power: 3, toughness: 3, tapped: true });
  const view: PlaytestView = {
    stage: "main",
    turn: 5,
    active: "you",
    started: "you",
    phase: "main1",
    mulligan: null,
    you: seat({
      life: 17,
      hand: [
        gameCard("Counterspell"),
        gameCard("Forest"),
        gameCard("Consecrated Sphinx"),
        gameCard("Swords to Plowshares"),
      ],
      handCount: 4,
      battlefield: [
        goyf,
        elves,
        delver,
        gameCard("Sol Ring"),
        gameCard("Forest", { tapped: true }),
        gameCard("Forest"),
        gameCard("Island"),
      ],
      graveyard: [gameCard("Lightning Bolt"), gameCard("Swords to Plowshares")],
      library: 48,
      libraryCards: library(48),
      manaOpen: 5,
    }),
    opponent: seat({
      life: 14,
      handCount: 5,
      battlefield: [
        ragavan,
        reckoner,
        gameCard("Smuggler's Copter"),
        mountain({ tapped: true }),
        mountain(),
        gameCard("Ancient Tomb"),
      ],
      graveyard: [gameCard("Lightning Bolt"), gameCard("Boros Charm")],
      exile: [gameCard("Bonecrusher Giant // Stomp")],
      library: 47,
      manaOpen: 3,
    }),
    combat: null,
    attack: null,
    block: null,
    prompt: null,
    stack: [],
    winner: null,
    tokens: [],
  };
  return { view, goyf, elves, delver, ragavan, reckoner };
}

/** The reader's declare-attackers step on turn 5: three creatures that may attack. */
export function attackStep(): TurnFive {
  const t = turnFive();
  return {
    ...t,
    view: {
      ...t.view,
      stage: "attack",
      phase: "combat",
      attack: { attackers: [t.goyf.id, t.elves.id, t.delver.id] },
    },
  };
}

/**
 * The opponent's turn 6, declare blockers: Ragavan attacks; Tarmogoyf and the Elves may block it.
 */
export function blockStep(): TurnFive {
  const t = turnFive();
  const ragavan = { ...t.ragavan, tapped: true };
  return {
    ...t,
    ragavan,
    view: {
      ...t.view,
      stage: "block",
      turn: 6,
      active: "opponent",
      phase: "combat",
      opponent: {
        ...t.view.opponent,
        battlefield: t.view.opponent.battlefield.map((c) => (c.id === ragavan.id ? ragavan : c)),
      },
      combat: { attackers: [ragavan.id], blocks: [] },
      block: {
        blockers: [
          { id: t.goyf.id, attackers: [ragavan.id] },
          { id: t.elves.id, attackers: [ragavan.id] },
        ],
      },
    },
  };
}

/**
 * The reader has cast Swords to Plowshares and the engine asks for its target: either of the
 * opponent's creatures, or one of the reader's own.
 */
export function targetPrompt(): TurnFive {
  const t = turnFive();
  const ref = (c: GameCard) => ({ id: c.id, name: c.name, cardId: c.cardId });
  const option = (index: number, c: GameCard) => ({
    index,
    kind: "ChooseTarget",
    cards: [ref(c)],
    players: [],
    number: null,
    yes: null,
    label: null,
  });
  return {
    ...t,
    view: {
      ...t.view,
      stage: "prompt",
      prompt: {
        kind: "TargetSelection",
        source: "Swords to Plowshares",
        options: [option(0, t.ragavan), option(1, t.reckoner), option(2, t.goyf)],
        cancellable: true,
      },
      stack: [],
    },
  };
}

/** Bonecrusher Giant from hand: cast the creature, or its adventure. */
export function castChoicePrompt(): TurnFive {
  const t = turnFive();
  const giant = gameCard("Bonecrusher Giant // Stomp");
  const ref = { id: giant.id, name: giant.name, cardId: giant.cardId };
  return {
    ...t,
    view: {
      ...t.view,
      stage: "prompt",
      you: { ...t.view.you, hand: [...t.view.you.hand, giant], handCount: 5 },
      prompt: {
        kind: "CastChoice",
        source: giant.name,
        options: [
          {
            index: 0,
            kind: "CastSpell",
            cards: [ref],
            players: [],
            number: null,
            yes: null,
            label: "Bonecrusher Giant",
          },
          {
            index: 1,
            kind: "CastAdventure",
            cards: [ref],
            players: [],
            number: null,
            yes: null,
            label: "Stomp",
          },
        ],
        cancellable: true,
      },
    },
  };
}

/** The opponent's Lightning Bolt on the stack over the reader's own Counterspell's target. */
export function withStack(): TurnFive {
  const t = turnFive();
  const bolt = gameCard("Lightning Bolt");
  const counter = gameCard("Counterspell");
  return {
    ...t,
    view: {
      ...t.view,
      stack: [
        { id: counter.id, name: counter.name, cardId: counter.cardId, seat: "you", ability: false },
        { id: bolt.id, name: bolt.name, cardId: bolt.cardId, seat: "opponent", ability: false },
      ],
    },
  };
}

/** The opponent at 0 on turn 9: the reader won. */
export function gameOver(): TurnFive {
  const t = turnFive();
  return {
    ...t,
    view: {
      ...t.view,
      stage: "over",
      turn: 9,
      opponent: { ...t.view.opponent, life: 0 },
      winner: "you",
    },
  };
}

/** The reader's opening hand: no mulligans yet. */
export function openingHand(): PlaytestView {
  const t = turnFive();
  return {
    ...t.view,
    stage: "mulligan",
    turn: 0,
    phase: "beginning",
    mulligan: { mulligans: 0, bottom: 0, freeFirst: false },
    you: {
      ...t.view.you,
      life: 20,
      battlefield: [],
      graveyard: [],
      hand: [
        gameCard("Forest"),
        gameCard("Island"),
        gameCard("Llanowar Elves"),
        gameCard("Tarmogoyf"),
        gameCard("Counterspell"),
        gameCard("Forest"),
        gameCard("Delver of Secrets // Insectile Aberration"),
      ],
      handCount: 7,
      library: 53,
      libraryCards: library(53),
    },
    opponent: {
      ...t.view.opponent,
      life: 20,
      battlefield: [],
      graveyard: [],
      exile: [],
      handCount: 7,
    },
  };
}
