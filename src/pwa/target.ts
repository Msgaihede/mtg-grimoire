/**
 * Is this build the web one?
 *
 * **A build-time flag rather than a runtime sniff, and the reason is the test suite.** The
 * obvious probe is `!("__TAURI_INTERNALS__" in window)` — but jsdom has no such global either
 * (`src/lib/images.ts` says so, and eleven test files repeat it), so that probe answers "web"
 * in every one of the app's existing tests and switches on every web-only surface below. A
 * test that wants the web answer mocks this module; nothing else can reach it.
 *
 * **`__CORE__` and not a second `__WEB_TARGET__` define.** PR 4 already established exactly
 * this flag: `vite.config.ts` defines it `"tauri"` (and so, therefore, does vitest, which runs
 * on that config) and `vite.web.config.ts` defines it `"web"`. A second define would be a
 * second thing to keep in step, and the failure mode of the two disagreeing — a web bundle
 * talking to the browser core with every PWA surface switched off, or a desktop one with them
 * switched on — is silent in both directions. One flag, and the branch folds away at build
 * time exactly as `src/lib/core/index.ts`'s does.
 *
 * The global is declared once, in `src/lib/core/index.ts`; its comment says why it is there
 * and not in `src/vite-env.d.ts`, and why a second `declare const` would be `TS2451`.
 */
export function isWebTarget(): boolean {
  return __CORE__ === "web";
}
