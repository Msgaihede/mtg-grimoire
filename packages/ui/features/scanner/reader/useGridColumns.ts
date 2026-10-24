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
 *
 * **Implicit tracks are lengths too** — Chromium lists them with the explicit ones — which is why
 * {@link useGridColumns} reads this off an empty probe rather than off the grid itself.
 */
export function gridTrackCount(template: string): number {
  if (template.includes("(")) return 0;
  return template
    .replace(/\[[^\]]*\]/g, " ")
    .split(/\s+/)
    .filter((track) => track !== "" && track !== "none").length;
}

/**
 * How many columns a CSS grid's template lays out at its width right now — a callback ref to put
 * on an **empty probe grid** beside it, and the count, kept current by a `ResizeObserver`.
 *
 * For a tile that spans "as many columns as it has cells, never more than the grid has": an
 * `auto-fill` template decides the count from the width, and no CSS can cap a `span` at it — an
 * item spanning more tracks than exist makes implicit ones and pushes the grid sideways.
 *
 * **The probe, never the grid, and the grid would lock an oversized span in.** Chromium's resolved
 * `grid-template-columns` lists implicit tracks beside the explicit ones. So once the grid narrows
 * under a span — the window shrinks, the page's columns move — the span makes an implicit track,
 * the count read off the grid includes it, and `min(cells, count)` answers the same span again:
 * measured 2026-10-24 at 700 → 500px, a span of 4 over three explicit tracks read
 * `144px 144px 144px 17px`, and the tray scrolled sideways for good. A probe is an element with the
 * same template, the same column gap and the same content width that holds no items — so it has
 * no implicit tracks, and its count is the explicit count the browser is laying out. The caller
 * draws it (`aria-hidden`, `invisible`, no height) and keeps those three in step with the grid.
 *
 * **It settles rather than oscillates.** A narrower span makes the spanning tile taller, which can
 * bring a scrollbar in and narrow the probe further — fewer columns again, taller again — and a
 * wider one does the reverse; each change pushes the scrollbar the way the change already went, so
 * the count moves one way and stops.
 *
 * **`0` is _unmeasured_**, and the caller must read it as its safe default — for the tray's
 * waiting tile, the whole width. It is what the first paint answers, before the browser's observer
 * has fired once (it always fires on `observe` for a box with a width), what jsdom answers for
 * ever, and what the hook goes back to when the probe leaves — so a grid drawn again later starts
 * unmeasured rather than from the count of a width it no longer has.
 *
 * `useElementWidth`'s shape and for its reasons: a callback ref hears the element arrive and
 * leave, and the count is set from the observer's callback and the ref's cleanup, never from an
 * effect body. React 19 calls the function the ref returns as its cleanup.
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
    return () => {
      observer.disconnect();
      setColumns(0);
    };
  }, []);
  return [ref, columns];
}
