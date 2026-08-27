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

/**
 * The combo feed's query roots, spelled once.
 *
 * **Two features read this data and neither owns it.** Settings' `CombosPanel` refreshes the feed
 * and invalidates it; the deck editor's `DeckBracket` reads the status *and* one entry per deck
 * it draws. They arrived in one branch from two hands, which is exactly how two files come to
 * agree on a string literal by accident — and the agreement is load-bearing, because
 * `invalidateQueries` matches by **prefix**: a refresh in Settings refills the open deck's
 * advisory only while both files spell the root the same way. Renaming one side would break that
 * link with nothing going red, because a stale advisory is a correct-looking one that is merely
 * out of date — and the 30 s `staleTime` above is exactly long enough to make it look deliberate.
 *
 * `COMBOS_KEY` is the bare root rather than a list of leaves: a refresh replaces the whole table,
 * so everything read out of it goes stale at once.
 */
export const COMBOS_KEY: QueryKey = ["combos"];

/** Whether the feed has ever been ingested, and how old it is — `ipc.combosStatus`. */
export const COMBOS_STATUS_KEY: QueryKey = ["combos", "status"];

/**
 * Which combos a set of cards fully contains — `ipc.combosForCards`.
 *
 * **Keyed on the card ids themselves, which is what makes a deck edit produce a fresh answer with
 * no invalidation at all.** A `["combos", "forCards", deckId]` key would instead have to be right
 * about every write that can change what is in a deck — an add, a move between piles, a category
 * switched off — and `staleTime` would hide whichever one was forgotten for half a minute.
 *
 * Sort and dedupe the ids before calling: an unsorted list makes a regroup look like a new
 * question, and the answer does not depend on the order.
 */
export const combosForCardsKey = (sortedCardIds: readonly string[]): QueryKey => [
  "combos",
  "forCards",
  sortedCardIds,
];
