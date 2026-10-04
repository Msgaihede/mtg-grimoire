// The web app's service worker, built and served — `vite.mobile.config.ts`'s `web` mode adds
// this one plugin and no other build has it, so `sw.js` is in `dist-web/` and never in `dist/`,
// `dist-mobile/` (the APK's) or `dist-share/`.
//
// Node's own modules in a file `tsc` never reads, like the config that imports it. What this
// decides that can be wrong is in `src/lib/core/web/sw/shell.ts` (`precacheList`, `shellBuildId`),
// where the suite covers it; what stays here is the filesystem and one nested build.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build, type Plugin } from "vite";
import { precacheList, shellBuildId, WORKER_FILE } from "./src/lib/core/web/sw/shell.ts";

/** The repository root: where this file is, whatever the working directory. */
const ROOT = fileURLToPath(new URL("./", import.meta.url));

/** The worker's entry, from the root. */
const ENTRY = "src/lib/core/web/sw/sw.ts";

/** As much of Node's `ServerResponse` as an answer written by hand needs. */
interface Answer {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string | Uint8Array): void;
}

/** Every file under `dir`, by its path from it with forward slashes. */
function filesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .map((name) => name.replaceAll("\\", "/"))
    .filter((name) => statSync(dir + name).isFile());
}

/**
 * **`sw.js`, written after the web app's own build, from what that build wrote.**
 *
 * - **After, and from the disk.** The precache list is the build's files, whose names are hashes
 *   — so only the build can say them, and only once it has written them, the public folder's
 *   copies included. `closeBundle` is the first hook that is all true in.
 * - **A build of its own**, nested: an IIFE at the output's root with a fixed name, no chunk and
 *   no hash. A worker registered as a classic script cannot import the app's chunks, and its
 *   address is the one thing in the build that must not move — the browser finds a new build by
 *   asking for this file again.
 * - **The build's id is a hash of every file in the output but the worker — path and bytes**
 *   (`shellBuildId`), the ones the precache leaves out included: a deploy that changed only the
 *   host's `_headers` is a new id, so it reaches a reader who already has the app. A browser
 *   decides there is an update by comparing this file's *bytes*, so a rebuild that changed
 *   nothing must write a byte-identical worker — a timestamp here would put "a new version is
 *   ready" in front of a reader with nothing to gain — and a build that changed one byte
 *   anywhere must not.
 * - **Only after a build that wrote its files**, which `writeBundle` is the word for. The
 *   document being on disk says nothing: Vite empties the output at `renderStart`, so a build
 *   that failed before then leaves the *last* build's document — and a worker built now would
 *   name that build's files as this one's.
 * - **A nested build that fails, fails this one**: the error leaves `closeBundle`, Vite's CLI
 *   exits non-zero, and `web:build` with it. (Settled by pointing the entry at nothing.)
 * - **The preview serves it `no-cache`**, as a host must: a worker the HTTP cache may keep is a
 *   new build found a day late. (The page also registers it with `updateViaCache: "none"`.)
 *
 * `outDir` is from the repository root, as the config that calls this spells it.
 */
export function serviceWorker(outDir: string): Plugin {
  const out = `${ROOT}${outDir}/`;
  let written = false;
  return {
    name: "web:service-worker",
    apply: (_config, { command, isPreview }) => command === "build" || isPreview === true,
    configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "/").split("?")[0];
        const onDisk = out + WORKER_FILE;
        if (path !== `/${WORKER_FILE}` || !existsSync(onDisk)) return next();
        const res = response as unknown as Answer;
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.end(readFileSync(onDisk));
      });
    },
    writeBundle() {
      written = true;
    },
    async closeBundle() {
      // `closeBundle` runs after a failed build too. One that did not write its files has no
      // list to precache, and whatever is on disk is not its own.
      if (!written || !existsSync(`${out}index.html`)) return;
      const files = filesUnder(out).filter((file) => file !== WORKER_FILE);
      const precache = precacheList(files);
      const id = shellBuildId(files.map((name) => ({ name, bytes: readFileSync(out + name) })));
      await build({
        configFile: false,
        root: ROOT,
        logLevel: "warn",
        publicDir: false,
        define: {
          __SW_BUILD__: JSON.stringify(id),
          __SW_PRECACHE__: JSON.stringify(precache),
        },
        build: {
          outDir,
          emptyOutDir: false,
          copyPublicDir: false,
          target: "es2020",
          lib: {
            entry: ENTRY,
            formats: ["iife"],
            name: "grimoireServiceWorker",
            fileName: () => WORKER_FILE,
          },
        },
      });
      console.log(`sw.js: build ${id}, ${precache.length} files precached`);
    },
  };
}
