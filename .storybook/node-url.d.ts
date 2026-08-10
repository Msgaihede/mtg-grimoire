/**
 * The one Node API `main.ts` uses, declared here instead of depending on `@types/node`.
 *
 * `@types/node` cannot be scoped to this directory, and that is the whole reason this file
 * exists. Ambient types are global to a *program*, and `types: []` only blocks the
 * *automatic* inclusion of `node_modules/@types/*` — it does nothing about a transitive
 * `/// <reference types="node" />` inside a dependency's declarations. Measured 2026-08-09:
 * with `@types/node` merely present in the tree, `vitest` (imported by every test under
 * `src/`) and `vite` (imported by `src/lib/iconFont.ts`) each dragged it into the app
 * program even under `"types": []`, and the damage was real and silent — `process.env.FOO`
 * type-checked clean in webview code, and the three existing `ReturnType<typeof setTimeout>`
 * handles turned from `number` into `NodeJS.Timeout`, which is the wrong runtime for a
 * WebView2 app.
 *
 * So the package stays uninstalled and this declaration — visible only to the `.storybook`
 * program, which is the only program that includes this file — carries the single function
 * `main.ts` imports. If Storybook config ever needs more of Node than this, that is the
 * moment to weigh a real dependency again, and the answer must account for the leak above.
 */
declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}
