import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { needsNextPage } from "@/features/search/useCardSearch";
import { FOCUS_INSET } from "@/lib/focus";
import { LAYER } from "@/lib/layers";
import type { SortDir, SortSpec } from "@/lib/sort";
import { stopRowActivationKeys } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { SortableHeader } from "./SortableHeader";

/** Row height in px, shared by all three tables so the app has one row pitch. */
export const TABLE_ROW_HEIGHT = 44;

/** Height of the sticky header row, which the virtualiser has to account for. */
export const TABLE_HEADER_HEIGHT = 36;

/** What the virtualiser's window is under `grow`, where nothing reads it. A module constant
 *  rather than a literal `[]`, which would be a new array on every render and a new dependency
 *  for the paging effect that reads its last item. */
const NO_VIRTUAL_ROWS: VirtualItem[] = [];

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

/**
 * One row about to be drawn: where it sits in `rows`, the key React sees, and the
 * virtualiser's geometry for it — `null` under `grow`, which is the whole of how the two modes
 * differ once the list has been laid out.
 *
 * The key is the row's index either way: `defaultKeyExtractor` is the index, so nothing about
 * what React reconciles moves when a caller opts in.
 */
interface LaidOutRow {
  index: number;
  key: VirtualItem["key"];
  item: VirtualItem | null;
}

/** Everything a row needs to be a row. `renderRow` receives it and must spread it. */
export interface RowRenderProps {
  role: "row";
  "aria-rowindex": number;
  tabIndex?: number;
  /** Takes the event since issue #214 — a caller reads the chords off it to tell "open this row"
   *  from "add it to the picked set". */
  onClick?: (e: React.MouseEvent) => void;
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
 * **{@link VirtualTable.grow} is the fourth caller's opt-out of the scroller**, and it is opt-in
 * precisely because the other three are 100k-row lists whose virtualisation must not move.
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
  grow = false,
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
  /**
   * Extra px this row needs beyond {@link TABLE_ROW_HEIGHT}.
   *
   * A **contract** in the ordinary mode — the virtualiser is told the row is that tall and
   * positions its neighbour accordingly, so a band that outgrows the number is painted over.
   * Under `grow` it is only a **floor**: nothing has to be told, so a row that outgrows it
   * simply gets taller. See the geometry note at the row's own `style`.
   */
  extraHeight?: (row: Row) => number;
  /**
   * Draw every row in normal flow and let the page be the scroller.
   *
   * **Opt-in, defaulting to today's behaviour exactly**, because the caller has to be able to
   * say *the list is bounded and the page is the scroller* — which is true of a deck, at most a
   * few hundred rows, and false of the search, the collection and the wishlist, which draw this
   * same table over 100k rows and need every bit of the virtualiser.
   *
   * What it buys is the absence of a second scrollbar: a table that scrolls inside a page that
   * also scrolls is two scrollbars an inch apart moving different things, which is the screen
   * this repo has twice gone looking for — once when the deck's other three views were given no
   * height (`features/decks/CLAUDE.md`) and again when the editor stopped being a scroller
   * nested in `AppShell`'s `main`.
   *
   * The virtualiser's hook still runs — a hook may not be conditional — and nothing reads its
   * answer: no `getVirtualItems`, no `getTotalSize`, no scroll reset and no paging, because
   * there is no scroller to reset and the whole list is already present.
   */
  grow?: boolean;
  /**
   * Click, Enter and Space on a row. Omitted makes rows inert.
   *
   * **The event travels since issue #214** — a caller needs the chords the press was holding, so
   * that Ctrl and Shift can mean "add this row to the picked set" rather than "open it". Both
   * kinds of activation carry the four modifier booleans, so the keyboard path is not a second
   * case. A caller with no use for it takes one argument and is unchanged.
   */
  onActivate?: (row: Row, event: React.MouseEvent | React.KeyboardEvent) => void;
  isSelected?: (row: Row) => boolean;
  rowClassName?: (row: Row) => string | undefined;
  /** Wraps the row. The default is a plain `div`; two callers make it a drag source. */
  renderRow?: (props: RowRenderProps, row: Row) => ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tip = useTooltip();

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

  // Under `grow` the virtualiser's window is not read at all — the rows are mapped directly,
  // below — so neither of these is asked for. `NO_VIRTUAL_ROWS` is a module constant rather
  // than a fresh `[]` so the paging effect's deps do not change every render.
  const virtualRows = grow ? NO_VIRTUAL_ROWS : virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

  // A new list reuses this scroll container, and a browser does not reset scrollTop for new
  // content — it clamps the old offset into the new, usually far shorter, list. Changing the
  // sort changes `listKey`, so a re-sorted list starts at the top for free.
  //
  // Skipped under `grow`: this element is not a scroll container there, so there is no offset
  // to reset — whatever scrolls is an ancestor, and a re-sorted deck must not yank the page.
  useEffect(() => {
    if (grow) return;
    virtualizer.scrollToOffset(0);
  }, [grow, listKey, virtualizer]);

  // Paging is driven by the virtualiser's window rather than a scroll handler: it already
  // knows which row is at the bottom, and it recomputes on resize too, which a scroll event
  // never fires for. The guards live with the query, in the page above.
  //
  // Skipped under `grow` for a stronger reason than "there is nothing to fetch": every row is
  // rendered, so the last rendered row is always the last row and `needsNextPage` would answer
  // true on every list, on every render.
  useEffect(() => {
    if (grow) return;
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [grow, lastRendered, rows.length, onNeedNextPage]);

  // The one place the two modes part: `grow` draws every row, in document order, in normal
  // flow, and reads nothing off the virtualiser; otherwise it is the window as before.
  const laidOut: LaidOutRow[] = grow
    ? rows.map((_row, index) => ({ index, key: index, item: null }))
    : virtualRows.map((v) => ({ index: v.index, key: v.key, item: v }));

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={label}
      // Every matching row plus the header, not just the rows currently in the DOM —
      // otherwise a virtualised list tells assistive tech the database holds 20 cards.
      aria-rowcount={total === null ? -1 : total + 1}
      tabIndex={0}
      // Under `grow` this element stops being a scroll container: no height of its own, no
      // `overflow`, and the page scrolls it instead. The border and the radius stay — they are
      // what makes the table a table — and `role`, `aria-label`, `aria-rowcount` and the
      // `tabIndex` are untouched, because none of them is a statement about scrolling.
      className={cn("rounded-md border border-border", !grow && "min-h-0 flex-1 overflow-auto")}
    >
      {/* Sticky inside the scroll container rather than sitting above it: a header outside
          the scroller is wider than the rows by exactly the scrollbar, and the columns drift
          apart by that much as soon as the list overflows.

          **Under `grow` there is no scroll container here and the class is still wanted.**
          `sticky` resolves against the nearest scrolling ancestor, which is then `AppShell`'s
          `main` — so the column names stay readable while a hundred-row deck scrolls past,
          which is exactly what a reader comparing rows down a long list needs. The scrollbar
          argument above simply does not arise: with no local scroller the header and the rows
          are the same width by construction. */}
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
              {...tip(column.headerTitle)}
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
          positioned absolutely — and wants neither number under `grow`, where the rows are in
          normal flow: there is no scrollbar to hold open, and nothing absolute for this box to
          be the containing block of. A fixed height there would be the letterbox again. */}
      <div
        role="rowgroup"
        style={grow ? undefined : { height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {laidOut.map(({ index, key, item }) => {
          const row = rows[index];
          if (!row) return null;
          const extra = extraHeight?.(row) ?? 0;
          const props: RowRenderProps = {
            role: "row",
            "aria-rowindex": index + 2,
            tabIndex: onActivate ? 0 : undefined,
            onClick: onActivate ? (e) => onActivate(row, e) : undefined,
            onKeyDown: onActivate
              ? (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  // Space scrolls the container it is pressed in, which would jump the list
                  // by a screen at the same time as opening the card.
                  e.preventDefault();
                  onActivate(row, e);
                }
              : undefined,
            className: cn(
              "grid items-center gap-3",
              // `group`: a row's controls show themselves on hover, and on the row taking
              // focus — which is the keyboard's version of hover.
              "group border-b border-border/50 px-3",
              // **Positioned in both modes, and that is a requirement rather than a leftover**:
              // `TableView` lays a `DropIndicator` and a `LandedMark` over the row with
              // `inset-0`, and off `grow` those rely on the virtualiser's own `absolute` being
              // the containing block. Under `grow` the row is in normal flow, so `relative` is
              // what keeps the two overlays addressed to the row instead of to the page.
              item === null ? "relative" : "absolute inset-x-0 top-0",
              // Off `grow` a row is positioned *and* transformed, which makes it a stacking
              // context — so an open popup's own layer cannot lift it over the next row, which
              // paints later simply for being later in the DOM. The row it is open in has to
              // come forward instead, as far as the rows and no further: the sticky header
              // above is a layer up, because a row lifted to its level would scroll over it.
              //
              // **Under `grow` that premise is gone and the class is kept anyway**, because it
              // is still what does the work: a bare `relative` row is no stacking context, so a
              // popup inside it is not capped in the first place — but the row it is open in
              // must still paint over the rows below it, and a positioned box raised to
              // `LAYER.raised` is exactly that. Same class, same rung, one fewer reason to need
              // it. (Spelled as the token and never as the number: `layers.test.ts` sweeps `src/`
              // for a bare z-index class and reads a *comment* as one — it is source text, and a
              // rule that could be evaded by writing the class in prose would not be a rule.)
              LAYER.raisedWhenPopupOpen,
              "text-sm transition-colors duration-150 motion-reduce:transition-none",
              // Inset: rows are stacked flush against each other, so an outline standing 2px
              // off one would be drawn over its neighbours — and off `grow`, where the list is
              // in a scroller, clipped at the ends of it as well. The first half is the one
              // that holds in both modes and it is enough on its own.
              FOCUS_INSET,
              onActivate && "cursor-pointer",
              // Which row the open pane is about. A quiet surface rather than gold: forty
              // rows are on screen and the one being read is already beside the pane.
              isSelected?.(row) ? "bg-surface text-text" : "hover:bg-surface/60",
              // Last, so a caller's own state colour wins over the selection colour.
              rowClassName?.(row),
            ),
            // Off `grow`: `start` is measured from the scroll container, which the header
            // shares; this div begins below it, so the header's height comes back off.
            //
            // Under `grow` the row is placed by the flow and carries a `minHeight` instead —
            // **`minHeight` rather than `height`, deliberately.** With the virtualiser gone
            // nothing has to be *told* a row is taller, so a band that outgrows its declared
            // `extraHeight` grows the row rather than being painted over the row below it.
            // That makes `extraHeight` a floor in this mode where it is a contract in the
            // other; the prop's own note says so.
            //
            // The two grid templates are the same in both modes. The row tracks are pinned
            // rather than left to `auto` because a flagged band is positioned over the second
            // one — an auto track would collapse it and re-centre the cells across a height
            // they do not occupy.
            style: {
              ...(item === null
                ? { minHeight: TABLE_ROW_HEIGHT + extra }
                : {
                    height: item.size,
                    transform: `translateY(${item.start - TABLE_HEADER_HEIGHT}px)`,
                  }),
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
            <RowSlot key={key}>{renderRow(props, row)}</RowSlot>
          ) : (
            <div key={key} {...props} />
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
