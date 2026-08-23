import { QueryClient, type QueryKey } from "@tanstack/react-query";
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});

/**
 * The four roots a write to `collection_entries` moves, beside nothing — this **is** the set.
 *
 * **Here rather than in either hook, because two writes in two features make the same change.**
 * The import's owned half (`features/transfer/import/useImport.ts`) and the deck builder's own
 * `own` add (`features/decks/useDeck.ts`) both file copies into a deck's group and both can
 * *record* a copy that was not written down before — and the branch shipped with those two
 * invalidating the same class of write two different ways, the deck one firing `["collection"]`
 * alone. A constant either file owned would have to be imported by the other, and they already
 * point at each other (`useImport` reads `DEFAULT_VARIANT` from `useDeck`), so the shared home
 * is here.
 *
 * **The 30 s `staleTime` above is what makes a missing root a wrong screen rather than a slow
 * one.** `invalidateQueries` matches by key **prefix**, and a mounted observer refetches only
 * when its query is actually invalidated — so a root left out is not a refetch that arrives late,
 * it is a number that goes on saying what it said before the press for half a minute:
 *
 * - `["collection"]` — the list, the summary, the folder census and the per-folder subtotals.
 * - `["wishlist"]` — its owned progress, which is a sum over the copies this write created.
 * - `["cards", "search"]` — `CardSummary.ownedQuantity`, the Owned badge on the very tile the
 *   reader pressed.
 * - `["decks"]` — every deck's detail, because copies filed in no group are what an open deck
 *   reads as spare, and a copy taken out of another deck's group is a card off *that* deck.
 */
export const OWNED_WRITE_KEYS: readonly QueryKey[] = [
  ["collection"],
  ["wishlist"],
  ["cards", "search"],
  ["decks"],
];
