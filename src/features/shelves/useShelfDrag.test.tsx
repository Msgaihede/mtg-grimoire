import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dndDraggable } from "@/lib/dndTarget";
import { folderDraggable, readFolderDrag, type FolderDrag } from "@/lib/folderDrag";
import { boxed, recordDrags, startPointerDrag } from "@/test-drag";
import {
  shelfDropMark,
  useShelfDragSource,
  useShelfDropTarget,
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

function source(register: (element: HTMLElement) => () => void): HTMLElement {
  const element = boxed(document.createElement("div"), 0);
  element.textContent = "a source";
  document.body.append(element);
  const release = register(element);
  undo.push(() => {
    release();
    element.remove();
  });
  return element;
}
const cardSource = (id: number) =>
  source((element) => dndDraggable({ element, data: () => ({ [KEY]: MARK, id }) }));
const folderSource = (drag: FolderDrag) =>
  source((element) => folderDraggable({ element, folder: () => drag }));

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
});
