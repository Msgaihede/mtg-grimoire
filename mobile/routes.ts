import { isLightView, LIGHT_START, type LightView } from "@/lib/edition";

/**
 * Where the reader is, as the URL says it.
 *
 * `/search`, `/decks`, `/decks/12`, `/collection`, `/wishlist`, `/scanner`, `/settings`, and
 * `?card=<id>` over any of them. Pure, and the one place the two faces agree on a spelling: the
 * phone face reads and writes it through its router, and the desktop face through one adapter
 * that maps it onto the store.
 */
export interface Place {
  view: LightView;
  /** The open deck. Only ever non-null while `view` is `"decks"`. */
  deckId: number | null;
  /** The open card, over whatever destination is behind it. */
  cardId: string | null;
}

/** A positive integer and nothing else — `Number("12abc")` is `NaN`, but `Number("1.5")` is not. */
const DECK_ID = /^[1-9]\d*$/;

/**
 * A path segment as a deck id, or `null` for anything that is not one.
 *
 * **The pattern is not enough on its own**: twenty nines are all digits and parse to `1e20`,
 * which is no deck's id, which {@link placeHref} would spell back as a different number than the
 * one typed, and which Rust cannot deserialise as an integer. An id is a *safe* integer or it is
 * malformed like any other.
 */
function deckIdOf(segment: string): number | null {
  if (!DECK_ID.test(segment)) return null;
  const id = Number(segment);
  return Number.isSafeInteger(id) ? id : null;
}

/** A URL as a {@link Place}. **Total**: a path that names nothing opens on {@link LIGHT_START}. */
export function parsePlace(pathname: string, search: string): Place {
  const [head = "", tail = ""] = pathname.split("/").filter((part) => part.length > 0);
  const view = isLightView(head) ? head : LIGHT_START;
  const deckId = view === "decks" ? deckIdOf(tail) : null;
  const card = new URLSearchParams(search).get("card");
  return { view, deckId, cardId: card !== null && card.length > 0 ? card : null };
}

export function placeHref(place: Place): string {
  const path =
    place.view === "decks" && place.deckId !== null ? `/decks/${place.deckId}` : `/${place.view}`;
  return place.cardId === null ? path : `${path}?card=${encodeURIComponent(place.cardId)}`;
}

/**
 * What a history entry's state says about how the light app wrote it.
 *
 * **One vocabulary for both faces, because an entry one face wrote is the entry the other face
 * stands on after a crossing**: the phone face pushes a card, a resize hands that entry to the
 * desktop face, and the desktop face's close has to know a Back is what put it there.
 *
 * - {@link PUSHED} — the phone router pushed this entry. **On an entry that carries a card, the
 *   entry directly beneath it is the same place without the card**: the phone face opens a card
 *   by a push over the page it is on and steps from one card to another by a replace that keeps
 *   the mark. Both faces' closes lean on that, so neither may write a card onto a marked page.
 * - {@link OVERLAID} — the desktop face wrote a card onto this entry by replace. The card is a
 *   modal over the page this entry already was, so what is beneath it is whatever was beneath
 *   that page.
 * - Anything else, `null` above all — nothing is known: a cold load, a link, a bookmark.
 */
export const PUSHED = { pushed: true } as const;

/** See {@link PUSHED}. */
export const OVERLAID = { overlaid: true } as const;

export function isPushed(state: unknown): boolean {
  return typeof state === "object" && state !== null && "pushed" in state && state.pushed === true;
}

export function isOverlaid(state: unknown): boolean {
  return (
    typeof state === "object" && state !== null && "overlaid" in state && state.overlaid === true
  );
}
