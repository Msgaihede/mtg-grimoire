import { type RefObject } from "react";
import { useDndDropTarget } from "@/lib/dndTarget";
import { composedDraggable, dragData, type DragPayload } from "@/features/decks/dnd";

/**
 * The gesture that files a collection entry into one of the binder's own folders — the payload,
 * the row that offers it, and the target that raises a folder's ring for it. Design spec §7.1.
 *
 * **A port of `wishDrag.ts`, and it is a port because the decision that file exists for is the
 * same decision here.** `deckDrag.ts` puts a *different mark* under `dnd.ts`'s **own key**
 * (`dragSource`), so a deck and a card refuse each other's payload outright — right for a deck,
 * because a deck is never a card. A collection row is not like a deck: it genuinely is both a
 * **card** (something a deck category or the sidebar's Decks entry can take — that drag has been
 * on this table since long before folders existed) and an **entry** (something a folder can
 * take), and both readers have to say yes to the *same row's* payload at once. Sharing
 * `dragSource` the way `deckDrag.ts` shares it would force this module's mark onto that one key,
 * so `dnd.ts`'s reader would see only whichever mark won and the other would be lied to. So this
 * module answers under its **own key**, `collectionSource`, spelled once as
 * {@link COLLECTION_MARK}.
 *
 * A row's payload is therefore the union of what `dnd.ts`'s `dragData` wrote and what
 * {@link collectionDragData} writes — two keys in one flat object, each reader answering only its
 * own and staying blind to the other's.
 *
 * **Where this parts company with the wishlist's copy: the card half is never absent.**
 * `wishDraggable` takes `card: () => DragPayload | null`, because an any-printing wish has no
 * printing to hand a deck category and `dnd.ts`'s `isId` refuses an empty `cardId` outright. A
 * collection entry is a printing by construction — `collection_entries.card_id` is `NOT NULL` and
 * is the first of the eleven grain columns — so there is no such case here and
 * {@link collectionDraggable} asks for the card payload rather than for a callback that may
 * decline. An **orphaned** entry, whose printing has left `cards`, still has its `card_id`; what
 * it lacks is a name, and a name is allowed to be empty.
 *
 * **A collection *tile* is a third payload and takes a third key, by the same argument one rung
 * further out.** The wall sums every entry for one printing into one tile — across finishes,
 * conditions, languages *and folders* — so a tile has no `entryId` at all, which is exactly why
 * `CardGrid.tsx`'s `dragPayload` note and `CollectionPage.tsx` recorded that the wall registered
 * no drag: {@link CollectionDrag} requires one. Widening that interface's `entryId` into a list is
 * the change that looks smaller and is not. A table row really does carry one entry — the table is
 * where a reader breaks a printing apart, and one row is the whole of what its drop writes — so
 * the widening would make every target, every test and every `canDrop` in this feature reason
 * about a list to say a thing about a single row. So a tile answers under its **own** key,
 * `collectionTileSource`, spelled once as {@link COLLECTION_TILE_MARK}, and a reader that has
 * never heard of tiles goes on answering `null` for one rather than reading half of it — which is
 * the same property that lets `dnd.ts` stay blind to both.
 *
 * {@link readCollectionDrop} is what a target that takes either one asks, and {@link CollectionDrop}
 * is its discriminated answer. The union rather than the tile shape alone: a folder's answer about
 * one row is a different sentence from its answer about nine copies filed in five places, and
 * `kind` is what makes a `canDrop` say which it is looking at instead of inferring it from a
 * length.
 *
 * Every payload is read field by field rather than cast, `dnd.ts`'s boundary rule and its reason:
 * this is the app's edge with the drag library's own store, which every draggable in the window
 * writes into untyped, and "it type-checked" means nothing at that edge.
 */

/**
 * The mark that says a payload carries a collection entry, and its key.
 *
 * **Deliberately not `dnd.ts`'s `dragSource`** — see the module comment above for why sharing it
 * would be wrong here where it is exactly right for `deckDrag.ts`'s `DECK_MARK`.
 */
const COLLECTION_MARK = "mtg-grimoire/collection-file-drag";
const MARK_KEY = "collectionSource";

/**
 * The mark that says a payload carries a whole collection **tile**, and its key.
 *
 * **A third key rather than a second `kind` inside the first payload**, which is the module
 * comment's argument said in one line: the two shapes have different *fields*, and a key of its
 * own is what keeps {@link readCollectionDrag} answering `null` — rather than reading an entry out
 * of something that has none — for a payload it was never written for.
 */
const COLLECTION_TILE_MARK = "mtg-grimoire/collection-tile-drag";
const TILE_MARK_KEY = "collectionTileSource";

/** What a collection drag carries: the entry, its name for whatever says what moved, and where
 *  it is filed right now. */
export interface CollectionDrag {
  entryId: number;
  name: string;
  /** Where it is filed now, so a folder can refuse a drop onto itself — `null` is the root. */
  folderId: number | null;
}

/** What a collection row hands the adapter under its own key. Flat, and meant to be merged with
 *  whatever `dnd.ts`'s `dragData` writes for the same row (see {@link collectionDraggable}), so
 *  `canDrop` on either side reads its own key without unwrapping anything. */
export function collectionDragData(drag: CollectionDrag): Record<string, unknown> {
  return { [MARK_KEY]: COLLECTION_MARK, ...drag };
}

/**
 * The payload a folder or a breadcrumb segment may act on, or `null` for everything else —
 * including a well-formed card payload that carries no collection mark at all.
 *
 * Field by field rather than a cast — `dnd.ts`'s rule, for its reason: this is the app's boundary
 * with an untyped store every draggable in the window writes into.
 */
export function readCollectionDrag(data: Record<string, unknown>): CollectionDrag | null {
  if (data[MARK_KEY] !== COLLECTION_MARK) return null;
  const { entryId, name, folderId } = data;
  if (typeof entryId !== "number" || !Number.isSafeInteger(entryId) || entryId <= 0) return null;
  if (typeof name !== "string") return null;
  if (folderId !== null && (typeof folderId !== "number" || !Number.isSafeInteger(folderId)))
    return null;
  return { entryId, name, folderId };
}

/** One copy behind a wall tile: the row it is, and the folder it sits in right now. */
export interface CollectionCopy {
  entryId: number;
  /** `null` is the root. Read at dragstart, so a copy refiled since the tile mounted is honest. */
  folderId: number | null;
}

/** What a collection *tile* carries: the printing, and every entry the wall summed into it. */
export interface CollectionTileDrag {
  cardId: string;
  name: string;
  /** Never empty — a tile exists because rows exist. At least one is the reader's fence. */
  copies: readonly CollectionCopy[];
}

/** What a collection tile hands the adapter under its own key. Flat like
 *  {@link collectionDragData} and merged with `dnd.ts`'s the same way (see
 *  {@link collectionTileDraggable}), so a deck column reads the card and a folder reads the
 *  shelf without either unwrapping the other's. */
export function collectionTileDragData(drag: CollectionTileDrag): Record<string, unknown> {
  return { [TILE_MARK_KEY]: COLLECTION_TILE_MARK, ...drag };
}

/**
 * The tile payload a folder or a breadcrumb segment may act on, or `null` for everything else —
 * including a well-formed *entry* payload, which is a different drag under a different key.
 *
 * Field by field like {@link readCollectionDrag}, and **every copy as well as the tile**: the
 * array comes out of the same untyped store the mark does, and an array is precisely the shape
 * that arrives looking right while carrying anything.
 *
 * **A malformed copy is fatal here, where `dnd.ts`'s `readDragGroup` drops one and carries on.**
 * That function reads a multi-*select*, where four readable cards out of five is still the gesture
 * the reader made. This reads one printing's copies, and they are the whole of what the refile
 * writes: a tile that quietly lost one would move eight rows of nine and leave the ninth where it
 * was, with nothing on screen saying which. A refused drop is a failure the reader can see.
 */
export function readCollectionTileDrag(data: Record<string, unknown>): CollectionTileDrag | null {
  if (data[TILE_MARK_KEY] !== COLLECTION_TILE_MARK) return null;
  const { cardId, name, copies } = data;
  // Empty is refused for `dnd.ts`'s `isId` reason, stated there: an empty `card_id` addresses
  // every row and no row. A collection tile is a printing by construction, so there is no honest
  // caller this costs.
  if (typeof cardId !== "string" || cardId.length === 0) return null;
  if (typeof name !== "string") return null;
  // Empty is refused because a tile with no copies behind it cannot exist — the wall draws one
  // *because* rows grouped into it — so an empty array is a producer bug, and a drop that wrote
  // nothing at all would look exactly like a drop that worked.
  if (!Array.isArray(copies) || copies.length === 0) return null;
  const read: CollectionCopy[] = [];
  for (const copy of copies) {
    if (typeof copy !== "object" || copy === null) return null;
    const { entryId, folderId } = copy as Record<string, unknown>;
    if (typeof entryId !== "number" || !Number.isSafeInteger(entryId) || entryId <= 0) return null;
    if (folderId !== null && (typeof folderId !== "number" || !Number.isSafeInteger(folderId)))
      return null;
    read.push({ entryId, folderId });
  }
  return { cardId, name, copies: read };
}

/**
 * What a collection drop target is holding: one row, or a whole tile's worth of them.
 *
 * The union rather than the tile shape alone — see the module comment: one row and one printing's
 * shelf are two different sentences, and `kind` is what makes a target's policy say which it is
 * answering about rather than infer it from `copies.length`.
 */
export type CollectionDrop =
  | { kind: "entry"; entry: CollectionDrag }
  | { kind: "tile"; tile: CollectionTileDrag };

/**
 * Either shape, or `null` for anything that is neither — the one reader every collection drop
 * target asks, so "what can be dropped on a folder" is answered in one place rather than per
 * target.
 *
 * The two marks are disjoint by construction — a row writes one key and a tile the other — so the
 * order below is a convention rather than a tie-break. Stated anyway, because a payload carrying
 * both would be a bug upstream and the entry is the narrower fact to act on: it moves one row,
 * where a tile moves every copy behind a printing.
 */
export function readCollectionDrop(data: Record<string, unknown>): CollectionDrop | null {
  const entry = readCollectionDrag(data);
  if (entry !== null) return { kind: "entry", entry };
  const tile = readCollectionTileDrag(data);
  return tile === null ? null : { kind: "tile", tile };
}

/**
 * A collection row that can be picked up — as a card and as an entry at once.
 *
 * **`dnd.ts`'s `composedDraggable`, with this module's composition passed in as its `data`.** The
 * capture-phase `mousedown` guard is that function's alone and this file contributes only the
 * record; the guard matters here for the reason it was written for, which the collection table is
 * the original example of: Chromium starts a drag from the nearest draggable *ancestor* of
 * whatever was pressed, and a collection row carries a quantity stepper, so without it a press on
 * `+` plus five pixels of travel drags the whole row into a deck.
 *
 * Both halves are read at `dragstart`, so a row re-filed or re-numbered since it mounted carries
 * what it is now — which is the whole reason the two are callbacks rather than values.
 */
export function collectionDraggable({
  element,
  entry,
  card,
}: {
  element: HTMLElement;
  /** Read at `dragstart`, so a row moved to another folder since it mounted carries where it is
   *  now — which is what lets that folder refuse it. */
  entry: () => CollectionDrag;
  /** The card half of the payload, read at `dragstart` too. Never `null`: a collection entry is
   *  a printing by construction. */
  card: () => DragPayload;
}): () => void {
  return composedDraggable({
    element,
    data: () => ({ ...dragData(card()), ...collectionDragData(entry()) }),
  });
}

/**
 * A collection **tile** that can be picked up — as a card and as a printing's whole shelf at once.
 *
 * {@link collectionDraggable}'s shape with the other payload in it, and it is that shape for the
 * same two reasons. The capture-phase `mousedown` guard is `composedDraggable`'s and matters here
 * as much as on a row: a wall tile carries a quantity stepper too, and Chromium starts a drag from
 * the nearest draggable *ancestor* of whatever was pressed. And both halves are callbacks read at
 * `dragstart`, so a copy refiled since the tile mounted travels as it is now — which on a tile is
 * not a nicety: `folderId` is per *copy*, and it is what lets a folder refuse the ones already in
 * it while still taking the rest.
 *
 * The card half is never absent here either, and for a stronger reason than on a row: the wall
 * groups **by printing**, so a tile with no `cardId` is not a tile.
 */
export function collectionTileDraggable({
  element,
  tile,
  card,
}: {
  element: HTMLElement;
  /** Read at `dragstart`, so a tile whose copies were refiled since it was drawn carries where
   *  they are now. */
  tile: () => CollectionTileDrag;
  /** The card half of the payload, read at `dragstart` too — what keeps a wall tile droppable on
   *  a deck category and the sidebar's Decks entry, exactly as a table row already is. */
  card: () => DragPayload;
}): () => void {
  return composedDraggable({
    element,
    data: () => ({ ...dragData(card()), ...collectionTileDragData(tile()) }),
  });
}

/**
 * Where a collection drop can be let go, and whether it is armed to be — one hook answering
 * both, gated by one `canDrop`.
 *
 * **Either payload, read through {@link readCollectionDrop}**, and the hook has no opinion about
 * which: a row and a tile arm the same rings and run the same handler, and what differs between
 * them — the folder a single row is already in, against the folders nine copies are spread over —
 * is policy the page supplies. This file's job is to say which drags are this feature's at all.
 *
 * **Not two hooks the way `deckDrag.ts` splits `useDeckDropTarget` from `useDeckDragging`**, and
 * `wishDrag.ts` states the reason in full: every folder-shaped target answers the same yes/no
 * about a *deck*, and none of them answers the same yes/no about an *entry* — the folder a row is
 * already filed in refuses it, so "would this folder take the thing in the air" is a question only
 * the folder itself can answer. So `armed` is computed **per target**, gated by its own
 * `canDrop` — which is what raises **every** eligible folder's ring at once while a row is in the
 * air, never only the one under the pointer — and `over` is the one further fact that only the
 * target the pointer is actually over can answer. Both come out of `lib/dndTarget.ts`'s
 * {@link useDndDropTarget}, which is that pair written once for the eight targets that ask it.
 *
 * `canDrop` and `onDrop` are read through a ref rather than through the effect's deps, so a
 * target does not tear itself down and re-register every time the folder list or the collection
 * list changes under it. `canDrop` is asked again on the drop itself, because the two questions
 * can be a second apart and only the second one writes.
 */
export function useCollectionDropTarget({
  ref,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drop: CollectionDrop) => boolean;
  onDrop: (drop: CollectionDrop) => void;
}): { armed: boolean; over: boolean } {
  return useDndDropTarget({ ref, read: readCollectionDrop, canDrop, onDrop });
}
