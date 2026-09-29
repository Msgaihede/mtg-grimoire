import { useEffect, type RefObject } from "react";
import { nearestScroller } from "./useDockHeight";

/**
 * Hold `scroll-padding-top` on the nearest scroller of `target` open by `clearance` px, for as
 * long as `clearance` is not zero — the room a bar docked over the top of that scroller takes.
 *
 * **A caret the page scrolls to must not land under the bar** — WCAG 2.4.11, Focus Not Obscured.
 * The arrow keys walk a wall by focusing cards, and a focus scrolls its target only as far as the
 * scrollport's edge, which is exactly where a docked bar sits: the card would be reached and not
 * be seen. `scroll-padding-top` on the scroller moves that edge for every scroll-into-view at
 * once. It belongs to `AppShell`'s `main`, which none of this hook's callers draw, so it is set on
 * the node for as long as the bar is down and taken off when it goes or the caller unmounts — the
 * one style a caller writes onto an element it does not own.
 *
 * The clearance is measured from the scroller's content edge (a sticky inset always is) and
 * scroll padding from its top edge, so the scroller's own padding sits between the two — `main`'s
 * 20px. Without it the padding would be 41 while the docked bar's foot stands 53 below the top
 * edge, so a card scrolled to would land 12px under the bar.
 *
 * This was the deck editor's own effect (the undocked header bar, issue #577) until the filter
 * quick bar (spec 2026-09-29, §8) needed the same padding on the four card walls; both call it
 * now. **The scroller is found rather than passed**, like `useDockHeight`'s, so a caller does not
 * have to know it scrolls in `main`. `target` takes an element *or* a ref: the deck editor has a
 * ref to its own root, and `useFilterQuickBar` is handed the filter row as an element held in
 * state. A ref is read when the effect runs, which is after the commit that attached it — so the
 * effect re-runs on `clearance`, and a caller whose element can change under the same ref must
 * pass the element rather than the ref.
 */
export function useScrollPaddingTop(
  target: HTMLElement | null | RefObject<HTMLElement | null>,
  clearance: number,
): void {
  useEffect(() => {
    const el = target !== null && "current" in target ? target.current : target;
    const scroller = el ? nearestScroller(el) : null;
    if (!scroller || clearance === 0) return;
    const edge = parseFloat(getComputedStyle(scroller).paddingTop) || 0;
    scroller.style.scrollPaddingTop = `${edge + clearance}px`;
    return () => {
      scroller.style.scrollPaddingTop = "";
    };
  }, [target, clearance]);
}
