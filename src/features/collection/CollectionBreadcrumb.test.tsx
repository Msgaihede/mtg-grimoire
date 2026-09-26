import { useEffect, useRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { folderDraggable, type FolderDrag } from "@/lib/folderDrag";
import type { CollectionFolder } from "@/lib/ipc";
import { boxed, startPointerDrag } from "@/test-drag";
import { CollectionBreadcrumb } from "./CollectionBreadcrumb";
import {
  collectionDraggable,
  collectionTileDraggable,
  type CollectionDrag,
  type CollectionDrop,
  type CollectionTileDrag,
} from "./collectionDrag";

/**
 * Where the reader is standing, and the way back out — every segment but the last takes a copy
 * **and a folder** dropped on it. Moved here from `CollectionFolderCard.test.tsx` when the folder
 * cards were deleted for shelves (spec §7); the Flatten case went with Flatten.
 *
 * Every source and every segment is given a box of its own, because dnd-kit hit-tests by
 * coordinate and jsdom measures every rectangle as four zeroes (`src/test-drag.ts`).
 */

const ENTRY: CollectionDrag = { entryId: 7, name: "Lightning Bolt", folderId: null };
const TILE: CollectionTileDrag = {
  cardId: "c1",
  name: "Lightning Bolt",
  copies: [
    { entryId: 7, folderId: null },
    { entryId: 8, folderId: 3 },
  ],
};
const ENTRY_DROP: CollectionDrop = { kind: "entry", entry: ENTRY };
const TILE_DROP: CollectionDrop = { kind: "tile", tile: TILE };
/** A folder two levels down, in the air — what a shelf heading hands a segment. */
const SLEEVED: FolderDrag = { folderId: 12, name: "Sleeved", parentId: 9, scope: "collection" };

const folder = (over: Partial<CollectionFolder> & { id: number; name: string }): CollectionFolder => ({
  parentId: null,
  kind: "user",
  deckId: null,
  sortOrder: over.id,
  locked: false,
  syncUid: `uid-${over.id}`,
  ...over,
});
const BINDER = folder({ id: 3, name: "Trade binder" });
const FOILS = folder({ id: 9, name: "Foils", parentId: 3 });

const SOURCE_BOX = new DOMRect(0, 0, 240, 120);

/** `classList.contains` per class — a substring over the attribute would read `hover:` variants. */
const marked = (element: Element, mark: string) =>
  mark.split(" ").every((one) => element.classList.contains(one));

function Source() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.getBoundingClientRect = () => SOURCE_BOX;
    return collectionDraggable({
      element,
      entry: () => ENTRY,
      card: () => ({ kind: "card", cardId: "c1", name: ENTRY.name, typeLine: "Instant" }),
    });
  }, []);
  return <div ref={ref}>the copy</div>;
}

function TileSource() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.getBoundingClientRect = () => SOURCE_BOX;
    return collectionTileDraggable({
      element,
      tile: () => TILE,
      card: () => ({ kind: "card", cardId: TILE.cardId, name: TILE.name, typeLine: "Instant" }),
    });
  }, []);
  return <div ref={ref}>the tile</div>;
}

function FolderSource() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.getBoundingClientRect = () => SOURCE_BOX;
    return folderDraggable({ element, folder: () => SLEEVED });
  }, []);
  return <div ref={ref}>the folder</div>;
}

const onOpen = vi.fn();
const onDropCard = vi.fn();
const onDropFolder = vi.fn();

beforeEach(() => {
  onOpen.mockReset();
  onDropCard.mockReset();
  onDropFolder.mockReset();
});

describe("CollectionBreadcrumb", () => {
  function mount({
    trail = [BINDER, FOILS] as readonly CollectionFolder[],
    canDrop = () => true,
    canDropFolder = () => true,
    folders = true,
    withSource = false,
    withTile = false,
    withFolder = false,
  }: {
    trail?: readonly CollectionFolder[];
    canDrop?: (drop: CollectionDrop, folderId: number | null) => boolean;
    canDropFolder?: (drag: FolderDrag, folderId: number | null) => boolean;
    /** Whether the page passes a folder policy at all. */
    folders?: boolean;
    withSource?: boolean;
    withTile?: boolean;
    withFolder?: boolean;
  } = {}) {
    render(
      <>
        {withSource && <Source />}
        {withTile && <TileSource />}
        {withFolder && <FolderSource />}
        <CollectionBreadcrumb
          trail={trail}
          onOpen={onOpen}
          canDrop={canDrop}
          onDropCard={onDropCard}
          canDropFolder={folders ? canDropFolder : undefined}
          onDropFolder={folders ? onDropFolder : undefined}
        />
      </>,
    );
  }

  /** Every segment boxed, 60px apart and clear of the source — the current one too, because it is
   *  the one that must refuse, and a refusal only counts where the pointer really arrived. */
  const stand = () => {
    const bar = screen.getByRole("navigation", { name: "Collection folders" });
    [...bar.querySelectorAll<HTMLElement>("button, [aria-current]")].forEach((element, index) =>
      boxed(element, 200 + index * 60),
    );
  };

  it("draws the trail root-most first, with the folder you are in current and inert", () => {
    mount();
    expect(screen.getByRole("button", { name: "Collection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Trade binder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Foils" })).not.toBeInTheDocument();
    expect(screen.getByText("Foils")).toHaveAttribute("aria-current", "page");
  });

  it("makes the root itself current when the reader is already there", () => {
    mount({ trail: [] });
    expect(screen.queryByRole("button", { name: "Collection" })).not.toBeInTheDocument();
    expect(screen.getByText("Collection")).toHaveAttribute("aria-current", "page");
  });

  it("climbs to the root and to an ancestor", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Collection" }));
    expect(onOpen).toHaveBeenCalledWith(null);
    await user.click(screen.getByRole("button", { name: "Trade binder" }));
    expect(onOpen).toHaveBeenCalledWith(3);
  });

  it("takes a copy dropped on the root and un-files it", async () => {
    mount({ withSource: true });
    stand();
    const root = screen.getByRole("button", { name: "Collection" });
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(root, DROP_RING)).toBe(true);

    await held.over(root);
    expect(marked(root, DROP_OVER)).toBe(true);
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP, null);
  });

  it("takes a copy dropped on an ancestor and moves it up", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    await held.over(screen.getByRole("button", { name: "Trade binder" }));
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(ENTRY_DROP, 3);
  });

  it("takes a whole tile dropped on the root and un-files every copy", async () => {
    mount({ withTile: true });
    stand();
    const root = screen.getByRole("button", { name: "Collection" });
    const held = await startPointerDrag(screen.getByText("the tile"));
    expect(marked(root, DROP_RING)).toBe(true);

    await held.over(root);
    await held.drop();
    expect(onDropCard).toHaveBeenCalledWith(TILE_DROP, null);
  });

  it("asks the page about each segment separately for a tile too", async () => {
    mount({ withTile: true, canDrop: (drop, folderId) => drop.kind === "tile" && folderId === 3 });
    stand();
    const held = await startPointerDrag(screen.getByText("the tile"));
    expect(marked(screen.getByRole("button", { name: "Trade binder" }), DROP_RING)).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Collection" }), DROP_RING)).toBe(false);
    await held.cancel();
  });

  it("offers no drop on the folder the reader is already standing in", async () => {
    mount({ withSource: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(screen.getByText("Foils"), DROP_RING)).toBe(false);

    await held.over(screen.getByText("Foils"));
    await held.drop();
    expect(onDropCard).not.toHaveBeenCalled();
  });

  it("asks the page about each segment separately", async () => {
    mount({ withSource: true, canDrop: (_drag, folderId) => folderId === null });
    stand();
    const held = await startPointerDrag(screen.getByText("the copy"));
    expect(marked(screen.getByRole("button", { name: "Collection" }), DROP_RING)).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Trade binder" }), DROP_RING)).toBe(false);
    await held.cancel();
  });

  /**
   * **A folder dropped on a segment moves into that level, last** — the half of the gesture the
   * deleted up tile carried (issue #283). A shelf heading only ever takes a folder *into* or
   * *beside* itself, so without this a folder dragged deeper had no route back up but the menu.
   * The segment is one landing wide, which is why it takes no edge.
   */
  it("hands the page a folder dropped on a segment, and the level it names", async () => {
    mount({ withFolder: true });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    const up = screen.getByRole("button", { name: "Trade binder" });
    expect(marked(up, DROP_RING)).toBe(true);

    await held.over(up);
    expect(marked(up, DROP_OVER)).toBe(true);
    await held.drop();
    expect(onDropFolder).toHaveBeenCalledWith(SLEEVED, 3);
    expect(onDropCard).not.toHaveBeenCalled();
  });

  it("asks the page about each segment for a folder too", async () => {
    mount({ withFolder: true, canDropFolder: (_drag, folderId) => folderId === null });
    stand();
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(screen.getByRole("button", { name: "Collection" }), DROP_RING)).toBe(true);
    expect(marked(screen.getByRole("button", { name: "Trade binder" }), DROP_RING)).toBe(false);
    await held.cancel();
  });

  /** A page that passes no folder policy gets segments that take copies and nothing else. */
  it("takes no folder where the page passed no folder policy", async () => {
    mount({ withFolder: true, folders: false });
    stand();
    const root = screen.getByRole("button", { name: "Collection" });
    const held = await startPointerDrag(screen.getByText("the folder"));
    expect(marked(root, DROP_RING)).toBe(false);
    await held.over(root);
    await held.drop();
    expect(onDropFolder).not.toHaveBeenCalled();
  });
});
