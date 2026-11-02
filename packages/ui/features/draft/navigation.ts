import { useAppStore } from "@/lib/store";

/**
 * Open a draft deck in Draft & Packs' own editor — where the draft's **Build** step happens
 * (spec §5). `App.tsx` draws `DeckEditor` with `host="draft"` in the Draft view while the store's
 * `draftDeckId` names a deck: an unsaved draft deck is apart from the reader's decks (no deck list
 * answers it), so its editor is not the Decks view's.
 *
 * **The view first, then the deck**, the quick search's order (`QuickSearch.tsx`), though here
 * it is habit rather than need: `setActiveView` leaves `draftDeckId` alone (see the store's doc).
 *
 * A plain function over the store rather than a hook, so the page can call it from a mutation's
 * `onSuccess` as readily as from a press.
 */
export function openDraftDeck(deckId: number): void {
  const { setActiveView, setDraftDeckId } = useAppStore.getState();
  setActiveView("draft");
  setDraftDeckId(deckId);
}

/**
 * Back to the Draft & Packs page from a draft deck's editor — the editor's `Draft & Packs` crumb,
 * Escape's floor there, and what **Discard** does once the deck is gone. The deck stays a draft
 * deck (unless it was discarded), listed under *Draft in progress*.
 */
export function returnToDraftPage(): void {
  const { setActiveView, setDraftDeckId } = useAppStore.getState();
  setDraftDeckId(null);
  setActiveView("draft");
}

/**
 * **Save deck**'s way on: the deck is one of the reader's decks now, so its editor is the Decks
 * view's. The Draft view's editor is closed first, so a later visit to Draft & Packs lands on its
 * page rather than on a deck that is no longer a draft; then the view, then the deck — the order
 * {@link openDraftDeck} explains, which here is the need: arriving at Decks hands back a *parked*
 * deck, and setting the id after it is what makes this deck the one on screen.
 */
export function openSavedDeck(deckId: number): void {
  const { setActiveView, setDraftDeckId, setOpenDeckId } = useAppStore.getState();
  setDraftDeckId(null);
  setActiveView("decks");
  setOpenDeckId(deckId);
}
