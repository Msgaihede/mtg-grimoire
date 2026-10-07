import type * as GlueModule from "./grimoire_web";
import { wasmUrls } from "./assets";
import { createEngine, type Glue } from "./engine";
import { transferOf, type ToWorker } from "./protocol";

/**
 * **The database Worker — where the web app's engine is.**
 *
 * Not an optimisation. OPFS's synchronous access handles exist only off the main thread, so the
 * pool SQLite sits on can only be installed here; and the pool permits one connection, so there
 * is nowhere else for the database to be. Every read and every write of the web app queues
 * through this file.
 *
 * **It is its own `tsc` program** (`tsconfig.web-worker.json`, the `WebWorker` lib) and the root
 * program leaves it out, because that one has the DOM's globals and the two libraries declare the
 * same names differently. Everything it decides is in `engine.ts`, which the suite runs; what is
 * left here is what only a real Worker can do.
 */
declare const self: DedicatedWorkerGlobalScope;

/**
 * **By URL, with an origin, through a variable.** Each of the three is load-bearing:
 *
 * - *By URL and not by import*, because `dist-wasm/` is ignored and written by a build of its
 *   own. In the module graph, the desktop's and the Android app's builds would need a file only
 *   the web build has.
 * - *A variable*, because `tsc` resolves a literal specifier even inside `import()`.
 * - *An origin*, because Vite's dev server appends `?import` to a root-relative specifier it
 *   cannot read statically and then refuses the result; an absolute URL is left alone (round one,
 *   2026-08-28).
 *
 * The build id in the path is `vite.mobile.config.ts`'s, and `assets.ts` has why it is there.
 */
const urls = wasmUrls(self.location.origin, import.meta.env.VITE_ENGINE_BUILD);

async function load(): Promise<Glue> {
  const glue = (await import(/* @vite-ignore */ urls.glue)) as typeof GlueModule;
  await glue.default({ module_or_path: urls.wasm });
  return glue;
}

/**
 * Whether this browser's OPFS already holds the database's folder — asked before the engine
 * opens it, which is what creates one (`engine.ts`).
 *
 * `getDirectoryHandle` without `create` is the whole question: it answers a folder that is
 * there and throws `NotFoundError` for one that is not. Anything else — a browser with no OPFS,
 * a name that is somehow a file — is `null`, *not known*, which the page reads as nothing to
 * report. A handle on a directory locks nothing, so asking does not get in the pool's way.
 */
async function held(directory: string): Promise<boolean | null> {
  try {
    const root = await self.navigator.storage.getDirectory();
    await root.getDirectoryHandle(directory);
    return true;
  } catch (error) {
    return error instanceof DOMException && error.name === "NotFoundError" ? false : null;
  }
}

// The labels' buffer is handed over and not copied (`transferOf`); every other answer is JSON.
const engine = createEngine(
  load,
  (message) => self.postMessage(message, transferOf(message)),
  held,
);

self.addEventListener("message", (event: MessageEvent<ToWorker>) => {
  void engine.handle(event.data);
});
