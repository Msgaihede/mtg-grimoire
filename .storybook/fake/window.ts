/**
 * The fake `getCurrentWindow`, aliased over `@tauri-apps/api/window`.
 *
 * `core.ts`'s argument, for the window boundary: it sits *under* `src/lib/window.ts` rather
 * than replacing it, so a story exercises the wrapper as well as the component. The real
 * module reads `window.__TAURI_INTERNALS__` at call time, which jsdom does not have — a
 * `TitleBar` story without this alias throws on its first click rather than on mount, which is
 * the shape of failure that reads as a component bug.
 *
 * **Module-level state, unlike `core.ts` and `event.ts`, and the difference is not an
 * oversight.** Those two are per-world because a story's *backend* is its own — two docs-page
 * stories can hold different databases. There is exactly one window, on the desk and here, and
 * a per-world window would let a docs page show two stories disagreeing about whether the app
 * is maximized. What that costs is the thing `scope.ts` exists to prevent, so `resetWindow` is
 * provided and `installWorld` calls it: state that outlives a story is state the next story
 * inherits.
 */

type ResizeListener = () => void;

interface FakeWindowState {
  maximized: boolean;
  minimizeCount: number;
  toggleMaximizeCount: number;
  closeCount: number;
  listeners: Set<ResizeListener>;
}

const state: FakeWindowState = {
  maximized: false,
  minimizeCount: 0,
  toggleMaximizeCount: 0,
  closeCount: 0,
  listeners: new Set(),
};

/**
 * The window handle `@tauri-apps/api/window` hands back.
 *
 * Every method is `async` because every real one is — see `src/lib/window.ts`. `minimize` and
 * `close` change nothing observable on screen: a story cannot be minimized, and a story that
 * closed itself would take the workbench with it, so both only count. `toggleMaximize` does
 * flip the flag and fire the resize listeners, because that is the one whose result the
 * component draws.
 */
export function getCurrentWindow() {
  return {
    async minimize(): Promise<void> {
      state.minimizeCount += 1;
    },
    async toggleMaximize(): Promise<void> {
      state.toggleMaximizeCount += 1;
      setMaximized(!state.maximized);
    },
    async close(): Promise<void> {
      state.closeCount += 1;
    },
    async isMaximized(): Promise<boolean> {
      return state.maximized;
    },
    async onResized(cb: ResizeListener): Promise<() => void> {
      state.listeners.add(cb);
      return () => state.listeners.delete(cb);
    },
  };
}

/**
 * Set the maximized state and tell every subscriber, which is the real thing's order: Tauri
 * has already resized the window by the time `onResized` fires, so a handler that re-reads
 * `isMaximized()` must see the new value. Flipping the flag after the callbacks would give a
 * component the previous state and make the glyph lag one click behind — a bug that would then
 * only exist in the fake.
 */
export function setMaximized(next: boolean): void {
  state.maximized = next;
  for (const cb of state.listeners) cb();
}

/** What a story or a test asserts against. A copy, so a caller cannot write through it. */
export function windowCalls(): Omit<FakeWindowState, "listeners"> {
  const { maximized, minimizeCount, toggleMaximizeCount, closeCount } = state;
  return { maximized, minimizeCount, toggleMaximizeCount, closeCount };
}

/** Back to a restored window with no subscribers and nothing counted. */
export function resetWindow(): void {
  state.maximized = false;
  state.minimizeCount = 0;
  state.toggleMaximizeCount = 0;
  state.closeCount = 0;
  state.listeners.clear();
}
