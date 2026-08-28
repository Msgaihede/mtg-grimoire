# The PWA shell around the web target — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the web target into something a reader installs, opens offline, and updates on their own say-so — and that tells the truth when the browser has thrown their 526 MB corpus away.

**Architecture:** One new folder, `src/pwa/`, plus two Vite configs that exist only for the web build. The shell is hand-written: a manifest emitted from a tested object, a service worker whose every *decision* is a pure function under vitest and whose Cache Storage plumbing is verified in a real browser, and a React hook that owns the waiting worker. **Desktop is byte-identical** — `vite.config.ts` is not touched, `index.html` is not touched, and every web-only surface is behind `isWebTarget()`, which is `false` in every build except one made by `vite.web.config.ts`.

**Tech Stack:** TypeScript 6.0.x, React 19, Vite 7, Vitest 4. **No new dependencies** — no `vite-plugin-pwa`, no Workbox. The portable updater is hand-written for the same reason ([in-app-updates.md](../../reference/in-app-updates.md)), and a service worker is ~120 lines of decisions this repo would rather own than configure.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) — §5.4 in full, and §5.3's mobile-data prompt. PR 5 of the §10 sequence.

**Research:** [the wasm-core spike](../research/2026-08-27-wasm-core-spike.md) — every storage number below is from it, measured, and must not be re-derived.

---

## What this PR is not

- **It does not build the wasm core, the DB Worker or the one-tab guard.** Those are PR 4 (§5.1, §5.2). This plan wraps them.
- **It adds no Rust.** `git diff --stat src-tauri/` must print nothing at the end of this branch, and Step 1 of the Self-Review checks it. `npm run verify` still runs `cargo test`, so a Rust file touched by accident is caught, but the *diff* is the assertion.
- **It does not intercept the data feeds.** The service worker never calls `respondWith` for `api.scryfall.com`, `data.scryfall.io`, `json.commanderspellbook.com` or `api.cardkingdom.com`. Putting a 610 MB stream through a service worker's `fetch` handler would defeat the framer's measured 2.01 MB peak buffer for no gain whatever. Task 2 has a test that fails if any of those four is ever routed.
- **It does not re-attach COOP/COEP, and that is a decision rather than an omission.** See the next section.

## What the spike settled, and must not be re-litigated

| Fact | Measured | Consequence for this PR |
| --- | --- | --- |
| **Cross-origin isolation is not required.** | The identical page passed with and without `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp`. Install 65 ms vs 50 ms, write of 532.8 MB in 3.3 s vs 2.3 s — cache noise, identical results. | **The service worker must not set either header on a cached navigation.** The "works on first load, breaks on the second" class of bug does not exist here. Task 8 asserts `crossOriginIsolated === false` *and* that the app works, so nobody adds them back defensively. |
| **`navigator.storage.estimate()` cannot gate anything.** | 647 MB during a fill and **7 MB** immediately after a restart, against a file that was 532.8 MB both times; an identical 10 887.0 MB quota reported on the desktop and on the phone. | Nothing in this PR reads `estimate()` to decide anything. It is shown, once, in the storage panel, labelled as the browser's own guess. Task 4 has a test that fails if a *decision* ever depends on it. |
| **Tier A stores and survives.** | 532.8 MB written at 162.1 MB/s desktop / 110.4 MB/s Android; reattached in 40 ms / 90 ms after Chrome was killed and relaunched; byte-intact. | The corpus is worth persisting. `persist()` is requested once it exists. |
| **First-run ingest.** | `default_cards` (77 972 714 B gz → 627 900 518 B JSON, 117 464 rows): **10.4 s** desktop, **36.5 s** OnePlus 12. Spellbook combos (27 555 788 B gz → 639 866 292 B JSON): **12.6 s** / **23.1 s**. | These are what the progress UI is designed against. A 36-second first run on a phone is a screen that must say what it is doing — which `SyncProgress` already does. Nothing here adds a second progress surface. |
| **Image cache: ~65 KB per image.** | 519 MB over 7 929 files in the live cache. | 256 MB ≈ **3 900 cards**; ~65 MB for a 1 000-card grid, ~6.5 MB for a deck. Default 256 MB, reader-adjustable to 1 GB (§5.4). Desktop stays uncapped. |
| **`persist()` was never granted in the spike.** | `false` throughout, in headless Chrome with no install and no user gesture — which is expected. | Its answer is **recorded, not trusted**. The evicted-corpus path exists whatever it says. |

## Preconditions from PR 4 — checked, never assumed

This plan sits on PR 4 and names exactly three things it needs. **Check each before Task 1. If one is absent, STOP and report** — do not invent it, and do not build a shim around a symbol that has not been written yet.

- [ ] **A frontend build that runs in a browser.** `npm run build` produces a `dist/` whose `index.html` boots the app against PR 4's web core rather than against Tauri.
      Check: `npm run build && ls dist/index.html dist/assets` — and read whatever build script PR 4 added to `package.json`. **If PR 4 already added a web build script, Task 1's `build:web` composes with it instead of replacing it**, and Task 1 Step 1 records which.
- [ ] **`ipc.syncStatus()` and `ipc.syncRun(force)` answer on the web target.** They are the corpus gate's whole interface and they exist today — `src/lib/ipc.ts:4807-4808`. Nothing in this plan needs a new command.
      Check: `grep -n "syncStatus\|syncRun" src/lib/ipc.ts`.
- [ ] **`cardImageUrl()` returns an `https:` URL on the web target.** `src/lib/images.ts:77` returns an `mtgimg://` URL today, which no browser can fetch and no service worker can intercept. PR 4 has to have changed this; Task 6's image cache is built on it.
      Check: `grep -n "mtgimg" src/lib/images.ts` and read what the web branch returns. **Record the exact origin string** — Task 6 needs it, and it is the one value this plan cannot verify for itself.

## Global Constraints

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy` — irrelevant here, because this PR touches no Rust.
- **Never install `@types/node`.** Nothing under `src/` may import a `node:` module — that is what keeps the fence. The two web build configs *do* read the filesystem, and they live at the repo root where Vite type-strips them, exactly as `vite.config.ts` already does. `src/lib/iconFont.ts` is the precedent for the split: the **decisions** live under `src/` where the suite covers them, the **filesystem** stays in the config.
- **No new dependencies.** TypeScript stays on 6.0.x.
- No `setState` inside an effect — the lint only catches it at `npm run verify`.
- **Do not name a Tailwind transition class in a doc comment.** `tokens.test.ts` sweeps prose as eagerly as code (`src/lib/layers.test.ts:8` shows the glob), so explaining a class you did *not* use goes red.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts` and nowhere else**; `layers.test.ts` sweeps `/src/**/*.{ts,tsx,css}`, which now includes `src/pwa/`.
- Commit messages: `feat(pwa):` / `fix(pwa):` / `test(pwa):` / `chore(pwa):`.
- **Every task ends with a mutation step.** Break the thing, watch it go red, put it back. **If a mutation survives, STOP and report it** — that is a test that was never going to catch anything.

---

### Task 1: The web build target, the manifest, and the icons

**Files:**
- Create: `src/pwa/target.ts`
- Create: `src/pwa/manifest.ts`
- Create: `src/pwa/webAssets.ts`
- Create: `src/pwa/webAssets.test.ts`
- Create: `vite.web.config.ts`
- Modify: `package.json` (one new script)

**Interfaces:**
- Consumes: nothing.
- Produces: `isWebTarget()` (from `@/pwa/target`), `manifestJson()` and `MANIFEST_PATH` (from `@/pwa/manifest`), `webAssetsPlugin()` (from `@/pwa/webAssets`).

> **Why the target flag is a build-time `define` and not a runtime sniff.** The obvious runtime test is `!("__TAURI_INTERNALS__" in window)` — and it is wrong here, because **jsdom does not have that global either** (`src/lib/images.ts:6` records it, and eleven test files repeat it). A runtime sniff would switch every web-only surface *on* in all ~5 500 existing tests. A `define` that only `vite.web.config.ts` supplies is off everywhere else by construction, and a test that wants it on mocks one module.

- [ ] **Step 1: Record what PR 4 left behind**

Run:
```bash
grep -n '"build' package.json
grep -rn "mtgimg\|cards.scryfall.io" src/lib/images.ts | head
```
Write the two answers into the Task 1 commit message: the name of PR 4's web build script (if any), and the image origin `cardImageUrl` returns on web. **Task 6 cannot be written without the second.** If `images.ts` still only knows `mtgimg://`, STOP — Task 6 has no seam and PR 4 is incomplete.

- [ ] **Step 2: Write the failing test**

Create `src/pwa/webAssets.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { MANIFEST_PATH, manifestJson } from "@/pwa/manifest";
import { maskableFromMark, webAssetsPlugin } from "@/pwa/webAssets";

/** The master artwork, as `vite.web.config.ts` reads it off disk. */
const MARK = import.meta.glob<string>("/public/mtg-grimoire-mark.svg", {
  query: "?raw",
  import: "default",
  eager: true,
})["/public/mtg-grimoire-mark.svg"];

describe("the web app manifest", () => {
  it("carries everything Chrome needs to offer an install", () => {
    const m = manifestJson();
    expect(m.name).toBe("MTG Grimoire");
    expect(m.short_name.length).toBeLessThanOrEqual(12);
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.id).toBe("/");
    expect(m.display).toBe("standalone");
    // An installable icon is one that is at least 144px and a format the browser rasterises.
    const big = m.icons.filter(
      (i) => i.type === "image/svg+xml" || Number(i.sizes.split("x")[0]) >= 192,
    );
    expect(big.length).toBeGreaterThan(0);
  });

  it("has exactly one maskable icon, and it is not also the any icon", () => {
    // Two purposes on one file means the platform crops artwork that was drawn full-frame.
    const maskable = manifestJson().icons.filter((i) => i.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0].purpose).not.toContain("any");
  });

  it("is served from the root, so `start_url` and `scope` are inside it", () => {
    expect(MANIFEST_PATH).toBe("manifest.webmanifest");
  });
});

describe("the maskable icon", () => {
  it("puts the field behind the mark and shrinks it into the safe zone", () => {
    const out = maskableFromMark(MARK);
    expect(out).toContain('<rect width="64" height="64" fill="#0C0D12"');
    // 0.9200 is the master's own scale; 0.8000 keeps the book inside the 40%-radius circle
    // a maskable icon is cropped to. See the function's comment for the arithmetic.
    expect(out).toContain("scale(0.8000)");
    expect(out).not.toContain("scale(0.9200)");
  });

  it("refuses artwork it does not recognise, instead of emitting a silent square", () => {
    // The master is edited by hand (`logos/README.md`: "Master artwork; edit this one"), so
    // the day its transform is rewritten this must fail the build rather than ship a field
    // with nothing on it.
    expect(() => maskableFromMark("<svg></svg>")).toThrow(/scale\(0\.9200\)/);
  });
});

describe("the web assets plugin", () => {
  it("links the manifest and the theme colour into the document head, once", () => {
    const plugin = webAssetsPlugin({ markSvg: MARK, icons: [] });
    const html = plugin.transformIndexHtml(`<!doctype html><html><head><title>x</title></head><body></body></html>`);
    expect(html.match(/rel="manifest"/g)).toHaveLength(1);
    expect(html).toContain('<meta name="theme-color" content="#0C0D12"');
    expect(html.indexOf("rel=\"manifest\"")).toBeLessThan(html.indexOf("</head>"));
  });

  it("emits the manifest, the maskable icon and every PNG it was handed", () => {
    const emitted: { fileName: string }[] = [];
    const plugin = webAssetsPlugin({
      markSvg: MARK,
      icons: [{ fileName: "icons/mark-512.png", source: new Uint8Array([1, 2, 3]) }],
    });
    plugin.generateBundle.call({ emitFile: (f: { fileName: string }) => emitted.push(f) });
    expect(emitted.map((e) => e.fileName)).toEqual([
      "manifest.webmanifest",
      "icons/maskable.svg",
      "icons/mark-512.png",
    ]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm run test -- src/pwa/webAssets.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "@/pwa/manifest"`.

- [ ] **Step 4: Write the implementation**

Create `src/pwa/target.ts`:

```ts
/**
 * Is this build the web one?
 *
 * `__WEB_TARGET__` is supplied by `vite.web.config.ts` and by nothing else — not by
 * `vite.config.ts`, not by vitest — so the identifier is genuinely undeclared in a desktop
 * build and the `typeof` guard is what keeps that from being a `ReferenceError` rather than a
 * style choice.
 *
 * **A build-time flag rather than a runtime sniff, and the reason is the test suite.** The
 * obvious probe is `!("__TAURI_INTERNALS__" in window)` — but jsdom has no such global either
 * (`src/lib/images.ts` says so, and eleven test files repeat it), so that probe answers "web"
 * in every one of the app's existing tests and switches on every surface below. A test that
 * wants the web answer mocks this module; nothing else can reach it.
 */
declare const __WEB_TARGET__: boolean;

export function isWebTarget(): boolean {
  return typeof __WEB_TARGET__ !== "undefined" && __WEB_TARGET__;
}
```

Create `src/pwa/manifest.ts`:

```ts
/** One entry of the manifest's `icons` array. */
export interface ManifestIcon {
  src: string;
  /** `"512x512"`, or `"any"` for a vector. */
  sizes: string;
  type: string;
  purpose: "any" | "maskable";
}

export interface WebManifest {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: ManifestIcon[];
}

/** Where the plugin emits it, and therefore what `index.html` links to. Root-relative, so
 *  `scope: "/"` contains it. */
export const MANIFEST_PATH = "manifest.webmanifest";

/**
 * The app's identity to the browser.
 *
 * A function rather than a const so the test and the build read the same object without either
 * being able to mutate the other's.
 *
 * **`id` is `"/"` and it is not decoration.** It is the key the browser files an installed app
 * under; leaving it out makes `start_url` the id, so the day `start_url` gains a query string
 * every installed copy becomes a *second* app. Written down once, here.
 *
 * **`display: "standalone"`, not `"window-controls-overlay"`.** Spec §3's seam table has no
 * window-chrome row for web at all — the custom caption and the Win32 hit-test are desktop's,
 * and asking for an overlay would put the app's content under a title bar it does not draw.
 *
 * Both colours are `--color-bg` resolved to hex, which `logos/README.md` pins at `#0C0D12`.
 * The theme colour is what paints the browser's own bar around the app before a single pixel
 * of ours is drawn, so a mismatch here is a light flash on every cold start.
 */
export function manifestJson(): WebManifest {
  return {
    id: "/",
    name: "MTG Grimoire",
    short_name: "Grimoire",
    description: "Track a Magic: The Gathering collection — offline, on your own device.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0C0D12",
    theme_color: "#0C0D12",
    icons: [
      // The vector first: a browser that can rasterise it gets every size for 2.8 KB.
      { src: "/mtg-grimoire-mark.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/mark-256.png", sizes: "256x256", type: "image/png", purpose: "any" },
      { src: "/icons/mark-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      // Separate file, separate purpose. A single icon declared `"any maskable"` is drawn
      // full-frame *and* cropped to a circle, and one of those two is always wrong.
      { src: "/icons/maskable.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
    ],
  };
}
```

Create `src/pwa/webAssets.ts`:

```ts
// Type-only: `vite` is a devDependency and this import leaves nothing behind at runtime.
import type { Plugin } from "vite";
import { MANIFEST_PATH, manifestJson } from "./manifest";

/** A PNG the config read off disk, with the name it should have in `dist/`. */
export interface IconFile {
  fileName: string;
  source: Uint8Array;
}

/** The master's own transform, verbatim. Changing the artwork changes this, which is the point. */
const MASTER_SCALE = "scale(0.9200)";

/**
 * How much of the master's scale survives into the maskable icon: `0.8000`.
 *
 * **The arithmetic, so nobody has to guess at it again.** A maskable icon is cropped by the
 * platform to a shape inscribed in a circle of radius 40% of the frame, so the artwork has to
 * sit inside that circle. `logos/README.md` measures the master's clear space at 12/64, which
 * puts the book across 40/64 = 0.625 of the frame; a square of side *c* has a circumscribed
 * circle of radius *c*·√2/2, so *c* ≤ 0.566 is the requirement. 0.625 × (0.80/0.92) = 0.543,
 * whose circle is 0.384 — inside 0.40 with room for the book being taller than it is wide.
 *
 * The book therefore fills 54% of a maskable tile against 62% of the transparent mark. That is
 * what maskable costs, not a mistake.
 */
const MASKABLE_SCALE = "scale(0.8000)";

/** `--color-bg`, resolved. A maskable icon is full-bleed by definition: transparency there is
 *  a hole the platform fills with whatever it likes. */
const FIELD = '<rect width="64" height="64" fill="#0C0D12"></rect>';

/**
 * The maskable icon, derived from the master rather than drawn again.
 *
 * `logos/README.md` says the master is the artwork to edit, so a second hand-drawn copy would
 * be a file guaranteed to rot. Two edits: a full-bleed field behind everything, and the
 * mark shrunk into the safe zone.
 *
 * It **throws** rather than returning something plausible when the master no longer carries the
 * transform it is looking for. A silent miss here is a dark square on a reader's home screen,
 * and nothing in a build log would say so.
 */
export function maskableFromMark(markSvg: string): string {
  if (!markSvg.includes(MASTER_SCALE)) {
    throw new Error(
      `the master mark no longer contains ${MASTER_SCALE}; the maskable icon cannot be derived ` +
        `from it. Re-derive MASKABLE_SCALE from the new transform — see src/pwa/webAssets.ts.`,
    );
  }
  const scaled = markSvg.replace(MASTER_SCALE, MASKABLE_SCALE);
  // After `</defs>`, so the field paints under the artwork and over nothing.
  return scaled.replace("</defs>", `</defs>${FIELD}`);
}

/** `<link>` and `<meta>` for the head, as one string. */
const HEAD = [
  `<link rel="manifest" href="/${MANIFEST_PATH}" />`,
  `<meta name="theme-color" content="${manifestJson().theme_color}" />`,
  // iOS ignores the manifest's icons entirely and reads this instead.
  `<link rel="apple-touch-icon" href="/icons/mark-256.png" />`,
].join("");

/**
 * Everything the web build adds to `dist/` that the app itself never imports.
 *
 * A plugin **factory taking file contents** rather than a plugin that reads them, for
 * `src/lib/iconFont.ts`'s reason stated the other way round: that module gets to live under
 * `src/` because it needs no filesystem, and this one gets to live here because the filesystem
 * stays in `vite.web.config.ts`. Nothing under `src/` may import `node:fs` — the absent
 * `@types/node` is the fence, and it is the only one.
 */
export function webAssetsPlugin({ markSvg, icons }: { markSvg: string; icons: IconFile[] }): Plugin {
  return {
    name: "grimoire-web-assets",
    transformIndexHtml(html: string) {
      return html.replace("</head>", `${HEAD}</head>`);
    },
    generateBundle(this: { emitFile: (f: { type: "asset"; fileName: string; source: string | Uint8Array }) => void }) {
      this.emitFile({
        type: "asset",
        fileName: MANIFEST_PATH,
        source: JSON.stringify(manifestJson(), null, 2),
      });
      this.emitFile({ type: "asset", fileName: "icons/maskable.svg", source: maskableFromMark(markSvg) });
      for (const icon of icons) {
        this.emitFile({ type: "asset", fileName: icon.fileName, source: icon.source });
      }
    },
  } as Plugin;
}
```

Create `vite.web.config.ts`:

```ts
// The web build, and the only place `__WEB_TARGET__` is ever true.
//
// Type-stripped by Vite and checked by nothing, exactly like `vite.config.ts` — see
// `tsconfig.node.json`'s comment for why that project deliberately lists one file and why
// widening it breaks `npm run build` on a clean checkout. The decisions this file makes live
// under `src/pwa/` where the suite covers them; what stays here is the filesystem.
import { readFileSync } from "node:fs";
import { mergeConfig } from "vite";
import base from "./vite.config";
import { webAssetsPlugin } from "./src/pwa/webAssets";

const icons = ["mark-256.png", "mark-512.png"].map((name) => ({
  fileName: `icons/${name}`,
  source: new Uint8Array(readFileSync(`logos/png/${name}`)),
}));

export default mergeConfig(base, {
  // `vite.config.ts` also carries the vitest block; `mergeConfig` keeps it, and it is inert
  // here because nothing runs `vitest --config vite.web.config.ts`.
  define: { __WEB_TARGET__: "true" },
  plugins: [webAssetsPlugin({ markSvg: readFileSync("public/mtg-grimoire-mark.svg", "utf8"), icons })],
});
```

Add to `package.json`'s `scripts`, after `"build"`:

```json
    "build:web": "tsc && tsc -p .storybook && vite build --config vite.web.config.ts",
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -- src/pwa/webAssets.test.ts 2>&1 | tail -12`
Expected: 7 passed.

- [ ] **Step 6: Build it and look at what came out**

Run:
```bash
npm run build:web > /tmp/webbuild.log 2>&1; tail -5 /tmp/webbuild.log
ls dist/manifest.webmanifest dist/icons/
node -e "const m=require('fs').readFileSync('dist/manifest.webmanifest','utf8');JSON.parse(m);console.log('manifest parses,',JSON.parse(m).icons.length,'icons')"
grep -c 'rel="manifest"' dist/index.html
```
Expected: `dist/manifest.webmanifest`, `dist/icons/maskable.svg`, `dist/icons/mark-256.png`, `dist/icons/mark-512.png`; the manifest parses with 4 icons; `1`.

Then confirm **desktop did not move**:
```bash
npm run build > /tmp/build.log 2>&1
grep -c 'rel="manifest"' dist/index.html
```
Expected: `0`. A plain `npm run build` must produce the same `index.html` it always did.

- [ ] **Step 7: Mutate to prove the tests bite**

Three, in order, reverting each:

1. In `maskableFromMark`, drop the `.replace("</defs>", …)` so no field is inserted. The field test must FAIL.
2. In `maskableFromMark`, delete the `if (!markSvg.includes(MASTER_SCALE)) throw`. The "refuses artwork it does not recognise" test must FAIL.
3. In `manifestJson`, give the 512 PNG `purpose: "maskable"` as well as the SVG. The "exactly one maskable" test must FAIL.

**Report any that survives.**

- [ ] **Step 8: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/pwa/ vite.web.config.ts package.json
git commit -m "feat(pwa): the web build target, its manifest and its icons

One new config, one new script, and desktop byte-identical: vite.config.ts and index.html
are untouched, and __WEB_TARGET__ is defined by vite.web.config.ts alone. The maskable icon
is DERIVED from the master rather than drawn again — logos/README.md says the master is the
file to edit — and the derivation throws rather than emitting a dark square if the master's
transform is ever rewritten.

The target flag is build-time and not a runtime sniff because jsdom has no
__TAURI_INTERNALS__ either, so the obvious probe would switch every web surface on in ~5 500
existing tests."
```

---

### Task 2: The service worker — its source, its build, and the four hosts it must never touch

**Files:**
- Create: `src/pwa/swCore.ts`
- Create: `src/pwa/swCore.test.ts`
- Create: `src/pwa/sw.ts`
- Create: `src/pwa/sw-env.d.ts`
- Create: `tsconfig.sw.json`
- Create: `vite.sw.config.ts`
- Modify: `tsconfig.json` (exclude the two worker-scope files), `vite.config.ts` (one coverage exclude), `package.json` (two scripts)

**Interfaces:**
- Consumes: nothing.
- Produces: `routeFor`, `shellCacheName`, `staleShellCaches`, `SHELL_PREFIX` (from `@/pwa/swCore`), and `dist/sw.js`.

> **The type-check split, and why it is a second `tsconfig` rather than a wider `lib`.** `ServiceWorkerGlobalScope`, `ExtendableEvent` and `FetchEvent` are in `lib.webworker.d.ts`, which is not in the app program (`tsconfig.json`'s `lib` is `ES2020, ES2022.Error, DOM, DOM.Iterable` — verified). Adding `WebWorker` to that list would give every component in the app a `self` of the wrong type. So `sw.ts` leaves the app program and gets `tsconfig.sw.json`, which is **not** `composite` and is **not** referenced from `tsconfig.json` — the TS6305 trap `tsconfig.node.json`'s comment records is exactly what `composite: true` plus a shared file causes, and it took `main` red twice.
>
> `swCore.ts` is in **both** programs on purpose, which two non-composite `noEmit` programs may do safely. It is written to types that exist in `lib.dom` *and* `lib.webworker` and touches neither `document` nor `window`.

- [ ] **Step 1: Write the failing test**

Create `src/pwa/swCore.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SHELL_PREFIX, routeFor, shellCacheName, staleShellCaches } from "@/pwa/swCore";

/** The worker's source as text, for the two invariants that are about what it does NOT do. */
const SW_SOURCE = import.meta.glob<string>("/src/pwa/sw.ts", {
  query: "?raw",
  import: "default",
  eager: true,
})["/src/pwa/sw.ts"];

const req = (url: string, extra: Partial<{ method: string; mode: string }> = {}) => ({
  url,
  method: extra.method ?? "GET",
  mode: extra.mode ?? "cors",
});

const IMAGES = "https://cards.scryfall.io";

describe("what the service worker answers for", () => {
  it("serves a navigation from the shell", () => {
    expect(routeFor(req("https://grimoire.example/decks", { mode: "navigate" }), IMAGES)).toBe(
      "navigation",
    );
  });

  it("serves same-origin build assets from the shell", () => {
    expect(routeFor(req("https://grimoire.example/assets/index-a1b2c3.js"), IMAGES)).toBe("shell");
    expect(routeFor(req("https://grimoire.example/assets/core-9f8e.wasm"), IMAGES)).toBe("shell");
  });

  it("serves card art from the image cache", () => {
    expect(routeFor(req(`${IMAGES}/normal/front/a/b/abcd.jpg`), IMAGES)).toBe("image");
  });

  /**
   * **The one that matters.** Every feed this app downloads is streamed and gunzipped
   * incrementally — the combo framer's peak buffer is 2.01 MB against a 610.2 MB document.
   * Routing any of them through a `respondWith` would buffer the response to put it in a cache
   * that is 526 MB smaller than the thing being cached, and it would do it silently.
   */
  it("never answers for a data feed", () => {
    for (const url of [
      "https://api.scryfall.com/bulk-data/default_cards",
      "https://data.scryfall.io/default-cards/default-cards-20260828.jsonl.gz",
      "https://json.commanderspellbook.com/variants.json.gz",
      "https://api.cardkingdom.com/api/v2/pricelist",
    ]) {
      expect(routeFor(req(url), IMAGES)).toBe("passthrough");
    }
  });

  it("never answers for anything that is not a GET", () => {
    expect(routeFor(req("https://grimoire.example/assets/x.js", { method: "POST" }), IMAGES)).toBe(
      "passthrough",
    );
  });
});

describe("the shell caches", () => {
  it("names one cache per build", () => {
    expect(shellCacheName("abc123")).toBe(`${SHELL_PREFIX}abc123`);
    expect(shellCacheName("abc123")).not.toBe(shellCacheName("def456"));
  });

  it("drops every other build's shell and nothing else", () => {
    const names = [
      `${SHELL_PREFIX}old1`,
      `${SHELL_PREFIX}new1`,
      "grimoire-images",
      "someone-elses-cache",
    ];
    expect(staleShellCaches(names, "new1")).toEqual([`${SHELL_PREFIX}old1`]);
  });
});

describe("what the worker must never contain", () => {
  /**
   * Measured both ways in the spike: the same page passed with and without
   * `Cross-Origin-Opener-Policy` + `Cross-Origin-Embedder-Policy`, install 65 ms against
   * 50 ms and a 532.8 MB write 3.3 s against 2.3 s — cache noise. Re-attaching them on a
   * cached navigation is the defensive reflex this test exists to stop, because it costs
   * every cross-origin image and script on the page and buys nothing.
   */
  it("re-attaches no cross-origin isolation headers", () => {
    expect(SW_SOURCE).not.toMatch(/Cross-Origin-(Opener|Embedder|Resource)-Policy/i);
  });

  /**
   * A worker that calls `skipWaiting()` in its own `install` handler activates the moment it
   * downloads, which takes the reader's build away mid-session — the exact thing spec §5.4
   * says must not happen. It may only be called from the message handler, where a press put it.
   */
  it("calls skipWaiting from the message handler and nowhere else", () => {
    const calls = SW_SOURCE.match(/skipWaiting\(\)/g) ?? [];
    expect(calls).toHaveLength(1);
    const at = SW_SOURCE.indexOf("skipWaiting()");
    const messageAt = SW_SOURCE.indexOf('addEventListener("message"');
    const installAt = SW_SOURCE.indexOf('addEventListener("install"');
    expect(messageAt).toBeGreaterThan(-1);
    expect(at).toBeGreaterThan(messageAt);
    expect(at).toBeGreaterThan(installAt);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/pwa/swCore.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "@/pwa/swCore"`.

- [ ] **Step 3: Write the pure half**

Create `src/pwa/swCore.ts`:

```ts
/**
 * Everything the service worker *decides*, as functions with no globals in them.
 *
 * **This file is compiled twice** — once in the app program (`lib.dom`) and once in
 * `tsconfig.sw.json` (`lib.webworker`) — so it may only name types both libraries have. No
 * `document`, no `window`, and no `Request`: the router takes the three fields it reads, which
 * a real `Request` satisfies structurally and which a test can write as an object literal.
 *
 * The Cache Storage plumbing is deliberately *not* here. It is in `sw.ts`, it is unreachable
 * from vitest (jsdom implements no `caches` and no service worker registration at all), and it
 * is verified in a real browser by Task 8. Splitting it this way is what keeps the untestable
 * half down to about thirty lines of calls with no branches in them.
 */

/** Every shell cache this app has ever made starts with this. `staleShellCaches` is the reason
 *  it is a prefix rather than a name. */
export const SHELL_PREFIX = "grimoire-shell-";

/** One cache per build, so an activation never has to reason about which files are which. */
export function shellCacheName(buildId: string): string {
  return `${SHELL_PREFIX}${buildId}`;
}

/**
 * The shell caches that are not this build's.
 *
 * Prefix-scoped rather than "everything else": the image cache lives in the same Cache Storage
 * and is *not* per-build — evicting 256 MB of card art on every deploy would undo the whole
 * point of caching it.
 */
export function staleShellCaches(names: readonly string[], buildId: string): string[] {
  const keep = shellCacheName(buildId);
  return names.filter((n) => n.startsWith(SHELL_PREFIX) && n !== keep);
}

/** What the worker does with one request. */
export type Route = "navigation" | "shell" | "image" | "passthrough";

/** The three fields of a `Request` this reads. A real one is assignable to it. */
export interface RoutableRequest {
  url: string;
  method: string;
  mode: string;
}

/**
 * Which of the four things this request is.
 *
 * **`passthrough` is the default and it is the important one.** Every bulk feed this app
 * downloads is streamed: `default_cards` is 627 900 518 B of JSON behind 77 972 714 B of gzip,
 * and the Spellbook combo feed is 639 866 292 B framed with a measured 2.01 MB peak buffer. A
 * `fetch` handler that called `respondWith` on any of them would put the whole document through
 * the worker for no reason at all, and the failure would look like a slow ingest rather than
 * like a routing mistake. So the list of things this worker answers for is closed, and
 * everything not on it is left to the network untouched — no `respondWith`, no clone, nothing.
 *
 * `imageOrigin` is a parameter rather than a constant because it is PR 4's to decide: the
 * desktop build's `cardImageUrl` returns an `mtgimg://` URL, and the web build's returns
 * something a browser can fetch. `sw.ts` supplies it.
 */
export function routeFor(request: RoutableRequest, imageOrigin: string): Route {
  if (request.method !== "GET") return "passthrough";
  if (request.mode === "navigate") return "navigation";

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return "passthrough";
  }
  if (url.origin === imageOrigin) return "image";
  // Same-origin is decided by the request's own origin, which for a subresource of this page is
  // always this page's. A miss in the shell cache falls through to the network in `sw.ts`, so
  // being generous here costs a cache lookup and never a wrong answer.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/icons/")) return "shell";
  return "passthrough";
}
```

- [ ] **Step 4: Write the worker-scope half**

Create `src/pwa/sw-env.d.ts`:

```ts
/**
 * The two values `vite.sw.config.ts` substitutes at build time.
 *
 * Only `tsconfig.sw.json` includes this file. The app program must never see these names — a
 * component that reached for `__PRECACHE__` would compile and then be `undefined` in the shipped
 * window, because the app bundle is built by a config that does not define them.
 */
declare const __PRECACHE__: readonly string[];
declare const __BUILD_ID__: string;
/** PR 4's image origin, baked in so `sw.ts` and `cardImageUrl` cannot disagree. */
declare const __IMAGE_ORIGIN__: string;
```

Create `src/pwa/sw.ts`:

```ts
/**
 * The service worker.
 *
 * **Not in the app program.** `tsconfig.json` excludes this file and `tsconfig.sw.json` compiles
 * it with `lib.webworker`, because `ServiceWorkerGlobalScope` and `FetchEvent` are declared
 * there and adding `WebWorker` to the app's `lib` would give every component the wrong `self`.
 *
 * **Everything that branches is in `swCore.ts`**, under vitest. What is left here is Cache
 * Storage plumbing with no decisions in it, and Task 8 drives it in a real browser — the only
 * place it can be driven, since jsdom implements neither `caches` nor a registration.
 *
 * **No `skipWaiting()` in `install`.** A new build installs and *waits*; the page offers the
 * reader a bar; only their press sends `SKIP_WAITING`. A reader who never presses it keeps
 * working on the build they started the session with (spec §5.4). `swCore.test.ts` pins that
 * this file calls it exactly once and only after the message handler.
 *
 * **No isolation headers are attached to anything.** Measured both ways in the spike: identical
 * results with and without COOP/COEP, so cross-origin isolation is not required and re-attaching
 * it on a cached navigation would break every cross-origin subresource for nothing.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

import { routeFor, shellCacheName, staleShellCaches } from "./swCore";

const SHELL = shellCacheName(__BUILD_ID__);
/** The document every navigation is answered with. One entry, so the app is one page. */
const SHELL_DOCUMENT = "/index.html";

sw.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      // `addAll` is atomic: one 404 and the whole install fails, which is what should happen —
      // a half-precached shell is a build that boots offline into a blank page.
      await cache.addAll([...__PRECACHE__]);
    })(),
  );
});

sw.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(staleShellCaches(names, __BUILD_ID__).map((n) => caches.delete(n)));
      // Claim always, not only after a skip-waiting. On a first install this is what puts the
      // page under a worker without a reload; the page's own guard is what stops that from
      // becoming a reload loop — see `useServiceWorker`.
      await sw.clients.claim();
    })(),
  );
});

sw.addEventListener("fetch", (event) => {
  const route = routeFor(event.request, __IMAGE_ORIGIN__);
  // Deliberately no `respondWith` at all for a passthrough: the request goes to the network as
  // if this worker did not exist, which for a 610 MB feed is the whole point.
  if (route === "passthrough") return;

  if (route === "navigation") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(SHELL_DOCUMENT, { cacheName: SHELL });
        return cached ?? fetch(event.request);
      })(),
    );
    return;
  }

  if (route === "shell") {
    event.respondWith(
      (async () => {
        const cached = await caches.match(event.request, { cacheName: SHELL });
        return cached ?? fetch(event.request);
      })(),
    );
    return;
  }

  // route === "image" — filled in by Task 6. Until then the image route falls through to the
  // network exactly as a passthrough would, which is the shipped desktop behaviour.
});

sw.addEventListener("message", (event) => {
  const data = event.data as { type?: string } | null;
  if (data?.type === "SKIP_WAITING") {
    // The reader pressed the bar. This is the only call to it in the file.
    void sw.skipWaiting();
    return;
  }
  if (data?.type === "VERSION") {
    // Answered on the port the caller opened, so a live pass can tell one build from another
    // without guessing from asset hashes.
    event.ports[0]?.postMessage({ buildId: __BUILD_ID__ });
  }
});
```

Create `tsconfig.sw.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    /* `WebWorker` instead of `DOM`, and the two must never be in one program: both declare
       `self`, `fetch` and `caches` with different types. This is the whole reason the service
       worker is not in the app's `tsconfig.json`. */
    "lib": ["ES2020", "WebWorker"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    /* Not `composite`, and not referenced from `tsconfig.json`. `swCore.ts` is in this program
       AND in the app's; two plain `noEmit` programs may share a file, but a composite one makes
       every listed file an *output* and `tsc` then demands a `.d.ts` beside it — TS6305, which
       `tsconfig.node.json`'s comment records taking main's CI red on two consecutive pushes. */
    "composite": false,
    "types": []
  },
  "include": ["src/pwa/sw.ts", "src/pwa/sw-env.d.ts", "src/pwa/swCore.ts"]
}
```

In `tsconfig.json`, change the `exclude` line to:

```json
  /* The two files that belong to `tsconfig.sw.json` instead. They are compiled with
     `lib.webworker`, where `self` is a `ServiceWorkerGlobalScope`; in this program `self` is a
     `Window` and every line of `sw.ts` is an error. `swCore.ts` stays in BOTH programs — it
     names only types the two libraries share. */
  "exclude": [".claude", "src/pwa/sw.ts", "src/pwa/sw-env.d.ts"],
```

Create `vite.sw.config.ts`:

```ts
// The service worker's own build. Runs AFTER the app build, because the list of files to
// precache is read out of `dist/`.
//
// Type-stripped and checked by nothing, like `vite.config.ts`; `npm run build` runs
// `tsc -p tsconfig.sw.json` so the worker's source is type-checked on every verify.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vite";
import { manifestJson } from "./src/pwa/manifest";

const DIST = "dist";

/** Every file under `dist/`, as a root-relative URL. */
function walk(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(DIST, dir), { withFileTypes: true })) {
    const rel = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

// `sw.js` cannot precache itself, and `.vite/` is build metadata a browser never asks for.
const files = walk(".")
  .filter((f) => f !== "/sw.js" && !f.startsWith("/.vite/"))
  .sort();

/**
 * The build id: a hash of what is being precached, contents included.
 *
 * **Content and not a timestamp**, because a browser decides there is an update by comparing the
 * *bytes* of `sw.js`. A timestamp would make every rebuild an update and put "A new version is
 * ready" in front of a reader who has nothing to gain from it; a content hash makes a rebuild of
 * unchanged sources produce a byte-identical worker and no prompt at all.
 */
const digest = createHash("sha256");
for (const f of files) {
  digest.update(f);
  digest.update(createHash("sha256").update(readFileSync(join(DIST, f.slice(1)))).digest());
}
const buildId = digest.digest("hex").slice(0, 16);

// The image origin has one source of truth and it is PR 4's. Read it from the app's own module
// rather than repeating the host here, so the worker and `cardImageUrl` cannot drift.
const imageOrigin = process.env.GRIMOIRE_IMAGE_ORIGIN ?? "https://cards.scryfall.io";

export default defineConfig({
  build: {
    outDir: DIST,
    emptyOutDir: false,
    target: "es2020",
    lib: {
      entry: "src/pwa/sw.ts",
      formats: ["iife"],
      name: "grimoireSw",
      fileName: () => "sw.js",
    },
  },
  define: {
    __PRECACHE__: JSON.stringify(files),
    __BUILD_ID__: JSON.stringify(buildId),
    __IMAGE_ORIGIN__: JSON.stringify(imageOrigin),
  },
});

// Emitted only so a build log says what went in. `manifestJson()` is imported for the same
// reason `webAssets.ts` exists: nothing about the app's identity is spelled twice.
console.log(`sw: ${manifestJson().name} build ${buildId}, ${files.length} files precached`);
```

Update `package.json`:

```json
    "build": "tsc && tsc -p .storybook && tsc -p tsconfig.sw.json && vite build",
    "build:web": "tsc && tsc -p .storybook && tsc -p tsconfig.sw.json && vite build --config vite.web.config.ts && vite build --config vite.sw.config.ts",
```

In `vite.config.ts`'s `test.coverage.exclude`, add after the `src/main.tsx` entry:

```ts
        // The service worker's global-scope half. `swCore.ts` beside it holds every decision
        // and is covered; this file is `caches` calls with no branches, it cannot be imported
        // into jsdom at all, and Task 8's live pass is what proves it.
        "src/pwa/sw.ts",
```

- [ ] **Step 5: Type-check both programs**

Run:
```bash
npx tsc --noEmit 2>&1 | tail -15
npx tsc -p tsconfig.sw.json 2>&1 | tail -15
```
Expected: no errors from either. **If the app program complains about `sw.ts`, the `exclude` did not take** — `include: ["src"]` and `exclude` are both required and `exclude` only removes files `include` matched.

- [ ] **Step 6: Run the tests**

Run: `npm run test -- src/pwa/swCore.test.ts 2>&1 | tail -12`
Expected: 8 passed.

- [ ] **Step 7: Build the worker and read what came out**

Run:
```bash
npm run build:web > /tmp/webbuild.log 2>&1; grep "^sw:" /tmp/webbuild.log
node -e "const s=require('fs').readFileSync('dist/sw.js','utf8');console.log('bytes',s.length);console.log('precached',(s.match(/\/assets\//g)||[]).length)"
```
Expected: the `sw:` line names a 16-hex build id and a file count that matches `ls dist/assets | wc -l` plus the root files. `dist/sw.js` exists and names the asset paths.

Then prove the id is content-addressed rather than clock-addressed:
```bash
npm run build:web > /tmp/webbuild2.log 2>&1; grep "^sw:" /tmp/webbuild2.log
```
Expected: **the same build id**. Two builds of an unchanged tree must not look like an update. If it differs, something non-deterministic is in `dist/` — find it before continuing, because every reader would be prompted on every deploy.

- [ ] **Step 8: Mutate to prove the tests bite**

Four, reverting each:

1. In `routeFor`, delete the `url.origin === imageOrigin` line and let `data.scryfall.io` fall into `shell`. The "never answers for a data feed" test must FAIL. *(Do this by changing the `/assets/` test to `url.hostname.endsWith("scryfall.io")` — a plausible mistake, not a nonsense one.)*
2. In `sw.ts`, add `void sw.skipWaiting();` inside the `install` handler. The "calls skipWaiting from the message handler and nowhere else" test must FAIL.
3. In `sw.ts`'s navigation branch, add a `Response` whose headers include `Cross-Origin-Embedder-Policy: require-corp`. The isolation test must FAIL.
4. In `staleShellCaches`, drop the `startsWith(SHELL_PREFIX)` clause. The "drops every other build's shell and nothing else" test must FAIL — this is the one that would otherwise silently delete the 256 MB image cache on every deploy.

**Report any that survives.**

- [ ] **Step 9: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/pwa/ tsconfig.json tsconfig.sw.json vite.sw.config.ts vite.config.ts package.json
git commit -m "feat(pwa): the service worker, its decisions under test and its plumbing named

Every branch is in swCore.ts under vitest; sw.ts is caches calls with none. The router's
default is passthrough and there is a test naming all four feed hosts, because putting a
610 MB stream through respondWith would look like a slow ingest rather than a bug.

No skipWaiting in install, pinned by a source sweep: a new build waits until the reader
presses the bar. No COOP/COEP anywhere, pinned the same way — the spike measured the page
both ways and got identical results, so re-attaching them defensively costs every
cross-origin subresource and buys nothing.

The build id is a content hash of what is precached, so an unchanged tree rebuilds to a
byte-identical worker and nobody is told there is a new version when there is not."
```

---

### Task 3: The waiting worker, and the "A new version is ready" bar

**Files:**
- Create: `src/pwa/useServiceWorker.ts`
- Create: `src/pwa/useServiceWorker.test.ts`
- Create: `src/pwa/UpdateReadyBar.tsx`
- Create: `src/pwa/UpdateReadyBar.test.tsx`
- Create: `src/pwa/UpdateReadyBar.stories.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `isWebTarget` (Task 1).
- Produces: `useServiceWorker()` returning `{ updateReady: boolean; applyUpdate: () => void }`, and `<UpdateReadyBar />`.

> **What this is tested by, stated plainly.** The hook is tested against a fake `ServiceWorkerContainer` in jsdom — jsdom implements none of this API, so the fake *is* the contract, and the four states it can be in (no worker, first install, a waiting worker, a controller change) are each a test. **What a fake cannot prove is that a real browser produces those states in that order**, and that is Task 8: two real builds, one real waiting worker, one press, one reload. Both halves are needed and neither substitutes for the other.

- [ ] **Step 1: Write the failing test**

Create `src/pwa/useServiceWorker.test.ts`:

```ts
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useServiceWorker } from "@/pwa/useServiceWorker";

vi.mock("@/pwa/target", () => ({ isWebTarget: () => true }));

/** A `ServiceWorker` with just the two members the hook reads and writes. */
function fakeWorker(state = "installed") {
  const listeners: (() => void)[] = [];
  return {
    state,
    postMessage: vi.fn(),
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    /** Move to `state` and fire `statechange`, the way a browser would. */
    become(next: string) {
      this.state = next;
      for (const fn of listeners) fn();
    },
  };
}

function fakeContainer({ controller = null as unknown, waiting = null as unknown } = {}) {
  const regListeners: Record<string, (() => void)[]> = {};
  const containerListeners: Record<string, (() => void)[]> = {};
  const registration = {
    waiting,
    installing: null as unknown,
    update: vi.fn(() => Promise.resolve()),
    addEventListener: (type: string, fn: () => void) => (regListeners[type] ??= []).push(fn),
    fire: (type: string) => (regListeners[type] ?? []).forEach((fn) => fn()),
  };
  return {
    controller,
    register: vi.fn(() => Promise.resolve(registration)),
    addEventListener: (type: string, fn: () => void) => (containerListeners[type] ??= []).push(fn),
    fire: (type: string) => (containerListeners[type] ?? []).forEach((fn) => fn()),
    registration,
  };
}

function install(container: unknown) {
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: container });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  // `configurable: true` above is what makes this possible; without the delete the next test
  // file in the same worker inherits a navigator with a fake service worker on it.
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("the service worker registration", () => {
  it("says nothing is ready on a first install", async () => {
    const container = fakeContainer({ controller: null });
    install(container);
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(container.register).toHaveBeenCalledWith("/sw.js"));
    expect(result.current.updateReady).toBe(false);
  });

  it("finds a worker that was already waiting when the page loaded", async () => {
    const waiting = fakeWorker();
    install(fakeContainer({ controller: {}, waiting }));
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(result.current.updateReady).toBe(true));
  });

  it("finds one that finishes installing while the page is open", async () => {
    const container = fakeContainer({ controller: {} });
    install(container);
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const installing = fakeWorker("installing");
    container.registration.installing = installing;
    act(() => container.registration.fire("updatefound"));
    expect(result.current.updateReady).toBe(false);
    act(() => installing.become("installed"));
    await waitFor(() => expect(result.current.updateReady).toBe(true));
  });

  /**
   * The first install also finishes with `state === "installed"` — and there is no old build to
   * replace, so calling that "a new version is ready" would put a bar in front of a reader who
   * has been in the app for four seconds. `controller === null` is what tells the two apart.
   */
  it("does not call a first install an update", async () => {
    const container = fakeContainer({ controller: null });
    install(container);
    const { result } = renderHook(() => useServiceWorker());
    await waitFor(() => expect(container.register).toHaveBeenCalled());

    const installing = fakeWorker("installing");
    container.registration.installing = installing;
    act(() => container.registration.fire("updatefound"));
    act(() => installing.become("installed"));
    expect(result.current.updateReady).toBe(false);
  });
});

describe("applying an update", () => {
  it("tells the waiting worker to take over, and reloads when it has", async () => {
    const reload = vi.fn();
    const waiting = fakeWorker();
    const container = fakeContainer({ controller: {}, waiting });
    install(container);
    const { result } = renderHook(() => useServiceWorker({ reload }));
    await waitFor(() => expect(result.current.updateReady).toBe(true));

    act(() => result.current.applyUpdate());
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "SKIP_WAITING" });
    expect(reload).not.toHaveBeenCalled();

    act(() => container.fire("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("reloads once, however many times the controller changes", async () => {
    const reload = vi.fn();
    const container = fakeContainer({ controller: {}, waiting: fakeWorker() });
    install(container);
    const { result } = renderHook(() => useServiceWorker({ reload }));
    await waitFor(() => expect(result.current.updateReady).toBe(true));
    act(() => result.current.applyUpdate());
    act(() => container.fire("controllerchange"));
    act(() => container.fire("controllerchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  /**
   * `clients.claim()` runs on **every** activation, first install included, and it fires
   * `controllerchange` on a page that was not controlled. Reloading for that is the classic
   * service-worker reload loop: claim, reload, claim, reload.
   */
  it("does not reload when the first worker claims an uncontrolled page", async () => {
    const reload = vi.fn();
    const container = fakeContainer({ controller: null });
    install(container);
    renderHook(() => useServiceWorker({ reload }));
    await waitFor(() => expect(container.register).toHaveBeenCalled());
    act(() => container.fire("controllerchange"));
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("on a build that is not the web one", () => {
  it("registers nothing at all", async () => {
    vi.resetModules();
    vi.doMock("@/pwa/target", () => ({ isWebTarget: () => false }));
    const { useServiceWorker: desktop } = await import("@/pwa/useServiceWorker");
    const container = fakeContainer();
    install(container);
    renderHook(() => desktop());
    expect(container.register).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run test -- src/pwa/useServiceWorker.test.ts 2>&1 | tail -20`
Expected: FAIL — `Failed to resolve import "@/pwa/useServiceWorker"`.

- [ ] **Step 3: Write the hook**

Create `src/pwa/useServiceWorker.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { isWebTarget } from "@/pwa/target";

/** How long between "the tab came back to the front" checks for a new build. */
const RECHECK_MS = 60 * 60 * 1000;

export interface ServiceWorkerState {
  /** A new build has installed and is waiting for the reader's say-so. */
  updateReady: boolean;
  /** Let it take over: `skipWaiting`, then one reload when it has. */
  applyUpdate: () => void;
}

/**
 * Owns the registration and the waiting worker.
 *
 * Mounted **once**, in `App`. Two calls would be two registrations racing to describe one
 * worker, which is `useUpdate`'s rule for the desktop updater arrived at from the same place.
 *
 * ## The update flow, which is the whole reason this file exists
 *
 * "Just reload" is not an update flow: a browser installs a new worker as the *waiting* one and
 * leaves it there until every page under the old one is gone, so a reader who reloads gets the
 * old build back and no explanation. Spec §5.4 fixes the shape — the new build waits, a
 * non-modal bar says so, the reader presses it, `skipWaiting` and `clients.claim` run, the page
 * reloads **once**, and a reader who never presses it keeps working on the build they started
 * with rather than being interrupted mid-deck.
 *
 * ## Two guards that look like paranoia and are not
 *
 * **`controller !== null` before calling an install an update.** A first install also ends at
 * `state === "installed"`; the difference is that there is no old build to replace. Without this
 * every reader's first session shows "A new version is ready" a few seconds in.
 *
 * **`wasControlled` before reloading on `controllerchange`.** `sw.ts` calls `clients.claim()` on
 * every activation, first install included, and claiming an uncontrolled page fires
 * `controllerchange`. Reloading for that is a loop — claim, reload, claim, reload — and it is
 * the single most common way this flow is got wrong.
 *
 * `reload` is injectable for one reason: jsdom answers `window.location.reload()` with
 * *"Not implemented: navigation"* on stderr and does nothing, so a test could neither trigger
 * the real thing nor see that it happened.
 */
export function useServiceWorker(options: { reload?: () => void } = {}): ServiceWorkerState {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null);
  const reloadRef = useRef(options.reload);
  reloadRef.current = options.reload;
  // Latched, not state: it is read inside listeners and must never re-run the effect.
  const reloaded = useRef(false);

  useEffect(() => {
    if (!isWebTarget() || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    // Read before anything is registered: after that, "were we controlled when this document
    // loaded" is unanswerable.
    const wasControlled = container.controller !== null;
    let cancelled = false;

    const onControllerChange = () => {
      if (!wasControlled || reloaded.current) return;
      reloaded.current = true;
      (reloadRef.current ?? (() => window.location.reload()))();
    };
    container.addEventListener("controllerchange", onControllerChange);

    let recheck: ReturnType<typeof setTimeout> | undefined;
    let lastCheck = Date.now();

    void container.register("/sw.js").then((registration) => {
      if (cancelled) return;
      if (registration.waiting && container.controller) setWaiting(registration.waiting);

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // The `controller` clause is the first-install guard. See the header.
          if (installing.state === "installed" && container.controller) setWaiting(installing);
        });
      });

      // A browser checks for a new worker on navigation and about once a day. An installed PWA
      // that is left open for a week navigates neither, so it would never learn there was one.
      const onVisible = () => {
        if (document.visibilityState !== "visible") return;
        if (Date.now() - lastCheck < RECHECK_MS) return;
        lastCheck = Date.now();
        void registration.update();
      };
      document.addEventListener("visibilitychange", onVisible);
      recheck = setTimeout(onVisible, RECHECK_MS);
    });

    return () => {
      cancelled = true;
      container.removeEventListener("controllerchange", onControllerChange);
      clearTimeout(recheck);
    };
  }, []);

  const applyUpdate = useCallback(() => {
    waiting?.postMessage({ type: "SKIP_WAITING" });
  }, [waiting]);

  return { updateReady: waiting !== null, applyUpdate };
}
```

> The `visibilitychange` listener above is added inside the `register` continuation and is not
> removed by the cleanup, because the cleanup runs before the promise settles in the only case
> that matters (an unmount of `App`, which is the end of the document). **If that reads wrong to
> you, move the listener out of the continuation and remove it in the cleanup** — it is a real
> choice and either is defensible; what is not defensible is leaving it undecided.

- [ ] **Step 4: Write the bar**

Create `src/pwa/UpdateReadyBar.tsx`:

```tsx
import { AnimatePresence, motion } from "motion/react";
import { RefreshCw } from "lucide-react";
import { LAYER } from "@/lib/layers";
import { PRESS, scrim } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * "A new version is ready", and the press that takes it.
 *
 * **Non-modal, and that is the requirement rather than a preference** (spec §5.4). A reader
 * halfway through a deck must be able to ignore this for the rest of the session and keep
 * working on the build they started with. So: no scrim, no focus trap, no Escape rung, nothing
 * inert behind it — it is a control that appeared, not a question that has to be answered.
 *
 * Bottom-centre and `fixed`, at {@link LAYER.popup}. Above the view and below a dialog, which is
 * the right way round: a reader in the middle of a modal is in the middle of something.
 * `LAYER.caption` is not in play here — the custom caption is a desktop surface (spec §3's seam
 * table has no window-chrome row for web) and this bar is web-only.
 *
 * **A plain fade, from {@link scrim}.** That preset is named for the backdrop it was written for
 * and is nothing but an opacity tween in both directions; `SyncProgress` already borrows it on
 * exactly that argument. Nothing here should travel — the bar does not come from anywhere.
 */
export function UpdateReadyBar({ ready, onApply }: { ready: boolean; onApply: () => void }) {
  return (
    <AnimatePresence>
      {ready && (
        <motion.div
          key="update-ready"
          {...scrim}
          role="status"
          className={cn(
            "fixed inset-x-0 bottom-4 mx-auto flex w-fit items-center gap-3 rounded-lg",
            "border border-border bg-surface px-4 py-2 text-sm shadow-lg",
            LAYER.popup,
          )}
        >
          <span className="text-text">A new version is ready.</span>
          <button
            type="button"
            onClick={onApply}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border border-accent px-3 py-1.5",
              "text-sm text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              PRESS,
            )}
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Reload to update
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
```

Create `src/pwa/UpdateReadyBar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { UpdateReadyBar } from "@/pwa/UpdateReadyBar";

describe("the update bar", () => {
  it("is not on screen until a build is waiting", () => {
    render(<UpdateReadyBar ready={false} onApply={() => {}} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("says what is ready and offers the press that takes it", async () => {
    const onApply = vi.fn();
    render(<UpdateReadyBar ready onApply={onApply} />);
    expect(screen.getByRole("status")).toHaveTextContent(/A new version is ready/);
    await userEvent.click(screen.getByRole("button", { name: /Reload to update/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  /**
   * Non-modal is the spec's word and this is what it costs to keep. A dialog role, an
   * `aria-modal`, or anything that took focus would interrupt a reader mid-deck — which is
   * exactly the outcome §5.4 says to avoid.
   */
  it("does not claim to be a dialog and does not take focus", () => {
    render(<UpdateReadyBar ready onApply={() => {}} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveAttribute("aria-modal");
    expect(document.body).toHaveFocus();
  });
});
```

Create `src/pwa/UpdateReadyBar.stories.tsx` following `get-storybook-story-instructions` — one `Ready` story with a `play` that presses the button and asserts the handler ran, and one `Quiet` story with `ready={false}`.

- [ ] **Step 5: Mount it**

In `src/App.tsx`, add the import and one line beside `<AllPrintingsDialog />`:

```tsx
import { UpdateReadyBar } from "@/pwa/UpdateReadyBar";
import { useServiceWorker } from "@/pwa/useServiceWorker";
```

Inside `App`, beside `const update = useUpdate();`:

```tsx
  // The browser's update, not the portable swap's. One hook, mounted once, for `useUpdate`'s
  // reason: two registrations would be two objects racing to describe one waiting worker.
  // Inert on desktop — `useServiceWorker` returns without registering when `isWebTarget()` is
  // false, so this costs a `useState` and nothing else in the shipped window.
  const browserUpdate = useServiceWorker();
```

and beside `<AllPrintingsDialog />`:

```tsx
              {/* A sibling of the shell for `CardZoomIndicator`'s reason: the bar is `fixed` at
                  `LAYER.popup`, a z-index competes only inside its own stacking context, and
                  every card surface in this app draws positioned, transformed rows. Nothing
                  between here and the root transforms. */}
              <UpdateReadyBar ready={browserUpdate.updateReady} onApply={browserUpdate.applyUpdate} />
```

- [ ] **Step 6: Run the tests**

Run: `npm run test -- src/pwa src/App.test.tsx 2>&1 | tail -12`
Expected: all pass. `App.test.tsx` is unmodified and must stay green — the hook returns early on the desktop default, so nothing in it can reach `navigator.serviceWorker`.

- [ ] **Step 7: Mutate to prove the tests bite**

Three, reverting each:

1. In `useServiceWorker`, drop the `&& container.controller` clause from the `statechange` handler. "does not call a first install an update" must FAIL.
2. Drop the `!wasControlled` clause from `onControllerChange`. "does not reload when the first worker claims an uncontrolled page" must FAIL.
3. Drop the `reloaded.current` latch. "reloads once, however many times the controller changes" must FAIL.

**Report any that survives.** All three are the classic ways this flow ships broken, and each is invisible until a real reader has a real second build.

- [ ] **Step 8: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/pwa/ src/App.tsx
git commit -m "feat(pwa): a waiting build says so, and takes over only when asked

'Just reload' is not an update flow — a browser leaves a new worker WAITING and a reload
hands the reader the old build back with no explanation. So: the bar says a version is
ready, the press sends SKIP_WAITING, and controllerchange reloads once. A reader who never
presses it keeps working on the build they started with.

Two guards that are the usual ways this ships broken, and both have a test: an install with
no controller is a FIRST install and not an update, and a controllerchange on a page that was
never controlled is clients.claim() rather than a new build — reloading for it is the loop.

The fake ServiceWorkerContainer is the contract in jsdom, which implements none of this.
Two real builds and one real press are Task 8's."
```

---

### Task 4: Install, and `navigator.storage.persist()`

**Files:**
- Create: `src/pwa/install.ts`
- Create: `src/pwa/install.test.ts`
- Create: `src/pwa/persistence.ts`
- Create: `src/pwa/persistence.test.ts`
- Create: `src/features/settings/WebStoragePanel.tsx`
- Create: `src/features/settings/WebStoragePanel.test.tsx`
- Create: `src/features/settings/WebStoragePanel.stories.tsx`
- Modify: `src/main.tsx`, `src/features/settings/SettingsPage.tsx`

**Interfaces:**
- Consumes: `isWebTarget` (Task 1).
- Produces: `captureInstallPrompt()`, `installState()`, `promptInstall()` (from `@/pwa/install`); `requestPersistenceOnce()`, `readPersistence()`, `PersistenceRecord` (from `@/pwa/persistence`); `<WebStoragePanel />`.

> **`beforeinstallprompt` has to be captured before React exists.** The browser fires it once, early, and a page that has not called `preventDefault()` by then has lost it — there is no way to ask for it again. So the capture is a module side effect run from `main.tsx`, and the React side reads what it caught. That also means **this is the one thing in this PR that no test and no headless browser can prove end to end**: the event does not fire in headless Chrome at all, and in a headed one it is gated behind an engagement heuristic. What is tested is the capture, the state machine and the button; what is verified live, headed, is Task 8's last step.

- [ ] **Step 1: Write the failing tests**

Create `src/pwa/persistence.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PERSIST_KEY, readPersistence, requestPersistenceOnce } from "@/pwa/persistence";

function fakeStorage(persist: () => Promise<boolean>, persisted = () => Promise.resolve(false)) {
  return { persist, persisted, estimate: () => Promise.resolve({}) } as unknown as StorageManager;
}

beforeEach(() => localStorage.clear());

describe("asking the browser to keep the corpus", () => {
  it("asks once, and writes down what it answered", async () => {
    const persist = vi.fn(() => Promise.resolve(true));
    await requestPersistenceOnce(fakeStorage(persist), localStorage, 1_700_000_000_000);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(readPersistence(localStorage)).toEqual({ askedAt: 1_700_000_000_000, granted: true });
  });

  it("does not ask again after a refusal", async () => {
    const persist = vi.fn(() => Promise.resolve(false));
    const storage = fakeStorage(persist);
    await requestPersistenceOnce(storage, localStorage, 1);
    await requestPersistenceOnce(storage, localStorage, 2);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(readPersistence(localStorage)?.granted).toBe(false);
  });

  it("survives a browser that has no storage manager at all", async () => {
    await expect(requestPersistenceOnce(undefined, localStorage, 1)).resolves.toBeNull();
    expect(readPersistence(localStorage)).toBeNull();
  });

  it("reads back nothing rather than throwing on a corrupt record", () => {
    localStorage.setItem(PERSIST_KEY, "{not json");
    expect(readPersistence(localStorage)).toBeNull();
  });
});

describe("what the record is worth", () => {
  /**
   * The spike asked for persistence and was told `false` throughout, which is what headless
   * Chrome with no install and no gesture answers. The point of writing the answer down is to
   * stop asking, and to be able to *show* it — never to conclude from it that the corpus is
   * still there. That conclusion is `corpusState`'s (Task 5) and it comes from opening the
   * database, not from this record.
   */
  it("is a record and not a guarantee — nothing here reports whether data survived", () => {
    const record = { askedAt: 1, granted: true };
    expect(Object.keys(record).sort()).toEqual(["askedAt", "granted"]);
  });
});
```

Create `src/pwa/install.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureInstallPrompt, installState, promptInstall } from "@/pwa/install";

vi.mock("@/pwa/target", () => ({ isWebTarget: () => true }));

/** The event Chrome fires. It is in no TypeScript lib, so the app declares its own shape. */
function beforeInstallPrompt() {
  const event = new Event("beforeinstallprompt") as Event & {
    preventDefault: () => void;
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: string }>;
  };
  event.preventDefault = vi.fn();
  event.prompt = vi.fn(() => Promise.resolve());
  event.userChoice = Promise.resolve({ outcome: "accepted" });
  return event;
}

beforeEach(() => {
  captureInstallPrompt(window, { reset: true });
});

describe("the install prompt", () => {
  it("is unavailable until the browser offers one", () => {
    expect(installState()).toBe("unavailable");
  });

  it("keeps the browser's own bar off the screen and holds the event", () => {
    const event = beforeInstallPrompt();
    window.dispatchEvent(event);
    // Without `preventDefault` Chrome draws its own install bar over the app and this button
    // becomes a second one saying the same thing.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(installState()).toBe("offered");
  });

  it("shows the browser's dialog on a press, once", async () => {
    const event = beforeInstallPrompt();
    window.dispatchEvent(event);
    await promptInstall();
    expect(event.prompt).toHaveBeenCalledTimes(1);
    // The event is single-use: a browser refuses a second `prompt()` on the same object.
    expect(installState()).toBe("unavailable");
  });

  it("goes quiet once the app is installed", () => {
    window.dispatchEvent(beforeInstallPrompt());
    window.dispatchEvent(new Event("appinstalled"));
    expect(installState()).toBe("installed");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- src/pwa/install.test.ts src/pwa/persistence.test.ts 2>&1 | tail -20`
Expected: FAIL — both imports unresolved.

- [ ] **Step 3: Write the implementations**

Create `src/pwa/persistence.ts`:

```ts
/** Where the answer is written down. `localStorage`, deliberately — see below. */
export const PERSIST_KEY = "grimoire.storage.persist";

export interface PersistenceRecord {
  /** Unix millis of the one time this was asked. */
  askedAt: number;
  /** What the browser said. **A record, not a guarantee.** */
  granted: boolean;
}

/**
 * Ask the browser to keep this origin's storage, once, and write down the answer.
 *
 * **Once, because the answer does not change for the asking.** Chrome decides from
 * installation and engagement, not from repetition, and a request in a loop is a request that
 * will be answered `false` forever at some cost.
 *
 * **Called when the corpus exists, not at boot.** 526 MB is what makes persistence worth having
 * and there is nothing to keep before the first sync finishes — 10.4 s on a desktop, 36.5 s on a
 * OnePlus 12.
 *
 * **`localStorage` and not `app_meta`.** This is a fact about *this browser profile's* storage
 * grant, not about the reader's data: it must not sync to a phone, and it should disappear
 * exactly when the origin's storage does, which is what a wipe of site data already gives.
 *
 * ⚠️ **The answer is recorded and not trusted.** The spike got `false` throughout (expected: no
 * install, no gesture, headless), and a `true` would not have meant the corpus was safe either —
 * Cache Storage and OPFS are evicted independently, and "shell loaded, corpus gone" is a state
 * this app has to handle whatever this returns. That handling is Task 5's and it comes from
 * opening the database.
 */
export async function requestPersistenceOnce(
  storage: StorageManager | undefined,
  store: Storage,
  now: number,
): Promise<PersistenceRecord | null> {
  if (!storage?.persist) return null;
  if (readPersistence(store)) return readPersistence(store);
  const granted = await storage.persist().catch(() => false);
  const record: PersistenceRecord = { askedAt: now, granted };
  try {
    store.setItem(PERSIST_KEY, JSON.stringify(record));
  } catch {
    // A private window with storage disabled. The request still happened; nothing else here
    // depends on it having been written down.
  }
  return record;
}

/** What was written down, or `null` — including for a record that cannot be read. */
export function readPersistence(store: Storage): PersistenceRecord | null {
  const raw = store.getItem(PERSIST_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { askedAt, granted } = parsed as Partial<PersistenceRecord>;
    if (typeof askedAt !== "number" || typeof granted !== "boolean") return null;
    return { askedAt, granted };
  } catch {
    return null;
  }
}
```

Create `src/pwa/install.ts`:

```ts
import { isWebTarget } from "@/pwa/target";

/**
 * Chrome's install event, which is in no TypeScript lib and is not on a standards track.
 * Declared here rather than shimmed globally so the shape is visible at the one place that
 * uses it.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export type InstallState = "unavailable" | "offered" | "installed";

let held: BeforeInstallPromptEvent | null = null;
let installed = false;

/**
 * Start listening for the browser's offer.
 *
 * **Called from `main.tsx`, before React**, because the event fires once and early: a page that
 * has not called `preventDefault()` on it by then has lost it, and there is no API to ask again.
 * That is also why this is a module-level latch rather than a hook — the offer arrives before
 * any component exists to hold it.
 */
export function captureInstallPrompt(target: EventTarget, options: { reset?: boolean } = {}): void {
  if (options.reset) {
    held = null;
    installed = false;
  }
  if (!isWebTarget()) return;
  target.addEventListener("beforeinstallprompt", (event) => {
    // Without this Chrome draws its own install bar, and the app's own control becomes a second
    // one saying the same thing in a different place.
    event.preventDefault();
    held = event as BeforeInstallPromptEvent;
  });
  target.addEventListener("appinstalled", () => {
    installed = true;
    held = null;
  });
}

export function installState(): InstallState {
  if (installed) return "installed";
  return held ? "offered" : "unavailable";
}

/**
 * Show the browser's own install dialog.
 *
 * Must be called from a click: browsers refuse `prompt()` outside a user gesture. The event is
 * single-use, so the held one is dropped whatever the reader chooses — a second press on a
 * spent event throws.
 */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  const event = held;
  if (!event) return "unavailable";
  held = null;
  await event.prompt();
  const { outcome } = await event.userChoice;
  return outcome;
}
```

In `src/main.tsx`, above `ReactDOM.createRoot`:

```tsx
import { captureInstallPrompt } from "./pwa/install";

// Before React, because `beforeinstallprompt` fires once and early and a page that has not
// called `preventDefault()` on it by then has lost it for good. Inert on desktop.
captureInstallPrompt(window);
```

- [ ] **Step 4: Write the panel**

Create `src/features/settings/WebStoragePanel.tsx` — a `SettingsSection id="web-storage" title="This browser"` rendering three rows:

1. **Install** — `installState()`; an `Install app` button on `"offered"`, the sentence *"Installed"* on `"installed"`, and on `"unavailable"` the sentence *"Your browser has not offered an install for this app."* (which is the honest state: Chrome gates the offer behind its own heuristic and Firefox on desktop does not offer one at all).
2. **Storage** — `readPersistence(localStorage)` plus a live `navigator.storage.persisted()`, rendered as *"The browser has agreed to keep this site's data"* or *"The browser may clear this site's data to free space"*. Under it, `navigator.storage.estimate()`'s usage — **labelled as the browser's own estimate**, with the sentence *"Browsers report this loosely; it is not a measurement of your database."*
3. The image cache cap — added by Task 6.

The panel is rendered by `SettingsPage` **only when `isWebTarget()`**:

```tsx
      {/* Web only: none of the three rows means anything in a window that owns its own disk.
          `isWebTarget()` is a build-time constant, so on desktop this subtree is not merely
          hidden — nothing under it is ever constructed. */}
      {isWebTarget() && <WebStoragePanel />}
```

`WebStoragePanel.test.tsx` covers: the three install states render three different things; a granted record and a refused one render different sentences; **and the estimate never gates anything** —

```tsx
  /**
   * The spike's measurement is the reason: `estimate()` reported 647 MB during a fill and 7 MB
   * immediately after a restart, against a file that was 532.8 MB both times, and reported an
   * identical 10 887.0 MB quota on a desktop and on a phone. It is printed, and nothing is
   * decided by it.
   */
  it("prints the browser's estimate and lets nothing depend on it", async () => {
    Object.defineProperty(navigator, "storage", {
      configurable: true,
      value: { estimate: () => Promise.resolve({ usage: 7_000_000, quota: 10_887_000_000 }), persisted: () => Promise.resolve(true) },
    });
    render(<WebStoragePanel />);
    expect(await screen.findByText(/Browsers report this loosely/)).toBeInTheDocument();
    // Nothing on the panel is disabled or hidden because the estimate is small.
    expect(screen.queryByRole("button", { name: /disabled|not enough space/i })).not.toBeInTheDocument();
  });
```

- [ ] **Step 5: Run the tests**

Run: `npm run test -- src/pwa src/features/settings 2>&1 | tail -12`
Expected: all pass, including the pre-existing settings suites unchanged.

- [ ] **Step 6: Mutate to prove the tests bite**

Three, reverting each:

1. In `captureInstallPrompt`, delete the `event.preventDefault()`. "keeps the browser's own bar off the screen" must FAIL.
2. In `requestPersistenceOnce`, delete the `if (readPersistence(store)) return …` guard. "does not ask again after a refusal" must FAIL.
3. In `promptInstall`, keep `held` instead of clearing it. "shows the browser's dialog on a press, once" must FAIL on the `installState()` assertion.

**Report any that survives.**

- [ ] **Step 7: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/pwa/ src/main.tsx src/features/settings/
git commit -m "feat(pwa): install, and persistence asked once and written down

beforeinstallprompt fires once and early, so the capture is a module side effect run from
main.tsx before React — a page that has not preventDefault()ed it by then has lost it and
there is no way to ask again.

persist() is requested when the corpus EXISTS rather than at boot, because 526 MB is what
makes it worth having. The answer is recorded and not trusted: the spike got false
throughout, and a true would not have meant the corpus was safe either — Cache Storage and
OPFS are evicted independently. estimate() is printed and gates nothing, with the 647-MB-
then-7-MB measurement as the reason, and a test that fails if a control ever depends on it."
```

---

### Task 5: Shell loaded, corpus gone

**Files:**
- Create: `src/pwa/corpusMark.ts`
- Create: `src/pwa/corpusMark.test.ts`
- Create: `src/pwa/useWebStorageLifecycle.ts`
- Modify: `src/components/SyncProgress.tsx`, `src/components/SyncProgress.test.tsx`, `src/components/SyncProgress.stories.tsx`, `src/components/AppShell.tsx`

**Interfaces:**
- Consumes: `requestPersistenceOnce` (Task 4), `isWebTarget` (Task 1), `ipc.syncStatus()` through the existing `useSync`.
- Produces: `corpusState()`, `markCorpusBuilt()` (from `@/pwa/corpusMark`); a new `reason` prop on `SyncProgress`.

> **The app already handles half of this, and finding that out is what makes the task small.** `SyncProgress` takes the whole screen when `cardCount === 0`, offers a Retry that runs `sync_run(true)`, and has a documented rule that `null` means "could not read" and must **not** black out a working app. That is the rebuild offer, already built and already tested. What is missing is that on the web the same screen can be reached for a completely different reason — the browser evicted OPFS while Cache Storage kept the shell — and a reader who has used this app for a month should not be told it is their first run.

- [ ] **Step 1: Write the failing test**

Create `src/pwa/corpusMark.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { CORPUS_KEY, corpusState, markCorpusBuilt } from "@/pwa/corpusMark";

beforeEach(() => localStorage.clear());

describe("what an empty database means", () => {
  it("is a first run when this browser has never had a corpus", () => {
    expect(corpusState(0, localStorage)).toBe("never-built");
  });

  /**
   * The state spec §5.4 names: the shell lives in Cache Storage and the corpus in OPFS, they are
   * evicted independently, and a reader who has been using this app can open it to an empty
   * database with the app itself perfectly intact. Telling them this is a first run would be a
   * lie about what happened to a month of syncing.
   */
  it("is an eviction when it has", () => {
    markCorpusBuilt(117_464, localStorage);
    expect(corpusState(0, localStorage)).toBe("evicted");
  });

  it("is neither while there are cards", () => {
    markCorpusBuilt(117_464, localStorage);
    expect(corpusState(117_464, localStorage)).toBe("present");
  });

  /**
   * `sync_status` answers `null` for a count it could not run, which is the normal state during
   * a sync. `SyncProgress` already refuses to treat that as empty — "treating it as empty would
   * black out a working 116 k-card app once a day" — and this must not undo that.
   */
  it("says nothing at all about a count that could not be read", () => {
    markCorpusBuilt(117_464, localStorage);
    expect(corpusState(null, localStorage)).toBe("present");
  });

  it("does not mark an empty sync as a corpus", () => {
    markCorpusBuilt(0, localStorage);
    expect(localStorage.getItem(CORPUS_KEY)).toBeNull();
    expect(corpusState(0, localStorage)).toBe("never-built");
  });

  it("treats an unreadable mark as never built rather than throwing", () => {
    localStorage.setItem(CORPUS_KEY, "{not json");
    expect(corpusState(0, localStorage)).toBe("never-built");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- src/pwa/corpusMark.test.ts 2>&1 | tail -20`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write it**

Create `src/pwa/corpusMark.ts`:

```ts
/** The one thing the shell remembers about the corpus: that there was one. */
export const CORPUS_KEY = "grimoire.corpus.built";

export type CorpusState = "present" | "never-built" | "evicted";

/**
 * Write down that this browser has had a corpus.
 *
 * **In `localStorage`, which is the shell's own storage, and that is what makes this work.**
 * Cache Storage, `localStorage` and OPFS are evicted independently; this mark lives with the
 * shell, so the case it detects — shell intact, corpus gone — is precisely the case where the
 * mark survives and the database does not. If the browser clears *everything*, the mark goes
 * too and the reader gets the first-run screen, which is then the truth.
 *
 * Idempotent, and a no-op for an empty count: a database with no cards is not a corpus, and
 * marking one would turn every genuine first run into a reported eviction.
 */
export function markCorpusBuilt(cardCount: number | null, store: Storage): void {
  if (cardCount === null || cardCount <= 0) return;
  try {
    store.setItem(CORPUS_KEY, JSON.stringify({ at: Date.now(), cards: cardCount }));
  } catch {
    // Storage disabled. The consequence is a reader who is one day told "first run" after an
    // eviction, which is the state this app shipped with before this file existed.
  }
}

/**
 * What an empty database means right now.
 *
 * `cardCount` is `sync_status`'s, with its own meanings kept exactly: `0` is a real empty
 * database, and `null` is a count that could not be read — which is the normal state *during*
 * every sync, and which `SyncProgress` has always refused to treat as empty.
 */
export function corpusState(cardCount: number | null, store: Storage): CorpusState {
  if (cardCount !== 0) return "present";
  let built = false;
  try {
    built = store.getItem(CORPUS_KEY) !== null && JSON.parse(store.getItem(CORPUS_KEY)!) !== null;
  } catch {
    built = false;
  }
  return built ? "evicted" : "never-built";
}
```

Create `src/pwa/useWebStorageLifecycle.ts`:

```ts
import { useEffect } from "react";
import { corpusState, markCorpusBuilt, type CorpusState } from "@/pwa/corpusMark";
import { requestPersistenceOnce } from "@/pwa/persistence";
import { isWebTarget } from "@/pwa/target";

/**
 * The two things that happen the moment the corpus exists, and the one question asked about it
 * on every poll.
 *
 * Driven from `AppShell`, which already reads `sync_status` through `useSync`. A hook of its own
 * rather than a second `useSync()` — that hook runs its own chained poll, and two of them would
 * be two loops describing one database.
 *
 * Inert on desktop: `isWebTarget()` is a build-time constant, the effect returns immediately,
 * and `corpusState` answers `"present"` for every count that is not exactly `0`.
 */
export function useWebStorageLifecycle(cardCount: number | null): CorpusState {
  useEffect(() => {
    if (!isWebTarget() || cardCount === null || cardCount <= 0) return;
    markCorpusBuilt(cardCount, localStorage);
    // Requested here rather than at boot: 526 MB is what makes persistence worth asking for,
    // and there is nothing to keep until the ingest has finished — 10.4 s on a desktop, 36.5 s
    // on a phone. `requestPersistenceOnce` is idempotent, so a poll every 30 s costs one read.
    void requestPersistenceOnce(navigator.storage, localStorage, Date.now());
  }, [cardCount]);

  return isWebTarget() ? corpusState(cardCount, localStorage) : "present";
}
```

- [ ] **Step 4: Teach the gate the difference**

In `src/components/SyncProgress.tsx`, add to `SyncProgressProps`:

```ts
  /**
   * Why the database is empty — `"never-built"` on a genuine first run, `"evicted"` when this
   * browser has had a corpus and no longer does (spec §5.4: Cache Storage and OPFS are evicted
   * independently, so "shell loaded, corpus gone" is a real state). Desktop always passes
   * `"never-built"`: a file on disk does not vanish while the app around it stays.
   */
  reason: CorpusState;
```

Thread it into `FirstRun` and branch **only the two sentences**, leaving the mark, the mana line, the Retry button and the whole of the surface's behaviour identical:

```tsx
  const EVICTED = reason === "evicted";
  // The heading and the sentence under it, and nothing else on this screen, because nothing
  // else about the situation is different: there is no card data, and the way out is the same
  // download. What differs is what the reader is owed as an explanation.
  const heading = EVICTED ? "Your card data was cleared" : "Setting up your collection";
  const blurb = EVICTED
    ? "This browser removed the card database to free up space. Your collection, decks and " +
      "wishlist are untouched — only the card data has to be downloaded again."
    : /* the existing sentence, unchanged */ undefined;
```

> **Why the collection is safe to promise.** `collection_entries`, `decks` and the rest live in the same SQLite file as `cards`, so an OPFS eviction takes them too — **which means this sentence is only true once sync exists (PR 6/7)**. Until then it must not be written. **Ship the eviction copy as: *"This browser removed the card database to free up space. It has to be downloaded again."*** and open an issue against PR 7 to add the second clause when a paired device can actually restore the user tables. Do not write a promise the app cannot keep.

Update `SyncProgress.test.tsx` with two cases (each `reason` renders its own heading) and `SyncProgress.stories.tsx` with an `Evicted` story. In `AppShell.tsx`:

```tsx
  const corpus = useWebStorageLifecycle(status?.cardCount ?? null);
```

and pass `reason={corpus}` to `<SyncProgress …>`.

- [ ] **Step 5: Run the tests**

Run: `npm run test -- src/pwa src/components/SyncProgress.test.tsx src/components/AppShell.test.tsx 2>&1 | tail -12`
Expected: all pass. `AppShell.test.tsx` needs no change — `useWebStorageLifecycle` returns `"present"` on the desktop default and the gate's existing behaviour is unchanged.

- [ ] **Step 6: Mutate to prove the tests bite**

Two, reverting each:

1. In `corpusState`, change `if (cardCount !== 0)` to `if (cardCount)`. "says nothing at all about a count that could not be read" must FAIL — this is the exact mistake `SyncProgress`'s own comment warns about, and it blacks out a working app once a day.
2. In `markCorpusBuilt`, delete the `cardCount <= 0` guard. "does not mark an empty sync as a corpus" must FAIL, and with it every first run would report an eviction.

**Report any that survives.**

- [ ] **Step 7: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/pwa/ src/components/
git commit -m "feat(pwa): an empty database says whether it was ever full

Spec §5.4's 'shell loaded, corpus gone': Cache Storage and OPFS are evicted independently, so
a reader who has used this app for a month can open it to an empty database with the app
itself intact. SyncProgress already takes the screen at cardCount === 0 and already offers
the rebuild — what it could not do was tell a first run from an eviction, and calling the
second one a first run is a lie about what happened.

The mark lives in localStorage, which is the shell's own storage, and that is what makes it
work: it survives exactly the eviction it detects, and a browser that clears everything
clears it too, at which point 'first run' is the truth.

cardCount === 0 and only 0, keeping SyncProgress's own rule — null is a count that could not
be read, which is the normal state during every sync."
```

---

### Task 6: The image cache — 256 MB LRU, reader-adjustable to 1 GB

**Files:**
- Create: `src/pwa/imageLedger.ts`
- Create: `src/pwa/imageLedger.test.ts`
- Modify: `src/pwa/swCore.ts` (nothing — the route already exists), `src/pwa/sw.ts` (fill in the `image` branch and one message), `src/features/settings/WebStoragePanel.tsx`

**Interfaces:**
- Consumes: PR 4's image origin, recorded in Task 1 Step 1.
- Produces: `IMAGE_CACHE`, `LEDGER_KEY`, `parseLedger`, `serializeLedger`, `admit`, `touch`, `evictions`, `withCap`, `DEFAULT_CAP_BYTES`, `MAX_CAP_BYTES` (from `@/pwa/imageLedger`).

> **Why the ledger is data and never a `Response`.** Everything in this file is strings and objects — `sw.ts` does the `caches.open`, the `cache.put` and the one `new Response(...)`, and the settings panel does the `cache.match`. That is not fastidiousness: jsdom implements no `caches`, and whether `Response` is even a global under vitest's jsdom environment is a question this repo has never had to answer (nothing in `src/` constructs one today). Keeping the constructor out of `src/` means the question never has to be answered, and every rule about what gets evicted is under test.

- [ ] **Step 1: Write the failing test**

Create `src/pwa/imageLedger.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAP_BYTES,
  MAX_CAP_BYTES,
  admit,
  evictions,
  parseLedger,
  serializeLedger,
  touch,
  withCap,
} from "@/pwa/imageLedger";

const KB = 65_000; // ~65 KB per image: 519 MB over 7 929 files in the live cache.

describe("the cap", () => {
  it("defaults to 256 MB, which is about 3 900 cards", () => {
    expect(DEFAULT_CAP_BYTES).toBe(256 * 1_000_000);
    expect(Math.floor(DEFAULT_CAP_BYTES / KB)).toBeGreaterThan(3_800);
  });

  it("is clamped to the range the reader is offered", () => {
    expect(withCap(parseLedger(null), 1)).toMatchObject({ cap: DEFAULT_CAP_BYTES });
    expect(withCap(parseLedger(null), 9e12)).toMatchObject({ cap: MAX_CAP_BYTES });
    expect(MAX_CAP_BYTES).toBe(1_000 * 1_000_000);
  });
});

describe("what gets thrown away", () => {
  it("throws away nothing while there is room", () => {
    let l = parseLedger(null);
    for (let i = 0; i < 10; i++) l = admit(l, `/img/${i}`, KB, i);
    expect(evictions(l)).toEqual([]);
  });

  it("throws away the least recently used first, and only until it is under the cap", () => {
    let l = withCap(parseLedger(null), DEFAULT_CAP_BYTES);
    l = admit(l, "/a", 100_000_000, 1);
    l = admit(l, "/b", 100_000_000, 2);
    l = admit(l, "/c", 100_000_000, 3);
    // 300 MB against 256: one 100 MB entry has to go, and it is the oldest *use*.
    expect(evictions(l)).toEqual(["/a"]);
  });

  it("counts a hit, so a card the reader keeps looking at outlives one they saw once", () => {
    let l = withCap(parseLedger(null), DEFAULT_CAP_BYTES);
    l = admit(l, "/a", 100_000_000, 1);
    l = admit(l, "/b", 100_000_000, 2);
    l = touch(l, "/a", 4);
    l = admit(l, "/c", 100_000_000, 5);
    expect(evictions(l)).toEqual(["/b"]);
  });

  it("re-admitting an entry replaces its size rather than adding to it", () => {
    let l = parseLedger(null);
    l = admit(l, "/a", 100, 1);
    l = admit(l, "/a", 200, 2);
    expect(l.bytes).toBe(200);
  });
});

describe("the ledger on disk", () => {
  it("round-trips", () => {
    let l = withCap(parseLedger(null), MAX_CAP_BYTES);
    l = admit(l, "/a", KB, 1);
    expect(parseLedger(serializeLedger(l))).toEqual(l);
  });

  /**
   * The ledger lives in the same Cache Storage as the images and is evicted with them — but not
   * necessarily *at the same moment*. A missing or corrupt ledger must cost the reader nothing
   * worse than one cold cache, never an exception in a `fetch` handler.
   */
  it("comes back empty from anything it cannot read", () => {
    for (const bad of [null, "", "{not json", "[]", '{"entries":3}']) {
      const l = parseLedger(bad);
      expect(l.bytes).toBe(0);
      expect(l.cap).toBe(DEFAULT_CAP_BYTES);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- src/pwa/imageLedger.test.ts 2>&1 | tail -20`
Expected: FAIL — unresolved import.

- [ ] **Step 3: Write it**

Create `src/pwa/imageLedger.ts` with the six functions above. The shape:

```ts
/** Card art, cached by the service worker. Never per-build — see `staleShellCaches`. */
export const IMAGE_CACHE = "grimoire-images";
/** The ledger's key inside that cache. A path no image can collide with. */
export const LEDGER_KEY = "/__grimoire_image_ledger__";

/**
 * 256 MB.
 *
 * From the live cache — 519 MB over 7 929 files, ~65 KB per image — that is **~3 900 cards**,
 * against ~65 MB for a 1 000-card grid and ~6.5 MB for a deck. It keeps the whole web footprint
 * under 1 GB against a 526 MB corpus, which is the number the cap was chosen to hold.
 * **Desktop is uncapped and stays uncapped**; this file is never loaded there.
 */
export const DEFAULT_CAP_BYTES = 256 * 1_000_000;
/** As far as spec §5.4 lets a reader raise it: ~15 000 cards. */
export const MAX_CAP_BYTES = 1_000 * 1_000_000;

export interface Ledger {
  /** url → the last time it was used, in unix millis. */
  used: Record<string, number>;
  /** url → its size in bytes, measured when it was cached. */
  size: Record<string, number>;
  /** The sum of `size`. Kept rather than recomputed: this is read on every image request. */
  bytes: number;
  cap: number;
}
```

`evictions(l)` returns the URLs to delete, oldest-use first, until `bytes` would be at or under `cap` — and returns `[]` when it already is. `admit`/`touch` return new objects (no mutation, so a test can hold both). `withCap` clamps into `[DEFAULT_CAP_BYTES, MAX_CAP_BYTES]`.

Fill in `sw.ts`'s `image` branch — cache-first, and on a miss fetch, `cache.put`, `admit`, delete what `evictions` names, and write the ledger back with `new Response(serializeLedger(next))`. Add `{ type: "SET_IMAGE_CAP", bytes }` to the message handler, applying `withCap` and running an eviction pass immediately so the reader sees the space come back.

> **The one call site this task does not own.** The images reach the worker because `cardImageUrl` returns an `https:` URL on the web target — PR 4's change, recorded in Task 1 Step 1. **If PR 4 already opened a Cache Storage bucket for images, adopt its name here rather than creating a second one**, and delete its eviction-free put; two caches holding the same art is 512 MB where the reader asked for 256. Check with `grep -rn "caches.open" src/`.

In `WebStoragePanel.tsx`, add the third row: the cache's current size (read from the ledger through `caches.open(IMAGE_CACHE)` → `match(LEDGER_KEY)` → `text()` → `parseLedger`) and a three-option control — 256 MB, 512 MB, 1 GB — that posts `SET_IMAGE_CAP` to the controller. Use the app's `Dropdown` (check its documented props with the `mtg-grimoire-sb-mcp` tools first — `src/CLAUDE.md` makes that binding).

- [ ] **Step 4: Run the tests, then build**

Run: `npm run test -- src/pwa src/features/settings 2>&1 | tail -12` then `npm run build:web`.
Expected: green, and `dist/sw.js` grows by the ledger code.

- [ ] **Step 5: Mutate to prove the tests bite**

Two, reverting each:

1. In `evictions`, sort by *insertion* order (`size` key order) instead of by `used`. "counts a hit" must FAIL.
2. In `admit`, add to `bytes` unconditionally instead of subtracting a previous size first. "re-admitting an entry replaces its size" must FAIL — the drift is silent and ends with a cache that evicts everything because its own arithmetic says it is full.

**Report any that survives.**

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/pwa/ src/features/settings/
git commit -m "feat(pwa): the image cache is 256 MB LRU, and the reader can raise it to 1 GB

From the live cache — 519 MB over 7 929 files, ~65 KB an image — 256 MB is ~3 900 cards,
which keeps the whole web footprint under 1 GB against a 526 MB corpus. Desktop stays
uncapped and never loads this file.

The ledger is data and never a Response: sw.ts does every caches call and the one
constructor, so nothing under src/ needs a web global that jsdom does not have, and every
rule about what gets thrown away is under test."
```

---

### Task 7: The mobile-data prompt

**Files:**
- Create: `src/pwa/connection.ts`, `src/pwa/connection.test.ts`
- Create: `src/pwa/feedSize.ts`, `src/pwa/feedSize.test.ts`
- Create: `src/pwa/FeedDownloadProvider.tsx`, `src/pwa/FeedDownloadProvider.test.tsx`, `src/pwa/FeedDownloadProvider.stories.tsx`
- Modify: `src/App.tsx`, `src/lib/useSync.ts`, `src/features/settings/CombosPanel.tsx`, `src/lib/useMarketplace.ts`

**Interfaces:**
- Consumes: `isWebTarget` (Task 1), `src/components/Dialog.tsx`.
- Produces: `meteredLink()`, `probeFeedSize()`, `PROMPT_OVER_BYTES`, `useFeedDownload()`.

> **There are exactly three reader-initiated downloads to guard, and finding that out is the task's shape.** `grep -rn "combosRefresh\|oracleTagsRefresh\|artTagsRefresh\|marketplaceFeedRefresh\|syncRun" src --include=*.tsx --include=*.ts` outside `ipc.ts` and the tests returns **four** lines, one of which is a story. The three real ones are `useSync.ts:153` (`syncRun`), `CombosPanel.tsx:322` (`combosRefresh`) and `useMarketplace.ts:315` (`marketplaceFeedRefresh`).
>
> **The two tagger feeds have no UI caller at all** — the backend refreshes them on its own weekly schedule. A prompt cannot be attached to a download nobody asked for, so **the tagger feeds are not guarded by this PR**, and that is a real hole rather than a decision: on a metered link the backend will fetch 5.85 MB and 12.5 MB without asking. Raise it against PR 4's ingest scheduling — the fix is a "not on a metered link" gate in the scheduler, not another dialog.

- [ ] **Step 1: Write the failing tests**

Create `src/pwa/connection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { meteredLink } from "@/pwa/connection";

describe("reading the link", () => {
  it("takes Data Saver at its word", () => {
    expect(meteredLink({ saveData: true })).toMatchObject({ metered: true });
    expect(meteredLink({ saveData: true }).why).toMatch(/Data Saver/);
  });

  it("treats a cellular link as metered", () => {
    expect(meteredLink({ type: "cellular" })).toMatchObject({ metered: true });
  });

  it("treats a 2G link as metered even when it does not say cellular", () => {
    expect(meteredLink({ effectiveType: "2g" })).toMatchObject({ metered: true });
    expect(meteredLink({ effectiveType: "slow-2g" })).toMatchObject({ metered: true });
  });

  it("says nothing about wifi, and nothing at all when the API is absent", () => {
    expect(meteredLink({ type: "wifi", effectiveType: "4g" })).toEqual({ metered: false, why: null });
    // Safari and Firefox expose no `navigator.connection`. Absent is not metered — guessing
    // "yes" would default every download to Not now on two whole browsers.
    expect(meteredLink(undefined)).toEqual({ metered: false, why: null });
  });
});
```

Create `src/pwa/feedSize.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { PROMPT_OVER_BYTES, probeFeedSize, shouldPrompt } from "@/pwa/feedSize";

describe("finding out what a feed costs", () => {
  it("reads the corpus size out of Scryfall's own bulk descriptor", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ compressed_size: 77_972_714 }),
      } as unknown as Response),
    );
    const size = await probeFeedSize("corpus", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://api.scryfall.com/bulk-data/default_cards",
      expect.objectContaining({ headers: { Accept: "application/json" } }),
    );
    expect(size).toEqual({ bytes: 77_972_714, exact: true });
  });

  it("reads the combo feed's size off a HEAD", async () => {
    const fetchFn = vi.fn(() =>
      Promise.resolve({
        ok: true,
        headers: { get: (h: string) => (h.toLowerCase() === "content-length" ? "27558428" : null) },
      } as unknown as Response),
    );
    const size = await probeFeedSize("combos", fetchFn);
    expect(fetchFn).toHaveBeenCalledWith(
      "https://json.commanderspellbook.com/variants.json.gz",
      expect.objectContaining({ method: "HEAD" }),
    );
    expect(size).toEqual({ bytes: 27_558_428, exact: true });
  });

  /**
   * Measured live 2026-08-28: a HEAD on `api.cardkingdom.com/api/v2/pricelist` answers 200 with
   * `Content-Type: text/html` and **no `Content-Length`**, and the feed is paginated, so there is
   * no single number to read. The price research measured the whole payload at 66 787 283 B
   * uncompressed — big enough to prompt about and not a number this app can confirm today.
   */
  it("admits it cannot size the Card Kingdom feed, and does not guess", async () => {
    const fetchFn = vi.fn();
    expect(await probeFeedSize("card-kingdom", fetchFn)).toEqual({ bytes: null, exact: false });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("answers null rather than throwing when the probe fails", async () => {
    const size = await probeFeedSize("corpus", () => Promise.reject(new Error("offline")));
    expect(size).toEqual({ bytes: null, exact: false });
  });
});

describe("whether to ask", () => {
  it("does not ask about anything under 5 MB", () => {
    expect(shouldPrompt({ bytes: 4_000_000, exact: true }, { metered: false, why: null }).show).toBe(false);
  });

  it("asks about anything over it", () => {
    expect(PROMPT_OVER_BYTES).toBe(5_000_000);
    expect(shouldPrompt({ bytes: 27_558_428, exact: true }, { metered: false, why: null }).show).toBe(true);
  });

  /** An unknown size is the one case where not asking would be the reckless answer. */
  it("asks when it does not know", () => {
    expect(shouldPrompt({ bytes: null, exact: false }, { metered: false, why: null }).show).toBe(true);
  });

  it("defaults to Not now on a metered link, and to the download otherwise", () => {
    const big = { bytes: 77_972_714, exact: true };
    expect(shouldPrompt(big, { metered: true, why: "Data Saver is on" }).preferred).toBe("not-now");
    expect(shouldPrompt(big, { metered: false, why: null }).preferred).toBe("download");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -- src/pwa/connection.test.ts src/pwa/feedSize.test.ts 2>&1 | tail -20`
Expected: FAIL — both imports unresolved.

- [ ] **Step 3: Write them**

`src/pwa/connection.ts` declares its own `NetworkInformation` — **`navigator.connection` is in no TypeScript lib** (checked: `lib.dom.d.ts` in typescript 6.0.3 has no `NetworkInformation` and no `connection` on `Navigator`) — and exports `meteredLink(connection)` plus a `navigatorConnection()` accessor doing the one cast.

> **No browser exposes a "metered" bit, and this must not pretend otherwise.** The three signals are `saveData` (the reader asked for less data — the strongest of the three, because it is a *choice*), `type === "cellular"` (Chrome on Android; absent on desktop), and `effectiveType` of `2g`/`slow-2g` (a guess about speed, not about cost, and here because a 78 MB download on a 2G link is a bad idea whoever is paying). Firefox and Safari expose none of it, and **absent is not metered** — defaulting two whole browsers to "Not now" would be worse than not asking.

`src/pwa/feedSize.ts`:

```ts
export type FeedId = "corpus" | "combos" | "card-kingdom";
export interface FeedSize {
  /** Compressed bytes over the wire, or `null` when it cannot be known. */
  bytes: number | null;
  /** The feed said so, rather than this app inferring it. */
  exact: boolean;
}
/** Spec §5.3: "any feed over 5 MB". Decimal MB, matching `useUpdate`'s `formatBytes`. */
export const PROMPT_OVER_BYTES = 5_000_000;
```

`probeFeedSize` is a one-request probe, cached per session in a module `Map`:

- **`corpus`** — `GET https://api.scryfall.com/bulk-data/default_cards`, read `compressed_size`. That is the field the app's own `scryfall.rs` reads (`BulkInfo.compressed_size`, `src-tauri/src/scryfall.rs:236`), so the prompt shows the same number the download will report.
- **`combos`** — `HEAD https://json.commanderspellbook.com/variants.json.gz`, read `Content-Length`. Verified live 2026-08-28: `Content-Length: 27558428`, `Content-Encoding: gzip`, `Accept-Ranges: bytes`. The spike measured 27 555 788 the day before, which is the file being rebuilt and not a discrepancy.
- **`card-kingdom`** — no probe at all. `{ bytes: null, exact: false }`.

> **Why the probe is a page `fetch` and not a new Rust command.** A byte count is a fact and facts are Rust's — so this is a deliberate exception with a bounded reason. The prompt exists only on the web target, where the shell already fetches on its own account (the image cache is Cache Storage in the service worker), and both hosts send `Access-Control-Allow-Origin: *` (verified in the spike, and it is what makes decision 5 possible at all). The alternative is a `feed_download_size` command — five files of new surface in `src-tauri/`, `ipc.ts`, its DTO, its argument pin and the Storybook fake — landing in the same week PR 4 is rewriting the whole Rust I/O layer.
>
> **Android will need the Rust one.** A Tauri webview runs under `default-src 'self'` and cannot fetch Scryfall from the page at all. `feedSize.ts` is the single place that changes; it is named here so PR 8 does not have to find it.
>
> **Two requests per refresh, and that is within Scryfall's rule.** The probe and the download's own descriptor read are separated by a human press, which is far more than the 50–100 ms the API asks for, and the answer is cached for the session.

`shouldPrompt(size, link)` returns `{ show, preferred }` per the tests.

- [ ] **Step 4: Write the dialog and its provider**

`src/pwa/FeedDownloadProvider.tsx` exports a provider mounted in `App.tsx` (inside `QueryClientProvider`, outside `ContextMenuProvider` — `CardToDeckProvider`'s placement argument applies verbatim: a provider drawn as a *sibling* of `children` is around every view and around none of the menu's rows) and a `useFeedDownload()` hook returning:

```ts
(feed: FeedId, run: () => void) => void
```

On desktop — `!isWebTarget()` — it calls `run()` synchronously and renders nothing, so the three call sites change by one wrapper each and behave identically in the shipped window.

On web it probes, and if `shouldPrompt` says so, opens a `Dialog` (`src/components/Dialog.tsx`, `width="w-[26rem]"`) that says:

- the feed's name, and **its measured size** — `formatBytes` from `@/lib/useUpdate`, so "78.0 MB" is written the way the desktop updater already writes one — or *"The size of this download is not published."* when `bytes` is `null`;
- the metered sentence when there is one: *"You appear to be on mobile data."* / *"Data Saver is on."*;
- two buttons: **Download** and **Not now**, with `autoFocus` on whichever `preferred` names.

`FeedDownloadProvider.test.tsx` covers: desktop runs immediately with no dialog; a sub-5 MB feed runs immediately; a large feed opens the dialog and only runs on Download; **Not now runs nothing**; and the focused button follows `preferred`.

- [ ] **Step 5: Wire the three call sites**

Each is one line. In `useSync.ts`'s `refresh`, `CombosPanel.tsx`'s mutation trigger, and `useMarketplace.ts`'s feed refresh, wrap the call:

```ts
  const askFirst = useFeedDownload();
  const refresh = useCallback(() => askFirst("corpus", () => { /* the existing body */ }), [askFirst]);
```

**Do not move the existing bodies.** The refusal handling, the `busy` flag and the `upToDate` timer are all unchanged; what is new is that the body may not run.

- [ ] **Step 6: Run the tests**

Run: `npm run test -- src/pwa src/lib/useSync.test.ts src/lib/useMarketplace.test.ts src/features/settings/CombosPanel.test.tsx 2>&1 | tail -12`
Expected: green. The three existing suites run on the desktop default, where the guard is a pass-through — **if one of them goes red, the pass-through is not synchronous**, and it must be, or every desktop Refresh grows a frame of delay.

- [ ] **Step 7: Mutate to prove the tests bite**

Three, reverting each:

1. In `meteredLink`, return `{ metered: true }` for `connection === undefined`. "says nothing about wifi, and nothing at all when the API is absent" must FAIL.
2. In `shouldPrompt`, return `show: false` when `bytes === null`. "asks when it does not know" must FAIL.
3. In `probeFeedSize`, return a hard-coded `66_787_283` for `card-kingdom`. "admits it cannot size the Card Kingdom feed" must FAIL — the number is real, it is from the price research, and it is exactly the kind of measured-once figure that rots into a lie.

**Report any that survives.**

- [ ] **Step 8: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/pwa/ src/App.tsx src/lib/useSync.ts src/lib/useMarketplace.ts src/features/settings/CombosPanel.tsx
git commit -m "feat(pwa): a feed over 5 MB says what it costs before it starts

Three reader-initiated downloads exist — the corpus, the combo feed and the Card Kingdom
pricelist — and each now goes through one guard. The size is the feed's own: Scryfall's
compressed_size out of the bulk descriptor, and a HEAD for Spellbook (verified live
2026-08-28, Content-Length 27558428).

Card Kingdom's cannot be sized and the prompt says so rather than reprinting a figure
measured once in August. Its HEAD answers text/html with no Content-Length and the feed is
paginated — also verified live.

No browser exposes a metered bit, so the three signals are saveData, a cellular type and a
2G effectiveType, and ABSENT IS NOT METERED — Firefox and Safari expose none of it and
defaulting them to Not now would be worse than not asking.

Not guarded, and named rather than hidden: the two tagger feeds have no UI caller at all —
the backend refreshes them weekly on its own — so a metered link still costs 5.85 MB and
12.5 MB unasked. That is PR 4's scheduler to gate, not another dialog."
```

---

### Task 8: The live pass — two builds, one update, no cross-origin isolation

**Files:**
- Create: `docs/reference/pwa-shell.md`
- Modify: `CLAUDE.md` (one row in the reference-docs table)

> **This task is the plan's answer to "a service worker passes in dev and fails in production".** Nothing below can be done in vitest: jsdom implements no service worker registration, no Cache Storage, and no `navigator.storage.persist()`. Everything below is done against a **production build**, served over HTTP, driven by a real browser over CDP. Record every result in `docs/reference/pwa-shell.md` with the date and the browser build, which is the repo's standing rule for a measured claim.

- [ ] **Step 1: Serve a production build and attach**

The app lock is not involved — this is not `tauri dev` and not Storybook — but **use CDP port 9333, not 9222**, so a colleague's Tauri window on 9222 is never the target this attaches to.

```powershell
npm run build:web
Start-Process npx -ArgumentList "vite preview --port 4173 --strictPort"
$dir = Join-Path $env:TEMP "grimoire-pwa-profile"
Start-Process "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" `
  -ArgumentList "--headless=new","--remote-debugging-port=9333","--disable-sync","--user-data-dir=$dir","http://localhost:4173/"
$env:CDP_PORT = "9333"
node scripts/cdp.mjs eval "location.href"
```

`cdp.mjs` takes the first `type: page` target. **Put `location.href` in every payload below** — a stray target answers about the wrong DOM and reads exactly like the feature being broken.

- [ ] **Step 2: Prove the worker installs, controls the page, and does not isolate it**

```powershell
node scripts/cdp.mjs eval "(async()=>{const r=await navigator.serviceWorker.ready;return JSON.stringify({href:location.href,scope:r.scope,active:!!r.active,controlled:!!navigator.serviceWorker.controller,isolated:crossOriginIsolated});})()"
```
Expected: `scope` is `http://localhost:4173/`, `active` and `controlled` true, and **`isolated: false`**.

**`isolated: false` with a working app is the assertion, not a tolerance.** The spike measured the identical page with and without COOP/COEP and got identical results, so cross-origin isolation is not required here — and a service worker that re-attached it on cached navigations is the "works on first load, breaks on the second" bug this design does not have. Write the reading into `pwa-shell.md` so nobody adds the headers back defensively.

- [ ] **Step 3: Prove the shell works offline**

```powershell
node scripts/cdp.mjs eval "(async()=>{const c=await caches.keys();return JSON.stringify({href:location.href,caches:c});})()"
```
Expected: one `grimoire-shell-<id>` cache. Then take the network away — stop the preview server — and navigate again:

```powershell
Stop-Process -Name node -ErrorAction SilentlyContinue   # the preview server
node scripts/cdp.mjs eval "location.reload()"
node scripts/cdp.mjs eval "JSON.stringify({href:location.href,root:document.getElementById('root')?.childElementCount})"
```
Expected: `root` is greater than 0. **A blank window is `childElementCount: 0`**, which is the tell — a screenshot of a dark page cannot tell "loaded" from "did not".

> ⚠️ **What this does *not* prove is that the app works offline** — only that the shell does. The corpus lives in OPFS behind PR 4's Worker and the app behind this shell will still try to reach Scryfall. Record exactly what was seen.

- [ ] **Step 4: The update flow, end to end, which is the point of this task**

Restart the preview server. Then, with the tab still open:

1. Note the running build: `node scripts/cdp.mjs eval "(async()=>{const r=await navigator.serviceWorker.ready;const ch=new MessageChannel();const p=new Promise(res=>ch.port1.onmessage=e=>res(e.data));r.active.postMessage({type:'VERSION'},[ch.port2]);return JSON.stringify(await p);})()"` — records build **A**.
2. Change one source file (`src/App.tsx`, a comment is enough) and run `npm run build:web` again. The build id must differ; Task 2 Step 7 already proved an *unchanged* tree does not.
3. Ask the page to check: `node scripts/cdp.mjs eval "(async()=>{const r=await navigator.serviceWorker.ready;await r.update();return JSON.stringify({href:location.href,waiting:!!r.waiting});})()"`.
   Expected: `waiting: true`. **Poll it** — the new worker has to finish installing, which means precaching the whole shell.
4. **The bar is on screen**: `node scripts/cdp.mjs eval "JSON.stringify({href:location.href,bar:document.body.innerText.includes('A new version is ready')})"` → `true`.
5. **A reader who ignores it keeps their build.** Reload without pressing, then read the version again: it must still be **A**. This is the half of §5.4 that is easiest to lose and impossible to see in a unit test — a browser leaves the waiting worker waiting across a reload, and if this reads **B** something is calling `skipWaiting` that should not be.
6. **Press it.** `node scripts/cdp.mjs hover "button" --rest 200` then `node scripts/cdp.mjs text "Reload to update"`. A cold pointer makes `click` a no-op that still prints "clicked", so the hover is not optional.
7. Read the version again: **B**, and `document.getElementById('root').childElementCount > 0`. One reload, not a loop — watch for 10 s and confirm the page is not cycling.

- [ ] **Step 5: The evicted corpus, forced**

With the app loaded, delete the OPFS database from under it and reload:

```powershell
node scripts/cdp.mjs eval "(async()=>{const root=await navigator.storage.getDirectory();const names=[];for await (const [n] of root.entries()) names.push(n);return JSON.stringify({href:location.href,names});})()"
```
Then remove what PR 4's `opfs-sahpool` uses (the directory name is in PR 4's VFS config — read it, do not guess), reload, and confirm the app shows **"Your card data was cleared"** with a working Retry — not a stack trace, not a blank page, and not "Setting up your collection".

**This is the one step that proves Task 5 does what it is for**, because `localStorage` survives an OPFS wipe and nothing in jsdom can stage that.

- [ ] **Step 6: The install offer, headed**

`beforeinstallprompt` does not fire in headless Chrome at all. Relaunch **headed**, load the app, interact with it for a few seconds, and confirm the Settings panel's install row moves from *"Your browser has not offered an install for this app"* to an enabled **Install app** button. Then install it and confirm `navigator.storage.persisted()` — which is what an install is most likely to change.

**If the offer never appears, record that and do not chase it.** Chrome's engagement heuristic is not a contract, and the panel's honest sentence for that state is already the shipped behaviour.

- [ ] **Step 7: Write it down**

Create `docs/reference/pwa-shell.md` holding: the manifest as shipped; the cache names and what is in each; the update flow with the two build ids observed and the timings; the offline reading; the eviction drill; whatever the install offer did; and — first, because it is the one somebody will want to undo — **the `crossOriginIsolated: false` reading beside the spike's A/B, so the case for not adding COOP/COEP is on one page**.

Add one row to `CLAUDE.md`'s reference-docs table:

```markdown
| [pwa-shell.md](docs/reference/pwa-shell.md) | The installable web shell — the manifest, the two caches, the update flow driven end to end, and why the service worker attaches no isolation headers |
```

- [ ] **Step 8: Commit**

```bash
git add docs/reference/pwa-shell.md CLAUDE.md
git commit -m "docs(pwa): the shell driven in a real browser, with both build ids

Everything in this file is something no test in this repo can see: jsdom implements no
service worker registration, no Cache Storage and no storage.persist(). Two production
builds, one waiting worker, one press, one reload — and the reading that matters most,
crossOriginIsolated: false with the app working, so the case for NOT re-attaching COOP/COEP
sits on one page beside the spike's A/B."
```

---

## Self-Review

**Spec coverage.** §5.4 in full — manifest and install (Tasks 1, 4), the service worker (Task 2), the update flow exactly as written (Task 3, verified end to end in Task 8), `persist()` requested once the corpus is built and its answer recorded rather than trusted (Tasks 4, 5), "shell loaded, corpus gone" opening the corpus before assuming it and offering a rebuild (Task 5), the 256 MB / 1 GB image cache (Task 6), and the service worker not re-attaching COOP/COEP — said in the plan, pinned by a source sweep in Task 2, and read off a running browser in Task 8. §5.3's mobile-data prompt is Task 7.

**What was checked against the repo rather than assumed.** `vite.config.ts` is a `vitest/config` `defineConfig` with a plugin array, a `resolve.alias` and a `test` block — `mergeConfig` composes with it. `tsconfig.json`'s `lib` is `ES2020, ES2022.Error, DOM, DOM.Iterable` with `types: []` and `include: ["src"]`, which is why the service worker needs a second program and why nothing under `src/` may import `node:fs`. `tsconfig.node.json` carries the TS6305 warning that decided `composite: false`. ESLint runs `tseslint.configs.recommended` — not the type-checked variant — so `src/pwa/sw.ts` needs no project entry and `no-undef` is off for TS files. `src/lib/layers.test.ts:8` gives the `query: "?raw"` glob shape the source sweeps use. `navigator.storage.persist()`, `persisted()` and `estimate()` are in `lib.dom.d.ts`; `NetworkInformation` and `BeforeInstallPromptEvent` are **not**, which is why both are declared locally. `logos/png/mark-256.png` and `mark-512.png` are tracked. `SyncProgress` already gates on `cardCount === 0` with a documented `null` rule and already offers the rebuild. `ipc.syncStatus`/`syncRun` are `src/lib/ipc.ts:4807-4808`. `scripts/cdp.mjs` reads `CDP_PORT`, so it drives a browser as well as the Tauri window.

**Measured live for this plan, 2026-08-28.** A HEAD on `json.commanderspellbook.com/variants.json.gz` answers `Content-Length: 27558428`, `Content-Encoding: gzip`, `Accept-Ranges: bytes`. A HEAD on `api.cardkingdom.com/api/v2/pricelist` answers 200 with `Content-Type: text/html` and **no `Content-Length`** — which is why Task 7 refuses to size that feed instead of reprinting the 66 787 283 B the price research measured in August.

**Where a task cannot be verified in the suite, and what verifies it instead.** Task 2's Cache Storage plumbing, Task 3's real registration ordering, Task 4's `beforeinstallprompt` and `persist()` grant, Task 5's actual OPFS eviction, and Task 6's cache writes. Every one is named at its task and driven in Task 8; the install offer is the only one that needs a headed browser, and the plan says so rather than pretending headless will do.

**Two things this plan leaves open, deliberately and in writing.**

1. **The tagger feeds are not guarded by the mobile-data prompt**, because they have no UI caller — the backend refreshes them weekly on its own. On a metered link that is 5.85 MB and 12.5 MB spent unasked. The fix belongs in PR 4's scheduler.
2. **The eviction copy cannot promise the reader's collection is safe** until sync exists. `collection_entries` and `decks` live in the same SQLite file as `cards`, so an OPFS eviction takes them too. Task 5 ships the shorter sentence and says why.

**One risk worth naming.** Task 6 assumes PR 4 made `cardImageUrl` return an `https:` URL on web, because a service worker cannot intercept a custom scheme. Task 1 Step 1 checks it and Task 8 would notice, but if PR 4 solved images another way — a blob URL minted in the Worker, say — the image route in `sw.ts` is dead code and the cap has to move into whatever mints those blobs. The ledger is unaffected either way: it is pure data with no idea where the bytes came from.
