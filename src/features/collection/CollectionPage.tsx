import { useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { OwnedBadge } from "@/components/OwnedBadge";
import { CardGrid, type GridCard } from "@/features/search/CardGrid";
import { ipc, ipcError, type CollectionPage as Page, type CollectionRow } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CollectionFilterBar } from "./CollectionFilterBar";
import { CollectionSummaryHeader } from "./CollectionSummary";
import { CollectionTable } from "./CollectionTable";
import { useCollection, type Collection } from "./useCollection";

/** One tile of the wall: a card, and how many copies of it the collection holds. */
interface CollectionTile extends GridCard {
  copies: number;
}

/**
 * The collection: what it adds up to, what is in it, and the quantities editable in place.
 *
 * The aggregate header is the one composition this view adds to the app, and it is data —
 * so it is the mono face, unemphasised, with no colour and no chrome. Everything loud on
 * this screen is card art, exactly as it is in search.
 */
export function CollectionPage() {
  const collection = useCollection();
  const { query, summary, rows, total } = collection;
  const view = useAppStore((s) => s.collectionView);
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const queryClient = useQueryClient();

  /**
   * Rewrite one entry wherever the collection is cached.
   *
   * Every cached filter combination, not just the one on screen: the same row is in the
   * "everything" list and in the "foils only" list, and a stepper press that fixed one and
   * left the other would show two different numbers for one card one filter click apart.
   */
  const patchEntry = useCallback(
    (id: number, next: ((row: CollectionRow) => CollectionRow) | null) => {
      queryClient.setQueriesData<InfiniteData<Page>>(
        { queryKey: ["collection", "list"] },
        (data) => {
          if (!data || !data.pages.some((p) => p.items.some((r) => r.id === id))) return data;
          return {
            ...data,
            pages: data.pages.map((page) =>
              next === null
                ? {
                    items: page.items.filter((r) => r.id !== id),
                    // Every page carries the same count of the whole list, so every page's
                    // copy of it moves — otherwise the header the *first* page feeds would go
                    // on counting a row that is gone.
                    total: Math.max(0, page.total - 1),
                  }
                : { ...page, items: page.items.map((r) => (r.id === id ? next(r) : r)) },
            ),
          };
        },
      );
    },
    [queryClient],
  );

  /** Undo, for a write the backend refused. */
  const snapshot = useCallback(
    () => queryClient.getQueriesData<InfiniteData<Page>>({ queryKey: ["collection", "list"] }),
    [queryClient],
  );
  const restore = useCallback(
    (saved: ReturnType<typeof snapshot>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  /**
   * What every write here has in common: the header re-fetches, the search is marked stale,
   * and the list is *not* re-fetched — the row's own number has already been rewritten from
   * the answer, and re-reading a hundred rows because one of them changed by one is a round
   * trip nobody is waiting for. A wrong total, though, is a worse lie than a slow one.
   */
  const settle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection", "summary"] });
    // The wishlist counts this list: a wish's `ownedQuantity` is computed from
    // `collection_entries`, so a stepper press has just made every cached wish for that card
    // wrong. The same pair `AddToCollection` invalidates, for the same reason — a write here
    // is the same write it makes.
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    // And the search results, which draw `ownedQuantity` on every row now. Refetched rather
    // than merely marked — only *active* queries refetch, and while this view is on screen
    // the search is unmounted, so from here the cost is a stale mark and nothing else.
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    // And every deck. A deck's claims are read back as `min(claim, entry.quantity)`, so a
    // copy stepped away from under a built deck changes what that deck says it owns — and
    // what its "missing to wishlist" button would buy — without the deck being touched at
    // all. The claims themselves are left stale on purpose: they are recomputed by the next
    // zone write, and a read is not the place to discover that the world moved.
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  /**
   * What a refused write leaves behind, on either path.
   *
   * The whole view, not just the list: a refused write is usually a row something else
   * already removed (`GONE`), and a collection that has lost a row has also lost the copies,
   * the value and the unique count that row was part of — measured live, the header went on
   * counting a deleted entry until this reached past the table. The wishlist and the search
   * go with it for the same reason a success takes them: the copies that deletion took are
   * copies some wish counted as owned and some result row is badged with.
   */
  const settleFailure = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["collection"] });
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    void queryClient.invalidateQueries({ queryKey: ["decks"] });
  }, [queryClient]);

  const setQuantity = useMutation({
    mutationFn: ({ row, quantity }: { row: CollectionRow; quantity: number }) =>
      ipc.collectionSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends
    // the same number three times — the box is controlled by the cache, so a second press
    // before the first answer would be computed from a stale value.
    onMutate: ({ row, quantity }) => {
      const saved = snapshot();
      patchEntry(row.id, (r) => ({ ...r, quantity }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleFailure();
    },
    onSuccess: (change) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored.
      patchEntry(change.id, (r) => ({ ...r, quantity: change.quantity }));
      settle();
    },
  });

  const remove = useMutation({
    mutationFn: (row: CollectionRow) => ipc.collectionRemove(row.id),
    // No optimistic half, so nothing to roll back: the row is dropped from the answer rather
    // than from the press, because a removal is one click and does not have to survive being
    // held down. The failure path is the stepper's, though — a refusal here means the same
    // thing it means there, and used to mean nothing at all.
    onError: settleFailure,
    onSuccess: (change) => {
      patchEntry(change.id, null);
      settle();
    },
  });

  const onSetQuantity = useCallback(
    (row: CollectionRow, quantity: number) => setQuantity.mutate({ row, quantity }),
    [setQuantity],
  );
  const onRemove = useCallback((row: CollectionRow) => remove.mutate(row), [remove]);
  const onNeedNextPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
      void query.fetchNextPage();
    }
  }, [query]);

  /**
   * The wall is a wall of *cards*, where the table is a list of entries: a foil and a played
   * nonfoil of one printing are two rows to maintain and one piece of art to look at, so the
   * tile carries the copies of both.
   */
  const tiles = useMemo(() => {
    const copies = new Map<string, number>();
    for (const row of rows) copies.set(row.cardId, (copies.get(row.cardId) ?? 0) + row.quantity);
    const seen = new Set<string>();
    const out: CollectionTile[] = [];
    for (const row of rows) {
      if (seen.has(row.cardId)) continue;
      seen.add(row.cardId);
      out.push({
        id: row.cardId,
        // A printing `cards` has forgotten still has the set and number the entry recorded,
        // and on a wall of art that is the whole of what identifies it.
        name: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
        setCode: row.setCode,
        collectorNumber: row.collectorNumber,
        rarity: row.rarity,
        copies: copies.get(row.cardId) ?? 0,
      });
    }
    return out;
  }, [rows]);

  // Once per session, on the first load that has rows: everything the user owns gets its
  // art cached in the background, so the collection browses without a network. Keys already
  // on disk are skipped by the query, which is what makes repeat calls cheap and the job
  // resumable across sessions.
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current || rows.length === 0) return;
    warmed.current = true;
    void ipc.prewarmCollection().catch(() => {});
  }, [rows.length]);

  const failure = query.isError ? ipcError(query.error) : null;
  // The *latest* write, not either of them: with `isError` on both, a refused stepper press
  // left "Could not change your collection" on screen while the reader went on to remove the
  // row successfully — an alert about something that had already been dealt with. Seen live.
  const lastWrite = setQuantity.submittedAt >= remove.submittedAt ? setQuantity : remove;
  const writeFailure = lastWrite.isError ? ipcError(lastWrite.error) : null;
  const empty = rows.length === 0;
  const status = statusOf(collection, failure);

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel
          "Collection" 18px under it would be a subheading repeating its own heading. The
          header below says what this view is far better than a title would. */}
      <h2 className="sr-only">Collection</h2>

      <CollectionSummaryHeader summary={summary.data} />

      {/* The region is mounted for the life of the view and the banner is swapped into it: a
          live region that appears together with its own text announces nothing, because there
          was no change for a screen reader to notice — the same rule as the status line below
          and as the quick-add's report. `empty:-mt-4` gives back the flex gap it would
          otherwise hold open under the header while it is saying nothing at all. */}
      <div role="status" aria-label="Needs review" className="empty:-mt-4">
        {/* Only while there are flagged rows *and* the reader is not already looking at them —
            with the filter on, the list is the answer and the banner would be a second copy of
            the question.

            `!== true`, not `!`: the chip has three states, and `false` is "the rows nothing
            flagged". Under a falsy test that state would put the banner back on screen above
            a list showing precisely the rows nothing is wrong with, offering to show them. */}
        {collection.needsReview !== true && (summary.data?.needsReview ?? 0) > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface px-3 py-2 text-xs">
            <span className="min-w-0">
              <span className="mr-1 font-medium text-destructive">Needs review:</span>
              <span className="font-mono tabular-nums">{summary.data?.needsReview}</span>{" "}
              {summary.data?.needsReview === 1 ? "entry names" : "entries name"} a printing that
              changed or left the card database.
            </span>
            <button
              type="button"
              onClick={() => collection.setNeedsReview(true)}
              className={cn(
                "ml-auto shrink-0 rounded-md border border-accent px-2 py-1 text-accent",
                "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
                "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                "motion-reduce:transition-none",
              )}
            >
              Show them
            </button>
          </div>
        )}
      </div>

      <CollectionFilterBar collection={collection} />

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* One live region, mounted for the life of the view: a region that appears together
            with its text announces nothing, because there was no change for a screen reader
            to notice. Empty — and therefore no taller than nothing — while the table below
            is answering for itself. */}
        <p
          role="status"
          className={cn(
            empty && status ? "py-16 text-center text-sm" : "text-xs",
            empty && failure ? "text-destructive" : "text-dim",
          )}
        >
          {status}
        </p>

        {/* A write that was refused, said where the writing happened. Not folded into the
            line above: that one describes the list, and this one describes something the
            reader just did to it. */}
        {writeFailure && (
          <p
            role="alert"
            className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            Could not change your collection — {writeFailure}
          </p>
        )}

        {!empty &&
          (view === "grid" ? (
            <CardGrid
              rows={tiles}
              label="Your collection"
              listKey={collection.queryKeyString}
              selectedId={selectedCardId}
              onSelect={selectCard}
              onNeedNextPage={onNeedNextPage}
              // The same mark search draws, and only the mark: the corner and the felt
              // behind it are the wall's, so the two views cannot drift into two shades.
              // No `wishlisted` — this wall shows what is owned and has no opinion about
              // what is wanted. A tile at zero copies draws nothing, which is the badge's
              // own guard and the reason this view no longer has a badge of its own.
              badge={(tile) => <OwnedBadge owned={tile.copies} />}
            />
          ) : (
            <>
              <CollectionTable
                rows={rows}
                total={total}
                listKey={collection.queryKeyString}
                onNeedNextPage={onNeedNextPage}
                onSetQuantity={onSetQuantity}
                onRemove={onRemove}
              />
              {/* The one thing about this table a reader cannot see: removal is offered on a
                  row at zero and nowhere else, so a mis-added four-copy row would only ever
                  be got rid of by accident. Said once, under the table, at the end of the
                  line the removal itself lives on — not per row, where forty copies of a
                  sentence about a rare action would be louder than the rows. */}
              <p className="text-right text-[0.7rem] text-dim">
                To remove an entry, set its copies to zero.
              </p>
            </>
          ))}
      </div>
    </section>
  );
}

/** The one line that says what the list area is currently showing, or nothing at all. */
function statusOf(collection: Collection, failure: string | null): string {
  const { query, rows, activeCount } = collection;

  if (rows.length === 0) {
    if (failure) return failure;
    if (query.isPending) return "Reading your collection…";
    // Nothing filtered and nothing there: this is a statement about the collection, not
    // about the query. "No cards match" would blame the reader for a table nobody has put
    // anything in yet, and say nothing about how to.
    return activeCount === 0
      ? "Nothing here yet. Add cards from search, or import a collection file."
      : "No cards in your collection match these filters.";
  }

  // With rows on screen the table captions itself and the header above counts it, so the
  // only thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
