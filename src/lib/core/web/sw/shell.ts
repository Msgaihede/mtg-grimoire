import { buildIdOf } from "../assets";
import { pictureOf, type PictureAsk } from "./pictures";

/**
 * **The app's shell in Cache Storage: its name, what goes in it, and which request is whose** —
 * everything the service worker decides about a request before it touches a cache, with no global
 * in it. Compiled twice, like `pictures.ts`, for its reason.
 */

/** Every shell cache this app has made starts with this — {@link staleShells} is why a prefix. */
export const SHELL_PREFIX = "grimoire-shell-";

/**
 * **One cache per build, named for it**, so two versions never share one: a page keeps getting
 * its own build's files from its own build's cache for as long as its worker controls it, however
 * many deploys have been installed behind it and are waiting.
 */
export function shellCacheName(build: string): string {
  return `${SHELL_PREFIX}${build}`;
}

/**
 * The shell caches that are not `build`'s — what an *activating* worker deletes.
 *
 * By prefix and not "everything else": the picture cache lives in the same Cache Storage and
 * belongs to no build.
 */
export function staleShells(names: readonly string[], build: string): string[] {
  const keep = shellCacheName(build);
  return names.filter((name) => name.startsWith(SHELL_PREFIX) && name !== keep);
}

/**
 * The key the document is cached under, and what every navigation is answered with — bar a page
 * of the build's own, such as the privacy policy (`routeFor`).
 */
export const DOCUMENT = "/";

/** The worker's own file. At the origin's root, unhashed: its scope is its folder and below. */
export const WORKER_FILE = "sw.js";

/**
 * What a build precaches, from every file it wrote (paths relative to the output folder,
 * forward slashes): **the document as `/`, and every other file by its own path.**
 *
 * - **`/` and not `/index.html`.** A static host redirects the second to the first, a redirected
 *   response may not answer a navigation, and the page is never asked for by that name anyway.
 * - **Not the worker itself**, which the browser keeps, and **not a file the host reads rather
 *   than serves** — `_headers` and its kind, and Vite's `.vite/` metadata. One 404 fails the
 *   whole install, by design (`serve.ts`), so a file listed here must be one the host answers.
 *
 * Sorted, so the list — and with it the worker's bytes — does not move with the order a
 * filesystem happened to list a folder in.
 */
export function precacheList(files: readonly string[]): string[] {
  const served = files.filter((file) => {
    if (file === WORKER_FILE || file === "index.html") return false;
    const first = file.split("/")[0];
    return !first.startsWith("_") && !first.startsWith(".");
  });
  return [DOCUMENT, ...served.map((file) => `/${file}`).sort()];
}

/**
 * A build's id: a hash of **every file the build wrote but the worker itself** — path, length
 * and bytes (`assets.ts`'s `buildIdOf`, the engine's own).
 *
 * **Every file, and not only the precached ones.** A file the host reads rather than serves —
 * `_headers`, the hosting policy — is left out of {@link precacheList} and is still part of what
 * a deploy *is*: a deploy that changed only the policy must reach a reader who already has the
 * app, and the one way anything reaches them is a worker whose bytes differ. The id is a literal
 * in the worker, so a changed `_headers` is a new worker, a new shell cache, and every file
 * fetched again past the HTTP cache — under the new headers.
 *
 * **The bytes and never the clock**: a browser finds an update by comparing the worker's bytes,
 * so a rebuild that changed nothing must write the same worker, or a reader is told a new
 * version is ready that is the one they have.
 */
export function shellBuildId(files: readonly { name: string; bytes: Uint8Array }[]): string {
  return buildIdOf(files.filter(({ name }) => name !== WORKER_FILE));
}

/** What the worker does with one request. */
export type Route =
  /** Not this worker's: no `respondWith` at all, and the request goes on as if there were none. */
  | { kind: "passthrough" }
  /**
   * A page: answered with the cached document, whatever place the path names — bar a page of the
   * build's own, such as the privacy policy, which is a `shell` route.
   */
  | { kind: "navigation" }
  /**
   * One of this build's own files: cache first, by its path — or, for a page of the build's own
   * such as the privacy policy, by the `.html` file its extensionless address names.
   */
  | { kind: "shell"; key: string }
  | { kind: "picture"; ask: PictureAsk }
  /** Under the picture prefix and not a picture — or one asked for as a page: a 404, asked of nobody. */
  | { kind: "not-a-picture" };

/** The three fields of a `Request` the router reads. A real one is assignable. */
export interface Routable {
  url: string;
  method: string;
  mode: string;
}

/**
 * Which of those a request is.
 *
 * **`passthrough` is the default, and the list of what this worker answers is closed.** The
 * engine streams a 78 MB card file and a 640 MB combo file through `fetch` from its own Worker;
 * a handler that answered either would put the whole body through this one for nothing. So a
 * request to another origin, and anything that is not a `GET`, is never touched.
 *
 * **The picture prefix is read before the mode, and a navigation under it is refused.** It is a
 * path nothing else lives under, so a picture's address opened as a page is never the app — and
 * never the picture either: a response this worker stores is served on the app's own origin,
 * beside the database, and the one way a stored body could be *run* rather than drawn is as a
 * document. A picture is drawn by an `<img>`; a tab, a frame and a link are each answered 404.
 *
 * **A same-origin file that is not a navigation is never answered with the document** — it is
 * `shell` when it is one of the build's (`/assets/`, `/wasm/` and whatever else was precached)
 * and the network's own answer otherwise. A page that asks for a script and is handed HTML fails
 * on a MIME error instead of a missing file, and that is the failure an update must not meet.
 *
 * **One navigation is not the app: a place whose `.html` this build precached.** It is a
 * document of the build's own — the privacy policy — and is answered from the shell by that
 * file's name.
 */
export function routeFor(request: Routable, origin: string, precached: ReadonlySet<string>): Route {
  if (request.method !== "GET") return { kind: "passthrough" };
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return { kind: "passthrough" };
  }
  if (url.origin !== origin) return { kind: "passthrough" };

  const picture = pictureOf(origin, url.pathname);
  if (picture !== null) {
    if (picture === "malformed" || request.mode === "navigate") return { kind: "not-a-picture" };
    return { kind: "picture", ask: picture };
  }

  const path = url.pathname;
  // A place has no extension in its last segment (`assets.ts`'s `isNavigation`, the rule the
  // preview and the host serve the document by); a file opened in a tab of its own is the file.
  const place = !path.slice(path.lastIndexOf("/") + 1).includes(".");
  if (request.mode === "navigate" && place) {
    // **A page of the build's own, at an address with no extension** — the privacy policy,
    // `privacy.html`, which the host serves at `/privacy`. Without this the reader who has the
    // app installed would be the one reader who could not open it: this worker answers every
    // extensionless navigation with the app. Asked of the precache and not of a list here, so
    // the rule is the build's: a page that is in it is served, and nothing else changes.
    const page = `${path}.html`;
    if (path !== "/" && precached.has(page)) return { kind: "shell", key: page };
    return { kind: "navigation" };
  }
  if (path.startsWith("/assets/") || path.startsWith("/wasm/") || precached.has(path)) {
    return { kind: "shell", key: path };
  }
  return { kind: "passthrough" };
}
