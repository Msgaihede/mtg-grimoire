import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VERDICTS } from "@grimoire/ui/features/scanner/fixtures";
import { matchStrip, type LastAdded } from "@grimoire/ui/features/scanner/reader/readerText";
import type { ScannerVerdict } from "@grimoire/ui/lib/ipc";
import { CameraBox } from "./CameraBox";
import { MatchLine } from "./MatchLine";
import { ScanControls } from "./ScanControls";

const SARUMAN: LastAdded = {
  name: "Storm of Saruman",
  setCode: "ltr",
  collectorNumber: "72",
  bumpedTo: null,
  replaced: false,
};

function line(
  verdict: ScannerVerdict | null,
  {
    lastAdded = null,
    onReset = vi.fn(),
    onSend,
  }: {
    lastAdded?: LastAdded;
    onReset?: () => void;
    onSend?: (opener: HTMLElement) => void;
  } = {},
) {
  const { unmount } = render(
    <MatchLine verdict={verdict} lastAdded={lastAdded} onReset={onReset} onSend={onSend} />,
  );
  return {
    status: screen.getByRole("status", { name: "Scanner status" }),
    expected: matchStrip(verdict, lastAdded),
    onReset,
    unmount,
  };
}

describe("the phone's status line", () => {
  it("says the desktop strip's own words for every state it can be in", () => {
    const states: [ScannerVerdict | null, Parameters<typeof line>[1]][] = [
      [null, {}],
      [VERDICTS.noCard, {}],
      [VERDICTS.voting, {}],
      [VERDICTS.noMatch, {}],
      [VERDICTS.panicked, {}],
      [VERDICTS.decided, { lastAdded: SARUMAN }],
      [VERDICTS.decided, { lastAdded: { ...SARUMAN, bumpedTo: 2 } }],
      [VERDICTS.decided, { lastAdded: { ...SARUMAN, replaced: true } }],
      [VERDICTS.resolved, {}],
      [VERDICTS.ambiguous, {}],
      [VERDICTS.ambiguous, { lastAdded: SARUMAN }],
      [{ ...VERDICTS.voting, matcher: false }, {}],
    ];
    for (const [verdict, over] of states) {
      const { status, expected, unmount } = line(verdict, over);
      // Nothing of its own: the word, the card, the printing and the sentence are `matchStrip`'s.
      const words = [expected.word, expected.name, expected.printing, expected.sentence]
        .filter((part): part is string => part !== null)
        .join(" ");
      expect(status.textContent?.replace(/\s+/g, " ").trim()).toBe(words);
      unmount();
    }
  });

  it("gives the instruction a line of its own, so the card's name has the first", () => {
    const { status } = line(VERDICTS.decided, { lastAdded: SARUMAN });
    const [first, second] = Array.from(status.children);
    expect(first.textContent).toMatch(/^Matched\s+Storm of Saruman\s+LTR 72\s*$/);
    expect(second.textContent).toBe("Added · swap in the next card");
    // The sentence may wrap; the name is what gives way.
    expect(second.classList.contains("truncate")).toBe(false);
    expect(first.querySelector(".truncate")?.textContent).toBe("Storm of Saruman");
  });

  it("draws a leaning name without announcing it, and announces a matched one", () => {
    const leaning = line(VERDICTS.voting);
    const name = Array.from(leaning.status.querySelectorAll("span")).find(
      (span) => span.textContent === "Plains",
    );
    expect(name).toHaveAttribute("aria-hidden", "true");
    leaning.unmount();

    const matched = line(VERDICTS.decided, { lastAdded: SARUMAN });
    const settled = Array.from(matched.status.querySelectorAll("span")).find(
      (span) => span.textContent === "Storm of Saruman",
    );
    expect(settled).not.toHaveAttribute("aria-hidden");
  });

  it("keeps the bar and the reset press outside the live region", async () => {
    const { status, onReset } = line(VERDICTS.voting);
    const bar = screen.getByRole("progressbar", { name: "Match progress" });
    const reset = screen.getByRole("button", { name: "Reset evidence" });
    expect(status.contains(bar)).toBe(false);
    expect(status.contains(reset)).toBe(false);
    expect(bar).toHaveAttribute("aria-valuenow", "63");
    await userEvent.click(reset);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("holds two lines of height whatever it says", () => {
    const { status } = line(null);
    expect(status.classList.contains("min-h-12")).toBe(true);
    expect(status.children).toHaveLength(2);
  });

  /**
   * The desktop strip's second press, by the desktop's name, as a 44px glyph: the words would
   * take the bar's room at 360px.
   */
  it("draws Send scan… as a thumb-sized press beside Reset, outside the live region", async () => {
    const onSend = vi.fn();
    const { status } = line(VERDICTS.voting, { onSend });
    const send = screen.getByRole("button", { name: "Send scan…" });
    const reset = screen.getByRole("button", { name: "Reset evidence" });
    expect(status.contains(send)).toBe(false);
    expect(send.previousElementSibling).toBe(reset);
    expect(send.parentElement).toBe(
      screen.getByRole("progressbar", { name: "Match progress" }).parentElement,
    );
    // A glyph and no words, a finger's size both ways, and the bar keeps the row's spare width.
    expect(send.textContent).toBe("");
    expect(send.classList.contains("size-11")).toBe(true);
    expect(send.classList.contains("shrink-0")).toBe(true);
    expect(send).toHaveAttribute("aria-haspopup", "dialog");

    await userEvent.click(send);
    expect(onSend).toHaveBeenCalledTimes(1);
    // Handed the press itself, which the page keeps for the caret.
    expect(onSend).toHaveBeenCalledWith(send);
  });

  /** The desktop's rule: no run to send, no press — and Reset is unaffected. */
  it("draws no Send scan… where the page hands it no press", () => {
    line(VERDICTS.voting);
    expect(screen.queryByRole("button", { name: "Send scan…" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reset evidence" })).toBeInTheDocument();
  });
});

describe("the bar over the camera", () => {
  function bar(over: Partial<Parameters<typeof ScanControls>[0]> = {}) {
    const props = {
      scanning: true,
      onScanning: vi.fn(),
      pointAndShoot: false,
      shooting: false,
      onHold: vi.fn(),
      onTap: vi.fn(),
      onOptions: vi.fn(),
      ...over,
    };
    render(<ScanControls {...props} />);
    return props;
  }

  it("draws Scan in place of Start and Stop under point and shoot, read while held", () => {
    const props = bar({ pointAndShoot: true });
    expect(screen.queryByRole("button", { name: /scanning/ })).toBeNull();
    const scan = screen.getByRole("button", { name: "Scan" });
    expect(scan).toHaveAttribute("aria-pressed", "false");
    fireEvent.pointerDown(scan, { pointerId: 1 });
    expect(props.onHold).toHaveBeenLastCalledWith(true);
    fireEvent.pointerUp(scan, { pointerId: 1 });
    expect(props.onHold).toHaveBeenLastCalledWith(false);
    // A finger taken away by the system ends the hold too.
    fireEvent.pointerDown(scan, { pointerId: 2 });
    fireEvent.pointerCancel(scan, { pointerId: 2 });
    expect(props.onHold).toHaveBeenLastCalledWith(false);
    // The pointer's own click after a hold is not a second press.
    fireEvent.click(scan, { detail: 1 });
    expect(props.onTap).not.toHaveBeenCalled();
  });

  it("holds on Space, and takes a press with no finger behind it as one card's tap", () => {
    const props = bar({ pointAndShoot: true });
    const scan = screen.getByRole("button", { name: "Scan" });
    fireEvent.keyDown(scan, { key: " " });
    expect(props.onHold).toHaveBeenLastCalledWith(true);
    fireEvent.keyUp(scan, { key: " " });
    expect(props.onHold).toHaveBeenLastCalledWith(false);
    // Space's own click on release is the hold's, not a tap.
    fireEvent.click(scan, { detail: 0 });
    expect(props.onTap).not.toHaveBeenCalled();
    // Assistive tech's activation (and Enter): no pointer, so one card's shot.
    fireEvent.click(scan, { detail: 0 });
    expect(props.onTap).toHaveBeenCalledTimes(1);
  });

  it("stops and starts in the desktop's words", async () => {
    const stopping = bar();
    await userEvent.click(screen.getByRole("button", { name: "Stop scanning" }));
    expect(stopping.onScanning).toHaveBeenCalledWith(false);
  });

  it("offers Start once stopped", async () => {
    const starting = bar({ scanning: false });
    await userEvent.click(screen.getByRole("button", { name: "Start scanning" }));
    expect(starting.onScanning).toHaveBeenCalledWith(true);
  });

  /** One scanner, so no mode to pick: the bar is the scanning press and the Options press. */
  it("draws no scan mode, and the Options press at the row's end beside Stop", () => {
    bar();
    expect(screen.queryByRole("group", { name: "Scan mode" })).toBeNull();
    for (const name of ["Fast", "Exact", "Neural"]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
    const options = screen.getByRole("button", { name: "Scanner options" });
    expect(options).toHaveClass("ml-auto");
    expect(options.previousElementSibling).toBe(
      screen.getByRole("button", { name: "Stop scanning" }),
    );
  });

  it("opens everything else from one press", async () => {
    const props = bar();
    await userEvent.click(screen.getByRole("button", { name: "Scanner options" }));
    expect(props.onOptions).toHaveBeenCalledTimes(1);
  });
});

describe("the camera's box", () => {
  const ref = { current: null as HTMLVideoElement | null };
  // The overlay asks its canvas for a 2D context on every animation frame, which jsdom answers
  // with a "Not implemented" line; no context stops its loop at its own guard, quietly.
  const real = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
  beforeAll(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
      configurable: true,
      value: () => null,
    });
  });
  afterAll(() => {
    if (real !== undefined) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", real);
  });

  it("is shaped by the stream once there is one, and 4:3 until then", () => {
    const { container, rerender } = render(
      <CameraBox videoRef={ref} camera={{ kind: "starting" }} verdict={null} />,
    );
    const box = container.querySelector<HTMLElement>("[data-camera-box]");
    // jsdom writes a ratio back as `w / 1`; the number is what is asked about.
    expect(parseFloat(box?.style.aspectRatio ?? "")).toBeCloseTo(4 / 3);
    rerender(
      <CameraBox
        videoRef={ref}
        camera={{ kind: "live", width: 1080, height: 1920, deviceId: null }}
        verdict={null}
      />,
    );
    expect(parseFloat(box?.style.aspectRatio ?? "")).toBeCloseTo(1080 / 1920);
  });

  it("crops the picture and the overlay alike, and caps its own height", () => {
    const { container } = render(
      <CameraBox videoRef={ref} camera={{ kind: "starting" }} verdict={null} />,
    );
    const box = container.querySelector("[data-camera-box]");
    // The one class the video and the canvas over it have to agree on.
    expect(container.querySelector("video")?.classList.contains("object-cover")).toBe(true);
    expect(container.querySelector("canvas")?.classList.contains("object-cover")).toBe(true);
    expect(box?.classList.contains("max-h-[38dvh]")).toBe(true);
    // Never a zero-basis grow: under a scrolling parent that collapses to nothing.
    expect(box?.classList.contains("flex-1")).toBe(false);
    expect(box?.classList.contains("shrink-0")).toBe(true);
  });

  it("says the camera's own sentence where the picture would be", () => {
    render(
      <CameraBox
        videoRef={ref}
        camera={{ kind: "error", name: "NotFoundError", message: "No camera on this device." }}
        verdict={null}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("No camera on this device.");
  });

  it("keeps its live region mounted while it has nothing to say, and fills it", () => {
    const { rerender } = render(
      <CameraBox videoRef={ref} camera={{ kind: "starting" }} verdict={null} />,
    );
    // There before the sentence is: a region that first appears with its words already inside
    // announces nothing.
    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();

    rerender(
      <CameraBox
        videoRef={ref}
        camera={{ kind: "starting" }}
        verdict={null}
        note="The card database is busy finishing a sync. Try that again in a moment."
      />,
    );
    // The same element, with the words put into it.
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toHaveTextContent("The card database is busy finishing a sync.");

    rerender(<CameraBox videoRef={ref} camera={{ kind: "starting" }} verdict={null} note={null} />);
    expect(screen.getByRole("status")).toBe(region);
    expect(region).toBeEmptyDOMElement();
  });

  it("says a host has no scanner session where the picture would be", () => {
    render(
      <CameraBox
        videoRef={ref}
        camera={{ kind: "starting" }}
        verdict={null}
        unavailable="The scanner does not run in a browser yet."
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The scanner does not run in a browser yet.",
    );
  });
});

// The slot for the scanner's data has a suite of its own, `ScannerDataSlot.test.tsx`: it asks
// the host what is owed, so it is rendered over a world rather than bare.
