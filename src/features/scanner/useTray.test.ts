import { createElement, type ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CollectionImportItem, ImportCommitOutcome, ScannerTrayRow } from "@/lib/ipc";
import { TRAY_ROWS } from "./fixtures";

const scannerTray = vi.fn<() => Promise<ScannerTrayRow[]>>();
const setScannerTray = vi.fn<(rows: ScannerTrayRow[]) => Promise<void>>();
const scannerTrayCommit =
  vi.fn<
    (items: CollectionImportItem[], folderId: number | null, remaining: ScannerTrayRow[]) => Promise<ImportCommitOutcome>
  >();

vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    scannerTray: () => scannerTray(),
    setScannerTray: (rows: ScannerTrayRow[]) => setScannerTray(rows),
    scannerTrayCommit: (items: CollectionImportItem[], folderId: number | null, remaining: ScannerTrayRow[]) =>
      scannerTrayCommit(items, folderId, remaining),
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

const OUTCOME: ImportCommitOutcome = { added: 1, updated: 0, removed: 0 };

/**
 * A backend that applies each write **when it answers** — the stored tray is whatever landed last —
 * and a hand that answers everything on the wire **newest first**, the order in which an older
 * write lands after a newer one. With single-flight writes there is only ever one on the wire, so
 * the order cannot matter; without them, it is exactly the race that restored committed rows.
 */
function backend() {
  const onTheWire: Array<() => void> = [];
  let stored: ScannerTrayRow[] = [];
  setScannerTray.mockImplementation(
    (rows) =>
      new Promise((resolve) =>
        onTheWire.push(() => {
          stored = rows;
          resolve();
        }),
      ),
  );
  scannerTrayCommit.mockImplementation(
    (_items, _folderId, remaining) =>
      new Promise((resolve) =>
        onTheWire.push(() => {
          stored = remaining;
          resolve(OUTCOME);
        }),
      ),
  );
  return {
    stored: () => stored,
    /** Answer every call on the wire, newest first, until nothing more goes out. */
    async settleNewestFirst() {
      while (onTheWire.length > 0) {
        for (const land of onTheWire.splice(0).reverse()) land();
        await advance(0);
      }
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  scannerTray.mockReset().mockResolvedValue([]);
  setScannerTray.mockReset().mockResolvedValue(undefined);
  scannerTrayCommit.mockReset().mockResolvedValue(OUTCOME);
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

  describe("single flight", () => {
    /**
     * **The commit waits for the tray write already on the wire.** Sent beside it, the write could
     * land second — a sync holding the connection answers them in whatever order it frees — and put
     * the committed rows back in the stored tray, which the next launch offered again and the next
     * Add filed twice.
     */
    it("sends a commit only after the tray write on the wire has answered, so that write cannot restore what it filed", async () => {
      const wire = backend();
      scannerTray.mockResolvedValue(TRAY_ROWS);
      const { result } = mount();
      await advance(0);

      const edited = TRAY_ROWS.map((row, i) => (i === 1 ? { ...row, quantity: row.quantity + 1 } : row));
      act(() => result.current.setRows(edited));
      await advance(TRAY_QUIET_MS);
      expect(setScannerTray, "the premise: a tray write is on the wire").toHaveBeenCalledTimes(1);

      const taken = edited[1];
      let committed!: Promise<ImportCommitOutcome>;
      act(() => {
        committed = result.current.commit([], null, (latest) => latest.filter((row) => row.key !== taken.key));
      });
      await advance(0);
      expect(scannerTrayCommit, "the commit went out beside a write still on the wire").not.toHaveBeenCalled();

      await wire.settleNewestFirst();
      await expect(committed).resolves.toEqual(OUTCOME);
      expect(scannerTrayCommit).toHaveBeenCalledWith([], null, edited.filter((row) => row.key !== taken.key));
      expect(wire.stored().map((row) => row.key)).not.toContain(taken.key);
      expect(result.current.rows.map((row) => row.key)).not.toContain(taken.key);

      // And nothing written behind it puts the row back.
      await advance(TRAY_QUIET_MS * 2);
      await wire.settleNewestFirst();
      expect(wire.stored().map((row) => row.key)).not.toContain(taken.key);
    });

    it("works out what is left against the rows as they are when the commit goes out, not when it was pressed", async () => {
      const wire = backend();
      scannerTray.mockResolvedValue(TRAY_ROWS);
      const { result } = mount();
      await advance(0);
      act(() => result.current.setRows(TRAY_ROWS.slice(0, 3)));
      await advance(TRAY_QUIET_MS);
      expect(setScannerTray, "the premise: a tray write is on the wire").toHaveBeenCalledTimes(1);

      const pressed = result.current.latest();
      act(() => {
        void result.current.commit([], null, (latest) => latest.filter((row) => !pressed.includes(row)));
      });
      // A card lands while the commit waits its turn.
      const landed: ScannerTrayRow = { ...TRAY_ROWS[3], key: "landed-while-queued" };
      act(() => result.current.setRows([landed, ...pressed]));
      await wire.settleNewestFirst();
      expect(scannerTrayCommit).toHaveBeenCalledWith([], null, [landed]);
      expect(wire.stored()).toEqual([landed]);
    });

    it("folds the writes asked for while one is on the wire into one, carrying the latest rows", async () => {
      const wire = backend();
      const { result } = mount();
      await advance(0);

      act(() => result.current.setRows(TRAY_ROWS.slice(0, 1)));
      await advance(TRAY_QUIET_MS);
      act(() => result.current.setRows(TRAY_ROWS.slice(0, 2)));
      await advance(TRAY_QUIET_MS);
      act(() => result.current.setRows(TRAY_ROWS.slice(0, 3)));
      await advance(TRAY_QUIET_MS);
      expect(setScannerTray, "a second write went out beside the first").toHaveBeenCalledTimes(1);

      await wire.settleNewestFirst();
      expect(setScannerTray).toHaveBeenCalledTimes(2);
      expect(setScannerTray).toHaveBeenLastCalledWith(TRAY_ROWS.slice(0, 3));
      expect(wire.stored()).toEqual(TRAY_ROWS.slice(0, 3));
    });

    /** The camera keeps running while the commit waits: a card landing then is not the commit's. */
    it("keeps a card that landed while the commit was on the wire, and writes the tray behind it", async () => {
      const wire = backend();
      scannerTray.mockResolvedValue(TRAY_ROWS);
      const { result } = mount();
      await advance(0);

      const taken = TRAY_ROWS[1];
      let committed!: Promise<ImportCommitOutcome>;
      act(() => {
        committed = result.current.commit([], null, (latest) => latest.filter((row) => row.key !== taken.key));
      });
      await advance(0);
      expect(scannerTrayCommit).toHaveBeenCalledWith([], null, TRAY_ROWS.filter((row) => row !== taken));

      const landed: ScannerTrayRow = { ...TRAY_ROWS[2], key: "landed-in-flight", addedAt: 9 };
      act(() => result.current.setRows([landed, ...TRAY_ROWS]));
      await wire.settleNewestFirst();
      await expect(committed).resolves.toEqual(OUTCOME);
      const after = [landed, ...TRAY_ROWS.filter((row) => row !== taken)];
      expect(result.current.rows).toEqual(after);

      await advance(TRAY_QUIET_MS);
      await wire.settleNewestFirst();
      expect(wire.stored()).toEqual(after);
    });

    it("keeps every row when the commit is refused, and the next write still goes out", async () => {
      scannerTray.mockResolvedValue(TRAY_ROWS);
      scannerTrayCommit.mockRejectedValueOnce(BUSY);
      const { result } = mount();
      await advance(0);

      let refusal: unknown = null;
      await act(async () => {
        await result.current.commit([], null, () => []).catch((e: unknown) => {
          refusal = e;
        });
      });
      expect(refusal).toBe(BUSY);
      expect(result.current.rows).toEqual(TRAY_ROWS);
      expect(setScannerTray).not.toHaveBeenCalled();

      act(() => result.current.setRows(TRAY_ROWS.slice(1)));
      await advance(TRAY_QUIET_MS);
      expect(setScannerTray).toHaveBeenCalledWith(TRAY_ROWS.slice(1));
    });
  });
});
