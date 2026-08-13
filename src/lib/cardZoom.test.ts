import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ZOOM,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  formatZoom,
  scaled,
  stepZoom,
} from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";

describe("the zoom ladder", () => {
  it("climbs and descends one stop at a time", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.9, -1)).toBe(0.75);
  });

  /**
   * Every stop reachable from every other with nothing skipped, and — the half a spot-check
   * misses — the values arriving back *identical* rather than 0.6700000000000001. `toEqual`
   * against the ladder itself is what pins that.
   */
  it("walks the whole ladder and back without drifting off it", () => {
    const walk = (from: number, direction: 1 | -1) => {
      const seen = [from];
      let zoom = from;
      while (seen.length < ZOOM_STEPS.length) {
        zoom = stepZoom(zoom, direction);
        seen.push(zoom);
      }
      return seen;
    };

    expect(walk(MIN_ZOOM, 1)).toEqual([...ZOOM_STEPS]);
    expect(walk(MAX_ZOOM, -1)).toEqual([...ZOOM_STEPS].reverse());
  });

  /**
   * The clamp is "the same value back", not a wrap and not a refusal — a reader who keeps
   * scrolling at the top of the ladder must not find themselves at 50%.
   */
  it("stops at both ends rather than wrapping", () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(stepZoom(MAX_ZOOM, 1), 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(stepZoom(MIN_ZOOM, -1), -1)).toBe(MIN_ZOOM);
  });

  /** And the far end is still one step away from a limit. */
  it("leaves a limit in the other direction", () => {
    expect(stepZoom(MAX_ZOOM, -1)).toBe(1.75);
    expect(stepZoom(MIN_ZOOM, 1)).toBe(0.67);
  });

  /**
   * An off-ladder value has to land somewhere before it can step, and the honest reading of
   * "next stop up from 1.05" is 1.1. A tie goes to the lower stop, so a value exactly between
   * two of them steps the way it was asked to and not back to where it already was.
   */
  it("snaps an off-ladder value to the nearest stop first", () => {
    // 1.05 sits exactly halfway between 1 and 1.1: the lower stop wins the tie, so a step up
    // lands on 1.1 rather than on the 1 the reader was effectively already at.
    expect(stepZoom(1.05, 1)).toBe(1.1);
    expect(stepZoom(1.05, -1)).toBe(0.9);
    expect(stepZoom(1.3, 1)).toBe(1.5);
    expect(stepZoom(1.3, -1)).toBe(1.1);
    // Below the bottom of the ladder — snapped onto it, then clamped there.
    expect(stepZoom(0.1, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(0.1, 1)).toBe(0.67);
    expect(stepZoom(9, 1)).toBe(MAX_ZOOM);
  });

  it("keeps its limits and its default on the ladder", () => {
    expect(MIN_ZOOM).toBe(0.5);
    expect(MAX_ZOOM).toBe(2);
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });
});

/**
 * The two stops that are not round in binary. 0.67 × 100 is 67.00000000000001 and 0.9 × 100 is
 * 90.00000000000001 — printed raw, a fifth of the ladder would show a badge fourteen digits wide.
 */
describe("formatZoom", () => {
  it("prints whole percentages, decimals and all", () => {
    expect(formatZoom(0.67)).toBe("67%");
    expect(formatZoom(0.9)).toBe("90%");
    expect(formatZoom(1)).toBe("100%");
    expect(formatZoom(1.25)).toBe("125%");
    expect(formatZoom(2)).toBe("200%");
  });

  it("has no decimal point anywhere on the ladder", () => {
    for (const step of ZOOM_STEPS) expect(formatZoom(step)).toMatch(/^\d+%$/);
  });
});

/**
 * These numbers become grid track widths and image box heights, and a fractional one is a seam:
 * the browser snaps each painted edge on its own, so a column of 212.5px tiles alternates 212 and
 * 213 down the page.
 */
describe("scaled", () => {
  it("rounds to a whole pixel", () => {
    expect(scaled(170, 1.25)).toBe(213);
    expect(scaled(170, 0.67)).toBe(114);
    expect(scaled(170, 1)).toBe(170);
    expect(scaled(238, 1.1)).toBe(262);
  });

  it("never leaves a fraction anywhere on the ladder", () => {
    for (const step of ZOOM_STEPS) expect(Number.isInteger(scaled(170, step))).toBe(true);
  });
});

describe("the zoom the store keeps", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  it("starts at the default, unpulsed", () => {
    expect(useAppStore.getState().cardZoom).toBe(DEFAULT_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(0);
  });

  it("steps the ladder in both directions", () => {
    useAppStore.getState().zoomCards(1);
    expect(useAppStore.getState().cardZoom).toBe(1.1);

    useAppStore.getState().zoomCards(-1);
    useAppStore.getState().zoomCards(-1);
    expect(useAppStore.getState().cardZoom).toBe(0.9);
  });

  /**
   * The reason `zoomPulse` is a field at all. The badge's visibility timer keys off it, and at
   * either end of the ladder every further gesture leaves `cardZoom` identical — so a badge
   * watching the value would fade out under the reader's fingers at exactly the moment they are
   * still asking for more, reading as the app having stopped listening.
   */
  it("pulses on every gesture, including the ones the clamp swallows", () => {
    useAppStore.setState({ cardZoom: MAX_ZOOM });
    const before = useAppStore.getState().zoomPulse;

    useAppStore.getState().zoomCards(1);
    useAppStore.getState().zoomCards(1);
    useAppStore.getState().zoomCards(1);

    expect(useAppStore.getState().cardZoom).toBe(MAX_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(before + 3);
  });

  it("pulses at the bottom of the ladder too", () => {
    useAppStore.setState({ cardZoom: MIN_ZOOM });

    useAppStore.getState().zoomCards(-1);

    expect(useAppStore.getState().cardZoom).toBe(MIN_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(1);
  });

  /** A subscriber sees the clamped gesture, because the pulse moved even though the zoom did not. */
  it("notifies subscribers on a gesture that changed no zoom", () => {
    useAppStore.setState({ cardZoom: MAX_ZOOM });
    let seen = 0;
    const stop = useAppStore.subscribe(() => void seen++);

    useAppStore.getState().zoomCards(1);
    stop();

    expect(seen).toBe(1);
  });

  /** Zoom is about how cards are read, not about which list is open — it survives the trip. */
  it("survives a change of view and of layout", () => {
    useAppStore.getState().zoomCards(1);

    useAppStore.getState().setActiveView("collection");
    useAppStore.getState().setCollectionView("grid");

    expect(useAppStore.getState().cardZoom).toBe(1.1);
  });
});
