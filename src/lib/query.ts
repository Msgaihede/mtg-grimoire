import { QueryClient, type QueryKey } from "@tanstack/react-query";
import type { SupporterStatus } from "@/lib/ipc";
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
 * Every combo that **names** one card, at one search and one pair of filters —
 * `ipc.combosForCard`.
 *
 * The third key under {@link COMBOS_KEY}, beside {@link COMBOS_STATUS_KEY} and
 * {@link combosForCardsKey}, and it is under that root for the root's own reason: a download
 * replaces the whole table, so everything read out of it goes stale at once and one
 * invalidation of `["combos"]` reaches all three.
 *
 * **`forCard`, not `forCards`, and one character between two keys is worth saying out loud.**
 * These are opposite questions over one table — that one asks which combos a *pile* of printings
 * fully contains (the deck advisory), this one asks what a *single* card is part of and claims
 * nothing about the other pieces. Spelling both `"forCards"` would not literally alias two cache
 * entries, since the third segment differs; what it would do is put them under one prefix, and
 * every prefix-scoped operation TanStack has — `invalidateQueries`, `cancelQueries`,
 * `removeQueries`, `getQueriesData` — matches by prefix. So a targeted invalidation of the
 * cheap read would silently throw away the expensive one, and the failure would look like a
 * bracket advisory that refetches for no reason rather than like a naming mistake.
 *
 * **Keyed on the oracle id and never a printing id**, which is `oracleTagsKey`'s argument
 * (`features/card/OracleTagsDialog.tsx`) arriving at the same place: a combo is a fact about a
 * card, so all four Lightning Bolts share one answer and a printing-keyed read would miss the
 * cache every time a reader stepped between two printings of the card they are already reading
 * about.
 *
 * **All three narrowings are in the key rather than applied to a cached superset, because none of
 * them is a subset operation.** `search`, `cardCount` and `ownedOnly` narrow in SQL *before* the
 * page is cut, so a filtered answer is a different question and not a slice of the unfiltered
 * one. Filtering on this side instead would filter page 1 of a match set that can run to
 * thousands of rows — and the answer it produces is confidently wrong rather than merely
 * incomplete: a card whose first page happens to be all four- and five-card combos would read "no
 * two-card combos" to a reader whose card has forty of them, with nothing on screen suggesting
 * there was more to fetch.
 *
 * **`search` is the third of those and the one the argument was written for.** Ashnod's Altar is
 * in **6 044** combos (measured), which is what the box exists to narrow; a client-side filter
 * over page 1 of those would tell a reader the card has no combo with Thassa in it while forty
 * sit on page 12. Same sentence as the two above, said once here and pointed at from
 * `ipc.ts` rather than repeated there.
 *
 * **`""` is folded into `null` here, and this helper is the floor rather than one participant in
 * a shared rule.** A cleared search box produces `""` on every clear — the ✕, a select-all and
 * delete, the last backspace — while `null` is what nothing-typed means everywhere else. Left
 * alone the two spellings of one question are two cache entries: a refetch and a fresh loading
 * state each time a reader empties the box, for an answer already in hand, and one that could
 * never differ, since `combos_for_card` reads `""` and `None` as the same request.
 *
 * It belongs **here** because the cache is the only thing the difference costs. `ipc.combosForCard`
 * therefore forwards `search` verbatim and adds no rule of its own — that would be the same rule
 * written twice, which is the drift these comments exist to prevent — and this fold is total, so
 * no future caller can split the cache by handing over an empty box.
 *
 * **A caller may still normalise *further*, and `CombosDialog` does: it trims.** That is a
 * different statement and not a second copy of this one — a trim changes what is **sent**
 * (`"bolt "` and `"bolt"` become one request, which is a decision about what the box means), where
 * this fold changes only what is **filed**. They compose because the dialog trims before both the
 * key and the wire, so the key never disagrees with the question that was asked. **What must not
 * move into this helper is the trim itself**: a key that trimmed what a caller sent untrimmed
 * would file `" thassa"` and `"thassa"` together while the two produced different pages, which is
 * this rule's own failure arriving from the other direction.
 *
 * **`limit` and `offset` are deliberately absent**, which is a constraint on the caller and not
 * an oversight: pages of one question belong under one key. Page with `useInfiniteQuery`, which
 * carries its own page param — a plain `useQuery` per offset would write every page over the
 * last one here.
 *
 * The arguments are in `CardCombosQuery`'s own order, which is `combos_for_card`'s parameter
 * order: three files describe one call and an order that agrees is the cheapest way to check it.
 */
export const cardCombosKey = (
  oracleId: string,
  search: string | null,
  cardCount: number | null,
  ownedOnly: boolean,
): QueryKey => [
  "combos",
  "forCard",
  oracleId,
  // The one place `""` becomes `null`, per the paragraph above — deliberately `=== ""` and not
  // `|| null`, which would swallow `"0"`, and not a `.trim()`, which would file two different
  // requests under one key.
  search === "" ? null : search,
  cardCount,
  ownedOnly,
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

/**
 * This device's membership — `ipc.syncSupporterStatus`.
 *
 * **Moved here from `SyncPanel.tsx` on 2026-09-08, and unlike {@link PAIRING_KEY} the trigger
 * that file pre-committed to is the one that actually fired.** Its comment read *"nothing else
 * in the window reads this one… the moment a second surface does read it, it moves too, for
 * `COMBOS_KEY`'s reason"*. The second surface is the collection cabinet's Share control
 * (`features/collection/ShareFolderMenu.tsx`), which hides itself for a reader who has connected
 * nothing (sharing spec §9) and therefore has to ask the same question the Settings panel asks.
 *
 * It sits **under** {@link SYNC_KEY}, which is what makes a finished round trip re-read it — a
 * trip refused with a 401 is how a lapse reaches a reader who never opened Patreon.
 */
export const SUPPORTER_KEY: QueryKey = ["sync", "supporter"];

/**
 * The membership in one word — and the three that must never be spelled the same way.
 *
 * `never` and `ended` arrive from the backend as the **same two fields**: `entitled: false`
 * with `status: "dead"`. They are not the same state and they do not get the same sentence. A
 * reader who has not connected is looking at a button; a reader whose pledge stopped is looking
 * at a renewal and at a paragraph saying their collection is untouched (sync spec §7.1), and
 * telling them *Not connected* would be the app forgetting they were ever here.
 *
 * **`groupBound` is the whole of what separates them, and `since` cannot do it.** That is the
 * trap the Rust names at `SupporterStatus::group_bound` and it was worth one bug before this
 * comment existed: `entitlement::revoke` stores `("dead", None)`, so a lapsed device and a
 * device out of the box read the *same three fields* — `entitled: false`, `status: "dead"`,
 * `since: null`. `group_bound` is `entitlement::membership_ended` crossing the wire, and it is
 * the only signal that remembers this device was ever bound to an entitlement.
 *
 * **A `"dead"` status on an *entitled* device is not an ending either**, and that is the second
 * trap. It is reachable from both sides of the grant: the device that pressed Connect holds a
 * refresh secret, and `store_grant` and `store_status` are separate calls, so a status row can
 * be absent while the secret is live — and an absent row defaults to `"dead"`. It is
 * supporting; it simply has not been told a date yet, which is what `SyncPanel`'s dateless
 * *Supporting* line is for.
 *
 * **`grace` is a third thing and not a gentler `dead`** (sync spec §7.2). Patreon is retrying a
 * card; tokens are still minted and sync still works. Drawn as a cancellation it would punish a
 * reader for something they did not decide, and hiding *Sync now* would make that punishment
 * real.
 *
 * `unknown` is the read in flight or refused, and it is why `relayState` takes this rather than
 * a boolean: `false` for "not answered yet" and `false` for "not a supporter" are the same value
 * and very different sentences. The Share control folds it in with `never` and says why at its
 * own site — the one question those two states answer the same way.
 *
 * **Here rather than beside the panel that draws its sentences**, for the reason above the key:
 * two surfaces now read the membership, and a *reading* of four fields that each one derived for
 * itself is the same drift a key spelled twice would be, with a worse failure — the ordering
 * below is load-bearing and a second copy would not carry the argument for it.
 */
export type SupporterState = "unknown" | "active" | "grace" | "ended" | "never";

export function supporterState(status: SupporterStatus | null): SupporterState {
  if (status === null) return "unknown";
  // **`entitled` is asked first, and the order is load-bearing rather than tidy.** It is the
  // question the relay's own answer settles — will it mint this device a token — and a device
  // it will mint for has not ended anything. A build that asked `status` first read the second
  // device as lapsed: `store_grant` and `store_status` are separate calls, `supporter_state`
  // defaults an absent row to `"dead"`, and a phone whose desktop had just paid drew
  // *Membership ended*. The order matters more now, not less: `entitlement::membership_ended`
  // is `refresh_secret.is_none() && SUPPORTER_STATUS.is_some()`, which a device entitled
  // through its *group* satisfies — so `groupBound` below reads `true` for a membership that
  // has not ended at all, and this line is the whole of what stops it being drawn as one.
  if (status.entitled) return status.status === "grace" ? "grace" : "active";
  // `groupBound`, never `since` — see above. A revoked grant deletes the date with the secret.
  return status.groupBound ? "ended" : "never";
}

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
