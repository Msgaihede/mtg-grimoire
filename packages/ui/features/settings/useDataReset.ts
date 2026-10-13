import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { ipc, ipcError } from "@/lib/ipc";
import { notify, type NoticeTone } from "@/lib/notifications";
import { COMBOS_KEY } from "@/lib/query";
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
 * Two hooks rather than one, matching the two panels: the three destructive clears are confirmed
 * by typing a word, and the two local-cache sweeps are not.
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

/**
 * A clear's outcome sentence, said as a toast: its first sentence is the title (no full stop, the
 * toast's own voice) and a second one, where there is one, the body.
 *
 * **The toast is the one receipt, on both faces.** Every clear here is confirmed in a dialog that
 * closes as the work starts, so the receipt arrives after the reader's attention has left the
 * button — and a clear is the destructive act the app's rule gives a receipt every time, with the
 * inbox keeping it (owner's rule, 2026-10-12: removing every card in the collection, the wishlist
 * or the decks is the largest edit those lists have). The panels used to repeat it in a line
 * under their buttons, only because the light app's phone face mounted no `Toaster`; it mounts
 * one now, so the line went and the toast and the inbox say it everywhere.
 */
function receipt(sentence: string, tone: NoticeTone): void {
  const cut = sentence.indexOf(". ");
  const title = (cut === -1 ? sentence : sentence.slice(0, cut)).replace(/\.$/, "");
  notify({ title, tone, ...(cut !== -1 && { body: sentence.slice(cut + 2) }) });
}

/** A refused clear, as a toast — {@link receipt}'s reason, and the inbox keeps it. */
function refused(title: string) {
  return (error: unknown) => void notify.error(title, { body: ipcError(error) });
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
 * The three irreversible clears.
 *
 * **Nothing here is held in state.** Each outcome is a toast — {@link receipt} for a result,
 * {@link refused} for a refusal — so there is no shared sentence for one press to overwrite or
 * clear on another's behalf: two presses are two notices, in the order they settled, and the
 * inbox keeps both.
 */
export function useDangerZone(): {
  collection: ClearAction;
  wishlist: ClearAction;
  decks: ClearAction;
} {
  const client = useQueryClient();

  const collection = useMutation({
    mutationFn: () => ipc.collectionClear(),
    onSuccess: (r) => {
      invalidate(client, COLLECTION_ROOTS);
      receipt(collectionOutcome(r), r.entries === 0 ? "info" : "success");
    },
    onError: refused("Couldn't clear the collection"),
  });

  const wishlist = useMutation({
    mutationFn: () => ipc.wishlistClear(),
    onSuccess: (entries) => {
      invalidate(client, WISHLIST_ROOTS);
      receipt(wishlistOutcome(entries), entries === 0 ? "info" : "success");
    },
    onError: refused("Couldn't clear the wishlist"),
  });

  const decks = useMutation({
    mutationFn: () => ipc.decksClear(),
    onSuccess: (r) => {
      invalidate(client, DECK_ROOTS);
      receipt(decksOutcome(r), r.decks + r.folders === 0 ? "info" : "success");
    },
    onError: refused("Couldn't clear the decks"),
  });

  return {
    collection: { run: () => collection.mutate(), pending: collection.isPending },
    wishlist: { run: () => wishlist.mutate(), pending: wishlist.isPending },
    decks: { run: () => decks.mutate(), pending: decks.isPending },
  };
}

/**
 * The two rebuildable things the Local cache panel throws away.
 *
 * **Both are `corpus.db` and `data/` rather than anything the reader made**, which is the whole
 * of why they are one panel above the fold instead of two more rows in the danger zone: schema
 * 27 split the reader's own tables out of the rebuildable ones precisely so that a button over
 * this half risks nothing. Like `useDangerZone`, it holds no state of its own: each outcome is
 * a toast.
 *
 * ## The image sweep destroys nothing and invalidates nothing
 *
 * **No query root goes stale, and that is worth saying out loud rather than leaving as an empty
 * line.** Nothing in the query cache describes the picture cache: card art is served over
 * `mtgimg://` by the protocol handler, outside TanStack Query entirely, and a picture already
 * decoded into a painted `<img>` stays correct — the bytes it was made from are simply no longer
 * on disk. The next request for a key that is gone is a miss, and a miss re-fetches. So the only
 * thing that half does after a success is say, in its toast, what it freed.
 *
 * ## The combo clear is two calls in one mutation, and that is the whole design
 *
 * **`combos_clear` downloads nothing**, so a press that stopped there would leave a reader who
 * came here because the data looked wrong with no data at all — and the feed is fetched on a
 * weekly schedule they cannot see, so "it will come back eventually" is not an answer. The
 * re-download is therefore inside the same `mutationFn` rather than chained by the panel: one
 * `isPending` that stays true across both calls, one refusal toast whichever
 * of the two produced it, and no window in which the button is idle over an empty table.
 *
 * **The invalidation is `onSettled` and not `onSuccess`, which is this hook's one departure from
 * `useDangerZone`'s shape.** The clear lands *first*: a refresh that then fails has still emptied
 * the tables, so every cached combo answer is describing rows that are gone. Invalidating only on
 * success would leave the open deck's bracket advisory quoting a combo list that no longer exists
 * for `lib/query.ts`'s 30 s, which is exactly long enough to look deliberate.
 */
export function useLocalCache(): {
  clear: ClearAction;
  combos: ClearAction;
} {
  const client = useQueryClient();

  const cache = useMutation({
    mutationFn: () => ipc.cacheClear(),
    onSuccess: (r) => {
      receipt(cacheOutcome(r), r.failed > 0 ? "warning" : r.files === 0 ? "info" : "success");
    },
    onError: refused("Couldn't clear the cache"),
  });

  const combos = useMutation({
    // Two awaits and no `Promise.all`: the second call is what refills what the first emptied,
    // and running them together would race a download against the delete it exists to undo.
    mutationFn: async () => {
      await ipc.combosClear();
      return await ipc.combosRefresh(true);
    },
    onSettled: () => invalidate(client, COMBO_ROOTS),
    onSuccess: (r) => {
      // A refresh that landed nothing is the download failing after the clear succeeded.
      receipt(combosOutcome(r), r.combos === 0 ? "warning" : "success");
    },
    onError: refused("Couldn't refresh combos"),
  });

  return {
    clear: { run: () => cache.mutate(), pending: cache.isPending },
    combos: { run: () => combos.mutate(), pending: combos.isPending },
  };
}

/** The danger zone's state, as the panel takes it — `useErrorLog`'s `ErrorLog` shape, one panel
 *  over, so a test can build one by hand without reaching for a query client. */
export type DangerZone = ReturnType<typeof useDangerZone>;

/** The cache panel's, for {@link DangerZone}'s reason. */
export type LocalCache = ReturnType<typeof useLocalCache>;
