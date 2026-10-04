import { INSTALL_FAILED, isClaim, isSkipWaiting, reasonOf, type InstallFailed } from "./bridge";
import { createWorker } from "./serve";

/**
 * **The web app's service worker** (phase 5, step 5.3; the light-app spec §3.5 and §6).
 * Hand-written — no `workbox`, no `vite-plugin-pwa`.
 *
 * **It is its own `tsc` program** (`tsconfig.web-sw.json`, the `WebWorker` lib; the root program
 * leaves this one file out, as it leaves out the database Worker's) **and its own bundle**:
 * `vite.sw.ts` builds it into `dist-web/sw.js` after the web app's own build, because the list
 * below is that build's files. No other build has one, and `web:dev` registers none.
 *
 * **Everything it decides is in the four modules beside it**, which the suite runs: `shell.ts`
 * (which request is whose, and the cache's name), `pictures.ts` (a picture's path, the budget),
 * `bridge.ts` (asking the page for a picture's address) and `serve.ts` (the three jobs, over
 * fakes). What is left here is the events, which only a real worker has.
 */
declare const self: ServiceWorkerGlobalScope;

/**
 * This build's id — `shell.ts`'s `shellBuildId`: a hash of every file the build wrote but this
 * one, the host's `_headers` included though it is not precached. A build that changed nothing
 * is no update.
 */
declare const __SW_BUILD__: string;
/** What to precache: `shell.ts`'s `precacheList` of `dist-web/`, the document first. */
declare const __SW_PRECACHE__: readonly string[];

const worker = createWorker({
  build: __SW_BUILD__,
  precache: __SW_PRECACHE__,
  origin: self.location.origin,
  caches: self.caches,
  fetch: (input, init) => self.fetch(input as Request | string, init),
  async pages(clientId) {
    const asked = clientId ? await self.clients.get(clientId) : undefined;
    if (asked) return [asked];
    // A request no page is known to have made — a picture's address opened in a tab of its own.
    // Any window of the app may hold the engine, a hard-reloaded one included.
    return self.clients.matchAll({ type: "window", includeUncontrolled: true });
  },
  now: () => Date.now(),
});

/**
 * **A new build installs and then waits** — nothing here skips the wait. While any page of the
 * old build is open the browser keeps this worker `waiting`, the old one goes on answering from
 * its own cache, and the page's bar is the only thing that sends the message below. A first
 * install has no old worker to wait for, and activates by itself.
 */
self.addEventListener("install", (event) => {
  event.waitUntil(
    worker.install().catch(async (error: unknown) => {
      // **Said to the pages before it is let fail.** The browser drops a worker whose install
      // rejects and tells nobody why; the page then runs with no worker and no pictures. Driven
      // on 2026-10-04: `caches.open` threw `UnknownError` under a long profile path on Windows,
      // and the page said nothing at all. What the page prints is `../update.ts`'s.
      const message: InstallFailed = { kind: INSTALL_FAILED, reason: reasonOf(error) };
      try {
        const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const page of pages) page.postMessage(message);
      } catch {
        // No page could be told; the page's own watch still says that it failed.
      }
      throw error;
    }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    // The housekeeping never rejects (`serve.ts`), and the `finally` is for the day it does:
    // **the claim follows whatever the housekeeping did.** Behind a failed `caches.keys()` it
    // was a first visit's page never taken, for the sake of a cache that was not deleted.
    worker.activate().finally(() =>
      // **Claimed on every activation, the first included.** On a first visit it is what puts
      // the page already open under this worker without a reload, so the pictures it asks for
      // from then on are answered here; after the reader's press it is what makes every open
      // page hear `controllerchange`. The page's own guard keeps the first of those from being
      // a reload (`../update.ts`).
      self.clients.claim(),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const answer = worker.respond(event.request, event.clientId, (work) => {
    try {
      event.waitUntil(work);
    } catch {
      // The event had already finished; the work goes on for as long as the worker does.
    }
  });
  // No `respondWith` for a request that is not this worker's: it goes to the network as if
  // there were no worker, which for a 78 MB card file is the point.
  if (answer) event.respondWith(answer);
});

self.addEventListener("message", (event) => {
  // The reader pressed the bar. The one way a waiting build takes over while a page is open.
  if (isSkipWaiting(event.data)) void self.skipWaiting();
  // A page nothing controls — a hard reload — asking to be taken. Only the active worker may
  // claim; asked of one that is not, the refusal is nobody's to hear.
  else if (isClaim(event.data)) event.waitUntil(self.clients.claim().catch(() => undefined));
});
