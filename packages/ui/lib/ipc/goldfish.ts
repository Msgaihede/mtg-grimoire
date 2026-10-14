/**
 * The goldfish board: one game of a deck against a target that does nothing, over phase.rs's rules
 * engine (`crates/grimoire-play`, linked by the desktop host alone).
 *
 * **A domain of `../ipc.ts`** like the others, and read through `@/lib/ipc` only. The shapes are
 * `grimoire-play`'s `view.rs`, held field for field by `ipc.test.ts`. **The engine supplies facts,
 * the page writes the sentences**: `Happened` is which card went where and how, and
 * `features/playtesting/goldfish/log.ts` turns it into "Cast Sol Ring".
 *
 * **A web or phone host refuses all three** — they are on the desktop's `DESKTOP_ONLY` list, and
 * the light app draws no Playtesting — so the page that calls them is reached from the desktop's
 * deck editor only.
 */
import { invoke } from "./invoke";

/**
 * Whose decision the game is waiting on: the opening hand, the reader's main phase, or — a turn
 * passed with too many cards in hand — the cleanup step's discard, which only `discard` answers.
 */
export type GoldfishStage = "mulligan" | "playing" | "discard";

/** Where a permanent sits: creatures toward the opponent; lands left and the rest right behind. */
export type GoldfishLane = "creature" | "land" | "other";

/** Where a card can be put. The library is two places, its top and its bottom. */
export type GoldfishPlace =
  "hand" | "battlefield" | "graveyard" | "exile" | "command" | "libraryTop" | "libraryBottom";

export type GoldfishSeat = "you" | "opponent";

/** The whole board after an action. */
export interface GoldfishView {
  stage: GoldfishStage;
  /** The reader's own turns, from 1; 0 while the opening hand is decided. */
  turn: number;
  mulligan: MulliganView | null;
  /** How many cards the reader has to discard before the turn ends; 0 unless `stage` is `discard`. */
  discard: number;
  life: number;
  opponentLife: number;
  hand: GameCard[];
  battlefield: GameCard[];
  /** Oldest first: the last is the top. */
  graveyard: GameCard[];
  exile: GameCard[];
  /** The reader's commanders while they are in the command zone. */
  command: GameCard[];
  /** How many cards the library holds. */
  library: number;
  /**
   * The library, **top first**. Face down on the table: drawn only when the reader asks to look
   * (scry, surveil, look at the top, search).
   */
  libraryCards: GameCard[];
  libraryLands: number;
  /** What the untapped permanents could make now (a summoning-sick creature makes none). */
  manaOpen: number;
  /** The same open mana by type, and what is floating in the pool — the board's mana table. */
  mana: ManaTable;
  /** The tokens this deck's cards make, for "Create a token". */
  tokens: TokenOffer[];
}

/** A seat's mana by type (issue #1002). Shared by the goldfish and the playtest board. */
export interface ManaTable {
  /**
   * The most of each type the untapped permanents could make now. Every source that can make a
   * type counts toward it, so a dual land is in two rows and the rows sum to more than `manaOpen`.
   */
  open: ManaByType;
  /** The mana already in the pool, made and not yet spent. */
  floating: ManaByType;
}

/** One count per type of mana: WUBRG, then colorless. */
export interface ManaByType {
  white: number;
  blue: number;
  black: number;
  red: number;
  green: number;
  colorless: number;
}

export interface MulliganView {
  mulligans: number;
  /** How many cards keeping this hand puts on the bottom. */
  bottom: number;
  freeFirst: boolean;
}

export interface GameCard {
  /**
   * The engine's object id. **A new one whenever the card changes zone** (CR 400.7), so hold it
   * only as long as the view it came from.
   */
  id: number;
  /** The printing to draw it by; `null` for a token the engine has no picture for. */
  cardId: string | null;
  name: string;
  typeLine: string;
  lane: GoldfishLane;
  manaValue: number;
  isLand: boolean;
  isToken: boolean;
  isCommander: boolean;
  tapped: boolean;
  counters: CardCounter[];
  power: number | null;
  toughness: number | null;
  /** Commander tax in generic mana; 0 for anything else. */
  tax: number;
}

export interface CardCounter {
  /** As a reader names it: `+1/+1`, `loyalty`, `charge`. */
  kind: string;
  count: number;
}

export interface TokenOffer {
  /** phase's preset id, which `createToken` takes back. */
  preset: string;
  name: string;
  /** The deck's card that makes it, or empty for a token the reader added to the deck by hand. */
  source: string;
  /** The printing the reader set for the token in the deck, or else phase's preset's. */
  cardId: string | null;
}

/** Everything the board can ask of a game. `id` is a {@link GameCard.id} from the current view. */
export type GoldfishAction =
  | { type: "mulligan" }
  | { type: "keep"; bottom: number[] }
  | { type: "play"; id: number }
  | { type: "move"; id: number; to: GoldfishPlace }
  | { type: "tap"; ids: number[]; tapped: boolean }
  | { type: "untapAll" }
  | { type: "counters"; id: number; kind: string; delta: number }
  | { type: "tokenCopy"; id: number }
  | { type: "createToken"; preset: string; count: number }
  | { type: "draw"; count: number }
  | { type: "mill"; count: number }
  | { type: "shuffle" }
  | { type: "setLife"; seat: GoldfishSeat; life: number }
  | { type: "nextTurn" }
  | { type: "discard"; ids: number[] };

/** What an action did, one fact a row. */
export type Happened =
  | { type: "mulliganed"; mulligans: number }
  | { type: "kept"; size: number; bottomed: number }
  | { type: "played"; name: string }
  | { type: "cast"; name: string; from: GoldfishPlace }
  | { type: "put"; name: string; from: GoldfishPlace; to: GoldfishPlace }
  | { type: "moved"; name: string; from: GoldfishPlace; to: GoldfishPlace }
  | { type: "tapped"; name: string; count: number; tapped: boolean }
  | { type: "untappedAll" }
  | { type: "counters"; name: string; kind: string; count: number }
  | { type: "tokensCreated"; name: string; count: number }
  | { type: "shuffled" }
  | { type: "lifeSet"; seat: GoldfishSeat; life: number; was: number }
  | { type: "turnBegan"; turn: number }
  | { type: "life"; seat: GoldfishSeat; amount: number; total: number }
  | { type: "opponentTurn"; drew: number; discarded: number }
  | { type: "chose"; what: string };

export interface GoldfishStep {
  view: GoldfishView;
  happened: Happened[];
}

/** The goldfish commands — spread into `ipc` by `../ipc.ts`. */
export const goldfishCommands = {
  /**
   * A new game of the deck as it stands in `variant`, opening hand drawn. `seed` shuffles it — a
   * page sends a fresh one per game; the same seed and deck deal the same game.
   */
  goldfishStart: (deckId: number, variant: string, seed: number) =>
    invoke<GoldfishView>("goldfish_start", { deckId, variant, seed }),
  /** One action. Rejects with one sentence and leaves the game as it was. */
  goldfishAct: (action: GoldfishAction) => invoke<GoldfishStep>("goldfish_act", { action }),
  /** Put the game away. Never rejects in a way worth showing. */
  goldfishEnd: () => invoke<void>("goldfish_end"),
};
