import { useAppStore, type PaneDeckContext } from "@/lib/store";

/**
 * Which of the app's card surfaces the open card was reached from — the modal's own vocabulary,
 * deliberately not {@link import("@/lib/store").ViewId}.
 *
 * Two differences, and each is why this is a type of its own. `deck` is not a view: the deck
 * editor is `activeView === "decks"` whether or not the card is one of the deck's rows, and this
 * word means the narrower thing (see {@link useCardModalScope}). And `settings` and the deck
 * *gallery* are not here at all, because no card can be open on either.
 */
export type CardModalSurface = "search" | "collection" | "wishlist" | "tags" | "deck";

/**
 * Everything the card modal's columns need to know about *where the card was opened from* —
 * spec §7's per-view table, resolved once.
 *
 * **It is a module of its own rather than a branch in each column, and that is the whole design.**
 * The rail, the controls and the action row each ask a slightly different question about the same
 * two store fields, and answering them at three sites is three chances to answer differently — a
 * quantity stepper bound to a deck row beside a category picker that is not drawn, say. One
 * answer, computed once, handed down as a prop.
 */
export interface CardModalScope {
  surface: CardModalSurface;
  /** The deck row the card was opened out of, or null. */
  deck: PaneDeckContext | null;
  /** What the quantity stepper edits, or null for "do not draw one". */
  quantity: "deck" | "owned" | "wished" | null;
  /** Deck category and tag pickers, and the deck-only rail actions. */
  deckControls: boolean;
}

/**
 * Resolve the scope from the two store fields that decide it — `paneDeckContext` and
 * `activeView`, both of which already existed for the docked pane.
 *
 * **The row wins over the view, and the two disagree in a case that is not rare**: the deck
 * editor's docked search panel opens cards that are *not* in the deck, so `activeView` is
 * `"decks"` while `paneDeckContext` is `null`. Deriving from the view alone would offer to set a
 * deck category, and to step a quantity, on a card the deck does not hold — a control that either
 * writes a row nobody asked for or refuses with nothing on screen explaining why. Reading the row
 * first makes "this card is a deck card" the same question the store already answers for the
 * swap offers, rather than a second opinion about it.
 *
 * The view is only consulted once the row has said no, and then only to name a wall. A wall the
 * app grows later that this does not name falls to `search`, which is the honest floor: the four
 * common rail entries and the action row, and no stepper — a stepper is a claim about a count
 * the surface keeps, and a surface that has not said it keeps one does not.
 */
export function useCardModalScope(): CardModalScope {
  const deck = useAppStore((s) => s.paneDeckContext);
  const view = useAppStore((s) => s.activeView);

  if (deck !== null) {
    return { surface: "deck", deck, quantity: "deck", deckControls: true };
  }
  const surface: CardModalSurface =
    view === "collection"
      ? "collection"
      : view === "wishlist"
        ? "wishlist"
        : view === "tags"
          ? "tags"
          : "search";
  // Only the two lists of things a reader *has* get a stepper, and it edits that list's own count.
  // The search wall and the tags wall are the corpus rather than a holding, so there is no number
  // on them to step — `Add to collection` and `Add to wishlist` in the action row are how a card
  // becomes one, which is the same door every other surface in the app uses.
  const quantity = surface === "collection" ? "owned" : surface === "wishlist" ? "wished" : null;
  return { surface, deck: null, quantity, deckControls: false };
}
