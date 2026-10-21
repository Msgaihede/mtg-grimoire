import {
  ipc,
  ipcError,
  type DeckVariant,
  type PlaytestAction,
  type PlaytestDifficulty,
  type PlaytestHappened,
  type PlaytestStep,
  type PlaytestView,
} from "@/lib/ipc";
import { freshBook, redoLog, rememberLog, undoLog, writeLog, type LogBook } from "../undo";
import { playtestLines } from "./log";
import { framesOf, replayEntries, type ReplayEntry } from "./useReplay";

/** What a game is dealt from: the reader's deck in one of its lists, and each opponent's — none
 *  for the goldfish, one for a duel, three for a four-player game — and how well the AI plays. */
export interface PlaytestPicks {
  deckId: number;
  variant: DeckVariant;
  /**
   * In turn order after the reader: `ipc.playtestStart`'s `opponents`. **Empty is the goldfish**
   * — the deck editor's "Goldfish this deck", and the setup page's Goldfish table.
   */
  opponents: { deckId: number; variant: DeckVariant }[];
  /** How well the AI plays; {@link DEFAULT_DIFFICULTY} when left out, and unused by the goldfish,
   *  whose page has nothing to pick. */
  difficulty?: PlaytestDifficulty;
}

/** The setup page's own first pick, for a caller that has none to give. */
export const DEFAULT_DIFFICULTY: PlaytestDifficulty = "medium";

/**
 * **The picks by value, not by array**: a caller that builds the list afresh on every render
 * must not deal a new game on every render. The same decks in the same seats, at the same
 * difficulty, are the same string.
 */
export function picksKey(picks: PlaytestPicks): string {
  return JSON.stringify([
    picks.deckId,
    picks.variant,
    picks.opponents.map((o) => [o.deckId, o.variant]),
    picks.difficulty ?? DEFAULT_DIFFICULTY,
  ]);
}

const NONE: readonly PlaytestHappened[] = [];

/** What the board draws of a held game. A new object on every change, so it is a snapshot
 *  `useSyncExternalStore` can compare. */
export interface HeldState {
  /** `null` until the first deal answers, and while a new game is being dealt. */
  view: PlaytestView | null;
  book: LogBook;
  /** The last refusal, until the next action. One sentence, the engine's. */
  error: string | null;
  /** A deal or an action is with the engine. */
  busy: boolean;
  /** What the view has just had happen — the step's facts, or one replay beat's — for the damage
   *  and life pops. A new list for every beat; empty after a skip, and while no board shows it. */
  lastHappened: readonly PlaytestHappened[];
}

/** The board showing a held game: its replay, which plays an answer back beat by beat. */
export interface HeldBoard {
  play: (entries: readonly ReplayEntry[]) => void;
  skip: () => void;
  cancel: () => void;
}

/**
 * One game's life, outside any component — so it can outlive the board that shows it (issue
 * #1322). `usePlaytestGame` is the board's view of one.
 *
 * **Dealt by `start`, put away by `end`, and nothing else ends it.** Which of the two a board's
 * leaving is, is its owner's choice: the deck editor's goldfish holds its game for the board's
 * life and ends it with the board (`usePlaytestGame` with no game of its own), while the
 * Playtesting page keeps its game across a trip to another view (`./keptGame.ts`) and ends it
 * only when the reader does — Back, New game — or deals another.
 *
 * **A new game is a new seed** (`crypto.getRandomValues`, 53 bits), which is the shuffle and the
 * coin flip: the engine deals the same game from the same seed, which its own tests rely on and a
 * reader never wants. **Each deal is a game of its own name** (`game`, drawn the same way), which
 * every call for it carries, so the host acts on and ends only that game (issue #1141). An end
 * while the AI is mid-turn ends the game at once — not after the turn — and that turn's answer is
 * dropped on the host rather than put back over the next game.
 *
 * **Every action is sent one at a time, in the order the reader made them.** An action names
 * cards by the ids of the view it was made on (`GameCard.id` is a new id after every zone change,
 * CR 400.7), so two drags fired before the first answer would otherwise race, and the second
 * would name a card the first had already moved. Chained instead: each waits for the one before
 * it, and one that names a card no longer there is refused by the engine in a sentence — shown,
 * and the board kept as the last answer left it, so nothing is lost but that one action.
 *
 * **An answer from an older deal is dropped, not drawn** (the generation counter): a deal that
 * StrictMode's second mount replaced, an action sent before New game. **And one still waiting its
 * turn in the queue is never sent**: it is for a game already put away.
 *
 * **An answer here can take seconds**, not milliseconds: `playtestAct` returns only once the AI
 * has played everything up to the reader's next decision — its whole turn, often. So `busy` is
 * also true while a game is being dealt (the coin flip may hand the opponent the first turn).
 *
 * **An answer is played back by the board showing it** (`attach`, the board's `useReplay`), each
 * beat's facts going to the log as it is shown. **With no board to show it** — the reader is on
 * another view while the AI plays its turn — it is taken whole, every beat logged in order, so a
 * board that comes back finds the game where the engine left it.
 *
 * **Undo and redo are actions** (`{ type: "undo" }`, issue #1022): the engine goes back to the
 * reader's last decision with all the opponents did after it, and answers with no facts and no
 * frames. The log is kept beside the engine's history as it stood before each action
 * (`../undo.ts`' `LogBook`), once the last replay has been logged whole. **The stops and the
 * sandbox are settings, not actions** (`setStops`, `setSandbox`): the engine does not remember
 * them for undo, so neither does the log.
 */
export interface HeldGame {
  readonly picks: PlaytestPicks;
  /** {@link picksKey} of `picks`. */
  readonly key: string;
  state: () => HeldState;
  subscribe: (listener: () => void) => () => void;
  /** Deal, unless a game is already dealt (or being dealt) and not ended since. */
  start: () => void;
  /** Whether a game is dealt, or being dealt, and not ended since. */
  live: () => boolean;
  /** Whether the game on it is underway: dealt, not over, and not ended. What a way out asks
   *  the reader about before it puts the game away. */
  inPlay: () => boolean;
  /** One beat on the board: its view drawn, its facts logged (and, unless quiet, popped). */
  apply: (entry: ReplayEntry) => void;
  act: (action: PlaytestAction) => void;
  /** Clear the board, then deal again from the same picks. */
  newGame: () => void;
  /** Put the game away — at once, even mid-action. */
  end: () => void;
  /** Show this game's answers on `board` until the returned detach is called. */
  attach: (board: HeldBoard) => () => void;
}

/** A fresh 53-bit number: a deal's seed, and its game's name. */
function fresh(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // A JS number holds 53 bits exactly; the engine takes a u64 and any of those is one.
  return words[0] * 2 ** 21 + (words[1] >>> 11);
}

/** A game for `picks`, not yet dealt: {@link HeldGame.start} deals it. */
export function holdGame(picks: PlaytestPicks): HeldGame {
  const { deckId, variant } = picks;
  const difficulty = picks.difficulty ?? DEFAULT_DIFFICULTY;
  const opponents = picks.opponents.map((o) => ({ deckId: o.deckId, variant: o.variant }));

  let state: HeldState = {
    view: null,
    book: freshBook(),
    error: null,
    busy: false,
    lastHappened: NONE,
  };
  const listeners = new Set<() => void>();
  const set = (next: (s: HeldState) => Partial<HeldState>) => {
    state = { ...state, ...next(state) };
    for (const listener of listeners) listener();
  };

  /** The chain every action waits its turn on. */
  let queue: Promise<unknown> = Promise.resolve();
  /** Which deal this is on; an answer from an older one is dropped rather than drawn. */
  let generation = 0;
  let pending = 0;
  /** The host's name for the game being shown, or being dealt: what `act` and `end` carry. */
  let game = 0;
  let live = false;
  let board: HeldBoard | null = null;

  const apply = (entry: ReplayEntry) =>
    set((s) => ({
      view: entry.view,
      lastHappened: entry.quiet || board === null ? NONE : entry.happened,
      book: writeLog(
        s.book,
        playtestLines(
          entry.happened,
          entry.view.turn,
          entry.view.opponents.length,
          entry.view.goldfish,
        ),
      ),
    }));

  const show = (step: PlaytestStep) => {
    const entries = replayEntries(step, framesOf(step));
    if (board !== null) board.play(entries);
    else for (const entry of entries) apply({ ...entry, quiet: true });
  };
  const skip = () => board?.skip();

  /** Queue `work`, counting it toward `busy` until it settles. */
  const enqueue = (work: () => Promise<unknown>) => {
    pending++;
    if (!state.busy) set(() => ({ busy: true }));
    queue = queue
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        pending--;
        if (pending === 0) set(() => ({ busy: false }));
      });
  };

  /** Ask the engine for a game; its answer is drawn only if `mine` is still this deal. */
  const request = (mine: number) => {
    const named = fresh();
    game = named;
    enqueue(() => {
      if (mine !== generation) return Promise.resolve();
      return ipc.playtestStart(named, deckId, variant, opponents, difficulty, fresh()).then(
        (step) => {
          if (mine !== generation) return;
          // The goldfish's deck is nobody's to shuffle: the old goldfish board's first line.
          const dealt =
            opponents.length === 0
              ? "Shuffled and drew seven"
              : opponents.length > 1
                ? "Shuffled every deck and drew seven"
                : "Shuffled both decks and drew seven";
          set(() => ({ book: freshBook([{ turn: 0, text: dealt, kind: "deal" }]) }));
          show(step);
        },
        (e: unknown) => {
          if (mine === generation) set(() => ({ error: ipcError(e) }));
        },
      );
    });
  };

  return {
    picks,
    key: picksKey(picks),
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start: () => {
      if (live) return;
      live = true;
      request(++generation);
    },
    live: () => live,
    inPlay: () => live && state.view !== null && state.view.stage !== "over",
    apply,
    act: (action) => {
      // The board is read-only while a replay plays; an action that reaches here anyway is made
      // on the view the replay ends on, so that view is shown first.
      skip();
      const mine = generation;
      const named = game;
      enqueue(() => {
        if (mine !== generation) return Promise.resolve();
        return ipc.playtestAct(named, action).then(
          (step) => {
            if (mine !== generation) return;
            set(() => ({ error: null }));
            // The replay of an earlier answer, if one is still playing, is logged whole first:
            // the log before this action is the one with all of that action's lines in it.
            if (action.type === "undo" || action.type === "redo") {
              skip();
              set((s) => ({
                book: action.type === "undo" ? undoLog(s.book) : redoLog(s.book),
                lastHappened: NONE,
                view: step.view,
              }));
              return;
            }
            // The stops and the sandbox are settings, which the engine does not remember as
            // actions: nothing to take back, so no log to go back to.
            if (action.type !== "setStops" && action.type !== "setSandbox") {
              skip();
              set((s) => ({ book: rememberLog(s.book) }));
            }
            show(step);
          },
          (e: unknown) => {
            if (mine === generation) set(() => ({ error: ipcError(e) }));
          },
        );
      });
    },
    newGame: () => {
      const mine = ++generation;
      // The old game is put away by the deal itself: the host's slot is the new name's from the
      // moment `playtestStart` arrives.
      live = true;
      board?.cancel();
      set(() => ({ lastHappened: NONE, view: null, error: null, book: freshBook() }));
      request(mine);
    },
    end: () => {
      if (!live) return;
      live = false;
      generation++;
      board?.cancel();
      // Not queued: an action the AI is still playing out ends with it, rather than first.
      void ipc.playtestEnd(game).catch(() => undefined);
    },
    attach: (shown) => {
      board = shown;
      return () => {
        // A replay still playing is shown to its end first, so the game kept is the engine's
        // and its log has every line; and nothing pops again when a board comes back.
        if (board === shown) {
          shown.skip();
          board = null;
          set(() => ({ lastHappened: NONE }));
        }
      };
    },
  };
}
