import { ASK_TIMEOUT_MS, askPages, type Postable } from "./bridge";
import {
  isFetchable,
  isStale,
  overBudget,
  PICTURE_CACHE,
  PICTURE_LIMIT,
  SOURCE_HEADER,
  STORED_HEADER,
  SWEEP_SLACK,
  type CacheLike,
  type CachesLike,
  type PictureAsk,
} from "./pictures";
import { DOCUMENT, routeFor, shellCacheName, staleShells, type Routable } from "./shell";

/**
 * **Everything the service worker does, with the worker left out** — its caches, its `fetch`, its
 * pages and its clock are handed in, so the suite drives an install, an activation and every kind
 * of request over fakes (`serve.test.ts`). `sw.ts` is the hand-in, and has no branch of its own.
 *
 * Compiled twice, like the modules it reads: by the root program for the suite, and by
 * `tsconfig.web-sw.json` under the `WebWorker` lib for the worker.
 */

/** What the worker is given of the world. */
export interface WorkerEnv {
  /** This build's id: the shell cache is named for it (`shell.ts`). */
  build: string;
  /** What to precache — `shell.ts`'s `precacheList` of the build's files, the document first. */
  precache: readonly string[];
  /** The worker's own origin. */
  origin: string;
  caches: CachesLike;
  /** The network. Handed the request itself where there is one, so its headers go with it. */
  fetch(input: Routable | string, init?: FetchInit): Promise<Response>;
  /**
   * Who to ask where a picture is: the page that made the request, or — when no page is known
   * to have made it — every window of the app.
   */
  pages(clientId: string): Promise<readonly Postable[]>;
  /** Unix milliseconds. */
  now(): number;
  /** How long a page is given to answer; `bridge.ts`'s bound unless a test shortens it. */
  askTimeoutMs?: number;
}

/** The two `fetch` options this worker sets. */
export interface FetchInit {
  cache?: "no-cache";
  mode?: "cors";
  credentials?: "omit";
}

/** The worker's three jobs. `sw.ts` wires each to its event. */
export interface Served {
  /** Precache this build's shell. Rejects — failing the install — unless every file arrived. */
  install(): Promise<void>;
  /** Delete every other build's shell. Runs when this worker takes over, never before. */
  activate(): Promise<void>;
  /**
   * The answer to one request, or `null` for a request that is not this worker's — which gets no
   * `respondWith` at all. `later` is the event's `waitUntil`: work that outlives the answer.
   */
  respond(
    request: Routable,
    clientId: string,
    later: (work: Promise<unknown>) => void,
  ): Promise<Response> | null;
}

/** What asking for a picture that is not cached came to. Data, so every waiter builds its own response. */
type Got =
  | { kind: "picture"; bytes: ArrayBuffer; type: string; source: string; storedAt: number }
  | { kind: "placeholder"; svg: string }
  | { kind: "refused"; status: number; reason: string };

/**
 * A refusal, as the page's `<img>` and a reader of the network panel each need it.
 *
 * **The statuses are the desktop protocol's** (`image-cache.md`): **502** for a picture that
 * could not be fetched, **503** for one that cannot be had *right now* — there a rate limit, here
 * also an engine that is not answering — and a 404 for a path that names no picture. To an
 * `<img>` every one of them is the same `error` event, which is what `useImageRetry` heals on
 * its 30 s ladder; the number is for whoever reads the request. **Never stored, and `no-store`**:
 * a refusal is about this moment.
 */
function refusal(status: number, reason: string): Response {
  return new Response(reason, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      // The floor `useImageRetry` waits anyway. A page cannot read it; a person can.
      ...(status === 503 ? { "Retry-After": "30" } : {}),
    },
  });
}

/**
 * A picture as it is stored and as it is served: **a response built from the bytes**, never the
 * one `fetch` returned.
 *
 * A page's `img-src` is checked against the *response's* URL even when a service worker answered
 * (measured for the hosting step, Chrome 154): Scryfall's own response, passed through or kept
 * as it came, is a cross-origin picture to that check, while one built here carries no URL of
 * its own and takes the request's. It is also what lets the stamp and the source ride on the
 * stored entry, and `Content-Length` say the size the body was measured at.
 */
function pictureResponse(bytes: ArrayBuffer, type: string, source: string, storedAt: number): Response {
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": type,
      "Content-Length": String(bytes.byteLength),
      [STORED_HEADER]: String(storedAt),
      [SOURCE_HEADER]: source,
    },
  });
}

function answerOf(got: Got): Response {
  switch (got.kind) {
    case "picture":
      return pictureResponse(got.bytes, got.type, got.source, got.storedAt);
    case "placeholder":
      // The one 200 whose content is meant to change — a card gains a picture at a later sync —
      // so it is never stored and says so, as the desktop's placeholder does.
      return new Response(got.svg, {
        status: 200,
        headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" },
      });
    case "refused":
      return refusal(got.status, got.reason);
  }
}

export function createWorker(env: WorkerEnv): Served {
  const shell = shellCacheName(env.build);
  const precached = new Set(env.precache);
  const timeout = env.askTimeoutMs ?? ASK_TIMEOUT_MS;

  /**
   * One ask per picture at a time. A wall mounts the same card twice, a frame that hears nothing
   * asks again with a mark (`CardImage`), and a retry can land while the first ask is still
   * waiting on the engine: each joins the ask in flight — the desktop cache's per-key
   * single-flight, for its reason.
   */
  const asking = new Map<string, Promise<Got>>();
  /** Stale pictures being refreshed, so a wall of hits on one picture starts one refresh. */
  const refreshing = new Set<string>();
  /**
   * How many pictures the cache is believed to hold: counted once, from the cache, the first
   * time this worker stores one, and kept by addition since. **Believed** — a clear from
   * Settings empties the cache behind it — and never trusted: it only decides *when* to sweep,
   * and a sweep reads the cache's own keys.
   */
  let held: number | undefined;
  let sweeping: Promise<void> = Promise.resolve();

  async function install(): Promise<void> {
    // Fetched whole before anything is written: a build half in the cache is a page that
    // boots offline into whichever half it has.
    const files = await Promise.all(
      env.precache.map(async (path) => {
        // Revalidated, never taken from the HTTP cache on trust: a stale document there would
        // name the last build's files, and this cache would pair it with this build's.
        const response = await env.fetch(path, { cache: "no-cache" });
        if (!response.ok) throw new Error(`${path} answered ${response.status}`);
        // A host that hands the document to any path it does not know answers a missing script
        // with a 200 of HTML. Refused here, so a broken deploy fails this install — and the
        // build the reader already has goes on working — rather than being installed.
        const html = (response.headers.get("Content-Type") ?? "").includes("text/html");
        if (html && path !== DOCUMENT && !path.endsWith(".html")) {
          throw new Error(`${path} answered a document, not the file`);
        }
        // A response that followed a redirect may not answer a navigation; rebuilt, it may.
        const kept = response.redirected
          ? new Response(response.body, { status: response.status, headers: response.headers })
          : response;
        return [path, kept] as const;
      }),
    );
    const cache = await env.caches.open(shell);
    try {
      await Promise.all(files.map(([path, response]) => cache.put(path, response)));
    } catch (error) {
      await env.caches.delete(shell);
      throw error;
    }
  }

  async function activate(): Promise<void> {
    const names = await env.caches.keys();
    await Promise.all(staleShells(names, env.build).map((name) => env.caches.delete(name)));
  }

  /**
   * One of this build's files: **this build's cache first, then the network — and whatever the
   * network says is the answer.** Never the document for a file: a 404 stays a 404.
   */
  async function fromShell(key: string, request: Routable): Promise<Response> {
    const cache = await env.caches.open(shell);
    return (await cache.match(key, { ignoreVary: true })) ?? env.fetch(request);
  }

  /** Count one stored picture, and sweep the oldest away once the cache is past its slack. */
  function stored(cache: CacheLike): Promise<void> {
    sweeping = sweeping
      .then(async () => {
        held = held === undefined ? (await cache.keys()).length : held + 1;
        if (held <= PICTURE_LIMIT + SWEEP_SLACK) return;
        const keys = (await cache.keys()).map((entry) => entry.url);
        const gone = overBudget(keys);
        await Promise.all(gone.map((key) => cache.delete(key, { ignoreVary: true })));
        held = keys.length - gone.length;
      })
      // The chain must never be a rejected promise, or one failed sweep is the last.
      .catch(() => undefined);
    return sweeping;
  }

  /** Fetch a picture from its address. A failure is a refusal, never a throw. */
  async function download(uri: string): Promise<Got> {
    if (!isFetchable(uri)) {
      return { kind: "refused", status: 502, reason: "The picture's address is not Scryfall's." };
    }
    let response: Response;
    try {
      // With CORS, and Scryfall answers `Access-Control-Allow-Origin: *`: the response is
      // readable, so its status is real and its bytes can be measured and rebuilt.
      response = await env.fetch(uri, { mode: "cors", credentials: "omit" });
    } catch {
      // Offline, or a host that did not answer: what the retry ladder is for.
      return { kind: "refused", status: 502, reason: "The picture could not be fetched." };
    }
    if (!response.ok) {
      return response.status === 429
        ? { kind: "refused", status: 503, reason: "Scryfall asked for a pause." }
        : { kind: "refused", status: 502, reason: `Scryfall answered ${response.status}.` };
    }
    try {
      return {
        kind: "picture",
        bytes: await response.arrayBuffer(),
        type: response.headers.get("Content-Type") ?? "image/webp",
        source: uri,
        storedAt: env.now(),
      };
    } catch {
      // The connection dropped mid-body.
      return { kind: "refused", status: 502, reason: "The picture could not be fetched." };
    }
  }

  async function keep(
    cache: CacheLike,
    ask: PictureAsk,
    got: Got,
    later: (work: Promise<unknown>) => void,
  ): Promise<void> {
    if (got.kind !== "picture") return;
    try {
      await cache.put(ask.key, pictureResponse(got.bytes, got.type, got.source, got.storedAt));
      later(stored(cache));
    } catch {
      // A full quota: the picture is still answered, it is only not kept.
    }
  }

  /** A picture that is not in the cache: ask where it is, fetch it, keep it. */
  async function obtain(
    cache: CacheLike,
    ask: PictureAsk,
    clientId: string,
    later: (work: Promise<unknown>) => void,
  ): Promise<Got> {
    const asked = await askPages(await env.pages(clientId), ask.path, timeout);
    if (asked.kind !== "source") {
      // No page, a page that did not answer, or one whose engine refused: nothing is known
      // about the picture, only that it cannot be had now.
      const reason =
        asked.kind === "refused" ? asked.message : "The card engine did not answer in time.";
      return { kind: "refused", status: 503, reason };
    }
    const { source } = asked;
    if (source.kind === "unknown") return { kind: "refused", status: 404, reason: "No such card." };
    if (source.kind === "missing") return { kind: "placeholder", svg: source.svg };
    const got = await download(source.uri);
    await keep(cache, ask, got, later);
    return got;
  }

  /**
   * A week-old picture, after it was served: ask what its address is now. The same address puts
   * the same bytes back under a new stamp — which is the used-stamp, and moves it to the young
   * end of the cache — and a new one fetches the new picture. Anything short of an answer leaves
   * the entry alone for the next hit to try: a stale picture beats none.
   */
  async function refresh(
    cache: CacheLike,
    ask: PictureAsk,
    clientId: string,
    had: Response,
  ): Promise<void> {
    if (refreshing.has(ask.key)) return;
    refreshing.add(ask.key);
    try {
      const asked = await askPages(await env.pages(clientId), ask.path, timeout);
      if (asked.kind !== "source") return;
      const { source } = asked;
      if (source.kind !== "uri") {
        // The card is gone, or lost its picture: the stored one is of nothing.
        await cache.delete(ask.key, { ignoreVary: true });
        return;
      }
      if (source.uri === had.headers.get(SOURCE_HEADER)) {
        const type = had.headers.get("Content-Type") ?? "image/webp";
        await cache.put(ask.key, pictureResponse(await had.arrayBuffer(), type, source.uri, env.now()));
        return;
      }
      const got = await download(source.uri);
      if (got.kind === "picture") {
        await cache.put(ask.key, pictureResponse(got.bytes, got.type, got.source, got.storedAt));
      }
    } catch {
      // A refresh is a courtesy; the picture already went out.
    } finally {
      refreshing.delete(ask.key);
    }
  }

  async function picture(
    ask: PictureAsk,
    clientId: string,
    later: (work: Promise<unknown>) => void,
  ): Promise<Response> {
    const cache = await env.caches.open(PICTURE_CACHE);
    // Cache first, and the engine is not asked: a picture already here is drawn offline, in a
    // second tab, and while an ingest holds the one connection.
    const hit = await cache.match(ask.key, { ignoreVary: true });
    if (hit) {
      if (isStale(hit.headers.get(STORED_HEADER), env.now())) {
        later(refresh(cache, ask, clientId, hit.clone()));
      }
      return hit;
    }
    let going = asking.get(ask.key);
    if (!going) {
      going = obtain(cache, ask, clientId, later).finally(() => asking.delete(ask.key));
      asking.set(ask.key, going);
    }
    return answerOf(await going);
  }

  return {
    install,
    activate,
    respond(request, clientId, later) {
      const route = routeFor(request, env.origin, precached);
      switch (route.kind) {
        case "passthrough":
          return null;
        case "navigation":
          // Every place is the one document, and it is this build's: a reload under a waiting
          // update is the same app, which is what keeps a reload from being an update.
          return fromShell(DOCUMENT, request);
        case "shell":
          return fromShell(route.key, request);
        case "not-a-picture":
          return Promise.resolve(refusal(404, "Not a picture."));
        case "picture":
          return picture(route.ask, clientId, later).catch(() =>
            // Cache Storage itself failed. A rejected `respondWith` is a network error on the
            // frame, which is also an `error` event — but this one says why.
            refusal(503, "The picture cache could not be read."),
          );
      }
    },
  };
}
