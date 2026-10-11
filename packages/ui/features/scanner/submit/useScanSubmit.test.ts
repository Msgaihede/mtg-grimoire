import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STATUS, VERDICTS } from "../fixtures";
import type { ScanFilters, ScanMode, ScannerStatus, ScannerVerdict } from "../types";
import { RUN_MIN_FRAMES, runFrameOf, type RunFrame } from "./run";
import { SCAN_TOO_SHORT } from "./submitText";
import { useScanSubmit } from "./useScanSubmit";

interface Page {
  recent: () => readonly RunFrame[];
  verdict: ScannerVerdict | null;
  mode: ScanMode;
  status: ScannerStatus | null;
  filters: ScanFilters;
  ready: boolean;
}

const NO_FILTERS: ScanFilters = { sets: [], released_from: null, released_to: null };

/** `count` frames the pump sent, a hundred milliseconds apart, the last at `at` — one byte each. */
function ring(count: number, at = 1000): RunFrame[] {
  return Array.from({ length: count }, (_, n) =>
    runFrameOf(new Uint8Array([n + 1]), at - (count - 1 - n) * 100, VERDICTS.voting, false),
  );
}

function page(over: Partial<Page> = {}): Page {
  return {
    recent: vi.fn(() => ring(6)),
    verdict: VERDICTS.decided,
    mode: "fast",
    status: STATUS.present,
    filters: NO_FILTERS,
    ready: true,
    ...over,
  };
}

/** The press that opened it — a real button in the document, so the caret can come back to it. */
function opener(): HTMLButtonElement {
  const button = document.createElement("button");
  document.body.append(button);
  return button;
}

/** The press lands at 1010 on the page's clock: ten milliseconds after the last frame. */
beforeEach(() => {
  vi.spyOn(performance, "now").mockReturnValue(1010);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("useScanSubmit", () => {
  it("is closed until the press, and reads nothing of the scan before it", () => {
    const recent = vi.fn(() => ring(6));
    const { result } = renderHook(() => useScanSubmit(page({ recent })));
    expect(result.current.run).toBeNull();
    expect(result.current.error).toBeNull();
    expect(recent).not.toHaveBeenCalled();
  });

  /**
   * One synchronous step: the run as the pump has it, and the page's state, in the tick of the
   * press. Nothing is grabbed and nothing is awaited, so the dialog is open by the time the
   * press's own handler returns.
   */
  it("opens at once on the run the scanner was given, with what the scanner was saying", () => {
    const recent = vi.fn(() => ring(6));
    const { result } = renderHook(() => useScanSubmit(page({ recent })));
    act(() => result.current.open(opener()));

    expect(recent).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
    expect(result.current.run?.said).toEqual({
      reported: "storm-of-saruman-ltr-72",
      mode: "fast",
      confidence: 1,
      distance: 30,
      bundle: 117630,
      filters: NO_FILTERS,
    });
    expect(result.current.run?.leadName).toBe("Storm of Saruman");
    // Every frame, oldest first, as the text that will be drawn and sent.
    expect(result.current.run?.frames.map((one) => one.jpeg)).toEqual([
      "AQ==",
      "Ag==",
      "Aw==",
      "BA==",
      "BQ==",
      "Bg==",
    ]);
  });

  it("counts every frame back from the press: oldest first, never after it", () => {
    const { result } = renderHook(() => useScanSubmit(page()));
    act(() => result.current.open(opener()));
    const ms = result.current.run?.frames.map((one) => one.ms) ?? [];
    expect(ms).toEqual([-510, -410, -310, -210, -110, -10]);
    expect(ms.every((one) => one <= 0)).toBe(true);
    expect([...ms].sort((a, b) => a - b)).toEqual(ms);
  });

  /** What the scanner was narrowed to rides with what it said — the reader's own filters. */
  it("carries the filters in force at the press", () => {
    const narrowed: ScanFilters = { sets: ["hob"], released_from: null, released_to: "2024-12-31" };
    const { result } = renderHook(() => useScanSubmit(page({ filters: narrowed })));
    act(() => result.current.open(opener()));
    expect(result.current.run?.said.filters).toEqual(narrowed);
  });

  /**
   * **All of the run or nothing.** A camera that has only just started, or evidence only just
   * reset, has not shown the scanner enough to be a scan — and there is no falling back to the
   * picture on screen. The press opens nothing and says what to do.
   */
  it.each([0, 1, RUN_MIN_FRAMES - 1])(
    "opens nothing on a run of %i frames, and says to hold the card a moment",
    (count) => {
      const { result } = renderHook(() => useScanSubmit(page({ recent: () => ring(count) })));
      act(() => result.current.open(opener()));
      expect(result.current.run).toBeNull();
      expect(result.current.error).toBe(SCAN_TOO_SHORT);
      expect(SCAN_TOO_SHORT).toBe(
        "Not enough of the scan yet. Hold the card under the camera a moment and press again.",
      );
    },
  );

  it("opens on exactly the fewest frames that are a scan", () => {
    const { result } = renderHook(() =>
      useScanSubmit(page({ recent: () => ring(RUN_MIN_FRAMES) })),
    );
    act(() => result.current.open(opener()));
    expect(result.current.run?.frames).toHaveLength(RUN_MIN_FRAMES);
    expect(result.current.error).toBeNull();
  });

  it("clears the sentence on the press that does open", () => {
    let frames = ring(2);
    const { result } = renderHook(() => useScanSubmit(page({ recent: () => frames })));
    act(() => result.current.open(opener()));
    expect(result.current.error).toBe(SCAN_TOO_SHORT);

    // Held a moment, as it said: the pump has sent more.
    frames = ring(7);
    act(() => result.current.open(opener()));
    expect(result.current.error).toBeNull();
    expect(result.current.run?.frames).toHaveLength(7);
  });

  /**
   * The camera keeps running behind the dialog and the page goes on re-rendering with each
   * verdict, while the pump's ring turns over. The pictures the reader is looking through must
   * stay the pictures, and the scanner's half what it was at the press.
   */
  it("keeps the run as it was however the page and the pump move on behind it", () => {
    let frames = ring(6);
    const recent = () => frames;
    const { result, rerender } = renderHook((props: Page) => useScanSubmit(props), {
      initialProps: page({ recent }),
    });
    act(() => result.current.open(opener()));
    const frozen = result.current.run;
    const pictures = frozen?.frames.map((one) => one.jpeg);

    frames = ring(20, 5000);
    rerender(page({ recent, verdict: VERDICTS.voting, mode: "exact", status: STATUS.missing }));
    rerender(page({ recent, verdict: null, filters: { ...NO_FILTERS, sets: ["ltr"] } }));
    expect(result.current.run).toBe(frozen);
    expect(result.current.run?.frames.map((one) => one.jpeg)).toEqual(pictures);
    expect(result.current.run?.said.mode).toBe("fast");
    expect(result.current.run?.said.filters).toEqual(NO_FILTERS);
  });

  it("takes one run for two presses that land together", () => {
    const recent = vi.fn(() => ring(6));
    const { result } = renderHook(() => useScanSubmit(page({ recent })));
    act(() => {
      result.current.open(opener());
      result.current.open(opener());
    });
    expect(recent).toHaveBeenCalledTimes(1);
    expect(result.current.run).not.toBeNull();
  });

  it("does not take a second run over the one the dialog is open on", () => {
    const recent = vi.fn(() => ring(6));
    const { result } = renderHook(() => useScanSubmit(page({ recent })));
    act(() => result.current.open(opener()));
    const frozen = result.current.run;

    act(() => result.current.open(opener()));
    expect(recent).toHaveBeenCalledTimes(1);
    expect(result.current.run).toBe(frozen);
  });

  it("hands the caret back to the press on a dismissal", () => {
    const from = opener();
    const { result } = renderHook(() => useScanSubmit(page()));
    act(() => result.current.open(from));
    expect(result.current.run).not.toBeNull();
    expect(from).not.toHaveFocus();

    act(() => result.current.onDismiss());
    expect(result.current.run).toBeNull();
    expect(from).toHaveFocus();
  });

  it("closes without moving the caret on a press outside", () => {
    const from = opener();
    const elsewhere = opener();
    const { result } = renderHook(() => useScanSubmit(page()));
    act(() => result.current.open(from));
    elsewhere.focus();

    act(() => result.current.onClose());
    expect(result.current.run).toBeNull();
    expect(elsewhere).toHaveFocus();
  });

  it.each(["onDismiss", "onClose"] as const)(
    "opens again after %s, on the run as it stands then",
    (way) => {
      let frames = ring(6);
      const { result } = renderHook(() => useScanSubmit(page({ recent: () => frames })));
      act(() => result.current.open(opener()));
      act(() => result.current[way]());

      frames = ring(9);
      act(() => result.current.open(opener()));
      expect(result.current.run?.frames).toHaveLength(9);
    },
  );

  /**
   * The press is drawn only while there can be a run. A sentence about a press — *press again* —
   * over a stopped scanner, with nothing there to press, is an instruction nobody can follow; and
   * one that came back unprompted when recognition started again would be about a press the
   * reader made before they stopped.
   */
  it("drops its sentence when the press stops being offered, and does not bring it back", () => {
    const short = () => ring(1);
    const { result, rerender } = renderHook((props: Page) => useScanSubmit(props), {
      initialProps: page({ recent: short }),
    });
    act(() => result.current.open(opener()));
    expect(result.current.error).toBe(SCAN_TOO_SHORT);

    rerender(page({ recent: short, ready: false }));
    expect(result.current.error).toBeNull();
    rerender(page({ recent: short, ready: true }));
    expect(result.current.error).toBeNull();
  });

  it("opens nothing, and reads nothing, where there can be no run", () => {
    const recent = vi.fn(() => ring(6));
    const { result } = renderHook(() => useScanSubmit(page({ recent, ready: false })));
    act(() => result.current.open(opener()));
    expect(result.current.run).toBeNull();
    expect(result.current.error).toBeNull();
    expect(recent).not.toHaveBeenCalled();
  });

  it("keeps its two ways out stable, so the dialog's body is not redrawn with the page", () => {
    const { result, rerender } = renderHook((props: Page) => useScanSubmit(props), {
      initialProps: page(),
    });
    const { onDismiss, onClose } = result.current;
    rerender(page({ verdict: VERDICTS.voting }));
    expect(result.current.onDismiss).toBe(onDismiss);
    expect(result.current.onClose).toBe(onClose);
  });
});
