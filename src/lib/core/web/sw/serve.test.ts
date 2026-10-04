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
import { createWorker, PRECACHE_LANES, type WorkerEnv } from "./serve";
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

  /**
   * An HTTP/1.1 host: six connections, and one is free again only when the body on it has been
   * read to its end. Measured against a host serving the shell `no-store` (Chrome 154): an
   * install that started every fetch and read no body until all had answered held all six with
   * unread bodies, 7 of 42 requests reached the server, and the worker stayed `installing`.
   */
  function sixSockets(paths: readonly string[]) {
    let free = 6;
    let unread = 0;
    let peak = 0;
    const queued: (() => void)[] = [];
    const asked: string[] = [];
    const fetch = async (input: Routable | string): Promise<Response> => {
      const path = typeof input === "string" ? input : input.url;
      if (free > 0) free -= 1;
      else await new Promise<void>((turn) => queued.push(turn));
      asked.push(path);
      unread += 1;
      peak = Math.max(peak, unread);
      const type = path.endsWith(".js") ? "text/javascript" : "text/html";
      const response = new Response(`the bytes of ${path}`, { headers: { "Content-Type": type } });
      const read = response.arrayBuffer.bind(response);
      Object.defineProperty(response, "arrayBuffer", {
        value: async () => {
          const bytes = await read();
          unread -= 1;
          const next = queued.shift();
          if (next) next();
          else free += 1;
          return bytes;
        },
      });
      return response;
    };
    return { fetch, asked, peak: () => peak, expected: paths.length };
  }

  it("installs through a host with six connections that frees one only when a body is read", async () => {
    const precache = ["/", ...Array.from({ length: 41 }, (_, at) => `/assets/chunk-${at}.js`)];
    const sockets = sixSockets(precache);
    const { worker, caches } = harness({ precache, fetch: sockets.fetch });

    const outcome = await Promise.race([
      worker.install().then(() => "installed"),
      new Promise((done) => setTimeout(() => done("still installing"), 2_000)),
    ]);

    expect(outcome).toBe("installed");
    expect(sockets.asked).toHaveLength(42);
    const shell = caches.named.get(shellCacheName("aaaa"));
    expect(shell?.entries.size).toBe(42);
    await expect((await shell?.match("/assets/chunk-40.js"))?.text()).resolves.toBe(
      "the bytes of /assets/chunk-40.js",
    );
  });

  it("fetches a few files at a time, and reads each before it takes the next", async () => {
    const precache = ["/", ...Array.from({ length: 20 }, (_, at) => `/assets/chunk-${at}.js`)];
    const sockets = sixSockets(precache);
    const { worker } = harness({ precache, fetch: sockets.fetch });
    await worker.install();
    // Never more unread bodies than lanes — and fewer lanes than the host has connections, so
    // the page's own requests still have one to arrive on.
    expect(sockets.peak()).toBe(PRECACHE_LANES);
    expect(PRECACHE_LANES).toBeLessThan(6);
  });

  it("writes nothing unless every file arrived, however far the others had got", async () => {
    const precache = ["/", ...Array.from({ length: 12 }, (_, at) => `/assets/chunk-${at}.js`)];
    const files: Record<string, string> = { "/": "<html></html>" };
    for (const path of precache.slice(1)) files[path] = "console.log()";
    delete files["/assets/chunk-9.js"];
    const { worker, caches, network } = harness({ precache, files });

    await expect(worker.install()).rejects.toThrow("/assets/chunk-9.js answered 404");
    expect(caches.named.has(shellCacheName("aaaa"))).toBe(false);
    // And the lanes stopped taking files once one had failed.
    expect(network.asked.length).toBeLessThan(precache.length);
  });

  it("keeps each file as it was served, under headers that describe the body it holds", async () => {
    const gzipped = new Response("console.log('a')", {
      headers: {
        "Content-Type": "text/javascript",
        "Content-Encoding": "gzip",
        "Content-Length": "9",
        "Cache-Control": "no-cache",
      },
    });
    const { worker, caches } = harness({ files: { ...files, "/assets/index-a.js": gzipped } });
    await worker.install();
    const stored = await (await caches.open(shellCacheName("aaaa"))).match("/assets/index-a.js");
    // `fetch` undid the transfer's encoding: the stored body is the script, and says its length.
    expect(stored?.headers.get("Content-Type")).toBe("text/javascript");
    expect(stored?.headers.get("Content-Encoding")).toBeNull();
    expect(stored?.headers.get("Content-Length")).toBe(String("console.log('a')".length));
    await expect(stored?.text()).resolves.toBe("console.log('a')");
  });

  it("fails — so the page can be told — when Cache Storage will not open", async () => {
    // Driven on 2026-10-04: `caches.open` threw under a long profile path on Windows.
    const broken: CachesLike = {
      open: () => Promise.reject(new DOMException("Unexpected internal error", "UnknownError")),
      keys: async () => [],
      delete: () => Promise.reject(new DOMException("Unexpected internal error", "UnknownError")),
    };
    const { worker } = harness({ files, caches: broken });
    await expect(worker.install()).rejects.toThrow("Unexpected internal error");
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

  /**
   * A worker whose Cache Storage throws is still the reader's worker, and they cannot get rid of
   * it short of clearing the site's data — which takes the collection in OPFS with it. With the
   * host online, it has to be as good as no worker.
   */
  describe("when Cache Storage throws", () => {
    const broken: CachesLike = {
      open: () => Promise.reject(new DOMException("Unexpected internal error", "UnknownError")),
      keys: () => Promise.reject(new DOMException("Unexpected internal error", "UnknownError")),
      delete: () => Promise.reject(new DOMException("Unexpected internal error", "UnknownError")),
    };

    it("answers a navigation and an asset from the network", async () => {
      // The host's own history fallback: a place is answered with the document.
      const host = { ...files, "/decks/12": files["/"] };
      const { ask, network } = harness({ files: host, caches: broken });
      const page = await ask("/decks/12", "navigate");
      await expect(page?.text()).resolves.toBe("<html>build a</html>");
      const script = await ask("/assets/index-a.js", "cors");
      await expect(script?.text()).resolves.toBe("console.log('a')");
      // Each was the request itself, handed on: the host answers a place with the document.
      expect(network.asked.map(({ url }) => url)).toEqual([
        `${ORIGIN}/decks/12`,
        `${ORIGIN}/assets/index-a.js`,
      ]);
    });

    it("answers from the network when the cache opens and then will not be read", async () => {
      const caches = new FakeCaches();
      const cache = await caches.open(shellCacheName("aaaa"));
      vi.spyOn(cache, "match").mockRejectedValue(new Error("the backing store is gone"));
      const { ask } = harness({ files, caches });
      await expect((await ask("/assets/index-a.js", "cors"))?.text()).resolves.toBe(
        "console.log('a')",
      );
    });

    it("does not fail the activation — the claim comes after it", async () => {
      const { worker } = harness({ files, caches: broken });
      await expect(worker.activate()).resolves.toBeUndefined();
    });

    it("still answers a picture: asked for, fetched, and only not kept", async () => {
      const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
      const { ask } = harness({
        caches: broken,
        files: { [URI]: picture() },
        pages: async () => [page.client],
      });
      const answer = await ask("/mtgimg/display/abc/0");
      expect(answer?.status).toBe(200);
      await expect(answer?.text()).resolves.toBe("the bytes of a card");
    });
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

  /**
   * What is kept is served again for as long as the address stands — the weekly re-check puts
   * the same bytes back — so a 200 that is not a picture must never be kept as one.
   */
  describe("a 200 that is not a picture", () => {
    const refusedFor = async (response: Response) => {
      const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
      const h = harness({ files: { [URI]: response }, pages: async () => [page.client] });
      const answer = await h.ask(PATH);
      await h.settle();
      return { answer, kept: await (await h.caches.open(PICTURE_CACHE)).keys() };
    };

    it("is a 502 and is not kept when it is an error page", async () => {
      const html = new Response("<html><script>alert(document.domain)</script></html>", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
      const { answer, kept } = await refusedFor(html);
      expect(answer?.status).toBe(502);
      expect(answer?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      await expect(answer?.text()).resolves.toBe("Scryfall answered something that is not a picture.");
      expect(kept).toEqual([]);
    });

    it("is a 502 and is not kept when it is empty", async () => {
      const empty = new Response(new ArrayBuffer(0), { headers: { "Content-Type": "image/webp" } });
      const { answer, kept } = await refusedFor(empty);
      expect(answer?.status).toBe(502);
      await expect(answer?.text()).resolves.toBe("Scryfall answered an empty picture.");
      expect(kept).toEqual([]);
    });

    it("is a 502 when it says nothing of what it is, or says it is an SVG", async () => {
      // No header to pass along and nothing sniffed: a body is only ever what it declares.
      const unnamed = new Response(new Uint8Array([1, 2, 3]));
      expect((await refusedFor(unnamed)).answer?.status).toBe(502);
      const svg = new Response("<svg xmlns='http://www.w3.org/2000/svg'/>", {
        headers: { "Content-Type": "image/svg+xml" },
      });
      const { answer, kept } = await refusedFor(svg);
      expect(answer?.status).toBe(502);
      expect(kept).toEqual([]);
    });

    it("heals on the retry, once Scryfall answers the picture", async () => {
      let broken = true;
      const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
      const { ask } = harness({
        pages: async () => [page.client],
        files: {
          [URI]: () =>
            broken
              ? new Response("<html></html>", { headers: { "Content-Type": "text/html" } })
              : picture(),
        },
      });
      expect((await ask(PATH))?.status).toBe(502);
      broken = false;
      expect((await ask(`${PATH}?retry=1`))?.status).toBe(200);
    });
  });

  it("says, on everything it answers under the prefix, that the body is what it declares", async () => {
    const page = enginePage({
      "/display/abc/0": { kind: "uri", uri: URI },
      "/display/noart/0": { kind: "missing", svg: "<svg>no art</svg>" },
    });
    const { ask, caches, settle } = harness({
      files: { [URI]: picture() },
      pages: async () => [page.client],
    });
    const fresh = await ask(PATH);
    await settle();
    const hit = await ask(PATH);
    const placeholder = await ask("/mtgimg/display/noart/0");
    const unknown = await ask("/mtgimg/display/nocard/0");
    const stored = await (await caches.open(PICTURE_CACHE)).match(`${ORIGIN}${PATH}`);
    for (const response of [fresh, hit, placeholder, unknown, stored]) {
      expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  it("keeps the type the picture declared, as its essence and from the list", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const jpeg = new Response("the bytes of a card", {
      headers: { "Content-Type": "IMAGE/JPEG; charset=binary" },
    });
    const { ask } = harness({ files: { [URI]: jpeg }, pages: async () => [page.client] });
    expect((await ask(PATH))?.headers.get("Content-Type")).toBe("image/jpeg");
  });

  it("refuses a navigation to a picture's address — cached or not — and asks nobody", async () => {
    const page = enginePage({ "/display/abc/0": { kind: "uri", uri: URI } });
    const { ask, network, settle } = harness({
      files: { [URI]: picture() },
      pages: async () => [page.client],
    });
    // Not cached: no ask, no fetch.
    const cold = await ask(PATH, "navigate", "");
    expect(cold?.status).toBe(404);
    expect(cold?.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(page.asked).toEqual([]);
    expect(network.asked).toEqual([]);
    // Cached: the stored response is still not a document's to be.
    await ask(PATH);
    await settle();
    const warm = await ask(PATH, "navigate", "");
    expect(warm?.status).toBe(404);
    await expect(warm?.text()).resolves.toBe("Not a picture.");
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

    it("is deleted when the card is known and has no picture any more", async () => {
      const { ask, cache, settle } = await aged({ kind: "missing", svg: "<svg>no art</svg>" });
      await ask(PATH);
      await settle();
      expect(cache.has(PATH)).toBe(false);
    });

    it("is kept when the engine does not know the card just now", async () => {
      // After a card-data clear, or a corpus the engine replaced, every card is unknown until
      // the sync has run again. A stale picture beats none, and a later hit asks again.
      const { ask, cache, asked, settle } = await aged({ kind: "unknown" });
      await ask(PATH);
      await settle();
      expect(cache.has(PATH)).toBe(true);
      const stored = await cache.match(`${ORIGIN}${PATH}`);
      expect(stored?.headers.get(STORED_HEADER)).toBe(String(NOW));
      await ask(PATH);
      await settle();
      expect(asked).toHaveLength(3);
    });

    it("is deleted, not put back, when what was stored is not a picture this worker would keep", async () => {
      // An entry from before the type was checked, or one a page wrote: re-put with a new stamp
      // it would be that card's picture for good.
      for (const bad of [
        new Response("<html></html>", {
          headers: { "Content-Type": "text/html", [SOURCE_HEADER]: URI, [STORED_HEADER]: String(NOW) },
        }),
        new Response(new ArrayBuffer(0), {
          headers: { "Content-Type": "image/webp", [SOURCE_HEADER]: URI, [STORED_HEADER]: String(NOW) },
        }),
      ]) {
        const { ask, cache, settle } = await aged({ kind: "uri", uri: URI });
        cache.entries.set(`${ORIGIN}${PATH}`, bad);
        await ask(PATH);
        await settle();
        expect(cache.has(PATH)).toBe(false);
      }
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

  it("answers a 503 rather than rejecting when nothing can be asked and nothing is cached", async () => {
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
