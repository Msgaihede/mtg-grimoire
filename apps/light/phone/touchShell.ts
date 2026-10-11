import { useEffect } from "react";

/**
 * The class this face puts on `<html>` while it is mounted — `mobile.css` hangs the page's
 * touch rules on it, so the desktop face (and every story) never sees them.
 */
export const TOUCH_SHELL_CLASS = "phone-touch";

/** What the viewport tag says while the phone face is up: `index.html`'s, and no page zoom. */
export const LOCKED_VIEWPORT =
  "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover";

/**
 * **A pinch no longer zooms the whole app** (the owner's decision, 2026-10-11) — the tab bar, the
 * header and the page scaled as one picture, which is a web page's behaviour and not an app's.
 * What a pinch is for here is the content: the card sheet's picture (`card/PinchZoom.tsx`) and
 * a wall's tile size (`useWallPinch`). Two locks, because no one of them holds on every host:
 *
 * - **The viewport tag** (`user-scalable=no`), which Chrome and Android's WebView honour — unless
 *   the reader has turned on Chrome's *Force enable zoom*, which this leaves to them.
 * - **`touch-action: pan-x pan-y` on the root** (`mobile.css`), which Safari honours where it
 *   ignores the tag. It also takes double-tap-to-zoom and its wait for a second tap away.
 *
 * The same class turns off the browser's chrome a page never asked for: pull-to-refresh, which
 * reloaded the app when a page was dragged down from its top, and the grey flash on every tap
 * (the app draws its own press, `PRESS`).
 *
 * **Only while this face is mounted**: a resize past 1024px draws the desktop face, which is a
 * desktop page and keeps every zoom a browser offers. The tag is put back as it was found.
 */
export function useTouchShell(): void {
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add(TOUCH_SHELL_CLASS);
    const tag = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
    const before = tag?.content;
    if (tag) tag.content = LOCKED_VIEWPORT;
    return () => {
      root.classList.remove(TOUCH_SHELL_CLASS);
      if (tag && before !== undefined) tag.content = before;
    };
  }, []);
}
