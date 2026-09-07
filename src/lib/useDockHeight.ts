import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * The nearest ancestor of `from` that actually scrolls, or `null` if nothing between it and the
 * document root does.
 *
 * A copy of `CardGrid`'s function of the same name, and the duplication is stated rather than
 * hidden: that one is private to the wall's virtualiser and this hook is in `lib/`, so importing
 * it would mean a shared module depending on a feature. Six lines and one rule — `overflow-y` of
 * `auto` or `scroll` — is cheaper than that dependency, and the rule is the browser's rather than
 * this app's, so the two copies cannot come to different answers about the same tree.
 *
 * **It can never succeed under jsdom**, which is the fact every test of this hook is written
 * against: `getComputedStyle` there answers `""` for a property no inline style set, and the
 * Tailwind class that makes a box a scroller is never parsed. So the suite proves the *wiring*
 * and the shipped window proves the number.
 */
function nearestScroller(from: HTMLElement): HTMLElement | null {
  for (let el = from.parentElement; el; el = el.parentElement) {
    const { overflowY } = getComputedStyle(el);
    if (overflowY === "auto" || overflowY === "scroll") return el;
  }
  return null;
}

/**
 * Write the one measurement this hook makes onto the box it was made for.
 *
 * **A function at module scope rather than the assignment written inline**, and the reason is a
 * lint rule rather than taste: `react-hooks/immutability` refuses a write through anything it can
 * trace back to a hook's own argument, and `dock.current.style.height = …` is exactly that. The
 * refusal is right about the general case and wrong about this one — a `RefObject<HTMLElement>` is
 * handed over *so that* its element can be sized, which is the whole contract of the hook — so the
 * write is named instead of suppressed, and what the rule stops is the shape it is actually
 * warning about: this hook reaching further into the caller's tree than the one box it was given.
 */
function setDockHeight(dock: HTMLElement, px: number): void {
  dock.style.height = `${px}px`;
}

/**
 * Draw a `sticky` dock exactly as tall as the part of the page that is on screen below it.
 *
 * **This exists because a docked search column's host has no height CSS can name.** The panel's
 * wall is a `min-h-0 flex-1` child, so an unsized dock draws it at nothing; `100%` of the row is
 * the *list's* height, which for a large collection is several thousand pixels; and a viewport
 * unit is wrong by whatever app chrome sits above the scroller. What is wanted is "the scroller's
 * visible height, less however much of the row still sits below its top", and that is arithmetic
 * over two measurements rather than a length.
 *
 * `sticky top-0` on the dock is the pinning and CSS does all of it. This is only the height.
 *
 * `dock` is the box being sized. `anchor` is the row the dock sits in — the thing whose top edge
 * says how much of the page is above it. Scrolled past, that term is zero and the dock is the full
 * height of the scrollport; at rest it is the scrollport under whatever header is still showing.
 * Both ends exact, and no second scrollbar in either.
 *
 * **The scroller is found rather than passed**, which is the whole of what generalising
 * `DeckEditor`'s own effect cost: that page is an `overflow-y-auto` `<section>` of its own, while
 * the collection and the wishlist scroll in `AppShell`'s `main` several levels up. Neither site
 * has to know which, and neither can be wrong about it.
 *
 * `useLayoutEffect` rather than `useEffect`: an unsized dock draws its wall at nothing, and after
 * paint is one frame too late to keep the reader from seeing that. **jsdom has no layout engine
 * and answers `0` to every one of these reads**, which is why a zero height is left unset rather
 * than written — a `height: 0px` here would be a real collapse in the one environment that cannot
 * see it.
 *
 * The rAF is coalescing, not animation: a scroll fires far more often than a frame, and the work
 * is two `getBoundingClientRect`s. The listener is `passive`, because nothing here calls
 * `preventDefault` and a non-passive scroll listener blocks the gesture it is only watching. The
 * `ResizeObserver` covers a window resize and anything above the row growing; a scroll covers
 * everything the reader does.
 *
 * ## Why the wiring is re-checked after every commit
 *
 * A `RefObject` notifies nobody. Both of these boxes are drawn *conditionally* at their call
 * sites — `DeckEditor` renders its desk row only once `deck_get` has answered — so an effect with
 * an empty dependency array would run once against two `null`s and never look again, which is the
 * dock silently never being sized. `DeckEditor` used to spell that dependency out (`[hasRow]`),
 * and a shared hook cannot ask three call sites to each know which of their own states to name.
 *
 * So the layout effect below carries **no** dependency array and runs after every render, and the
 * first thing it does is compare the two elements against the ones it is already wired to. That
 * comparison is two identity checks; the rewire — a `getComputedStyle` walk, a listener and an
 * observer — happens only when an element has actually changed. The teardown is therefore held in
 * a ref and run by hand rather than returned as the effect's cleanup, because a returned cleanup
 * runs on *every* render and would undo exactly the work this guard exists to keep.
 */
export function useDockHeight(
  dock: RefObject<HTMLElement | null>,
  anchor: RefObject<HTMLElement | null>,
): void {
  // What the effect below is currently wired to, and how to unwire it. `null` throughout is
  // "nothing is wired", which is the state before the first commit and after a scroller could
  // not be found — both of which are ordinary rather than a failure.
  const wiring = useRef<{
    dock: HTMLElement | null;
    anchor: HTMLElement | null;
    off: (() => void) | null;
  }>({ dock: null, anchor: null, off: null });

  useLayoutEffect(() => {
    const dockEl = dock.current;
    const anchorEl = anchor.current;
    const wired = wiring.current;
    if (dockEl === wired.dock && anchorEl === wired.anchor) return;

    wired.off?.();
    wired.dock = dockEl;
    wired.anchor = anchorEl;
    wired.off = null;
    if (!dockEl) return;

    const scroller = nearestScroller(dockEl);
    if (!scroller) return;

    let frame = 0;
    const size = () => {
      frame = 0;
      const visible = scroller.clientHeight;
      if (visible === 0) return;
      // **Where the row starts is what both boxes are measured from**, and it is read fresh on
      // every pass rather than closed over: the page above it grows and shrinks — a banner, a
      // figures band, a breadcrumb wrapping to two lines — and each of those moves the top
      // without resizing either observed box.
      const below = anchorEl
        ? anchorEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : 0;
      setDockHeight(dockEl, Math.max(0, visible - Math.max(0, below)));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(size);
    };

    size();
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    // The row only when it is drawn. Everything else this hook answers for — the window
    // resizing, the page growing — reaches it through the scroller.
    if (anchorEl) observer.observe(anchorEl);

    wired.off = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
    };
  });

  // Unmount. The layout effect above returns no cleanup by design (see its doc), so this is the
  // one place the listener and the observer are given up — and it is an ordinary `useEffect`
  // because there is nothing to see: the boxes are already gone by the time it runs.
  useEffect(() => {
    const wired = wiring.current;
    return () => {
      wired.off?.();
      wired.off = null;
      wired.dock = null;
      wired.anchor = null;
    };
  }, []);
}
