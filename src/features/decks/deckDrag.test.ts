import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { dragData, readDragData } from "@/features/decks/dnd";
import { boxed, startPointerDrag } from "@/test-drag";
import {
  deckDragData,
  deckDraggable,
  readDeckDrag,
  useDeckDragging,
  useDeckDropTarget,
  type DeckDrag,
} from "./deckDrag";

const DECK: DeckDrag = { deckId: 12, name: "Burn" };
const CARD = { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" } as const;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function mountTile(payload: () => DeckDrag) {
  const element = boxed(document.createElement("div"), 0);
  const remove = document.createElement("button");
  remove.textContent = "Delete";
  remove.setAttribute("data-no-drag", "");
  element.append(remove);
  document.body.append(element);
  const stop = deckDraggable({ element, payload });
  undo.push(() => {
    stop();
    element.remove();
  });
  return { element, remove };
}

function mountDrawer(canDrop: (drag: DeckDrag) => boolean, onDrop: (drag: DeckDrag) => void) {
  const element = boxed(document.createElement("div"), 200);
  document.body.append(element);
  undo.push(() => element.remove());
  const ref = { current: element as HTMLElement | null };
  const view = renderHook(() => useDeckDropTarget({ ref, canDrop, onDrop }));
  return {
    element,
    get over() {
      return view.result.current;
    },
  };
}

describe("the deck drag", () => {
  /** The two fences, in both directions — the reason this module shares `dnd.ts`'s key rather
   *  than taking one of its own. */
  it("is refused by the card reader, and refuses a card", () => {
    expect(readDragData(deckDragData(DECK))).toBeNull();
    expect(readDeckDrag(dragData(CARD))).toBeNull();
  });

  it("files a deck into the drawer it was let go over", async () => {
    const onDrop = vi.fn();
    const drawer = mountDrawer(() => true, onDrop);
    // A second drawer the pointer never visits, so `over` is a claim about *this* drawer rather
    // than about a drag being in the air at all — which is what tells `over` from `armed`.
    const elsewhere = mountDrawer(() => true, vi.fn());
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    expect(drawer.over).toBe(true);
    expect(elsewhere.over).toBe(false);
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith(DECK);
  });

  /** The press guard, which is `NOT_A_DRAG`'s and is now the sensor's: a tile carries a Delete
   *  button, and a press on it plus five pixels of travel used to be a drag of the whole tile. */
  it("does not start from a press on the tile's own control", async () => {
    const { element, remove } = mountTile(() => DECK);
    const held = await startPointerDrag(element, { pressOn: remove });
    expect(held.started).toBe(false);
    await held.cancel();
  });

  /** Read at the press, so a tile renamed since it mounted carries what it is now. */
  it("carries the deck as it is at the press", async () => {
    let deck: DeckDrag = { ...DECK };
    const onDrop = vi.fn();
    const drawer = mountDrawer(() => true, onDrop);
    const { element } = mountTile(() => deck);

    deck = { deckId: 12, name: "Burn, renamed" };
    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith({ deckId: 12, name: "Burn, renamed" });
  });

  it("refuses on the drop a deck the drawer accepted on the way in", async () => {
    const onDrop = vi.fn();
    let takes = true;
    const drawer = mountDrawer(() => takes, onDrop);
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    takes = false;
    await held.drop();

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("stands down on Escape without writing", async () => {
    const onDrop = vi.fn();
    const drawer = mountDrawer(() => true, onDrop);
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    await held.cancel();

    expect(onDrop).not.toHaveBeenCalled();
    expect(drawer.over).toBe(false);
  });
});

describe("useDeckDragging", () => {
  it("answers the deck in the air and nothing for a card", async () => {
    const view = renderHook(() => useDeckDragging());
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    expect(view.result.current).toEqual(DECK);
    await held.cancel();
    expect(view.result.current).toBeNull();
  });
});
