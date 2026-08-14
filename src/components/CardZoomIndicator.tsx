import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatZoom } from "@/lib/cardZoom";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";

/**
 * How much quiet it takes for the badge to go away — measured from the **last** notch, not
 * from the first.
 *
 * A timer, where almost nothing else in this app has one, and it is allowed here for exactly
 * `REPORT_MS`'s reason (`components/useSidebarDrops.ts`): **it is not a transition.** Nothing
 * about the fade is decided here — that is {@link popup}'s, and `MotionConfig` in `App.tsx`
 * turns it down for a reader who asked the OS for less. All this number decides is *when* a
 * figure about a gesture that has stopped stops being news.
 *
 * 1200ms because the gesture it reports on is repeated: a trackpad pinch or a rolled wheel
 * arrives as a stream of notches a few tens of milliseconds apart, and every one of them
 * restarts this clock, so the badge is up for the whole gesture whatever its length. What the
 * number really sets is the tail after the reader's hand stops — long enough to read a
 * three-character figure, short enough that it is gone before they reach for anything.
 */
export const ZOOM_QUIET_MS = 1200;

/**
 * The zoom figure, floating over the wall it is about.
 *
 * Split out from {@link CardZoomIndicator} — which owns the store, the clock and the presence —
 * because a badge that is on screen for a second and a fifth at a time has no *resting* state a
 * catalogue could show otherwise. This is the half that has a look; that one is the half that
 * has a life. (Storybook's `Chrome/CardZoomIndicator` stories the pair: the states here by
 * argument, the timing there through the store.)
 *
 * **`aria-hidden`, and deliberately not a live region.** This is transient feedback for a
 * mouse-and-trackpad gesture: a `role="status"` here would announce "60%… 75%… 90%…" once per
 * wheel notch, which is a burst of noise a screen-reader reader cannot act on and did not ask
 * for — they are not the ones holding ctrl and rolling a wheel. The size of a card is the wall's
 * business, and the wall says what it is showing in its own accessible name. Do not "fix" this
 * into a status.
 *
 * **Non-interactive to the pixel.** `pointer-events-none` is not decoration: this box is
 * `fixed` across the whole window width, directly over the grid, and a layer that took the
 * pointer would swallow the very ctrl+wheel events that put it there — the badge would appear
 * on the first notch and eat every notch after it.
 */
export function ZoomBadge({ zoom }: { zoom: number }) {
  return (
    <motion.div
      {...popup}
      aria-hidden="true"
      className={cn(
        // A full-width centring row rather than a half-width offset, so the scale in `popup`
        // has nothing to fight: the pill sits at the row's centre, so the row growing from 0.96
        // grows the pill about its own middle and moves it nowhere.
        "pointer-events-none fixed inset-x-0 bottom-10 flex justify-center",
        // The rung for "floating over the page", which is what this is — above a table's sticky
        // header, which would otherwise paint over it, and deliberately **below** the drag tray,
        // the full-window overlays and the sync gate. A reader who has a dialog open
        // is not zooming the wall behind it, and a figure about that wall must not be the one
        // thing drawn on top of a surface they opened. It only competes in the root stacking
        // context, so mount it at the app root and not inside a transformed ancestor.
        LAYER.popup,
      )}
    >
      <span className="rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-sm tabular-nums text-text shadow-lg">
        {formatZoom(zoom)}
      </span>
    </motion.div>
  );
}

/**
 * What the reader is told while they zoom the card sections, and nothing else.
 *
 * Two facts out of the store and one clock over them:
 *
 * * **`zoomPulse`, not `cardZoom`, is what puts the badge up.** A gesture at either end of the
 *   range changes no number — the zoom is clamped — and that is precisely the moment a reader
 *   most needs an answer, because they are rolling the wheel and nothing is happening. Watching
 *   the size would say nothing at exactly that moment. The pulse counts *gestures*, so "200%,
 *   and that is as far as it goes" is a badge that stays up under a hand that keeps going.
 * * **Hidden on mount, and it stays hidden until a gesture arrives.** The pulse the store
 *   already holds is the one this starts from, so opening the app flashes nothing — and neither
 *   does a remount half an hour into a session, when the count is at 40.
 * * **Every pulse restarts the clock**, so continuous zooming keeps the figure on screen and it
 *   leaves once the reader actually stops. The effect below is keyed on the pulse it is up for,
 *   which is what makes the restart the ordinary cleanup path rather than a second timer.
 *
 * The store read is adjusted **during render** rather than in an effect, which is React's own
 * answer for state derived from something that changed, and this project's — see
 * `lib/useDelayedFlag.ts`, which does the same on the same rule (`react-hooks` rejects the
 * synchronous `setState` in an effect body outright, and an effect would also cost a painted
 * frame with the badge not yet up).
 *
 * Takes no props on purpose: it is mounted once, at the app root, and everything it draws is a
 * fact two other surfaces already own.
 */
export function CardZoomIndicator() {
  const zoom = useAppStore((s) => s.cardZoom);
  const pulse = useAppStore((s) => s.zoomPulse);

  /** The last pulse this has reacted to. Starts wherever the store already is — see the doc. */
  const [seenPulse, setSeenPulse] = useState(pulse);
  /** The pulse the badge is currently up for, or `null` when nothing is on screen. */
  const [shownFor, setShownFor] = useState<number | null>(null);

  if (seenPulse !== pulse) {
    setSeenPulse(pulse);
    setShownFor(pulse);
  }

  // Keyed on the pulse rather than on a bare "is it up" flag, so a notch arriving while the
  // badge is already showing re-runs this — clearing the previous timeout and starting a fresh
  // one — instead of inheriting whatever was left of it. The same cleanup covers unmount, which
  // is the case where a stray timer would set state on a component that is gone.
  useEffect(() => {
    if (shownFor === null) return;
    const timer = setTimeout(() => setShownFor(null), ZOOM_QUIET_MS);
    return () => clearTimeout(timer);
  }, [shownFor]);

  return (
    <AnimatePresence>{shownFor !== null && <ZoomBadge key="zoom" zoom={zoom} />}</AnimatePresence>
  );
}
