import { useEffect, useRef, useState, type RefObject } from "react";
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { NOT_A_DRAG } from "./dnd";

/**
 * The gesture that files a deck into one of the filing cabinet's drawers — the payload, the two
 * readers of it, and the three registrations that raise a drawer's ring.
 *
 * **`dnd.ts`'s sibling, and the two are meant to be read together.** That module is the app's
 * *card* drag; this is the *deck* drag, and the pair share a key so that each refuses the
 * other's payload (see {@link DECK_MARK}). Everything here follows that module's rules for its
 * reasons: a payload is read field by field rather than cast, because the library's store is
 * untyped by construction; and a press on a control inside a draggable is a press on the
 * control, because Chromium starts a drag from the nearest draggable *ancestor* of whatever was
 * pressed and the library adds no exclusion of its own.
 *
 * It sits beside `FolderTree.tsx` rather than inside it because the gallery registers these in
 * three places — a deck tile, a folder row, a folder card on the wall — and a drop target is not
 * a tree.
 */

/**
 * A deck in the air, and the mark that says so.
 *
 * **A different mark from `dnd.ts`'s, deliberately, and it shares that module's key.** A deck
 * is not a card, and the two must be told apart in both directions: `readDragData` refuses
 * anything whose `dragSource` is not the card mark, so a deck dragged over a category column or
 * over the sidebar's Decks entry lights nothing up and writes nothing; and `readDeckDrag`
 * refuses a card for the same reason. Sharing the key is what makes each fence answer the
 * other's payload rather than ignoring it.
 */
const DECK_MARK = "mtg-grimoire/deck-file-drag";
const MARK_KEY = "dragSource";

/** What a deck drag carries: the deck, and its name for whatever wants to say what moved. */
export interface DeckDrag {
  deckId: number;
  name: string;
}

/** What a deck tile hands the adapter. Flat, so `canDrop` reads it without unwrapping. */
export function deckDragData(drag: DeckDrag): Record<string, unknown> {
  return { [MARK_KEY]: DECK_MARK, ...drag };
}

/**
 * The payload a folder may act on, or `null` for everything else.
 *
 * Field by field rather than a cast — `dnd.ts`'s rule, for its reason: this is the app's
 * boundary with an untyped store every draggable in the window writes into.
 */
export function readDeckDrag(data: Record<string, unknown>): DeckDrag | null {
  if (data[MARK_KEY] !== DECK_MARK) return null;
  const { deckId, name } = data;
  if (typeof deckId !== "number" || !Number.isSafeInteger(deckId) || deckId <= 0) return null;
  if (typeof name !== "string") return null;
  return { deckId, name };
}

/**
 * A deck tile that can be picked up, and a press on one of its controls that is a press on the
 * control.
 *
 * `cardDraggable`'s arrangement rather than `cardDraggable` itself: the payload is a deck and
 * the mark has to differ (see {@link DECK_MARK}), so what is shared is {@link NOT_A_DRAG} and
 * the reasoning. Chromium starts a drag from the nearest draggable *ancestor* of whatever was
 * pressed and the library adds no exclusion, so without the capture-phase `mousedown` a press
 * on Delete plus five pixels of travel is a drag of the whole tile and the click never lands.
 */
export function deckDraggable({
  element,
  payload,
}: {
  element: HTMLElement;
  /** Read at `dragstart`, so a tile renamed since it mounted carries what it is now. */
  payload: () => DeckDrag;
}): () => void {
  let onControl = false;
  const press = (event: Event) => {
    const target = event.target;
    onControl = target instanceof Element && target.closest(NOT_A_DRAG) !== null;
  };
  element.addEventListener("mousedown", press, true);
  const stop = draggable({
    element,
    canDrag: () => !onControl,
    getInitialData: () => deckDragData(payload()),
  });
  return () => {
    element.removeEventListener("mousedown", press, true);
    stop();
  };
}

/**
 * The deck in the air, or `null` — what raises the ring on every folder that could take it.
 *
 * The deck rather than a bare "something is being dragged", because a folder the deck is
 * already in cannot take it: a boolean would light every drawer up and then refuse the one the
 * reader aimed at. A card drag raises nothing here at all, and this is where that is decided.
 */
export function useDeckDragging(): DeckDrag | null {
  const [drag, setDrag] = useState<DeckDrag | null>(null);
  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => readDeckDrag(source.data) !== null,
        onDragStart: ({ source }) => setDrag(readDeckDrag(source.data)),
        // Fires for a cancelled drag as well as a completed one — the platform ends both the
        // same way — so the rings stand down on Escape without this hearing a keypress.
        onDrop: () => setDrag(null),
      }),
    [],
  );
  return drag;
}

/**
 * One place a deck can be let go: a folder row, or a folder card on the wall.
 *
 * `canDrop` and `onDrop` are read through a ref rather than through the effect's deps, so a
 * target does not tear itself down and re-register every time the deck list changes under it —
 * `AppShell`'s sidebar entries do the same, for the same reason.
 */
export function useDeckDropTarget({
  ref,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drag: DeckDrag) => boolean;
  onDrop: (drag: DeckDrag) => void;
}): boolean {
  const [over, setOver] = useState(false);
  const latest = useRef({ canDrop, onDrop });
  useEffect(() => {
    latest.current = { canDrop, onDrop };
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => {
        const drag = readDeckDrag(source.data);
        return drag !== null && latest.current.canDrop(drag);
      },
      onDragEnter: () => setOver(true),
      onDragLeave: () => setOver(false),
      onDrop: ({ source }) => {
        setOver(false);
        const drag = readDeckDrag(source.data);
        // Asked again on the drop itself: `canDrop` and this can be a second apart, and only
        // this one writes.
        if (drag !== null && latest.current.canDrop(drag)) latest.current.onDrop(drag);
      },
    });
  }, [ref]);

  return over;
}
