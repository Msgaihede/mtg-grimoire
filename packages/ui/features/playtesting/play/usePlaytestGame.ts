import { useCallback, useEffect, useRef, useState } from "react";
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
import type { LogLine } from "../table/log";
import { freshBook, redoLog, rememberLog, undoLog, writeLog, type LogBook } from "../undo";
import { playtestLines } from "./log";
import { framesOf, replayEntries, useReplay, type ReplayEntry } from "./useReplay";

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
 * One game's life on the page, against the goldfish or the AI — one hook for one game.
 *
 * **Dealt when the board mounts and put away when it leaves** (`playtestEnd`), and **a new game
 * is a new seed** (`crypto.getRandomValues`, 53 bits), which is the shuffle and the coin flip:
 * the engine deals the same game from the same seed, which its own tests rely on and a reader
 * never wants.
 *
 * **Each deal is a game of its own name** (`game`, drawn the same way), which every call for it
 * carries, so the host acts on and ends only that game (issue #1141). A board that leaves while
 * the AI is mid-turn ends its game at once — not after the turn — and that turn's answer is
 * dropped on the host rather than put back over the next board's game; a late action or end from
 * a board that has gone, or from another window's, never touches a newer game.
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
 * also true while a game is being dealt (the coin flip may hand the opponent the first turn), and
 * the board says the opponent is thinking for as long as it is.
 *
 * **And an answer is played back, not jumped to** (`useReplay`): a step that carries the views in
 * between the AI's actions shows them one by one before it settles, each beat's facts going to the
 * log and to the board's pops (`lastHappened`) as it is shown. While one plays the board is
 * read-only (`replaying`), and `skip` shows the end at once.
 *
 * **Undo and redo are actions** (`{ type: "undo" }`, issue #1022): the engine goes back to the
 * reader's last decision with all the opponents did after it, and answers with no facts and no
 * frames, so nothing plays back. The log is kept beside the engine's history as it stood before
 * each action (`../undo.ts`' `LogBook`), once the last replay has been logged whole. **The stops
 * and the sandbox are settings, not actions** (`setStops`, `setSandbox`): the engine does not
 * remember them for undo, so neither does the log.
 */
const NONE: readonly PlaytestHappened[] = [];

export interface PlaytestGame {
  /** `null` until the first deal answers, and while a new game is being dealt. */
  view: PlaytestView | null;
  log: LogLine[];
  /** The last refusal, until the next action. One sentence, the engine's. */
  error: string | null;
  /** A deal or an action is with the engine. */
  busy: boolean;
  act: (action: PlaytestAction) => void;
  newGame: () => void;
  /** What the view on the board has just had happen — the step's facts, or one replay beat's —
   *  for the damage and life pops. A new list for every beat; empty after a skip. */
  lastHappened: readonly PlaytestHappened[];
  /** A replay of the opponent's actions is being shown. */
  replaying: boolean;
  /** Show the end of the replay now. */
  skip: () => void;
}

/** A fresh 53-bit number: a deal's seed, and its game's name. */
function fresh(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // A JS number holds 53 bits exactly; the engine takes a u64 and any of those is one.
  return words[0] * 2 ** 21 + (words[1] >>> 11);
}

export function usePlaytestGame(picks: PlaytestPicks): PlaytestGame {
  const { deckId, variant } = picks;
  const difficulty = picks.difficulty ?? DEFAULT_DIFFICULTY;
  // **The opponents by value, not by array**: a caller that builds the list afresh on every
  // render must not deal a new game on every render, which is what a dependency on the array's
  // identity would do. The same decks in the same seats are the same string.
  const lineup = JSON.stringify(picks.opponents.map((o) => [o.deckId, o.variant]));
  const [view, setView] = useState<PlaytestView | null>(null);
  const [book, setBook] = useState<LogBook>(() => freshBook());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastHappened, setLastHappened] = useState<readonly PlaytestHappened[]>(NONE);
  /** The chain every action waits its turn on. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Which deal the page is on; an answer from an older one is dropped rather than drawn. */
  const generation = useRef(0);
  const pending = useRef(0);
  /** The host's name for the game on the board, or being dealt: what `act` and `playtestEnd`
   *  carry. */
  const game = useRef(0);

  /** One beat on the board: its view drawn, its facts logged and (unless skipped past) popped. */
  const apply = useCallback((entry: ReplayEntry) => {
    setView(entry.view);
    setLastHappened(entry.quiet ? NONE : entry.happened);
    setBook((b) =>
      writeLog(
        b,
        playtestLines(
          entry.happened,
          entry.view.turn,
          entry.view.opponents.length,
          entry.view.goldfish,
        ),
      ),
    );
  }, []);
  const replay = useReplay(apply);
  const { play, skip, cancel } = replay;
  const show = useCallback(
    (step: PlaytestStep) => play(replayEntries(step, framesOf(step))),
    [play],
  );

  /** Queue `work`, counting it toward `busy` until it settles. */
  const enqueue = useCallback((work: () => Promise<unknown>) => {
    pending.current++;
    setBusy(true);
    queue.current = queue.current
      .catch(() => undefined)
      .then(work)
      .finally(() => {
        pending.current--;
        if (pending.current === 0) setBusy(false);
      });
  }, []);

  /** Ask the engine for a game; its answer is drawn only if `mine` is still the page's deal. */
  const request = useCallback(
    (mine: number) => {
      const seats = JSON.parse(lineup) as [number, string][];
      const opponents = seats.map(([id, list]) => ({ deckId: id, variant: list }));
      const named = fresh();
      game.current = named;
      enqueue(() => {
        if (mine !== generation.current) return Promise.resolve();
        return ipc.playtestStart(named, deckId, variant, opponents, difficulty, fresh()).then(
          (step) => {
            if (mine !== generation.current) return;
            // The goldfish's deck is nobody's to shuffle: the old goldfish board's first line.
            const dealt =
              opponents.length === 0
                ? "Shuffled and drew seven"
                : opponents.length > 1
                  ? "Shuffled every deck and drew seven"
                  : "Shuffled both decks and drew seven";
            setBook(freshBook([{ turn: 0, text: dealt, kind: "deal" }]));
            show(step);
          },
          (e: unknown) => {
            if (mine === generation.current) setError(ipcError(e));
          },
        );
      });
    },
    [enqueue, show, deckId, variant, lineup, difficulty],
  );

  /** The game menu's New game, and the result banner's: clear the board, then deal. */
  const newGame = useCallback(() => {
    const mine = ++generation.current;
    cancel();
    setLastHappened(NONE);
    setView(null);
    setError(null);
    setBook(freshBook());
    request(mine);
  }, [request, cancel]);

  useEffect(() => {
    // The ref objects, not their values: the cleanup must bump the counter the next deal reads,
    // and end the game on the board as it leaves, which New game may have changed since.
    const deals = generation;
    const named = game;
    request(++deals.current);
    return () => {
      deals.current++;
      // Not queued: an action the AI is still playing out ends with it, rather than first.
      void ipc.playtestEnd(named.current).catch(() => undefined);
    };
  }, [request]);

  const act = useCallback(
    (action: PlaytestAction) => {
      // The board is read-only while a replay plays; an action that reaches here anyway is made
      // on the view the replay ends on, so that view is shown first.
      skip();
      const mine = generation.current;
      const named = game.current;
      enqueue(() => {
        if (mine !== generation.current) return Promise.resolve();
        return ipc.playtestAct(named, action).then(
          (step) => {
            if (mine !== generation.current) return;
            setError(null);
            // The replay of an earlier answer, if one is still playing, is logged whole first:
            // the log before this action is the one with all of that action's lines in it.
            if (action.type === "undo" || action.type === "redo") {
              skip();
              setBook(action.type === "undo" ? undoLog : redoLog);
              setLastHappened(NONE);
              setView(step.view);
              return;
            }
            // The stops and the sandbox are settings, which the engine does not remember as
            // actions: nothing to take back, so no log to go back to.
            if (action.type !== "setStops" && action.type !== "setSandbox") {
              skip();
              setBook(rememberLog);
            }
            show(step);
          },
          (e: unknown) => {
            if (mine === generation.current) setError(ipcError(e));
          },
        );
      });
    },
    [enqueue, show, skip],
  );

  return {
    view,
    log: book.log,
    error,
    busy,
    act,
    newGame,
    lastHappened,
    replaying: replay.replaying,
    skip,
  };
}
