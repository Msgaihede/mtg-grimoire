/**
 * The only place the frontend touches the *window* rather than the app's own commands.
 *
 * `src/lib/ipc.ts`'s reason, applied to a second boundary: `@tauri-apps/api/window` reads
 * `window.__TAURI_INTERNALS__`, which jsdom does not have and Storybook's fake world does not
 * provide — so a component importing it directly is a component neither the workbench nor
 * Vitest can mount. Everything below is one `vi.mock` / one Vite alias away from a fake, and
 * `.storybook/fake/window.ts` is the fake both use.
 *
 * **Every function here is `async` even where the underlying call need not be**, because the
 * real ones are: Tauri's window methods all cross the IPC boundary and return promises, and a
 * fake that resolved synchronously would let a component get away with an ordering the shipped
 * app does not allow.
 *
 * The four verbs match the four permissions granted in `src-tauri/capabilities/desktop.json`
 * — `core:window:allow-minimize`, `-toggle-maximize`, `-close`, `-start-dragging`. Adding a
 * fifth here means adding its permission there, and the reverse: a granted permission nothing
 * on this page calls is a widening nobody asked for.
 */
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Send the window to the taskbar. */
export async function minimizeWindow(): Promise<void> {
  await getCurrentWindow().minimize();
}

/** Maximize, or restore if already maximized — the double-click-the-titlebar verb. */
export async function toggleMaximizeWindow(): Promise<void> {
  await getCurrentWindow().toggleMaximize();
}

/**
 * Close the window, which ends the process.
 *
 * `close()` rather than `destroy()`: it fires the `CloseRequested` event, which is the hook a
 * future "you have unsaved changes" gate would need. Nothing listens today, so the two behave
 * identically — the difference is that this one leaves the door open and the other welds it.
 */
export async function closeWindow(): Promise<void> {
  await getCurrentWindow().close();
}

/** Whether the window is maximized right now — which of two glyphs the middle button draws. */
export async function isWindowMaximized(): Promise<boolean> {
  return getCurrentWindow().isMaximized();
}

/**
 * Subscribe to the window being resized, and hand back the unsubscribe.
 *
 * The only signal that the maximized state changed. There is no `onMaximized`, and polling
 * would be a timer running for the life of the app to catch an event that fires by hand — but
 * note that this fires for *every* resize, including a drag of the window's edge, so the
 * handler must be cheap and must re-read the state rather than assume it flipped.
 */
export async function onWindowResized(cb: () => void): Promise<() => void> {
  return getCurrentWindow().onResized(cb);
}

/**
 * The two events `tauri-plugin-snap-layout`'s native overlay emits as the pointer enters and
 * leaves it.
 *
 * **The maximize button cannot use CSS `:hover`**, and this is the whole reason these exist.
 * The plugin parks a transparent Win32 child window over that button's rectangle so Windows 11
 * can answer `HTMAXBUTTON` from `WM_NCHITTEST` and raise its Snap Layouts flyout — which means
 * the pointer is over a native child, never over the webview, and the button's own `:hover`
 * never fires. It would be a button that visibly stops responding on the one platform the
 * feature is for.
 *
 * Emitted only on Windows 11. Everywhere else the plugin is a documented no-op, nothing is
 * ever emitted, and the button's CSS `:hover` works normally — so both paths have to draw the
 * same hover, and {@link SNAP_HOVER_EVENTS} is the reason `TitleBar` keeps a state flag rather
 * than choosing one mechanism.
 */
export const SNAP_HOVER_EVENTS = {
  enter: "tauri-snap://snap/mouseenter",
  leave: "tauri-snap://snap/mouseleave",
} as const;

/**
 * Subscribe to the snap overlay's two hover events as one thing, and hand back the
 * unsubscribe.
 *
 * **A pair rather than two calls, because a caller has no use for one of them.** They are the
 * two edges of a single boolean, and a component that subscribed to `enter` and forgot `leave`
 * would leave the maximize button lit for the rest of the session — a stuck hover, on the one
 * control whose hover cannot be corrected by moving the pointer, since the pointer was never
 * over the webview to begin with.
 *
 * Here rather than in `TitleBar` for `ipc.ts`'s reason, stated in its header: this module is
 * the only place the frontend names a Tauri event, so it is the only module a test or a story
 * has to fake. `TitleBar` importing `listen` directly is what made every existing `AppShell`
 * and `App` test reach the real `@tauri-apps/api/event` and flood the run with unhandled
 * rejections while still passing — 336 of them, which is the shape of a mock boundary in the
 * wrong place.
 */
export async function onSnapHover(cb: (hovering: boolean) => void): Promise<() => void> {
  const offs = await Promise.all([
    listen(SNAP_HOVER_EVENTS.enter, () => cb(true)),
    listen(SNAP_HOVER_EVENTS.leave, () => cb(false)),
  ]);
  return () => {
    for (const off of offs) off();
  };
}

/**
 * The DOM id the snap overlay tracks. Set in Rust — `snap_layout::init().button_id(…)` in
 * `src-tauri/src/lib.rs` — and read here so the two cannot drift: the failure of a mismatch is
 * silent on both sides (no overlay is created, no error is raised, Snap Layouts simply never
 * appear), which is exactly the kind that survives a release.
 */
export const SNAP_BUTTON_ID = "snap-maximize-button";
