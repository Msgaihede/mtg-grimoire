/**
 * The wishlist's three shelf pieces that take a drop — a heading, the sticky bar, and an empty
 * folder's dashed box — each the shared `features/shelves` component, wired through
 * `features/shelves/useShelfDrag` with this page's payload reader and filing policy.
 *
 * **Through `useShelfDrag` and never through `useWishDropTarget` directly**, because that is where
 * the shelves opt into `armOnMount`: a virtualised heading mounts as it scrolls in, a folder drag
 * folds the whole wall and remounts every heading at once, and a target that armed only at
 * `dragstart` would take the drop without ever showing it could (spec §6).
 *
 * **Components, because the registrations are hooks and a wall is a loop.** Every rule about
 * *which* shelf takes *what* is the page's and arrives as the `cards` / `folders` policy; these
 * only bind it to the element the shared component hands over. They stamp nothing — `ShelfHeading`
 * (`data-shelf-heading`), `EmptyShelf` and `ShelfStickyBar` already mark the element each registers
 * on, and that element is what the suites box.
 */
import { EmptyShelf } from "@/features/shelves/EmptyShelf";
import { ShelfHeading, type ShelfHeadingProps } from "@/features/shelves/ShelfHeading";
import { ShelfStickyBar } from "@/features/shelves/ShelfStickyBar";
import { useShelfDragSource, useShelfDropTarget } from "@/features/shelves/useShelfDrag";
import type { FolderDrag, FolderEdge } from "@/lib/folderDrag";
import type { WishlistFolder } from "@/lib/ipc";
import type { Shelf } from "@/lib/shelves";
import { readWishDrop, type WishDrop } from "./wishDrag";

/** A card let go on a shelf: may it land, and what landing writes. */
export interface CardDrops {
  canDrop: (drop: WishDrop) => boolean;
  onDrop: (drop: WishDrop) => void;
}
/** A folder let go on a heading, by the edge it was let go on (before / inside / after). */
export interface FolderDrops {
  canDrop: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDrop: (drag: FolderDrag, edge: FolderEdge) => void;
}

/** What a shelf that takes nothing answers — the folder being added, whose drawer does not exist. */
const NO_CARDS: CardDrops = { canDrop: () => false, onDrop: () => {} };

/**
 * One shelf's heading on the wishlist: `ShelfHeading`, a card target, a folder target on the
 * vertical axis (before / inside / after, `EDGE_ZONE`) when `folders` is given, and a folder drag
 * source when `source` is.
 *
 * `source` is `null` for Not sorted, a deck's managed folder and the folder being added — spec
 * §3.9's "app-owned folders cannot be dragged", and `ShelfHeading` itself ignores `dragRef` on
 * anything but `kind: "folder"` as a second fence.
 */
export function WishShelfHeading({
  cards,
  folders,
  source,
  ...heading
}: Omit<ShelfHeadingProps, "dropRef" | "dropMark" | "dragRef"> & {
  cards?: CardDrops;
  folders?: FolderDrops;
  source: WishlistFolder | null;
}) {
  const drop = useShelfDropTarget(
    { read: readWishDrop, ...(cards ?? NO_CARDS) },
    folders === undefined ? undefined : { scope: "wishlist", ...folders },
  );
  const drag = useShelfDragSource(source, "wishlist");
  return <ShelfHeading {...heading} dropRef={drop.attach} dropMark={drop.mark} dragRef={drag} />;
}

/**
 * The sticky bar — a **permanent** card target (spec §5.3, §6), filing into whichever shelf the
 * reader is scrolled inside. Cards only: its path segments are buttons and take no folder (the
 * coordinator's spec change — only the path row's segments do). Its `canDrop` reads the shelf of
 * the moment through the hook's own ref, so scrolling past a shelf re-binds nothing.
 */
export function WishShelfSticky({
  shelf,
  onOpen,
  onTop,
  cards,
}: {
  shelf: Shelf | null;
  onOpen: (folderId: number) => void;
  onTop: () => void;
  cards: (shelf: Shelf) => CardDrops | undefined;
}) {
  const drops = (shelf === null ? undefined : cards(shelf)) ?? NO_CARDS;
  const drop = useShelfDropTarget({ read: readWishDrop, ...drops });
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

/** An empty folder's dashed box — a card target of its own (spec §6). */
export function WishEmptyShelf({ cards }: { cards?: CardDrops }) {
  const drop = useShelfDropTarget({ read: readWishDrop, ...(cards ?? NO_CARDS) });
  return <EmptyShelf dropRef={drop.attach} dropMark={drop.mark} />;
}
