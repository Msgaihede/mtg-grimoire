import { afterEach, describe, expect, it, vi } from "vitest";
import { Draggable } from "@dnd-kit/dom";
import { dragData } from "@/features/decks/dnd";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { boxed, startPointerDrag } from "@/test-drag";
import { CARD_COUNT_CHIP, cardCountLabel, setCardCountPreview } from "./dragPreview";

/**
 * The count chip a multi-card drag carries — issue #214.
 *
 * What can be checked here is the **decision** and the words: whether a chip is drawn at all, and
 * what it says. What it looks like cannot be — jsdom has no layout engine, and the chip is
 * rendered into a container the library appends to `document.body` for a single frame so the
 * browser can photograph it. That frame is the live pass's to look at.
 */
afterEach(() => {
  // The library appends its container to the body and removes it on `dragstart`/`drop`, neither
  // of which happens here — so each call leaves one behind.
  document.body.innerHTML = "";
});

describe("cardCountLabel", () => {
  it("pluralises", () => {
    expect(cardCountLabel(1)).toBe("1 card");
    expect(cardCountLabel(4)).toBe("4 cards");
  });
});

describe("setCardCountPreview", () => {
  /**
   * **A single-card drag keeps the native preview**, which is a picture of the card and better
   * than any chip could be. Declining is not calling `nativeSetDragImage` at all, which is the
   * documented way to leave the browser's own ghost alone.
   */
  it("draws nothing for a drag carrying one card", () => {
    const native = vi.fn();
    setCardCountPreview(1, native);
    expect(native).not.toHaveBeenCalled();
    expect(document.body.textContent).toBe("");
  });

  it("draws nothing for a drag carrying none", () => {
    const native = vi.fn();
    setCardCountPreview(0, native);
    expect(native).not.toHaveBeenCalled();
  });

  it("renders the count for a group", () => {
    setCardCountPreview(3, vi.fn());
    expect(document.body.textContent).toContain("3 cards");
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
