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
import { FOCUS } from "@/lib/focus";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder, WishlistSortKey, WishRow } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { EditWishButton } from "./EditWish";
import { missingOf, printingOf, wishLabel } from "./wish";
import { wishDraggable } from "./wishDrag";
import { ElsewhereMark, WishFolderCaption } from "./wishMarks";

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
 *
 * One options object rather than a row of positional arguments: the list grew five members for
 * spec §4 and §5, and a call site of nine bare values is a call site where two of them get
 * swapped.
 */
function columnsFor({
  folders,
  nodes,
  onSetQuantity,
  onRemove,
  onSetFolder,
  onChangePrinting,
  onAnyPrinting,
  folderNameOf,
  flattened,
  marketplace,
  tip,
}: {
  folders: readonly WishlistFolder[];
  nodes: readonly FolderNode<WishlistFolder>[];
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  onSetFolder: (row: WishRow, folderId: number | null) => void;
  onChangePrinting: (row: WishRow) => void;
  onAnyPrinting: (row: WishRow) => void;
  folderNameOf: (folderId: number | null) => string | null;
  flattened: boolean;
  marketplace: Marketplace;
  tip: TooltipBinder;
}): TableColumn<WishRow>[] {
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
      // **The cell holds a control now, so the row's own press must not also fire.**
      // `interactive` stamps `data-no-drag` and swallows the click and the two activation keys —
      // without it a press on the pencil would open the card pane as well, and five pixels of
      // travel would drag the row off into a deck. It costs this cell as a grab handle and as a
      // place to click the card open, which is the cheapest price available: the name, Owned and
      // Cost columns are all three still both.
      interactive: true,
      cell: (row) => (
        <>
          <RarityGem rarity={row.rarity} />
          <span className="min-w-0 truncate" {...tip(printingOf(row), { whenClipped: true })}>
            {printingOf(row)}
          </span>
          {/* Spec §4's two marks and spec §5's editor, in the order and the place the wall's
              caption strip draws them — this cell *is* that strip, and the whole reason the two
              are one arrangement is that a reader who has learned one view has learned the other.
              `wishMarks.tsx` is the one definition of the marks. */}
          <ElsewhereMark count={row.elsewhere} />
          {flattened && <WishFolderCaption name={folderNameOf(row.folderId)} />}
          {/* **Spec §5: this is how the list reaches the two new writes, and it is the wall's own
              control rather than a second design for one job.** It goes in *this* column and not
              beside the remove button, and the reason is anchoring: `EditWishButton` opens its
              panel at `align="start"` — pinned left, growing right — which is right on a 170px
              tile and would put 288px of panel off the right edge of the window from a cell at the
              end of the row, where nothing clips it and the whole app scrolls sideways instead
              (the anchored-popup rule in `src/CLAUDE.md`). Beside the printing it grows into the
              table.

              Keyed by the wish for the wall's reason: this list is virtualised, so scrolling
              re-binds a row to a different wish, and a panel carried across that would be pointed
              at a card the reader never opened it on. */}
          <EditWishButton
            key={row.id}
            row={row}
            folders={folders}
            nodes={nodes}
            onSetQuantity={onSetQuantity}
            onRemove={onRemove}
            onSetFolder={onSetFolder}
            onChangePrinting={onChangePrinting}
            onAnyPrinting={onAnyPrinting}
            // The wall's recipe, minus its `static`: that class exists to hang the panel off the
            // tile's caption rather than off a 20px control, and here the cell is already the
            // anchor. Invisible until the row is hovered or holds the caret — a list of four
            // hundred wishes is not a list of pencils — and always in the tab order, because
            // "visible on hover" is not a state a keyboard has.
            className={REVEAL_ON_HOVER}
          />
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
      // **`min={0}`, and zero removes the wish. That reverses this comment's own argument, on
      // purpose (issue #284).** What stood here was a floor of one, justified as the place a
      // wish diverges from a collection entry — there `set_quantity(0)` was said to keep the
      // row, here it deletes, so a held-down `−` was a one-way door with no undo. Half of that
      // premise had already gone: `collection::set_quantity(0)` has deleted the entry since
      // schema v24 and `CollectionTable`'s stepper is `min={0}`, so what the floor actually
      // bought was this list behaving differently from the one beside it for a reason the one
      // beside it had stopped having. The three walls a reader edits — the collection's table,
      // this one, and the wishlist's own grid — floor at zero and delete there, and two
      // drawings of one list must not disagree about what can be edited.
      //
      // **The backend never held the old rule.** `set_wish_quantity` returns
      // `remove_wish(conn, id)` at zero (`src-tauri/src/wishlist.rs`), because
      // `wishlist_entries.quantity` carries `CHECK (quantity > 0)` — there is no stored zero
      // for a floor to sit above, and there never was. Only the front of the control moved.
      //
      // The one-way door is answered by the control beside it rather than by the floor: the
      // Actions column's `Remove … from your wishlist` is still offered on **every** row (see
      // its own note below), so the named route out is a single labelled press and the stepper
      // reaches the same write from the other end. Nothing here may go back to claiming a wish
      // stops at one: a comment left asserting a reversed rule is green forever and reads as
      // the code being the thing that is wrong.
      interactive: true,
      cell: (row) => (
        <QuantityStepper
          size="sm"
          value={row.quantity}
          min={0}
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
 * A row that is also the wish it lists, and — where there is a printing to carry — the card
 * that printing is. Spec §1's third drag source, widened by spec §9.
 *
 * **Every row is draggable now, and only the card half is conditional.** This used to register
 * nothing at all on a wish with no `card_id`, on the reasoning that such a wish is for the
 * *card*, so there is no printing to hand a deck column and a drag from one would arrive
 * carrying an empty id — which addresses every row and no row (`dnd.ts`). All of that is still
 * true and is still why `card()` answers `null` there. What it is no longer a reason for is the
 * row being inert: "file this one away" is a wish operation that has nothing to do with owning a
 * printing, so such a row carries `wishDragData`'s mark alone, `readDragData` answers `null` for
 * it and the deck's targets stay dark, and a folder card reads its own key and takes it.
 *
 * `wishDraggable` rather than `cardDraggable`, because the payload is two marks in one flat
 * record on a pinned wish — see `wishDrag.ts`, which is where that composition and its reason
 * live. The wall's tile reaches the identical record through `CardGrid`'s `dragRecord`, so a
 * reader dragging out of the list and out of the wall is doing the same thing.
 *
 * A component rather than a callback ref in the map, because the registration has to hold
 * still: React detaches and re-runs a ref whose identity changed, and this list re-renders on
 * every scrolled row — a source that unregisters mid-drag is a drop that never arrives.
 */
function DraggableRow({
  wishId,
  folderId,
  cardId,
  name,
  typeLine,
  children,
  ...rest
}: {
  wishId: number;
  folderId: number | null;
  cardId: string | null;
  name: string;
  typeLine: string | null;
} & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return wishDraggable({
      element,
      // `folderId` travels so a folder can refuse the wish already filed in it — the answer has
      // to be in the payload, because the target is asked before the drop.
      wish: () => ({ wishId, name, folderId }),
      // The type line files the card if it is carried somewhere with no column to point at — the
      // sidebar's Decks entry. It is the one thing `WishRow` carries that this list never draws,
      // and it is carried for exactly this (`ipc.ts`).
      card: () => (cardId === null ? null : { kind: "card", cardId, name, typeLine }),
    });
  }, [wishId, folderId, cardId, name, typeLine]);
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
  folders,
  nodes,
  folderNameOf,
  flattened,
  onNeedNextPage,
  onSetQuantity,
  onRemove,
  onSetFolder,
  onChangePrinting,
  onAnyPrinting,
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
  /** The flat folder rows and the tree built from them, both straight through to
   *  {@link EditWishButton} — see its own doc for why it wants two shapes of one read. */
  folders: readonly WishlistFolder[];
  nodes: readonly FolderNode<WishlistFolder>[];
  /**
   * What to call the folder a wish is filed in — `Wishlist` for the root, and `null` for a folder
   * this page cannot name, which draws nothing rather than a blank chip.
   *
   * The page's job rather than this component's: the page holds both the wishes and the folder
   * list, and joining them per row here would be a lookup table rebuilt on every scrolled row.
   */
  folderNameOf: (folderId: number | null) => string | null;
  /** Whether the list is showing every wish regardless of filing — spec §4's Flatten, and the
   *  only state the folder caption is drawn in. The wall gates it on the same flag, so the two
   *  drawings of one list cannot say different things about where a wish lives. */
  flattened: boolean;
  onNeedNextPage: () => void;
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  /**
   * The three writes the panel behind a row's pencil reaches, passed straight through — the same
   * three the wall passes, because it is the same panel.
   *
   * **The list draws `EditWishButton` itself rather than asking the page to open something**, and
   * that is settled rather than incidental: `AnchoredPopup` owns its own open state, so a cell
   * press cannot drive a panel the page holds and the page cannot open one this cell holds. The
   * alternative — a callback up to a `Dialog` on the page — would give the list a different
   * editing surface from the wall, which is two designs for one job and the thing spec §5 exists
   * to avoid.
   */
  onSetFolder: (row: WishRow, folderId: number | null) => void;
  onChangePrinting: (row: WishRow) => void;
  onAnyPrinting: (row: WishRow) => void;
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
      columns={columnsFor({
        folders,
        nodes,
        onSetQuantity,
        onRemove,
        onSetFolder,
        onChangePrinting,
        onAnyPrinting,
        folderNameOf,
        flattened,
        marketplace,
        tip,
      })}
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
      // instead.
      //
      // **The drag is no longer part of that split.** Both branches are a `DraggableRow` since
      // spec §9: every wish can be filed into a folder, and only the *card* half of what a row
      // carries is conditional — see {@link DraggableRow}. What still branches is opening the
      // pane, the caret and the menu, all three of which genuinely need a printing.
      renderRow={(props, row) =>
        row.cardId ? (
          <DraggableRow
            {...props}
            wishId={row.id}
            folderId={row.folderId}
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
          <DraggableRow
            {...props}
            wishId={row.id}
            folderId={row.folderId}
            cardId={null}
            name={row.name}
            typeLine={row.typeLine}
          />
        )
      }
    />
  );
}
