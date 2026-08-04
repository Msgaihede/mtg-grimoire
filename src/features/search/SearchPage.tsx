import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useVirtualizer, type ReactVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { ipcError, type CardSummary } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import {
  COLOR_KEYS,
  COLOR_LABEL,
  FORMATS,
  needsNextPage,
  useCardSearch,
  type ColorKey,
} from "./useCardSearch";

/** Row height in px. Rows are uniform, so this is exact rather than an estimate. */
const ROW_HEIGHT = 44;

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
 * Card search: a debounced box, three filters, and every match in one scroll.
 *
 * The result list is virtualised because an unfiltered search matches the whole database
 * — ~117 k rows — and the page opens on exactly that.
 */
export function SearchPage() {
  const { text, setText, format, setFormat, colors, toggleColor, query, rows, total, unfiltered } =
    useCardSearch();
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

  // Paging is driven by the virtualiser's window rather than a scroll handler: it already
  // knows which row is at the bottom, and it recomputes on resize too, which a scroll
  // event never fires for.
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage && needsNextPage(lastRendered, rows.length)) {
      void fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, lastRendered, rows.length]);

  return (
    <section className="flex h-full flex-col gap-4">
      {/* Not shown: the filter bar says what this view is far better than a title would,
          and the window is short. It is here to name the view for assistive tech. */}
      <h2 className="sr-only">Card search</h2>

      <div className="flex flex-wrap items-center gap-3">
        <label htmlFor="card-search-text" className="sr-only">
          Search cards
        </label>
        <input
          id="card-search-text"
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search cards…"
          className="min-w-56 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
        />

        <label htmlFor="card-search-format" className="text-sm text-muted">
          Format
        </label>
        <select
          id="card-search-format"
          value={format}
          onChange={(e) => setFormat(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-2 text-sm focus:border-accent focus:outline-none"
        >
          <option value="">Any format</option>
          {FORMATS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>

        <div role="group" aria-label="Color identity" className="flex gap-1">
          {COLOR_KEYS.map((key: ColorKey) => {
            const on = colors.includes(key);
            return (
              <button
                key={key}
                type="button"
                onClick={() => toggleColor(key)}
                aria-pressed={on}
                aria-label={COLOR_LABEL[key]}
                title={COLOR_LABEL[key]}
                className={cn(
                  "size-9 rounded-md border text-sm font-medium transition-colors",
                  on
                    ? "border-accent bg-accent text-accent-foreground"
                    : "border-border text-muted hover:text-text",
                )}
              >
                {key}
              </button>
            );
          })}
        </div>
      </div>

      <Results
        query={query}
        rows={rows}
        total={total}
        unfiltered={unfiltered}
        virtualizer={virtualizer}
        virtualRows={virtualRows}
        scrollRef={scrollRef}
      />
    </section>
  );
}

type Search = ReturnType<typeof useCardSearch>;

function Results({
  query,
  rows,
  total,
  unfiltered,
  virtualizer,
  virtualRows,
  scrollRef,
}: {
  query: Search["query"];
  rows: CardSummary[];
  total: number;
  unfiltered: boolean;
  virtualizer: ReactVirtualizer<HTMLDivElement, Element>;
  virtualRows: VirtualItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  if (query.isError) return <Notice tone="bad">{ipcError(query.error)}</Notice>;

  // `isPending` is only ever true before the first page of the first search — after that
  // `keepPreviousData` means there are rows to keep showing.
  if (query.isPending) return <Notice>Searching…</Notice>;

  if (rows.length === 0) {
    // An unfiltered search asks for everything, so an empty answer to it is a statement
    // about the database, not about the query. Saying "no cards match" here would blame
    // the user for a sync that has not finished.
    return unfiltered ? (
      <Notice>Card database is empty — waiting for the first sync to finish.</Notice>
    ) : (
      <Notice>No cards match these filters.</Notice>
    );
  }

  return (
    <>
      <p className="text-xs text-muted" aria-live="polite">
        {total.toLocaleString("en-US")} {total === 1 ? "card" : "cards"}
        {query.isFetching && !query.isFetchingNextPage && " · searching…"}
      </p>

      <div
        role="table"
        aria-label="Search results"
        // The header row plus every match, not just the rows currently in the DOM —
        // otherwise a virtualised list tells assistive tech the database holds 20 cards.
        aria-rowcount={total + 1}
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border"
      >
        <div
          role="row"
          aria-rowindex={1}
          className={cn(GRID, "border-b border-border bg-surface px-3 py-2 text-xs text-muted")}
        >
          <span role="columnheader">Name</span>
          <span role="columnheader">Set</span>
          <span role="columnheader">Type</span>
          <span role="columnheader">Rarity</span>
          <span role="columnheader" className="text-right">
            Price
          </span>
        </div>

        <div ref={scrollRef} role="rowgroup" tabIndex={0} className="min-h-0 flex-1 overflow-auto">
          {/* Spacer only: it holds the scrollbar open to the full list height while the
              rows inside it are positioned absolutely. */}
          <div
            role="presentation"
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
                  className={cn(
                    GRID,
                    "absolute inset-x-0 top-0 border-b border-border/50 px-3 text-sm",
                  )}
                  style={{ height: v.size, transform: `translateY(${v.start}px)` }}
                >
                  <Row card={card} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone?: "bad" }) {
  return (
    <p
      className={cn(
        "py-16 text-center text-sm",
        tone === "bad" ? "text-destructive" : "text-muted",
      )}
      role={tone === "bad" ? "alert" : undefined}
    >
      {children}
    </p>
  );
}
