import { describe, expect, it } from "vitest";
import { FOIL_EFFECTS, FOIL_PATTERN_LAYERS, FOIL_REST, foilEffect, foilLight } from "./foilEffect";
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
  it("places a resting light at the rest point, at the resting strength", () => {
    const rest = foilLight(FOIL_REST.x, FOIL_REST.y, false);
    expect(rest["--foil-px"]).toBe("0.320");
    expect(rest["--foil-my"]).toBe("28.0%");
    expect(rest["--foil-on"]).toBe("0.55");
  });

  it("brings the light up to full strength under a pointer", () => {
    const lit = foilLight(0.75, 0.5, true);
    expect(lit["--foil-mx"]).toBe("75.0%");
    expect(lit["--foil-on"]).toBe("1");
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
    const light = foilLight(x, y, true);
    const weights = ["--foil-wa", "--foil-wb", "--foil-wc"].map((k) => Number(light[k]));
    const top = Math.max(...weights);
    expect(Number(light[strongest])).toBe(top);
    // And the others have faded well down, rather than all three showing at once.
    for (const w of weights) if (w !== top) expect(w).toBeLessThan(top / 2);
  });
});
