import { deferredCore, refusedCore } from "./deferred";
import { browserHost, tableHost } from "./host";
import { tableCore } from "./table";
import { tauriCore, tauriHost } from "./tauri";
import type { CallArgs, CallOptions, Core, Host } from "./types";

export type { CallArgs, CallOptions, Core, Host };

/**
 * The mark a host that answers through the command table sets before the page's first script
 * runs — the Android host, by `append_invoke_initialization_script`
 * (`mobile/src-tauri/src/lib.rs`'s `HOST_MARK`). **Read through {@link isTableHost} and nowhere
 * else** — by this file and by `files.ts`, both below the `Core` seam (the light-app spec §3.5); no
 * page may ask where it runs (`mobile/phone/fence.test.ts`).
 */
export const HOST_MARK = "__GRIMOIRE_CORE__";

/** Whether a window with these globals is the light host's, which answers through the table. */
export function isTableHost(scope: object): boolean {
  return (scope as Record<string, unknown>)[HOST_MARK] === "table";
}

/** Which implementation a window with these globals calls through, in a build that has Tauri. */
export function pickCore(scope: object): Core {
  return isTableHost(scope) ? tableCore : tauriCore;
}

/** Whose clipboard and whose way out a window with these globals has — {@link pickCore}'s twin. */
export function pickHost(scope: object): Host {
  return isTableHost(scope) ? tableHost : tauriHost;
}

/** What the gate is told when the web host's own chunk never arrived. */
const HOST_UNLOADED = "MTG Grimoire could not finish loading. Check your connection, then reload.";

/**
 * The implementation every command goes through — **the one place a build chooses its host** (the
 * light-app spec §3.5): Tauri's own IPC on the desktop (a typed command per name), one `core_call`
 * that names the command on the light app's Android host, and in the web app a message to the
 * database Worker.
 *
 * **Which build this is, is `import.meta.env.MODE`** — `web` is the mode `npm run web:build` and
 * `web:dev` run `vite.mobile.config.ts` in. It is not a probe: Vite replaces it at compile time,
 * as it does for the `fake` mode `mobile/main.tsx` reads, and nothing is asked of the window.
 *
 * **The comparison is written out at the `import()`, and the import is dynamic, and both are what
 * keep the web host out of every other build.** Vite bundles a Worker for each file it transforms
 * that spells `new Worker(new URL(…))`, whether or not anything runs it — so a static import of
 * `./web` would put the Worker's chunk in the desktop's `dist/` and in the `dist-mobile/` the APK
 * embeds. With the literal folded to `false` the bundler drops the branch before it follows the
 * import, and `./web` is never read. `deferredCore` is what `core` is while that chunk is on its
 * way, and `refusedCore` what it becomes if the chunk never comes.
 *
 * **Two files a browser answers on the page ride with it** (`./web/files`): the desktop's
 * `export_save_file` and `import_pick_file`, which on the other two hosts are a native dialog the
 * host opens. The engine's table has neither — a Worker has no document to pick a file with —
 * so the web host's `Core` is the Worker's with those two names answered in front of it.
 *
 * **And the card scanner rides with it** (`./web/scanner`, the light app's step 7.5): the
 * engine's table has the scanner's commands on every host, and in a browser the session cannot
 * live in the engine's Worker — so the session's commands and the two for its files are
 * answered on the page too, in front of the Worker and behind the two file names, by a Worker
 * and a module of the scanner's own. `./web` is named in the list although only `./web/scanner`
 * is read from it: the scanner's file imports the engine's `Core`, and naming it here is what
 * keeps that `Core` a chunk of its own, which the smoke runs find by name.
 */
export const core: Core =
  import.meta.env.MODE === "web"
    ? deferredCore(() =>
        Promise.all([import("./web"), import("./web/files"), import("./web/scanner")]).then(
          ([, files, scanner]) => files.answeringFiles(scanner.scanningCore),
          () => refusedCore(HOST_UNLOADED),
        ),
      )
    : pickCore(globalThis);

/**
 * The clipboard and the way out to a browser, **chosen where the `Core` is chosen and by the
 * same two questions** (the light-app spec §3.5): the web build is a browser's own two answers,
 * the light app's Android host is a browser's clipboard and Tauri's opener, and the desktop is the
 * two Tauri plugins. `@/lib/clipboard` and `@/lib/externalLinks` are the two callers; a page asks
 * through them and never learns which this is.
 *
 * **Not deferred, unlike {@link core}**: the browser's implementation spells no Worker, so there
 * is no chunk to keep out of the other builds and nothing to wait for. In the web build the
 * literal folds, `pickHost` is never called, and the two plugins fall out of the bundle with it.
 */
export const host: Host = import.meta.env.MODE === "web" ? browserHost : pickHost(globalThis);
