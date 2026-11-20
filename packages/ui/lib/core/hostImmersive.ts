/**
 * **Immersive full screen — the system bars put away, the page the whole screen** — and the one
 * place the hosts differ about how. `hostStorage.ts`'s arrangement: the page asks for the effect,
 * never for the kind of host it is on (`apps/light/phone/fence.test.ts`).
 *
 * Asked for by the Life tracker's board on the light app's phone face (the owner's request,
 * 2026-11-20: the tracker must fill an Android phone's screen properly), on as the board comes up
 * and off as it goes.
 *
 * **Two roads, chosen by what is there, not by where this runs:**
 *
 * 1. **A host bridge, `window.grimoireImmersive.setImmersive(on)`**, where a host put one on the
 *    page. The Android host does (`MainActivity.kt`'s `ImmersiveBridge`): its WebView (wry 0.55.1)
 *    answers the browser's Fullscreen API by hiding the custom view the moment it is shown, so a
 *    `requestFullscreen()` there does nothing a reader can see, and the bars stay. The bridge
 *    hides them with the window's own insets controller, a swipe from an edge showing them for a
 *    moment, and the host's insets listener stops padding the page for bars that are not there.
 * 2. **The browser's Fullscreen API** everywhere else — the web app in a phone's browser above
 *    all — while `document.fullscreenEnabled` says it may: the document element full screen with
 *    the browser's own navigation hidden, and back out when it is off. **A browser grants it only
 *    during a press** (transient activation), so `setImmersive(true)` must be called from the
 *    press that brings the board up — Start game, Continue game — and not from an effect a frame
 *    later. A refusal (no press, a policy, a browser that says no) is swallowed: the board is
 *    still drawn, under the browser's bars.
 *
 * A host with neither — a desktop browser's frame does not care, and the desktop face never asks —
 * changes nothing. Feature detection of the bridge is not a platform probe: the page asks whether
 * an object it would call is there, which every host answers by having it or not.
 */

/** What a host that puts its own bridge on the page provides — exactly one method. */
interface ImmersiveBridge {
  setImmersive: (on: boolean) => void;
}

/** The bridge, if a host put one on the page. Read on every call: a host may add it late. */
function bridge(): ImmersiveBridge | null {
  const found = (window as Window & { grimoireImmersive?: Partial<ImmersiveBridge> })
    .grimoireImmersive;
  return typeof found?.setImmersive === "function" ? (found as ImmersiveBridge) : null;
}

/**
 * Put the system bars away (`on`) or bring them back. Never throws, never rejects: a host or a
 * browser that refuses leaves the page as it was.
 */
export function setImmersive(on: boolean): void {
  const host = bridge();
  if (host !== null) {
    try {
      host.setImmersive(on);
    } catch {
      // A bridge that throws is a host that said no; the page goes on as it is.
    }
    return;
  }
  try {
    if (on) {
      if (document.fullscreenEnabled !== true || document.fullscreenElement) return;
      // `navigationUI: "hide"` asks a phone's browser to put its own bar away too; a browser that
      // does not know the option ignores it.
      void document.documentElement.requestFullscreen({ navigationUI: "hide" })?.catch(() => {});
    } else if (document.fullscreenElement) {
      void document.exitFullscreen()?.catch(() => {});
    }
  } catch {
    // An older engine that throws instead of rejecting: the same refusal.
  }
}
