import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GoldfishStep, GoldfishView } from "@/lib/ipc";
import { openingHandView, turnNineView } from "./fixtures";
import { useGoldfishGame } from "./useGoldfishGame";

// Hoisted with the mock below, which runs before this file's own top level.
const { goldfishStart, goldfishAct, goldfishEnd } = vi.hoisted(() => ({
  goldfishStart: vi.fn<(deckId: number, variant: string, seed: number) => Promise<GoldfishView>>(),
  goldfishAct: vi.fn<(action: unknown) => Promise<GoldfishStep>>(),
  goldfishEnd: vi.fn<() => Promise<void>>(),
}));

vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { goldfishStart, goldfishAct, goldfishEnd },
}));

beforeEach(() => {
  goldfishStart.mockReset().mockResolvedValue(openingHandView());
  goldfishAct.mockReset();
  goldfishEnd.mockReset().mockResolvedValue(undefined);
});

describe("useGoldfishGame", () => {
  it("deals the deck's list with a fresh seed, and puts the game away on unmount", async () => {
    const { result, unmount } = renderHook(() => useGoldfishGame(7, "theory"));
    await waitFor(() => expect(result.current.view?.stage).toBe("mulligan"));
    expect(goldfishStart).toHaveBeenCalledWith(7, "theory", expect.any(Number));
    expect(Number.isSafeInteger(goldfishStart.mock.calls[0][2])).toBe(true);
    unmount();
    expect(goldfishEnd).toHaveBeenCalled();
  });

  it("sends actions one at a time, in order, and logs what each did", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    goldfishAct.mockImplementation(async (a) => {
      const type = (a as { type: string }).type;
      order.push(`start ${type}`);
      if (type === "nextTurn") await new Promise<void>((r) => (release = r));
      order.push(`end ${type}`);
      return {
        view: turnNineView(),
        happened: type === "nextTurn" ? [{ type: "turnBegan", turn: 9 }] : [{ type: "shuffled" }],
      };
    });
    const { result } = renderHook(() => useGoldfishGame(7, "live"));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    act(() => {
      result.current.act({ type: "nextTurn" });
      result.current.act({ type: "shuffle" });
    });
    await waitFor(() => expect(result.current.busy).toBe(true));
    await waitFor(() => expect(order).toEqual(["start nextTurn"]));
    release();
    await waitFor(() => expect(result.current.busy).toBe(false));
    expect(order).toEqual(["start nextTurn", "end nextTurn", "start shuffle", "end shuffle"]);
    expect(result.current.log.map((l) => l.text).slice(0, 2)).toEqual([
      "Shuffled the library",
      "Untapped · turn 9 begins",
    ]);
  });

  it("shows a refusal and keeps the board it had", async () => {
    goldfishAct.mockRejectedValue("That card is no longer where it was.");
    const { result } = renderHook(() => useGoldfishGame(7, "live"));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const before = result.current.view;
    act(() => result.current.act({ type: "play", id: 1 }));
    await waitFor(() => expect(result.current.error).toBe("That card is no longer where it was."));
    expect(result.current.view).toBe(before);
  });

  // Issue #1022: the engine takes the game back; the hook takes the action's lines off the log.
  it("takes an undone action's lines off the log, and a redone one's back on", async () => {
    goldfishAct.mockImplementation(async (a) => {
      const type = (a as { type: string }).type;
      return {
        view: turnNineView(),
        happened: type === "shuffle" ? [{ type: "shuffled" }] : [],
      };
    });
    const { result } = renderHook(() => useGoldfishGame(7, "live"));
    await waitFor(() => expect(result.current.view).not.toBeNull());
    const texts = () => result.current.log.map((l) => l.text);
    act(() => result.current.act({ type: "shuffle" }));
    await waitFor(() =>
      expect(texts()).toEqual(["Shuffled the library", "Shuffled and drew seven"]),
    );
    act(() => result.current.act({ type: "undo" }));
    await waitFor(() => expect(texts()).toEqual(["Shuffled and drew seven"]));
    act(() => result.current.act({ type: "redo" }));
    await waitFor(() =>
      expect(texts()).toEqual(["Shuffled the library", "Shuffled and drew seven"]),
    );
    expect(goldfishAct).toHaveBeenLastCalledWith({ type: "redo" });
  });
});
