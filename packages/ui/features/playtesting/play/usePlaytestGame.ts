import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { PlaytestAction, PlaytestHappened, PlaytestView } from "@/lib/ipc";
import type { LogLine } from "../table/log";
import { holdGame, picksKey, type HeldGame, type PlaytestPicks } from "./heldGame";
import { useReplay } from "./useReplay";

export { DEFAULT_DIFFICULTY, type PlaytestPicks } from "./heldGame";

/**
 * One game on the board, against the goldfish or the AI — the board's view of a
 * {@link HeldGame}, which is where the game's life is (`./heldGame.ts` has its rules: the queue,
 * the names, the generations, undo's log).
 *
 * **Whose game it is decides what leaving does.** Given a `held` game — the Playtesting page's,
 * kept across a trip to another view (issue #1322) — the board only shows it: a board that leaves
 * shows the replay it was playing to its end and lets go, and the game plays on without it, an
 * answer the AI was still working on included. Given none — the deck editor's goldfish — the
 * board holds a game of its own for its life: **dealt when it mounts and put away when it
 * leaves** (`playtestEnd`), and dealt again for other picks.
 *
 * **An answer is played back, not jumped to** (`useReplay`): a step that carries the views in
 * between the AI's actions shows them one by one before it settles, each beat's facts going to the
 * log and to the board's pops (`lastHappened`) as it is shown. While one plays the board is
 * read-only (`replaying`), and `skip` shows the end at once.
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
  /** What the view on the board has just had happen — the step's facts, or one replay beat's —
   *  for the damage and life pops. A new list for every beat; empty after a skip. */
  lastHappened: readonly PlaytestHappened[];
  /** A replay of the opponent's actions is being shown. */
  replaying: boolean;
  /** Show the end of the replay now. */
  skip: () => void;
}

export function usePlaytestGame(picks: PlaytestPicks, held?: HeldGame): PlaytestGame {
  const key = picksKey(picks);
  // The board's own game, for a caller that keeps none: one per picks, so a list rebuilt alike on
  // every render is still the one game. Built in render (a held game does nothing until it is
  // started) and dealt only by the effect below; unused beside a `held` one.
  const [own, setOwn] = useState(() => holdGame(picks));
  if (own.key !== key) setOwn(holdGame(picks));
  const game = held ?? own;

  const state = useSyncExternalStore(game.subscribe, game.state);
  const replay = useReplay(game.apply);
  const { play, skip, cancel } = replay;
  const kept = held !== undefined;

  useEffect(() => {
    const detach = game.attach({ play, skip, cancel });
    game.start();
    return () => {
      detach();
      if (!kept) game.end();
    };
  }, [game, kept, play, skip, cancel]);

  const act = useCallback((action: PlaytestAction) => game.act(action), [game]);
  const newGame = useCallback(() => game.newGame(), [game]);

  return {
    view: state.view,
    log: state.book.log,
    error: state.error,
    busy: state.busy,
    act,
    newGame,
    lastHappened: state.lastHappened,
    replaying: replay.replaying,
    skip,
  };
}
