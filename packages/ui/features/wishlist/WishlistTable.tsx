import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Trash2 } from "lucide-react";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { TABLE_BAND_HEIGHT, VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { useTooltip, type TooltipBinder } from "@/components/tooltip/useTooltip";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { FOCUS } from "@/lib/focus";
import type { FolderNode } from "@/lib/folderTree";
import type { WishlistFolder, WishlistSortKey, WishRow } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import { SHELF_EMPTY_HEIGHT, SHELF_INDENT_PX, SHELF_RAIL_OFFSET_PX } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import type { SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { EditWishButton } from "./EditWish";
import { printingOf, wishLabel } from "./wish";
import { wishDraggable } from "./wishDrag";
import { ElsewhereMark } from "./wishMarks";
import { isBand, type ShelfBandRow, type WishTableRow } from "./wishShelfPlan";

/** The band a flagged row grows by, to say what the reconciler found. */
const REVIEW_HEIGHT = 20;

/**
 * What a row adds to its base height — `VirtualTable`'s `extraHeight` (rule 2), module scope so the
 * table is handed one function for its life.
 *
 * - A **wish** grows by the reconciler's sentence when it is flagged: that sentence is a band under
 *   the row it belongs to, since the reconciler walks `wishlist_entries` too.
 * - A **heading** band carrying its shelf's empty box is `SHELF_EMPTY_HEIGHT` taller than a heading.
 * - An **empty** band is the box alone, so it is `SHELF_EMPTY_HEIGHT` tall in all — the collection
 *   table's empty band, and for the same reason: a band's base is `TABLE_BAND_HEIGHT`.
 */
function extraHeightOf(row: WishTableRow): number {
  if (!isBand(row)) return row.needsReview ? REVIEW_HEIGHT : 0;
  if (row.band === "empty") return SHELF_EMPTY_HEIGHT - TABLE_BAND_HEIGHT;
  return row.band === "heading" && row.empty ? SHELF_EMPTY_HEIGHT : 0;
}

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
 * The keys are the backend's, verbatim: `WISHLIST_SORTS` in `crates/grimoire-core/src/wishlist.rs`.
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
  readOnly,
  marketplace,
  tip,
}: {
  /** A wish in a deck's managed folder — see {@link WishlistTable}'s prop. */
  readOnly: (row: WishRow) => boolean;
  folders: readonly WishlistFolder[];
  nodes: readonly FolderNode<WishlistFolder>[];
  onSetQuantity: (row: WishRow, quantity: number) => void;
  onRemove: (row: WishRow) => void;
  onSetFolder: (row: WishRow, folderId: number | null) => void;
  onChangePrinting: (row: WishRow) => void;
  onAnyPrinting: (row: WishRow) => void;
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
          {/* Spec §4's mark and spec §5's editor, in the order and the place the wall's caption
              strip draws them — this cell *is* that strip, and the whole reason the two are one
              arrangement is that a reader who has learned one view has learned the other.
              `wishMarks.tsx` is the one definition of the mark. (The folder caption Flatten drew
              beside it went with Flatten: a shelf's band names the folder now.) */}
          <ElsewhereMark count={row.elsewhere} />
          {/* **Spec §5: this is how the list reaches the two new writes, and it is the wall's own
              control rather than a second design for one job.** It goes in *this* column and not
              beside the remove button, and the reason is anchoring: `EditWishButton` opens its
              panel at `align="start"` — pinned left, growing right — which is right on a 170px
              tile and would put 288px of panel off the right edge of the window from a cell at the
              end of the row, where nothing clips it and the whole app scrolls sideways instead
              (the anchored-popup rule in `packages/ui/CLAUDE.md`). Beside the printing it grows into the
              table.

              Keyed by the wish for the wall's reason: this list is virtualised, so scrolling
              re-binds a row to a different wish, and a panel carried across that would be pointed
              at a card the reader never opened it on. */}
          {/* Not on a wish in a deck's managed folder: every write the panel reaches is refused
              for one, and the folder's own line says why. */}
          {!readOnly(row) && (
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
              // The wall's recipe, minus its `static`: that class exists to hang the panel off
              // the tile's caption rather than off a 20px control, and here the cell is already
              // the anchor. Invisible until the row is hovered or holds the caret — a list of
              // four hundred wishes is not a list of pencils — and always in the tab order,
              // because "visible on hover" is not a state a keyboard has.
              className={REVEAL_ON_HOVER}
            />
          )}
        </>
      ),
    },
    // **There was an `Owned` column here until 2026-09-08**, between the printing and the
    // wanted count: `2 of 4 owned`, or the word `Fulfilled`. It read the copies the collection
    // held against each wish and it is gone with every other comparison this list made against
    // the binder — a wishlist is the reader's own list, kept by hand, and they take a card off it
    // when they acquire one. The column that used to answer "how far along am I" was answering a
    // question this list does not ask.
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
      // `remove_wish(conn, id)` at zero (`crates/grimoire-core/src/wishlist.rs`), because
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
      cell: (row) =>
        // A managed wish says its number and offers no way to change it — the deck decides it.
        readOnly(row) ? (
          <span className="px-2 font-mono tabular-nums">{row.quantity}</span>
        ) : (
          <QuantityStepper
            // The deck editor's table draws `xs` and this drew `sm`, which was the two lists
            // disagreeing about one control in the one place they are the same shape (issue
            // #348). `xs` is the app's size for a stepper in a dense row — the deck's table and
            // text views both — and this row is 44px like theirs (`TABLE_ROW_HEIGHT`).
            size="xs"
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
      // What this wish costs — `unit × copies wanted`, arithmetic over the number the stepper
      // moves, so the two can never disagree on screen. A wish with no price for its finish has
      // no cost either: that is a hole in the data, not a zero, and an etched wish on Cardmarket
      // is exactly that hole (`eur_etched` does not exist), so it is an em dash rather than
      // another marketplace's rate wearing a euro sign.
      //
      // **It was `unit × copies still missing` until 2026-09-08**, which is why a covered wish
      // used to sort to the bottom of a cost order however dear the card was. Nothing here reads
      // the collection now, so a cost order is an order by what the list is worth.
      //
      // The header sorts by *this*, at the marketplace the query named — which is why the query
      // carries one.
      cell: (row) => {
        const unit = row.unitPrice;
        return (
          <>
            {formatPrice(unit === null ? null : unit * row.quantity, currency)}
            {/* What one of them costs, under what all of them cost — and only where the two are
                different numbers. On the single-copy rows that are most of a wishlist it would be
                the same price written twice. */}
            {unit !== null && row.quantity > 1 && (
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
      //
      // **Except a wish in a deck's managed folder**, which is crossed off by the deck and never
      // by hand — the backend refuses the removal, so the cell is empty rather than a button that
      // can only end in that sentence.
      cell: (row) =>
        readOnly(row) ? null : (
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
 * The wish columns over a table that may carry heading bands. `VirtualTable` draws a band itself
 * and never hands one to a cell (its rule 1), so the guard is for the type — `Row` is the union —
 * rather than for a row that can arrive.
 */
function overBands(
  columns: TableColumn<WishRow>[],
  indentOf?: (row: WishRow) => number,
): TableColumn<WishTableRow>[] {
  return columns.map((column, at) => ({
    ...column,
    cell: (row: WishTableRow) => {
      if (isBand(row)) return null;
      // The first cell of a wish row carries its shelf's rails, and its content steps in by the
      // same indent as the shelf's band, so no rail is drawn through the wish's name.
      const indent = at === 0 && indentOf !== undefined ? indentOf(row) : 0;
      if (indent === 0) return column.cell(row);
      return (
        <>
          <ShelfRails count={indent} />
          <span className="block min-w-0" style={{ paddingLeft: indent * SHELF_INDENT_PX }}>
            {column.cell(row)}
          </span>
        </>
      );
    },
  }));
}

/**
 * Spec §3.3's rails, in the table: one 1px rail per indent level — the wall's own
 * `SHELF_RAIL_OFFSET_PX + level × SHELF_INDENT_PX` — spanning the whole row, so a band and every
 * wish row under it draw one continuous line down the table.
 *
 * **Two absolute boxes, and the outer one names neither `left` nor a width.** `left: auto`
 * leaves it at its *static* position — the start of the cell it is the first child of — so the
 * rails are measured from where the band's content and the first column begin, as the wall's are
 * from the level's own column. `inset-y-0` measures it against the nearest *positioned* ancestor:
 * the row, which `VirtualTable` positions in both of its modes. That is how it spans the full row,
 * a flagged wish's review band included. **Nothing between the row and this box may be
 * positioned**: the name cell's review sentence is `absolute` against the row too, and a
 * `relative` cell would re-home both. jsdom lays nothing out, so the live pass is what checks
 * the line is continuous. The suite counts the rails and reads their `left`.
 */
function ShelfRails({ count }: { count: number }) {
  if (count === 0) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0">
      {Array.from({ length: count }, (_, level) => (
        <span
          key={level}
          data-shelf-rail=""
          className="absolute inset-y-0 border-l border-border"
          style={{ left: SHELF_RAIL_OFFSET_PX + level * SHELF_INDENT_PX }}
        />
      ))}
    </span>
  );
}

/**
 * The shelves' four drawings in the table (spec §3.10): the heading band, the dashed box an empty
 * folder's band carries under its heading, the label over the decks' group, and the sticky bar —
 * whose index is `VirtualTable`'s row under the header, answered `null` over a band.
 */
export interface WishTableBands {
  heading: (shelf: Shelf) => ReactNode;
  empty: (shelf: Shelf) => ReactNode;
  label: (group: "decks" | "managed") => ReactNode;
  sticky: (index: number) => ReactNode;
  /** How many levels a wish's shelf is indented — its rails and its step-in. */
  indentOf: (row: WishRow) => number;
}

/**
 * The bands of the table being drawn, handed to {@link ShelfBand} past `VirtualTable`.
 *
 * **A context rather than a closure, because `VirtualTable`'s `band` has to hold still and these
 * cannot.** The table asks `band` of every loaded row whenever the callback's *identity* changes
 * (its rule on `band`). A callback closed over `bands` changes identity with them — and the page's
 * render props are fresh on every page render, because `renderHeading` depends on a `useMutation`
 * result, which is a new object each render. So a memo on `bands` was a memo on nothing: every page
 * render re-asked every loaded row, and built every heading in the list — its figures and its
 * sentence, not only the ones in the window — to answer whether the row was a band at all. The
 * callback is {@link bandOf}, one module-scope function for the life of the app, and the render
 * props travel down here instead, where a new value re-renders the bands that read it and nothing
 * else.
 */
const BandsContext = createContext<WishTableBands | null>(null);

/**
 * `VirtualTable`'s `band`: a shelf's band for a band row, `null` for a wish. Module scope, so its
 * identity never changes — see {@link BandsContext}. Whether a row is a band depends on the row
 * alone, which is the table's other condition on this callback.
 *
 * **Keyed by shelf** (`band:<shelf.id>`), because the table keys its rows by **position**: unkeyed,
 * a Move up / Move down re-used the heading at the old place for the folder that took it — `⋯` and
 * all — so a `⋯` the reader had pressed stayed mounted, and focused, under *another* folder's name
 * whenever the moved heading went past the loaded edge. Keyed, the old heading goes with its folder:
 * the caret falls to `<body>` and the moved heading takes it back where it lands (`WishShelfHeading`'s
 * `caret`). `CollectionTable` keys its bands the same way, for the same reason.
 */
function bandOf(row: WishTableRow): ReactNode {
  return isBand(row) ? <ShelfBand key={bandKey(row)} row={row} /> : null;
}

/** Which shelf's band a row is — its folder's id for a heading or an empty box, the group for a
 *  label, which belongs to no shelf. */
function bandKey(row: ShelfBandRow): string {
  if (row.band === "label") return `label:${row.group}`;
  return row.band === "heading" ? `band:${row.shelf.id}` : `empty:${row.shelf.id}`;
}

/** One band, drawn from the bands of the table it sits in. */
function ShelfBand({ row }: { row: ShelfBandRow }) {
  const bands = useContext(BandsContext);
  if (bands === null) return null;
  if (row.band === "label") return bands.label(row.group);
  // The box with no heading over it — the opened folder's own, empty. The same box and the same
  // target the wall draws in that place, at the shelf's own indent (0 for the level itself).
  if (row.band === "empty") {
    return (
      <div className="min-w-0 flex-1" style={{ paddingLeft: row.shelf.indent * SHELF_INDENT_PX }}>
        {bands.empty(row.shelf)}
      </div>
    );
  }
  // Spec §3.3's indent, 32px a level and capped by `Shelf.indent`. `CardGrid` draws it on the wall;
  // `VirtualTable` draws a band as one full-width cell and knows nothing of levels, so the table
  // draws it here. An inline style, because the value is computed — a Tailwind class built from it
  // would emit no rule. `flex-1`, because the band's cell is a flex row and the heading's hairline
  // runs to the right edge only if this does.
  return (
    <>
      <ShelfRails count={row.shelf.indent} />
      <div className="min-w-0 flex-1" style={{ paddingLeft: row.shelf.indent * SHELF_INDENT_PX }}>
        {bands.heading(row.shelf)}
        {row.empty && bands.empty(row.shelf)}
      </div>
    </>
  );
}

/** The default `readOnly` — module scope so a caller passing none does not hand the column
 *  builder a fresh function every render. */
const NOTHING_READ_ONLY = (): boolean => false;

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
  fixed = false,
  children,
  ...rest
}: {
  wishId: number;
  folderId: number | null;
  cardId: string | null;
  name: string;
  typeLine: string | null;
  /** A wish in a deck's managed folder, which is **not** a drag source — the wall's `tileDrag`
   *  answers `null` for the same row, and carries the reason. */
  fixed?: boolean;
} & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || fixed) return;
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
  }, [wishId, folderId, cardId, name, typeLine, fixed]);
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
  bands,
  revealIndex,
  keepRow,
  readOnly = NOTHING_READ_ONLY,
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
  rows: WishTableRow[];
  /** Wishes matching the filters, not wishes loaded — what assistive tech is told. */
  total: number;
  /** The shelves' bands; `rows` carries {@link ShelfBandRow}s between the wishes when given. */
  bands?: WishTableBands;
  /** A row to scroll into view — `VirtualTable`'s `revealIndex`, passed straight through: the page
   *  names the heading band it owes the caret to, or the band of the folder being added. */
  revealIndex?: number | null;
  /** A row kept drawn wherever the table scrolls — `VirtualTable`'s `keepRow`, passed straight
   *  through: the page names the band of the folder heading being dragged, so its drag source is
   *  never scrolled out of the window mid-gesture. */
  keepRow?: number | null;
  /**
   * Whether a wish is the **deck's** — filed in a managed folder (issue #512), where the backend
   * refuses every edit. Such a row draws its count without a stepper, no pencil and no removal,
   * and is not a drag source: the wall's `readOnly`, for the wall's reasons. Absent reads every
   * wish as the reader's.
   */
  readOnly?: (row: WishRow) => boolean;
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

  const table = (
    <VirtualTable
      rows={rows}
      columns={overBands(
        columnsFor({
          folders,
          nodes,
          onSetQuantity,
          onRemove,
          onSetFolder,
          onChangePrinting,
          onAnyPrinting,
          readOnly,
          marketplace,
          tip,
        }),
        bands?.indentOf,
      )}
      label="Your wishlist"
      // A wishlist total is counted in full, so there is no unknown-count case here.
      total={total}
      listKey={listKey}
      sort={sort}
      onSort={onSort}
      extraHeight={extraHeightOf}
      isSelected={(row) => !isBand(row) && row.cardId !== null && row.cardId === selectedCardId}
      // One module-scope callback for the life of the table — see {@link bandOf}.
      band={bands === undefined ? undefined : bandOf}
      stickyBand={bands?.sticky}
      revealIndex={revealIndex}
      keepRow={keepRow}
      // **No `rowClassName` here, and the absence is the change rather than an omission.** A wish
      // the collection already covered used to recede to `text-dim` — a record rather than a
      // want, saying so without disappearing — and that dimming went on 2026-09-08 with the
      // figure behind it. There is no such thing as a covered wish now: the reader takes a card
      // off this list when they acquire one, so every row on it is a row they still want.
      onNeedNextPage={onNeedNextPage}
      // An any-printing wish names no printing, so there is nothing for the pane to open —
      // and a row that looked clickable and did nothing would be worse than one that does
      // not. `onActivate` is deliberately *not* passed to `VirtualTable`: it is all-or-
      // nothing there, and here it is per row. The row's own props are overridden below
      // instead.
      //
      // **`rove` is that split's half of the roving tab stop** (issue #558): the rows take the
      // table's one-stop `tabIndex` from `props` and its arrow walk, where each card row used to
      // write `tabIndex={0}` and make every wish a Tab stop. A wish with no printing is on the
      // walk too — a row the arrows skipped would be a gap in the list the keyboard cannot see.
      //
      // **The drag is no longer part of that split.** Both branches are a `DraggableRow` since
      // spec §9: every wish can be filed into a folder, and only the *card* half of what a row
      // carries is conditional — see {@link DraggableRow}. What still branches is opening the
      // pane, the caret and the menu, all three of which genuinely need a printing.
      rove
      renderRow={(props, row) =>
        // A band never reaches `renderRow` (rule 1); the first arm is for the type.
        isBand(row) ? null : row.cardId ? (
          <DraggableRow
            {...props}
            wishId={row.id}
            folderId={row.folderId}
            cardId={row.cardId}
            name={row.name}
            typeLine={row.typeLine}
            fixed={readOnly(row)}
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
            fixed={readOnly(row)}
          />
        )
      }
    />
  );
  // Always the provider, even with no bands to hand down: one root shape, so a table that gains or
  // loses its shelves is re-rendered rather than remounted — a remount drops the caret to `<body>`.
  return <BandsContext.Provider value={bands ?? null}>{table}</BandsContext.Provider>;
}
