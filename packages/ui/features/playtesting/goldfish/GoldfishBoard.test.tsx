import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameCard, GoldfishView } from "@/lib/ipc";
import { GoldfishBoard } from "./GoldfishBoard";
import { INSPECT_DELAY } from "./Inspect";
import { gameCard, turnNineView } from "./fixtures";

function board(view: GoldfishView) {
  return (
    <GoldfishBoard
      deckName="Kenrith"
      view={view}
      log={[]}
      error={null}
      onAct={vi.fn()}
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

  it.each([
    ["the command zone", /in the command zone/],
    ["the graveyard", /^Graveyard, /],
    ["exile", /^Exile, /],
  ])("closes at once when the pointer leaves a card in %s", (_zone, name) => {
    const view: GoldfishView = {
      ...turnNineView(),
      command: [gameCard("Kenrith, the Returned King", { isCommander: true })],
      exile: [gameCard("Counterspell")],
    };
    render(board(view));
    const card = screen.getByRole("button", { name });

    fireEvent.mouseEnter(card);
    rest(INSPECT_DELAY);
    expect(preview()).toBeInTheDocument();

    fireEvent.mouseLeave(card);
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
