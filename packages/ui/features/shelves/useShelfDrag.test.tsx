import { render, screen } from "@testing-library/react";
import { Feedback } from "@dnd-kit/dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dndManager } from "@/lib/dndManager";
import { dndDraggable } from "@/lib/dndTarget";
import { folderDraggable, readFolderDrag, type FolderDrag } from "@/lib/folderDrag";
import { boxed, recordDrags, startPointerDrag } from "@/test-drag";
import {
  shelfDropMark,
  useShelfDragSource,
  useShelfDropTarget,
  useShelfStickyDropTarget,
  type ShelfDragFolder,
  type ShelfFolderDrop,
} from "./useShelfDrag";

/** A card payload of this file's own, under a key nothing else writes. */
const KEY = "shelfDropTestSource";
const MARK = "mtg-grimoire/shelf-drop-test";
interface Thing {
  id: number;
}
const read = (record: Record<string, unknown>): Thing | null =>
  record[KEY] === MARK && typeof record.id === "number" ? { id: record.id } : null;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function source(register: (element: HTMLElement) => () => void, top = 0): HTMLElement {
  const element = boxed(document.createElement("div"), top);
  element.textContent = "a source";
  document.body.append(element);
  const release = register(element);
  undo.push(() => {
    release();
    element.remove();
  });
  return element;
}
const cardSource = (id: number, top = 0) =>
  source((element) => dndDraggable({ element, data: () => ({ [KEY]: MARK, id }) }), top);
const folderSource = (drag: FolderDrag, top = 0) =>
  source((element) => folderDraggable({ element, folder: () => drag }), top);

const FOILS: FolderDrag = { folderId: 12, name: "Foils", parentId: null, scope: "collection" };

function Target({
  canDrop = () => true,
  onDrop = () => {},
  folder,
}: {
  canDrop?: (thing: Thing) => boolean;
  onDrop?: (thing: Thing) => void;
  folder?: ShelfFolderDrop;
}) {
  const { attach, mark } = useShelfDropTarget({ read, canDrop, onDrop }, folder);
  return <div ref={attach} data-testid="target" data-mark={mark} />;
}

/** A heading's drag source, as a page wires it. `null` is Not sorted or an app-owned shelf. */
function Source({ folder }: { folder: ShelfDragFolder | null }) {
  const attach = useShelfDragSource(folder, "wishlist");
  return (
    <div ref={attach} data-testid="source">
      {folder?.name ?? "Not sorted"}
    </div>
  );
}

/** The target, given somewhere to be — jsdom lays nothing out and dnd-kit hit-tests by coordinate. */
const placed = () => boxed(screen.getByTestId("target"), 200);

describe("shelfDropMark", () => {
  it("draws the folder's landing first, then a card over it, then eligibility", () => {
    const still = { armed: false, over: false };
    const shut = { armed: false, edge: null };
    expect(shelfDropMark(still, shut)).toBe("none");
    expect(shelfDropMark({ armed: true, over: false }, shut)).toBe("armed");
    expect(shelfDropMark({ armed: true, over: true }, shut)).toBe("over");
    expect(shelfDropMark(still, { armed: true, edge: null })).toBe("armed");
    for (const edge of ["before", "inside", "after"] as const) {
      expect(shelfDropMark(still, { armed: true, edge })).toBe(edge);
    }
  });
});

describe("useShelfDropTarget", () => {
  it("arms a heading that is on screen when the drag starts", async () => {
    render(<Target />);
    placed();
    const held = await startPointerDrag(cardSource(7));

    expect(screen.getByTestId("target")).toHaveAttribute("data-mark", "armed");
    await held.cancel();
    expect(screen.getByTestId("target")).toHaveAttribute("data-mark", "none");
  });

  /** Spec §6 — the whole reason this hook exists rather than each page calling the two it wraps. */
  it("arms a heading that mounts in the middle of a card drag, marks it under the pointer, and files the card", async () => {
    const onDrop = vi.fn();
    const held = await startPointerDrag(cardSource(7));
    render(<Target onDrop={onDrop} />);
    const target = placed();

    expect(target).toHaveAttribute("data-mark", "armed");
    await held.over(target);
    expect(target).toHaveAttribute("data-mark", "over");
    await held.drop();
    expect(onDrop).toHaveBeenCalledWith({ id: 7 });
  });

  it("stays dark for a card its page refuses", async () => {
    const held = await startPointerDrag(cardSource(7));
    render(<Target canDrop={() => false} />);
    const target = placed();

    expect(target).toHaveAttribute("data-mark", "none");
    await held.over(target);
    expect(target).toHaveAttribute("data-mark", "none");
    await held.cancel();
  });

  /** A heading lays folders out top to bottom, so the landings are the vertical axis's quarters. */
  it("reports a folder's landing along the vertical axis and hands the page where it landed", async () => {
    const onFolderDrop = vi.fn();
    const held = await startPointerDrag(folderSource(FOILS));
    render(<Target folder={{ scope: "collection", canDrop: () => true, onDrop: onFolderDrop }} />);
    const target = placed();

    expect(target).toHaveAttribute("data-mark", "armed");
    await held.over(target, { y: 0.1 });
    expect(target).toHaveAttribute("data-mark", "before");
    await held.over(target, { y: 0.9 });
    expect(target).toHaveAttribute("data-mark", "after");
    await held.over(target, { y: 0.5 });
    expect(target).toHaveAttribute("data-mark", "inside");
    await held.drop();
    expect(onFolderDrop).toHaveBeenCalledWith(FOILS, "inside");
  });

  it("takes no folder when the page gave it no folder half", async () => {
    const held = await startPointerDrag(folderSource(FOILS));
    render(<Target />);
    const target = placed();

    expect(target).toHaveAttribute("data-mark", "none");
    await held.over(target);
    expect(target).toHaveAttribute("data-mark", "none");
    await held.cancel();
  });

  /**
   * The live pass's "Extra, found during 3": a card released on one shelf's tiles, or on empty wall,
   * was filed into the **nearest** heading — the carried card's rectangle overlapped it, and
   * dnd-kit's default detector falls back to that overlap when the pointer is in no target. Spec §6
   * names the targets; tiles and blank wall are not among them, so a release there does nothing.
   *
   * jsdom measures the carried card once, off the source's own box, so the overlap is staged
   * there: a card at 230–270 reaches 10px into this 200–240 heading, and the pointer is then walked
   * off to where nothing is (`dndTarget.test.ts`'s `pointerOnly` block has the reading, and the
   * fence that a plain target *would* take this drop).
   */
  it("is not over, and files nothing, while the pointer is outside it however near the card is", async () => {
    const onDrop = vi.fn();
    render(<Target onDrop={onDrop} />);
    const target = placed();
    const held = await startPointerDrag(cardSource(7, 230));

    await held.moveTo(100, 330);
    expect(target).toHaveAttribute("data-mark", "armed");
    await held.drop();
    expect(onDrop).not.toHaveBeenCalled();
  });

  /**
   * The same stray drop for a **folder** heading. The collection's and the wishlist's table views do
   * not fold away during a folder drag, so a heading carried over card rows overlapped the next
   * heading down, and `folderEdge` turned a pointer below it into `"after"` — a reorder beside a
   * heading the reader was not aiming at. Staged as the card case above is.
   */
  it("lands no folder, and files nothing, while the pointer is outside it however near the folder is", async () => {
    const onFolderDrop = vi.fn();
    render(<Target folder={{ scope: "collection", canDrop: () => true, onDrop: onFolderDrop }} />);
    const target = placed();
    const held = await startPointerDrag(folderSource(FOILS, 230));

    await held.moveTo(100, 330);
    expect(target).toHaveAttribute("data-mark", "armed");
    await held.drop();
    expect(onFolderDrop).not.toHaveBeenCalled();
  });
});

/**
 * **The sticky bar wins the pointer where it is drawn** — review finding S-M1. The bar is an overlay
 * at the top of the wall, and headings and table bands scroll *underneath* it, so for the length of
 * that overlap the pointer is inside two targets at once. dnd-kit does not consult paint order: two
 * pointer collisions are ranked by distance to each box's centre, and a 36px bar over a 40px heading
 * whose centre is nearer loses — the card files into the heading the reader cannot see, under the
 * bar they are looking at. `useShelfStickyDropTarget` is the bar's own hook and asks for `overlay`,
 * which is pointer-inside **and** `CollisionPriority.Highest`.
 *
 * The geometry: the bar at 200–236 (centre 218), the heading scrolled half under it at 210–250
 * (centre 230), the pointer at 228 — inside both, 10px from the bar's centre and 2px from the
 * heading's.
 */
describe("useShelfStickyDropTarget", () => {
  function Sticky({ onDrop }: { onDrop: (thing: Thing) => void }) {
    const { attach, mark } = useShelfStickyDropTarget({ read, canDrop: () => true, onDrop });
    return <div ref={attach} data-testid="sticky" data-mark={mark} />;
  }

  function Heading({ onDrop }: { onDrop: (thing: Thing) => void }) {
    const { attach, mark } = useShelfDropTarget({ read, canDrop: () => true, onDrop });
    return <div ref={attach} data-testid="heading" data-mark={mark} />;
  }

  it("takes a card over a heading scrolled underneath it, where the heading is nearer the pointer", async () => {
    const onSticky = vi.fn();
    const onHeading = vi.fn();
    render(
      <>
        <Sticky onDrop={onSticky} />
        <Heading onDrop={onHeading} />
      </>,
    );
    const sticky = boxed(screen.getByTestId("sticky"), 200, 36);
    const heading = boxed(screen.getByTestId("heading"), 210);
    const held = await startPointerDrag(cardSource(7));

    await held.moveTo(100, 228);
    expect(sticky).toHaveAttribute("data-mark", "over");
    expect(heading).toHaveAttribute("data-mark", "armed");
    await held.drop();
    expect(onSticky).toHaveBeenCalledWith({ id: 7 });
    expect(onHeading).not.toHaveBeenCalled();
  });

  /** Still pointer-inside: an overlay's detector is `pointerIntersection`, so a card whose
   *  rectangle only brushes the bar lands nowhere — the shelf targets' rule, kept. */
  it("takes nothing while the pointer is outside it however near the card is", async () => {
    const onSticky = vi.fn();
    render(<Sticky onDrop={onSticky} />);
    const sticky = boxed(screen.getByTestId("sticky"), 200);
    const held = await startPointerDrag(cardSource(7, 230));

    await held.moveTo(100, 330);
    expect(sticky).toHaveAttribute("data-mark", "armed");
    await held.drop();
    expect(onSticky).not.toHaveBeenCalled();
  });
});

describe("useShelfDragSource", () => {
  /** Read at the press, not at mount — a folder renamed or re-filed since it mounted carries what
   *  it is now, which is what lets its current parent refuse a nest that moves nothing. */
  it("carries the folder as it is at the press", async () => {
    const view = render(<Source folder={{ id: 4, name: "Signed", parentId: 2 }} />);
    view.rerender(<Source folder={{ id: 4, name: "Signed foils", parentId: 9 }} />);
    const drags = recordDrags();

    const held = await startPointerDrag(boxed(screen.getByTestId("source"), 0));
    expect(held.started).toBe(true);
    await held.cancel();
    drags.stop();

    expect(drags.records.map((data) => readFolderDrag(data, "wishlist"))).toEqual([
      { folderId: 4, name: "Signed foils", parentId: 9, scope: "wishlist" },
    ]);
  });

  it("registers nothing for a shelf that is not a folder", async () => {
    render(<Source folder={null} />);
    const held = await startPointerDrag(boxed(screen.getByTestId("source"), 0));

    expect(held.started).toBe(false);
    await held.cancel();
  });

  /**
   * The live re-check's new finding 3. On a drop that moves a heading far, dnd-kit animated the
   * floating heading toward the slot it measured **before** the reorder landed — 355 → 458 → 620 →
   * 1482 … 7276 in one run, up to −308 in another — so a ghost heading slid off the screen for 2–4
   * frames while the real one already sat under the pointer. A heading asks for no drop
   * animation: `Feedback`'s per-source `dropAnimation: null` is the library's own off switch.
   *
   * Pinned as the registration's configuration because the animation cannot run here: it is the
   * `Feedback` plugin's WAAPI machinery, which jsdom does not have, so a behaviour test would pass
   * whether the flag was set or not. What reaches the library is the source's own plugin config.
   */
  it("asks for no drop animation, so a moved heading does not fly toward its old slot", () => {
    render(<Source folder={{ id: 4, name: "Signed", parentId: null }} />);
    const element = screen.getByTestId("source");
    const draggable = [...dndManager.registry.draggables].find((d) => d.element === element);

    expect(draggable).toBeDefined();
    expect(draggable!.pluginConfig(Feedback)).toEqual({ dropAnimation: null });
  });
});
