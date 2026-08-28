import { describe, expect, it } from "vitest";
import { SHELL_PREFIX, routeFor, shellCacheName, staleShellCaches } from "@/pwa/swCore";

/** The worker's source as text, for the two invariants that are about what it does NOT do. */
const SW_SOURCE = import.meta.glob<string>("/src/pwa/sw.ts", {
  query: "?raw",
  import: "default",
  eager: true,
})["/src/pwa/sw.ts"];

const req = (url: string, extra: Partial<{ method: string; mode: string }> = {}) => ({
  url,
  method: extra.method ?? "GET",
  mode: extra.mode ?? "cors",
});

const IMAGES = "https://cards.scryfall.io";

describe("what the service worker answers for", () => {
  it("serves a navigation from the shell", () => {
    expect(routeFor(req("https://grimoire.example/decks", { mode: "navigate" }), IMAGES)).toBe(
      "navigation",
    );
  });

  it("serves same-origin build assets from the shell", () => {
    expect(routeFor(req("https://grimoire.example/assets/index-a1b2c3.js"), IMAGES)).toBe("shell");
    expect(routeFor(req("https://grimoire.example/assets/core-9f8e.wasm"), IMAGES)).toBe("shell");
  });

  /**
   * **Not in the plan, and the offline reading is why.** On the web target the *app itself* is
   * `/wasm/mtg_grimoire_lib_bg.wasm` plus its glue — `scripts/build-wasm.mjs` writes them into
   * `web/public/wasm/`, so they land at that path and nowhere near `/assets/`. Leaving them out
   * makes an offline load a shell that renders and then cannot open a database, which reads
   * exactly like the corpus having been evicted.
   */
  it("serves the wasm core from the shell, because that is where the app lives on web", () => {
    expect(routeFor(req("https://grimoire.example/wasm/mtg_grimoire_lib_bg.wasm"), IMAGES)).toBe(
      "shell",
    );
    expect(routeFor(req("https://grimoire.example/wasm/mtg_grimoire_lib.js"), IMAGES)).toBe("shell");
  });

  it("serves card art from the image cache", () => {
    expect(routeFor(req(`${IMAGES}/normal/front/a/b/abcd.jpg`), IMAGES)).toBe("image");
  });

  /**
   * **The one that matters.** Every feed this app downloads is streamed and gunzipped
   * incrementally — the combo framer's peak buffer is 2.01 MB against a 610.2 MB document.
   * Routing any of them through a `respondWith` would buffer the response to put it in a cache
   * that is 526 MB smaller than the thing being cached, and it would do it silently.
   */
  it("never answers for a data feed", () => {
    for (const url of [
      "https://api.scryfall.com/bulk-data/default_cards",
      "https://data.scryfall.io/default-cards/default-cards-20260828.jsonl.gz",
      "https://json.commanderspellbook.com/variants.json.gz",
      "https://api.cardkingdom.com/api/v2/pricelist",
    ]) {
      expect(routeFor(req(url), IMAGES)).toBe("passthrough");
    }
  });

  it("never answers for anything that is not a GET", () => {
    expect(routeFor(req("https://grimoire.example/assets/x.js", { method: "POST" }), IMAGES)).toBe(
      "passthrough",
    );
  });
});

describe("the shell caches", () => {
  it("names one cache per build", () => {
    expect(shellCacheName("abc123")).toBe(`${SHELL_PREFIX}abc123`);
    expect(shellCacheName("abc123")).not.toBe(shellCacheName("def456"));
  });

  it("drops every other build's shell and nothing else", () => {
    const names = [
      `${SHELL_PREFIX}old1`,
      `${SHELL_PREFIX}new1`,
      "grimoire-images",
      "someone-elses-cache",
    ];
    expect(staleShellCaches(names, "new1")).toEqual([`${SHELL_PREFIX}old1`]);
  });
});

describe("what the worker must never contain", () => {
  /**
   * Measured both ways in the spike: the same page passed with and without the two isolation
   * headers, install 65 ms against 50 ms and a 532.8 MB write 3.3 s against 2.3 s — cache
   * noise. Re-attaching them on a cached navigation is the defensive reflex this test exists
   * to stop, because it costs every cross-origin image and script on the page and buys nothing.
   */
  it("re-attaches no cross-origin isolation headers", () => {
    expect(SW_SOURCE).not.toMatch(/Cross-Origin-(Opener|Embedder|Resource)-Policy/i);
  });

  /**
   * **Every Cache Storage lookup passes `ignoreVary`, and a bare one is an offline blank page.**
   *
   * `Cache.match` honours the stored response's `Vary` by comparing the header it names on the
   * *stored request* against the incoming one. Vite's preview and dev servers answer `/assets/*`
   * with `vary: Origin`; `cache.addAll` stores those with requests that carry **no `Origin` at
   * all**, and the page's own module-script request — Vite emits `<script type="module"
   * crossorigin>` — carries one. Every `/assets/` entry therefore misses.
   *
   * Measured 2026-08-28 in headless Edge against a production build: with the server up the miss
   * is invisible, because the `fetch` fallback is answered by the HTTP cache; with the server
   * stopped the navigation came from Cache Storage and every subresource failed after ~2.3 s,
   * leaving `#root` at `childElementCount: 0`. Nothing in this suite could see it, which is why
   * the guard is a source sweep and not a unit test.
   */
  it("never looks in a cache without ignoring Vary", () => {
    const lookups = SW_SOURCE.match(/(?:caches|cache)\.match\([^)]*\)/g) ?? [];
    expect(lookups.length).toBeGreaterThan(0);
    for (const lookup of lookups) expect(lookup).toContain("ignoreVary: true");
  });

  /**
   * A worker that skips waiting in its own `install` handler activates the moment it
   * downloads, which takes the reader's build away mid-session — the exact thing spec §5.4
   * says must not happen. It may only be called from the message handler, where a press put it.
   */
  it("calls skipWaiting from the message handler and nowhere else", () => {
    const calls = SW_SOURCE.match(/skipWaiting\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    const at = SW_SOURCE.indexOf("skipWaiting()");
    const messageAt = SW_SOURCE.indexOf('addEventListener("message"');
    const installAt = SW_SOURCE.indexOf('addEventListener("install"');
    expect(messageAt).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(messageAt);
    expect(at).toBeGreaterThan(installAt);
  });
});
