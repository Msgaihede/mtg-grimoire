import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameCard, GoldfishView } from "@/lib/ipc";
import { manaTable } from "./fixtures";
import { CommandZone, ExileZone, GraveyardZone, LibraryZone } from "./ZonePile";

let next = 1;
function card(name: string, over: Partial<GameCard> = {}): GameCard {
  return {
    id: next++,
    cardId: `p-${name}`,
    name,
    typeLine: "",
    lane: "creature",
    manaValue: 0,
    isLand: false,
    isToken: false,
    isCommander: false,
    tapped: false,
    counters: [],
    power: null,
    toughness: null,
    tax: 0,
    ...over,
  };
}

function view(over: Partial<GoldfishView> = {}): GoldfishView {
  return {
    stage: "playing",
    turn: 3,
    mulligan: null,
    discard: 0,
    life: 40,
    opponentLife: 40,
    hand: [],
    battlefield: [],
    graveyard: [],
    exile: [],
    command: [],
    library: 76,
    libraryCards: [],
    libraryLands: 30,
    manaOpen: 0,
    mana: manaTable(),
    tokens: [],
    ...over,
  };
}

const quiet = { onDrop: vi.fn(), onPoint: vi.fn(), onUnpoint: vi.fn() };

describe("LibraryZone", () => {
  it("draws a card on a click", () => {
    const onAct = vi.fn();
    render(<LibraryZone view={view()} onAct={onAct} onDrop={vi.fn()} onLook={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Library, 76 cards. Click to draw; right-click for more",
      }),
    );
    expect(onAct).toHaveBeenCalledWith({ type: "draw", count: 1 });
    expect(screen.getByText("Library · 76")).toBeInTheDocument();
  });

  it("offers nothing while a game is being dealt", () => {
    render(<LibraryZone view={null} onAct={vi.fn()} onDrop={vi.fn()} onLook={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Library, 0 cards/ })).toBeDisabled();
    expect(screen.getByText("Library · 0")).toBeInTheDocument();
  });
});

describe("CommandZone", () => {
  it("shows the commander and the tax its next cast costs", () => {
    const onAct = vi.fn();
    const kenrith = card("Kenrith", { isCommander: true, tax: 2 });
    render(<CommandZone view={view({ command: [kenrith] })} onAct={onAct} {...quiet} />);
    expect(screen.getByText(/Command · tax/)).toHaveTextContent("Command · tax 2");
    fireEvent.doubleClick(
      screen.getByRole("button", {
        name: "Kenrith in the command zone. Double-click or drag to cast",
      }),
    );
    expect(onAct).toHaveBeenCalledWith({ type: "play", id: kenrith.id });
  });

  it("keeps showing the tax while the commander is on the battlefield", () => {
    const kenrith = card("Kenrith", { isCommander: true, tax: 4 });
    render(<CommandZone view={view({ battlefield: [kenrith] })} onAct={vi.fn()} {...quiet} />);
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText(/Command · tax/)).toHaveTextContent("Command · tax 4");
  });

  it("draws its empty slot with no game", () => {
    render(<CommandZone view={null} onAct={vi.fn()} {...quiet} />);
    expect(screen.getByText("Command")).toBeInTheDocument();
    expect(screen.getByText(/Command · tax/)).toHaveTextContent("Command · tax 0");
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("ExileZone and GraveyardZone", () => {
  it("draw their empty slots, counted at nothing", () => {
    render(
      <>
        <ExileZone view={view()} onLook={vi.fn()} {...quiet} />
        <GraveyardZone view={null} onLook={vi.fn()} {...quiet} />
      </>,
    );
    expect(screen.getByText("Exile")).toBeInTheDocument();
    expect(screen.getByText("Exile · 0")).toBeInTheDocument();
    expect(screen.getByText("Graveyard")).toBeInTheDocument();
    expect(screen.getByText("Graveyard · 0")).toBeInTheDocument();
  });

  it("show the last card on top, and open the whole zone on a right-click", () => {
    const onLook = vi.fn();
    const graveyard = [card("Fabled Passage"), card("Swords to Plowshares")];
    render(<GraveyardZone view={view({ graveyard })} onLook={onLook} {...quiet} />);
    expect(screen.getByText("Graveyard · 2")).toBeInTheDocument();
    const top = screen.getByRole("button", { name: /Swords to Plowshares on top/ });
    fireEvent.contextMenu(top);
    expect(onLook).toHaveBeenCalledWith({ zone: "graveyard", mode: "browse", count: "all" });
  });
});
