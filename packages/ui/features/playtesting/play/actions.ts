/**
 * The goldfish's table pieces speak `GoldfishAction`; this board speaks `PlaytestAction`.
 *
 * **One is nearly a subset of the other**, by design (`playtest/view.rs`: "the goldfish's sandbox
 * moves are here under the goldfish's names"), so the pieces are reused as they are and their
 * actions are put through {@link fromGoldfish} on the way out rather than the pieces being drawn
 * twice. The goldfish has two words this board does not. `nextTurn` — a goldfish's turn is the
 * reader's alone — has its nearest meaning here in "play out the rest of my turn", which is
 * `endTurn`. `discard` — the goldfish's cleanup-step answer, sent only by its `DiscardDialog` —
 * has none: here the engine asks that as a question (`DiscardToHandSize`, answered by `choose`),
 * and this board never draws the dialog, so it is dropped (`null`).
 */
import type { GoldfishAction, PlaytestAction } from "@/lib/ipc";

export function fromGoldfish(action: GoldfishAction): PlaytestAction | null {
  if (action.type === "nextTurn") return { type: "endTurn" };
  if (action.type === "discard") return null;
  return action;
}
