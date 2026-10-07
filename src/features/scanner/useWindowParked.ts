import { useEffect, useState } from "react";
import { isWindowMinimized, onWindowFocusChanged, onWindowResized } from "@/lib/window";
import { useGrace, usePageHidden, type Parked } from "./useParked";

// The grace and its shape are `useParked.ts`'s — shared with the light app's phone face, which
// parks on the document's visibility alone — and re-exported so this module's importers keep theirs.
export { PARK_GRACE_MS, type Parked } from "./useParked";

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
  const hidden = usePageHidden();

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

    reread();
    onWindowResized(reread).then(keep, () => undefined);
    onWindowFocusChanged(reread).then(keep, () => undefined);
    return () => {
      gone = true;
      for (const off of offs) off();
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
  return useGrace(useWindowMinimized());
}
