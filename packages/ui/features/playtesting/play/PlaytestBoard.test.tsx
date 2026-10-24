import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameCard, PlaytestView } from "@/lib/ipc";
import { ContextMenuProvider } from "@/components/menu/ContextMenuProvider";
import { gameCard } from "../table/fixtures";
import { tableDraggable } from "../table/tableDrag";
import { tableCardWidth } from "../table/Battlefield";
import { LAYER } from "@/lib/layers";
import { INSPECT_DELAY } from "../table/Inspect";
import type { Playmat } from "../table/types";
import {
  GOLDFISH,
  attackStep,
  blockStep,
  combatArrowsView,
  fourPlayer,
  fourPlayerAttack,
  fourPlayerLost,
  gameOver,
  goldfishCommanderDead,
  goldfishDead,
  goldfishOpeningHand,
  goldfishTurn,
  openingHand,
  respondStep,
  targetPrompt,
  turnFive,
  withAttachments,
  withEmblems,
} from "./fixtures";
import { useTableSoundsMuted } from "../sound/muted";
import { useTableSoundsVolume } from "../sound/volume";
import { PlaytestBoard, zoneSize } from "./PlaytestBoard";

// Spied, not replaced: the board's cards still register as they would, and the test can ask
// which ones did.
vi.mock("../table/tableDrag", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../table/tableDrag")>();
  return { ...actual, tableDraggable: vi.fn(actual.tableDraggable) };
});

function board(
  view: PlaytestView | null,
  handlers: {
    onAct: (a: unknown) => void;
    onBack: () => void;
    onNewGame: () => void;
    onSkip: () => void;
  },
  {
    busy = false,
    replaying = false,
    opponentNames = ["Boros Aggro"] as readonly string[],
    returnTo = undefined as "setup" | "deck" | undefined,
    initialPlaymat = undefined as Playmat | undefined,
  } = {},
) {
  return (
    <ContextMenuProvider>
      <PlaytestBoard
        deckName="Simic Tempo"
        opponentNames={opponentNames}
        view={view}
        log={[]}
        error={null}
        busy={busy}
        onAct={handlers.onAct}
        onBack={handlers.onBack}
        onNewGame={handlers.onNewGame}
        replaying={replaying}
        onSkip={handlers.onSkip}
        returnTo={returnTo}
        initialPlaymat={initialPlaymat}
      />
    </ContextMenuProvider>
  );
}

function setup(view: PlaytestView | null, options: Parameters<typeof board>[2] = {}) {
  const handlers = { onAct: vi.fn(), onBack: vi.fn(), onNewGame: vi.fn(), onSkip: vi.fn() };
  const { rerender } = render(board(view, handlers, options));
  return {
    ...handlers,
    rerender: (next: PlaytestView | null) => rerender(board(next, handlers, options)),
  };
}

/** Turn 5 with the sandbox turned on. */
const sandboxed = (view: PlaytestView = turnFive().view): PlaytestView => ({
  ...view,
  sandbox: true,
});

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

describe("PlaytestBoard's sound button", () => {
  afterEach(() => {
    useTableSoundsMuted.getState().setMuted(false);
    useTableSoundsVolume.getState().setVolume(100);
  });

  it("turns the board's sounds off and back on, the setting every board shares", () => {
    setup(turnFive().view);
    fireEvent.click(screen.getByRole("button", { name: "Turn sounds off" }));
    expect(useTableSoundsMuted.getState().muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Turn sounds on" }));
    expect(useTableSoundsMuted.getState().muted).toBe(false);
    expect(screen.getByRole("button", { name: "Turn sounds off" })).toBeInTheDocument();
  });

  it("sets how loud the sounds are, and moving the slider while muted turns them back on", () => {
    setup(turnFive().view);
    const slider = screen.getByRole("slider", { name: "Sound volume" });
    expect(slider).toHaveValue("100");
    fireEvent.change(slider, { target: { value: "35" } });
    expect(useTableSoundsVolume.getState().volume).toBe(35);
    expect(slider).toHaveAttribute("aria-valuetext", "35%");
    fireEvent.click(screen.getByRole("button", { name: "Turn sounds off" }));
    fireEvent.change(slider, { target: { value: "60" } });
    expect(useTableSoundsVolume.getState().volume).toBe(60);
    expect(useTableSoundsMuted.getState().muted).toBe(false);
  });
});

describe("PlaytestBoard's opening hand", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("previews a card rested on, and closes when the pointer leaves it", () => {
    setup(openingHand());
    const goyf = screen.getByRole("button", { name: "Tarmogoyf" });
    const preview = () => screen.queryByTestId("card-inspect");

    fireEvent.mouseEnter(goyf);
    act(() => vi.advanceTimersByTime(INSPECT_DELAY));
    expect(preview()).toHaveTextContent("Tarmogoyf · in your opening hand");

    fireEvent.mouseLeave(goyf);
    expect(preview()).not.toBeInTheDocument();
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
      attacks: [{ attacker: goyf.id, target: null, player: "opponent" }],
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

describe("PlaytestBoard's rules drags", () => {
  const carried = () => vi.mocked(tableDraggable).mock.calls.map(([{ element }]) => element);
  const isCarried = (button: HTMLElement) => carried().some((el) => el.contains(button));

  it("lets the reader carry their attackers, but not their lands, with the sandbox off", () => {
    vi.mocked(tableDraggable).mockClear();
    setup(attackStep().view);
    expect(isCarried(within(yours()).getByRole("button", { name: /^Tarmogoyf/ }))).toBe(true);
    expect(isCarried(within(yours()).getByRole("button", { name: /^Llanowar Elves/ }))).toBe(true);
    expect(isCarried(within(yours()).getByRole("button", { name: /^Island/ }))).toBe(false);
    expect(carried().some((el) => theirs().contains(el))).toBe(false);
  });

  it("lets the reader carry a permanent onto a target with priority", () => {
    vi.mocked(tableDraggable).mockClear();
    setup(turnFive().view);
    expect(isCarried(within(yours()).getByRole("button", { name: /^Sol Ring/ }))).toBe(true);
  });

  it("carries nothing on the table while the engine asks a question", () => {
    vi.mocked(tableDraggable).mockClear();
    setup(targetPrompt().view);
    expect(carried().some((el) => yours().contains(el))).toBe(false);
  });

  it("carries nothing on the table while the engine is busy", () => {
    vi.mocked(tableDraggable).mockClear();
    setup(attackStep().view, { busy: true });
    expect(carried().some((el) => yours().contains(el))).toBe(false);
  });
});

describe("PlaytestBoard's opponent", () => {
  it("never taps or opens a menu on the opponent's cards with the sandbox off", () => {
    const { onAct } = setup(turnFive().view);
    const ragavan = within(theirs()).getByRole("button", { name: /^Ragavan/ });
    fireEvent.click(ragavan);
    fireEvent.contextMenu(ragavan);
    expect(onAct).not.toHaveBeenCalled();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("never drags the opponent's cards, even with the sandbox on", () => {
    vi.mocked(tableDraggable).mockClear();
    setup(sandboxed());
    const dragged = vi.mocked(tableDraggable).mock.calls.map(([{ element }]) => element);
    expect(dragged.length).toBeGreaterThan(0);
    expect(dragged.some((el) => theirs().contains(el))).toBe(false);
    expect(dragged.some((el) => yours().contains(el))).toBe(true);
  });

  it("opens the sandbox's menu on the opponent's cards with it on, and a click still taps none", async () => {
    const { view, ragavan } = turnFive();
    const { onAct } = setup(sandboxed(view));
    const button = within(theirs()).getByRole("button", { name: /^Ragavan/ });
    fireEvent.click(button);
    expect(onAct).not.toHaveBeenCalled();
    fireEvent.contextMenu(button);
    await screen.findByRole("menu");
    const rows = screen.getAllByRole("menuitem").map((r) => r.textContent);
    expect(rows).not.toContain("Activate ability");
    expect(rows).not.toContain("Play");
    fireEvent.click(screen.getByRole("menuitem", { name: "Tap" }));
    expect(onAct).toHaveBeenCalledWith({ type: "tap", ids: [ragavan.id], tapped: true });
  });

  it("gives the opponent's plate a life stepper only with the sandbox on", () => {
    setup(turnFive().view);
    expect(screen.queryByRole("spinbutton", { name: "Opponent's life" })).toBeNull();
    expect(screen.getByText("Opponent's life:")).toBeInTheDocument();
  });

  it("taps the reader's own on a click with the sandbox on", () => {
    const { view, elves } = turnFive();
    const { onAct } = setup(sandboxed(view));
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
      attacks: [{ attacker: goyf.id, target: jace.id, player: null }],
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
      attacks: [{ attacker: goyf.id, target: null, player: "opponent" }],
    });
    expect(jace.id).not.toBe(goyf.id);
  });
});

describe("PlaytestBoard's respond stage", () => {
  it("passes on Space, passes the turn on the second button, and asks about the opponent's spell", () => {
    const { onAct } = setup(respondStep().view);
    const asked = screen.getByRole("region", { name: "Respond to Lightning Bolt?" });
    expect(within(asked).getByText("Targeting")).toBeInTheDocument();
    // The question is asked over the opponent's table, so the stack's column only says "Stack".
    expect(screen.queryByText("Respond?")).not.toBeInTheDocument();
    fireEvent.click(within(asked).getByRole("button", { name: /Let it resolve/ }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "pass" });
    fireEvent.keyDown(window, { key: " " });
    expect(onAct).toHaveBeenLastCalledWith({ type: "pass" });
    fireEvent.click(screen.getByRole("button", { name: "Pass turn" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "endTurn" });
  });

  it("asks about nothing on the stack at a step's stop with the stack empty", () => {
    setup({ ...respondStep().view, stack: [] });
    expect(screen.queryByRole("region", { name: /^Respond to/ })).not.toBeInTheDocument();
  });

  it("holds the question's answer while the engine is busy", () => {
    setup(respondStep().view, { busy: true });
    expect(screen.getByRole("button", { name: /Let it resolve/ })).toBeDisabled();
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

describe("PlaytestBoard's emblems (issue #1333)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("draws each seat's emblems on its own table, and previews one with its words", () => {
    setup(withEmblems().view);
    const sorin = within(yours()).getByRole("img", {
      name: "Emblem from Sorin, Lord of Innistrad — Creatures you control get +1/+0.",
    });
    expect(
      within(theirs()).getByRole("img", { name: /^Emblem from Chandra, Torch of Defiance/ }),
    ).toBeInTheDocument();
    expect(within(theirs()).queryByRole("img", { name: /Sorin/ })).toBeNull();

    fireEvent.mouseEnter(sorin);
    act(() => vi.advanceTimersByTime(INSPECT_DELAY));
    expect(screen.getByTestId("card-inspect")).toHaveTextContent(
      "Emblem from Sorin, Lord of Innistrad — Creatures you control get +1/+0.",
    );
    fireEvent.mouseLeave(sorin);
    expect(screen.queryByTestId("card-inspect")).not.toBeInTheDocument();
  });
});

const FOUR = ["Boros Aggro", "Partners", "Mono-White"];

describe("PlaytestBoard at a four-player table", () => {
  it("draws each opponent's own area, plate and table, and the duel's single table not at all", () => {
    setup(fourPlayer().view, { opponentNames: FOUR });
    for (const [name, player] of [
      ["Opponent 1's battlefield", "opponent"],
      ["Opponent 2's battlefield", "opponent2"],
      ["Opponent 3's battlefield", "opponent3"],
    ]) {
      const table = screen.getByRole("region", { name });
      expect(table.closest("[data-table]")).toHaveAttribute("data-table", player);
    }
    expect(screen.queryByRole("region", { name: "The opponent's battlefield" })).toBeNull();
    expect(document.querySelectorAll("[data-plate]")).toHaveLength(4);
    expect(screen.getByRole("img", { name: "Opponent 2's hand, 6 cards" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Opponent 2 · Partners" })).toBeInTheDocument();
  });

  it("draws an opponent's emblem on that opponent's own table", () => {
    const { view } = fourPlayer();
    const emblem = { id: 9100, source: "Nissa, Who Shakes the World", cardId: null, text: [] };
    view.opponents = view.opponents.map((o) =>
      o.player === "opponent2" ? { ...o, emblems: [emblem] } : o,
    );
    setup(view, { opponentNames: FOUR });
    const table = screen.getByRole("region", { name: "Opponent 2's battlefield" });
    expect(
      within(table).getByRole("img", { name: "Emblem from Nissa, Who Shakes the World" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: /^Emblem/ })).toHaveLength(1);
  });

  it("counts commander damage on each plate, one mark a commander, red at 21", () => {
    setup(fourPlayer().view, { opponentNames: FOUR });
    // The reader's two partners' damage stays two counts, never one of 10.
    const yourPlate = document.querySelector('[data-plate="you"]') as HTMLElement;
    const thrasios = within(yourPlate).getByLabelText(
      "6 commander damage from Thrasios, Triton Hero",
    );
    expect(thrasios).toHaveAttribute("title", "Thrasios, Triton Hero: 6 of 21 commander damage");
    expect(thrasios).not.toHaveAttribute("data-lethal");
    expect(
      within(yourPlate).getByLabelText("4 commander damage from Tymna the Weaver"),
    ).toBeInTheDocument();
    const second = document.querySelector('[data-plate="opponent2"]') as HTMLElement;
    expect(within(second).getByLabelText("3 poison")).toBeInTheDocument();
    expect(
      within(second).getByLabelText("14 commander damage from Kenrith, the Returned King"),
    ).toBeInTheDocument();
    const third = document.querySelector('[data-plate="opponent3"]') as HTMLElement;
    expect(
      within(third).getByLabelText("21 commander damage from Kenrith, the Returned King, lethal"),
    ).toHaveAttribute("data-lethal", "true");
    const first = document.querySelector('[data-plate="opponent"]') as HTMLElement;
    expect(first.querySelector("[data-commander-damage]")).toBeNull();
  });

  it("marks an opponent who is out", () => {
    setup(fourPlayer().view, { opponentNames: FOUR });
    const out = screen.getByRole("region", { name: "Opponent 3 · Mono-White" });
    expect(out).toHaveAttribute("data-out", "true");
    expect(within(out).getByText("Out")).toBeInTheDocument();
    const inPlay = screen.getByRole("region", { name: "Opponent 2 · Partners" });
    expect(within(inPlay).queryByText("Out")).toBeNull();
  });

  it("aims an attacker at the opponent whose plate is clicked", () => {
    const { view, elves } = fourPlayerAttack();
    const { onAct } = setup(view, { opponentNames: FOUR });
    fireEvent.click(within(yours()).getByRole("button", { name: /^Llanowar Elves/ }));
    // Waiting to be aimed: each opponent it may attack is a target, and the one out is not.
    expect(screen.getByRole("button", { name: "Attack Opponent 1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attack Opponent 3" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Attack Opponent 2" }));
    fireEvent.click(screen.getByRole("button", { name: /Attack with 1/ }));
    expect(onAct).toHaveBeenCalledWith({
      type: "attack",
      attacks: [{ attacker: elves.id, target: null, player: "opponent2" }],
    });
  });

  it("says the reader lost once they are out, though nobody has won", () => {
    setup(fourPlayerLost().view, { opponentNames: FOUR });
    expect(screen.getByRole("heading", { name: "You lost" })).toBeInTheDocument();
  });
});

describe("PlaytestBoard's sandbox", () => {
  it("is off: no click-to-tap, no T key, no library draws, plates read-only, the menu's rows grey", async () => {
    const { view, elves } = turnFive();
    const { onAct } = setup(view);
    const elf = within(yours()).getByRole("button", { name: /^Llanowar Elves/ });
    fireEvent.click(elf);
    fireEvent.mouseEnter(elf);
    fireEvent.keyDown(window, { key: "t" });
    expect(onAct).not.toHaveBeenCalledWith(expect.objectContaining({ ids: [elves.id] }));
    expect(onAct).not.toHaveBeenCalled();

    const library = screen.getByRole("button", { name: "Library, 48 cards" });
    expect(library).toBeDisabled();
    expect(screen.queryByRole("spinbutton", { name: "Your life" })).toBeNull();

    // A card in hand keeps Play and nothing else.
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Counterspell\. Drag to play/ }));
    await screen.findByRole("menu");
    expect(screen.getAllByRole("menuitem").map((r) => r.textContent)).toEqual(["Play"]);
  });

  it("greys the game menu's hand edits while off", async () => {
    setup(turnFive().view);
    fireEvent.click(screen.getByRole("button", { name: "Game menu" }));
    await screen.findByRole("menu");
    expect(screen.getByRole("menuitem", { name: "Untap everything" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Sandbox" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
  });

  it("offers the game menu's hand edits while on, and the row turns it off", async () => {
    const { onAct } = setup(sandboxed());
    fireEvent.click(screen.getByRole("button", { name: "Game menu" }));
    const row = await screen.findByRole("menuitemradio", { name: "Sandbox" });
    expect(row).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitem", { name: "Untap everything" })).not.toHaveAttribute(
      "aria-disabled",
    );
    fireEvent.click(row);
    expect(onAct).toHaveBeenLastCalledWith({ type: "setSandbox", on: false });
  });

  it("is on: T taps the card pointed at, the library draws, the plates step", () => {
    const { view, elves } = turnFive();
    const { onAct } = setup(sandboxed(view));
    fireEvent.mouseEnter(within(yours()).getByRole("button", { name: /^Llanowar Elves/ }));
    fireEvent.keyDown(window, { key: "t" });
    expect(onAct).toHaveBeenLastCalledWith({ type: "tap", ids: [elves.id], tapped: true });
    fireEvent.click(screen.getByRole("button", { name: /^Library, 48 cards\. Click to draw/ }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "draw", count: 1 });
    expect(screen.getByRole("spinbutton", { name: "Your life" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "Opponent's life" })).toBeEnabled();
  });

  it("takes no hand edits outside the reader's main phase, though it is on", () => {
    const { onAct } = setup(sandboxed(respondStep().view));
    fireEvent.click(within(yours()).getByRole("button", { name: /^Llanowar Elves/ }));
    expect(onAct).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Library, 48 cards" })).toBeDisabled();
    // The steppers are there, greyed, to come back to.
    expect(screen.getByRole("spinbutton", { name: "Your life" })).toBeDisabled();
  });

  it("is turned on and off by the chip in the top band", () => {
    const { onAct, rerender } = setup(turnFive().view);
    const chip = screen.getByRole("button", { name: "Sandbox" });
    expect(chip).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(chip);
    expect(onAct).toHaveBeenLastCalledWith({ type: "setSandbox", on: true });
    rerender(sandboxed());
    expect(screen.getByRole("button", { name: "Sandbox" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Sandbox" }));
    expect(onAct).toHaveBeenLastCalledWith({ type: "setSandbox", on: false });
  });
});

describe("PlaytestBoard against the goldfish", () => {
  it("names the goldfish's plate, and says the engine is playing on rather than thinking", () => {
    setup(goldfishTurn(), { opponentNames: GOLDFISH, busy: true });
    expect(screen.getByText("Opponent · Goldfish")).toBeInTheDocument();
    expect(screen.getByText("Playing on…")).toBeInTheDocument();
    expect(screen.queryByText(/thinking/)).toBeNull();
  });

  it("says on which of the reader's turns the goldfish died", () => {
    setup(goldfishDead(), { opponentNames: GOLDFISH });
    expect(screen.getByText("Dead on your turn 8")).toBeInTheDocument();
  });

  it("says the goldfish died to commander damage with its life above 0", () => {
    setup(goldfishCommanderDead(), { opponentNames: GOLDFISH });
    expect(screen.getByText("Dead on your turn 8")).toBeInTheDocument();
    expect(
      screen.getByLabelText("21 commander damage from Kenrith, the Returned King, lethal"),
    ).toBeInTheDocument();
  });

  it("draws no commander damage outside a Commander game", () => {
    setup(turnFive().view);
    expect(document.querySelector("[data-commander-damage]")).toBeNull();
  });

  it("goes back to the deck it was opened from, under the goldfish's undo scope", async () => {
    const { onBack, onAct } = setup(goldfishTurn(), {
      opponentNames: GOLDFISH,
      returnTo: "deck",
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to the Simic Tempo deck" }));
    expect(onBack).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    expect(onAct).toHaveBeenLastCalledWith({ type: "undo" });
    fireEvent.click(screen.getByRole("button", { name: "Game menu" }));
    expect(await screen.findByRole("menuitem", { name: "Back to the deck" })).toBeInTheDocument();
  });

  it("names the result banner's way back by where the board came from", () => {
    setup(gameOver().view, { returnTo: "deck" });
    const over = screen.getByRole("region", { name: "Game over" });
    expect(within(over).getByRole("button", { name: "Back to the deck" })).toBeInTheDocument();
  });

  it("draws the felt the board was opened on", () => {
    setup(goldfishTurn(), { opponentNames: GOLDFISH, initialPlaymat: "green" });
    expect(screen.getByTestId("board-felt")).toBeInTheDocument();
  });
});

describe("PlaytestBoard's inspect preview", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const rest = (ms: number) => act(() => vi.advanceTimersByTime(ms));
  const preview = () => screen.queryByTestId("card-inspect");
  const table = (battlefield: GameCard[]): PlaytestView => {
    const view = goldfishTurn();
    return { ...view, you: { ...view.you, battlefield } };
  };

  it("opens once the pointer has rested, closes at once, and waits again", () => {
    setup(table([gameCard("Sol Ring")]), { opponentNames: GOLDFISH });
    const ring = within(yours()).getByRole("button", { name: "Sol Ring" });

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
    setup(table([gameCard("Sol Ring"), gameCard("Rhystic Study")]), { opponentNames: GOLDFISH });
    const ring = within(yours()).getByRole("button", { name: "Sol Ring" });
    const study = within(yours()).getByRole("button", { name: "Rhystic Study" });

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
    const { rerender } = setup(table([first, second]), { opponentNames: GOLDFISH });
    const tapped = within(yours()).getByRole("button", { name: "Forest, tapped" });

    fireEvent.mouseEnter(tapped);
    rest(INSPECT_DELAY);
    expect(preview()).toBeInTheDocument();

    // Untapped, it joins the other Forest's pile: its own element is gone without a `mouseleave`.
    rerender(table([first, { ...second, tapped: false }]));
    expect(tapped).not.toBeInTheDocument();
    fireEvent.pointerMove(screen.getByTestId("playtest-board"));
    expect(preview()).not.toBeInTheDocument();
  });

  it.each([
    ["the command zone", /in the command zone/],
    ["the graveyard", /^Graveyard, /],
    ["exile", /^Exile, /],
  ])("closes at once when the pointer leaves a card in %s", (_zone, name) => {
    const view = goldfishTurn();
    setup(
      {
        ...view,
        you: {
          ...view.you,
          command: [gameCard("Kenrith, the Returned King", { isCommander: true })],
          exile: [gameCard("Counterspell")],
        },
      },
      { opponentNames: GOLDFISH },
    );
    const card = screen.getByRole("button", { name });

    fireEvent.mouseEnter(card);
    rest(INSPECT_DELAY);
    expect(preview()).toBeInTheDocument();

    fireEvent.mouseLeave(card);
    expect(preview()).not.toBeInTheDocument();
  });

  // Issue #1373: a graveyard or exile looked through is drawn small, and the preview is how a
  // card in it is read — over the dialog's scrim, not under it.
  it("opens over a zone's dialog on a card in it, and closes with the dialog", () => {
    const view = goldfishTurn();
    setup(
      { ...view, you: { ...view.you, exile: [gameCard("Counterspell"), gameCard("Brainstorm")] } },
      { opponentNames: GOLDFISH },
    );
    fireEvent.click(screen.getByRole("button", { name: /^Exile, / }));
    const dialog = screen.getByRole("dialog", { name: "Exile" });
    const counterspell = within(dialog)
      .getByRole("group", { name: "Counterspell" })
      .querySelector("[data-point]")!;

    fireEvent.mouseEnter(counterspell);
    rest(INSPECT_DELAY);
    expect(preview()).toHaveTextContent("Counterspell · in exile");
    expect(preview()).toHaveClass(LAYER.menuOverDialog);

    fireEvent.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(preview()).not.toBeInTheDocument();
  });

  it("opens on a card of the goldfish game's opening hand, and closes when the pointer leaves it", () => {
    setup(goldfishOpeningHand(), { opponentNames: GOLDFISH });
    const ring = screen.getByRole("button", { name: "Sol Ring" });

    fireEvent.mouseEnter(ring);
    rest(INSPECT_DELAY);
    expect(preview()).toHaveTextContent("Sol Ring · in your opening hand");

    fireEvent.mouseLeave(ring);
    expect(preview()).not.toBeInTheDocument();
  });

  // Issue #1331: an attachment's edge is a card of its own to rest on, whichever table it is
  // drawn on — the reader's Aura under the opponent's creature is still the reader's card.
  it.each([
    ["an Equipment under the reader's creature", yours, "Bonesplitter, attached to Tarmogoyf"],
    [
      "the reader's Aura on the opponent's table",
      theirs,
      "Pacifism, attached to Ragavan, Nimble Pilferer",
    ],
  ])("opens on %s, and closes when the pointer leaves it", (_what, table, name) => {
    setup(withAttachments().view);
    const edge = within(table()).getByRole("button", { name });

    fireEvent.mouseEnter(edge);
    rest(INSPECT_DELAY);
    expect(preview()).toHaveTextContent(name);

    fireEvent.mouseLeave(edge);
    expect(preview()).not.toBeInTheDocument();
  });

  it("taps the reader's Aura on the opponent's table with T, its controller's key", () => {
    const { view } = withAttachments();
    const { onAct } = setup(sandboxed(view));
    const edge = within(theirs()).getByRole("button", {
      name: "Pacifism, attached to Ragavan, Nimble Pilferer",
    });
    const pacifism = view.you.battlefield.find((c) => c.name === "Pacifism")!;

    fireEvent.mouseEnter(edge);
    fireEvent.keyDown(window, { key: "t" });
    expect(onAct).toHaveBeenCalledWith({ type: "tap", ids: [pacifism.id], tapped: true });
  });

  it("stays open while the pointer moves over the card it shows", () => {
    setup(table([gameCard("Sol Ring")]), { opponentNames: GOLDFISH });
    const ring = within(yours()).getByRole("button", { name: "Sol Ring" });

    fireEvent.mouseEnter(ring);
    rest(INSPECT_DELAY);
    fireEvent.pointerMove(ring);
    expect(preview()).toBeInTheDocument();
  });
});

describe("PlaytestBoard's zone columns", () => {
  it("keep their 72 × 101 cards in a short window", () => {
    // 1280 × 800 less the caption: the tables' cards are smaller than that.
    expect(zoneSize(766)).toEqual({ width: 72, height: 101, compact: true });
  });

  it("draw their cards at the size of an unshrunk card on the tables in a tall window", () => {
    // A 1400 px board's tables are 606 px tall each.
    const size = zoneSize(1400);
    expect(size.width).toBe(tableCardWidth(606, true));
    expect(size.width).toBeGreaterThan(2 * 72);
    expect(size.height).toBe(Math.round(size.width * 1.4));
    // Two of them and the column's 8 px gap still stand inside the table.
    expect(2 * size.height + 8).toBeLessThanOrEqual(606);
  });

  it("move the tables in by their width", () => {
    const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(1400);
    try {
      setup(turnFive().view);
      expect(screen.getByTestId("playtest-board").style.getPropertyValue("--table-x")).toBe(
        `${zoneSize(1400).width + 24}px`,
      );
    } finally {
      height.mockRestore();
    }
  });
});
