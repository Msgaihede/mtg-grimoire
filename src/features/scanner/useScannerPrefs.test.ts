import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScanFilters, ScannerPrefs } from "@/lib/ipc";
import { DEFAULT_SCANNER_PREFS } from "./fixtures";

const scannerPrefs = vi.fn<() => Promise<ScannerPrefs>>();
const setScannerPrefs = vi.fn<(prefs: ScannerPrefs) => Promise<void>>();
const scannerSetFilters = vi.fn<(filters: ScanFilters) => Promise<void>>();

// The three commands the hook calls and nothing else. `ipcError` stays the real one, because the
// sentence a refusal becomes is what the filter popover prints.
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    scannerPrefs: () => scannerPrefs(),
    setScannerPrefs: (prefs: ScannerPrefs) => setScannerPrefs(prefs),
    scannerSetFilters: (filters: ScanFilters) => scannerSetFilters(filters),
  },
}));

import { SCANNER_ELSEWHERE_POLL_MS } from "./useScannerElsewhere";
import { PREFS_RETRY_MS, SCANNER_PREFS_BEFORE_LOAD, useScannerPrefs } from "./useScannerPrefs";
import { SCANNER_OPEN_ELSEWHERE } from "./verdictText";

/** `db::BUSY`, verbatim — the one refusal `set_scanner_prefs` has. */
const BUSY = "The card database is busy finishing a sync. Try that again in a moment.";
const REFUSED = "No printing matches these filters.";

const HOB: ScanFilters = { sets: ["hob"], released_from: null, released_to: null };
const ZZZ: ScanFilters = { sets: ["zzz"], released_from: null, released_to: null };

/** A reader who narrowed the scanner last session — the row a wrong revert would erase. */
const STORED: ScannerPrefs = { ...DEFAULT_SCANNER_PREFS, filters: HOB };

/** One client per test unless a test passes its own, which is how a view comes back to a cache. */
function mount(qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  return renderHook(() => useScannerPrefs(), { wrapper });
}

beforeEach(() => {
  scannerPrefs.mockReset().mockResolvedValue(DEFAULT_SCANNER_PREFS);
  setScannerPrefs.mockReset().mockResolvedValue(undefined);
  scannerSetFilters.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useScannerPrefs", () => {
  /**
   * The hook spells the crate's default itself so the app bundle does not carry the fixtures
   * module — and the fixture is `ScannerPrefs::default()` verbatim, which the fake answers for a
   * row never written. Two copies of one value agree here or nowhere.
   */
  it("draws the crate's own default before the row loads", () => {
    expect(SCANNER_PREFS_BEFORE_LOAD).toEqual(DEFAULT_SCANNER_PREFS);
  });

  it("starts on the defaults, loads the stored prefs and pushes their filters to the session", async () => {
    const stored: ScannerPrefs = { ...DEFAULT_SCANNER_PREFS, mode: "exact", filters: HOB, folderId: 3 };
    scannerPrefs.mockResolvedValue(stored);
    const { result } = mount();
    expect(result.current.prefs).toEqual(DEFAULT_SCANNER_PREFS);
    expect(result.current.loaded).toBe(false);

    await waitFor(() => expect(result.current.loaded).toBe(true));
    expect(result.current.prefs).toEqual(stored);
    expect(scannerSetFilters).toHaveBeenCalledWith(HOB);
    // Reading the row back is not a change to it.
    expect(setScannerPrefs).not.toHaveBeenCalled();
  });

  /**
   * **`loaded` waits for the session to have the filters as well as for the row**, which is what
   * lets the page hold its first frame until the scanner is narrowed the way the popover says.
   */
  it("is not loaded until the stored filters have reached the session", async () => {
    let accept!: () => void;
    scannerSetFilters.mockReturnValueOnce(new Promise<void>((resolve) => (accept = resolve)));
    const { result } = mount();
    await waitFor(() => expect(scannerSetFilters).toHaveBeenCalled());
    expect(result.current.loaded).toBe(false);
    await act(async () => accept());
    expect(result.current.loaded).toBe(true);
  });

  it("applies an update at once and persists the whole row", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.update({ mode: "exact" }));
    await waitFor(() => expect(result.current.prefs.mode).toBe("exact"));
    expect(setScannerPrefs).toHaveBeenCalledWith({ ...DEFAULT_SCANNER_PREFS, mode: "exact" });
  });

  it("sends changed filters to the session and persists them once the session accepts", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    act(() => result.current.update({ filters: HOB }));
    await waitFor(() =>
      expect(setScannerPrefs).toHaveBeenCalledWith({ ...DEFAULT_SCANNER_PREFS, filters: HOB }),
    );
    expect(scannerSetFilters).toHaveBeenLastCalledWith(HOB);
    expect(result.current.prefs.filters).toEqual(HOB);
    expect(result.current.filterError).toBeNull();
  });

  /**
   * A refusal is a scanner still searching under the filters it had, so the popover must say
   * those — and the row must never hold a filter the session has refused, or the next launch
   * would push the refusal straight back at the reader.
   */
  it("keeps the previous filters and exposes the sentence when the session refuses", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    scannerSetFilters.mockRejectedValueOnce(REFUSED);
    act(() => result.current.update({ filters: ZZZ }));
    await waitFor(() => expect(result.current.filterError).toBe(REFUSED));
    expect(result.current.prefs.filters).toEqual(DEFAULT_SCANNER_PREFS.filters);
    for (const [prefs] of setScannerPrefs.mock.calls) expect(prefs.filters).not.toEqual(ZZZ);

    // …and the next filter the session takes clears the sentence.
    act(() => result.current.update({ filters: HOB }));
    await waitFor(() => expect(result.current.filterError).toBeNull());
    expect(result.current.prefs.filters).toEqual(HOB);
  });

  /** Another field changed while a filter is refused must not carry the refused filter in. */
  it("persists the accepted filters beside a later change, never a refused one", async () => {
    const { result } = mount();
    await waitFor(() => expect(result.current.loaded).toBe(true));

    let refuse!: (e: unknown) => void;
    scannerSetFilters.mockReturnValueOnce(new Promise<void>((_, reject) => (refuse = reject)));
    act(() => result.current.update({ filters: ZZZ }));
    // The switch is pressed while the session is still deciding about the filter.
    act(() => result.current.update({ developer: true }));
    await waitFor(() =>
      expect(setScannerPrefs).toHaveBeenLastCalledWith({ ...DEFAULT_SCANNER_PREFS, developer: true }),
    );
    await act(async () => refuse(REFUSED));
    expect(result.current.prefs).toEqual({ ...DEFAULT_SCANNER_PREFS, developer: true });
  });

  /**
   * **A BUSY write keeps the prefs in memory and says nothing** — a sync holds the write
   * connection for seconds, and the reader's switch has not failed, it is waiting. One more try
   * after a short delay is what makes a change nobody follows up survive a restart.
   */
  it("keeps the prefs through a BUSY write and tries once more after a short delay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    setScannerPrefs.mockRejectedValueOnce(BUSY);
    const { result } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.loaded).toBe(true);

    act(() => result.current.update({ developer: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(setScannerPrefs).toHaveBeenCalledTimes(1);
    expect(result.current.prefs.developer).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREFS_RETRY_MS);
    });
    expect(setScannerPrefs).toHaveBeenCalledTimes(2);
    expect(setScannerPrefs).toHaveBeenLastCalledWith({ ...DEFAULT_SCANNER_PREFS, developer: true });
    expect(result.current.filterError).toBeNull();

    // Once more and no further: a write that is still refused waits for the next change.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREFS_RETRY_MS * 5);
    });
    expect(setScannerPrefs).toHaveBeenCalledTimes(2);
  });
});

/**
 * **The lease's refusal is not an answer about the filters.** `scanner_set_filters` refuses with
 * `OPEN_ELSEWHERE` when another window holds the scanner, which says nothing about whether these
 * filters match a printing — so none of what an ordinary refusal does may follow from it.
 */
describe("useScannerPrefs while another window holds the scanner", () => {
  it("keeps the stored filters and writes them, not none, beside a later change", async () => {
    scannerPrefs.mockResolvedValue(STORED);
    let refuse!: (e: unknown) => void;
    scannerSetFilters.mockReturnValueOnce(new Promise<void>((_, reject) => (refuse = reject)));
    const { result } = mount();
    await waitFor(() => expect(scannerSetFilters).toHaveBeenCalledWith(HOB));
    await act(async () => refuse(SCANNER_OPEN_ELSEWHERE));

    expect(result.current.prefs.filters).toEqual(HOB);
    // The gate's sentence is what tells the reader, not the filter popover's.
    expect(result.current.filterError).toBeNull();
    // Still held: the session has not got these filters, so no frame may go out under none.
    expect(result.current.loaded).toBe(false);

    act(() => result.current.update({ developer: true }));
    await waitFor(() => expect(setScannerPrefs).toHaveBeenCalled());
    expect(setScannerPrefs).toHaveBeenLastCalledWith({ ...STORED, developer: true });
  });

  /** The cache outlives the view (`gcTime: Infinity`), so a revert there is what the next visit draws. */
  it("hands a view that comes back the stored filters to push, not none", async () => {
    scannerPrefs.mockResolvedValue(STORED);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let refuse!: (e: unknown) => void;
    scannerSetFilters.mockReturnValueOnce(new Promise<void>((_, reject) => (refuse = reject)));
    const first = mount(qc);
    await waitFor(() => expect(scannerSetFilters).toHaveBeenCalledTimes(1));
    await act(async () => refuse(SCANNER_OPEN_ELSEWHERE));
    first.unmount();

    const second = mount(qc);
    await waitFor(() => expect(second.result.current.loaded).toBe(true));
    expect(scannerSetFilters).toHaveBeenLastCalledWith(HOB);
    expect(second.result.current.prefs.filters).toEqual(HOB);
  });

  /**
   * The other window can let go in the moment between the refusal and the gate's second ask, and
   * then the view stays. Held until the session has the filters, it would never scan — so the push
   * goes out again at the gate's own pace until the session answers it.
   */
  it("sends the refused push again while mounted, and loads once the session takes it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    scannerPrefs.mockResolvedValue(STORED);
    scannerSetFilters.mockRejectedValueOnce(SCANNER_OPEN_ELSEWHERE);
    const { result } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(scannerSetFilters).toHaveBeenCalledTimes(1);
    expect(result.current.loaded).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCANNER_ELSEWHERE_POLL_MS);
    });
    expect(scannerSetFilters).toHaveBeenCalledTimes(2);
    expect(scannerSetFilters).toHaveBeenLastCalledWith(HOB);
    expect(result.current.loaded).toBe(true);
    expect(result.current.prefs.filters).toEqual(HOB);
    // Still the mount's own push, answered late: a reading of the row, not a change to it.
    expect(setScannerPrefs).not.toHaveBeenCalled();
  });

  /** A view that has gone must not push again — an accepted push is the lease, taken. */
  it("sends nothing again once the view has gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    scannerSetFilters.mockRejectedValueOnce(SCANNER_OPEN_ELSEWHERE);
    const { unmount } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(scannerSetFilters).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCANNER_ELSEWHERE_POLL_MS * 5);
    });
    expect(scannerSetFilters).toHaveBeenCalledTimes(1);
  });

  /** …including when the refusal itself only lands after the view has gone. */
  it("sends nothing again when the refusal lands after the view has gone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let refuse!: (e: unknown) => void;
    scannerSetFilters.mockReturnValueOnce(new Promise<void>((_, reject) => (refuse = reject)));
    const { unmount } = mount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(scannerSetFilters).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => refuse(SCANNER_OPEN_ELSEWHERE));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SCANNER_ELSEWHERE_POLL_MS * 5);
    });
    expect(scannerSetFilters).toHaveBeenCalledTimes(1);
  });
});
