import { vi } from "vitest";
import { PHONE_PX } from "@/lib/viewports";

/**
 * State the window's width to `useNarrowWindow` — and to nothing else that reads `matchMedia`.
 *
 * **jsdom's `matchMedia` is a stub that never matches** (`src/test-setup.ts`), which is what puts
 * every test in this repo in the desktop shape without any of them saying so. A suite that wants
 * the phone shape has to say the width by hand, and there are five such suites now — the shell's
 * own choice of navigation, and the four walls that hand `CardGrid` a narrower tile — so the stub
 * lives here rather than being written out a fifth time.
 *
 * **Only the width query answers, and that is not fastidiousness.** `motion`'s `useReducedMotion`
 * reads this same API through these surfaces, so a blanket `matches: true` would also tell it the
 * reader had asked for reduced motion — which changes timings inside tests that are not about
 * them. Every other query keeps jsdom's answer.
 *
 * The caller owns the cleanup: `afterEach(() => vi.unstubAllGlobals())` inside the block that
 * calls this, rather than a file-wide one registered from here, which would also undo a global a
 * sibling `beforeAll` had stubbed on purpose.
 */
export function stubNarrowWindow(narrow: boolean): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes(`${PHONE_PX}px`) ? narrow : false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}
