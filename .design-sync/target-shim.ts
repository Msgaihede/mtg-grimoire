// `@/pwa/target` as the converter's esbuild must see it — the second half of the `__CORE__`
// problem `core-shim.ts` describes, and the half that reaches the *shipped* bundle.
//
// `isWebTarget()` reads `__CORE__` from **function** scope, so unlike `src/lib/core/index.ts`
// it survives module evaluation and throws when a component first renders. That is worse than
// a build error, because it is not only the previews that would break: `_ds_bundle.js` is what
// claude.ai/design's agent renders, and `AppShell` calls `isWebTarget()`, so every design built
// with it would die on `ReferenceError: __CORE__ is not defined`.
//
// Setting the global here is what `vite.config.ts`'s `define` does, just later — and "later"
// is soon enough precisely because the read is inside a function. The value is `"tauri"`
// because that is the define storybook renders under (its Vite builder loads the root config),
// and the compare loop's whole premise is that both sides answer the same.
//
// The real function is re-exported rather than stubbed, so if `isWebTarget` ever grows logic
// this follows it instead of quietly disagreeing.
//
// **The cover is exactly the modules aliased here, and no more.** A future `__CORE__` reader
// that no aliased module pulls in would fail again — loudly, as a `[RENDER]` root-empty with
// this same `ReferenceError` in `.render-check.json`. The remedy is another line in
// `tsconfig.json`'s `paths`, above the `@/*` wildcard.
(globalThis as Record<string, unknown>).__CORE__ ??= "tauri";

export { isWebTarget } from "../src/pwa/target";
