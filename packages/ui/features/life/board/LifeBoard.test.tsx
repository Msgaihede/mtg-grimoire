import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DialogHostContext, type DialogHost } from "@/lib/dialogHost";
import { setupFromFormat, type LifeSetup } from "../types";
import { SAVE_KEY, peekSavedGame } from "../game/savedGame";
import { LifeBoard } from "./LifeBoard";

/**
 * The board as a reader meets it. jsdom lays nothing out and its `ResizeObserver` never reports
 * (`test-setup.ts`), so each test hands the board a phone's size: the observer here answers as soon
 * as it is asked to watch.
 */
function sized(width: number, height: number) {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width, height } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    },
  );
}

function mount(setup: LifeSetup = setupFromFormat("commander"), host?: DialogHost) {
  const onLeave = vi.fn();
  const board = <LifeBoard setup={setup} resume={false} onLeave={onLeave} />;
  const view = render(
    host ? <DialogHostContext.Provider value={host}>{board}</DialogHostContext.Provider> : board,
  );
  return { onLeave, unmount: view.unmount };
}

/** The turn of a seat's panel: its content's frame, turned to face whoever reads it. */
const turnOf = (player: number) =>
  (screen.getByRole("region", { name: `Player ${player}` }).firstElementChild as HTMLElement).style
    .transform;

const openCommanderDamage = (player: number) =>
  fireEvent.click(
    screen.getByRole("button", {
      name: new RegExp(`^Commander damage dealt to Player ${player},`),
    }),
  );

/** A seat's total, read the way a screen reader reads it — off the number's own button. */
const lifeOf = (player: number) =>
  screen
    .getByRole("button", { name: new RegExp(`^Player ${player} is at (.+) life`) })
    .getAttribute("aria-label")!
    .match(/is at (.+?) life/)![1];

beforeEach(() => {
  localStorage.clear();
  sized(390, 844);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("LifeBoard", () => {
  it("draws a panel for every seat", () => {
    mount();
    const panels = screen.getAllByRole("region");
    expect(panels.map((p) => p.getAttribute("aria-label"))).toEqual([
      "Player 1",
      "Player 2",
      "Player 3",
      "Player 4",
    ]);
    mount({ ...setupFromFormat("standard"), players: 6 });
    expect(screen.getAllByRole("region")).toHaveLength(4 + 6);
  });

  it("draws nothing that depends on its size until it has one", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    mount();
    expect(screen.queryAllByRole("region")).toEqual([]);
    expect(screen.queryByRole("button", { name: "Game menu" })).toBeNull();
  });

  it("moves a total by one on a tap of − or +", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Player 2 gains 1 life" }));
    fireEvent.click(screen.getByRole("button", { name: "Player 2 gains 1 life" }));
    expect(lifeOf(2)).toBe("42");
    fireEvent.click(screen.getByRole("button", { name: "Player 3 loses 1 life" }));
    expect(lifeOf(3)).toBe("39");
    expect(lifeOf(1)).toBe("40");
  });

  it("opens the calculator on a press held half a second, and the release taps nothing", () => {
    vi.useFakeTimers();
    mount();
    const minus = screen.getByRole("button", { name: "Player 1 loses 1 life" });
    fireEvent.pointerDown(minus, { clientX: 50, clientY: 700 });
    act(() => vi.advanceTimersByTime(500));
    const calculator = screen.getByRole("dialog", { name: "Life total, Player 1" });
    expect(calculator).toBeInTheDocument();
    fireEvent.pointerUp(minus, { clientX: 50, clientY: 700 });
    fireEvent.click(minus);
    expect(lifeOf(1)).toBe("40");

    // − 5, then Set.
    fireEvent.click(screen.getByRole("button", { name: "Subtract" }));
    fireEvent.click(screen.getByRole("button", { name: "5" }));
    fireEvent.click(screen.getByRole("button", { name: "Set to 35" }));
    expect(screen.queryByRole("dialog", { name: /Life total/ })).toBeNull();
    expect(lifeOf(1)).toBe("35");
  });

  it("does not open the calculator on a quick tap", () => {
    vi.useFakeTimers();
    mount();
    const plus = screen.getByRole("button", { name: "Player 1 gains 1 life" });
    fireEvent.pointerDown(plus, { clientX: 300, clientY: 700 });
    fireEvent.pointerUp(plus, { clientX: 300, clientY: 700 });
    fireEvent.click(plus);
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(lifeOf(1)).toBe("41");
  });

  it("opens the game menu from its button, and closes it again", () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Game menu" }));
    const menu = screen.getByRole("dialog", { name: "Game menu" });
    expect(menu).toHaveFocus();
    expect(screen.getByRole("switch", { name: "Poison counters" })).toHaveAttribute(
      "aria-checked",
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Back to the game" }));
    expect(screen.queryByRole("dialog", { name: "Game menu" })).toBeNull();
  });

  it("asks before ending the game, and leaves only on the reader's yes", async () => {
    const { onLeave } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Player 1 gains 1 life" }));
    await waitFor(() => expect(peekSavedGame()).not.toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Game menu" }));
    fireEvent.click(screen.getByRole("button", { name: "End game and change setup" }));
    expect(screen.getByRole("dialog", { name: "End this game?" })).toBeInTheDocument();
    // The safe answer holds the caret.
    expect(screen.getByRole("button", { name: "Keep playing" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Keep playing" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "End this game?" })).toBeNull(),
    );
    expect(onLeave).not.toHaveBeenCalled();
    expect(lifeOf(1)).toBe("41");

    fireEvent.click(screen.getByRole("button", { name: "Game menu" }));
    fireEvent.click(screen.getByRole("button", { name: "End game and change setup" }));
    fireEvent.click(screen.getByRole("button", { name: "End game" }));
    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SAVE_KEY)).toBeNull();
  });

  it("asks the same question when Back reaches the board", () => {
    const backs: (() => void)[] = [];
    const host: DialogHost = {
      claimBack: (onBack) => {
        backs.push(onBack);
        return () => {};
      },
      swipeToClose: false,
    };
    const { onLeave } = mount(setupFromFormat("commander"), host);
    expect(backs).toHaveLength(1);
    act(() => backs[0]());
    expect(screen.getByRole("dialog", { name: "End this game?" })).toBeInTheDocument();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("turns every panel to face the player whose commander damage is open", () => {
    mount();
    const sideways = (deg: number) => `translate(-50%, -50%) rotate(${deg}deg)`;
    // Four round the table, two to a side.
    expect([1, 2, 3, 4].map(turnOf)).toEqual([90, 90, -90, -90].map(sideways));

    openCommanderDamage(1);
    // The far side's counts are upright to Player 1, who reads and presses all of them.
    expect([1, 2, 3, 4].map(turnOf)).toEqual([90, 90, 90, 90].map(sideways));
    fireEvent.click(
      screen.getByRole("button", { name: "One more commander damage from Player 3" }),
    );
    expect(
      screen.getByRole("button", { name: /^Player 3 has dealt 1 commander damage/ }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Back to life totals" }));
    expect([1, 2, 3, 4].map(turnOf)).toEqual([90, 90, -90, -90].map(sideways));
    openCommanderDamage(4);
    expect([1, 2, 3, 4].map(turnOf)).toEqual([-90, -90, -90, -90].map(sideways));
  });

  it("opens the calculator on another commander's panel facing the player counting", () => {
    vi.useFakeTimers();
    mount();
    openCommanderDamage(1);
    const more = screen.getByRole("button", { name: "One more commander damage from Player 4" });
    fireEvent.pointerDown(more, { clientX: 300, clientY: 700 });
    act(() => vi.advanceTimersByTime(500));
    const calculator = screen.getByRole("dialog", {
      name: "Commander damage dealt, Player 4 to Player 1",
    });
    // Player 1's turn, not Player 4's.
    expect(calculator.style.transform).toBe("translate(-50%, -50%) rotate(90deg)");
  });

  it("puts − and + under the number on a panel turned a quarter", () => {
    // Four players' B table: one at the foot and the head, one down each long side.
    mount({ ...setupFromFormat("commander"), layout: "B" });
    const minus = (player: number) =>
      screen.getByRole("button", { name: `One less commander damage from Player ${player}` });
    openCommanderDamage(1);
    expect([1, 2, 3, 4].map(turnOf)).toEqual(
      [1, 2, 3, 4].map(() => "translate(-50%, -50%) rotate(0deg)"),
    );
    // The long sides turned a quarter, and are narrow for the − and + beside their numbers.
    expect(minus(2).style.justifyContent).toBe("center");
    expect(minus(4).style.justifyContent).toBe("center");
    // The head turned a half: the same shape as it was laid out, its − and + where they were.
    expect(minus(3).style.justifyContent).toBe("");
    expect(minus(3).style.paddingLeft).toBe("6px");
  });

  it("picks up a saved game where it was left", async () => {
    const { onLeave, unmount } = mount();
    fireEvent.click(screen.getByRole("button", { name: "Player 4 loses 1 life" }));
    // Leaving the page writes the game at once, without waiting out the save's quiet.
    unmount();
    expect(peekSavedGame()?.players).toBe(4);

    render(<LifeBoard setup={setupFromFormat("commander")} resume onLeave={onLeave} />);
    await waitFor(() => expect(screen.getAllByRole("region")).toHaveLength(4));
    expect(lifeOf(4)).toBe("39");
  });
});
