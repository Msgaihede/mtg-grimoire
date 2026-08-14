import { useCallback, useEffect, useMemo, useRef, type ComponentProps } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Figure, FigureRow } from "@/components/Figure";
import { FILTER_CONTROL, FILTER_FOCUS, ResetAll, ToggleChip } from "@/components/FilterChips";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardDraggable } from "@/features/decks/dnd";
import { finishLabel } from "@/lib/finish";
import {
  ipc,
  ipcError,
  type WishlistPage as Page,
  type WishlistSortKey,
  type WishRow,
} from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { statusLine } from "@/lib/motion";
import { sortOptions } from "@/lib/options";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { useWishlist, WISHLIST_SORTS, type Wishlist, type WishlistSort } from "./useWishlist";

/** The band a flagged row grows by, to say what the reconciler found. */
const REVIEW_HEIGHT = 20;

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
  typeLine,
  children,
  ...rest
}: {
  cardId: string | null;
  name: string;
  typeLine: string | null;
} & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !cardId) return;
    // The type line files the card if it is carried somewhere with no column to point at — the
    // sidebar's Decks entry. It is the one thing `WishRow` carries that this list never draws,
    // and it is carried for exactly this (`ipc.ts`).
    return cardDraggable({ element, payload: () => ({ kind: "card", cardId, name, typeLine }) });
  }, [cardId, name, typeLine]);
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
  const { query, rows, total, marketplace } = wishlist;
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
   * What is left to buy in the selected marketplace's currency, and how many wishes that
   * figure could not price.
   *
   * Counted over what is *missing* rather than over what is wanted: a total that charged the
   * reader for cards already in the binder is a number nobody can act on. Computed here
   * rather than asked of the backend because a wishlist fits in one page — this is arithmetic
   * over the rows already on screen, not a second round trip.
   *
   * **One figure, not the pair this used to draw.** Two totals over one shopping list was two
   * answers to the question the header exists to answer, and the setting is now the way to
   * say which one is wanted. The unpriced counter is summed from the same rows and is never
   * carried across a switch, because no two marketplaces have the same holes: `eur_etched`
   * does not exist in Scryfall's data at all, so a wish for the etched printing is priced on
   * TCGplayer and unpriced on Cardmarket at once, and a card a bulk feed has never listed is
   * unpriced on that feed alone. Nothing falls back: an unpriced wish is left out of the sum
   * and counted, never quoted at another marketplace's rate.
   */
  const currency = marketplace.currency;
  const cost = useMemo(() => {
    let total = 0;
    let unpriced = 0;
    for (const row of rows) {
      const missing = missingOf(row);
      if (missing === 0) continue;
      if (row.unitPrice === null) unpriced += 1;
      else total += row.unitPrice * missing;
    }
    return { total, unpriced };
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
  // of one figure. The second is the rare one: the backend pages at 100 and a shopping list
  // is tens of rows, so a sum taken over part of the list is a case that has to be *said*
  // rather than a case that has to be common. The first is about the currency on screen —
  // the unpriced rows are not the same rows in dollars and in euros.
  const counted = rows.length < total ? `${rows.length} of ${total} counted` : null;
  const note =
    [cost.unpriced > 0 ? `${cost.unpriced} unpriced` : null, counted].filter(Boolean).join(" · ") ||
    undefined;

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not drawn: the ribbon's `h1` already names the view, and a second Cinzel "Wishlist"
          under it would be a subheading repeating its own heading. */}
      <h2 className="sr-only">Wishlist</h2>

      <FigureRow>
        <Figure label="Wishes" value={query.isPending ? "—" : total.toLocaleString("en-US")} />
        {/* The one number this view exists for, in the currency the reader picked — spec §7
            says this header mirrors the collection's, and that one now prices in one
            currency too. Spec §5: it says how old the prices are, and whose they are.

            Etched printings have no EUR price in Scryfall's data at all — `eur_etched` is
            documented and absent — so on Cardmarket a wish for one is left out of this sum
            and counted in the note rather than quoted at the nonfoil rate. */}
        <Figure
          label={`Still to buy (${currency.toUpperCase()})`}
          value={query.isPending || empty ? "—" : formatPrice(cost.total, currency)}
          note={note}
          title={pricesAsOf(marketplace)}
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
                Could not change your wishlist — {writeFailure}
              </p>
            </motion.div>
          )}
        </AnimatePresence>

        {!empty && (
          <WishlistTable
            rows={rows}
            total={total}
            listKey={wishlist.queryKeyString}
            sort={wishlist.sort}
            onSort={wishlist.toggleSort}
            onNeedNextPage={onNeedNextPage}
            onSetQuantity={onSetQuantity}
            onRemove={onRemove}
            marketplace={marketplace}
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

      {/* Always drawn, greyed when there is nothing to clear — the rule lives in the control,
          so every view that offers a reset offers the same one. */}
      <ResetAll count={wishlist.activeCount} onReset={wishlist.resetAll} />

      <label htmlFor="wishlist-sort" className="sr-only">
        Sort
      </label>
      {/* The same state the table's headers drive, from the other end. Picking here
          *replaces* the sort with that one term; the headers refine and extend it. It
          survived the headers becoming sortable because two of its orders have no column to
          press: "Recently added", and the unit price, which is the Cost column's other
          question. */}
      <select
        id="wishlist-sort"
        value={wishlist.sortSelection}
        onChange={(e) => wishlist.setSortKey(e.target.value as WishlistSort)}
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
        {/* Reachable by reading only: picking it would be picking the sort you already
            have. Present because a select showing nothing at all looks broken, and because
            "Custom…" is the honest name for a sort built from a header this control has no
            option for.

            Pinned first, outside the sorted list below: it is the state of the control
            rather than an order to pick. `disabled` and not `aria-disabled` — the house
            rule's one exception is a native `<option>`. */}
        {wishlist.sortSelection === "" && (
          <option value="" disabled>
            Custom…
          </option>
        )}
        {/* Alphabetical by label, like every other option list (`lib/options.ts`) — a
            reader looks up the words on screen. `WISHLIST_SORTS` is declared in the order
            the orders were reasoned about; the display order is decided here. */}
        {sortOptions(WISHLIST_SORTS, (s) => s.label).map((s) => (
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
/**
 * The six columns. The same grammar as the collection table's — name flexes, everything
 * else is a known width — because a reader who has learned one of this app's lists has
 * learned all of them.
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
 *
 * **Printing is the one header in this app that cannot be pressed.** An any-printing wish
 * names no set, and a list where half the rows sort under the same blank is not an order —
 * the same reason `useWishlist` has never offered a set order either.
 *
 * The keys are the backend's, verbatim: `WISHLIST_SORTS` in `src-tauri/src/wishlist.rs`.
 */
function columnsFor(
  onSetQuantity: (row: WishRow, quantity: number) => void,
  onRemove: (row: WishRow) => void,
  marketplace: Marketplace,
): TableColumn<WishRow>[] {
  const asOf = pricesAsOf(marketplace);
  const currency = marketplace.currency;
  return [
    {
      key: "name",
      width: "minmax(0,2fr)",
      header: "Name",
      sortable: true,
      cell: (row) => (
        <>
          {/* `overflow-hidden`, and it is load-bearing: with the card pane open this column
              is the one that gives, and a row of `shrink-0` mana symbols in a 40px cell is
              drawn straight across the printing beside it. The wrapper carries the clip so
              the full-width sentence below is not clipped with it. */}
          <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            {/* Never null: a wish carries its own name, because it outlives the printing it
                was made from and may never have had one. */}
            <span className="truncate">{row.name}</span>
            <ManaText source={row.manaCost} className="shrink-0 text-xs" />
          </span>
          {row.needsReview && (
            // Inside the name's cell rather than beside it, so a screen reader reads it with
            // the row it belongs to — a `<p>` among a row's cells is not a cell, and what is
            // not a cell is not announced. Drawn across the whole row because it is a
            // sentence, not a column.
            //
            // The band is one line and the reconciler writes 130–190 characters, of which
            // the *second* half is what to do about it. A truncation that eats the
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
        </>
      ),
    },
    {
      key: "printing",
      width: "minmax(0,1fr)",
      header: "Printing · finish",
      // Deliberately not sortable — see the note above this list.
      headerTitle: "Printing · finish",
      // The distinction spec §6 draws in one word, said in three. Mono because a collector
      // number is data — the same rule as the grid caption and the pane.
      cellClassName: "flex items-center gap-1.5 font-mono text-xs text-dim",
      cell: (row) => (
        <>
          <RarityGem rarity={row.rarity} />
          <span className="truncate" title={printingOf(row)}>
            {printingOf(row)}
          </span>
        </>
      ),
    },
    {
      key: "owned",
      width: "6.25rem",
      header: "Owned",
      sortable: true,
      firstDir: "desc",
      // The whole question a wishlist answers, per row. A fraction and not a bar: the
      // direction's motion and colour budget is spent on the mana line and the card art, and
      // forty progress bars would out-shout both.
      cellClassName: "truncate font-mono text-xs tabular-nums text-dim",
      cell: (row) =>
        missingOf(row) === 0 ? "Fulfilled" : `${row.ownedQuantity} of ${row.quantity} owned`,
    },
    {
      key: "quantity",
      width: "7rem",
      header: "Wanted",
      sortable: true,
      firstDir: "desc",
      // The stepper writes straight through: a shopping list is where the number of copies
      // is *maintained*, and making the reader open an editor to change a 3 to a 4 is the
      // difference between a tool and a form.
      //
      // `min={1}`, which is where this diverges from the collection's: there,
      // `set_quantity(0)` keeps the row with its condition and its purchase story; here it
      // *deletes* it, because a wish for none of something is not a wish. A stepper that
      // deleted a row when held down would be a one-way door with no undo, so removal is its
      // own control and this one stops at one.
      interactive: true,
      cell: (row) => (
        <QuantityStepper
          size="sm"
          value={row.quantity}
          min={1}
          label={`Copies wanted of ${wishLabel(row)}`}
          onChange={(next) => onSetQuantity(row, next)}
        />
      ),
    },
    {
      key: "cost",
      width: "5.5rem",
      header: "Cost",
      sortable: true,
      firstDir: "desc",
      // Spec §5: a price is never shown without saying how old it is. A 36px header row has
      // no space for the sentence, so it rides as the column's tooltip and inside its
      // accessible name — which *begins* with the visible word, so the column is still
      // addressable by what is written on it (WCAG 2.5.3, label in name).
      headerTitle: asOf,
      headerLabel: `Cost. ${asOf}`,
      headerClassName: "text-right",
      cellClassName: "text-right font-mono tabular-nums",
      // What finishing this wish costs, over the copies still missing — arithmetic over the
      // number the stepper moves, so the two can never disagree on screen. A wish with no
      // price for its finish has no cost either: that is a hole in the data, not a zero, and
      // an etched wish on Cardmarket is exactly that hole (`eur_etched` does not exist), so
      // it is an em dash rather than another marketplace's rate wearing a euro sign.
      //
      // The header sorts by *this*, at the marketplace the query named — which is why the
      // query carries one — and why a fulfilled wish sorts to the bottom of a cost order
      // however dear the card is.
      cell: (row) => {
        const missing = missingOf(row);
        const unit = row.unitPrice;
        return (
          <>
            {formatPrice(unit === null ? null : unit * missing, currency)}
            {/* What one of them costs, under what all of them cost — and only where the two
                are different numbers. On the single-copy rows that are most of a wishlist it
                would be the same price written twice, and on a fulfilled one it was a unit
                price under a total of nothing: a line quoting $105.18 each beside the word
                "Fulfilled" reads as a bill for a card already in the binder. Seen live. */}
            {unit !== null && missing > 1 && (
              <span className="block text-[0.7rem] leading-tight text-dim">
                {formatPrice(unit, currency)} ea
              </span>
            )}
          </>
        );
      },
    },
    {
      key: "actions",
      width: "2rem",
      // The removal column. Nothing to show, and a header a screen reader still needs: an
      // unnamed column is announced as "column 6" for every row.
      header: "Actions",
      srOnlyHeader: true,
      interactive: true,
      // Always offered, where the collection's appears only on an emptied row. The two lists
      // mean opposite things by deletion: losing a collection entry loses a record of
      // something owned, and crossing a line off a shopping list is what a shopping list is
      // *for*.
      cell: (row) => (
        <button
          type="button"
          onClick={() => onRemove(row)}
          aria-label={`Remove ${wishLabel(row)} from your wishlist`}
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
      ),
    },
  ];
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
  sort,
  onSort,
  onNeedNextPage,
  onSetQuantity,
  onRemove,
  marketplace,
}: {
  rows: WishRow[];
  /** Wishes matching the filters, not wishes loaded — what assistive tech is told. */
  total: number;
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  /** The columns the list is ordered by, first one deciding. */
  sort: SortSpec<WishlistSortKey>;
  /** One press on a column header. `additive` is Shift being held. */
  onSort: (key: string, additive: boolean) => void;
  onNeedNextPage: () => void;
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  /** Which marketplace the Cost column quotes. Passed rather than read here so the list and
   *  the header above it cannot disagree about what they are pricing in. */
  marketplace: Marketplace;
}) {
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list never
  // has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);

  return (
    <VirtualTable
      rows={rows}
      columns={columnsFor(onSetQuantity, onRemove, marketplace)}
      label="Your wishlist"
      // A wishlist total is counted in full, so there is no unknown-count case here.
      total={total}
      listKey={listKey}
      sort={sort}
      onSort={onSort}
      // The reconciler walks `wishlist_entries` as well as `collection_entries`, so its
      // sentence is a band under the row it belongs to.
      extraHeight={(row) => (row.needsReview ? REVIEW_HEIGHT : 0)}
      isSelected={(row) => row.cardId !== null && row.cardId === selectedCardId}
      // Last, so it wins over the selection colour: a wish the collection already covers is
      // a record rather than a want, and it says so by receding rather than by disappearing.
      rowClassName={(row) => (missingOf(row) === 0 ? "text-dim" : undefined)}
      onNeedNextPage={onNeedNextPage}
      // An any-printing wish names no printing, so there is nothing for the pane to open —
      // and a row that looked clickable and did nothing would be worse than one that does
      // not. `onActivate` is deliberately *not* passed to `VirtualTable`: it is all-or-
      // nothing there, and here it is per row. The row's own props are overridden below
      // instead, which is also where the drag source is attached (pinned wishes only, for
      // the same reason).
      renderRow={(props, row) =>
        row.cardId ? (
          <DraggableRow
            {...props}
            cardId={row.cardId}
            name={row.name}
            typeLine={row.typeLine}
            tabIndex={0}
            onClick={() => selectCard(row.cardId!)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              // Space scrolls the container it is pressed in, which would jump the list by a
              // screen at the same time as opening the card.
              e.preventDefault();
              selectCard(row.cardId!);
            }}
            className={cn(props.className, "cursor-pointer")}
          />
        ) : (
          <div {...props} />
        )
      }
    />
  );
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
