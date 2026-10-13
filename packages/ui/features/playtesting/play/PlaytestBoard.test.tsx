import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PlaytestView } from "@/lib/ipc";
import { goldfishDraggable } from "../goldfish/goldfishDrag";
import {
  attackStep,
  blockStep,
  combatArrowsView,
  gameOver,
  respondStep,
  targetPrompt,
  turnFive,
} from "./fixtures";
import { PlaytestBoard } from "./PlaytestBoard";

// Spied, not replaced: the board's cards still register as the goldfish's do, and the test can
// ask which ones did.
vi.mock("../goldfish/goldfishDrag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../goldfish/goldfishDrag")>();
  return { ...actual, goldfishDraggable: vi.fn(actual.goldfishDraggable) };
});

function setup(view: PlaytestView | null, { busy = false, replaying = false } = {}) {
  const onAct = vi.fn();
  const onBack = vi.fn();
  const onNewGame = vi.fn();
  const onSkip = vi.fn();
  render(
    <PlaytestBoard
      deckName="Simic Tempo"
      opponentName="Boros Aggro"
      view={view}
      log={[]}
      error={null}
      busy={busy}
      onAct={onAct}
      onBack={onBack}
      onNewGame={onNewGame}
      replaying={replaying}
      onSkip={onSkip}
    />,
  );
  return { onAct, onBack, onNewGame, onSkip };
}

const yours = () => screen.getByRole("region", { name: "Your battlefield" });
const theirs = () => screen.getByRole("region", { name: "The opponent's battlefield" });

describe("PlaytestBoard's stage button", () => {
  it("goes to combat or ends the turn in the first main phase, and Space presses the first", () => {
    const { onAct } = setup(turnFive().view);
    expect(screen.getByRole("group", { name: "Turn 5 · Your main phase" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /To combat/ }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "pass" });
    fireEvent.click(screen.getByRole("button", { name: "End turn" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "endTurn" });
    onAct.mockClear();
    fireEvent.keyDown(window, { key: " " });
    expect(onAct).toHaveBeenCalledWith({ type: "pass" });
  });

  it("says the opponent is thinking while an action is out, and Space does nothing", () => {
    const { onAct } = setup(turnFive().view, { busy: true });
    expect(screen.getByText("Opponent is thinking…")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /To combat/ })).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: " " });
    expect(onAct).not.toHaveBeenCalled();
  });

  it("shows the result with a new game and the way back", () => {
    const { onNewGame, onBack } = setup(gameOver().view);
    expect(screen.getByRole("heading", { name: "You won" })).toBeInTheDocument();
    const over = screen.getByRole("region", { name: "Game over" });
    fireEvent.click(within(over).getByRole("button", { name: "New game" }));
    expect(onNewGame).toHaveBeenCalled();
    fireEvent.click(within(over).getByRole("button", { name: "Back to setup" }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("PlaytestBoard's attack step", () => {
  it("toggles attackers on a click rather than tapping them, and declares them", () => {
    const { view, goyf, delver } = attackStep();
    const { onAct } = setup(view);
    const goyfButton = within(yours()).getByRole("button", { name: /^Tarmogoyf/ });
    expect(goyfButton).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(goyfButton);
    fireEvent.click(within(yours()).getByRole("button", { name: /^Delver/ }));
    expect(onAct).not.toHaveBeenCalled();
    expect(within(yours()).getByRole("button", { name: /^Tarmogoyf/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Delver picked and then put back.
    fireEvent.click(within(yours()).getByRole("button", { name: /^Delver/ }));
    fireEvent.click(screen.getByRole("button", { name: /Attack with 1/ }));
    expect(onAct).toHaveBeenCalledWith({
      type: "attack",
      attacks: [{ attacker: goyf.id, target: null }],
    });
    expect(onAct).not.toHaveBeenCalledWith(
      expect.objectContaining({
        attacks: expect.arrayContaining([expect.objectContaining({ attacker: delver.id })]),
      }),
    );
  });

  it("declares no attack with nothing picked", () => {
    const { onAct } = setup(attackStep().view);
    fireEvent.keyDown(window, { key: " " });
    expect(onAct).toHaveBeenCalledWith({ type: "attack", attacks: [] });
  });
});

describe("PlaytestBoard's block step", () => {
  it("assigns a blocker to the attacker clicked after it, and numbers both", () => {
    const { view, goyf, ragavan } = blockStep();
    const { onAct } = setup(view);
    fireEvent.click(within(yours()).getByRole("button", { name: /^Tarmogoyf/ }));
    fireEvent.click(within(theirs()).getByRole("button", { name: /^Ragavan/ }));
    expect(
      within(yours()).getByRole("button", { name: /Tarmogoyf.*blocking 1/ }),
    ).toBeInTheDocument();
    expect(
      within(theirs()).getByRole("button", { name: /Ragavan.*attacking, blocked 1/ }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Confirm blocks/ }));
    expect(onAct).toHaveBeenCalledWith({
      type: "block",
      blocks: [{ blocker: goyf.id, attacker: ragavan.id }],
    });
  });

  it("takes a blocker off when it is clicked again", () => {
    const { view } = blockStep();
    const { onAct } = setup(view);
    fireEvent.click(within(yours()).getByRole("button", { name: /^Tarmogoyf/ }));
    fireEvent.click(within(theirs()).getByRole("button", { name: /^Ragavan/ }));
    fireEvent.click(within(yours()).getByRole("button", { name: /^Tarmogoyf/ }));
    fireEvent.click(screen.getByRole("button", { name: /No blocks/ }));
    expect(onAct).toHaveBeenCalledWith({ type: "block", blocks: [] });
  });
});

describe("PlaytestBoard's prompt", () => {
  it("makes each one-card answer clickable on the table", () => {
    const { view } = targetPrompt();
    const { onAct } = setup(view);
    expect(screen.getByRole("region", { name: "Choose a target" })).toBeInTheDocument();
    fireEvent.click(within(theirs()).getByRole("button", { name: /^Boros Reckoner/ }));
    expect(onAct).toHaveBeenCalledWith({ type: "choose", index: 1 });
  });
});

describe("PlaytestBoard's opponent", () => {
  it("never taps, drags or opens a menu on the opponent's cards", () => {
    vi.mocked(goldfishDraggable).mockClear();
    const { onAct } = setup(turnFive().view);
    const ragavan = within(theirs()).getByRole("button", { name: /^Ragavan/ });
    fireEvent.click(ragavan);
    fireEvent.contextMenu(ragavan);
    expect(onAct).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    const dragged = vi.mocked(goldfishDraggable).mock.calls.map(([{ element }]) => element);
    expect(dragged.length).toBeGreaterThan(0);
    expect(dragged.some((el) => theirs().contains(el))).toBe(false);
    expect(dragged.some((el) => yours().contains(el))).toBe(true);
  });

  it("still taps the reader's own", () => {
    const { view, elves } = turnFive();
    const { onAct } = setup(view);
    fireEvent.click(within(yours()).getByRole("button", { name: /^Llanowar Elves/ }));
    expect(onAct).toHaveBeenCalledWith({ type: "tap", ids: [elves.id], tapped: true });
  });

  it("draws the opponent's hand face down, by its count", () => {
    setup(turnFive().view);
    expect(screen.getByRole("img", { name: "The opponent's hand, 5 cards" })).toBeInTheDocument();
  });
});

describe("PlaytestBoard's aimed attacks", () => {
  it("re-aims an attacker at a planeswalker clicked on the opponent's table", () => {
    const { view, goyf, jace } = attackStep();
    const { onAct } = setup(view);
    fireEvent.click(within(yours()).getByRole("button", { name: /^Tarmogoyf/ }));
    fireEvent.click(within(theirs()).getByRole("button", { name: /^Jace/ }));
    fireEvent.click(screen.getByRole("button", { name: /Attack with 1/ }));
    expect(onAct).toHaveBeenCalledWith({
      type: "attack",
      attacks: [{ attacker: goyf.id, target: jace.id }],
    });
  });

  it("aims back at the opponent through their plate", () => {
    const { view, goyf, jace } = attackStep();
    const { onAct } = setup(view);
    fireEvent.click(within(yours()).getByRole("button", { name: /^Tarmogoyf/ }));
    fireEvent.click(within(theirs()).getByRole("button", { name: /^Jace/ }));
    // Waiting to be aimed again, then at the plate.
    fireEvent.click(within(yours()).getByRole("button", { name: /^Tarmogoyf/ }));
    fireEvent.click(screen.getByRole("button", { name: "Attack the opponent" }));
    fireEvent.keyDown(window, { key: " " });
    expect(onAct).toHaveBeenCalledWith({
      type: "attack",
      attacks: [{ attacker: goyf.id, target: null }],
    });
    expect(jace.id).not.toBe(goyf.id);
  });
});

describe("PlaytestBoard's respond stage", () => {
  it("passes on Space, passes the turn on the second button, and calls out the stack", () => {
    const { onAct } = setup(respondStep().view);
    expect(screen.getByText("Respond?")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: " " });
    expect(onAct).toHaveBeenLastCalledWith({ type: "pass" });
    fireEvent.click(screen.getByRole("button", { name: "Pass turn" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "endTurn" });
  });

  it("says it is passing the turn while the engine plays it out", () => {
    setup({ ...respondStep().view, endingTurn: true });
    expect(screen.getByRole("button", { name: "Passing turn…" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("PlaytestBoard's stops", () => {
  it("toggles a stop by sending the whole new set, with the reader's main phases fixed on", () => {
    const { onAct } = setup(respondStep().view);
    fireEvent.click(screen.getByRole("button", { name: "Stops" }));
    const mine = screen.getByRole("group", { name: "Your turn" });
    expect(within(mine).getByRole("button", { name: "Main 1" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(mine).getByRole("button", { name: "Main 1" }));
    expect(onAct).not.toHaveBeenCalled();
    const theirsRow = screen.getByRole("group", { name: "Opponent's turn" });
    expect(within(theirsRow).getByRole("button", { name: "Upkeep" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(theirsRow).getByRole("button", { name: "End" }));
    expect(onAct).toHaveBeenLastCalledWith({
      type: "setStops",
      stops: [
        { seat: "opponent", step: "upkeep" },
        { seat: "opponent", step: "end" },
      ],
    });
    fireEvent.click(within(theirsRow).getByRole("button", { name: "Upkeep" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "setStops", stops: [] });
  });
});

describe("PlaytestBoard's replay", () => {
  it("is read-only, and Skip or Space ends it", () => {
    const { view, elves } = turnFive();
    const { onAct, onSkip } = setup(view, { replaying: true });
    expect(screen.getByTestId("replay-shield")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /To combat/ })).not.toBeInTheDocument();
    fireEvent.click(within(yours()).getByRole("button", { name: /^Llanowar Elves/ }));
    expect(onAct).not.toHaveBeenCalledWith(expect.objectContaining({ ids: [elves.id] }));
    fireEvent.keyDown(window, { key: " " });
    expect(onSkip).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Skip/ }));
    expect(onSkip).toHaveBeenCalledTimes(2);
  });
});

describe("PlaytestBoard's tracker", () => {
  it("lights the phase the game is in, named in one sentence", () => {
    setup(combatArrowsView().view);
    const tracker = screen.getByRole("group", {
      name: "Turn 5 · Your declare blockers step — you may respond",
    });
    expect(tracker.querySelector("[data-lit]")).toHaveTextContent("Combat");
  });
});
