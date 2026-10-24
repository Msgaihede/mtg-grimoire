import type { ReactElement } from "react";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { cn } from "@/lib/utils";

/** How a test or a live probe finds a shelf's contents target. */
export const SHELF_CONTENTS_ATTR = "data-shelf-contents";

/**
 * **A shelf's tiles as a drop target** (issue #1377) — the box `CardGrid` lays behind every tile
 * row of one shelf (`GridSections.renderContents`), filled by the page with this and a
 * registration from `useShelfContentsDropTarget`.
 *
 * **Behind the tiles and never over them**: the wall draws it before the rows, so the art paints
 * over it and the wash shows in the gaps between cards and the margin around them — the drawer
 * lighting up behind what is in it. It takes no pointer events: dnd-kit finds a target by its
 * rectangle rather than by hit-testing, so a box nothing can click is still one a card lands in,
 * and every press, hover and right-click on a tile reaches the tile.
 *
 * Only the `over` mark, never an `armed` one — see the hook for why.
 */
export function ShelfContents({
  dropRef,
  over = false,
}: {
  dropRef?: (el: HTMLElement | null) => void;
  over?: boolean;
}): ReactElement {
  return (
    <div
      ref={dropRef}
      aria-hidden="true"
      {...{ [SHELF_CONTENTS_ATTR]: over ? "over" : "" }}
      className={cn("pointer-events-none size-full rounded-xl", over && cn(DROP_RING, DROP_OVER))}
    />
  );
}
