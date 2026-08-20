# design-sync notes — mtg-grimoire

Repo-specific gotchas for syncing this app's component layer to claude.ai/design.
Read this before touching `.design-sync/config.json`.

## What makes this repo unusual

- **It is an application, not a component library.** No `dist/`, no `main`/`module`/`exports`.
  Three files exist only to give the converter something to read, and all three are committed:
  - `.design-sync/entry.ts` — the bundle's barrel. Re-exports the real modules under `src/`.
  - `.design-sync/tsconfig.dts.json` — emits the `.d.ts` tree into `.design-sync/dist/`.
  - `.design-sync/tsconfig.json` — module resolution for the converter only.
- **`package.json` carries a `types` field solely for this.** `.design-sync/dist/.design-sync/entry.d.ts`.
  The converter finds the export list through `pkgJson.types` and nothing else; without it the
  build writes **zero components** while still exiting 0. The doubled path is real — declarations
  are emitted with `rootDir: ".."`, so the barrel lands under its own directory inside `dist/`.
- **`buildCmd` runs `tsc` before `storybook build`.** The declaration tree and the reference
  storybook must move together with `src/`; a stale `.d.ts` silently shrinks the roster.

## The sync's footprint outside `.design-sync/`

Three repo files carry sync state. All three look incidental and none is:

- **`package.json` → `"types"`** — the converter's only route to the export list. See above.
- **`eslint.config.js` → `ignores`** — `ds-bundle/`, `.ds-sync/` and `.design-sync/` are ignored
  whole. Without it `npm run lint` walks the emitted 600 KB bundle and its generated `.d.ts`
  files: **24,970 problems**, so `npm run verify` and the `frontend` CI job both go red for
  anyone who has ever run a sync, with no lintable source having changed. The reasoning is
  written out in that file.
- **`.gitignore`** — the generated half of `.design-sync/` plus `.ds-sync/` and `ds-bundle/`.

## Traps that cost a debugging cycle (fix, root cause, why it was invisible)

- **[GENERAL] The barrel must use relative specifiers, never the repo's `@/` alias.** TypeScript
  does not rewrite path aliases when emitting declarations, and the converter reads `entry.d.ts`
  through a ts-morph project that has no `paths` of its own. Every `export *` resolved to
  nothing, all 14 storybook titles dropped as `[TITLE_UNMAPPED]`, and the build reported success
  with 0 components.
- **[GENERAL] `.storybook/main.ts`'s Vite aliases have to be restated for esbuild.** The
  converter never reads that file. `.design-sync/tsconfig.json` mirrors its three exact-match
  rules — `@tauri-apps/api/core`, `@tauri-apps/api/event`, `@/lib/images` — **before** the `@/*`
  wildcard, because both resolvers take the first match. Reorder them and previews silently
  compile the real Tauri IPC (no backend outside the webview) and the real `mtgimg://` image
  URLs (which resolve to nothing on claude.ai/design).
- **[GENERAL] `preview-runtime.tsx` must re-export the whole fake surface, `core` and `scope`
  included.** `cfg.storyImports.shim` redirects every `.storybook/fake/` import to
  `window.MtgGrimoire`, and a shim can only find what the global actually exports. A story that
  pulls in `@/lib/useUpdate` or `@/lib/ipc` gets those modules compiled **from source into the
  preview**, so their `invoke` came back `undefined` and every call threw. `useUpdate`'s poll
  catches and discards its errors by design, so the page rendered a clean console, a settled
  frame, and a permanently "Checking for updates…" panel. Measured on AppShell/Settings: the
  fake's `update_status` answered correctly when called directly, which is what finally located it.
- **[GENERAL] The card html hardcodes `body{background:#fff}` and this app is dark-only.**
  `GrimoirePreviewProvider` appends a `<style>` at mount to restore the app's surface and adds
  the `dark` class, mirroring `.storybook/preview-head.html`. Scoped to the provider on purpose:
  the module ships inside `_ds_bundle.js`, and a module-scope side effect would repaint the
  design agent's own canvas. Before this, storybook rendered every story on the app's near-black
  and the preview rendered it on white — same correct component, two very different pictures.
- **Decorators cannot be bundled for this repo.** The converter's decorator bundler hardcodes
  its esbuild loaders to `.js`/`.json`, and `.storybook/preview.tsx` reaches
  `keyrune/css/keyrune.css`, whose `url()`s name a `.eot`. `cfg.provider` replaces it, which the
  skill wants before upload anyway. Do not spend time re-enabling the decorator path.

## Config decisions worth knowing

- **Scope is deliberate**: the 14 reusable primitives + shell. Every other storybook title is
  `titleMap: null` — those are whole feature pages (`Search/Page`, `Decks/Editor`, …), which sync
  fine but are near-useless as design-agent building blocks. `titleMap` keys are the title's
  **leaf segment**, so one `"Page": null` excludes all four `*/Page` titles at once.
- **`FilterChips` → `ToggleChip`.** `src/components/FilterChips.tsx` is a family module
  (`ManaChip`, `ManaValueChips`, `ToggleChip`, `LayoutToggle`, `ResetAll`) with no component of
  its own name, so the title matched no export. `ToggleChip` is the dominant export and the one
  most of the 13 chip stories exercise; all five ship in the bundle either way.
- **`AppShell` has an owned preview** (`.design-sync/previews/AppShell.tsx`) because four of its
  stories choose their backend through `parameters.fake`, which no preview wrapper can see. It
  derives the world from each story's own parameters rather than naming the four, so a story that
  gains or changes a seed is followed automatically.
- **`AppShell` renders at `viewport: "1280x800"`** — the app's narrow rung, near enough. The
  opening size is decided per monitor since 2026-08-20 (`src-tauri/src/window.rs`): 1280×**720**
  on a 1080p desk, 1920×1080 on anything with the room. The width is the one that matters to a
  shell render, and it is unchanged. At the default the shell is cropped mid-ribbon on both
  panels.

## Skipped stories, and why

- `primitives-cardimage--swap-card` — its `play` clicks "Swap card" and storybook captures the
  post-click state. No static render can reach it. `Loaded` is the canonical use.
- `chrome-appshell--update-available` — same class: the `play` clicks the gold update button and
  storybook captures the Settings view it opens. `Settings` already shows the Updates panel.
  The owned preview deliberately does not export this cell (it would report as an extra).
- `primitives-manatext--nothing` — renders `null` by design, so storybook has no root content
  either (`sb-error` on both sides).

## Known render warns (triaged — not new)

- **`[FONT_MISSING]` "MPlantin", "Garamond", "Palatino"** — not a defect and not fixable.
  **Accepted explicitly by Markus on 2026-08-10** after the evidence below; do not re-raise it as
  new on a later sync, and do not "fix" it by adding a substitute serif (that would make the
  previews stop matching the shipped app).
  `MPlantin` is `mana-font`'s card-text face for four `.ms-…` classes this app never uses;
  `src/lib/iconFont.ts` drops its `@font-face` at build time on purpose because it ships no
  woff2, and those rules already name `Garamond, Palatino, serif` as the fallback. Garamond and
  Palatino are system faces nobody ships. claude.ai/design therefore renders exactly what the
  shipped app renders. See `iconFont.ts`'s `UNUSED_FAMILY`.
- **`[REFERENCE_STALE?]`** fires whenever only design-sync harness files change
  (`preview-runtime.tsx`, config). It compares bundle mtime against `sb-reference` and cannot
  tell a harness edit from a `src/` edit. Rebuild the reference only when `src/` or the stories
  actually moved.
- **`[CSS_ASSETS]` 21 unresolvable `url()`s** — the fallback CSS is scraped from the storybook
  build, whose asset hashes do not exist post-upload. Fonts are copied separately by
  `extractFonts` and the rewrite log confirms all 21 are font URLs, which do resolve.

## Re-sync risks — what to watch

- **The `types` field in `package.json` is load-bearing and looks like a stray.** If someone
  removes it as unused, the next sync writes zero components and says it succeeded.
- **`.design-sync/entry.ts` is a hand-maintained list.** A component added to `src/components/`
  with stories will appear in the roster (titles drive it) but resolve to nothing in the bundle
  unless its module is added here. Symptom: `[TITLE_UNMAPPED]`.
- **`cfg.storyImports.shim` and `preview-runtime.tsx`'s re-exports are one mechanism in two
  files.** Adding a shim pattern without adding the matching re-export produces the silent
  `undefined`-call failure described above. Keep them in step.
- **The synced set is 14 of 34 storied components** — a deliberate scope, not a discovery
  failure. Widening it means removing `titleMap` nulls *and* adding the modules to the barrel.
- **`AppShell.tsx`'s owned preview copies `compose` verbatim from the generated wrapper.** If the
  converter's story composition changes, diff the generated twin
  (`.design-sync/.cache/previews/AppShell.tsx`) against it.
- Only `AppShell` uses `parameters.fake` today. If another story starts to, it needs the same
  owned-preview treatment or it will render the default `starter` world.
