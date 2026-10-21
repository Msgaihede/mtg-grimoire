/**
 * The table's fixtures for stories and tests — the reader's seat drawn without the engine.
 *
 * **The engine is Rust's and the fake has none** (`packages/fake/parity.test.ts`' `ABSENT` says so),
 * so a story or a test hands the board (or one of its pieces) a seat built here, from the fake's
 * own card rows (real printings, real pictures in Storybook's `live` and `bundled` modes), and
 * {@link playLocally} answers the few sandbox actions a story or test clicks through the way the
 * engine would in outline — a move is a move, a tap is a tap — so a reader driving one sees the
 * table respond. It is not the rules: a cast here is a placement, and that is the difference the
 * fixtures never claim otherwise. Whole views, with the opponents and the stage, are
 * `../play/fixtures.ts`', built on these.
 */
import { CARDS } from "@grimoire/fake/cards";
import type {
  GameCard,
  GameLane,
  GamePlace,
  ManaByType,
  ManaTable,
  PlaytestAction,
  PlaytestPlayer,
  PlaytestSeat,
  TokenOffer,
} from "@/lib/ipc";
import type { OpeningHandView } from "./OpeningHand";

let nextId = 1000;

/** A mana table: `open` by type, WUBRG then colorless, and `floating` the same way (none). */
export function manaTable(open: number[] = [], floating: number[] = []): ManaTable {
  const by = ([
    white = 0,
    blue = 0,
    black = 0,
    red = 0,
    green = 0,
    colorless = 0,
  ]: number[]): ManaByType => ({ white, blue, black, red, green, colorless });
  return { open: by(open), floating: by(floating) };
}

/** One card of the fake's by name, as the engine would answer it. */
export function gameCard(name: string, over: Partial<GameCard> = {}): GameCard {
  const row = CARDS.find((c) => c.name === name);
  const typeLine = row?.typeLine ?? "Token";
  const isLand = /\bLand\b/.test(typeLine);
  const isCreature = /\bCreature\b/.test(typeLine);
  const lane: GameLane = isCreature ? "creature" : isLand ? "land" : "other";
  const num = (s: string | null | undefined) => (s == null || isNaN(Number(s)) ? null : Number(s));
  return {
    id: nextId++,
    cardId: row?.id ?? null,
    name,
    typeLine,
    lane,
    manaValue: Math.round(row?.cmc ?? 0),
    isLand,
    isToken: /\bToken\b/.test(typeLine),
    isCommander: false,
    tapped: false,
    counters: [],
    effects: [],
    power: isCreature ? num(row?.power) : null,
    toughness: isCreature ? num(row?.toughness) : null,
    tax: 0,
    attachedTo: null,
    foretold: false,
    canForetell: false,
    castable: false,
    gaps: [],
    ...over,
  };
}

export function many(n: number, name: string, over: Partial<GameCard> = {}): GameCard[] {
  return Array.from({ length: n }, () => gameCard(name, over));
}

/** The commander of the deck the table's fixtures play. */
export const COMMANDER = "Kenrith, the Returned King";

/** `n` library cards of six names in turn, top first. */
export function library(n: number): GameCard[] {
  const names = ["Forest", "Island", "Sol Ring", "Counterspell", "Rhystic Study", "Tarmogoyf"];
  return Array.from({ length: n }, (_, i) => gameCard(names[i % names.length]));
}

/** A seat with nothing in it — every field the engine sends, `over` laid on top. */
export function emptySeat(player: PlaytestPlayer, over: Partial<PlaytestSeat> = {}): PlaytestSeat {
  return {
    player,
    out: false,
    life: 40,
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
    deadOn: null,
    ...over,
  };
}

/** The reader's seven before the first turn, the commander waiting in the command zone. */
export function openingHandSeat(): PlaytestSeat {
  const hand = [
    gameCard("Forest"),
    gameCard("Sol Ring"),
    gameCard("Llanowar Elves"),
    gameCard("Ancient Tomb"),
    gameCard("Swords to Plowshares"),
    gameCard("Consecrated Sphinx"),
    gameCard("Island"),
  ];
  return emptySeat("you", {
    hand,
    handCount: hand.length,
    command: [gameCard(COMMANDER, { isCommander: true })],
    library: 92,
    libraryCards: library(92),
  });
}

/** The opening hand, two mulligans in with the first one free: one card to put on the bottom. */
export function openingHandView(): OpeningHandView {
  const seat = openingHandSeat();
  return {
    hand: seat.hand,
    library: seat.library,
    mulligan: { mulligans: 2, bottom: 1, freeFirst: true },
    libraryLands: 37,
  };
}

/** The reader's ninth turn: a busy table, tapped lands and creatures, a counter, five Treasures. */
export function turnNineSeat({ extraLands = 0 }: { extraLands?: number } = {}): PlaytestSeat {
  const hand = [
    gameCard("Swords to Plowshares"),
    gameCard("Forest"),
    gameCard("Island"),
    gameCard("Forest"),
  ];
  return emptySeat("you", {
    life: 37,
    hand,
    handCount: hand.length,
    battlefield: [
      gameCard(COMMANDER, { isCommander: true }),
      gameCard("Llanowar Elves", {
        counters: [{ kind: "+1/+1", count: 2 }],
        power: 3,
        toughness: 3,
      }),
      gameCard("Tarmogoyf", { tapped: true }),
      gameCard("Avacyn, Angel of Hope"),
      gameCard("Elesh Norn, Grand Cenobite", { tapped: true }),
      gameCard("Consecrated Sphinx"),
      gameCard("Sol Ring", { tapped: true }),
      gameCard("Smuggler's Copter"),
      gameCard("Rhystic Study"),
      ...many(5, "Treasure"),
      ...many(2, "Forest", { tapped: true }),
      ...many(2, "Forest"),
      ...many(3, "Island", { tapped: true }),
      ...many(2, "Island"),
      gameCard("Ancient Tomb", { tapped: true }),
      gameCard("Urza's Saga"),
      ...many(extraLands, "Forest"),
    ],
    graveyard: [gameCard("Counterspell"), gameCard("Swords to Plowshares")],
    library: 76,
    libraryCards: library(76),
    manaOpen: 16,
    // Five Treasures make any color; the Elves and two Forests green, two Islands blue, the Saga {C}.
    mana: manaTable([5, 7, 5, 5, 8, 1]),
  });
}

/** The tokens the turn-nine deck makes: Smuggler's Copter's Treasure. */
export function turnNineTokens(): TokenOffer[] {
  return [
    {
      preset: "treasure",
      name: "Treasure",
      source: "Smuggler's Copter",
      cardId: CARDS.find((c) => c.name === "Treasure")?.id ?? null,
    },
  ];
}

type Zone = "hand" | "battlefield" | "graveyard" | "exile" | "command" | "libraryCards";
const ZONES: Zone[] = ["hand", "battlefield", "graveyard", "exile", "command", "libraryCards"];

const ZONE_OF: Record<GamePlace, Zone> = {
  hand: "hand",
  battlefield: "battlefield",
  graveyard: "graveyard",
  exile: "exile",
  command: "command",
  libraryTop: "libraryCards",
  libraryBottom: "libraryCards",
};

/**
 * What a story's or test's seat does with a sandbox action — the engine's answer in outline, for
 * clicking through one. Moves, taps, untapping, draws and mills; a play is a placement (an
 * instant or sorcery straight to the graveyard); anything else is ignored. A new seat every time,
 * with a new id for each card that moved (CR 400.7), as the engine answers. Never used outside
 * stories and tests.
 */
export function playLocally(seat: PlaytestSeat, action: PlaytestAction): PlaytestSeat {
  const v: PlaytestSeat = {
    ...seat,
    hand: [...seat.hand],
    battlefield: [...seat.battlefield],
    graveyard: [...seat.graveyard],
    exile: [...seat.exile],
    command: [...seat.command],
    libraryCards: [...seat.libraryCards],
  };
  const take = (id: number): GameCard | null => {
    for (const z of ZONES) {
      const list = v[z];
      const at = list.findIndex((c) => c.id === id);
      if (at >= 0) return list.splice(at, 1)[0];
    }
    return null;
  };
  const put = (card: GameCard, to: GamePlace) => {
    const fresh = {
      ...card,
      id: nextId++,
      tapped: false,
      counters: to === "battlefield" ? card.counters : [],
    };
    if (to === "libraryTop") v.libraryCards.unshift(fresh);
    else v[ZONE_OF[to]].push(fresh);
  };
  switch (action.type) {
    case "play": {
      const c = take(action.id);
      if (c) put(c, /Instant|Sorcery/.test(c.typeLine) ? "graveyard" : "battlefield");
      break;
    }
    case "move": {
      const c = take(action.id);
      if (c && !(c.isToken && action.to !== "battlefield")) put(c, action.to);
      break;
    }
    case "tap":
      v.battlefield = v.battlefield.map((c) =>
        action.ids.includes(c.id) ? { ...c, tapped: action.tapped } : c,
      );
      break;
    case "untapAll":
      v.battlefield = v.battlefield.map((c) => ({ ...c, tapped: false }));
      break;
    case "draw":
    case "mill":
      for (let i = 0; i < action.count; i++) {
        const top = v.libraryCards.shift();
        if (top) (action.type === "draw" ? v.hand : v.graveyard).push(top);
      }
      break;
    default:
      break;
  }
  return { ...v, handCount: v.hand.length, library: v.libraryCards.length };
}
