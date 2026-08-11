/**
 * The deck as a table: one row per card, under a band naming its group.
 *
 * The view to reach for when the question is comparative — what is dearest, what is not
 * owned, what is tagged. It is the app's one `VirtualTable` and not a fourth table of its
 * own, which is what keeps the row pitch, the sticky header, the focus ring and the
 * interactive-cell guards identical to the collection's and the wishlist's.
 *
 * **Its headers do not sort, and that is the one deliberate difference from the other
 * three.** The deck's order is the toolbar's — one Group by and one Sort, which together
 * decide both the bands and the rows inside them — and a header that re-sorted would give one
 * list two orders with no way to see which was in force. A press on a header would also have
 * to say what it meant to do to the grouping, which is a question the toolbar has already
 * answered.
 */
import { useCallback, useMemo } from "react";
import { OwnedBadge } from "@/components/OwnedBadge";
import { ManaText } from "@/components/ManaText";
import { RarityGem } from "@/components/RarityGem";
import {
  VirtualTable,
  type RowRenderProps,
  type TableColumn,
} from "@/components/table/VirtualTable";
import type { DeckCard } from "@/lib/ipc";
import { PRICES_AS_OF, usdPrice } from "@/lib/prices";
import { cn } from "@/lib/utils";
import { GameChangerBadge, rowMarkColor, TagDot } from "../CardMarks";
import {
  deckCardProps,
  DeckCardControls,
  deckGroupProps,
  useCategoryDrop,
  useDeckCardDrag,
  type DeckCardActions,
} from "../cardControl";
import type { CardGroup } from "../grouping";
import { ruleBreak } from "../violations";
import type { ValidationIssue } from "../validation/types";
import { GroupHeader } from "./GroupHeader";

/**
 * What one row of the flat list is. A table with bands is a flat list of two kinds of thing,
 * because that is what a virtualiser can measure — a nested list would have to be flattened
 * at render time anyway, and then the row indices a screen reader is told would be a
 * different set from the ones the virtualiser is counting.
 */
type Row =
  | { kind: "group"; key: string; group: CardGroup }
  | { kind: "card"; key: string; group: CardGroup; card: DeckCard; ruleBreakText: string | null };

export function TableView({
  groups,
  violations,
  onSelect,
  actions,
  selectedCardId,
  className,
}: {
  groups: readonly CardGroup[];
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  /**
   * What may be done to a card here — see {@link DeckCardActions}.
   *
   * **This view spends them as columns, where the other three draw them over the card**, and
   * that is the one difference worth having: a table's answer to "where does a control go" is
   * a column of its own, and an overlay would cover the very cells a reader came here to
   * compare. The controls themselves are `cardControl.tsx`'s, the same ones.
   */
  actions?: DeckCardActions;
  /** Which card the open pane is about, so its row says so. */
  selectedCardId?: string | null;
  className?: string;
}) {
  const editable = actions?.setQuantity !== undefined || actions?.move !== undefined;
  const rows = useMemo<Row[]>(
    () =>
      groups.flatMap((group) => [
        { kind: "group" as const, key: `g-${group.key}`, group },
        ...group.cards.map((card) => ({
          kind: "card" as const,
          key: `c-${group.key}-${card.id}`,
          group,
          card,
          ruleBreakText: ruleBreak(violations?.get(card.cardId)),
        })),
      ]),
    [groups, violations],
  );

  const columns = useMemo<TableColumn<Row>[]>(
    () => [
      {
        key: "quantity",
        // Wide enough for the stepper when there is one, and no wider when there is not — a
        // read-only deck table should not carry an empty 8rem gutter.
        width: editable ? "8.5rem" : "3rem",
        header: "Qty",
        // `interactive` is the whole of what keeps a press on `−` from also opening the card
        // and a typed `12` from scrolling the list a screenful — `VirtualTable` applies
        // `data-no-drag` and swallows the click and the two activation keys.
        interactive: editable,
        cellClassName: editable ? undefined : "font-mono text-xs tabular-nums text-dim",
        cell: (row) =>
          row.kind !== "card" ? null : editable ? (
            <DeckCardControls card={row.card} actions={actions} className="flex-nowrap" />
          ) : (
            row.card.quantity
          ),
      },
      {
        key: "name",
        width: "minmax(0,2fr)",
        header: "Card name",
        cell: (row) =>
          row.kind === "card" ? (
            <span
              // The stripe the text view uses, for the same reason and in the same two
              // colours: down a column of eighty rows it is what says where to stop.
              style={{ borderColor: rowMarkColor(row.ruleBreakText, row.card.gameChanger) }}
              className="flex min-w-0 items-center gap-1.5 border-l-2 pl-2"
              title={row.ruleBreakText ?? undefined}
            >
              <span className="min-w-0 truncate">{row.card.name}</span>
              {/* The badge and the stripe are both `aria-hidden` decoration; this is where
                  the table says the two facts in words. It works here and not on the other
                  three views because a row is not an `aria-label`-ed button — a cell's text
                  is really read. */}
              {row.card.gameChanger === true && (
                <>
                  <GameChangerBadge />
                  <span className="sr-only">Game changer</span>
                </>
              )}
              {row.ruleBreakText !== null && (
                <span className="sr-only">Rule break: {row.ruleBreakText}</span>
              )}
            </span>
          ) : null,
      },
      {
        key: "manaCost",
        width: "6rem",
        header: "Mana cost",
        cell: (row) => (row.kind === "card" ? <ManaText source={row.card.manaCost} /> : null),
      },
      {
        key: "type",
        width: "minmax(0,1.5fr)",
        header: "Type",
        cellClassName: "truncate text-xs text-dim",
        // The front face, like everywhere else: a modal DFC's back is routinely a land while
        // its front is a spell.
        cell: (row) =>
          row.kind === "card" ? (row.card.typeLine ?? "").split("//")[0].trim() : null,
      },
      {
        key: "price",
        width: "5rem",
        header: "Price",
        headerTitle: PRICES_AS_OF,
        headerLabel: `Price. ${PRICES_AS_OF}`,
        headerClassName: "text-right",
        cellClassName: "text-right font-mono text-xs tabular-nums",
        cell: (row) => (row.kind === "card" ? usdPrice(row.card.unitPriceUsd) : null),
      },
      {
        key: "owned",
        width: "4rem",
        header: "Owned",
        // The allocator claims nothing for an inactive category, so a badge there would read
        // as "you own none of these" when the truth is "this deck reserved none".
        cell: (row) =>
          row.kind === "card" && row.card.categoryActive ? (
            <OwnedBadge owned={row.card.ownedQuantity} />
          ) : null,
      },
      {
        key: "tag",
        width: "7rem",
        header: "Tags",
        cell: (row) =>
          row.kind === "card" && row.card.tagName !== null ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <TagDot name={row.card.tagName} color={row.card.tagColor} />
              <span className="min-w-0 truncate text-xs">{row.card.tagName}</span>
            </span>
          ) : null,
      },
      {
        key: "rarity",
        width: "6rem",
        header: "Rarity",
        cell: (row) =>
          row.kind === "card" ? <RarityGem rarity={row.card.rarity} withLabel /> : null,
      },
      {
        key: "printing",
        width: "7rem",
        header: "Printing",
        cellClassName: "truncate font-mono text-xs text-dim",
        cell: (row) =>
          row.kind === "card"
            ? `${row.card.setCode.toUpperCase()} · ${row.card.collectorNumber}`
            : null,
      },
    ],
    [editable, actions],
  );

  // Closed over the column count, because the band's one cell has to say how many columns it
  // stands in and the count is data here rather than a literal.
  //
  // A **component** rather than an element, because a row is a drag source and a drop target
  // and both of those are hooks — and a hook cannot be called from inside a `map` or a
  // callback. `DeckTableRow` is where they live; the band gets one too, so letting a card go
  // on a group's heading files it under that group like letting it go on any of its rows.
  const drop = actions?.drop;
  const renderRow = useCallback(
    (props: RowRenderProps, row: Row) => (
      <DeckTableRow
        props={props}
        row={row}
        columns={columns.length}
        actions={actions}
        onDrop={drop}
      />
    ),
    [columns.length, actions, drop],
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <VirtualTable<Row>
        rows={rows}
        columns={columns}
        label="This deck"
        total={rows.length}
        // A deck arrives whole — there is no next page, and the identity of the list is what
        // is in it, so a regrouping starts at the top.
        listKey={rows.map((row) => row.key).join("|")}
        onNeedNextPage={() => {}}
        // The toolbar owns the order; see this file's own note.
        sort={[]}
        onSort={() => {}}
        onActivate={onSelect ? (row) => row.kind === "card" && onSelect(row.card) : undefined}
        isSelected={(row) =>
          row.kind === "card" && selectedCardId != null && row.card.cardId === selectedCardId
        }
        renderRow={renderRow}
      />
    </div>
  );
}

/**
 * One row of the table, as a component — which is what lets it be a drag source and a drop
 * target, since both are hooks and `renderRow` is a callback.
 *
 * **Every row of a group is a drop target for that group**, the band included: the bands are
 * this view's only heading, so a reader aiming a card at "Ramp" is aiming at the band, and a
 * target that covered only the cards would refuse the most obvious drop on the screen.
 */
function DeckTableRow({
  props,
  row,
  columns,
  actions,
  onDrop,
}: {
  props: RowRenderProps;
  row: Row;
  columns: number;
  actions?: DeckCardActions;
  onDrop?: DeckCardActions["drop"];
}) {
  const { attach, over } = useCategoryDrop(row.group.categoryId, onDrop);
  const dragRef = useDeckCardDrag(
    row.kind === "card" ? row.card : EMPTY_CARD,
    row.kind === "card" && actions?.drop !== undefined,
  );
  // One element, two registrations — a row is both the thing that can be picked up and the
  // place a card can be let go. React 19 calls the returned function as the cleanup, so the
  // two teardowns are chained rather than one of them being dropped.
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const stopDrag = dragRef(element);
      const stopDrop = attach(element);
      return () => {
        stopDrag?.();
        stopDrop?.();
      };
    },
    [dragRef, attach],
  );

  if (row.kind === "group") return bandRow(props, row.group, columns, ref, over);

  return (
    <div
      {...props}
      ref={ref}
      // The caret's way home after a printing swap, on the row because the row is what takes
      // focus in this table (`VirtualTable` owns the click, Enter and Space on it).
      {...deckCardProps(row.card)}
      className={cn(props.className, over && "ring-1 ring-inset ring-accent")}
    />
  );
}

/** A row's drag payload needs a card, and a band has none. Never read: `useDeckCardDrag` is
 *  handed `enabled: false` for a band, so nothing registers and nothing is asked for it. */
const EMPTY_CARD = { cardId: "", name: "", categoryId: 0 } as DeckCard;

/**
 * A card row is the table's own; a group row is one band spanning every column.
 *
 * The props are spread whole in both cases, and the band then overrides **six** of them:
 * `tabIndex`, `onClick` and `onKeyDown` because a heading is not something Enter opens;
 * `style.gridTemplateColumns`, because a band has one track rather than nine; `className`,
 * for the surface colour; and `children`, which is the band itself. Everything it does not
 * touch — `role`, `aria-rowindex`, the absolute geometry, the focus ring — is exactly what a
 * row in this table is, and a band is still a row of it.
 *
 * **The band owns a real cell.** A `role="row"` with no `role="cell"` inside it is malformed
 * to assistive tech — a row that owns nothing — so the heading sits in one cell carrying
 * `aria-colspan`, which is the same thing the design canvas's `colspan="9"` says in HTML.
 */
function bandRow(
  props: RowRenderProps,
  group: CardGroup,
  columns: number,
  ref: (element: HTMLDivElement | null) => void,
  over: boolean,
) {
  return (
    <div
      {...props}
      ref={ref}
      tabIndex={undefined}
      onClick={undefined}
      onKeyDown={undefined}
      // The caret lands here when a card leaves this pile under it, exactly as it lands on a
      // group's section in the other three views — the band *is* the group here.
      {...deckGroupProps(group.categoryId)}
      // One track, not nine. `props.className` already carries `grid`; overriding the
      // template is the whole of what makes this row one cell wide, and adding a second
      // display utility beside it would leave which one wins to the class sorter.
      style={{ ...props.style, gridTemplateColumns: "minmax(0,1fr)" }}
      className={cn(props.className, "bg-surface", over && "ring-1 ring-inset ring-accent")}
    >
      <span role="cell" aria-colspan={columns} className="flex min-w-0 items-center">
        <GroupHeader group={group} className="w-full" />
      </span>
    </div>
  );
}
