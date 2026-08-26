import { beforeEach, describe, expect, it } from "vitest";
import {
  CHIN_HEIGHT,
  CHIN_RISE,
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
  chinHeight,
  formatZoom,
  isZoomSection,
  scaled,
  snapZoom,
  stepZoom,
} from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";

describe("the zoom ladder", () => {
  it("climbs and descends one stop at a time", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1.1, 1)).toBe(1.2);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(0.9, -1)).toBe(0.8);
  });

  /**
   * Every stop reachable from every other with nothing skipped, and — the half a spot-check
   * misses — the values arriving back *identical* rather than 1.1000000000000001. `toEqual`
   * against the ladder itself is what pins that, and it is the assertion that would fail the day
   * somebody replaced the sixteen literals with a loop that adds 0.1.
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
    expect(stepZoom(MAX_ZOOM, -1)).toBe(1.9);
    expect(stepZoom(MIN_ZOOM, 1)).toBe(0.6);
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
    // 1.32 is not a stop: it snaps to 1.3 and steps from there, in whichever direction it
    // was asked for.
    expect(stepZoom(1.32, 1)).toBe(1.4);
    expect(stepZoom(1.32, -1)).toBe(1.2);
    // Below the bottom of the ladder — snapped onto it, then clamped there.
    expect(stepZoom(0.1, -1)).toBe(MIN_ZOOM);
    expect(stepZoom(0.1, 1)).toBe(0.6);
    expect(stepZoom(9, 1)).toBe(MAX_ZOOM);
  });

  it("keeps its limits and its default on the ladder", () => {
    expect(MIN_ZOOM).toBe(0.5);
    expect(MAX_ZOOM).toBe(2);
    expect(ZOOM_STEPS).toContain(DEFAULT_ZOOM);
  });

  /**
   * **The stops are evenly spaced ten points apart**, which is the whole of what changed on
   * 2026-08-22 and the one property a reader can feel: one notch of the wheel always means the
   * same amount, wherever on the ladder they are.
   *
   * `toBeCloseTo` rather than `toBe` because the *gaps* are floating-point subtractions of
   * literals — 1.1 − 1 is 0.10000000000000009 — while the stops themselves are exact. That
   * distinction is the point: what has to be identical is the value the store holds, not the
   * difference nothing ever stores.
   */
  it("spaces every stop ten points from the last", () => {
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i] - ZOOM_STEPS[i - 1]).toBeCloseTo(0.1, 10);
    }
  });
});

/**
 * The gate on anything read back out of storage — the row's keys are whatever some build of this
 * app wrote, so a section that has been renamed or dropped arrives as an ordinary string.
 */
describe("isZoomSection", () => {
  it("accepts every section and nothing else", () => {
    for (const section of ZOOM_SECTIONS) expect(isZoomSection(section)).toBe(true);
    for (const other of ["", " deck", "Deck", "eighthWall", "toString", "__proto__"]) {
      expect(isZoomSection(other)).toBe(false);
    }
  });
});

/**
 * `snapZoom` is what keeps the ladder's exactness true of a *restored* session. Nothing writes an
 * off-ladder value today, but three things can leave one in the row: a build whose ladder was
 * spaced differently, a hand-edited `mtg.db`, and Rust's own bound, which checks 0.5–2 and
 * deliberately does not know where the stops are.
 */
describe("snapZoom", () => {
  it("returns a stop untouched, by identity", () => {
    for (const step of ZOOM_STEPS) expect(snapZoom(step)).toBe(step);
  });

  it("pulls an off-ladder value onto the nearest stop", () => {
    expect(snapZoom(1.37)).toBe(1.4);
    expect(snapZoom(0.63)).toBe(0.6);
    // The stops the *old* ladder had and this one does not — the case a reader upgrading from a
    // build before 2026-08-22 actually meets. Two of the three sit exactly halfway between two
    // new stops, and the nearest-stop search gives a tie to the **lower** one — so a restored
    // 125% opens at 120% rather than 130%.
    expect(snapZoom(0.67)).toBe(0.7);
    expect(snapZoom(1.25)).toBe(1.2);
    expect(snapZoom(1.75)).toBe(1.7);
  });

  it("clamps a value from outside the ladder to its nearer end", () => {
    expect(snapZoom(0.01)).toBe(MIN_ZOOM);
    expect(snapZoom(40)).toBe(MAX_ZOOM);
  });

  /**
   * `NaN` compares false against everything, so `nearestIndex` would walk it straight to index 0
   * and hand a reader 50% tiles for a corrupt row. A value that is not a number has no nearest
   * stop and is not a zoom — the honest answer is the default.
   */
  it("answers the default for anything that is not a finite number", () => {
    expect(snapZoom(NaN)).toBe(DEFAULT_ZOOM);
    expect(snapZoom(Infinity)).toBe(DEFAULT_ZOOM);
    expect(snapZoom(-Infinity)).toBe(DEFAULT_ZOOM);
  });
});

/**
 * The stop that is not round in binary: 1.1 × 100 is 110.00000000000001, so printed raw that one
 * rung of the ladder would show a badge fourteen digits wide. The sweep below is what says the
 * other fifteen are covered too, rather than a spot-check that happens to pick the exact ones.
 */
describe("formatZoom", () => {
  it("prints whole percentages, decimals and all", () => {
    expect(formatZoom(0.6)).toBe("60%");
    expect(formatZoom(0.9)).toBe("90%");
    expect(formatZoom(1)).toBe("100%");
    // The one that drifts — 110.00000000000001 without the rounding.
    expect(formatZoom(1.1)).toBe("110%");
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
    expect(scaled(170, 1.2)).toBe(204);
    expect(scaled(170, 0.6)).toBe(102);
    expect(scaled(170, 1)).toBe(170);
    expect(scaled(238, 1.1)).toBe(262);
  });

  it("never leaves a fraction anywhere on the ladder", () => {
    for (const step of ZOOM_STEPS) expect(Number.isInteger(scaled(170, step))).toBe(true);
  });
});

describe("the chin", () => {
  /**
   * The chin moves with the card in **both** directions, and it is the same sum on all three
   * surfaces that draw one. It floored on two of them and the floor's failure mode has swapped
   * ends: 28px of empty felt under a 105px card.
   */
  it("scales the chin with the card, with no floor", () => {
    expect(chinHeight(DEFAULT_ZOOM)).toBe(CHIN_HEIGHT);
    for (const step of ZOOM_STEPS) {
      expect(chinHeight(step)).toBe(scaled(CHIN_HEIGHT, step));
    }
    expect(chinHeight(0.5)).toBeLessThan(CHIN_HEIGHT);
  });

  /**
   * The rise does **not** scale, because the thing it is derived from does not: it is a Tailwind
   * `rounded-[7px]` corner less its own 1px border, and that corner is 7px at every zoom. A rise
   * that scaled would clear the seam at 1× and show two hairlines of background at 0.5×.
   */
  it("holds the rise still at every zoom", () => {
    expect(CHIN_RISE).toBe(4);
    // **The rise is subtracted from a scaled height, never scaled with it**, which is the one
    // thing about this pair a future tidy-up could quietly break: folding the subtraction inside
    // `scaled` reads as the same sum and is not. At 1× the two agree — which is why 1× cannot be
    // the test — and everywhere else they differ by exactly the amount the seam would open by.
    for (const step of [0.5, 2]) {
      expect(chinHeight(step) - CHIN_RISE).not.toBe(scaled(CHIN_HEIGHT - CHIN_RISE, step));
    }
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

    expect(useAppStore.getState().cardZoom.search).toBe(1.2);
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

  /**
   * The second door onto `cardZoom`, and it has to hold the same guarantee the first one does —
   * the store only ever holds one of the sixteen exact stops, whatever a stored row says.
   */
  describe("hydrating from what was stored", () => {
    it("seeds the sections the row names and leaves the rest at their default", () => {
      useAppStore.getState().hydrateCardZoom({ deck: 0.7, printings: 1.8 });

      expect(useAppStore.getState().cardZoom).toEqual({
        ...DEFAULT_SECTION_ZOOMS,
        deck: 0.7,
        printings: 1.8,
      });
    });

    it("snaps an off-ladder value and drops a key that is not a section", () => {
      useAppStore.getState().hydrateCardZoom({ deck: 1.37, eighthWall: 1.5, "": 2 });

      expect(useAppStore.getState().cardZoom).toEqual({ ...DEFAULT_SECTION_ZOOMS, deck: 1.4 });
    });

    /** A restored size is not a gesture: raising the badge here would greet every launch with a
     *  percentage floating over a wall nobody touched. */
    it("pulses nothing and aims nothing", () => {
      useAppStore.getState().hydrateCardZoom({ search: 1.5 });

      expect(useAppStore.getState().cardZoom.search).toBe(1.5);
      expect(useAppStore.getState().zoomPulse).toBe(0);
      expect(useAppStore.getState().zoomSection).toBeNull();
    });

    /**
     * The read is a round trip, so a reader can zoom inside it — and their gesture is the newer
     * fact. Without this the wall would snap back to last session's size under their hand.
     */
    it("gives way entirely to a gesture already made", () => {
      useAppStore.getState().zoomCards("search", 1);

      useAppStore.getState().hydrateCardZoom({ search: 0.5, deck: 0.5 });

      expect(useAppStore.getState().cardZoom.search).toBe(1.1);
      expect(useAppStore.getState().cardZoom.deck).toBe(DEFAULT_ZOOM);
    });
  });

  /** Zoom is about how cards are read, not about which list is open — it survives the trip. */
  it("survives a change of view and of layout", () => {
    useAppStore.getState().zoomCards("collection", 1);

    useAppStore.getState().setActiveView("collection");
    useAppStore.getState().setCollectionView("grid");

    expect(useAppStore.getState().cardZoom.collection).toBe(1.1);
  });
});
