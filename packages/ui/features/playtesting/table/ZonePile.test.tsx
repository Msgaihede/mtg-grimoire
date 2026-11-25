import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GameCard, PlaytestSeat } from "@/lib/ipc";
import { emptySeat, hiddenCard } from "./fixtures";
import { CASTABLE_RING, CommandZone, ExileZone, GraveyardZone, LibraryZone } from "./ZonePile";

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
    effects: [],
    power: null,
    toughness: null,
    basePower: null,
    baseToughness: null,
    tax: 0,
    attachedTo: null,
    foretold: false,
    faceDown: false,
    damage: 0,
    sick: false,
    phasedOut: false,
    classLevel: null,
    chosen: [],
    marks: [],
    canForetell: false,
    canActivate: false,
    castable: false,
    canTapForMana: false,
    gaps: [],
    ...over,
  };
}

function view(over: Partial<PlaytestSeat> = {}): PlaytestSeat {
  return emptySeat("you", { library: 76, ...over });
}

const quiet = { sandbox: true, onDrop: vi.fn(), onPoint: vi.fn(), onUnpoint: vi.fn() };

describe("LibraryZone", () => {
  it("draws a card on a click", () => {
    const onAct = vi.fn();
    render(<LibraryZone view={view()} sandbox onAct={onAct} onDrop={vi.fn()} onLook={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Library, 76 cards. Click to draw; right-click for more",
      }),
    );
    expect(onAct).toHaveBeenCalledWith({ type: "draw", count: 1 });
    expect(screen.getByText("Library · 76")).toBeInTheDocument();
  });

  it("offers nothing while a game is being dealt", () => {
    render(<LibraryZone view={null} sandbox onAct={vi.fn()} onDrop={vi.fn()} onLook={vi.fn()} />);
    expect(screen.getByRole("button", { name: /^Library, 0 cards/ })).toBeDisabled();
    expect(screen.getByText("Library · 0")).toBeInTheDocument();
  });

  it("is a pile and a count with the sandbox off: no draw, no menu", () => {
    const onAct = vi.fn();
    render(
      <LibraryZone view={view()} sandbox={false} onAct={onAct} onDrop={vi.fn()} onLook={vi.fn()} />,
    );
    const pile = screen.getByRole("button", { name: "Library, 76 cards" });
    expect(pile).toBeDisabled();
    fireEvent.click(pile);
    fireEvent.contextMenu(pile);
    expect(onAct).not.toHaveBeenCalled();
  });

  it("draws the top card face up and points at it while the reader may see it (issue #1722)", () => {
    const top = card("Grizzly Bears");
    const onPoint = vi.fn();
    const { container } = render(
      <LibraryZone
        view={view({ libraryCards: [top], libraryTop: top })}
        sandbox={false}
        onAct={vi.fn()}
        onDrop={vi.fn()}
        onLook={vi.fn()}
        onPoint={onPoint}
        onUnpoint={vi.fn()}
      />,
    );
    const pile = screen.getByRole("button", {
      name: "Library, 76 cards; Grizzly Bears on top, which only you see",
    });
    // The card's face, not the pile's back; the only icon is the "you look at it" chip's.
    expect(pile.querySelector("img")).not.toBeNull();
    expect(pile.querySelector("svg.lucide-eye-off")).not.toBeNull();
    fireEvent.mouseEnter(container.querySelector(`[data-point="${top.id}"]`)!);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ card: top, ids: [top.id], place: "libraryTop" }),
    );
  });

  it("stays face down without a top to show", () => {
    const onPoint = vi.fn();
    const { container } = render(
      <LibraryZone
        view={view({ libraryCards: [card("Forest")] })}
        sandbox
        onAct={vi.fn()}
        onDrop={vi.fn()}
        onLook={vi.fn()}
        onPoint={onPoint}
        onUnpoint={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", {
        name: "Library, 76 cards. Click to draw; right-click for more",
      }),
    ).toBeInTheDocument();
    expect(container.querySelector("[data-point]")).toBeNull();
  });
});

describe("LibraryZone's top card (CR 401.5)", () => {
  function setup(over: Partial<PlaytestSeat>, sandbox = false) {
    const onAct = vi.fn();
    const onPoint = vi.fn();
    render(
      <LibraryZone
        view={view(over)}
        sandbox={sandbox}
        onAct={onAct}
        onDrop={vi.fn()}
        onLook={vi.fn()}
        onPoint={onPoint}
        onUnpoint={vi.fn()}
      />,
    );
    return { onAct, onPoint, pile: screen.getByRole("button", { name: /^Library, 76 cards/ }) };
  }

  it("draws the top card the reader looks at face up, said to be theirs alone", () => {
    const elves = card("Llanowar Elves");
    const { pile, onAct, onPoint } = setup({ libraryTop: elves });
    expect(pile).toHaveAccessibleName(
      "Library, 76 cards; Llanowar Elves on top, which only you see",
    );
    expect(pile).toBeEnabled();
    expect(screen.getByTestId("library-top-chip")).toHaveTextContent("You look at it");
    expect(pile.querySelector("img")).not.toBeNull();
    fireEvent.mouseEnter(pile);
    expect(onPoint).toHaveBeenCalledWith(
      expect.objectContaining({ card: elves, ids: [elves.id], place: "libraryTop" }),
    );
    // Seen but not playable, and no sandbox: a double-click or a click does nothing.
    fireEvent.doubleClick(pile);
    fireEvent.click(pile);
    expect(onAct).not.toHaveBeenCalled();
    expect(pile.className).not.toContain(CASTABLE_RING);
  });

  it("says when the top card is revealed to every player (Courser of Kruphix)", () => {
    const { pile } = setup({ libraryTop: card("Forest"), libraryTopRevealed: true });
    expect(pile).toHaveAccessibleName("Library, 76 cards; Forest on top, revealed");
    expect(screen.getByTestId("library-top-chip")).toHaveTextContent("Revealed");
  });

  it("casts a castable top card on a double-click with the sandbox off (Future Sight)", () => {
    const elves = card("Llanowar Elves", { castable: true });
    const { pile, onAct } = setup({ libraryTop: elves });
    expect(pile).toHaveAccessibleName(
      "Library, 76 cards; Llanowar Elves on top, which only you see. Double-click to cast it",
    );
    expect(pile.className).toContain(CASTABLE_RING);
    fireEvent.doubleClick(pile);
    expect(onAct).toHaveBeenCalledWith({ type: "play", id: elves.id });
    // Enter on the focused pile is the keyboard's double-click: a click with no `detail`.
    onAct.mockClear();
    fireEvent.click(pile, { detail: 0 });
    expect(onAct).toHaveBeenCalledWith({ type: "play", id: elves.id });
  });

  it("activates a top card's ability that works from there (plot)", () => {
    const plotted = card("Slickshot Show-Off", { canActivate: true });
    const { pile, onAct } = setup({ libraryTop: plotted });
    expect(pile).toHaveAccessibleName(/Double-click to activate it$/);
    fireEvent.doubleClick(pile);
    expect(onAct).toHaveBeenCalledWith({ type: "activate", id: plotted.id });
  });

  it("draws nothing on a click while the top card can be played, sandbox or not", () => {
    // A double-click is two clicks first: drawing on each would play a different card.
    const elves = card("Llanowar Elves", { castable: true });
    const { pile, onAct } = setup({ libraryTop: elves }, true);
    expect(pile).toHaveAccessibleName(/Double-click to cast it; right-click for more$/);
    fireEvent.click(pile, { detail: 1 });
    expect(onAct).not.toHaveBeenCalled();
  });

  it("still draws on a click with the sandbox on when the top card cannot be played", () => {
    const { pile, onAct } = setup({ libraryTop: card("Forest") }, true);
    fireEvent.click(pile, { detail: 1 });
    expect(onAct).toHaveBeenCalledWith({ type: "draw", count: 1 });
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

  it("casts with the sandbox off too: a cast is the rules'", () => {
    const onAct = vi.fn();
    const kenrith = card("Kenrith", { isCommander: true });
    render(
      <CommandZone view={view({ command: [kenrith] })} onAct={onAct} {...quiet} sandbox={false} />,
    );
    fireEvent.doubleClick(screen.getByRole("button", { name: /^Kenrith in the command zone/ }));
    expect(onAct).toHaveBeenCalledWith({ type: "play", id: kenrith.id });
  });

  it("rings a commander the rules let the reader cast, and not one they do not", () => {
    const kenrith = card("Kenrith", { isCommander: true, castable: true });
    const { rerender } = render(
      <CommandZone view={view({ command: [kenrith] })} onAct={vi.fn()} {...quiet} />,
    );
    const button = () => screen.getByRole("button", { name: /^Kenrith in the command zone/ });
    expect(button().className).toContain(CASTABLE_RING);
    rerender(
      <CommandZone
        view={view({ command: [{ ...kenrith, castable: false }] })}
        onAct={vi.fn()}
        {...quiet}
      />,
    );
    expect(button().className).not.toContain(CASTABLE_RING);
  });

  it("activates commander ninjutsu on a double-click when only the ability works (CR 702.49d)", () => {
    const onAct = vi.fn();
    const yuriko = card("Yuriko", { isCommander: true, canActivate: true });
    render(
      <CommandZone view={view({ command: [yuriko] })} onAct={onAct} {...quiet} sandbox={false} />,
    );
    const button = screen.getByRole("button", {
      name: "Yuriko in the command zone. Double-click to activate",
    });
    expect(button.className).toContain(CASTABLE_RING);
    fireEvent.doubleClick(button);
    expect(onAct).toHaveBeenCalledWith({ type: "activate", id: yuriko.id });
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

  it("draw a hidden face-down card on top as a back, counted, never named or pointed at", () => {
    const onPoint = vi.fn();
    const exile = [card("Swords to Plowshares"), hiddenCard()];
    render(<ExileZone view={view({ exile })} onLook={vi.fn()} {...quiet} onPoint={onPoint} />);
    expect(screen.getByText("Exile · 2")).toBeInTheDocument();
    const top = screen.getByRole("button", {
      name: "Exile, 2 cards; a face-down card on top. Click to look through it",
    });
    expect(top.querySelector("[data-back]")).not.toBeNull();
    expect(top.querySelector("img")).toBeNull();
    fireEvent.mouseEnter(top);
    expect(onPoint).not.toHaveBeenCalled();
  });

  it("ring a top card the rules let the reader cast from there (flashback)", () => {
    const graveyard = [card("Fabled Passage"), card("Think Twice", { castable: true })];
    render(<GraveyardZone view={view({ graveyard })} onLook={vi.fn()} {...quiet} />);
    expect(screen.getByRole("button", { name: /Think Twice on top/ }).className).toContain(
      CASTABLE_RING,
    );
  });
});
