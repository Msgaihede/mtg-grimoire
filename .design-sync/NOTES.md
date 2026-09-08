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
- **[GENERAL] `__CORE__` is a Vite `define`, and esbuild is handed no defines — so every module
  that reads it needs an alias in `.design-sync/tsconfig.json`.** Storybook never sees this:
  `@storybook/react-vite` loads the root `vite.config.ts`, so a story gets the define for free.
  The converter's esbuild does not, and the failure has **two shapes** because the two readers
  differ in scope, which is why one shim was not enough:
  - `src/lib/core/index.ts` reads `__CORE__` at **module scope**, so it throws
    `ReferenceError: __CORE__` while still evaluating — before any preview renders.
    `.design-sync/core-shim.ts` re-exports `tauriCore`, which is the implementation storybook
    itself lands on, so the compare loop is comparing like with like.
  - `src/pwa/target.ts`'s `isWebTarget()` reads it from **function** scope, so it survives module
    evaluation and throws on first render. That one reaches the *shipped* bundle: `AppShell`
    calls it, so every design built on claude.ai/design would have died the same way.
    `.design-sync/target-shim.ts` sets the global (`"tauri"`, matching storybook) and re-exports
    the real function.
  Both aliases must sit **above** the `@/*` wildcard, same first-match rule as the other three.
  **The cover is exactly the modules aliased, and no more** — a future `__CORE__` reader that no
  aliased module pulls in fails again, loudly, as a `[RENDER]` root-empty with that
  `ReferenceError` in `.render-check.json`. Remedy is another `paths` line, not a code change.
- **`@/lib/core` is a *directory*, and that is a second trap in the same line.** The converter's
  `tsconfigPathsPlugin` tries the bare stem before `/index.ts`, and `existsSync` says yes to a
  folder — esbuild is handed a directory to read and fails with a Windows `Incorrect function`.
  Aliasing to `core-shim.ts` steps over it. Any other `@/`-aliased directory-with-`index.ts`
  lands in the same hole; today this is the only one in `src/`.

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
- **`[TOKENS_MISSING]` `--dnd-transition`, `--dnd-translate`, `--dnd-scale`,
  `--dnd-transform-origin`** — triaged 2026-09-08, not a defect and nothing to define.
  `src/index.css:562–583` only ever *reads* them, and the guards there are
  `[data-dnd-dragging][style*='--dnd-scale']`: dnd-kit writes them **inline on the dragged
  element** at drag time. That is the "vars a component sets at runtime" case the warning text
  itself calls expected. They are also unreachable in a static render — nothing on
  claude.ai/design is mid-drag — so do **not** answer this with `cfg.tokensPkg`/`tokensGlob`;
  defining them in a stylesheet would give a resting element drag transforms it should not have.
- **`[TITLE_UNMAPPED]` 61 dropped titles** is the deliberate scope, not a discovery failure — see
  the `titleMap` bullet under Config decisions. It is expected to grow as the app gains feature
  pages; only investigate a name here that is a genuine reusable primitive.
- **`[RENDER_THIN]` on `GrimoireMark`** ("mounts have no text and paint nothing") — triaged
  2026-09-08, **false positive, do not author an owned preview for it.** The heuristic's
  `allHollow` test counts *text nodes*, and `GrimoireMark` is a pure SVG logo that has none by
  construction. The rest of its own row contradicts the sentence: `blank:false`, `rootEmpty:false`,
  `bad:false`, `variantsIdentical:false`, 42 KB of PNG. The card was opened and shows seven gold
  grimoire-book variants (`Large`, `TitleBarSize`, `TakesItsColourFromTheParent`, …) rendering
  correctly. Any text-free icon component added later will trip this the same way.
- **`[RENDER_THIN]` on `TitleBar`** ("variants render identically") — triaged 2026-09-08, true but
  harmless. Its row is `thin:false`, `bad:false`, and all six variants read `MTG GRIMOIRE`: the
  stories differ by window state and button behaviour, and the window controls sit **past the
  right edge of the capture width**, so nothing that separates them paints. Confirmed while
  grading — the `Default` and `Each Button Acts On The Window` raws are identical on the
  *storybook* side too, so this is the stories' nature, not a preview defect.

## `conventions.md` drift found on 2026-09-08 — fixed

The header is human-owned and is re-validated against the fresh build on every sync. One claim
had rotted; **Markus chose to correct it on 2026-09-08** and the header now simply says to use the
`font-sans` utility:

- **"Tailwind never compiles a `.font-sans` rule — verified absent from the shipped CSS on
  2026-08-24" is no longer true.** `src/features/card/CardDetailModal.tsx:619` now writes
  `className="… font-sans …"`, so the built CSS carries
  `.font-sans{font-family:Geist Variable,sans-serif}`. The advice that follows it — return to body
  type with `style={{ fontFamily: "var(--font-sans)" }}` because "the token ships, the utility does
  not" — therefore recommends an inline-style workaround for something a class now does.
  Everything else in the header re-verified clean: all 9 utility families, all 8 core tokens, the
  three domain token families, the `--color-muted: var(--color-surface)` alias the trap warning
  rests on, and all 6 bundle-only exports (`GrimoirePreviewProvider`, `GrimoireWorld`, `ManaChip`,
  `ManaValueChips`, `LayoutToggle`, `ResetAll`).
- **The lesson is the claim's shape, not its content.** "Verified absent" is a fact about a *tree*
  — one `className` in one feature file flipped it, in a file nobody thought of as design-system
  surface. Prefer "use `font-sans`" over asserting what Tailwind did not compile.

## Playwright: set `DS_CHROMIUM_PATH`, the download does not work here

**The driver's render check and `compare.mjs` both need a browser, and `npx playwright install`
fails on this machine** — `cdn.playwright.dev` times out at 30 s per asset (measured twice on
2026-09-08). `.ds-sync`'s playwright is **1.63.0, which wants chromium build 1243**; what is
installed under `~/AppData/Local/ms-playwright/` is 1223 / 1228 / 1234. So a bare driver run dies
at the validate stage with `[RENDER_SKIPPED] … Executable doesn't exist … chromium_headless_shell-1243`,
which fails `ok` and skips capture entirely.

Both scripts honour an override (`package-validate.mjs:440`, `compare.mjs:293`, `probe.mjs:86`).
Export it before every driver or compare run:

    export DS_CHROMIUM_PATH="C:/Users/Markus/AppData/Local/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-win64/chrome-headless-shell.exe"

Build 1234 against playwright 1.63 was launch-tested both headless-shell and full-chromium on
2026-09-08 — both fine, so the nine-build gap costs nothing. **`npx playwright install` reports
success through a pipe**: it exits non-zero but `| tail` returns tail's 0, so check the log text,
not `$?`.

## Re-sync risks — what to watch

- **The `types` field in `package.json` is load-bearing and looks like a stray.** If someone
  removes it as unused, the next sync writes zero components and says it succeeded.
- **`.design-sync/entry.ts` is a hand-maintained list.** A component added to `src/components/`
  with stories will appear in the roster (titles drive it) but resolve to nothing in the bundle
  unless its module is added here. Symptom: `[TITLE_UNMAPPED]`.
- **`cfg.storyImports.shim` and `preview-runtime.tsx`'s re-exports are one mechanism in two
  files.** Adding a shim pattern without adding the matching re-export produces the silent
  `undefined`-call failure described above. Keep them in step.
- **The synced set is a deliberate scope, not a discovery failure** — the reusable primitives and
  shell, with every feature-page title excluded by a `titleMap` null. Widening it means removing
  those nulls *and* adding the modules to the barrel. **No count is written here on purpose**:
  this bullet said "14 of 34" until 2026-09-08, when the build emitted 21 components against 104
  storybook titles and both halves were wrong. `find ds-bundle/components -mindepth 2 -maxdepth 2
  -type d | wc -l` answers the first; the reference storybook's `index.json` answers the second.
- **`.design-sync/tsconfig.json`'s `paths` is the whole `__CORE__` fence.** Two of its five rules
  point at shims that exist only for that define (see the trap above). Deleting one, or letting it
  drift below the `@/*` wildcard, breaks previews *and* the shipped bundle.
- **`AppShell.tsx`'s owned preview copies `compose` verbatim from the generated wrapper.** If the
  converter's story composition changes, diff the generated twin
  (`.design-sync/.cache/previews/AppShell.tsx`) against it.
- Only `AppShell` uses `parameters.fake` today. If another story starts to, it needs the same
  owned-preview treatment or it will render the default `starter` world.
