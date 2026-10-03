import { isLightView, LIGHT_START, type LightView } from "@/lib/edition";

/**
 * Where the reader is, as the URL says it.
 *
 * `/search`, `/decks`, `/decks/12`, `/collection`, `/wishlist`, `/scanner`, `/settings`,
 * `?folder=<id>` on the deck gallery, and `?card=<id>` over any of them. Pure, and the one place the two faces agree on a spelling: the
 * phone face reads and writes it through its router, and the desktop face through one adapter
 * that maps it onto the store.
 */
export interface Place {
  view: LightView;
  /** The open deck. Only ever non-null while `view` is `"decks"`. */
  deckId: number | null;
  /** The open card, over whatever destination is behind it. */
  cardId: string | null;
  /**
   * The deck folder the gallery is standing in — `?folder=<id>` on `/decks`, and only ever
   * present while `view` is `"decks"` and no deck is open.
   *
   * **A place rather than a page's state**, so Back closes a folder (Android's gesture included)
   * and a deck's way back lands in the folder it is filed in rather than at the top of the
   * cabinet. **Optional, and absent rather than `null` at the top level**: every place spelled
   * before folders were in the grammar is still a whole place, and `parsePlace` answers the same
   * three fields it always did for every URL without the parameter. The desktop face does not
   * read it — its gallery keeps its drawer in the page — so a crossing drops it, as it drops any
   * other filter state.
   */
  folderId?: number | null;
}

/** A positive integer and nothing else — `Number("12abc")` is `NaN`, but `Number("1.5")` is not. */
const DECK_ID = /^[1-9]\d*$/;

/**
 * A path segment or a parameter as a row id — a deck's or a folder's — or `null` for anything
 * that is not one.
 *
 * **The pattern is not enough on its own**: twenty nines are all digits and parse to `1e20`,
 * which is no deck's id, which {@link placeHref} would spell back as a different number than the
 * one typed, and which Rust cannot deserialise as an integer. An id is a *safe* integer or it is
 * malformed like any other.
 */
function idOf(segment: string): number | null {
  if (!DECK_ID.test(segment)) return null;
  const id = Number(segment);
  return Number.isSafeInteger(id) ? id : null;
}

/** A URL as a {@link Place}. **Total**: a path that names nothing opens on {@link LIGHT_START}. */
export function parsePlace(pathname: string, search: string): Place {
  const [head = "", tail = ""] = pathname.split("/").filter((part) => part.length > 0);
  const view = isLightView(head) ? head : LIGHT_START;
  const deckId = view === "decks" ? idOf(tail) : null;
  const params = new URLSearchParams(search);
  const card = params.get("card");
  const place: Place = { view, deckId, cardId: card !== null && card.length > 0 ? card : null };
  // A folder only on the gallery itself: under an open deck it would name a drawer nothing draws.
  const folderId = view === "decks" && deckId === null ? idOf(params.get("folder") ?? "") : null;
  return folderId === null ? place : { ...place, folderId };
}

export function placeHref(place: Place): string {
  const path =
    place.view === "decks" && place.deckId !== null ? `/decks/${place.deckId}` : `/${place.view}`;
  const query: string[] = [];
  const folder = place.folderId ?? null;
  if (place.view === "decks" && place.deckId === null && folder !== null) {
    query.push(`folder=${folder}`);
  }
  if (place.cardId !== null) query.push(`card=${encodeURIComponent(place.cardId)}`);
  return query.length === 0 ? path : `${path}?${query.join("&")}`;
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
