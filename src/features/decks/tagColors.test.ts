import { describe, expect, it } from "vitest";
// `?raw`, like `lib/tokens.test.ts`'s own sweep of this file — there is no `node:fs` to reach
// for here, because `@types/node` is banned from this program on purpose.
import css from "@/index.css?raw";
import {
  DEFAULT_TAG_COLOR,
  LEGACY_TOKENS,
  normalizeTagColor,
  TAG_COLORS,
  tagColorCss,
  tagColorHex,
  tagFgCss,
} from "./tagColors";

/**
 * The colour a tag stores, and the three questions the rest of the app asks about one.
 *
 * **This file guards a storage-format change** (2026-08-20): `deck_tags.color` used to hold one
 * of six token words and now holds `#rrggbb`. The backend validates neither — it checks the
 * string is non-empty and stores it — so nothing but these functions and these tests stands
 * between a database written by one build and a screen drawn by another.
 */

describe("normalizeTagColor", () => {
  it("takes a hex with or without the hash, and answers one shape", () => {
    expect(normalizeTagColor("#d9b95c")).toBe("#d9b95c");
    expect(normalizeTagColor("d9b95c")).toBe("#d9b95c");
    // Uppercase is what a reader pastes out of a design tool, and what the field itself draws.
    expect(normalizeTagColor("#D9B95C")).toBe("#d9b95c");
    expect(normalizeTagColor("  #d9b95c  ")).toBe("#d9b95c");
  });

  /** Three digits is a shape a reader typing by hand will try, and CSS's own shorthand. */
  it("expands the three-digit shorthand", () => {
    expect(normalizeTagColor("#f00")).toBe("#ff0000");
    expect(normalizeTagColor("abc")).toBe("#aabbcc");
  });

  /**
   * The six words a database older than this build still holds.
   *
   * **A read path only** — nothing writes a token any more — and it does not expire, because a
   * database is not migrated by a build being newer than it.
   */
  it("reads the six retired tokens", () => {
    expect(normalizeTagColor("gold")).toBe("#d9b95c");
    expect(normalizeTagColor("moss")).toBe("#00733e");
    expect(normalizeTagColor("EMBER")).toBe("#d3202a");
    for (const [token, hex] of Object.entries(LEGACY_TOKENS)) {
      expect(normalizeTagColor(token)).toBe(hex);
    }
  });

  /**
   * `null` for anything else — which is what lets the picker's hex field hold a half-typed
   * colour rather than snapping back on every keystroke. A field that could not sit in this
   * state would be untypeable: three characters into `d9b95c` there is nothing to normalise to.
   */
  it("answers null for anything that is not yet a colour", () => {
    expect(normalizeTagColor("d9b")).toBe("#dd99bb"); // three digits *is* a colour
    expect(normalizeTagColor("d9b9")).toBeNull();
    expect(normalizeTagColor("")).toBeNull();
    expect(normalizeTagColor("rebeccapurple")).toBeNull();
    expect(normalizeTagColor("#zzzzzz")).toBeNull();
    expect(normalizeTagColor(null)).toBeNull();
    expect(normalizeTagColor(undefined)).toBeNull();
  });
});

describe("tagColorCss", () => {
  it("draws a stored colour, however it was stored", () => {
    expect(tagColorCss("#7b2d8e")).toBe("#7b2d8e");
    expect(tagColorCss("azure")).toBe("#0e68ab");
  });

  /**
   * A colour this build cannot read is the **default**, never nothing: a dot the reader cannot
   * see is a label the reader cannot find. The arm covers a token retired before
   * {@link LEGACY_TOKENS}, a truncated write, and a `null` column.
   */
  it("falls back to the default rather than to nothing", () => {
    expect(tagColorCss(null)).toBe(DEFAULT_TAG_COLOR.hex);
    expect(tagColorCss("chartreuse")).toBe(DEFAULT_TAG_COLOR.hex);
    expect(tagColorCss("")).toBe(DEFAULT_TAG_COLOR.hex);
  });

  it("hands the picker's field six uppercase digits and no hash", () => {
    expect(tagColorHex("#7b2d8e")).toBe("7B2D8E");
    expect(tagColorHex("gold")).toBe("D9B95C");
  });
});

/**
 * What reads on a tag's colour — the deck stack's quantity tag prints a copy count on one.
 *
 * **The six answers below are the specification, not a derivation.** They were a hand-made
 * column on each of the six palette rows until the colour became the reader's own and no table
 * could hold the answer in advance; the formula that replaced the column is the one those six
 * were built from. A "more correct" luminance curve that flips one of them is a regression on a
 * screen somebody looked at, which is why every one is pinned rather than a threshold sampled.
 */
describe("tagFgCss", () => {
  const DARK_TEXT = "var(--color-accent-fg)";
  const LIGHT_TEXT = "var(--color-text)";

  it("keeps the six palette answers it inherited", () => {
    expect(tagFgCss("#d9b95c")).toBe(DARK_TEXT); // gold
    expect(tagFgCss("#f8e7b9")).toBe(DARK_TEXT); // bone
    expect(tagFgCss("#c8c4bf")).toBe(DARK_TEXT); // slate
    expect(tagFgCss("#0e68ab")).toBe(LIGHT_TEXT); // azure
    expect(tagFgCss("#d3202a")).toBe(LIGHT_TEXT); // ember
    expect(tagFgCss("#00733e")).toBe(LIGHT_TEXT); // moss
  });

  it("answers for a colour no palette has heard of", () => {
    expect(tagFgCss("#ffffff")).toBe(DARK_TEXT);
    expect(tagFgCss("#000000")).toBe(LIGHT_TEXT);
    expect(tagFgCss("#7b2d8e")).toBe(LIGHT_TEXT);
  });

  /** Total, like {@link tagColorCss} and through it: an unreadable colour is drawn as the
   *  default, so what reads on it is what reads on the default. */
  it("answers for a colour it cannot read at all", () => {
    expect(tagFgCss(null)).toBe(tagFgCss(DEFAULT_TAG_COLOR.hex));
    expect(tagFgCss("chartreuse")).toBe(tagFgCss(DEFAULT_TAG_COLOR.hex));
  });
});

/**
 * **The six quick picks are duplicated from `src/index.css` and this is what keeps them honest.**
 *
 * They cannot be `var(--color-pie-*)` any more: these strings are written *to the database* when
 * a reader presses one, and a `var()` in a column is a colour with no value outside this build.
 * So the duplication is deliberate, and the cost of a duplicate is that it drifts — this reads
 * the stylesheet and compares, which is the only thing that would go red if a palette edit moved
 * one of the deeps and left the picker on last year's.
 */
describe("the quick picks against the palette", () => {
  const VARS: Record<string, string> = {
    Gold: "--color-pie-gold",
    Bone: "--color-pie-w",
    Azure: "--color-pie-u",
    Slate: "--color-pie-c",
    Ember: "--color-pie-r",
    Moss: "--color-pie-g",
  };

  it.each(TAG_COLORS.map((c) => [c.label, c.hex] as const))(
    "%s is still the palette's own deep",
    (label, hex) => {
      const declared = new RegExp(`${VARS[label]}:\\s*(#[0-9a-f]{6})`, "i").exec(css);
      expect(declared, `${VARS[label]} is missing from index.css`).not.toBeNull();
      expect(declared?.[1].toLowerCase()).toBe(hex);
    },
  );

  /** Lowercase `#rrggbb` throughout, because the picker compares stored colours by string —
   *  a swatch pressed has to read as pressed. */
  it("stores every pick in the one shape", () => {
    for (const c of TAG_COLORS) {
      expect(c.hex).toMatch(/^#[0-9a-f]{6}$/);
      expect(normalizeTagColor(c.hex)).toBe(c.hex);
    }
  });
});
