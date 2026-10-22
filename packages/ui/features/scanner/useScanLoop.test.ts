import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DETAIL_WAIT_MS, DEFAULT_SCANNER_OPTIONS, DEFAULT_SEND_PX } from "./scannerOptions";
import { READS, VERDICTS } from "./fixtures";
import { RUN_MAX_AGE_MS, RUN_MAX_BYTES, RUN_MAX_FRAMES, runClock } from "./submit/run";
import type { ScannerDecision, ScannerOptions, ScannerVerdict } from "./types";
import { useScanLoop, type GrabbedKept, type GrabbedPair, type RunFrame } from "./useScanLoop";

const scannerFrame =
  vi.fn<
    (
      jpeg: Uint8Array,
      options: ScannerOptions,
      detail?: Uint8Array | null,
    ) => Promise<ScannerVerdict>
  >();
const scannerReset = vi.fn<() => Promise<void>>();

// Only the frame and reset calls are replaced. `ipcError` stays the real one, because what the
// error path owes is *its* sentence — a stub would let the hook return anything and still pass. The
// arguments are forwarded as they came, so a plain frame's call is two arguments and a paired
// frame's three — the difference the detail tests below assert on.
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: {
    scannerFrame: (...args: [Uint8Array, ScannerOptions, (Uint8Array | null)?]) =>
      scannerFrame(...args),
    scannerReset: () => scannerReset(),
  },
}));

const BYTES = new Uint8Array([0xff, 0xd8, 0xff]);
/** The paired grab's two halves — distinct from {@link BYTES}, so a test can tell which grab ran. */
const PAIR_FRAME = new Uint8Array([0xff, 0xd8, 0x01]);
const PAIR_DETAIL = new Uint8Array([0xff, 0xd8, 0x02, 0x03]);
/** Gates for the first `count` frames, answered when a test chooses; later frames park. */
function framesGated(count: number) {
  const gates = Array.from({ length: count }, () => deferred<ScannerVerdict>());
  let n = 0;
  scannerFrame.mockImplementation(() => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise);
  return gates;
}

/** A decision naming another card than {@link VERDICTS.decided}'s. */
const OTHER_CARD = {
  ...VERDICTS.decided.decision!,
  printing: "honored-hierarch-ori-17",
  oracle_id: "honored-hierarch",
};

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

/** The page's three knobs as the page starts them, for a test that is about none of them. */
const KNOBS = {
  options: DEFAULT_SCANNER_OPTIONS,
  sendPx: DEFAULT_SEND_PX,
  detailWaitMs: DEFAULT_DETAIL_WAIT_MS,
};

function mount(over: Partial<Parameters<typeof useScanLoop>[0]> = {}) {
  const grabFrame = vi.fn(async () => BYTES);
  const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => ({
    frame: PAIR_FRAME,
    detail: PAIR_DETAIL,
  }));
  const args = {
    videoRef: { current: readyVideo() },
    live: true,
    ...KNOBS,
    grabFrame,
    grabPair,
    ...over,
  };
  const hook = renderHook(() => useScanLoop(args));
  return { ...hook, grabFrame, grabPair, args };
}

beforeEach(() => {
  vi.useFakeTimers();
  scannerFrame.mockReset();
  scannerReset.mockReset().mockResolvedValue(undefined);
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
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
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
    const options: ScannerOptions = {
      ...DEFAULT_SCANNER_OPTIONS,
      canny_low: 55,
      rule: "confidence",
    };
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
        useScanLoop({ videoRef, live: true, ...KNOBS, options, sendPx, grabFrame }),
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
      ({ live }: { live: boolean }) => useScanLoop({ videoRef, live, ...KNOBS, grabFrame }),
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

  it.each(["plain", "paired"] as const)(
    "sends nothing when the camera stops during a pending %s grab",
    async (kind) => {
      const first = deferred<ScannerVerdict>();
      scannerFrame.mockReturnValue(first.promise);
      const frame = deferred<Uint8Array | null>();
      const pair = deferred<GrabbedPair | null>();
      const grabFrame = vi.fn(() => (kind === "plain" ? frame.promise : Promise.resolve(BYTES)));
      const grabPair = vi.fn(() => pair.promise);
      const videoRef = { current: readyVideo() };
      const { rerender } = renderHook(
        ({ live }: { live: boolean }) =>
          useScanLoop({ videoRef, live, ...KNOBS, detailWaitMs: 0, grabFrame, grabPair }),
        { initialProps: { live: true } },
      );
      await tick();
      if (kind === "paired") {
        await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
        expect(grabPair).toHaveBeenCalledTimes(1);
      } else {
        expect(grabFrame).toHaveBeenCalledTimes(1);
      }
      const sent = kind === "paired" ? 1 : 0;
      expect(scannerFrame).toHaveBeenCalledTimes(sent);

      rerender({ live: false });
      await act(async () => {
        frame.resolve(BYTES);
        pair.resolve({ frame: PAIR_FRAME, detail: PAIR_DETAIL });
      });
      await tick(100);
      expect(scannerFrame).toHaveBeenCalledTimes(sent);
    },
  );

  it("keeps the one-in-flight guarantee across a restart", async () => {
    // The `while` loop's own `await` serialises a single run. What it cannot do is stop a
    // *second* loop putting a request on the wire beside an outstanding one — which is what
    // toggling `live` off and on does, and why the flag is a ref rather than a loop-local.
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const videoRef = { current: readyVideo() };
    const grabFrame = vi.fn(async () => BYTES);
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) => useScanLoop({ videoRef, live, ...KNOBS, grabFrame }),
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

  it("clears the verdict and ignores an outstanding frame when reads are cleared", async () => {
    const first = deferred<ScannerVerdict>();
    const oldFrame = deferred<ScannerVerdict>();
    const onDecision = vi.fn();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(oldFrame.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount({ onDecision, detailWaitMs: 0 });
    await tick();
    await act(async () => first.resolve(VERDICTS.exactResolved));
    expect(result.current.verdict).toEqual(VERDICTS.exactResolved);

    act(() => result.current.clearReads());
    expect(result.current.verdict).toBeNull();
    await act(async () =>
      oldFrame.resolve({
        ...VERDICTS.exactResolved,
        decision_seq: VERDICTS.exactResolved.decision_seq + 1,
        ocr: READS.ocr,
        collector: READS.collector,
      }),
    );
    await tick();
    expect(result.current.verdict).toBeNull();
    expect(result.current.lastOcr).toBeNull();
    expect(result.current.lastCollector).toBeNull();
    expect(result.current.lastResolution).toBeNull();
    // The first frame's card, decided on the stream's first frame — and nothing of the old one.
    expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([
      VERDICTS.exactResolved.decision_seq,
    ]);
    // The start's reset alone: clearing the reads is this side's, and asks the session nothing.
    expect(scannerReset).toHaveBeenCalledTimes(1);
  });

  /** The reset must run after the old frame, and no old answer may revive its evidence. */
  it("drains an outstanding frame before reset and resumes with fresh evidence", async () => {
    const first = deferred<ScannerVerdict>();
    const oldFrame = deferred<ScannerVerdict>();
    const baseline = deferred<ScannerVerdict>();
    const newCard = deferred<ScannerVerdict>();
    const resetGate = deferred<void>();
    const onDecision = vi.fn();
    // The pump's start resets at once; the press's waits on the gate.
    scannerReset.mockResolvedValueOnce(undefined).mockReturnValue(resetGate.promise);
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(oldFrame.promise)
      .mockReturnValueOnce(baseline.promise)
      .mockReturnValueOnce(newCard.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result, grabPair } = mount({ onDecision, detailWaitMs: 0 });
    await tick();
    await act(async () =>
      first.resolve({
        ...VERDICTS.exactResolved,
        decision_seq: 0,
        ocr: READS.ocr,
        collector: READS.collector,
      }),
    );
    expect(result.current.lastOcr).toEqual(READS.ocr);
    expect(result.current.lastCollector).toEqual(READS.collector);
    expect(result.current.lastResolution).toEqual(VERDICTS.exactResolved.resolution);
    expect(scannerFrame).toHaveBeenCalledTimes(2);

    let reset!: Promise<void>;
    act(() => {
      reset = result.current.reset();
    });
    expect(result.current.verdict).toBeNull();
    expect(result.current.lastOcr).toBeNull();
    expect(result.current.lastCollector).toBeNull();
    expect(result.current.lastResolution).toBeNull();
    await tick(100);
    expect(scannerReset).toHaveBeenCalledTimes(1);
    expect(scannerFrame).toHaveBeenCalledTimes(2);

    await act(async () =>
      oldFrame.resolve({
        ...VERDICTS.exactResolved,
        decision_seq: 1,
        wants_detail: true,
        ocr: READS.ocr,
        collector: READS.collector,
      }),
    );
    await tick();
    expect(scannerReset).toHaveBeenCalledTimes(2);
    expect(result.current.verdict).toBeNull();
    expect(result.current.lastOcr).toBeNull();
    expect(result.current.lastCollector).toBeNull();
    expect(result.current.lastResolution).toBeNull();
    // The first frame's card alone: the old frame's answer was thrown away.
    expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([0]);
    await tick(100);
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(grabPair).not.toHaveBeenCalled();

    await act(async () => {
      resetGate.resolve(undefined);
      await reset;
    });
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(3);
    expect(scannerFrame.mock.calls[2]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
    await act(async () => baseline.resolve({ ...VERDICTS.voting, decision_seq: 0 }));
    expect(result.current.verdict).toEqual(VERDICTS.voting);
    await act(async () => newCard.resolve({ ...VERDICTS.decided, decision_seq: 1 }));
    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision).toHaveBeenLastCalledWith(VERDICTS.decided.decision, 1);
  });

  it.each(["plain", "paired"] as const)(
    "drops a pending %s grab when reset starts",
    async (kind) => {
      const first = deferred<ScannerVerdict>();
      const frame = deferred<Uint8Array | null>();
      const pair = deferred<GrabbedPair | null>();
      const resetGate = deferred<void>();
      scannerReset.mockResolvedValueOnce(undefined).mockReturnValue(resetGate.promise);
      scannerFrame
        .mockReturnValueOnce(first.promise)
        .mockReturnValue(deferred<ScannerVerdict>().promise);
      const grabFrame = vi.fn(() => (kind === "plain" ? frame.promise : Promise.resolve(BYTES)));
      const grabPair = vi.fn(() => pair.promise);
      const { result } = mount({ grabFrame, grabPair, detailWaitMs: 0 });
      await tick();
      if (kind === "paired") {
        await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
        expect(grabPair).toHaveBeenCalledTimes(1);
      } else {
        expect(grabFrame).toHaveBeenCalledTimes(1);
      }
      const sent = kind === "paired" ? 1 : 0;
      let reset!: Promise<void>;
      act(() => {
        reset = result.current.reset();
      });
      await act(async () => {
        frame.resolve(BYTES);
        pair.resolve({ frame: PAIR_FRAME, detail: PAIR_DETAIL });
      });
      await tick();
      expect(scannerReset).toHaveBeenCalledTimes(2);
      expect(scannerFrame).toHaveBeenCalledTimes(sent);
      await tick(100);
      expect(scannerFrame).toHaveBeenCalledTimes(sent);

      await act(async () => {
        resetGate.resolve(undefined);
        await reset;
      });
      await tick();
      expect(scannerFrame).toHaveBeenCalledTimes(sent + 1);
      expect(scannerFrame.mock.calls[sent]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
    },
  );

  it("rejects a failed reset and resumes the frame pump", async () => {
    const resetGate = deferred<void>();
    const video = readyVideo();
    Object.defineProperty(video, "readyState", { value: 0, configurable: true });
    scannerReset.mockReturnValue(resetGate.promise);
    scannerFrame.mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount({ videoRef: { current: video } });
    let reset!: Promise<void>;
    act(() => {
      reset = result.current.reset();
    });
    const rejection = expect(reset).rejects.toThrow("scanner reset unavailable");
    await tick();
    expect(scannerReset).toHaveBeenCalledTimes(1);
    Object.defineProperty(video, "readyState", { value: 2, configurable: true });
    await tick(100);
    expect(scannerFrame).not.toHaveBeenCalled();

    await act(async () => {
      resetGate.reject(new Error("scanner reset unavailable"));
      await rejection;
    });
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(1);
    expect(scannerFrame.mock.calls[0]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
  });

  it("shares one pending reset across repeated presses", async () => {
    const resetGate = deferred<void>();
    scannerReset.mockReturnValue(resetGate.promise);
    const { result } = mount({ live: false });
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.reset();
      second = result.current.reset();
    });
    expect(second).toBe(first);
    await tick();
    expect(scannerReset).toHaveBeenCalledTimes(1);
    act(() => {
      second = result.current.reset();
    });
    expect(second).toBe(first);
    await act(async () => {
      resetGate.resolve(undefined);
      await first;
    });
    expect(scannerReset).toHaveBeenCalledTimes(1);

    scannerReset.mockResolvedValue(undefined);
    await act(async () => {
      await result.current.reset();
    });
    expect(scannerReset).toHaveBeenCalledTimes(2);
  });

  it("accepts the next decision after reset without the previous card's frame gap", async () => {
    const baseline = deferred<ScannerVerdict>();
    const firstCard = deferred<ScannerVerdict>();
    const oldFrame = deferred<ScannerVerdict>();
    const nextCard = deferred<ScannerVerdict>();
    const onDecision = vi.fn();
    scannerFrame
      .mockReturnValueOnce(baseline.promise)
      .mockReturnValueOnce(firstCard.promise)
      .mockReturnValueOnce(oldFrame.promise)
      .mockReturnValueOnce(nextCard.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount({ onDecision });
    await tick();
    await act(async () => baseline.resolve(VERDICTS.voting));
    await act(async () => firstCard.resolve(VERDICTS.decided));
    expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1]);

    let reset!: Promise<void>;
    act(() => {
      reset = result.current.reset();
    });
    await act(async () => {
      oldFrame.resolve({ ...VERDICTS.voting, decision_seq: 1 });
      await reset;
    });
    await tick();
    await act(async () => nextCard.resolve({ ...VERDICTS.decided, decision_seq: 2 }));
    // Only one new verdict since the prior decision: Reset explicitly means another read.
    // Retaining the sequence baseline makes this first post-reset decision an edge to report.
    expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1, 2]);
  });

  it("drops a stale detail ask when reset starts during its wait", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result, grabFrame, grabPair } = mount({ detailWaitMs: 300 });
    await tick();
    await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(100);
    expect(grabPair).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.reset();
    });
    expect(scannerReset).toHaveBeenCalledTimes(2);
    expect(result.current.verdict).toBeNull();
    await tick(300);
    expect(grabPair).not.toHaveBeenCalled();
    expect(grabFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame.mock.calls[1]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
  });

  it("drops both reads when the camera stops", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const videoRef = { current: readyVideo() };
    const grabFrame = vi.fn(async () => BYTES);
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useScanLoop({ videoRef, live, ...KNOBS, grabFrame }),
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

  /**
   * **`decision_seq` is what makes "one add per card" the session's property**, so the loop's
   * whole job is to notice it move: a repeat of the same number is a frozen card still in front of
   * the lens, and a frame with no decision is a card nobody has settled on yet.
   */
  it("calls onDecision once per decision_seq change, never on repeats or null decisions", async () => {
    const onDecision = vi.fn();
    const second = {
      ...VERDICTS.decided,
      decision_seq: 2,
      decision: { ...VERDICTS.decided.decision!, printing: "plains-2xm-373", label: null },
    };
    const answers: ScannerVerdict[] = [
      VERDICTS.voting, // seq 0, no decision
      VERDICTS.decided, // seq 1
      VERDICTS.decided, // seq 1 again, still carrying its decision
      { ...VERDICTS.voting, decision_seq: 1 }, // seq 1 and nothing decided
      { ...VERDICTS.voting, decision_seq: 1 }, // …for long enough to be a second card
      second, // seq 2
    ];
    let n = 0;
    scannerFrame.mockImplementation(() => {
      const v = answers[n++];
      return v === undefined ? deferred<ScannerVerdict>().promise : answersIn(10, v);
    });
    mount({ onDecision });
    await tick(300);
    expect(scannerFrame).toHaveBeenCalledTimes(answers.length + 1);
    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(onDecision.mock.calls[0]).toEqual([VERDICTS.decided.decision, 1]);
    expect(onDecision.mock.calls[1]).toEqual([second.decision, 2]);
  });

  /**
   * **Issue #735: two rows a moment apart.** The session calls a card changed on two frames that
   * look unlike the decided one, so one card still settling is decided twice — two frames apart,
   * or three when the second waits on its confirming read. A card really swapped in needs more
   * frames than that, so the gap is what tells them apart, and the first of the pair stays.
   */
  it("drops a decision that follows the last one within the frame gap", async () => {
    const decided = (seq: number): ScannerVerdict => ({
      ...VERDICTS.decided,
      decision_seq: seq,
      decision: { ...VERDICTS.decided.decision!, printing: `printing-${seq}` },
    });
    const quiet = (seq: number): ScannerVerdict => ({ ...VERDICTS.voting, decision_seq: seq });
    const answers: ScannerVerdict[] = [
      quiet(0), // the baseline
      decided(1), // the card
      quiet(1),
      decided(2), // two frames on: the same card, decided again
      decided(2),
      quiet(2),
      decided(3), // three frames after *that* one — counted from the dropped decision too
      quiet(3),
      quiet(3),
      quiet(3),
      decided(4), // four frames on: a card of its own
    ];
    const onDecision = vi.fn();
    let n = 0;
    scannerFrame.mockImplementation(() => {
      const v = answers[n++];
      return v === undefined ? deferred<ScannerVerdict>().promise : answersIn(10, v);
    });
    mount({ onDecision });
    await tick(600);
    expect(scannerFrame).toHaveBeenCalledTimes(answers.length + 1);
    expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1, 4]);
  });

  it("starts the frame gap over when the camera does", async () => {
    // A camera that stops and starts takes a new baseline, and the first card after it is never
    // inside a gap left over from the last stream.
    const onDecision = vi.fn();
    // Every frame answers — a request left hanging would hold the pump across the restart.
    let next: ScannerVerdict[] = [{ ...VERDICTS.voting, decision_seq: 0 }, VERDICTS.decided];
    let last: ScannerVerdict = { ...VERDICTS.voting, decision_seq: 1 };
    scannerFrame.mockImplementation(() => answersIn(10, next.shift() ?? last));
    const videoRef = { current: readyVideo() };
    const grabFrame = vi.fn(async () => BYTES);
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useScanLoop({
          videoRef,
          live,
          ...KNOBS,
          grabFrame,
          onDecision,
        }),
      { initialProps: { live: true } },
    );
    // Two frames at ten milliseconds each: the baseline, and the card.
    await tick(25);
    expect(onDecision).toHaveBeenCalledTimes(1);

    // Off at once and on again, with a second card decided on the new stream's second frame —
    // two frames after the first card by the old count, and one after the new baseline.
    rerender({ live: false });
    await tick(60);
    // Another card than the first — that one, still lying there, would not be filed again.
    next = [
      { ...VERDICTS.voting, decision_seq: 1 },
      { ...VERDICTS.decided, decision_seq: 2, decision: OTHER_CARD },
    ];
    last = { ...VERDICTS.voting, decision_seq: 2 };
    rerender({ live: true });
    await tick(100);
    expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1, 2]);
  });

  /**
   * **Issue #1318: a card already in front of the lens when scanning starts.** The session outlives
   * the pump and never saw that card arrive, so the pump resets it first — and every decision of
   * the new stream is news, its very first frame's too (Neural decides on one clear frame).
   */
  it("resets the session before a stream's first frame, and files a card decided on it", async () => {
    const onDecision = vi.fn();
    const gates = framesGated(2);
    mount({ onDecision });
    await tick();
    expect(scannerReset).toHaveBeenCalledTimes(1);
    expect(scannerReset.mock.invocationCallOrder[0]).toBeLessThan(
      scannerFrame.mock.invocationCallOrder[0],
    );
    await act(async () => gates[0].resolve({ ...VERDICTS.decided, decision_seq: 4 }));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(VERDICTS.decided.decision, 4);
    // The decision rides the next frame too: the same number, so not a second card.
    await act(async () => gates[1].resolve({ ...VERDICTS.decided, decision_seq: 4 }));
    expect(onDecision).toHaveBeenCalledTimes(1);
  });

  it("holds the first frame back until the start's reset has answered", async () => {
    const resetGate = deferred<void>();
    scannerReset.mockReturnValueOnce(resetGate.promise);
    scannerFrame.mockReturnValue(deferred<ScannerVerdict>().promise);
    mount();
    await tick(100);
    expect(scannerReset).toHaveBeenCalledTimes(1);
    expect(scannerFrame).not.toHaveBeenCalled();
    await act(async () => resetGate.resolve(undefined));
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(1);
  });

  /**
   * A refused reset leaves the session holding what it held, so the stream's first number is a
   * baseline again — a card frozen across the gap rides every committed frame of it — and the
   * refusal is said, as a frame's would be.
   */
  it("takes the first number as a baseline when the start's reset is refused", async () => {
    scannerReset.mockRejectedValueOnce("the scanner is open in another window");
    const onDecision = vi.fn();
    const frozen = { ...VERDICTS.decided, decision_seq: 4 };
    const gates = framesGated(2);
    const { result } = mount({ onDecision });
    await tick();
    expect(result.current.error).toBe("the scanner is open in another window");
    await act(async () => gates[0].resolve(frozen));
    await act(async () => gates[1].resolve(frozen));
    expect(onDecision).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  describe("the card standing when the last stream stopped", () => {
    /** A camera that can be stopped and started, over one `onDecision`. */
    function restartable(onDecision: (decision: ScannerDecision, seq: number) => void) {
      const videoRef = { current: readyVideo() };
      const grabFrame = vi.fn(async () => BYTES);
      return renderHook(
        ({ live }: { live: boolean }) =>
          useScanLoop({ videoRef, live, ...KNOBS, grabFrame, onDecision }),
        { initialProps: { live: true } },
      );
    }
    /** Plays `answers`, one each 10 ms, then holds the last of them. */
    function plays(answers: ScannerVerdict[]) {
      const queue = [...answers];
      let last = answers[answers.length - 1];
      scannerFrame.mockImplementation(() => {
        last = queue.shift() ?? last;
        return answersIn(10, last);
      });
    }

    /**
     * Closing a dialog, restoring the window or coming back to the view starts a pump over the
     * card already in the tray. The session, reset, decides it again — and that decision is the
     * card still lying there, not a second copy.
     */
    it("does not file it again when the session decides it afresh", async () => {
      const onDecision = vi.fn();
      plays([{ ...VERDICTS.voting, decision_seq: 0 }, VERDICTS.decided]);
      const { rerender } = restartable(onDecision);
      await tick(60);
      expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1]);

      rerender({ live: false });
      await tick(60);
      plays([
        { ...VERDICTS.voting, decision_seq: 1 },
        { ...VERDICTS.decided, decision_seq: 2 },
      ]);
      rerender({ live: true });
      await tick(100);
      expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1]);

      // Only the stream's first decision: lifted and laid down again, the card is a card of its own.
      plays([
        { ...VERDICTS.noCard, decision_seq: 2 },
        { ...VERDICTS.voting, decision_seq: 2 },
        { ...VERDICTS.decided, decision_seq: 3 },
      ]);
      await tick(100);
      expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1, 3]);
    });

    it("remembers it across a remount — the view the reader comes back to", async () => {
      const onDecision = vi.fn();
      plays([{ ...VERDICTS.voting, decision_seq: 0 }, VERDICTS.decided]);
      const first = restartable(onDecision);
      await tick(60);
      expect(onDecision).toHaveBeenCalledTimes(1);
      first.unmount();

      plays([
        { ...VERDICTS.voting, decision_seq: 1 },
        { ...VERDICTS.decided, decision_seq: 2 },
      ]);
      restartable(onDecision);
      await tick(100);
      expect(onDecision).toHaveBeenCalledTimes(1);
    });

    it("files another card laid down while the camera was stopped", async () => {
      const onDecision = vi.fn();
      plays([{ ...VERDICTS.voting, decision_seq: 0 }, VERDICTS.decided]);
      const { rerender } = restartable(onDecision);
      await tick(60);
      rerender({ live: false });
      await tick(60);
      plays([{ ...VERDICTS.decided, decision_seq: 2, decision: OTHER_CARD }]);
      rerender({ live: true });
      await tick(60);
      expect(onDecision.mock.calls).toEqual([
        [VERDICTS.decided.decision, 1],
        [OTHER_CARD, 2],
      ]);
    });

    it("files it again once a frame showed the lens empty before the stop", async () => {
      const onDecision = vi.fn();
      plays([
        { ...VERDICTS.voting, decision_seq: 0 },
        VERDICTS.decided,
        { ...VERDICTS.noCard, decision_seq: 1 },
      ]);
      const { rerender } = restartable(onDecision);
      await tick(60);
      rerender({ live: false });
      await tick(60);
      plays([{ ...VERDICTS.decided, decision_seq: 2 }]);
      rerender({ live: true });
      await tick(60);
      expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1, 2]);
    });

    it("files it again after a Reset press, which asked for the next decision to be news", async () => {
      const onDecision = vi.fn();
      plays([{ ...VERDICTS.voting, decision_seq: 0 }, VERDICTS.decided]);
      const { result, rerender } = restartable(onDecision);
      await tick(60);
      rerender({ live: false });
      await tick(60);
      plays([
        { ...VERDICTS.voting, decision_seq: 1 },
        { ...VERDICTS.decided, decision_seq: 2 },
      ]);
      rerender({ live: true });
      await act(async () => {
        await result.current.reset();
      });
      await tick(100);
      expect(onDecision.mock.calls.map(([, seq]) => seq)).toEqual([1, 2]);
    });
  });

  /**
   * **A resolve is reported on one frame only**, so the loop latches the last one for the status
   * line and the Tiers panel — and lets go the moment the card leaves, because a sentence about the
   * last card must not reach the next one.
   */
  it("keeps the last resolution until a frame has no card, and a reset drops it", async () => {
    const answers: ScannerVerdict[] = [
      VERDICTS.exactAmbiguous,
      { ...VERDICTS.exactAmbiguous, resolution: null },
      VERDICTS.noCard,
      VERDICTS.exactResolved,
    ];
    const gates = answers.map(() => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    const { result } = mount();
    await tick();
    expect(result.current.lastResolution).toBeNull();

    await act(async () => gates[0].resolve(answers[0]));
    expect(result.current.lastResolution).toEqual(VERDICTS.exactAmbiguous.resolution);
    await act(async () => gates[1].resolve(answers[1]));
    expect(result.current.lastResolution).toEqual(VERDICTS.exactAmbiguous.resolution);
    await act(async () => gates[2].resolve(answers[2]));
    expect(result.current.lastResolution).toBeNull();
    await act(async () => gates[3].resolve(answers[3]));
    expect(result.current.lastResolution).toEqual(VERDICTS.exactResolved.resolution);

    act(() => result.current.clearReads());
    expect(result.current.lastResolution).toBeNull();
  });

  /**
   * **A detail image goes out on the one frame the session asked for it, and on no other**
   * (issue #708). The full-size encode is the expensive half of a grab, so the loop pays for it
   * only on the frame after a verdict that set `wants_detail` — and that frame's two JPEGs come
   * out of one paired grab, never a plain grab plus a second look at the video.
   */
  it("sends a detail image on the frame after wants_detail, and only then", async () => {
    const answers: ScannerVerdict[] = [
      { ...VERDICTS.voting, wants_detail: true },
      { ...VERDICTS.voting, wants_detail: false },
    ];
    const gates = answers.map(() => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    // No wait in this test or the two after it: they are about what a paired frame carries.
    const { grabFrame, grabPair } = mount({ sendPx: 720, detailWaitMs: 0 });
    await tick();

    // The first frame of a stream: nothing has asked for a detail yet.
    expect(scannerFrame).toHaveBeenCalledTimes(1);
    expect(scannerFrame.mock.calls[0]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
    expect(grabPair).not.toHaveBeenCalled();

    // `wants_detail: true` — the next frame is the paired grab's, carrying its detail.
    await act(async () => gates[0].resolve(answers[0]));
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame.mock.calls[1]).toEqual([PAIR_FRAME, DEFAULT_SCANNER_OPTIONS, PAIR_DETAIL]);
    expect(grabPair).toHaveBeenCalledTimes(1);
    expect(grabPair).toHaveBeenLastCalledWith(expect.anything(), 720, 0.72);
    // …and it was the pair's frame that went out, not a plain grab beside it.
    expect(grabFrame).toHaveBeenCalledTimes(1);

    // `wants_detail: false` — back to the one plain JPEG.
    await act(async () => gates[1].resolve(answers[1]));
    expect(scannerFrame).toHaveBeenCalledTimes(3);
    expect(scannerFrame.mock.calls[2]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
    expect(grabPair).toHaveBeenCalledTimes(1);
  });

  /**
   * A pair that cannot be grabbed must not stop the scanner. The latch is consumed by the attempt,
   * so a failing full-size grab costs that one read and the next frame is an ordinary one — a latch
   * left up would retry the failing grab forever and send nothing at all.
   */
  it("shows a failed paired grab's sentence and goes back to plain frames", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => {
      throw new Error("the detail canvas is too large");
    });
    const { result, grabFrame } = mount({ grabPair, detailWaitMs: 0 });
    await tick();

    await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick();
    expect(grabPair).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("the detail canvas is too large");
    // The pump carried on with a plain frame rather than asking for the pair again.
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame.mock.calls[1]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
    expect(grabFrame).toHaveBeenCalledTimes(2);
  });

  /** A camera no larger than the frame gives a pair with no detail, which is the plain call. */
  it("sends a pair with no detail as the plain two-argument call", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => ({
      frame: PAIR_FRAME,
      detail: null,
    }));
    mount({ grabPair, detailWaitMs: 0 });
    await tick();
    await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame.mock.calls[1]).toEqual([PAIR_FRAME, DEFAULT_SCANNER_OPTIONS]);
  });

  /**
   * **The detail grab waits after the ask** (issue #741). The session asks the moment two hashed
   * frames agree, and a card still sliding or a lens still focusing agrees just as well — so a
   * grab on the very next iteration took the fine print while it was blurred. Nothing goes out
   * during the wait: the session reads its bands on the next frame it is sent, whatever that
   * frame carries, so a plain frame sent to fill the time would be the read.
   */
  it("waits before the paired grab, and sends nothing while it does", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { grabFrame, grabPair } = mount();
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(DEFAULT_DETAIL_WAIT_MS - 1);
    expect(grabPair).not.toHaveBeenCalled();
    expect(grabFrame).toHaveBeenCalledTimes(1);
    expect(scannerFrame).toHaveBeenCalledTimes(1);

    await tick(1);
    expect(grabPair).toHaveBeenCalledTimes(1);
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame.mock.calls[1]).toEqual([PAIR_FRAME, DEFAULT_SCANNER_OPTIONS, PAIR_DETAIL]);
  });

  /**
   * Exact asks on every frame until its resolve starts, and a wait on each would stall the
   * overlay through the whole run. The wait is for the card and the lens to settle, and once it
   * has been spent the frames after it are all later than it.
   */
  it("waits once for a run of asks, not once a frame", async () => {
    const gates = [0, 1, 2].map(() => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    const { grabPair } = mount({ detailWaitMs: 300 });
    await tick();

    await act(async () => gates[0].resolve({ ...VERDICTS.voting, wants_detail: true }));
    expect(grabPair).not.toHaveBeenCalled();
    await tick(300);
    expect(grabPair).toHaveBeenCalledTimes(1);

    // The pair's own answer asks again: the next pair goes out with no clock moved at all.
    await act(async () => gates[1].resolve({ ...VERDICTS.voting, wants_detail: true }));
    expect(grabPair).toHaveBeenCalledTimes(2);
    expect(scannerFrame).toHaveBeenCalledTimes(3);
  });

  /** A plain frame between two asks ends the run, so the second ask waits like the first. */
  it("waits again for an ask that follows a plain frame", async () => {
    const gates = [0, 1, 2, 3].map(() => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    const { grabPair } = mount({ detailWaitMs: 300 });
    await tick();

    await act(async () => gates[0].resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(300);
    expect(grabPair).toHaveBeenCalledTimes(1);
    // The pair's answer does not ask, so a plain frame goes out; its answer asks again.
    await act(async () => gates[1].resolve({ ...VERDICTS.voting, wants_detail: false }));
    expect(scannerFrame).toHaveBeenCalledTimes(3);
    await act(async () => gates[2].resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(299);
    expect(grabPair).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(grabPair).toHaveBeenCalledTimes(2);
  });

  /**
   * Exact asks from the first frame with a quad in it, two frames before the lock trusts it. A
   * wait there is spent on every stray quad and is over before the card is one the session will
   * read, so the run's one wait is held for the first ask that comes with the lock trusted.
   */
  it("holds the wait for the first ask on a trusted lock", async () => {
    const acquiring: ScannerVerdict = {
      ...VERDICTS.voting,
      lock: { phase: "acquiring", agree: 1, misses: 0 },
      wants_detail: true,
    };
    const gates = [0, 1, 2].map(() => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    const { grabPair } = mount({ detailWaitMs: 300 });
    await tick();

    // Not trusted yet: the pair goes out at once, as it did before there was a wait.
    await act(async () => gates[0].resolve(acquiring));
    expect(grabPair).toHaveBeenCalledTimes(1);
    // Trusted, and still the same run of asks: this is the ask that waits.
    await act(async () => gates[1].resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(299);
    expect(grabPair).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(grabPair).toHaveBeenCalledTimes(2);
    // …and the run has had its wait.
    await act(async () => gates[2].resolve({ ...VERDICTS.voting, wants_detail: true }));
    expect(grabPair).toHaveBeenCalledTimes(3);
  });

  /**
   * A paired grab that fails sends the next frame plain, and Exact asks again on that one. Counted
   * by what the last grab was, that ask waited afresh — every other frame, for as long as the
   * grab kept failing. A run is the verdicts that ask, so it has had its wait.
   */
  it("does not wait a second time when the pair it waited for could not be grabbed", async () => {
    const gates = [0, 1].map(() => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    let fail = true;
    const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => {
      if (fail) throw new Error("the detail canvas is too large");
      return { frame: PAIR_FRAME, detail: PAIR_DETAIL };
    });
    mount({ grabPair, detailWaitMs: 300 });
    await tick();

    await act(async () => gates[0].resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(300);
    expect(grabPair).toHaveBeenCalledTimes(1);
    // The failed grab's idle tick, then the plain frame that stands in for the pair.
    await tick();
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame.mock.calls[1]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);

    // That plain frame's answer asks again, and the pair is tried at once.
    fail = false;
    await act(async () => gates[1].resolve({ ...VERDICTS.voting, wants_detail: true }));
    expect(grabPair).toHaveBeenCalledTimes(2);
    expect(scannerFrame).toHaveBeenCalledTimes(3);
  });

  /** The slider's value is read through a ref like the others: the next ask waits the new time. */
  it("waits the time it was last handed, without restarting the loop", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const grabFrame = vi.fn(async () => BYTES);
    const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => ({
      frame: PAIR_FRAME,
      detail: PAIR_DETAIL,
    }));
    const videoRef = { current: readyVideo() };
    const { rerender } = renderHook(
      ({ detailWaitMs }: { detailWaitMs: number }) =>
        useScanLoop({
          videoRef,
          live: true,
          options: DEFAULT_SCANNER_OPTIONS,
          sendPx: DEFAULT_SEND_PX,
          detailWaitMs,
          grabFrame,
          grabPair,
        }),
      { initialProps: { detailWaitMs: 400 } },
    );
    await tick();
    rerender({ detailWaitMs: 100 });

    await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(99);
    expect(grabPair).not.toHaveBeenCalled();
    await tick(1);
    expect(grabPair).toHaveBeenCalledTimes(1);
    // One plain grab at the start and no second stream: the drag did not restart the pump.
    expect(grabFrame).toHaveBeenCalledTimes(1);
  });

  /** A camera stopped during the wait is not read once the wait is over. */
  it("grabs nothing when the camera stops during the wait", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const grabFrame = vi.fn(async () => BYTES);
    const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => ({
      frame: PAIR_FRAME,
      detail: PAIR_DETAIL,
    }));
    const videoRef = { current: readyVideo() };
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useScanLoop({
          videoRef,
          live,
          options: DEFAULT_SCANNER_OPTIONS,
          sendPx: DEFAULT_SEND_PX,
          detailWaitMs: 300,
          grabFrame,
          grabPair,
        }),
      { initialProps: { live: true } },
    );
    await tick();
    await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(100);
    rerender({ live: false });
    await tick(500);
    expect(grabPair).not.toHaveBeenCalled();
    expect(grabFrame).toHaveBeenCalledTimes(1);
    expect(scannerFrame).toHaveBeenCalledTimes(1);
  });

  /**
   * Off and on again inside the wait: the new stream's pump starts with no ask and no wait owed,
   * and the old one, waking from its sleep, sends nothing beside it.
   */
  it("starts a restarted camera with a plain frame, and only one", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const grabFrame = vi.fn(async () => BYTES);
    const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => ({
      frame: PAIR_FRAME,
      detail: PAIR_DETAIL,
    }));
    const videoRef = { current: readyVideo() };
    const { rerender } = renderHook(
      ({ live }: { live: boolean }) =>
        useScanLoop({ videoRef, live, ...KNOBS, detailWaitMs: 300, grabFrame, grabPair }),
      { initialProps: { live: true } },
    );
    await tick();
    await act(async () => first.resolve({ ...VERDICTS.voting, wants_detail: true }));
    await tick(100);
    rerender({ live: false });
    rerender({ live: true });
    await tick(500);
    expect(grabPair).not.toHaveBeenCalled();
    expect(scannerFrame).toHaveBeenCalledTimes(2);
    expect(scannerFrame.mock.calls[1]).toEqual([BYTES, DEFAULT_SCANNER_OPTIONS]);
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

/**
 * **The run** (`recent()`): the last frames the pump sent and had answered, for *Send scan…* —
 * which sends a run of them and never one picture. What is asked here is what is in it, and
 * when it is let go.
 */
describe("the run useScanLoop keeps", () => {
  /**
   * A grab that hands back a JPEG of its own each time — `ff d8 n` for the nth — in an array of
   * its own. The suite's shared `BYTES` would do for neither question below: the frames have to
   * be told apart, and one of the tests empties what the pump sends.
   */
  function numbered() {
    let n = 0;
    return vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([0xff, 0xd8, ++n]));
  }
  /** Which grabs a run holds, by the number each frame carries. */
  const numbers = (run: readonly RunFrame[]) => run.map((frame) => frame.jpeg[2]);

  /** Gates for the first `count` frames, answered when a test chooses; later frames park. */
  function gated(count: number) {
    const gates = Array.from({ length: count }, () => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    return gates;
  }

  /**
   * What the web host does to a frame it is handed: its buffer is *transferred* to the scanner's
   * Worker (`lib/core/web/scanner.ts`), which leaves the caller's array detached and empty.
   */
  function detach(bytes: Uint8Array) {
    structuredClone(bytes.buffer, { transfer: [bytes.buffer as ArrayBuffer] });
  }

  it("is empty until a frame has been answered", async () => {
    gated(1);
    const { result } = mount({ grabFrame: numbered() });
    expect(result.current.recent()).toEqual([]);
    await tick();
    // Sent, and not yet answered: a frame is not in the run until its verdict is taken.
    expect(scannerFrame).toHaveBeenCalledTimes(1);
    expect(result.current.recent()).toEqual([]);
  });

  it("keeps each frame it sent beside what the scanner answered for it, oldest first", async () => {
    const gates = gated(3);
    const { result } = mount({ grabFrame: numbered() });
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.noCard));
    await act(async () => gates[1].resolve(VERDICTS.voting));
    await act(async () => gates[2].resolve(VERDICTS.decided));

    const run = result.current.recent();
    expect(numbers(run)).toEqual([1, 2, 3]);
    expect(run.map((frame) => Array.from(frame.jpeg))).toEqual([
      [0xff, 0xd8, 1],
      [0xff, 0xd8, 2],
      [0xff, 0xd8, 3],
    ]);
    expect(
      run.map(({ ok, lock, confidence, distance, decided, detail }) => ({
        ok,
        lock,
        confidence,
        distance,
        decided,
        detail,
      })),
    ).toEqual([
      { ok: false, lock: "idle", confidence: null, distance: null, decided: null, detail: false },
      { ok: true, lock: "locked", confidence: 0.625, distance: 74, decided: null, detail: false },
      {
        ok: true,
        lock: "locked",
        confidence: 1,
        distance: 30,
        decided: "storm-of-saruman-ltr-72",
        detail: false,
      },
    ]);
  });

  /** When the frame was drawn off the video — not when its bytes, or its answer, came back. */
  it("stamps each frame with the clock as it was grabbed", async () => {
    scannerFrame.mockImplementation(() => answersIn(10));
    const started = performance.now();
    const { result } = mount({ grabFrame: numbered() });
    await tick(35);
    const run = result.current.recent();
    // Three answered ten milliseconds apart, and a fourth on the wire.
    expect(numbers(run)).toEqual([1, 2, 3]);
    expect(run.map((frame) => frame.at - started)).toEqual([0, 10, 20]);
  });

  /**
   * **The stamp is `runClock`'s — the clock a press reads** — so a test that holds that clock
   * holds every frame's age with it, and none has to race the machine. The round trip is not on
   * it: that is how long the scanner took, on the wall, and a held run clock must not flatten it.
   */
  it("stamps frames by the run's own clock, and times the round trip by the wall's", async () => {
    scannerFrame.mockImplementation(() => answersIn(10));
    let at = 5000;
    const clock = vi.spyOn(runClock, "now").mockImplementation(() => (at += 100));
    try {
      const { result } = mount({ grabFrame: numbered() });
      await tick(35);
      expect(result.current.recent().map((frame) => frame.at)).toEqual([5100, 5200, 5300]);
      expect(result.current.roundTripMs).toBe(10);
    } finally {
      clock.mockRestore();
    }
  });

  /**
   * Frames and bytes are not a clock: a pump whose frames come seconds apart would hold half a
   * minute of them inside both of the other bounds. Driven on the run's clock, with no waiting.
   */
  it("holds nothing grabbed more than four seconds before its newest frame", async () => {
    scannerFrame.mockImplementation(() => answersIn(10));
    let at = 0;
    const clock = vi.spyOn(runClock, "now").mockImplementation(() => (at += 1500));
    try {
      const { result } = mount({ grabFrame: numbered() });
      await tick(55);
      // Five answered, stamped 1500 apart: the newest three are inside four seconds of the last.
      const run = result.current.recent();
      expect(numbers(run)).toEqual([3, 4, 5]);
      expect(run[2].at - run[0].at).toBeLessThanOrEqual(RUN_MAX_AGE_MS);
    } finally {
      clock.mockRestore();
    }
  });

  it("does not keep a frame whose call was refused", async () => {
    const second = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(Promise.reject("scanner_frame: no bundle loaded"))
      .mockReturnValueOnce(second.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount({ grabFrame: numbered() });
    await tick();
    expect(result.current.error).toBe("scanner_frame: no bundle loaded");
    expect(result.current.recent()).toEqual([]);

    await act(async () => second.resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([2]);
  });

  /**
   * A verdict the page did not take is not in the run either: the run is what the answers on
   * screen were made from, and an answer thrown away was never on it.
   */
  it("does not keep a frame whose answer was thrown away when the evidence was cleared", async () => {
    const gates = gated(3);
    const { result } = mount({ grabFrame: numbered(), detailWaitMs: 0 });
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([1]);

    // The second frame is on the wire when the evidence goes.
    act(() => result.current.clearReads());
    expect(result.current.recent()).toEqual([]);
    await act(async () => gates[1].resolve(VERDICTS.decided));
    await tick();
    expect(result.current.recent()).toEqual([]);

    // The run starts again with the first frame answered after it.
    await act(async () => gates[2].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([3]);
  });

  it("does not keep a frame whose answer lands after the camera stopped", async () => {
    const gates = gated(2);
    const videoRef = { current: readyVideo() };
    const grabFrame = numbered();
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useScanLoop({ videoRef, live, ...KNOBS, grabFrame }),
      { initialProps: { live: true } },
    );
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([1]);

    rerender({ live: false });
    await act(async () => gates[1].resolve(VERDICTS.decided));
    await tick(60);
    expect(result.current.recent()).toEqual([]);
  });

  /** About two seconds of frames: the twenty-first pushes the first out, from the old end. */
  it("holds twenty frames at most, dropping the oldest", async () => {
    scannerFrame.mockImplementation(() => answersIn(10));
    const { result } = mount({ grabFrame: numbered() });
    await tick(10 * RUN_MAX_FRAMES + 55);
    const run = numbers(result.current.recent());
    expect(run).toHaveLength(RUN_MAX_FRAMES);
    // More than twenty were answered, the run is the newest twenty, and they are consecutive.
    expect(run[0]).toBeGreaterThan(1);
    expect(run).toEqual(Array.from({ length: RUN_MAX_FRAMES }, (_, n) => run[0] + n));
  });

  /** A camera whose frames are heavy keeps a shorter run, never a heavier one. */
  it("holds eight mebibytes of frames at most, dropping the oldest", async () => {
    scannerFrame.mockImplementation(() => answersIn(10));
    let n = 0;
    const grabFrame = vi.fn(async (): Promise<Uint8Array | null> => {
      const frame = new Uint8Array(3_000_000);
      frame[2] = ++n;
      return frame;
    });
    const { result } = mount({ grabFrame });
    await tick(45);
    // Four answered; two of them fit the budget, and they are the newest two.
    const run = result.current.recent();
    expect(numbers(run)).toEqual([3, 4]);
    expect(run.reduce((sum, frame) => sum + frame.jpeg.length, 0)).toBeLessThanOrEqual(
      RUN_MAX_BYTES,
    );
  });

  it("is emptied with the evidence, and by a reset", async () => {
    scannerFrame.mockImplementation(() => answersIn(10));
    const { result } = mount({ grabFrame: numbered(), detailWaitMs: 0 });
    await tick(35);
    expect(result.current.recent().length).toBeGreaterThan(1);

    act(() => result.current.clearReads());
    expect(result.current.recent()).toEqual([]);

    // It fills again from the frames sent after — and a reset lets those go too, at the press.
    await tick(35);
    const refilled = numbers(result.current.recent());
    expect(refilled.length).toBeGreaterThan(0);
    let reset!: Promise<void>;
    act(() => {
      reset = result.current.reset();
    });
    expect(result.current.recent()).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20);
      await reset;
    });
    expect(scannerReset).toHaveBeenCalledTimes(2);
    // Nothing from before the reset came back with the frames sent after it.
    await tick(35);
    const after = numbers(result.current.recent());
    expect(after.length).toBeGreaterThan(0);
    expect(Math.min(...after)).toBeGreaterThan(Math.max(...refilled));
  });

  /** A run never spans a Stop, or two camera streams. */
  it("is emptied when the pump stops, and starts over when it starts again", async () => {
    scannerFrame.mockImplementation(() => answersIn(10));
    const videoRef = { current: readyVideo() };
    const grabFrame = numbered();
    const { result, rerender } = renderHook(
      ({ live }: { live: boolean }) => useScanLoop({ videoRef, live, ...KNOBS, grabFrame }),
      { initialProps: { live: true } },
    );
    await tick(35);
    const before = numbers(result.current.recent());
    expect(before.length).toBeGreaterThan(1);

    rerender({ live: false });
    expect(result.current.recent()).toEqual([]);
    await tick(60);
    expect(result.current.recent()).toEqual([]);

    rerender({ live: true });
    await tick(35);
    const after = numbers(result.current.recent());
    expect(after.length).toBeGreaterThan(1);
    expect(Math.min(...after)).toBeGreaterThan(Math.max(...before));
  });

  /**
   * ⚠️ **The web host empties the array it is sent.** A frame goes to its scanner's Worker by
   * transfer, so the `Uint8Array` the pump made is detached — zero-length — from the moment the
   * call is made. A run that kept those arrays would be twenty empty frames in a browser and
   * twenty good ones on the desktop, with nothing red anywhere; so the run keeps a copy, taken
   * before the call.
   */
  it("keeps its own copy of each frame, which survives the host emptying the one it was sent", async () => {
    scannerFrame.mockImplementation((jpeg) => {
      detach(jpeg);
      return answersIn(10);
    });
    const { result } = mount({ grabFrame: numbered() });
    await tick(35);

    // The premise: what the pump handed over really is gone.
    const handed = scannerFrame.mock.calls.map(([jpeg]) => jpeg);
    expect(handed.length).toBeGreaterThan(2);
    for (const jpeg of handed) expect(jpeg.length).toBe(0);

    // And the run has every byte of every frame that was answered.
    const run = result.current.recent();
    expect(run.map((frame) => Array.from(frame.jpeg))).toEqual([
      [0xff, 0xd8, 1],
      [0xff, 0xd8, 2],
      [0xff, 0xd8, 3],
    ]);
  });

  it("keeps a copy even where the host leaves the frame alone", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount();
    await tick();
    await act(async () => first.resolve(VERDICTS.voting));
    const [kept] = result.current.recent();
    // The same bytes in an array of the run's own: what was sent is still what was sent.
    expect(kept.jpeg).toEqual(BYTES);
    expect(kept.jpeg).not.toBe(BYTES);
    expect(scannerFrame.mock.calls[0][0]).toBe(BYTES);
  });

  /** A detail image is not kept or sent; that one went to the scanner with a frame is. */
  it("says which frame went to the scanner with a detail image", async () => {
    const gates = gated(3);
    const { result } = mount({ detailWaitMs: 0 });
    await tick();
    await act(async () => gates[0].resolve({ ...VERDICTS.voting, wants_detail: true }));
    await act(async () => gates[1].resolve({ ...VERDICTS.voting, wants_detail: false }));
    await act(async () => gates[2].resolve(VERDICTS.voting));

    const run = result.current.recent();
    expect(run.map((frame) => frame.detail)).toEqual([false, true, false]);
    // The paired frame's own small JPEG is the one in the run — never the detail image.
    expect(run[1].jpeg).toEqual(PAIR_FRAME);
    expect(run[0].jpeg).toEqual(BYTES);
  });

  it("says no detail went with a pair that had none to give", async () => {
    const gates = gated(2);
    const grabPair = vi.fn(async (): Promise<GrabbedPair | null> => ({
      frame: PAIR_FRAME,
      detail: null,
    }));
    const { result } = mount({ grabPair, detailWaitMs: 0 });
    await tick();
    await act(async () => gates[0].resolve({ ...VERDICTS.voting, wants_detail: true }));
    await act(async () => gates[1].resolve(VERDICTS.voting));
    expect(result.current.recent().map((frame) => frame.detail)).toEqual([false, false]);
  });

  /**
   * **A device that may send keeps its run at full resolution** (the owner's decision,
   * 2026-10-22): every frame is one grab of three pictures — the scanner's frame, a detail image
   * when one was asked for, and the copy the run keeps — and only the first two go to the
   * scanner.
   */
  describe("with full frames kept", () => {
    /** A kept grab whose three pictures are told apart: `ff d8 n` small, `ff d9 n` kept. */
    function keptGrab() {
      let n = 0;
      return vi.fn(
        async (
          _video: HTMLVideoElement,
          _longEdge: number,
          _quality: number,
          detail: boolean,
        ): Promise<GrabbedKept | null> => {
          n += 1;
          return {
            frame: new Uint8Array([0xff, 0xd8, n]),
            detail: detail ? new Uint8Array([0xff, 0xda, n]) : null,
            kept: new Uint8Array([0xff, 0xd9, n]),
          };
        },
      );
    }

    it("keeps the full copy, sends the scanner its own frame, and the detail beside it", async () => {
      const gates = gated(3);
      const grabKept = keptGrab();
      const { result, grabFrame, grabPair } = mount({
        grabKept,
        keepFullFrames: true,
        detailWaitMs: 0,
      });
      await tick();
      await act(async () => gates[0].resolve({ ...VERDICTS.voting, wants_detail: true }));
      await act(async () => gates[1].resolve(VERDICTS.voting));
      await act(async () => gates[2].resolve(VERDICTS.voting));

      // Every grab is the kept one, asked at the pump's size, and for a detail image only on the
      // frame after the ask.
      expect(grabFrame).not.toHaveBeenCalled();
      expect(grabPair).not.toHaveBeenCalled();
      expect(grabKept.mock.calls.slice(0, 3).map((call) => call[3])).toEqual([false, true, false]);
      expect(grabKept.mock.calls[0][1]).toBe(DEFAULT_SEND_PX);
      // The scanner was given the small frames, and the detail with the second…
      const sent = scannerFrame.mock.calls.slice(0, 3);
      expect(sent.map((call) => Array.from(call[0] as Uint8Array))).toEqual([
        [0xff, 0xd8, 1],
        [0xff, 0xd8, 2],
        [0xff, 0xd8, 3],
      ]);
      expect(sent.map((call) => call.length)).toEqual([2, 3, 2]);
      // …and the run is the full copies, each beside what was said of its frame.
      const run = result.current.recent();
      expect(run.map((frame) => Array.from(frame.jpeg))).toEqual([
        [0xff, 0xd9, 1],
        [0xff, 0xd9, 2],
        [0xff, 0xd9, 3],
      ]);
      expect(run.map((frame) => frame.detail)).toEqual([false, true, false]);
    });

    it("keeps the scanner's own frame where the full copy did not encode", async () => {
      const gates = gated(1);
      const grabKept = vi.fn(async (): Promise<GrabbedKept | null> => ({
        frame: PAIR_FRAME,
        detail: null,
        kept: null,
      }));
      const { result } = mount({ grabKept, keepFullFrames: true });
      await tick();
      await act(async () => gates[0].resolve(VERDICTS.voting));
      expect(result.current.recent().map((frame) => frame.jpeg)).toEqual([PAIR_FRAME]);
    });

    it("starts the run over when the page starts or stops keeping them", async () => {
      const gates = gated(3);
      const grabKept = keptGrab();
      const { result, rerender, args } = mount({ grabFrame: numbered(), grabKept });
      await tick();
      await act(async () => gates[0].resolve(VERDICTS.voting));
      expect(result.current.recent()).toHaveLength(1);

      // A run is one size of picture: the small frame already kept goes with the switch.
      args.keepFullFrames = true;
      rerender();
      expect(result.current.recent()).toEqual([]);
      await tick();
      await act(async () => gates[1].resolve(VERDICTS.voting));
      await tick();
      await act(async () => gates[2].resolve(VERDICTS.voting));
      expect(result.current.recent().every((frame) => frame.jpeg[1] === 0xd9)).toBe(true);
      expect(result.current.recent().length).toBeGreaterThan(0);
    });
  });

  /**
   * A press reads the run once and the pump goes on: the array it was handed is its own, and a
   * frame that lands afterwards is not in it.
   */
  it("hands out a snapshot that later frames do not reach", async () => {
    const gates = gated(3);
    const { result } = mount({ grabFrame: numbered() });
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    await act(async () => gates[1].resolve(VERDICTS.voting));

    const taken = result.current.recent();
    expect(numbers(taken)).toEqual([1, 2]);
    await act(async () => gates[2].resolve(VERDICTS.decided));
    expect(numbers(taken)).toEqual([1, 2]);
    expect(numbers(result.current.recent())).toEqual([1, 2, 3]);

    // …nor does emptying the ring reach an array already handed out.
    const whole = result.current.recent();
    act(() => result.current.clearReads());
    expect(numbers(whole)).toEqual([1, 2, 3]);
    expect(result.current.recent()).toEqual([]);
  });

  it("is the same function from render to render", async () => {
    const first = deferred<ScannerVerdict>();
    scannerFrame
      .mockReturnValueOnce(first.promise)
      .mockReturnValue(deferred<ScannerVerdict>().promise);
    const { result } = mount();
    const { recent, breakRun } = result.current;
    await tick();
    await act(async () => first.resolve(VERDICTS.voting));
    expect(result.current.recent).toBe(recent);
    // A page keys an effect on this one: a new function a render would break the run a render.
    expect(result.current.breakRun).toBe(breakRun);
  });
});

/**
 * **The two breaks the session makes by itself.** A reset, a Stop and a new stream are this
 * side's doing, and the ring is emptied where they happen. The session also drops its tracker on
 * its own account — on the first frame it is sent in another mode, and when it takes a changed
 * set of filters — and a run across either would be frames judged one way under a label that
 * says another. Neither clears anything on screen, which is what tells them from `clearReads`.
 */
describe("the run useScanLoop keeps, across the session's own breaks", () => {
  function numbered() {
    let n = 0;
    return vi.fn(async (): Promise<Uint8Array | null> => new Uint8Array([0xff, 0xd8, ++n]));
  }
  const numbers = (run: readonly RunFrame[]) => run.map((frame) => frame.jpeg[2]);

  function gated(count: number) {
    const gates = Array.from({ length: count }, () => deferred<ScannerVerdict>());
    let n = 0;
    scannerFrame.mockImplementation(
      () => gates[n++]?.promise ?? deferred<ScannerVerdict>().promise,
    );
    return gates;
  }

  const EXACT: ScannerVerdict = { ...VERDICTS.voting, mode: "exact" };

  it("says of each frame which mode the scanner judged it in", async () => {
    const gates = gated(2);
    const { result } = mount({ grabFrame: numbered() });
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    await act(async () => gates[1].resolve(VERDICTS.decided));
    expect(result.current.recent().map((frame) => frame.mode)).toEqual(["fast", "fast"]);
  });

  /**
   * The mode is the verdict's — the session's own word — and not the option the frame went out
   * with: the page's switch moves when it is pressed, and the session's when the next frame
   * reaches it.
   */
  it("starts the run over at the first frame the scanner answers in another mode", async () => {
    const gates = gated(5);
    const { result } = mount({ grabFrame: numbered(), detailWaitMs: 0 });
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    await act(async () => gates[1].resolve(VERDICTS.voting));
    await act(async () => gates[2].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([1, 2, 3]);

    // The reader switched to Exact: this is the frame the session forgot the card on.
    await act(async () => gates[3].resolve(EXACT));
    expect(numbers(result.current.recent())).toEqual([4]);
    expect(result.current.recent()[0].mode).toBe("exact");
    // What is on screen is untouched — the verdict is the one just taken.
    expect(result.current.verdict).toEqual(EXACT);

    await act(async () => gates[4].resolve(EXACT));
    expect(numbers(result.current.recent())).toEqual([4, 5]);
  });

  it("starts the run over when the scanner first answers in Neural, as for any mode", async () => {
    const gates = gated(3);
    const { result } = mount({ grabFrame: numbered(), detailWaitMs: 0 });
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    await act(async () => gates[1].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([1, 2]);

    await act(async () => gates[2].resolve({ ...VERDICTS.voting, mode: "neural" }));
    expect(numbers(result.current.recent())).toEqual([3]);
    expect(result.current.recent()[0].mode).toBe("neural");
  });

  it("lets the run go at breakRun, and starts it again with the next frame sent", async () => {
    const gates = gated(4);
    const { result } = mount({ grabFrame: numbered(), detailWaitMs: 0 });
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    await act(async () => gates[1].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([1, 2]);

    // The third frame is on the wire when the session takes the changed filters.
    expect(scannerFrame).toHaveBeenCalledTimes(3);
    act(() => result.current.breakRun());
    expect(result.current.recent()).toEqual([]);

    // **It was sent before the break and answered after it**, so nobody can say which side of
    // the change judged it: it joins neither run.
    await act(async () => gates[2].resolve(VERDICTS.decided));
    expect(result.current.recent()).toEqual([]);

    // The first frame sent after the break is the first of the new run.
    expect(scannerFrame).toHaveBeenCalledTimes(4);
    await act(async () => gates[3].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([4]);
  });

  /**
   * **Not `clearReads`.** The session reset itself and nothing on screen is stale, so the
   * verdict and the kept reads stay, and the answer to the frame in flight is taken and drawn
   * like any other — where `clearReads` would have thrown it away.
   */
  it("leaves the verdict, the kept reads and the frame in flight's answer alone at breakRun", async () => {
    const gates = gated(3);
    const { result } = mount({ grabFrame: numbered(), detailWaitMs: 0 });
    await tick();
    const read: ScannerVerdict = { ...VERDICTS.voting, ocr: READS.ocr };
    await act(async () => gates[0].resolve(read));
    expect(result.current.verdict).toEqual(read);
    expect(result.current.lastOcr).toEqual(READS.ocr);

    act(() => result.current.breakRun());
    expect(result.current.verdict).toEqual(read);
    expect(result.current.lastOcr).toEqual(READS.ocr);
    expect(result.current.error).toBeNull();

    // The frame that was on the wire: out of the run, and on the screen.
    await act(async () => gates[1].resolve(VERDICTS.decided));
    expect(result.current.recent()).toEqual([]);
    expect(result.current.verdict).toEqual(VERDICTS.decided);
    expect(result.current.lastOcr).toEqual(READS.ocr);
  });

  /**
   * The decision edge is the session's count of cards, and a change of filters is not a card: a
   * decision that lands on the frame in flight across the break is still one add.
   */
  it("still passes on a decision that lands on the frame in flight across breakRun", async () => {
    const gates = gated(2);
    const onDecision = vi.fn();
    const { result } = mount({ grabFrame: numbered(), detailWaitMs: 0, onDecision });
    await tick();
    // The camera's first number is a baseline, not news.
    await act(async () => gates[0].resolve({ ...VERDICTS.voting, decision_seq: 0 }));
    act(() => result.current.breakRun());
    await act(async () => gates[1].resolve({ ...VERDICTS.decided, decision_seq: 1 }));
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(result.current.recent()).toEqual([]);
  });

  it("breaks an empty run without harm, and as often as it is asked", async () => {
    const gates = gated(1);
    const { result } = mount({ grabFrame: numbered() });
    act(() => result.current.breakRun());
    act(() => result.current.breakRun());
    expect(result.current.recent()).toEqual([]);
    // Sent after both: it is in the run.
    await tick();
    await act(async () => gates[0].resolve(VERDICTS.voting));
    expect(numbers(result.current.recent())).toEqual([1]);
  });
});
