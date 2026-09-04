/**
 * Where the caret goes when a printing swap has replaced the control it came from.
 *
 * **Lifted whole out of `CardDetailPane.tsx`, which is where this lived until the pane became
 * `CardDetailModal` and the printings list became `AllPrintingsDialog`.** The swap moved with the
 * list; this did not, and nothing walked the caret anywhere for a while. The argument is unchanged
 * and is worth restating, because it is the whole reason the lookup is a DOM query rather than a
 * ref:
 *
 * A swap **deletes the deck's control for the row it moved**. The card the reader pressed the
 * printings list open from is gone, the printing's new card is a different React key, and the
 * refetch that rebuilds the pile unmounts the old element — so a ref taken when the modal opened
 * points at something that is not in the document by the time the modal closes. A *slot* is a
 * question the DOM can answer after the fact, which is what {@link DECK_CARD_ATTR} is stamped for
 * (`cardControl.tsx`'s `deckCardProps`, and therefore all four deck views).
 */
import { DECK_CARD_ATTR, deckCardSlot } from "@/features/decks/dnd";
import type { PaneDeckContext } from "@/lib/store";

/**
 * The deck's own control for a slot, or `null`.
 *
 * The card ids this interpolates are Scryfall UUIDs and the category ids are `INTEGER PRIMARY
 * KEY` rowids, so there is nothing here a quoted attribute selector can be broken by — the
 * category's *name* is the user's and would be, which is why the slot is keyed by the id. The
 * search is document-wide and does not name a deck, which is safe for as long as one editor is
 * mounted at a time — see {@link deckCardSlot}, which is where that assumption is written down.
 */
export function deckControlFor(row: PaneDeckContext | null): HTMLElement | null {
  if (!row) return null;
  return document.querySelector<HTMLElement>(
    `[${DECK_CARD_ATTR}="${deckCardSlot(row.categoryId, row.cardId, row.finish)}"]`,
  );
}

/**
 * How long {@link handBackToDeckCard} waits for the deck to draw the row the swap made.
 *
 * **The wait is the whole difference between this and the pane's one-liner.** The pane handed the
 * caret back when the reader pressed Escape, which is a human-scale moment: the swap's refetch had
 * landed long before, so the control was simply there. This modal **closes on a successful swap**,
 * and it closes inside the mutation's own `onSuccess` — one microtask after `deck_swap_printing`
 * answered and while `useDeck`'s invalidation is still in flight. At that instant the pile on
 * screen is still the *old* row, so a lookup made there finds nothing and a lookup made a moment
 * earlier finds an element the refetch is about to unmount.
 *
 * So the hand-back waits for the element rather than for a clock, and this is only the ceiling on
 * that wait: a deck read that never answers must not leave a `MutationObserver` running on the
 * document for the rest of the session, and a caret that arrives a second and a half after the
 * gesture is one the reader has stopped expecting anyway.
 */
const HAND_BACK_DEADLINE_MS = 1500;

/**
 * The hand-back this module has in flight, so a second one replaces it rather than racing it.
 *
 * Module scope for {@link deckControlFor}'s reason — there is one deck editor mounted at a time,
 * so there is one caret being walked home — and it is the same shape the pane's `handover` used:
 * a note between two moments of one surface, never application state.
 */
let pending: (() => void) | null = null;

/**
 * Put the caret on the deck's card for `row`, as soon as the deck has drawn it.
 *
 * `null` is the ordinary case and does nothing: most presses in the printings modal are a repoint
 * or a look, and neither has a deck row to go home to.
 *
 * **Three conditions, and every one of them is a refusal to take a caret that is not ours.**
 *
 * * **The document holds no dialog.** The printings modal is opened from a deck card's own menu —
 *   where it is the only surface up, and this is the case the hand-back exists for — and from the
 *   card modal's `View all printings`, where closing it leaves *that* modal on screen. Walking the
 *   caret into the deck behind an `aria-modal` panel is the exact defect `caretWalk.ts` was
 *   written for, one surface over. The test is for **any** dialog rather than for that one, both
 *   because this file has no business naming another surface and because `Dialog` keeps its panel
 *   mounted for the length of its fade — so at the moment `close` runs, the dialog still standing
 *   is usually this one.
 * * **The caret is homeless.** `null` or `<body>`, which is where the browser leaves it when the
 *   panel holding it unmounts. A reader who has moved on owns where they are, which is every other
 *   hand-back in this app's rule.
 * * **The control is in the document.** `isConnected` rather than a bare truthiness test, because
 *   the answer to the query can be an element the next commit is about to take away.
 */
export function handBackToDeckCard(row: PaneDeckContext | null): void {
  pending?.();
  pending = null;
  if (row === null) return;

  const attempt = (): boolean => {
    if (document.querySelector('[role="dialog"]') !== null) return false;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return false;
    const home = deckControlFor(row);
    if (!home?.isConnected) return false;
    home.focus();
    return true;
  };

  // Tried once before anything is watched, for the swap whose refetch has already landed — a fold
  // keeps the modal open, so that close is the reader's own press and the pile below it was
  // rebuilt several seconds ago.
  if (attempt()) return;

  const observer = new MutationObserver(() => {
    if (attempt()) stop();
  });
  const stop = () => {
    clearTimeout(timer);
    observer.disconnect();
    if (pending === stop) pending = null;
  };
  const timer = setTimeout(stop, HAND_BACK_DEADLINE_MS);
  pending = stop;
  // The whole document, because the deck editor is not this component's tree and there is no
  // element here to scope the watch to. It runs for at most {@link HAND_BACK_DEADLINE_MS} and only
  // while a swap-close is waiting for its row.
  observer.observe(document.body, { childList: true, subtree: true });
}
