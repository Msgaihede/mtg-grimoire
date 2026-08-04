import { useEffect, useRef, type RefObject } from "react";
import { useVirtualizer, type ReactVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ipcError, type CardSummary } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { FilterBar } from "./FilterBar";
import { needsNextPage, useCardSearch, type CardSearch } from "./useCardSearch";

/** Row height in px. Rows are uniform, so this is exact rather than an estimate. */
const ROW_HEIGHT = 44;

/** Height of the sticky header row, which the virtualiser has to account for. */
const HEADER_HEIGHT = 36;

/** The five columns, shared by the header row and every body row so they stay aligned. */
const GRID = "grid grid-cols-[minmax(0,1fr)_8rem_minmax(0,16rem)_6rem_6rem] items-center gap-3";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** Prices are the one column worth aligning on the decimal point; absent is an em dash. */
function price(value: number | null): string {
  return value === null ? "—" : usd.format(value);
}

function Row({ card }: { card: CardSummary }) {
  return (
    <>
      <span role="cell" className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{card.name}</span>
        {card.manaCost && <span className="shrink-0 text-xs text-muted">{card.manaCost}</span>}
      </span>
      {/* `setName` is nullable and the code is not, so the code is what is shown; the
          full name rides along as the tooltip when there is one. */}
      <span role="cell" className="truncate text-muted" title={card.setName ?? undefined}>
        {card.setCode.toUpperCase()} · {card.collectorNumber}
      </span>
      <span role="cell" className="truncate text-muted">
        {card.typeLine ?? "—"}
      </span>
      <span role="cell" className="truncate capitalize text-muted">
        {card.rarity ?? "—"}
      </span>
      <span role="cell" className="text-right tabular-nums">
        {price(card.priceUsd)}
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

  // Paging is driven by the virtualiser's window rather than a scroll handler: it already
  // knows which row is at the bottom, and it recomputes on resize too, which a scroll
  // event never fires for.
  useEffect(() => {
    // `isFetchNextPageError` is a stop, not a detail: a failed page leaves `hasNextPage`
    // true with the reader still at the bottom, so without it this effect re-fires on
    // every render — a tight retry loop against a database that is already saying no.
    // The banner's Try again button is the way back.
    if (!hasNextPage || isFetchingNextPage || isFetchNextPageError) return;
    if (needsNextPage(lastRendered, rows.length)) void fetchNextPage();
  }, [
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

/** The one line that says what the result area is currently showing. */
function summaryOf(search: CardSearch, failure: string | null): string {
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
  const { query, rows, total, totalIsCapped } = search;

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
          empty && failure ? "text-destructive" : "text-muted",
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
              className="ml-auto shrink-0 rounded-md border border-destructive/40 px-2 py-1 transition-colors hover:bg-destructive/20"
            >
              Try again
            </button>
          )}
        </div>
      )}

      {!empty && (
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
              the columns drift apart by that much as soon as the list overflows. */}
          <div
            role="row"
            aria-rowindex={1}
            style={{ height: HEADER_HEIGHT }}
            className={cn(
              GRID,
              "sticky top-0 z-10 border-b border-border bg-surface px-3 text-xs text-muted",
            )}
          >
            <span role="columnheader">Name</span>
            <span role="columnheader">Set</span>
            <span role="columnheader">Type</span>
            <span role="columnheader">Rarity</span>
            <span role="columnheader" className="text-right">
              Price
            </span>
          </div>

          {/* Holds the scrollbar open to the full list height while the rows inside it are
              positioned absolutely. */}
          <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
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
                  className={cn(
                    GRID,
                    "absolute inset-x-0 top-0 border-b border-border/50 px-3 text-sm",
                  )}
                  // `start` is measured from the scroll container, which the header shares;
                  // this div begins below it, so the header's height comes back off.
                  style={{ height: v.size, transform: `translateY(${v.start - HEADER_HEIGHT}px)` }}
                >
                  <Row card={card} />
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
