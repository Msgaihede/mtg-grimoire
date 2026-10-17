import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestAction, PlaytestSeat } from "@/lib/ipc";
import { gameCard, playLocally, turnNineSeat } from "./fixtures";
import { LibraryDialog } from "./LibraryDialog";
import type { ZoneLook } from "./types";

/** Six cards of six names, top first, so every card's group is named once. */
const NAMES = ["Forest", "Island", "Sol Ring", "Counterspell", "Rhystic Study", "Tarmogoyf"];

function tableView(): PlaytestSeat {
  const libraryCards = NAMES.map((n) => gameCard(n));
  return {
    ...turnNineSeat(),
    libraryCards,
    library: libraryCards.length,
    graveyard: [gameCard("Swords to Plowshares"), gameCard("Llanowar Elves")],
    exile: [],
  };
}

/**
 * The dialog over a view that answers its actions, the way the board's page does: each action
 * comes back as a new view with a new id for the card that moved — which is what the dialog must
 * read from rather than from what it was opened with.
 */
function Harness({
  look,
  initial,
  onAct,
  readOnly,
}: {
  look: ZoneLook;
  initial: PlaytestSeat;
  onAct: (a: PlaytestAction) => void;
  readOnly?: boolean;
}) {
  const [view, setView] = useState(initial);
  return (
    <LibraryDialog
      look={look}
      view={view}
      readOnly={readOnly}
      onAct={(a) => {
        onAct(a);
        setView((v) => playLocally(v, a));
      }}
      onClose={() => {}}
    />
  );
}

function open(look: ZoneLook, view = tableView(), readOnly = false) {
  const onAct = vi.fn();
  render(<Harness look={look} initial={view} onAct={onAct} readOnly={readOnly} />);
  const shown = () => screen.queryAllByRole("group").map((g) => g.getAttribute("aria-label"));
  return { onAct, shown, view };
}

describe("LibraryDialog", () => {
  it("shows the top N of the library, top first", () => {
    const { shown } = open({ zone: "library", mode: "look", count: 3 });
    expect(screen.getByRole("heading", { name: "The top 3 of your library" })).toBeInTheDocument();
    expect(shown()).toEqual(["Forest", "Island", "Sol Ring"]);
  });

  it("scries a card to the bottom and closes the window behind it", async () => {
    const { onAct, shown, view } = open({ zone: "library", mode: "scry", count: 2 });
    expect(screen.getByRole("heading", { name: "Scry 2" })).toBeInTheDocument();
    const forest = within(screen.getByRole("group", { name: "Forest" }));
    expect(forest.getAllByRole("button").map((b) => b.textContent)).toEqual(["Top", "Bottom"]);

    await userEvent.click(forest.getByRole("button", { name: "Bottom" }));
    expect(onAct).toHaveBeenLastCalledWith({
      type: "move",
      id: view.libraryCards[0].id,
      to: "libraryBottom",
    });
    // The third card does not slide into a scry of two.
    expect(shown()).toEqual(["Island"]);

    // The view after the move has Island at the top, and the button acts on that view's id.
    await userEvent.click(
      within(screen.getByRole("group", { name: "Island" })).getByRole("button", { name: "Bottom" }),
    );
    expect(onAct).toHaveBeenLastCalledWith({
      type: "move",
      id: view.libraryCards[1].id,
      to: "libraryBottom",
    });
    expect(shown()).toEqual([]);
    expect(screen.getByText("Nothing left to look at.")).toBeInTheDocument();
  });

  it("keeps a card sent back to the top inside the window", async () => {
    const { onAct, shown } = open({ zone: "library", mode: "surveil", count: 2 });
    const island = within(screen.getByRole("group", { name: "Island" }));
    expect(island.getAllByRole("button").map((b) => b.textContent)).toEqual(["Top", "Graveyard"]);

    await userEvent.click(island.getByRole("button", { name: "Top" }));
    expect(onAct).toHaveBeenLastCalledWith(expect.objectContaining({ to: "libraryTop" }));
    expect(shown()).toEqual(["Island", "Forest"]);
  });

  it("searches the whole library by name, and shuffles on the way out", async () => {
    const { onAct, shown, view } = open({ zone: "library", mode: "search", count: "all" });
    expect(shown()).toEqual(NAMES);

    await userEvent.type(screen.getByRole("textbox", { name: "Find a card by name" }), "RING");
    expect(shown()).toEqual(["Sol Ring"]);

    const ring = within(screen.getByRole("group", { name: "Sol Ring" }));
    expect(ring.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Hand",
      "Battlefield",
      "Graveyard",
      "Exile",
      "Top",
    ]);
    await userEvent.click(ring.getByRole("button", { name: "Battlefield" }));
    expect(onAct).toHaveBeenLastCalledWith({
      type: "move",
      id: view.libraryCards[2].id,
      to: "battlefield",
    });
    expect(shown()).toEqual([]);

    await userEvent.click(screen.getByRole("button", { name: "Shuffle" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "shuffle" });
    // Still open: a tutor's card can go on top after the shuffle.
    expect(screen.getByRole("heading", { name: "Search your library" })).toBeInTheDocument();
  });

  it("browses the graveyard newest first, without a way to put a card where it already is", () => {
    const { shown } = open({ zone: "graveyard", mode: "browse", count: "all" });
    expect(screen.getByRole("heading", { name: "Your graveyard" })).toBeInTheDocument();
    expect(shown()).toEqual(["Llanowar Elves", "Swords to Plowshares"]);
    const elves = within(screen.getByRole("group", { name: "Llanowar Elves" }));
    expect(elves.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Hand",
      "Battlefield",
      "Exile",
      "Top",
      "Bottom",
    ]);
  });

  it("is a look and nothing more with the sandbox's moves not working", () => {
    const { shown } = open({ zone: "graveyard", mode: "browse", count: "all" }, tableView(), true);
    expect(shown()).toEqual(["Llanowar Elves", "Swords to Plowshares"]);
    const elves = within(screen.getByRole("group", { name: "Llanowar Elves" }));
    expect(elves.queryAllByRole("button")).toEqual([]);
    expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument();
  });

  it("casts a foretold card from exile by the rules, even as a look", async () => {
    const behold = gameCard("Behold the Multiverse", { foretold: true, castable: true });
    const view = { ...tableView(), exile: [behold, gameCard("Swords to Plowshares")] };
    const { onAct } = open({ zone: "exile", mode: "browse", count: "all" }, view, true);
    const card = within(screen.getByRole("group", { name: "Behold the Multiverse" }));
    expect(card.getByText("Foretold")).toBeInTheDocument();
    await userEvent.click(card.getByRole("button", { name: "Cast" }));
    expect(onAct).toHaveBeenCalledWith({ type: "play", id: behold.id });
    // A card the rules do not let the reader cast from exile has nothing to press.
    const swords = within(screen.getByRole("group", { name: "Swords to Plowshares" }));
    expect(swords.queryAllByRole("button")).toEqual([]);
  });
});
