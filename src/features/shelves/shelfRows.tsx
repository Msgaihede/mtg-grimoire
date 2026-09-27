/**
 * **The sectioned wall's row pieces** — which shelf the sticky bar names, what a row is keyed by,
 * the rails down a nested shelf's left side and the slot a page that has not landed leaves. All
 * four are `CardGrid`'s and nobody else's; they live here so that file is the wall rather than
 * the wall and every part of it (final review S-M3), and each is exactly as it stood there.
 */
import { CARD_ASPECT } from "@/lib/images";
import {
  SHELF_INDENT_PX,
  SHELF_RAIL_OFFSET_PX,
  shelfAtRow,
  type ShelfLayout,
} from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";

/**
 * **Which shelf the sticky bar names**, given the rows the virtualiser has drawn and where the
 * bar's top edge sits in the virtualiser's coordinates.
 *
 * The row under the edge is the last drawn row whose `start` is at or above it. Three answers are
 * `null`, and each is a place where a bar would say something false or hide something true:
 *
 * - **Nothing drawn at the edge** — the wall has not reached the top of the scrollport yet (a
 *   growing wall below the page's header), or the edge is in the wall's own padding.
 * - **Above the first heading** — an opened folder's own cards, which sit under the path row with
 *   no heading because the path row already names them (spec §3.1).
 * - **A heading whose own top is still on screen** — it names itself, and a bar laid over it would
 *   hide the very buttons it copies. At rest, that is the first heading.
 *
 * Pure, and exported for exactly that: jsdom lays nothing out, so `CardGrid.shelves.test.tsx`
 * asks this row by row over a real `layoutShelves` result.
 */
export function stickyShelfAt(
  layout: ShelfLayout,
  drawn: readonly { index: number; start: number }[],
  edge: number,
): Shelf | null {
  let top: { index: number; start: number } | undefined;
  for (const item of drawn) {
    if (item.start > edge) break;
    top = item;
  }
  if (!top) return null;
  const firstHeading = layout.rows.findIndex((row) => row.kind === "heading");
  if (firstHeading < 0 || top.index < firstHeading) return null;
  if (layout.rows[top.index]?.kind === "heading" && top.start >= edge) return null;
  return shelfAtRow(layout, top.index);
}

/**
 * A sectioned row's virtualiser key: **what the row is**, not where it sits.
 *
 * A heading keyed by its shelf keeps its React identity when the rows above it change — a shelf
 * folding, a page landing, every shelf folding to its heading for a folder drag (spec §3.9) — so
 * the element being dragged, a rename field being typed in and a drop target that has armed all
 * survive it. A tile row is keyed by its shelf and its offset *within* that shelf for the same
 * reason. Shelf ids are unique in one list, and `Not sorted` is `0`, which no folder is.
 */
export function shelfRowKey(layout: ShelfLayout, index: number): string {
  const row = layout.rows[index];
  if (!row) return `row:${index}`;
  switch (row.kind) {
    case "label":
      return `label:${row.group}`;
    case "heading":
      return `heading:${row.shelf.id}`;
    case "empty":
      return `empty:${row.shelf.id}`;
    case "tiles":
      return `tiles:${row.shelf.id}:${row.start - (layout.tileStart.get(row.shelf.id) ?? 0)}`;
  }
}

/**
 * The rails of one nested shelf's row — a 1px line per level of indent, in `border-border`,
 * standing under the parent heading's chevron (spec §3.3).
 *
 * **Drawn per row and as tall as the row's whole pitch** (`v.size`, gap included), so the rail of
 * one row meets the rail of the next and a nested shelf reads as one line down its left side
 * rather than a dotted one. Positioned from the row's own left edge (`from` is the row's gutter),
 * so it does not move with the row's padding.
 */
export function ShelfRails({
  indent,
  from,
  height,
}: {
  indent: number;
  from: number;
  height: number;
}) {
  if (indent <= 0) return null;
  return (
    <>
      {Array.from({ length: indent }, (_, level) => (
        <span
          key={level}
          aria-hidden="true"
          data-shelf-rail=""
          className="pointer-events-none absolute top-0 border-l border-border"
          style={{ left: from + level * SHELF_INDENT_PX + SHELF_RAIL_OFFSET_PX, height }}
        />
      ))}
    </>
  );
}

/**
 * A slot whose page has not landed — the art's 5:7 box in the frame's own felt, with nothing to
 * press, nothing to walk onto and nothing announced.
 *
 * It exists because a shelf's size comes from its count (`*_shelf_counts`) and not from its pages,
 * so every heading can be placed before the cards arrive and nothing reflows when they do. **Not a
 * `Tile`**: no `data-grid-index`, no button, no drag — the arrow walk scrolls toward it and waits.
 * `CardArt`'s own `rounded-lg border border-border bg-surface`, so the card that lands draws over
 * exactly this box.
 */
export function PendingSlot({ slot, width }: { slot: number; width: number }) {
  return (
    <div data-pending-slot={slot} aria-hidden="true" className="shrink-0" style={{ width }}>
      <div
        className="w-full rounded-lg border border-border bg-surface"
        style={{ aspectRatio: CARD_ASPECT }}
      />
    </div>
  );
}
