import { useEffect, useState } from "react";

/**
 * How long a Scanner nobody is looking at keeps its camera open before letting it go.
 *
 * Long enough that a minimize and a restore in one breath — a glance at the desktop, a misclick on
 * the taskbar, a phone's notification shade pulled down and let go — costs no `getUserMedia` and no
 * flicker; short enough that the camera light goes out while the reader is still looking at it, and
 * that a second window waiting on the lease gets it within this plus the lease's two seconds.
 */
export const PARK_GRACE_MS = 5000;

/** Where a Scanner that is out of sight stands. */
export interface Parked {
  /** Out of sight now: the pump sends nothing. */
  paused: boolean;
  /**
   * Out of sight for {@link PARK_GRACE_MS}: the camera is closed and the heartbeat stopped, so the
   * lease lapses and another window can take the scanner.
   */
  released: boolean;
}

/**
 * Whether the document is hidden — a tab in the background, a phone's app switched away from, a
 * screen locked. The page's own answer, and the only one a face with no window to ask has.
 *
 * **Not enough on the desktop, which is why `useWindowParked` asks Tauri as well**: WebView2
 * reports a minimized window's page as `visible`. A phone's WebView and a browser tab do report it.
 */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");

  useEffect(() => {
    const onVisibility = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  return hidden;
}

/**
 * The Scanner's answer to being out of sight: **pause at once, let go after a grace.**
 *
 * The pump stops the moment `away` goes true — a frame sent from a view nobody is looking at is a
 * detector pass and an OCR read for nothing — and the camera and the lease follow
 * {@link PARK_GRACE_MS} later, so a quick return finds the stream still open. A return inside the
 * grace cancels it; one after it reopens the camera and renews the lease, and if another window
 * took the scanner meanwhile, the heartbeat's refusal is what sends this one to the gate's
 * sentence.
 *
 * What "away" means is the caller's: a minimized window on the desktop (`useWindowParked`), a
 * hidden document on a face with no window ({@link usePageParked}).
 *
 * `bornAway` is whether a view that **mounts** away starts already let go, with no grace to run
 * out. The grace is for a view that was in sight a moment ago; one that was never in sight has no
 * stream to keep. `false` unless the caller says otherwise — the desktop's window is asked about
 * its minimize a moment *after* mount, so it never mounts away, and its behaviour is as it was.
 */
export function useGrace(away: boolean, bornAway = false): Parked {
  // Read once, at mount: `away` going true later is a view that was in sight, and gets its grace.
  const [graceOver, setGraceOver] = useState(bornAway && away);
  // A return puts the grace back in the render that sees it — React's own answer to state that
  // follows a value — so no frame reads `released` for a view that is in sight again.
  const [was, setWas] = useState(away);
  if (was !== away) {
    setWas(away);
    setGraceOver(false);
  }

  useEffect(() => {
    if (!away) return;
    const timer = setTimeout(() => setGraceOver(true), PARK_GRACE_MS);
    return () => clearTimeout(timer);
  }, [away]);

  return { paused: away, released: away && graceOver };
}

/**
 * {@link useGrace} over the document's own visibility — the light app's phone face, which has no
 * window to ask and must not import one (`apps/light/phone/fence.test.ts`).
 *
 * **A page that mounts hidden starts released.** A browser restores a background tab at the
 * address it was left on, and a phone's app can be brought up behind the lock screen; mounted
 * with a grace still to run, the Scanner there asked for the camera — a permission prompt, or a
 * lit indicator, on a page nobody was looking at — and held it for the five seconds before
 * letting it go. Shown, it opens the camera as any arrival does.
 */
export function usePageParked(): Parked {
  return useGrace(usePageHidden(), true);
}
