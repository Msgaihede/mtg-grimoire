import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Trash2 } from "lucide-react";
import { Figure, FigureRow } from "@/components/Figure";
import { FILTER_CONTROL, FILTER_FOCUS, ResetAll, ToggleChip } from "@/components/FilterChips";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardDraggable } from "@/features/decks/dnd";
import { needsNextPage } from "@/features/search/useCardSearch";
import { finishLabel } from "@/lib/finish";
import { ipc, ipcError, type WishlistPage as Page, type WishRow } from "@/lib/ipc";
import { LAYER } from "@/lib/layers";
import { eurPrice, PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { stopRowActivationKeys } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { useWishlist, WISHLIST_SORTS, type Wishlist, type WishlistSort } from "./useWishlist";

/** Row height in px. Rows are uniform — except for the flagged ones, below. */
const ROW_HEIGHT = 44;

/** The band a flagged row grows by, to say what the reconciler found. */
const REVIEW_HEIGHT = 20;

/** Height of the sticky header row, which the virtualiser has to account for. */
const HEADER_HEIGHT = 36;

/**
 * The six columns, shared by the header row and every body row so they stay aligned. The
 * same grammar as the collection table's — name flexes, everything else is a known width —
 * because a reader who has learned one of this app's lists has learned all of them.
 *
 * The printing column carries a set, a number *and* a finish, because those three together
 * are what make two wishes for one card two wishes rather than a duplicate — so it is the
 * one column here that cannot be given a fixed width and be honest. It is `1fr` against the
 * name's `2fr`, the arrangement the search table reached the hard way: a *capped* track is
 * inflexible, and grid feeds it to its cap out of the free space before any `fr` track gets
 * anything — which is how a narrow window with the card pane open ends up drawing mana
 * symbols across the column beside them. Two flexible tracks share the squeeze instead, so
 * the name truncates last, and the whole printing rides as the cell's tooltip for the
 * window widths where 200px is not enough for "PLST · CHK-280 · Nonfoil".
 */
const GRID =
  "grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_6.25rem_7rem_5.5rem_2rem] items-center gap-3";

/**
 * Keyboard focus on a row, in the shape the rest of the app uses — an outline, never a ring.
 * The offset is *negative*: rows are stacked flush inside a scroller, and an outline standing
 * 2px off one would be drawn over its neighbours and clipped at the ends of the list.
 */
const ROW_FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * Which printing a wish is for, in the words spec §6 draws the distinction in.
 *
 * A wish with no `card_id` is for the *card*: a shopping list usually means "a Lightning
 * Bolt", not "the one from Alpha". Saying `LEA · 161` there would send the reader hunting a
 * particular piece of cardboard they never asked for.
 */
function printingOf(row: WishRow): string {
  const printing = row.cardId
    ? `${row.setCode?.toUpperCase() ?? "—"} · ${row.collectorNumber ?? "—"}`
    : "Any printing";
  // Appended rather than given a column of its own: a finish is not a fact about the card,
  // it is the other half of *which* card this wish is for. Absent means no preference, which
  // is not the same as nonfoil and must not be drawn as it.
  return row.preferredFinish ? `${printing} · ${finishLabel(row.preferredFinish)}` : printing;
}

/**
 * The wish, named the way a control has to name it: uniquely.
 *
 * Two wishes for one card differ only by printing and finish, so a stepper called "Copies
 * wanted of Lightning Bolt" would be two identical controls in one list as far as a screen
 * reader or a voice driver is concerned.
 */
function wishLabel(row: WishRow): string {
  const printing = row.cardId
    ? `${row.setCode?.toUpperCase() ?? "—"} ${row.collectorNumber ?? "—"}`
    : "any printing";
  const finish = row.preferredFinish ? `, ${finishLabel(row.preferredFinish)}` : "";
  return `${row.name} (${printing}${finish})`;
}

/** Copies still to find. Never negative: a wish over-covered is covered, not owed. */
function missingOf(row: WishRow): number {
  return Math.max(0, row.quantity - row.ownedQuantity);
}

/**
 * A row that is also the printing it wants — spec §1's third drag source.
 *
 * **Pinned wishes only**, which is the same rule that decides whether a row opens the card: a
 * wish with no `card_id` is for the *card*, and there is no printing to carry. A drag started
 * from one would arrive somewhere carrying an empty id, which addresses every row and no row
 * (`dnd.ts`) — so it never starts, and the row is a row.
 *
 * A component rather than a callback ref in the map, because the registration has to hold
 * still: React detaches and re-runs a ref whose identity changed, and this list re-renders on
 * every scrolled row — a source that unregisters mid-drag is a drop that never arrives.
 */
function DraggableRow({
  cardId,
  name,
  children,
  ...rest
}: { cardId: string | null; name: string } & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !cardId) return;
    return cardDraggable({ element, payload: () => ({ kind: "card", cardId, name }) });
  }, [cardId, name]);
  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  );
}

/**
 * The wishlist: what is still needed, what it will cost, and the quantities editable in
 * place.
 *
 * The thin mirror of the collection, deliberately — a wishlist is a shopping list, not an
 * inventory. One list and no layout toggle: a shopping list is read by name, and forty pieces
 * of art answer none of what it is for. The whole view is grey; the only arithmetic it does
 * out loud is the one number the reader came for.
 */
export function WishlistPage() {
  const wishlist = useWishlist();
  const { query, rows, total } = wishlist;
  const queryClient = useQueryClient();

  /**
   * Rewrite one wish wherever the wishlist is cached.
   *
   * Every cached filter combination, not just the one on screen: the same wish is in the
   * "everything" list and in the "still missing" list, and a stepper press that fixed one and
   * left the other would show two different numbers for one card one filter click apart.
   */
  const patchWish = useCallback(
    (id: number, next: ((row: WishRow) => WishRow) | null) => {
      queryClient.setQueriesData<InfiniteData<Page>>({ queryKey: ["wishlist", "list"] }, (data) => {
        if (!data || !data.pages.some((p) => p.items.some((r) => r.id === id))) return data;
        return {
          ...data,
          pages: data.pages.map((page) =>
            next === null
              ? {
                  items: page.items.filter((r) => r.id !== id),
                  // Every page carries the same count of the whole list, so every page's copy
                  // of it moves — otherwise the header the *first* page feeds would go on
                  // counting a wish that is gone.
                  total: Math.max(0, page.total - 1),
                }
              : { ...page, items: page.items.map((r) => (r.id === id ? next(r) : r)) },
          ),
        };
      });
    },
    [queryClient],
  );

  /** Undo, for a write the backend refused. */
  const snapshot = useCallback(
    () => queryClient.getQueriesData<InfiniteData<Page>>({ queryKey: ["wishlist", "list"] }),
    [queryClient],
  );
  const restore = useCallback(
    (saved: ReturnType<typeof snapshot>) => {
      for (const [key, data] of saved) queryClient.setQueryData(key, data);
    },
    [queryClient],
  );

  /**
   * What every write here has in common: the search results are re-read, and the list is
   * *not* — the row's own number has already been rewritten from the answer.
   *
   * The search, because a result row now draws `wishlisted`: adding or clearing a wish
   * changes the heart on every printing of that card, and a wall that goes on showing one
   * for a wish the reader just crossed off is wrong on screen rather than stale in a cache.
   * There is nothing else to invalidate — a wish write moves no copies, so the collection
   * and its header are untouched.
   */
  const settle = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  }, [queryClient]);

  /**
   * What a refused write leaves behind. The whole list, because a refusal here is almost
   * always a row something else already deleted — and a list that has lost a row has lost the
   * total and the cost it was part of.
   */
  const settleFailure = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
    void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
  }, [queryClient]);

  const setQuantity = useMutation({
    mutationFn: ({ row, quantity }: { row: WishRow; quantity: number }) =>
      ipc.wishlistSetQuantity(row.id, quantity),
    // Optimistic on the row's own number and nothing else. Without it, holding `+` sends the
    // same number three times — the box is controlled by the cache, so a second press before
    // the first answer would be computed from a stale value.
    onMutate: ({ row, quantity }) => {
      const saved = snapshot();
      patchWish(row.id, (r) => ({ ...r, quantity }));
      return saved;
    },
    onError: (_error, _variables, saved) => {
      if (saved) restore(saved);
      settleFailure();
    },
    onSuccess: (change) => {
      // The answer, not the guess: the backend clamps and canonicalises, and this is the
      // number it actually stored.
      patchWish(change.id, (r) => ({ ...r, quantity: change.quantity }));
      settle();
    },
  });

  const remove = useMutation({
    mutationFn: (row: WishRow) => ipc.wishlistRemove(row.id),
    onError: settleFailure,
    onSuccess: (change) => {
      patchWish(change.id, null);
      settle();
    },
  });

  const onSetQuantity = useCallback(
    (row: WishRow, quantity: number) => setQuantity.mutate({ row, quantity }),
    [setQuantity],
  );
  const onRemove = useCallback((row: WishRow) => remove.mutate(row), [remove]);
  const onNeedNextPage = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
      void query.fetchNextPage();
    }
  }, [query]);

  /**
   * What is left to buy, in both currencies, and how much of the list each figure could not
   * price.
   *
   * Counted over what is *missing* rather than over what is wanted: a total that charged the
   * reader for cards already in the binder is a number nobody can act on. Computed here
   * rather than asked of the backend because a wishlist fits in one page — this is arithmetic
   * over the rows already on screen, not a second round trip.
   *
   * Two unpriced counters and not one, because the two currencies do not have the same holes:
   * `eur_etched` does not exist in Scryfall's data at all, so a wish for the etched printing
   * is priced in dollars and unpriced in euros at the same time. One shared count would have
   * to be wrong about whichever figure it was not describing.
   */
  const cost = useMemo(() => {
    let usd = 0;
    let eur = 0;
    let unpricedUsd = 0;
    let unpricedEur = 0;
    for (const row of rows) {
      const missing = missingOf(row);
      if (missing === 0) continue;
      if (row.unitPriceUsd === null) unpricedUsd += 1;
      else usd += row.unitPriceUsd * missing;
      if (row.unitPriceEur === null) unpricedEur += 1;
      else eur += row.unitPriceEur * missing;
    }
    return { usd, eur, unpricedUsd, unpricedEur };
  }, [rows]);

  const failure = query.isError ? ipcError(query.error) : null;
  // The *latest* write, not either of them: with `isError` on both, a refused stepper press
  // would leave "Could not change your wishlist" on screen while the reader went on to remove
  // the row successfully — an alert about something that had already been dealt with.
  const lastWrite = setQuantity.submittedAt >= remove.submittedAt ? setQuantity : remove;
  const writeFailure = lastWrite.isError ? ipcError(lastWrite.error) : null;
  const empty = rows.length === 0;
  const status = statusOf(wishlist, failure);

  // The notes a total needs to stay honest, in one string because they are one qualification
  // of one figure. The second is the rare one, and it is the same sentence about both
  // figures: the backend pages at 100 and a shopping list is tens of rows, so a sum taken
  // over part of the list is a case that has to be *said* rather than a case that has to be
  // common. The first is per currency, because the unpriced rows are not the same rows.
  const counted = rows.length < total ? `${rows.length} of ${total} counted` : null;
  const noteFor = (unpriced: number) =>
    [unpriced > 0 ? `${unpriced} unpriced` : null, counted].filter(Boolean).join(" · ") ||
    undefined;

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel "Wishlist"
          under it would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Wishlist</h2>

      <FigureRow>
        <Figure label="Wishes" value={query.isPending ? "—" : total.toLocaleString("en-US")} />
        {/* The one number this view exists for, in both currencies — spec §7 says this header
            mirrors the collection's, and that one prices in both. Spec §5: each says how old
            the prices are. */}
        <Figure
          label="Still to buy (USD)"
          value={query.isPending || empty ? "—" : usdPrice(cost.usd)}
          note={noteFor(cost.unpricedUsd)}
          title={PRICES_AS_OF}
        />
        <Figure
          label="Still to buy (EUR)"
          value={query.isPending || empty ? "—" : eurPrice(cost.eur)}
          // Etched printings have no EUR price in Scryfall's data at all — `eur_etched` is
          // documented and absent — so a wish for one is unpriced here rather than quoted at
          // the nonfoil rate, and this is where that shows.
          note={noteFor(cost.unpricedEur)}
          title={PRICES_AS_OF}
        />
      </FigureRow>

      <WishlistFilterBar wishlist={wishlist} />

      <div className="flex min-h-0 flex-1 flex-col gap-2">
        {/* One live region, mounted for the life of the view: a region that appears together
            with its text announces nothing, because there was no change for a screen reader
            to notice. Empty — and therefore no taller than nothing — while the list below is
            answering for itself. */}
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
            Could not change your wishlist — {writeFailure}
          </p>
        )}

        {!empty && (
          <WishlistTable
            rows={rows}
            total={total}
            listKey={wishlist.queryKeyString}
            onNeedNextPage={onNeedNextPage}
            onSetQuantity={onSetQuantity}
            onRemove={onRemove}
          />
        )}
      </div>
    </section>
  );
}

/**
 * Every filter the wishlist offers, in one row that never wraps.
 *
 * Three controls where the collection has fourteen — four on the rare day a sync has left
 * something behind. The colour chips, the mana values and the set picker are all absent on
 * purpose: they filter a list of thousands, and this one is a list of tens read by name. What
 * is left is the box you type a name into, the one question a shopping list is for, and how
 * to order it.
 */
function WishlistFilterBar({ wishlist }: { wishlist: Wishlist }) {
  // Drawn only where it has something to filter. A wishlist is flagged by the reconciler and
  // most never are, so a permanent chip here would be a control that spends its whole life
  // saying nothing — the rule the collection's banner follows, applied to a filter. It stays
  // while the filter is on, including on the complement, where by definition no row on screen
  // carries a flag and the chip is the only way back off.
  const offered = wishlist.needsReview !== undefined || wishlist.rows.some((r) => r.needsReview);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <label htmlFor="wishlist-text" className="sr-only">
        Search your wishlist
      </label>
      <input
        id="wishlist-text"
        type="search"
        value={wishlist.text}
        onChange={(e) => wishlist.setText(e.target.value)}
        placeholder="Search your wishlist…"
        // Capped where the other two views let it take the whole row: they fill what is left
        // with chips, and this one has two controls — 780px of empty search box over a list
        // of eight is a toolbar pretending to be busy.
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "min-w-56 max-w-md flex-1 border-border bg-surface px-3 placeholder:text-dim",
          "focus:border-accent",
        )}
      />

      {/* One chip, three states, and the word on it is what says which is on. "Still missing"
          first, because it is the question the list is usually open for — the search's twin
          starts from the other end for the same reason. */}
      <ToggleChip
        label={wishlist.fulfilled === true ? "Fulfilled" : "Still missing"}
        pressed={wishlist.fulfilled !== undefined}
        onClick={wishlist.toggleFulfilled}
      />

      {/* The other half of what the flagged band under a row says: the band tells you a wish
          needs looking at, and this is how you ask for only those. Same three states and the
          same rule about the word on it — "Not flagged" is the complement, which is where the
          reader goes once the flagged ones are dealt with. */}
      {offered && (
        <ToggleChip
          label={wishlist.needsReview === false ? "Not flagged" : "Needs review"}
          pressed={wishlist.needsReview !== undefined}
          onClick={wishlist.toggleNeedsReview}
        />
      )}

      {/* Nothing is drawn until there is something to clear — the rule lives in the control,
          so every view that offers a reset offers the same one. */}
      <ResetAll count={wishlist.activeCount} onReset={wishlist.resetAll} />

      <label htmlFor="wishlist-sort" className="sr-only">
        Sort
      </label>
      <select
        id="wishlist-sort"
        value={wishlist.sort}
        onChange={(e) => wishlist.setSort(e.target.value as WishlistSort)}
        // At the far end of the row, where the other two views put their layout toggle: what
        // is on the left is *what you are looking at*, and what is on the right is *how you
        // are reading it*. This view has no layout to choose, so the sort is the whole of the
        // right-hand group.
        //
        // Never gold: a sort is always on — there is no "unsorted" — so a state colour here
        // would say "a filter is active" about a control that cannot be inactive.
        className={cn(
          FILTER_CONTROL,
          FILTER_FOCUS,
          "ml-auto border-border bg-surface px-2 text-dim",
        )}
      >
        {WISHLIST_SORTS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The wishlist as a list: one row per wish, and the wanted quantity editable in place.
 *
 * Virtualised like its two siblings — for consistency of behaviour rather than for scale,
 * because the same list has to keep working when somebody's want-list runs to four figures.
 */
function WishlistTable({
  rows,
  total,
  listKey,
  onNeedNextPage,
  onSetQuantity,
  onRemove,
}: {
  rows: WishRow[];
  /** Wishes matching the filters, not wishes loaded — what assistive tech is told. */
  total: number;
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  onNeedNextPage: () => void;
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list never
  // has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Exact rather than estimated, flagged rows included: the reconciler walks
    // `wishlist_entries` as well as `collection_entries`, so its sentence is a band under the
    // row it belongs to — and a virtualiser told every row is 44px would overlap the one
    // below it by exactly that band.
    estimateSize: (index) => (rows[index]?.needsReview ? ROW_HEIGHT + REVIEW_HEIGHT : ROW_HEIGHT),
    overscan: 10,
    // The sticky header shares the scroll container with the rows, so the list does not start
    // at the container's origin.
    scrollMargin: HEADER_HEIGHT,
  });

  // Row heights are cached from the first `estimateSize` call, so a page that lands with a
  // flagged row in it — or a fix that clears one — has to say so, or the rows keep the old
  // pitch. Usually the empty string: nothing is flagged in a healthy wishlist.
  const reviewKey = useMemo(
    () =>
      rows
        .map((r, i) => (r.needsReview ? i : -1))
        .filter((i) => i >= 0)
        .join(","),
    [rows],
  );
  useEffect(() => {
    virtualizer.measure();
  }, [reviewKey, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

  // A new list reuses this scroll container, and a browser does not reset scrollTop for new
  // content — it clamps the old offset into the new, usually far shorter, list.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [listKey, virtualizer]);

  // Paging is driven by the virtualiser's window rather than a scroll handler: it already
  // knows which row is at the bottom, and it recomputes on resize too. The guards live with
  // the query, in the page above.
  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label="Your wishlist"
      // Every matching wish plus the header, not just the rows currently in the DOM —
      // otherwise a virtualised list tells assistive tech the wishlist is 20 rows. A wishlist
      // total is counted in full, so there is no unknown-count case here.
      aria-rowcount={total + 1}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
    >
      {/* Sticky inside the scroll container rather than sitting above it: a header outside the
          scroller is wider than the rows by exactly the scrollbar, and the columns drift apart
          by that much as soon as the list overflows. */}
      <div
        role="row"
        aria-rowindex={1}
        style={{ height: HEADER_HEIGHT }}
        className={cn(
          GRID,
          "sticky top-0 border-b border-border bg-surface px-3 text-xs text-dim",
          LAYER.header,
        )}
      >
        <span role="columnheader" className="truncate">
          Name
        </span>
        <span role="columnheader" className="truncate" title="Printing · finish">
          Printing · finish
        </span>
        <span role="columnheader" className="truncate">
          Owned
        </span>
        <span role="columnheader" className="truncate">
          Wanted
        </span>
        {/* Spec §5: a price is never shown without saying how old it is. A 36px header row has
            no space for the sentence, so it rides as the column's tooltip and inside its
            accessible name — which *begins* with the visible word, so the column is still
            addressable by what is written on it (WCAG 2.5.3, label in name). */}
        <span
          role="columnheader"
          className="cursor-help truncate text-right"
          title={PRICES_AS_OF}
          aria-label={`Cost. ${PRICES_AS_OF}`}
        >
          Cost
        </span>
        {/* The removal column. Nothing to show, and a header a screen reader still needs: an
            unnamed column is announced as "column 6" for every row. */}
        <span role="columnheader" className="sr-only">
          Actions
        </span>
      </div>

      {/* Holds the scrollbar open to the full list height while the rows inside it are
          positioned absolutely. */}
      <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualRows.map((v) => {
          const row = rows[v.index];
          const missing = missingOf(row);
          const label = wishLabel(row);
          // An any-printing wish names no printing, so there is nothing for the pane to open.
          // A row that looked clickable and did nothing would be worse than one that does not.
          const opens = row.cardId;
          return (
            // Keyed by row position rather than by wish id: two pages fetched either side of a
            // write can carry one wish twice, and a duplicate key drops a row.
            <DraggableRow
              key={v.key}
              cardId={opens}
              name={row.name}
              role="row"
              aria-rowindex={v.index + 2}
              tabIndex={opens ? 0 : undefined}
              onClick={opens ? () => selectCard(opens) : undefined}
              onKeyDown={
                opens
                  ? (e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      // Space scrolls the container it is pressed in, which would jump the
                      // list by a screen at the same time as opening the card.
                      e.preventDefault();
                      selectCard(opens);
                    }
                  : undefined
              }
              className={cn(
                GRID,
                // `group`: the removal button shows itself on hover, and on the row taking
                // focus — which is the keyboard's version of hover.
                "group absolute inset-x-0 top-0 border-b border-border/50 px-3",
                "text-sm transition-colors duration-150 motion-reduce:transition-none",
                ROW_FOCUS,
                opens && "cursor-pointer",
                // Which row the open pane is about. A quiet surface rather than gold: forty
                // rows are on screen and the one being read is already beside the pane.
                opens && opens === selectedCardId ? "bg-surface text-text" : "hover:bg-surface/60",
                // Last, so it wins over the selection colour: a wish the collection already
                // covers is a record rather than a want, and it says so by receding rather
                // than by disappearing.
                missing === 0 && "text-dim",
              )}
              // `start` is measured from the scroll container, which the header shares; this
              // div begins below it, so the header's height comes back off. The row tracks are
              // pinned rather than left to `auto` because the flagged band is positioned over
              // the second one — an auto track would collapse it and re-centre the cells
              // across a height they do not occupy.
              style={{
                height: v.size,
                transform: `translateY(${v.start - HEADER_HEIGHT}px)`,
                gridTemplateRows: row.needsReview
                  ? `${ROW_HEIGHT}px ${REVIEW_HEIGHT}px`
                  : undefined,
              }}
            >
              <span role="cell" className="min-w-0">
                {/* `overflow-hidden`, and it is load-bearing: with the card pane open this
                    column is the one that gives, and a row of `shrink-0` mana symbols in a
                    40px cell is drawn straight across the printing beside it. The wrapper
                    carries the clip so the full-width sentence below is not clipped with it. */}
                <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
                  {/* Never null: a wish carries its own name, because it outlives the printing
                      it was made from and may never have had one. */}
                  <span className="truncate">{row.name}</span>
                  <ManaText source={row.manaCost} className="shrink-0 text-xs" />
                </span>
                {row.needsReview && (
                  // Inside the name's cell rather than beside it, so a screen reader reads it
                  // with the row it belongs to — a `<p>` among a row's cells is not a cell, and
                  // what is not a cell is not announced. Drawn across the whole row because it
                  // is a sentence, not a column.
                  //
                  // The band is one line and the reconciler writes 130–190 characters, of
                  // which the *second* half is what to do about it. A truncation that eats the
                  // instruction and offers no way to read it is half an error message, so the
                  // whole sentence rides as the tooltip — and is in the accessible name either
                  // way, because a screen reader reads the text, not the clip.
                  <span
                    title={row.needsReview}
                    className="absolute inset-x-3 bottom-0.5 truncate text-[0.7rem] text-dim"
                  >
                    <span className="mr-1 font-medium text-destructive">Needs review:</span>
                    {row.needsReview}
                  </span>
                )}
              </span>

              {/* The distinction spec §6 draws in one word, said in three. Mono because a
                  collector number is data — the same rule as the grid caption and the pane. */}
              <span
                role="cell"
                className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-dim"
                title={printingOf(row)}
              >
                <RarityGem rarity={row.rarity} />
                <span className="truncate">{printingOf(row)}</span>
              </span>

              {/* The whole question a wishlist answers, per row. A fraction and not a bar: the
                  direction's motion and colour budget is spent on the mana line and the card
                  art, and forty progress bars would out-shout both. */}
              <span role="cell" className="truncate font-mono text-xs tabular-nums text-dim">
                {missing === 0 ? "Fulfilled" : `${row.ownedQuantity} of ${row.quantity} owned`}
              </span>

              {/* The stepper writes straight through: a shopping list is where the number of
                  copies is *maintained*, and making the reader open an editor to change a 3 to
                  a 4 is the difference between a tool and a form.

                  `min={1}`, which is where this diverges from the collection's: there,
                  `set_quantity(0)` keeps the row with its condition and its purchase story;
                  here it *deletes* it, because a wish for none of something is not a wish. A
                  stepper that deleted a row when held down would be a one-way door with no
                  undo, so removal is its own control and this one stops at one.

                  The row opens the card on any click and on Enter or Space, and every one of
                  those lands here too: without stopping them, correcting a count would also
                  open the card, and typing `12` into the box would scroll the list a
                  screenful. Those two keys and no others — a blanket `stopPropagation` also
                  took Escape away from the card pane, which listens on `window`.

                  `data-no-drag` is the other half of the same thought, now that a pinned row
                  is a drag handle: without the mark a press on `−` that travels five pixels is
                  a drag of the whole wish with the press never delivered (`cardDraggable`). */}
              <span role="cell" data-no-drag="" onClick={stop} onKeyDown={stopRowActivationKeys}>
                <QuantityStepper
                  size="sm"
                  value={row.quantity}
                  min={1}
                  label={`Copies wanted of ${label}`}
                  onChange={(next) => onSetQuantity(row, next)}
                />
              </span>

              {/* What finishing this wish costs, over the copies still missing — arithmetic
                  over the number the stepper moves, so the two can never disagree on screen.
                  A wish with no price for its finish has no cost either: that is a hole in the
                  data, not a zero. */}
              <span role="cell" className="text-right font-mono tabular-nums">
                {usdPrice(row.unitPriceUsd === null ? null : row.unitPriceUsd * missing)}
                {/* What one of them costs, under what all of them cost — and only where the
                    two are different numbers. On the single-copy rows that are most of a
                    wishlist it would be the same price written twice, and on a fulfilled one
                    it was a unit price under a total of nothing: a line quoting $105.18 each
                    beside the word "Fulfilled" reads as a bill for a card already in the
                    binder. Seen live. */}
                {row.unitPriceUsd !== null && missing > 1 && (
                  <span className="block text-[0.7rem] leading-tight text-dim">
                    {usdPrice(row.unitPriceUsd)} ea
                  </span>
                )}
              </span>

              <span role="cell" data-no-drag="" onClick={stop} onKeyDown={stopRowActivationKeys}>
                {/* Always offered, where the collection's appears only on an emptied row. The
                    two lists mean opposite things by deletion: losing a collection entry loses
                    a record of something owned, and crossing a line off a shopping list is
                    what a shopping list is *for*. */}
                <button
                  type="button"
                  onClick={() => onRemove(row)}
                  aria-label={`Remove ${label} from your wishlist`}
                  title="Remove from your wishlist"
                  className={cn(
                    REVEAL_ON_HOVER,
                    "grid size-6 place-items-center rounded-md border border-border text-dim",
                    "transition-colors duration-150 hover:border-destructive/60 hover:text-destructive",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                    "motion-reduce:transition-none",
                  )}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </span>
            </DraggableRow>
          );
        })}
      </div>
    </div>
  );
}

/** Keeps a cell's own clicks off the row that opens the card. Clicks only: the keyboard's
 *  half is `stopRowActivationKeys`, which stops the two keys a row acts on and hands the
 *  rest — Escape above all — on to `window`. */
function stop(e: { stopPropagation: () => void }) {
  e.stopPropagation();
}

/** The one line that says what the list area is currently showing, or nothing at all. */
function statusOf(wishlist: Wishlist, failure: string | null): string {
  const { query, rows, activeCount } = wishlist;

  if (rows.length === 0) {
    if (failure) return failure;
    if (query.isPending) return "Reading your wishlist…";
    // Nothing filtered and nothing there: this is a statement about the wishlist, not about
    // the query. "No wishes match" would blame the reader for a list nobody has put anything
    // on yet, and say nothing about how to.
    return activeCount === 0
      ? "Nothing on your wishlist yet. Add cards from search with the + on any row or tile."
      : "No wishes match these filters.";
  }

  // With rows on screen the list captions itself and the header above counts it, so the only
  // thing left to say is that something is still on its way.
  if (query.isFetchingNextPage) return "Loading more…";
  if (query.isFetching) return "Updating…";
  return failure ?? "";
}
