import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerTrayRow } from "@/lib/ipc";
import { TRAY_ROWS } from "./fixtures";

const scannerTray = vi.fn<() => Promise<ScannerTrayRow[]>>();
const setScannerTray = vi.fn<(rows: ScannerTrayRow[]) => Promise<void>>();

vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    scannerTray: () => scannerTray(),
    setScannerTray: (rows: ScannerTrayRow[]) => setScannerTray(rows),
  },
}));

import { TRAY_QUIET_MS, TRAY_RETRY_MS, useTray } from "./useTray";

const BUSY = "The card database is busy finishing a sync. Try that again in a moment.";

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useTray(), { wrapper });
}

/**
 * The clock moved by `ms`, with every promise that settles on the way drained.
 *
 * Never `waitFor` and never `userEvent` in this file — both schedule on the timers faked here and
 * hang the test rather than failing it. TanStack Query notifies on `setTimeout(0)` too, which is
 * why even a zero advance is a real step.
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  scannerTray.mockReset().mockResolvedValue([]);
  setScannerTray.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useTray", () => {
  it("loads the stored tray, and reading it back writes nothing", async () => {
    scannerTray.mockResolvedValue(TRAY_ROWS);
    const { result } = mount();
    expect(result.current.rows).toEqual([]);
    expect(result.current.loaded).toBe(false);
    await advance(0);
    expect(result.current.loaded).toBe(true);
    expect(result.current.rows).toEqual(TRAY_ROWS);
    await advance(TRAY_QUIET_MS * 2);
    expect(setScannerTray).not.toHaveBeenCalled();
  });

  /**
   * A stepper held down is a dozen writes a second, and the tray is written whole — so the store
   * gets the tray once the reader stops, and gets the *last* one.
   */
  it("shows every change at once and persists two quick ones once, with the last value", async () => {
    const { result } = mount();
    await advance(0);

    const first = TRAY_ROWS.slice(0, 1);
    const second = TRAY_ROWS.slice(0, 2);
    act(() => result.current.setRows(first));
    await advance(0);
    expect(result.current.rows).toEqual(first);
    await advance(TRAY_QUIET_MS - 100);
    act(() => result.current.setRows(second));
    await advance(0);
    expect(result.current.rows).toEqual(second);

    await advance(TRAY_QUIET_MS - 1);
    expect(setScannerTray).not.toHaveBeenCalled();
    await advance(1);
    expect(setScannerTray).toHaveBeenCalledTimes(1);
    expect(setScannerTray).toHaveBeenCalledWith(second);
  });

  /** Leaving the Scanner inside the quiet window must not cost the reader the card they just scanned. */
  it("flushes a pending write when it unmounts", async () => {
    const { result, unmount } = mount();
    await advance(0);

    act(() => result.current.setRows(TRAY_ROWS));
    unmount();
    expect(setScannerTray).toHaveBeenCalledTimes(1);
    expect(setScannerTray).toHaveBeenCalledWith(TRAY_ROWS);
    // …and the timer it replaced does not write a second time.
    await advance(TRAY_QUIET_MS * 2);
    expect(setScannerTray).toHaveBeenCalledTimes(1);
  });

  it("writes nothing on unmount when nothing is pending", async () => {
    const { unmount } = mount();
    await advance(0);
    unmount();
    expect(setScannerTray).not.toHaveBeenCalled();
  });

  /**
   * **A BUSY write keeps the rows and says nothing.** Rows scanned during a sync are the reader's
   * cards, and the store is only where they survive a restart — so the tray stays on screen, and
   * one more try after a short delay is what makes them survive one.
   */
  it("keeps the rows through a BUSY write and tries once more after a short delay", async () => {
    setScannerTray.mockRejectedValueOnce(BUSY);
    const { result } = mount();
    await advance(0);

    act(() => result.current.setRows(TRAY_ROWS));
    await advance(TRAY_QUIET_MS);
    expect(setScannerTray).toHaveBeenCalledTimes(1);
    expect(result.current.rows).toEqual(TRAY_ROWS);

    await advance(TRAY_RETRY_MS);
    expect(setScannerTray).toHaveBeenCalledTimes(2);
    expect(setScannerTray).toHaveBeenLastCalledWith(TRAY_ROWS);
    await advance(TRAY_RETRY_MS * 5);
    expect(setScannerTray).toHaveBeenCalledTimes(2);
  });

  /** The retry writes the tray as it is by then, not as it was when the write was refused. */
  it("retries with the rows as they are when the retry runs", async () => {
    setScannerTray.mockRejectedValueOnce(BUSY);
    const { result } = mount();
    await advance(0);

    act(() => result.current.setRows(TRAY_ROWS.slice(0, 1)));
    await advance(TRAY_QUIET_MS);
    expect(setScannerTray).toHaveBeenCalledTimes(1);
    // A card lands in the quiet window of the retry…
    act(() => result.current.setRows(TRAY_ROWS.slice(0, 2)));
    await advance(TRAY_QUIET_MS);
    // …and its own write is the next one; the retry does not come round again with the old tray.
    await advance(TRAY_RETRY_MS);
    for (const [rows] of setScannerTray.mock.calls.slice(1)) expect(rows).toEqual(TRAY_ROWS.slice(0, 2));
  });
});
