/**
 * The service worker.
 *
 * **Not in the app program.** `tsconfig.json` excludes this file and `tsconfig.sw.json` compiles
 * it with `lib.webworker`, because `ServiceWorkerGlobalScope` and `FetchEvent` are declared
 * there and adding `WebWorker` to the app's `lib` would give every component the wrong `self`.
 *
 * **Everything that branches is in `swCore.ts`**, under vitest. What is left here is Cache
 * Storage plumbing with no decisions in it, and the live pass drives it in a real browser — the
 * only place it can be driven, since jsdom implements neither `caches` nor a registration.
 *
 * **The `install` handler does not skip waiting.** A new build installs and *waits*; the page
 * offers the reader a bar; only their press sends `SKIP_WAITING`. A reader who never presses it
 * keeps working on the build they started the session with (spec §5.4). `swCore.test.ts` pins
 * that this file makes that call exactly once and only after the message handler — which is
 * also why no comment in this file may spell the call with its parentheses.
 *
 * **No isolation headers are attached to anything.** Measured both ways in the spike: identical
 * results with and without COOP/COEP, so cross-origin isolation is not required and re-attaching
 * it on a cached navigation would break every cross-origin subresource for nothing.
 */
import {
  IMAGE_CACHE,
  LEDGER_KEY,
  admit,
  evictions,
  forget,
  measuredSize,
  parseLedger,
  serializeLedger,
  touch,
  withCap,
  type Ledger,
} from "./imageLedger";
import { routeFor, shellCacheName, staleShellCaches } from "./swCore";

const sw = self as unknown as ServiceWorkerGlobalScope;

const SHELL = shellCacheName(__BUILD_ID__);
/** The document every navigation is answered with. One entry, so the app is one page. */
const SHELL_DOCUMENT = "/index.html";

/**
 * Every shell lookup, and the reason none of them may be a bare Cache Storage lookup.
 *
 * (The sentence above deliberately does not spell that call: `swCore.test.ts` sweeps this
 * file's text for every lookup and demands `ignoreVary` on each, and prose is swept as
 * eagerly as code.)
 *
 * **`ignoreVary` is load-bearing, and it was found by driving a real browser.** `Cache.match`
 * honours the stored response's `Vary`, comparing the header it names on the *stored request*
 * against the incoming one. The dev/preview server answers `/assets/*` with
 * `access-control-allow-origin` and **`vary: Origin`**; the precache stores those entries
 * through `cache.addAll`, whose requests are `mode: "no-cors"`, `credentials: "omit"` and carry
 * **no `Origin` header at all**, while the page's own module-script request — Vite emits
 * `<script type="module" crossorigin>` — carries `Origin: <this origin>`. The two disagree, so
 * every single `/assets/` entry **misses**.
 *
 * Measured 2026-08-28, headless Edge 151 against a production build: with the server up the
 * miss is invisible (the `fetch` fallback is answered by the HTTP cache — `deliveryType:
 * "cache"` rather than `"cache-storage"`), and with the server stopped the navigation is served
 * from Cache Storage and every subresource fails after ~2.3 s, leaving `#root` with
 * `childElementCount: 0` — an offline shell that is a blank page.
 *
 * Ignoring `Vary` is right rather than expedient here: this cache holds one build's own static
 * files, keyed by content-hashed path, and there is no second representation of any of them for
 * a `Vary` to be choosing between.
 */
function fromShell(request: Request | string): Promise<Response | undefined> {
  return caches.match(request, { cacheName: SHELL, ignoreVary: true });
}

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // `addAll` is atomic: one 404 and the whole install fails, which is what should happen —
      // a half-precached shell is a build that boots offline into a blank page.
      await cache.addAll([...__PRECACHE__]);
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(staleShellCaches(names, __BUILD_ID__).map((n) => caches.delete(n)));
      // Claim always, not only after a skip-waiting. On a first install this is what puts the
      // page under a worker without a reload; the page's own guard is what stops that from
      // becoming a reload loop — see `useServiceWorker`.
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const route = routeFor(event.request, __IMAGE_ORIGIN__);
  // Deliberately no `respondWith` at all for a passthrough: the request goes to the network as
  // if this worker did not exist, which for a 610 MB feed is the whole point.
  if (route === "passthrough") return;

  if (route === "navigation") {
    event.respondWith(
      (async () => {
        const cached = await fromShell(SHELL_DOCUMENT);
        return cached ?? fetch(event.request);
      })(),
    );
    return;
  }

  if (route === "shell") {
    event.respondWith(
      (async () => {
        const cached = await fromShell(event.request);
        return cached ?? fetch(event.request);
      })(),
    );
    return;
  }

  event.respondWith(image(event.request));
});

/** Read the ledger out of the image cache. Every rule about it is in `imageLedger.ts`. */
async function readLedger(cache: Cache): Promise<Ledger> {
  // `ignoreVary: true` like every other lookup in this file. The ledger is written by this
  // worker with no `Vary` at all, so it changes nothing here — it is uniform because the
  // sweep that guards the two that DO need it is absolute rather than case-by-case.
  const stored = await cache.match(LEDGER_KEY, { ignoreVary: true });
  return parseLedger(stored ? await stored.text() : null);
}

/** Write it back. The one `Response` this file constructs, and the reason the rest is data. */
async function writeLedger(cache: Cache, ledger: Ledger): Promise<void> {
  await cache.put(LEDGER_KEY, new Response(serializeLedger(ledger)));
}

/** Delete what the ledger says to, and take those bytes off the count in the same step. */
async function sweep(cache: Cache, ledger: Ledger): Promise<Ledger> {
  const gone = evictions(ledger);
  await Promise.all(gone.map((url) => cache.delete(url)));
  return forget(ledger, gone);
}

/**
 * Card art: cache first, then the network, then an eviction pass.
 *
 * A miss costs one fetch and one ledger write; a hit costs a ledger write of one timestamp,
 * which is what makes the eviction order about *use* rather than about arrival. A failure
 * anywhere here answers with the network's response rather than throwing — a broken picture on
 * one tile beats a rejected `respondWith`, which is a broken picture on all of them.
 */
async function image(request: Request): Promise<Response> {
  const cache = await caches.open(IMAGE_CACHE);
  // `ignoreVary` for `fromShell`'s reason, one layer down: card art is served with CORS
  // headers too, and a stored request that carried no `Origin` would never match one that
  // does. A miss here is a re-download rather than a blank page, which is exactly why it
  // would go unnoticed.
  const hit = await cache.match(request, { ignoreVary: true });
  if (hit) {
    await writeLedger(cache, touch(await readLedger(cache), request.url, Date.now()));
    return hit;
  }

  const response = await fetch(request);
  // An `<img>` fetch is `no-cors`, so a perfectly good response is opaque: `ok` is false and
  // `status` is 0. Only a real HTTP failure is refused here, which is a `status` above zero.
  if (response.status >= 400) return response;

  const copy = response.clone();
  const bytes = measuredSize((await copy.clone().blob()).size);
  await cache.put(request, copy);
  const ledger = admit(await readLedger(cache), request.url, bytes, Date.now());
  await writeLedger(cache, await sweep(cache, ledger));
  return response;
}

sw.addEventListener("message", (event) => {
  const data = event.data as { type?: string; bytes?: number } | null;
  if (data?.type === "SKIP_WAITING") {
    // The reader pressed the bar. This is the only call to it in the file.
    void sw.skipWaiting();
    return;
  }
  if (data?.type === "SET_IMAGE_CAP") {
    // The eviction pass runs immediately, so a reader who lowers the cap sees the space come
    // back rather than waiting for the next card they happen to look at.
    event.waitUntil(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE);
        const next = withCap(await readLedger(cache), Number(data.bytes));
        await writeLedger(cache, await sweep(cache, next));
      })(),
    );
    return;
  }
  if (data?.type === "VERSION") {
    // Answered on the port the caller opened, so a live pass can tell one build from another
    // without guessing from asset hashes.
    event.ports[0]?.postMessage({ buildId: __BUILD_ID__ });
  }
});
