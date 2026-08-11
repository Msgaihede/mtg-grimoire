# Deck stack flip-through, and motion across the app

Date: 2026-08-12
Status: approved, ready to plan

Two pieces of work that share one dependency. The first fixes a real defect in the deck
builder's signature interaction. The second gives the app a motion vocabulary it has never
had. Both land on `motion@13.1.0`, which this spec adopts.

---

## 1. The defect, measured

`CardStack` lays its cards out with `margin-bottom: -278px` and lifts the hovered one with
`hover:mb-2`. The list has a fixed height and `overflow-visible`, so a lift pushes the cards
after it out of the box rather than resizing it.

The arithmetic that matters, and which nobody had written down:

- A card is `STACK_CARD_HEIGHT` = **312px**; collapsed it advances the stack by
  `STACK_ADVANCE` = **34px**.
- With card *N* open, card *k*'s top is `k·34` for `k ≤ N`, and `N·34 + 320 + (k−N−1)·34`
  for `k > N`.
- Open card *N+1* instead and every one of those tops is unchanged **except card N+1's**,
  which moves from `N·34 + 320` to `N·34 + 34`.

So a step down the stack moves exactly one card, 286px. That is good news for animating it
and it is also the whole defect: **after the first step, the next card's strip is only ~34px
below the pointer.** A continuous downward sweep crosses four or five strips in ~60ms, each
one firing its own 286px reflow, and the reader lands several cards below the one they aimed
at. That is the reported symptom — "it selects a card further down in the stack" — and it is
not a rendering bug, it is the absence of any hover intent.

A close delay alone does not fix it. Every strip the pointer crosses still arms its card. The
fix is a pair: an **open dwell** so a sweep commits to nothing until it settles, and a **close
delay** so switching between two cards never shows a closed frame.

## 2. The new interaction

Model, confirmed against the Archidekt reference: the reflow stays. Cards above the open one
are thin bars at the top, the open card is expanded in place, cards below sit under it. What
changes is what arms a card and when.

| | Today | New |
|---|---|---|
| Trigger | CSS `:hover` on the whole 312px face | `openIndex` state, armed by `pointerenter` on the `<li>` |
| Open | Instant, on every strip crossed | After `STACK_OPEN_DWELL_MS` = **70ms** |
| Close | Instant | After `STACK_CLOSE_DELAY_MS` = **180ms**, cancelled by arming another card |
| Motion | `transition-[margin-bottom] 150ms` | `motion` animating the one card that moves |
| Keyboard | `focus-within:mb-2` | `onFocus` sets `openIndex`, `onBlur` schedules the close |
| Leave stack | Instant collapse | Collapse after the close delay |

`pointerenter` on the `<li>` is the correct trigger and needs no new hit-target element: a
closed card is overlapped by 278px by its successor, which is later in DOM order and therefore
paints over it, so **the only hittable part of a closed card already is its 34px strip**. The
open card is z-raised and its own art re-arms nothing, because re-entering an already-open
card is a no-op.

Preserved exactly: `stackHeight(n) = 34·(n−1) + 312 + 8`, the fixed inline height, the
`overflow-visible` contract, `onSelect` on click/Enter/Space, `deckCardProps` data attributes,
the `FOCUS_INSET` negative outline offset, and `StackView`'s `groupHeight = 46 + stackHeight(n) + 20`.

### Why the pointer never loses its card

With card *N+1* newly open, its body spans `N·34+34 → N·34+346` and the pointer that armed it
sits at roughly `N·34+337`. The card slides up *underneath* a stationary pointer and the
pointer remains inside it for every frame of the animation, so no spurious `pointerenter`
fires. Card *N+2*'s strip lands 17px below the pointer, and one 34px move reaches it. The
gesture is therefore: one small move per card, with the layout settling once per step.

## 3. Motion vocabulary

`src/lib/motion.ts` is the single source of truth and the only file that defines timings.
Everything else consumes it. `src/index.css`'s `@theme` block carries the same scale as
`--duration-*` / `--ease-*` custom properties so CSS-only sites agree with JS ones.

The app's stated 150ms budget is kept as the *interaction* tier and widened only where a
surface travels a real distance:

| Token | Value | Used for |
|---|---|---|
| `fast` | 120ms | press feedback, chevrons, colour |
| `base` | 180ms | the stack reflow, popups, status lines |
| `slow` | 260ms | drawers and dialogs, which cross the window |

Presets exported for consumers: `scrim`, `drawerRight`, `dialog`, `popup`, `statusLine`,
`press`, `stackCard`. Consumers import a preset; they do not write durations.

## 4. Reduced motion

`<MotionConfig reducedMotion="user">` is mounted once at the app root. Motion does **not**
honour `prefers-reduced-motion` by default — `MotionConfigContext` ships `reducedMotion:
"never"` — so this is load-bearing rather than decorative.

It is a deliberately weaker guarantee than the app's existing CSS rule, and this is the
behaviour change worth naming: it makes transforms and width/height/top/left **instant**, but
**opacity, colour and filter still animate** (`visual-element-target.mjs:84-87`). That is
WCAG 2.3.3's intent — the hazard is movement, not a cross-fade — but it is not what
`motion-reduce:transition-none` does, and both rules now coexist in the app.

`useReducedMotion()` is **not** the app-wide mechanism: it reads its value once with
`useState` and never updates on a live media-query change. It is fine as a per-component
branch (swap a slide for a fade) and wrong as the global switch.

## 5. Forbidden APIs, and why the usual verification cannot catch them

The shipped CSP is `style-src 'self'; style-src-attr 'unsafe-inline'`. Inline `style=`
attributes are allowed — which is what `motion` writes, and why it is usable at all — but a
`<style>` **element** appended at runtime is blocked. Two public `motion` APIs do exactly that:

- **`AnimatePresence mode="popLayout"`** — `framer-motion/dist/es/components/AnimatePresence/PopChild.mjs:89-95`
  appends a `<style>` to `document.head` and inserts a rule into `style.sheet`. Under the
  shipped CSP `style.sheet` is null, which line 94 already guards, so popLayout **silently
  does nothing** and exiting siblings jump. No throw, no error.
- **`animateView()` / `ViewTransitionBuilder`** — `motion-dom/dist/es/view/utils/css.mjs:9,22`,
  same mechanism, reachable from `import { animateView } from "motion"`, and with no nonce
  path at all.

`MotionConfig nonce` is not an escape: it needs a nonce-based `style-src` and this app has
`'self'`.

**The dev CSP has `style-src 'self' 'unsafe-inline'`.** So `tauri dev`, Storybook, jsdom and
every test are green on a violation that only appears in the shipped exe. A source sweep is
the only thing that can catch it, so `src/lib/tokens.test.ts` gains one.

Everything else is safe: `motion.*`, `AnimatePresence` at `sync`/`wait`, `MotionConfig`,
`layout`/`layoutId`, gestures, MotionValues, `useAnimate`, `scroll`, `inView`. All write
`element.style.*` through CSSOM or drive WAAPI, neither of which CSP governs. The packages
contain no `eval`, `new Function`, `Blob`, `Worker` or `innerHTML`, so `script-src` is untouched.

## 6. Test guards

`tokens.test.ts`'s existing sweep is `/\btransition-(?!none)/g` requiring
`motion-reduce:transition-none` within 400 characters. It is **blind to JS motion** — a file
animated entirely through `motion` matches nothing and passes trivially, so the guard would
stay green across a whole feature it cannot see. Two assertions are added to the same file:

1. Exactly one `<MotionConfig reducedMotion="user">` exists in `src/`, and no other
   `MotionConfig` sets `reducedMotion` to anything else.
2. No file under `src/` mentions `popLayout` or `animateView`.

`MotionGlobalConfig.skipAnimations = true` is set in the Vitest setup and in the Storybook
test annotations, or the 242 story `play` functions become timing-dependent.

## 7. Scope

**In:** the CardStack rebuild; the motion foundation; enter/exit for the four deck overlays,
the sync gate, the card detail pane and the three anchored popups; press feedback, rotating
sort arrows and chevrons, stepper ticks, and inline status/alert lines that fade and grow
instead of shoving the layout 32px.

**Out, deliberately:** deck view cross-fades, drag lift/drop springs, gallery tile lifts, and
virtual-table row enter/leave. The last is out on risk — animating a virtualiser's rows fights
its scroll.

## 8. Cost

`motion@13.1.0`, React 19 in its peers. Measured with esbuild `--bundle --minify`,
`NODE_ENV=production`, gzip -9, against the app's current 176 kB gzip bundle:

| shape | gzip | marginal |
|---|---|---|
| react + react-dom baseline | 61,012 | — |
| + `motion` component | 102,430 | +41.4 kB |
| + `motion` + `AnimatePresence` + `MotionConfig` | 104,262 | +43.3 kB |
| + `m` + `LazyMotion(domAnimation)` + `AnimatePresence` | 90,335 | +29.3 kB |

**Plain `motion.*` is chosen** — roughly +24% on the bundle. The app loads from local disk in
a Tauri window, so the download cost that makes `LazyMotion` worth its ceremony does not
exist here, and `m` carries a real trap: forgetting the `LazyMotion` wrapper throws at runtime.
The cheaper shape is recorded above for whoever wants to revisit it.

## 9. Verification

`npm run verify` is necessary and not sufficient. The stack's whole subject is CSS `:hover`
and real pointer movement, which jsdom does not have and which `userEvent.hover` does not
engage — `CardStack.stories.tsx:57-76` already records that no story can assert the lift. So
the interaction is proven by a live CDP pass over the shipped WebView2, using
`scripts/cdp.mjs`'s `hover --from --rest --probe`, approaching sideways onto a middle card's
title bar, and counting activations rather than checking whether one happened.
