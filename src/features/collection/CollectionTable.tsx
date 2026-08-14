import {
  useEffect,
  useRef,
  type ComponentProps,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Trash2 } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardDraggable } from "@/features/decks/dnd";
import { CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { finishLabel } from "@/lib/finish";
import type { CollectionRow, CollectionSortKey } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** The band a flagged row grows by, to say what the reconciler found. */
const REVIEW_HEIGHT = 20;

/** The grade spelled out, for the same reason `finishLabel` exists. */
function conditionLabel(raw: string): string {
  return CONDITION_LABEL[raw as Condition] ?? raw;
}

/**
 * The six columns.
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
 *
 * That squeeze is also why the two orders with no column stay on the filter bar's select
 * rather than becoming columns: there is no room, and this table has already given one up.
 *
 * The keys are the backend's, verbatim: `COLLECTION_SORTS` in `src-tauri/src/collection.rs`.
 */
function columnsFor(
  onSetQuantity: (row: CollectionRow, quantity: number) => void,
  onRemove: (row: CollectionRow) => void,
  marketplace: Marketplace,
): TableColumn<CollectionRow>[] {
  const asOf = pricesAsOf(marketplace);
  const currency = marketplace.currency;
  return [
    {
      key: "name",
      width: "minmax(0,1fr)",
      header: "Name",
      sortable: true,
      cell: (row) => (
        <>
          {/* `overflow-hidden`, and it is load-bearing: with the card pane open this column is
            the one that gives, and a row of `shrink-0` mana symbols in a 40px cell is drawn
            straight across the set beside it — which reads as a rendering fault rather than
            as a squeeze. The wrapper carries the clip so that the full-width sentence below
            is not clipped with it. */}
          <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            {/* An orphaned entry has no name to print — `cards` does not know this printing
              any more — and the set and number beside it are the entry's own columns,
              copied at write time for exactly this. */}
            <span className="truncate">{row.name ?? "—"}</span>
            <ManaText source={row.manaCost} className="shrink-0 text-xs" />
          </span>
          {row.needsReview && (
            // Inside the name's cell rather than beside it, so a screen reader reads it with
            // the row it belongs to — a `<p>` among a row's cells is not a cell, and what is
            // not a cell is not announced. Drawn across the whole row because it is a
            // sentence, not a column.
            //
            // Not a colour-only signal and not a destructive one: the card is still owned,
            // and the row says what happened in the words the reconciler wrote.
            //
            // The band is one line and the reconciler writes 130–190 characters, of which the
            // *second* half is what to do about it ("check the printing and re-add it… or
            // remove this entry"). A truncation that eats the instruction and offers no way to
            // read it is half an error message, so the whole sentence rides as the tooltip —
            // and is in the accessible name either way, because a screen reader reads the
            // text, not the clip.
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
      key: "set",
      width: "6.5rem",
      header: "Set",
      sortable: true,
      // `setName` is nullable and the code is not, so the code is what is shown; the full name
      // rides along as the tooltip when there is one. Mono because a collector number is data
      // — the same rule as the grid caption and the pane.
      cellClassName: "flex items-center gap-1.5 font-mono text-xs text-dim",
      cell: (row) => (
        <>
          <RarityGem rarity={row.rarity} />
          <span className="truncate" title={row.setName ?? undefined}>
            {row.setCode.toUpperCase()} · {row.collectorNumber}
          </span>
        </>
      ),
    },
    {
      key: "finish",
      width: "5.5rem",
      header: "Finish · condition",
      sortable: true,
      // The one header longer than its column at a narrow width. The accessible name is the
      // full string either way; the tooltip is for the reader who can see it is cut.
      headerTitle: "Finish · condition",
      cellClassName: "truncate text-xs text-dim",
      cell: (row) => (
        <>
          {finishLabel(row.finish)} ·{" "}
          {/* The grade as it is printed on the listing the card came from, with the words one
            hover — or one screen reader — away. */}
          <abbr title={conditionLabel(row.condition)} className="no-underline">
            {row.condition}
          </abbr>
        </>
      ),
    },
    {
      key: "quantity",
      width: "7rem",
      header: "Copies",
      sortable: true,
      firstDir: "desc",
      // The stepper writes straight through: a collection table is where quantities are
      // *maintained*, and making the reader open an editor to change a 3 to a 4 is the
      // difference between a tool and a form. `interactive` is what keeps a press here from
      // also opening the card, and what marks the cell as not part of the row's drag.
      interactive: true,
      cell: (row) => (
        <QuantityStepper
          size="sm"
          value={row.quantity}
          min={0}
          label={`Quantity of ${row.name ?? row.cardId} (${finishLabel(row.finish)}, ${row.condition})`}
          onChange={(next) => onSetQuantity(row, next)}
        />
      ),
    },
    {
      key: "value",
      width: "5.5rem",
      header: "Value",
      sortable: true,
      firstDir: "desc",
      // Spec §5: a price is never shown without saying how old it is. A 36px header row has
      // no space for the sentence, so it rides as the column's tooltip and inside its
      // accessible name — which *begins* with the visible word, so the column is still
      // addressable by what is written on it (WCAG 2.5.3, label in name).
      headerTitle: asOf,
      headerLabel: `Value. ${asOf}`,
      headerClassName: "text-right",
      cellClassName: "text-right font-mono tabular-nums",
      // Arithmetic over the number the stepper moves, so the two can never disagree on
      // screen. A row with no price for its finish has no value either — that is a hole in
      // the data, not a zero. The header sorts by *this* number, not by the unit price
      // underneath it: a column that reorders by something other than the figure printed in
      // it is a column that lies. It cannot be sorted in another marketplace's money either,
      // and that is now structural rather than guarded: `CollectionQuery.marketplace` decides
      // the figure and the order together.
      //
      // **How empty this column is depends on the marketplace, and that is the data.** An
      // etched row has no `eur_etched` key to read, so it is an em dash on Cardmarket while
      // showing a figure on TCGplayer; a printing a bulk feed never listed is an em dash on
      // that feed. No other marketplace's rate is borrowed for either.
      cell: (row) => {
        const unit = row.unitPrice;
        return (
          <>
            {formatPrice(unit === null ? null : unit * row.quantity, currency)}
            {/* What one of them is worth, under what all of them are worth — and only where the
              two are different numbers. On the single-copy rows that are most of a collection
              it would be the same price written twice. */}
            {unit !== null && row.quantity !== 1 && (
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
      // Offered on an empty row and nowhere else. Zero copies is a state the stepper can
      // reach and nothing else can leave: the backend keeps the row — with its condition, its
      // purchase price and its acquisition story — until something says delete, and this is
      // the only thing in the app that does. On a row that still holds cards it would be a
      // one-click way to lose the lot from a list that scrolls under the pointer.
      cell: (row) =>
        row.quantity === 0 && (
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
        ),
    },
  ];
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
  typeLine,
  children,
  ...rest
}: {
  cardId: string;
  name: string | null;
  typeLine: string | null;
} & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // An orphaned entry has no name — `cards` does not know this printing any more — and an
    // empty one is what the payload contract allows for exactly that (`dnd.ts`: a name may be
    // empty, an id may not). Its type line is `null` for the same reason, which files it under
    // `Uncategorised` if it is carried into a deck — the honest pile for a card the database
    // cannot describe.
    return cardDraggable({
      element,
      payload: () => ({ kind: "card", cardId, name: name ?? "", typeLine }),
    });
  }, [cardId, name, typeLine]);
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
  sort,
  onSort,
  onNeedNextPage,
  onSetQuantity,
  onRemove,
  rowMenu,
  marketplace,
}: {
  rows: CollectionRow[];
  /** Rows matching the filters, not rows loaded — what assistive tech is told the list is. */
  total: number;
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  /** The columns the list is ordered by, first one deciding. */
  sort: SortSpec<CollectionSortKey>;
  /** One press on a column header. `additive` is Shift being held. */
  onSort: (key: string, additive: boolean) => void;
  onNeedNextPage: () => void;
  onSetQuantity: (row: CollectionRow, quantity: number) => void;
  onRemove: (row: CollectionRow) => void;
  /**
   * What a row offers on a right-click — a ready-made `onContextMenu` handler, one per row.
   *
   * A prop rather than a hook here, for the reason the two callbacks above it are props: a
   * menu's rows are *writes*, and the writes belong to the page that owns this list's cache.
   * Absent leaves the rows without one, which is what every story and every other consumer of
   * this table gets.
   */
  rowMenu?: (row: CollectionRow) => (e: ReactMouseEvent) => void;
  /** Which marketplace the Value column quotes. Passed rather than read here so the table and
   *  the header above it cannot disagree about what they are pricing in. */
  marketplace: Marketplace;
}) {
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list
  // never has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);

  return (
    <VirtualTable
      rows={rows}
      columns={columnsFor(onSetQuantity, onRemove, marketplace)}
      label="Your collection"
      // A collection total is counted in full, so there is no unknown-count case here.
      total={total}
      listKey={listKey}
      sort={sort}
      onSort={onSort}
      // The reconciler's sentence is a band under the row it belongs to, and a virtualiser
      // told every row is the same height would overlap the one below it by exactly that
      // band.
      extraHeight={(row) => (row.needsReview ? REVIEW_HEIGHT : 0)}
      // A row opens the card, from the mouse and from the keyboard both.
      onActivate={(row) => selectCard(row.cardId)}
      isSelected={(row) => row.cardId === selectedCardId}
      // Last, so it wins over the selection colour: a row emptied to zero is a record of a
      // card the user no longer holds, and it says so by receding rather than by
      // disappearing (see the stepper's contract).
      rowClassName={(row) => (row.quantity === 0 ? "text-dim" : undefined)}
      onNeedNextPage={onNeedNextPage}
      // A right-click is not an activation: `onActivate` above is a left click and the two
      // keys, and neither of them fires for this one — so the menu asks about the row without
      // also opening the card in the pane.
      renderRow={(props, row) => (
        <DraggableRow
          cardId={row.cardId}
          name={row.name}
          typeLine={row.typeLine}
          {...props}
          onContextMenu={rowMenu?.(row)}
        />
      )}
    />
  );
}
