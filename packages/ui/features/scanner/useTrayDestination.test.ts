import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ScannerTrayRow } from "@/lib/ipc";
import { VERDICTS } from "./fixtures";
import { NO_FINISHED_ROWS, rowFromDecision } from "./reader/tray";
import type { TrayState } from "./useTray";
import { heldNotice, useTrayDestination, type TrayDestination } from "./useTrayDestination";

const resolved = VERDICTS.resolved.decision!;
const ambiguous = VERDICTS.ambiguous.decision!;

/** A resolved row under names this file controls. Built per call: a row is told apart by identity. */
function row(key: string, over: Partial<ScannerTrayRow> = {}): ScannerTrayRow {
  return { ...rowFromDecision(resolved, { finish: "nonfoil" }, 1, key), cardId: key, ...over };
}

/**
 * The tray as the hook reads it: rows, and the two doors the page hands it. `latest()` answers the
 * array the last `setRows` passed in, as the real one does — which is what lets a test land a card
 * "while the write is out" by writing through `setRows` from outside the hook.
 */
function trayOf(initial: ScannerTrayRow[], loaded = true) {
  let rows = initial;
  const tray = {
    get rows() {
      return rows;
    },
    loaded,
    latest: () => rows,
    setRows: vi.fn((next: ScannerTrayRow[]) => {
      rows = next;
    }),
  } satisfies Pick<TrayState, "rows" | "loaded" | "latest" | "setRows">;
  return tray;
}

/** A destination whose write the test settles itself, so "meanwhile" has a moment to happen in. */
function destinationOf(over: Partial<TrayDestination> = {}) {
  const settle: { resolve: () => void; reject: (reason: unknown) => void }[] = [];
  const commit = vi.fn<TrayDestination["commit"]>(
    () => new Promise<void>((resolve, reject) => settle.push({ resolve, reject })),
  );
  const destination: TrayDestination = {
    title: "Scanned for their side",
    name: "their side",
    commit,
    ...over,
  };
  return { destination, commit, settle };
}

describe("useTrayDestination", () => {
  it("hands the ready rows to the destination and then takes exactly those out of the tray, leaving a card scanned meanwhile", async () => {
    const bolt = row("bolt");
    const saga = row("saga", { quantity: 3 });
    const tray = trayOf([bolt, saga]);
    const onCommitted = vi.fn();
    const { destination, commit, settle } = destinationOf({ onCommitted });
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));

    let pressed!: Promise<number | null>;
    act(() => {
      pressed = result.current.commit();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toEqual([bolt, saga]);
    expect(result.current.committing).toBe(true);
    // The destination is written first: the tray has not been touched while the write is out.
    expect(tray.setRows).not.toHaveBeenCalled();

    // The camera keeps running — a card lands at the head of the tray before the write answers.
    const tomb = row("tomb");
    tray.setRows([tomb, bolt, saga]);
    tray.setRows.mockClear();

    await act(async () => {
      settle[0].resolve();
      await pressed;
    });
    expect(await pressed).toBe(4);
    expect(tray.setRows).toHaveBeenCalledTimes(1);
    expect(tray.latest()).toEqual([tomb]);
    // The very row, not a copy: nothing about a card the press never saw is rewritten.
    expect(tray.latest()[0]).toBe(tomb);
    expect(onCommitted).toHaveBeenCalledWith(1);
    expect(result.current.committing).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("keeps the copies a taken row gained while the write was out", async () => {
    const bolt = row("bolt", { quantity: 2 });
    const tray = trayOf([bolt]);
    const { destination, settle } = destinationOf();
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));
    let pressed!: Promise<number | null>;
    act(() => {
      pressed = result.current.commit();
    });
    // The same card scanned again: the reducer builds a new row object with one more copy.
    tray.setRows([{ ...bolt, quantity: 3 }]);
    await act(async () => {
      settle[0].resolve();
      await pressed;
    });
    expect(tray.latest().map((r) => [r.key, r.quantity])).toEqual([["bolt", 1]]);
  });

  it("leaves a row of unknown finish in the tray and does not hand it over", async () => {
    const bolt = row("bolt");
    const unknown = row("unknown", { finish: "unknown" });
    const tray = trayOf([unknown, bolt]);
    const onCommitted = vi.fn();
    const { destination, commit, settle } = destinationOf({ onCommitted });
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));
    let pressed!: Promise<number | null>;
    act(() => {
      pressed = result.current.commit();
    });
    expect(commit.mock.calls[0][0]).toEqual([bolt]);
    await act(async () => {
      settle[0].resolve();
      await pressed;
    });
    expect(tray.latest()).toEqual([unknown]);
    expect(onCommitted).toHaveBeenCalledWith(1);
  });

  it("leaves the tray exactly as it was when the destination refuses, and says the refusal", async () => {
    const bolt = row("bolt");
    const saga = row("saga");
    const tray = trayOf([bolt, saga]);
    const onCommitted = vi.fn();
    const { destination, commit, settle } = destinationOf({ onCommitted });
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));
    let pressed!: Promise<number | null>;
    act(() => {
      pressed = result.current.commit();
    });
    await act(async () => {
      // The backend's own sentence, as a Tauri command rejects: a bare string.
      settle[0].reject("This trade is finished. Reopen it to change it.");
      await pressed;
    });
    expect(await pressed).toBeNull();
    expect(tray.setRows).not.toHaveBeenCalled();
    expect(tray.latest()).toEqual([bolt, saga]);
    expect(result.current.error).toBe("This trade is finished. Reopen it to change it.");
    expect(result.current.committing).toBe(false);
    expect(onCommitted).not.toHaveBeenCalled();

    // The rows are not stranded by the refusal: the next press carries them again, and clears
    // the sentence while it is out.
    act(() => {
      pressed = result.current.commit();
    });
    expect(commit).toHaveBeenCalledTimes(2);
    expect(commit.mock.calls[1][0]).toEqual([bolt, saga]);
    expect(result.current.error).toBeNull();
    await act(async () => {
      settle[1].resolve();
      await pressed;
    });
    expect(tray.latest()).toEqual([]);
  });

  it("refuses while a printing is unpicked, in the collection commit's own words, and writes nothing", async () => {
    const waiting = rowFromDecision(ambiguous, { finish: "nonfoil" }, 2, "waiting");
    const tray = trayOf([waiting, row("bolt")]);
    const { destination, commit } = destinationOf();
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));
    await act(async () => {
      expect(await result.current.commit()).toBeNull();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.error).toBe(
      "1 scanned card is still waiting for a printing to be picked.",
    );
    expect(tray.setRows).not.toHaveBeenCalled();
  });

  it("refuses a tray of nothing but unknown finishes", async () => {
    const tray = trayOf([row("unknown", { finish: "unknown" })]);
    const { destination, commit } = destinationOf();
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));
    await act(async () => {
      expect(await result.current.commit()).toBeNull();
    });
    expect(commit).not.toHaveBeenCalled();
    expect(result.current.error).toBe(NO_FINISHED_ROWS);
  });

  it("starts one write for two presses in a row", async () => {
    const tray = trayOf([row("bolt")]);
    const { destination, commit, settle } = destinationOf();
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));
    let first!: Promise<number | null>;
    let second!: Promise<number | null>;
    act(() => {
      first = result.current.commit();
      second = result.current.commit();
    });
    expect(await second).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
    await act(async () => {
      settle[0].resolve();
      await first;
    });
  });

  it("does not send rows a write from an earlier mount is still carrying", async () => {
    const bolt = row("bolt");
    const tray = trayOf([bolt]);
    const { destination, commit, settle } = destinationOf();
    const first = renderHook(() => useTrayDestination({ tray, destination }));
    let pressed!: Promise<number | null>;
    act(() => {
      pressed = first.result.current.commit();
    });
    // The surface closes with its write out and is opened again over the same tray.
    first.unmount();
    const second = renderHook(() => useTrayDestination({ tray, destination }));
    await act(async () => {
      expect(await second.result.current.commit()).toBeNull();
    });
    expect(commit).toHaveBeenCalledTimes(1);
    // The first write still takes its rows out when it answers, mounted or not.
    await act(async () => {
      settle[0].resolve();
      await pressed;
    });
    expect(tray.latest()).toEqual([]);
  });

  it("writes nothing over a tray it finds empty when the write answers", async () => {
    const bolt = row("bolt");
    const tray = trayOf([bolt]);
    const { destination, settle } = destinationOf();
    const { result } = renderHook(() => useTrayDestination({ tray, destination }));
    let pressed!: Promise<number | null>;
    act(() => {
      pressed = result.current.commit();
    });
    // What `latest()` answers once the surface has gone and its cache entry with it.
    tray.setRows([]);
    tray.setRows.mockClear();
    await act(async () => {
      settle[0].resolve();
      await pressed;
    });
    expect(tray.setRows).not.toHaveBeenCalled();
  });

  it("does nothing at all without a destination", async () => {
    const tray = trayOf([row("bolt")]);
    const { result } = renderHook(() => useTrayDestination({ tray, destination: undefined }));
    await act(async () => {
      expect(await result.current.commit()).toBeNull();
    });
    expect(tray.setRows).not.toHaveBeenCalled();
    expect(result.current.notice).toBeNull();
    expect(result.current.error).toBeNull();
  });

  describe("the tray it opened on", () => {
    it("says how many cards were already there, and where they would go", () => {
      const tray = trayOf([row("bolt"), row("saga", { quantity: 3 })]);
      const { destination } = destinationOf();
      const { result } = renderHook(() => useTrayDestination({ tray, destination }));
      expect(result.current.notice).toBe(heldNotice(4, "their side"));
      expect(result.current.notice).toMatch(/^4 cards were already in the scanner's tray\./);
      expect(result.current.notice).toContain("onto their side");
      expect(result.current.notice).toContain("Clear all…");
    });

    it("says one card in the singular", () => {
      expect(heldNotice(1, "your side")).toMatch(
        /^1 card was already in the scanner's tray\. It is in this list and goes onto your side/,
      );
    });

    it("says nothing over a tray that opened empty, whatever is scanned afterwards", () => {
      const tray = trayOf([]);
      const { destination } = destinationOf();
      const { result, rerender } = renderHook(() => useTrayDestination({ tray, destination }));
      expect(result.current.notice).toBeNull();
      tray.setRows([row("bolt")]);
      rerender();
      expect(result.current.notice).toBeNull();
    });

    it("waits for the tray to load before deciding what it held", () => {
      const rows = [row("bolt")];
      let loaded = false;
      const tray = {
        get rows() {
          return loaded ? rows : [];
        },
        get loaded() {
          return loaded;
        },
        latest: () => (loaded ? rows : []),
        setRows: vi.fn(),
      };
      const { destination } = destinationOf();
      const { result, rerender } = renderHook(() => useTrayDestination({ tray, destination }));
      expect(result.current.notice).toBeNull();
      loaded = true;
      rerender();
      expect(result.current.notice).toBe(heldNotice(1, "their side"));
    });

    it("counts a held card as it stood, not the copy scanned since, and goes when those rows do", () => {
      const bolt = row("bolt");
      const tray = trayOf([bolt]);
      const { destination } = destinationOf();
      const { result, rerender } = renderHook(() => useTrayDestination({ tray, destination }));
      const tomb = row("tomb");
      tray.setRows([tomb, { ...bolt, quantity: 2 }]);
      rerender();
      expect(result.current.notice).toBe(heldNotice(1, "their side"));
      // The held row removed: what is left was scanned here, and there is nothing to warn about.
      tray.setRows([tomb]);
      rerender();
      expect(result.current.notice).toBeNull();
    });
  });
});
