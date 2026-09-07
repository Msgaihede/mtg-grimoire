import { type RefObject } from "react";
import { useDndDropTarget } from "@/lib/dndTarget";
import { composedDraggable, dragData, type DragPayload } from "@/features/decks/dnd";
import { readSearchCardDrag, type SearchCardDrag } from "@/features/search/searchCardDrag";

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
 * **Since 2026-09-07 a folder can be handed a second thing entirely**, and that is what
 * {@link WishDrop} is: the page grew a docked card search whose tiles are drag sources, so a
 * drawer takes either a wish being re-filed or a printing that is on nobody's list yet. The
 * second payload is `features/search/searchCardDrag.ts`'s, under a key of its own like every
 * other mark here — this module composes nothing new for it and only *reads* it, which is why
 * {@link wishDraggable} below is unchanged.
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
 * The wish half of a payload, or `null` for everything else — including a well-formed card payload
 * that carries no wish mark at all.
 *
 * **{@link readWishDrop} is what a target asks**; this is the arm of it that reads a wish already
 * on the list, and it stays exported because the drag *source* half of this module is tested
 * against it directly.
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
 * What a wishlist drop target is holding: a wish already on the list, or a printing off the search
 * column that is not on it yet.
 *
 * **A discriminated union rather than the bare {@link WishDrag} this file answered until
 * 2026-09-07**, and it is `CollectionDrop` copied — that module has been a union since a wall tile
 * became a second payload, and the argument is the same one: two shapes with different *fields* are
 * two different sentences at the target, and `kind` is what makes a `canFile` say which it is
 * looking at rather than infer it from a field one of them happens to lack. A wish carries where it
 * is filed **now**, which is the whole of what lets a folder refuse it; a card nobody owns has no
 * "now" at all, so every folder takes it.
 *
 * **This is the wishlist paying what the collection did not.** Widening `CollectionDrop` was one
 * arm on a type that was already a union; here every target had `WishDrag` written into its props,
 * so the union is prop-type churn across six sites — {@link useWishDropTarget}, `WishFolderCard`,
 * `WishParentFolderCard`, `WishlistBreadcrumb`'s `Segment`, and the page's own `canFile`/`fileWish`.
 * **It is still cheaper than the alternative**, which was a second droppable per folder card:
 * `@dnd-kit/dom` keys its registry by entity id, so two registrations on one element both stand and
 * `accepts()` keeps them apart — that really would work now, and it would split the `armed`/`over`
 * pair these cards fold into one. Two rings on one card, each answering about a different drag, is
 * a drawing decision bought to avoid a type.
 */
export type WishDrop =
  | { kind: "wish"; wish: WishDrag }
  | { kind: "new"; card: SearchCardDrag };

/**
 * Either shape, or `null` for anything that is neither — the one reader every wishlist drop target
 * asks, so "what may be let go on a folder" is answered in one place rather than per target.
 *
 * The two marks are disjoint by construction — a wish tile writes `wishSource` and a search tile
 * writes `searchCardSource` — so the order below is a convention rather than a tie-break. Stated
 * anyway, because a record carrying both would be a bug upstream and the wish is the narrower fact
 * to act on: it moves a row that already exists, where the other one creates one.
 */
export function readWishDrop(data: Record<string, unknown>): WishDrop | null {
  const wish = readWishDrag(data);
  if (wish !== null) return { kind: "wish", wish };
  const card = readSearchCardDrag(data);
  return card === null ? null : { kind: "new", card };
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
 * Where a {@link WishDrop} can be let go, and whether it is armed to be — one hook answering both,
 * gated by one `canDrop`.
 *
 * **One reader per element, and that is what the {@link WishDrop} union bought.** Since the search
 * column landed there are two things a folder card can be given — a wish being re-filed and a
 * printing being added — and the obvious alternative was a second `useDndDropTarget` beside this
 * one. dnd-kit would allow it; what it would cost is this hook's `armed`/`over` pair, which every
 * card folds into one ring and would then have to fold into one by hand from two.
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
  canDrop: (drop: WishDrop) => boolean;
  onDrop: (drop: WishDrop) => void;
}): { armed: boolean; over: boolean } {
  return useDndDropTarget({ ref, read: readWishDrop, canDrop, onDrop });
}
