import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { frame, frameData, MotionGlobalConfig } from "motion/react";
import { afterEach } from "vitest";

/**
 * Every `motion` animation lands on its final value in one frame, for the whole suite.
 *
 * **jsdom animates for real without this**, which is the thing worth knowing: it has no
 * `Element.prototype.animate` — measured, `typeof` is `undefined` — so `motion` never takes its
 * WAAPI path, and falls back to its own main-thread driver on `requestAnimationFrame`, which
 * jsdom does have. Probed 2026-08-12 with a 180ms fade: `opacity: 0.08` at mount, `0.50` at
 * 60ms, `1` at 360ms. Nothing throws and nothing needs shimming; the animations are simply
 * *real*, and therefore timing-dependent.
 *
 * That is fine for a component test that awaits a `findBy*` and fatal for the ~256 story `play`
 * functions `src/stories.test.tsx` composes: a `play` asserts on the DOM the moment it renders,
 * and half a fade is an element that is present, focusable, and at `opacity: 0.08`. This is a
 * setup file rather than something `stories.test.tsx` does for itself because
 * `MotionGlobalConfig` is a module-level object read at animation time — one assignment before
 * any test file loads covers every file, the composed stories included. `motion.test.ts`
 * asserts the flag is set, which is what fails if this line is ever dropped or if the module
 * graph ever hands a test a second copy of `motion`.
 *
 * Deliberately **not** done in `.storybook/preview.tsx`: that file is also the real Storybook
 * browser, where the whole point is that a reader can watch the motion.
 */
MotionGlobalConfig.skipAnimations = true;

/**
 * …and lands it **synchronously**, because "one frame" was still one frame too many.
 *
 * `skipAnimations` shortens an animation; it does not remove the hop through the frame loop.
 * `motion-dom`'s `animateMotionValue` applies the skipped animation's final keyframe inside
 * `frame.update(...)` (see `animation/interfaces/motion-value.mjs`), and that batch is
 * scheduled on `requestAnimationFrame`. A `motion` element therefore paints its `initial` —
 * for every preset in `lib/motion.ts` that is `opacity: 0` — and only reaches `opacity: 1` on
 * the next frame.
 *
 * **That one frame is a flake, and it is the one that has been biting CI.** `findBy*` resolves
 * the moment the element lands in the DOM, which is the render *before* the frame; the
 * assertion that follows then runs against an ancestor still at `opacity: 0`. It fails as
 * `expect(element).toBeVisible()`, and the two things that make it hard to read are worth
 * writing down:
 *
 * * **`byRole` and `toBeVisible` disagree about opacity, and only about opacity.**
 *   `isSubtreeInaccessible` tests `hidden`, `aria-hidden` and `display: none`; `toBeVisible`
 *   tests those *and* `opacity`. So the query finds the element and the assertion then refuses
 *   it — which reads like nonsense until you know that only an ancestor's opacity can do it.
 * * **The failure prints the element with no children**, because jest-dom prints
 *   `element.cloneNode(false)` — a *shallow* clone. An empty `<button />` in the message is the
 *   printer, never evidence that the content had not arrived.
 *
 * Two CI runs pin it, and the pair is the proof it was never anyone's diff: run 32337273661
 * failed `CardDetailPane.test.tsx > the foil view > is a view again…` on a feature branch, and
 * run 32330052897 failed `CardDetailPane.stories.tsx > Legalities plays` on **`main`**.
 *
 * Running the batch inline closes the gap: the final keyframe is applied during the layout
 * effect that starts the animation, so a `motion` element's `initial` is never observable
 * after the commit and no assertion can lose the race. `keepAlive` work — the continuous
 * loops, which are the ones that would recurse forever — is left on the real frame loop.
 * Verified by delaying every `requestAnimationFrame` in the suite to **500ms**, 30× worse than
 * a starved runner: with this the whole class passes, without it eight tests fail.
 */
const inline =
  (scheduled: typeof frame.update): typeof frame.update =>
  (process, keepAlive = false, immediate = false) => {
    if (keepAlive) return scheduled(process, keepAlive, immediate);
    process(frameData);
    return process;
  };
// The two steps a skipped animation passes through: `update` carries the final keyframe onto
// the motion value, `render` is what writes it to the element.
frame.update = inline(frame.update);
frame.render = inline(frame.render);

// Testing Library only registers its own `afterEach(cleanup)` when Vitest runs with
// `globals: true`, which this project does not. Without it every render stacks up in the
// same `document.body` and the second test in a file sees two of everything.
afterEach(cleanup);

// jsdom has no layout engine and no ResizeObserver. The card grid measures its container
// to decide how many columns fit, so without this every grid test renders nothing — and
// `@tanstack/react-virtual` observes its scroll element with one too.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom has no layout, so it answers no questions about what is at a point either — and the
// drag auto-scroller asks one on every frame of a drag (`pragmatic-drag-and-drop-auto-scroll`
// looks through what is under the pointer to find the scroller it should move). An
// unimplemented method there throws outside every test's stack: an unhandled error that fails
// the run without failing an assertion. Nothing is under a pointer in a window with no layout,
// and that is what this answers — the auto-scroll itself is the live CDP pass's to prove.
document.elementsFromPoint ??= () => [];

// jsdom implements no pointer capture either, and the deck editor's search panel resizes with
// it: the handle captures on `pointerdown` so the drag survives the pointer leaving a 9px strip
// that is *moving away from it*, and releases on `pointerup`. An unimplemented method there
// throws inside the event handler, so a resize test would fail on the API rather than on the
// behaviour. `??=`, so a jsdom that grows a real implementation is used instead of this.
Element.prototype.setPointerCapture ??= () => {};
Element.prototype.releasePointerCapture ??= () => {};
