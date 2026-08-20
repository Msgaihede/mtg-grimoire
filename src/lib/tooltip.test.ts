import { describe, expect, it } from "vitest";
import { placeTooltip, TOOLTIP_EDGE_GUTTER, TOOLTIP_GAP, type AnchorRect } from "./tooltip";

/**
 * The placement is arithmetic on purpose, for `shouldFlipUp`'s stated reason: jsdom lays nothing
 * out, so every rectangle a *component* test could read is zero and a test of a rendered tooltip
 * would pass over any decision at all. These hand it rectangles.
 */
const VIEW = { width: 1280, height: 800 };

/** A 40×20 control in the middle of the window. */
const middle: AnchorRect = { left: 600, right: 640, top: 400, bottom: 420, width: 40, height: 20 };
const size = { width: 200, height: 40 };

describe("placeTooltip", () => {
  it("puts a top-side panel above the anchor, centred, growing from its bottom edge", () => {
    expect(placeTooltip(middle, size, "top", VIEW)).toEqual({
      // 400 − 8 gap − 40 tall
      top: 352,
      // centre 620, minus half of 200
      left: 520,
      origin: "origin-bottom",
    });
  });

  it("puts a bottom-side panel below the anchor, growing from its top edge", () => {
    expect(placeTooltip(middle, size, "bottom", VIEW)).toEqual({
      top: 428,
      left: 520,
      origin: "origin-top",
    });
  });

  it("flips a top-side panel down when there is no room above", () => {
    const high: AnchorRect = { left: 600, right: 640, top: 10, bottom: 30, width: 40, height: 20 };
    expect(placeTooltip(high, size, "top", VIEW)).toEqual({
      top: 38,
      left: 520,
      origin: "origin-top",
    });
  });

  it("keeps the preferred side when neither direction fits", () => {
    const tall = { width: 200, height: 780 };
    const high: AnchorRect = { left: 600, right: 640, top: 10, bottom: 30, width: 40, height: 20 };
    // Flipping a panel that does not fit either way only moves it; it opens where it was asked to.
    expect(placeTooltip(high, tall, "top", VIEW).origin).toBe("origin-bottom");
  });

  it("clamps a panel that would hang off the left of the window", () => {
    const left: AnchorRect = { left: 4, right: 24, top: 400, bottom: 420, width: 20, height: 20 };
    expect(placeTooltip(left, size, "top", VIEW).left).toBe(TOOLTIP_EDGE_GUTTER);
  });

  it("clamps a panel that would hang off the right of the window", () => {
    const right: AnchorRect = {
      left: 1250, right: 1276, top: 400, bottom: 420, width: 26, height: 20,
    };
    expect(placeTooltip(right, size, "top", VIEW).left).toBe(
      VIEW.width - size.width - TOOLTIP_EDGE_GUTTER,
    );
  });

  it("places a right-side panel beside the anchor, vertically centred", () => {
    expect(placeTooltip(middle, size, "right", VIEW)).toEqual({
      left: middle.right + TOOLTIP_GAP,
      // centre 410, minus half of 40
      top: 390,
      origin: "origin-left",
    });
  });

  it("flips a right-side panel to the left when the window edge is in the way", () => {
    const right: AnchorRect = {
      left: 1200, right: 1240, top: 400, bottom: 420, width: 40, height: 20,
    };
    expect(placeTooltip(right, size, "right", VIEW)).toEqual({
      left: 1200 - TOOLTIP_GAP - size.width,
      top: 390,
      origin: "origin-right",
    });
  });

  it("rounds to whole pixels, so text is never painted on a half pixel", () => {
    const odd: AnchorRect = { left: 600, right: 641, top: 400, bottom: 420, width: 41, height: 20 };
    const placed = placeTooltip(odd, size, "top", VIEW);
    expect(Number.isInteger(placed.left)).toBe(true);
    expect(Number.isInteger(placed.top)).toBe(true);
  });
});
