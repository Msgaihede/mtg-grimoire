import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

/* The workbench's own chrome — the sidebar, the toolbar and the addon panel — as opposed to
   `preview.tsx`, which dresses the iframe a story renders inside. Storybook loads this file
   in the *manager* document, a separate page from the preview, which is why none of the
   app's CSS reaches here and why the colours below are written as literals.

   **Storybook 10 moved both of these imports into the `storybook` package itself.**
   `@storybook/manager-api` and `@storybook/theming` are not installed in this tree at all —
   verified against `node_modules/storybook/package.json`'s export map (10.5.7), which lists
   `./manager-api`, `./theming` and `./theming/create` and nothing under `@storybook/`. A
   Storybook 7 or 8 snippet copied in here compiles under `tsc -p .storybook` only by
   accident and fails at manager boot with a bare module-resolution error that says nothing
   about the version it came from. */

/* Hex, because a manager theme is plain CSS values with no `@theme` block behind it and no
   Tailwind to resolve a token — these are `src/index.css`'s own tokens converted from oklch,
   and `logos/README.md` records the same three for the artwork so the mark and the chrome it
   sits in cannot drift apart:

     --color-accent   oklch(0.75 0.12 85)     #D1A84B  gold
     --color-surface  oklch(0.21 0.012 270)   #16181E  panel
     --color-bg       oklch(0.16 0.01 270)    #0C0D12  field
     --color-text     oklch(0.93 0.005 90)    #E9E8E4
     --color-dim      oklch(0.65 0.01 90)     #918F88
     --color-border   oklch(0.3 0.01 270)     #2C2E33

   No `fontBase`/`fontCode` is set. The app's faces come from `@fontsource` imports in
   `src/index.css`, which reaches the preview iframe through `preview.css` and never reaches
   this document — naming Geist here would silently fall back to the system sans and only
   look like a decision was made. */
const grimoire = create({
  // Dark only, matching the app: `src/index.css` carries identical values on `:root` and
  // `.dark`, and `preview-head.html` explains why the class exists at all. There is no light
  // theme to offer the workbench because there is none to build a component against.
  base: "dark",

  brandTitle: "MTG Grimoire",
  // Served by `staticDirs` in `main.ts` — see the comment there. Document-relative rather
  // than root-absolute, which is what Storybook's own manager template emits for its favicon
  // (`assets/server/template.ejs`: `href="./<%= favicon %>"`): the manager routes by query
  // string from a single page at the Storybook root, so `./` resolves the same as `/` today
  // and keeps resolving if a build is ever served under a subpath.
  brandImage: "./mtg-grimoire-mark.svg",
  // No `brandUrl`: the default turns the sidebar brand into a link, and there is nowhere for
  // it to go — this is a local workbench for a desktop app with no site behind it.

  colorPrimary: "#D1A84B",
  colorSecondary: "#D1A84B",

  appBg: "#0C0D12",
  appContentBg: "#16181E",
  // The preview's backdrop behind a story. The field colour rather than the panel one, so a
  // component's own surface reads as a raised panel here exactly as it does in the app.
  appPreviewBg: "#0C0D12",
  appBorderColor: "#2C2E33",
  appBorderRadius: 6,

  textColor: "#E9E8E4",
  textMutedColor: "#918F88",
  textInverseColor: "#0C0D12",

  barBg: "#16181E",
  barTextColor: "#918F88",
  barSelectedColor: "#D1A84B",
  barHoverColor: "#D1A84B",

  inputBg: "#0C0D12",
  inputBorder: "#2C2E33",
  inputTextColor: "#E9E8E4",
  inputBorderRadius: 6,
});

addons.setConfig({ theme: grimoire });
