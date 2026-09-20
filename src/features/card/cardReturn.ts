/**
 * What the card modal does when the row behind the open card is **removed** — issue #474.
 *
 * Every removal in this app deletes a row rather than zeroing one: `deck_set_card_quantity` at 0
 * deletes the `deck_cards` row, `collection_set_quantity` at 0 `DELETE`s the entry, and the
 * wishlist's does the same. A deleted row is not a stop on `cardWalk`, so the modal open over it
 * lost its place the moment the write landed — `at` went to `-1`, both `StepChevron`s unmounted
 * and `onPanelKeyDown` returned on every press. What the reader reported is the honest reading of
 * it: *removing the card leaves you on that page and prevents navigation to the next card*.
 *
 * ## Two halves, and each is a statement about a move the reader did not make
 *
 * **Leaving.** The app steps onto the next stop, so the walk survives the removal — which is the
 * whole feature, because a cut is something a reader does *while going through a deck* and the
 * key they press next is the arrow. At the end of the walk it falls back to the previous stop,
 * the way every list does; with nothing else on the walk at all it stays put, and that is the
 * floor rather than an error.
 *
 * **Returning.** A move nobody asked for has to be reversible. Ctrl+Z is `DeckEditor`'s window
 * handler and reaches straight past this modal's panel — it only yields inside a text field — so
 * a reader who cuts a card and changes their mind presses it with the card still open, and
 * *put that card back* has to include putting them back on it. {@link useReturnToRemovedCard} is
 * that half.
 *
 * ## Why the return is triggered by the walk and not by the undo
 *
 * `useDeckUndo` knows which audit row it is about to reverse, so it could in principle re-open
 * the card itself — and it would then be a deck-only answer wired to one presser, firing on every
 * undo including the ones that rename a pile. "The row is back on the walk" is the same evidence
 * whatever put it there: an undo, a redo of a re-add, a second window, a sync. And it is evidence
 * the modal can act on, because the walk is exactly the list the modal is able to navigate — a
 * card restored somewhere the modal could not step to is not a card it should jump to.
 */
import { useEffect, useRef } from "react";
import { useAppStore, type CardWalkStop } from "@/lib/store";
import { sameDeckSlot } from "@/features/decks/deckWalk";

/**
 * Where the modal lands when the stop at `at` is removed: the **next** one, or the previous one
 * at the end of the walk, or `null` when the walk holds nothing else.
 *
 * **Next before previous, and never the other way round.** A reader going through a deck is going
 * forwards, and a cut that walked them backwards would re-show a card they had just decided to
 * keep. The fallback exists only because the last stop has no next, and at that end the previous
 * card is the only thing "carry on" can mean.
 *
 * `at` is the index on the walk the modal already computes for its chevrons, so this adds no
 * second opinion about where the reader is standing. An `at` of `-1` — a card reached by a meld
 * relation or a printing swap, which is on no list — answers `null`, which is the same *nothing
 * to step to* the walk's two ends give.
 */
export function stopAfterRemoval(
  stops: readonly CardWalkStop[],
  at: number,
): CardWalkStop | null {
  if (at < 0 || at >= stops.length) return null;
  return stops[at + 1] ?? stops[at - 1] ?? null;
}

/**
 * Where the open card is about to be moved to, and which stop it is being moved **off**.
 *
 * Planned before the removal and spent after it, which is why it is a value rather than a call:
 * the two moments are a round trip apart and the walk does not hold still across one.
 */
export interface PaneDeparture {
  /** The stop the open card is, as the walk still holds it. What a return puts the reader back
   *  on — so it is the *stop*, carrying its deck row where it has one, and not merely an id. */
  leaving: CardWalkStop;
  /** The stop to step onto, or `null` where the walk holds nothing else — see
   *  {@link stopAfterRemoval}. */
  to: CardWalkStop | null;
}

/**
 * Plan the departure forced on the card standing at `at`, or `null` where it is on no walk.
 *
 * **One definition for three surfaces**, which is the point: the deck plans this inside
 * `useDeck.setQuantity` (a removal there can come from the tray, a menu row or the `Delete` key
 * as well as from the modal's stepper), and the collection and the wishlist plan it in the modal
 * itself, where their only removal is pressed. Written twice, the second copy is the one that
 * comes to fall back the wrong way at the end of a walk.
 */
export function departureFrom(stops: readonly CardWalkStop[], at: number): PaneDeparture | null {
  const leaving = stops[at];
  if (at < 0 || leaving === undefined) return null;
  return { leaving, to: stopAfterRemoval(stops, at) };
}

/**
 * Is this stop the one that address names — the test the modal finds its own place with, asked
 * about a remembered stop instead of the open card.
 *
 * **A deck stop goes through all five parts of the grain and a plain one through `cardId`**, for
 * `CardDetailModal`'s reason: a deck can hold one printing in two piles and in two finishes, and
 * those are different rows that a removal removes one of. Comparing `cardId` alone would call a
 * cut Burn-spells Bolt "back" the moment the reader's Sideboard copy was drawn.
 *
 * **`oracleId` and `name` are deliberately not compared.** Both are facts *about* the card rather
 * than parts of its address, and `name` in particular is denormalized at write time — a stop that
 * matched on it would stop matching when a corpus refresh corrected a spelling.
 */
export function isSameStop(stop: CardWalkStop, address: CardWalkStop): boolean {
  if (address.deck !== null) {
    return stop.deck !== null && sameDeckSlot(stop.deck, address.deck);
  }
  return stop.deck === null && stop.cardId === address.cardId;
}

/**
 * Walk the modal back onto a removed card as soon as that card is on the walk again.
 *
 * Mounted once, by `CardDetailModal`, which is the one component in the app that reads the walk.
 *
 * ## The arming ref, which is the whole of what makes this correct
 *
 * **It fires on a _transition_ — absent, then present — and never on "the stop is there".** The
 * two surfaces this serves publish their walks at different moments relative to the write, and
 * only one of them has taken the row out by the time the modal is moved: `useDeck.setQuantity`
 * patches the deck's cache in `onMutate`, so a deck row is off the walk before the round trip
 * even returns, while the collection and the wishlist settle by invalidating a query and the
 * removed entry is still on the walk for as long as the refetch takes. Written as a plain
 * presence test this would therefore work on a deck and, on a collection, would put the reader
 * straight back on the card they had just deleted — one frame after moving them off it.
 *
 * So the watcher waits until it has *seen* the address leave the walk, and only then does a
 * reappearance mean anything. A ref rather than state, for `useHoldingsFreshness`' reason one
 * file over: this is an edge detector, and a re-render of its own would be one.
 *
 * ## The chain
 *
 * `paneReturns` is a stack and this pops one entry per reappearance, so two cards cut in a row
 * are two presses of Ctrl+Z and the modal follows both — the deck's undo cursor is LIFO, so the
 * rows come back in exactly the order they went. After a pop the effect re-runs against the next
 * entry down, which is still removed, and re-arms against it.
 *
 * ## What it answers, and why the caller wants it
 *
 * The **depth** of that stack, which is `DialogProps.caretPulse`: it changes on exactly the two
 * moments the app moves the reader without being asked, and those are the two moments a control
 * may have vanished from under their caret. Answered from here rather than selected a second
 * time by the host, because a second subscriber to the same field is a second opinion about when
 * a move happened.
 */
export function useReturnToRemovedCard(stops: readonly CardWalkStop[]): number {
  const returns = useAppStore((s) => s.paneReturns);
  const returnToRemovedCard = useAppStore((s) => s.returnToRemovedCard);
  const top = returns.length > 0 ? returns[returns.length - 1] : null;
  const sawItLeave = useRef(false);

  useEffect(() => {
    if (top === undefined || top === null) {
      sawItLeave.current = false;
      return;
    }
    const present = stops.some((stop) => isSameStop(stop, top));
    if (!present) {
      sawItLeave.current = true;
      return;
    }
    if (!sawItLeave.current) return;
    sawItLeave.current = false;
    returnToRemovedCard();
  }, [top, stops, returnToRemovedCard]);

  return returns.length;
}
