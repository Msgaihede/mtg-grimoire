import { describe, expect, it } from "vitest";
import { woff2IconFonts, woff2Only } from "@/lib/iconFont";
/**
 * The real package CSS, not a fixture: the point of this transform is that node_modules
 * stays the source of truth, so the test has to fail when a package bump changes the
 * shape of what it rewrites. `?raw` hands over the file as it ships — the plugin skips
 * query-suffixed ids precisely so this arrives untransformed.
 */
import mana from "mana-font/css/mana.css?raw";
import keyrune from "keyrune/css/keyrune.css?raw";
/**
 * The two files the rewrite points at, resolved through npm. These are here to *resolve*:
 * a `woff2` the package does not ship is a specifier that does not exist, and this file
 * fails to load rather than shipping a stylesheet whose only `src` is a 404. Paired with
 * the `../fonts/…` assertion below, that is the whole guarantee — and it is a guarantee
 * worth having now that real `.ms-*` and `.ss-*` glyphs are on screen, because a missing
 * font file draws nothing at all and reports nothing anywhere.
 */
import manaWoff2 from "mana-font/fonts/mana.woff2?url";
import keyruneWoff2 from "keyrune/fonts/keyrune.woff2?url";
/** Read as text so the plugin's registration can be asserted without loading esbuild. */
import viteConfigSource from "../../vite.config.ts?raw";

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

/** Every `url()` the rewritten stylesheet still names. */
const faceUrls = (css: string) => [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1]);

/**
 * The rewrite is load-bearing from Task 10 on: real `.ms-*` and `.ss-*` glyphs are on
 * screen, and this transform is what decides which file the browser fetches them from. A
 * `src` pointing at a file the package does not ship fails silently — no build error, no
 * console error, just every mana chip and set symbol rendering as nothing at all.
 */
describe("the fonts the rewrite points at", () => {
  it("are the ones the packages actually ship", () => {
    // The imports above already proved these two exist; this ties them to what the
    // rewrite names, since `../fonts/x.woff2` from `<pkg>/css/` is `<pkg>/fonts/x.woff2`.
    expect(manaWoff2).toMatch(/mana\.woff2/);
    expect(keyruneWoff2).toMatch(/keyrune\.woff2/);
    expect(faceUrls(woff2Only(mana))).toEqual(["../fonts/mana.woff2"]);
    expect(faceUrls(woff2Only(keyrune))).toEqual(["../fonts/keyrune.woff2"]);
  });
});

/**
 * `woff2Only` is only ever reached through the Vite plugin, so a green transform test
 * proves nothing on its own: unregister the plugin — or narrow its `id` filter past the
 * paths these stylesheets actually arrive under — and the transform stops running, with
 * ~5 MB of eot/ttf/svg quietly back in the bundle and no test the wiser.
 */
describe("woff2IconFonts", () => {
  const plugin = woff2IconFonts();
  const face = '@font-face{font-family:"Mana";src:url("../fonts/mana.eot");}';

  it("is registered in vite.config.ts, before the CSS plugin", () => {
    // Text, not the imported config: importing `vite.config.ts` drags esbuild into the
    // test environment, and it refuses to load under jsdom.
    expect(viteConfigSource).toMatch(/plugins:\s*\[\s*woff2IconFonts\(\)/);
    // Without `pre` the `url()`s would already be emitted assets by the time the
    // transform saw them, and the eot/ttf/svg would ship regardless.
    expect(plugin.enforce).toBe("pre");
  });

  it.each([
    "D:/proj/node_modules/mana-font/css/mana.css",
    "D:\\proj\\node_modules\\keyrune\\css\\keyrune.css",
    // pnpm's layout, and the minified stylesheet the packages also ship.
    "/proj/node_modules/.pnpm/mana-font@1.18.0/node_modules/mana-font/css/mana.min.css",
  ])("rewrites the icon-font stylesheets, however the id is spelled (%s)", (id) => {
    expect(plugin.transform(face, id)?.code).toContain('url("../fonts/mana.woff2")');
  });

  it.each([
    // `?raw` is how this very file reads the packages as they ship; transforming it would
    // have the test grade its own output.
    "D:/proj/node_modules/mana-font/css/mana.css?raw",
    "D:/proj/src/index.css",
    "D:/proj/node_modules/@fontsource/cinzel/500.css",
  ])("leaves every other stylesheet alone (%s)", (id) => {
    expect(plugin.transform(face, id)).toBeNull();
  });
});
