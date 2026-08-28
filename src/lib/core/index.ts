import { browserCore } from "./browser";
import { tauriCore } from "./tauri";
import type { Core } from "./types";

export type { Core };
export { browserCore };

/**
 * Which {@link Core} implementation this build talks to. Replaced at build time by the
 * `define` in `vite.config.ts` (`"tauri"`) or `vite.web.config.ts` (`"web"`).
 *
 * **Declared here and not in `src/vite-env.d.ts`, and that is not a preference.** `npm run
 * build` type-checks *two* programs — `tsc` over `src/` and `tsc -p .storybook` — and the
 * second deliberately contains none of `src/`'s ambient declarations (its own comment says
 * so, which is why it lists `vite/client` in `types` by hand). The workbench's fake backend
 * reaches this module, so a declaration in `vite-env.d.ts` leaves the app's half green and
 * fails the build with `TS2304: Cannot find name '__CORE__'`. A `/// <reference path>` from
 * here would pull that file into both programs and is what `@typescript-eslint`'s
 * `triple-slash-reference` rule refuses. So it is declared once, in the module every program
 * that needs it already contains — a second `declare const` elsewhere would be `TS2451` the
 * moment one program held both files.
 */
declare global {
  const __CORE__: "tauri" | "web";
}

/**
 * The implementation this build talks to.
 *
 * **A `define`, not a runtime probe.** Which core is answering is a fact about the *build*,
 * and a module-level constant is what stops anything re-rendering its way into a different
 * one. Sniffing for `__TAURI_INTERNALS__` would look equivalent and is not: that global is
 * absent under vitest, where every assertion in `ipc.test.ts` expects the Tauri core.
 *
 * The unused branch folds away — `__CORE__` is replaced at build time, so the desktop entry
 * chunk never reaches the Worker and the web bundle carries no `@tauri-apps/api`. **Folded
 * away is not the same as absent from `dist/`**: Vite resolves `new Worker(new URL(…))`
 * statically, before any branch is folded, so a desktop `vite build` still *emits* the
 * Worker chunk — measured 2026-08-28, `dist/assets/db-*.js`, 1 119 bytes, referenced by
 * nothing in the entry bundle. An orphan of that size is not worth a `rollupOptions` rule.
 */
export const core: Core = __CORE__ === "web" ? browserCore : tauriCore;
