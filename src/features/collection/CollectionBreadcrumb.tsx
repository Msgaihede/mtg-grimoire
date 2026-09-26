/**
 * Where the reader is standing in the collection's filing cabinet, and the way back out of it.
 * Design spec §7.1; the folder-shelves spec §3.5 and §6.
 *
 * **Every segment except the last is a drop target — for a copy and, since shelves, for a
 * folder.** A shelf heading takes a copy *into* its folder and a folder *into or beside* it, so
 * both gestures only ever push things deeper or sideways; the breadcrumb is the one place that
 * takes either back **up**. Dropping a copy on `Collection` un-files it to the root, on an ancestor
 * moves it there. Dropping a folder moves it into that level, **last** — which is what the up tile
 * did before it was deleted with the folder band, and why a segment takes no edge: it is one
 * landing wide, there is no second position for the reader to have meant.
 *
 * The last segment is the folder the reader is already in, so it is neither a link nor a target:
 * `aria-current="page"` and no drop, because "move this to where it already is" is not an
 * operation. At the root the trail is empty and `Collection` is itself that last segment.
 *
 * **There is no flattened state any more.** Flatten was deleted with the folder band (decision 2):
 * the wall at any level is every card at and below it, so there is no "all folders" sentence for
 * this bar to stand in for.
 */
import { useRef } from "react";
import { DROP_OVER, DROP_RING } from "@/lib/dropMarks";
import { useFolderDropTarget, type FolderDrag } from "@/lib/folderDrag";
import { FOCUS } from "@/lib/focus";
import type { CollectionFolder } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { useCollectionDropTarget, type CollectionDrop } from "./collectionDrag";

/** The top of the cabinet. Not a folder, and deliberately not spelled twice: it is the one
 *  destination whose id is `null`, which is a real place rather than an absent one. */
const ROOT = "Collection";

/** A folder policy for a page that passes none: every segment refuses every folder. */
const NO_FOLDER = () => false;
const IGNORE = () => {};

export function CollectionBreadcrumb({
  trail,
  onOpen,
  canDrop,
  onDropCard,
  canDropFolder,
  onDropFolder,
}: {
  /** Root-most first, ending with the folder being shown. Empty at the root. */
  trail: readonly CollectionFolder[];
  onOpen: (folderId: number | null) => void;
  /** Asked per segment rather than once for the bar — a copy already filed at the root refuses
   *  the root and still accepts an ancestor, so only the page can answer, and only per place. */
  canDrop: (drop: CollectionDrop, folderId: number | null) => boolean;
  onDropCard: (drop: CollectionDrop, folderId: number | null) => void;
  /**
   * A folder let go on a segment — moved into that level, last. Asked per segment for the same
   * reason as a copy: a folder already in a level refuses that level, and one may not go inside
   * itself. Absent: the segments take copies and no folder.
   */
  canDropFolder?: (drag: FolderDrag, folderId: number | null) => boolean;
  onDropFolder?: (drag: FolderDrag, folderId: number | null) => void;
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
                  canDropFolder={canDropFolder ?? NO_FOLDER}
                  onDropFolder={onDropFolder ?? IGNORE}
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
 * One step of the trail a reader can go back to, and let go of a copy or a folder on.
 *
 * Its own component because both drop targets are hooks and a trail is a loop. Both register on
 * the **button**: the mark goes on the thing that can be pressed, and a mark on the `<li>` would
 * sit over the separator too. The two payloads are disjoint by construction (`readCollectionDrop`
 * and `readFolderDrag` read different keys), so two targets on one element never take one drag.
 */
function Segment({
  folderId,
  name,
  onOpen,
  canDrop,
  onDropCard,
  canDropFolder,
  onDropFolder,
}: {
  folderId: number | null;
  name: string;
  onOpen: (folderId: number | null) => void;
  canDrop: (drop: CollectionDrop, folderId: number | null) => boolean;
  onDropCard: (drop: CollectionDrop, folderId: number | null) => void;
  canDropFolder: (drag: FolderDrag, folderId: number | null) => boolean;
  onDropFolder: (drag: FolderDrag, folderId: number | null) => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const card = useCollectionDropTarget({
    ref,
    canDrop: (drop) => canDrop(drop, folderId),
    onDrop: (drop) => onDropCard(drop, folderId),
  });
  // The edge is ignored on purpose: a segment is one landing, and "last in this level" is the
  // only thing a drop on it can say. `axis` only decides which way `folderEdge` measures.
  const folder = useFolderDropTarget({
    ref,
    scope: "collection",
    axis: "horizontal",
    canDrop: (drag) => canDropFolder(drag, folderId),
    onDrop: (drag) => onDropFolder(drag, folderId),
  });

  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onOpen(folderId)}
      className={cn(
        "min-w-0 truncate rounded-md px-1.5 py-0.5 text-dim",
        "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
        (card.armed || folder.armed) && DROP_RING,
        (card.over || folder.edge !== null) && cn("text-text", DROP_OVER),
        FOCUS,
      )}
    >
      {name}
    </button>
  );
}
