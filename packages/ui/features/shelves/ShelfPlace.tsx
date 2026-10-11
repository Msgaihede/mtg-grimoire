import type { ReactElement, ReactNode } from "react";
import type { TableColumn } from "@/components/table/VirtualTable";
import { useTooltip } from "@/components/tooltip/useTooltip";
import type { Shelf } from "@/lib/shelves";
import { cn } from "@/lib/utils";
import { ShelfGlyph } from "./ShelfHeading";

/**
 * Where a card is filed, as words — the shelf's whole path from the root, `Binder › Staples`.
 * What {@link ShelfPlace}'s tooltip says, and what a test finds it by.
 */
export function shelfPlaceName(shelf: Pick<Shelf, "path">): string {
  return shelf.path.join(" › ");
}

/**
 * **Which shelf a card is on, said on the card itself** — the `View all` wall's half of what a
 * heading says on the shelves (issue #907).
 *
 * The flat wall draws no headings, so the folder a tile is filed in has nowhere to be said but on
 * the tile. The chin carries it, before the printing: the shelf's own glyph — the heading's, shut,
 * so a deck group still reads as a deck and `Recently removed` as the inbox it is — and its name.
 * The whole path rides as the tooltip, because a chin is ~170px at 100% and `Fetchlands` says which
 * drawer where `Binder › Staples › Fetchlands` would say only `Binder › St…`.
 *
 * **One line, and the printing gives way first.** `CardGrid` positions its rows from the caption's
 * height, so nothing here may wrap: the name and the printing both truncate, and the printing's
 * shrink is weighted a hundred to one, so a narrow tile keeps the drawer and loses the set code —
 * the drawer is what this wall is the only place to read.
 *
 * `sr-only` "In" before the name, so the line is read as a place rather than as a second title.
 * The table's `Folder` column draws the same mark without the printing beside it.
 */
export function ShelfPlace({
  shelf,
  children,
  className,
}: {
  shelf: Pick<Shelf, "kind" | "name" | "path">;
  /** What follows the place on the same line — the chin's printing. */
  children?: ReactNode;
  className?: string;
}): ReactElement {
  const tip = useTooltip();
  return (
    <span
      className={cn("flex min-w-0 items-center gap-[calc(0.25rem*var(--mark-scale,1))]", className)}
    >
      <ShelfGlyph
        kind={shelf.kind}
        open={false}
        className="size-[calc(0.75rem*var(--mark-scale,1))]"
      />
      <span
        {...tip(shelfPlaceName(shelf), { describes: false })}
        className="min-w-0 flex-[0_1_auto] truncate text-text"
      >
        <span className="sr-only">In </span>
        {shelf.name}
      </span>
      {children !== undefined && (
        <>
          <span aria-hidden="true" className="flex-none">
            ·
          </span>
          <span className="min-w-0 flex-[0_100_auto] truncate">{children}</span>
        </>
      )}
    </span>
  );
}

/**
 * **The `Folder` column a flat table draws on the `View all` wall** (issue #907) — the chin's
 * {@link ShelfPlace} as a cell, so the table says what the wall does. On the shelves the bands name
 * the drawer once above its rows, and a column saying the band's word on every row was taken off
 * both tables for exactly that; with no bands, the column is the only place left to say it.
 *
 * Not sortable: the backend has no folder order to sort by that would agree with the tree's, and a
 * header that sorted by folder id would be a lie with an arrow on it. A row whose shelf the census
 * does not know yet draws an em dash, the table's word for "nothing to say".
 */
export function shelfColumn<Row>(
  shelfOf: (row: Row) => Pick<Shelf, "kind" | "name" | "path"> | undefined,
): TableColumn<Row> {
  return {
    key: "folder",
    width: "8rem",
    header: "Folder",
    cellClassName: "flex items-center text-xs text-dim",
    cell: (row) => {
      const shelf = shelfOf(row);
      return shelf === undefined ? "—" : <ShelfPlace shelf={shelf} />;
    },
  };
}
