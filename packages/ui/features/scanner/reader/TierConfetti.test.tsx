import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Whether the reader has asked for less motion, set by the test. `motion`'s hook reads the media
 * query once into a module-level value, so a suite cannot flip the query under it; the hook is
 * stood in for instead, and everything else of the library is the real thing.
 */
const motionPref = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (original) => ({
  ...(await original<typeof import("motion/react")>()),
  useReducedMotion: () => motionPref.reduced,
}));

import { confettiEnd, confettiPieces, confettiSeed } from "./confetti";
import { TierConfetti } from "./TierConfetti";

const JACKPOT = { stamp: "a:1", tier: "jackpot" } as const;

/** The design canvas's picture, which jsdom — laying nothing out — has to be told about. */
function hasABox(): void {
  vi.spyOn(HTMLCanvasElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 640,
    height: 600,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 640,
    bottom: 600,
    toJSON: () => ({}),
  });
}

beforeEach(() => {
  motionPref.reduced = false;
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Whether there is a canvas, and when its loop runs. jsdom has no 2D context, so what the canvas
 * draws is `confetti.ts`'s to test and the live pass's to see.
 */
describe("TierConfetti", () => {
  it("renders no canvas at all under reduced motion", () => {
    motionPref.reduced = true;
    const { container } = render(<TierConfetti burst={JACKPOT} />);
    expect(container.querySelector("canvas")).toBeNull();
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a hidden, unpressable canvas over the whole box otherwise", () => {
    const { container } = render(<TierConfetti burst={null} />);
    const canvas = container.querySelector("canvas");
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute("aria-hidden", "true");
    expect(canvas).toHaveClass("pointer-events-none", "absolute", "inset-0");
  });

  it("throws a burst on a canvas with no 2D context without an error, and keeps the canvas", () => {
    // A box with a size, so the burst gets as far as asking for a context — which jsdom answers
    // with `null`, as a browser does for a canvas it cannot give one.
    hasABox();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    const { container, rerender, unmount } = render(<TierConfetti burst={JACKPOT} />);
    expect(getContext).toHaveBeenCalledWith("2d");
    rerender(<TierConfetti burst={{ stamp: "a:2", tier: "tier1" }} />);
    expect(getContext).toHaveBeenCalledTimes(2);
    expect(container.querySelector("canvas")).not.toBeNull();
    unmount();
  });

  /**
   * On a stand-in context, with the frames run by hand: the loop runs until the last piece is
   * gone and asks for no frame after, a `null` burst leaves the one in the air alone, a new stamp
   * starts over, and unmounting stops it.
   */
  it("runs its loop once per stamp, to the burst's end, and stops it on unmount", () => {
    hasABox();
    const gradient = { addColorStop: vi.fn() };
    const ctx = {
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      createRadialGradient: vi.fn(() => gradient),
      createLinearGradient: vi.fn(() => gradient),
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      fillStyle: "",
    };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as unknown as CanvasRenderingContext2D,
    );
    // jsdom loads no stylesheet, so the palette's tokens are given.
    vi.spyOn(window, "getComputedStyle").mockReturnValue({
      getPropertyValue: () => "#c9a64b",
    } as unknown as CSSStyleDeclaration);
    let frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const tick = (now: number) => {
      const due = frames;
      frames = [];
      for (const callback of due) callback(now);
    };
    const box = { width: 640, height: 600, originX: 320, originY: 536 };
    const end = confettiEnd("jackpot", confettiPieces("jackpot", box, confettiSeed(JACKPOT.stamp)));

    const { rerender, unmount } = render(<TierConfetti burst={JACKPOT} />);
    expect(frames).toHaveLength(1);
    tick(1_000);
    expect(ctx.fillRect).toHaveBeenCalled();
    expect(frames).toHaveLength(1);

    // The page puts the popup away; the jackpot keeps raining.
    rerender(<TierConfetti burst={null} />);
    expect(cancel).not.toHaveBeenCalled();
    tick(1_000 + end / 2);
    expect(frames).toHaveLength(1);

    // Past the last piece: the frame clears and asks for no other.
    ctx.fillRect.mockClear();
    tick(1_000 + end + 1);
    expect(frames).toHaveLength(0);
    expect(ctx.fillRect).not.toHaveBeenCalled();

    rerender(<TierConfetti burst={{ stamp: "a:2", tier: "tier1" }} />);
    expect(frames).toHaveLength(1);
    // A new stamp mid-flight stops the burst in the air before throwing its own.
    cancel.mockClear();
    rerender(<TierConfetti burst={{ stamp: "a:3", tier: "tier3" }} />);
    expect(cancel).toHaveBeenCalledTimes(1);
    unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
