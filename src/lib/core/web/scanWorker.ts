import type * as ScanModule from "./grimoire_scan";
import { scannerUrls } from "./assets";
import { createScanSession, type ScanGlue } from "./scanSession";
import type { ToScanner } from "./scanProtocol";

/**
 * **The scanner's Worker — where the web app's card scanner runs, and nothing else does.**
 *
 * A Worker of its own on a module of its own (`crates/grimoire-scan`), never the database's:
 * a panic in that module ends the instance, and the instance that holds the reader's
 * collection must not be the one a camera frame can end; a read frame blocks its Worker for
 * a third of a second to more than one, and every search would queue behind it; and a WASM
 * memory only ever grows, so the hundred megabytes a session stands on are given back by
 * ending this Worker, which the page does when the reader has left the Scanner
 * (`scanner.ts`).
 *
 * **Tiny on purpose.** Everything it decides is in `scanSession.ts`, which the suite runs;
 * what is left here is what only a real Worker can do — `worker.ts`'s arrangement, and the same
 * `tsc` program (`tsconfig.web-worker.json`).
 *
 * **Loaded by URL, with an origin, through a variable**, for `worker.ts`'s three reasons. The
 * build id in the path is the scanner module's own (`assets.ts`), so a deploy that changed
 * only the engine does not make a reader fetch this module again.
 */
declare const self: DedicatedWorkerGlobalScope;

const urls = scannerUrls(self.location.origin, import.meta.env.VITE_SCANNER_BUILD);

async function load(): Promise<ScanGlue> {
  const glue = (await import(/* @vite-ignore */ urls.glue)) as typeof ScanModule;
  // The module's own `start` runs here: it installs `performance.now()` as the crate's clock
  // and the panic hook that writes a panic to the console before the trap.
  await glue.default({ module_or_path: urls.wasm });
  return glue;
}

// Nothing is handed back to the page by reference: a verdict is JSON, cloned.
const session = createScanSession(load, (message) => self.postMessage(message));

self.addEventListener("message", (event: MessageEvent<ToScanner>) => {
  void session.handle(event.data);
});
