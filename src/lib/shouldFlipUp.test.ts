import { describe, expect, it } from "vitest";
import { shouldFlipUp } from "./shouldFlipUp";

/**
 * The flip is arithmetic on purpose: jsdom lays nothing out, so every rectangle a component
 * test could read is zero and a test of a *rendered* anchored layer would pass over any
 * decision at all. Both callers clip — the card pane's printings scroller and, while it
 * existed, the deck editor's category column — and there is nothing under a clipped edge to
 * scroll to.
 *
 * These cases came here from `ZoneColumn.test.tsx`, which the deck builder rebuild retired.
 * They are the only tests this module has, and it is still live: `PrintingPreview` places its
 * hover preview with it.
 */
describe("shouldFlipUp", () => {
  /** A row at the top of a scroller: the layer fits below it, so it opens where the reader is
   *  looking. */
  it("opens downwards while there is room", () => {
    expect(
      shouldFlipUp({ rowTop: 100, rowBottom: 140, menuHeight: 140, viewTop: 90, viewBottom: 600 }),
    ).toBe(false);
  });

  /** A row near the foot of it: opening down would put half the layer past the clipped edge. */
  it("opens upwards when the layer would run out of the bottom", () => {
    expect(
      shouldFlipUp({ rowTop: 520, rowBottom: 560, menuHeight: 140, viewTop: 90, viewBottom: 600 }),
    ).toBe(true);
  });

  /** A layer taller than the box it is in fits neither way, so it opens the way it reads —
   *  flipping would move it without gaining anything. */
  it("stays downwards when neither direction fits", () => {
    expect(
      shouldFlipUp({ rowTop: 150, rowBottom: 190, menuHeight: 300, viewTop: 100, viewBottom: 260 }),
    ).toBe(false);
  });

  /** Exactly enough room is room. */
  it("does not flip on a layer that fits to the pixel", () => {
    expect(
      shouldFlipUp({ rowTop: 460, rowBottom: 500, menuHeight: 140, viewTop: 90, viewBottom: 600 }),
    ).toBe(false);
  });
});
