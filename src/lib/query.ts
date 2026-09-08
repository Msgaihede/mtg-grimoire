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
 * **Three files touch this data and none of them owns it.** `lib/useComboProgress.ts` invalidates
 * the root when a download reaches a terminal phase, `features/settings/useDataReset.ts`
 * invalidates it again after *Clear combos* has cleared and re-fetched, and the deck
 * editor's `DeckBracket` reads the status *and* one entry per deck it draws. None of the three
 * imports anything from the others, which is exactly how files come to agree on a string literal
 * by accident — and the agreement is load-bearing, because `invalidateQueries` matches by
 * **prefix**: a download that lands refills the open deck's advisory only while all three spell
 * the root the same way. Renaming one side would break that link with nothing going red, because
 * a stale advisory is a correct-looking one that is merely out of date — and the 30 s `staleTime`
 * above is exactly long enough to make it look deliberate.
 *
 * **The root still has writers after the feed stopped needing a reader, and checking that was the
 * point of the change rather than a formality.** What used to be here was Settings' `CombosPanel`
 * and its Refresh button, deleted when the download moved to launch. Both of the presses that
 * replaced it are indirect: the Local cache panel *clears*, and the launch refresh is a Rust task
 * nobody presses at all. That task writes SQLite and has never heard of TanStack, so
 * `useComboProgress`'s terminal event is the **whole** of how a finished download reaches an open
 * deck — without it the advisory would go on saying the list has never been downloaded for the
 * rest of the session after it arrived, which is the failure the never-ingested arm exists to
 * prevent, produced by the fix for it.
 *
 * **The deck gallery reads the same data and does not read this root at all.**
 * `useDeckBrackets` takes its combos off `deck_bracket_reads`, under `["decks", "brackets", …]`,
 * where they arrive alongside the cards they are estimated against — so an invalidation here
 * reaches no tile. Two surfaces answering one question through two roots is the thing to know
 * before assuming a fix to one has reached the other, and it is why `useComboProgress` invalidates
 * **both** on its terminal event rather than this one alone. With only this root, a download
 * landing while the gallery was on screen would refill an open deck's advisory and leave every
 * tile reading three signals until the next deck write fired `["decks"]`, or the wall was
 * remounted — a download half-applied to the screen, which is the shape a reader reports as a bug
 * even though `estimateBracket` answers a *floor* and such a tile is low rather than wrong.
 *
 * The fix is a second root on that event and was never a change to the keys here, which is the
 * part worth keeping: these three are what the data is filed under, and who invalidates them is
 * a fact about the hooks that watch the feed.
 *
 * `COMBOS_KEY` is the bare root rather than a list of leaves: a download replaces the whole table,
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

/**
 * The relay's own state — `ipc.syncRelayStatus`.
 *
 * **Here rather than in `SyncPanel`, because two panels move it and only one reads it.** The
 * Sync panel draws the address, what is waiting and when the last round trip finished; the
 * Needs-review panel never draws any of that, and yet every press of *Looks fine* changes two
 * of the three — clearing a sentence is a captured write, so it puts a new op on the pile and
 * drops `reviewCount` by one. A key one panel declared and the other imported would be the
 * combo feed's near-miss with the names swapped, and `COMBOS_KEY`'s paragraph above is the
 * whole argument.
 *
 * `["sync", …]` is already `PAIRING_KEY`'s prefix, declared just below, so the bare root
 * invalidates the pairing, the relay and the review queue at once — which is exactly what a
 * completed round trip has changed.
 */
export const SYNC_KEY: QueryKey = ["sync"];

/**
 * This device's pairing state, under one key — `ipc.syncPairingStatus`.
 *
 * **Moved here from `SyncPanel.tsx:36`, though not for the reason that file's own comment had
 * promised.** It pre-committed to this exact move "the moment a second surface" read the key,
 * naming the ribbon's sync indicator — but the indicator that shipped reads
 * `useDeviceSyncLive`'s `LiveState` off a Tauri event, never this query, so that trigger was
 * never actually met. What moved it is a plainer inconsistency: `SYNC_KEY` above was already
 * describing this key as its child, from a file that did not itself declare it. `COMBOS_KEY`'s
 * reason at the top of this file still holds either way — two features must not spell one
 * prefix two ways — this is just the honest account of which trigger fired.
 */
export const PAIRING_KEY: QueryKey = ["sync", "pairing"];

/** The relay address, what is waiting, and the last round trip — `ipc.syncRelayStatus`. */
export const RELAY_KEY: QueryKey = ["sync", "relay"];

/** Every row carrying a sentence for the reader — `ipc.syncReviewList`. */
export const REVIEW_KEY: QueryKey = ["sync", "review"];

/**
 * What a device sync can have changed on screen.
 *
 * **Not `SYNC_INVALIDATED`.** That is the *corpus* root set (`src/lib/useSyncInvalidation.ts`)
 * and carries `["sets"]`, whose `staleTime` is `Infinity`, and `["card"]` — neither of which
 * any relay op can touch: a sync applies pulled ops to the reader's own rows, it never rebuilds
 * the Scryfall corpus. `OWNED_WRITE_KEYS` is already the constant for "a user write happened",
 * which is exactly what applying a pulled op is; the relay adds `SYNC_KEY` on top, because
 * `RelayStatus.pending`, `lastSyncAt` and `reviewCount` all move on a round trip too.
 */
export const DEVICE_SYNC_INVALIDATED: readonly QueryKey[] = [...OWNED_WRITE_KEYS, SYNC_KEY];
