import { type RefObject } from "react";
import { useDndDropTarget } from "@/lib/dndTarget";
import { composedDraggable, dragData, type DragPayload } from "@/features/decks/dnd";

/**
 * The gesture that files a wish into one of the wishlist's own folders — the payload, the tile
 * that offers it, and the target that raises a folder's ring for it. Design spec §9.
 *
 * **`deckDrag.ts`'s sibling in shape, and its opposite in the one decision the whole file
 * exists for.** That module puts a *different mark* under `dnd.ts`'s **own key** (`dragSource`),
 * so a deck and a card refuse each other's payload outright — right for a deck, because a deck
 * is never a card. A wish is not like a deck: a **pinned** wish genuinely is both a card
 * (something a deck category or the sidebar's Decks entry can take) and a wish (something a
 * folder can take), and both readers have to say yes to the *same tile's* payload at once.
 * Sharing `dragSource` the way `deckDrag.ts` shares it would force this module's mark onto that
 * one key, so `dnd.ts`'s reader would see only whichever mark won and the other would be lied to.
 * So this module answers under its **own key**, `wishSource`, spelled once as {@link WISH_MARK}.
 * A wish tile's payload is the union of what `dnd.ts`'s `dragData` wrote (when there is a
 * printing to carry) and what {@link wishDragData} writes (always) — two keys in one flat
 * object, each reader answering only its own and staying blind to the other's.
 *
 * **An any-printing wish is where this pays for itself rather than merely differing on paper.**
 * `WishlistGrid.tsx` registers no drag at all today on a wish with no `card_id`, because
 * `dnd.ts`'s `isId` refuses an empty `cardId` outright — it "addresses every row and no row" —
 * and there is no printing to hand a deck category regardless. But "set this one aside" is a
 * wish operation and has nothing to do with owning a printing, so such a wish's payload carries
 * `wishSource` **alone**: `wishDraggable`'s `card` callback answers `null`, so `dragData` is
 * never called and no `dragSource` key is ever written. `readDragData` then answers `null` for
 * it exactly as it does today when the tile cannot be picked up at all — nothing in `dnd.ts` or
 * the deck editor has to know this module exists — while {@link readWishDrag} answers the wish.
 *
 * Every payload is read field by field rather than cast, `dnd.ts`'s boundary rule and its
 * reason: this is the app's edge with the drag library's own store, which every draggable in the
 * window writes into untyped, and "it type-checked" means nothing at that edge.
 */

/**
 * The mark that says a payload carries a wish, and its key.
 *
 * **Deliberately not `dnd.ts`'s `dragSource`** — see the module comment above for why sharing it
 * would be wrong here where it is exactly right for `deckDrag.ts`'s `DECK_MARK`.
 */
const WISH_MARK = "mtg-grimoire/wish-file-drag";
const MARK_KEY = "wishSource";

/** What a wish drag carries: the wish, its name for whatever says what moved, and where it is
 *  filed right now. */
export interface WishDrag {
  wishId: number;
  name: string;
  /** Where it is filed now, so a folder can refuse a drop onto itself — `null` is the root. */
  folderId: number | null;
}

/** What a wish tile hands the adapter under its own key. Flat, and meant to be merged with
 *  whatever `dnd.ts`'s `dragData` writes for a pinned wish (see {@link wishDraggable}), so
 *  `canDrop` on either side reads its own key without unwrapping anything. */
export function wishDragData(drag: WishDrag): Record<string, unknown> {
  return { [MARK_KEY]: WISH_MARK, ...drag };
}

/**
 * The payload a folder or a breadcrumb segment may act on, or `null` for everything else —
 * including a well-formed card payload that carries no wish mark at all.
 *
 * Field by field rather than a cast — `dnd.ts`'s rule, for its reason: this is the app's
 * boundary with an untyped store every draggable in the window writes into.
 */
export function readWishDrag(data: Record<string, unknown>): WishDrag | null {
  if (data[MARK_KEY] !== WISH_MARK) return null;
  const { wishId, name, folderId } = data;
  if (typeof wishId !== "number" || !Number.isSafeInteger(wishId) || wishId <= 0) return null;
  if (typeof name !== "string") return null;
  if (folderId !== null && (typeof folderId !== "number" || !Number.isSafeInteger(folderId)))
    return null;
  return { wishId, name, folderId };
}

/**
 * A wish tile or row that can be picked up — as a wish always, and as a card too where there is a
 * printing to carry.
 *
 * **`dnd.ts`'s `composedDraggable`, with this module's composition passed in as its `data`.** It
 * had its own copy of the capture-phase `mousedown` guard until the seam existed; a second copy
 * of that guard is a second place for the bug it exists to prevent to come back, so the guard is
 * `dnd.ts`'s alone now and this file contributes only the payload. The guard still matters here
 * for the reason it was copied for: Chromium starts a drag from the nearest draggable *ancestor*
 * of whatever was pressed, and a wish tile carries controls of its own — the pencil `EditWish`
 * opens, the quantity stepper — so without it a press on either plus five pixels of travel drags
 * the whole tile.
 *
 * What is this module's is the record: `card()`'s payload through `dnd.ts`'s own `dragData`
 * merged under {@link wishDragData}'s, and only when `card()` answers something — an
 * any-printing wish's payload is `wishDragData` alone, which is the asymmetry the module comment
 * above is about. `CardGrid`'s `dragRecord` slot exists to carry the identical record for the
 * wall's tiles, which register through the wall rather than through here.
 */
export function wishDraggable({
  element,
  wish,
  card,
}: {
  element: HTMLElement;
  /** Read at `dragstart`, so a wish moved to another folder or renamed since the tile mounted
   *  carries what it is now. */
  wish: () => WishDrag;
  /** The card half of the payload, read at `dragstart` too — `null` for a wish with no printing
   *  to carry, which is what leaves the mark off the payload rather than sending an empty one. */
  card: () => DragPayload | null;
}): () => void {
  return composedDraggable({
    element,
    data: () => {
      const cardPayload = card();
      return cardPayload === null
        ? wishDragData(wish())
        : { ...dragData(cardPayload), ...wishDragData(wish()) };
    },
  });
}

/**
 * Where a wish can be let go, and whether it is armed to be — one hook answering both, gated by
 * one `canDrop`.
 *
 * **Not two hooks the way `deckDrag.ts` splits `useDeckDropTarget` (the one target under the
 * pointer) from `useDeckDragging` (a deck in the air at all, read once and combined with
 * `canDrop` by whoever calls it).** That split works there because every folder-shaped target in
 * this app answers the same yes/no about a deck. It does not work here: spec §9 says a folder
 * refuses the wish already filed in it, so "would this folder accept the thing currently in the
 * air" is a question only the folder itself can answer, and answering it once centrally would
 * mean threading every folder's own state back out to a shared caller instead of asking the
 * target that already has it. So `armed` is computed **per target**, gated by its own `canDrop`
 * — which is what raises **every** eligible folder's ring at once while a wish is in the air,
 * never only the one under the pointer — and `over` is the one further fact that only the target
 * the pointer is actually over can answer. Both come out of `lib/dndTarget.ts`'s
 * {@link useDndDropTarget}, which is that pair written once for the eight targets that ask it.
 *
 * `canDrop` and `onDrop` are read through a ref rather than through either effect's deps, so a
 * target does not tear itself down and re-register every time the folder list or the wish list
 * changes under it — `deckDrag.ts`'s `useDeckDropTarget` and `AppShell`'s sidebar entries do the
 * same, for the same reason. `canDrop` is asked again on the drop itself, because the two
 * questions can be a second apart and only the second one writes.
 */
export function useWishDropTarget({
  ref,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drag: WishDrag) => boolean;
  onDrop: (drag: WishDrag) => void;
}): { armed: boolean; over: boolean } {
  return useDndDropTarget({ ref, read: readWishDrag, canDrop, onDrop });
}
