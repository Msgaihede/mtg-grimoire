import { tauriHost } from "./tauri";
import type { Host } from "./types";

/**
 * What a copy is refused with where a browser offers no clipboard — `navigator.clipboard` is
 * absent outside a secure context. A caller frames it (`Couldn't copy that export — …`), so it
 * is the tail of a sentence. **One sentence on both faces**: the phone's export sheet said this
 * from a module of its own until the seam took the clipboard (phase 5, step 5.4).
 */
export const NO_CLIPBOARD = "this browser offers no clipboard here.";

/** What an open is refused with when the browser made no tab — a pop-up blocker, in practice. */
export const NOT_OPENED = "The link could not be opened. This browser may be blocking new tabs.";

/**
 * **A browser's own two answers** — the web app's host services, and half of the Android host's.
 *
 * - **Copy is `navigator.clipboard.writeText`, and it rejects rather than pretending.** The API is
 *   missing on an insecure origin, and a browser may refuse a write it does have (a document that
 *   lost focus, a permission) — the first is {@link NO_CLIPBOARD}, the second the browser's own
 *   words. There is no `execCommand` fallback: a second path that half works is how a `Copied.`
 *   comes to be drawn over an empty clipboard.
 * - **A link is a new tab, with nothing leading back.** The opener is cut the moment the tab
 *   exists — before the page on the far side has run a line — so it cannot steer this one.
 *   **Not the `noopener` feature**, which gives the same isolation and makes `window.open` answer
 *   `null` whether or not a tab opened: the Sync panel's *Connect Patreon* opens its link after a
 *   round trip to the engine, which is exactly the press a pop-up blocker refuses, and `null` is
 *   the only thing that says so ({@link NOT_OPENED}).
 */
export const browserHost: Host = {
  async copyText(text) {
    // A browser that has no clipboard API (an insecure origin) leaves the property undefined.
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) throw new Error(NO_CLIPBOARD);
    await clipboard.writeText(text);
  },

  // `async` so a refusal is a rejection like every other host's, never a throw out of a handler.
  async openUrl(url) {
    const opened = window.open(url, "_blank");
    if (opened === null) throw new Error(NOT_OPENED);
    opened.opener = null;
  },
};

/**
 * **The light app's Android host: a browser's clipboard, and Tauri's opener.**
 *
 * The host registers no clipboard plugin (`mobile/src-tauri/src/lib.rs`), so the desktop's
 * `writeText` would be refused there by name; its WebView is served from `http://tauri.localhost`,
 * a secure context, and has `navigator.clipboard` — what the phone face has copied through on
 * that host since phase 3. **The opener it does have, granted to the page as the desktop's exact
 * pair** (`capabilities/light.json`, held by `mobile/host.test.ts`), and it is the answer that
 * needs nothing from the WebView: a `window.open` there is a navigation of the app's own window,
 * which only the host's guard (`navigation.rs`) turns back into a hand-off to the browser.
 *
 * Two functions that call, rather than the two members read off their objects: a member read at
 * the top of a module is something a bundler must assume has an effect, and it kept this object —
 * and Tauri's two plugins behind it — in the web build, which never picks it.
 */
export const tableHost: Host = {
  copyText: (text) => browserHost.copyText(text),
  openUrl: (url) => tauriHost.openUrl(url),
};
