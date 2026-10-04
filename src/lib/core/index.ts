import { deferredCore, refusedCore } from "./deferred";
import { tableCore } from "./table";
import { tauriCore } from "./tauri";
import type { CallArgs, CallOptions, Core } from "./types";

export type { CallArgs, CallOptions, Core };

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
 */
export const core: Core =
  import.meta.env.MODE === "web"
    ? deferredCore(() =>
        import("./web").then(
          (host) => host.webCore,
          () => refusedCore(HOST_UNLOADED),
        ),
      )
    : pickCore(globalThis);
