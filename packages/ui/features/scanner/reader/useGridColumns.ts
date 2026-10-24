import { useCallback, useState, type RefCallback } from "react";

/**
 * How many columns a grid's resolved `grid-template-columns` lays out, or `0` when it cannot say.
 *
 * **A browser resolves the template to one length per track** — `repeat(auto-fill, …)` comes back
 * from `getComputedStyle` as `149px 149px 149px 149px` — so the count is the number of lengths.
 * Line names (`[start]`) are not tracks and are dropped first. Anything still holding a function
 * (`repeat(`, `minmax(`) was never resolved, which is jsdom's answer for every grid: it echoes the
 * declared value back. That, `none` and the empty string are all `0`, *unmeasured*, rather than a
 * guess at a count.
 */
export function gridTrackCount(template: string): number {
  if (template.includes("(")) return 0;
  return template
    .replace(/\[[^\]]*\]/g, " ")
    .split(/\s+/)
    .filter((track) => track !== "" && track !== "none").length;
}

/**
 * How many columns a CSS grid is drawing right now — a callback ref to put on the grid, and the
 * count, kept current by a `ResizeObserver`.
 *
 * For a tile that spans "as many columns as it has cells, never more than the grid has": an
 * `auto-fill` template decides the count from the width, and no CSS can cap a `span` at it — an
 * item spanning more tracks than exist makes implicit ones and pushes the grid sideways. So the
 * count is read back from the grid itself, `getComputedStyle(grid).gridTemplateColumns`, each
 * time the grid's box changes size.
 *
 * **`0` is _unmeasured_**, and the caller must read it as its safe default — for the tray's
 * waiting tile, the whole width. It is what the first paint answers, before the browser's observer
 * has fired once (it always fires on `observe`), and what jsdom answers for ever.
 *
 * `useElementWidth`'s shape and for its reasons: a callback ref hears the element arrive and
 * leave, and the count is set from the observer's callback and nowhere else, so there is no
 * `setState` in an effect body. React 19 calls the function the ref returns as its cleanup.
 */
export function useGridColumns<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [columns, setColumns] = useState(0);
  // Stable for the component's life, so React attaches it once rather than re-observing on every
  // render.
  const ref = useCallback((el: T | null) => {
    if (el === null) return;
    const observer = new ResizeObserver(() => {
      setColumns(gridTrackCount(window.getComputedStyle(el).gridTemplateColumns));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, columns];
}
