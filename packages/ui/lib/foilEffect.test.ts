import { describe, expect, it } from "vitest";
import {
  FOIL_EFFECTS,
  FOIL_PATTERN_LAYERS,
  FOIL_REST,
  foilEffect,
  foilLight,
  foilLightFrom,
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

describe("foilLight", () => {
  it("places a resting light at the rest point", () => {
    const rest = foilLight(FOIL_REST.x, FOIL_REST.y);
    expect(rest["--foil-px"]).toBe("0.320");
    expect(rest["--foil-my"]).toBe("28.0%");
  });

  /** The owner's call: "put it at full strength even when not hovered". */
  it("is at full strength wherever it is, resting or not", () => {
    expect(foilLight(FOIL_REST.x, FOIL_REST.y)["--foil-on"]).toBe("1");
    expect(foilLight(0.75, 0.5)["--foil-on"]).toBe("1");
    expect(foilLight(0.75, 0.5)["--foil-mx"]).toBe("75.0%");
  });

  /**
   * Ripple's camera-obscura: each of its three circle sets is the strongest one exactly when the
   * light is near its own spot, so moving the light fades one set out and another in.
   */
  it.each([
    [0.22, 0.25, "--foil-wa"],
    [0.8, 0.4, "--foil-wb"],
    [0.4, 0.85, "--foil-wc"],
  ])("makes one ripple set the strongest with the light at (%s, %s)", (x, y, strongest) => {
    const light = foilLight(x, y);
    const weights = ["--foil-wa", "--foil-wb", "--foil-wc"].map((k) => Number(light[k]));
    const top = Math.max(...weights);
    expect(Number(light[strongest])).toBe(top);
    // And the others have faded well down, rather than all three showing at once.
    for (const w of weights) if (w !== top) expect(w).toBeLessThan(top / 2);
  });
});

/**
 * The owner's call: "the foils should react to the cursor moving anywhere in the window, not just
 * when hovering the card".
 */
describe("foilLightFrom", () => {
  const VIEW = { width: 1600, height: 900 };
  const BOX = { left: 700, top: 300, width: 200, height: 280 };
  const at = (x: number, y: number) => {
    const light = foilLightFrom({ x, y }, BOX, VIEW);
    return [Number(light["--foil-px"]), Number(light["--foil-py"])];
  };

  it("centres the light under a pointer at the card's middle", () => {
    expect(at(800, 440)).toEqual([0.5, 0.5]);
  });

  it("turns the light toward a pointer far from the card, without pinning it to the edge", () => {
    const [left] = at(0, 440);
    const [right] = at(1600, 440);
    expect(left).toBeLessThan(0.1);
    expect(right).toBeGreaterThan(0.9);
    // Never quite at the edge, so the far side of the window still moves it.
    expect(right).toBeLessThan(1);
    const [nearer] = at(1300, 440);
    expect(nearer).toBeLessThan(right);
  });

  it("moves the light up and across alike for the same distance", () => {
    const [x] = at(800 + 300, 440);
    const [, y] = at(800, 440 + 300);
    expect(x).toBe(y);
  });

  it("moves the light a little as the pointer crosses the card itself", () => {
    const [left] = at(700, 440);
    const [right] = at(900, 440);
    expect(right - left).toBeGreaterThan(0.15);
    expect(right - left).toBeLessThan(0.4);
  });
});
