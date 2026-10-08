/**
 * How one deck is **read** — the query key and the command behind it, and the three words every
 * deck hook in this folder shares — with nothing that writes.
 *
 * **A module of its own so that a deck can be read without `useDeck.ts`'s writes.** Those reach
 * the app store (a write re-anchors the card modal on the row it moved), and the phone face may
 * not import anything that does (`apps/light/phone/fence.test.ts`). Splitting the read out is what
 * lets the phone's deck page ask under **the desktop editor's own key**, so a resize across the
 * 1024px floor paints the deck from the cache rather than reading it again — and so every deck
 * write either face makes, which invalidates `["decks"]`, refreshes both.
 *
 * `useDeck.ts` re-exports the three shared words, so no caller of that file had to change.
 */
import type { QueryKey } from "@tanstack/react-query";
import { ipc, type DeckDetail, type DeckVariant } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";

/**
 * The variant every surface that has no opinion reads.
 *
 * Schema v8 gave every deck two lists — `live`, what is sleeved up, and `theory`, what it is
 * being built toward — and this is the one the app meant by "the deck" before the column
 * existed. It is a **default argument** rather than a constant now: a caller with a Live/Theory
 * control passes what the reader chose, and a caller that has none (the sidebar's drop target,
 * the card pane) gets the deck as it stands.
 *
 * Exported so every deck hook in this folder defaults to the same word from the same place.
 */
export const DEFAULT_VARIANT: DeckVariant = "live";

/**
 * What an add is filed under when the caller names no category.
 *
 * `deck_add_card` takes either an explicit `categoryId` — a drop onto a column the reader
 * pointed at — or a **name** to find-or-create. The surfaces that have no column to point at
 * (the docked panel's Add button, the sidebar's Decks drop target) send a name, and this is
 * that name: the v8 migration's own word for the pile it put every legacy main-deck row in, so
 * a deck that predates categories and one made since agree about where a plain add goes.
 *
 * **A fence now rather than the usual answer.** `autoCategoryFor` files an add that names no
 * category (see {@link useDeck}'s `addCard`), and every surface in the app hands this hook a
 * type line to file by — so this word is what is left for a caller that has neither a category
 * nor a type line, which is a shape the app does not currently produce. It is kept because the
 * alternative is filing such a card under `UNCATEGORIZED`, and "the caller told us nothing" and
 * "the card's type line is unrecognised" are different states that should not land in one pile.
 *
 * Exported for two readers: `useDeckMeta` has to know which piles are *nobody's choice* before
 * it is allowed to empty them, and a second copy of this string there would be a second place
 * to keep one word.
 */
export const DEFAULT_CATEGORY_NAME = "Main deck";

/**
 * The open deck's id, or a refusal.
 *
 * Every write below is reachable only from an editor, which is only mounted for a deck that
 * is open — so this throw is a fence rather than a path. It throws instead of silently doing
 * nothing because a mutation that resolves without writing is a stepper that looks like it
 * worked, and the rejection lands in the mutation's error state, which the editor already
 * renders.
 *
 * Exported because every deck hook in this folder takes a nullable id for the same reason —
 * the view mounts whether or not a deck is open — and one fence is one sentence to keep.
 */
export function opened(id: number | null): number {
  if (id === null) throw new Error("No deck is open.");
  return id;
}

/**
 * The key one deck's read is cached under: `["decks", "detail", id, variant, marketplace]`.
 *
 * Under `["decks"]` so every deck write refreshes it; the variant and the marketplace are in it
 * for the reasons {@link deckDetailQuery} gives. Written once, here, because two spellings of one
 * key are two caches that stop agreeing the first time either changes.
 */
export function deckDetailKey(
  id: number | null,
  variant: DeckVariant,
  marketplaceId: MarketplaceId,
): QueryKey {
  return ["decks", "detail", id, variant, marketplaceId];
}

/**
 * One deck's read — `deck_get` over one of its two lists, priced at one marketplace — as the
 * options a `useQuery` or a `fetchQuery` takes.
 *
 * **Switching variant is a key change, not a refetch**, so Live and Theory are two cached answers
 * and flipping back is instant; **the marketplace is in the key** because `deck_get` prices every
 * row with it. `useDeck` argues both at length.
 *
 * `enabled` is false for a `null` id: a surface that mounts whether or not a deck is open must not
 * ask the backend for deck `null`.
 */
export function deckDetailQuery(
  id: number | null,
  variant: DeckVariant,
  marketplaceId: MarketplaceId,
): {
  queryKey: QueryKey;
  queryFn: () => Promise<DeckDetail | null>;
  enabled: boolean;
} {
  return {
    queryKey: deckDetailKey(id, variant, marketplaceId),
    queryFn: () => ipc.deckGet(opened(id), variant, marketplaceId),
    enabled: id !== null,
  };
}
