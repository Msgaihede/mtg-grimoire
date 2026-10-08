import { useEffect, useState } from "react";
import { nearestScroller } from "./useDockHeight";

/** What the observer last said, and about which element — see the hook's doc for why both. */
interface Seen {
  el: HTMLElement | null;
  undocked: boolean;
}

/** Nothing has been seen yet, which reads as docked. Module-level so the seed is one object. */
const UNSEEN: Seen = { el: null, undocked: false };

/**
 * Whether `el` has scrolled up out of its nearest scrolling ancestor — i.e. its bottom edge is at
 * or above that scroller's top edge.
 *
 * **What this answers is a crossing, and a crossing is what an `IntersectionObserver` reports.**
 * The deck editor asks it about the last line of its own header (issue #577): once that line has
 * left the page, a compact bar pinned over the top of the scroller takes over from it. A scroll
 * listener would answer the same question by measuring on every scroll event and handing React a
 * value to compare, and the editor must not re-render per scroll event. The observer says nothing
 * until the element crosses the scroller's edge, so this hook's state moves only when the answer
 * flips — once going out, once coming back.
 *
 * **Above, not merely out of view.** An element *below* the scrollport is not intersecting
 * either, and it has not been scrolled past. So undocked is `!isIntersecting` **and** the
 * element's bottom at or above the root's top.
 *
 * **It takes the element rather than a `RefObject`**, because a ref notifies nobody and the
 * observer has to be rebuilt when the element changes. The caller holds it with a callback ref
 * into `useState`, which is what makes it something an effect can depend on.
 *
 * **The state carries the element it was measured for, and the answer is derived from it** —
 * `false` unless the element in state is the one being asked about. That is how a changed or
 * removed element reads as docked with no effect writing a reset: a synchronous `setState` in an
 * effect body is what `react-hooks/set-state-in-effect` refuses, and only `npm run verify` runs
 * that rule. The observer's callback is the one writer.
 *
 * `false` wherever the question cannot be asked: no element, no `IntersectionObserver`, or no
 * scrolling ancestor. **Under jsdom nothing is a scroller** unless a test gives a box an inline
 * `overflow-y`, and `packages/ui/test-setup.ts`'s observer stub never fires, so nothing in the suite
 * undocks unless a test installs an observer of its own. The element has to be laid out, too: a
 * `display: none` box measures as an empty rect at the viewport's origin, which is above any
 * scroller that starts below the title bar, and would read as scrolled past.
 */
export function useUndocked(el: HTMLElement | null): boolean {
  const [seen, setSeen] = useState<Seen>(UNSEEN);

  useEffect(() => {
    if (el === null || typeof IntersectionObserver === "undefined") return;
    const root = nearestScroller(el);
    if (root === null) return;

    // A notification already queued when this is torn down can still be delivered after
    // `disconnect()` — the spec clears the targets, not the queue — and it would describe an
    // observation that has ended. Without this, `el` leaving and coming back could show that stale
    // answer until the new observer's first one lands.
    let live = true;
    const observer = new IntersectionObserver(
      (entries) => {
        // The newest last: a batch can hold more than one crossing of the one target.
        const entry = entries[entries.length - 1];
        if (!live || entry === undefined) return;
        const undocked =
          !entry.isIntersecting && entry.boundingClientRect.bottom <= (entry.rootBounds?.top ?? 0);
        // The same object back when nothing moved, so React bails out rather than rendering.
        setSeen((prev) =>
          prev.el === el && prev.undocked === undocked ? prev : { el, undocked },
        );
      },
      { root, threshold: 0 },
    );
    observer.observe(el);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [el]);

  return seen.el === el ? seen.undocked : false;
}
