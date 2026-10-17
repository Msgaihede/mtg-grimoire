// `packages/fake/world.ts`'s `membership.rs?raw` as the converter's esbuild must see it. Nothing
// but `.design-sync/tsconfig.json`'s alias reaches this file, and the app never compiles it.
//
// **`?raw` is Vite's, and the converter's esbuild has no loader for `.rs`.** `world.ts` reads the
// light app's Tauri host source as text, to answer `membership_elsewhere` with the very sentence
// that host sends. Storybook builds it through Vite; the converter's bundle build has a fixed
// loader table (`.svg`/`.png`/`.woff`/`.woff2`) with no config knob, and failed with "No loader
// is configured for ".rs" files". An import attribute names the loader per import instead, so
// the bundle carries the file's real text — read at every build, never a copy that could rot.
import membership from "../apps/light/src-tauri/src/membership.rs" with { type: "text" };

export default membership;
