/**
 * Where the reader is standing in the wishlist's filing cabinet, and the way back out of it.
 * Design spec §4 and §9, and the shelves' §3.5 and §6.
 *
 * **Every segment except the last is a drop target — for a wish, and since the shelves for a
 * folder too.** A heading takes a card *into* a folder on the wall; without somewhere to drop one
 * that moves it *up*, the gesture would be one-way. Dropping a wish on `Wishlist` un-files it, and
 * on an ancestor moves it there. Dropping a **folder** on a segment files it last inside that
 * level, which is what `ParentFolderCard`'s "Up one level" tile did before the tile went with the
 * folder band (spec §7): `inside` already means "which drawer, and nothing about where in it", so
 * the segment says "last" without having to draw it.
 *
 * **It is the page bar's trail since 2026-10-21** (`PageBar`'s `trailNode`, the owner's note): the
 * folder the reader is in is the bar's title, so this draws only the levels above it, in the bar's
 * crumb style, and nothing at the root. That folder was never a target — "move this where it
 * already is" is not an operation — so no drop was lost with it.
 */
import { Fragment, useRef } from "react";
import { CrumbChevron, PAGE_CRUMB } from "@/components/PageBar";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import { useFolderDropTarget, type FolderDrag } from "@/lib/folderDrag";
import type { WishlistFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useWishDropTarget, type WishDrop } from "./wishDrag";

/** The root's own segment. Not a folder, and deliberately not spelled twice: it is the one
 *  destination whose id is `null`, which is a real place rather than an absent one. */
const ROOT = "Wishlist";

export function WishlistBreadcrumb({
  trail,
  onOpen,
  canDrop,
  onDropWish,
  canDropFolder,
  onDropFolder,
}: {
  /** Root-most first, ending with the folder being shown. Empty at the root. */
  trail: readonly WishlistFolder[];
  onOpen: (folderId: number | null) => void;
  /** Asked per segment rather than once for the bar — a wish already filed at the root refuses
   *  the root and still accepts an ancestor, so only the page can answer, and only per place. */
  canDrop: (drop: WishDrop, folderId: number | null) => boolean;
  onDropWish: (drop: WishDrop, folderId: number | null) => void;
  /** A folder let go on a segment — filed last inside that level. Absent takes no folder. */
  canDropFolder?: (drag: FolderDrag, folderId: number | null) => boolean;
  onDropFolder?: (drag: FolderDrag, folderId: number | null) => void;
}) {
  // The folders **above** the one on screen, root first: the folder the reader is in is the page
  // bar's title, so it is not a crumb (and was the one segment that took no drop anyway). At the
  // root there is nothing above, and no trail is drawn.
  if (trail.length === 0) return null;
  const segments: { folderId: number | null; name: string }[] = [
    { folderId: null, name: ROOT },
    ...trail.slice(0, -1).map((folder) => ({ folderId: folder.id, name: folder.name })),
  ];

  return (
    // Drawn as the page bar's trail (`PageBar`'s `trailNode`): `PAGE_CRUMB` words and a chevron
    // after each, so it reads as every other page's trail — and every crumb still takes a drop.
    <nav aria-label="Wishlist folders" className="flex min-w-0 items-baseline gap-2">
      {segments.map((segment) => (
        <Fragment key={segment.folderId ?? "root"}>
          <Segment
            folderId={segment.folderId}
            name={segment.name}
            onOpen={onOpen}
            canDrop={canDrop}
            onDropWish={onDropWish}
            canDropFolder={canDropFolder}
            onDropFolder={onDropFolder}
          />
          <CrumbChevron />
        </Fragment>
      ))}
    </nav>
  );
}

/**
 * One step of the trail a reader can go back to, and let go of a wish or a folder on.
 *
 * Its own component because the targets are hooks and a trail is a loop. Both register on the
 * **button** — the ring marks the thing that can be pressed — and the folder half ignores the edge:
 * a segment is one word with no order to point into, so every part of it means "last, in here".
 *
 * **Both take a drop only while the pointer is inside the segment** (`pointerOnly`) — the stray
 * drop the shelf headings were fenced against, one row up. A segment is a one-line word over the
 * wall, and dnd-kit's default detector falls back to the carried card's *rectangle* when the pointer
 * is in no target: a card released over the first row of tiles inside an opened folder overlapped
 * the path row above it and was filed into a segment the reader never pointed at.
 */
function Segment({
  folderId,
  name,
  onOpen,
  canDrop,
  onDropWish,
  canDropFolder,
  onDropFolder,
}: {
  folderId: number | null;
  name: string;
  onOpen: (folderId: number | null) => void;
  canDrop: (drop: WishDrop, folderId: number | null) => boolean;
  onDropWish: (drop: WishDrop, folderId: number | null) => void;
  canDropFolder?: (drag: FolderDrag, folderId: number | null) => boolean;
  onDropFolder?: (drag: FolderDrag, folderId: number | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { armed, over } = useWishDropTarget({
    ref,
    canDrop: (drop) => canDrop(drop, folderId),
    onDrop: (drop) => onDropWish(drop, folderId),
    pointerOnly: true,
  });
  const folder = useFolderDropTarget({
    ref,
    scope: "wishlist",
    axis: "horizontal",
    canDrop: (drag) => canDropFolder?.(drag, folderId) ?? false,
    onDrop: (drag) => onDropFolder?.(drag, folderId),
    pointerOnly: true,
  });

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(folderId)}
      className={cn(
        // The page bar's crumb, with the room a drop ring needs taken back by the margin, so the
        // word stands where a plain crumb would.
        PAGE_CRUMB,
        "-mx-1 min-w-0 truncate rounded-md px-1",
        (armed || folder.armed) && DROP_RING,
        (over || folder.edge !== null) && cn("text-text", DROP_OVER),
        FOCUS,
      )}
    >
      {name}
    </button>
  );
}
