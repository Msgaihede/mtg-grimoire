import { describe, expect, it, vi } from "vitest";
import { ASK_SOURCE, type Postable } from "./bridge";
import {
  PICTURE_CACHE,
  PICTURE_LIMIT,
  REFRESH_AFTER_MS,
  SOURCE_HEADER,
  STORED_HEADER,
  SWEEP_SLACK,
  type CacheLike,
  type CachesLike,
  type ImageSource,
} from "./pictures";
import { createWorker, type WorkerEnv } from "./serve";
import { precacheList, shellCacheName, type Routable } from "./shell";

const ORIGIN = "https://mtg-grimoire.app";
const NOW = Date.UTC(2026, 9, 4, 12);
const URI = "https://cards.scryfall.io/large/front/a/b/abc.webp?1783948684";

/**
 * A Cache that behaves as the standard says one does where this worker leans on it: keys come
 * back in insertion order, and a `put` over an existing key moves it to the end.
 */
class FakeCache implements CacheLike {
  readonly entries = new Map<string, Response>();
  private abs = (key: string): string => new URL(key, ORIGIN).href;

  async match(key: string): Promise<Response | undefined> {
    return this.entries.get(this.abs(key))?.clone();
  }
  async put(key: string, response: Response): Promise<void> {
    this.entries.delete(this.abs(key));
    this.entries.set(this.abs(key), response);
  }
  async delete(key: string): Promise<boolean> {
    return this.entries.delete(this.abs(key));
  }
  async keys(): Promise<{ url: string }[]> {
    return [...this.entries.keys()].map((url) => ({ url }));
  }
  has(key: string): boolean {
    return this.entries.has(this.abs(key));
  }
}

class FakeCaches implements CachesLike {
  readonly named = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    let cache = this.named.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.named.set(name, cache);
    }
    return cache;
  }
  async keys(): Promise<string[]> {
    return [...this.named.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.named.delete(name);
  }
}

/** A host: what each address answers. An address it does not have is a 404, as a real one's is. */
function host(files: Record<string, string | Response | (() => Response | Promise<Response>)>) {
  const asked: { url: string; init?: unknown }[] = [];
  const fetch = async (input: Routable | string, init?: unknown): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.url, ORIGIN).href;
    asked.push({ url, init });
    const path = url.startsWith(ORIGIN) ? url.slice(ORIGIN.length) : url;
    const answer = files[path];
    if (answer === undefined) return new Response("not found", { status: 404 });
    if (typeof answer === "string") {
      const type = path.endsWith(".js") ? "text/javascript" : "text/html";
      return new Response(answer, { headers: { "Content-Type": type } });
    }
    return typeof answer === "function" ? answer() : answer.clone();
  };
  return { fetch, asked };
}

/** A page holding the engine: it answers each ask for a path from `sources`. */
function enginePage(sources: Record<string, ImageSource>) {
  const asked: string[] = [];
  const client: Postable = {
    postMessage(message, transfer) {
      const { kind, path } = message as { kind: string; path: string };
      if (kind !== ASK_SOURCE) return;
      asked.push(path);
      transfer[0].postMessage({ kind: "source", source: sources[path] ?? { kind: "unknown" } });
    },
  };
  return { client, asked };
}

const picture = (bytes = "the bytes of a card") =>
  new Response(bytes, { headers: { "Content-Type": "image/webp" } });

function harness(over: Partial<WorkerEnv> & { files?: Parameters<typeof host>[0] } = {}) {
  const caches = new FakeCaches();
  const network = host(over.files ?? {});
  let now = NOW;
  const env: WorkerEnv = {
    build: "aaaa",
    precache: ["/", "/assets/index-a.js"],
    origin: ORIGIN,
    caches,
    fetch: network.fetch,
    pages: async () => [],
    now: () => now,
    askTimeoutMs: 50,
    ...over,
  };
  const later: Promise<unknown>[] = [];
  const worker = createWorker(env);
  const ask = (path: string, mode = "no-cors", clientId = "page-1") =>
    worker.respond({ url: `${ORIGIN}${path}`, method: "GET", mode }, clientId, (work) =>
      later.push(work),
    );
  return {
    worker,
    caches,
    network,
    ask,
    /** Everything handed to `waitUntil` so far, finished. */
    settle: () => Promise.all(later),
    tick: (ms: number) => void (now += ms),
  };
}

describe("installing a build", () => {
  const files = { "/": "<html>build a</html>", "/assets/index-a.js": "console.log('a')" };

  it("precaches every listed file into the cache named for the build", async () => {
    const { worker, caches, network } = harness({ files });
    await worker.install();

    const shell = caches.named.get(shellCacheName("aaaa"));
    expect([...(shell?.entries.keys() ?? [])]).toEqual([
      `${ORIGIN}/`,
      `${ORIGIN}/assets/index-a.js`,
    ]);
    // Revalidated: a stale document from the HTTP cache would name the last build's files.
    expect(network.asked.every(({ init }) => (init as { cache: string }).cache === "no-cache")).toBe(true);
  });

  it("fails, and leaves no cache behind, when one file is missing", async () => {
    const { worker, caches } = harness({ files: { "/": files["/"] } });
    await expect(worker.install()).rejects.toThrow("/assets/index-a.js answered 404");
    expect(caches.named.has(shellCacheName("aaaa"))).toBe(false);
  });

  it("fails when a host answers a missing script with the document", async () => {
    // A single-page fallback on every path: 200, and HTML. Installed, it would be a page that
    // asks for JavaScript and is handed the app's own document.
    const html = new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
    const { worker, caches } = harness({ files: { ...files, "/assets/index-a.js": html } });
    await expect(worker.install()).rejects.toThrow("answered a document, not the file");
    expect(caches.named.has(shellCacheName("aaaa"))).toBe(false);
  });

  it("stores a document that arrived by a redirect as one that may answer a navigation", async () => {
    const redirected = new Response("<html>build a</html>", { headers: { "Content-Type": "text/html" } });
    Object.defineProperty(redirected, "redirected", { value: true });
    Object.defineProperty(redirected, "clone", { value: () => redirected });
    const { worker, caches } = harness({ files: { ...files, "/": redirected } });
    await worker.install();
    const stored = await (await caches.open(shellCacheName("aaaa"))).match("/");
    expect(stored?.redirected).toBe(false);
    await expect(stored?.text()).resolves.toBe("<html>build a</html>");
  });

  it("precaches a real build's list, document first", async () => {
    const list = precacheList(["index.html", "assets/index-a.js", "sw.js"]);
    const { worker, caches } = harness({ files, precache: list });
    await worker.install();
    expect(caches.named.get(shellCacheName("aaaa"))?.has("/")).toBe(true);
  });
});

describe("answering the shell", () => {
  const files = { "/": "<html>build a</html>", "/assets/index-a.js": "console.log('a')" };

  it("answers every place with the cached document, the network down", async () => {
    const { worker, caches } = harness({ files });
    await worker.install();
    const offline = createWorker({
      build: "aaaa",
      precache: ["/", "/assets/index-a.js"],
      origin: ORIGIN,
      caches,
      fetch: () => Promise.reject(new TypeError("offline")),
      pages: async () => [],
      now: () => NOW,
    });
    for (const place of ["/", "/decks/12", "/search?card=abc"]) {
      const answer = await offline.respond(
        { url: `${ORIGIN}${place}`, method: "GET", mode: "navigate" },
        "",
        () => undefined,
      );
      await expect(answer?.text()).resolves.toBe("<html>build a</html>");
    }
    const script = await offline.respond(
      { url: `${ORIGIN}/assets/index-a.js`, method: "GET", mode: "cors" },
      "page-1",
      () => undefined,
    );
    await expect(script?.text()).resolves.toBe("console.log('a')");
  });

  it("answers a missing asset with what the network says, never with the document", async () => {
    const { worker, ask } = harness({ files });
    await worker.install();
    const answer = await ask("/assets/gone-123.js", "cors");
    expect(answer?.status).toBe(404);
    await expect(answer?.text()).resolves.not.toContain("<html>");
  });

  it("does not answer what is not its own", async () => {
    const { worker } = harness({ files });
    expect(
      worker.respond(
        { url: "https://data.scryfall.io/default-cards/x.jsonl.gz", method: "GET", mode: "cors" },
        "",
        () => undefined,
      ),
    ).toBeNull();
    expect(
      worker.respond({ url: `${ORIGIN}/sw.js`, method: "GET", mode: "same-origin" }, "", () => undefined),
    ).toBeNull();
  });

  /**
   * Phase 1's leftover, `FaceBoundary`'s "cannot recover from a deploy that renamed the chunks":
   * the page of build A crosses the face floor after build B was deployed and installed.
   */
  it("keeps serving a page its own build's chunks after a newer build has installed", async () => {
    const caches = new FakeCaches();
    const deployA = host({ "/": "<html>build a</html>", "/assets/PhoneApp-a.js": "phone a" });
    const a = createWorker({
      build: "aaaa",
      precache: ["/", "/assets/PhoneApp-a.js"],
      origin: ORIGIN,
      caches,
      fetch: deployA.fetch,
      pages: async () => [],
      now: () => NOW,
    });
    await a.install();
    await a.activate();

    // The deploy: A's chunk is gone from the host, B's is there. B installs and waits.
    const deployB = host({ "/": "<html>build b</html>", "/assets/PhoneApp-b.js": "phone b" });
    const b = createWorker({
      build: "bbbb",
      precache: ["/", "/assets/PhoneApp-b.js"],
      origin: ORIGIN,
      caches,
      fetch: deployB.fetch,
      pages: async () => [],
      now: () => NOW,
    });
    await b.install();
    expect(await caches.keys()).toEqual([shellCacheName("aaaa"), shellCacheName("bbbb")]);

    // The old worker still controls the page — and it now reaches the *new* host.
    const stillA = createWorker({
      build: "aaaa",
      precache: ["/", "/assets/PhoneApp-a.js"],
      origin: ORIGIN,
      caches,
      fetch: deployB.fetch,
      pages: async () => [],
      now: () => NOW,
    });
    const chunk = await stillA.respond(
      { url: `${ORIGIN}/assets/PhoneApp-a.js`, method: "GET", mode: "cors" },
      "page-1",
      () => undefined,
    );
    await expect(chunk?.text()).resolves.toBe("phone a");
    expect(deployB.asked.some(({ url }) => url.endsWith("PhoneApp-a.js"))).toBe(false);
    // And a reload is the same build, which is what keeps a reload from being an update.
    const reloaded = await stillA.respond(
      { url: `${ORIGIN}/decks/12`, method: "GET", mode: "navigate" },
      "",
      () => undefined,
    );
    await expect(reloaded?.text()).resolves.toBe("<html>build a</html>");

    // Only the newer build taking over deletes the older one's cache.
    await b.activate();
    expect(await caches.keys()).toEqual([shellCacheName("bbbb")]);
  });

  it("leaves the pictures alone when a build takes over", async () => {
    const { worker, caches } = harness({ files });
    await (await caches.open(PICTURE_CACHE)).put(`${ORIGIN}/mtgimg/display/abc/0`, picture());
    await caches.open(shellCacheName("older"));
    await worker.install();
    await worker.activate();
    expect(await caches.keys()).toEqual([PICTURE_CACHE, shellCacheName("aaaa")]);
  });
});

describe("answering a card picture", () => {
  const PATH = "/mtgimg/display/abc/0";

  it("asks the page that asked, fetches the address with CORS, stores the picture and answers it", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const { ask, caches, network, settle } = harness({
      files: { [URI]: picture() },
      pages: async (clientId) => (clientId === "page-1" ? [page.client] : []),
    });

    const answer = await ask(PATH);
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("Content-Type")).toBe("image/webp");
    await expect(answer?.text()).resolves.toBe("the bytes of a card");
    expect(page.asked).toEqual(["/display/abc/0"]);
    expect(network.asked).toEqual([{ url: URI, init: { mode: "cors", credentials: "omit" } }]);

    await settle();
    const stored = await (await caches.open(PICTURE_CACHE)).match(`${ORIGIN}${PATH}`);
    expect(stored?.headers.get(SOURCE_HEADER)).toBe(URI);
    expect(stored?.headers.get(STORED_HEADER)).toBe(String(NOW));
    // The size the clear will report: the body as it was measured.
    expect(stored?.headers.get("Content-Length")).toBe(String("the bytes of a card".length));
  });

  it("answers a response built from the bytes, never the one Scryfall sent", async () => {
    // A page's `img-src` is checked against the response's own URL. Scryfall's is another
    // origin's; one built here has none and takes the request's.
    const theirs = picture();
    Object.defineProperty(theirs, "url", { value: URI });
    Object.defineProperty(theirs, "clone", { value: () => theirs });
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const { ask } = harness({ files: { [URI]: theirs }, pages: async () => [page.client] });
    const answer = await ask(PATH);
    expect(answer).not.toBe(theirs);
    expect(answer?.url).toBe("");
  });

  it("answers from the cache without asking the engine or the network — offline included", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const { ask, network, settle, caches } = harness({
      files: { [URI]: picture() },
      pages: async () => [page.client],
    });
    await ask(PATH);
    await settle();

    const offline = createWorker({
      build: "aaaa",
      precache: [],
      origin: ORIGIN,
      caches,
      fetch: () => Promise.reject(new TypeError("offline")),
      pages: async () => [],
      now: () => NOW,
    });
    const again = await offline.respond(
      { url: `${ORIGIN}${PATH}`, method: "GET", mode: "no-cors" },
      "",
      () => undefined,
    );
    expect(again?.status).toBe(200);
    await expect(again?.text()).resolves.toBe("the bytes of a card");
    expect(page.asked).toHaveLength(1);
    expect(network.asked).toHaveLength(1);
  });

  it("keeps one picture under one key, whatever retry or stall mark the request wears", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const { ask, caches, network, settle } = harness({
      files: { [URI]: picture() },
      pages: async () => [page.client],
    });
    await ask(PATH);
    await settle();
    for (const mark of ["?retry=1", "?stall=2", "?retry=1&stall=1"]) {
      const answer = await ask(`${PATH}${mark}`);
      expect(answer?.status).toBe(200);
    }
    expect((await (await caches.open(PICTURE_CACHE)).keys()).map(({ url }) => url)).toEqual([
      `${ORIGIN}${PATH}`,
    ]);
    expect(network.asked).toHaveLength(1);
  });

  it("joins an ask already in flight: a wall that asks twice fetches once", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const { ask, network } = harness({ files: { [URI]: picture() }, pages: async () => [page.client] });
    const [first, marked] = await Promise.all([ask(PATH), ask(`${PATH}?stall=1`)]);
    await expect(first?.text()).resolves.toBe("the bytes of a card");
    await expect(marked?.text()).resolves.toBe("the bytes of a card");
    expect(page.asked).toHaveLength(1);
    expect(network.asked).toHaveLength(1);
  });

  it("answers a card with no picture the engine's placeholder, and does not store it", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "missing", svg: "<svg>no art</svg>" } });
    const { ask, caches, network } = harness({ pages: async () => [page.client] });
    const answer = await ask(PATH);
    expect(answer?.status).toBe(200);
    expect(answer?.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(answer?.headers.get("Cache-Control")).toBe("no-store");
    await expect(answer?.text()).resolves.toBe("<svg>no art</svg>");
    expect((await (await caches.open(PICTURE_CACHE)).keys())).toEqual([]);
    expect(network.asked).toEqual([]);
  });

  it("answers 404 for a card the engine does not know, and for a path that is no picture", async () => {
    const page = enginePage({});
    const { ask } = harness({ pages: async () => [page.client] });
    expect((await ask(PATH))?.status).toBe(404);
    expect((await ask("/mtgimg/png/abc/0"))?.status).toBe(404);
    // The second never reached the engine.
    expect(page.asked).toEqual(["/display/abc/0"]);
  });

  /** What `useImageRetry` heals: an `error` now, and the same address again in 30 s. */
  describe("a picture that cannot be had", () => {
    it("is a 503 when there is no page to ask", async () => {
      const { ask } = harness({ pages: async () => [] });
      const answer = await ask(PATH);
      expect(answer?.status).toBe(503);
      expect(answer?.headers.get("Cache-Control")).toBe("no-store");
      expect(answer?.headers.get("Retry-After")).toBe("30");
    });

    it("is a 503 when the page does not answer in time", async () => {
      const silent: Postable = { postMessage: () => undefined };
      const { ask } = harness({ pages: async () => [silent], askTimeoutMs: 5 });
      expect((await ask(PATH))?.status).toBe(503);
    });

    it("is a 503, with the engine's own sentence, when the engine refuses", async () => {
      const refusing: Postable = {
        postMessage: (_message, [port]) =>
          port.postMessage({ kind: "refused", message: "MTG Grimoire's card engine stopped." }),
      };
      const { ask } = harness({ pages: async () => [refusing] });
      const answer = await ask(PATH);
      expect(answer?.status).toBe(503);
      await expect(answer?.text()).resolves.toBe("MTG Grimoire's card engine stopped.");
    });

    it("is a 502 offline, and nothing is stored", async () => {
      const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
      const { ask, caches } = harness({
        pages: async () => [page.client],
        fetch: () => Promise.reject(new TypeError("Failed to fetch")),
      });
      const answer = await ask(PATH);
      expect(answer?.status).toBe(502);
      expect(await (await caches.open(PICTURE_CACHE)).keys()).toEqual([]);
    });

    it("is a 502 when Scryfall answers an error, and a 503 when it asks for a pause", async () => {
      const page = enginePage({
        "/display/abc/0": { kind: "uri", uri: URI },
        "/display/def/0": { kind: "uri", uri: `${URI}&x` },
      });
      const { ask, caches } = harness({
        pages: async () => [page.client],
        files: {
          [URI]: new Response("gone", { status: 404 }),
          [`${URI}&x`]: new Response("slow down", { status: 429 }),
        },
      });
      expect((await ask(PATH))?.status).toBe(502);
      expect((await ask("/mtgimg/display/def/0"))?.status).toBe(503);
      // A refusal is about this moment: never a picture, never kept.
      expect(await (await caches.open(PICTURE_CACHE)).keys()).toEqual([]);
    });

    it("is a 502 for an address that is not Scryfall's, which is never fetched", async () => {
      const page = enginePage({
        "/display/abc/0": { kind: "uri", uri: "https://errors.scryfall.com/soon.jpg" },
      });
      const { ask, network } = harness({ pages: async () => [page.client] });
      expect((await ask(PATH))?.status).toBe(502);
      expect(network.asked).toEqual([]);
    });

    it("heals on the next ask, once the engine answers", async () => {
      let ready = false;
      const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
      const { ask } = harness({
        files: { [URI]: picture() },
        pages: async () => (ready ? [page.client] : []),
      });
      expect((await ask(PATH))?.status).toBe(503);
      ready = true;
      expect((await ask(`${PATH}?retry=1`))?.status).toBe(200);
    });
  });

  describe("the budget", () => {
    it("deletes the oldest pictures once the cache is past its limit and slack", async () => {
      const page = enginePage({ "/display/new/0": { kind: "uri", uri: URI } });
      const { ask, caches, settle } = harness({
        files: { [URI]: picture() },
        pages: async () => [page.client],
      });
      const cache = await caches.open(PICTURE_CACHE);
      const full = PICTURE_LIMIT + SWEEP_SLACK;
      for (let at = 0; at < full; at++) {
        cache.entries.set(`${ORIGIN}/mtgimg/display/old-${at}/0`, picture());
      }

      await ask("/mtgimg/display/new/0");
      await settle();

      expect(cache.entries.size).toBe(PICTURE_LIMIT);
      // The oldest went; the newest and the one just stored stayed.
      expect(cache.has("/mtgimg/display/old-0/0")).toBe(false);
      expect(cache.has(`/mtgimg/display/old-${SWEEP_SLACK}/0`)).toBe(false);
      expect(cache.has(`/mtgimg/display/old-${SWEEP_SLACK + 1}/0`)).toBe(true);
      expect(cache.has("/mtgimg/display/new/0")).toBe(true);
    });

    it("does not sweep a cache that is within its slack", async () => {
      const page = enginePage({ "/display/new/0": { kind: "uri", uri: URI } });
      const { ask, caches, settle } = harness({
        files: { [URI]: picture() },
        pages: async () => [page.client],
      });
      const cache = await caches.open(PICTURE_CACHE);
      for (let at = 0; at < PICTURE_LIMIT; at++) {
        cache.entries.set(`${ORIGIN}/mtgimg/display/old-${at}/0`, picture());
      }
      await ask("/mtgimg/display/new/0");
      await settle();
      expect(cache.entries.size).toBe(PICTURE_LIMIT + 1);
    });
  });

  describe("a picture a week old", () => {
    async function aged(next: ImageSource, files: Parameters<typeof host>[0] = {}) {
      let source: ImageSource = { kind: "uri", uri: URI };
      const asked: string[] = [];
      const client: Postable = {
        postMessage(message, [port]) {
          asked.push((message as { path: string }).path);
          port.postMessage({ kind: "source", source });
        },
      };
      const h = harness({ files: { [URI]: picture(), ...files }, pages: async () => [client] });
      await h.ask(PATH);
      await h.settle();
      // A second, younger picture, so the order can be read.
      const cache = await h.caches.open(PICTURE_CACHE);
      cache.entries.set(`${ORIGIN}/mtgimg/display/younger/0`, picture());
      source = next;
      h.tick(REFRESH_AFTER_MS);
      return { ...h, cache, asked };
    }

    it("is served from the cache at once, and then asked about", async () => {
      const { ask, asked, settle } = await aged({ kind: "uri", uri: URI });
      const answer = await ask(PATH);
      await expect(answer?.text()).resolves.toBe("the bytes of a card");
      await settle();
      expect(asked).toEqual(["/display/abc/0", "/display/abc/0"]);
    });

    it("is put back under a new stamp when its address has not moved — which makes it the youngest", async () => {
      const { ask, cache, network, settle } = await aged({ kind: "uri", uri: URI });
      await ask(PATH);
      await settle();
      const stored = await cache.match(`${ORIGIN}${PATH}`);
      expect(stored?.headers.get(STORED_HEADER)).toBe(String(NOW + REFRESH_AFTER_MS));
      await expect(stored?.text()).resolves.toBe("the bytes of a card");
      expect((await cache.keys()).map(({ url }) => url)).toEqual([
        `${ORIGIN}/mtgimg/display/younger/0`,
        `${ORIGIN}${PATH}`,
      ]);
      // The same bytes: nothing was downloaded a second time.
      expect(network.asked).toHaveLength(1);
    });

    it("is replaced when Scryfall has a new picture at a new address", async () => {
      const moved = `${URI}9`;
      const { ask, cache, settle } = await aged(
        { kind: "uri", uri: moved },
        { [moved]: picture("a sharper scan") },
      );
      await ask(PATH);
      await settle();
      const stored = await cache.match(`${ORIGIN}${PATH}`);
      expect(stored?.headers.get(SOURCE_HEADER)).toBe(moved);
      await expect(stored?.text()).resolves.toBe("a sharper scan");
    });

    it("is kept as it is when the new address cannot be fetched: a stale picture beats none", async () => {
      const { ask, cache, settle } = await aged({ kind: "uri", uri: `${URI}9` });
      await ask(PATH);
      await settle();
      const stored = await cache.match(`${ORIGIN}${PATH}`);
      expect(stored?.headers.get(SOURCE_HEADER)).toBe(URI);
    });

    it("is deleted when the card has no picture any more", async () => {
      const { ask, cache, settle } = await aged({ kind: "unknown" });
      await ask(PATH);
      await settle();
      expect(cache.has(PATH)).toBe(false);
    });

    it("is not asked about before the week is out", async () => {
      const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
      const { ask, settle, tick } = harness({
        files: { [URI]: picture() },
        pages: async () => [page.client],
      });
      await ask(PATH);
      await settle();
      tick(REFRESH_AFTER_MS - 1);
      await ask(PATH);
      await settle();
      expect(page.asked).toHaveLength(1);
    });
  });

  it("answers a 503 rather than rejecting when Cache Storage itself fails", async () => {
    const broken: CachesLike = {
      open: () => Promise.reject(new Error("quota")),
      keys: async () => [],
      delete: async () => false,
    };
    const { ask } = harness({ caches: broken });
    expect((await ask(PATH))?.status).toBe(503);
  });

  it("answers the picture even when storing it fails", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const caches = new FakeCaches();
    const cache = await caches.open(PICTURE_CACHE);
    vi.spyOn(cache, "put").mockRejectedValue(new Error("QuotaExceededError"));
    const { ask } = harness({ caches, files: { [URI]: picture() }, pages: async () => [page.client] });
    const answer = await ask(PATH);
    expect(answer?.status).toBe(200);
    await expect(answer?.text()).resolves.toBe("the bytes of a card");
  });
});
