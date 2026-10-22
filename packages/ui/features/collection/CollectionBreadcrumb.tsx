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
 * **It is the page bar's trail since 2026-10-21** (`PageBar`'s `trailNode`, the owner's note): the
 * folder the reader is in is the bar's title, so this draws only the levels above it, in the bar's
 * crumb style, and nothing at the root. That folder was never a target — "move this to where it
 * already is" is not an operation — so no drop was lost with it.
 *
 * **There is no flattened state any more.** Flatten was deleted with the folder band (decision 2):
 * the wall at any level is every card at and below it, so there is no "all folders" sentence for
 * this bar to stand in for.
 */
import { Fragment, useRef } from "react";
import { CrumbChevron, PAGE_CRUMB } from "@/components/PageBar";
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
    <nav aria-label="Collection folders" className="flex min-w-0 items-baseline gap-2">
      {segments.map((segment) => (
        <Fragment key={segment.folderId ?? "root"}>
          <Segment
            folderId={segment.folderId}
            name={segment.name}
            onOpen={onOpen}
            canDrop={canDrop}
            onDropCard={onDropCard}
            canDropFolder={canDropFolder ?? NO_FOLDER}
            onDropFolder={onDropFolder ?? IGNORE}
          />
          <CrumbChevron />
        </Fragment>
      ))}
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
  // **Both targets take a drop only while the pointer is inside the segment** (`pointerOnly`).
  // dnd-kit's default detector falls back to the carried card's whole rectangle, and the path row
  // sits straight above the wall — so a card released over the first row of tiles inside an opened
  // folder overlapped a segment and landed in it, the stray drop T3 fixed for the headings.
  const card = useCollectionDropTarget({
    ref,
    canDrop: (drop) => canDrop(drop, folderId),
    onDrop: (drop) => onDropCard(drop, folderId),
    pointerOnly: true,
  });
  // The edge is ignored on purpose: a segment is one landing, and "last in this level" is the
  // only thing a drop on it can say. `axis` only decides which way `folderEdge` measures.
  const folder = useFolderDropTarget({
    ref,
    scope: "collection",
    axis: "horizontal",
    canDrop: (drag) => canDropFolder(drag, folderId),
    onDrop: (drag) => onDropFolder(drag, folderId),
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
        (card.armed || folder.armed) && DROP_RING,
        (card.over || folder.edge !== null) && cn("text-text", DROP_OVER),
        FOCUS,
      )}
    >
      {name}
    </button>
  );
}
