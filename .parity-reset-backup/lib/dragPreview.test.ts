import { afterEach, describe, expect, it } from "vitest";
import { Draggable } from "@dnd-kit/dom";
import { dragData } from "@/features/decks/dnd";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { boxed, startPointerDrag } from "@/test-drag";
import { CARD_COUNT_CHIP, cardCountLabel } from "./dragPreview";

/**
 * The count chip a multi-card drag carries — issue #214.
 *
 * What can be checked here is the **decision**, the words and where the chip is put: whether one
 * is drawn at all, what it says, and that it follows the pointer. What it *looks* like cannot
 * be — jsdom has no layout engine and applies no stylesheet — and that is the live pass's.
 */

describe("cardCountLabel", () => {
  it("pluralises", () => {
    expect(cardCountLabel(1)).toBe("1 card");
    expect(cardCountLabel(4)).toBe("4 cards");
  });
});

/* ------------------------------------------------------------------ the manager's chip ------ */

const CARDS = [
  { kind: "card", cardId: "a", name: "Sol Ring", typeLine: "Artifact" },
  { kind: "card", cardId: "b", name: "Arcane Signet", typeLine: "Artifact" },
  { kind: "card", cardId: "c", name: "Mind Stone", typeLine: "Artifact" },
] as const;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function mountSource(record: Record<string, unknown>): HTMLElement {
  const element = boxed(document.createElement("div"), 0);
  element.textContent = "a card";
  document.body.append(element);
  const draggable = new Draggable(
    { id: dndId("chip-test"), element, data: record, register: false },
    dndManager,
  );
  registerNow(draggable);
  undo.push(() => {
    draggable.destroy();
    element.remove();
  });
  return element;
}

const chip = () => document.querySelector<HTMLElement>(`[${CARD_COUNT_CHIP}]`);

describe("the multi-card count chip", () => {
  it("draws nothing for a single-card drag", async () => {
    const held = await startPointerDrag(mountSource(dragData(CARDS[0])));
    expect(chip()).toBeNull();
    await held.cancel();
  });

  it("draws the count for a drag carrying more than one", async () => {
    const held = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1], CARDS[2]])));
    expect(chip()?.textContent).toBe(cardCountLabel(3));
    await held.cancel();
  });

  it("draws nothing for a drag that is not this app's card drag", async () => {
    const held = await startPointerDrag(mountSource({ folderSource: "something else" }));
    expect(chip()).toBeNull();
    await held.cancel();
  });

  /** It has to travel: a chip pinned where the drag began says nothing about where the cards are
   *  going, which is the one moment the reader can still change their mind. */
  it("follows the pointer", async () => {
    const held = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1]])));
    await held.moveTo(400, 300);
    const at = chip();
    expect(at?.style.left).toBe("412px");
    expect(at?.style.top).toBe("312px");
    await held.cancel();
  });

  it("is gone when the drag ends, dropped or cancelled", async () => {
    const dropped = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1]])));
    await dropped.drop();
    expect(chip()).toBeNull();

    const cancelled = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1]])));
    await cancelled.cancel();
    expect(chip()).toBeNull();
  });
});
