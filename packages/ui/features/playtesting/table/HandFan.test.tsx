import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameCard } from "@/lib/ipc";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { startPointerDrag } from "@/test-drag";
import { gameCard } from "./fixtures";
import { HandFan } from "./HandFan";
import { HAND_CARD_H, HAND_CARD_W, handRow } from "./layout";

/** Four cards that are not lands, so the hand is held in the order they come. */
function four(): GameCard[] {
  return ["Alpha", "Bravo", "Charlie", "Delta"].map((name) => gameCard(name));
}

function setup(cards: GameCard[], { sandbox = false }: { sandbox?: boolean } = {}) {
  const onAct = vi.fn();
  const onDrop = vi.fn();
  const view = (next: GameCard[]) => (
    <ContextMenuProvider>
      <HandFan
        cards={next}
        sandbox={sandbox}
        onAct={onAct}
        onDrop={onDrop}
        onPoint={vi.fn()}
        onUnpoint={vi.fn()}
        pointedId={null}
      />
    </ContextMenuProvider>
  );
  const { rerender } = render(view(cards));
  return { onAct, onDrop, rerender: (next: GameCard[]) => rerender(view(next)) };
}

const hand = () => screen.getByRole("region", { name: "Hand" });
const cardOf = (name: string) =>
  within(hand()).getByRole("button", { name: new RegExp(`^${name}\\.`) });
/** The hand's names, left to right. */
const held = () =>
  within(hand())
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label")?.split(".")[0]);

/** A box in the window, since jsdom lays nothing out and dnd-kit hit-tests by coordinate. */
function box(element: Element, left: number, top: number, width: number, height: number): void {
  element.getBoundingClientRect = () =>
    ({
      x: left,
      y: top,
      left,
      top,
      right: left + width,
      bottom: top + height,
      width,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
}

describe("HandFan's order (issue #1330)", () => {
  it("moves a focused card one place with Shift+arrow, asking the game nothing", () => {
    const { onAct } = setup(four());
    const alpha = cardOf("Alpha");

    fireEvent.keyDown(alpha, { key: "ArrowRight", shiftKey: true });
    expect(held()).toEqual(["Bravo", "Alpha", "Charlie", "Delta"]);
    fireEvent.keyDown(cardOf("Alpha"), { key: "ArrowRight", shiftKey: true });
    expect(held()).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
    fireEvent.keyDown(cardOf("Alpha"), { key: "ArrowLeft", shiftKey: true });
    expect(held()).toEqual(["Bravo", "Alpha", "Charlie", "Delta"]);

    expect(onAct).not.toHaveBeenCalled();
  });

  it("stops at either end, and leaves a plain or Alt arrow alone", () => {
    setup(four());
    fireEvent.keyDown(cardOf("Alpha"), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(cardOf("Delta"), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cardOf("Bravo"), { key: "ArrowRight" });
    fireEvent.keyDown(cardOf("Bravo"), { key: "ArrowRight", altKey: true });
    expect(held()).toEqual(["Alpha", "Bravo", "Charlie", "Delta"]);
  });

  it("keeps the reader's order when a card is drawn or played", () => {
    const cards = four();
    const { rerender } = setup(cards);
    fireEvent.keyDown(cardOf("Delta"), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(cardOf("Delta"), { key: "ArrowLeft", shiftKey: true });
    fireEvent.keyDown(cardOf("Delta"), { key: "ArrowLeft", shiftKey: true });
    expect(held()).toEqual(["Delta", "Alpha", "Bravo", "Charlie"]);

    const [, bravo, charlie, delta] = cards;
    rerender([bravo, charlie, delta, gameCard("Echo")]);
    expect(held()).toEqual(["Delta", "Bravo", "Charlie", "Echo"]);
  });

  it("puts a card dragged within the hand in the slot it is let go over, sandbox off", async () => {
    const { onAct, onDrop } = setup(four());
    const row = handRow(4);
    const left = 100;
    const top = 500;
    const band = hand();
    box(band, 0, top, row.width + 2 * left, row.height);
    box(band.firstElementChild as Element, left, top, row.width, row.height);
    for (const [i, name] of ["Alpha", "Bravo", "Charlie", "Delta"].entries()) {
      box(cardOf(name), left + row.lefts[i], top + row.restTop, HAND_CARD_W, HAND_CARD_H);
    }

    const drag = await startPointerDrag(cardOf("Alpha"));
    await drag.moveTo(left + row.lefts[2] + HAND_CARD_W / 2 + 10, top + row.restTop + 40);
    await drag.drop();
    await act(async () => {});

    expect(held()).toEqual(["Bravo", "Charlie", "Alpha", "Delta"]);
    expect(onDrop).toHaveBeenCalledWith(expect.objectContaining({ from: "hand" }), "hand");
    expect(onAct).not.toHaveBeenCalled();
  });
});
