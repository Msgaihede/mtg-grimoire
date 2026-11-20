/**
 * **Immersive — a game's screen: the system bars put away, the rotation the board came up in
 * held, and the screen kept on** — and the one place the hosts differ about how. `hostStorage.ts`'s
 * arrangement: the page asks for the effect, never for the kind of host it is on
 * (`apps/light/phone/fence.test.ts`).
 *
 * Asked for by the Life tracker's board on the light app's phone face, on as the board comes up
 * and off as it goes: the bars at the owner's request (2026-11-20: the tracker must fill an Android
 * phone's screen properly); the rotation and the screen at a reader's (issue #1716: a phone lying
 * on the table turned the board under the players, and dimmed and locked between turns). The
 * setup is not held — its Layout pictures are drawn in the window's shape, so turning the phone
 * there still means something; the board keeps the shape it was set up in.
 *
 * **Two roads, chosen by what is there, not by where this runs:**
 *
 * 1. **A host bridge, `window.grimoireImmersive.setImmersive(on)`**, where a host put one on the
 *    page — and the host does all three. The Android host does (`MainActivity.kt`'s
 *    `ImmersiveBridge`): its WebView (wry 0.55.1) answers the browser's Fullscreen API by hiding
 *    the custom view the moment it is shown, so a `requestFullscreen()` there does nothing a reader
 *    can see, and the bars stay. The bridge hides them with the window's own insets controller, a
 *    swipe from an edge showing them for a moment, and the host's insets listener stops padding the
 *    page for bars that are not there; it locks the activity to the rotation it is in and keeps
 *    the window's screen on, and lets both go when it is off.
 * 2. **The browser's own APIs** everywhere else — the web app in a phone's browser above all — each
 *    where the browser has it, each refusal swallowed (the board is drawn either way):
 *    - **Full screen** (the Fullscreen API, while `document.fullscreenEnabled` says it may): the
 *      document element full screen with the browser's own navigation hidden, and back out when it
 *      is off. **A browser grants it only during a press** (transient activation), so
 *      `setImmersive(true)` must be called from the press that brings the board up — Start game,
 *      Continue game — and not from an effect a frame later.
 *    - **The rotation** (`screen.orientation.lock`), to the exact one the screen is in — upside
 *      down included, so a phone flat on the table never flips. Asked once the full-screen request
 *      has been answered, either way: Chrome holds a rotation only for a page that is full screen
 *      (or an installed app), and lets it go by itself when full screen ends.
 *    - **The screen kept on** (the Screen Wake Lock API). A browser lets go of the lock whenever
 *      the page is hidden, so it is taken again each time the page is shown while the board is up.
 *
 * A host with none of it — a desktop browser's frame does not care, and the desktop face never
 * asks — changes nothing. Feature detection of the bridge is not a platform probe: the page asks
 * whether an object it would call is there, which every host answers by having it or not.
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
 * Whether the page last asked for immersive. The browser's answers come late — a full screen
 * granted, a wake lock handed over — and each reads this when it lands, so one that lands after
 * the board has gone is let go at once.
 */
let wanted = false;
/** The screen's wake lock while the browser holds it for the page. */
let wakeLock: WakeLockSentinel | null = null;
/** A wake lock asked for and not yet answered: never a second ask beside it. */
let wakeAsk: Promise<void> | null = null;

/**
 * Put the system bars away, hold the rotation and keep the screen on (`on`), or let all three go.
 * Never throws, never rejects: a host or a browser that refuses leaves the page as it was.
 */
export function setImmersive(on: boolean): void {
  wanted = on;
  const host = bridge();
  if (host !== null) {
    try {
      host.setImmersive(on);
    } catch {
      // A bridge that throws is a host that said no; the page goes on as it is.
    }
    return;
  }
  if (on) {
    enterFullScreen();
    keepAwake();
    document.addEventListener("visibilitychange", onVisibility);
  } else {
    document.removeEventListener("visibilitychange", onVisibility);
    letSleep();
    releaseRotation();
    exitFullScreen();
  }
}

function enterFullScreen(): void {
  try {
    if (document.fullscreenEnabled !== true || document.fullscreenElement) {
      holdRotation();
      return;
    }
    // `navigationUI: "hide"` asks a phone's browser to put its own bar away too; a browser that
    // does not know the option ignores it. The rotation waits for the answer, granted or not.
    const asked = document.documentElement.requestFullscreen({ navigationUI: "hide" });
    if (asked) void asked.then(holdRotation, holdRotation);
    else holdRotation();
  } catch {
    // An older engine that throws instead of rejecting: the same refusal.
    holdRotation();
  }
}

function exitFullScreen(): void {
  try {
    if (document.fullscreenElement) void document.exitFullscreen()?.catch(() => {});
  } catch {
    // An older engine that throws instead of rejecting.
  }
}

/** Lock the screen to the exact rotation it is in — read now, not at the press, which is the same. */
function holdRotation(): void {
  if (!wanted) return;
  const orientation: ScreenOrientation | undefined = screen.orientation;
  if (typeof orientation?.lock !== "function") return;
  try {
    void orientation.lock(orientation.type)?.then(
      // Granted after the board had already gone: let it go again.
      () => {
        if (!wanted) releaseRotation();
      },
      // Refused: a page that is not full screen, a browser that does not lock (a desktop's).
      () => {},
    );
  } catch {
    // An older engine that throws instead of rejecting.
  }
}

function releaseRotation(): void {
  try {
    screen.orientation?.unlock?.();
  } catch {
    // Nothing held, or a browser that has no unlock: either way there is nothing to let go.
  }
}

function keepAwake(): void {
  if (!wanted || wakeLock !== null || wakeAsk !== null) return;
  // A hidden page is refused a wake lock; it is asked again when the page is shown.
  if (document.visibilityState !== "visible") return;
  const api: WakeLock | undefined = navigator.wakeLock;
  if (typeof api?.request !== "function") return;
  let asked: Promise<WakeLockSentinel>;
  try {
    asked = api.request("screen");
  } catch {
    return;
  }
  wakeAsk = asked
    .then(
      (sentinel) => {
        if (!wanted) {
          void sentinel.release().catch(() => {});
          return;
        }
        wakeLock = sentinel;
        // The browser lets go by itself when the page is hidden; forget it, so a return asks again.
        sentinel.addEventListener("release", () => {
          if (wakeLock === sentinel) wakeLock = null;
        });
      },
      // Refused: a battery saver, a policy, a page hidden before the answer.
      () => {},
    )
    .finally(() => {
      wakeAsk = null;
    });
}

function letSleep(): void {
  const held = wakeLock;
  wakeLock = null;
  if (held === null) return;
  try {
    void held.release().catch(() => {});
  } catch {
    // Already let go.
  }
}

function onVisibility(): void {
  if (document.visibilityState === "visible") keepAwake();
}
