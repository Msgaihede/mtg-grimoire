import { useCallback, useEffect, useRef, useState } from "react";
import {
  ipc,
  ipcError,
  type DeckVariant,
  type PlaytestAction,
  type PlaytestDifficulty,
  type PlaytestView,
} from "@/lib/ipc";
import { appendLog, type LogLine } from "../goldfish/log";
import { playtestLines } from "./log";

/** What a game is dealt from: the reader's deck and the opponent's, each in one of its lists,
 *  and how well the AI plays. */
export interface PlaytestPicks {
  deckId: number;
  variant: DeckVariant;
  opponentDeckId: number;
  opponentVariant: DeckVariant;
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
 */
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
}

function freshSeed(): number {
  const words = new Uint32Array(2);
  crypto.getRandomValues(words);
  // A JS number holds 53 bits exactly; the engine takes a u64 and any of those is one.
  return words[0] * 2 ** 21 + (words[1] >>> 11);
}

export function usePlaytestGame(picks: PlaytestPicks): PlaytestGame {
  const { deckId, variant, opponentDeckId, opponentVariant, difficulty } = picks;
  const [view, setView] = useState<PlaytestView | null>(null);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The chain every action waits its turn on. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  /** Which deal the page is on; an answer from an older one is dropped rather than drawn. */
  const generation = useRef(0);
  const pending = useRef(0);

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
      enqueue(() =>
        ipc
          .playtestStart(deckId, variant, opponentDeckId, opponentVariant, difficulty, freshSeed())
          .then(
            (step) => {
              if (mine !== generation.current) return;
              setView(step.view);
              setLog(
                appendLog(
                  [{ turn: 0, text: "Shuffled both decks and drew seven", kind: "deal" }],
                  playtestLines(step.happened, step.view.turn),
                ),
              );
            },
            (e: unknown) => {
              if (mine === generation.current) setError(ipcError(e));
            },
          ),
      );
    },
    [enqueue, deckId, variant, opponentDeckId, opponentVariant, difficulty],
  );

  /** The game menu's New game, and the result banner's: clear the board, then deal. */
  const newGame = useCallback(() => {
    const mine = ++generation.current;
    setView(null);
    setError(null);
    setLog([]);
    request(mine);
  }, [request]);

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
      const mine = generation.current;
      enqueue(() =>
        ipc.playtestAct(action).then(
          (step) => {
            if (mine !== generation.current) return;
            setError(null);
            setView(step.view);
            setLog((old) => appendLog(old, playtestLines(step.happened, step.view.turn)));
          },
          (e: unknown) => {
            if (mine === generation.current) setError(ipcError(e));
          },
        ),
      );
    },
    [enqueue],
  );

  return { view, log, error, busy, act, newGame };
}
