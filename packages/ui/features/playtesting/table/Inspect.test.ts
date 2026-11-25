import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameCard } from "@/lib/ipc";
import { gameCard } from "./fixtures";
import {
  INSPECT_DELAY,
  INSPECT_MAX,
  INSPECT_MIN,
  Inspect,
  changedStats,
  placePreview,
  shownName,
  wheelWidth,
} from "./Inspect";

describe("placePreview", () => {
  const box = { width: 1440, height: 900 };
  const size = { width: 336, height: 480 };

  it("opens below and right of the pointer", () => {
    expect(placePreview({ x: 100, y: 100 }, size, box)).toEqual({ left: 124, top: 124 });
  });

  it("flips left of the pointer at the right edge and stays inside the bottom", () => {
    const at = placePreview({ x: 1300, y: 800 }, size, box);
    expect(at.left).toBe(1300 - 24 - 336);
    expect(at.top + size.height).toBeLessThanOrEqual(box.height);
  });
});

describe("wheelWidth", () => {
  it("grows on a wheel up and shrinks on a wheel down, within the bounds", () => {
    expect(wheelWidth(320, -100)).toBeGreaterThan(320);
    expect(wheelWidth(320, 100)).toBeLessThan(320);
    expect(wheelWidth(INSPECT_MAX, -100)).toBe(INSPECT_MAX);
    expect(wheelWidth(INSPECT_MIN, 100)).toBe(INSPECT_MIN);
  });
});

describe("changedStats", () => {
  const pt = (
    power: number | null,
    toughness: number | null,
    basePower: number | null,
    baseToughness: number | null,
  ) => ({ power, toughness, basePower, baseToughness }) as GameCard;

  it("is nothing for a creature as printed, and for a non-creature", () => {
    expect(changedStats(pt(2, 2, 2, 2))).toBeNull();
    expect(changedStats(pt(null, null, null, null))).toBeNull();
  });

  it("gives both stats once either has moved, each with which way", () => {
    expect(changedStats(pt(4, 4, 2, 2))).toEqual({
      power: 4,
      toughness: 4,
      powerTone: "up",
      toughnessTone: "up",
    });
    expect(changedStats(pt(1, 3, 2, 3))).toEqual({
      power: 1,
      toughness: 3,
      powerTone: "down",
      toughnessTone: "same",
    });
  });

  it("marks a creature with no base as changed, neither up nor down", () => {
    expect(changedStats(pt(3, 3, null, null))).toEqual({
      power: 3,
      toughness: 3,
      powerTone: "same",
      toughnessTone: "same",
    });
  });
});

describe("Inspect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function open(card: GameCard) {
    render(
      createElement(Inspect, {
        pointed: {
          card,
          ids: [card.id],
          place: "battlefield",
          line: shownName(card),
          at: { x: 0, y: 0 },
        },
        width: 320,
        onResize: () => {},
      }),
    );
    act(() => {
      vi.advanceTimersByTime(INSPECT_DELAY);
    });
    return screen.getByTestId("card-inspect");
  }

  it("lists the rules' marks on the card under its caption, the damage in red", () => {
    open(gameCard("Grizzly Bears", { damage: 2, sick: true, chosen: ["Elf"], marks: ["goaded"] }));
    const lines = screen.getByTestId("card-state").querySelectorAll("li");
    expect(Array.from(lines, (li) => li.textContent)).toEqual([
      "2 damage marked",
      "Summoning sick",
      "Goaded",
      "Chosen: Elf",
    ]);
    expect(lines[0]).toHaveClass("text-destructive");
  });

  it("has no list for a card the rules have marked nothing on", () => {
    open(gameCard("Grizzly Bears"));
    expect(screen.queryByTestId("card-state")).toBeNull();
  });

  it("shows a face-down card the reader may not see as a card back, by what it is", () => {
    const preview = open(gameCard("", { faceDown: true, cardId: null }));
    expect(preview.querySelector("[data-face-down]")).not.toBeNull();
    expect(preview).toHaveTextContent("Face-down card");
  });
});

describe("shownName", () => {
  it("is the card's own name, or what a face-down card is", () => {
    expect(shownName(gameCard("Den Protector"))).toBe("Den Protector");
    expect(shownName(gameCard("", { faceDown: true, cardId: null }))).toBe("Face-down card");
  });
});
