/**
 * The game table's shared pieces: a card, its lane and counters, a place a card can be put, a
 * seat, the opening hand's mulligan, a token on offer and a seat's mana — what every board on
 * phase.rs's rules engine (`crates/grimoire-play`, linked by the desktop host alone) draws a
 * table from. The game itself, its actions and its facts, is `./playtest.ts`.
 *
 * **A domain of `../ipc.ts`** like the others, and read through `@/lib/ipc` only. The shapes are
 * `grimoire-play`'s `view.rs`, held field for field by `ipc.test.ts`. It has no commands of its
 * own: a game is played through `playtestStart`, `playtestAct` and `playtestEnd`, the goldfish
 * included.
 */

/** Where a permanent sits: creatures toward the opponent; lands left and the rest right behind. */
export type GameLane = "creature" | "land" | "other";

/** Where a card can be put. The library is two places, its top and its bottom. */
export type GamePlace =
  "hand" | "battlefield" | "graveyard" | "exile" | "command" | "libraryTop" | "libraryBottom";

/** A side of the table: the reader's, or the opponents' (a stop's side). */
export type GameSeat = "you" | "opponent";

/** A seat's mana by type (issue #1002). Every seat's, the reader's and each opponent's. */
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
  lane: GameLane;
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
  /** In exile and foretold (CR 702.143): cast later, for its foretell cost, by a `play`. */
  foretold: boolean;
  /** The rules let the reader foretell this hand card now (their turn, {2} to pay). */
  canForetell: boolean;
  /** The rules let the reader cast or play this graveyard or exile card now (foretold,
   *  flashback). */
  castable: boolean;
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
