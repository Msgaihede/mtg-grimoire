import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
// Ships one format of the icon fonts instead of five — worth ~5 MB of the bundle. Both
// the rewrite and its `id` filter live under `src/` so the test suite covers them; see
// `src/lib/iconFont.ts` for why, and `iconFont.test.ts` for the guarantee that it leaves
// every glyph class alone.
import { woff2IconFonts } from "./src/lib/iconFont";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  plugins: [woff2IconFonts(), react(), tailwindcss()],

  // `@/*` -> `src/*`, matching tsconfig.json paths and components.json aliases.
  resolve: {
    alias: { "@": "/src" },
  },

  // Which core the bundle talks to. `"tauri"` here and in vitest; `vite.web.config.ts`
  // overrides it. A `define` rather than an env read so the unused branch is folded away
  // rather than merely unreachable.
  define: { __CORE__: JSON.stringify("tauri") },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**", "**/.claude/**"],
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    // Vitest's default is 5000ms, and that number was the third-largest source of red CI in
    // this repo — a bare `Test timed out in 5000ms` with no assertion message, on a different
    // test each time, always green in isolation.
    //
    // **It is a budget, not a bound, which is why raising it is the right dial here.** Nothing
    // asserts on it: it measures no behaviour and guards no regression, unlike
    // `images::tests::consecutive_fetches_are_not_paced_apart`, where the number *was* the
    // claim and raising it would have deleted the test. What runs out of it is wall-clock
    // under contention. Measured 2026-08-20 on this machine: `App.test.tsx > announces a
    // fold…` and `SearchPage.test.tsx > keeps the loaded rows…` take **646ms** and **702ms**
    // run alone and both hit the 5000ms wall under `verify`, which puts `tsc` + `vite build` +
    // `eslint` in front of 148 files running in parallel — a 7–8× starvation, not a test
    // sitting near its limit.
    //
    // 15s against a **1219ms** slowest-passing test in the whole suite is ~12× headroom. The
    // cost is the only thing this trades away: a test that genuinely hangs now reports in 15s
    // rather than 5s.
    testTimeout: 15_000,
    // `.storybook` is in scope so the fake backend is covered by the one suite `verify`
    // runs. No `*.stories.tsx` is ever collected as a **test file** — both globs require a
    // literal `.test.` segment, not a particular extension, so
    // `src/components/RarityGem.stories.tsx` matches neither. Stories are nonetheless in the
    // suite, as *modules*: `src/stories.test.tsx` globs every one of them and runs their
    // `play` functions through `composeStories`. That is the intended shape — one collected
    // file that owns the Storybook wiring (project annotations, the fake-backend module
    // mocks), rather than every story file inheriting a test runner's environment.
    // What the narrower `.test.ts` on the second glob rules out is a
    // `.storybook/**/*.test.tsx`: the fakes are plain modules, and a test needing JSX is
    // testing a component, which lives under `src/`.
    // The third glob is the Cloudflare relay's pure logic, and it is a *third* glob rather
    // than a widening of the first because `src/**` is anchored at the repo root and does not
    // reach `relay/src/`. Only `log.ts` is testable this way and that is by design: the
    // Durable Object itself would need `@cloudflare/vitest-pool-workers`, which drags wrangler
    // and workerd into a tree pinned to vitest 4.1.10, so the compaction, ordering and
    // retention rules live in a pure module this suite already knows how to run. `relay/` is
    // absent from `coverage.include` for the same reason `src-tauri/` is: it is not app code
    // and would move a number that is about the app.
    include: ["src/**/*.test.{ts,tsx}", ".storybook/**/*.test.ts", "relay/src/**/*.test.ts"],
    // Vitest stubs CSS imports as empty strings by default, which would hand
    // `iconFont.test.ts` an empty `mana.css?raw` to assert against. No *component* imports
    // CSS; `.storybook/preview.tsx` imports three files of it and reaches the suite through
    // `src/stories.test.tsx`, which is the second thing this now carries.
    css: true,
    coverage: {
      provider: "v8",
      // `json-summary` is the machine-readable one — `coverage/coverage-summary.json` is
      // what the README figure is read off. `text` prints the per-file table locally.
      reporter: ["text", "json-summary"],
      // Vitest 4 dropped `coverage.all`; an explicit `include` is now what makes a file
      // with no test at all count as 0% instead of vanishing from the denominator. Without
      // it the report covers only modules some test happened to import, which flatters the
      // number by exactly the files nobody tested.
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        // Tests, and the two helpers that exist only for them.
        "src/**/*.test.{ts,tsx}",
        "src/test-setup.ts",
        "src/test-drag.ts",
        // Stories are the Storybook workbench, not app code. They *do* run — through
        // `src/stories.test.tsx` — so leaving them in would count the workbench's own
        // coverage of itself as product coverage.
        "src/**/*.stories.tsx",
        // No statements to cover: ambient types, and the `createRoot` entry point that
        // only ever runs in a browser.
        "src/vite-env.d.ts",
        "src/main.tsx",
        // The service worker's global-scope half. `swCore.ts` beside it holds every decision
        // and is covered; this file is `caches` calls with no branches, it cannot be imported
        // into jsdom at all, and the live pass is what proves it.
        "src/pwa/sw.ts",
        ".claude/**/*",
      ],
    },
  },
});
