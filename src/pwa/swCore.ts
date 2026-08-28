/**
 * Everything the service worker *decides*, as functions with no globals in them.
 *
 * **This file is compiled twice** — once in the app program (`lib.dom`) and once in
 * `tsconfig.sw.json` (`lib.webworker`) — so it may only name types both libraries have. No
 * `document`, no `window`, and no `Request`: the router takes the three fields it reads, which
 * a real `Request` satisfies structurally and which a test can write as an object literal.
 *
 * The Cache Storage plumbing is deliberately *not* here. It is in `sw.ts`, it is unreachable
 * from vitest (jsdom implements no `caches` and no service worker registration at all), and it
 * is verified in a real browser by Task 8. Splitting it this way is what keeps the untestable
 * half down to about thirty lines of calls with no branches in them.
 */

/** Every shell cache this app has ever made starts with this. `staleShellCaches` is the reason
 *  it is a prefix rather than a name. */
export const SHELL_PREFIX = "grimoire-shell-";

/** One cache per build, so an activation never has to reason about which files are which. */
export function shellCacheName(buildId: string): string {
  return `${SHELL_PREFIX}${buildId}`;
}

/**
 * The shell caches that are not this build's.
 *
 * Prefix-scoped rather than "everything else": the image cache lives in the same Cache Storage
 * and is *not* per-build — evicting 256 MB of card art on every deploy would undo the whole
 * point of caching it.
 */
export function staleShellCaches(names: readonly string[], buildId: string): string[] {
  const keep = shellCacheName(buildId);
  return names.filter((n) => n.startsWith(SHELL_PREFIX) && n !== keep);
}

/** What the worker does with one request. */
export type Route = "navigation" | "shell" | "image" | "passthrough";

/** The three fields of a `Request` this reads. A real one is assignable to it. */
export interface RoutableRequest {
  url: string;
  method: string;
  mode: string;
}

/**
 * Which of the four things this request is.
 *
 * **`passthrough` is the default and it is the important one.** Every bulk feed this app
 * downloads is streamed: `default_cards` is 627 900 518 B of JSON behind 77 972 714 B of gzip,
 * and the Spellbook combo feed is 639 866 292 B framed with a measured 2.01 MB peak buffer. A
 * `fetch` handler that called `respondWith` on any of them would put the whole document through
 * the worker for no reason at all, and the failure would look like a slow ingest rather than
 * like a routing mistake. So the list of things this worker answers for is closed, and
 * everything not on it is left to the network untouched — no `respondWith`, no clone, nothing.
 *
 * `imageOrigin` is a parameter rather than a constant because it is PR 4's to decide: the
 * desktop build's `cardImageUrl` returns an `mtgimg://` URL, and the web build's will return
 * something a browser can fetch. `sw.ts` supplies it.
 */
export function routeFor(request: RoutableRequest, imageOrigin: string): Route {
  if (request.method !== "GET") return "passthrough";
  if (request.mode === "navigate") return "navigation";

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "passthrough";
  }
  if (url.origin === imageOrigin) return "image";
  // Same-origin is decided by the request's own origin, which for a subresource of this page is
  // always this page's. A miss in the shell cache falls through to the network in `sw.ts`, so
  // being generous here costs a cache lookup and never a wrong answer.
  //
  // `/wasm/` is on the list because on the web target the app *is* the wasm module: it is
  // served out of `web/public/wasm/` rather than out of the bundle, so it never gets an
  // `/assets/` path and an offline load without it is a shell that cannot open a database.
  if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/wasm/")
  ) {
    return "shell";
  }
  return "passthrough";
}
