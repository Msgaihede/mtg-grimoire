import { useAppStore } from "@/lib/store";

/**
 * Open a draft's deck in the Decks view's editor — where the draft's **Build** step happens
 * (spec §5): the editor draws its draft mode for a deck on the unsaved list (`useIsDraftDeck`).
 *
 * **The view first, then the deck**, the quick search's order (`QuickSearch.tsx`): `setActiveView`
 * hands back a *parked* deck on arrival at Decks, and setting the id after it is what makes this
 * deck the one on screen rather than whichever the reader left there earlier.
 *
 * A plain function over the store rather than a hook, so the page can call it from a mutation's
 * `onSuccess` as readily as from a press.
 */
export function openDraftDeck(deckId: number): void {
  const { setActiveView, setOpenDeckId } = useAppStore.getState();
  setActiveView("decks");
  setOpenDeckId(deckId);
}

/**
 * Back to the Draft & Packs page from a draft deck's editor — what **Discard** does once the deck
 * is gone.
 *
 * **The deck is closed before the view changes**, and that order is the point: leaving Decks with
 * an editor open *parks* its deck (`parkedDeckId`), so the next press of the Decks row would open
 * the editor again — on a deck that no longer exists. Closing it first parks nothing.
 */
export function returnToDraftPage(): void {
  const { setActiveView, setOpenDeckId } = useAppStore.getState();
  setOpenDeckId(null);
  setActiveView("draft");
}
