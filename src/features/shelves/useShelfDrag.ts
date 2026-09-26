/**
 * The drag wiring a shelf needs from its page, written once for both pages — spec §6.
 *
 * **Every shelf target mounts mid-drag at some point**, because the wall is virtualised and a reader
 * holding a card scrolls; and a folder drag folds the whole wall (spec §3.9), which remounts every
 * heading at once. So both halves here ask for `armOnMount`, and the element arrives through
 * `useDndTargetRef`'s callback ref so a heading that swaps its element is re-registered rather than
 * orphaned.
 *
 * **Anything lands on a shelf target only while the pointer is inside it** (`pointerOnly`, on both
 * halves). Spec §6's targets are headings, empty boxes, the sticky bar and path segments — never
 * tiles, table rows or blank wall — and dnd-kit's default detector falls back to the carried
 * thing's *rectangle* when the pointer is in no target, which made the nearest heading take a card
 * released on another shelf's tiles (live pass, "Extra, found during 3"). The folder half takes the
 * same rule because the table view does not fold away during a folder drag, so a heading carried
 * over card rows would land beside whichever heading it overlapped. What it gives up is the grid's
 * folded wall landing a folder dropped in the 8px gap between two headings: there it now lands
 * nowhere, and a reorder is aimed at a heading's top or bottom quarter instead.
 *
 * **The results are named `attach` and `mark`, never `…Ref`**: the React Compiler lint reads a hook
 * result named like a ref as a ref object and flags every read beside it
 * (`features/home/stickyNoteDrag.ts` carries the finding).
 */
import { useCallback, useEffect, useRef } from "react";
import { useDndDropTarget, useDndTargetRef } from "@/lib/dndTarget";
import {
  folderDraggable,
  useFolderDropTarget,
  type FolderDrag,
  type FolderEdge,
  type FolderScope,
} from "@/lib/folderDrag";
import type { ShelfDropMark } from "./ShelfHeading";

/** What a target that takes cards only can show — `EmptyShelf` and `ShelfStickyBar`. */
export type CardDropMark = "none" | "armed" | "over";

/** The callback ref a page hands a shelf as `dropRef`. */
export type AttachDrop = (element: HTMLElement | null) => () => void;

/** The callback ref a page hands a heading as `dragRef`. */
export type AttachDrag = (element: HTMLElement | null) => (() => void) | undefined;

/** The page's card half: its own payload reader (`readCollectionDrop` / `readWishDrop`) and policy. */
export interface ShelfCardDrop<T> {
  read: (data: Record<string, unknown>) => T | null;
  canDrop: (drop: T) => boolean;
  onDrop: (drop: T) => void;
}

/** The page's folder half — only for a heading of a reader's own folder. */
export interface ShelfFolderDrop {
  scope: FolderScope;
  canDrop: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDrop: (drag: FolderDrag, edge: FolderEdge) => void;
}

/**
 * The plan header's spellings of the two argument shapes above — the same types under the names its
 * pinned signature uses, so a page written against either spelling compiles.
 */
export type ShelfCardDropPolicy<T> = ShelfCardDrop<T>;
export type ShelfFolderDropPolicy = ShelfFolderDrop;

/** The folder being carried, as the drag source reads it at the press. */
export interface ShelfDragFolder {
  id: number;
  name: string;
  parentId: number | null;
}

const NEVER = (): boolean => false;
const NOTHING = (): void => {};

/**
 * The two drop states as one mark. Only one thing is ever in the air, so a folder's landing, a card
 * over the row and "could take it" never compete; the order is only which question to ask first.
 */
export function shelfDropMark(
  card: { armed: boolean; over: boolean },
  folder: { armed: boolean; edge: FolderEdge | null },
): ShelfDropMark {
  if (folder.edge !== null) return folder.edge;
  if (card.over) return "over";
  if (card.armed || folder.armed) return "armed";
  return "none";
}

/**
 * A shelf's drop target — a heading's (cards and folders), an empty shelf's or the sticky bar's
 * (cards only). Both registrations sit on the one element: `@dnd-kit/dom` keys its registry by
 * entity id, and each droppable's `accept` refuses the other's payload before anything is measured.
 * Without a folder half the folder droppable accepts nothing, so it never enters a collision.
 */
export function useShelfDropTarget<T>(card: ShelfCardDrop<T>): {
  attach: AttachDrop;
  mark: CardDropMark;
};
export function useShelfDropTarget<T>(
  card: ShelfCardDrop<T>,
  folder: ShelfFolderDrop | undefined,
): { attach: AttachDrop; mark: ShelfDropMark };
export function useShelfDropTarget<T>(
  card: ShelfCardDrop<T>,
  folder?: ShelfFolderDrop,
): { attach: AttachDrop; mark: ShelfDropMark } {
  const { ref, attach } = useDndTargetRef();
  const cards = useDndDropTarget({
    ref,
    read: card.read,
    canDrop: card.canDrop,
    onDrop: card.onDrop,
    armOnMount: true,
    // Over only while the pointer is inside this row, box or bar. Spec §6 names these targets and
    // nothing else: a card released on a shelf's tiles or on blank wall files nowhere, where the
    // default's shape fallback filed it into whichever heading the carried card overlapped.
    pointerOnly: true,
  });
  const folders = useFolderDropTarget({
    ref,
    scope: folder?.scope ?? "collection",
    axis: "vertical",
    canDrop: folder?.canDrop ?? NEVER,
    onDrop: folder?.onDrop ?? NOTHING,
    armOnMount: true,
    // The same rule for a folder: the table view does not fold away during a folder drag, so a
    // heading carried over card rows would otherwise land beside whichever heading it overlapped.
    pointerOnly: true,
  });
  return { attach, mark: shelfDropMark(cards, folders) };
}

/**
 * A heading as something to pick up — `CollectionFolderCard`'s `useFolderDragSource`, as a callback
 * ref because a virtualised heading's element comes and goes. `null` (Not sorted, an app-owned
 * shelf) registers nothing and answers `undefined`, which is the heading's "not draggable".
 *
 * The folder is read **at the press** through a ref, and the registration is keyed on the id alone,
 * so a refetch that hands over a fresh folder object does not tear the source down mid-gesture.
 */
export function useShelfDragSource(
  folder: ShelfDragFolder | null,
  scope: FolderScope,
): AttachDrag | undefined {
  const latest = useRef(folder);
  useEffect(() => {
    latest.current = folder;
  });

  const id = folder?.id ?? null;
  const attach = useCallback(
    (element: HTMLElement | null) => {
      if (element === null || id === null) return undefined;
      return folderDraggable({
        element,
        folder: () => ({
          folderId: id,
          name: latest.current?.name ?? "",
          parentId: latest.current?.parentId ?? null,
          scope,
        }),
      });
    },
    [id, scope],
  );

  return id === null ? undefined : attach;
}
