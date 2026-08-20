import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { Figure, FigureRow } from "@/components/Figure";
import { buildCardMenu, type CardMenuTarget } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { count } from "@/lib/counts";
import { isFinish } from "@/lib/finish";
import { ipc, ipcError, type WishlistPage as Page, type WishRow } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { WishlistFilterBar } from "./WishlistFilterBar";
import { WishlistGrid } from "./WishlistGrid";
import { WishlistTable } from "./WishlistTable";
import { useWishlist, type Wishlist } from "./useWishlist";
import { missingOf } from "./wish";

/**
 * The printing a right-click on a **pinned** wish is about.
 *
 * `cardId` is the caller's rather than the row's, and that is the whole of how this list's one
 * peculiarity is enforced: a wish with no `card_id` is for the *card*, so there is no printing
 * to copy a name from, link to, or record a copy of — and the menu is not offered at all. The
 * same rule decides whether the row opens the card and whether it can be dragged.
 *
 * **The preferred finish travels, where there is one.** A wish *for the foil* is a different
 * wish and is not filled by the nonfoil, so "Add to → Collection" records the finish the wish
 * asked for rather than asking again. `isFinish` guards it because
 * `wishlist_entries.preferred_finish` is TEXT with a CHECK rather than an enum this side knows.
 *
 * `finishes` is `null` — a wish carries no printing's finish list — so a wish with no
 * preference falls to the menu's own rule for an unknown list, which is nonfoil.
 */
function wishTarget(row: WishRow, cardId: string): CardMenuTarget {
  const preferred = row.preferredFinish;
  return {
    cardId,
    // Never null: a wish carries its own name, because it outlives the printing it was made
    // from and may never have had one.
    name: row.name,
    // An *orphaned* pinned wish has neither — the join found no card — and the row already
    // draws that as "— · —". The Scryfall link is a dead one for those, which is the same
    // thing the row itself says about them.
    setCode: row.setCode ?? "",
    collectorNumber: row.collectorNumber ?? "",
    oracleId: row.oracleId,
    finishes: null,
    finish: preferred !== null && isFinish(preferred) ? preferred : undefined,
    // The one thing `WishRow` carries that this list never draws, carried for exactly this and
    // for the drag beside it: a menu add is filed by what the card does.
    typeLine: row.typeLine,
  };
}

/**
 * The wishlist: what is still needed, what it will cost, and the quantities editable in
 * place.
 *
 * The thin mirror of the collection, deliberately — a wishlist is a shopping list, not an
 * inventory — and, like the other two lists, it is drawn either as a wall of art or as a
 * table. **It opens on the wall**, which is where it differs from the collection and agrees
 * with the search: these are cards the reader does not have yet and may never have held, so
 * the picture is how you recognise the thing you are about to buy. The table is a press away
 * for the trip where the question is what it all costs.
 *
 * Both layouts draw one list and answer alike: the same wishes, the same two writes, the same
 * menu on the same rows. What differs is only what there is room to say — see
 * {@link WishlistGrid} for what a 170px tile keeps and what it moves into a panel.
 */
export function WishlistPage() {
  const wishlist = useWishlist();
  const { query, rows, total, marketplace } = wishlist;
  const view = useAppStore((s) => s.wishlistView);
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

  /**
   * The wishlist as a **walk**, so the printings modal's chevrons and arrow keys step along it.
   *
   * **`artCardId`, not `cardId`, and the difference is this list's own.** A stop is the printing
   * the modal rings and the card pane opens, which on this wall is what the tile is *drawn as* —
   * a pinned wish's own printing, and for an any-printing wish the newest printing of its oracle
   * card. `cardId` is what the wish is *for* and is `null` on half of them, so a walk built from
   * it would skip every unpinned wish and leave holes in a list the reader can see. The two agree
   * wherever a walk can be *started* from here anyway: the card menu is offered only on a pinned
   * wish, and a pinned wish is drawn as the printing it names.
   *
   * Memoised because the hook requires it — a fresh array republishes an identical walk under a
   * new identity and re-renders the modal for nothing.
   */
  const walk = useMemo(
    () =>
      listWalkStops(rows, (row) => ({
        cardId: row.artCardId,
        oracleId: row.oracleId,
        name: row.name,
      })),
    [rows],
  );
  usePublishCardWalk("your wishlist", walk);

  /**
   * The right-click menu, as one object for the whole page — `CardMenuDeps` is built per
   * surface, never per row.
   *
   * `rowMenu` answers `undefined` for a wish with no printing, which is what leaves those rows
   * without a menu: an absent `onContextMenu` is the same thing to the list as a row that never
   * asked for one, and the reader gets the app's plain suppression instead of a panel about a
   * card this row cannot name.
   */
  const { menu, menuKey } = useContextMenu();
  const { deps: menuDeps, error: menuFailure } = useCardMenuDeps();
  const rowMenu = useCallback(
    (row: WishRow) =>
      row.cardId === null
        ? undefined
        : menu(() => buildCardMenu(wishTarget(row, row.cardId!), menuDeps)),
    [menu, menuDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key, gated on the same `cardId`: a menu only
   *  a mouse can open is a menu half this app's readers do not have. */
  const rowMenuKey = useCallback(
    (row: WishRow) =>
      row.cardId === null
        ? undefined
        : menuKey(() => buildCardMenu(wishTarget(row, row.cardId!), menuDeps)),
    [menuKey, menuDeps],
  );

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
        <Figure label="Wishes" value={query.isPending ? "—" : count(total)} />
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

        {/* A write the right-click menu started and the backend refused, beside the banner
            above rather than folded into it: that one is about this list's own controls — a
            stepper press, a removal — and this one is about a card the reader filed somewhere
            from a menu that has already closed. */}
        <CardMenuRefusal error={menuFailure} />

        {!empty &&
          (view === "grid" ? (
            <WishlistGrid
              rows={rows}
              listKey={wishlist.queryKeyString}
              onNeedNextPage={onNeedNextPage}
              onSetQuantity={onSetQuantity}
              onRemove={onRemove}
              rowMenu={rowMenu}
              rowMenuKey={rowMenuKey}
              marketplace={marketplace}
            />
          ) : (
            <WishlistTable
              rows={rows}
              total={total}
              listKey={wishlist.queryKeyString}
              sort={wishlist.sort}
              onSort={wishlist.toggleSort}
              onNeedNextPage={onNeedNextPage}
              onSetQuantity={onSetQuantity}
              onRemove={onRemove}
              rowMenu={rowMenu}
              rowMenuKey={rowMenuKey}
              marketplace={marketplace}
            />
          ))}
      </div>
    </section>
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
