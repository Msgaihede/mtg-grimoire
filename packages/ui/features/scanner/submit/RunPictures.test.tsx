import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScannerSubmissionFrame } from "../types";

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

import { PLAY_STEP_MS, RunPictures } from "./RunPictures";

/** Six frames a hundred and ten milliseconds apart, the last ten before the press. */
const FRAMES: ScannerSubmissionFrame[] = ["AQ==", "Ag==", "Aw==", "BA==", "BQ==", "Bg=="].map(
  (jpeg, index, all) => ({
    jpeg,
    ms: -10 - (all.length - 1 - index) * 110,
    ok: true,
    lock: "locked",
    confidence: 1,
    distance: 30,
    decided: null,
    detail: false,
  }),
);
const LAST = FRAMES.length;

const url = (n: number) => `data:image/jpeg;base64,${FRAMES[n - 1].jpeg}`;
/** The one picture that is showing — the rest are `hidden`, and so out of the tree. */
const picture = () => screen.getByRole("img");
const slider = () => screen.getByRole("slider", { name: "Picture" });
const play = () => screen.getByRole("button", { name: "Play" });
/** Which picture is showing, by its place in the run. */
const showing = () => FRAMES.findIndex((one) => picture().getAttribute("src")?.endsWith(one.jpeg)) + 1;

/** One step of a pass on the fake clock, with React's queue drained after it. */
function step(times = 1) {
  act(() => {
    vi.advanceTimersByTime(PLAY_STEP_MS * times);
  });
}

beforeEach(() => {
  motionPref.reduced = false;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RunPictures", () => {
  /** The reader's answer names the card in the last picture, so that is the one it opens on. */
  it("rests on the last picture, out of the text that will be sent", () => {
    render(<RunPictures frames={FRAMES} />);
    expect(picture()).toHaveAttribute("src", url(LAST));
    expect(picture()).toHaveAttribute("alt", "Picture 6 of 6 that will be sent");
    expect(screen.getByText("Picture 6 of 6 · the moment you pressed")).toBeInTheDocument();
    // Never an object URL: the shipped policy allows no `blob:` picture on any host.
    expect(picture().getAttribute("src")).toMatch(/^data:image\/jpeg;base64,/);
  });

  /**
   * **Every picture is mounted, and one is shown** — so a step un-hides a picture the browser
   * already has rather than swapping an address under the one on screen. Each is decoded with the
   * paint that first shows it, which is what keeps that paint from being an empty box.
   */
  it("mounts every picture once and shows exactly one", () => {
    const { container } = render(<RunPictures frames={FRAMES} />);
    const all = Array.from(container.querySelectorAll("img"));
    expect(all.map((img) => img.getAttribute("src"))).toEqual(FRAMES.map((_, n) => url(n + 1)));
    expect(all.filter((img) => !img.hidden)).toHaveLength(1);
    expect(screen.getAllByRole("img")).toHaveLength(1);
    for (const img of all) expect(img).toHaveAttribute("decoding", "sync");

    // A step moves which one is shown, and replaces no element.
    fireEvent.change(slider(), { target: { value: "2" } });
    expect(Array.from(container.querySelectorAll("img"))).toEqual(all);
    expect(all.map((img) => img.hidden)).toEqual([true, false, true, true, true, true]);
  });

  it("walks every picture on the slider, with the picture and its line following", () => {
    render(<RunPictures frames={FRAMES} />);
    expect(slider()).toHaveAttribute("min", "1");
    expect(slider()).toHaveAttribute("max", String(LAST));
    expect(slider()).toHaveAttribute("step", "1");
    expect(slider()).toHaveValue(String(LAST));
    expect(slider()).toHaveAttribute("aria-valuetext", "Picture 6 of 6");

    for (let n = 1; n <= LAST; n++) {
      fireEvent.change(slider(), { target: { value: String(n) } });
      expect(picture()).toHaveAttribute("src", url(n));
      expect(picture()).toHaveAttribute("alt", `Picture ${n} of 6 that will be sent`);
      expect(slider()).toHaveAttribute("aria-valuetext", `Picture ${n} of 6`);
    }
    fireEvent.change(slider(), { target: { value: "1" } });
    expect(screen.getByText("Picture 1 of 6 · 0.6 s before you pressed")).toBeInTheDocument();
    fireEvent.change(slider(), { target: { value: "5" } });
    expect(screen.getByText("Picture 5 of 6 · 0.1 s before you pressed")).toBeInTheDocument();
  });

  /** A finger's size for the two controls, from the shared floor and never a pointer query. */
  it("gives the slider and the press the touch floor", () => {
    render(<RunPictures frames={FRAMES} />);
    expect(slider().classList.contains("coarse:min-h-[var(--target-min)]")).toBe(true);
    expect(play().classList.contains("coarse:min-h-[var(--target-min)]")).toBe(true);
  });

  it("plays nothing by itself", () => {
    render(<RunPictures frames={FRAMES} />);
    step(40);
    expect(showing()).toBe(LAST);
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * One pass: the first picture at the press, then one more each step, in order, and it stops on
   * the last — the press reads Play again and nothing is left ticking.
   */
  it("plays once from the first picture to the last, and stops there", () => {
    render(<RunPictures frames={FRAMES} />);
    fireEvent.click(play());
    expect(showing()).toBe(1);
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();

    const seen = [showing()];
    for (let n = 2; n <= LAST; n++) {
      step();
      seen.push(showing());
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
    expect(play()).toBeInTheDocument();
    expect(slider()).toHaveValue(String(LAST));
    expect(vi.getTimerCount()).toBe(0);

    // Never a loop: left alone for many passes' worth of time, it is where it stopped.
    step(60);
    expect(showing()).toBe(LAST);
    expect(play()).toBeInTheDocument();
  });

  it("stops where it is when pressed mid-pass", () => {
    render(<RunPictures frames={FRAMES} />);
    fireEvent.click(play());
    step(2);
    expect(showing()).toBe(3);

    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(play()).toBeInTheDocument();
    expect(vi.getTimerCount()).toBe(0);
    step(20);
    expect(showing()).toBe(3);

    // Pressed again, it starts over from the first rather than going on from the third.
    fireEvent.click(play());
    expect(showing()).toBe(1);
  });

  /** A hand on the slider is the reader choosing a picture: the pass ends there. */
  it("ends the pass when the slider is moved", () => {
    render(<RunPictures frames={FRAMES} />);
    fireEvent.click(play());
    step();
    fireEvent.change(slider(), { target: { value: "5" } });
    expect(showing()).toBe(5);
    expect(play()).toBeInTheDocument();
    step(20);
    expect(showing()).toBe(5);
  });

  /**
   * **A reader who asked for less motion is not offered the pass.** Pictures changing under a
   * timer is the motion they asked not to be shown; the slider reaches every one of them
   * without it.
   */
  it("offers no Play, and advances nothing, under reduced motion", () => {
    motionPref.reduced = true;
    render(<RunPictures frames={FRAMES} />);
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    step(40);
    expect(showing()).toBe(LAST);
    expect(vi.getTimerCount()).toBe(0);

    // The slider is the way through, and it is all there.
    fireEvent.change(slider(), { target: { value: "1" } });
    expect(picture()).toHaveAttribute("src", url(1));
    step(40);
    expect(showing()).toBe(1);
  });

  it("clears its timer when it is unmounted mid-pass", () => {
    const { unmount } = render(<RunPictures frames={FRAMES} />);
    fireEvent.click(play());
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("draws nothing for a run with no pictures in it", () => {
    const { container } = render(<RunPictures frames={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
