import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatZoom, type ZoomSection } from "@/lib/cardZoom";
import { LAYER } from "@/lib/layers";
import { popup } from "@/lib/motion";
import { useAppStore } from "@/lib/store";
import { zoomSectionElement } from "@/lib/useCardZoomGesture";
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
 * How far the badge sits in from its section's top-right corner, in px.
 *
 * Small on purpose, and the smallness is the argument. The badge is drawn *inside* the box it is
 * about — that is the whole of how a reader with the deck editor open knows which of two walls
 * the figure belongs to — so the inset has to read as "tucked into this corner" rather than as a
 * margin. Eight pixels is `space-2` on the app's spacing scale and comfortably less than the gap
 * between two sections, which is what keeps the pill from ever appearing to float in the trough
 * between them, belonging to neither.
 */
export const ZOOM_BADGE_INSET = 8;

/**
 * Where the badge draws itself: CSS px in from the **viewport's** top and right edges.
 *
 * Viewport rather than section coordinates because the badge is `fixed` and mounted at the app
 * root — see {@link CardZoomIndicator} for why it may not live inside the section it points at —
 * so these two numbers go into `top` and `right` untouched. A `DOMRect` would carry six more
 * fields nothing here reads, and each of them would be a fact about a box measured at one moment
 * and quietly wrong at the next.
 */
export type ZoomAnchor = { top: number; right: number };

/**
 * Where the badge goes for a gesture in `section`.
 *
 * The section's element comes from the registry `useCardZoomGesture` fills as it attaches its
 * listeners, so the box measured here is exactly the box the gesture was made over — no ref
 * threaded through four surfaces, and no way for the two to disagree about which element a
 * section is.
 *
 * **With no element it answers the window's own top-right corner.** Three things reach that
 * branch and all of them are ordinary: no gesture has been made yet, the section that was zoomed
 * has since unmounted, and a Storybook story driving the store directly with nothing registered
 * at all. None of them is an error worth a thrown exception or a hidden badge — a figure in the
 * window's corner is the pre-section behaviour and is still a true statement about the zoom.
 */
export function anchorFor(section: ZoomSection | null): ZoomAnchor {
  const el = section === null ? null : zoomSectionElement(section);
  if (!el) return { top: ZOOM_BADGE_INSET, right: ZOOM_BADGE_INSET };
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top + ZOOM_BADGE_INSET,
    // `right` in CSS is measured from the viewport's right edge inwards, and a rect's `right` is
    // measured from its left edge outwards — so the section's own inset is the difference, and
    // the badge stays in the section's corner however far from the window's that is.
    //
    // **`documentElement.clientWidth` and not `window.innerWidth`, and the difference is exactly
    // one scrollbar.** `innerWidth` counts the classic vertical scrollbar; the initial containing
    // block a `fixed` element is positioned against does not. Subtracting the wider number puts
    // the badge a scrollbar-width to the left of the corner it is meant to hug — measured live in
    // the shipped window at 1280×800, where the deck editor really does scroll: `innerWidth` 1280
    // against `clientWidth` 1265, and a desk whose right edge is 830 drew its badge at 807 where
    // 822 was wanted. The search wall, on a page with no scrollbar, was exact, which is why this
    // was invisible until the editor.
    //
    // It was found by driving the real window rather than by reasoning, and the suite is
    // structurally incapable of finding it unaided: **jsdom hard-returns 0 from every
    // `clientWidth`** — `Element-impl.js`, no layout engine and no special case for the document
    // element — so neither number in a test is a viewport, and a test has to *state* one. The
    // first version of `CardZoomIndicator.test.tsx` stated `window.innerWidth`, which is to say
    // it pinned this line's bug as the expected answer. It now states a viewport a scrollbar
    // narrower than `innerWidth` for the whole file, so every anchor assertion there is also an
    // assertion about which of the two widths this line reads.
    right: document.documentElement.clientWidth - rect.right + ZOOM_BADGE_INSET,
  };
}

/**
 * The zoom figure, floating in the top-right corner of the wall it is about.
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
 * **Non-interactive to the pixel.** `pointer-events-none` is not decoration, and it got *more*
 * load-bearing when the badge moved into the section's corner rather than less: the pill is now
 * drawn over the very scroller that carries the ctrl+wheel listener, guaranteed rather than
 * merely likely, and a layer that took the pointer would swallow the notches that put it there —
 * the badge would appear on the first one and eat every one after it, under a hand that is still
 * rolling.
 */
export function ZoomBadge({ zoom, anchor }: { zoom: number; anchor: ZoomAnchor }) {
  return (
    <motion.div
      {...popup}
      aria-hidden="true"
      // The one thing about this pill that is not a constant: which corner it is in. It is a
      // measurement of another element, so it cannot be a class — see `layers.ts` for what
      // Tailwind does with a class name it never saw in the source text.
      style={{ top: anchor.top, right: anchor.right }}
      className={cn(
        // Pinned by its top-right corner and grown from the same one. {@link popup} arrives from
        // `scale: 0.96`, and a box held by its top and right edges scaled about its *middle*
        // travels: the pill would slide up and in from outside the corner it belongs to, which
        // reads as an object flying in rather than a figure appearing where the reader is
        // looking. `origin-top-right` puts the fixed point on the two edges the `style` above
        // pins, so the only thing the animation moves is the pill's own size. It is the same
        // rule every anchored popup in this app follows — pinned by the corner it grows from.
        "pointer-events-none fixed origin-top-right",
        // The rung for "floating over the page", which is what this is — above a table's sticky
        // header, which would otherwise paint over it, and deliberately **below** the drag tray,
        // the full-window overlays and the sync gate. A reader who has a dialog open
        // is not zooming the wall behind it, and a figure about that wall must not be the one
        // thing drawn on top of a surface they opened. It only competes in the root stacking
        // context, so mount it at the app root and not inside a transformed ancestor.
        LAYER.popup,
        // The pill's own look, on the same element rather than on a child. It used to be a
        // `<span>` inside a full-width centring row, and the row is what the span was inside
        // *of*; with the row gone the box that is positioned and the box that is drawn are the
        // same box, so `origin-top-right` above is the pill's own corner and not a parent's.
        "rounded-full border border-border bg-surface px-3 py-1.5 font-mono text-sm tabular-nums text-text shadow-lg",
      )}
    >
      {formatZoom(zoom)}
    </motion.div>
  );
}

/**
 * What the reader is told while they zoom a card section, and nothing else.
 *
 * Three facts out of the store and one clock over them:
 *
 * * **`zoomPulse`, not `cardZoom`, is what puts the badge up.** A gesture at either end of the
 *   range changes no number — the zoom is clamped — and that is precisely the moment a reader
 *   most needs an answer, because they are rolling the wheel and nothing is happening. Watching
 *   the size would say nothing at exactly that moment. The pulse counts *gestures*, so "200%,
 *   and that is as far as it goes" is a badge that stays up under a hand that keeps going.
 * * **`zoomSection` says which of the four numbers in `cardZoom` this is about**, and therefore
 *   which box to draw over. Each section keeps its own zoom, so "125%" without a corner to sit
 *   in would be a figure a reader with the deck editor open — a search column beside a deck —
 *   could not attach to either wall.
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
 * **The corner is measured in that same branch, and measuring during render is correct here
 * rather than merely convenient.** The usual objection to reading a rect before the commit is
 * that it answers about the old layout — and the old layout is the right answer in this case:
 * stepping the zoom resizes a section's *contents*, never the section's own box, which is a
 * scroller sized by the app's layout and unmoved by what is inside it. So the pre-commit rect is
 * the same rect the post-commit one would be, and taking it here means the badge's **first
 * painted frame** is already in the right corner. Measuring in an effect would cost one frame
 * with the pill somewhere else — at the previous section's corner, or the window's, which is
 * exactly the flash this feature exists to avoid. If a future section ever moves as it zooms,
 * this is the paragraph that stops being true.
 *
 * Takes no props on purpose: it is mounted once, at the app root, and everything it draws is a
 * fact two other surfaces already own.
 */
export function CardZoomIndicator() {
  const cardZoom = useAppStore((s) => s.cardZoom);
  const pulse = useAppStore((s) => s.zoomPulse);
  const section = useAppStore((s) => s.zoomSection);

  /** The last pulse this has reacted to. Starts wherever the store already is — see the doc. */
  const [seenPulse, setSeenPulse] = useState(pulse);
  /** The pulse the badge is currently up for, or `null` when nothing is on screen. */
  const [shownFor, setShownFor] = useState<number | null>(null);
  /**
   * The corner the badge is up in, captured with the pulse rather than recomputed every render.
   * A section that scrolls or a window that resizes while the badge is up does not chase it: the
   * figure is about a gesture that has already happened, and it is gone in about a second.
   */
  const [anchor, setAnchor] = useState<ZoomAnchor>(() => anchorFor(null));

  if (seenPulse !== pulse) {
    setSeenPulse(pulse);
    setShownFor(pulse);
    setAnchor(anchorFor(section));
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
    <AnimatePresence>
      {/* `section` is null only before the first gesture of a session, which is also when
          `shownFor` is null — the two are written by the same action. It is tested here rather
          than asserted because the alternative is indexing `cardZoom` with a null key on a
          store any test or story may set by hand. */}
      {shownFor !== null && section !== null && (
        <ZoomBadge key="zoom" zoom={cardZoom[section]} anchor={anchor} />
      )}
    </AnimatePresence>
  );
}
