/**
 * The fake `getCurrentWindow`, aliased over `@tauri-apps/api/window`.
 *
 * `core.ts`'s argument, for the window boundary: it sits *under* `packages/ui/lib/window.ts` rather
 * than replacing it, so a story exercises the wrapper as well as the component. The real
 * module reads `window.__TAURI_INTERNALS__` at call time, which jsdom does not have — a
 * `TitleBar` story without this alias throws on its first click rather than on mount, which is
 * the shape of failure that reads as a component bug.
 *
 * **Module-level state, unlike `core.ts` and `event.ts`, and the difference is not an
 * oversight.** Those two are per-world because a story's *backend* is its own — two docs-page
 * stories can hold different databases. A page has exactly one window — its own, on the desk
 * and here, however many others the desk has open — and a per-world window would let a docs
 * page show two stories disagreeing about whether the app is maximized. What that costs is the
 * thing `scope.ts` exists to prevent, so `resetWindow` is provided and `installWorld` calls it:
 * state that outlives a story is state the next story inherits.
 */
import { listen } from "./event";

type ResizeListener = () => void;
type FocusListener = (e: { payload: boolean }) => void;

interface FakeWindowState {
  maximized: boolean;
  minimized: boolean;
  minimizeCount: number;
  toggleMaximizeCount: number;
  closeCount: number;
  listeners: Set<ResizeListener>;
  focusListeners: Set<FocusListener>;
}

const state: FakeWindowState = {
  maximized: false,
  minimized: false,
  minimizeCount: 0,
  toggleMaximizeCount: 0,
  closeCount: 0,
  listeners: new Set(),
  focusListeners: new Set(),
};

/**
 * The window handle `@tauri-apps/api/window` hands back.
 *
 * Every method is `async` because every real one is — see `packages/ui/lib/window.ts`. `minimize` and
 * `close` change nothing observable on screen: a story cannot be minimized, and a story that
 * closed itself would take the workbench with it, so both only count. `toggleMaximize` does
 * flip the flag and fire the resize listeners, because that is the one whose result the
 * component draws.
 */
export function getCurrentWindow() {
  return {
    label: "main",
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
    async isMinimized(): Promise<boolean> {
      return state.minimized;
    },
    async onResized(cb: ResizeListener): Promise<() => void> {
      state.listeners.add(cb);
      return () => state.listeners.delete(cb);
    },
    async onFocusChanged(cb: FocusListener): Promise<() => void> {
      state.focusListeners.add(cb);
      return () => state.focusListeners.delete(cb);
    },
    /**
     * `Window.listen` — an event aimed at this window. There is one window here, so it is the
     * fake bus's `listen`, which is also what keeps `TitleBar`'s `emitFake(SNAP_HOVER_EVENTS…)`
     * stories and tests reaching the button.
     */
    async listen<T>(event: string, cb: (e: { payload: T }) => void): Promise<() => void> {
      return listen(event, cb);
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

/**
 * Minimize or restore the window, in the order Windows reports it: the state first, then a
 * resize (to 0×0 and back) and the focus going or coming — so a handler re-reading
 * `isMinimized()` on either event sees the new value.
 */
export function setMinimized(next: boolean): void {
  state.minimized = next;
  for (const cb of state.listeners) cb();
  for (const cb of state.focusListeners) cb({ payload: !next });
}

/** What a story or a test asserts against. A copy, so a caller cannot write through it. */
export function windowCalls(): Omit<FakeWindowState, "listeners" | "focusListeners"> {
  const { maximized, minimized, minimizeCount, toggleMaximizeCount, closeCount } = state;
  return { maximized, minimized, minimizeCount, toggleMaximizeCount, closeCount };
}

/** Back to a restored window with no subscribers and nothing counted. */
export function resetWindow(): void {
  state.maximized = false;
  state.minimized = false;
  state.minimizeCount = 0;
  state.toggleMaximizeCount = 0;
  state.closeCount = 0;
  state.listeners.clear();
  state.focusListeners.clear();
}
