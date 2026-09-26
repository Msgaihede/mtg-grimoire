/**
 * The collection's shelves, wired — Task 3's `ShelfHeading`, `EmptyShelf` and `ShelfStickyBar`, each
 * handed the drags this cabinet answers (spec §6):
 *
 * | Part | Takes | Does |
 * | --- | --- | --- |
 * | a heading of the reader's own folder | a card; a folder | files the card there; places the folder before / inside / after it by the vertical edge zone |
 * | `Not sorted`'s heading | a card | un-files it to the root |
 * | an app-owned heading (deck group, Recently removed) | nothing | — |
 * | an empty folder's dashed box | a card | files it there |
 * | the sticky bar | a card | files it into the shelf the reader is scrolled inside |
 *
 * **Only the path row's segments take a folder besides a heading** (`CollectionBreadcrumb`); a
 * heading's lead segments and the sticky bar's are buttons and nothing else.
 *
 * What the policy *is* — which copies may go where, which placements are legal — is the page's,
 * handed in as `canDrop` / `onDrop` already asked about this shelf; this file only says which part
 * takes which drag. App-owned shelves are never draggable and never a folder target:
 * `reorder_folders` refuses a deck group or `Recently removed` at either end in words, and a mark
 * over a target the backend always refuses is a promise the next press breaks.
 */
import { useCallback, useRef, type ReactElement } from "react";
import { EmptyShelf } from "@/features/shelves/EmptyShelf";
import { useTakeHeadingCaret, type HeadingCaret } from "@/features/shelves/headingCaret";
import { ShelfHeading, type ShelfHeadingProps } from "@/features/shelves/ShelfHeading";
import { ShelfStickyBar } from "@/features/shelves/ShelfStickyBar";
import {
  useShelfDragSource,
  useShelfDropTarget,
  useShelfStickyDropTarget,
} from "@/features/shelves/useShelfDrag";
import type { FolderDrag, FolderEdge } from "@/lib/folderDrag";
import type { CollectionFolder } from "@/lib/ipc";
import type { Shelf } from "@/lib/shelves";
import { readCollectionDrop, type CollectionDrop } from "./collectionDrag";

/** Where a copy let go on a shelf is filed: its folder, or the root for `Not sorted`. */
export function shelfTarget(shelf: Shelf): number | null {
  return shelf.kind === "unfiled" ? null : shelf.id;
}

/** The page's card policy — `canFile` and `fileCard`, asked with the shelf's own destination. */
export interface CardTarget {
  canDrop: (drop: CollectionDrop, to: number | null) => boolean;
  onDrop: (drop: CollectionDrop, to: number | null) => void;
}

/** The page's folder policy for one heading — `canPlaceFolder` / `placeFolder` bound to it. */
export interface FolderTarget {
  canDrop: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDrop: (drag: FolderDrag, edge: FolderEdge) => void;
}

const REFUSE = (): boolean => false;
const IGNORE = (): void => {};

/**
 * **The caret the page is handing back to this heading** — `CollectionPage`'s `caretBack`. One type
 * for both cabinets, declared once in `features/shelves/headingCaret.ts` and re-exported here for
 * the page and the suite that already import it from this file.
 */
export type { HeadingCaret };

export function CollectionShelfHeading({
  cards,
  folders,
  dragFolder,
  caret,
  ...heading
}: Omit<ShelfHeadingProps, "dropRef" | "dropMark" | "dragRef"> & {
  /** Absent: the heading takes no card (an app-owned shelf, a folder still being named). */
  cards?: CardTarget;
  /** Absent: the heading takes no folder (anything but the reader's own folder). */
  folders?: FolderTarget;
  /** Absent: the heading cannot be picked up. */
  dragFolder?: CollectionFolder;
  /** Absent: nothing is handing this heading the caret. */
  caret?: HeadingCaret;
}): ReactElement {
  const to = shelfTarget(heading.shelf);
  const drop = useShelfDropTarget(
    {
      read: readCollectionDrop,
      canDrop: cards ? (one: CollectionDrop) => cards.canDrop(one, to) : REFUSE,
      onDrop: cards ? (one: CollectionDrop) => cards.onDrop(one, to) : IGNORE,
    },
    folders ? { scope: "collection", canDrop: folders.canDrop, onDrop: folders.onDrop } : undefined,
  );
  // Read at the press through a ref inside the hook, keyed on the id alone — a refetch that hands
  // over a fresh folder object does not tear the source down mid-gesture.
  const drag = useShelfDragSource(
    dragFolder
      ? { id: dragFolder.id, name: dragFolder.name, parentId: dragFolder.parentId }
      : null,
    "collection",
  );

  // The heading's own element — `ShelfHeading` hands its drop ref the row, the element carrying
  // `data-shelf-heading` — kept beside the registration so the caret is looked for inside **this**
  // row and nowhere else. Always passed, so the row is known on a heading that takes nothing too;
  // only a heading that takes a card or a folder registers as a target.
  const row = useRef<HTMLElement | null>(null);
  const takes = cards !== undefined || folders !== undefined;
  const attach = drop.attach;
  const dropRef = useCallback(
    (element: HTMLElement | null) => {
      row.current = element;
      const release = takes ? attach(element) : undefined;
      return () => {
        row.current = null;
        release?.();
      };
    },
    [attach, takes],
  );

  // Take the caret when drawn with a request on it — `headingCaret.ts` has the whole rule.
  useTakeHeadingCaret(caret, row);

  return <ShelfHeading {...heading} dropRef={dropRef} dropMark={drop.mark} dragRef={drag} />;
}

/** An empty folder's dashed box (spec §3.8) — a drop target for a card, filed into that folder. */
export function CollectionEmptyShelf({
  shelf,
  cards,
}: {
  shelf: Shelf;
  cards: CardTarget;
}): ReactElement {
  const to = shelfTarget(shelf);
  const drop = useShelfDropTarget({
    read: readCollectionDrop,
    canDrop: (one: CollectionDrop) => cards.canDrop(one, to),
    onDrop: (one: CollectionDrop) => cards.onDrop(one, to),
  });
  return <EmptyShelf dropRef={drop.attach} dropMark={drop.mark} />;
}

/**
 * The sticky bar (spec §5.3), and a **permanent** card target: it is always mounted on a shelved
 * wall, so a card dragged past a heading that has scrolled away still has somewhere to land in the
 * shelf the reader is reading. The shelf it names changes as the wall scrolls; the hook reads the
 * policy at the drop, never at registration.
 */
export function CollectionShelfSticky({
  shelf,
  onOpen,
  onTop,
  cards,
}: {
  shelf: Shelf | null;
  onOpen: (folderId: number) => void;
  onTop: () => void;
  cards: CardTarget;
}): ReactElement | null {
  const to = shelf === null ? undefined : shelfTarget(shelf);
  // `useShelfStickyDropTarget` rather than the headings' own: the bar is drawn **over** the wall,
  // and a heading scrolled half under it whose centre is nearer the pointer took the drop the bar
  // was showing it would take (the final review's S-M1). The overlay's priority is what wins it.
  const drop = useShelfStickyDropTarget({
    read: readCollectionDrop,
    canDrop: (one: CollectionDrop) => to !== undefined && cards.canDrop(one, to),
    onDrop: (one: CollectionDrop) => {
      if (to !== undefined) cards.onDrop(one, to);
    },
  });
  return (
    <ShelfStickyBar
      shelf={shelf}
      onOpen={onOpen}
      onTop={onTop}
      dropRef={drop.attach}
      dropMark={drop.mark}
    />
  );
}
