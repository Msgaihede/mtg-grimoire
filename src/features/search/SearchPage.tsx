import { useEffect, useRef, type RefObject } from "react";
import { useVirtualizer, type ReactVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ManaText } from "@/components/ManaText";
import { OwnedBadge } from "@/components/OwnedBadge";
import { RarityGem } from "@/components/RarityGem";
import { AddToCollectionButton, REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import type { DragPayload } from "@/features/decks/dnd";
import { parseFinishes } from "@/lib/finish";
import { ipc, ipcError, type CardSummary } from "@/lib/ipc";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { stopRowActivationKeys } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { CardGrid } from "./CardGrid";
import { FilterBar } from "./FilterBar";
import { needsNextPage, useCardSearch, type CardSearch } from "./useCardSearch";

/** Row height in px. Rows are uniform, so this is exact rather than an estimate. */
const ROW_HEIGHT = 44;

/** Height of the sticky header row, which the virtualiser has to account for. */
const HEADER_HEIGHT = 36;

/**
 * The six columns, shared by the header row and every body row so they stay aligned. The
 * last is 2.5rem of quick-add: a 24px button and the room to reach it.
 *
 * Name and type are `2fr`/`1fr` rather than `1fr` and a 16rem cap. A capped track is
 * *inflexible*: grid grows it to its cap out of the free space **before** any `fr` track is
 * fed, so on a narrow window with the card pane open the type column took its 16rem and the
 * name column was left with nothing — a row of mana symbols overflowing a zero-width track
 * across the set beside it. Two flexible tracks share the squeeze instead: at 1280px with
 * the pane open every column keeps a readable share, and closed they measure 381/190 where
 * the cap gave 315/256 — the name, which is what identifies a row, now truncates last.
 */
const GRID =
  "grid grid-cols-[minmax(0,2fr)_8rem_minmax(0,1fr)_6rem_6rem_2.5rem] items-center gap-3";

/**
 * What a tile carries when it is dragged: the printing it draws, and nothing about this view.
 *
 * At module scope because it must hold still — the wall re-registers a tile's drag when this
 * changes identity, and a fresh arrow per render would do that on every scrolled row (see
 * `CardGrid`'s `dragPayload`).
 *
 * The tiles only. The table beside them is the view for *comparing* — five columns of facts
 * and a price — and a row there is read rather than picked up; the drag sources spec §1 names
 * are the wall's tiles, the two lists that are inventories, and the pane's printings.
 */
const tileDrag = (card: CardSummary): DragPayload => ({
  kind: "card",
  cardId: card.id,
  name: card.name,
});

/**
 * Keyboard focus on a row, in the shape the rest of the app uses — an outline, never a
 * ring (see `FilterBar`'s `FOCUS`). The offset is *negative* here: rows are stacked
 * flush inside a scroller, and an outline standing 2px off one would be drawn over its
 * neighbours and clipped at the top and bottom of the list.
 */
const ROW_FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

function Row({ card }: { card: CardSummary }) {
  return (
    <>
      <span role="cell" className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{card.name}</span>
        {/* The printed symbols, from the bundled font — the same rule as the detail pane:
            a cost is read as symbols, and `{1}{W}{U}` is a wire format. */}
        <ManaText source={card.manaCost} className="shrink-0 text-xs" />
        {/* The two facts the tile carries over its art, in the cell that identifies the row —
            because they are facts about the *card*, and the table's other five columns are
            about the printing. One truth, stated the same way in both layouts. */}
        <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />
      </span>
      {/* `setName` is nullable and the code is not, so the code is what is shown; the
          full name rides along as the tooltip when there is one. Mono because a collector
          number is data — the same rule as the grid caption and the pane. */}
      <span role="cell" className="truncate font-mono text-dim" title={card.setName ?? undefined}>
        {card.setCode.toUpperCase()} · {card.collectorNumber}
      </span>
      <span role="cell" className="truncate text-dim">
        {card.typeLine ?? "—"}
      </span>
      {/* Gem dot plus tinted word, exactly as the grid tiles caption a rarity — the two
          views show the same fact and there is no reason for it to look like two facts. */}
      <span role="cell" className="min-w-0">
        <RarityGem rarity={card.rarity} withLabel className="max-w-full" />
      </span>
      <span role="cell" className="text-right font-mono tabular-nums">
        {usdPrice(card.priceUsd)}
      </span>
      {/* The row opens the card on any click and on Enter or Space, and every one of those
          lands here too: without stopping them, recording a copy would also open the card,
          and typing `12` into the quantity box would scroll the list a screenful. Those two
          keys and no others — a blanket `stopPropagation` also took Escape away from the
          card pane, which listens on `window`. */}
      <span role="cell" onClick={(e) => e.stopPropagation()} onKeyDown={stopRowActivationKeys}>
        <AddToCollectionButton
          className={REVEAL_ON_HOVER}
          target={{
            cardId: card.id,
            name: card.name,
            setCode: card.setCode,
            collectorNumber: card.collectorNumber,
            // Both ride on `CardSummary`, which is what lets a row be honest: the popup
            // offers the finishes this printing exists in — the backend checks the enum and
            // not the card, so a foil-only printing would otherwise take a nonfoil entry —
            // and a wish made here can be for the card rather than for this printing.
            oracleId: card.oracleId,
            finishes: parseFinishes(card.finishes),
          }}
        />
      </span>
    </>
  );
}

/**
 * Card search: a filter bar, and every match in one scroll.
 *
 * The result list is virtualised because an unfiltered search matches the whole database
 * — ~117 k rows — and the page opens on exactly that.
 */
export function SearchPage() {
  const search = useCardSearch();
  const { query, rows, searchKey } = search;
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = query;
  const view = useAppStore((s) => s.searchView);

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
    // The sticky header shares the scroll container with the rows, so the list does not
    // start at the container's origin.
    scrollMargin: HEADER_HEIGHT,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

  // A new search reuses the same scroll container, and a browser does not reset scrollTop
  // for new content — it clamps the old offset into the new, usually far shorter, list.
  // Refining a search from 13 000 matches to 40 would otherwise drop the reader at the
  // bottom of results they have never seen, and trip the paging effect below into
  // fetching a second page nobody asked for.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [searchKey, virtualizer]);

  // Warm the images for the page that just landed, so its first paint is not a wall of
  // empty frames. The grid's own overscan mounts two rows of off-screen `<img>`s, which
  // covers the *next scroll*; this covers the *next page*. Grid only — the table shows no
  // art to warm.
  //
  // Keyed on an identity of the newest page rather than on `query.data`: an infinite
  // query hands back a new `data` object on every background refetch, and re-firing there
  // would re-walk 50 already-cached images for nothing. The page count alone is not
  // enough either — `keepPreviousData` means a new search with the same number of pages
  // never moves it, so the search the reader actually typed would be the one page that
  // never got warmed.
  const pages = query.data?.pages;
  const pageCount = pages?.length ?? 0;
  const latestPage = pages?.[pageCount - 1]?.items;
  const isPlaceholder = query.isPlaceholderData;
  const latestKey = `${searchKey}|${pageCount}|${latestPage?.[0]?.id ?? ""}`;
  useEffect(() => {
    // Placeholder rows belong to the search *before* this one; they are already warm, and
    // the real page is one render away.
    if (view !== "grid" || isPlaceholder) return;
    if (!latestPage || latestPage.length === 0) return;
    // Fire-and-forget by design: the command resolves as soon as the work is queued, and
    // a tile whose prefetch failed simply fetches when it renders.
    void ipc
      .prefetchImages(
        latestPage.map((c) => c.id),
        "grid",
      )
      .catch(() => {});
    // `latestPage` and `view` are both deliberately out of the dependency list.
    // `latestPage` is a fresh array on every render, and `latestKey` is the part that
    // means "a different page is now the newest one". `view` is read but not depended on:
    // it is a guard, not a trigger. Depending on it would make every table→grid toggle
    // re-send the newest page — 50 keys the grid warmed when they landed and the tiles
    // will hit from disk anyway — which is the same wasted round trip `latestKey` exists
    // to avoid. The cost is that a page which arrives *while the table is showing* is
    // never warmed, not even on the switch back: those tiles fetch as they mount, which
    // is exactly how the grid behaved before this effect existed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestKey, isPlaceholder]);

  // Paging is driven by the virtualiser's window rather than a scroll handler: it already
  // knows which row is at the bottom, and it recomputes on resize too, which a scroll
  // event never fires for.
  useEffect(() => {
    // The table's window, so only the table's paging. While the grid is showing, this
    // virtualiser has no scroll element to measure and its idea of the bottom row is a
    // leftover — the grid pages itself, through `onNeedNextPage`.
    if (view !== "table") return;
    // `isFetchNextPageError` is a stop, not a detail: a failed page leaves `hasNextPage`
    // true with the reader still at the bottom, so without it this effect re-fires on
    // every render — a tight retry loop against a database that is already saying no.
    // The banner's Try again button is the way back.
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    if (needsNextPage(lastRendered, rows.length)) void fetchNextPage();
  }, [
    view,
    hasNextPage,
    isFetchingNextPage,
    isFetchNextPageError,
    fetchNextPage,
    lastRendered,
    rows.length,
  ]);

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not shown: the filter bar says what this view is far better than a title would,
          and the window is short. It is here to name the view for assistive tech. */}
      <h2 className="sr-only">Card search</h2>

      <FilterBar search={search} />

      <Results
        search={search}
        virtualizer={virtualizer}
        virtualRows={virtualRows}
        scrollRef={scrollRef}
      />
    </section>
  );
}

/**
 * How many matches there are, in words.
 *
 * The backend stops counting at 5 000 rather than scanning 116 k rows for a number nobody
 * reads precisely, so past that this says `5,000+ cards` — a floor, which is true —
 * instead of `5,000 cards`, which would not be.
 */
function countOf(total: number, capped: boolean): string {
  const n = `${total.toLocaleString("en-US")}${capped ? "+" : ""}`;
  return `${n} ${total === 1 && !capped ? "card" : "cards"}`;
}

/**
 * The one line that says what the result area is currently showing.
 *
 * Exported for the deck editor's docked panel, which shows the same six states over the same
 * hook in a 384px column. Two copies of these sentences would be two answers to "why is this
 * list empty" — and the one that matters most (an empty database still syncing, which is not
 * a search that missed) is the one a second copy would be likeliest to get wrong.
 */
export function summaryOf(search: CardSearch, failure: string | null): string {
  const { query, rows, total, totalIsCapped, unfiltered } = search;

  if (rows.length === 0) {
    // With no rows there is nothing to caption, so this line carries the whole story.
    if (failure) return failure;
    if (query.isPending) return "Searching…";
    // An unfiltered search asks for everything, so an empty answer to it is a statement
    // about the database, not about the query. Saying "no cards match" here would blame
    // the user for a sync that has not finished.
    return unfiltered
      ? "Card database is empty — waiting for the first sync to finish."
      : "No cards match these filters.";
  }

  const count = countOf(total, totalIsCapped);
  if (query.isFetchingNextPage) return `${count} · loading more…`;
  if (query.isFetching) return `${count} · searching…`;
  return count;
}

function Results({
  search,
  virtualizer,
  virtualRows,
  scrollRef,
}: {
  search: CardSearch;
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>;
  virtualRows: VirtualItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const { query, rows, total, totalIsCapped, searchKey } = search;
  // Read here rather than taken as a prop: the layout is the result area's own business,
  // and the page above it only needs to know which pager is live.
  const view = useAppStore((s) => s.searchView);
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list
  // never has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);

  // query-core keeps `data` when a fetch fails, so `isError` arrives with every page that
  // did load still in hand. Reading it as "show the error instead" would throw away 400
  // rows because page 9 hit the ingest's database lock, or because a window-focus refetch
  // failed on results the reader was part way through.
  const failure = query.isError ? ipcError(query.error) : null;
  const empty = rows.length === 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* One live region, mounted for the life of the view: a region that appears together
          with its text announces nothing, because there was no change for a screen reader
          to notice. The rows stay outside it — a live region wrapped around a virtualised
          list would read out every row that scrolls into the DOM. */}
      <p
        role="status"
        className={cn(
          empty ? "py-16 text-center text-sm" : "text-xs",
          empty && failure ? "text-destructive" : "text-dim",
        )}
      >
        {summaryOf(search, failure)}
      </p>

      {!empty && failure && (
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
      )}

      {!empty &&
        (view === "grid" ? (
          <CardGrid
            rows={rows}
            listKey={searchKey}
            selectedId={selectedCardId}
            onSelect={selectCard}
            // Spec §1's first drag source: a tile is a printing the reader can carry to a
            // deck's zone or to the sidebar. The click paths beside it — the quick-add below,
            // the pane the art opens — are unchanged; this is speed, not capability.
            dragPayload={tileDrag}
            // Spec §7: "'owned' badges appear in search once a wish is fulfilled." Drawn
            // unconditionally because the badge is its own guard — on a browse of the whole
            // database almost every tile has nothing to say, and says nothing.
            badge={(card) => <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />}
            // The tile's one control, built from the row it is about: the popup offers the
            // finishes this printing exists in — a foil-only card must not take a nonfoil
            // entry — and a wish made here can be for the card rather than for this piece of
            // cardboard. `static` hands the anchoring to the tile's caption, so a 256px
            // popup on a 170px tile opens from the tile's left edge instead of off the
            // scroller's.
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
          <div
            ref={scrollRef}
            role="table"
            aria-label="Search results"
            // The header row plus every match, not just the rows currently in the DOM —
            // otherwise a virtualised list tells assistive tech the database holds 20 cards.
            // `-1` is ARIA's "the total is unknown", which is exactly what a capped count
            // is: 5 000 would be a smaller lie than 20, but still a lie.
            aria-rowcount={totalIsCapped ? -1 : total + 1}
            tabIndex={0}
            className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
          >
            {/* Sticky inside the scroll container rather than sitting above it: a header
              outside the scroller is wider than the rows by exactly the scrollbar, and
              the columns drift apart by that much as soon as the list overflows.

              `z-20` beats the `z-10` a row takes while a quick-add is open in it. Equal
              z-indexes are resolved by DOM order, and every row comes after this header —
              so at `z-10` the row scrolling under it would be drawn *over* it. */}
            <div
              role="row"
              aria-rowindex={1}
              style={{ height: HEADER_HEIGHT }}
              className={cn(
                GRID,
                "sticky top-0 z-20 border-b border-border bg-surface px-3 text-xs text-dim",
              )}
            >
              {/* `truncate` on every label, because two of these tracks are `minmax(0,…)`
                  and collapse to nothing in a narrow window with the card pane open — and a
                  header that overflows a zero-width track is drawn *over* the next column's,
                  which reads as a rendering fault rather than as a squeeze. */}
              <span role="columnheader" className="truncate">
                Name
              </span>
              <span role="columnheader" className="truncate">
                Set
              </span>
              <span role="columnheader" className="truncate">
                Type
              </span>
              <span role="columnheader" className="truncate">
                Rarity
              </span>
              {/* Spec §5: a price is never shown without saying how old it is. The detail
                  pane has room to say it in the open; a 36px header row does not, so the
                  same sentence rides as the column's tooltip and inside its accessible
                  name. The label *begins* with the visible word, which is what keeps an
                  overriding `aria-label` legitimate here (WCAG 2.5.3, label in name) —
                  "Price" still selects this column for anyone driving it by voice. */}
              <span
                role="columnheader"
                className="cursor-help truncate text-right"
                title={PRICES_AS_OF}
                aria-label={`Price. ${PRICES_AS_OF}`}
              >
                Price
              </span>
              {/* The quick-add column. Nothing to show, and a header a screen reader still
                  needs: an unnamed column is announced as "column 6" for every row. */}
              <span role="columnheader" className="sr-only">
                Actions
              </span>
            </div>

            {/* Holds the scrollbar open to the full list height while the rows inside it are
              positioned absolutely. */}
            <div
              role="rowgroup"
              style={{ height: virtualizer.getTotalSize(), position: "relative" }}
            >
              {virtualRows.map((v) => {
                const card = rows[v.index];
                return (
                  // Keyed by row position, not by card id: two pages fetched either side of
                  // a sync can carry the same printing twice, and duplicate keys would be a
                  // React warning plus a dropped row.
                  <div
                    key={v.key}
                    role="row"
                    aria-rowindex={v.index + 2}
                    // A row opens the card, from the mouse and from the keyboard both — the
                    // table is the view for comparing prices, and being unable to open the
                    // one you picked would make it a dead end for anyone not using a mouse.
                    tabIndex={0}
                    onClick={() => selectCard(card.id)}
                    onKeyDown={(e) => {
                      if (e.key !== "Enter" && e.key !== " ") return;
                      // Space scrolls the container it is pressed in, which would jump the
                      // list by a screen at the same time as opening the card.
                      e.preventDefault();
                      selectCard(card.id);
                    }}
                    className={cn(
                      GRID,
                      // `group`: the quick-add in the last cell shows itself on hover, and
                      // on the row taking focus — which is the keyboard's version of hover.
                      //
                      // The `:has` rule below: a row is positioned *and* transformed, which
                      // makes it a stacking context — so an open popup's `z-20` cannot lift
                      // it over the next row, which paints later simply for being later in
                      // the DOM. The row it is open in has to come forward instead — as far
                      // as the rows, and no further: the sticky header above is `z-20`,
                      // because a row lifted to its level would scroll over it.
                      "group absolute inset-x-0 top-0 cursor-pointer border-b border-border/50 px-3",
                      "has-[[aria-expanded=true]]:z-10",
                      "text-sm transition-colors duration-150 motion-reduce:transition-none",
                      ROW_FOCUS,
                      // Which row the open pane is about. A quiet surface rather than gold:
                      // forty rows are on screen and the one being read is already the one
                      // beside the pane.
                      card.id === selectedCardId ? "bg-surface text-text" : "hover:bg-surface/60",
                    )}
                    // `start` is measured from the scroll container, which the header shares;
                    // this div begins below it, so the header's height comes back off.
                    style={{
                      height: v.size,
                      transform: `translateY(${v.start - HEADER_HEIGHT}px)`,
                    }}
                  >
                    <Row card={card} />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
    </div>
  );
}
