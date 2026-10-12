/**
 * Goldfish views for stories and tests — the board drawn without the engine.
 *
 * **The engine is Rust's and the fake has none** (`packages/fake/parity.test.ts`' `ABSENT` says so),
 * so a story hands `GoldfishBoard` a view built here, from the fake's own card rows (real printings,
 * real pictures in Storybook's `live` and `bundled` modes), and {@link playLocally} answers the
 * few actions a story clicks through the way the engine would in outline — a move is a move, a tap
 * is a tap — so a reader driving a story sees the board respond. It is not the rules: a
 * cast here is a placement, and that is the difference the stories never claim otherwise.
 */
import { CARDS } from "@grimoire/fake/cards";
import type {
  GameCard,
  GoldfishAction,
  GoldfishLane,
  GoldfishPlace,
  GoldfishView,
} from "@/lib/ipc";

let nextId = 1000;

/** One card of the fake's by name, as the engine would answer it. */
export function gameCard(name: string, over: Partial<GameCard> = {}): GameCard {
  const row = CARDS.find((c) => c.name === name);
  const typeLine = row?.typeLine ?? "Token";
  const isLand = /\bLand\b/.test(typeLine);
  const isCreature = /\bCreature\b/.test(typeLine);
  const lane: GoldfishLane = isCreature ? "creature" : isLand ? "land" : "other";
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
    power: isCreature ? num(row?.power) : null,
    toughness: isCreature ? num(row?.toughness) : null,
    tax: 0,
    ...over,
  };
}

function many(n: number, name: string, over: Partial<GameCard> = {}): GameCard[] {
  return Array.from({ length: n }, () => gameCard(name, over));
}

const COMMANDER = "Kenrith, the Returned King";

function library(n: number): GameCard[] {
  const names = ["Forest", "Island", "Sol Ring", "Counterspell", "Rhystic Study", "Tarmogoyf"];
  return Array.from({ length: n }, (_, i) => gameCard(names[i % names.length]));
}

/** The opening hand, two mulligans in with the first one free: one card to put on the bottom. */
export function openingHandView(): GoldfishView {
  return {
    stage: "mulligan",
    turn: 0,
    mulligan: { mulligans: 2, bottom: 1, freeFirst: true },
    life: 40,
    opponentLife: 40,
    hand: [
      gameCard("Forest"),
      gameCard("Sol Ring"),
      gameCard("Llanowar Elves"),
      gameCard("Ancient Tomb"),
      gameCard("Swords to Plowshares"),
      gameCard("Consecrated Sphinx"),
      gameCard("Island"),
    ],
    battlefield: [],
    graveyard: [],
    exile: [],
    command: [gameCard(COMMANDER, { isCommander: true })],
    library: 92,
    libraryLands: 37,
    libraryCards: library(92),
    manaOpen: 0,
    tokens: [],
  };
}

/** The table at turn 9: a busy board, tapped lands and creatures, a counter, five Treasures. */
export function turnNineView({ extraLands = 0 }: { extraLands?: number } = {}): GoldfishView {
  return {
    stage: "playing",
    turn: 9,
    mulligan: null,
    life: 37,
    opponentLife: 12,
    hand: [
      gameCard("Swords to Plowshares"),
      gameCard("Forest"),
      gameCard("Island"),
      gameCard("Forest"),
    ],
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
    exile: [],
    command: [],
    library: 76,
    libraryLands: 22,
    libraryCards: library(76),
    manaOpen: 16,
    tokens: [
      {
        preset: "treasure",
        name: "Treasure",
        source: "Smuggler's Copter",
        cardId: CARDS.find((c) => c.name === "Treasure")?.id ?? null,
      },
    ],
  };
}

const ZONE_OF: Record<GoldfishPlace, keyof GoldfishView | null> = {
  hand: "hand",
  battlefield: "battlefield",
  graveyard: "graveyard",
  exile: "exile",
  command: "command",
  libraryTop: "libraryCards",
  libraryBottom: "libraryCards",
};

type Zone = "hand" | "battlefield" | "graveyard" | "exile" | "command" | "libraryCards";
const ZONES: Zone[] = ["hand", "battlefield", "graveyard", "exile", "command", "libraryCards"];

/**
 * What a story's board does with an action — the engine's answer in outline, for clicking
 * through a story. Moves, taps, draws, life and the next turn; a play is a placement; anything
 * else is ignored. Never used outside stories and tests.
 */
export function playLocally(view: GoldfishView, action: GoldfishAction): GoldfishView {
  const v: GoldfishView = {
    ...view,
    hand: [...view.hand],
    battlefield: [...view.battlefield],
    graveyard: [...view.graveyard],
    exile: [...view.exile],
    command: [...view.command],
    libraryCards: [...view.libraryCards],
  };
  const take = (id: number): GameCard | null => {
    for (const z of ZONES) {
      const list = v[z];
      const at = list.findIndex((c) => c.id === id);
      if (at >= 0) return list.splice(at, 1)[0];
    }
    return null;
  };
  const put = (card: GameCard, to: GoldfishPlace) => {
    const fresh = {
      ...card,
      id: nextId++,
      tapped: false,
      counters: to === "battlefield" ? card.counters : [],
    };
    const zone = ZONE_OF[to] as Zone;
    if (to === "libraryTop") v.libraryCards.unshift(fresh);
    else v[zone].push(fresh);
  };
  switch (action.type) {
    case "keep":
      for (const id of action.bottom) {
        const c = take(id);
        if (c) put(c, "libraryBottom");
      }
      return { ...v, stage: "playing", mulligan: null, turn: 1, library: v.libraryCards.length };
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
      for (let i = 0; i < action.count; i++) {
        const top = v.libraryCards.shift();
        if (top) v.hand.push(top);
      }
      break;
    case "setLife":
      return action.seat === "you"
        ? { ...v, life: action.life }
        : { ...v, opponentLife: action.life };
    case "nextTurn": {
      v.battlefield = v.battlefield.map((c) => ({ ...c, tapped: false }));
      const top = v.libraryCards.shift();
      if (top) v.hand.push(top);
      return { ...v, turn: v.turn + 1, library: v.libraryCards.length };
    }
    default:
      break;
  }
  return { ...v, library: v.libraryCards.length };
}
