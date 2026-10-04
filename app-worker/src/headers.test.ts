import { describe, expect, it } from "vitest";
import { headersFor, MAX_LINE_LENGTH, MAX_RULES, parseHeaders } from "./headers";

/**
 * The reader of `_headers`, against Cloudflare's own worked example and each rule of the format
 * the file leans on. The table in the first test is the one on
 * `developers.cloudflare.com/workers/static-assets/headers/` (read 2026-10-04), less its
 * absolute-URL rule, which this reader refuses.
 */

describe("the format", () => {
  const EXAMPLE = [
    "# This is a comment",
    "/secure/page",
    "\tX-Frame-Options: DENY",
    "\tX-Content-Type-Options: nosniff",
    "\tReferrer-Policy: no-referrer",
    "",
    "/static/*",
    "\tAccess-Control-Allow-Origin: *",
    "\tX-Robots-Tag: nosnippet",
  ].join("\n");

  it("answers Cloudflare's example the way their table does", () => {
    const rules = parseHeaders(EXAMPLE);

    expect(headersFor(rules, "/secure/page")).toEqual({
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    expect(headersFor(rules, "/static/image.jpg")).toEqual({
      "access-control-allow-origin": "*",
      "x-robots-tag": "nosnippet",
    });
    expect(headersFor(rules, "/home")).toEqual({});
  });

  it("joins a header two matching rules both set, with a comma", () => {
    const rules = parseHeaders("/*\n  X-Robots-Tag: noindex\n/static/*\n  X-Robots-Tag: nosnippet");

    expect(headersFor(rules, "/static/styles.css")).toEqual({
      "x-robots-tag": "noindex, nosnippet",
    });
  });

  it("detaches a wider rule's header, and what follows the detach replaces it", () => {
    const rules = parseHeaders(
      [
        "/*",
        "  Cache-Control: no-cache",
        "  Content-Security-Policy: default-src 'self'",
        "/assets/*",
        "  ! Cache-Control",
        "  Cache-Control: public, max-age=31536000, immutable",
        "/*.jpg",
        "  ! Content-Security-Policy",
      ].join("\n"),
    );

    expect(headersFor(rules, "/assets/index-1a2b.js")).toEqual({
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": "default-src 'self'",
    });
    expect(headersFor(rules, "/photo.jpg")).toEqual({ "cache-control": "no-cache" });
  });

  it("keeps a value's own colons and commas", () => {
    const rules = parseHeaders("/*\n  Content-Security-Policy: img-src 'self' data: https://a.test");

    expect(headersFor(rules, "/")).toEqual({
      "content-security-policy": "img-src 'self' data: https://a.test",
    });
  });

  it("matches a splat across `/`, and a literal path exactly", () => {
    const rules = parseHeaders("/sw.js\n  A: 1\n/wasm/*\n  B: 2");

    expect(headersFor(rules, "/sw.js")).toEqual({ a: "1" });
    expect(headersFor(rules, "/sw.js.map")).toEqual({});
    expect(headersFor(rules, "/x/sw.js")).toEqual({});
    expect(headersFor(rules, "/wasm/0123/grimoire_web_bg.wasm")).toEqual({ b: "2" });
    // A dot in a pattern is a dot.
    expect(headersFor(parseHeaders("/sw.js\n  A: 1"), "/swxjs")).toEqual({});
  });
});

describe("what it refuses rather than skips", () => {
  it.each([
    ["an absolute URL pattern", "https://mtg-grimoire.app/*\n  A: 1", /absolute URL/],
    ["a placeholder", "/movies/:title\n  A: 1", /placeholders/],
    ["two splats", "/a/*/b/*\n  A: 1", /one splat/],
    ["a header before any path", "A: 1", /before any path/],
    ["a line that is not a pair", "/*\n  just words", /Name: value/],
    ["a header with no value", "/*\n  A:", /Name: value/],
    // Cloudflare stores rules by path: of two for one path it keeps the last and says nothing.
    ["the same path twice", "/a\n  A: 1\n/b\n  B: 2\n/a\n  C: 3", /second rule for `\/a`/],
    // …and drops a rule with nothing under it, with a warning in a deploy's output.
    ["a rule with nothing under it", "/a\n/b\n  B: 2", /`\/a` has no headers/],
    ["a last rule with nothing under it", "/a\n  A: 1\n/b\n# only a comment", /`\/b` has no headers/],
  ])("%s", (_what, text, why) => {
    expect(() => parseHeaders(text)).toThrow(why);
  });

  it("names the line", () => {
    expect(() => parseHeaders("# one\n/*\n  A: 1\n  oops")).toThrow(/line 4/);
    // An empty rule is named by the line it began on, not the line that ended it.
    expect(() => parseHeaders("/a\n  A: 1\n/empty\n\n/c\n  C: 1")).toThrow(/line 3/);
  });

  it("takes a rule that only detaches", () => {
    // Cloudflare's own example, `/*.jpg` with one `! Content-Security-Policy`, is not empty.
    expect(parseHeaders("/*.jpg\n  ! Content-Security-Policy")).toEqual([
      { path: "/*.jpg", unset: ["content-security-policy"], set: [] },
    ]);
  });

  it("applies three rules to one address in the file's order", () => {
    // The shape `_headers` leans on for the engine's Worker: a default, a tree, one file in it.
    const rules = parseHeaders(
      [
        "/*",
        "  Cache-Control: no-cache",
        "/assets/*",
        "  ! Cache-Control",
        "  Cache-Control: public, max-age=31536000, immutable",
        "/assets/worker-*",
        "  ! Cache-Control",
        "  Cache-Control: no-cache",
      ].join("\n"),
    );

    expect(headersFor(rules, "/assets/worker-BjbUO-kj.js")).toEqual({ "cache-control": "no-cache" });
    expect(headersFor(rules, "/assets/index-B1x9QkZp.js")).toEqual({
      "cache-control": "public, max-age=31536000, immutable",
    });
  });

  it("holds Cloudflare's two limits", () => {
    const long = `/*\n  A: ${"x".repeat(MAX_LINE_LENGTH)}`;
    expect(() => parseHeaders(long)).toThrow(/2000/);

    const many = Array.from({ length: MAX_RULES + 1 }, (_, n) => `/r${n}\n  A: 1`).join("\n");
    expect(() => parseHeaders(many)).toThrow(/more than 100 rules/);
  });
});
