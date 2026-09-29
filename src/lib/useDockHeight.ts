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
 *
 * Exported for `useScrollPerView`, which needs the same scroller for the same reason and is the
 * same directory — so this is one copy shared, not a third.
 */
export function nearestScroller(from: HTMLElement): HTMLElement | null {
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
 * `sticky` on the dock is the pinning and CSS does all of it. This is only the height.
 *
 * **`top` is that `sticky` box's own inset, in px** — `0` for a dock drawn `top-0`, which is every
 * caller that passes nothing, and for them the arithmetic is exactly what it was before the
 * parameter. A dock pinned lower than the scroller's edge can never sit higher than its inset, so
 * what comes off the scrollport is the larger of the inset and the row's own distance down it:
 * pinned at 66px in a 600px scrollport, the dock is 534px however far the row has scrolled past.
 * The deck editor is why it exists (issue #577): while its floating header bar is drawn over the
 * top of the page, the docked search column pins below the bar rather than under it. **A new inset
 * is measured in the commit that brings it**, because nothing else would report it — the bar
 * appearing moves the dock without resizing either observed box, and no scroll has to follow.
 *
 * `dock` is the box being sized. `anchor` is the row the dock sits in — the thing whose top edge
 * says how much of the page is above it. Scrolled past, that term gives way to `top` and the dock
 * is the whole scrollport below its inset; at rest it is the scrollport under whatever header is
 * still showing.
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
 *
 * **`top` rides the same guard rather than an effect of its own.** It is held on the wiring ref,
 * where the wired measurement reads it, and a render that brought a new inset and neither new box
 * re-measures on the spot — one pass, no rewire, and before paint, so the dock is never drawn one
 * frame at its old height below its new inset.
 */
export function useDockHeight(
  dock: RefObject<HTMLElement | null>,
  anchor: RefObject<HTMLElement | null>,
  top = 0,
): void {
  // What the effect below is currently wired to, and how to unwire it. `null` throughout is
  // "nothing is wired", which is the state before the first commit and after a scroller could
  // not be found — both of which are ordinary rather than a failure. `top` is the inset the last
  // measurement used, and `measure` re-runs that measurement now, for an inset that moved alone.
  const wiring = useRef<{
    dock: HTMLElement | null;
    anchor: HTMLElement | null;
    top: number;
    off: (() => void) | null;
    measure: (() => void) | null;
  }>({ dock: null, anchor: null, top, off: null, measure: null });

  useLayoutEffect(() => {
    const dockEl = dock.current;
    const anchorEl = anchor.current;
    const wired = wiring.current;
    if (dockEl === wired.dock && anchorEl === wired.anchor) {
      if (top !== wired.top) {
        wired.top = top;
        wired.measure?.();
      }
      return;
    }

    wired.off?.();
    wired.dock = dockEl;
    wired.anchor = anchorEl;
    wired.top = top;
    wired.off = null;
    wired.measure = null;
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
      // The dock sits at the row's top or at its own inset, whichever is lower — and **a sticky
      // inset is measured from the scroller's content edge, not its top edge**, so the scroller's
      // own `padding-top` is part of where a pinned dock stands. `AppShell`'s `main` is `p-5`:
      // measured 2026-09-27 (debug build, 1280×800, the deck editor), a dock pinned at `top: 66`
      // stood at 20 + 66 below the scroller's top while this sized it as though it stood at 66,
      // and its bottom 20px hung past the window. The same arithmetic put a `top: 0` dock's
      // bottom 20px past it too, on every page that docks a column in a padded `main`. A scroller
      // with no padding reads `0` here and is sized exactly as before, which is also what every
      // case in the suite reads.
      const edge = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
      setDockHeight(dockEl, Math.max(0, visible - Math.max(edge + wired.top, below)));
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

    // Now rather than on the next frame, and any frame already owed is dropped: this pass
    // answers everything it would have, so a burst stays one measurement per frame.
    wired.measure = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      size();
    };
    wired.off = () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      // The height this wiring wrote goes with it. A caller that stops handing a dock over — the
      // Tags page's rail in table view — lays that box out with flex again, and an inline height
      // left behind would pin it at a number the flex layout cannot override. A rewire onto the
      // same box writes a fresh one before paint, so nothing flashes.
      dockEl.style.height = "";
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
      wired.measure = null;
      wired.dock = null;
      wired.anchor = null;
    };
  }, []);
}
