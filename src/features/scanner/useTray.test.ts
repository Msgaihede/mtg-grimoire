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

import { refreshForTables } from "@/lib/crossWindow";
import { TRAY_QUIET_MS, TRAY_RETRY_MS, useTray } from "./useTray";
import { SCANNER_OPEN_ELSEWHERE } from "./verdictText";

const BUSY = "The card database is busy finishing a sync. Try that again in a moment.";

/** The tray's cache entry, spelled as `crossWindow.ts`' `SINGLE_WRITER_KEYS` spells it. */
const TRAY = ["scanner", "tray"];

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** One client per test unless a test passes its own, which is how a view comes back to a cache. */
function mount(qc = client()) {
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

  /**
   * **The lease's refusal is `BUSY`'s twin.** Another window holding the scanner answers a tray
   * write with `OPEN_ELSEWHERE`, and that says nothing about the rows — so they stay, and the one
   * more try goes out on the same schedule.
   */
  it("keeps the rows through a write refused as open elsewhere, and tries once more like BUSY", async () => {
    setScannerTray.mockRejectedValueOnce(SCANNER_OPEN_ELSEWHERE);
    const { result } = mount();
    await advance(0);

    act(() => result.current.setRows(TRAY_ROWS));
    await advance(TRAY_QUIET_MS);
    expect(setScannerTray).toHaveBeenCalledTimes(1);
    expect(result.current.rows).toEqual(TRAY_ROWS);

    await advance(TRAY_RETRY_MS);
    expect(setScannerTray).toHaveBeenCalledTimes(2);
    expect(setScannerTray).toHaveBeenLastCalledWith(TRAY_ROWS);
    expect(result.current.rows).toEqual(TRAY_ROWS);
  });

  /**
   * **A retry never writes what is not there.** The view is gone and so is its cache entry — the
   * rows went with it — and writing `latest()`'s `[]` would store an empty tray over the one the
   * row still holds.
   */
  it("skips a retry that finds its cache entry gone, rather than storing an empty tray", async () => {
    setScannerTray.mockRejectedValueOnce(BUSY);
    const qc = client();
    const { result, unmount } = mount(qc);
    await advance(0);

    act(() => result.current.setRows(TRAY_ROWS));
    unmount();
    expect(setScannerTray, "the premise: the unmount's flush was refused").toHaveBeenCalledTimes(1);
    await advance(0);
    qc.removeQueries({ queryKey: TRAY });

    await advance(TRAY_RETRY_MS);
    expect(setScannerTray).toHaveBeenCalledTimes(1);
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

    /**
     * The commit's answer writes the tray behind it only while there is a tray to write: with the
     * view gone and its entry dropped, `latest()` is `[]` rather than the rows, and storing what is
     * left of *that* would empty the tray the commit had just stored.
     */
    it("writes nothing behind a commit that answers after its entry has gone", async () => {
      const wire = backend();
      scannerTray.mockResolvedValue(TRAY_ROWS);
      const qc = client();
      const { result, unmount } = mount(qc);
      await advance(0);

      const taken = TRAY_ROWS[1];
      let committed!: Promise<ImportCommitOutcome>;
      act(() => {
        committed = result.current.commit([], null, (latest) => latest.filter((row) => row.key !== taken.key));
      });
      await advance(0);
      expect(scannerTrayCommit).toHaveBeenCalledTimes(1);
      unmount();
      qc.removeQueries({ queryKey: TRAY });

      await wire.settleNewestFirst();
      await expect(committed).resolves.toEqual(OUTCOME);
      await advance(TRAY_QUIET_MS * 2);
      await wire.settleNewestFirst();
      expect(setScannerTray).not.toHaveBeenCalled();
      expect(wire.stored()).toEqual(TRAY_ROWS.filter((row) => row !== taken));
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

/**
 * **What another window's refresh may do with a tray this window has left.** `crossWindow.ts`
 * drops an idle tray on every `app_meta` change so the next visit reads the stored row fresh —
 * and asks this hook first whether anything in it is unsaved. These drive that real refresh
 * against the real hook, because the failure is the pair of them: the entry dropped under a write
 * still waiting, and the write then storing nothing or nobody's rows.
 */
describe("useTray under another window's refresh", () => {
  /**
   * Leave the Scanner during a sync: the unmount's flush answers `BUSY`, the one more try is
   * waiting, and some other window's `app_meta` write lands meanwhile.
   */
  it("keeps an idle tray whose refused write is waiting to retry, and the retry stores the rows", async () => {
    setScannerTray.mockRejectedValueOnce(BUSY);
    const qc = client();
    const { result, unmount } = mount(qc);
    await advance(0);
    act(() => result.current.setRows(TRAY_ROWS));
    unmount();
    expect(setScannerTray, "the premise: the unmount's flush was refused").toHaveBeenCalledTimes(1);
    await advance(0);

    refreshForTables(qc, ["app_meta"]);
    expect(qc.getQueryData(TRAY), "the refresh dropped rows the store does not hold").toEqual(TRAY_ROWS);

    await advance(TRAY_RETRY_MS);
    expect(setScannerTray).toHaveBeenCalledTimes(2);
    expect(setScannerTray).toHaveBeenLastCalledWith(TRAY_ROWS);
  });

  /**
   * **A sync outlasts one retry.** First runs hold the write connection for minutes, so the one
   * more try is refused as well and nothing is queued, on the wire or waiting — and the rows are
   * still nowhere but here. They stay until a write lands, and the entry is ordinary again after.
   */
  it("keeps it after the one more try is refused too, and drops it once a write has landed", async () => {
    setScannerTray.mockRejectedValue(BUSY);
    const qc = client();
    const first = mount(qc);
    await advance(0);
    act(() => first.result.current.setRows(TRAY_ROWS));
    first.unmount();
    await advance(0);
    await advance(TRAY_RETRY_MS);
    expect(setScannerTray, "the premise: the flush and its retry were both refused").toHaveBeenCalledTimes(2);
    await advance(TRAY_RETRY_MS * 5);

    refreshForTables(qc, ["app_meta"]);
    expect(qc.getQueryData(TRAY)).toEqual(TRAY_ROWS);

    // The sync is over; the reader comes back to the rows they left and scans one more.
    setScannerTray.mockResolvedValue(undefined);
    const second = mount(qc);
    await advance(0);
    expect(second.result.current.rows).toEqual(TRAY_ROWS);
    act(() => second.result.current.setRows(TRAY_ROWS.slice(1)));
    await advance(TRAY_QUIET_MS);
    expect(setScannerTray).toHaveBeenLastCalledWith(TRAY_ROWS.slice(1));
    second.unmount();
    await advance(0);

    refreshForTables(qc, ["app_meta"]);
    expect(qc.getQueryCache().find({ queryKey: TRAY, exact: true })).toBeUndefined();
  });
});
