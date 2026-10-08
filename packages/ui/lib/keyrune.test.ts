import { describe, expect, it } from "vitest";
import { setGlyphClass } from "@/lib/keyrune";
/** The package as it ships, so a bump that moves the fallback fails here. */
import keyruneCss from "keyrune/css/keyrune.css?raw";

describe("setGlyphClass", () => {
  it("names the keyrune class for a set code", () => {
    expect(setGlyphClass("LEA")).toBe("ss ss-lea");
    expect(setGlyphClass("neo")).toBe("ss ss-neo");
  });

  /**
   * keyrune ships 441 set classes and Scryfall knows ~1 050 sets, so a miss is routine.
   * The fallback is built into the font, not into a lookup table this app would have to
   * maintain. Codes with characters no class could have are still refused, so nothing
   * odd reaches a class attribute.
   */
  it("refuses anything that is not a plain set code", () => {
    expect(setGlyphClass("")).toBe("");
    expect(setGlyphClass("a b")).toBe("");
    expect(setGlyphClass("../x")).toBe("");
  });

  /**
   * The whole reason an unknown code still gets a class: keyrune's base `.ss` rule carries
   * a generic set symbol, so `.ss-<a code it has never heard of>` draws that instead of a
   * hole where every other row has a glyph. Nothing in this app supplies it, and nothing
   * in this app would notice if a package bump took it away.
   */
  it("leans on the fallback glyph keyrune's own base class provides", () => {
    expect(keyruneCss).toMatch(/\.ss:before\s*\{\s*content:\s*"\\[0-9a-f]+";/);
    expect(keyruneCss).not.toContain(".ss-zzz");
  });
});
