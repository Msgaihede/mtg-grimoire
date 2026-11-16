import { describe, expect, it } from "vitest";
import {
  FOIL_ANGLE,
  FOIL_EFFECTS,
  FOIL_HOVER,
  FOIL_IDLE,
  FOIL_IDLE_STEP,
  FOIL_PATTERN_LAYERS,
  FOIL_REST,
  FOIL_STRENGTH,
  RIPPLE_RINGS,
  RIPPLE_SHOWN,
  foilAim,
  foilCard,
  foilEffect,
  foilLight,
  foilPointer,
  rippleRings,
} from "./foilEffect";
import { finishTreatments } from "./treatment";

/** A copy in `finish` of a printing whose `promo_types` are `promo`, as every caller derives it. */
const effectOf = (finish: "foil" | "etched" | "nonfoil" | null, promo: string[]) =>
  foilEffect(finish, finishTreatments(JSON.stringify(promo), finish));

describe("foilEffect", () => {
  /** The rule `FoilOverlay` always had: the regular copy, and no finish at all, draw nothing. */
  it("draws nothing for a plain copy or an unknown finish", () => {
    expect(foilEffect("nonfoil")).toBeNull();
    expect(foilEffect(null)).toBeNull();
    // Even on a printing whose foil copy is a Surge Foil — the plain copy of it is plain.
    expect(effectOf("nonfoil", ["surgefoil"])).toBeNull();
  });

  it("draws an ordinary foil as traditional foil", () => {
    expect(foilEffect("foil")).toBe("foil");
    expect(effectOf("foil", ["boosterfun"])).toBe("foil");
  });

  /**
   * The case that started this: a printing sold plain and in a special foil is photographed
   * plain, so the foil copy has to be drawn as its kind or it looks like any other foil.
   */
  it.each([
    [["surgefoil", "universesbeyond"], "surge"],
    [["silverfoil", "scroll", "universesbeyond", "boosterfun"], "silver"],
    [["ripplefoil"], "ripple"],
    [["manafoil"], "mana"],
    [["galaxyfoil", "boosterfun"], "galaxy"],
    [["rainbowfoil"], "rainbow"],
    [["doublerainbow", "serialized"], "doublerainbow"],
    [["halofoil"], "halo"],
    [["textured"], "textured"],
    [["confettifoil"], "confetti"],
    [["fracturefoil"], "fracture"],
  ] as const)("draws a foil copy carrying %j as %s", (promo, drawn) => {
    expect(effectOf("foil", [...promo])).toBe(drawn);
  });

  /** A named foil with no drawing of its own is still foil, drawn the traditional way. */
  it("falls back to traditional foil for a named foil it has no drawing for", () => {
    expect(effectOf("foil", ["firstplacefoil"])).toBe("foil");
    expect(effectOf("foil", ["oilslick", "raisedfoil"])).toBe("foil");
  });

  /** Etched is a finish and its look is the process's, whatever else the printing is called. */
  it("draws an etched copy as etched, whatever its promo types", () => {
    expect(foilEffect("etched")).toBe("etched");
    expect(effectOf("etched", ["surgefoil"])).toBe("etched");
  });

  /** Every drawing says how many pattern layers it mounts — the overlay reads nothing else. */
  it("knows the layer count of every drawing", () => {
    expect(Object.keys(FOIL_PATTERN_LAYERS).sort()).toEqual([...FOIL_EFFECTS].sort());
  });
});

/** A card at the plain constants: the shared rest, the shared angle. */
const PLAIN = { angle: FOIL_ANGLE, ox: 0, oy: 0 };
const VIEW = { width: 1600, height: 900 };
const BOX = { left: 700, top: 300, width: 200, height: 280 };

/**
 * The owner's call on the design canvas: "all the foil sheens go in the same direction, and move
 * at the same rate… across a whole card wall" — so each card is its own foil.
 */
describe("foilCard", () => {
  it("is the same card every time it is asked", () => {
    expect(foilCard("dmr-45")).toEqual(foilCard("dmr-45"));
  });

  it("turns each card's sweep up to 9° either way and rests its light up to 0.08 off", () => {
    const cards = Array.from({ length: 200 }, (_, i) => foilCard(`card-${i}`));
    for (const c of cards) {
      expect(Math.abs(c.angle - FOIL_ANGLE)).toBeLessThanOrEqual(9);
      expect(Math.abs(c.ox)).toBeLessThanOrEqual(0.08);
      expect(Math.abs(c.oy)).toBeLessThanOrEqual(0.08);
    }
    // And they really are spread, not all the same card.
    const angles = cards.map((c) => c.angle);
    expect(Math.max(...angles) - Math.min(...angles)).toBeGreaterThan(14);
  });
});

/**
 * The light does not follow the pointer (the owner: following it "ends up looking like a torch").
 * Every card drifts a little with the pointer's place in the window; the card it is on moves more.
 */
describe("foilAim", () => {
  const off = (x: number, y: number) => foilAim(foilPointer({ x, y }, BOX, VIEW, false), PLAIN);
  const on = (x: number, y: number) => foilAim(foilPointer({ x, y }, BOX, VIEW, true), PLAIN);

  it("rests at the card's own resting light with no pointer", () => {
    expect(foilAim(null, PLAIN)).toEqual(FOIL_REST);
    expect(foilAim(null, { angle: 110, ox: 0.05, oy: -0.02 })).toEqual({ x: 0.37, y: 0.26 });
  });

  it("drifts a card the pointer is not on by a fifth of it across the whole window, mirrored", () => {
    const left = off(0, 450);
    const right = off(1600, 450);
    expect(left.x - right.x).toBeCloseTo(FOIL_IDLE, 2);
    expect(left.y).toBe(right.y);
  });

  it("moves an idle card's light in steps of about a pixel", () => {
    const { x, y } = off(523, 211);
    expect(Math.abs(x / FOIL_IDLE_STEP - Math.round(x / FOIL_IDLE_STEP))).toBeLessThan(1e-9);
    expect(Math.abs(y / FOIL_IDLE_STEP - Math.round(y / FOIL_IDLE_STEP))).toBeLessThan(1e-9);
  });

  it("moves the card the pointer is on across most of itself, mirrored", () => {
    const nearLeft = on(700 + 0.2 * 200, 440);
    const nearRight = on(700 + 0.8 * 200, 440);
    // 0.6 of the card crossed at 0.9 of a card per card: 0.54.
    expect(nearLeft.x - nearRight.x).toBeCloseTo(FOIL_HOVER * 0.6, 2);
  });

  /** Arriving on a card blends in over its outer edge, so its light never snaps across. */
  it("does not jump when the pointer crosses onto the card", () => {
    const outside = off(699, 440);
    const edge = on(700, 440);
    expect(Math.abs(edge.x - outside.x)).toBeLessThan(0.01);
    expect(foilPointer({ x: 700, y: 440 }, BOX, VIEW, true).hover).toBe(0);
    expect(foilPointer({ x: 800, y: 440 }, BOX, VIEW, true).hover).toBe(1);
  });

  /** In the deck's stacks the pointer is inside nine boxes; only the card on top is hovered. */
  it("treats a card the pointer is inside but not on as idle", () => {
    expect(foilPointer({ x: 800, y: 440 }, BOX, VIEW, false).hover).toBe(0);
  });
});

/** Issue #1689: "about half as many circles, which grow/shrink and gradually fade". */
describe("rippleRings", () => {
  it("has nine rings and shows five of them", () => {
    expect(RIPPLE_RINGS).toHaveLength(9);
    expect(RIPPLE_SHOWN).toBe(5);
    for (const [x, y] of [
      [0.32, 0.28],
      [0.5, 0.5],
      [0.8, 0.9],
    ]) {
      const shown = rippleRings(x, y).filter((r) => r.show > 0.5);
      expect(shown.length).toBeGreaterThanOrEqual(4);
      expect(shown.length).toBeLessThanOrEqual(6);
    }
  });

  it("grows and shrinks each ring between 0.7 and 1.3 of its size, never moving it", () => {
    for (let x = 0; x <= 1; x += 0.25)
      for (let y = 0; y <= 1; y += 0.25)
        for (const { grow } of rippleRings(x, y)) {
          expect(grow).toBeGreaterThanOrEqual(0.7);
          expect(grow).toBeLessThanOrEqual(1.3);
        }
  });
});

describe("foilLight", () => {
  /** Issue #1689: "all foils are too blown out". */
  it("draws every foil at the approved strength", () => {
    expect(foilLight(FOIL_REST, PLAIN)["--foil-on"]).toBe(String(FOIL_STRENGTH));
    expect(FOIL_STRENGTH).toBe(0.6);
  });

  it("places the light, turns the sweep, and puts the band where the light is along it", () => {
    const light = foilLight({ x: 0.75, y: 0.5 }, { angle: 110, ox: 0, oy: 0 });
    expect(light["--foil-mx"]).toBe("75.0%");
    expect(light["--foil-angle"]).toBe("110.0deg");
    // Centred light: the band is mid-sweep; further along the sweep, further along.
    expect(foilLight({ x: 0.5, y: 0.5 }, PLAIN)["--foil-at"]).toBe("50.0%");
    expect(Number.parseFloat(light["--foil-at"])).toBeGreaterThan(50);
  });

  it("writes ripple's rings only for a ripple", () => {
    expect(foilLight(FOIL_REST, PLAIN)["--foil-g1"]).toBeUndefined();
    const ripple = foilLight(FOIL_REST, PLAIN, "live");
    expect(Object.keys(ripple).filter((k) => /^--foil-[gs]\d$/.test(k))).toHaveLength(18);
  });

  /** An idle ripple keeps its resting rings, so a deck of them is not a hundred fades. */
  it("shows an idle ripple's resting rings wherever its light is", () => {
    const shown = (light: Record<string, string>) =>
      Object.entries(light).filter(([k]) => k.startsWith("--foil-s"));
    const rest = foilLight(FOIL_REST, PLAIN, "rest");
    const moved = foilLight({ x: 0.9, y: 0.9 }, PLAIN, "rest");
    expect(shown(moved)).toEqual(shown(rest));
    expect(shown(foilLight({ x: 0.9, y: 0.9 }, PLAIN, "live"))).not.toEqual(shown(rest));
  });
});
