import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestSeat } from "@/lib/ipc";
import { emptySeat, gameCard, hiddenCard } from "../table/fixtures";
import type { ZoneSize } from "../table/layout";
import { OpponentHand, OpponentLibrary, OpponentPile } from "./OpponentZones";

const SIZE: ZoneSize = { width: 72, height: 101, compact: true };

function seat(over: Partial<PlaytestSeat> = {}): PlaytestSeat {
  return emptySeat("opponent", { library: 52, ...over });
}

describe("OpponentLibrary", () => {
  it("is a back and a count while its top card is hidden", () => {
    const { container } = render(<OpponentLibrary seat={seat()} size={SIZE} />);
    expect(screen.getByRole("img", { name: "The opponent's library, 52 cards" })).toBeVisible();
    expect(container.querySelector("[data-back]")).not.toBeNull();
  });

  it("draws a revealed top card face up, pointed at for the preview (CR 401.5)", () => {
    const onPoint = vi.fn();
    const courser = gameCard("Forest");
    render(
      <OpponentLibrary
        seat={seat({ libraryTop: courser, libraryTopRevealed: true })}
        size={SIZE}
        onPoint={onPoint}
        onUnpoint={vi.fn()}
      />,
    );
    const library = screen.getByRole("img", {
      name: "The opponent's library, 52 cards; Forest on top, revealed",
    });
    expect(library.querySelector("[data-back]")).toBeNull();
    fireEvent.mouseEnter(library);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ card: courser, ids: [courser.id], place: "libraryTop" }),
    );
  });
});

describe("OpponentHand", () => {
  it("draws the known cards face up first and backs for the rest, all counted", () => {
    const onPoint = vi.fn();
    const bolt = gameCard("Lightning Bolt");
    const { container } = render(
      <OpponentHand count={4} cards={[bolt]} onPoint={onPoint} onUnpoint={vi.fn()} />,
    );
    expect(
      screen.getByRole("img", { name: "The opponent's hand, 4 cards; known: Lightning Bolt" }),
    ).toBeVisible();
    expect(screen.getByText("Hand · 4")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-back]")).toHaveLength(3);
    const known = container.querySelector(`[data-point="${bolt.id}"]`);
    expect(known).not.toBeNull();
    fireEvent.mouseEnter(known!);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        card: bolt,
        place: "hand",
        line: "Lightning Bolt · in the opponent's hand",
      }),
    );
  });

  it("is all backs when nothing of it is known", () => {
    const { container } = render(<OpponentHand count={3} />);
    expect(screen.getByRole("img", { name: "The opponent's hand, 3 cards" })).toBeVisible();
    expect(container.querySelectorAll("[data-back]")).toHaveLength(3);
  });

  it("names the known cards on a four-player area's single back", () => {
    const { container } = render(
      <OpponentHand
        count={2}
        cards={[gameCard("Counterspell")]}
        owner="Opponent 2's"
        size={SIZE}
      />,
    );
    expect(
      screen.getByRole("img", { name: "Opponent 2's hand, 2 cards; known: Counterspell" }),
    ).toBeVisible();
    expect(container.querySelectorAll("[data-back]")).toHaveLength(1);
  });
});

describe("OpponentPile", () => {
  it("draws a hidden face-down top card of their exile as a back, never pointed at (CR 708)", () => {
    const onPoint = vi.fn();
    render(
      <OpponentPile
        seat={seat({ exile: [gameCard("Counterspell"), hiddenCard()] })}
        zone="exile"
        size={SIZE}
        onPoint={onPoint}
        onUnpoint={vi.fn()}
        onLook={vi.fn()}
      />,
    );
    const pile = screen.getByRole("button", {
      name: "The opponent's exile, 2 cards; a face-down card on top. Click to look through it",
    });
    expect(pile.querySelector("[data-back]")).not.toBeNull();
    fireEvent.mouseEnter(pile);
    expect(onPoint).not.toHaveBeenCalled();
  });
});
