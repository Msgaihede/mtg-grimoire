import { useLayoutEffect, useRef, type RefObject } from "react";
import { nearestScroller } from "./useDockHeight";

/**
 * Give each of a page's views a scroll position of its own, on a page whose views all scroll one
 * shared box.
 *
 * **Why this exists** (issue #567). The deck editor's four views are given no height and grow, so
 * the one thing that scrolls under every one of them is `AppShell`'s `main` — and a box that
 * outlives a view switch keeps its `scrollTop` across it. A reader two thousand pixels down a
 * Stacks desk who pressed `Grid` landed two thousand pixels down a wall laid out nothing like it,
 * at a place that meant nothing; coming back, Stacks was wherever the Grid had left the box. The
 * reader's words were that scrolling one view must not scroll another. So the position is kept
 * per view and handed back on return, and a view never visited opens at the top of the page,
 * which is where the editor itself opens.
 *
 * **The departing position is recorded by the caller, before the switch, and never read after
 * it.** By the time a layout effect sees the new key, the new view is in the DOM, and reading
 * `scrollTop` then answers a number the browser has already *clamped* to the new content's height
 * — a long desk switching to a short text list reads as the text list's bottom, not as where the
 * reader was. So this returns `park`, which the one control that changes the key calls first,
 * while the old view is still what the box holds. A scroll listener would have answered the same
 * question at the cost of a write per frame for as long as the reader scrolls; a view switch is
 * one press, and the press is where the fact is.
 *
 * **The restore is a layout effect**, so the new view is painted at its own position rather than
 * at the old view's for one frame and then jumped. It is skipped on the first render — the page
 * mounting on its first view is not a switch, and whatever the page arrived with is not this
 * hook's to overwrite.
 *
 * `anchor` is any element inside the scroller; the scroller is found from it, as
 * {@link nearestScroller} documents. **Under jsdom that walk finds nothing** (no stylesheet, so no
 * `overflow` on `main`) and both halves are a no-op — the suite proves the wiring against a box
 * with an inline `overflow-y`, and the shipped window proves the behaviour.
 */
export function useScrollPerView<K>(anchor: RefObject<HTMLElement | null>, view: K): () => void {
  const positions = useRef(new Map<K, number>());
  const shown = useRef(view);

  // A plain function rather than a `useCallback`: the React Compiler memoizes it, and refuses a
  // hand-written dependency list that names `anchor` where the body reads `anchor.current`.
  const park = () => {
    const el = anchor.current;
    const scroller = el ? nearestScroller(el) : null;
    if (scroller) positions.current.set(shown.current, scroller.scrollTop);
  };

  useLayoutEffect(() => {
    if (shown.current === view) return;
    shown.current = view;
    const el = anchor.current;
    const scroller = el ? nearestScroller(el) : null;
    if (scroller) scroller.scrollTop = positions.current.get(view) ?? 0;
  }, [anchor, view]);

  return park;
}
