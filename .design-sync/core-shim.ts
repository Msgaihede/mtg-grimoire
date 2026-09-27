// `@/lib/core` as the converter's esbuild must see it. Nothing but
// `.design-sync/tsconfig.json`'s alias reaches this file, and the app never compiles it.
//
// **`@/lib/core` is a directory, and that is the whole reason this file exists.** The
// converter's `tsconfigPathsPlugin` tries the bare stem before `/index.ts` — `existsSync` says
// yes to a folder, so esbuild is handed one to read and fails with a Windows `Incorrect
// function`. Re-exporting the real module by its file steps over that and changes nothing
// else: `@tauri-apps/api/core` is already aliased to the fake one rule above, so the `invoke`
// underneath this is the workbench's, which is the whole point — the compare loop screenshots
// both sides and they have to be the same picture. Any other `@/`-aliased
// directory-with-`index.ts` will land in the same hole; today this is the only one in `src/`.
export { core } from "../src/lib/core/index";
