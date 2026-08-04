import { describe, expect, it } from "vitest";
import { woff2Only } from "@/lib/iconFont";
/**
 * The real package CSS, not a fixture: the point of this transform is that node_modules
 * stays the source of truth, so the test has to fail when a package bump changes the
 * shape of what it rewrites. `?raw` hands over the file as it ships — the plugin skips
 * query-suffixed ids precisely so this arrives untransformed.
 */
import mana from "mana-font/css/mana.css?raw";
import keyrune from "keyrune/css/keyrune.css?raw";

describe("woff2Only", () => {
  it("leaves exactly one src per face, pointing at the woff2 the package ships", () => {
    const out = woff2Only(mana);

    expect(out).toContain('src: url("../fonts/mana.woff2") format("woff2");');
    for (const dead of [".eot", ".ttf", ".svg", "mana.woff?"]) {
      expect(out).not.toContain(dead);
    }
  });

  /** `keyrune.css` already lists a woff2, but behind four formats Vite would still emit. */
  it("does the same for a package that already mentions woff2", () => {
    const out = woff2Only(keyrune);

    expect(out).toContain('src: url("../fonts/keyrune.woff2") format("woff2");');
    expect(out.match(/src:/g)).toHaveLength(1);
  });

  /**
   * The glyphs are the reason the packages are here at all. `.ms-w` and `.ss-lea` stand in
   * for the ~1 000 class rules that must survive a transform aimed only at `@font-face`.
   */
  it("touches nothing but the @font-face blocks", () => {
    const manaOut = woff2Only(mana);
    const keyruneOut = woff2Only(keyrune);

    // `mana-font` writes `::before`, `keyrune` writes `:before`; the minifier normalises
    // them later, so these are the selectors as the packages actually ship them.
    expect(manaOut).toContain(".ms-w::before");
    expect(manaOut).toContain(".ms-c::before");
    expect(keyruneOut).toContain(".ss-lea:before");
    // Every rule that is not an @font-face survives byte for byte.
    const classRules = (css: string) => css.replace(/@font-face\s*\{[^}]*\}/g, "").trim();
    expect(classRules(manaOut)).toBe(classRules(mana));
    expect(classRules(keyruneOut)).toBe(classRules(keyrune));
  });

  /** MPlantin has no woff2 to trim to, and this app never sets type in it. */
  it("drops the card-text face the app does not use", () => {
    const out = woff2Only(mana);

    expect(out).not.toContain('font-family: "MPlantin";');
    // The classes that *name* it keep their serif fallback stack.
    expect(out).toContain("MPlantin, Garamond, Palatino");
  });
});
