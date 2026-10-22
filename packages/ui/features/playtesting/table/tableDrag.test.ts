import { afterEach, describe, expect, it } from "vitest";
import { boxed, startPointerDrag } from "@/test-drag";
import { tableDraggable } from "./tableDrag";

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.body.replaceChildren();
});

/** A pile with an attachment: the box is the source, the card's own button its handle. */
function mountPile(): { pile: HTMLDivElement; card: HTMLButtonElement } {
  const pile = boxed(document.createElement("div"), 0);
  const card = boxed(document.createElement("button"), 0);
  pile.append(card);
  document.body.append(pile);
  cleanups.push(
    tableDraggable({
      element: pile,
      handle: card,
      payload: () => ({ ids: [1], from: "battlefield", name: "Vampire Interloper" }),
    }),
  );
  return { pile, card };
}

describe("tableDraggable", () => {
  /**
   * Issue #1364: dnd-kit drops its activation constraints for a press inside a declared handle,
   * so a click on a card with an attachment was a zero-pixel drag and never a click — the
   * creature wearing a Role could not be declared as an attacker.
   */
  it("needs travel before a press on the handle becomes a drag", async () => {
    const { pile, card } = mountPile();

    // The press lands at the pile's centre, (100, 20): 3px and then 20px of travel.
    const held = await startPointerDrag(pile, { pressOn: card, move: false });
    expect(held.started).toBe(false);
    await held.moveTo(103, 20);
    expect(held.started).toBe(false);
    await held.moveTo(120, 20);
    expect(held.started).toBe(true);
    await held.cancel();
  });
});
