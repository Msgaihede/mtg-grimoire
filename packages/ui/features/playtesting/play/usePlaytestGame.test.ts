import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaytestStep } from "@/lib/ipc";
import { openingHand, replayStep, turnFive } from "./fixtures";
import { usePlaytestGame, type PlaytestPicks } from "./usePlaytestGame";

// Hoisted with the mock below, which runs before this file's own top level.
const { playtestStart, playtestAct, playtestEnd } = vi.hoisted(() => ({
  playtestStart: vi.fn<(...args: unknown[]) => Promise<PlaytestStep>>(),
  playtestAct: vi.fn<(action: unknown) => Promise<PlaytestStep>>(),
  playtestEnd: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { playtestStart, playtestAct, playtestEnd },
}));

const PICKS: PlaytestPicks = {
  deckId: 7,
  variant: "theory",
  opponents: [{ deckId: 9, variant: "live" }],
  difficulty: "hard",
};

beforeEach(() => {
  playtestStart.mockReset().mockResolvedValue({
    view: openingHand(),
    happened: [{ type: "drew", seat: "opponent", name: null }],
    frames: [],
  });
  playtestAct.mockReset();
  playtestEnd.mockReset().mockResolvedValue(undefined);
});

describe("usePlaytestGame", () => {
  it("deals both decks with a fresh seed, logs the deal, and ends the game on unmount", async () => {
    const { result, unmount } = renderHook(() => usePlaytestGame(PICKS));
    await waitFor(() => expect(result.current.view?.stage).toBe("mulligan"));
    expect(playtestStart).toHaveBeenCalledWith(
      7,
      "theory",
      [{ deckId: 9, variant: "live" }],
      "hard",
      expect.any(Number),
    );
    expect(Number.isSafeInteger(playtestStart.mock.calls[0][4])).toBe(true);
    expect(result.current.log.map((l) => l.text)).toEqual([
      "The opponent drew a card",
      "Shuffled both decks and drew seven",
    ]);
    expect(result.current.busy).toBe(false);
    unmount();
    expect(playtestEnd).toHaveBeenCalled();
  });

  it("sends actions one at a time, in order, busy until the last answers", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    playtestAct.mockImplementation(async (a) => {
      const type = (a as { type: string }).type;
      order.push(`start ${type}`);
      if (type === "endTurn") await new Promise<void>((r) => (release = r));
      order.push(`end ${type}`);
      return {
        view: turnFive().view,
        happened:
          type === "endTurn"
            ? [{ type: "turnBegan", turn: 5, seat: "you" }]
            : [{ type: "cast", seat: "you", name: "Sol Ring" }],
        frames: [],
      };
    });
    const { result } = renderHook(() => usePlaytestGame(PICKS));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    act(() => {
      result.current.act({ type: "endTurn" });
      result.current.act({ type: "play", id: 1 });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    await waitFor(() => expect(order).toEqual(["start endTurn"]));
    release();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(order).toEqual(["start endTurn", "end endTurn", "start play", "end play"]);
    expect(result.current.log.map((l) => l.text).slice(0, 2)).toEqual([
      "Cast Sol Ring",
      "Your turn 5 begins",
    ]);
  });

  it("shows a refusal and keeps the board it had", async () => {
    playtestAct.mockRejectedValue("Sol Ring can't be cast now.");
    const { result } = renderHook(() => usePlaytestGame(PICKS));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const before = result.current.view;
    act(() => result.current.act({ type: "play", id: 1 }));
    await waitFor(() => expect(result.current.error).toBe("Sol Ring can't be cast now."));
    expect(result.current.view).toBe(before);
  });

  it("drops an answer from before New game", async () => {
    let release: () => void = () => {};
    playtestAct.mockImplementation(async () => {
      await new Promise<void>((r) => (release = r));
      return { view: turnFive().view, happened: [], frames: [] };
    });
    const { result } = renderHook(() => usePlaytestGame(PICKS));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    act(() => result.current.act({ type: "pass" }));
    await waitFor(() => expect(playtestAct).toHaveBeenCalled());
    act(() => result.current.newGame());
    release();
    await waitFor(() => expect(playtestStart).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(result.current.view?.stage).toBe("mulligan");
  });

  it("plays a step's frames back, logs each fact once, and skips to the end", async () => {
    const { step } = replayStep();
    playtestAct.mockResolvedValue(step);
    const { result } = renderHook(() => usePlaytestGame(PICKS));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const before = result.current.log.length;
    act(() => result.current.act({ type: "endTurn" }));
    await waitFor(() => expect(result.current.replaying).toBe(true));
    expect(result.current.view).toBe(step.frames[0].view);
    expect(result.current.lastHappened).toEqual(step.frames[0].happened);
    act(() => result.current.skip());
    expect(result.current.replaying).toBe(false);
    expect(result.current.view).toBe(step.view);
    expect(result.current.lastHappened).toEqual([]);
    const said = result.current.log.slice(0, result.current.log.length - before);
    expect(said.map((l) => l.text)).toEqual([
      "Drew Island",
      "Your turn 7 begins",
      "You lost 2, down to 15",
      "The opponent attacked with Ragavan, Nimble Pilferer",
      "Lightning Bolt dealt 3 damage to Tarmogoyf",
      "The opponent cast Lightning Bolt",
      "The opponent played Mountain",
      "The opponent drew a card",
      "The opponent's turn 6 begins",
    ]);
  });

  it("deals a four-player game's three opponents, and does not deal again for a list rebuilt alike", async () => {
    const opponents = [
      { deckId: 9, variant: "live" as const },
      { deckId: 9, variant: "theory" as const },
      { deckId: 11, variant: "live" as const },
    ];
    // A fresh list on every render, as a careless caller would build it.
    const { result } = renderHook(() =>
      usePlaytestGame({ ...PICKS, opponents: opponents.map((o) => ({ ...o })) }),
    );
    await waitFor(() => expect(result.current.view?.stage).toBe("mulligan"));
    expect(playtestStart).toHaveBeenCalledTimes(1);
    expect(playtestStart.mock.calls[0][2]).toEqual(opponents);
    expect(result.current.log.map((l) => l.text)).toContain("Shuffled every deck and drew seven");
  });

  // Issue #1022: an undo pressed while the AI's turn is still being played back takes back the
  // whole of it — every beat, the ones not yet shown included — and a redo puts it all back.
  it("undoes a step mid-replay to the log before it, and redoes it whole", async () => {
    const { step } = replayStep();
    const back = turnFive().view;
    playtestAct.mockImplementation(async (a) => {
      const type = (a as { type: string }).type;
      if (type === "undo") return { view: back, happened: [], frames: [] };
      if (type === "redo") return { view: step.view, happened: [], frames: [] };
      return step;
    });
    const { result } = renderHook(() => usePlaytestGame(PICKS));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const before = result.current.log;
    act(() => result.current.act({ type: "endTurn" }));
    await waitFor(() => expect(result.current.replaying).toBe(true));
    act(() => result.current.act({ type: "undo" }));
    await waitFor(() => expect(result.current.view).toBe(back));
    expect(result.current.replaying).toBe(false);
    expect(result.current.log).toEqual(before);
    act(() => result.current.act({ type: "redo" }));
    await waitFor(() => expect(result.current.view).toBe(step.view));
    expect(result.current.log).toHaveLength(before.length + 9);
    expect(result.current.log[0].text).toBe("Drew Island");
  });
});
