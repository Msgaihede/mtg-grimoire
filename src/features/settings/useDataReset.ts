import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { useState } from "react";
import { ipc } from "@/lib/ipc";
import { COMBOS_KEY } from "@/lib/query";
import { writeFailure, type Write } from "@/lib/writes";
import { useFeedDownload } from "@/pwa/FeedDownloadProvider";
import {
  cacheOutcome,
  collectionOutcome,
  combosOutcome,
  decksOutcome,
  wishlistOutcome,
} from "./clearOutcome";

/**
 * The five things Settings can throw away, and what the cache has to be told afterwards.
 *
 * Two hooks rather than one, matching the two panels: the three destructive clears share a
 * status line and are confirmed by typing a word, and the two local-cache sweeps share neither.
 * Folding them into one hook would give the cache panel three mutations it must not show and
 * give the danger zone two more its confirmation does not cover.
 *
 * **The invalidation is the interesting half.** A clear empties a table the query cache has
 * already answered from, and — for the collection — several tables it has *joined*: every card
 * in the search wall carries an `ownedQuantity`, every card in a deck carries what that deck's
 * own collection group holds, and both are `LEFT JOIN`s into `collection_entries` rather than
 * fields anything would think to refresh. Each mutation names the roots it can have made wrong and no more,
 * which is written out at each site.
 */

/** One button's worth of clear: press it, and whether it is in flight. */
export interface ClearAction {
  run: () => void;
  pending: boolean;
}

/** The one sentence a panel shows under its buttons, and how loudly. */
export interface ClearStatus {
  tone: "problem" | "plain";
  text: string;
}

/** Mark a set of roots stale; only the queries actually on screen pay for a refetch. */
function invalidate(client: QueryClient, roots: readonly QueryKey[]): void {
  for (const queryKey of roots) void client.invalidateQueries({ queryKey });
}

/**
 * Emptying the collection makes four roots wrong, and only one of them is obvious.
 *
 * * `["collection"]` — the table itself and its summary.
 * * `["cards"]` — the search wall. `CardSummary.ownedQuantity` and the facet response's
 *   `owned` tri-state both count `collection_entries`, so every row and the Owned chip above
 *   them are now describing a collection that is gone.
 * * `["card"]` — the detail pane, whose printings list carries the same count per printing.
 * * `["decks"]` — `DeckCard.ownedQuantity` counts `collection_entries`, and the wipe just deleted
 *   all of them. On a **live** row that is the deck's own group at `(card_id, finish)`; on a
 *   **theory** row it is the wider `Availability::ForDeck` pool since 2026-09-09 (issue #435), and
 *   a wipe empties both by construction. Since schema v25 there is no claim ledger to delete: a
 *   copy is in a deck because its row is filed there, so clearing the collection is what takes it
 *   out.
 *
 * **`["wishlist"]` was the fifth and is deliberately not here any more.** It was on the list
 * because a wish counted the copies that already filled it (`WishRow.ownedQuantity`), so a wipe
 * sent every one of those figures to zero. The wishlist reads nothing out of `collection_entries`
 * now — it is the reader's own list, kept by hand — so a collection clear leaves every row on
 * that page saying exactly what it said before, and refetching it would be work for a figure
 * that cannot have moved.
 *
 * Not `["sets"]`, whose `staleTime` is `Infinity` and which only a sync can change.
 */
const COLLECTION_ROOTS = [["collection"], ["cards"], ["card"], ["decks"]];

/** The wishlist's own table, plus the two surfaces that draw a `wishlisted` flag per card. */
const WISHLIST_ROOTS = [["wishlist"], ["cards"], ["card"]];

/**
 * The decks, and the collection with them.
 *
 * **The second root is schema v25's, and the sentence it replaces is now false.** This read
 * *"a deck holds an allocation against a collection row, and nothing the collection page or the
 * search wall draws is derived from it"* — true while a claim ledger stood beside the cards.
 * Since v25 a deck's group **is** a `collection_folders` row: `clear_decks` cascades every one
 * of them away and files the copies they were holding into `Recently removed` first, so the
 * folder tree, both folder cards, the summary and the list are all describing a world that is
 * gone. `lib/query.ts` caches 30 s, so leaving that root out is a ghost row rather than a slow
 * refresh.
 *
 * **The two card roots stay out, and that absence is still worth stating.** A copy that changes
 * folder is a copy the reader still owns — no quantity moves, and `CardSummary.ownedQuantity`
 * is a sum over quantities, finish-blind and folder-blind — so the search wall cannot read
 * differently afterwards. (The wishlist could not either, and no longer for this reason: it
 * reads nothing out of `collection_entries` at all.)
 */
const DECK_ROOTS = [["decks"], ["collection"]];

/**
 * The combo feed's one root, and it is a root rather than a list of leaves on purpose.
 *
 * `@/lib/query` owns the literal and says why: two features read this data and neither owns it,
 * so the prefix is spelled once or the link between a refresh here and the deck editor's bracket
 * advisory breaks with nothing going red. Everything under it — the status line and every deck's
 * `combos_for_cards` answer — was read out of rows this press has just replaced wholesale, and
 * `invalidateQueries` matches by prefix, so the bare root is exactly the set.
 */
const COMBO_ROOTS = [COMBOS_KEY];

/**
 * The three irreversible clears, and the one sentence they share.
 *
 * **One `outcome` for all three, and that is the rule rather than a shortcut**: `@/lib/writes`
 * settles that the most recently *started* write owns the banner, and one piece of state is what
 * makes that structural here. It is cleared on `onMutate` so a fresh press never leaves the
 * previous clear's sentence standing under a button that is still working.
 *
 * The refusal half goes through {@link writeFailure} unchanged, which reads the same rule off
 * the three mutations' `submittedAt`. So a refused clear replaces a successful one's sentence,
 * and a successful one replaces a refusal — in both directions, without either half having to
 * know about the other.
 */
export function useDangerZone(): {
  collection: ClearAction;
  wishlist: ClearAction;
  decks: ClearAction;
  status: ClearStatus | null;
} {
  const client = useQueryClient();
  const [outcome, setOutcome] = useState<string | null>(null);
  const started = () => setOutcome(null);

  const collection = useMutation({
    mutationFn: () => ipc.collectionClear(),
    onMutate: started,
    onSuccess: (r) => {
      invalidate(client, COLLECTION_ROOTS);
      setOutcome(collectionOutcome(r));
    },
  });

  const wishlist = useMutation({
    mutationFn: () => ipc.wishlistClear(),
    onMutate: started,
    onSuccess: (entries) => {
      invalidate(client, WISHLIST_ROOTS);
      setOutcome(wishlistOutcome(entries));
    },
  });

  const decks = useMutation({
    mutationFn: () => ipc.decksClear(),
    onMutate: started,
    onSuccess: (r) => {
      invalidate(client, DECK_ROOTS);
      setOutcome(decksOutcome(r));
    },
  });

  return {
    collection: { run: () => collection.mutate(), pending: collection.isPending },
    wishlist: { run: () => wishlist.mutate(), pending: wishlist.isPending },
    decks: { run: () => decks.mutate(), pending: decks.isPending },
    status: statusOf([collection, wishlist, decks], outcome),
  };
}

/**
 * The two rebuildable things the Local cache panel throws away, and the one sentence they share.
 *
 * **Both are `corpus.db` and `data/` rather than anything the reader made**, which is the whole
 * of why they are one panel above the fold instead of two more rows in the danger zone: schema
 * 27 split the reader's own tables out of the rebuildable ones precisely so that a button over
 * this half risks nothing. `useDangerZone`'s single `outcome` is the pattern followed here for
 * its stated reason — `@/lib/writes` settles that the most recently *started* write owns the
 * banner, and one piece of state is what makes that structural rather than a rule each site has
 * to remember.
 *
 * ## The image sweep destroys nothing and invalidates nothing
 *
 * **No query root goes stale, and that is worth saying out loud rather than leaving as an empty
 * line.** Nothing in the query cache describes the picture cache: card art is served over
 * `mtgimg://` by the protocol handler, outside TanStack Query entirely, and a picture already
 * decoded into a painted `<img>` stays correct — the bytes it was made from are simply no longer
 * on disk. The next request for a key that is gone is a miss, and a miss re-fetches. So the only
 * thing that half does after a success is say what it freed.
 *
 * **On the web target it is a different cache entirely, and that changes nothing here.**
 * `ipc.cacheClear()` is diverted in `src/lib/core/browser.ts` onto the service worker's
 * `IMAGE_CACHE` — there is no `data/images/` and no protocol handler in a browser, and the
 * pictures come straight from `cards.scryfall.io` into an `<img>`. Both are outside TanStack
 * Query for the same reason, both answer the same `CacheCleared`, and neither this hook nor
 * `CachePanel` takes a branch. The web half is `src/pwa/imageCacheClear.ts`.
 *
 * ## The combo clear is two calls in one mutation, and that is the whole design
 *
 * **`combos_clear` downloads nothing**, so a press that stopped there would leave a reader who
 * came here because the data looked wrong with no data at all — and the feed is fetched on a
 * weekly schedule they cannot see, so "it will come back eventually" is not an answer. The
 * re-download is therefore inside the same `mutationFn` rather than chained by the panel: one
 * `isPending` that stays true across both calls, one refusal that reaches the banner whichever
 * of the two produced it, and no window in which the button is idle over an empty table.
 *
 * **The invalidation is `onSettled` and not `onSuccess`, which is this hook's one departure from
 * `useDangerZone`'s shape.** The clear lands *first*: a refresh that then fails has still emptied
 * the tables, so every cached combo answer is describing rows that are gone. Invalidating only on
 * success would leave the open deck's bracket advisory quoting a combo list that no longer exists
 * for `lib/query.ts`'s 30 s, which is exactly long enough to look deliberate.
 *
 * **`askFirst` wraps the press rather than the mutation.** On desktop it is a synchronous
 * pass-through and this is the press it always was; on the web target it raises the
 * metered-connection prompt *before* 27.5 MB is spent, and a reader who answers Not now must
 * leave `isPending` false — which it does, because nothing has been started yet.
 */
export function useLocalCache(): {
  clear: ClearAction;
  combos: ClearAction;
  status: ClearStatus | null;
} {
  const client = useQueryClient();
  const [outcome, setOutcome] = useState<string | null>(null);
  const started = () => setOutcome(null);
  const askFirst = useFeedDownload();

  const cache = useMutation({
    mutationFn: () => ipc.cacheClear(),
    onMutate: started,
    onSuccess: (r) => setOutcome(cacheOutcome(r)),
  });

  const combos = useMutation({
    // Two awaits and no `Promise.all`: the second call is what refills what the first emptied,
    // and running them together would race a download against the delete it exists to undo.
    mutationFn: async () => {
      await ipc.combosClear();
      return await ipc.combosRefresh(true);
    },
    onMutate: started,
    onSettled: () => invalidate(client, COMBO_ROOTS),
    onSuccess: (r) => setOutcome(combosOutcome(r)),
  });

  return {
    clear: { run: () => cache.mutate(), pending: cache.isPending },
    combos: { run: () => askFirst("combos", () => combos.mutate()), pending: combos.isPending },
    status: statusOf([cache, combos], outcome),
  };
}

/**
 * A refusal beats a success, and the newest write beats an older one.
 *
 * `outcome` is already the newest success — it is one piece of state that every one of these
 * mutations overwrites — so all this has to decide is whether the newest write of the set is
 * currently holding an error, which is exactly {@link writeFailure}'s question.
 */
function statusOf(
  writes: readonly [Write, ...Write[]],
  outcome: string | null,
): ClearStatus | null {
  const failure = writeFailure(writes);
  if (failure) return { tone: "problem", text: failure };
  return outcome === null ? null : { tone: "plain", text: outcome };
}

/** The danger zone's state, as the panel takes it — `useErrorLog`'s `ErrorLog` shape, one panel
 *  over, so a test can build one by hand without reaching for a query client. */
export type DangerZone = ReturnType<typeof useDangerZone>;

/** The cache panel's, for {@link DangerZone}'s reason. */
export type LocalCache = ReturnType<typeof useLocalCache>;
