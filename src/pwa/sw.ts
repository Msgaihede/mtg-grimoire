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
import { routeFor, shellCacheName, staleShellCaches } from "./swCore";

const sw = self as unknown as ServiceWorkerGlobalScope;

const SHELL = shellCacheName(__BUILD_ID__);
/** The document every navigation is answered with. One entry, so the app is one page. */
const SHELL_DOCUMENT = "/index.html";

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
        const cached = await caches.match(SHELL_DOCUMENT, { cacheName: SHELL });
        return cached ?? fetch(event.request);
      })(),
    );
    return;
  }

  if (route === "shell") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(event.request, { cacheName: SHELL });
        return cached ?? fetch(event.request);
      })(),
    );
    return;
  }

  // route === "image" — filled in by the image-cache task. Until then the image route falls
  // through to the network exactly as a passthrough would, which is the shipped desktop
  // behaviour.
});

sw.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === "SKIP_WAITING") {
    // The reader pressed the bar. This is the only call to it in the file.
    void sw.skipWaiting();
    return;
  }
  if (data?.type === "VERSION") {
    // Answered on the port the caller opened, so a live pass can tell one build from another
    // without guessing from asset hashes.
    event.ports[0]?.postMessage({ buildId: __BUILD_ID__ });
  }
});
