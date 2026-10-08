import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerAssetsOwed, ScannerAssetsProgress } from "@/lib/ipc";

const scannerAssets = vi.fn<() => Promise<ScannerAssetsOwed>>();
const scannerAssetsFetch = vi.fn<() => Promise<ScannerAssetsOwed>>();
/** The page's one subscriber to `scanner:assets`, or `null` while nobody is listening. */
let heard: ((e: ScannerAssetsProgress) => void) | null = null;
const onScannerAssets = vi.fn((cb: (e: ScannerAssetsProgress) => void) => {
  heard = cb;
  return () => {
    if (heard === cb) heard = null;
  };
});

// The two commands and the event the hook reaches, and nothing else. `ipcError` stays the real
// one: the sentence a refused fetch becomes is what the offer prints.
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    scannerAssets: () => scannerAssets(),
    scannerAssetsFetch: () => scannerAssetsFetch(),
    onScannerAssets: (cb: (e: ScannerAssetsProgress) => void) => onScannerAssets(cb),
  },
}));

import {
  SCANNER_ASSETS_KEY,
  SCANNER_ASSETS_POLL_MS,
  SCANNER_STATUS_KEY,
  useScannerAssets,
} from "./useScannerAssets";

const BUNDLE = { key: "bundle", label: "Card hashes", bytes: 5_874_752 };
const DETECTION = { key: "detectionModel", label: "Text detection model", bytes: 2_510_284 };
const RECOGNITION = { key: "recognitionModel", label: "Text recognition model", bytes: 9_716_568 };

/** A phone before its first download: all three, and nothing running. */
const ALL: ScannerAssetsOwed = {
  owed: [BUNDLE, DETECTION, RECOGNITION],
  bytes: 18_101_604,
  fetching: false,
};
/** A desktop release build, and any host once the files have landed. */
const NOTHING: ScannerAssetsOwed = { owed: [], bytes: 0, fetching: false };
const MODELS: ScannerAssetsOwed = {
  owed: [DETECTION, RECOGNITION],
  bytes: 12_226_852,
  fetching: false,
};

const NOT_PUBLISHED = "card-hashes.bin is not published for this version of the app (HTTP 404).";

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** The hook over `qc`, with `onLoaded` and every `scanner_status` invalidation counted. */
function mount(qc = client()) {
  const onLoaded = vi.fn();
  const invalidated = vi.spyOn(qc, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children);
  const view = renderHook(() => useScannerAssets(onLoaded), { wrapper });
  /** How many times the status was marked stale — the one entry this hook ever invalidates. */
  const statusAsked = () =>
    invalidated.mock.calls.filter(([filters]) => filters?.queryKey === SCANNER_STATUS_KEY).length;
  return { ...view, qc, onLoaded, statusAsked };
}

/** A promise and its two handles, for an answer the test gives when it chooses. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The clock moved by `ms`, with every promise that settles on the way drained — **and one
 * millisecond more.** The query library announces a cache write through a zero timeout, and the
 * fake clock files a timeout that is set *during* a tick one millisecond later, so that a timer
 * re-arming itself cannot spin a tick for ever. A poll that answers on the tick it fired in is
 * therefore announced a millisecond after it, and a clock stopped exactly on the poll never
 * shows it — the cache right and the hook a render behind.
 */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
    await vi.advanceTimersByTimeAsync(1);
  });
}

beforeEach(() => {
  heard = null;
  scannerAssets.mockReset().mockResolvedValue(ALL);
  scannerAssetsFetch.mockReset().mockResolvedValue(NOTHING);
  onScannerAssets.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useScannerAssets", () => {
  /**
   * **The host answers, and no rows is no offer** — whichever way it came to that: a release
   * build whose binary carries the files, or a host that refuses the command outright. Neither
   * is listened to for a fetch nothing could start.
   */
  it("owes nothing where the host answers nothing or refuses, and listens for no fetch", async () => {
    scannerAssets.mockResolvedValue(NOTHING);
    const carried = mount();
    await waitFor(() => expect(scannerAssets).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(carried.qc.getQueryData(SCANNER_ASSETS_KEY)).toEqual(NOTHING));
    expect(carried.result.current.owed).toEqual([]);
    expect(carried.result.current.fetching).toBe(false);

    scannerAssets.mockRejectedValue("There is no command named scanner_assets on this host.");
    const refused = mount();
    await waitFor(() => expect(scannerAssets).toHaveBeenCalledTimes(2));
    expect(refused.result.current.owed).toEqual([]);
    expect(refused.result.current.bytes).toBe(0);
    expect(refused.result.current.error).toBeNull();

    expect(onScannerAssets).not.toHaveBeenCalled();
    // A press with nothing owed starts nothing.
    act(() => carried.result.current.fetch());
    act(() => refused.result.current.fetch());
    expect(scannerAssetsFetch).not.toHaveBeenCalled();
    expect(carried.onLoaded).not.toHaveBeenCalled();
    expect(carried.statusAsked()).toBe(0);
  });

  /** Nothing is fetched until the reader says so: mounting asks what is owed and stops there. */
  it("answers what is owed and fetches nothing uninvited", async () => {
    const { result, onLoaded } = mount();
    await waitFor(() => expect(result.current.owed).toHaveLength(3));
    expect(result.current.bytes).toBe(18_101_604);
    expect(result.current.fetching).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(scannerAssetsFetch).not.toHaveBeenCalled();
    expect(onLoaded).not.toHaveBeenCalled();
    expect(onScannerAssets).toHaveBeenCalledTimes(1);
  });

  /**
   * **The press, start to end.** The entry says fetching before the command has answered; the
   * progress is the event's; and the end is the command's own answer — after which the status
   * is asked again and the page is told, once, that the engine's session is a new one.
   */
  it("fetches on the press, hears how far it has got, and tells the page once when it ends", async () => {
    const going = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(going.promise);
    const { result, qc, onLoaded, statusAsked } = mount();
    await waitFor(() => expect(result.current.owed).toHaveLength(3));

    act(() => result.current.fetch());
    // Marked in the cache by the press itself, before the command has said anything.
    expect(qc.getQueryData<ScannerAssetsOwed>(SCANNER_ASSETS_KEY)?.fetching).toBe(true);
    await waitFor(() => expect(result.current.fetching).toBe(true));
    expect(scannerAssetsFetch).toHaveBeenCalledTimes(1);
    // A second press while it runs is not a second download.
    act(() => result.current.fetch());
    expect(scannerAssetsFetch).toHaveBeenCalledTimes(1);

    const progress: ScannerAssetsProgress = {
      phase: "downloading",
      file: "bundle",
      done: 262_144,
      total: 18_101_604,
      message: null,
    };
    act(() => heard?.(progress));
    expect(result.current.progress).toEqual(progress);
    expect(onLoaded).not.toHaveBeenCalled();
    expect(statusAsked()).toBe(0);

    await act(async () => going.resolve(NOTHING));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fetching).toBe(false);
    expect(result.current.owed).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(statusAsked()).toBe(1);
    // Its own press was never polled for: the answer is what ended it.
    expect(scannerAssets).toHaveBeenCalledTimes(1);
  });

  /**
   * **A fetch that fails says why, and owes what is still owed.** The bundle landed before a
   * model failed, so the next press is for the two models — read from the host, not assumed.
   * The page is told here too: the engine let its session go for the file that did arrive.
   */
  it("keeps the engine's sentence for a failed fetch and re-reads what is still owed", async () => {
    scannerAssetsFetch.mockRejectedValue(NOT_PUBLISHED);
    const { result, onLoaded, statusAsked } = mount();
    await waitFor(() => expect(result.current.owed).toHaveLength(3));
    scannerAssets.mockResolvedValue(MODELS);

    act(() => result.current.fetch());
    await waitFor(() => expect(result.current.error).toBe(NOT_PUBLISHED));
    expect(result.current.fetching).toBe(false);
    expect(result.current.owed).toEqual(MODELS.owed);
    expect(result.current.bytes).toBe(12_226_852);
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    expect(statusAsked()).toBe(1);

    // The retry is the reader's press, and it clears the last sentence as it goes out.
    const again = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(again.promise);
    act(() => result.current.fetch());
    expect(result.current.error).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(scannerAssetsFetch).toHaveBeenCalledTimes(2);
    await act(async () => again.resolve(NOTHING));
    await waitFor(() => expect(result.current.owed).toEqual([]));
  });

  /** If even the re-read fails, what was owed before the press still is, and the bar is gone. */
  it("falls back to what was owed when the re-read after a failure is refused too", async () => {
    scannerAssetsFetch.mockRejectedValue(NOT_PUBLISHED);
    const { result } = mount();
    await waitFor(() => expect(result.current.owed).toHaveLength(3));
    scannerAssets.mockRejectedValue("the scanner state is poisoned");

    act(() => result.current.fetch());
    await waitFor(() => expect(result.current.error).toBe(NOT_PUBLISHED));
    expect(result.current.fetching).toBe(false);
    expect(result.current.owed).toHaveLength(3);
  });

  /**
   * **A fetch this view did not start** — the reader pressed, left the Scanner view, and came
   * back. The host says one is running, so the view shows it, asks again on a clock until it is
   * over, and then does what it would have done for its own.
   */
  it("follows a fetch it did not start until the host says it is over", async () => {
    vi.useFakeTimers();
    scannerAssets.mockResolvedValue({ ...ALL, fetching: true });
    const { result, onLoaded, statusAsked } = mount();
    await advance(0);
    expect(result.current.fetching).toBe(true);
    expect(onScannerAssets).toHaveBeenCalledTimes(1);
    // A press while it runs starts nothing.
    act(() => result.current.fetch());
    expect(scannerAssetsFetch).not.toHaveBeenCalled();

    await advance(SCANNER_ASSETS_POLL_MS);
    expect(scannerAssets).toHaveBeenCalledTimes(2);
    expect(result.current.fetching).toBe(true);
    expect(onLoaded).not.toHaveBeenCalled();

    scannerAssets.mockResolvedValue(NOTHING);
    await advance(SCANNER_ASSETS_POLL_MS);
    expect(result.current.fetching).toBe(false);
    expect(result.current.owed).toEqual([]);
    expect(onLoaded).toHaveBeenCalledTimes(1);
    expect(statusAsked()).toBe(1);

    // And once it is over, the clock is let go.
    const asked = scannerAssets.mock.calls.length;
    await advance(SCANNER_ASSETS_POLL_MS * 3);
    expect(scannerAssets).toHaveBeenCalledTimes(asked);
  });

  /**
   * A fetch somebody else's press started has no command answer to carry its failure here, so
   * the event's last word is the sentence.
   */
  it("takes a foreign fetch's failure from the event's last word", async () => {
    scannerAssets.mockResolvedValue({ ...ALL, fetching: true });
    const { result } = mount();
    await waitFor(() => expect(result.current.fetching).toBe(true));
    act(() =>
      heard?.({ phase: "error", file: null, done: 0, total: 18_101_604, message: NOT_PUBLISHED }),
    );
    expect(result.current.error).toBe(NOT_PUBLISHED);
  });

  /**
   * **A press the engine refuses because a fetch is already running is not a failed download.**
   * The entry this view held was stale — a left view's fetch is still going — so nothing is
   * drawn as an error; the re-read says fetching, and the poll sees it through.
   */
  it("does not call a press refused for a running fetch a failure", async () => {
    scannerAssetsFetch.mockRejectedValue("The scanner's files are already downloading.");
    const { result } = mount();
    await waitFor(() => expect(result.current.owed).toHaveLength(3));
    scannerAssets.mockResolvedValue({ ...ALL, fetching: true });

    act(() => result.current.fetch());
    await waitFor(() => expect(scannerAssets).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.fetching).toBe(true));
    expect(result.current.error).toBeNull();
  });

  /**
   * **Another window's fetch** — a desktop build with nothing embedded, two windows. The event
   * reaches every window, so the one that did not press asks what is owed when it first hears a
   * fetch its entry does not know of — once, not per event — and when it hears it end, asks
   * again and marks the status, so it does not go on offering a download that has landed.
   */
  it("follows a fetch another window started by its events, and re-reads when it ends", async () => {
    const { result, qc, onLoaded, statusAsked } = mount();
    qc.setQueryData(SCANNER_STATUS_KEY, "read before the download");
    await waitFor(() => expect(result.current.owed).toHaveLength(3));
    expect(scannerAssets).toHaveBeenCalledTimes(1);
    const said = (phase: ScannerAssetsProgress["phase"], done: number): ScannerAssetsProgress => ({
      phase,
      file: phase === "done" ? null : "bundle",
      done,
      total: 18_101_604,
      message: null,
    });

    scannerAssets.mockResolvedValue({ ...ALL, fetching: true });
    act(() => heard?.(said("downloading", 0)));
    await waitFor(() => expect(result.current.fetching).toBe(true));
    expect(scannerAssets).toHaveBeenCalledTimes(2);
    // The entry knows now: the events that follow draw the bar and ask nothing.
    act(() => heard?.(said("downloading", 262_144)));
    act(() => heard?.(said("checking", 18_101_604)));
    await act(async () => {});
    expect(scannerAssets).toHaveBeenCalledTimes(2);
    expect(result.current.progress?.phase).toBe("checking");
    expect(scannerAssetsFetch).not.toHaveBeenCalled();
    expect(statusAsked()).toBe(0);

    scannerAssets.mockResolvedValue(NOTHING);
    act(() => heard?.(said("done", 18_101_604)));
    await waitFor(() => expect(result.current.owed).toEqual([]));
    expect(result.current.fetching).toBe(false);
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    // Marked once: by the event, and not again by the ending the hook then saw.
    expect(statusAsked()).toBe(1);
  });

  /**
   * **Once per fetch end, whatever answers late.** A read of what is owed that was asked while
   * the fetch ran can answer after it has ended, saying a fetch is running that is not; taken,
   * the poll would see that one "end" too and the page would be told twice. The fetch's end
   * drops it.
   */
  it("tells the page once when a read asked mid-fetch answers after the fetch has ended", async () => {
    const going = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(going.promise);
    const { result, qc, onLoaded } = mount();
    await waitFor(() => expect(result.current.owed).toHaveLength(3));
    act(() => result.current.fetch());

    const late = deferred<ScannerAssetsOwed>();
    scannerAssets.mockReturnValue(late.promise);
    void qc.refetchQueries({ queryKey: SCANNER_ASSETS_KEY });
    await waitFor(() => expect(scannerAssets).toHaveBeenCalledTimes(2));

    await act(async () => going.resolve(NOTHING));
    await waitFor(() => expect(onLoaded).toHaveBeenCalledTimes(1));
    await act(async () => late.resolve({ ...ALL, fetching: true }));
    await act(async () => {});
    expect(result.current.fetching).toBe(false);
    expect(result.current.owed).toEqual([]);
    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  /**
   * **A fetch that ends while no Scanner view is mounted still makes the status stale.** The
   * reader pressed Download, went to the collection, and the files landed while they were
   * there. The page's status query never goes stale by itself, so a view that came back drew
   * the status it read before the download — an instruction to place a file the engine had
   * already loaded — under an offer that was gone. The press's promise outlives the hook, and
   * it is what marks the status for re-reading; the view that comes back says it is loading
   * until the page has read it again.
   */
  it("marks the status stale when a fetch lands with no view mounted", async () => {
    const going = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(going.promise);
    const first = mount();
    // What the page read before the download: nothing loaded.
    first.qc.setQueryData(SCANNER_STATUS_KEY, "read before the download");
    await waitFor(() => expect(first.result.current.owed).toHaveLength(3));
    act(() => first.result.current.fetch());
    first.unmount();

    scannerAssets.mockResolvedValue(NOTHING);
    await act(async () => going.resolve(NOTHING));
    await waitFor(() => expect(first.qc.getQueryData(SCANNER_ASSETS_KEY)).toEqual(NOTHING));
    expect(first.qc.getQueryState(SCANNER_STATUS_KEY)?.isInvalidated).toBe(true);
    expect(first.onLoaded).not.toHaveBeenCalled();

    // The view that comes back: nothing owed, and nothing drawn from the old status.
    const back = mount(first.qc);
    expect(back.result.current.owed).toEqual([]);
    expect(back.result.current.loading).toBe(true);
    // The page reads the status again, and the box is done.
    act(() => {
      first.qc.setQueryData(SCANNER_STATUS_KEY, "read after it");
    });
    back.rerender();
    await waitFor(() => expect(back.result.current.loading).toBe(false));
  });

  /**
   * **And a fetch that fails while nobody is looking is not lost.** The sentence used to be
   * state of the hook that pressed, so a reader who came back saw a plain Download and no word
   * of why the last one had not worked. It is kept with the cache, read by whichever view is
   * there next, and cleared by the next press.
   */
  it("keeps a failure that landed with no view mounted for the view that comes back", async () => {
    const going = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(going.promise);
    const first = mount();
    first.qc.setQueryData(SCANNER_STATUS_KEY, "read before the download");
    await waitFor(() => expect(first.result.current.owed).toHaveLength(3));
    act(() => first.result.current.fetch());
    first.unmount();

    scannerAssets.mockResolvedValue(MODELS);
    await act(async () => going.reject(NOT_PUBLISHED));
    await waitFor(() => expect(first.qc.getQueryData(SCANNER_ASSETS_KEY)).toEqual(MODELS));
    // The bundle landed before the failure, so the engine reloaded: the status is stale too.
    expect(first.qc.getQueryState(SCANNER_STATUS_KEY)?.isInvalidated).toBe(true);

    const back = mount(first.qc);
    expect(back.result.current.error).toBe(NOT_PUBLISHED);
    expect(back.result.current.owed).toEqual(MODELS.owed);
    // The next press clears it, for every view on this cache.
    scannerAssetsFetch.mockReturnValue(new Promise<ScannerAssetsOwed>(() => {}));
    act(() => {
      first.qc.setQueryData(SCANNER_STATUS_KEY, "read after it");
    });
    await waitFor(() => expect(back.result.current.owed).toEqual(MODELS.owed));
    act(() => back.result.current.fetch());
    await waitFor(() => expect(back.result.current.error).toBeNull());
  });

  /**
   * **A fetch outlives the view that pressed.** Its answer is written to the cache from the
   * promise, so the view that comes back finds it; and the view that left is told nothing —
   * `onLoaded` pushes the filters, which takes the scanner's lease, and a view that has gone
   * must not take it.
   */
  it("writes the answer of a fetch whose view has gone, and tells that view nothing", async () => {
    const going = deferred<ScannerAssetsOwed>();
    scannerAssetsFetch.mockReturnValue(going.promise);
    const first = mount();
    await waitFor(() => expect(first.result.current.owed).toHaveLength(3));
    act(() => first.result.current.fetch());
    first.unmount();

    // The view that comes back, on the same cache: the entry says a fetch is running, and so
    // does the host when it is asked afresh.
    scannerAssets.mockResolvedValue({ ...ALL, fetching: true });
    const second = mount(first.qc);
    expect(second.result.current.fetching).toBe(true);
    await waitFor(() => expect(scannerAssets).toHaveBeenCalledTimes(2));
    await act(async () => {});
    scannerAssets.mockResolvedValue(NOTHING);

    await act(async () => going.resolve(NOTHING));
    await waitFor(() => expect(second.result.current.fetching).toBe(false));
    expect(first.qc.getQueryData(SCANNER_ASSETS_KEY)).toEqual(NOTHING);
    expect(first.onLoaded).not.toHaveBeenCalled();
    await waitFor(() => expect(second.onLoaded).toHaveBeenCalledTimes(1));
  });
});
