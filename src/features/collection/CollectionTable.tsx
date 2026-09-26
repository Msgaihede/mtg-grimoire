import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { Trash2 } from "lucide-react";
import { FinishMark } from "@/components/FinishMark";
import { ManaText } from "@/components/ManaText";
import { QuantityStepper } from "@/components/QuantityStepper";
import { RarityGem } from "@/components/RarityGem";
import { TABLE_BAND_HEIGHT, VirtualTable, type TableColumn } from "@/components/table/VirtualTable";
import { useTooltip, type TooltipBinder } from "@/components/tooltip/useTooltip";
import { REVEAL_ON_HOVER } from "@/features/collection/AddToCollection";
import { collectionDraggable } from "@/features/collection/collectionDrag";
import { CONDITION_LABEL, CONDITION_NOT_SET, type Condition } from "@/lib/conditions";
import { finishLabel, isFinish } from "@/lib/finish";
import { finishTreatments } from "@/lib/treatment";
import { FOCUS } from "@/lib/focus";
import type { CollectionRow, CollectionSortKey } from "@/lib/ipc";
import type { Marketplace } from "@/lib/marketplace";
import { formatPrice, pricesAsOf } from "@/lib/prices";
import {
  SHELF_EMPTY_HEIGHT,
  SHELF_INDENT_PX,
  SHELF_RAIL_OFFSET_PX,
  type LayoutRow,
} from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
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
 * `Foil, NM` where the reader said what state the copy is in, and **`Foil` alone where they did
 * not**. The "no grade" branch this used to carry was documented as unreachable, on the argument
 * that `condition` is `NOT NULL DEFAULT 'NM'` on the column and non-nullable on
 * {@link CollectionRow} — the column and the DTO have not changed, and the *default* has: it is
 * the `NONE` sentinel since schema v35, so the arm is what every add that states no grade lands
 * on rather than a state the backend cannot build.
 *
 * Neither half of the sentinel belongs in a name. `Foil, NONE` says a storage token out loud,
 * `Foil, Not set` names a grade the reader never chose, and a bare `Foil, ` trails a comma into
 * nothing. An absence is said by saying nothing.
 */
function copyLabel(row: CollectionRow): string {
  const finish = finishLabel(row.finish);
  return row.condition === CONDITION_NOT_SET ? finish : `${finish}, ${row.condition}`;
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
 * **Six, and the sixth is the removal's strip again.** Folders had it carry the drawer's name as
 * well (`Folder`), and shelves took that back off: a shelved table draws each shelf's rows under
 * that shelf's band, which names the drawer and wears its lock, so a column saying the band's word
 * on every row under it was the same fact forty times. The 2.5rem it gave up goes back to the name.
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
            {/* **The finish this copy is, and what it is called** — a foil, an etched, a Surge
              Foil, a serialized card. Here rather than in the `Finish · condition` column
              beside it, which is 5.5rem and truncates "Nonfoil · NM" as it is: that column
              answers *which finish*, which is a word this table sorts on and must keep
              spelling the same way, and "Step-and-Compleat Foil" would leave it showing three
              letters. The glyph carries the name as its accessible name and its tooltip,
              exactly as the search table's does one screen over.

              **Ungated, because the glyph is the finish** (issue #353). It used to be drawn
              only where a treatment named the copy, which was right while a treatment had a
              glyph of its own — but now that a Surge Foil is the same `Sparkles` as any other
              foil, gating on the name would draw the foil icon on the Surge Foil row and
              nothing on the plain foil row above it, which is the same one-fact-two-pictures
              defect the issue is about, inside one table. `FinishMark` returns `null` for a
              plain copy, so the unmarked case is still unmarked.

              The entry's own `finish` decides what applies: this reader owns *this* copy, so
              the plain half of a Surge Foil printing is not marked. An unrecognised finish —
              the column is TEXT with a CHECK, and `finishLabel` prints whatever it holds —
              names no treatment rather than guessing at one. */}
            <FinishMark
              finish={isFinish(row.finish) ? row.finish : "nonfoil"}
              treatments={treatmentsOf(row)}
              className="self-center"
            />
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
      // — the same rule as the grid caption and `CardChin`'s printing line.
      //
      // No `whenClipped`: the span shows the set *code* and the tip says its *name*, so gating
      // the panel on the code's own clip gates it on a different string than the one it says —
      // the rule is stated at `CardChin`'s `printingTitle`, which inherited it from the docked
      // pane's printings row.
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
        /* **The finish alone where the grade was never stated.** Both halves and the separator
          were unconditional while `condition` was `NOT NULL DEFAULT 'NM'`, which made the "no
          grade" arm this cell used to carry a state the backend could not build. Schema v35
          moved the default onto the `NONE` sentinel, so that arm is now where every add that
          says nothing about a grade lands — and it is the commonest row in a new collection
          rather than a rarity.

          It prints `Foil`. Not `Foil · NONE`, which puts a storage token in a column a reader
          scans; not `Foil · —`, because an em dash is what this table draws for a *value* it
          does not have (an orphan's name, an unpriced row) and a grade nobody claimed is not a
          missing value. The `<abbr>` and its `sr-only` twin go with it for the same reason:
          an abbreviation that expands to nothing, and a " (…)" read aloud after a finish, are
          two ways of announcing an absence that is better left silent. */
        if (condition === CONDITION_NOT_SET) return finishLabel(row.finish);
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
            change it is somewhere else entirely (cut the card from the deck, or move the copy
            into a folder the reader made). It is drawn in this table's own data styling for the
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
            // The deck editor's table draws `xs` and this drew `sm`, which was the two lists
            // disagreeing about one control in the one place they are the same shape (issue #348).
            // `xs` is the app's size for a stepper in a dense row — the deck's table and text
            // views both — and this row is 44px like theirs (`TABLE_ROW_HEIGHT`).
            size="xs"
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
      key: "remove",
      width: "2rem",
      /**
       * **The removal, in a strip of its own** — where it stood before folders, and for the reason
       * it stood there: offered on an empty row and nowhere else. **No shipped write produces one**
       * (since schema v24 a stepper at zero deletes, and `collectionUpdate` has no caller), so this
       * is the escape hatch for a row a hand-edited database or a future editor leaves behind, and
       * it stays fenced on `quantity === 0` because on a row that still holds cards it would be a
       * one-click way to lose the lot from a list that scrolls under the pointer.
       */
      header: "Remove",
      srOnlyHeader: true,
      // A control lives here on an empty row, so the row's own press must not also fire.
      interactive: true,
      cellClassName: "flex items-center justify-end",
      cell: (row) =>
        row.quantity === 0 ? (
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
        ) : null,
    },
  ];
}

/**
 * What a shelved table is handed (spec §3.10): the wall's own layout rows — `layoutShelves` over the
 * page's sections, at one column — the loaded rows of each shelf, and the page's four drawings.
 * The table draws what it is given and decides nothing about shelves; which is open, which is empty
 * and which label comes first were all decided once, for the wall and the table together.
 */
export interface CollectionTableShelves {
  layout: readonly LayoutRow[];
  rowsOf: (shelfId: number) => readonly CollectionRow[];
  /**
   * Whether every page of the list has loaded. **Required rather than defaulted**, because the
   * answer decides where the table stops drawing (see {@link shelvedRows}) and a default of "yes"
   * would quietly draw every heading past the loaded rows for a caller that forgot to say.
   */
  complete: boolean;
  renderHeading: (shelf: Shelf) => ReactNode;
  renderLabel: (group: "decks" | "managed") => ReactNode;
  renderEmpty: (shelf: Shelf) => ReactNode;
  renderSticky: (shelf: Shelf | null, scrollToTop: () => void) => ReactNode;
  /**
   * The shelf whose heading band to bring into view — `CardGrid`'s `revealShelfId`, the table's
   * half: Add folder's draft heading while its field is open, and afterwards the heading the caret
   * is being handed back to (after Add folder in a heading, or a Move up / Move down). Handed to
   * `VirtualTable` as that band's row index (`revealIndex`), which scrolls it clear of the header
   * and the sticky bar and never moves focus — the heading takes the caret itself once it is drawn.
   * A shelf with no band among the rows drawn (past the loaded edge, or not on this wall) reveals
   * nothing.
   */
  revealShelfId?: number | null;
}

/** A band row: a label, a heading, or an empty folder's box — drawn by `VirtualTable` itself. */
type Band =
  | { kind: "label"; group: "decks" | "managed" }
  | { kind: "heading"; shelf: Shelf }
  | { kind: "empty"; shelf: Shelf };
type TableRow = CollectionRow | { band: Band };

/** `CollectionRow` has no `band` field, so its presence is the whole discriminant. */
const isBand = (row: TableRow): row is { band: Band } => "band" in row;

/** Which shelf's band a row is — its folder's id for a heading or an empty box, the group for a
 *  label, which belongs to no shelf. `WishlistTable`'s keys, spelt the same way. */
function bandKey(band: Band): string {
  if (band.kind === "label") return `label:${band.group}`;
  return band.kind === "heading" ? `band:${band.shelf.id}` : `empty:${band.shelf.id}`;
}

/**
 * The layout as one list of table rows, and the shelf each row belongs to — a band per label,
 * heading and empty row, and a shelf's loaded rows **once**, where its first run of tiles is. The
 * layout is at one column, so a shelf has one tiles row per tile; the table draws entries rather
 * than tiles, so it reads only where the shelf's rows start and draws every loaded row there.
 *
 * **While pages remain, it stops after the shelf holding the last loaded row** — the wishlist's
 * `shelfTable` rule, reached from rows rather than counts because a collection shelf's count is in
 * *tiles* and the table draws *entries*. The list is paged in shelf order, so that shelf is the
 * edge of what has arrived. Drawn past it, every later shelf's band would stand over rows that
 * are not there — `42 cards` over nothing — and `VirtualTable`, which asks for the next page when
 * the rows it has drawn run low, would count those bands as rows and not ask until the reader had
 * scrolled deep into them, then insert a page above the viewport. With nothing loaded yet the edge
 * is the first shelf expecting rows, which is the one the first page is filling.
 */
function shelvedRows(
  layout: readonly LayoutRow[],
  rowsOf: (shelfId: number) => readonly CollectionRow[],
  complete: boolean,
): {
  rows: TableRow[];
  shelfAt: (Shelf | null)[];
  /** The indent of the shelf each drawn entry is filed under — what its rails are counted from. */
  indentOf: ReadonlyMap<TableRow, number>;
} {
  // The shelf the drawing stops after, or `null` to draw every one.
  let edge: number | null = null;
  if (!complete) {
    for (const row of layout) {
      if (row.kind !== "tiles") continue;
      if (edge === null) edge = row.shelf.id;
      if (rowsOf(row.shelf.id).length > 0) edge = row.shelf.id;
    }
  }
  const rows: TableRow[] = [];
  const shelfAt: (Shelf | null)[] = [];
  const indentOf = new Map<TableRow, number>();
  const drawn = new Set<number>();
  for (const [index, row] of layout.entries()) {
    // Past the edge shelf's rows: a label, heading or empty box for a later shelf ends the drawing.
    if (edge !== null && drawn.has(edge) && (row.kind === "label" || row.shelf.id !== edge)) break;
    if (row.kind === "label") {
      rows.push({ band: { kind: "label", group: row.group } });
      // A label belongs to the shelf it introduces — `shelfAtRow`'s rule.
      const next = layout[index + 1];
      shelfAt.push(next !== undefined && next.kind !== "label" ? next.shelf : null);
    } else if (row.kind === "heading") {
      rows.push({ band: { kind: "heading", shelf: row.shelf } });
      shelfAt.push(row.shelf);
    } else if (row.kind === "empty") {
      rows.push({ band: { kind: "empty", shelf: row.shelf } });
      shelfAt.push(row.shelf);
    } else if (!drawn.has(row.shelf.id)) {
      drawn.add(row.shelf.id);
      for (const entry of rowsOf(row.shelf.id)) {
        rows.push(entry);
        shelfAt.push(row.shelf);
        indentOf.set(entry, row.shelf.indent);
      }
    }
  }
  return { rows, shelfAt, indentOf };
}

/**
 * **The rails** (spec §3.3), the table's half of `CardGrid`'s `ShelfRails`: one 1px line per level
 * of indent, standing at the same offsets the wall's do, as tall as the row.
 *
 * **Positioned against the row, never against the cell**, and that is the one decision here. The
 * name cell's `Needs review` sentence is `absolute inset-x-3` against the row, so a `relative` on
 * the first cell would squeeze that sentence into the name column; the band's cell is not
 * positioned either. So the rails sit in a zero-width `absolute inset-y-0 left-3` box — which
 * resolves to the row in both, starts where the row's `px-3` content starts, and is the row's full
 * height — and each rail stands `SHELF_RAIL_OFFSET_PX + level × SHELF_INDENT_PX` into it.
 */
function TableRails({ indent }: { indent: number }) {
  if (indent <= 0) return null;
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-3">
      {Array.from({ length: indent }, (_, level) => (
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
 * A row that is both the card it lists and the entry it is — spec §1's second drag source, and
 * since the folders (spec §7.1) the app's only source of a filing drag.
 *
 * **Two payloads under two keys on one registration.** The **card** half is what a deck category
 * or the sidebar's Decks entry reads, and it carries no finish and no condition: a deck names a
 * printing, and the two columns that make this row an *entry* are exactly what such a drop cannot
 * answer. The **entry** half is what a shelf heading or a breadcrumb segment reads, and it is the
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
  shelves,
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
   * And for a folder kind the page has not been taught about:
   * `` `In ${row.folderName}. Move it into one of your own folders to change how many you hold.` ``
   * **`Recently removed` is not fenced at all since issue #506** — its copies belong to no deck, so
   * its rows draw the stepper like any row the reader filed, and the sentence it used to get
   * (*Move it back to your collection…*) is gone with the fence.
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
  /**
   * The shelves (spec §3.10). Absent: today's flat table over `rows`, which is what every story and
   * every other mount of this table wants. Present: `rows` is ignored for drawing, and the table
   * draws the layout's bands with each shelf's rows under its heading.
   */
  shelves?: CollectionTableShelves;
}) {
  // Opening a card is a store write and nothing else — `App` owns the pane, so the list
  // never has to know whether one is open, only which card is in it.
  const selectCard = useAppStore((s) => s.setSelectedCardId);
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const tip = useTooltip();
  /**
   * `display: contents`, so this box has no layout of its own and the table's height chain
   * (`min-h-0 flex-1` on `VirtualTable`'s root) is untouched — it exists only so the sticky bar's
   * **Top** can find the scroller, which `VirtualTable` keeps to itself.
   */
  const frame = useRef<HTMLDivElement>(null);
  /**
   * **Top scrolls the table's scroller, which is not the `role="table"` element here.** While a
   * sticky band is live `VirtualTable` moves the scroll container onto a plain `div` around the
   * table — the bar may not be owned by a `role="table"` — so the scroller is the table's parent,
   * and a Top aimed at the table itself would scroll nothing. The bar is drawn only while the
   * band is live, so this is only ever pressed in that shape.
   */
  const scrollToTop = useCallback(() => {
    const table = frame.current?.querySelector<HTMLElement>('[role="table"]');
    const scroller = table?.parentElement;
    if (scroller) scroller.scrollTop = 0;
  }, []);

  /**
   * **Keyed on the layout, the lookup and the paging flag — never on the `shelves` object.** The
   * page builds that object around four drawing callbacks that close over its mutations, and a
   * `useMutation` result is a fresh object every render, so the object is new on every keystroke
   * anywhere on the page. Keyed on it, every keystroke rebuilt the row list and handed
   * `VirtualTable` a new `rows` — `CardGrid`'s `sections` rule (`GridSections`), the table's half.
   * The drawings are read at draw time, through {@link band} and {@link stickyBand}.
   */
  const layout = shelves?.layout;
  const rowsOfShelf = shelves?.rowsOf;
  const complete = shelves?.complete ?? true;
  const shelved = useMemo(
    () => (layout && rowsOfShelf ? shelvedRows(layout, rowsOfShelf, complete) : null),
    [layout, rowsOfShelf, complete],
  );
  const tableRows: TableRow[] = shelved ? shelved.rows : rows;
  /** The requested shelf's heading band, as a row index — or nothing to reveal. */
  const revealShelfId = shelves?.revealShelfId ?? null;
  const revealIndex = useMemo(() => {
    if (shelved === null || revealShelfId === null) return null;
    const at = shelved.rows.findIndex(
      (row) => isBand(row) && row.band.kind === "heading" && row.band.shelf.id === revealShelfId,
    );
    return at < 0 ? null : at;
  }, [shelved, revealShelfId]);

  // A band never reaches a column's cell (`VirtualTable` draws it itself), so the guard below is
  // for the type, which is the union. The first column also carries the row's rails and is
  // indented by its shelf's depth, so the name lines up under its heading's title.
  const columns = useMemo(
    () =>
      columnsFor(onSetQuantity, onRemove, marketplace, tip, quantityBlocked).map(
        (column, index): TableColumn<TableRow> => ({
          ...column,
          cell: (row) => {
            if (isBand(row)) return null;
            const indent = index === 0 ? (shelved?.indentOf.get(row) ?? 0) : 0;
            if (indent === 0) return column.cell(row);
            return (
              <>
                <TableRails indent={indent} />
                <span className="block min-w-0" style={{ paddingLeft: indent * SHELF_INDENT_PX }}>
                  {column.cell(row)}
                </span>
              </>
            );
          },
        }),
      ),
    [onSetQuantity, onRemove, marketplace, tip, quantityBlocked, shelved],
  );

  // Indented and railed exactly as the rows under it are. It changes with the page's drawings,
  // which is every render — accepted: `VirtualTable` redraws the bands with it, and the row list
  // above, which is what a relayout would cost, holds still.
  //
  // **Keyed by the shelf, so a band never changes which folder it draws.** `VirtualTable` keys its
  // rows by position, so without a key a Move up / Move down re-used the heading at the old place
  // for the folder that took it — `⋯` and all — and the caret the menu had just put back on the
  // moved folder's `⋯` stayed there, on another folder's control. Keyed, the old heading goes with
  // its folder: the caret falls to `<body>`, and the moved heading takes it back where it lands
  // (`CollectionShelfHeading`'s `caret`). The keys are `WishlistTable`'s, spelt the same way.
  const band = useCallback(
    (row: TableRow): ReactNode => {
      if (!isBand(row) || !shelves) return null;
      const { band: b } = row;
      if (b.kind === "label") {
        return <Fragment key={bandKey(b)}>{shelves.renderLabel(b.group)}</Fragment>;
      }
      const indent = b.shelf.indent;
      return (
        <Fragment key={bandKey(b)}>
          <TableRails indent={indent} />
          <span
            className="flex min-w-0 flex-1 items-center self-stretch"
            style={{ paddingLeft: indent * SHELF_INDENT_PX }}
          >
            {b.kind === "heading" ? shelves.renderHeading(b.shelf) : shelves.renderEmpty(b.shelf)}
          </span>
        </Fragment>
      );
    },
    [shelves],
  );

  // **Defined for the whole life of a shelved table, and `null` where there is nothing to pin** —
  // never toggled between a function and `undefined`: that switches `VirtualTable` between its two
  // root shapes (the table as its own scroller, and a plain scroller around it), which remounts the
  // table and drops the caret on `<body>`. `null` while the row under the column header is itself
  // a heading: the heading is its own bar, and a bar drawn over it would hide the controls it
  // copies (Task 5's caller rule).
  const stickyBand = useCallback(
    (index: number): ReactNode => {
      if (!shelved || !shelves) return null;
      const row = shelved.rows[index];
      if (row === undefined || (isBand(row) && row.band.kind === "heading")) return null;
      return shelves.renderSticky(shelved.shelfAt[index] ?? null, scrollToTop);
    },
    [shelved, shelves, scrollToTop],
  );

  return (
    <div ref={frame} className="contents">
      <VirtualTable
        rows={tableRows}
        columns={columns}
        label="Your collection"
        // The data rows matching the filters; `VirtualTable` adds the bands it has loaded.
        total={total}
        listKey={listKey}
        sort={sort}
        onSort={onSort}
        band={shelves ? band : undefined}
        // An empty folder's band holds the dashed box, which is `SHELF_EMPTY_HEIGHT` tall with its
        // gap; every other band is `TABLE_BAND_HEIGHT`. The reconciler's sentence is a band under
        // the row it belongs to, and a virtualiser told every row is the same height would overlap
        // the one below it by exactly that band.
        extraHeight={(row) =>
          isBand(row)
            ? row.band.kind === "empty"
              ? SHELF_EMPTY_HEIGHT - TABLE_BAND_HEIGHT
              : 0
            : row.needsReview
              ? REVIEW_HEIGHT
              : 0
        }
        stickyBand={shelves ? stickyBand : undefined}
        revealIndex={revealIndex}
        // A row opens the card, from the mouse and from the keyboard both.
        onActivate={(row) => {
          if (!isBand(row)) selectCard(row.cardId);
        }}
        isSelected={(row) => !isBand(row) && row.cardId === selectedCardId}
        // Last, so it wins over the selection colour: a row holding no copies is a record of a
        // card the user no longer holds, and it says so by receding rather than by
        // disappearing (see the removal button's comment for the one write that still makes one).
        rowClassName={(row) => (!isBand(row) && row.quantity === 0 ? "text-dim" : undefined)}
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
        renderRow={(props, row) =>
          isBand(row) ? (
            <div {...props} />
          ) : (
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
          )
        }
      />
    </div>
  );
}
