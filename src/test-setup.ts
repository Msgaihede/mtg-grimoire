import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

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
