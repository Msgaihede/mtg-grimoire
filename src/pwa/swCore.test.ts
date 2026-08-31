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
   *
   * **The eviction's delete joined this sweep on 2026-08-31 as insurance, not as a fix — it has
   * never been broken.** `Cache.delete` runs the same matching algorithm, so the same
   * disagreement would refuse to evict a file the ledger had already forgotten. It needs a
   * `Vary`, and there is not one: probed live that day, a card image from `cards.scryfall.io`
   * answers 200 with **no `vary` header at all**, plain, with an `Origin:` and with a
   * webp-negotiating `Accept:`. What the option buys is that the read and the evict cannot
   * drift apart if that ever changes — `image()` would go on matching while eviction quietly
   * stopped, and a cache growing past its cap names nothing that would lead anyone here.
   */
  it("never queries a cache without ignoring Vary, the eviction included", () => {
    const lookups = SW_SOURCE.match(/(?:caches|cache)\.match\([^)]*\)/g) ?? [];
    const deletes = SW_SOURCE.match(/cache\.delete\([^)]*\)/g) ?? [];
    expect(lookups.length).toBeGreaterThan(0);
    expect(deletes.length).toBeGreaterThan(0);
    for (const query of [...lookups, ...deletes]) expect(query).toContain("ignoreVary: true");
  });

  /**
   * **The exclusion the sweep above rests on, asserted rather than assumed.**
   *
   * There are two kinds of delete in this file and only one of them takes query options.
   * `caches.delete(name)` in `activate` drops a whole stale shell cache and has no `Vary` to
   * ignore; the eviction's is a delete of one entry *inside* a cache and does. The sweep tells
   * them apart on the `s`: `caches.delete(` simply does not contain the substring
   * `cache.delete(`, because the character after `cache` is an `s` rather than a dot.
   *
   * That is a fact about a regular expression, which is exactly the kind of reasoning that is
   * right until it is not — so this counts every delete in the file and demands the two
   * families account for all of them. A third spelling nobody classified (`imageCache` with a
   * delete on it, say) fails here rather than slipping past the sweep as an unchecked query.
   */
  it("classifies every delete in the file as one kind or the other", () => {
    const everyDelete = SW_SOURCE.match(/\.delete\(/g) ?? [];
    const wholeCaches = SW_SOURCE.match(/caches\.delete\(/g) ?? [];
    const oneEntry = SW_SOURCE.match(/cache\.delete\(/g) ?? [];

    // Non-empty in both directions, or the partition below is satisfied by arithmetic on
    // nothing and the exclusion is never exercised.
    expect(wholeCaches.length).toBeGreaterThan(0);
    expect(oneEntry.length).toBeGreaterThan(0);
    expect(wholeCaches.length + oneEntry.length).toBe(everyDelete.length);
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

  /**
   * **The read-modify-write race, fenced at the one place it can come back.**
   *
   * `writeLedger` is only safe inside `ledgerWriter`'s queue. Called directly it is the defect
   * that shipped: dozens of card tiles run `read → mutate → write` concurrently, interleave at
   * each `await`, and all but the last write back a ledger built from a copy that predates the
   * others. Measured in the shipped web build on 2026-08-29, from an empty cache, one wall
   * load: **78 pictures in the cache and 9 in the ledger.**
   *
   * The behaviour is pinned in `imageLedger.test.ts`, which can exercise the queue directly.
   * What that cannot see is *this file reaching around it*, which is a one-line mistake with a
   * silent consequence — so the sweep is here, in the idiom this file already uses for
   * `ignoreVary`. `readLedger` is deliberately not counted: `ledgerFor` has to call it, and a
   * lone read races nothing.
   */
  /**
   * **The clear is the one operation that can leave the two halves disagreeing, and going
   * around the queue is how.** `clearImages` deletes files and hands back the ledger that
   * describes what is left; it is the caller that writes it. A call made outside
   * `mutateLedger` would empty Cache Storage and leave the stored ledger certain it was still
   * holding 256 MB of pictures - after which `evictions` deletes from an empty cache on every
   * single request, for the life of the worker. That is `forget`'s failure reached from the
   * other end, and the sweep in the previous test cannot see it: nothing has to be *written*
   * for it to happen.
   *
   * The reply is swept for the same reason `ledgerWriter` is not memoised - a silent failure
   * with no witness. `sw.ts` is unreachable from vitest (jsdom implements no `caches` and no
   * registration), so the page's own timeout is all that stands between a handler that forgets
   * to answer and a Clear button that spins for ever.
   */
  it("clears the image cache through the writer, and answers the caller", () => {
    const calls = SW_SOURCE.match(/clearImages\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const verbAt = SW_SOURCE.indexOf('"CLEAR_IMAGE_CACHE"');
    const nextVerbAt = SW_SOURCE.indexOf('"VERSION"');
    expect(verbAt).toBeGreaterThan(-1);
    expect(nextVerbAt).toBeGreaterThan(verbAt);

    const handler = SW_SOURCE.slice(verbAt, nextVerbAt);
    expect(handler).toContain("clearImages(");
    expect(handler).toContain("mutateLedger(");
    expect(handler).toContain("event.ports[0]?.postMessage");
  });

  it("never writes the ledger outside the serialising writer", () => {
    // The definition, plus the single call inside `ledgerFor`'s writer argument. Anything more
    // is a caller that has gone around the queue.
    const calls = SW_SOURCE.match(/writeLedger\(/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);

    const writerAt = SW_SOURCE.indexOf("ledgerWriter(");
    const lastCallAt = SW_SOURCE.lastIndexOf("writeLedger(");
    expect(writerAt).toBeGreaterThan(-1);
    // The surviving call site is the one `ledgerWriter` is handed, so it sits after it.
    expect(lastCallAt).toBeGreaterThan(writerAt);
  });
});
