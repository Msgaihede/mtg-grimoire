/**
 * When the sandbox's moves are taken — the session's `edit` (issue #1522).
 *
 * **Wherever the game waits on the reader to play or to declare**: their main phase, a moment to
 * respond (the opponent's spell, combat after blocks, or any step they asked to stop at — the
 * Stops menu is how a reader edits in a step the game would pass), and their declare-attackers
 * and declare-blockers steps. phase re-reads who may attack or block after an edit, so the
 * declare steps' picks follow it. The reader stays where they were: an edit passes nothing.
 *
 * **Not in the middle of a question** (`prompt`), whose answers phase does not re-read, and not
 * before the opening hand is kept (`mulligan`); never while the game waits on someone else, is
 * played back, or is over.
 */
import type { PlaytestStage } from "@/lib/ipc";

const EDITABLE: ReadonlySet<PlaytestStage> = new Set(["main", "respond", "attack", "block"]);

/** Whether the engine takes the sandbox's moves at this stage, with the sandbox on. */
export function sandboxEditsAt(stage: PlaytestStage): boolean {
  return EDITABLE.has(stage);
}
