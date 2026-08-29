# Mobile layout 9a: the design round, and the foundation underneath it — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put four real, lookable-at design options in front of Markus for each of the four surfaces the spec names — the ribbon, `CardGrid`, the deck editor and the filter bar — and ship the part of the phone answer that is true whichever option wins: the visible viewport, the safe area, one spelling of the coarse-pointer question, and a written census of what a reader with no hover and no wheel loses.

**Architecture:** Nothing in this plan changes a layout. Tasks 1–3 add three things the app does not have today — a shared statement of the widths each target promises, a shell that is as tall as the *visible* viewport rather than the large one, and a `coarse:` variant beside the 145 `motion-reduce:` variants already in the tree. Task 4 measures what breaks. Tasks 5–8 build option stories on the **real** components at a phone width, behind Storybook, and are deleted in Task 9 once the decision is taken. The durable output of 5–9 is a decision record, not a diff.

**Tech Stack:** React 19, TypeScript 6.0.x, Tailwind v4 (`@theme`/`@custom-variant` in `src/index.css`), Vitest, Storybook 10.5.7, `scripts/cdp.mjs`.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §6.1 and §6.4, and [the parity matrix](../specs/2026-08-27-cross-platform-parity-matrix.md) §7.

---

## 9b is deliberately unplanned, and this says why

**There is no plan in this repository for "implement the mobile layout", and there must not be one until 9a's options come back approved.**

Spec §6.1 says the mobile layout is *"a design task, not a media-query pass"* and that *"options come to Markus before anything is built, via the `frontend-design` skill."* Parity matrix §7 says the same in the same words and adds *"this matrix only records that they are open."*

A task-level plan for 9b would have to name the components it creates, the props they take and the tests that pin them. Every one of those names is downstream of a choice nobody has made. Whether the six `NAV` entries end up in a bottom bar, a drawer or the rail they already collapse to decides whether 9b touches `useSidebarDrops`, `useNavCollapsed` and `useNavLabels` at all. Whether `CardGrid` keeps being a wall or becomes a list decides whether `columnsFor`/`tileWidthFor`/`sideGutterFor` survive. Writing steps against any of those today produces placeholders, and this repo's planning rules forbid them.

So 9b is scoped and named here and nowhere else:

- **9b** — build the four approved layouts, re-verify every drag against `@dnd-kit/react` at touch sizes, and re-measure the deck editor's `deskWidth` ladder at phone widths. **Planned after Task 9 records the decision**, against what was chosen rather than against a guess.

This is the same split the dnd-kit plan made for the same reason: [3a](2026-08-27-dnd-kit-3a-foundation-and-folder-tree.md) built the smallest real thing and wrote the answer down, and 3b was written against that answer.

---

## What this plan calls "design-independent", and the test it had to pass

A thing is in Tasks 1–4 only if **it is wrong today at a phone width whatever the phone layout turns out to be**, and fixing it constrains none of the four rounds. Everything else is 9b's.

| In | Why it survives every option |
| --- | --- |
| The widths each target promises (Task 1) | Every option has to be looked at through the same window, or two options are being compared at two sizes. |
| `100dvh` and the safe-area insets (Task 2) | A ribbon under a notch and a dialog footer under a URL bar are wrong for a bottom bar, a drawer and a rail alike. |
| One spelling of `(pointer: coarse)`, and a target-size token (Task 3) | Every option contains buttons, and the app's small ones sit at 28px and 32px with **no coarse-pointer branch anywhere**. |
| The hover and gesture census (Task 4) | It is a measurement of what a pointer-less reader loses. It is the input the four rounds argue *from*. |

**Deliberately out**, each because it belongs to someone else or to a choice not yet made:

- **Breakpoint *values*.** Where the ribbon folds, where the wall goes to one column, where the desk stops being two columns — these *are* the design. Task 1 fixes only the mechanism question (viewport or container) and the floors, which are facts.
- **`touch-action` on drag handles.** `@dnd-kit/react` is pointer-based and a drag competes with the scroller on touch, but the element set is [3b and 3c](2026-08-27-dnd-kit-3a-foundation-and-folder-tree.md)'s and a second registration on one element silently replaces the first. Two plans reaching for the same handles is how that bug arrives.
- **Hiding `TitleBar` on web and Android.** Parity §5 says the browser and the OS own the frame, but the branch needs the platform module Boundary A introduces (`src/lib/core/`), which is on `boundary-a-core` and not in this tree.
- **The image-cache LRU, the one-tab guard, the PWA manifest, the corpus tier prompt.** Phase 2.
- **`tauri.conf.json`'s `minWidth: 1024` / `minHeight: 700`.** Desktop's floor is a decision that stands. What changes is that the phrase "the app's 1024px floor", which a good many files use as if it were universal, becomes a statement about *one target* — a docs correction, folded into Task 1.

---

## What the tree already answers

Measured 2026-08-28 in this worktree at `8c924bb`, by reading the source. **Every one of these is a fact the design rounds argue from, and several of them contradict what the spec assumed.**

| | Measured | Consequence for a 390px phone |
| --- | --- | --- |
| `Ribbon` | `h-14` = 56px; title 20px Cinzel; status line 14px | Cinzel's floor is **18px** (`src/CLAUDE.md`), so the title cannot be shrunk to fit — it stays 20px or it goes |
| `AppShell` `<nav>` | `w-52` = 208px, `w-17` = 68px collapsed, persisted in `app_meta` by `useNavCollapsed` | 208px leaves 182px of content — narrower than one 170px tile. **The wide rail is impossible on a phone**; the collapsed one is already built |
| `AppShell` `<main>` | `relative min-h-0 flex-1 overflow-auto p-5` — the app's only scroller | `p-5` costs 40px of a 390px window |
| `CardGrid` | `TILE_BASE_WIDTH = 170`, `GAP = 12`, `baseTileWidth` is a prop | `columnsFor(350, 170)` = **1**, and `sideGutterFor(350, 170)` = **90px of empty margin each side**. `columnsFor(350, 160)` = 2; `columnsFor(366, 170)` = 2 |
| `useCardZoomGesture` | `wheel` + `ctrlKey`, `{ passive: false }` | A trackpad pinch is a ctrl+wheel and works. **A touchscreen pinch is not a wheel event at all, so the 16-stop ladder is unreachable on a phone** |
| `DeckEditor` | `DECK_FLOOR` 192, `DESK_GAP` 16, `MIN_PANEL_WIDTH_PX` 206 → `roomForPanel` threshold **414** | 414 > 350, so **the shipped code already falls back to the rail**. The question is what the rail becomes, not whether the desk splits |
| `DeckEditor` header | `deskWidth` thresholds 1400 / 1100 / 900 off a `ResizeObserver` | A ladder already exists and already reasons about its own box, not the window |
| `StackView` | `stackColumnWidth(1)` = 224px | One pile per line at 350px. A ten-category deck is a very long column |
| `TextView` | `COLUMN_WIDTH` = `18.75rem` = 300px | One column, no overflow |
| `FilterBar` | `@container/fb`, bands at **640 / 900 / 1500**; below 640 the search box takes a whole line and chips drop to `size-8` | **The sub-640 band was designed for the docked panel's 206px floor (~193px content box).** The filter bar's phone layout largely exists |
| Responsive variants in `src/` | **10** total (`sm:` ×2, `md:` ×1, `lg:` ×1 and four in `Dialog`); `@container` in 2 files; `matchMedia` in **0** | There is no breakpoint system to extend. There is a container-query rule and a strong precedent against viewport queries |
| `motion-reduce:` variants | **145** | Media-query-driven Tailwind variants are already how this app expresses an environment preference |
| Control heights | The app's ladder is `h-9`/`size-9` (36px) for a control, `h-8`/`size-8` (32px) and `h-7`/`size-7` (28px) for a small one — grep them rather than quoting a count, which is a fact about a tree | Everything below 36px is under every touch guideline. WCAG 2.5.5 (AAA) asks 44×44; 2.5.8 (AA) asks 24×24 |
| ~~`touch-action` / `pointer: coarse`~~ | ~~**0 occurrences in the whole tree**~~ — **half wrong, corrected 2026-08-29 by Task 4.** `(pointer: coarse)` really is nowhere. **`touch-action` is at two sites**: `src/index.css:434`, inside the block mirroring the rules `@dnd-kit/dom` injects at runtime, and `src/features/decks/DeckSearchPanel.tsx:1072`, where the panel's resize strip carries Tailwind's `touch-none` | Neither is a designed touch affordance, and neither changes what this plan does. It matters to **9b**: a plan that believes the tree has no `touch-action` will add a second registration to an element that already has one, which is the failure mode 3b and 3c both warn about |
| `index.html` | `width=device-width, initial-scale=1.0` — **no `viewport-fit=cover`** | `env(safe-area-inset-*)` resolves to `0px` on every device today |
| `AppShell` root | `h-screen` (= `100vh`) | On a mobile browser `100vh` is the **large** viewport, so the shell's bottom sits under the URL bar |

**Two of these change what the design round is about.** The filter bar already has a narrow band that was designed for a box half a phone's width, so F1 below ("change nothing but the target size") is a serious option rather than a straw man. And the deck editor already falls back to a rail below 414px of desk, so the phone question is *what the rail opens into*, not whether the two columns can coexist.

---

## Verification instruments available at 9a time

9a runs in Phase 5, after the web and Android targets exist. It does not depend on them, and every measurement below can be taken today.

- **`scripts/cdp.mjs size <w> <h>`** drives the shipped WebView2 at a phone width. **Two traps, both in the script's own comments:** it hardcodes `mobile: false`, so it emulates a narrow *desktop* and never a mobile viewport's URL-bar behaviour or its pointer; and WebView2 **ignores `clearDeviceMetricsOverride`**, so the only way back is an explicit `size 1280 800`.
- **`scripts/cdp.mjs media <feature> <value> "<expression>"`** overrides a media feature — but the override **belongs to the socket and every invocation is its own socket**, so the expression must ride in the same command. Chromium's emulated-media allowlist is not `matchMedia`'s: `prefers-reduced-motion` is on it and **`pointer` is very likely not**. Task 3 finds out rather than assuming.
- **A real phone against Storybook.** `adb reverse tcp:6006 tcp:6006` makes the dev machine's Storybook `localhost:6006` on the device — a secure context, no HTTPS setup, `adb` only. Spec §9 proves this shape for this repo on a OnePlus 12. **This is the only instrument where `pointer: coarse`, the safe area and the URL bar are real rather than emulated**, and it needs nothing from Phase 2 because Storybook runs entirely on the fake.

---

## Global Constraints

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; nothing here touches Rust, so those two are not at risk.
- **Never install `@types/node`.** TypeScript stays on 6.0.x. `xlsx` is banned. No new runtime dependency is needed by any task here — if one seems to be, stop and report.
- **Read the surface's own rules before touching it.** [`src/CLAUDE.md`](../../../src/CLAUDE.md) is binding for every task; [`src/features/decks/CLAUDE.md`](../../../src/features/decks/CLAUDE.md) for Task 7; [`.storybook/CLAUDE.md`](../../../.storybook/CLAUDE.md) for every task that writes a story.
- **Never state a component prop you have not read out of the Storybook MCP tools.** `list-all-documentation` for the component list, `get-documentation` for one component's props and examples. `src/CLAUDE.md` forbids inferring a prop from a naming convention or from another library. **This plan's own prop lists were read from source, because the Storybook MCP answered `500` three times on 2026-08-28** — one instance was already on port 6006 from another worktree and the lock read `FREE`, which the `running-the-app` skill warns is not proof. Re-verify before writing any of them.
- **Only one app and one Storybook run across every worktree, and both collisions are silent.** Take the lock through `.claude/skills/running-the-app/lock.ps1`. A `FREE` lock does not mean nothing is running.
- **After changing anything that alters how the UI looks, call `preview-stories` and put every returned URL in the report.** A shared file has no stories of its own — preview its consumers'.
- **Tailwind scans source text for whole class names, so a class named in a doc comment emits a rule** and a class built by interpolation emits nothing. Both bite this plan: Task 3's sweep reads prose, and Task 2's tokens are arbitrary values that can silently compile to nothing.
- **jsdom has no layout engine.** Nothing in Tasks 1–3 that is about *pixels* can go red in the suite; the tests here pin classes and constants, and the numbers come from a browser. Say which is which at each site.
- **Tasks 5–8 produce no test that can judge a design.** Their deliverable is a set of Storybook previews Markus can open plus a written argument. Do not dress that up as coverage.

> ⚠️ **And the claim that used to stand here — "`src/stories.test.tsx` will render each option and go red if it throws" — is false for these files, corrected 2026-08-29.** `src/stories.test.tsx:277` reads `if (plays.length === 0) continue;`, and these options are specified to carry **no `play` functions**, so **not one of the twelve is ever rendered by the suite.** What still bites is `composeStories` at module scope (`:253`), which runs for every story file at collection — so an import-time or compose-time break goes red, and a render-time one does not. `npm run build-storybook` compiles them and never plays them either.
>
> **So opening each of the twelve URLs in Task 9 Step 1 is not a courtesy — it is the only thing in this plan that proves an option renders at all.** Treat a URL that 404s or throws in the preview as a red build.

---

### Task 1: The widths each target promises, and the instrument the design round is looked at through

**Files:**
- Create: `src/lib/viewports.ts`
- Create: `src/lib/viewports.test.ts`
- Modify: `docs/reference/frontend-design.md` — append to it; do not create a new doc

**Interfaces:**
- Consumes: nothing.
- Produces: `DESKTOP_FLOOR_PX`, `DESKTOP_FLOOR_HEIGHT_PX`, `PHONE_PX`, `PHONE_HEIGHT_PX`, `TABLET_PX` from `@/lib/viewports`, used by Tasks 5–8's decorators.

> **Why a module and not four numbers typed into four story files.** Two options compared at two widths are not compared. And the desktop floor is already written down — in `src-tauri/tauri.conf.json`, in a language the frontend cannot read — so a TS copy of it is a number that can drift silently. The test below is the fence, and it is the same shape as `TitleBar.test.tsx` pinning `SNAP_BUTTON_ID` across the Rust boundary.

- [ ] **Step 1: Write the failing test**

Create `src/lib/viewports.test.ts`. It reads the Tauri config through Vite's `?raw`, which is how `tokens.test.ts` reads `index.css` and how `stories.test.tsx` reaches `.storybook/preview.tsx` — this project has no `@types/node` and cannot use `node:fs`.

```ts
import { describe, expect, it } from "vitest";
import conf from "../../src-tauri/tauri.conf.json?raw";
import { DESKTOP_FLOOR_HEIGHT_PX, DESKTOP_FLOOR_PX, PHONE_PX, TABLET_PX } from "./viewports";

/**
 * The window the shipped app refuses to be smaller than, read out of the file that enforces it.
 *
 * Rust owns this number and TypeScript only quotes it, so the quote is what can rot: a window
 * floor raised in `tauri.conf.json` and not here leaves every story in the design round drawn at
 * a width the app can no longer be. Nothing else in the build compares the two.
 */
const win = (JSON.parse(conf) as { app: { windows: { minWidth: number; minHeight: number }[] } })
  .app.windows[0];

describe("viewport floors", () => {
  it("quotes the shipped window's own floor", () => {
    expect(DESKTOP_FLOOR_PX).toBe(win.minWidth);
    expect(DESKTOP_FLOOR_HEIGHT_PX).toBe(win.minHeight);
  });

  it("orders the three targets", () => {
    // Not decoration: a phone width at or above the tablet width would make the design round's
    // two frames the same frame, and every option would be looked at once.
    expect(PHONE_PX).toBeLessThan(TABLET_PX);
    expect(TABLET_PX).toBeLessThan(DESKTOP_FLOOR_PX);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/lib/viewports.test.ts 2>&1 | tail -15`
Expected: FAIL — the module does not exist.

If it instead fails on `conf` being undefined or on the JSON shape, **read `src-tauri/tauri.conf.json` and correct the accessor path before going on** — the config's shape is the fact, not the destructuring above.

- [ ] **Step 3: Implement**

Create `src/lib/viewports.ts`:

```ts
/**
 * The narrowest window each target promises to be usable in.
 *
 * **These are three different promises, and conflating them is the mistake this module exists
 * to prevent.** A good many files in this repo say "the app's 1024px floor" as though it were a
 * property of the app; it is a property of *one target*, enforced by `tauri.conf.json`'s
 * `minWidth`, and a browser tab and a phone honour nothing of the sort.
 *
 * They are **widths to look at, not breakpoints to branch on.** Where a control row folds is a
 * question about that row's own box — `FilterBar` answers it with `@container/fb` and
 * `DeckEditor` with a `ResizeObserver` over its desk — because the same component is drawn in a
 * 1500px bar and a 206px docked panel, and a viewport query answers about the wrong box. Nothing
 * in this app may grow a `sm:`/`md:`/`lg:` layout branch off these numbers without saying at its
 * own site why the *window* is the thing it is asking about.
 */

/** `src-tauri/tauri.conf.json`'s `minWidth`. Pinned against it by this module's test. */
export const DESKTOP_FLOOR_PX = 1024;

/** `src-tauri/tauri.conf.json`'s `minHeight`. */
export const DESKTOP_FLOOR_HEIGHT_PX = 700;

/**
 * The phone frame the design round is drawn in — a 390×844 CSS viewport, which is the iPhone
 * 12/13/14 and sits within a pixel or two of the common Android flagship in CSS pixels.
 *
 * **Chosen as a hard case rather than as a device.** It is narrow enough that
 * `CardGrid.columnsFor` floors at one column against today's 170px tile, which is the failure
 * the wall's round exists to answer.
 */
export const PHONE_PX = 390;

/** The same frame's height, before any browser chrome is taken off it. */
export const PHONE_HEIGHT_PX = 844;

/** The middle frame — a portrait tablet, where the deck editor's two columns become possible again. */
export const TABLET_PX = 768;
```

- [ ] **Step 4: Run, then prove the fence can fail**

Run: `npm run test -- src/lib/viewports.test.ts 2>&1 | tail -10` — expected: 2 passed.

Now change `DESKTOP_FLOOR_PX` to `1025`. The first test must FAIL naming both numbers. Revert.
Then change `PHONE_PX` to `800`. The second test must FAIL. Revert.

**If either survives, the fence is decorative** — the `?raw` import is probably resolving to something other than the config, so print `conf.slice(0, 200)` and find out before continuing.

- [ ] **Step 5: Correct the docs that call one target's floor the app's**

```bash
grep -rn "1024px floor\|app's own floor\|narrowest window this app" src docs --include=*.md --include=*.tsx --include=*.ts | wc -l
```

Do **not** rewrite every site. Append one paragraph to `docs/reference/frontend-design.md` saying that the 1024px floor is `tauri.conf.json`'s and therefore desktop's alone, that web and Android have no floor at all, and that `src/lib/viewports.ts` is where the three are now stated. Link it from the sites that would otherwise mislead only if a grep shows fewer than five — a prose-only edit routes to neither CI job, so a sweep of fourteen files is fourteen chances for a document to rot with nothing going red.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/lib/viewports.ts src/lib/viewports.test.ts docs/reference/frontend-design.md
git commit -m "feat(mobile): state the width each target promises, and pin desktop's against Rust

Three different promises, and the repo had been writing one of them down as though it were
the app's. 1024 is tauri.conf.json's minWidth and belongs to the desktop window; a browser
tab and a phone honour nothing of the sort.

The test reads the Tauri config through ?raw and compares — nothing else in the build
compares the two, so a floor raised in Rust and not in TS would leave every story in the
design round drawn at a width the app can no longer be.

Widths to look at, not breakpoints to branch on: where a control row folds stays a question
about that row's own box, which is what @container/fb and DeckEditor's ResizeObserver
already answer."
```

---

### Task 2: The visible viewport, and the safe area

**Files:**
- Modify: `index.html` — the viewport meta
- Modify: `src/index.css` — four custom properties beside the existing `:root`
- Modify: `src/components/AppShell.tsx` — the root element only
- Modify: `src/components/AppShell.test.tsx` — extend the existing class pins
- Modify: `src/components/Dialog.tsx` and `src/components/Dialog.test.tsx` — **only if Step 5 measures a problem**
- Modify: `docs/reference/frontend-design.md`

**Interfaces:**
- Consumes: Task 1's constants (for the frame the measurement is taken in).
- Produces: `--safe-t`, `--safe-r`, `--safe-b`, `--safe-l` on `:root`, for 9b to hang a bottom bar or a drawer off.

> **Why these two changes are one task.** `viewport-fit=cover` without consuming the insets is strictly worse than not shipping it: it moves the page *under* the notch and the gesture bar, and `env(safe-area-inset-*)` is `0px` in every context until that meta lands. Neither half is shippable alone.

- [ ] **Step 1: Write the failing test**

Extend `src/components/AppShell.test.tsx`. It already pins `relative` and `overflow-auto` together on `main`; this is the same idiom on the root.

```ts
import html from "../../index.html?raw";

it("is as tall as the visible viewport, not the large one", () => {
  render(<AppShell update={noUpdate}>{null}</AppShell>);
  // The shell root: the element `TitleBar` and the sidebar row live inside.
  const root = document.querySelector("div.flex.flex-col")!;
  expect(root).toHaveClass("h-dvh");
  expect(root).not.toHaveClass("h-screen");
});

it("opts the document into the safe area", () => {
  // `viewport-fit=cover` is what makes `env(safe-area-inset-*)` non-zero. Without it the four
  // custom properties below resolve to 0px on every device and the padding is dead code —
  // green here, invisible in the app, and only findable on hardware.
  expect(html).toMatch(/viewport-fit=cover/);
});
```

Use whatever root selector `AppShell.test.tsx` already reaches for; if it has none, add a `data-testid` rather than inventing a class selector that a restyle breaks.

> ⚠️ **The second assertion as written above is vacuous, measured 2026-08-29.** `expect(html).toMatch(/viewport-fit=cover/)` searches the *whole file*, and the HTML comment this task tells you to write above the meta — explaining why the attribute and the four `--safe-*` properties ship together — names the attribute. Deleting `viewport-fit=cover` from the tag left the string in the prose and **the test stayed green over the exact regression it exists to catch**. Anchor on the tag instead and read the captured group:
>
> ```ts
> const VIEWPORT_META = /<meta\s+name="viewport"[^>]*\scontent="([^"]*)"/;
> const content = html.match(VIEWPORT_META)?.[1];
> expect(content).toBeDefined();
> expect(content).toContain("viewport-fit=cover");
> ```
>
> This is `tokens.test.ts`'s rule — Tailwind reads prose as eagerly as code — arriving from the other side: the *test* read prose as eagerly as markup. **The general rule it earns: a `?raw` assertion over a whole file is only a fence if the file cannot describe the thing it is being searched for**, and in a codebase whose comments are as long as this one's, most files can.

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/components/AppShell.test.tsx 2>&1 | tail -15`
Expected: FAIL twice — `h-screen` is still there, and the meta has no `viewport-fit`.

- [ ] **Step 3: Implement**

`index.html`:

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
```

`src/index.css`, in the same `:root` block the palette uses:

```css
  /* The four edges the OS reserves — a notch, a rounded corner, a home indicator, a landscape
     cutout. **They are `0px` in every context until `index.html` carries `viewport-fit=cover`**,
     which is why that meta and these four ship together: half of this pair is dead code.

     The `0px` fallback is load-bearing rather than defensive. A browser that does not know
     `env()` treats the whole declaration as invalid, and a `padding-top` that fails to parse is
     not zero — it is whatever the cascade had before it. On desktop every one of these is `0px`
     and this whole block costs nothing. */
  --safe-t: env(safe-area-inset-top, 0px);
  --safe-r: env(safe-area-inset-right, 0px);
  --safe-b: env(safe-area-inset-bottom, 0px);
  --safe-l: env(safe-area-inset-left, 0px);
```

`src/components/AppShell.tsx`, the root only:

```tsx
    <div
      className="flex h-dvh flex-col overflow-hidden bg-bg text-text"
      // Three of the four insets, as an inline style rather than as arbitrary-value classes:
      // Tailwind scans for whole class names and a mistyped arbitrary value emits *nothing*,
      // silently, with the suite and the type-checker both green (`src/CLAUDE.md`). An inline
      // style is what a computed length is spelled as here, exactly as a column template is.
      //
      // Bottom is deliberately absent. Nothing is anchored to the window's bottom edge in this
      // build, and padding the shell there would inset a scroller against an indicator that is
      // not over it. `--safe-b` is published for whatever 9b puts down there.
      style={{
        paddingTop: "var(--safe-t)",
        paddingLeft: "var(--safe-l)",
        paddingRight: "var(--safe-r)",
      }}
    >
```

`h-dvh` rather than `h-screen`: `100vh` on a mobile browser is the **large** viewport — the height the page would have if the URL bar were hidden — so an `h-screen` shell puts its own bottom row under browser chrome. `100dvh` is the visible height and tracks the bar. On desktop and in WebView2 the two are identical, so this is a no-op there; **prove that in Step 4 rather than believing it.**

- [ ] **Step 4: Prove the classes emit, and that desktop did not move**

`h-dvh` is a core utility rather than an arbitrary value, so it should emit — but this repo has been bitten by a class that compiled to nothing, and the check is one grep:

```bash
npm run build > /tmp/build.log 2>&1; tail -3 /tmp/build.log
grep -o "\.h-dvh{[^}]*}" dist/assets/*.css
grep -o -- "--safe-t:[^;]*" dist/assets/*.css
```
Expected: a rule for each. **If `.h-dvh` is absent the utility did not survive the build** — stop and report rather than shipping a class that does nothing.

Then take the desktop reading. Follow the `running-the-app` skill for the lock, start the app, and in **one** `cdp.mjs eval` (a rect and a viewport width taken minutes apart can be at two different sizes):

```
node scripts/cdp.mjs eval "(() => { const r = document.querySelector('#root > div').getBoundingClientRect(); return { h: r.height, inner: window.innerHeight, client: document.documentElement.clientHeight }; })()"
```
Expected: the shell's height equals `clientHeight`, unchanged from before this task.

- [ ] **Step 5: Measure the dialog against a real URL bar, and only then decide**

`Dialog`'s scrim is `fixed inset-0 grid grid-rows-[minmax(0,1fr)]`, and the panel's `max-h-full` is a percentage of that grid area. If a fixed element's `bottom: 0` resolves against the **large** viewport on mobile, the area is taller than the screen and the panel's footer buttons land under the URL bar — which is the 2963px failure `src/CLAUDE.md` documents, arriving by a different route and just as invisible to jsdom.

**This is genuinely two-way and must not be guessed.** Serve Storybook to a real device (`npm run storybook`, then `adb reverse tcp:6006 tcp:6006`), open a `Dialog` story with more content than fits, and read:

```js
(() => {
  const f = document.querySelector("[data-dialog-footer], footer, .justify-end");
  return { footerBottom: f.getBoundingClientRect().bottom, visual: visualViewport.height, inner: innerHeight };
})()
```

> ⚠️ **That selector finds nothing, corrected 2026-08-29.** The `Dialog` shell renders header + body only — **its hosts supply the footer** — so `[data-dialog-footer], footer, .justify-end` matches nothing on the shell's own stories and the expression throws on `f`. Read the panel's bottom instead, and reach the scrim as `panel.parentElement`, which is exactly how `Dialog.test.tsx:226` reaches it, so the live reading and the pinned assertion talk about one element. Open the story **without the manager chrome** (`iframe.html?id=…&viewMode=story`) or the manager's own scroller makes the reading about the wrong box. The full recipe, both branches, and where the `h-dvh` pin would go is in `docs/reference/frontend-design.md` under "The dialog against a real URL bar".

- **If `footerBottom > visualViewport.height`:** add `h-dvh` to the scrim's class string beside `inset-0` — a specified height wins over `bottom` on a fixed box — and pin it in `Dialog.test.tsx` next to the existing `grid-rows-[minmax(0,1fr)]` assertion, with a comment saying the number came from a device.
- **If it does not:** change nothing, and **record the reading**. "We looked and it was already right" is a result, and the next person will otherwise pay for the same measurement.

- [ ] **Step 6: Prove the tests can fail, record, and commit**

Revert `h-dvh` to `h-screen` — the first test must FAIL. Restore.
Remove `viewport-fit=cover` — the second must FAIL. Restore.
**If either survives, the assertion is reaching the wrong element or the wrong file.**

Append to `docs/reference/frontend-design.md`: the date, the build, the desktop reading from Step 4, the device reading from Step 5, and the sentence that `--safe-b` is published and unused on purpose.

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add index.html src/index.css src/components/AppShell.tsx src/components/AppShell.test.tsx docs/reference/frontend-design.md
git commit -m "fix(mobile): the shell is as tall as the visible viewport, and inside the safe area

100vh is the LARGE viewport on a mobile browser, so an h-screen shell puts its own bottom row
under the URL bar. 100dvh is the visible height and is identical on desktop — measured in the
shipped window rather than assumed.

viewport-fit=cover and the four inset properties ship together because half the pair is dead
code: env(safe-area-inset-*) is 0px in every context until that meta lands, and a cover
viewport without padding puts the page under the notch. The insets are an inline style, not
arbitrary-value classes, because a mistyped arbitrary value emits nothing with the suite and
tsc both green.

Bottom is published and deliberately unapplied: nothing is anchored to the window's bottom
edge in this build."
```

---

### Task 3: One spelling of the coarse-pointer question, and a target-size token

**Files:**
- Modify: `src/index.css` — one `@custom-variant`, one token
- Create: `src/lib/touchTargets.test.ts`
- Modify: `docs/reference/frontend-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the `coarse:` Tailwind variant and `--target-min`, for every option in Tasks 5–8 and all of 9b.

> **Why this is foundation and not design.** The *value* of a minimum target is a standard, not a taste: WCAG 2.5.8 (AA) asks 24×24 CSS px and 2.5.5 (AAA) asks 44×44. The *variant* is the same shape as `motion-reduce:`, which this app already uses 145 times to express an environment preference. What is **not** here is any application of either — which control grows, and where, is 9b's.

- [ ] **Step 1: Write the failing test**

Create `src/lib/touchTargets.test.ts`, on `tokens.test.ts`'s sweep:

```ts
import { describe, expect, it } from "vitest";
import css from "@/index.css?raw";

/**
 * Every source file in the app, as text. Same glob and same reason as `tokens.test.ts`:
 * Tailwind reads prose as eagerly as code, and this project has no `@types/node`.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * The raw media query this variant exists to replace, assembled from two pieces.
 *
 * Written out whole it would match this very file — and worse, a find-and-replace over `src/`
 * would rewrite the guard along with the thing it guards, leaving a test that passes on a
 * codebase where nothing was fixed. `tokens.test.ts` spells `text-muted` the same way for the
 * same reason.
 */
const RAW_POINTER_QUERY = new RegExp(`\\(\\s*(any-)?${"pointer"}\\s*:`);

describe("the coarse-pointer question has one spelling", () => {
  it("declares the variant and the floor", () => {
    expect(css).toMatch(/@custom-variant\s+coarse\s*\(/);
    expect(css).toMatch(/--target-min:\s*44px/);
  });

  it("is asked nowhere else", () => {
    const offenders = Object.entries(SOURCES)
      // The stylesheet is where the variant is declared, so it is the one file allowed to
      // contain the query. Everything else asks through `coarse:`.
      .filter(([path]) => !path.endsWith("/index.css"))
      .filter(([, text]) => RAW_POINTER_QUERY.test(text))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/lib/touchTargets.test.ts 2>&1 | tail -15`
Expected: FAIL on the first test — neither the variant nor the token exists. The second should already pass, since the tree has zero occurrences today; **that is a real starting state, not a vacuous pass**, and Step 4 proves the assertion bites.

- [ ] **Step 3: Implement**

`src/index.css`, beside the existing `@custom-variant dark`:

```css
/* A coarse pointer — a finger, a stylus — as a variant, so `coarse:min-h-[var(--target-min)]`
   is how a control says it grows for touch.

   **One spelling, for `layers.test.ts`'s reason.** A raw `@media (pointer: coarse)` written in a
   component is a second answer to a question the app should answer once, and the two drift the
   first time either moves. It is also the shape `motion-reduce:` already has here — 145 sites —
   so the vocabulary is one a reader of this codebase already has.

   `pointer`, not `any-pointer`: a laptop with a touchscreen has a fine pointer *and* a coarse
   one, and `any-pointer: coarse` would grow every control on it for a finger nobody is using. */
@custom-variant coarse (@media (pointer: coarse));
```

and in the same `:root` Task 2 added the insets to:

```css
  /* The smallest a control may be when a finger is aiming at it. WCAG 2.5.5 (AAA) asks 44×44
     CSS px; 2.5.8 (AA) asks 24×24, which this app already clears everywhere. 44 is the number
     because the AA floor is a floor for a *pointer*, and the surfaces this token is for have no
     pointer at all.

     A plain custom property rather than a `@theme` entry: it is a minimum, not a step on the
     spacing scale, and putting it in the spacing namespace would generate `p-target-min` and
     `gap-target-min` — two utilities that mean nothing and one that means this. */
  --target-min: 44px;
```

- [ ] **Step 4: Prove the variant emits, and prove the sweep bites**

A `@custom-variant` that Tailwind does not accept fails **silently** — the utility simply never appears:

```bash
npm run build > /tmp/build.log 2>&1; tail -3 /tmp/build.log
```

Then add a throwaway `<div className="coarse:min-h-[var(--target-min)]" />` to any component, rebuild, and grep:

```bash
grep -o "@media(pointer:coarse){[^{]*{[^}]*}}" dist/assets/*.css | head
```
Expected: a rule wrapping a `min-height: var(--target-min)`. **If nothing is emitted the variant syntax is wrong for this Tailwind version** — read `src/index.css`'s `@custom-variant dark` line, try the at-rule form the installed Tailwind documents, and record which one worked. Remove the throwaway.

> ⚠️ **The pattern above was corrected on 2026-08-29, and the original was wrong twice in a way that reads exactly like the failure it detects.** It was written `"@media (pointer:coarse){[^}]*}"`, which exits 1 with no output over a sheet that plainly contains the rule: Tailwind 4.3.3's minifier emits `@media(pointer:coarse)` with **no space** after `@media`, and the rule **nests**, so a `[^}]*}` class stops at the inner brace. Answer: `@media(pointer:coarse){.coarse\:min-h-\[var\(--target-min\)\]{min-height:var(--target-min)}}`. The at-rule form worked on the first attempt.

Now break each assertion:
- Delete the `@custom-variant coarse` line → the first test must FAIL. Restore.
- Add `@media (pointer: coarse) { .x { color: red } }` to any `src/` file → the second test must FAIL, **naming that file**. Remove it.

**If the second survives, the glob or the regex is not reaching source text** — print `Object.keys(SOURCES).length` and confirm it is in the hundreds.

- [ ] **Step 5: Record and commit**

Append to `docs/reference/frontend-design.md`: the variant, the token, the WCAG citation, which `@custom-variant` form the build accepted, and — plainly — that **nothing in the app uses either yet**, because which control grows is 9b's decision.

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/index.css src/lib/touchTargets.test.ts docs/reference/frontend-design.md
git commit -m "feat(mobile): a coarse-pointer variant and a target-size floor, asked once

The same shape motion-reduce: already has here 145 times — an environment preference as a
Tailwind variant — and the sweep is layers.test.ts's rule applied to a media query: a raw
(pointer: coarse) written in a component is a second answer that drifts from the first.

pointer rather than any-pointer, so a laptop with a touchscreen does not grow every control
for a finger nobody is using. 44px because WCAG 2.5.8's 24px floor is a floor for a pointer
and these surfaces have none.

Nothing applies either yet. Which control grows is a design decision and belongs to 9b."
```

---

### Task 4: What a reader with no hover and no wheel loses

**Files:** none — this task produces a document.
- Modify: `docs/reference/frontend-design.md`

**Interfaces:**
- Consumes: nothing.
- Produces: the census Tasks 5–8 argue from, and the list 9b works through.

> **There is no mutation step here, because there is no code.** The deliverable is a written census, and the way it fails is by being incomplete — which a test cannot catch. Every entry must name a file and a line, so the next reader can check it rather than trust it.

- [ ] **Step 1: Enumerate the hover-only affordances**

```bash
grep -rn "group-hover:\|hover:opacity\|opacity-0" src --include=*.tsx | grep -v "\.test\." | grep -v "\.stories\." | wc -l
grep -rn "group-hover:\|opacity-0" src --include=*.tsx | grep -v "\.test\." | grep -v "\.stories\."
grep -rln "useTooltip" src --include=*.tsx | grep -v "\.test\."
```

For each hit, write down **what a reader learns or can do only by hovering**, and whether it is reachable another way. Known starting points, each to be confirmed at its own site rather than copied from here: `CardArt`'s hover lift; `CardGrid`'s action strip over the art; the `⋯` menus on folder and deck cards; every `useTooltip()` binding — the ribbon's data folder and image-failure sentence among them, which is the only place that number is said.

**One rule this census must respect:** `src/CLAUDE.md` requires a hint to be `useTooltip()`'s spread and not a `title` attribute. A phone answer is not "put the `title` back" — a native tooltip does not appear on touch either.

- [ ] **Step 2: Enumerate the gestures with no touch equivalent**

Read `src/lib/useCardZoomGesture.ts` and `src/lib/multiSelect.ts` and write down, for each:

- **Ctrl+wheel card zoom.** The listener is `wheel` with `ctrlKey` and `{ passive: false }`. That file's own comment explains that a **trackpad** pinch arrives as ctrl+wheel with no key held, which is correct and is why the desktop gesture works for two input devices. **A touchscreen pinch produces no wheel event at all** — so on a phone the whole 16-stop ladder from `ZOOM_STEPS` is unreachable, `cardZoom` is frozen at whatever `hydrateCardZoom` restored, and there is no control anywhere in the app that steps it. This is the single largest gap the census finds; state it first.
- **Ctrl-click and Shift-click.** `src/lib/multiSelect.ts` has four cases and no others, and `useCardSelection`'s `pick` returns whether the press was a selection. A touchscreen has no modifiers. Whether a phone gets multi-select at all is a design question — record only that it currently cannot.
- **Right-click.** Every context menu in the app. `components/menu` is the surface; a long-press is the usual touch answer and this app has none.
- **Hover-to-open.** `useTooltip()`'s open delay (`TOOLTIP_OPEN_MS`).

- [ ] **Step 3: Write it down**

Append a `## What touch takes away` section to `docs/reference/frontend-design.md`: two tables — affordances and gestures — each row naming the file, what is lost, and whether anything else in the app reaches the same thing today. End with the sentence that **this is a census and not a proposal**: what replaces each one is Tasks 5–8's and 9b's, and a census that quietly proposes a fix is a design decision taken without being asked for.

- [ ] **Step 4: Commit**

```bash
git add docs/reference/frontend-design.md
git commit -m "docs(mobile): what a reader with no hover and no wheel loses

A census, not a proposal. Every row names a file so the next reader can check it.

The headline: ctrl+wheel is the only way to reach the card zoom, and a touchscreen pinch is
not a wheel event — so on a phone the sixteen-stop ladder is unreachable and cardZoom is
frozen at whatever hydrateCardZoom restored. A trackpad pinch DOES arrive as ctrl+wheel,
which is why the desktop gesture serves two devices and still serves no phone.

Right-click, ctrl-click and shift-click have no touch equivalent either. What replaces any of
them is a design decision and is deliberately not in here."
```

---

## The four design rounds — Tasks 5 to 8

**These four are independent and share no files. Dispatch them in one message.**

Every one of them follows the same shape, and the shape is stated once here rather than four times:

1. **Invoke the `frontend-design` skill** and follow its two-pass process — brainstorm a compact plan (palette is fixed by [the visual direction doc](../specs/2026-08-04-visual-design-direction.md) and is *not* an axis here; type, layout and signature are), critique it against the brief, then build. Its ASCII wireframes are what survives the option stories being deleted, so draw them.
2. **Verify every prop through the Storybook MCP tools before writing it.** `list-all-documentation`, then `get-documentation` for each component the option touches. Never infer one.
3. **Build three options as stories on the real component**, in one file, titled `Mobile/<Surface>`, with no `play` functions. Each option is boxed at `PHONE_PX` by a decorator declared in that file:

```tsx
import type { ReactElement } from "react";
import { PHONE_HEIGHT_PX, PHONE_PX } from "@/lib/viewports";

// Declared here rather than shared, and the numbers rather than the box are what is shared.
// A Tailwind class cannot be built by interpolation — it would emit no rule at all — so the
// width is an inline style, which is how this repo already spells a computed length.
// `shrink-0` because the docs canvas is a flex container: without it a narrow canvas shrinks
// the frame and the story becomes a picture of a width nobody asked for.
const phone = (Story: () => ReactElement) => (
  <div className="flex shrink-0 overflow-hidden" style={{ width: PHONE_PX, height: PHONE_HEIGHT_PX }}>
    <Story />
  </div>
);
```
4. **Call `preview-stories` for all three** and keep every URL.
5. **Write the round up** in `docs/superpowers/specs/2026-08-28-mobile-layout-options.md` (create it in Task 5; append in 6–8): the wireframes, what each option costs and buys **in the numbers from "What the tree already answers"**, which shipped machinery each reuses or strands, and a labelled recommendation.
6. **Commit** the story file and the write-up together.

> **What these tasks do not produce.** There is no test that can tell a good layout from a bad one. `src/stories.test.tsx` renders every story and will go red if an option throws — that proves the option renders. The deliverable is the previews and the write-up; say so in the commit message rather than implying coverage.

---

### Task 5: Design round — the ribbon and the rail

**Files:** Create `src/components/MobileChrome.stories.tsx`; create `docs/superpowers/specs/2026-08-28-mobile-layout-options.md`.

**Read first:** `src/components/Ribbon.tsx`, `src/components/AppShell.tsx` (the `<nav>` block and its two long comments), `src/components/TitleBar.tsx`, `src/lib/useNavCollapsed.ts`, `src/lib/useNavLabels.ts`, `src/components/useSidebarDrops.ts`.

**The constraints these options are drawn under, none of them negotiable:**

- **The 2px `ManaLine` under the ribbon does not scale.** A signature that grows with its frame is a border.
- **Cinzel never below 18px**, so the ribbon's 20px title cannot be shrunk to fit — it stays or it goes. `TitleBar`'s 13px wordmark is the one exception in the app and is paid for by being a wordmark.
- **`GrimoireMark` picks its own variant at a 24px detail floor.**
- **`TitleBar` is absent on web and Android** (parity §5): the browser and the OS own the frame. So on a phone the chrome is the ribbon and the rail, and 34px comes back.
- **The rail is a drop target from every view** (`useSidebarDrops`) — the Search wall and the deck editor never coexist, so a card found in Search has nowhere else to go. Any option that moves the rail has to say where that drop goes.

**The three options to build:**

- **R1 — the rail holds, the ribbon sheds.** Force the shipped 68px collapsed rail below `PHONE_PX` instead of merely defaulting to it; the ribbon keeps title and Refresh and moves the status line into a press. *Reuses `useNavCollapsed`, `useNavLabels` and `useSidebarDrops` untouched — the cheapest of the three by a wide margin.* Costs 68 of 390 px on every screen, and puts navigation in the top-left, which is the hardest corner for a thumb.
- **R2 — a bottom tab bar.** The six `NAV` entries move to a bar in the thumb zone, inside `--safe-b`; the rail is gone below `PHONE_PX`; the ribbon becomes one title row. *Gives the wall the full 390px.* `useSidebarDrops` follows the bar — which is possible now, and was not before: `@dnd-kit/react` is pointer-based, so a bottom bar can be a drop target. Six entries is at the top of what a tab bar holds legibly.
- **R3 — a drawer behind the ribbon.** The rail becomes an off-canvas sheet opened from a button in the ribbon. *The most width for card art, which is what this app is.* Costs a tap per navigation, and it is the only option where the sidebar's drop target genuinely has nowhere to live — you cannot drop onto a drawer that is closed.

**Say in the write-up what each does with the status line**, which is a permanently-mounted `role="status"` live region whose number is `aria-hidden`. A live region that only sometimes exists announces nothing.

---

### Task 6: Design round — `CardGrid`

**Files:** Create `src/features/search/MobileCardGrid.stories.tsx`; append to the options spec.

**Read first:** `src/features/search/CardGrid.tsx` (`TILE_BASE_WIDTH`, `columnsFor`, `tileWidthFor`, `sideGutterFor`, and the `GRID_INDEX_ATTR` comment), `src/components/CardArt.tsx`, `src/components/CardChin.tsx`, `src/lib/cardZoom.ts`.

**The arithmetic these options answer**, computed from the shipped constants:

- `main` is `p-5`, so a 390px window leaves **350px** of wall — 322 if R1's rail is there.
- `columnsFor(350, 170)` = **1**. `tileWidthFor` caps at the wall, so the tile is drawn at 170 and `sideGutterFor(350, 170)` puts **90px of empty margin on each side**. A phone showing one card per row with half the screen as margin is the failure this round exists to answer.
- `columnsFor(350, 160)` = **2**. `columnsFor(366, 170)` = **2** — so `main`'s padding alone is worth a column.

**The three options to build**, each drawn with the real component and the fake's corpus:

- **G1 — a phone tile width.** `baseTileWidth` is already a prop and already defaults to `TILE_BASE_WIDTH`; pass ~160 below `PHONE_PX`. Two columns, the whole zoom ladder intact, `--mark-scale` and `--control-scale` unchanged. A 6% shrink on the chin's type. *The smallest change of the three and it strands nothing.*
- **G2 — the gutter is the bug, not the tile.** Let the wall stretch tiles to fill the row on a phone — which is the pre-2026-08-14 behaviour that was deliberately removed because it made the drawn size a step function of the column count and collapsed a ten-stop ladder to three widths on a 330px wall. **At two columns that argument does not bite the same way**, but this is a settled decision being re-opened and the write-up must argue it as one, not slip it in.
- **G3 — one column, art beside data.** The tile becomes a row: the 5:7 `CardArt` at ~96px on the left, `CardChin`'s vocabulary on the right. A phone reads a list better than a wall. *The biggest risk and the biggest payoff* — it gives up the wall of faces that is the app's whole feel, and `arrowNav`/`gridNav`'s arithmetic is about a grid.

**Every option inherits one sub-question and must answer it:** Task 4 records that the ctrl+wheel zoom is unreachable on a touchscreen. Say for each option what steps `cardZoom` on a phone — a pinch handler, a control at the filter bar's grid-or-table end, or nothing — and cost it. "Nothing" is a legitimate answer if the phone tile size is right by default; it is not a legitimate omission.

**Three rules the options must not break**, each with a live failure behind it: the tile's `scroll-m-1.5` (6px) is `DROP_MARK_ROOM`'s number reached from the other end and keeps the focus ring off the scrollport edge; top-right belongs to the `FoilOverlay`/`GameChangerMark` chip on every surface that draws a card as a face; and `sideGutterFor`'s padding goes on the **row**, never on the box the `ResizeObserver` measures.

---

### Task 7: Design round — the deck editor

**Files:** Create `src/features/decks/MobileDeckEditor.stories.tsx`; append to the options spec.

**Read first:** [`src/features/decks/CLAUDE.md`](../../../src/features/decks/CLAUDE.md) in full — it is binding and it is long. Then `src/features/decks/DeckEditor.tsx`'s desk row and its `deskWidth` observer, `DeckSearchPanel.tsx`, `views/StackView.tsx`, `views/TextView.tsx`.

**What the shipped code already does at 390px, which changes what this round is about:**

- `roomForPanel` is `deskWidth === 0 || maxPanelWidth >= MIN_PANEL_WIDTH_PX`, and the threshold is `DECK_FLOOR` + `DESK_GAP` + `MIN_PANEL_WIDTH_PX` = **414**. A 350px desk is below it, so **the panel already falls back to its rail and says so in words.** Nothing is broken; the question is what the rail opens into.
- The card pane is already an **overlay** in the editor rather than a third column (issue #183), over whichever of the two columns the reader was not looking at. That pattern exists and is drawn by `PANE_OVER_ATTR`.
- `stackColumnWidth(1)` = **224px**, so `StackView` puts one pile per line on a phone and a ten-category deck becomes a long column. `TextView`'s `COLUMN_WIDTH` is 300px — one column, no overflow.
- The header already has a ladder at 1400 / 1100 / 900 off `deskWidth`. A fourth rung is a smaller change than a new mechanism.

**The three options to build:**

- **D1 — the rail's fallback, taken seriously.** Keep `roomForPanel`; the rail's open state becomes a full-width overlay over the deck, which is the pattern #183 already established. *Reuses the most.* Honest cost: while the overlay covers the deck there is nothing to drag *into*, so adding a card is a tap and dragging is for rearranging within the deck.
- **D2 — a bottom sheet.** The search column becomes a sheet from the bottom edge at ~40% height with the deck visible above it; a card is dragged up out of the sheet into a pile. *The only option that keeps cross-column drag on a phone*, and the only one that spends what 3a and 3b bought. Costs a surface type this app does not have — and `src/CLAUDE.md`'s rule that a consulted surface is a `Dialog` and a worked-out-of surface earns a place in the layout has to be **extended** here rather than broken: a sheet is the second kind, on a window with no width to give it.
- **D3 — `Deck | Find`, one at a time.** A segmented control at the top of the editor; each pane takes the whole width. No cross-surface drag at all. *The simplest and the most predictable*, and it gives up the most.

**Measure, do not assume, before writing the round up:** drive the shipped editor at `cdp.mjs size 390 844` with a multi-category deck and read the three views' actual widths and any horizontal overflow. `size` hardcodes `mobile: false` and **cannot be cleared in WebView2** — put the window back with an explicit `size 1280 800`. An overhang in the editor becomes a horizontal scrollbar across the whole builder, which is the one thing the desktop floor forbids, and it arrives with nothing on screen naming the culprit.

---

### Task 8: Design round — the filter bar

**Files:** Create `src/features/search/MobileFilterBar.stories.tsx`; append to the options spec.

**Read first:** `src/features/search/FilterBar.tsx` — particularly the `@container/fb` comment at ~line 483 and the four-band arrangement below it — and `src/components/FilterChips.tsx`.

**The finding that reframes this round.** `FilterBar` already lays out by its own width in four bands at 640 / 900 / 1500, and **the sub-640 band was designed for the docked search panel's 206px floor**, i.e. a ~193px content box — half a phone. Below 640 the search box already takes a whole line via `basis-full`, the gaps already close from 12 to 8, and `ManaValueChips` already drops from `size-9` to `size-8`. **The spec listed this surface as open; the tree says most of it is answered.** The round is therefore narrower and more honest than the other three.

**The vertical budget is the real constraint and the write-up must state it.** At 390×844 with browser chrome the visible viewport is roughly 700px. Ribbon 56 + `main`'s 40 of vertical padding + the bar's two-or-three lines at ~36–40 each leaves the wall about **500px** — one 170px tile plus its chin, and a sliver of the next row. Anything the bar spends is spent out of the only thing the reader came for.

**The three options to build:**

- **F1 — change nothing but the target size.** The container query already answers a 390px box; the one thing wrong is that `size-8` chips are 32px, below the `--target-min` Task 3 set. Raise them under `coarse:`. *The honest option, and it may simply be right.*
- **F2 — the disclosure becomes a sheet.** In-place expansion of `Filters` pushes the wall off a 700px screen; open it as a full-height surface on `Dialog` instead, with the active 26px chips staying on the bar so the reader can still see what is on.
- **F3 — a sticky one-line bar.** The search box and a single `Filters` button stick to the top of the wall as it scrolls; everything else lives in F2's sheet. *Buys back the most vertical room*, and it is a change to **where the bar lives** rather than to what it holds.

**Three things no option may break:** the arrangement is `order` plus a `basis-full` break and never one `<div>` per breakpoint with `hidden` on the rest — that build puts two mana groups and two sort pickers in the tree at once, which is two tab stops and two accessible names per filter. `labels`/`idStem` keep each surface's box its own name and its own `id`. And no folder control joins the filters: where the reader is standing is navigation, and among the filters it would be the one thing `Reset all` could not undo.

---

### Task 9: Put the four rounds in front of Markus, record the answer, and open 9b

**Files:**
- Modify: `docs/superpowers/specs/2026-08-28-mobile-layout-options.md`
- Delete: the four option story files from Tasks 5–8

**Interfaces:**
- Consumes: Tasks 5–8.
- Produces: the decision 9b is planned against.

- [ ] **Step 1: Check the previews are live and the workbench is green**

```bash
npm run build-storybook > /tmp/sb.log 2>&1; tail -5 /tmp/sb.log
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
```

Then start Storybook (taking the lock) and confirm each of the twelve preview URLs opens on the right story. **A URL that 404s is worse than no URL** — it reads as the option not existing.

- [ ] **Step 2: Ask, through `AskUserQuestion`, one question per surface**

Four questions. Each one:

- **Leads with what was measured**, not with the options. "A 390px window leaves 350px of wall; `columnsFor(350, 170)` floors at one column with 90px of margin either side" is the question. "How should the grid look on a phone?" is not.
- **Puts the recommendation first and labels it as such.**
- **Carries the preview URLs** for its three options.
- Leaves "Other" doing real work — an answer that is not on the list is the point of asking.

- [ ] **Step 3: Record the answer where 9b will be planned from**

Rewrite the head of `docs/superpowers/specs/2026-08-28-mobile-layout-options.md` as a decision record: for each surface, which option was chosen, in Markus's own words where he gave them, and what it commits the app to. Keep the losing options and their wireframes below it — the reason an option was **not** chosen is the thing a later reader needs and the thing that is always thrown away.

Then state, in that file, what 9b now has to do, per surface, in one paragraph each. That is not 9b's plan; it is the brief 9b's plan is written from.

- [ ] **Step 4: Delete the option stories**

```bash
git rm src/components/MobileChrome.stories.tsx \
       src/features/search/MobileCardGrid.stories.tsx \
       src/features/decks/MobileDeckEditor.stories.tsx \
       src/features/search/MobileFilterBar.stories.tsx
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
```

They were mock-ups of three futures, two of which are now dead; leaving them turns the workbench into a museum of layouts the app does not have, and `src/stories.test.tsx` would go on rendering all twelve on every run. **Note in the record that the URLs were live at the moment the decision was taken** — the wireframes in the document are what survives, which is why Tasks 5–8 draw them.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-08-28-mobile-layout-options.md
git commit -m "docs(mobile): the four phone layouts, decided

One option per surface, chosen from three that were built on the real components and looked
at in a 390px frame. The losing two are kept with their wireframes: why an option was not
chosen is what a later reader needs, and it is what always gets thrown away.

The option stories are deleted with this commit. They were mock-ups of three futures, two of
which are now dead, and stories.test.tsx would have gone on rendering all twelve.

9b is now writable — the brief it is planned from is at the foot of this file."
```

---

## Self-Review

**Spec coverage.** This implements the half of §6.1 that is determined: it runs the design round the spec requires *before* anything is built, through the `frontend-design` skill, and ships the four foundation pieces that hold whichever option wins. It does **not** implement the mobile layout, and §6.1's own words are why.

**Placeholders.** There are none, and two places that look like them are not. Task 2's Step 5 does not say what to do to `Dialog` — it says what to measure, names both possible readings and says what follows from each, because whether a `fixed inset-0` box resolves against the large or the small viewport on mobile is a browser fact this plan will not guess. Task 3's Step 4 does the same for `@custom-variant`'s at-rule form, which fails **silently** if written wrong. Both are the exemplar's Task-1 shape: build the smallest real thing, read what actually happens, write the answer down.

**Type consistency.** `src/lib/viewports.ts` exports five `number` constants, defined in Task 1 and consumed by name in Tasks 5–8's decorators. `--safe-t/r/b/l` and `--target-min` are CSS custom properties declared once in `src/index.css` and referenced as `var()`, never rebuilt by interpolation — a Tailwind class assembled from a constant emits no rule at all.

**Mutation steps.** Tasks 1, 2 and 3 each break their own subject and require a named test to go red: the floor constant against Rust's, `h-dvh` and `viewport-fit=cover`, and the coarse variant plus the one-spelling sweep. Each also says what it means if the mutation **survives**, because a sweep that reaches the wrong files is green forever. Task 4 produces a document and has no mutation step, and says so. Tasks 5–8 produce previews and a write-up and have no test that can judge them, and say so — `stories.test.tsx` proves an option renders and nothing more.

**What could still be wrong here.** Three things, and they are worth reading before starting.

1. **The prop lists in this plan were read from source, not from the Storybook MCP**, which answered `500` three times on 2026-08-28 — an instance was already on port 6006 from another worktree while the lock read `FREE`. `src/CLAUDE.md` forbids answering about props from source. Every task that writes a prop re-verifies it through the MCP first, and the Global Constraints say so, but the framing of the rounds may still carry an error from that reading.
2. **Task 8 may find there is nothing to decide.** `FilterBar`'s sub-640 band was built for a 193px content box, so F1 — "change nothing but the target size" — is a real candidate rather than a straw man. That is a good outcome and the write-up must be willing to reach it, rather than manufacturing a difference to justify the round.
3. **The vertical budget may matter more than any of the four horizontal answers.** ~500px of wall on a 390×844 phone is one card and a sliver. If the rounds come back and the phone still feels wrong, the thing to re-open is what the chrome spends vertically — the ribbon's 56, `main`'s 40, the bar's 80–120 — and not which of R1/R2/R3 won. Nothing in this plan measures that end-to-end, because until one option per surface is chosen there is no stack of chrome to measure.
