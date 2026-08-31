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
  clearImages,
  evictions,
  forget,
  ledgerWriter,
  measuredSize,
  parseLedger,
  serializeLedger,
  touch,
  withCap,
  type ImageClearReport,
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

/**
 * The one writer of the ledger, and every update in this file goes through it.
 *
 * **A raw `readLedger`/`writeLedger` pair anywhere else is the read-modify-write race back
 * again** — dozens of card tiles run their update concurrently, interleave at each `await`, and
 * all but the last write back a ledger built from a copy that predates the others.
 * `swCore.test.ts` sweeps this file's text for exactly that, and `ledgerWriter`'s comment in
 * `imageLedger.ts` carries the measurement.
 *
 * **`caches.open` is inside the two callbacks rather than captured, and that is not tidiness.**
 * `image()` re-opens the cache on every request, so a writer holding one `Cache` handle from
 * whenever it happened to be built keeps writing to that handle after the image cache is
 * deleted — by storage eviction, or by a reader clearing site data. Driven in a real browser on
 * 2026-08-29 that produced **45 images cached and the ledger missing entirely**, which is worse
 * than the bug being fixed and is invisible to every test in this repo. Opening it here costs a
 * lookup of an already-open cache and cannot go stale.
 */
const mutateLedger = ledgerWriter(
  async () => readLedger(await caches.open(IMAGE_CACHE)),
  async (ledger) => writeLedger(await caches.open(IMAGE_CACHE), ledger),
);

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
    await mutateLedger((ledger) => touch(ledger, request.url, Date.now()));
    return hit;
  }

  const response = await fetch(request);
  // An `<img>` fetch is `no-cors`, so a perfectly good response is opaque: `ok` is false and
  // `status` is 0. Only a real HTTP failure is refused here, which is a `status` above zero.
  if (response.status >= 400) return response;

  const copy = response.clone();
  const bytes = measuredSize((await copy.clone().blob()).size);
  await cache.put(request, copy);
  // Admit and sweep are one mutation, not two: a sweep computed from a ledger a concurrent
  // admit has already moved on from would evict against a stale `bytes`.
  await mutateLedger(async (ledger) =>
    sweep(cache, admit(ledger, request.url, bytes, Date.now())),
  );
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
        // Through the same queue as the image path: a cap change that raced an admit used to
        // be able to write back a ledger with that admit missing from it.
        await mutateLedger(async (ledger) =>
          sweep(cache, withCap(ledger, Number(data.bytes))),
        );
      })(),
    );
    return;
  }
  if (data?.type === "CLEAR_IMAGE_CACHE") {
    // **Settings → Local cache → Clear, on this target.** The desktop's `cache_clear`
    // sweeps `data/images/` and drops the `image_cache` rows that vouched for it; a browser
    // has neither, and the pictures are in this cache instead — so the command is diverted in
    // `src/lib/core/browser.ts` and lands here. `web::route::COMMANDS` does not move: the
    // bytes are Cache Storage's and no arm over a SQLite connection could reach them.
    //
    // Through `mutateLedger` for `SET_IMAGE_CAP`'s reason, and the reason is sharper here: a
    // clear that raced an admit and wrote back the ledger it read first would leave the
    // worker counting a picture it had just deleted, for the life of the worker. Queued, an
    // admit either lands before the read — and is cleared with everything else — or after the
    // write, with its own `cache.put` already done. Both are consistent.
    //
    // The counts escape through a closure because `mutateLedger` answers with the *ledger*
    // and this needs what the *cache* did. It is not a race — the mutation is awaited before
    // the reply — and the initialiser is unreachable rather than a fallback: a throw anywhere
    // in here rejects the whole `waitUntil` and posts nothing at all, which the caller's own
    // timeout is what covers. Nothing here is caught, because there is nothing this worker
    // could truthfully say about a Cache Storage call that failed.
    event.waitUntil(
      (async () => {
        const cache = await caches.open(IMAGE_CACHE);
        let report: ImageClearReport = { files: 0, bytes: 0, failed: 0 };
        await mutateLedger(async (ledger) => {
          const cleared = await clearImages(cache, ledger);
          report = cleared.report;
          return cleared.ledger;
        });
        // Answered on the port the caller opened, exactly as `VERSION` is — a reader who
        // pressed a button is owed the number, and a `postMessage` back to the client would
        // reach every tab rather than the one that asked.
        event.ports[0]?.postMessage(report);
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
