import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SHELF_HEADING_ATTR } from "@/features/shelves/ShelfHeading";
import { SHELF_STICKY_ATTR } from "@/features/shelves/ShelfStickyBar";
import type { Shelf } from "@/lib/shelves";
import { boxed, startPointerDrag } from "@/test-drag";
import { WishShelfHeading, WishShelfSticky } from "./WishShelfHeading";
import { wishDraggable, type WishDrag } from "./wishDrag";

/**
 * **The sticky bar wins the pointer where it is drawn** (the final review's S-M1). Headings and
 * table bands scroll *underneath* the bar, so for the length of that overlap the pointer is inside
 * two targets — and dnd-kit ranks two pointer collisions by distance to each one's centre, never by
 * paint order. A heading half under the bar, its centre nearer the pointer, took a card the reader
 * released on the bar. `WishShelfSticky` registers through `useShelfStickyDropTarget` (an overlay:
 * pointer-inside and the highest priority), and this is the page's half of that fence: the
 * wishlist's own two components, overlapping the way the wall overlaps them.
 *
 * Staged as `useShelfDrag.test.tsx`'s pair is: the bar at 200–236 (centre 218), the heading at
 * 210–250 (centre 230), the pointer at 228 — inside both, and nearer the heading's centre.
 */

const shelf = (id: number, name: string): Shelf => ({
  id,
  kind: "folder",
  group: "own",
  name,
  pathIds: [id],
  path: [name],
  depth: 0,
  indent: 0,
  lead: [],
  leadIds: [],
  headless: false,
  collapsed: false,
  locked: false,
});

const SOMEDAY = shelf(3, "Someday");
const ORDERED = shelf(1, "Ordered");
const WISH: WishDrag = { wishId: 7, name: "Lightning Bolt", folderId: null };
const noop = () => {};

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/** A wish to pick up, boxed well above both targets so the press lands on neither. */
function wishSource(): HTMLElement {
  const element = boxed(document.createElement("div"), 0);
  element.textContent = "the wish";
  document.body.append(element);
  const release = wishDraggable({ element, wish: () => WISH, card: () => null });
  undo.push(() => {
    release();
    element.remove();
  });
  return element;
}

describe("WishShelfSticky", () => {
  it("takes a card released on the bar over the heading scrolled underneath it", async () => {
    const onBar = vi.fn();
    const onHeading = vi.fn();
    render(
      <>
        <WishShelfSticky
          shelf={SOMEDAY}
          onOpen={noop}
          onTop={noop}
          cards={() => ({ canDrop: () => true, onDrop: onBar })}
        />
        <WishShelfHeading
          shelf={ORDERED}
          stat=""
          peek={[]}
          onToggle={noop}
          onOpen={noop}
          source={null}
          cards={{ canDrop: () => true, onDrop: onHeading }}
        />
      </>,
    );
    boxed(document.querySelector<HTMLElement>(`[${SHELF_STICKY_ATTR}]`)!, 200, 36);
    boxed(document.querySelector<HTMLElement>(`[${SHELF_HEADING_ATTR}="${ORDERED.id}"]`)!, 210);

    const held = await startPointerDrag(wishSource());
    await held.moveTo(100, 228);
    await held.drop();

    expect(onBar).toHaveBeenCalledWith({ kind: "wish", wish: WISH });
    expect(onHeading).not.toHaveBeenCalled();
  });
});
