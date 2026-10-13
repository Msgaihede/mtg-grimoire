/**
 * The playtest board: one game of a deck against another, the opponent played by phase.rs's AI
 * (`phase-ai`), over the same rules engine as the goldfish board (`crates/grimoire-play`, linked
 * by the desktop host alone).
 *
 * **A domain of `../ipc.ts`** like the others, and read through `@/lib/ipc` only. The shapes are
 * `grimoire-play`'s `playtest/view.rs`, held field for field by `ipc.test.ts`. A card, its lane,
 * its counters, a place and a seat are the goldfish's own types, so the goldfish's table pieces
 * draw this board's cards too. **The engine supplies facts, the page writes the sentences**:
 * `PlaytestHappened` is which card went where and whose doing it was, and
 * `features/playtesting/play/log.ts` turns it into "The opponent cast Lightning Bolt".
 *
 * **What the reader may not see is not sent**: the opponent's hand and library are counts.
 *
 * **A web or phone host refuses all three** — they are on the desktop's `DESKTOP_ONLY` list, and
 * the light app draws no Playtesting.
 */
import type { GameCard, GoldfishPlace, GoldfishSeat, MulliganView, TokenOffer } from "./goldfish";
import { invoke } from "./invoke";

/** What the game waits on the reader for — the board's mode. */
export type PlaytestStage = "mulligan" | "main" | "attack" | "block" | "prompt" | "over";

/** Where the turn is, coarse. */
export type PlaytestPhase = "beginning" | "main1" | "combat" | "main2" | "ending";

/** What the AI opponent plays like: phase's presets, random to strong. */
export type PlaytestDifficulty = "veryEasy" | "easy" | "medium" | "hard" | "veryHard";

/** The whole table after an action, from the reader's seat. */
export interface PlaytestView {
  stage: PlaytestStage;
  /** Both seats' turns counted, from 1; 0 during the opening hands. */
  turn: number;
  active: GoldfishSeat;
  /** Who played first (the seed's coin flip). */
  started: GoldfishSeat;
  phase: PlaytestPhase;
  mulligan: MulliganView | null;
  you: PlaytestSeat;
  /** `hand` and `libraryCards` are always empty: the counts are what the reader may know. */
  opponent: PlaytestSeat;
  combat: PlaytestCombat | null;
  /** In the `attack` stage: the reader's creatures that can attack. */
  attack: PlaytestAttack | null;
  /** In the `block` stage: the reader's creatures that can block, and what each can block. */
  block: PlaytestBlock | null;
  /** In the `prompt` stage: the engine's question. */
  prompt: PlaytestPrompt | null;
  /** Waiting to resolve, the top first. */
  stack: PlaytestStackItem[];
  /** In the `over` stage: who won, `null` for a draw. */
  winner: GoldfishSeat | null;
  /** The tokens the reader's deck makes. */
  tokens: TokenOffer[];
}

export interface PlaytestSeat {
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
}

export interface PlaytestCombat {
  /** The attacking creatures' ids, whichever seat attacks. */
  attackers: number[];
  blocks: PlaytestBlockPair[];
}

export interface PlaytestBlockPair {
  blocker: number;
  attacker: number;
}

export interface PlaytestAttack {
  attackers: number[];
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
}

export interface PlaytestOption {
  /** What `choose` sends back. */
  index: number;
  /** phase's name for the answer: `ChooseTarget`, `SelectCards`, `CastSpell`… */
  kind: string;
  cards: PlaytestCardRef[];
  players: GoldfishSeat[];
  number: number | null;
  yes: boolean | null;
  /** A named choice's own word, as the card prints it. */
  label: string | null;
}

export interface PlaytestCardRef {
  id: number;
  name: string;
  cardId: string | null;
}

export interface PlaytestStackItem {
  id: number;
  name: string;
  cardId: string | null;
  seat: GoldfishSeat;
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
  | { type: "attack"; attackers: number[] }
  | { type: "block"; blocks: PlaytestBlockPair[] }
  | { type: "choose"; index: number }
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
  | { type: "setLife"; seat: GoldfishSeat; life: number };

/** What happened, one fact a row; `seat` is whose card or doing it was. */
export type PlaytestHappened =
  | { type: "mulliganed"; mulligans: number }
  | { type: "kept"; size: number; bottomed: number }
  | { type: "turnBegan"; turn: number; seat: GoldfishSeat }
  | { type: "played"; seat: GoldfishSeat; name: string }
  | { type: "cast"; seat: GoldfishSeat; name: string }
  | { type: "activated"; seat: GoldfishSeat; name: string }
  | { type: "moved"; seat: GoldfishSeat; name: string; from: GoldfishPlace; to: GoldfishPlace }
  | { type: "drew"; seat: GoldfishSeat; name: string | null }
  | { type: "attacked"; seat: GoldfishSeat; names: string[] }
  | { type: "blocked"; seat: GoldfishSeat; blocker: string; attacker: string }
  | { type: "dealt"; source: string; target: string; amount: number }
  | { type: "life"; seat: GoldfishSeat; amount: number }
  | { type: "tokensCreated"; seat: GoldfishSeat; name: string; count: number }
  | { type: "put"; name: string; from: GoldfishPlace; to: GoldfishPlace }
  | { type: "tapped"; name: string; count: number; tapped: boolean }
  | { type: "untappedAll" }
  | { type: "counters"; name: string; kind: string; count: number }
  | { type: "shuffled" }
  | { type: "lifeSet"; seat: GoldfishSeat; life: number; was: number }
  | { type: "chose"; what: string }
  | { type: "gameOver"; winner: GoldfishSeat | null };

export interface PlaytestStep {
  view: PlaytestView;
  happened: PlaytestHappened[];
}

/** The playtest commands — spread into `ipc` by `../ipc.ts`. */
export const playtestCommands = {
  /**
   * A new game: the reader's deck as it stands in `variant` against `opponentDeckId`'s, the
   * opponent played by the AI at `difficulty`. Answers at the reader's opening hand (or the first
   * thing the reader decides). `seed` is the shuffle and the coin flip.
   */
  playtestStart: (
    deckId: number,
    variant: string,
    opponentDeckId: number,
    opponentVariant: string,
    difficulty: PlaytestDifficulty,
    seed: number,
  ) =>
    invoke<PlaytestStep>("playtest_start", {
      deckId,
      variant,
      opponentDeckId,
      opponentVariant,
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
};
