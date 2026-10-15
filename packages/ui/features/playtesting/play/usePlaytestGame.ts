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
import type { LogLine } from "../goldfish/log";
import { freshBook, redoLog, rememberLog, undoLog, writeLog, type LogBook } from "../undo";
import { playtestLines } from "./log";
import { framesOf, replayEntries, useReplay, type ReplayEntry } from "./useReplay";

/** What a game is dealt from: the reader's deck and each opponent's — one for a duel, three for a
 *  four-player game — each in one of its lists, and how well the AI plays. */
export interface PlaytestPicks {
  deckId: number;
  variant: DeckVariant;
  /** In turn order after the reader: `ipc.playtestStart`'s `opponents`. */
  opponents: { deckId: number; variant: DeckVariant }[];
  difficulty: PlaytestDifficulty;
}

/**
 * One playtest's life on the page — `useGoldfishGame`'s, for its reasons: dealt when the board
 * mounts, put away when it leaves, every action sent **one at a time, in the order the reader
 * made them** (an action names cards by the ids of the view it was made on, CR 400.7), an answer
 * from an older deal dropped by the generation counter, and a fresh 53-bit seed per game.
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
 * **Undo and redo are actions** (`{ type: "undo" }`, issue #1022), as on the goldfish board: the
 * engine goes back to the reader's last decision with all the opponent did after it, and answers
 * with no facts and no frames, so nothing plays back. The log is kept beside the engine's history
 * as it stood before each action (`../undo.ts`' `LogBook`), once the last replay has been logged
 * whole.
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

function freshSeed(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // A JS number holds 53 bits exactly; the engine takes a u64 and any of those is one.
  return words[0] * 2 ** 21 + (words[1] >>> 11);
}

export function usePlaytestGame(picks: PlaytestPicks): PlaytestGame {
  const { deckId, variant, difficulty } = picks;
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

  /** One beat on the board: its view drawn, its facts logged and (unless skipped past) popped. */
  const apply = useCallback((entry: ReplayEntry) => {
    setView(entry.view);
    setLastHappened(entry.quiet ? NONE : entry.happened);
    setBook((b) =>
      writeLog(b, playtestLines(entry.happened, entry.view.turn, entry.view.opponents.length)),
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
      enqueue(() =>
        ipc.playtestStart(deckId, variant, opponents, difficulty, freshSeed()).then(
          (step) => {
            if (mine !== generation.current) return;
            const dealt = opponents.length > 1 ? "every deck" : "both decks";
            setBook(
              freshBook([{ turn: 0, text: `Shuffled ${dealt} and drew seven`, kind: "deal" }]),
            );
            show(step);
          },
          (e: unknown) => {
            if (mine === generation.current) setError(ipcError(e));
          },
        ),
      );
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
    // The ref object, not its value: the cleanup must bump the counter the next deal reads.
    const deals = generation;
    request(++deals.current);
    return () => {
      deals.current++;
      void ipc.playtestEnd().catch(() => undefined);
    };
  }, [request]);

  const act = useCallback(
    (action: PlaytestAction) => {
      // The board is read-only while a replay plays; an action that reaches here anyway is made
      // on the view the replay ends on, so that view is shown first.
      skip();
      const mine = generation.current;
      enqueue(() =>
        ipc.playtestAct(action).then(
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
            // The stops are a setting, which the engine does not remember as an action.
            if (action.type !== "setStops") {
              skip();
              setBook(rememberLog);
            }
            show(step);
          },
          (e: unknown) => {
            if (mine === generation.current) setError(ipcError(e));
          },
        ),
      );
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
