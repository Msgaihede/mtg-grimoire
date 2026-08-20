import {
  useEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Trash2 } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { useTooltip, type TooltipBinder } from "@/components/tooltip/useTooltip";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { cardDraggable } from "@/features/decks/dnd";
import { FOCUS } from "@/lib/focus";
import type { WishlistSortKey, WishRow } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { missingOf, printingOf, wishLabel } from "./wish";

/** The band a flagged row grows by, to say what the reconciler found. */
const REVIEW_HEIGHT = 20;

/**
 * The six columns. The same grammar as the collection table's — name flexes, everything
 * else is a known width — because a reader who has learned one of this app's lists has
 * learned all of them.
 *
 * The printing column carries a set, a number *and* a finish, because those three together
 * are what make two wishes for one card two wishes rather than a duplicate — so it is the
 * one column here that cannot be given a fixed width and be honest. It is `1fr` against the
 * name's `2fr`, the arrangement the search table reached the hard way: a *capped* track is
 * inflexible, and grid feeds it to its cap out of the free space before any `fr` track gets
 * anything — which is how a narrow window with the card pane open ends up drawing mana
 * symbols across the column beside them. Two flexible tracks share the squeeze instead, so
 * the name truncates last, and the whole printing rides as the cell's tooltip for the
 * window widths where 200px is not enough for "PLST · CHK-280 · Nonfoil".
 *
 * **Printing is the one header in this app that cannot be pressed.** An any-printing wish
 * names no set, and a list where half the rows sort under the same blank is not an order —
 * the same reason `useWishlist` has never offered a set order either.
 *
 * The keys are the backend's, verbatim: `WISHLIST_SORTS` in `src-tauri/src/wishlist.rs`.
 */
function columnsFor(
  onSetQuantity: (row: WishRow, quantity: number) => void,
  onRemove: (row: WishRow) => void,
  marketplace: Marketplace,
  tip: TooltipBinder,
): TableColumn<WishRow>[] {
  const asOf = pricesAsOf(marketplace);
  const currency = marketplace.currency;
  return [
    {
      key: "name",
      width: "minmax(0,2fr)",
      header: "Name",
      sortable: true,
      cell: (row) => (
        <>
          {/* `overflow-hidden`, and it is load-bearing: with the card pane open this column
              is the one that gives, and a row of `shrink-0` mana symbols in a 40px cell is
              drawn straight across the printing beside it. The wrapper carries the clip so
              the full-width sentence below is not clipped with it. */}
          <span className="flex min-w-0 items-baseline gap-2 overflow-hidden">
            {/* Never null: a wish carries its own name, because it outlives the printing it
                was made from and may never have had one. */}
            <span className="truncate">{row.name}</span>
            <ManaText source={row.manaCost} className="shrink-0 text-xs" />
          </span>
          {row.needsReview && (
            // Inside the name's cell rather than beside it, so a screen reader reads it with
            // the row it belongs to — a `<p>` among a row's cells is not a cell, and what is
            // not a cell is not announced. Drawn across the whole row because it is a
            // sentence, not a column.
            //
            // The band is one line and the reconciler writes 130–190 characters, of which
            // the *second* half is what to do about it. A truncation that eats the
            // instruction and offers no way to read it is half an error message, so the
            // whole sentence rides as the tooltip — and is in the accessible name either
            // way, because a screen reader reads the text, not the clip. `interactive` as
            // well as `whenClipped`, matching the collection's twin band: the instruction can
            // now be selected and copied, rather than only read.
            <span
              {...tip(row.needsReview, { whenClipped: true, interactive: true })}
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
      key: "printing",
      width: "minmax(0,1fr)",
      header: "Printing · finish",
      // Deliberately not sortable — see the note above this list.
      headerTitle: "Printing · finish",
      // The distinction spec §6 draws in one word, said in three. Mono because a collector
      // number is data — the same rule as the grid caption and the pane.
      cellClassName: "flex items-center gap-1.5 font-mono text-xs text-dim",
      cell: (row) => (
        <>
          <RarityGem rarity={row.rarity} />
          <span className="truncate" {...tip(printingOf(row), { whenClipped: true })}>
            {printingOf(row)}
          </span>
        </>
      ),
    },
    {
      key: "owned",
      width: "6.25rem",
      header: "Owned",
      sortable: true,
      firstDir: "desc",
      // The whole question a wishlist answers, per row. A fraction and not a bar: the
      // direction's motion and colour budget is spent on the mana line and the card art, and
      // forty progress bars would out-shout both.
      cellClassName: "truncate font-mono text-xs tabular-nums text-dim",
      cell: (row) =>
        missingOf(row) === 0 ? "Fulfilled" : `${row.ownedQuantity} of ${row.quantity} owned`,
    },
    {
      key: "quantity",
      width: "7rem",
      header: "Wanted",
      sortable: true,
      firstDir: "desc",
      // The stepper writes straight through: a shopping list is where the number of copies
      // is *maintained*, and making the reader open an editor to change a 3 to a 4 is the
      // difference between a tool and a form.
      //
      // `min={1}`, which is where this diverges from the collection's: there,
      // `set_quantity(0)` keeps the row with its condition and its purchase story; here it
      // *deletes* it, because a wish for none of something is not a wish. A stepper that
      // deleted a row when held down would be a one-way door with no undo, so removal is its
      // own control and this one stops at one.
      interactive: true,
      cell: (row) => (
        <QuantityStepper
          size="sm"
          value={row.quantity}
          min={1}
          label={`Copies wanted of ${wishLabel(row)}`}
          onChange={(next) => onSetQuantity(row, next)}
        />
      ),
    },
    {
      key: "cost",
      width: "5.5rem",
      header: "Cost",
      sortable: true,
      firstDir: "desc",
      // Spec §5: a price is never shown without saying how old it is. A 36px header row has
      // no space for the sentence, so it rides as the column's tooltip and inside its
      // accessible name — which *begins* with the visible word, so the column is still
      // addressable by what is written on it (WCAG 2.5.3, label in name).
      headerTitle: asOf,
      headerLabel: `Cost. ${asOf}`,
      headerClassName: "text-right",
      cellClassName: "text-right font-mono tabular-nums",
      // What finishing this wish costs, over the copies still missing — arithmetic over the
      // number the stepper moves, so the two can never disagree on screen. A wish with no
      // price for its finish has no cost either: that is a hole in the data, not a zero, and
      // an etched wish on Cardmarket is exactly that hole (`eur_etched` does not exist), so
      // it is an em dash rather than another marketplace's rate wearing a euro sign.
      //
      // The header sorts by *this*, at the marketplace the query named — which is why the
      // query carries one — and why a fulfilled wish sorts to the bottom of a cost order
      // however dear the card is.
      cell: (row) => {
        const missing = missingOf(row);
        const unit = row.unitPrice;
        return (
          <>
            {formatPrice(unit === null ? null : unit * missing, currency)}
            {/* What one of them costs, under what all of them cost — and only where the two
                are different numbers. On the single-copy rows that are most of a wishlist it
                would be the same price written twice, and on a fulfilled one it was a unit
                price under a total of nothing: a line quoting $105.18 each beside the word
                "Fulfilled" reads as a bill for a card already in the binder. Seen live. */}
            {unit !== null && missing > 1 && (
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
      // Always offered, where the collection's appears only on an emptied row. The two lists
      // mean opposite things by deletion: losing a collection entry loses a record of
      // something owned, and crossing a line off a shopping list is what a shopping list is
      // *for*.
      cell: (row) => (
        <button
          type="button"
          onClick={() => onRemove(row)}
          aria-label={`Remove ${wishLabel(row)} from your wishlist`}
          // Redundant, not "only name": the button already carries its own `aria-label`, so
          // the tooltip repeats it for the pointer alone. `describes: false` is what keeps a
          // screen reader from hearing "Remove … from your wishlist" twice — the collection
          // table's twin button was converted the same way in PR 1.
          {...tip("Remove from your wishlist", { describes: false })}
          className={cn(
            REVEAL_ON_HOVER,
            "grid size-6 place-items-center rounded-md border border-border text-dim",
            "transition-colors duration-150 hover:border-destructive/60 hover:text-destructive",
            FOCUS,
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
 * A row that is also the printing it wants — spec §1's third drag source.
 *
 * **Pinned wishes only**, which is the same rule that decides whether a row opens the card: a
 * wish with no `card_id` is for the *card*, and there is no printing to carry. A drag started
 * from one would arrive somewhere carrying an empty id, which addresses every row and no row
 * (`dnd.ts`) — so it never starts, and the row is a row.
 *
 * A component rather than a callback ref in the map, because the registration has to hold
 * still: React detaches and re-runs a ref whose identity changed, and this list re-renders on
 * every scrolled row — a source that unregisters mid-drag is a drop that never arrives.
 */
function DraggableRow({
  cardId,
  name,
  typeLine,
  children,
  ...rest
}: {
  cardId: string | null;
  name: string;
  typeLine: string | null;
} & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !cardId) return;
    // The type line files the card if it is carried somewhere with no column to point at — the
    // sidebar's Decks entry. It is the one thing `WishRow` carries that this list never draws,
    // and it is carried for exactly this (`ipc.ts`).
    return cardDraggable({ element, payload: () => ({ kind: "card", cardId, name, typeLine }) });
  }, [cardId, name, typeLine]);
  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  );
}

/**
 * The wishlist as a list: one row per wish, and the wanted quantity editable in place.
 *
 * Virtualised like its two siblings — for consistency of behaviour rather than for scale,
 * because the same list has to keep working when somebody's want-list runs to four figures.
 */
export function WishlistTable({
  rows,
  total,
  listKey,
  sort,
  onSort,
  onNeedNextPage,
  onSetQuantity,
  onRemove,
  rowMenu,
  rowMenuKey,
  marketplace,
}: {
  rows: WishRow[];
  /** Wishes matching the filters, not wishes loaded — what assistive tech is told. */
  total: number;
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  /** The columns the list is ordered by, first one deciding. */
  sort: SortSpec<WishlistSortKey>;
  /** One press on a column header. `additive` is Shift being held. */
  onSort: (key: string, additive: boolean) => void;
  onNeedNextPage: () => void;
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  /**
   * What a row offers on a right-click — a ready-made `onContextMenu` handler, or `undefined`
   * for a row that has no menu. Per row rather than for the list, because on this list it is
   * per row: an any-printing wish names no card to ask a question about.
   */
  rowMenu?: (row: WishRow) => ((e: ReactMouseEvent) => void) | undefined;
  /**
   * The same menu from the keyboard — Shift+F10 and the ContextMenu key — and `undefined` on
   * exactly the rows its pointer twin is: a wish for any printing names no card either way.
   */
  rowMenuKey?: (row: WishRow) => ((e: ReactKeyboardEvent) => void) | undefined;
  /** Which marketplace the Cost column quotes. Passed rather than read here so the list and
   *  the header above it cannot disagree about what they are pricing in. */
  marketplace: Marketplace;
}) {
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list never
  // has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const tip = useTooltip();

  return (
    <VirtualTable
      rows={rows}
      columns={columnsFor(onSetQuantity, onRemove, marketplace, tip)}
      label="Your wishlist"
      // A wishlist total is counted in full, so there is no unknown-count case here.
      total={total}
      listKey={listKey}
      sort={sort}
      onSort={onSort}
      // The reconciler walks `wishlist_entries` as well as `collection_entries`, so its
      // sentence is a band under the row it belongs to.
      extraHeight={(row) => (row.needsReview ? REVIEW_HEIGHT : 0)}
      isSelected={(row) => row.cardId !== null && row.cardId === selectedCardId}
      // Last, so it wins over the selection colour: a wish the collection already covers is
      // a record rather than a want, and it says so by receding rather than by disappearing.
      rowClassName={(row) => (missingOf(row) === 0 ? "text-dim" : undefined)}
      onNeedNextPage={onNeedNextPage}
      // An any-printing wish names no printing, so there is nothing for the pane to open —
      // and a row that looked clickable and did nothing would be worse than one that does
      // not. `onActivate` is deliberately *not* passed to `VirtualTable`: it is all-or-
      // nothing there, and here it is per row. The row's own props are overridden below
      // instead, which is also where the drag source is attached (pinned wishes only, for
      // the same reason).
      renderRow={(props, row) =>
        row.cardId ? (
          <DraggableRow
            {...props}
            cardId={row.cardId}
            name={row.name}
            typeLine={row.typeLine}
            tabIndex={0}
            // The menu goes on exactly the rows that open the card, and for the same reason:
            // both need a printing. A right-click is not an activation — `onClick` below is a
            // left click and `onKeyDown` is the two keys — so asking about the row does not
            // also open it in the pane.
            onContextMenu={rowMenu?.(row)}
            onClick={() => selectCard(row.cardId!)}
            onKeyDown={(e) => {
              // Shift+F10 and the ContextMenu key, on the same rows and about the same card.
              // Before the activation test rather than after it, so the two cannot both act on
              // one press; the primitive decides which presses are its own and leaves a field
              // alone.
              rowMenuKey?.(row)?.(e);
              if (e.key !== "Enter" && e.key !== " ") return;
              // Space scrolls the container it is pressed in, which would jump the list by a
              // screen at the same time as opening the card.
              e.preventDefault();
              selectCard(row.cardId!);
            }}
            className={cn(props.className, "cursor-pointer")}
          />
        ) : (
          <div {...props} />
        )
      }
    />
  );
}
