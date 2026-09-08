import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import { READS, VERDICTS } from "./fixtures";
import type { ScannerOptions, ScannerVerdict } from "./types";
import { useScanLoop } from "./useScanLoop";

const scannerFrame = vi.fn<(jpeg: Uint8Array, options: ScannerOptions) => Promise<ScannerVerdict>>();

// Only `scannerFrame` is replaced. `ipcError` stays the real one, because what the error path
// owes is *its* sentence — a stub of it would let the hook return anything and still pass.
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { scannerFrame: (jpeg: Uint8Array, options: ScannerOptions) => scannerFrame(jpeg, options) },
}));

const BYTES = new Uint8Array([0xff, 0xd8, 0xff]);

/** A video the loop is willing to read: `readyState` 2 is `HAVE_CURRENT_DATA`. */
function readyVideo(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "readyState", { value: 2, configurable: true });
  Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
  return video;
}

/** One tick of the loop's idle wait, with React's queue drained after it. */
async function tick(ms = 16) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * An answer that takes `ms` of the fake clock.
 *
 * Deliberately never a resolved promise: `invoke` crosses the IPC boundary, so a verdict that
 * arrives in the same microtask is a state the app cannot reach — and a loop fed one has no
 * macrotask to yield on, which starves the timer advance rather than driving it.
 */
function answersIn(ms: number, verdict: ScannerVerdict = VERDICTS.voting) {
  return new Promise<ScannerVerdict>((resolve) => setTimeout(() => resolve(verdict), ms));
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mount(over: Partial<Parameters<typeof useScanLoop>[0]> = {}) {
  const grabFrame = vi.fn(async () => BYTES);
  const args = {
    videoRef: { current: readyVideo() },
    live: true,
    options: DEFAULT_SCANNER_OPTIONS,
    sendPx: DEFAULT_SEND_PX,
    grabFrame,
    ...over,
  };
  const hook = renderHook(() => useScanLoop(args));
  return { ...hook, grabFrame, args };
}

beforeEach(() => {
  vi.useFakeTimers();
  scannerFrame.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useScanLoop", () => {
  it("keeps one request in flight and drops the frames that arrive under it", async () => {
    scannerFrame.mockReturnValue(deferred<ScannerVerdict>().promise);
    mount();
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(1);
  });

  it("takes the verdict and sends the next frame once the first answers", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame.mockReturnValueOnce(first.promise).mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount();
    await tick();
    expect(result.current.verdict).toBeNull();

    await act(async () => {
      first.resolve(VERDICTS.voting);
    });
    expect(result.current.verdict).toEqual(VERDICTS.voting);
    expect(scannerFrame).toHaveBeenCalledTimes(2);
  });

  it("sends the options and the send size it was handed, not the defaults", async () => {
    scannerFrame.mockReturnValue(deferred<ScannerVerdict>().promise);
    const options: ScannerOptions = { ...DEFAULT_SCANNER_OPTIONS, canny_low: 55, rule: "confidence" };
    const { grabFrame } = mount({ options, sendPx: 720 });
    await tick();
    expect(scannerFrame).toHaveBeenLastCalledWith(BYTES, options);
    expect(grabFrame).toHaveBeenLastCalledWith(expect.anything(), 720, 0.72);
  });

  it("reads a changed slider through a ref rather than restarting the loop", async () => {
    scannerFrame.mockImplementation(() => answersIn(50));
    const grabFrame = vi.fn(async () => BYTES);
    const videoRef = { current: readyVideo() };
    const { rerender } = renderHook(
      ({ options, sendPx }: { options: ScannerOptions; sendPx: number }) =>
        useScanLoop({ videoRef, live: true, options, sendPx, grabFrame }),
      { initialProps: { options: DEFAULT_SCANNER_OPTIONS, sendPx: DEFAULT_SEND_PX } },
    );
    await tick(60);
    const dragged: ScannerOptions = { ...DEFAULT_SCANNER_OPTIONS, decide_at: 20 };
    rerender({ options: dragged, sendPx: 480 });
    await tick(60);
    expect(scannerFrame).toHaveBeenLastCalledWith(BYTES, dragged);
    expect(grabFrame).toHaveBeenLastCalledWith(expect.anything(), 480, 0.72);
  });

  it("reports the rate as 1000 over the mean round trip", async () => {
    const delays = [100, 200, 300];
    let n = 0;
    scannerFrame.mockImplementation(() => {
      const ms = delays[n++];
      // A fourth call parks forever, so the mean below is exactly these three.
      return ms === undefined ? deferred<ScannerVerdict>().promise : answersIn(ms);
    });
    const { result } = mount();
    await tick(650);
    expect(scannerFrame).toHaveBeenCalledTimes(4);
    expect(result.current.roundTripMs).toBe(300);
    expect(result.current.rate).not.toBeNull();
    expect(Math.abs((result.current.rate ?? 0) - 1000 / 200)).toBeLessThan(1);
  });

  it("shows a rejection's sentence and keeps pumping", async () => {
    const second = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(Promise.reject("scanner_frame: no bundle loaded"))
      .mockReturnValueOnce(second.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount();
    await tick();
    expect(result.current.error).toBe("scanner_frame: no bundle loaded");
    expect(scannerFrame).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(VERDICTS.decided);
    });
    expect(result.current.verdict).toEqual(VERDICTS.decided);
    expect(result.current.error).toBeNull();
  });

  it("sends nothing while `live` is false, and stops when it goes false again", async () => {
    scannerFrame.mockImplementation(() => answersIn(50));
    const videoRef = { current: readyVideo() };
    const grabFrame = vi.fn(async () => BYTES);
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useScanLoop({ videoRef, live, options: DEFAULT_SCANNER_OPTIONS, sendPx: DEFAULT_SEND_PX, grabFrame }),
      { initialProps: { live: false } },
    );
    await tick(60);
    expect(scannerFrame).not.toHaveBeenCalled();

    rerender({ live: true });
    await tick(60);
    expect(scannerFrame.mock.calls.length).toBeGreaterThan(0);

    rerender({ live: false });
    const sent = scannerFrame.mock.calls.length;
    for (let i = 0; i < 5; i++) await tick(60);
    expect(scannerFrame).toHaveBeenCalledTimes(sent);
  });

  it("keeps the one-in-flight guarantee across a restart", async () => {
    // The `while` loop's own `await` serialises a single run. What it cannot do is stop a
    // *second* loop putting a request on the wire beside an outstanding one — which is what
    // toggling `live` off and on does, and why the flag is a ref rather than a loop-local.
    const first = deferred<ScannerVerdict>();
    scannerFrame.mockReturnValueOnce(first.promise).mockReturnValue(deferred<ScannerVerdict>().promise);
    const videoRef = { current: readyVideo() };
    const grabFrame = vi.fn(async () => BYTES);
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useScanLoop({ videoRef, live, options: DEFAULT_SCANNER_OPTIONS, sendPx: DEFAULT_SEND_PX, grabFrame }),
      { initialProps: { live: true } },
    );
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(1);

    rerender({ live: false });
    rerender({ live: true });
    for (let i = 0; i < 3; i++) await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(1);

    // …and the restarted loop is alive rather than wedged: the flag clears when the first
    // answers, and the next frame goes out.
    await act(async () => {
      first.resolve(VERDICTS.voting);
    });
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(2);
  });

  /**
   * **The readers run on one eligible frame in four**, so `verdict.ocr` is `null` on most
   * frames — a panel reading the current verdict says "nothing read" three frames in four on a
   * card the tier read perfectly. The loop keeps the last of each; the frames that carried
   * none must not overwrite it.
   */
  it("keeps the last read across the frames that carried none, and a reset drops it", async () => {
    const first = deferred<ScannerVerdict>();
    const second = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount();
    await tick();
    expect(result.current.lastOcr).toBeNull();
    expect(result.current.lastCollector).toBeNull();

    await act(async () => {
      first.resolve({ ...VERDICTS.voting, ocr: READS.ocr, collector: READS.collector });
    });
    expect(result.current.lastOcr).toEqual(READS.ocr);
    expect(result.current.lastCollector).toEqual(READS.collector);

    // The ordinary next frame: the readers did not run on it, so both fields are `null`.
    await act(async () => {
      second.resolve(VERDICTS.voting);
    });
    expect(result.current.verdict?.ocr).toBeNull();
    expect(result.current.verdict?.collector).toBeNull();
    expect(result.current.lastOcr).toEqual(READS.ocr);
    expect(result.current.lastCollector).toEqual(READS.collector);

    // Reset's other half: the crate drops its evidence, the loop drops what it is holding.
    act(() => {
      result.current.clearReads();
    });
    expect(result.current.lastOcr).toBeNull();
    expect(result.current.lastCollector).toBeNull();
  });

  it("drops both reads when the camera stops", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame.mockReturnValueOnce(first.promise).mockReturnValue(deferred<ScannerVerdict>().promise);
    const videoRef = { current: readyVideo() };
    const grabFrame = vi.fn(async () => BYTES);
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useScanLoop({ videoRef, live, options: DEFAULT_SCANNER_OPTIONS, sendPx: DEFAULT_SEND_PX, grabFrame }),
      { initialProps: { live: true } },
    );
    await tick();
    await act(async () => {
      first.resolve({ ...VERDICTS.voting, ocr: READS.ocr, collector: READS.collector });
    });
    expect(result.current.lastOcr).toEqual(READS.ocr);

    rerender({ live: false });
    expect(result.current.lastOcr).toBeNull();
    expect(result.current.lastCollector).toBeNull();
    // …and a camera that opens again starts with nothing carried over from the last one.
    rerender({ live: true });
    expect(result.current.lastOcr).toBeNull();
  });

  /**
   * **The grab used to sit outside the `try`, and a throw there took the whole loop down
   * silently.** `drawImage` throws on a tainted canvas and `toBlob` can fail under memory
   * pressure; unhandled, the rejection ended `pump()` with `error` still `null` — a picture
   * that keeps moving, an overlay frozen on its last quad, and nothing anywhere saying why.
   */
  it("shows a failed frame grab's sentence and keeps pumping", async () => {
    scannerFrame.mockReturnValue(deferred<ScannerVerdict>().promise);
    const grabFrame = vi.fn(async (): Promise<Uint8Array | null> => {
      throw new Error("the canvas is tainted");
    });
    const { result } = mount({ grabFrame });
    await tick();
    expect(result.current.error).toBe("the canvas is tainted");
    // Nothing went on the wire — a frame that never became bytes was never in flight.
    expect(scannerFrame).not.toHaveBeenCalled();

    const tried = grabFrame.mock.calls.length;
    for (let i = 0; i < 3; i++) await tick();
    expect(grabFrame.mock.calls.length).toBeGreaterThan(tried);
  });

  it("waits rather than sending when the frame grab comes back empty", async () => {
    scannerFrame.mockReturnValue(deferred<ScannerVerdict>().promise);
    const grabFrame = vi.fn(async () => null);
    mount({ grabFrame });
    for (let i = 0; i < 3; i++) await tick();
    expect(grabFrame.mock.calls.length).toBeGreaterThan(0);
    expect(scannerFrame).not.toHaveBeenCalled();
  });

  it("exposes the same grab for a full-resolution capture", async () => {
    scannerFrame.mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result, grabFrame } = mount();
    await tick();
    const bytes = await result.current.grab(Infinity, 0.92);
    expect(bytes).toBe(BYTES);
    expect(grabFrame).toHaveBeenLastCalledWith(expect.anything(), Infinity, 0.92);
  });
});
