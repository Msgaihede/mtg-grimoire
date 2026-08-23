import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ipc } from "@/lib/ipc";
import { writeFailure, type Write } from "@/lib/writes";
import { cacheOutcome, collectionOutcome, decksOutcome, wishlistOutcome } from "./clearOutcome";

/**
 * The four things Settings can throw away, and what the cache has to be told afterwards.
 *
 * Two hooks rather than one, matching the two panels: the three destructive clears share a
 * status line and are confirmed by typing a word, and the cache clear shares neither. Folding
 * them into one hook would give the cache panel three mutations it must not show and give the
 * danger zone a fourth its confirmation does not cover.
 *
 * **The invalidation is the interesting half.** A clear empties a table the query cache has
 * already answered from, and — for the collection — several tables it has *joined*: every card
 * in the search wall carries an `ownedQuantity`, every card in a deck carries the allocator's
 * claim on it, and both are `LEFT JOIN`s into `collection_entries` rather than fields anything
 * would think to refresh. Each mutation names the roots it can have made wrong and no more,
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
function invalidate(client: QueryClient, roots: readonly string[][]): void {
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
 * * `["decks"]` — `DeckCard.ownedQuantity` is the allocator's *claim* on an owned copy, and
 *   the cascade just deleted every claim in the app.
 * * `["wishlist"]` — the fifth, and the one that reads as wrong: a wish is for a card the reader
 *   does *not* own, so a wishlist ought not to care. `WishRow.ownedQuantity` is why it does —
 *   it counts the copies that already fill each wish, so every row on that page has just gone
 *   to zero.
 *
 * Not `["sets"]`, whose `staleTime` is `Infinity` and which only a sync can change.
 */
const COLLECTION_ROOTS = [["collection"], ["cards"], ["card"], ["decks"], ["wishlist"]];

/** The wishlist's own table, plus the two surfaces that draw a `wishlisted` flag per card. */
const WISHLIST_ROOTS = [["wishlist"], ["cards"], ["card"]];

/**
 * Only the decks.
 *
 * Deliberately short, and it is the one worth stating: a deck holds an allocation *against* a
 * collection row, and nothing the collection page or the search wall draws is derived from it.
 * `CardSummary.ownedQuantity` is finish-blind and allocation-blind by design. So the claims all
 * being released changes what the deck pages say and nothing else.
 */
const DECK_ROOTS = [["decks"]];

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
 * The cache sweep, which destroys nothing and invalidates nothing.
 *
 * **No query root goes stale, and that is worth saying out loud rather than leaving as an empty
 * line.** Nothing in the query cache describes the picture cache: card art is served over
 * `mtgimg://` by the protocol handler, outside TanStack Query entirely, and a picture already
 * decoded into a painted `<img>` stays correct — the bytes it was made from are simply no longer
 * on disk. The next request for a key that is gone is a miss, and a miss re-fetches. So the only
 * thing this hook does after a success is say what it freed.
 */
export function useLocalCache(): { clear: ClearAction; status: ClearStatus | null } {
  const [outcome, setOutcome] = useState<string | null>(null);

  const cache = useMutation({
    mutationFn: () => ipc.cacheClear(),
    onMutate: () => setOutcome(null),
    onSuccess: (r) => setOutcome(cacheOutcome(r)),
  });

  return {
    clear: { run: () => cache.mutate(), pending: cache.isPending },
    status: statusOf([cache], outcome),
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
