import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { needsNextPage } from "@/features/search/useCardSearch";
import { LAYER } from "@/lib/layers";
import type { SortDir, SortSpec } from "@/lib/sort";
import { stopRowActivationKeys } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { SortableHeader } from "./SortableHeader";

/** Row height in px, shared by all three tables so the app has one row pitch. */
export const TABLE_ROW_HEIGHT = 44;

/** Height of the sticky header row, which the virtualiser has to account for. */
export const TABLE_HEADER_HEIGHT = 36;

/**
 * Keyboard focus on a row: an outline, never a ring. The offset is *negative* because rows
 * are stacked flush inside a scroller, and an outline standing 2px off one would be drawn
 * over its neighbours and clipped at the ends of the list.
 */
const ROW_FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

export interface TableColumn<Row> {
  /** Stable id. Also the sort key sent to the backend when `sortable`. */
  key: string;
  /** Grid track — `"minmax(0,2fr)"`, `"8rem"`. The template is joined from these. */
  width: string;
  header: string;
  /** Not drawn, still named: an unnamed column is announced as "column 6" on every row. */
  srOnlyHeader?: boolean;
  /** Rides as the column's tooltip. */
  headerTitle?: string;
  /** Overrides the accessible name. Must *begin* with `header` — WCAG 2.5.3. */
  headerLabel?: string;
  headerClassName?: string;
  sortable?: boolean;
  /**
   * Which direction one press asks for first. Ascending unless stated — descending on money
   * and counts, because "highest first" is what clicking one of those means.
   *
   * Documentation at the column, decided at the hook: the state lives with the query, so
   * the hook's own table of first directions is what actually runs. Keep the two in step.
   */
  firstDir?: SortDir;
  cell: (row: Row) => ReactNode;
  cellClassName?: string;
  /**
   * The cell holds a control. Applies `data-no-drag` and swallows the click and the two
   * activation keys, so editing a quantity does not also open the card and typing `12` does
   * not scroll the list a screenful.
   */
  interactive?: boolean;
}

/** Everything a row needs to be a row. `renderRow` receives it and must spread it. */
export interface RowRenderProps {
  role: "row";
  "aria-rowindex": number;
  tabIndex?: number;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  className: string;
  style: CSSProperties;
  children: ReactNode;
}

/**
 * The app's one virtualised table: a scroller, a sticky sortable header, and absolutely
 * positioned rows.
 *
 * One component because there were three, and they differed in their columns rather than in
 * their behaviour — same scroller, same `scrollMargin`, same paging effect, same
 * scroll-reset, same row geometry, same `role="cell"` wrapper, same trio of guards on every
 * interactive cell. What actually differs stays a callback: `renderRow`, because two of the
 * three wrap their row in a drag source, and `extraHeight`, because two of the three grow a
 * row by the reconciler's flagged band.
 *
 * The column template is an inline style rather than a Tailwind arbitrary value on purpose:
 * Tailwind scans source text for whole class names, so a template joined at runtime would
 * emit no rule at all.
 */
export function VirtualTable<Row>({
  rows,
  columns,
  label,
  total,
  listKey,
  onNeedNextPage,
  sort,
  onSort,
  extraHeight,
  onActivate,
  isSelected,
  rowClassName,
  renderRow,
}: {
  rows: Row[];
  columns: TableColumn<Row>[];
  /** Names the table for assistive tech — "Search results", "Your collection". */
  label: string;
  /**
   * Rows matching the filters, not rows loaded. `null` when the count is capped: ARIA
   * spells "unknown" `-1`, and 5 000 would be a smaller lie than 20 but still a lie.
   */
  total: number | null;
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  onNeedNextPage: () => void;
  sort: SortSpec;
  onSort: (key: string, additive: boolean) => void;
  /** Extra px this row needs beyond {@link TABLE_ROW_HEIGHT}. */
  extraHeight?: (row: Row) => number;
  /** Click, Enter and Space on a row. Omitted makes rows inert. */
  onActivate?: (row: Row) => void;
  isSelected?: (row: Row) => boolean;
  rowClassName?: (row: Row) => string | undefined;
  /** Wraps the row. The default is a plain `div`; two callers make it a drag source. */
  renderRow?: (props: RowRenderProps, row: Row) => ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const template = useMemo(() => columns.map((c) => c.width).join(" "), [columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Exact rather than estimated: a row that carries the reconciler's band is taller, and a
    // virtualiser told every row is 44px would overlap the one below it by exactly that band.
    estimateSize: (index) => {
      const row = rows[index];
      return TABLE_ROW_HEIGHT + (row && extraHeight ? extraHeight(row) : 0);
    },
    overscan: 10,
    // The sticky header shares the scroll container with the rows, so the list does not
    // start at the container's origin.
    scrollMargin: TABLE_HEADER_HEIGHT,
  });

  // Row heights are cached from the first `estimateSize` call, so a page that lands with a
  // taller row in it — or a fix that shortens one — has to say so, or the rows keep the old
  // pitch. Usually the empty string: nothing is flagged in a healthy list.
  const heightKey = useMemo(
    () =>
      extraHeight
        ? rows
            .map((r, i) => (extraHeight(r) > 0 ? i : -1))
            .filter((i) => i >= 0)
            .join(",")
        : "",
    [rows, extraHeight],
  );
  useEffect(() => {
    virtualizer.measure();
  }, [heightKey, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

  // A new list reuses this scroll container, and a browser does not reset scrollTop for new
  // content — it clamps the old offset into the new, usually far shorter, list. Changing the
  // sort changes `listKey`, so a re-sorted list starts at the top for free.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [listKey, virtualizer]);

  // Paging is driven by the virtualiser's window rather than a scroll handler: it already
  // knows which row is at the bottom, and it recomputes on resize too, which a scroll event
  // never fires for. The guards live with the query, in the page above.
  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={label}
      // Every matching row plus the header, not just the rows currently in the DOM —
      // otherwise a virtualised list tells assistive tech the database holds 20 cards.
      aria-rowcount={total === null ? -1 : total + 1}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
    >
      {/* Sticky inside the scroll container rather than sitting above it: a header outside
          the scroller is wider than the rows by exactly the scrollbar, and the columns drift
          apart by that much as soon as the list overflows. */}
      <div
        role="row"
        aria-rowindex={1}
        style={{ height: TABLE_HEADER_HEIGHT, gridTemplateColumns: template }}
        className={cn(
          "grid items-center gap-3 border-b border-border bg-surface px-3 text-xs text-dim",
          "sticky top-0",
          LAYER.header,
        )}
      >
        {columns.map((column) =>
          column.sortable ? (
            <SortableHeader
              key={column.key}
              label={column.header}
              ariaLabel={column.headerLabel}
              title={column.headerTitle}
              sortKey={column.key}
              spec={sort}
              onSort={onSort}
              className={column.headerClassName}
            />
          ) : (
            <span
              key={column.key}
              role="columnheader"
              title={column.headerTitle}
              aria-label={column.headerLabel}
              className={cn(
                // `truncate` on every label, because the flexible tracks collapse to nothing
                // in a narrow window with the card pane open — and a header that overflows a
                // zero-width track is drawn over the next column's, which reads as a
                // rendering fault rather than as a squeeze.
                column.srOnlyHeader ? "sr-only" : "truncate",
                column.headerClassName,
              )}
            >
              {column.header}
            </span>
          ),
        )}
      </div>

      {/* Holds the scrollbar open to the full list height while the rows inside it are
          positioned absolutely. */}
      <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualRows.map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          const extra = extraHeight?.(row) ?? 0;
          const props: RowRenderProps = {
            role: "row",
            "aria-rowindex": v.index + 2,
            tabIndex: onActivate ? 0 : undefined,
            onClick: onActivate ? () => onActivate(row) : undefined,
            onKeyDown: onActivate
              ? (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  // Space scrolls the container it is pressed in, which would jump the list
                  // by a screen at the same time as opening the card.
                  e.preventDefault();
                  onActivate(row);
                }
              : undefined,
            className: cn(
              "grid items-center gap-3",
              // `group`: a row's controls show themselves on hover, and on the row taking
              // focus — which is the keyboard's version of hover.
              "group absolute inset-x-0 top-0 border-b border-border/50 px-3",
              // A row is positioned *and* transformed, which makes it a stacking context —
              // so an open popup's own layer cannot lift it over the next row, which paints
              // later simply for being later in the DOM. The row it is open in has to come
              // forward instead, as far as the rows and no further: the sticky header above
              // is a layer up, because a row lifted to its level would scroll over it.
              LAYER.raisedWhenPopupOpen,
              "text-sm transition-colors duration-150 motion-reduce:transition-none",
              ROW_FOCUS,
              onActivate && "cursor-pointer",
              // Which row the open pane is about. A quiet surface rather than gold: forty
              // rows are on screen and the one being read is already beside the pane.
              isSelected?.(row) ? "bg-surface text-text" : "hover:bg-surface/60",
              // Last, so a caller's own state colour wins over the selection colour.
              rowClassName?.(row),
            ),
            // `start` is measured from the scroll container, which the header shares; this
            // div begins below it, so the header's height comes back off. The row tracks are
            // pinned rather than left to `auto` because a flagged band is positioned over
            // the second one — an auto track would collapse it and re-centre the cells
            // across a height they do not occupy.
            style: {
              height: v.size,
              transform: `translateY(${v.start - TABLE_HEADER_HEIGHT}px)`,
              gridTemplateColumns: template,
              gridTemplateRows: extra > 0 ? `${TABLE_ROW_HEIGHT}px ${extra}px` : undefined,
            },
            children: columns.map((column) => (
              <span
                key={column.key}
                role="cell"
                className={cn("min-w-0", column.cellClassName)}
                {...(column.interactive
                  ? {
                      "data-no-drag": "",
                      onClick: (e: React.MouseEvent) => e.stopPropagation(),
                      onKeyDown: stopRowActivationKeys,
                    }
                  : {})}
              >
                {column.cell(row)}
              </span>
            )),
          };
          // Keyed by row position, not by id: two pages fetched either side of a write can
          // carry the same row twice, and a duplicate key is a React warning plus a dropped
          // row. The key rides on whatever the caller renders, so a wrapper element — which
          // would break the `rowgroup`'s children — is never needed.
          return renderRow ? (
            <RowSlot key={v.key}>{renderRow(props, row)}</RowSlot>
          ) : (
            <div key={v.key} {...props} />
          );
        })}
      </div>
    </div>
  );
}

/**
 * Carries the list key for a caller-rendered row without adding an element.
 *
 * A wrapping `<div>` here would sit between the `rowgroup` and its `row`s, which is an ARIA
 * structure error and a real one: a screen reader walks that relationship to count rows.
 */
function RowSlot({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
