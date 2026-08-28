import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, manifestJson } from "@/pwa/manifest";
import { maskableFromMark, webAssetsPlugin } from "@/pwa/webAssets";

/** The master artwork, as `vite.web.config.ts` reads it off disk. */
const MARK = import.meta.glob<string>("/public/mtg-grimoire-mark.svg", {
  query: "?raw",
  import: "default",
  eager: true,
})["/public/mtg-grimoire-mark.svg"];

describe("the web app manifest", () => {
  it("carries everything Chrome needs to offer an install", () => {
    const m = manifestJson();
    expect(m.name).toBe("MTG Grimoire");
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.id).toBe("/");
    expect(m.display).toBe("standalone");
    // An installable icon is one that is at least 144px and a format the browser rasterises.
    const big = m.icons.filter(
      (i) => i.type === "image/svg+xml" || Number(i.sizes.split("x")[0]) >= 192,
    );
    expect(big.length).toBeGreaterThan(0);
  });

  it("has exactly one maskable icon, and it is not also the any icon", () => {
    // Two purposes on one file means the platform crops artwork that was drawn full-frame.
    const maskable = manifestJson().icons.filter((i) => i.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0].purpose).not.toContain("any");
  });

  it("is served from the root, so `start_url` and `scope` are inside it", () => {
    expect(MANIFEST_PATH).toBe("manifest.webmanifest");
  });
});

describe("the maskable icon", () => {
  it("puts the field behind the mark and shrinks it into the safe zone", () => {
    const out = maskableFromMark(MARK);
    expect(out).toContain('<rect width="64" height="64" fill="#0C0D12"');
    // 0.9200 is the master's own scale; 0.8000 keeps the book inside the 40%-radius circle
    // a maskable icon is cropped to. See the function's comment for the arithmetic.
    expect(out).toContain("scale(0.8000)");
    expect(out).not.toContain("scale(0.9200)");
  });

  it("refuses artwork it does not recognise, instead of emitting a silent square", () => {
    // The master is edited by hand (`logos/README.md`: "Master artwork; edit this one"), so
    // the day its transform is rewritten this must fail the build rather than ship a field
    // with nothing on it.
    expect(() => maskableFromMark("<svg></svg>")).toThrow(/scale\(0\.9200\)/);
  });
});

describe("the web assets plugin", () => {
  it("links the manifest and the theme colour into the document head, once", () => {
    const plugin = webAssetsPlugin({ markSvg: MARK, icons: [] });
    const html = plugin.transformIndexHtml(
      `<!doctype html><html><head><title>x</title></head><body></body></html>`,
    );
    expect(html.match(/rel="manifest"/g)).toHaveLength(1);
    expect(html).toContain('<meta name="theme-color" content="#0C0D12"');
    expect(html.indexOf('rel="manifest"')).toBeLessThan(html.indexOf("</head>"));
  });

  it("emits the manifest, the maskable icon and every PNG it was handed", () => {
    const emitted: { fileName: string }[] = [];
    const plugin = webAssetsPlugin({
      markSvg: MARK,
      icons: [{ fileName: "icons/mark-512.png", source: new Uint8Array([1, 2, 3]) }],
    });
    plugin.generateBundle.call({ emitFile: (f: { fileName: string }) => emitted.push(f) });
    expect(emitted.map((e) => e.fileName)).toEqual([
      "manifest.webmanifest",
      "icons/maskable.svg",
      "icons/mark-512.png",
    ]);
  });
});
