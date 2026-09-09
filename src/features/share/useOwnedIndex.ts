/**
 * What the reader already owns and already wants, keyed by printing — the cross-reference that
 * is the whole reason a shared binder is worth opening *in the app*.
 *
 * ## Two reads, folded, never materialised
 *
 * There is no by-id read on either list: `collection_list` and `wishlist_list` are paged filter
 * queries, and no command answers "of these 4 000 scryfall ids, which do I hold". So the sweep
 * walks both lists once and folds each page into a map, **discarding the rows**. That is the
 * difference between this and `features/transfer/export/scope.ts`'s `sweep`, which is otherwise
 * the same loop and would have been reused: an export needs every row, and this needs two
 * integers per printing. At the collection sizes this app is measured against — 50 000 cards —
 * holding every `CollectionRow` to build a `Map<string, number>` is the whole list in memory for
 * an answer that fits in a few hundred kilobytes.
 *
 * ## Where the answers are filed, and why not under `["share", …]`
 *
 * `["collection", …]` and `["wishlist", …]`, because that is what they are reads *of*.
 * `invalidateQueries` matches by prefix and `OWNED_WRITE_KEYS` (`@/lib/query`) already names both
 * roots, so every write that changes what the reader owns or wants reaches these two without
 * anything being taught about the shared view. Filed under `["share"]` they would be correct on
 * the first draw and 30 seconds stale after the reader's next add — `staleTime` making a missing
 * invalidation look like a considered figure, which is the failure `query.ts` opens with.
 *
 * ## It has no write path, and that is the view's read-only guarantee
 *
 * `readOnly.test.ts` sweeps this directory for ipc names; the two here are on its read list.
 * Nothing in `src/features/share/` may name a mutation — see that file for why the guarantee is
 * structural rather than a flag.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ipc } from "@/lib/ipc";
import type { ShareCard } from "@/lib/shareSnapshot";

/**
 * Rows per round trip.
 *
 * 500 because that is what both commands clamp a `limit` to — asking for more is answered with
 * this anyway, and asking for less is round trips bought for nothing. It is `SWEEP_PAGE`'s
 * number for `SWEEP_PAGE`'s reason, arrived at independently rather than imported: that constant
 * is the export's page size and is free to move for the export's reasons.
 */
export const INDEX_PAGE = 500;

/** The two maps a row is looked up in, plus the name-keyed one a printing-less wish lands in. */
export interface OwnedIndex {
  /** Copies of one printing, summed over every row of the collection that holds it. */
  owned: ReadonlyMap<string, number>;
  /** Copies wished for **that printing**. */
  wanted: ReadonlyMap<string, number>;
  /**
   * Copies wished for by **name**, for the wishes that name no printing.
   *
   * A wish with no `cardId` is *any printing of this card*, which is what most of a wishlist is:
   * a reader writes down "three Lightning Bolts", not "three of the Beta one". Keyed on the
   * lowercased name because that is the only thing a snapshot and a printing-less wish have in
   * common — the snapshot carries no oracle id, so there is no stronger key available.
   */
  wantedByName: ReadonlyMap<string, number>;
  /**
   * Copies wished for at **one exact wishlist row**, keyed by {@link wishGrainKey}.
   *
   * ⚠️ **This is the only map here that answers "will another add fold, or make a second line".**
   * The two above it answer *do I want this card*, which is the question a tile asks and a
   * perfectly good one — but `wishlist_add` folds on a four-term grain
   * (`oracle_id`, `card_id`, `preferred_finish`, `folder_id`), so a wish for the nonfoil, or one
   * filed in another drawer, is a **new row** rather than a raised count. A surface that promised
   * "adding raises what you already want" off `wanted` would be wrong in the ordinary case, in
   * both directions, and would not change its answer when the reader picked a different folder.
   *
   * **Only pinned wishes are in it**, which is the third divergence and the quietest: a wish with
   * no `card_id` is *any printing of this card*, its grain's second term is `''`, and nothing that
   * writes a pinned wish can ever fold onto it. `wantedByName` counts those and this deliberately
   * does not.
   *
   * It costs one entry per wish where the two maps above cost one per printing — which is nothing
   * next to the collection sweep beside it: a wishlist is the reader's own hand-kept list, and
   * the 50 000-card argument this module is written against is about `collection_entries`.
   */
  wishes: ReadonlyMap<string, number>;
}

/**
 * `wishlist_add`'s fold key, as far as this side can spell it — printing, finish, folder.
 *
 * **The grain's first term is deliberately absent and costs nothing here.** `oracle_id` is
 * resolved *from* the printing by the backend, so two pinned wishes for one `card_id` always
 * agree about it; and this key is only ever built for pinned wishes, which is what the map it
 * feeds holds.
 *
 * Written once and read from both ends — the sweep that fills the map and the surface that looks
 * a row up in it — because a key spelled twice is a lookup that misses for a reason nothing can
 * see. `""` for the root rather than `0`: folder ids are numbers, so the two can never collide.
 */
export function wishGrainKey(
  cardId: string,
  finish: string | null,
  folderId: number | null,
): string {
  return `${cardId}|${finish ?? ""}|${folderId ?? ""}`;
}

/** What every card answers before the sweep has finished, and what a refused sweep leaves. */
export const EMPTY_INDEX: OwnedIndex = {
  owned: new Map(),
  wanted: new Map(),
  wantedByName: new Map(),
  wishes: new Map(),
};

/** One row of somebody else's binder, measured against the reader's own two lists. */
export interface CrossReference {
  own: number;
  want: number;
}

/**
 * The two figures for one shared row.
 *
 * **Owning is per printing and wanting is per printing *or* per card**, which is a difference in
 * the data rather than an inconsistency: a collection row is always a printing, and a wish is a
 * printing only when the reader pinned one. So a pinned wish is counted against its own printing
 * and a loose one against every printing of the card — which is what the reader meant when they
 * wrote the name down without a set.
 */
export function crossReference(card: ShareCard, index: OwnedIndex): CrossReference {
  return {
    own: index.owned.get(card.id) ?? 0,
    want: (index.wanted.get(card.id) ?? 0) + (index.wantedByName.get(card.n.toLowerCase()) ?? 0),
  };
}

/**
 * Walk a paged list, folding each page and keeping none of it.
 *
 * **The stop is a short page, not the total.** A write landing mid-sweep moves the total, and
 * believing it either drops the tail or loops forever — `useCollection`'s own `getNextPageParam`
 * documents the same rule, and the export sweep applies it too.
 */
async function fold<T>(
  page: (limit: number, offset: number) => Promise<{ items: T[] }>,
  onRow: (row: T) => void,
): Promise<void> {
  for (let offset = 0; ; ) {
    const { items } = await page(INDEX_PAGE, offset);
    for (const row of items) onRow(row);
    if (items.length < INDEX_PAGE) return;
    offset += items.length;
  }
}

/** Every copy the reader holds, whatever folder it is filed in and whatever deck claims it. */
async function readOwned(): Promise<ReadonlyMap<string, number>> {
  const owned = new Map<string, number>();
  // No folder filter and no lock filter: the question is what the reader *has*, and a copy set
  // aside in a locked drawer is still a copy they will not be trading for.
  await fold(
    (limit, offset) => ipc.collectionList({ limit, offset }),
    (row) => owned.set(row.cardId, (owned.get(row.cardId) ?? 0) + row.quantity),
  );
  return owned;
}

/** Every wish, split three ways: by printing, by name, and by the row it actually is. */
async function readWanted(): Promise<Pick<OwnedIndex, "wanted" | "wantedByName" | "wishes">> {
  const wanted = new Map<string, number>();
  const wantedByName = new Map<string, number>();
  const wishes = new Map<string, number>();
  // `flatten` because `folderId` absent is the **root** wishlist on this query and not "every
  // folder" — the opposite polarity to the collection's, which `WishlistQuery.flatten` explains.
  // Without it this sweep would silently answer about unfiled wishes alone.
  await fold(
    (limit, offset) => ipc.wishlistList({ limit, offset, flatten: true }),
    (row) => {
      if (row.cardId !== null) {
        wanted.set(row.cardId, (wanted.get(row.cardId) ?? 0) + row.quantity);
        // **The same row again, at its own grain.** The map above answers *do I want this card*
        // and this one answers *is this exact wishlist line already there* — see
        // {@link OwnedIndex.wishes}. Both, because the two questions have different right
        // answers and a surface asking the second off the first is wrong in both directions.
        const grain = wishGrainKey(row.cardId, row.preferredFinish, row.folderId);
        wishes.set(grain, (wishes.get(grain) ?? 0) + row.quantity);
      } else {
        const key = row.name.toLowerCase();
        wantedByName.set(key, (wantedByName.get(key) ?? 0) + row.quantity);
      }
    },
  );
  return { wanted, wantedByName, wishes };
}

/**
 * The index, swept once a snapshot is on screen.
 *
 * `enabled` is not a convenience: this reads the reader's whole collection, and a reader who
 * never opens a share must never pay for it. The view passes `true` only once it has a snapshot
 * to draw the figures against.
 */
export function useOwnedIndex(enabled: boolean): {
  index: OwnedIndex;
  /** The figures are real. `false` while the sweep runs **and** after it has failed. */
  ready: boolean;
  /**
   * A read was refused.
   *
   * Said out loud rather than folded into zeroes, because the two are indistinguishable on
   * screen and only one of them is safe to act on: *you own 0* beside a card the reader owns
   * four of is what sends somebody into a trade with the wrong list.
   */
  failed: boolean;
} {
  const collection = useQuery({
    queryKey: ["collection", "sharedIndex"],
    queryFn: readOwned,
    enabled,
  });
  const wishlist = useQuery({
    queryKey: ["wishlist", "sharedIndex"],
    queryFn: readWanted,
    enabled,
  });

  const owned = collection.data;
  const wanted = wishlist.data;
  const failed = collection.isError || wishlist.isError;

  /**
   * ⚠️ **Memoised, and it is the consumer's `useMemo` that this is for.**
   *
   * `SharedPage`'s `shown` filters and sorts the whole binder and lists `index` in its deps. A
   * fresh object literal every render makes that dependency change every render, so the memo
   * never hits and the sort re-runs on every keystroke, every chip and every refetch tick — at
   * exactly the binder size this feature is for. `EMPTY_INDEX` is a module constant for the same
   * reason: the loading and failed states have to be one stable identity too, or the memo would
   * miss for the whole of the window it is meant to cover.
   */
  const index = useMemo<OwnedIndex>(
    () =>
      owned === undefined || wanted === undefined
        ? EMPTY_INDEX
        : {
            owned,
            wanted: wanted.wanted,
            wantedByName: wanted.wantedByName,
            wishes: wanted.wishes,
          },
    [owned, wanted],
  );
  const ready = owned !== undefined && wanted !== undefined;

  // The whole answer is memoised too, so a caller that spreads it or lists it in deps of its own
  // gets the same identity between renders that changed nothing.
  return useMemo(() => ({ index, ready, failed }), [index, ready, failed]);
}
