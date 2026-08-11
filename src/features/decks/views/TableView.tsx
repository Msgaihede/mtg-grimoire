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
import { useMemo } from "react";
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
  selectedCardId,
  className,
}: {
  groups: readonly CardGroup[];
  violations?: Map<string, ValidationIssue[]>;
  onSelect?: (card: DeckCard) => void;
  /** Which card the open pane is about, so its row says so. */
  selectedCardId?: string | null;
  className?: string;
}) {
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
        width: "3rem",
        header: "Qty",
        cellClassName: "font-mono text-xs tabular-nums text-dim",
        cell: (row) => (row.kind === "card" ? row.card.quantity : null),
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
              {row.card.gameChanger === true && <GameChangerBadge />}
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
    [],
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
 * A card row is the table's own; a group row replaces every cell with one band.
 *
 * The props are spread whole in both cases — the role, the row index, the focus ring and the
 * geometry all still apply — and the band overrides exactly two of them: the children, and
 * the column template, which a full-width band has no use for.
 */
function renderRow(props: RowRenderProps, row: Row) {
  if (row.kind === "card") return <div {...props} />;
  return (
    <div
      {...props}
      // Not activatable: a band is a heading, and Enter on one would open nothing.
      tabIndex={undefined}
      onClick={undefined}
      onKeyDown={undefined}
      style={{ ...props.style, gridTemplateColumns: undefined }}
      className={cn(props.className, "flex items-center bg-surface")}
    >
      <GroupHeader group={row.group} className="w-full" />
    </div>
  );
}
