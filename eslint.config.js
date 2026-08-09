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
  {
    ignores: ["dist/", "storybook-static/", "src-tauri/", "node_modules/", ".claude/worktrees/"],
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
  // Node than this should be asked why.
  {
    files: ["scripts/**/*.mjs"],
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
