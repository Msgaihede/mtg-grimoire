import type { ComponentType } from "react";
import type { CardDetail, DeckVariant } from "@/lib/ipc";
import type { Place } from "../../routes";
import { AddToDeck } from "./AddToDeck";
import { CollectionAdd } from "./CollectionAdd";
import { WishlistAdd } from "./WishlistAdd";

/**
 * What every action row on the card sheet is handed — the card on screen, where the reader is, and
 * which of the open deck's lists the page beneath is showing (the face's own state, not the URL's).
 */
export interface ActionContext {
  card: CardDetail;
  place: Place;
  /** The list the deck page beneath has been switched to, or `null` for the one it opened on. */
  deckPicked: DeckVariant | null;
}

/** One kind of action the sheet can offer, and when it offers it. */
interface ActionSlot {
  id: string;
  /** Whether this card, over this place, is one the action is about at all. */
  applies: (context: ActionContext) => boolean;
  Row: ComponentType<ActionContext>;
}

/**
 * **The slot list** — every action the card sheet can draw at its top, in the order it draws them.
 * A new action is a file of its own and one entry here, so two steps adding actions in parallel
 * touch one line each rather than the same component.
 *
 * - `deck` — `Add to <deck>`, only over a deck page (step 3.5a).
 * - `collection` — `Add to collection`, one copy into the root, on every card (step 3.5b).
 * - `wishlist` — `Add to wishlist`, this printing or any, on every card (step 3.5b).
 */
const SLOTS: readonly ActionSlot[] = [
  { id: "deck", applies: ({ place }) => place.deckId !== null, Row: AddToDeck },
  { id: "collection", applies: () => true, Row: CollectionAdd },
  { id: "wishlist", applies: () => true, Row: WishlistAdd },
];

/**
 * The card sheet's actions — **at the top of the sheet**, under the picture's heading and above
 * everything it says about the card, because a reader who opened a card to do something with it
 * should not scroll past its rules text to find the press. Draws nothing at all where no slot
 * applies — since step 3.5b the collection's and the wishlist's adds apply to every card, so that
 * is no card today.
 */
export function ActionsSection(context: ActionContext) {
  const rows = SLOTS.filter((slot) => slot.applies(context));
  if (rows.length === 0) return null;
  return (
    <section aria-label="Actions" className="flex flex-col gap-2">
      {rows.map(({ id, Row }) => (
        <Row key={id} {...context} />
      ))}
    </section>
  );
}
