/**
 * Where the reader is standing in the collection's filing cabinet, and the way back out of it.
 * Design spec §7.1.
 *
 * **Every segment except the last is a drop target, and that is the half of the drag the folder
 * cards cannot do.** A folder card only ever takes a card *deeper*: drop on `Commander staples`
 * and the copy goes into `Commander staples`. Without somewhere to drop a card that moves it
 * *up*, the gesture is one-way — a reader could file a copy three folders down by dragging and
 * would then have to reach for the menu's `Move to folder…` to undo it. The breadcrumb is that
 * somewhere: dropping on `Collection` un-files a copy to the root, dropping on an ancestor moves
 * it there, and the two directions are then the same gesture.
 *
 * The last segment is the folder the reader is already in, so it is neither a link nor a target:
 * it carries `aria-current="page"` and takes no drop, because "move this copy to where it already
 * is" is not an operation. At the root the trail is empty and `Collection` is itself that last
 * segment — the same rule, not a special case.
 *
 * **No `flattened` prop, which is where this parts company with `WishlistBreadcrumb`.** The
 * wishlist has a Flatten switch because `WishlistQuery` reads an absent `folderId` as *the root
 * wishlist* — the wishes filed nowhere — so it needs a second field to say "every folder". The
 * collection's is the other way round: `CollectionQuery.folderId` absent means **every folder**
 * (`collection.rs`, and spec §8.4), which is the view this page has always opened on. So the
 * root of this trail already *is* the flattened list, there is no third state to draw, and a prop
 * with one possible value would be a switch nothing can throw.
 *
 * That difference has one consequence worth stating where it is read: dropping on `Collection`
 * still means **un-file to the root**, which is a narrower thing than the level the segment
 * navigates to. The two readings are the same word doing what it does everywhere else in this app
 * — `null` is the root, a real destination, and the root of a cabinet is also the whole of it.
 */
import { useRef } from "react";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { FOCUS } from "@/lib/focus";
import type { CollectionFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useCollectionDropTarget, type CollectionDrag } from "./collectionDrag";

/** The top of the cabinet. Not a folder, and deliberately not spelled twice: it is the one
 *  destination whose id is `null`, which is a real place rather than an absent one. */
const ROOT = "Collection";

export function CollectionBreadcrumb({
  trail,
  onOpen,
  canDrop,
  onDropCard,
}: {
  /** Root-most first, ending with the folder being shown. Empty at the root. */
  trail: readonly CollectionFolder[];
  onOpen: (folderId: number | null) => void;
  /** Asked per segment rather than once for the bar — a copy already filed at the root refuses
   *  the root and still accepts an ancestor, so only the page can answer, and only per place. */
  canDrop: (drag: CollectionDrag, folderId: number | null) => boolean;
  onDropCard: (drag: CollectionDrag, folderId: number | null) => void;
}) {
  const segments: { folderId: number | null; name: string }[] = [
    { folderId: null, name: ROOT },
    ...trail.map((folder) => ({ folderId: folder.id, name: folder.name })),
  ];

  return (
    <nav aria-label="Collection folders">
      <ol className="flex flex-wrap items-center gap-1 text-sm">
        {segments.map((segment, i) => {
          const last = i === segments.length - 1;
          return (
            <li key={segment.folderId ?? "root"} className="flex min-w-0 items-center gap-1">
              {/* Decoration: the list structure is what says these are steps, and a screen reader
                  announcing "greater than" between every pair is noise. */}
              {i > 0 && (
                <span aria-hidden="true" className="flex-none text-dim">
                  ›
                </span>
              )}
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
                  onDropCard={onDropCard}
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
 * One step of the trail a reader can go back to, and let go of a copy on.
 *
 * Its own component because {@link useCollectionDropTarget} is a hook and a trail is a loop — the
 * same reason `FolderCard`'s `MemberArt` is one. It also keeps the target on the **button**: the
 * ring marks the thing that can be pressed, and a mark drawn on the `<li>` around it would sit
 * over the separator too.
 */
function Segment({
  folderId,
  name,
  onOpen,
  canDrop,
  onDropCard,
}: {
  folderId: number | null;
  name: string;
  onOpen: (folderId: number | null) => void;
  canDrop: (drag: CollectionDrag, folderId: number | null) => boolean;
  onDropCard: (drag: CollectionDrag, folderId: number | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const { armed, over } = useCollectionDropTarget({
    ref,
    canDrop: (drag) => canDrop(drag, folderId),
    onDrop: (drag) => onDropCard(drag, folderId),
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
