import { useCallback, useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useContextMenu } from "@/components/menu/useContextMenu";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { OwnedBadge } from "@/components/OwnedBadge";
import { VirtualTable } from "@/components/table/VirtualTable";
import { buildCardMenu } from "@/features/card/cardMenu";
import { CardMenuRefusal } from "@/features/card/CardMenuRefusal";
import { listWalkStops, usePublishCardWalk } from "@/features/card/cardWalk";
import { useCardMenuDeps } from "@/features/card/useCardMenuDeps";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { CardGrid, PHONE_TILE_WIDTH } from "@/features/search/CardGrid";
import {
  cardTarget,
  columnsFor,
  summaryOf,
  tileDrag,
  tileFinish,
  tileTreatment,
  tileGameChanger,
} from "@/features/search/SearchPage";
import type { CardSearch } from "@/features/search/useCardSearch";
import { parseFinishes } from "@/lib/finish";
import { WALL_CARD_VARIANT } from "@/lib/images";
import { ipc, ipcError, type CardSummary } from "@/lib/ipc";
import { statusLine } from "@/lib/motion";
import { pricesAsOf } from "@/lib/prices";
import { priceRange } from "@/lib/priceRange";
import { useAppStore } from "@/lib/store";
import { useNarrowWindow } from "@/lib/useNarrowWindow";
import { cn } from "@/lib/utils";

/**
 * The Tags page's answer: every printing a picked motif reaches, as a wall of art or as a table.
 *
 * ## It is `SearchPage`'s `Results`, and deliberately not a variation on it
 *
 * The two pages ask the corpus different questions and draw the **same rows** — `CardSummary`,
 * from `search_cards`, under the same filters plus a tag term. So every feature the search view's
 * result area has is a feature this one owes: the right-click menu and its keyboard twin, the
 * card pane, the printings walk, the drag into a deck, the quick-add, the badges, the crown, the
 * paging, the sortable headers, the marketplace's price column. Each of those is wired here the
 * way it is wired there, and the callbacks the two walls share are **imported** rather than
 * copied — see `SearchPage.tsx`, where each says what breaks without it.
 *
 * ## The one thing that is not the same, and it is the point of the page
 *
 * **Collapse is off.** `useCardSearch`'s `defaultAllPrintings` is what does it and the reason is
 * written there: an art tag is a fact about *this illustration*, so a collapsed row would stand
 * for five printings and be drawn by whichever is newest — a picture that need have nothing to do
 * with the motif the reader searched for. Art results are printings. Everything downstream
 * follows from that: `card.printings` is 1 on nearly every row, so the wall's printings corner
 * and the table's `×n printings` cell stay quiet on their own.
 */
export function TagResults({ search }: { search: CardSearch }) {
  const { query, rows, total, totalIsCapped, searchKey, marketplace } = search;
  const tip = useTooltip();
  // Only the Price column and the tooltip binder depend on it, and a `TableColumn[]` rebuilt
  // every render would re-key every header — so it is rebuilt when the marketplace changes and
  // not otherwise. `tip`'s own identity never changes (`useTooltip` memoises it on the context
  // alone), so it costs the memo nothing to depend on it too.
  const columns = useMemo(() => columnsFor(marketplace, tip), [marketplace, tip]);
  // The currency both layouts quote in, named once — the marketplace's, and never a bare
  // `Intl.NumberFormat`. The table reads it through `columnsFor` above and the wall's chin reads
  // it here, so the two cannot draw one tag search in two currencies.
  const currency = marketplace.currency;
  // The Tags page's own layout preference, not the search's — see `store.ts`, where the field
  // says why a reader who put this wall in a table said nothing about their card search.
  const view = useAppStore((s) => s.tagsView);
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list never
  // has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  // What the wall below is sized by — see its `baseTileWidth`. A consumer of the app's one
  // viewport branch rather than a second one; the hook argues for itself at its own site.
  const narrowWindow = useNarrowWindow();

  /**
   * Warm the images for the page that just landed, so its first paint is not a wall of empty
   * frames — `SearchPage`'s effect, over this page's rows.
   *
   * Keyed on an identity of the newest page rather than on `query.data`: an infinite query hands
   * back a new `data` object on every background refetch, and re-firing there would re-walk 50
   * already-cached images for nothing. The page count alone is not enough either —
   * `keepPreviousData` means a new tag with the same number of pages never moves it, so the
   * motif the reader actually picked would be the one page that never got warmed.
   *
   * It matters **more** here than it does on the search page, and that is the one thing about it
   * that is this page's rather than inherited: a reader browsing by motif is looking at the
   * pictures, which is the whole reason they came.
   */
  const pages = query.data?.pages;
  const pageCount = pages?.length ?? 0;
  const latestPage = pages?.[pageCount - 1]?.items;
  const isPlaceholder = query.isPlaceholderData;
  const latestKey = `${searchKey}|${pageCount}|${latestPage?.[0]?.id ?? ""}`;
  useEffect(() => {
    // Placeholder rows belong to the search *before* this one; they are already warm, and the
    // real page is one render away.
    if (view !== "grid" || isPlaceholder) return;
    if (!latestPage || latestPage.length === 0) return;
    // Fire-and-forget by design: the command resolves as soon as the work is queued, and a tile
    // whose prefetch failed simply fetches when it renders.
    void ipc
      .prefetchImages(
        latestPage.map((c) => c.id),
        // The wall's own variant, never a literal: warming a size the tiles do not ask for
        // reports success and leaves every tile to fetch cold — see `WALL_CARD_VARIANT`.
        WALL_CARD_VARIANT,
      )
      .catch(() => {});
    // `latestPage` and `view` are both deliberately out of the dependency list, for the reasons
    // `SearchPage`'s twin gives: `latestPage` is a fresh array on every render and `latestKey` is
    // the part that means "a different page is now the newest one", and `view` is a guard rather
    // than a trigger — depending on it would re-send the newest page on every table→grid toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestKey, isPlaceholder]);

  /**
   * These results as a **walk**, so the printings modal's chevrons and arrow keys step along them.
   *
   * Published from here rather than derived in the modal for `cardWalk.ts`'s reason: the order is
   * the query's, narrowed by a motif and a filter bar and sorted by whichever header was last
   * clicked, and `AllPrintingsDialog` is mounted at `App` level with no way to ask. **From `rows`
   * rather than from either layout**, which is what keeps the wall and the table agreeing.
   *
   * Memoised because the hook requires it: an array rebuilt on every render republishes an
   * identical walk under a new identity, and this page re-renders on every keystroke in its tag
   * box.
   */
  const walk = useMemo(
    () =>
      listWalkStops(rows, (card) => ({
        cardId: card.id,
        oracleId: card.oracleId,
        name: card.name,
      })),
    [rows],
  );
  usePublishCardWalk("these tag results", walk);

  /**
   * The right-click menu, built here rather than in either layout: one object for the page, as
   * `CardMenuDeps` asks — the two views are the same list, and a menu whose writes differed
   * between them would be two answers to one question.
   */
  const { menu, menuKey } = useContextMenu();
  const { deps: menuDeps, error: menuFailure } = useCardMenuDeps();
  /** One row's or one tile's handler. The item list is a **thunk** inside `menu`, so a wall of
   *  forty pays for nothing until a reader actually right-clicks one of them. */
  const cardMenu = useCallback(
    (card: CardSummary, picked: readonly CardSummary[] = []) =>
      menu(() => buildCardMenu(cardTarget(card), { ...menuDeps, picked: picked.map(cardTarget) })),
    [menu, menuDeps],
  );
  /** The same menu on Shift+F10 and the ContextMenu key. Wired everywhere `cardMenu` is, because
   *  a menu only a mouse can open is a menu half this app's readers do not have. */
  const cardMenuKey = useCallback(
    (card: CardSummary, picked: readonly CardSummary[] = []) =>
      menuKey(() =>
        buildCardMenu(cardTarget(card), { ...menuDeps, picked: picked.map(cardTarget) }),
      ),
    [menuKey, menuDeps],
  );

  // query-core keeps `data` when a fetch fails, so `isError` arrives with every page that did
  // load still in hand. Reading it as "show the error instead" would throw away 400 rows because
  // page 9 hit the ingest's database lock.
  const failure = query.isError ? ipcError(query.error) : null;
  const empty = rows.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* One live region, mounted for the life of the view: a region that appears together with
          its text announces nothing, because there was no change for a screen reader to notice.
          The rows stay outside it — a live region wrapped around a virtualised list would read
          out every row that scrolls into the DOM. */}
      <p
        role="status"
        className={cn(
          empty ? "py-16 text-center text-sm" : "text-xs",
          empty && failure ? "text-destructive" : "text-dim",
        )}
      >
        {/* `summaryOf`, imported rather than rewritten. Two copies of those sentences would be two
            answers to "why is this list empty", and the one that matters most — an empty database
            still syncing, which is not a search that missed — is what a second copy would get
            wrong. It reads `unfiltered`, which counts a picked tag as the reader asking: a motif
            that matches nothing says so, and a page with no chips over a cold database still says
            to wait for the sync. */}
        {summaryOf(search, failure)}
      </p>

      {/* The banner grows into place rather than shoving the results list down by its whole height
          the instant a page fails. The animated element is the wrapper and carries only
          `overflow-hidden`: `statusLine` takes `height` to 0, and under `box-sizing: border-box` a
          box with its own padding and border can never be shorter than the two of them.
          `role="alert"` stays on the element that holds the sentence. */}
      <AnimatePresence initial={false}>
        {!empty && failure && (
          <motion.div {...statusLine} className="overflow-hidden">
            <div
              role="alert"
              className="flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
            >
              <span className="min-w-0">
                {query.isFetchNextPageError
                  ? "Could not load more cards"
                  : "Could not refresh these results"}{" "}
                — {failure}
              </span>
              {query.isFetchNextPageError && (
                <button
                  type="button"
                  onClick={() => void query.fetchNextPage()}
                  className="ml-auto shrink-0 rounded-md border border-destructive/40 px-2 py-1 transition-colors hover:bg-destructive/20 motion-reduce:transition-none"
                >
                  Try again
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* A write the menu started and the backend refused, said where the reader made it — beside
          the banner above rather than folded into it, because that one is about the *list* and
          this is about a card in it. */}
      <CardMenuRefusal error={menuFailure} />

      {!empty &&
        (view === "grid" ? (
          <CardGrid
            rows={rows}
            listKey={searchKey}
            // **A phone gets a narrower card, so the wall is two columns rather than one.** The
            // same width the other three page-width walls take and for the same arithmetic: 324px
            // of wall at 390, where 170 floors to one column. `PHONE_TILE_WIDTH` carries the
            // derivation, the 160 that looks like a fix and is not, and the decision that the
            // chin does not scale with it.
            baseTileWidth={narrowWindow ? PHONE_TILE_WIDTH : undefined}
            // Named, because `CardGrid` defaults to `Search results` — the wall it was written
            // for. Two walls announcing the same name is the kind of thing only a reader who
            // cannot see them ever notices, and the table beside it already says `Tag results`.
            label="Tag results"
            // Which zoom is this wall's. Its own section, so a reader who sizes a motif's
            // illustrations up to look at them has not resized the card search — see `CardGrid`'s
            // `zoomSection` for why it is required rather than defaulted.
            zoomSection="tags"
            // Ctrl and Shift build a set of tiles, and a drag from any member carries all of
            // them (issue #214) — the same wall the search page draws, so the same gestures.
            selectionScope="tags"
            selectedId={selectedCardId}
            onSelect={selectCard}
            // The arrow keys walk the wall, and the selection walks with them — which on this page
            // means the card pane really does move to the card the caret lands on, because the
            // `selectedId` above and the `onSelect` beside it are the same store field the pane
            // reads.
            arrowNav
            // A tile is a printing the reader can carry to a deck's category column or to the
            // sidebar. Imported from the search view rather than restated: what a card *is* when
            // it lands somewhere does not depend on how the reader found it.
            dragPayload={tileDrag}
            badge={(card) => <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />}
            // **Nearly always absent here, and that is the collapse being off rather than an
            // omission.** The corner counts the printings a collapsed row stands for; uncollapsed
            // every row is one printing, so the guard inside it is what keeps the wall quiet. It
            // is still wired, because the reader may press All printings back off — at which point
            // this wall is the search's wall and says what that one says.
            topLeft={(card) =>
              card.printings > 1 ? (
                <span
                  {...tip(`${card.printings} printings matched these filters`)}
                  className={cn(
                    "block whitespace-nowrap tabular-nums text-text",
                    "text-[calc(10px*var(--mark-scale,1))] leading-none",
                  )}
                >
                  {card.printings} printings
                </span>
              ) : null
            }
            // The foil-only and etched-only printings, which Scryfall's art has no way to show.
            finish={tileFinish}
            treatment={tileTreatment}
            // The crown, in the same chip as that mark.
            gameChanger={tileGameChanger}
            // What the chin says one copy costs — the **spread**, through the same `priceRange`
            // the table beside it uses, so a wall and its table cannot quote different money
            // about one search.
            //
            // **Nearly always one figure here, and that is the collapse being off** rather than
            // the helper being the wrong one: uncollapsed, a row is one printing and both ends
            // carry its own price, which `priceRange` folds into a single price. It is still the
            // spread that is asked for, because the reader may press All printings back on — at
            // which point this wall is the search's wall and has to say what that one says.
            //
            // Spec §5's as-of sentence is said once under this wall, not on forty tooltips, which
            // is why this slot is a bare figure.
            money={(card) => priceRange(card.priceLow, card.priceHigh, currency)}
            cardMenu={cardMenu}
            cardMenuKey={cardMenuKey}
            // The tile's one control, built from the row it is about: the popup offers the
            // finishes this printing exists in, and a wish made here can be for the card rather
            // than for this piece of cardboard. `static` hands the anchoring to the tile's
            // caption, so a 256px popup on a 170px tile opens from the tile's left edge instead of
            // off the scroller's.
            action={(card) => (
              <AddToCollectionButton
                align="start"
                className={cn(REVEAL_ON_HOVER, "static")}
                target={{
                  cardId: card.id,
                  name: card.name,
                  setCode: card.setCode,
                  collectorNumber: card.collectorNumber,
                  oracleId: card.oracleId,
                  finishes: parseFinishes(card.finishes),
                }}
              />
            )}
            onNeedNextPage={() => {
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                void query.fetchNextPage();
              }
            }}
          />
        ) : (
          <VirtualTable
            rows={rows}
            columns={columns}
            label="Tag results"
            // `null` is ARIA's "the total is unknown", which is exactly what a capped count is.
            total={totalIsCapped ? null : total}
            // Changing the sort changes the query key and therefore this, so a re-sorted list
            // starts at the top through the scroll-reset that was already there. A changed tag
            // moves it too, which is what makes picking a second motif start at the top.
            listKey={searchKey}
            sort={search.sort}
            onSort={search.toggleSort}
            // A row opens the card, from the mouse and from the keyboard both.
            onActivate={(card) => selectCard(card.id)}
            isSelected={(card) => card.id === selectedCardId}
            // The same menu the wall's tiles offer, on the row that stands for the same printing.
            // The row's own `onKeyDown` runs first and is not replaced: it answers Enter and Space
            // (opening the card), and `menuKey` answers Shift+F10 and the ContextMenu key.
            renderRow={(props, card) => (
              <div
                {...props}
                onContextMenu={cardMenu(card)}
                onKeyDown={(e) => {
                  props.onKeyDown?.(e);
                  cardMenuKey(card)(e);
                }}
              />
            )}
            onNeedNextPage={() => {
              // `isFetchNextPageError` is a stop, not a detail: a failed page leaves
              // `hasNextPage` true with the reader still at the bottom, so without it this fires
              // on every render — a tight retry loop against a database already saying no.
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                void query.fetchNextPage();
              }
            }}
          />
        ))}

      {/* **Spec §5: a price is never shown without saying how old it is** — the wall's chins
          started quoting money on 2026-08-26, so the rule reaches this page where it did not
          before. `pricesAsOf` names the marketplace as well as the date, which matters with five
          in the picker.

          Said **once** here rather than as a tooltip on every one of forty tiles, and **grid
          only**: the table says it in the Price column's header through the same `columnsFor`
          the search page uses, so drawing it here too would state it twice in one view. */}
      {!empty && view === "grid" && (
        <p className="shrink-0 text-[0.7rem] text-dim">{pricesAsOf(marketplace)}</p>
      )}
    </div>
  );
}
