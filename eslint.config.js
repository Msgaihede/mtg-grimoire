import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import storybook from "eslint-plugin-storybook";

export default tseslint.config(
  // `storybook-static/` joins `dist/` for the same reason: it is generated output that
  // `npm run verify` can leave on disk before `lint` runs, and its bundled JS would be
  // linted as if it were source.
  //
  // `.claude/worktrees/` is where Claude Code parks git worktrees — entire second checkouts
  // of this repository, each with its own `tsconfig.json`. Flat config's default ignores are
  // only `node_modules/` and `.git/`, so ESLint walks into them, and typescript-eslint then
  // refuses every file in the *real* `src/` with "multiple candidate TSConfigRootDirs are
  // present". Measured 2026-08-09: 257 parsing errors with one worktree checked out, 0 with
  // this line. It is a local-machine artifact — CI never has one — which is exactly why it
  // has to be ignored here rather than diagnosed again by the next person whose `lint` broke
  // without them touching any lintable file.
  // Only `worktrees/`, matching `.gitignore` exactly: the rest of `.claude/` is ordinary
  // project config, and a future `.claude/hooks/*.mjs` should be linted like `scripts/` is.
  //
  // The three design-sync directories are the same argument as `dist/`, one step further out.
  // `ds-bundle/` is the converter's emitted bundle — a 600 KB IIFE plus 14 generated `.d.ts`
  // files, which on its own contributed ~24,900 errors to `npm run lint` the first time it
  // existed on disk. `.ds-sync/` is the staged converter and its own `node_modules`.
  // `.design-sync/` is mixed and ignored **whole**, deliberately: most of it is generated
  // (`sb-reference/`, `.cache/`, `dist/`), and the handful of committed files are the sync's
  // harness rather than app source — `tsconfig.json` never includes them, the converter's own
  // esbuild compiles them, and `previews/*.tsx` copies its `compose` helper verbatim from
  // generated code where the `any`s are the point. Lint them and you are linting a tool's
  // input against the app's rules.
  {
    ignores: [
      "dist/",
      // Output of round one's web build, removed on 2026-09-27, which a checkout that ran it
      // still holds on disk (gitignored): the wasm-bindgen glue is machine-written and fails
      // `no-undef`.
      "web/public/",
      // The web app's bundle (`npm run web:build`), and the engine `npm run web:wasm` writes for
      // it — wasm-bindgen's glue again, which is the file that fails `no-undef`.
      "dist-web/",
      "dist-wasm/",
      // The public share viewer's bundle. Generated output like `dist/` above, and on disk on
      // any machine that has run `npm run share:build` — which `share-worker`'s deploy requires,
      // because `wrangler.jsonc` declares an `assets` binding over it.
      "dist-share/",
      // The light app's bundle (`npm run mobile:build`). Generated output like the two above.
      "dist-mobile/",
      "storybook-static/",
      "src-tauri/",
      "node_modules/",
      ".claude/worktrees/",
      "ds-bundle/",
      ".ds-sync/",
      ".design-sync/",
      // wrangler's local state, beside whichever Worker `wrangler dev` was run in — ignored by
      // git everywhere, and on disk on any machine that has run one. Its `tmp/` holds the
      // Worker's bundle with wrangler's own middleware around it, which fails `no-undef` by the
      // hundred: found 2026-10-04, when `npm run web:sync-smoke` (which starts the relay under
      // `wrangler dev --local`) was followed by `npm run verify` and 620 errors named no file a
      // person wrote. The smoke removes what it made; a `wrangler dev` stopped any other way
      // does not.
      "**/.wrangler/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // `rules-of-hooks` and `exhaustive-deps` are the point: a stale dependency array is the
  // one React bug this project's tests cannot see, because it only shows up as a value
  // that stopped updating. `recommended-latest` also brings the React Compiler rules,
  // which are kept on as free static analysis.
  reactHooks.configs.flat["recommended-latest"],
  // Developer tooling that runs in Node rather than in the webview. Listed by hand rather
  // than pulled from the `globals` package: half a dozen names is not worth a dependency,
  // and the list being short is itself a fence — anything in `scripts/` that needs more of
  // Node than this should be asked why. **The card scanner's own scripts are the same kind
  // of file one directory down** (`crates/card-scanner/scripts/`: the page check, the model
  // fetch, the camera-less drive), and `eslint .` reaches them — found 2026-09-08 as 27
  // `no-undef` errors the first time `npm run verify` ran with the crate in the tree.
  {
    files: ["scripts/**/*.mjs", "crates/*/scripts/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        fetch: "readonly",
        WebSocket: "readonly",
        Buffer: "readonly",
        // Asked and answered: a real drag is a *paced* gesture. Chromium starts one from a
        // press and a few moves spread over time, and dispatched back to back they arrive as
        // a click. `cdp.mjs drag` sleeps between moves for that reason and no other.
        setTimeout: "readonly",
        // `drive-frames.mjs` times each round trip; Node 22 has it as a global.
        performance: "readonly",
        // Asked and answered: `web-deploy-probe.mjs` gives each `fetch` a deadline, and
        // `AbortSignal.timeout` is the only way to hand `fetch` one.
        AbortSignal: "readonly",
      },
    },
  },
  // No Node-globals block accompanies this, unlike the `scripts` block above, and the
  // asymmetry is deliberate: that one covers `.mjs`, where `no-undef` is live, while
  // `.storybook` is all TypeScript and typescript-eslint's `eslint-recommended` turns
  // `no-undef` off for TS files — the compiler already answers that question better.
  // Verified with `eslint --print-config .storybook/main.ts`: `no-undef` is `[0]`, so such a
  // block would declare globals to a rule that never runs.
  ...storybook.configs["flat/recommended"],
  {
    rules: {
      // Off because React Compiler is not enabled in this build (see `vite.config.ts`:
      // plain `@vitejs/plugin-react`, no `babel-plugin-react-compiler`), so its advice —
      // "the compiler will skip memoizing this component" — describes something that
      // cannot happen here. It fires on TanStack Virtual's `useVirtualizer`, which the
      // ~117 k-row result list is built on and which is not going away.
      // **Turn this back on if the React Compiler is ever adopted**: the warning is real
      // under a compiled build, and the virtualised lists are exactly where it would bite.
      "react-hooks/incompatible-library": "off",
    },
  },
);
