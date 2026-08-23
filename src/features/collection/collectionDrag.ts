import { useEffect, useRef, useState, type RefObject } from "react";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
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
 * Where a collection entry can be let go, and whether it is armed to be — one hook answering
 * both, gated by one `canDrop`.
 *
 * **Not two hooks the way `deckDrag.ts` splits `useDeckDropTarget` from `useDeckDragging`**, and
 * `wishDrag.ts` states the reason in full: every folder-shaped target answers the same yes/no
 * about a *deck*, and none of them answers the same yes/no about an *entry* — the folder a row is
 * already filed in refuses it, so "would this folder take the thing in the air" is a question only
 * the folder itself can answer. So `armed` is computed **per target**, through its own
 * `monitorForElements` gated by its own `canDrop` — which is what raises **every** eligible
 * folder's ring at once while a row is in the air, never only the one under the pointer — and
 * `over` is the one further fact that only the target the pointer is actually over can answer.
 *
 * `canDrop` and `onDrop` are read through a ref rather than through either effect's deps, so a
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
  canDrop: (drag: CollectionDrag) => boolean;
  onDrop: (drag: CollectionDrag) => void;
}): { armed: boolean; over: boolean } {
  const [armed, setArmed] = useState(false);
  const [over, setOver] = useState(false);
  const latest = useRef({ canDrop, onDrop });
  useEffect(() => {
    latest.current = { canDrop, onDrop };
  });

  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => {
          const drag = readCollectionDrag(source.data);
          return drag !== null && latest.current.canDrop(drag);
        },
        onDragStart: () => setArmed(true),
        // Fires for a cancelled drag as well as a completed one — the platform ends both the
        // same way — so the ring stands down on Escape without this hearing a keypress.
        onDrop: () => setArmed(false),
      }),
    [],
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => {
        const drag = readCollectionDrag(source.data);
        return drag !== null && latest.current.canDrop(drag);
      },
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        const drag = readCollectionDrag(source.data);
        if (drag !== null && latest.current.canDrop(drag)) latest.current.onDrop(drag);
      },
    });
  }, [ref]);

  return { armed, over };
}
