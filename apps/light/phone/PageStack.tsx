import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useDrag } from "@use-gesture/react";
import {
  animate,
  AnimatePresence,
  motion,
  MotionGlobalConfig,
  useMotionValue,
  useMotionValueEvent,
  usePresence,
  useReducedMotion,
  type MotionValue,
} from "motion/react";
import { PAGE, SPRING } from "@grimoire/ui/lib/motion";
import { parsePlace, placeHref, type Place } from "../routes";
import { BACK_WAIT_MS, up, useMove, type Move } from "./router";

/**
 * **The phone face's pages move like a phone's** (the owner's "feel like an iPhone app" pass,
 * 2026-11-25): a page opened from another slides in over it from the right edge, the page beneath
 * drifting a little left and dimming; Back plays that the other way; a tab cross-fades, because
 * two tabs are siblings rather than depths. And a page with a way up can be **swiped back**: a
 * finger dragging it right takes it off the page above it, which is drawn beneath as it goes.
 *
 * **Which way comes from the router, never from comparing places** (`router.ts`'s `useMove`). A
 * folder inside a folder and its parent are the same view with a different id; only the verb that
 * moved knows whether the reader went deeper. A change no verb made is Android's back gesture or a
 * browser's Back, and reads as back.
 *
 * **A page is a place less its card** ({@link pageKey}): the card is a sheet over the page, and
 * opening one moves nothing here. Anything else — a deck, a folder, a trade — is a page of its own,
 * keyed, so the page left behind stays drawn while it goes.
 *
 * **Driven by hand, not by variants.** Each layer holds its own `x` and `opacity` and animates them
 * imperatively on arrival and on leaving: a swipe sets the same two values every frame and only the
 * let-go is an animation, which variants would fight. Springs (`motion.ts`'s `SPRING.surface`), so
 * a let-go keeps the finger's speed. Under reduced motion every travel becomes a cross-fade; a
 * swipe still follows the finger, which is the reader's own movement.
 *
 * **The swipe lands on the page it showed, without a second arrival.** The page beneath is mounted
 * under the key it will have once the reader is there, so when the let-go's `up` lands the layer
 * is already the page — the same component, its scroll and state intact — and the page left goes
 * as Back takes a page, from where the swipe left it: off the glass already.
 */

/** The page a place draws — the place less its card, as `placeHref` spells it. */
export const pageKey = (place: Place): string => placeHref({ ...place, cardId: null });

/** A page key back to the place it names. */
function placeOf(key: string): Place {
  const cut = key.indexOf("?");
  return cut === -1 ? parsePlace(key, "") : parsePlace(key.slice(0, cut), key.slice(cut));
}

interface Stack {
  /** The stack's width — what a slide travels. */
  width: () => number;
  /** How the page that is leaving now leaves — the move that took the reader off it. */
  leave: Move;
  /** A swipe's progress, 0 (nothing moved) to 1 (the page above is off the glass). */
  progress: MotionValue<number>;
  /** A swipe has started on the page on top, back to `parent`: draw it beneath. */
  begin: (parent: string) => void;
  /** The let-go: `true` goes back to the page beneath, `false` puts the page back. */
  end: (commit: boolean, top: MotionValue<number>) => void;
}

const StackContext = createContext<Stack | null>(null);

/** Where a page that can be swiped back says what it goes back to — its layer's own setter. */
const SwipeBackContext = createContext<((parent: string | null) => void) | null>(null);

/**
 * Let the page this is called in be swiped back to `parent` — the place its header's `‹` names,
 * so the gesture and the arrow can never disagree. `null`, or a page drawn outside the stack (a
 * story, a test that renders a page bare), offers no swipe.
 */
export function useSwipeBack(parent: Place | null): void {
  const register = useContext(SwipeBackContext);
  const key = parent === null ? null : pageKey(parent);
  useEffect(() => {
    if (register === null) return;
    register(key);
    return () => register(null);
  }, [register, key]);
}

export function PageStack({
  place,
  render,
}: {
  place: Place;
  /** The page for a place — called for the page on top and, during a swipe, the one beneath. */
  render: (place: Place) => ReactNode;
}) {
  const { move } = useMove();
  const key = pageKey(place);
  const stackRef = useRef<HTMLDivElement>(null);
  const progress = useMotionValue(0);

  /** The page drawn beneath the one on top while a swipe is on it, by key. */
  const [beneath, setBeneath] = useState<string | null>(null);
  /** The page a swipe let go past the line is going back to, until the address lands there. */
  const [landing, setLanding] = useState<string | null>(null);

  /**
   * How the page on top arrived — kept beside the key it arrived as, and renewed in the render the
   * key changes in (React's derived-state pattern), so a new page mounts already knowing. The first
   * page arrived by nothing: the app opening is not a move.
   */
  const [arrival, setArrival] = useState<{ key: string; move: Move | "none" }>({
    key,
    move: "none",
  });
  if (arrival.key !== key) setArrival({ key, move });
  const arrived = arrival.key === key ? arrival.move : move;

  const width = useCallback(() => stackRef.current?.clientWidth || window.innerWidth, []);
  /** The page on top, for a let-go's late check — read in a timer, never in a render. */
  const keyRef = useRef(key);
  useLayoutEffect(() => {
    keyRef.current = key;
  });

  // The swipe landed: the page beneath is the page now — the same layer, handed the page's role in
  // this render, so it stops following the swipe. The page it covered is already off the glass.
  if (landing !== null && landing === key) {
    setLanding(null);
    setBeneath(null);
  }

  const begin = useCallback(
    (parent: string) => {
      progress.set(0);
      setBeneath(parent);
    },
    [progress],
  );

  const end = useCallback(
    (commit: boolean, top: MotionValue<number>) => {
      if (!commit || beneath === null) {
        void animate(top, 0, SPRING.surface);
        void animate(progress, 0, SPRING.surface).then(() => setBeneath(null));
        return;
      }
      const parent = beneath;
      setLanding(parent);
      void animate(top, width(), SPRING.surface);
      void animate(progress, 1, SPRING.surface).then(() => {
        up(placeOf(parent));
        // A way up the router declined — already leaving, or already there — lands nowhere: put
        // the page back rather than leave the reader on a page slid off the glass.
        setTimeout(() => {
          if (keyRef.current === parent) return;
          setLanding(null);
          void animate(top, 0, SPRING.surface);
          void animate(progress, 0, SPRING.surface).then(() => setBeneath(null));
        }, BACK_WAIT_MS * 2);
      });
    },
    [beneath, progress, width],
  );

  const stack = useMemo<Stack>(
    () => ({
      width,
      leave: move,
      progress,
      begin,
      end,
    }),
    [width, move, progress, begin, end],
  );

  return (
    <StackContext.Provider value={stack}>
      <div ref={stackRef} className="relative min-h-0 flex-1 overflow-hidden">
        <AnimatePresence initial={false}>
          {beneath !== null && beneath !== key && (
            <PageLayer key={beneath} role="beneath" arrival="none">
              {render(placeOf(beneath))}
            </PageLayer>
          )}
          <PageLayer key={key} role="page" arrival={arrived}>
            {render(place)}
          </PageLayer>
        </AnimatePresence>
      </div>
    </StackContext.Provider>
  );
}

/** Below this much movement a finger is still a tap, or still deciding which way it is going. */
const SWIPE_SLOP_PX = 10;

/**
 * One page in the stack: the page on top, or the one a swipe is uncovering beneath it.
 */
function PageLayer({
  role,
  arrival,
  children,
}: {
  role: "page" | "beneath";
  /** How this layer arrived — read once, as it mounts. */
  arrival: Move | "none";
  children: ReactNode;
}) {
  const stack = useContext(StackContext) as Stack;
  const { width, progress } = stack;
  const ref = useRef<HTMLDivElement>(null);
  const x = useMotionValue(0);
  const opacity = useMotionValue(1);
  const reduced = useReducedMotion() === true;
  const [isPresent, safeToRemove] = usePresence();
  /** The place this page's `‹` names, if it has one — {@link useSwipeBack}. */
  const [parent, setParent] = useState<string | null>(null);
  // Read once: a layer's arrival is the move that mounted it, and one born beneath was placed by
  // the swipe rather than by a move.
  const [entry] = useState(arrival);
  const [bornBeneath] = useState(role === "beneath");

  // Beneath, the page follows the swipe: a little way left and dimmed at rest, home as it ends.
  const follow = useCallback(
    (p: number) => {
      if (!reduced) x.set((p - 1) * PAGE.parallax * width());
      opacity.set(PAGE.dim + (1 - PAGE.dim) * p);
    },
    [reduced, width, x, opacity],
  );
  useMotionValueEvent(progress, "change", (p) => {
    if (role === "beneath") follow(p);
  });

  useLayoutEffect(() => {
    if (bornBeneath) {
      follow(progress.get());
      return;
    }
    // Skipped animations (the suite) jump to the end, and the end is where a layer rests.
    if (entry === "none" || MotionGlobalConfig.skipAnimations === true) return;
    const w = width();
    if (entry === "forward" && !reduced) {
      x.set(w);
      void animate(x, 0, SPRING.surface);
    } else if (entry === "back" && !reduced) {
      x.set(-PAGE.parallax * w);
      opacity.set(PAGE.dim);
      void animate(x, 0, SPRING.surface);
      void animate(opacity, 1, SPRING.surface);
    } else {
      opacity.set(0);
      void animate(opacity, 1, PAGE.swap);
    }
  }, [bornBeneath, entry, follow, progress, reduced, width, x, opacity]);

  const leave = stack.leave;
  useEffect(() => {
    if (isPresent) return;
    // A page beneath that was never landed on is already where it ends. (A page a swipe took off
    // leaves as Back does, from where the swipe left it — off the glass, so there is nothing to see.)
    if (role === "beneath" || MotionGlobalConfig.skipAnimations === true) {
      safeToRemove();
      return;
    }
    const w = width();
    let going: { then: (onResolve: () => void) => unknown };
    if (leave === "forward" && !reduced) {
      void animate(x, -PAGE.parallax * w, SPRING.surface);
      going = animate(opacity, PAGE.dim, SPRING.surface);
    } else if (leave === "back" && !reduced) {
      going = animate(x, w, SPRING.surface);
    } else {
      going = animate(opacity, 0, PAGE.swap);
    }
    void going.then(safeToRemove);
  }, [isPresent, leave, role, reduced, safeToRemove, width, x, opacity]);

  // The swipe back: a finger moving right on a page that has somewhere to go back to.
  useDrag(
    ({
      first,
      last,
      movement: [mx],
      velocity: [vx],
      direction: [dx],
      event,
      cancel,
      memo,
      touches,
    }) => {
      let mine = memo === true;
      if (first) {
        mine =
          parent !== null &&
          mx > 0 &&
          touches === 1 &&
          // A move something under the finger already claimed (a zoomed picture panning) is its own.
          !event.defaultPrevented &&
          maySwipe(event.target, ref.current);
        if (!mine) {
          cancel();
          return false;
        }
        stack.begin(parent as string);
      }
      if (!mine) return false;
      const w = width();
      const travelled = Math.min(Math.max(mx, 0), w);
      x.set(travelled);
      progress.set(travelled / w);
      if (last) stack.end(travelled / w > PAGE.commit || (dx > 0 && vx > PAGE.flick), x);
      return true;
    },
    {
      target: ref,
      enabled: role === "page" && isPresent && parent !== null,
      axis: "x",
      threshold: SWIPE_SLOP_PX,
      pointer: { touch: true },
      // **No `filterTaps`.** It swallows, in the capture phase, every click whose gesture it did
      // not see begin as a tap — and with `touch` it sees no mouse at all, so every mouse click
      // inside (the web app below 1024px) was dropped. A browser already sends no click after a
      // touch that moved, and `threshold` keeps a tap out of the handler.
    },
  );

  const leaving = !isPresent;
  return (
    <SwipeBackContext.Provider value={role === "page" ? setParent : null}>
      <motion.div
        ref={ref}
        style={{ x, opacity, zIndex: leaving && leave === "back" ? 1 : undefined }}
        // Neither a page going nor the one a swipe uncovers is a page the reader can use: nothing
        // to press, and nothing in the accessibility tree beside the page that is.
        inert={leaving || role === "beneath"}
        aria-hidden={leaving || role === "beneath" ? true : undefined}
        // The shadow falls off the page's left edge — off the glass at rest, and the edge a page
        // sliding over another casts on it while it moves.
        className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-bg shadow-[-12px_0_32px_rgb(0_0_0/0.45)]"
      >
        {children}
      </motion.div>
    </SwipeBackContext.Provider>
  );
}

/**
 * Whether a finger that went down on `target` may swipe the page back: not in a box the reader
 * types into or slides, not on a range, and not in anything that scrolls sideways — there the move
 * is that box's own.
 */
function maySwipe(target: EventTarget | null, layer: HTMLElement | null): boolean {
  if (!(target instanceof Element) || layer === null) return false;
  if (target.closest("input, textarea, select, [contenteditable='true'], [data-no-swipe]") !== null)
    return false;
  for (let el: Element | null = target; el !== null && el !== layer; el = el.parentElement) {
    if (el.scrollWidth > el.clientWidth) {
      const overflow = getComputedStyle(el).overflowX;
      if (overflow === "auto" || overflow === "scroll") return false;
    }
  }
  return true;
}
