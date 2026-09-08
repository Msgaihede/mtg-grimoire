// `@/lib/core` as the converter's esbuild must see it. Nothing but
// `.design-sync/tsconfig.json`'s alias reaches this file, and the app never compiles it.
//
// **`src/lib/core/index.ts` cannot be bundled here, and the reason is a `define`.** It picks
// its implementation from `__CORE__`, which `vite.config.ts` replaces at build time; storybook
// inherits that for free, because `@storybook/react-vite` loads the root Vite config, so a
// story runs `tauriCore` over `.storybook/fake`'s `invoke`. esbuild is handed no defines at
// all, so the real module reaches `__CORE__ === "web"` as a bare global and throws
// `ReferenceError` while it is still evaluating — before any preview renders anything.
//
// Re-exporting `tauriCore` therefore restates storybook's own answer rather than inventing a
// second one. `@tauri-apps/api/core` is already aliased to the fake one rule above, so the
// `invoke` underneath this is the workbench's, which is the whole point: the compare loop
// screenshots both sides and they have to be the same picture.
//
// It buys a second thing on the way past. `@/lib/core` is a **directory**, and the converter's
// `tsconfigPathsPlugin` tries the bare stem before `/index.ts` — `existsSync` says yes to a
// folder, so esbuild is handed one to read and fails with a Windows `Incorrect function`.
// Any other `@/`-aliased directory-with-`index.ts` will land in the same hole; today this is
// the only one in `src/`.
export { tauriCore as core } from "../src/lib/core/tauri";
