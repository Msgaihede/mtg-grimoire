import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaytestStep } from "@/lib/ipc";
import { openingHand, turnFive } from "./fixtures";
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
  opponentDeckId: 9,
  opponentVariant: "live",
  difficulty: "hard",
};

beforeEach(() => {
  playtestStart.mockReset().mockResolvedValue({
    view: openingHand(),
    happened: [{ type: "drew", seat: "opponent", name: null }],
  });
  playtestAct.mockReset();
  playtestEnd.mockReset().mockResolvedValue(undefined);
});

describe("usePlaytestGame", () => {
  it("deals both decks with a fresh seed, logs the deal, and ends the game on unmount", async () => {
    const { result, unmount } = renderHook(() => usePlaytestGame(PICKS));
    await waitFor(() => expect(result.current.view?.stage).toBe("mulligan"));
    expect(playtestStart).toHaveBeenCalledWith(7, "theory", 9, "live", "hard", expect.any(Number));
    expect(Number.isSafeInteger(playtestStart.mock.calls[0][5])).toBe(true);
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
      return { view: turnFive().view, happened: [] };
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
});
