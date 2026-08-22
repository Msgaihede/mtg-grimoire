/**
 * Where the reader is standing in the wishlist's filing cabinet, and the way back out of it.
 * Design spec §4 and §9.
 *
 * **Every segment except the last is a drop target, and that is the half of the drag the folder
 * cards cannot do.** A folder card only ever takes a wish *deeper*: drop on `Ordered` and the
 * wish goes into `Ordered`. Without somewhere to drop a wish that moves it *up*, the gesture is
 * one-way — a reader could file a wish three folders down by dragging and would then have to
 * reach for the panel's `Move to folder…` to undo it. The breadcrumb is that somewhere: dropping
 * on `Wishlist` un-files a wish to the root, dropping on an ancestor moves it there, and the two
 * directions are then the same gesture.
 *
 * The last segment is the folder the reader is already in, so it is neither a link nor a target:
 * it carries `aria-current="page"` and takes no drop, because "move this wish to where it already
 * is" is not an operation. At the root the trail is empty and `Wishlist` is itself that last
 * segment — the same rule, not a special case.
 *
 * **Flatten replaces the whole thing.** With no current folder there is no trail to draw and
 * nowhere for a drop to mean anything: the bar says `Wishlist · all folders` in plain inert words
 * and registers no target at all. A breadcrumb that stayed clickable while the list ignored
 * filing would be offering a place to stand that the view is not standing in.
 */
import { useRef } from "react";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import type { WishlistFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useWishDropTarget, type WishDrag } from "./wishDrag";

/** The root's own segment. Not a folder, and deliberately not spelled twice: it is the one
 *  destination whose id is `null`, which is a real place rather than an absent one. */
const ROOT = "Wishlist";

export function WishlistBreadcrumb({
  trail,
  flattened,
  onOpen,
  canDrop,
  onDropWish,
}: {
  /** Root-most first, ending with the folder being shown. Empty at the root. */
  trail: readonly WishlistFolder[];
  flattened: boolean;
  onOpen: (folderId: number | null) => void;
  /** Asked per segment rather than once for the bar — a wish already filed at the root refuses
   *  the root and still accepts an ancestor, so only the page can answer, and only per place. */
  canDrop: (drag: WishDrag, folderId: number | null) => boolean;
  onDropWish: (drag: WishDrag, folderId: number | null) => void;
}) {
  if (flattened) {
    return (
      <nav aria-label="Wishlist folders" className="text-sm text-dim">
        <span>{`${ROOT} · all folders`}</span>
      </nav>
    );
  }

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
 * One step of the trail a reader can go back to, and let go of a wish on.
 *
 * Its own component because {@link useWishDropTarget} is a hook and a trail is a loop — the same
 * reason `FolderCard`'s `MemberArt` is one. It also keeps the target on the **button**: the ring
 * marks the thing that can be pressed, and a mark drawn on the `<li>` around it would sit over
 * the separator too.
 */
function Segment({
  folderId,
  name,
  onOpen,
  canDrop,
  onDropWish,
}: {
  folderId: number | null;
  name: string;
  onOpen: (folderId: number | null) => void;
  canDrop: (drag: WishDrag, folderId: number | null) => boolean;
  onDropWish: (drag: WishDrag, folderId: number | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { armed, over } = useWishDropTarget({
    ref,
    canDrop: (drag) => canDrop(drag, folderId),
    onDrop: (drag) => onDropWish(drag, folderId),
  });

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(folderId)}
      className={cn(
        "min-w-0 truncate rounded-md px-1.5 py-0.5 text-dim",
        "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
        armed && DROP_RING,
        over && cn("text-text", DROP_OVER),
        FOCUS,
      )}
    >
      {name}
    </button>
  );
}
