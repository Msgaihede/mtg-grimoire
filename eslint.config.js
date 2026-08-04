import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // `rules-of-hooks` and `exhaustive-deps` are the point: a stale dependency array is the
  // one React bug this project's tests cannot see, because it only shows up as a value
  // that stopped updating. `recommended-latest` also brings the React Compiler rules,
  // which are kept on as free static analysis.
  reactHooks.configs.flat["recommended-latest"],
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
