/**
 * The bar naming the shelf at the top of the wall — spec §3.3 and §5.3.
 *
 * **An overlay, because CSS `sticky` cannot be.** The wall's rows are `absolute` and `translateY`'d
 * by the virtualiser, so no row can stick; the host (`CardGrid`'s `renderSticky`, `VirtualTable`'s
 * `stickyBand`) draws this above the scroller at `LAYER.header` and hands it the shelf the first
 * visible row belongs to. This component is the content only — it positions nothing and names no
 * z-index.
 *
 * **A permanent drop target for cards**, which is what spec §6 needs it for: the headings come and
 * go as the wall scrolls, and this does not, so a reader holding a card always has somewhere to say
 * "the shelf I am in". It has no border of its own around it, so it wears the borderless marks.
 *
 * **Its `dropRef` has to come from `useShelfStickyDropTarget`, never from `useShelfDropTarget`.**
 * Headings and table bands scroll *under* the bar, and dnd-kit ranks two targets the pointer is
 * inside by distance to their centres rather than by what is painted on top — so a plain shelf
 * target here lost the drop to a heading half under it whose centre was nearer (review finding
 * S-M1). The sticky variant is an `overlay` target, which is pointer-inside and ranked first.
 */
import type { ReactElement } from "react";
import { ArrowUp } from "lucide-react";
import { useTooltip } from "@/components/tooltip/useTooltip";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import { SHELF_STICKY_HEIGHT } from "@/lib/shelfLayout";
import type { Shelf } from "@/lib/shelves";
import { cn } from "@/lib/utils";
import { ShelfGlyph } from "./ShelfHeading";
import { SHELF_TEXT_BUTTON } from "./shelfButtons";

/** How a test or a live probe finds the bar — the value is the shelf id it names. */
export const SHELF_STICKY_ATTR = "data-shelf-sticky";

export function ShelfStickyBar({
  shelf,
  onOpen,
  onTop,
  dropRef,
  dropMark = "none",
}: {
  shelf: Shelf | null;
  onOpen: (folderId: number) => void;
  /**
   * Scroll the wall back to its top. **Absent, no Top is drawn** — the filter quick bar (spec
   * 2026-09-29 §6.2) carries the page's one Top while it is docked over the wall, and a second one
   * a bar's height under it would be two controls for one act. Absent rather than greyed, because
   * a greyed Top would say the page cannot go back up, which it can.
   */
  onTop?: () => void;
  dropRef?: (el: HTMLElement | null) => void;
  dropMark?: "none" | "armed" | "over";
}): ReactElement | null {
  const tip = useTooltip();
  if (shelf === null) return null;

  return (
    <div
      ref={dropRef}
      {...{ [SHELF_STICKY_ATTR]: shelf.id }}
      // The wall reserves exactly this much at its top as scroll padding (`CardGrid`, final review
      // S-M2), so the bar is sized from that one number rather than from a class beside it.
      style={{ height: SHELF_STICKY_HEIGHT }}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 border-b border-border bg-bg px-2",
        // Ringed for as long as the bar could take the card, and the ring goes to full strength
        // under the pointer — `DROP_OVER` raises the ring's colour rather than its width, so the two
        // together are an escalation, never a second outline (`CollectionBreadcrumb`'s pair).
        dropMark !== "none" && DROP_RING,
        dropMark === "over" && DROP_OVER,
      )}
    >
      <ShelfGlyph kind={shelf.kind} open className="size-3.5" />
      <nav aria-label="Current shelf" className="min-w-0 flex-1">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          {shelf.kind === "unfiled" ? (
            // Not a folder, so not a door — the words, as the heading draws them.
            <li className="min-w-0">
              <span aria-current="location" className="block truncate text-text">
                {shelf.name}
              </span>
            </li>
          ) : (
            shelf.path.map((name, i) => {
              const id = shelf.pathIds[i];
              const last = i === shelf.path.length - 1;
              return (
                <li key={id} className="flex min-w-0 items-center gap-1">
                  {i > 0 && (
                    <span aria-hidden="true" className="flex-none text-dim">
                      ›
                    </span>
                  )}
                  <button
                    type="button"
                    aria-current={last ? "location" : undefined}
                    onClick={() => onOpen(id)}
                    className={cn(
                      "min-w-0 truncate rounded-sm underline-offset-[3px] hover:underline",
                      last ? "text-text" : "text-dim hover:text-text",
                      FOCUS,
                    )}
                    {...tip(name, { whenClipped: true })}
                  >
                    {name}
                  </button>
                </li>
              );
            })
          )}
        </ol>
      </nav>
      {/* The filter quick bar carries the page's one Top while it is docked, and the page then
          hands this bar no `onTop` — see the prop. */}
      {onTop && (
        <button
          type="button"
          onClick={onTop}
          className={SHELF_TEXT_BUTTON}
          {...tip("Scroll back to the top")}
        >
          <ArrowUp className="size-3.5" aria-hidden="true" />
          Top
        </button>
      )}
    </div>
  );
}
