import { describe, expect, it } from "vitest";
import type { WishRow } from "@/lib/ipc";
import { preferredFinishOf, wallPrinting } from "./wish";

const wish = (over: Partial<WishRow> = {}): WishRow =>
  ({
    id: 1,
    cardId: "card-1",
    name: "Lightning Bolt",
    setCode: "lea",
    collectorNumber: "161",
    preferredFinish: null,
    ...over,
  }) as WishRow;

describe("preferredFinishOf", () => {
  it("answers the finish a wish asks for, and nothing for no preference or an unknown word", () => {
    expect(preferredFinishOf(wish({ preferredFinish: "foil" }))).toBe("foil");
    expect(preferredFinishOf(wish())).toBeNull();
    expect(preferredFinishOf(wish({ preferredFinish: "glossy" }))).toBeNull();
  });
});

describe("wallPrinting", () => {
  it("drops the finish's word where the chin's glyph already says it", () => {
    expect(wallPrinting(wish({ preferredFinish: "foil" }))).toBe("LEA · 161");
  });

  it("keeps the word for a wish for the nonfoil, which draws no glyph", () => {
    expect(wallPrinting(wish({ preferredFinish: "nonfoil" }))).toBe("LEA · 161 · Nonfoil");
  });

  it("never names the printing a wish for any printing is drawn as", () => {
    expect(wallPrinting(wish({ cardId: null, setCode: null, collectorNumber: null }))).toBe(
      "Any printing",
    );
  });
});
