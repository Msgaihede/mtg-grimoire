import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { OwnedBadge } from "@/components/OwnedBadge";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { CardGrid, type GridCard } from "@/features/search/CardGrid";
import { ExportDialog } from "@/features/transfer/export/ExportDialog";
import { everythingLabel, scopeLabel, useExportScope } from "@/features/transfer/export/scope";
import { collectionDestination } from "@/features/transfer/import/destinations/CollectionPreview";
import { ImportDialog } from "@/features/transfer/import/ImportDialog";
import { FINISHES, isFinish } from "@/lib/finish";
import { FOCUS } from "@/lib/focus";
import { ipc, ipcError, type CollectionPage as Page, type CollectionRow } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { CollectionFilterBar } from "./CollectionFilterBar";
import { CollectionSummaryHeader } from "./CollectionSummary";
import { CollectionTable } from "./CollectionTable";
import { useCollection, type Collection } from "./useCollection";

/** One tile of the wall: a card, and how many copies of it the collection holds. */
interface CollectionTile extends GridCard {
  copies: number;
  /** Carried for the right-click menu alone — nothing on the wall draws it. A menu add is
   *  filed by what the card *does*, exactly as a drag of the same card is. */
  typeLine: string | null;
  /** Also the menu's alone: which oracle card this is, so "View all printings" can reach it.
   *  `null` where the entries behind this tile are orphans. */
  oracleId: string | null;
  /**
   * The finishes the reader's own entries for this printing are in, as the JSON list
   * `CardMenuTarget.finishes` takes.
   *
   * **Not the finishes the printing exists in** — a collection row does not carry those — and
   * that difference is the point rather than a compromise. The tile sums entries, so it knows
   * exactly which finishes are behind the art in front of the reader: one, and the menu records
   * that one without asking; two, and it asks. A tile that said nothing here fell to the menu's
   * unknown-list rule and silently recorded a **nonfoil** copy for a reader who owns two foils
   * and no nonfoil, which is the failure the whole finish rule exists to prevent.
   */
  finishes: string;
}

/**
 * The entries' finishes for one printing, in the app's own order, as stored JSON.
 *
 * `FINISHES` order (nonfoil, foil, etched) rather than the order the rows arrived in: it is
 * Scryfall's, it is what every finish picker in this app reads in, and a submenu whose two rows
 * swapped places depending on which entry the backend sorted first would be a picker that moves
 * under the pointer. Unrecognised words are dropped — `finish` is TEXT with a CHECK rather than
 * an enum this side knows — and a tile left with nothing falls to the menu's unknown-list rule,
 * which is the honest answer for an entry whose finish this build cannot name.
 *
 * Every entry counts, including one emptied to zero: the wall draws a tile for it, the table
 * keeps the row with its condition and its purchase story, and it is still a finish the reader
 * has recorded holding this printing in.
 */
function ownedFinishes(seen: ReadonlySet<string>): string {
  return JSON.stringify(FINISHES.filter((finish) => seen.has(finish)));
}

/**
 * The card a right-click on an **entry** is about.
 *
 * **A collection row is a finish** — it is one of the ten columns the row's identity is made
 * of — so the menu names it rather than asking. The `isFinish` guard is not ceremony:
 * `collection_entries.finish` is TEXT with a CHECK rather than an enum this side knows, so a
 * row can spell something this build has never heard of, and an unrecognised word must not
 * arrive at the backend as a finish.
 *
 * **`oracleId` travels straight through, with no fallback**, and that is what makes the menu's
 * one greyed row honest here. It comes off the same `LEFT JOIN` as `name` and `rarity`, so a
 * `null` means the entry's printing has left the corpus — 0 of 116 590 live rows have a null
 * `oracle_id` — which is exactly what "View all printings" says when it greys itself out. Every
 * healthy row gets a live item. (This adapter passed a hardcoded `null` until
 * `CollectionRow.oracleId` landed, which greyed the row on the reader's whole collection and
 * gave a true sentence about a card that was fine.)
 *
 * `finishes` is `null` because a collection row genuinely has no such list: it says which finish
 * the reader *holds*, never which ones the printing exists in. The wall's tile can do better —
 * see {@link tileTarget}.
 */
function rowTarget(row: CollectionRow): CardMenuTarget {
  return {
    cardId: row.cardId,
    // An orphaned entry has no name — `cards` does not know this printing any more — and the
    // set and number beside it are the entry's own columns, copied at write time for exactly
    // this. The same fallback the wall's tiles use.
    name: row.name ?? `${row.setCode.toUpperCase()} ${row.collectorNumber}`,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    oracleId: row.oracleId,
    finishes: null,
    finish: isFinish(row.finish) ? row.finish : undefined,
    typeLine: row.typeLine,
  };
}

/**
 * The card a right-click on a **tile** is about.
 *
 * Where {@link rowTarget} *names* a finish, this one offers a **list**, and the two are the same
 * rule seen from either end: a row is one entry and therefore is one finish, while a tile is a
 * card the reader may hold in two — a foil and a played nonfoil are one piece of art on this
 * wall. So the tile hands over the finishes its own entries are in ({@link ownedFinishes}), and
 * the menu does what it does on the search wall through the very same component: one finish is
 * no question, two is a submenu.
 *
 * The list is the reader's *holdings* rather than the printing's catalogue, which is the only
 * honest list a collection row can produce and is also the better one here — an add from this
 * wall is a copy of something already in the binder.
 */
function tileTarget(tile: CollectionTile): CardMenuTarget {
  return {
    cardId: tile.id,
    name: tile.name,
    setCode: tile.setCode,
    collectorNumber: tile.collectorNumber,
    oracleId: tile.oracleId,
    finishes: tile.finishes,
    typeLine: tile.typeLine,
  };
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
  const { query, summary, rows, total, marketplace } = collection;
  const view = useAppStore((s) => s.collectionView);
  /** The mode note's way out. There is no router in this app — `store.ts` says outright that
   *  it *is* what a router would provide — so the jump to Settings is a store write. */
  const setActiveView = useAppStore((s) => s.setActiveView);
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const queryClient = useQueryClient();

  /**
   * The export dialog, and the sweep that fills it — see `scope.ts`'s doc for why the sweep
   * exists at all rather than exporting the page already in memory.
   *
   * `useExportScope` runs on every render, `enabled` or not: `ExportDialog` is mounted
   * unconditionally below (the same shape `DeckEditor`'s is), so that closing it fades the
   * shell out instead of yanking it out of the tree — and that means this hook has to be
   * called every render too, `enabled: exporting` is what stops it from sweeping the whole
   * collection on every filter keystroke nobody asked to export.
   */
  const [exporting, setExporting] = useState(false);
  const exportScope = useExportScope("collection", collection.filters, exporting);

  /** The import dialog. One destination, so no radio group is drawn — a choice between one
   *  thing is not a choice. */
  const [importing, setImporting] = useState(false);

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
    // deck card write, and a read is not the place to discover that the world moved.
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

  /**
   * Whether this list is the sum of the reader's live decks.
   *
   * Read off the hook the two queries are keyed from rather than by calling
   * `useDeckDrivenCollection` again here, so the page, the bar and the table cannot disagree
   * about which mode they are drawing for the length of a render.
   */
  const deckDriven = collection.deckDriven;

  /**
   * Both writes refuse while **the row itself** is derived — the second half of the greying the
   * table does, and the half that is load-bearing.
   *
   * **`row.deckCount !== null`, never the `deckDriven` flag.** `filterKey` folds the mode into
   * the list query's key and that query uses `keepPreviousData`, so the render right after a
   * flip to **off** can still be handed the previous mode's rows — ids that are `deck_cards.id`
   * — with `deckDriven` already reading `false` and the Rust fence that would otherwise refuse
   * the write already down. A flag-driven guard is wide open in exactly that frame; the row's
   * own `deckCount` is never wrong about what the row is, which is the same argument
   * `CollectionTable.tsx`'s finish cell makes for reading the row over the mode.
   *
   * The controls say `aria-disabled`, which is a statement to assistive tech and stops no
   * click on its own; and the row's right-click menu, the keyboard, and anything else that
   * reaches these callbacks never saw the attribute at all. `collection::set_quantity` refuses
   * too and would answer with a sentence — but that sentence would arrive as
   * "Could not change your collection", i.e. as a *failure*, over an optimistic patch that had
   * already moved the number on screen and then moved it back. Returning here is the
   * difference between "that control is not available" and "something went wrong".
   */
  const onSetQuantity = useCallback(
    (row: CollectionRow, quantity: number) => {
      if (row.deckCount !== null) return;
      setQuantity.mutate({ row, quantity });
    },
    [setQuantity],
  );
  const onRemove = useCallback(
    (row: CollectionRow) => {
      if (row.deckCount !== null) return;
      remove.mutate(row);
    },
    [remove],
  );
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
    // The same walk, answering the tile's second question: *which finishes* those copies are in.
    // A second pass would be a second definition of "the entries behind this printing".
    const finishes = new Map<string, Set<string>>();
    for (const row of rows) {
      copies.set(row.cardId, (copies.get(row.cardId) ?? 0) + row.quantity);
      const held = finishes.get(row.cardId) ?? new Set<string>();
      held.add(row.finish);
      finishes.set(row.cardId, held);
    }
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
        typeLine: row.typeLine,
        oracleId: row.oracleId,
        finishes: ownedFinishes(finishes.get(row.cardId) ?? new Set()),
      });
    }
    return out;
  }, [rows]);

  /**
   * The collection as a **walk**, so the printings modal's chevrons and arrow keys step along it.
   *
   * **Built from {@link tiles} rather than from `rows`, and that is the honest source of the
   * two.** A walk's stops are printings — the modal answers a foil entry and a played nonfoil of
   * one printing with the same wall and the same ring — which is exactly the merge the wall has
   * already done, name fallback for an orphaned entry included. Feeding it `rows` would rely on
   * `listWalkStops`' own de-duplication to arrive back at this list, which is two definitions of
   * one thing and only one of them carries the fallback name.
   *
   * The table is walked by the same list, and that is right rather than a compromise: the two
   * layouts are one collection in one order, and a press that meant something different
   * depending on which was on screen would be two answers to one question.
   */
  const walk = useMemo(
    () => listWalkStops(tiles, (tile) => ({ cardId: tile.id, oracleId: tile.oracleId, name: tile.name })),
    [tiles],
  );
  usePublishCardWalk("your collection", walk);

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

  /**
   * The right-click menu, as one object for the whole page — the table's rows and the wall's
   * tiles are two drawings of one collection, and a menu whose writes differed between them
   * would be two answers to one question.
   *
   * "View all printings" is live on every healthy row and tile, and greyed only where the
   * entries behind it are orphans — `CollectionRow.oracleId` is what makes that distinction
   * reachable, and it is passed through untouched by both adapters above.
   */
  const { menu, menuKey } = useContextMenu();
  const { deps: menuDeps, error: menuFailure } = useCardMenuDeps();
  /** One row's handler. The item list is a **thunk** inside `menu`, so a list of a thousand
   *  pays for nothing until a reader actually right-clicks one of them. */
  const rowMenu = useCallback(
    (row: CollectionRow) => menu(() => buildCardMenu(rowTarget(row), menuDeps)),
    [menu, menuDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key — wired everywhere its pointer twin is,
   *  because a menu only a mouse can open is a menu half this app's readers do not have. */
  const rowMenuKey = useCallback(
    (row: CollectionRow) => menuKey(() => buildCardMenu(rowTarget(row), menuDeps)),
    [menuKey, menuDeps],
  );
  const tileMenu = useCallback(
    (tile: CollectionTile) => menu(() => buildCardMenu(tileTarget(tile), menuDeps)),
    [menu, menuDeps],
  );
  const tileMenuKey = useCallback(
    (tile: CollectionTile) => menuKey(() => buildCardMenu(tileTarget(tile), menuDeps)),
    [menuKey, menuDeps],
  );

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

      <CollectionSummaryHeader
        summary={summary.data}
        marketplace={marketplace}
        deckDriven={deckDriven}
      />

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
                FOCUS,
                "motion-reduce:transition-none",
              )}
            >
              Show them
            </button>
          </div>
        )}
      </div>

      {/* **What this page is a list of, said before the list.** Every number on this screen
          changes meaning under this setting — a count is copies in decks rather than copies
          owned, a value is what the decks are worth — and none of the controls says so on its
          own. Above the filter bar rather than beside the header, because it explains the
          whole view and not one figure in it.

          "Theory lists are left out" is the one thing a reader cannot deduce from the sentence
          before it, and it is the difference between two very different totals for anybody who
          builds a deck on paper first.

          A `<button>` and not an `<a>`: there is no router in this app, so a link would have
          nowhere to point — `useAppStore`'s own doc says the store is the whole of what one
          would provide. It reads as a link and is announced as a button, which is what it is. */}
      {deckDriven && (
        <p className="-mt-2 text-sm text-dim">
          Your collection is the sum of the cards in your decks. Theory lists are left out.{" "}
          <button
            type="button"
            onClick={() => setActiveView("settings")}
            className={cn("rounded-sm text-accent hover:underline", FOCUS)}
          >
            Change this in Settings
          </button>
          .
        </p>
      )}

      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <CollectionFilterBar collection={collection} />
        </div>
        {/* The first export entry point outside the deck editor (Task 11); Import beside it
            since Task 14, over `collectionDestination` — the collection's own bulk-import
            planner and preview. */}
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={() => setImporting(true)}
            className={cn(
              "h-8 rounded-md border border-border px-3 text-sm hover:bg-surface",
              FOCUS,
            )}
          >
            Import
          </button>
          <button
            type="button"
            onClick={() => setExporting(true)}
            className={cn(
              "h-8 rounded-md border border-border px-3 text-sm hover:bg-surface",
              FOCUS,
            )}
          >
            Export
          </button>
        </div>
      </div>

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
            reader just did to it.

            It grows into place instead of shoving the table down by its whole height. The
            animated element is the wrapper and carries only `overflow-hidden`, because
            `statusLine` takes `height` to 0 and a box with its own padding and border can
            never — under `box-sizing: border-box` — be shorter than the two of them. */}
        <AnimatePresence initial={false}>
          {writeFailure && (
            <motion.div {...statusLine} className="overflow-hidden">
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              >
                Could not change your collection — {writeFailure}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {/* A write the right-click menu started and the backend refused, beside the banner
            above rather than folded into it: that one is about this list's own controls — a
            stepper press, a removal — and this one is about a card the reader filed somewhere
            from a menu that has already closed. */}
        <CardMenuRefusal error={menuFailure} />

        {!empty &&
          (view === "grid" ? (
            <CardGrid
              rows={tiles}
              label="Your collection"
              listKey={collection.queryKeyString}
              // This wall's own zoom, kept apart from the search's: the two views are the same
              // component over different rows, and a reader who peers at one printing's art in
              // search is not asking for a binder at 2× as well. `CardGrid`'s `zoomSection`
              // carries why it is required rather than defaulted.
              zoomSection="collection"
              selectedId={selectedCardId}
              onSelect={selectCard}
              // The same arrow-key walk the search wall takes, on the same terms: `selectedId`
              // and `onSelect` here are both the store field the card pane reads, so a press
              // moves the pane rather than only an outline. The two walls that are a *page* pass
              // this and the two that are a panel do not — `CardGrid`'s `arrowNav` is where that
              // split is argued.
              arrowNav
              onNeedNextPage={onNeedNextPage}
              // The same mark search draws, and only the mark: the corner and the felt
              // behind it are the wall's, so the two views cannot drift into two shades.
              // No `wishlisted` — this wall shows what is owned and has no opinion about
              // what is wanted. A tile at zero copies draws nothing, which is the badge's
              // own guard and the reason this view no longer has a badge of its own.
              badge={(tile) => <OwnedBadge owned={tile.copies} />}
              // The whole tile is the target: the art, its badge and the caption.
              cardMenu={tileMenu}
              cardMenuKey={tileMenuKey}
            />
          ) : (
            <>
              <CollectionTable
                rows={rows}
                total={total}
                listKey={collection.queryKeyString}
                sort={collection.sort}
                onSort={collection.toggleSort}
                onNeedNextPage={onNeedNextPage}
                onSetQuantity={onSetQuantity}
                onRemove={onRemove}
                rowMenu={rowMenu}
                rowMenuKey={rowMenuKey}
                marketplace={marketplace}
                deckDriven={deckDriven}
              />
              {/* The one thing about this table a reader cannot see: removal is offered on a
                  row at zero and nowhere else, so a mis-added four-copy row would only ever
                  be got rid of by accident. Said once, under the table, at the end of the
                  line the removal itself lives on — not per row, where forty copies of a
                  sentence about a rare action would be louder than the rows.

                  A derived list gets the other sentence, in the same place: there is no
                  removal to explain, and the question the column *does* answer — which decks
                  these copies are in — is one hover away and nothing else on screen says so. */}
              <p className="text-right text-[0.7rem] text-dim">
                {deckDriven
                  ? "Copies are removed in the deck that holds them. Hover a deck count to see which."
                  : "To remove an entry, set its copies to zero."}
              </p>
            </>
          ))}
      </div>

      {/* Mounted unconditionally, the same shape every other dialog in this app is — `Dialog`
          itself renders nothing while closed, and staying in the tree is what lets its scrim
          fade out instead of the whole thing vanishing the instant `exporting` flips back. */}
      <ExportDialog
        open={exporting}
        subject="your collection"
        surface="collection"
        cards={exportScope.cards}
        suggestedFileName="collection"
        onDismiss={() => setExporting(false)}
        onClose={() => setExporting(false)}
        scope={{
          label: scopeLabel(exportScope.total, exportScope.everything),
          // No filing argument, because the collection has none: there is no drawer to be
          // standing in, so both sentences are the plain ones `scope.ts` composes without it.
          everythingLabel: everythingLabel(),
          loading: exportScope.loading,
          everything: exportScope.everything,
          onEverything: exportScope.setEverything,
        }}
      />

      {/* One destination — the collection itself — so no destination radios are drawn: a
          choice between one thing is not a choice. `onDone`'s message is discarded, the same
          precedent `DeckEditor` and `DecksPage` set for their own import dialogs: the numbers
          are already on screen, in the preview the reader just committed. */}
      <ImportDialog
        destinations={[collectionDestination]}
        open={importing}
        onDismiss={() => setImporting(false)}
        onClose={() => setImporting(false)}
        onDone={() => setImporting(false)}
      />
    </section>
  );
}

/** The one line that says what the list area is currently showing, or nothing at all. */
function statusOf(collection: Collection, failure: string | null): string {
  const { query, rows, activeCount, deckDriven } = collection;

  if (rows.length === 0) {
    if (failure) return failure;
    if (query.isPending) return "Reading your collection…";
    // Nothing filtered and nothing there: this is a statement about the collection, not
    // about the query. "No cards match" would blame the reader for a table nobody has put
    // anything in yet, and say nothing about how to.
    //
    // **And in the derived mode the advice would be wrong as well as unhelpful**: adding a
    // card from search or importing a file puts a row somewhere this view is not looking, so
    // the reader would follow the instruction and watch the page stay empty. The empty
    // collection and the empty *reason* for it are one sentence, because the cause is not
    // "nothing added" — it is that there are no decks to add up.
    if (activeCount === 0) {
      return deckDriven
        ? "Your collection is driven by your decks, and you have no decks yet."
        : "Nothing here yet. Add cards from search, or import a collection file.";
    }
    return "No cards in your collection match these filters.";
  }

  // With rows on screen the table captions itself and the header above counts it, so the
  // only thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
