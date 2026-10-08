/**
 * A masonry over CSS Grid: one-pixel rows, and an item that spans its own measured height.
 *
 * **Lifted out of `views/StackView.tsx`, which has shipped this since 2026-08-15** and which
 * still holds the argument for it in full. The short version: a grid of `auto-fill` tracks whose
 * rows are one pixel each turns CSS Grid's ordinary row-major placement into a masonry, because
 * "the next free cell at or after the cursor" becomes "the foot of the shortest column that is
 * not in the way". A wrapping flex box cannot do it — a flex line is as tall as its tallest item,
 * which is the whole defect both surfaces exist to avoid.
 *
 * **The gutter is an argument and not a constant**, which is the only difference from the
 * original: the deck's stack view spaces its piles by 20px and the notes band spaces its cards by
 * 8, and one module that took a side would make one of them wrong.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * How many one-pixel rows a box of this height claims — its height, plus the one gutter under it.
 *
 * `Math.ceil` because a measured height is fractional and a span is an integer: rounding **up** is
 * the only safe direction, since a span a pixel short would let the box below start a pixel inside
 * this one. `Math.max(1, …)` because `grid-row: span 0` is invalid and would be dropped — and
 * because **jsdom measures every box as 0**, so a suite that never sees a layout still has to
 * produce a legal span.
 */
export function masonryRowSpan(height: number, gapY: number): number {
  return Math.max(1, Math.ceil(height) + gapY);
}

/**
 * A box's own height, measured, as a row span — `null` until it has been.
 *
 * **The measurement is of the item, never of the box the items are in.** How many columns fit is
 * CSS's answer (`repeat(auto-fill, …)`, which needs no number from us), and what an item measures
 * cannot be derived from it: a heading wraps or it does not, and only the browser knows.
 *
 * **There is no feedback loop, and `align-items: start` is what forbids one.** A grid item aligned
 * to the start of its area is sized by its content, so its height does not depend on the span it
 * is given; the span depends on the height and never the other way round. Stretch it — the
 * default — and this oscillates.
 *
 * The read is a `useLayoutEffect` on **every** render rather than a dependency list, so a span is
 * never a frame behind the thing that changed it. It runs before paint, so the first frame an item
 * is drawn in already has its right span. The `ResizeObserver` beside it is for the changes no
 * render of the host causes — a panel dragged narrower until a line wraps, a font arriving late.
 */
export function useMasonryRowSpan(gapY: number, enabled = true) {
  // The name has to end in `Ref` — `react-hooks/immutability` refuses a write to anything else a
  // hook returned.
  const elementRef = useRef<HTMLElement | null>(null);
  const [span, setSpan] = useState<number | null>(null);

  const read = useCallback(() => {
    const node = elementRef.current;
    if (!node || !enabled) return;
    // Setting the value it already holds is a bail-out in React, so the every-render read costs
    // one extra pass only when the box has actually changed height.
    setSpan(masonryRowSpan(node.getBoundingClientRect().height, gapY));
  }, [enabled, gapY]);

  useLayoutEffect(read);

  useEffect(() => {
    const node = elementRef.current;
    if (!node || !enabled) return;
    const observer = new ResizeObserver(read);
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, read]);

  return { elementRef, span };
}
