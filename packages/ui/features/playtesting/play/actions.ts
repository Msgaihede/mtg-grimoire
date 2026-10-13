/**
 * The goldfish's table pieces speak `GoldfishAction`; this board speaks `PlaytestAction`.
 *
 * **One is nearly a subset of the other**, by design (`playtest/view.rs`: "the goldfish's sandbox
 * moves are here under the goldfish's names"), so the pieces are reused as they are and their
 * actions are put through {@link fromGoldfish} on the way out rather than the pieces being drawn
 * twice. The one word the goldfish has that this board does not is `nextTurn` — a goldfish's turn
 * is the reader's alone — and its nearest meaning here is "play out the rest of my turn", which
 * is `endTurn`.
 */
import type { GoldfishAction, PlaytestAction } from "@/lib/ipc";

export function fromGoldfish(action: GoldfishAction): PlaytestAction {
  return action.type === "nextTurn" ? { type: "endTurn" } : action;
}
