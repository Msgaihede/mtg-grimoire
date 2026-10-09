import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vite.base.ts";

// The one test program: every package's tests, as one project per package, from the repository
// root, over the plugins and the alias the apps build with. It lived in `vite.config.ts` until
// 2026-10-08, when that file became the desktop app's and moved into it.

/**
 * One Vitest project. `extends: true` gives it everything this file sets — the plugins, the
 * alias, jsdom, the one setup file, the timeout — and leaves its root where this file is. That
 * root is not negotiable: thirty-eight `import.meta.glob` calls in the suite start their pattern
 * at `/`, which is the repository only while a project's root is.
 */
const project = (name: string, include: string[]) => ({
  extends: true as const,
  test: { name, include },
});

export default mergeConfig(
  base,
  defineConfig({
    test: {
      environment: "jsdom",
      setupFiles: ["./packages/ui/test-setup.ts"],
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
      // ⚠️ A folder no project's glob names is collected by **nothing**, and `vitest run <that
      // folder>` answers `No test files found` — which prints on stdout and is easy to read as a
      // pass.
      //
      // One project per package, named for it since 2026-10-08, so `vitest run --project light`
      // is that package's tests. The suite is still one program: one root, one environment, one
      // setup file. `scripts/ci-route.test.mjs` mirrors these globs.
      projects: [
        // The shared UI. No `*.stories.tsx` is ever collected as a **test file** — every glob
        // here requires a literal `.test.` segment, not a particular extension, so
        // `packages/ui/components/RarityGem.stories.tsx` matches none of them. Stories are
        // nonetheless in the suite, as *modules*: `packages/ui/stories.test.tsx` globs every one
        // of them and runs their `play` functions through `composeStories`. That is the intended
        // shape — one collected file that owns the Storybook wiring (project annotations, the
        // fake-backend module mocks), rather than every story file inheriting a test runner's
        // environment.
        project("ui", ["packages/ui/**/*.test.{ts,tsx}"]),
        // The Storybook fake, in scope so the fake backend is covered by the one suite `verify`
        // runs. It was `.storybook/fake/` until 2026-10-08, and the workbench's own glob below
        // is what collected it. What the narrower `.test.ts` rules out is a
        // `packages/fake/**/*.test.tsx`: the fakes are plain modules, and a test needing JSX is
        // testing a component, which lives under `packages/ui/`.
        project("fake", ["packages/fake/**/*.test.ts"]),
        // The desktop app's own page — its entry and the boot components that hold `App` back
        // until the database is open. They were under the first glob until 2026-10-08, when
        // they moved out of the shared UI and into the one app that mounts them.
        project("desktop", ["apps/desktop/src/**/*.test.{ts,tsx}"]),
        // The **light app** — `apps/light/`, built by `apps/light/vite.config.ts`. A React entry
        // like `apps/share/`, with one difference: it has a core, so its tests mock Tauri's API
        // modules with the Storybook fake the way `packages/ui/stories.test.tsx` does.
        project("light", ["apps/light/**/*.test.{ts,tsx}"]),
        // The **public web viewer** — `apps/share/`, built by `apps/share/vite.config.ts` into
        // `apps/share/dist-share/` and served by the share Worker's `assets` binding. It is a
        // React page like the shared UI, so unlike the three Worker globs below it needs `.tsx`,
        // and unlike the shared UI it has no core: no `ipc`, no store, no Tauri boundary
        // anywhere in it. `apps/share/SharePage.test.tsx` holds a sweep of its own import graph
        // that keeps it that way.
        project("share", ["apps/share/**/*.test.{ts,tsx}"]),
        // The Cloudflare relay's pure logic, and a glob of its own rather than a widening of the
        // first because `packages/ui/**` is anchored at the repo root and does not reach
        // `infrastructure/relay/src/`. **The rule is that every pure decision in
        // `infrastructure/relay/` is testable this way and the I/O is not**, which is by design
        // rather than a limit: the Durable Object and the fetch handlers would need
        // `@cloudflare/vitest-pool-workers`, which drags wrangler and workerd into the tree and
        // peers on `vitest ^4.1.0` (0.22.0, checked 2026-09-27), which the vitest 5 here is
        // outside of - so compaction, ordering, retention, token minting, the entitlement
        // decision, claim-code normalisation and the HMAC-MD5 a Patreon signature is checked
        // against all live in pure modules this suite already knows how to run.
        // This comment read "only `log.ts` is testable this way", which was true when `log.ts`
        // was the only pure module here and had stopped being true every time another one
        // landed. A rule does not drift the way that sentence did.
        // `infrastructure/relay/` is absent from `coverage.include` for the same reason
        // `apps/desktop/src-tauri/` is: it is not app code and would move a number that is about
        // the app.
        project("relay", ["infrastructure/relay/src/**/*.test.ts"]),
        // The *share* Worker — a second Cloudflare Worker beside the relay, for spec §5.1's
        // blast-radius reason — and everything the relay's paragraph says applies to it
        // unchanged: no workerd, plain handlers over an injected `Env`, `fakeD1`'s SQL evaluator
        // standing in for D1. It is absent from `coverage.include` beside
        // `infrastructure/relay/`. This is the directory the warning above was learned on: no
        // glob named it for exactly one commit.
        project("share-worker", ["infrastructure/share-worker/src/**/*.test.ts"]),
        // The third Worker — `infrastructure/app-worker/`, the web app's hosting — on the two
        // above's terms: a plain handler over a fake of its one binding. Its other two files are
        // not about a handler at all: `headers.test.ts` holds the reader of Cloudflare's
        // `_headers` format, and `hosting.test.ts` reads that file, `wrangler.jsonc` and the
        // engine's Rust as text and fails when the Content-Security-Policy and the hosts the
        // engine asks part.
        project("app-worker", ["infrastructure/app-worker/src/**/*.test.ts"]),
        // The root package's own two folders, which belong to no other.
        //
        // The workbench's own folder. Nothing in it is a test since the fake moved out, and the
        // glob stays for the warning above: a test written beside `preview.tsx` is collected
        // rather than silently not. `.test.ts` and no `.tsx`, for the fake's reason.
        //
        // CI's own router, `scripts/ci-route.mjs`, and the fences beside it: plain `.mjs` like
        // the rest of `scripts/`, so their tests are too — no `tsc` program includes `scripts/`,
        // and a `.ts` test under `packages/ui/` importing one would need a declaration file to
        // satisfy `strict`.
        project("root", [".storybook/**/*.test.ts", "scripts/**/*.test.mjs"]),
      ],
      // Vitest stubs CSS imports as empty strings by default, which would hand
      // `iconFont.test.ts` an empty `mana.css?raw` to assert against. No *component* imports
      // CSS; `.storybook/preview.tsx` imports three files of it and reaches the suite through
      // `packages/ui/stories.test.tsx`, which is the second thing this now carries.
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
        //
        // Two folders, for one number: the desktop's entry and its boot components were under
        // `src/` with everything else until 2026-10-08, and naming the shared UI alone would
        // have taken them out of the figure by moving them.
        include: ["packages/ui/**/*.{ts,tsx}", "apps/desktop/src/**/*.{ts,tsx}"],
        exclude: [
          // Tests, and the helpers that exist only for them. (Counted in prose here until
          // 2026-08-29, when a third arrived and the sentence was wrong for the length of one
          // edit — a list is a fact this file already states.)
          "**/*.test.{ts,tsx}",
          "packages/ui/test-setup.ts",
          "packages/ui/test-drag.ts",
          // Stories are the Storybook workbench, not app code. They *do* run — through
          // `packages/ui/stories.test.tsx` — so leaving them in would count the workbench's own
          // coverage of itself as product coverage.
          "**/*.stories.tsx",
          // No statements to cover: ambient types, and the `createRoot` entry point that
          // only ever runs in a browser.
          "packages/ui/vite-env.d.ts",
          "apps/desktop/src/main.tsx",
          // The database Worker's entry: it runs only in a Worker, over a WASM module no test
          // loads. Everything it decides is in `engine.ts` beside it, which is covered.
          "packages/ui/lib/core/web/worker.ts",
          "packages/ui/lib/core/web/grimoire_web.d.ts",
          // The service worker's entry, for the same reason: four event listeners that only a
          // real worker has. What it decides is in the modules beside it, which are covered.
          "packages/ui/lib/core/web/sw/sw.ts",
          ".claude/**/*",
        ],
      },
    },
  }),
);
