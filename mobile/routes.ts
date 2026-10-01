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
