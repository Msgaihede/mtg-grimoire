import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
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

/**
 * Height of a heading band — a row {@link VirtualTable}'s `band` answers for — when the caller
 * names none. The shelf grid draws its heading at 40px plus an 8px gap; a table packs its rows
 * flush, so it takes the 40 without the gap, and a shelf heading is one height in both views.
 */
export const TABLE_BAND_HEIGHT = 40;

/** What the virtualiser's window is under `grow`, where nothing reads it. A module constant
 *  rather than a literal `[]`, which would be a new array on every render and a new dependency
 *  for the paging effect that reads its last item. */
const NO_VIRTUAL_ROWS: VirtualItem[] = [];

/**
 * **The table's own keyboard focus, drawn on the table's frame**: the box with the border and
 * the radius, which is the box a reader sees as "the table". **The frame, the scroller and the
 * tab stop are one element in every shape.** That element is the `role="table"` element when the
 * table is its own scroller (and under `grow`, where it is still the bordered box). While a sticky
 * band is live it is the `role="group"` scroller around the table. So this mark is an ordinary
 * `focus-visible:` rule on the element that has the focus, gated on `data-kbd` like every other
 * mark in the app.
 *
 * Until the 2026-09-26 live pass the table drew nothing of its own. What a Tab onto it showed
 * was the browser's `outline: auto` in the base layer's `outline-ring/50`, around whatever box
 * held the tab stop. With a sticky band live, that box was then the `role="table"` element inside
 * the scroller, as tall as the whole list. Its top edge sat under the sticky header and its bottom
 * was thousands of pixels down the scroll, so the ring was two faint 1px vertical lines. That was
 * **no focus indicator**, which fails WCAG 2.4.7. Focusing that box also scrolled the list
 * (855 → 191), because focus reveals an element inside its scroller. Both went when the stop moved
 * onto the scroller, and that move is what the band-mode `return` at the foot of the component
 * does.
 *
 * **2px straddling the border, rather than `@/lib/focus`'s `FOCUS` (2px standing off it) or
 * {@link FOCUS_INSET} (2px inside it).** Offset −1 puts the outline over the 1px border and 1px
 * past it. Scrolled content is clipped at the padding box, so nothing in the table can paint over
 * the border. A table fills its column, flush against the page edge or the docked search panel,
 * so an outline standing 4px off it would be the first thing an ancestor clips. An inset outline
 * would lose its inner pixel under the sticky header, a `LAYER.header` box that paints after the
 * scroller's own outline. It is gold and 2px, like every other focus mark here.
 */
const FRAME_FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent";

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
 * **{@link VirtualTable.band} is the second opt-in, and the shelves are its callers** — the
 * collection's and the wishlist's table views, where a folder's heading is a row across every
 * column above that folder's cards (spec §3.10, §5.8). "Heading band" throughout, because this
 * file already says "band" for the reconciler's flagged strip under a row (`extraHeight`), and
 * the two are different things. Without the prop, or with every row answering `null`, the table
 * is exactly what it was.
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
  band,
  bandHeight,
  stickyBand,
  revealIndex,
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
   *
   * **Asked about a heading band too** ({@link band}), where it adds to `bandHeight` instead of
   * to 44px — which is how a band that needs more room than a heading (an empty shelf's dashed
   * box) says so without a second height prop.
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
  /**
   * Wraps the row. The default is a plain `div`; two callers make it a drag source.
   *
   * **Never called for a heading band** ({@link band}), which the table draws itself: a
   * caller's wrapper adds a drag source and a click and keys of its own, and a heading must
   * carry none of them.
   */
  renderRow?: (props: RowRenderProps, row: Row) => ReactNode;
  /**
   * Which rows are **heading bands** rather than data, and what each one draws. Anything but
   * `null` or `undefined` makes the row a band: one `role="row"` holding one `role="cell"` with
   * `aria-colspan` over every column, {@link bandHeight} tall, with the node inside. Absent — or
   * `null` for every row — the table is exactly what it is without the prop.
   *
   * **A band is chrome the table places, and nothing more.** It never reaches `onActivate`,
   * `isSelected`, `rowClassName`, `renderRow` or any column's `cell`, and it carries no
   * `tabIndex`, no click and no Enter or Space — so row activation skips it and no drag-source
   * wrapper ever wraps a heading. What a heading does (a chevron, a title that opens the folder,
   * a drop target) is the node's own. `extraHeight` **is** asked about it, and adds to
   * `bandHeight`.
   *
   * **It is a row to assistive tech**: `aria-rowindex` counts it, and `aria-rowcount` is
   * `total + 1 + (bands among rows)` — `total` stays a count of data rows.
   *
   * Asked of every loaded row whenever `rows` or this callback changes, so pass a stable one
   * (`useCallback`), and let whether a row is a band depend on the row alone. The node is asked
   * for again at render, for the bands in the window only, so a heading that redraws on state (a
   * drop mark, a rename) is never stale.
   */
  band?: (row: Row) => ReactNode | null;
  /**
   * A heading band's height in px, before `extraHeight`. {@link TABLE_BAND_HEIGHT} when
   * omitted.
   */
  bandHeight?: number;
  /**
   * An overlay pinned directly under the sticky column header — the shelves' sticky bar
   * (spec §5.3) — drawn from the index in `rows` of the row under the header's bottom edge.
   *
   * When a heading band reaches that edge the index is the heading's own, so a caller that
   * returns `null` whenever `rows[index]` is itself a heading lets the heading be its own bar
   * and hands over to the bar as the heading scrolls away; a bar drawn over a heading hides the
   * heading's controls. Called only while there are rows, so the index is always one of them,
   * and **never under `grow`**: the page scrolls there and no offset of this table names a row —
   * and nothing that grows draws shelves.
   *
   * **Passing it moves the scroller off the `role="table"` element**, and that is the one
   * structural change any prop here makes. The bar holds buttons (a path, Top) and a drop
   * target, and a table may own only rows and row groups — so the bar cannot be inside it. The
   * scroller becomes a `div` holding two siblings, the bar's anchor and the table. The table
   * keeps its name and its count. **The tab stop moves with the scroll**: the scroller is a
   * `role="group"` named by {@link label}, with `tabIndex={0}` and the frame's focus mark, and
   * the table is no longer a stop. The element that takes focus is the element that scrolls,
   * exactly as in the unbanded shape, so a Tab onto the table never scrolls the list. A caller
   * that scrolls the table in a test scrolls `table.parentElement`. The scroller also takes a
   * `scroll-padding-top` of the header plus {@link bandHeight}, so a row that takes focus
   * scrolls clear of both rather than coming to rest underneath them.
   */
  stickyBand?: (firstVisibleRowIndex: number) => ReactNode;
  /**
   * Scroll this row into view when the value changes to a row index. It lands clear of the
   * sticky header, and of the sticky band while one is live, which is the line
   * `scroll-padding-top` holds a focused row to. It goes through the virtualiser, and nothing
   * moves if the row is already fully in view. **It never moves focus.**
   *
   * The pages need it for a heading the virtualiser has not mounted — one moved by Move up or
   * down, or Add folder's draft — which has no element to focus until it is scrolled to. The row
   * mounts once the scroll lands, so focus it after that.
   *
   * Answered once per value: the same index again does nothing, and `null` in between asks
   * afresh. An index past the loaded rows waits for them. It is inert under `grow`, where the
   * page scrolls.
   */
  revealIndex?: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const tip = useTooltip();

  const template = useMemo(() => columns.map((c) => c.width).join(" "), [columns]);

  // Which rows are heading bands, asked once per list rather than once per estimate: the size
  // estimate, the re-measure key and `aria-rowcount` all read it. `null` without `band`, which is
  // what keeps all three exactly as they were for every caller that never passes one.
  const bandAt = useMemo(() => (band ? rows.map((row) => band(row) != null) : null), [rows, band]);
  const bandCount = useMemo(() => (bandAt ? bandAt.filter(Boolean).length : 0), [bandAt]);
  const bandSize = bandHeight ?? TABLE_BAND_HEIGHT;

  // Whether the sticky band is drawn: `stickyBand` passed, and a scroller of this table's own to
  // pin it in (never under `grow`). The shape of the whole render turns on this; see `stickyBand`.
  const stickyLive = stickyBand !== undefined && !grow;

  // How much of the scrollport's top the sticky chrome covers: the header always, plus the bar
  // while it is drawn. One number for both lines that must agree about it. It is the scroller's
  // CSS `scroll-padding-top`, the line the browser holds a *focused* row to. It is also the
  // virtualiser's `scrollPaddingStart`, the line `revealIndex` holds a *revealed* row to. Written
  // twice, the two would part the first time either moved.
  const topCover = TABLE_HEADER_HEIGHT + (stickyLive && rows.length > 0 ? bandSize : 0);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Exact rather than estimated: a row that carries the reconciler's band is taller, and a
    // virtualiser told every row is 44px would overlap the one below it by exactly that band.
    // A heading band starts from `bandSize` rather than 44, and `extraHeight` adds to either.
    estimateSize: (index) => {
      const row = rows[index];
      const extra = row && extraHeight ? extraHeight(row) : 0;
      return (bandAt?.[index] ? bandSize : TABLE_ROW_HEIGHT) + extra;
    },
    overscan: 10,
    // The sticky header shares the scroll container with the rows, so the list does not
    // start at the container's origin.
    scrollMargin: TABLE_HEADER_HEIGHT,
    // Read only by `scrollToIndex`, which only `revealIndex` calls. A revealed row stops below
    // the header and the bar rather than underneath them.
    scrollPaddingStart: topCover,
  });

  // Row heights are cached from the first `estimateSize` call, so a page that lands with a
  // taller row in it — or a fix that shortens one — has to say so, or the rows keep the old
  // pitch. Usually the empty string: nothing is flagged in a healthy list.
  //
  // A heading band is a height of its own, and a row that becomes one — or stops being one — at
  // the same index changes no `count`, which is the only thing the virtualiser re-reads by
  // itself. So the bands' positions and their height join the key. Without `band` it is the
  // string it always was.
  const heightKey = useMemo(() => {
    const flagged = extraHeight
      ? rows
          .map((r, i) => (extraHeight(r) > 0 ? i : -1))
          .filter((i) => i >= 0)
          .join(",")
      : "";
    if (!bandAt) return flagged;
    const banded = bandAt
      .map((isBand, i) => (isBand ? i : -1))
      .filter((i) => i >= 0)
      .join(",");
    return `${flagged}|${banded}@${bandSize}`;
  }, [rows, extraHeight, bandAt, bandSize]);
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

  // `revealIndex`. It is declared after the two effects above, and the order is load-bearing:
  // effects run in declaration order, so in one commit the list reset lands first and the reveal
  // is not undone by it. `measure()` has also already invalidated the virtualiser's positions
  // for a reorder, which keeps `count` and moves the bands.
  //
  // `revealed` is the one value this has answered. It is what stops a re-render carrying the
  // same index from dragging the list back after the reader has scrolled away. It is set only
  // once the row exists, so an index past the loaded rows is still asked about when they arrive.
  const revealed = useRef<number | null>(null);
  useEffect(() => {
    if (revealIndex == null) {
      revealed.current = null;
      return;
    }
    if (grow || revealed.current === revealIndex) return;
    if (revealIndex < 0 || revealIndex >= rows.length) return;
    revealed.current = revealIndex;
    // Rebuilds the positions `measure()` threw away, so a moved heading is judged at its new
    // place and not its old one. `getTotalSize` is the public call that recomputes them.
    virtualizer.getTotalSize();
    // `"auto"` comes back unchanged only when the row is already clear of both edges. An offset
    // equal to where the list stands means the row is flush against one. Either way, nothing
    // moves.
    const target = virtualizer.getOffsetForIndex(revealIndex, "auto");
    if (!target || target[1] === "auto" || target[0] === virtualizer.scrollOffset) return;
    virtualizer.scrollToIndex(revealIndex, { align: "auto" });
  }, [revealIndex, rows.length, grow, virtualizer]);

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

  // `stickyBand`'s question: which row is under the column header's bottom edge — content
  // offset `scrollTop + TABLE_HEADER_HEIGHT`, because the rows' coordinates start below the
  // header (`scrollMargin`). Not `virtualizer.range.startIndex`: that is the row at the
  // scroller's *top* edge, 36px higher, which is a row the header is already hiding — and the
  // virtualiser re-renders only when its window's ends move, not when this edge crosses a row.
  //
  // So it is a subscription to the scroller's own `scroll` event with a number for a snapshot:
  // React re-renders when the index moves and never per pixel, and no effect sets state. Dormant
  // — no listener, a constant 0 — without `stickyBand` or under `grow` (`stickyLive`, above).
  const subscribeToScroll = useCallback(
    (notify: () => void) => {
      const el = scrollRef.current;
      if (!stickyLive || !el) return () => {};
      el.addEventListener("scroll", notify, { passive: true });
      return () => el.removeEventListener("scroll", notify);
    },
    [stickyLive],
  );
  const readFirstVisibleRow = useCallback(() => {
    const el = scrollRef.current;
    if (!stickyLive || !el) return 0;
    return virtualizer.getVirtualItemForOffset(el.scrollTop + TABLE_HEADER_HEIGHT)?.index ?? 0;
  }, [stickyLive, virtualizer]);
  const firstVisibleRowIndex = useSyncExternalStore(subscribeToScroll, readFirstVisibleRow);

  // The one place the two modes part: `grow` draws every row, in document order, in normal
  // flow, and reads nothing off the virtualiser; otherwise it is the window as before.
  const laidOut: LaidOutRow[] = grow
    ? rows.map((_row, index) => ({ index, key: index, item: null }))
    : virtualRows.map((v) => ({ index: v.index, key: v.key, item: v }));

  // The table. **It is the scroller too, except while a sticky band is live**. Then a `div`
  // around it scrolls instead (below), because the bar is not something a table may own.
  // What makes it a *table* (the role, the name, the count) stays here in both shapes. What
  // belongs to the thing that *scrolls* moves out with the scroll: the ref, the classes and the
  // tab stop.
  const table = (
    <div
      ref={stickyLive ? undefined : scrollRef}
      role="table"
      aria-label={label}
      // Every matching row plus the header, not just the rows currently in the DOM —
      // otherwise a virtualised list tells assistive tech the database holds 20 cards.
      //
      // Plus every heading band among `rows`: a band is a row to assistive tech — it carries an
      // `aria-rowindex`, and the indices run down `rows` counting it — while `total` is a count
      // of data rows, which is all a backend count answers. So `total + 1 + bands`, and `-1`
      // stays `-1`: unknown plus anything is unknown. Bands are counted as loaded, so a caller
      // that lists every heading up front gets an exact figure.
      aria-rowcount={total === null ? -1 : total + 1 + bandCount}
      // **Not a stop while a sticky band is live.** The stop is then the scroller around this
      // element, because focusing an element scrolls every scroller around it to reveal it, and
      // this one is list-tall. As a stop it moved the list from 855 to 191 on a Tab (live pass
      // 2026-09-26), and its focus ring's edges lay under the header and thousands of pixels
      // down. Focusing a scroller never scrolls that scroller, which is why the unbanded shape
      // never did either.
      tabIndex={stickyLive ? undefined : 0}
      // Under `grow` this element stops being a scroll container: no height of its own, no
      // `overflow`, and the page scrolls it instead. The border and the radius stay — they are
      // what makes the table a table — and `role`, `aria-label`, `aria-rowcount` and the
      // `tabIndex` are untouched, because none of them is a statement about scrolling.
      //
      // While a sticky band is live the classes belong to the scroller around this element, so
      // it carries none: the frame, the scrollport and the stop are one box's, and that box is
      // the parent. The focus mark (`FRAME_FOCUS`) goes with them.
      className={
        stickyLive
          ? undefined
          : cn(
              "rounded-md border border-border",
              !grow && "min-h-0 flex-1 overflow-auto",
              FRAME_FOCUS,
            )
      }
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
          // A heading band, drawn here and never through `renderRow`: one cell across every
          // column, and none of a row's tab stop, click, keys, selection colour or state colour
          // — see `band`. Placed exactly as a row is, in both modes, from the same `item`.
          //
          // **No lift, unlike a row.** `LAYER.raisedWhenPopupOpen` keys on a descendant with
          // `aria-expanded="true"`, and a shelf heading's collapse chevron carries exactly that
          // for as long as the shelf is open — so every open heading would sit a rung up for
          // good, and at the same rung as a row's open popup above it, document order would
          // paint the heading over that popup. A heading's menus are root-mounted, so there is
          // nothing inside it to lift.
          //
          // One track across and none split down: the cell takes the whole height, including any
          // `extraHeight`, and `self-stretch` makes it — and so a drop target filling it — as
          // tall as the band rather than as tall as its text.
          if (band && bandAt?.[index]) {
            return (
              <div
                key={key}
                role="row"
                aria-rowindex={index + 2}
                data-band=""
                className={cn(
                  "grid items-center border-b border-border/50 px-3 text-sm",
                  item === null ? "relative" : "absolute inset-x-0 top-0",
                )}
                style={{
                  ...(item === null
                    ? { minHeight: bandSize + extra }
                    : {
                        height: item.size,
                        transform: `translateY(${item.start - TABLE_HEADER_HEIGHT}px)`,
                      }),
                  gridTemplateColumns: "minmax(0,1fr)",
                }}
              >
                <span
                  role="cell"
                  aria-colspan={columns.length}
                  className="flex min-w-0 items-center self-stretch"
                >
                  {band(row)}
                </span>
              </div>
            );
          }
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

  // Without a live sticky band the table is its own scroller, exactly as it always was.
  if (!stickyLive) return table;

  // With one, a `div` scrolls and the table is the second of its two children. **The bar may
  // not be inside the table**: it holds buttons and a drop target, and a `role="table"` may own
  // rows and row groups only. A generic `div` in between passes ownership straight through
  // (axe `aria-required-children`, WCAG 1.3.1). So the bar's anchor is the table's sibling, and
  // nothing in it has a table for an ancestor.
  //
  // **This box is the tab stop, because this box is what scrolls.** The unbanded table is its
  // own scroller and its own stop, and focusing a scroller never scrolls it. The same shape here
  // is what keeps a Tab onto the table from moving the list; the `role="table"` child's own
  // `tabIndex` comment has the measurement. A stop has to say what it is, so the box is a
  // `group` named by `label`. That is the grid wall's shape as well (`CardGrid`'s scroller is a
  // `group` carrying the page's same label), and the two are never mounted together. It is
  // never a landmark: a `region` per table would be one more stop on the landmark list for a box
  // whose content is already a named table. The browser's own scroll keys (arrows, Page Up/Down,
  // Home, End) act on the focused scroller, and nothing else was ever bound to the table's stop.
  //
  // `scrollPaddingTop` is the header and the bar together, and it is here because of what they
  // cover. They take the top 76px of the scrollport between them and a row is 44px, so a row the
  // keyboard focuses can sit wholly underneath them, and focusing it scrolls nothing: the browser
  // counts it as already in view (WCAG 2.4.11). Scroll padding moves that line down to the bar's
  // lower edge. It is used for scroll-into-view and never for `scrollTo`, so the virtualiser's
  // own offsets and the scroll reset are untouched. It is set only while rows exist, since the
  // bar is drawn only then.
  //
  // The table's focus mark is this box's too (`FRAME_FOCUS`). This box is the frame the reader
  // sees, its edges are the table's visible edges, and it is the element that holds the focus.
  return (
    <div
      ref={scrollRef}
      role="group"
      aria-label={label}
      tabIndex={0}
      className={cn("min-h-0 flex-1 overflow-auto rounded-md border border-border", FRAME_FOCUS)}
      style={
        rows.length > 0 ? { scrollPaddingTop: topCover } : undefined
      }
    >
      {/* The sticky band: an overlay pinned directly under the column header, showing whatever
          `stickyBand` draws for the row at the header's edge. CSS `sticky` cannot pin a row —
          rows are `absolute` and translated — so this is an element of its own, and an in-flow
          one, because `sticky` works on an in-flow box and resolves against this scroller.

          **First, ahead of the table, and that order is what pins it.** A sticky box is pushed
          down to its inset whenever its flow position is above it, so an anchor whose place in
          the flow is the scroller's top edge sits at 36px at every scroll offset. Placed after
          the table, its flow position would be the end of the list, and `top` never pulls a box
          up. It is zero tall, so it moves no row and the rows' coordinates (`scrollMargin`) are
          unchanged. Its content is `absolute` inside it and is drawn over the rows below. It is
          on the header's rung, so the rows scroll under it. The header itself sits at 0–36 and
          the bar starts at 36, so they never overlap and document order has nothing to decide.

          Inside the scroller rather than laid over it from outside, on purpose: a box over the
          scroller covers the scrollbar. Not over an empty list, so the index handed out is
          always a row of `rows`. */}
      {rows.length > 0 && (
        <div
          data-sticky-band=""
          style={{ top: TABLE_HEADER_HEIGHT }}
          className={cn("sticky h-0", LAYER.header)}
        >
          <div className="absolute inset-x-0 top-0">
            {stickyBand?.(firstVisibleRowIndex)}
          </div>
        </div>
      )}
      {table}
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
