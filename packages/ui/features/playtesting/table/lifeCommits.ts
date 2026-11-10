import { createContext } from "react";

/**
 * **What the board tells its life plates about the engine** (issue #1593), so a change on a
 * plate cannot be lost behind another action.
 *
 * A plate waits 400 ms (`SETTLE_MS`) after the last press before it sends `setLife` (`LifePlate`), so
 * a press of `+` and then Space within that time would queue the pass first and the life after
 * it — at a step where the engine may refuse it ("Declare your attackers first."). Two things
 * close that:
 *
 * - **`hold`**: each plate hands the board a way to send its waiting change now, and the board
 *   calls every one before it sends any other action. A change made before a pass is sent
 *   before it, which is the order the reader made them in.
 * - **`working`**: an action is with the engine or its answer is being played back. A plate that
 *   has sent a change lets go of its draft once this falls with the game's life unmoved — the
 *   engine refused it — rather than show a life total the game does not have.
 *
 * Outside a board (no provider) `hold` keeps nothing and `working` is `null`: the plate cannot
 * tell a refusal from an answer still on its way, so it keeps its draft until the life moves.
 */
export interface LifeCommits {
  /** Keep `flush` until the returned function is called; the board calls it before an action. */
  hold: (flush: () => void) => () => void;
  /** An action is with the engine or being played back; `null` when nobody says. */
  working: boolean | null;
}

export const LifeCommitsContext = createContext<LifeCommits>({
  hold: () => () => {},
  working: null,
});
