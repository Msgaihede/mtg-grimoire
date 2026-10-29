import { viewMemory } from "@/lib/viewMemory";
import { holdGuestGame, type GuestHeldGame } from "./play/guestGame";
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

/**
 * **A guest's game in a lobby, kept the same way** (issue #1419), by the lobby's code: held from
 * the join on — the first `lobby:game` can come the moment the guest's deck reaches the host — and
 * across a trip to another view, so a guest who comes back finds the board where the host's steps
 * left it. Apart from the host's game above, because a guest's app plays nothing in its own slot:
 * a goldfish dealt from the deck editor meanwhile leaves it be.
 */
const GUEST = viewMemory<{ code: string; game: GuestHeldGame } | null>("playtest.guest");

/**
 * The guest's game for the lobby `code`, held (not yet listening — the page starts it) when
 * there is none. **Safe to call while rendering**: it is the same game for the same code on every
 * call, and a game kept for another code — a lobby left, another joined — is put away first, which
 * only stops its listening.
 */
export function guestGameFor(code: string): GuestHeldGame {
  const kept = GUEST.recall() ?? null;
  if (kept !== null && kept.code === code) return kept.game;
  kept?.game.end();
  const game = holdGuestGame();
  GUEST.keep({ code, game });
  return game;
}

/** The guest's game kept for `code`, if one is — never a new one (a lobby that has closed). */
export function keptGuestGame(code: string): GuestHeldGame | null {
  const kept = GUEST.recall() ?? null;
  return kept !== null && kept.code === code ? kept.game : null;
}

/** Put the guest's game away and forget it: the reader left the lobby. */
export function forgetGuestGame(): void {
  GUEST.recall()?.game.end();
  GUEST.keep(null);
}
