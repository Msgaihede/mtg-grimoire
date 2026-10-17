/**
 * The playtest board: one game of a deck against one other, or against three in a four-player
 * game (issue #994), each opponent played by phase.rs's AI (`phase-ai`), over the same rules engine as the goldfish board (`crates/grimoire-play`, linked
 * by the desktop host alone).
 *
 * **A domain of `../ipc.ts`** like the others, and read through `@/lib/ipc` only. The shapes are
 * `grimoire-play`'s `playtest/view.rs`, held field for field by `ipc.test.ts`. A card, its lane,
 * its counters and a place are the goldfish's own types, so the goldfish's table pieces draw this
 * board's cards too. A player is a {@link PlaytestPlayer}: a duel's two are spelled as the
 * goldfish's seats, and a four-player game adds `opponent2` and `opponent3`. **The engine supplies facts, the page writes the sentences**:
 * `PlaytestHappened` is which card went where and whose doing it was, and
 * `features/playtesting/play/log.ts` turns it into "The opponent cast Lightning Bolt".
 *
 * **What the reader may not see is not sent**: an opponent's hand and library are counts.
 *
 * **A web or phone host refuses all four** — they are on the desktop's `DESKTOP_ONLY` list, and
 * the light app draws no Playtesting.
 */
import type {
  GameCard,
  GoldfishPlace,
  GoldfishSeat,
  ManaTable,
  MulliganView,
  TokenOffer,
} from "./goldfish";
import { invoke } from "./invoke";

/**
 * What the game waits on the reader for — the board's mode. `respond` is priority with something
 * to answer (the opponent's spell, combat after blocks, a step the reader asked to stop at);
 * `watching` appears only in a replay frame, while the game moves on by itself.
 */
export type PlaytestStage =
  "mulligan" | "main" | "attack" | "block" | "respond" | "prompt" | "watching" | "over";

/** Where the turn is, coarse. */
export type PlaytestPhase = "beginning" | "main1" | "combat" | "main2" | "ending";

/** What picking a card does: kept on top (scry, surveil), discarded, found, kept, revealed… */
export type PlaytestPickPurpose =
  "scry" | "surveil" | "discard" | "search" | "dig" | "reveal" | "targets" | "choose";

/** A step the reader can ask the game to stop at. */
export type PlaytestStopStep =
  | "upkeep"
  | "draw"
  | "main1"
  | "beginCombat"
  | "attackers"
  | "blockers"
  | "damage"
  | "main2"
  | "end";

/**
 * A player at the table, from the reader's seat: the reader, or an opponent in turn order after
 * them. A duel has `you` and `opponent`; a four-player game `opponent2` and `opponent3` too.
 */
export type PlaytestPlayer = "you" | "opponent" | "opponent2" | "opponent3";

/** What the AI opponent plays like: phase's presets, random to strong. */
export type PlaytestDifficulty = "veryEasy" | "easy" | "medium" | "hard" | "veryHard";

/** The whole table after an action, from the reader's seat. */
export interface PlaytestView {
  stage: PlaytestStage;
  /** Both seats' turns counted, from 1; 0 during the opening hands. */
  turn: number;
  active: PlaytestPlayer;
  /** Who played first (the seed's coin flip). */
  started: PlaytestPlayer;
  phase: PlaytestPhase;
  /** The step within `phase` where a player gets priority; `null` in untap, end of combat, cleanup. */
  step: PlaytestStopStep | null;
  mulligan: MulliganView | null;
  you: PlaytestSeat;
  /**
   * Each opponent's side, in turn order after the reader: one in a duel, three in a four-player
   * game. `hand` and `libraryCards` are always empty: the counts are what the reader may know.
   */
  opponents: PlaytestSeat[];
  combat: PlaytestCombat | null;
  /** In the `attack` stage: the reader's creatures that can attack. */
  attack: PlaytestAttack | null;
  /** In the `block` stage: the reader's creatures that can block, and what each can block. */
  block: PlaytestBlock | null;
  /** In the `prompt` stage: the engine's question. */
  prompt: PlaytestPrompt | null;
  /** Waiting to resolve, the top first. */
  stack: PlaytestStackItem[];
  /**
   * In the `over` stage: who won, `null` for a draw — or for a reader who is out (`you.out`) of a
   * game the others play on, which the reader has lost.
   */
  winner: PlaytestPlayer | null;
  /** The tokens the reader's deck makes. */
  tokens: TokenOffer[];
  /** The steps the reader asked to stop at, as `setStops` set them. */
  stops: PlaytestStop[];
  /** The reader is ending the turn: until it changes, only a block or a question stops it. */
  endingTurn: boolean;
  /** The reader's last action can be taken back (`undo`), with all the opponent did after it.
   *  Never in a replay frame. */
  canUndo: boolean;
  /** An undone action can be taken again (`redo`). Never in a replay frame. */
  canRedo: boolean;
}

/** A step to stop at, on whose turn: the reader's, or any opponent's. */
export interface PlaytestStop {
  seat: GoldfishSeat;
  step: PlaytestStopStep;
}

export interface PlaytestSeat {
  player: PlaytestPlayer;
  /** This player has lost and left the game, which the others play on without them. */
  out: boolean;
  life: number;
  poison: number;
  /** The reader's hand; empty for the opponent. */
  hand: GameCard[];
  handCount: number;
  battlefield: GameCard[];
  /** Oldest first: the last is the top. */
  graveyard: GameCard[];
  exile: GameCard[];
  command: GameCard[];
  library: number;
  /** The reader's library, top first; empty for the opponent. */
  libraryCards: GameCard[];
  manaOpen: number;
  /** The same open mana by type, and what is floating in the pool. */
  mana: ManaTable;
}

export interface PlaytestCombat {
  /** Every attacker, whichever seat attacks, and what it attacks. */
  attacks: PlaytestAttackPair[];
  blocks: PlaytestBlockPair[];
}

/**
 * An attacker and what it attacks: a planeswalker's or battle's id, or `null` for a player —
 * `player`, the one attacked. From the reader, a `null` player is the first opponent it can attack.
 */
export interface PlaytestAttackPair {
  attacker: number;
  target: number | null;
  player: PlaytestPlayer | null;
}

export interface PlaytestBlockPair {
  blocker: number;
  attacker: number;
}

export interface PlaytestAttack {
  /** The reader's creatures that can attack, and what each can attack. */
  attackers: PlaytestAttacker[];
  /** The planeswalkers and battles any of them can attack, to name them. */
  targets: PlaytestCardRef[];
}

export interface PlaytestAttacker {
  id: number;
  /** The players it can attack. */
  players: PlaytestPlayer[];
  /** The planeswalkers and battles it can attack. */
  targets: number[];
}

export interface PlaytestBlock {
  blockers: PlaytestBlocker[];
}

export interface PlaytestBlocker {
  id: number;
  /** The attackers this creature can block. */
  attackers: number[];
}

/**
 * The engine's question, as the answers it accepts. `kind` is phase's name for it
 * (`TargetSelection`, `ModeChoice`…, or the board's own `CastChoice` / `AbilityChoice`); each
 * option is named by its facts. `auto` answers any of them.
 */
export interface PlaytestPrompt {
  kind: string;
  /** The card the question is about, when there is one. */
  source: string | null;
  options: PlaytestOption[];
  /** It came out of the reader's own cast or activation, which `cancel` takes back. */
  cancellable: boolean;
  /** The answer is a set of cards (scry, surveil, a discard, a search): `pickCards` answers. */
  pick: PlaytestPick | null;
}

export interface PlaytestPick {
  purpose: PlaytestPickPurpose;
  /** The cards looked at, in order (a scry's top first). */
  cards: PlaytestCardRef[];
  /** The ids among them that may be picked. */
  eligible: number[];
  min: number;
  max: number;
  /** Order counts: for scry and surveil the picked cards stay on top, first picked on top. */
  ordered: boolean;
}

export interface PlaytestOption {
  /** What `choose` sends back. */
  index: number;
  /** phase's name for the answer: `ChooseTarget`, `SelectCards`, `CastSpell`… */
  kind: string;
  cards: PlaytestCardRef[];
  players: PlaytestPlayer[];
  number: number | null;
  yes: boolean | null;
  /** A named choice's own word, as the card prints it. */
  label: string | null;
}

export interface PlaytestCardRef {
  id: number;
  name: string;
  cardId: string | null;
  /** The ref stands for one of the card's abilities — a trigger to order, a replacement effect
   *  to choose: the ability's words, as the engine gives them. */
  text: string | null;
}

export interface PlaytestStackItem {
  id: number;
  name: string;
  cardId: string | null;
  seat: PlaytestPlayer;
  ability: boolean;
}

/** Everything the board can ask of a game. `id` is a {@link GameCard.id} from the current view. */
export type PlaytestAction =
  | { type: "mulligan" }
  | { type: "keep"; bottom: number[] }
  | { type: "play"; id: number }
  | { type: "activate"; id: number }
  | { type: "pass" }
  | { type: "endTurn" }
  | { type: "setStops"; stops: PlaytestStop[] }
  | { type: "attack"; attacks: PlaytestAttackPair[] }
  | { type: "block"; blocks: PlaytestBlockPair[] }
  | { type: "choose"; index: number }
  | { type: "pickCards"; ids: number[] }
  | { type: "auto" }
  | { type: "cancel" }
  | { type: "move"; id: number; to: GoldfishPlace }
  | { type: "tap"; ids: number[]; tapped: boolean }
  | { type: "untapAll" }
  | { type: "counters"; id: number; kind: string; delta: number }
  | { type: "tokenCopy"; id: number }
  | { type: "createToken"; preset: string; count: number }
  | { type: "draw"; count: number }
  | { type: "mill"; count: number }
  | { type: "shuffle" }
  | { type: "setLife"; seat: PlaytestPlayer; life: number }
  /** Back to the reader's last decision, exactly. Happens nothing and plays nothing back. */
  | { type: "undo" }
  /** The game as it was before the last undo. Happens nothing. */
  | { type: "redo" };

/** What happened, one fact a row; `seat` is whose card or doing it was. */
export type PlaytestHappened =
  | { type: "mulliganed"; mulligans: number }
  | { type: "kept"; size: number; bottomed: number }
  | { type: "turnBegan"; turn: number; seat: PlaytestPlayer }
  | { type: "played"; seat: PlaytestPlayer; name: string }
  | { type: "cast"; seat: PlaytestPlayer; name: string }
  | { type: "activated"; seat: PlaytestPlayer; name: string }
  | { type: "moved"; seat: PlaytestPlayer; name: string; from: GoldfishPlace; to: GoldfishPlace }
  | { type: "drew"; seat: PlaytestPlayer; name: string | null }
  | { type: "attacked"; seat: PlaytestPlayer; names: string[] }
  | { type: "blocked"; seat: PlaytestPlayer; blocker: string; attacker: string }
  | {
      type: "dealt";
      source: string;
      target: string;
      /** The permanent hit and whose it is, so the board finds the very card. */
      targetId: number;
      seat: PlaytestPlayer;
      amount: number;
    }
  | { type: "life"; seat: PlaytestPlayer; amount: number; total: number }
  | { type: "tokensCreated"; seat: PlaytestPlayer; name: string; count: number }
  | { type: "put"; name: string; from: GoldfishPlace; to: GoldfishPlace }
  | { type: "tapped"; name: string; count: number; tapped: boolean }
  | { type: "untappedAll" }
  | { type: "counters"; name: string; kind: string; count: number }
  | { type: "shuffled" }
  | { type: "lifeSet"; seat: PlaytestPlayer; life: number; was: number }
  | { type: "chose"; what: string }
  | { type: "eliminated"; seat: PlaytestPlayer }
  | { type: "gameOver"; winner: PlaytestPlayer | null };

export interface PlaytestStep {
  view: PlaytestView;
  /** Everything, in order — the frames' facts included. */
  happened: PlaytestHappened[];
  /**
   * The table after each thing worth showing on the way (an opponent's land, cast, attack or
   * block, a spell resolving, combat damage), oldest first, for the page to replay before it
   * settles on `view`. Every frame's stage is `watching`.
   */
  frames: PlaytestFrame[];
}

export interface PlaytestFrame {
  view: PlaytestView;
  happened: PlaytestHappened[];
}

/** An opponent's deck for `playtestStart`: a deck and its `live` or `theory` variant. */
export interface PlaytestOpponent {
  deckId: number;
  variant: string;
}

/**
 * What the rules engine plays of a deck (issue #1078): `grimoire-play`'s `support.rs`. Its
 * different cards (two printings of one are one), and those phase.rs's parser reads only in part.
 */
export interface DeckSupport {
  cards: number;
  unsupported: UnsupportedCard[];
}

/**
 * One card of a deck the engine plays only in part: dealt and played as a body with a cost and a
 * type, with what `gaps` names doing nothing. A gap is phase's own coverage label —
 * `Effect:…`, `Keyword:…`, `Trigger:…` — and the page words it (`features/playtesting/support.ts`).
 */
export interface UnsupportedCard {
  /** The first printing's Scryfall id, for its picture. */
  cardId: string;
  name: string;
  /** Copies in the deck, every printing together. */
  quantity: number;
  commander: boolean;
  gaps: string[];
}

/** The playtest commands — spread into `ipc` by `../ipc.ts`. */
export const playtestCommands = {
  /**
   * A new game: the reader's deck as it stands in `variant` against each of `opponents` (one for a
   * duel, three for a four-player game), each played by the AI at `difficulty`. Answers at the
   * reader's opening hand (or the first thing the reader decides). `seed` is the shuffle and the
   * coin flip.
   */
  playtestStart: (
    deckId: number,
    variant: string,
    opponents: PlaytestOpponent[],
    difficulty: PlaytestDifficulty,
    seed: number,
  ) =>
    invoke<PlaytestStep>("playtest_start", {
      deckId,
      variant,
      opponents,
      difficulty,
      seed,
    }),
  /**
   * One action, and everything the opponent does after it until the reader next decides.
   * Rejects with one sentence and leaves the game as it was.
   */
  playtestAct: (action: PlaytestAction) => invoke<PlaytestStep>("playtest_act", { action }),
  /** Put the game away. Never rejects in a way worth showing. */
  playtestEnd: () => invoke<void>("playtest_end"),
  /**
   * What the rules engine plays of `deckId` as it stands in `variant` (issue #1078). Each card is
   * parsed once per window, so asking about every deck costs each shared card once.
   */
  playtestSupport: (deckId: number, variant: string) =>
    invoke<DeckSupport>("playtest_support", { deckId, variant }),
};
