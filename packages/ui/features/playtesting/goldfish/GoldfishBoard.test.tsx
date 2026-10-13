import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameCard, GoldfishView } from "@/lib/ipc";
import { GoldfishBoard } from "./GoldfishBoard";
import { INSPECT_DELAY } from "./Inspect";
import { discardView, gameCard, turnNineView } from "./fixtures";

function board(view: GoldfishView, onAct = vi.fn()) {
  return (
    <GoldfishBoard
      deckName="Kenrith"
      view={view}
      log={[]}
      error={null}
      onAct={onAct}
      onBack={vi.fn()}
      onNewGame={vi.fn()}
    />
  );
}

function table(battlefield: GameCard[]): GoldfishView {
  return { ...turnNineView(), battlefield };
}

const rest = (ms: number) => act(() => vi.advanceTimersByTime(ms));
const preview = () => screen.queryByTestId("goldfish-inspect");

describe("GoldfishBoard's inspect preview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens once the pointer has rested, closes at once, and waits again", () => {
    render(board(table([gameCard("Sol Ring")])));
    const ring = screen.getByRole("button", { name: "Sol Ring" });

    fireEvent.mouseEnter(ring);
    rest(INSPECT_DELAY - 1);
    expect(preview()).not.toBeInTheDocument();
    rest(1);
    expect(preview()).toBeInTheDocument();

    fireEvent.mouseLeave(ring);
    expect(preview()).not.toBeInTheDocument();

    fireEvent.mouseEnter(ring);
    rest(INSPECT_DELAY - 1);
    expect(preview()).not.toBeInTheDocument();
    rest(1);
    expect(preview()).toBeInTheDocument();
  });

  it("waits again on the next card, however soon the pointer reaches it", () => {
    render(board(table([gameCard("Sol Ring"), gameCard("Rhystic Study")])));
    const ring = screen.getByRole("button", { name: "Sol Ring" });
    const study = screen.getByRole("button", { name: "Rhystic Study" });

    fireEvent.mouseEnter(ring);
    rest(INSPECT_DELAY);
    expect(preview()).toBeInTheDocument();

    fireEvent.mouseLeave(ring);
    fireEvent.mouseEnter(study);
    expect(preview()).not.toBeInTheDocument();
    rest(INSPECT_DELAY);
    expect(preview()).toBeInTheDocument();
  });

  it("closes when the card is redrawn elsewhere and the pointer moves off where it was", () => {
    const first = gameCard("Forest");
    const second = gameCard("Forest", { tapped: true });
    const { rerender } = render(board(table([first, second])));
    const tapped = screen.getByRole("button", { name: "Forest, tapped" });

    fireEvent.mouseEnter(tapped);
    rest(INSPECT_DELAY);
    expect(preview()).toBeInTheDocument();

    // Untapped, it joins the other Forest's pile: its own element is gone without a `mouseleave`.
    rerender(board(table([first, { ...second, tapped: false }])));
    expect(tapped).not.toBeInTheDocument();
    fireEvent.pointerMove(screen.getByTestId("goldfish-board"));
    expect(preview()).not.toBeInTheDocument();
  });

  it("stays open while the pointer moves over the card it shows", () => {
    render(board(table([gameCard("Sol Ring")])));
    const ring = screen.getByRole("button", { name: "Sol Ring" });

    fireEvent.mouseEnter(ring);
    rest(INSPECT_DELAY);
    fireEvent.pointerMove(ring);
    expect(preview()).toBeInTheDocument();
  });
});

describe("GoldfishBoard's discard to hand size", () => {
  const dialog = () => screen.queryByRole("dialog", { name: "Discard to hand size" });

  it("asks which cards are discarded, and sends the reader's picks", () => {
    const view = discardView(1);
    const onAct = vi.fn();
    render(board(view, onAct));
    expect(dialog()).toBeInTheDocument();

    // The oldest card of the hand, where the engine's own answer was always the newest.
    const gone = view.hand[0];
    fireEvent.click(screen.getByRole("button", { name: gone.name }));
    fireEvent.click(screen.getByRole("button", { name: "Discard 1 and end the turn" }));
    expect(onAct).toHaveBeenCalledExactlyOnceWith({ type: "discard", ids: [gone.id] });
  });

  it("closes to show the table, and the turn's button and Space open it again", () => {
    const onAct = vi.fn();
    render(board(discardView(2), onAct));

    fireEvent.click(screen.getByRole("button", { name: "Close and look at the board" }));
    expect(dialog()).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Discard 2/ }));
    expect(dialog()).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close and look at the board" }));
    expect(dialog()).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: " " });
    expect(dialog()).toBeInTheDocument();
    // Neither is a pass of the turn: the game is still waiting on the discard.
    expect(onAct).not.toHaveBeenCalled();
  });

  it("does not ask while the hand is within its size", () => {
    render(board(turnNineView()));
    expect(dialog()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Next turn/ })).toBeInTheDocument();
  });
});
