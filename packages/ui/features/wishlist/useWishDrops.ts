/**
 * The wishlist's **drops** — everything a drag let go on this page turns into: a wish or a printing
 * off the search column let go on a heading, an empty shelf, the sticky bar or a breadcrumb segment
 * (`canFile` / `fileWish`, `cardDrops`), and a folder heading let go on another heading or on a
 * breadcrumb segment (`folderPlacement` / `placeFolder`, `canMoveInto` / `moveInto`).
 *
 * **Out of `WishlistPage` since issue #557**, verbatim — `CollectionPage`'s `useCollectionDrops`
 * left that page in the same change, and this is its twin rather than a second caller of it: the
 * two cabinets' drop rules diverge on every point that matters (this one has the decks' managed
 * folders and nothing else to fence; the collection has deck groups, `Recently removed`, a lock and
 * a copy picker), so one hook over both would be a hook made of branches. What they genuinely share
 * is shared one level down — `reorderedLevel`, `folderDescendants`, `folderLevel`.
 *
 * What it is handed is the page's census and the page's writes, held still: the folder rows, the
 * reader's tree and the level each folder is drawn in, the managed folders, and the two writes a
 * drop reuses (`setFolder` and the folder reorder) as their `mutate`.
 */
import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import type { SearchCardDrag } from "@/features/search/searchCardDrag";
import type { FolderDrag, FolderEdge } from "@/lib/folderDrag";
import { reorderedLevel } from "@/lib/folderOrder";
import { folderDescendants, folderLevel, type FolderNode } from "@/lib/folderTree";
import { ipc, ipcError, type WishlistFolder } from "@/lib/ipc";
import { notify } from "@/lib/notifications";
import type { Shelf } from "@/lib/shelves";
import type { WishDrop } from "./wishDrag";
import type { CardDrops } from "./WishShelfHeading";
import { ROOT_LABEL } from "./WishFolderPanel";
import { fileTarget, NEW_FOLDER_SHELF } from "./wishShelfPlan";

/**
 * The root as {@link reorderedLevel} has to address it — an id no folder has, because
 * `wishlist_folders.id` is an `INTEGER PRIMARY KEY` and therefore always positive.
 *
 * Only a folder dropped on the breadcrumb's root segment needs it, and only to satisfy an argument
 * it does not use: an `inside`
 * landing reads `target` for one thing, the "dropped on itself" refusal, and a folder can never
 * be dropped on the root. The alternative is widening `reorderedLevel`'s `target` to
 * `number | null`, which would put a case in the shared arithmetic that only one caller has.
 * `DecksPage` spells the same constant for the same reason.
 */
const ROOT_TARGET = 0;

/** What a folder write hands back as its plan — the destination level and its whole new order. */
type Placement = { parentId: number | null; ids: number[] };

export function useWishDrops({
  census,
  userNodes,
  treeParent,
  managed,
  setFolder,
  reorder,
  settleWhole,
}: {
  /** Every folder there is, managed ones included — `useWishlistFolders`' `folders`. */
  census: readonly WishlistFolder[];
  /** The reader's tree, without the decks' managed folders — every destination is drawn from it. */
  userNodes: readonly FolderNode<WishlistFolder>[];
  /** Every reader's folder's parent as the tree draws it — the page's `treeParent`. */
  treeParent: ReadonlyMap<number, number | null>;
  /** The decks' managed folders, which refuse every hand write. */
  managed: ReadonlySet<number>;
  /** `useWishEntryWrites`' `setFolder`, as its `mutate` — the drags' write. The Edit panel's move
   *  is `moveWish`, an observer of its own, because it toasts and a drag does not. */
  setFolder: (variables: { id: number; folderId: number | null }) => void;
  /** The folder reorder's `mutate` — what a heading or a segment drop writes. */
  reorder: (plan: Placement) => void;
  /** How every write on the page finishes — `useWishEntryWrites`' `settleWhole`. */
  settleWhole: () => void;
}) {
  /**
   * A card **dropped** out of the search column onto a folder card or a breadcrumb segment.
   *
   * **An add and never a move**, which is the whole of what the second arm of {@link WishDrop}
   * means: the printing in the air is on nobody's list, so there is no row to re-file and
   * `wishlist_set_folder` has nothing to address. It is the *same write* `useCardMenuDeps` makes
   * for `Add to wishlist → this folder`, which is what keeps a drop and a right-click one
   * behaviour rather than two — `quantity: 1`, the printing's own finish as the preference, and
   * the folder the reader pointed at.
   *
   * **`preferredFinish` is the finish the printing actually exists in, carried on the drag.** A
   * wish for the foil is not filled by the nonfoil, so this is part of what is being asked for
   * rather than extra detail — and `searchCardDrag` refuses a record whose finish this build does
   * not know rather than guessing one, which is `useSidebarDrops.ts`'s standing objection answered
   * at the only place that can answer it. The `+` on the tile beside it is where a reader who
   * wants to say more says it.
   *
   * **`folderId` is never omitted, and `null` is the root.** The field is part of the row's
   * storage grain, so a folder the caller failed to pass is not a wish filed in the wrong drawer
   * but a *second* wish for the same card.
   *
   * Settled through {@link settleWhole} like every other write on this page: an add changes the
   * level being drawn, the folder subtotals above it, and every search row's `wishlisted` mark.
   */
  const addWish = useMutation({
    mutationFn: ({ card, folderId: to }: { card: SearchCardDrag; folderId: number | null }) =>
      ipc.wishlistAdd({
        cardId: card.cardId,
        quantity: 1,
        preferredFinish: card.finish,
        folderId: to,
      }),
    onSettled: settleWhole,
  });
  // Held still for {@link fileWish}'s dependencies — `mutateAsync` is stable where the result
  // around it is a new object every render. The promise rather than `mutate`'s per-call callbacks,
  // which TanStack fires for the newest call alone: two cards dropped in quick succession are two
  // receipts.
  const { mutateAsync: addWishAsync } = addWish;

  /**
   * Where what is in the air may be let go — asked per target, because the answer differs per
   * target: the folder a wish is already filed in refuses it and draws no ring at all, rather
   * than a ring that would write nothing and bump `updated_at`. `dropWrite`'s rule about a card
   * dropped back in its own column, one screen over.
   *
   * **A card off the search column has no such refusal to make, and that is a fact about it
   * rather than a gap here.** It is on nobody's list, so there is no `folderId` to compare a
   * destination against — every drawer is somewhere it is not already, so every drawer takes it.
   * **The ownership clause arrived with user schema v48's managed folders** (issue #512), which
   * are the decks' rather than the reader's — `CollectionPage`'s twin has had one all along for its
   * deck groups and `Recently removed`. Both ends of a drop are fenced, because the backend refuses
   * both in `MANAGED_REFUSAL`'s words (`./managed.ts`): a wish may not be filed *into* a deck's
   * list, and a wish in one may not be filed *out*. The second arm is belt and braces — a managed
   * wish is not a drag source on either view — so a stray payload cannot light a ring for a write
   * that is always refused.
   */
  const canFile = useCallback(
    (drop: WishDrop, to: number | null) => {
      if (to !== null && managed.has(to)) return false;
      if (drop.kind === "new") return true;
      if (drop.wish.folderId !== null && managed.has(drop.wish.folderId)) return false;
      return drop.wish.folderId !== to;
    },
    [managed],
  );
  /**
   * And what the drop writes — a **re-file** for a wish that exists, an **add** for a printing
   * that does not.
   *
   * One function for both arms rather than two props threaded to every target, because the target
   * asks one question and gets one answer: a heading lights up and takes what it is given.
   * Which command that turns into is the page's business, and it is the page that holds both.
   */
  //
  // **Only the add is said** (the owner's rule, 2026-10-12: every add to a list toasts, and a drag
  // inside the open list does not). A wish re-filed by a drag is the list rearranging itself under
  // the reader's pointer; a card off the search column is something new arriving on the wishlist,
  // often into a shelf that is shut, so the receipt names it and the drawer. The refusal is said
  // too — the page's banner says it as well, but a drop's banner sits far from where it was let go.
  const fileWish = useCallback(
    (drop: WishDrop, to: number | null) => {
      if (drop.kind === "wish") {
        setFolder({ id: drop.wish.wishId, folderId: to });
        return;
      }
      const name = drop.card.name === "" ? "card" : drop.card.name;
      const into = to === null ? ROOT_LABEL : (census.find((f) => f.id === to)?.name ?? "a folder");
      void addWishAsync({ card: drop.card, folderId: to }).then(
        () => notify.success(`Added “${name}” to “${into}”`),
        (error: unknown) =>
          notify.error(`Couldn't add “${name}” to “${into}”`, { body: ipcError(error) }),
      );
    },
    [setFolder, addWishAsync, census],
  );

  /**
   * What a folder let go on a heading means as a write — the destination level and that level's
   * whole new order — or `null` for a drop this page will not make.
   *
   * **One function for both halves of the gesture**: `useFolderDropTarget` asks it per frame to
   * decide what to draw and again at the drop, and a mark that promised a write the drop refused
   * would be worse than none. The ownership fence is structural — a heading has a folder target only
   * where `nodeById` holds it, which is the reader's folders alone.
   *
   * **The level is the target's as the tree draws it** ({@link treeParent}), because on shelves a
   * heading can be at any depth — where the band drew one level, and the level on screen was the
   * answer.
   *
   * **A folder may not land inside itself or inside anything it holds** — asked of the destination
   * parent, which covers all three landings at once. **Shelves made this reachable**: a folder's own
   * sub-folder is a heading on the same wall now, so `Ordered` dragged onto `Backordered` is one
   * move. The backend refuses it in words and `parent_id` cascades on itself, so this is the fence.
   *
   * And a drop that would reproduce the order already on screen is not a write — `reorderedLevel`'s
   * `null`, for the gesture a reader makes by accident whenever they think better of one mid-drag.
   */
  const folderPlacement = useCallback(
    (drag: FolderDrag, target: FolderNode<WishlistFolder>, edge: FolderEdge): Placement | null => {
      const parentId =
        edge === "inside" ? target.folder.id : (treeParent.get(target.folder.id) ?? null);
      if (parentId !== null && parentId === drag.folderId) return null;
      if (parentId !== null && folderDescendants(census, drag.folderId).has(parentId)) {
        return null;
      }
      const ids = reorderedLevel({
        // The target's own children for a nest — in the order the tree already draws them, so a
        // nest re-states the level it is joining rather than re-sorting it — and the target's own
        // level for the other two.
        siblings: (edge === "inside" ? target.children : folderLevel(userNodes, parentId)).map(
          (node) => node.folder.id,
        ),
        dragged: drag.folderId,
        target: target.folder.id,
        edge,
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [treeParent, census, userNodes],
  );
  const placeFolder = useCallback(
    (drag: FolderDrag, target: FolderNode<WishlistFolder>, edge: FolderEdge) => {
      const plan = folderPlacement(drag, target, edge);
      // A `null` writes **nothing at all** — not a reorder of the level as it stands.
      if (plan !== null) reorder(plan);
    },
    [folderPlacement, reorder],
  );

  /**
   * A folder let go on a **breadcrumb segment**: filed last inside that level — what the
   * `ParentFolderCard` "Up one level" tile did, on every segment rather than one tile (spec §6).
   *
   * Three refusals, each one {@link folderPlacement} makes too: **already there** (asked of the
   * level the tree *draws* it in, so an orphan drawn at the root may still be filed at the root
   * properly), **into itself or anything it holds**, and `reorderedLevel`'s own `null`.
   */
  const intoPlacement = useCallback(
    (drag: FolderDrag, parentId: number | null): Placement | null => {
      if ((treeParent.get(drag.folderId) ?? null) === parentId) return null;
      if (
        parentId !== null &&
        (parentId === drag.folderId || folderDescendants(census, drag.folderId).has(parentId))
      ) {
        return null;
      }
      const ids = reorderedLevel({
        // The destination level as the tree draws it, which is what makes the arriving folder
        // *last*. `userNodes`: the root holds the decks' managed folders too, and a reorder naming
        // one of those is refused whole.
        siblings: folderLevel(userNodes, parentId).map((node) => node.folder.id),
        dragged: drag.folderId,
        target: parentId ?? ROOT_TARGET,
        edge: "inside",
      });
      return ids === null ? null : { parentId, ids: [...ids] };
    },
    [treeParent, census, userNodes],
  );
  const canMoveInto = useCallback(
    (drag: FolderDrag, parentId: number | null) => intoPlacement(drag, parentId) !== null,
    [intoPlacement],
  );
  const moveInto = useCallback(
    (drag: FolderDrag, parentId: number | null) => {
      const plan = intoPlacement(drag, parentId);
      if (plan !== null) reorder(plan);
    },
    [intoPlacement, reorder],
  );

  /** A card let go on a shelf files into it — the root for Not sorted — through the page's own
   *  `canFile`, which refuses a managed destination, so a deck's heading never arms. */
  const cardDrops = useCallback(
    (shelf: Shelf): CardDrops | undefined => {
      if (shelf.id === NEW_FOLDER_SHELF) return undefined;
      const to = fileTarget(shelf);
      return { canDrop: (drop) => canFile(drop, to), onDrop: (drop) => fileWish(drop, to) };
    },
    [canFile, fileWish],
  );

  return {
    addWish,
    canFile,
    fileWish,
    folderPlacement,
    placeFolder,
    canMoveInto,
    moveInto,
    cardDrops,
  };
}
