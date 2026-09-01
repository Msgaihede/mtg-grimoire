import {
  useEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Trash2 } from "lucide-react";
import { FinishMark } from "@/components/FinishMark";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { useTooltip, type TooltipBinder } from "@/components/tooltip/useTooltip";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { collectionDraggable } from "@/features/collection/collectionDrag";
import { CONDITION_LABEL, type Condition } from "@/lib/conditions";
import { finishLabel, isFinish } from "@/lib/finish";
import { finishTreatments } from "@/lib/treatment";
import { FOCUS } from "@/lib/focus";
import type { CollectionRow, CollectionSortKey } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import type { SortSpec } from "@/lib/sort";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/** The band a flagged row grows by, to say what the reconciler found. */
const REVIEW_HEIGHT = 20;

/**
 * What the copy on a collection row is *called*, or `[]`.
 *
 * The **entry's** finish against the **card's** `promoTypes`, which is the pairing this whole
 * feature rests on: the printing says what its shiny copy is named, the entry says which copy
 * the reader actually owns. An orphan — a row whose printing has left `cards` — carries `null`
 * there and is unnamed, like every other card-derived field on the row.
 */
function treatmentsOf(row: CollectionRow) {
  return finishTreatments(row.promoTypes, isFinish(row.finish) ? row.finish : null);
}

/** The grade spelled out, for the same reason `finishLabel` exists. */
function conditionLabel(raw: string): string {
  return CONDITION_LABEL[raw as Condition] ?? raw;
}

/**
 * Which copy a row is about, for the accessible name of a control that acts on it.
 *
 * `Foil, NM` — both halves always, because `condition` is `NOT NULL DEFAULT 'NM'` on the column
 * and non-nullable on {@link CollectionRow}. The "no grade" branch this used to carry was
 * unreachable.
 */
function copyLabel(row: CollectionRow): string {
  return `${finishLabel(row.finish)}, ${row.condition}`;
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
 * **Still six with the folders, and that is why the filing shares the last column rather than
 * taking one of its own.** `Folder` is where `DeckCountCell` used to sit and where the removal
 * still does: one heading, two things, the row deciding which — the arrangement the derived mode
 * already proved this column can carry. A seventh column at 4.5rem would take the name to about
 * 44px at the width the paragraph above measured, which is the failure it exists to record.
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
  tip: TooltipBinder,
  /** {@link CollectionTable}'s prop of the same name, threaded down to the one cell it fences. */
  quantityBlocked?: (row: CollectionRow) => string | null,
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
            {/* **What this copy is called**, where the cardboard has a name of its own — a
              Surge Foil, a Halo Foil, a serialized card. Here rather than in the
              `Finish · condition` column beside it, which is 5.5rem and truncates
              "Nonfoil · NM" as it is: that column answers *which finish*, which is a word this
              table sorts on and must keep spelling the same way, and "Step-and-Compleat Foil"
              would leave it showing three letters. The glyph carries the name as its accessible
              name and its tooltip, exactly as the search table's does one screen over.

              The entry's own `finish` decides what applies: this reader owns *this* copy, so
              the plain half of a Surge Foil printing is not marked. An unrecognised finish —
              the column is TEXT with a CHECK, and `finishLabel` prints whatever it holds —
              names no treatment rather than guessing at one. */}
            {treatmentsOf(row).length > 0 && (
              <FinishMark
                finish={isFinish(row.finish) ? row.finish : "nonfoil"}
                treatments={treatmentsOf(row)}
                className="self-center"
              />
            )}
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
            // text, not the clip. `interactive` as well as `whenClipped`: the instruction can
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
      key: "set",
      width: "6.5rem",
      header: "Set",
      sortable: true,
      // `setName` is nullable and the code is not, so the code is what is shown; the full name
      // rides along as the tooltip when there is one. Mono because a collector number is data
      // — the same rule as the grid caption and the pane.
      //
      // No `whenClipped`: the span shows the set *code* and the tip says its *name*, so gating
      // the panel on the code's own clip gates it on a different string than the one it says —
      // the rule is stated once at `CardDetailPane.tsx`'s printings row.
      cellClassName: "flex items-center gap-1.5 font-mono text-xs text-dim",
      cell: (row) => (
        <>
          <RarityGem rarity={row.rarity} />
          <span className="truncate" {...tip(row.setName)}>
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
      cell: (row) => {
        const condition = row.condition;
        /* Always both halves and always the separator: `condition` is `NOT NULL DEFAULT 'NM'`
          on the column, so the "no grade" arm this cell used to carry could not be reached. */
        return (
          <>
            {finishLabel(row.finish)} ·{" "}
            {/* Not like this table's other tooltips (spec §4, "the one site that is not a
              tooltip"): on `<abbr>`, `title` is the standard HTML expansion mechanism rather
              than decoration, and `aria-label` on this roleless element is not reliably
              announced. So the expansion also rides as `sr-only` text right beside the
              abbreviation — text is the one route to assistive tech that always works — and
              the hover/focus panel is bound separately, with `describes: false` so it does
              not also wire `aria-describedby` onto a sentence the accessibility tree already
              has. */}
            <abbr className="no-underline" {...tip(conditionLabel(condition), { describes: false })}>
              {condition}
            </abbr>
            <span className="sr-only"> ({conditionLabel(condition)})</span>
          </>
        );
      },
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
      //
      // **It stays `true` on a blocked row, where there is no stepper to protect**, for two
      // reasons. The flag is a property of the *column* — one shape for every row in it, read
      // once per cell by `VirtualTable` — so answering it per row would make "does a click here
      // open the card?" depend on which drawer the row happens to sit in, which is a worse
      // surprise than a cell that is not a grab handle. And the cell still holds something a
      // pointer is meant to rest on: the number is a tooltip anchor, and a press that reached
      // the row would open the card out from under the sentence the reader hovered to read.
      interactive: true,
      cell: (row) => {
        const blocked = quantityBlocked?.(row) ?? null;
        if (blocked !== null) {
          /* **A number, not a `disabled` stepper.** A greyed control says "not now" and invites
            the reader to look for the state that would enable it; a plain figure says "this is
            what you hold, and it is not edited here" — which is the truth, because the way to
            change it is somewhere else entirely (cut the card from the deck, or file the copy
            back out of `Recently removed`). It is drawn in this table's own data styling for the
            same reason the Value column is: a quantity is data. `text-dim` is the rank — the
            column has stopped being the place anything happens on this row.

            **The reason reaches assistive tech as text, which is the `Finish · condition` cell's
            answer rather than the Value header's.** That header can put its sentence in the
            column's accessible *name* because it is true of every row in the column; this one is
            about *this* row, and a column-level name would repeat it on the four hundred rows
            that are not blocked. That leaves the tooltip's `aria-describedby`, which cannot
            reach a keyboard reader here: it is wired only while the panel is open, and the panel
            opens on pointer-enter or on the anchor taking focus — a `<span>` takes no focus, and
            the row's tab stop is the row. So the sentence rides as `sr-only` text beside the
            figure, and the hover panel is bound with `describes: false` so it does not also
            describe a sentence the accessibility tree already holds. */
          return (
            <>
              <span
                className="font-mono tabular-nums text-dim"
                {...tip(blocked, { describes: false })}
              >
                {row.quantity}
              </span>
              <span className="sr-only"> {blocked}</span>
            </>
          );
        }
        return (
          <QuantityStepper
            size="sm"
            value={row.quantity}
            min={0}
            label={`Quantity of ${row.name ?? row.cardId} (${copyLabel(row)})`}
            onChange={(next) => onSetQuantity(row, next)}
          />
        );
      },
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
              two are different numbers *and there is something to be worth it*. On the
              single-copy rows that are most of a collection it would be the same price written
              twice; on a zero-copy row — which the Copies stepper produced at `min={0}` until
              schema v24 made zero a delete, and which only `collectionUpdate` can leave behind
              now — it was a unit price under a total of nothing,
              quoting $105.18 each for cards that are not there. Hence `> 1` rather than `!== 1`,
              which is what the wishlist's twin cell already guards on. */}
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
      key: "folder",
      /**
       * `4.5rem` is the width `DeckCountCell` was measured at for `11 decks` at 0.7rem, and a
       * folder name is the same shape of thing: a short word the reader chose, truncating with
       * its whole name on the tooltip. The 2.5rem over the icon button's 2rem comes off the
       * name, the only flexing column — the same trade the derived mode made for the same
       * column, and the reason this is *not* a seventh column: the header of this file argues
       * six against seven with the figures, and at 1280px with the card pane open a seventh
       * would take the name column to about 44px.
       */
      width: "4.5rem",
      /**
       * **Where the copy is filed, and the removal, under one heading — the row decides which.**
       *
       * `DeckCountCell` held this column while the collection was derived and PR 1 took it out,
       * leaving a 2rem strip that was empty on every row but the rare emptied one. Folders give
       * it something to say on **every** row instead, and it is a value already on the row rather
       * than a hover query — a net deletion of a lazy per-row ipc call (spec §7.1).
       *
       * The header is visible now, where the removal's was `srOnlyHeader`: a column carrying a
       * value on every row is a column a reader has to be able to name, and an unnamed one is
       * announced as "column 6" for every row either way.
       */
      header: "Folder",
      // The cell holds a control on an emptied row, so the row's own press must not also fire.
      // `interactive` stamps `data-no-drag` and swallows the click and the two activation keys.
      // It costs this cell as a grab handle and as a place to click the card open — the cheapest
      // price available, since the name, Set and Value cells are all three still both.
      interactive: true,
      cellClassName: "flex items-center justify-between gap-1 text-xs text-dim",
      cell: (row) => (
        <>
          {/* An em dash for a copy at the root, which is where every card starts and where a
              deleted folder's cards return to. Not the word "Collection": the breadcrumb says
              that about the *level*, and repeating it four hundred times down a column would be
              a name for the absence of filing rather than a folder.

              `folderName` is the row's own join, so a folder renamed in another window is named
              by whatever the last read said. `null` with a `folderId` set cannot happen through
              the join and reads as the root if it ever does — an em dash is the honest answer for
              a drawer this row cannot name. */}
          <span className="min-w-0 truncate" {...tip(row.folderName, { whenClipped: true })}>
            {row.folderName ?? "—"}
          </span>
          {/* Offered on an empty row and nowhere else — and **no shipped write can produce one
              today, so this button is unreachable in the app as it stands**. Since schema v24
              `collectionSetQuantity(id, 0)` deletes the row outright and the importer's `set`
              mode does the same, and the v24 rung swept away every zero row that was already
              stored. `collectionUpdate` is the one write left that keeps a row at zero — an
              edit form sends eight fields at once and must not delete its own subject — and it
              has no caller in `src/`: there is no entry editor yet.

              It is kept rather than deleted because it is the **only** way out of that row if
              one ever does appear (a hand-edited database, a future entry editor, a command
              added without this table in mind), and a row that cannot be removed from the one
              surface that lists it is a card the reader is stuck with. What it is not is
              ordinary: nothing a reader can press reaches this branch, and a test that
              exercises it is testing the escape hatch rather than the stepper. On a row that
              still holds cards it would be a one-click way to lose the lot from a list that
              scrolls under the pointer, which is why it stays fenced on `quantity === 0`. */}
          {row.quantity === 0 && (
            <button
              type="button"
              onClick={() => onRemove(row)}
              aria-label={`Remove ${row.name ?? row.cardId} (${copyLabel(row)}) from your collection`}
              {...tip("Remove from your collection", { describes: false })}
              className={cn(
                REVEAL_ON_HOVER,
                "grid size-6 flex-none place-items-center rounded-md border border-border text-dim",
                "transition-colors duration-150 hover:border-destructive/60 hover:text-destructive",
                FOCUS,
                "motion-reduce:transition-none",
              )}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          )}
        </>
      ),
    },
  ];
}

/**
 * A row that is both the card it lists and the entry it is — spec §1's second drag source, and
 * since the folders (spec §7.1) the app's only source of a filing drag.
 *
 * **Two payloads under two keys on one registration.** The **card** half is what a deck category
 * or the sidebar's Decks entry reads, and it carries no finish and no condition: a deck names a
 * printing, and the two columns that make this row an *entry* are exactly what such a drop cannot
 * answer. The **entry** half is what a folder card or a breadcrumb segment reads, and it is the
 * whole of what a filing write needs — the entry's id, its name for whatever says what moved, and
 * where it is filed now so a folder can refuse the row it already holds. `collectionDrag.ts`
 * argues at length why those are two keys rather than one; the short of it is that both readers
 * have to say yes to the same row at once.
 *
 * A component rather than a callback ref in the map, because the registration has to hold
 * still: React detaches and re-runs a ref whose identity changed, and this list re-renders on
 * every scrolled row — a source that unregisters mid-drag is a drop that never arrives. So the
 * effect re-runs only when what the row would carry has changed, `folderId` included: a row
 * dropped into a drawer and then picked up again must carry the drawer it is in now, or that
 * drawer would go on offering itself.
 *
 * A wrapper rather than a whole row component: everything else about a row is the table's, and
 * the props ride through untouched. The wishlist keeps its own copy of this, for its own
 * reason — its `cardId` is nullable.
 */
function DraggableRow({
  entryId,
  cardId,
  name,
  typeLine,
  folderId,
  children,
  ...rest
}: {
  entryId: number;
  cardId: string;
  name: string | null;
  typeLine: string | null;
  folderId: number | null;
} & ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    // An orphaned entry has no name — `cards` does not know this printing any more — and an
    // empty one is what the payload contract allows for exactly that (`dnd.ts`: a name may be
    // empty, an id may not). Its type line is `null` for the same reason, which files it under
    // `Uncategorized` if it is carried into a deck — the honest pile for a card the database
    // cannot describe. The entry half takes the same fallback name, for the sentence a refusal
    // would print about it.
    return collectionDraggable({
      element,
      card: () => ({ kind: "card", cardId, name: name ?? "", typeLine }),
      entry: () => ({ entryId, name: name ?? "", folderId }),
    });
  }, [entryId, cardId, name, typeLine, folderId]);
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
  quantityBlocked,
  rowMenu,
  rowMenuKey,
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
   * Why this row's copies cannot be stepped here, or `null` for a row that can.
   *
   * **The quantity control belongs to a normal folder and to nothing else** (issue #284). Since
   * schema v25 a deck owns whatever its own group holds, so stepping a row filed there changes
   * what the deck physically holds with `deck_cards` never touched — and where the *move* is
   * fenced in the backend (`collection_folders::set_entry_folder` answers `ENTRY_IN_A_DECK`),
   * `collection::set_quantity` has no folder fence at all. This predicate is therefore the whole
   * of the guard rather than a second opinion about one, and **the wall takes the same one from
   * the same page**: two drawings of one list that disagree about what can be edited are worse
   * than either fence alone.
   *
   * **A sentence rather than a boolean, because a row that refuses has to say what to do
   * instead.** The words are the caller's — this table prints them and decides nothing about
   * them — and the page passes two shapes. For a deck's group:
   * `` `In ${row.folderName ?? "a deck"}. Cut the card from the deck to change how many you hold.` ``
   * And for the removals drawer:
   * `In Recently removed. Move it back to your collection to change how many you hold.`
   * Both are deliberately the grammar of `PickCopies`' own `blockedReason`
   * (`CollectionPage.tsx`) — one voice across this feature for "you cannot do this here, and
   * here is what to do instead".
   *
   * Optional, and optional in `rowMenu`/`rowMenuKey`'s way rather than defaulted to a predicate
   * of its own: absent, every row draws the stepper it drew before the folders existed, which is
   * what every story and every read-only mount of this table wants and what keeps a caller that
   * has no cabinet to reason about from having to say so.
   */
  quantityBlocked?: (row: CollectionRow) => string | null;
  /**
   * What a row offers on a right-click — a ready-made `onContextMenu` handler, one per row.
   *
   * A prop rather than a hook here, for the reason the two callbacks above it are props: a
   * menu's rows are *writes*, and the writes belong to the page that owns this list's cache.
   * Absent leaves the rows without one, which is what every story and every other consumer of
   * this table gets.
   */
  rowMenu?: (row: CollectionRow) => (e: ReactMouseEvent) => void;
  /**
   * The same menu from the keyboard — Shift+F10 and the ContextMenu key. Its own slot for the
   * reason `CardGrid`'s twin is: a keypress has no coordinates, so the panel anchors to the row
   * rather than to a pointer that was never there.
   */
  rowMenuKey?: (row: CollectionRow) => (e: ReactKeyboardEvent) => void;
  /** Which marketplace the Value column quotes. Passed rather than read here so the table and
   *  the header above it cannot disagree about what they are pricing in. */
  marketplace: Marketplace;
}) {
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list
  // never has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const tip = useTooltip();

  return (
    <VirtualTable
      rows={rows}
      columns={columnsFor(onSetQuantity, onRemove, marketplace, tip, quantityBlocked)}
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
      // Last, so it wins over the selection colour: a row holding no copies is a record of a
      // card the user no longer holds, and it says so by receding rather than by
      // disappearing (see the removal button's comment for the one write that still makes one).
      rowClassName={(row) => (row.quantity === 0 ? "text-dim" : undefined)}
      onNeedNextPage={onNeedNextPage}
      // A right-click is not an activation: `onActivate` above is a left click and the two
      // keys, and neither of them fires for this one — so the menu asks about the row without
      // also opening the card in the pane.
      //
      // The row's own `onKeyDown` runs first and is not replaced: it answers Enter and Space
      // (opening the card), and `menuKey` answers Shift+F10 and the ContextMenu key. Two
      // handlers for one event, because the row already had one — dropping `props`' would take
      // the keyboard's route to the *card* away in the act of adding one to its menu. A press
      // inside the quantity stepper is left alone by the primitive, which tests for a field
      // before it builds anything.
      renderRow={(props, row) => (
        <DraggableRow
          entryId={row.id}
          cardId={row.cardId}
          name={row.name}
          typeLine={row.typeLine}
          folderId={row.folderId}
          {...props}
          onContextMenu={rowMenu?.(row)}
          onKeyDown={(e) => {
            props.onKeyDown?.(e);
            rowMenuKey?.(row)(e);
          }}
        />
      )}
    />
  );
}
