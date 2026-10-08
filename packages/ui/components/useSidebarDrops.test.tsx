import { render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dragData } from "@/features/decks/dnd";
import { dndDraggable } from "@/lib/dndTarget";
import { boxed, startPointerDrag } from "@/test-drag";
import { useSidebarDropTarget, type SidebarDrop } from "./useSidebarDrops";

/** A card as every wall's drag carries one — built through `dragData`, so a change to that
 *  module's key cannot leave this passing about a record nothing writes any more. */
const CARD = { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" } as const;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/** A card source whose box starts at `top` — `test-drag.ts`'s `boxed` geometry, 0–200 across. */
function cardSource(top: number): HTMLElement {
  const element = boxed(document.createElement("div"), top);
  element.textContent = "a card";
  document.body.append(element);
  const release = dndDraggable({ element, data: () => dragData(CARD) });
  undo.push(() => {
    release();
    element.remove();
  });
  return element;
}

/** One navigation entry, registered the way the rail's row registers its own. */
function Entry({ drop }: { drop: SidebarDrop }) {
  const ref = useRef<HTMLDivElement>(null);
  const { over } = useSidebarDropTarget({ ref, drop, dragging: true });
  return <div ref={ref} data-testid="entry" data-over={String(over)} />;
}

const drop = (onDrop: SidebarDrop["onDrop"]): SidebarDrop => ({
  eligible: true,
  inertReason: null,
  report: null,
  onDrop,
});

/**
 * The live re-check's new finding 1 — the stray drop's class, on the targets the shelf fix fenced
 * off. With the pointer on the wishlist wall's first tile column, the carried card's left edge
 * overlapped the sidebar's **Wishlist** entry; dnd-kit's default detector falls back to that
 * overlap when the pointer is in no target, so the entry lit gold for the whole hold and the
 * release **added a wish at the wishlist root** (measured in the shipped window: entry 158,
 * `folder_id` null). Any pointer within about 75px of the wall's left edge could do it, on either
 * page. A navigation entry is a place a reader lets a card go on purpose, so it takes one only
 * from over it.
 *
 * Staged as the shelf cases are (`dndTarget.test.ts`'s `pointerOnly` block has the reading): jsdom
 * measures the carried card once, off the source's own box, so a source at 230–270 reaches 10px
 * into this 200–240 entry, and the pointer is then walked off to where nothing is.
 */
describe("useSidebarDropTarget", () => {
  it("is not over, and takes nothing, while the pointer is outside it however near the card is", async () => {
    const onDrop = vi.fn();
    render(<Entry drop={drop(onDrop)} />);
    const entry = boxed(screen.getByTestId("entry"), 200);
    const held = await startPointerDrag(cardSource(230));

    await held.moveTo(100, 330);
    expect(entry).toHaveAttribute("data-over", "false");
    await held.drop();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("is over, and takes the card, once the pointer is inside it", async () => {
    const onDrop = vi.fn();
    render(<Entry drop={drop(onDrop)} />);
    const entry = boxed(screen.getByTestId("entry"), 200);
    const held = await startPointerDrag(cardSource(230));

    await held.moveTo(100, 330);
    await held.over(entry);
    expect(entry).toHaveAttribute("data-over", "true");
    await held.drop();
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ cardId: "c1" }));
  });
});
