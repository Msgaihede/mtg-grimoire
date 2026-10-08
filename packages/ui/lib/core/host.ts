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

/** What an open is refused with for anything that is not a whole `http` or `https` address. */
export const NOT_A_WEB_ADDRESS = "That link is not a web address, so it was not opened.";

/**
 * Whether `url` is a whole web address — absolute, and `http` or `https`.
 *
 * **The scheme backstop the desktop has in its capability, restated for a browser.** There the
 * opener's `allow-default-urls` scope refuses anything but a web, mail or phone link whatever a
 * caller hands it. A page's `window.open` refuses nothing: handed a `javascript:` URL it runs
 * the script in the app's own origin, beside the reader's database. Every caller today builds
 * its address or takes it from a dialect that keeps only `http(s)` (`noteMarkdown.ts`), so this
 * is the fence behind them and not the first one. No `mailto:` or `tel:`: nothing in the app
 * opens one, and a scheme allowed for nobody is a scheme nobody has looked at. A relative URL is
 * refused too — it would open the app's own page in a second tab, which the database refuses.
 */
function isWebAddress(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

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
    if (!isWebAddress(url)) throw new Error(NOT_A_WEB_ADDRESS);
    const opened = window.open(url, "_blank");
    if (opened === null) throw new Error(NOT_OPENED);
    opened.opener = null;
  },
};

/**
 * **The light app's Android host: a browser's clipboard, and Tauri's opener.**
 *
 * The host registers no clipboard plugin (`apps/light/src-tauri/src/lib.rs`), so the desktop's
 * `writeText` would be refused there by name. Its WebView is served from `http://tauri.localhost`,
 * which is a secure context, so `navigator.clipboard` is there to call — it is what the phone
 * face's export sheet has called on every host since it was written. **Whether an Android
 * WebView grants the write has never been seen**: no copy has run on a device, on either face
 * (light-app.md §9.4). If it refuses, a copy is refused in the browser's words, which the caller
 * frames; the cure would be a clipboard plugin on that host, not a change here. And under
 * `tauri android dev` served from a LAN address the origin is not secure at all, and the answer
 * is {@link NO_CLIPBOARD}.
 *
 * **The opener it does have, granted to the page as the desktop's exact pair**
 * (`capabilities/light.json`, held by `apps/light/host.test.ts`), and it is the answer that needs
 * nothing from the WebView: a `window.open` there is a navigation of the app's own window,
 * which only the host's guard (`navigation.rs`) turns back into a hand-off to the browser. So
 * this host never reaches {@link browserHost}'s `openUrl`, and its scheme fence is the
 * opener's own scope.
 *
 * Two functions that call, rather than the two members read off their objects: a member read at
 * the top of a module is something a bundler must assume has an effect, and it kept this object —
 * and Tauri's two plugins behind it — in the web build, which never picks it.
 */
export const tableHost: Host = {
  copyText: (text) => browserHost.copyText(text),
  openUrl: (url) => tauriHost.openUrl(url),
};
