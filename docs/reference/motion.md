# Motion

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- **Timings live in `src/lib/motion.ts` and nowhere else.** `DURATION` is `fast` 120 · `base`
  180 · `slow` 260 ms, `EASE` is `standard`/`enter`/`exit`, and consumers import a **preset**
  (`scrim`, `drawerRight`, `dialog`, `popup`, `statusLine`, `press`, `stackCard`) rather than a
  number. The 150 ms budget it replaces existed only as a prose comment and ~100 hand-copied
  `duration-150` literals. `src/index.css` carries the same scale so CSS-only sites agree.
- **`@theme static` is load-bearing for `--duration-*`.** Measured against tailwindcss 4.3.3 by
  compiling the block both ways: under plain `@theme` the three lines are **absent from the
  output entirely** (tree-shaken, because nothing references them), under `@theme static` they
  land in `:root`. `--ease-*` **is** a v4 namespace, so `ease-standard` is a real utility;
  `--duration-*` is **not**, so there is no `duration-base` and it is read as
  `duration-[var(--duration-fast)]`.
- **`<MotionConfig reducedMotion="user">` is mounted once, in `App.tsx`** — not `main.tsx`,
  which nothing in the suite or in Storybook ever loads, so a provider there is one only the
  shipped window would have. Motion ships `reducedMotion: "never"` by default, so this line is
  load-bearing rather than decorative.
- **It only reduces `positionalKeys`, and that is a trap with a live example.** The set is
  `width, height, top, left, right, bottom` plus the transform props — read out of
  `motion-dom/.../keys-position.mjs`. **`marginBottom` is not in it**, so the deck stack's 286px
  reflow would have travelled at full speed under `reducedMotion="user"` — a straight regression
  against the `motion-reduce:transition-none` it replaced. `CardStack` therefore carries its own
  `useReducedMotion()` opt-out. **Any `motion` animation of a non-positional property needs
  one.** Opacity, colour and filter animating on is deliberate (WCAG 2.3.3's hazard is
  movement), but it is a weaker rule than the CSS one and both now coexist.
- `useReducedMotion()` is a per-component branch only: it reads its value once with `useState`
  and **never updates on a live media-query change**. It is the wrong thing to reach for as an
  app-wide switch.
- **Two public APIs are forbidden: `AnimatePresence mode="popLayout"` and `animateView()`.**
  Both append a `<style>` element to `document.head` (`PopChild.mjs:89-95`,
  `motion-dom/.../view/utils/css.mjs:9,22`), which `style-src 'self'` blocks. The failure is
  **silent** — `style.sheet` comes back null and `PopChild` already guards on it, so popLayout
  simply does nothing and siblings jump. `MotionConfig nonce` is not an escape; it needs a
  nonce-based `style-src`. `mode="sync"` and `"wait"` are fine.
- **`devCsp` has `style-src 'self' 'unsafe-inline'` and the shipped `csp` does not**, so dev,
  Storybook and jsdom are all green on that violation and only the packaged exe breaks. A source
  sweep is the only thing that can catch it, and `src/lib/tokens.test.ts` now carries it, beside
  a second guard asserting exactly one `MotionConfig reducedMotion="user"` exists in `src/`.
  Both were proven red before being trusted. The old `\btransition-(?!none)` sweep is **blind to
  JS motion** — a file animated entirely through `motion` matches nothing and passes trivially.
- **Measured in the shipped window 2026-08-12, on a `--debug` build, which enforces the
  production CSP**: appending a `<style>` gives `sheet === null` (so the policy is genuinely the
  shipped one, not `devCsp`), the document holds **0 `<style>` elements**, and the console is
  clean of CSP violations, JS errors and React warnings across a full pass. `motion` injects
  nothing.
- **Under jsdom `motion` needs no shim**: `Element.prototype.animate` is undefined, so it falls
  back to its own rAF driver, which jsdom has. The animations are therefore **real and
  timing-dependent**, which is why `MotionGlobalConfig.skipAnimations = true` is set in
  `src/test-setup.ts` — one assignment before any test file loads, covering the composed story
  plays too.
- **A `motion` element's first painted frame carries its `initial`, so `toBeVisible` is false
  for everything inside an animated surface until the next frame** — even with `skipAnimations`,
  because `toBeVisible` walks ancestors and `opacity: 0` fails it. Story plays that assert on
  content inside a new overlay need `waitFor`, and under 91 parallel jsdom files the default 1s
  timeout is not always enough for a `requestAnimationFrame`.
- **Tailwind v4's `scale-*` writes the `scale` longhand, not `transform`** —
  `.active\:scale-\[0\.97\]:active{scale:.97}` — so a `transition-[…,transform]` list does not
  tween it and the press snaps. Tailwind's own `transition-transform` reads
  `transform,translate,scale,rotate` for exactly this reason. The shared press recipe is
  `transition-[color,background-color,border-color,opacity,transform,scale]` +
  `duration-[var(--duration-fast)] ease-standard` + `active:scale-[0.97]`, verified in the built
  CSS rather than in source.
- **Cost: +41.4 kB gzip** for the full `motion.*` surface against the app's 176 kB (esbuild
  `--bundle --minify`, `NODE_ENV=production`, gzip -9). `m` + `LazyMotion(domAnimation)` measures
  +29.3 kB and code-splits; it was **not** taken, because the app loads from local disk in a
  Tauri window and `m` throws if its wrapper is ever forgotten. An unused dep costs 0 — dist was
  byte-identical after `npm install motion` and before the first import.
