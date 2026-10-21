import { viewMemory } from "@/lib/viewMemory";
import type { HeldGame } from "./play/heldGame";

/**
 * **The Playtesting page's game, kept while the reader is on another view** (issue #1322). The
 * page is unmounted by every view change, and its board with it; the game is not. It is left
 * here on the way out and found here on the way back, its picks, its board and its log as they
 * were — and an answer the AI was still working on lands in it meanwhile (`./play/heldGame.ts`).
 *
 * **Window-lifetime memory, `@/lib/viewMemory`'s**: a restart opens the setup page, and the
 * host's game is dropped by the next deal. **Only the reader puts it away** — the board's Back
 * or New game, each asked first while the game is underway — or a game dealt elsewhere: the host
 * holds one game, so the deck editor's goldfish asks before it deals over this one
 * (`GoldfishPage`), and ends it.
 */
const KEPT = viewMemory<HeldGame | null>("playtest");

/** The kept game, if one is still dealt (or being dealt). */
export function keptGame(): HeldGame | null {
  const game = KEPT.recall() ?? null;
  return game?.live() ? game : null;
}

/** Keep `game` as the page's, or forget it (`null`). Never ends one: the caller does that. */
export function keepGame(game: HeldGame | null): void {
  KEPT.keep(game);
}
