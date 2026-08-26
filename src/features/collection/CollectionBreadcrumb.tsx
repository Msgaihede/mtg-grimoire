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
 * **`flattened` survives its own Flatten, and this bar is the one piece of the cabinet that
 * does.** The note that stood here said there was no such prop, on the reasoning that the
 * collection had no flattened state to draw: `CollectionQuery.folderId` absent meant *every
 * folder*, so the root of this trail already was the whole binder. **Both halves of that are
 * false as of the Flatten switch** — the root is `rootOnly` now, the copies filed nowhere, which
 * is the wishlist's own reading, and the switch exists.
 *
 * It was briefly drawn the other way, with `CollectionPage` taking this component off screen
 * along with the wall and the pinned strip, on the argument that a bar reading
 * `Collection · all folders` over a page with no folder cards is the last piece of a cabinet that
 * is otherwise gone. **That argument does not survive being checked against the page it claims to
 * distinguish**: the wishlist hides its wall on exactly the same flag and keeps its line anyway,
 * so the sentence separates nothing. What is actually true is the reverse — with the wall, the
 * deck groups and `Recently removed` all put away, this line is the *only* thing on screen saying
 * why, and a reader who pressed a chip up on the filter bar and watched three bands vanish is
 * owed it. So the two pages behave identically under one control, which is the whole of what
 * "the collection works like the wishlist" was asked to mean.
 *
 * Inert words rather than a trail: with every folder on screen at once there is no level to be
 * on, so a segment would be a door into a place the reader is already standing. The `nav` and its
 * accessible name are kept across both states, so a test or a screen reader looking for
 * `Collection folders` finds the same landmark either way.
 *
 * One consequence of the new root reading is worth stating where it is read, because it removed a
 * wrinkle rather than adding one: dropping on `Collection` means **un-file to the root**, and the
 * segment now *navigates* to exactly those copies. The two used to be different sizes — a drop
 * narrowed to the unfiled rows while the press widened to every folder — and they are the same
 * place again.
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
  flattened,
  onOpen,
  canDrop,
  onDropCard,
}: {
  /** Root-most first, ending with the folder being shown. Empty at the root. */
  trail: readonly CollectionFolder[];
  /** Whether the filing is being ignored. On, the trail is replaced by the inert words for what
   *  is on screen — see the note above about why this bar survives its own Flatten. */
  flattened: boolean;
  onOpen: (folderId: number | null) => void;
  /** Asked per segment rather than once for the bar — a copy already filed at the root refuses
   *  the root and still accepts an ancestor, so only the page can answer, and only per place. */
  canDrop: (drag: CollectionDrag, folderId: number | null) => boolean;
  onDropCard: (drag: CollectionDrag, folderId: number | null) => void;
}) {
  // Not a trail, because there is no level to be on: every folder is on screen at once, so each
  // segment would be a door to a place the reader is already standing. Drawn as words rather than
  // dropped entirely — this is the one line that says *why* the wall and the pinned strip are
  // gone, and `WishlistBreadcrumb` says it in the same shape one table over.
  if (flattened) {
    return (
      <nav aria-label="Collection folders" className="text-sm text-dim">
        <span>{`${ROOT} · all folders`}</span>
      </nav>
    );
  }

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
