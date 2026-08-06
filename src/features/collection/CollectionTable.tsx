import { useEffect, useMemo, useRef, type ComponentProps } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Trash2 } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardDraggable } from "@/features/decks/dnd";
import { needsNextPage } from "@/features/search/useCardSearch";
import { CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { finishLabel } from "@/lib/finish";
import type { CollectionRow } from "@/lib/ipc";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { useAppStore } from "@/lib/store";
import { stopRowActivationKeys } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";

/** Row height in px. Rows are uniform — except for the flagged ones, below. */
const ROW_HEIGHT = 44;

/** The band a flagged row grows by, to say what the reconciler found. */
const REVIEW_HEIGHT = 20;

/** Height of the sticky header row, which the virtualiser has to account for. */
const HEADER_HEIGHT = 36;

/**
 * The six columns, shared by the header row and every body row so they stay aligned.
 *
 * Only the name flexes: every other column holds something whose width is known — a set and
 * a number, a finish and a grade, a stepper (112px exactly), a price — and a price column
 * that squeezes is a column nobody can scan.
 *
 * Six and not seven. The per-copy price was a column of its own until the card pane opened
 * beside this table at 1280px: 6.5rem of it plus its gap was the difference between a name
 * column of 124px and one of 40, and a 40px name column is not a name. It moved into the
 * value cell, under the number it multiplies into and only on rows where the two differ —
 * which is exactly where it says something. The name truncates last because it is what
 * identifies a row, the same conclusion the search table reached the hard way.
 */
const GRID = "grid grid-cols-[minmax(0,1fr)_6.5rem_5.5rem_7rem_5.5rem_2rem] items-center gap-3";

/**
 * Keyboard focus on a row, in the shape the rest of the app uses — an outline, never a ring.
 * The offset is *negative*: rows are stacked flush inside a scroller, and an outline standing
 * 2px off one would be drawn over its neighbours and clipped at the ends of the list.
 */
const ROW_FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** The grade spelled out, for the same reason `finishLabel` exists. */
function conditionLabel(raw: string): string {
  return CONDITION_LABEL[raw as Condition] ?? raw;
}

/**
 * A row that is also the card it lists — spec §1's second drag source.
 *
 * What it carries is the **card**, never the entry: a deck names a printing, and the finish
 * and the condition that make this row an entry are exactly what a drop cannot answer. (Which
 * is the same reason the collection is not a drop *target*.)
 *
 * A component rather than a callback ref in the map, because the registration has to hold
 * still: React detaches and re-runs a ref whose identity changed, and this list re-renders on
 * every scrolled row — a source that unregisters mid-drag is a drop that never arrives. So the
 * effect re-runs only when what the row would carry has changed.
 *
 * A wrapper rather than a whole row component: everything else about a row is the table's, and
 * the props ride through untouched. The wishlist keeps its own copy of this, for its own
 * reason — its `cardId` is nullable.
 */
function DraggableRow({
  cardId,
  name,
  children,
  ...rest
}: { cardId: string; name: string | null } & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // An orphaned entry has no name — `cards` does not know this printing any more — and an
    // empty one is what the payload contract allows for exactly that (`dnd.ts`: a name may be
    // empty, an id may not).
    return cardDraggable({ element, payload: () => ({ kind: "card", cardId, name: name ?? "" }) });
  }, [cardId, name]);
  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  );
}

/**
 * The collection as a table: one row per entry, and the quantity editable in place.
 *
 * Virtualised for the same reason the search results are — a collection is thousands of rows
 * and the view opens on all of them — and one row per *entry* rather than per card, because
 * a foil in a sleeve and a played nonfoil are two different things to own, priced
 * differently and sold separately.
 */
export function CollectionTable({
  rows,
  total,
  listKey,
  onNeedNextPage,
  onSetQuantity,
  onRemove,
}: {
  rows: CollectionRow[];
  /** Rows matching the filters, not rows loaded — what assistive tech is told the list is. */
  total: number;
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  onNeedNextPage: () => void;
  onSetQuantity: (row: CollectionRow, quantity: number) => void;
  onRemove: (row: CollectionRow) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list
  // never has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Exact rather than estimated, flagged rows included: the reconciler's sentence is a
    // band under the row it belongs to, and a virtualiser told every row is 44px would
    // overlap the one below it by exactly that band.
    estimateSize: (index) => (rows[index]?.needsReview ? ROW_HEIGHT + REVIEW_HEIGHT : ROW_HEIGHT),
    overscan: 10,
    // The sticky header shares the scroll container with the rows, so the list does not
    // start at the container's origin.
    scrollMargin: HEADER_HEIGHT,
  });

  // Row heights are cached from the first `estimateSize` call, so a page that lands with a
  // flagged row in it — or a fix that clears one — has to say so, or the rows keep the old
  // pitch. Usually the empty string: nothing is flagged in a healthy collection.
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
  // knows which row is at the bottom, and it recomputes on resize too, which a scroll event
  // never fires for. The guards live with the query, in the page above.
  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label="Your collection"
      // Every matching row plus the header, not just the rows currently in the DOM —
      // otherwise a virtualised list tells assistive tech the collection is 20 rows. A
      // collection total is counted in full, so there is no unknown-count case here.
      aria-rowcount={total + 1}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
    >
      {/* Sticky inside the scroll container rather than sitting above it: a header outside
          the scroller is wider than the rows by exactly the scrollbar, and the columns drift
          apart by that much as soon as the list overflows. */}
      <div
        role="row"
        aria-rowindex={1}
        style={{ height: HEADER_HEIGHT }}
        className={cn(
          GRID,
          "sticky top-0 z-20 border-b border-border bg-surface px-3 text-xs text-dim",
        )}
      >
        <span role="columnheader" className="truncate">
          Name
        </span>
        <span role="columnheader" className="truncate">
          Set
        </span>
        {/* The one header longer than its column at a narrow width. The accessible name is
            the full string either way; the tooltip is for the reader who can see it is cut. */}
        <span role="columnheader" className="truncate" title="Finish · condition">
          Finish · condition
        </span>
        <span role="columnheader" className="truncate">
          Copies
        </span>
        {/* Spec §5: a price is never shown without saying how old it is. A 36px header row
            has no space for the sentence, so it rides as the column's tooltip and inside its
            accessible name — which *begins* with the visible word, so the column is still
            addressable by what is written on it (WCAG 2.5.3, label in name). */}
        <span
          role="columnheader"
          className="cursor-help truncate text-right"
          title={PRICES_AS_OF}
          aria-label={`Value. ${PRICES_AS_OF}`}
        >
          Value
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
          return (
            // Keyed by row position rather than by entry id: two pages fetched either side
            // of a write can carry one entry twice, and a duplicate key drops a row.
            <DraggableRow
              key={v.key}
              cardId={row.cardId}
              name={row.name}
              role="row"
              aria-rowindex={v.index + 2}
              // A row opens the card, from the mouse and from the keyboard both.
              tabIndex={0}
              onClick={() => selectCard(row.cardId)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                // Space scrolls the container it is pressed in, which would jump the list by
                // a screen at the same time as opening the card.
                e.preventDefault();
                selectCard(row.cardId);
              }}
              className={cn(
                GRID,
                // `group`: the removal button shows itself on hover, and on the row taking
                // focus — which is the keyboard's version of hover.
                "group absolute inset-x-0 top-0 cursor-pointer border-b border-border/50 px-3",
                "text-sm transition-colors duration-150 motion-reduce:transition-none",
                ROW_FOCUS,
                // Which row the open pane is about. A quiet surface rather than gold: forty
                // rows are on screen and the one being read is already beside the pane.
                row.cardId === selectedCardId ? "bg-surface text-text" : "hover:bg-surface/60",
                // Last, so it wins over the selection colour: a row emptied to zero is a
                // record of a card the user no longer holds, and it says so by receding
                // rather than by disappearing (see the stepper's contract).
                row.quantity === 0 && "text-dim",
              )}
              // `start` is measured from the scroll container, which the header shares; this
              // div begins below it, so the header's height comes back off. The row tracks
              // are pinned rather than left to `auto` because the flagged band is positioned
              // over the second one — an auto track would collapse it and re-centre the
              // cells across a height they do not occupy.
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
                    40px cell is drawn straight across the set beside it — which reads as a
                    rendering fault rather than as a squeeze. The wrapper carries the clip so
                    that the full-width sentence below is not clipped with it. */}
                <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
                  {/* An orphaned entry has no name to print — `cards` does not know this
                      printing any more — and the set and number beside it are the entry's
                      own columns, copied at write time for exactly this. */}
                  <span className="truncate">{row.name ?? "—"}</span>
                  <ManaText source={row.manaCost} className="shrink-0 text-xs" />
                </span>
                {row.needsReview && (
                  // Inside the name's cell rather than beside it, so a screen reader reads
                  // it with the row it belongs to — a `<p>` among a row's cells is not a
                  // cell, and what is not a cell is not announced. Drawn across the whole
                  // row because it is a sentence, not a column.
                  //
                  // Not a colour-only signal and not a destructive one: the card is still
                  // owned, and the row says what happened in the words the reconciler wrote.
                  //
                  // The band is one line and the reconciler writes 130–190 characters, of
                  // which the *second* half is what to do about it ("check the printing and
                  // re-add it… or remove this entry"). A truncation that eats the instruction
                  // and offers no way to read it is half an error message, so the whole
                  // sentence rides as the tooltip — and is in the accessible name either way,
                  // because a screen reader reads the text, not the clip.
                  <span
                    title={row.needsReview}
                    className="absolute inset-x-3 bottom-0.5 truncate text-[0.7rem] text-dim"
                  >
                    <span className="mr-1 font-medium text-destructive">Needs review:</span>
                    {row.needsReview}
                  </span>
                )}
              </span>

              {/* `setName` is nullable and the code is not, so the code is what is shown; the
                  full name rides along as the tooltip when there is one. Mono because a
                  collector number is data — the same rule as the grid caption and the pane. */}
              <span
                role="cell"
                className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-dim"
                title={row.setName ?? undefined}
              >
                <RarityGem rarity={row.rarity} />
                <span className="truncate">
                  {row.setCode.toUpperCase()} · {row.collectorNumber}
                </span>
              </span>

              <span role="cell" className="truncate text-xs text-dim">
                {finishLabel(row.finish)} ·{" "}
                {/* The grade as it is printed on the listing the card came from, with the
                    words one hover — or one screen reader — away. */}
                <abbr title={conditionLabel(row.condition)} className="no-underline">
                  {row.condition}
                </abbr>
              </span>

              {/* The stepper writes straight through: a collection table is where quantities
                  are *maintained*, and making the reader open an editor to change a 3 to a 4
                  is the difference between a tool and a form.

                  The row opens the card on any click and on Enter or Space, and every one of
                  those lands here too: without stopping them, correcting a count would also
                  open the card, and typing `12` into the box would scroll the list a
                  screenful. Those two keys and no others — a blanket `stopPropagation` also
                  took Escape away from the card pane, which listens on `window`.

                  `data-no-drag` is the other half of the same thought, now that the row is a
                  drag handle: without the mark a press on `−` that travels five pixels is a
                  drag of the whole row with the press never delivered (`cardDraggable`). Every
                  control added in here needs it. */}
              <span
                role="cell"
                data-no-drag=""
                onClick={(e) => e.stopPropagation()}
                onKeyDown={stopRowActivationKeys}
              >
                <QuantityStepper
                  size="sm"
                  value={row.quantity}
                  min={0}
                  label={`Quantity of ${row.name ?? row.cardId} (${finishLabel(row.finish)}, ${row.condition})`}
                  onChange={(next) => onSetQuantity(row, next)}
                />
              </span>

              {/* Arithmetic over the number the stepper moves, so the two can never disagree
                  on screen. A row with no price for its finish has no value either — that is
                  a hole in the data, not a zero. */}
              <span role="cell" className="text-right font-mono tabular-nums">
                {usdPrice(row.unitPriceUsd === null ? null : row.unitPriceUsd * row.quantity)}
                {/* What one of them is worth, under what all of them are worth — and only
                    where the two are different numbers. On the single-copy rows that are
                    most of a collection it would be the same price written twice. */}
                {row.unitPriceUsd !== null && row.quantity !== 1 && (
                  <span className="block text-[0.7rem] leading-tight text-dim">
                    {usdPrice(row.unitPriceUsd)} ea
                  </span>
                )}
              </span>

              <span
                role="cell"
                data-no-drag=""
                onClick={(e) => e.stopPropagation()}
                onKeyDown={stopRowActivationKeys}
              >
                {/* Offered on an empty row and nowhere else. Zero copies is a state the
                    stepper can reach and nothing else can leave: the backend keeps the row —
                    with its condition, its purchase price and its acquisition story — until
                    something says delete, and this is the only thing in the app that does.
                    On a row that still holds cards it would be a one-click way to lose the
                    lot from a list that scrolls under the pointer. */}
                {row.quantity === 0 && (
                  <button
                    type="button"
                    onClick={() => onRemove(row)}
                    aria-label={`Remove ${row.name ?? row.cardId} (${finishLabel(row.finish)}, ${row.condition}) from your collection`}
                    title="Remove from your collection"
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
                )}
              </span>
            </DraggableRow>
          );
        })}
      </div>
    </div>
  );
}
