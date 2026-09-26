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
 * The last segment is the folder the reader is already in, so it is neither a link nor a target:
 * it carries `aria-current="page"` and takes no drop, because "move this where it already is" is
 * not an operation. At the root the trail is empty and `Wishlist` is itself that last segment.
 */
import { useRef } from "react";
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
  const segments: { folderId: number | null; name: string }[] = [
    { folderId: null, name: ROOT },
    ...trail.map((folder) => ({ folderId: folder.id, name: folder.name })),
  ];

  return (
    <nav aria-label="Wishlist folders">
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {segments.map((segment, i) => {
          const last = i === segments.length - 1;
          return (
            <li key={segment.folderId ?? "root"} className="flex min-w-0 items-center gap-1">
              {/* Decoration: the list structure is what says these are steps, and a screen
                  reader announcing "greater than" between every pair is noise. */}
              {i > 0 && <span aria-hidden="true" className="flex-none text-dim">›</span>}
              {last ? (
                <span aria-current="page" className="truncate text-text">
                  {segment.name}
                </span>
              ) : (
                <Segment
                  folderId={segment.folderId}
                  name={segment.name}
                  onOpen={onOpen}
                  canDrop={canDrop}
                  onDropWish={onDropWish}
                  canDropFolder={canDropFolder}
                  onDropFolder={onDropFolder}
                />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/**
 * One step of the trail a reader can go back to, and let go of a wish or a folder on.
 *
 * Its own component because the targets are hooks and a trail is a loop. Both register on the
 * **button** — the ring marks the thing that can be pressed — and the folder half ignores the edge:
 * a segment is one word with no order to point into, so every part of it means "last, in here".
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
  });
  const folder = useFolderDropTarget({
    ref,
    scope: "wishlist",
    axis: "horizontal",
    canDrop: (drag) => canDropFolder?.(drag, folderId) ?? false,
    onDrop: (drag) => onDropFolder?.(drag, folderId),
  });

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(folderId)}
      className={cn(
        "min-w-0 truncate rounded-md px-1.5 py-0.5 text-dim",
        "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
        (armed || folder.armed) && DROP_RING,
        (over || folder.edge !== null) && cn("text-text", DROP_OVER),
        FOCUS,
      )}
    >
      {name}
    </button>
  );
}
