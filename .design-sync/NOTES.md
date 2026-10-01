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
- **[GENERAL] A story that imports a *hook* gets a second copy of it — and of the context the
  hook reads.** The converter's rule 2 redirects an import to `window.MtgGrimoire` only when it
  resolves to an exported **component's** module. `Tooltip.stories.tsx` imports `useTooltip` from
  `./useTooltip`, which is not a component, so `_preview/TooltipProvider.js` compiled its own
  `useTooltip` with its own `TooltipContext`. The bundle's `TooltipProvider` filled the bundle's
  context and the story read the other one, which answers `NO_TOOLTIP_API`: measured 2026-09-27,
  the button focused and matched `:focus-visible` and `#app-tooltip` never mounted. Fixed with a
  `cfg.storyImports.shim` entry, `/components/tooltip/useTooltip`, which needs the barrel to export
  the hook. **The tell is `createContext` in a `_preview/*.js`** —
  `grep -c createContext ds-bundle/_preview/<Name>.js` should be 0 for any module whose context
  matters. Any future story importing a context-reading hook needs its own shim line.
- **[GENERAL] `GrimoirePreviewProvider` installs keyboard modality, or no focus ring ever draws.**
  `src/index.css` redefines `focus-visible:` as `html[data-kbd] *:focus-visible` and blanks
  `html:not([data-kbd]) :focus-visible`. `data-kbd` is written by `installKeyboardModality`, which
  `main.tsx` and `.storybook/preview.tsx` both install and the provider did not until 2026-09-27 —
  so every design built on claude.ai/design showed no keyboard focus anywhere. Found grading
  Tooltip's `OnFocus`, whose reference shows the ring. Mounted in a ref-counted layout effect, not
  at module scope, for the same reason as the surface style.
- **[GENERAL] compare's reference is cropped to `#storybook-root`, so a `fixed` panel outside it
  is invisible.** Dropdown's root is its 36px trigger: the listbox its plays open sits below and
  never appears in the reference, so `Open` and `Default` photograph identically. The compare
  cannot verify an open popup at all. It was verified by hand on 2026-09-27 — real input on both
  sides, then `[role=option]` text, `aria-selected`/`aria-disabled` and listbox-to-trigger offset
  compared (identical on all five stories that open it) plus a 2x visual. Tooltip is the opposite
  case: its `Stage` is `min-h-[220px]`, so the panel lands inside the root and IS compared.
- **[GENERAL] The `?story=` capture page offsets viewport-positioned `fixed` panels by +24px.** It
  keeps the body's 24px padding gutter (deliberately — it is the graded framing) while wrapping
  the story in `.ds-single{transform:translateZ(0)}`, and a transformed ancestor is the containing
  block for `fixed`. `TooltipPanel` computes viewport coordinates, so in the grading capture its
  panel lands 24px right and down, over its own button. **The product card does not have this**:
  single mode without `?story=` zeroes the padding, and the probe measured panel centre = button
  centre = 450px with an 8px gap. `Dropdown` is immune, because `usePopupPlacement` measures a
  zero-size `fixed` probe and corrects for exactly this. Graded `close` with that note; do not
  "fix" it in the preview.
- **`@/lib/core` is a *directory*, and the converter cannot resolve one.** Its
  `tsconfigPathsPlugin` tries the bare stem before `/index.ts`, and `existsSync` says yes to a
  folder — esbuild is handed a directory to read and fails with a Windows `Incorrect function`.
  Aliasing to `core-shim.ts`, which re-exports the real module by its file, steps over it. The
  alias must sit **above** the `@/*` wildcard, same first-match rule as the other four. Any other
  `@/`-aliased directory-with-`index.ts` lands in the same hole; today this is the only one in
  `src/`. (Until 2026-09-27 the shim also covered `__CORE__`, a Vite `define` esbuild was never
  handed, and a second shim covered `@/pwa/target`; the define left with the web build.)

## Real card art — the `bundled` mode (2026-10-01)

**Until this date every card the design system drew was a synthetic SVG placeholder, and that
was deliberate rather than a gap.** The fake's only other mode, `live`, points at
`cards.scryfall.io`, and claude.ai's pages allow no remote image source — so a design built from
the bundle drew named grey frames where the app draws cards. Markus asked for the cards as the app
shows them, so the fake grew a third mode (`.storybook/fake/images.ts`):

- **`bundled` serves exactly the rows `live` would, from a folder beside the bundle.** The
  folder is `card-art/` at the design system's root, and a file's path inside it is Scryfall's
  own — `normal/<file>.jpg`, `art_crop/<file>.jpg` (`bundledArtPath`). Keyed by the Scryfall
  path and **never by the fixture id**, because the `large` seed's 5 200 minted printings copy
  their URLs from real rows under ids of their own.
- **The root is found from the bundle script's own URL** (`bundledArtRootFor`, captured from
  `document.currentScript` at the top of `preview-runtime.tsx`). `_ds_bundle.js` at the root of a
  claude.ai/design project and `components/bundle.js` in the Design System artifact — and in a
  canvas that installs it under `ds/<folder>/` — both resolve to the same `card-art/` at the
  system's root. No script URL (an ES module, which is Storybook) means no root, and no root means
  `synthetic`: never a relative `<img>` that 404s.
- **The bytes are downloaded at sync time and never committed** —
  `node .design-sync/card-art.mjs` fetches every fixture image (116 files: 58 `normal`,
  58 `art_crop`, **11.0 MB**, measured 2026-10-01) into the gitignored `.design-sync/card-art/`,
  politely, and skips what it has.
- **One fixture crop has already left Scryfall**: `A-Vivi Ornitier`'s `art_crop` (`fin A-248`, an
  Alchemy rebalance) answers **404** at the fixture's stamped URL, and Scryfall's API answers
  `not_found` for the card id. The same path without the `?` stamp still answered 200 from the
  CDN's cache, so the script retries once without the stamp on a 404 only, and says so in a
  `note` line. When that cached copy goes too the script fails loudly, and the fix is
  regenerating the fixture (`scripts/gen-storybook-cards.mjs`), not another retry. `live` mode
  draws that crop broken today.
- **The reference storybook draws the same art, or grading breaks for every card-bearing
  component.** `buildCmd` runs `.design-sync/build-reference.mjs`, which builds `sb-reference`
  with `STORYBOOK_ART=bundled`: `main.ts` mounts `.design-sync/card-art` at `/card-art` and
  `preview.tsx` opens on the Bundled toolbar item. Everywhere else — the dev workbench,
  `build-storybook`, `src/stories.test.tsx` — the default is still `synthetic`.

**Two steps the sync must now take that the skill does not know about:**

1. **After every converter build, copy the art into the output**:
   `node .design-sync/card-art.mjs --copy ds-bundle`. The converter wipes `--out` on every
   rebuild, so a copy made before the build is gone after it — and a preview then draws the app's
   own no-image frame where the reference draws the card, which fails compare loudly (good) and
   for a reason the sheet does not name (bad).
2. **Add `card-art/**` to the upload's `writes`.** The skill's fixed list
   (`components/**`, `fonts/**`, `_vendor/**`, …) does not name it, and a bundle uploaded without
   its art draws no-image frames on every card in every design. Chunk the writes: 11 MB of
   JPEGs, and the server bounds bytes per call as well as files.

**Which project the upload reaches is an open question — ask the host.** The design system this
account's canvases read is the **Design System artifact**
`https://claude.ai/code/artifact/78e3174c-a1be-4ceb-96de-5ae052092d1c`, migrated from the
claude.ai/design project on **2026-09-20**. Its README (read 2026-10-01) lists 21 components and
**not** `Dropdown`, `TooltipProvider` or `WorkInProgress`, which joined in the 2026-09-27 sync —
so that sync's upload went to `config.json`'s `projectId` and never reached the artifact. The
artifact keeps the bundle at `project/components/bundle.js` (renamed from `_ds_bundle.js`) and
its tokens in `project/tokens.json`, so a sync meant for canvases has to land there — with the art
at `project/card-art/`.

## Config decisions worth knowing

- **Scope is deliberate**: the reusable primitives and the shell (no count here; see Re-sync
  risks for the command that answers it). Every other storybook title is either
  `titleMap: null` or has no module in the barrel. The nulls are whole feature pages
  (`Search/Page`, `Decks/Editor`, …), which sync fine but are near-useless as design-agent
  building blocks. `titleMap` keys are the title's
  **leaf segment**, so one `"Page": null` excludes all four `*/Page` titles at once.
- **`FilterChips` → `ToggleChip`.** `src/components/FilterChips.tsx` is a family module
  (`ManaChip`, `ManaValueChips`, `ToggleChip`, `LayoutToggle`, `ResetAll`) with no component of
  its own name, so the title matched no export. `ToggleChip` is the dominant export and the one
  most of the 13 chip stories exercise; all five ship in the bundle either way.
- **`AppShell` has an owned preview** (`.design-sync/previews/AppShell.tsx`) because four of its
  stories choose their backend through `parameters.fake`, which no preview wrapper can see. It
  derives the world from each story's own parameters rather than naming the four, so a story that
  gains or changes a seed is followed automatically.
- **`Dropdown`, `TooltipProvider` and `WorkInProgress` joined on 2026-09-27, by Markus's choice.**
  All three had stories before the 2026-09-08 sync and were dropped as `[TITLE_UNMAPPED]` with no
  module in the barrel. The tooltip is a provider and a hook with no `Tooltip` component, so
  `titleMap` sends `Tooltip` to `TooltipProvider` and the barrel exports `useTooltip` beside it.
  **Five other `src/components` titles are still out, and that was the decision, not an oversight**
  — offered and declined the same day: `CardChin`, `FolderNameField`, `KeyMap`,
  `ParentFolderCard`, and `Dropdown/PlacementProbe` (see skipped stories). Do not re-raise them
  unless one becomes a general-purpose primitive. (`BottomTabBar` was a sixth until #604 deleted
  the phone layout.)
- **The deck editor's parts joined on 2026-10-01, by Markus's choice, and `CardChin` is one of
  them** — which reverses its 2026-09-27 decline above. Asked for the deck editor, a design agent
  could only redraw it by hand, so the barrel's `Deck editor` section exports `StackView` (the
  Stacks desk), `CardStack`, `DeckCardFace`, `CardMarks` (`QuantityTag`, `TheoryMatchMark`, …),
  `CountPill`, `GroupHeader` and `CardChin`. Four have cards — `StackView`, `CardStack`,
  `CardChin` and `QuantityTag`, which `titleMap` sends `CardMarks` to for `FilterChips`' reason
  (the family module has no component of its own name; six of its seven stories render
  `QuantityTag`). `StackView` is `single` on `Default` at `1280x720`: its meta decorator is a
  672px-tall box, and 1280 is four 224px pile columns plus the rail — what the app's own 1920
  window leaves the desk with the card search docked. `GridView`, `TableView`, `TextView` and
  `TokenPile` are still out: each is a desk of its own needing its own audit and viewport.
- **Two shim lines came with them, and one is a module the barrel had to start exporting.**
  `/features/decks/CardMarks` — no export is named after that file, so rule 2 would compile a
  second copy into every deck preview. `/lib/dndManager` — a module-level `new DragDropManager`
  plus a payload `WeakMap` and an id counter, which `StackView`'s and `CardStack`'s stories reach
  through `dnd.ts` → `dndTarget.ts`; a preview built from source would own a second drag manager.
  So the barrel exports `dndManager` beside `store`, for `store`'s reason. **Check after the
  build**: `grep -c "new DragDropManager" ds-bundle/_preview/{StackView,CardStack}.js` should be
  0, and the shim reaches any older preview whose graph touches `dndManager` too (ContextMenu's
  feature menus may) — compare its `createContext` count with the table below.
- **Four owned previews exist only to re-enact a `play`**: `TooltipProvider`, `CardZoomIndicator`,
  `ContextMenu`, and the `Flanked` half of `Dialog`. The rule they follow is under "Stories with a
  `play`" below. `TooltipProvider` is `cardMode: "single"`, `primaryStory: "Interactive"`, because
  an open panel is `fixed` and validate flags it `[GRID_OVERFLOW] escape` in a grid.
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
- `primitives-dropdown-placementprobe--{in-a-scroller,in-a-transformed-box,at-the-bottom}` — the
  file's own doc comment calls them "a probe, not a catalogue entry": three containers that
  `usePopupPlacement` has to survive, driven by hand over CDP. They join the Dropdown card only
  because the title nests under `Primitives/Dropdown`, and on a card they are filler lines.

## Duplicate contexts that are known and harmless (swept 2026-09-27)

`grep -c createContext ds-bundle/_preview/*.js` is non-zero for four previews, and none of
them is the `useTooltip` bug:

- **ContextMenu (8)** — its story imports `ContextMenuProvider`, `useContextMenu`, `cardMenu` and
  the four feature menus from source. The whole menu stack compiles consistently *inside* the
  preview, so the provider and every reader share the preview's copy and it renders correctly. The
  cost: this card proves the source menu stack, not the bundle's copy. Shimming it would mean
  exporting `ContextMenuProvider`, `useContextMenu` and the feature menus from the barrel —
  not done.
- **AppShell (8), Ribbon (1), Dialog (1)** — `motion`'s and `lucide-react`'s contexts come from
  `node_modules`, which rule 2 never redirects by design. `FeedDownloadContext` rides in through
  `src/lib/query.ts`. The 2026-09-08 grades already covered all three in this state.

Designs never see any of this: they mount the bundle's own provider stack through
`GrimoirePreviewProvider`. Re-run the grep when a count moves.

## Stories with a `play` — what the reference shows, and when a preview re-enacts it

Settled across the 2026-09-27 fan-out. A preview runs no play (`storybook/test` is stubbed to inert
callables), and the storybook side is photographed with the play in whatever state it has reached.
Read the play before grading, because three facts decide what its reference can show:

1. **[GENERAL] compare does not wait for a play to finish.** `captureStory` shoots after
   `networkidle` and fonts. A short play is usually done by then; a play that shows something and
   removes it on a timer is caught **mid-flight**. `CardZoomIndicator` `While Zooming` shows its
   `130%` badge inside `ZOOM_QUIET_MS` (1,200 ms). ContextMenu `No Stored Image` and
   `Add To Wishlist Folders` still show the menu their plays go on to close.
2. **[GENERAL] The reference is cropped to `#storybook-root`**, so a `fixed` panel below a thin
   root never appears: Dropdown's listbox, ToggleChip `With Hint`, CountTag `Neutral` and
   OwnedBadge `Both` tooltips, ContextMenu's submenus, and the TitleBar shortcuts panel (past the
   900px edge too). Those were checked by hand with real input or a read-only hover probe on both
   sides. **The compare itself verifies none of them.**
3. **[GENERAL] Re-enact only where the leftover state can be shown.** An owned `withPlay` wrapper
   re-enacts the end state with the DOM events `userEvent` dispatches, and nothing else: no props
   and no store writes. It's done where the state is **in flow** (a focus ring, a focused row, a
   badge) or the card is **already `single`**: `TooltipProvider`, `CardZoomIndicator`, Dialog
   `Flanked` (Tab then focus the Next flank, once the dialog holds focus) and ContextMenu `Card`
   (ArrowDown on the panel once it holds focus). **Never for a `fixed` panel on a grid or column
   card**: every `.ds-cell` is `transform:translateZ(0); overflow:hidden`, so the panel lands
   relative to the cell and is clipped. Measured on CardArt's grid at 728px, it landed at cell-local
   y=349 in a 330x296 cell. Validate would still flag it `escape` and prescribe `single`, cutting
   CardArt's card from seven variants to one.

Graded `close` on purpose, each with its reason in its `grade.json`:

- **Dropdown `Multi` and `Picked Icon`**: the reference is the play's end state ("3 formats"; "No
  label" with the swatch gone), and the preview renders the story's args ("1 format"; "Removal"
  with its `triggerIcon` swatch). They are kept rather than skipped because they are the only cells
  that show `MultiDropdown` and `triggerIcon`.
- **TooltipProvider `Interactive` and `On Focus`**: the +24px capture-page offset described above.
  Product-card placement was measured correct.
- **CardArt `Game Changer` and `Game Changer Foil`, Figure `With As Of Title`**: the reference
  shows the tooltip each play opens (Figure's only as a 5px sliver at the root's bottom edge).
  Rule 3 forbids re-enacting it on their grid cards. A hover probe confirmed that the bundle opens
  the right text on every one.

Grading tips from the same pass:

- **Storybook text has LCD colour fringes and the preview's does not.** That is antialiasing, not
  colour: the `.ds-single` transform puts the capture on a composited layer, which loses subpixel
  AA. Solid fills agree to the unit, e.g. RarityGem rare is 191,163,90 on both.
- **A thin reference strip cannot be judged from the sheet** (ManaLine's root is 868x2). Crop the
  preview raw to its content, upscale both 5–6x nearest-neighbour into one image, and Read that.
- **Fan-out subagents share one scratchpad**, and two batches writing `compare1.log` interleaved.
  Tell each batch to log under its own subdirectory.

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
- **`[RENDER_THIN]` on `TooltipProvider`** ("DOM content present but rendered height is 0px") —
  triaged 2026-09-27, **false positive from the `withPlay` wrapper.** Validate measures the mount's
  *direct children* (`package-validate.mjs` ~l.546), and the owned preview wraps the story in a
  `display: contents` div, which has no box and reads 0×0 however tall the story inside it is.
  Only this card trips it: it is `single`, so the wrapper is the one mount. ContextMenu's grid has
  taller sibling cells, and Dialog's wrapper is a sized stage. Its row reads `bad:false`, `blank:false`,
  12 KB PNG, and the card screenshot shows the tooltip open and centred over "Needs review".
  If it ever needs silencing, swap the wrapper for a plain block `div` (the story's `Stage` is
  full-width block anyway) and re-grade.
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
- **`.design-sync/tsconfig.json`'s `@/lib/core` rule is the whole directory fence.** It points at
  a shim that exists only for that trap (see above). Deleting it, or letting it drift below the
  `@/*` wildcard, breaks previews *and* the shipped bundle.
- **`AppShell.tsx`'s owned preview copies `compose` verbatim from the generated wrapper.** If the
  converter's story composition changes, diff the generated twin
  (`.design-sync/.cache/previews/AppShell.tsx`) against it.
- **`TooltipProvider.tsx`'s owned preview mirrors two plays by hand.** If `Interactive`'s or
  `OnFocus`'s play changes, `[STORY_CHANGED]` names it and this file has to follow. Its `compose`
  is the generated one verbatim, same as `AppShell.tsx` and `Dialog.tsx`.
- **`cfg.storyImports.shim` holds one hook (`useTooltip`) and, since 2026-10-01, two modules
  (`CardMarks`, `dndManager` — see Config decisions).** A new story that imports a
  context-reading hook from a module that is not a component (`useCardToDeckRefusal`, a
  `use…Context`) compiles a dead second copy, and the static render usually looks fine. Grep the
  compiled preview for `createContext`.
- **Four owned previews re-enact plays by hand** (see "Stories with a `play`"). If
  `CardZoomIndicator` `WhileZooming`, Dialog `Flanked` or ContextMenu `Card` changes its play,
  `[STORY_CHANGED]` names it and the owned file has to follow. `CardZoomIndicator`'s match is
  timing-dependent **on both sides**: each shot has to land within 1,200 ms of the click.
- `AppShell` is the only story whose `parameters.fake` changes what renders. ContextMenu
  `No Stored Image` also sets one (`fault: "imageUrisMissing"`, since 2026-08-14), but the fault
  only changes what *Copy card image* copies, and no static render presses it. A story whose
  `parameters.fake` does change a render needs AppShell's owned-preview treatment, or it renders
  the default `starter` world.
