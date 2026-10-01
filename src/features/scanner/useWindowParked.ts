import { useEffect, useState } from "react";
import { isWindowMinimized, onWindowFocusChanged, onWindowResized } from "@/lib/window";

/**
 * How long a minimized Scanner keeps its camera open before letting it go.
 *
 * Long enough that a minimize and a restore in one breath — a glance at the desktop, a misclick on
 * the taskbar — costs no `getUserMedia` and no flicker; short enough that the camera light goes out
 * while the reader is still looking at it, and that a second window waiting on the lease gets it
 * within this plus the lease's two seconds.
 */
export const PARK_GRACE_MS = 5000;

/** Where a minimized window stands. */
export interface Parked {
  /** Minimized now: the pump sends nothing. */
  paused: boolean;
  /**
   * Minimized for {@link PARK_GRACE_MS}: the camera is closed and the heartbeat stopped, so the
   * lease lapses and another window can take the scanner.
   */
  released: boolean;
}

/**
 * Whether this window is minimized — answered by Tauri, because the page cannot answer it.
 *
 * **WebView2 reports a minimized window's page as `visibilityState: "visible"`** (measured,
 * [card-scanner.md](../../../docs/reference/card-scanner.md), *One window scans at a time*): 340 of
 * 340 one-second polls with the window minimized, the page's own timers unthrottled. So nothing in
 * the page ever pauses, and the scanner went on lighting the camera, running the detector at
 * 5–9 fps and renewing the lease for as long as the window sat on the taskbar.
 *
 * `isMinimized()` is re-read on the two events a minimize and a restore fire — the resize (to 0×0
 * and back, on Windows) and the focus change — and once on mount. **The focus alone decides
 * nothing**: a reader holding a card up to the camera may well have clicked another window, and a
 * scanner that stopped whenever it lost focus would stop under them. `document.hidden` is taken as
 * well, for the engines that do report it.
 *
 * A window whose question fails — no Tauri at all, as in jsdom — reads as not minimized, which is
 * the state every view had before this existed.
 */
export function useWindowMinimized(): boolean {
  const [minimized, setMinimized] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");

  useEffect(() => {
    let gone = false;
    const offs: (() => void)[] = [];
    const reread = () => {
      isWindowMinimized().then(
        (now) => {
          if (!gone) setMinimized(now);
        },
        () => {
          // Nothing to say: a window that cannot be asked is a window that stays open.
        },
      );
    };
    const keep = (off: () => void) => {
      if (gone) off();
      else offs.push(off);
    };
    const onVisibility = () => setHidden(document.visibilityState === "hidden");

    reread();
    onWindowResized(reread).then(keep, () => undefined);
    onWindowFocusChanged(reread).then(keep, () => undefined);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      gone = true;
      for (const off of offs) off();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return minimized || hidden;
}

/**
 * The Scanner's answer to being minimized: **pause at once, let go after a grace.**
 *
 * The pump stops on the minimize itself — a frame sent from a window nobody is looking at is a
 * detector pass and an OCR read for nothing — and the camera and the lease follow
 * {@link PARK_GRACE_MS} later, so a quick restore finds the stream still open. A restore inside
 * the grace cancels it; one after it reopens the camera and renews the lease, and if another
 * window took the scanner meanwhile, the heartbeat's refusal is what sends this one to the gate's
 * sentence.
 */
export function useWindowParked(): Parked {
  const minimized = useWindowMinimized();
  const [graceOver, setGraceOver] = useState(false);
  // A restore puts the grace back in the render that sees it — React's own answer to state that
  // follows a value — so no frame reads `released` for a window that is open again.
  const [was, setWas] = useState(minimized);
  if (was !== minimized) {
    setWas(minimized);
    setGraceOver(false);
  }

  useEffect(() => {
    if (!minimized) return;
    const timer = setTimeout(() => setGraceOver(true), PARK_GRACE_MS);
    return () => clearTimeout(timer);
  }, [minimized]);

  return { paused: minimized, released: minimized && graceOver };
}
