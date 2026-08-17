import { beforeEach, describe, expect, it } from "vitest";
import {
  CONTROL_SCALE_VAR,
  CONTROL_SHRINK,
  DEFAULT_SECTION_ZOOMS,
  DEFAULT_ZOOM,
  MARK_SCALE_VAR,
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_SECTIONS,
  ZOOM_STEPS,
  cardScaleVars,
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

/**
 * The two variables a card publishes for the marks drawn on it.
 *
 * There is nothing else in this repo that can check them. The values only mean anything to a
 * browser resolving `calc()` against an inherited custom property, and **jsdom has no layout engine
 * at all** — a test can see that the tile set `--mark-scale: 2`, and cannot see that the crown in
 * its corner came out 24px. So what is pinned here is the arithmetic and the *pairing*: that the
 * control scale is the mark scale less its shrink, and that neither floors. The rest is a live
 * pass's to answer, and `docs/reference/frontend-design.md` carries what one found.
 */
describe("the card scale variables", () => {
  it("publishes the zoom itself, with no floor in either direction", () => {
    expect(cardScaleVars(1)[MARK_SCALE_VAR]).toBe("1");
    expect(cardScaleVars(2)[MARK_SCALE_VAR]).toBe("2");
    // **The half-size arm is the whole point of this test.** Every budget that holds a mark used
    // to floor at 1× — `CardGrid`'s caption, `GridView`'s foot, `stackAdvance`, `stackDataHeight`
    // — because the marks inside them could not shrink. They can now, and a floor reinstated here
    // would put the app back to a 28px strip around 6px of type.
    expect(cardScaleVars(MIN_ZOOM)[MARK_SCALE_VAR]).toBe(String(MIN_ZOOM));
    for (const step of ZOOM_STEPS) expect(cardScaleVars(step)[MARK_SCALE_VAR]).toBe(String(step));
  });

  it("draws a control on a card smaller than its panel twin, at every stop", () => {
    for (const step of ZOOM_STEPS) {
      const vars = cardScaleVars(step);
      expect(Number(vars[CONTROL_SCALE_VAR])).toBeCloseTo(step * CONTROL_SHRINK);
      // The pairing is the thing: a control and the mark beside it in one caption reading two
      // different zooms is the drift this function exists to make impossible.
      expect(Number(vars[CONTROL_SCALE_VAR])).toBeLessThan(Number(vars[MARK_SCALE_VAR]));
    }
  });

  it("names two different properties, so a mark and a control cannot be conflated", () => {
    expect(MARK_SCALE_VAR).not.toBe(CONTROL_SCALE_VAR);
    expect(Object.keys(cardScaleVars(1)).sort()).toEqual([CONTROL_SCALE_VAR, MARK_SCALE_VAR].sort());
  });
});

/**
 * `DEFAULT_SECTION_ZOOMS` is a spelled-out literal rather than a reduce over `ZOOM_SECTIONS`
 * precisely so that a new section cannot be added without somebody saying what it starts at. That
 * is a compile-time guarantee, and a compile-time guarantee is invisible to a green suite — this
 * is the runtime half of it, so a section added to the list and nowhere else fails here too.
 */
describe("the sections", () => {
  it("gives every section a default, and defaults nothing that is not a section", () => {
    expect(Object.keys(DEFAULT_SECTION_ZOOMS).sort()).toEqual([...ZOOM_SECTIONS].sort());
  });

  it("starts every section at the default zoom", () => {
    for (const section of ZOOM_SECTIONS) expect(DEFAULT_SECTION_ZOOMS[section]).toBe(DEFAULT_ZOOM);
  });
});

describe("the zoom the store keeps", () => {
  beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));

  /**
   * Asserted against `ZOOM_SECTIONS` rather than against four literals: a section added to the
   * list without a starting value fails here, which is the same failure the `Record` type is
   * there to raise at compile time.
   */
  it("starts every section at the default, unpulsed and unaimed", () => {
    for (const section of ZOOM_SECTIONS) {
      expect(useAppStore.getState().cardZoom[section]).toBe(DEFAULT_ZOOM);
    }
    expect(useAppStore.getState().zoomPulse).toBe(0);
    expect(useAppStore.getState().zoomSection).toBeNull();
  });

  it("steps the ladder in both directions", () => {
    useAppStore.getState().zoomCards("search", 1);
    expect(useAppStore.getState().cardZoom.search).toBe(1.1);

    useAppStore.getState().zoomCards("search", -1);
    useAppStore.getState().zoomCards("search", -1);
    expect(useAppStore.getState().cardZoom.search).toBe(0.9);
  });

  /**
   * The defect this whole shape exists to fix, stated as a test. The deck editor draws its docked
   * card search column *beside* the deck, so with one shared number a reader enlarging a search
   * result was enlarging the deck at the same time. Every section that was not named stays where
   * it was.
   */
  it("moves only the section it was given", () => {
    useAppStore.getState().zoomCards("search", 1);

    expect(useAppStore.getState().cardZoom.search).toBe(1.1);
    for (const section of ZOOM_SECTIONS) {
      if (section === "search") continue;
      expect(useAppStore.getState().cardZoom[section]).toBe(DEFAULT_ZOOM);
    }
  });

  /** And each one keeps its own history, so returning to a section returns to its size. */
  it("keeps a separate value per section", () => {
    useAppStore.getState().zoomCards("search", 1);
    useAppStore.getState().zoomCards("search", 1);
    useAppStore.getState().zoomCards("deck", -1);

    expect(useAppStore.getState().cardZoom.search).toBe(1.25);
    expect(useAppStore.getState().cardZoom.deck).toBe(0.9);
    expect(useAppStore.getState().cardZoom.deckSearch).toBe(DEFAULT_ZOOM);
    expect(useAppStore.getState().cardZoom.collection).toBe(DEFAULT_ZOOM);
  });

  /**
   * The badge draws itself over the section that was zoomed, so the store has to remember which
   * one that was — the pulse says *that* a gesture happened, this says *where*.
   */
  it("records the section the last gesture landed in", () => {
    useAppStore.getState().zoomCards("collection", 1);
    expect(useAppStore.getState().zoomSection).toBe("collection");

    useAppStore.getState().zoomCards("deckSearch", -1);
    expect(useAppStore.getState().zoomSection).toBe("deckSearch");
  });

  /**
   * The reason `zoomPulse` is a field at all. The badge's visibility timer keys off it, and at
   * either end of the ladder every further gesture leaves `cardZoom` identical — so a badge
   * watching the value would fade out under the reader's fingers at exactly the moment they are
   * still asking for more, reading as the app having stopped listening.
   */
  it("pulses on every gesture, including the ones the clamp swallows", () => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, search: MAX_ZOOM } });
    const before = useAppStore.getState().zoomPulse;

    useAppStore.getState().zoomCards("search", 1);
    useAppStore.getState().zoomCards("search", 1);
    useAppStore.getState().zoomCards("search", 1);

    expect(useAppStore.getState().cardZoom.search).toBe(MAX_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(before + 3);
  });

  /** A clamped gesture still aims the badge, or it would be left pointing at the previous one. */
  it("aims the badge on a gesture the clamp swallowed", () => {
    useAppStore.setState({
      cardZoom: { ...DEFAULT_SECTION_ZOOMS, deck: MAX_ZOOM },
      zoomSection: "search",
    });

    useAppStore.getState().zoomCards("deck", 1);

    expect(useAppStore.getState().cardZoom.deck).toBe(MAX_ZOOM);
    expect(useAppStore.getState().zoomSection).toBe("deck");
  });

  it("pulses at the bottom of the ladder too", () => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, collection: MIN_ZOOM } });

    useAppStore.getState().zoomCards("collection", -1);

    expect(useAppStore.getState().cardZoom.collection).toBe(MIN_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(1);
  });

  /** A subscriber sees the clamped gesture, because the pulse moved even though the zoom did not. */
  it("notifies subscribers on a gesture that changed no zoom", () => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, search: MAX_ZOOM } });
    let seen = 0;
    const stop = useAppStore.subscribe(() => void seen++);

    useAppStore.getState().zoomCards("search", 1);
    stop();

    expect(seen).toBe(1);
  });

  /** Zoom is about how cards are read, not about which list is open — it survives the trip. */
  it("survives a change of view and of layout", () => {
    useAppStore.getState().zoomCards("collection", 1);

    useAppStore.getState().setActiveView("collection");
    useAppStore.getState().setCollectionView("grid");

    expect(useAppStore.getState().cardZoom.collection).toBe(1.1);
  });
});
