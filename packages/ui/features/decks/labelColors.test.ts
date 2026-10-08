import { describe, expect, it } from "vitest";
// `?raw`, like `lib/tokens.test.ts`'s own sweep of this file — there is no `node:fs` to reach
// for here, because `@types/node` is banned from this program on purpose.
import css from "@/index.css?raw";
import {
  DEFAULT_LABEL_COLOR,
  LABEL_COLORS,
  labelColorCss,
  labelColorHex,
  labelFgCss,
  LEGACY_TOKENS,
  normalizeLabelColor,
} from "./labelColors";

/**
 * The colour a label stores, and the three questions the rest of the app asks about one.
 *
 * **This file guards a storage-format change** (2026-08-20): `deck_labels.color` used to hold one
 * of six token words and now holds `#rrggbb`. The backend validates neither — it checks the
 * string is non-empty and stores it — so nothing but these functions and these tests stands
 * between a database written by one build and a screen drawn by another.
 */

describe("normalizeLabelColor", () => {
  it("takes a hex with or without the hash, and answers one shape", () => {
    expect(normalizeLabelColor("#d9b95c")).toBe("#d9b95c");
    expect(normalizeLabelColor("d9b95c")).toBe("#d9b95c");
    // Uppercase is what a reader pastes out of a design tool, and what the field itself draws.
    expect(normalizeLabelColor("#D9B95C")).toBe("#d9b95c");
    expect(normalizeLabelColor("  #d9b95c  ")).toBe("#d9b95c");
  });

  /** Three digits is a shape a reader typing by hand will try, and CSS's own shorthand. */
  it("expands the three-digit shorthand", () => {
    expect(normalizeLabelColor("#f00")).toBe("#ff0000");
    expect(normalizeLabelColor("abc")).toBe("#aabbcc");
  });

  /**
   * The six words a database older than this build still holds.
   *
   * **A read path only** — nothing writes a token any more — and it does not expire, because a
   * database is not migrated by a build being newer than it.
   */
  it("reads the six retired tokens", () => {
    expect(normalizeLabelColor("gold")).toBe("#d9b95c");
    expect(normalizeLabelColor("moss")).toBe("#00733e");
    expect(normalizeLabelColor("EMBER")).toBe("#d3202a");
    for (const [token, hex] of Object.entries(LEGACY_TOKENS)) {
      expect(normalizeLabelColor(token)).toBe(hex);
    }
  });

  /**
   * `null` for anything else — which is what lets the picker's hex field hold a half-typed
   * colour rather than snapping back on every keystroke. A field that could not sit in this
   * state would be untypeable: three characters into `d9b95c` there is nothing to normalise to.
   */
  it("answers null for anything that is not yet a colour", () => {
    expect(normalizeLabelColor("d9b")).toBe("#dd99bb"); // three digits *is* a colour
    expect(normalizeLabelColor("d9b9")).toBeNull();
    expect(normalizeLabelColor("")).toBeNull();
    expect(normalizeLabelColor("rebeccapurple")).toBeNull();
    expect(normalizeLabelColor("#zzzzzz")).toBeNull();
    expect(normalizeLabelColor(null)).toBeNull();
    expect(normalizeLabelColor(undefined)).toBeNull();
  });
});

describe("labelColorCss", () => {
  it("draws a stored colour, however it was stored", () => {
    expect(labelColorCss("#7b2d8e")).toBe("#7b2d8e");
    expect(labelColorCss("azure")).toBe("#0e68ab");
  });

  /**
   * A colour this build cannot read is the **default**, never nothing: a dot the reader cannot
   * see is a label the reader cannot find. The arm covers a token retired before
   * {@link LEGACY_TOKENS}, a truncated write, and a `null` column.
   */
  it("falls back to the default rather than to nothing", () => {
    expect(labelColorCss(null)).toBe(DEFAULT_LABEL_COLOR.hex);
    expect(labelColorCss("chartreuse")).toBe(DEFAULT_LABEL_COLOR.hex);
    expect(labelColorCss("")).toBe(DEFAULT_LABEL_COLOR.hex);
  });

  it("hands the picker's field six uppercase digits and no hash", () => {
    expect(labelColorHex("#7b2d8e")).toBe("7B2D8E");
    expect(labelColorHex("gold")).toBe("D9B95C");
  });
});

/**
 * What reads on a label's colour — the deck stack's quantity tag prints a copy count on one.
 *
 * **The six answers below are the specification, not a derivation.** They were a hand-made
 * column on each of the six palette rows until the colour became the reader's own and no table
 * could hold the answer in advance; the formula that replaced the column is the one those six
 * were built from. A "more correct" luminance curve that flips one of them is a regression on a
 * screen somebody looked at, which is why every one is pinned rather than a threshold sampled.
 */
describe("labelFgCss", () => {
  const DARK_TEXT = "var(--color-accent-fg)";
  const LIGHT_TEXT = "var(--color-text)";

  /** The six deeps the picker offered until 2026-09-28. They are no longer in its row, but every
   *  label picked before then still stores one, so these screens still exist. */
  it("keeps the six palette answers it inherited", () => {
    expect(labelFgCss("#d9b95c")).toBe(DARK_TEXT); // gold
    expect(labelFgCss("#f8e7b9")).toBe(DARK_TEXT); // bone
    expect(labelFgCss("#c8c4bf")).toBe(DARK_TEXT); // slate
    expect(labelFgCss("#0e68ab")).toBe(LIGHT_TEXT); // azure
    expect(labelFgCss("#d3202a")).toBe(LIGHT_TEXT); // ember
    expect(labelFgCss("#00733e")).toBe(LIGHT_TEXT); // moss
  });

  /** The mana colours are pale where three of the deeps were dark, so the count ink on Azure,
   *  Ember and Moss flipped to near-black — and the flip is the formula's to make, not a
   *  hand-kept column's. Light text on any of these reads 1.2–1.5:1. */
  it("prints near-black on every quick pick", () => {
    for (const c of LABEL_COLORS) expect(labelFgCss(c.hex), c.label).toBe(DARK_TEXT);
  });

  it("answers for a colour no palette has heard of", () => {
    expect(labelFgCss("#ffffff")).toBe(DARK_TEXT);
    expect(labelFgCss("#000000")).toBe(LIGHT_TEXT);
    expect(labelFgCss("#7b2d8e")).toBe(LIGHT_TEXT);
  });

  /** Total, like {@link labelColorCss} and through it: an unreadable colour is drawn as the
   *  default, so what reads on it is what reads on the default. */
  it("answers for a colour it cannot read at all", () => {
    expect(labelFgCss(null)).toBe(labelFgCss(DEFAULT_LABEL_COLOR.hex));
    expect(labelFgCss("chartreuse")).toBe(labelFgCss(DEFAULT_LABEL_COLOR.hex));
  });
});

/**
 * `oklch(L C h)` as the `#rrggbb` a browser paints it, for a colour inside the sRGB gamut: OKLCh
 * to OKLab, OKLab to linear sRGB through Björn Ottosson's published matrices, the sRGB transfer
 * curve, then 8 bits a channel. Nothing is clamped, because a colour outside the gamut has no one
 * hex and the assertion should fail on it rather than agree with a clipped guess.
 */
function oklchHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  const channels = linear.map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
  for (const v of channels) {
    expect(v, `oklch(${l} ${c} ${h}) is outside sRGB`).toBeGreaterThanOrEqual(0);
    expect(v, `oklch(${l} ${c} ${h}) is outside sRGB`).toBeLessThanOrEqual(1);
  }
  return `#${channels.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * **The six quick picks are duplicated from `packages/ui/index.css` and this is what keeps them honest.**
 *
 * They cannot be `var(--color-mana-*)`: these strings are written *to the database* when a reader
 * presses one, and a `var()` in a column is a colour with no value outside this build. So the
 * duplication is deliberate, and the cost of a duplicate is that it drifts — this reads the
 * stylesheet and compares, which is the only thing that would go red if a palette edit moved one
 * of the mana colours, or the accent, and left the picker on last year's.
 */
describe("the quick picks against the palette", () => {
  const VARS: Record<string, string> = {
    Bone: "--color-mana-w",
    Azure: "--color-mana-u",
    Slate: "--color-mana-c",
    Ember: "--color-mana-r",
    Moss: "--color-mana-g",
  };

  it.each(LABEL_COLORS.filter((c) => c.label !== "Gold").map((c) => [c.label, c.hex] as const))(
    "%s is still the palette's own mana colour",
    (label, hex) => {
      const declared = new RegExp(`${VARS[label]}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
      expect(declared, `${VARS[label]} is missing from index.css`).not.toBeNull();
      expect(declared?.[1].toLowerCase()).toBe(hex);
    },
  );

  /** Gold has no mana colour, so it is the accent — declared in OKLCh, which a hex can only be
   *  compared against once converted. `--color-ok`'s `#56bd78` checks the converter itself: that
   *  is the one conversion `index.css` already quotes, so a converter that drifted fails there. */
  it("Gold is still the accent, converted to sRGB", () => {
    expect(oklchHex(0.72, 0.14, 152)).toBe("#56bd78");
    const accent = /--color-accent:\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(css);
    expect(accent, "--color-accent is not an oklch() in index.css").not.toBeNull();
    const [l, c, h] = accent!.slice(1).map(Number);
    expect(LABEL_COLORS.find((pick) => pick.label === "Gold")?.hex).toBe(oklchHex(l, c, h));
  });

  /** Lowercase `#rrggbb` throughout, because the picker compares stored colours by string —
   *  a swatch pressed has to read as pressed. */
  it("stores every pick in the one shape", () => {
    for (const c of LABEL_COLORS) {
      expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(normalizeLabelColor(c.hex)).toBe(c.hex);
    }
  });
});
