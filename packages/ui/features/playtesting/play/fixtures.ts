/**
 * Playtest views for stories and tests — the board drawn without the engine.
 *
 * **The goldfish's fixtures' arrangement** (`../goldfish/fixtures.ts`): real printings from the
 * fake's card rows, so Storybook's `live` and `bundled` modes draw real pictures, and views shaped
 * as the engine answers them. There is no rules engine here and no AI; a story that is clicked
 * through records what the board asks rather than playing it.
 */
import type {
  GameCard,
  PlaytestHappened,
  PlaytestPick,
  PlaytestSeat,
  PlaytestStep,
  PlaytestView,
} from "@/lib/ipc";
import { gameCard, manaTable } from "../goldfish/fixtures";

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
    mana: manaTable(),
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
  /** The opponent's planeswalker, which Tarmogoyf may attack. */
  jace: GameCard;
}

/** Turn 5, the reader's first main phase: both tables populated, nothing on the stack. */
export function turnFive(): TurnFive {
  const goyf = gameCard("Tarmogoyf", { power: 3, toughness: 4 });
  const elves = gameCard("Llanowar Elves");
  const delver = gameCard("Delver of Secrets // Insectile Aberration", { power: 1, toughness: 1 });
  const ragavan = gameCard("Ragavan, Nimble Pilferer", { power: 2, toughness: 1 });
  const reckoner = gameCard("Boros Reckoner", { power: 3, toughness: 3, tapped: true });
  const jace = gameCard("Jace, the Mind Sculptor", {
    lane: "other",
    counters: [{ kind: "loyalty", count: 3 }],
  });
  const view: PlaytestView = {
    stage: "main",
    turn: 5,
    active: "you",
    step: "main1",
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
      mana: manaTable([0, 1, 0, 0, 2, 2]),
    }),
    opponent: seat({
      life: 14,
      handCount: 5,
      battlefield: [
        ragavan,
        reckoner,
        gameCard("Smuggler's Copter"),
        jace,
        mountain({ tapped: true }),
        mountain(),
        gameCard("Ancient Tomb"),
      ],
      graveyard: [gameCard("Lightning Bolt"), gameCard("Boros Charm")],
      exile: [gameCard("Bonecrusher Giant // Stomp")],
      library: 47,
      manaOpen: 3,
      mana: manaTable([0, 0, 0, 1, 0, 2]),
    }),
    combat: null,
    attack: null,
    block: null,
    prompt: null,
    stack: [],
    winner: null,
    tokens: [],
    stops: [],
    endingTurn: false,
  };
  return { view, goyf, elves, delver, ragavan, reckoner, jace };
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
      attack: {
        attackers: [
          { id: t.goyf.id, player: true, targets: [t.jace.id] },
          { id: t.elves.id, player: true, targets: [] },
          { id: t.delver.id, player: true, targets: [] },
        ],
        targets: [{ id: t.jace.id, name: t.jace.name, cardId: t.jace.cardId }],
      },
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
      combat: { attacks: [{ attacker: ragavan.id, target: null }], blocks: [] },
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
        pick: null,
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
        pick: null,
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

/**
 * Combat on the reader's turn 5 after blocks: Tarmogoyf at the opponent, Delver at Jace, and the
 * opponent's Ragavan blocking Delver — the arrows' story.
 */
export function combatArrowsView(): TurnFive {
  const t = turnFive();
  const tapped = (c: GameCard) => ({ ...c, tapped: true });
  return {
    ...t,
    view: {
      ...t.view,
      stage: "respond",
      phase: "combat",
      step: "blockers",
      you: {
        ...t.view.you,
        battlefield: t.view.you.battlefield.map((c) =>
          c.id === t.goyf.id || c.id === t.delver.id ? tapped(c) : c,
        ),
      },
      combat: {
        attacks: [
          { attacker: t.goyf.id, target: null },
          { attacker: t.delver.id, target: t.jace.id },
        ],
        blocks: [{ blocker: t.ragavan.id, attacker: t.delver.id }],
      },
    },
  };
}

/** The opponent's Lightning Bolt on top of the stack, and the reader holding priority. */
export function respondStep(): TurnFive {
  const t = withStack();
  return {
    ...t,
    view: {
      ...t.view,
      stage: "respond",
      turn: 6,
      active: "opponent",
      phase: "beginning",
      step: "upkeep",
      stack: t.view.stack.filter((s) => s.seat === "opponent"),
      stops: [{ seat: "opponent", step: "upkeep" }],
    },
  };
}

/** The facts of a combat-damage step, for the pops: Goyf hit for 3, Ragavan hit, life lost. */
export function damageHappened(t: TurnFive): PlaytestHappened[] {
  return [
    {
      type: "dealt",
      source: t.reckoner.name,
      target: t.goyf.name,
      targetId: t.goyf.id,
      seat: "you",
      amount: 3,
    },
    {
      type: "dealt",
      source: t.goyf.name,
      target: t.ragavan.name,
      targetId: t.ragavan.id,
      seat: "opponent",
      amount: 4,
    },
    { type: "life", seat: "opponent", amount: -3, total: 11 },
    { type: "life", seat: "you", amount: 2, total: 19 },
  ];
}

/** A prompt answered by a set of cards. */
function pickPrompt(t: TurnFive, kind: string, source: string, pick: PlaytestPick): TurnFive {
  return {
    ...t,
    view: {
      ...t.view,
      stage: "prompt",
      prompt: { kind, source, options: [], cancellable: false, pick },
    },
  };
}

/** Scry 3: the top three of the reader's library, any of them kept on top, in order. */
export function scryPick(): TurnFive {
  const t = turnFive();
  const cards = t.view.you.libraryCards
    .slice(0, 3)
    .map((c) => ({ id: c.id, name: c.name, cardId: c.cardId }));
  return pickPrompt(t, "ScryChoice", "Opt", {
    purpose: "scry",
    cards,
    eligible: cards.map((c) => c.id),
    min: 0,
    max: 3,
    ordered: true,
  });
}

/** Discard exactly two of the hand; the land cannot be picked (a "discard a nonland card"). */
export function discardPick(): TurnFive {
  const t = turnFive();
  const cards = t.view.you.hand.map((c) => ({ id: c.id, name: c.name, cardId: c.cardId }));
  return pickPrompt(t, "DiscardChoice", "Thoughtseize", {
    purpose: "discard",
    cards,
    eligible: t.view.you.hand.filter((c) => !c.isLand).map((c) => c.id),
    min: 2,
    max: 2,
    ordered: false,
  });
}

/**
 * The opponent's whole turn 6 as a step with frames, the way the engine answers an `endTurn`:
 * they play a Mountain, cast Lightning Bolt at Tarmogoyf (which takes 3), attack with Ragavan for 2,
 * and the reader's turn 7 begins.
 */
export function replayStep(): { step: PlaytestStep; start: PlaytestView } {
  const t = turnFive();
  const start = t.view;
  const theirs = (v: PlaytestView, battlefield: GameCard[], over: Partial<PlaytestView> = {}) => ({
    ...v,
    stage: "watching" as const,
    active: "opponent" as const,
    turn: 6,
    opponent: { ...v.opponent, battlefield },
    ...over,
  });
  const played = mountain();
  const f1Bf = [...start.opponent.battlefield, played];
  const f1 = theirs(start, f1Bf, { phase: "main1" });
  const bolt = { id: 9001, name: "Lightning Bolt", cardId: gameCard("Lightning Bolt").cardId };
  const f2 = {
    ...theirs(start, f1Bf, { phase: "main1" }),
    stack: [{ ...bolt, seat: "opponent" as const, ability: false }],
  };
  const ragavan = { ...t.ragavan, tapped: true };
  const f3Bf = f1Bf.map((c) => (c.id === ragavan.id ? ragavan : c));
  const f3 = theirs(start, f3Bf, {
    phase: "combat",
    combat: { attacks: [{ attacker: ragavan.id, target: null }], blocks: [] },
  });
  const f4 = theirs(start, f3Bf, {
    phase: "combat",
    combat: { attacks: [{ attacker: ragavan.id, target: null }], blocks: [] },
    you: { ...start.you, life: start.you.life - 2 },
  });
  const h1: PlaytestHappened[] = [
    { type: "turnBegan", turn: 6, seat: "opponent" },
    { type: "drew", seat: "opponent", name: null },
    { type: "played", seat: "opponent", name: "Mountain" },
  ];
  const h2: PlaytestHappened[] = [{ type: "cast", seat: "opponent", name: "Lightning Bolt" }];
  const h3: PlaytestHappened[] = [
    {
      type: "dealt",
      source: "Lightning Bolt",
      target: t.goyf.name,
      targetId: t.goyf.id,
      seat: "you",
      amount: 3,
    },
    { type: "attacked", seat: "opponent", names: [ragavan.name] },
  ];
  const h4: PlaytestHappened[] = [
    { type: "life", seat: "you", amount: -2, total: start.you.life - 2 },
  ];
  const after: PlaytestHappened[] = [
    { type: "turnBegan", turn: 7, seat: "you" },
    { type: "drew", seat: "you", name: "Island" },
  ];
  const final: PlaytestView = {
    ...start,
    turn: 7,
    you: { ...start.you, life: start.you.life - 2 },
    opponent: { ...start.opponent, battlefield: f3Bf.map((c) => ({ ...c, tapped: false })) },
  };
  return {
    start,
    step: {
      view: final,
      happened: [...h1, ...h2, ...h3, ...h4, ...after],
      frames: [
        { view: f1, happened: h1 },
        { view: f2, happened: h2 },
        { view: f3, happened: h3 },
        { view: f4, happened: h4 },
      ],
    },
  };
}
