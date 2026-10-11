import { useCallback, useState, type RefCallback } from "react";

/**
 * How wide one element is, kept current by a `ResizeObserver` — a callback ref to put on the box,
 * and its width in px.
 *
 * **`0` is _unmeasured_, and a caller must read it as its roomiest-safe default**, never as a box
 * of no width. It is what jsdom answers for ever (its observer never reports — `test-setup.ts`
 * installs a no-op), and what the first paint answers before a browser's observer has fired once.
 * `useDeskWidth` reads its own `0` the same way.
 *
 * **A callback ref rather than a `RefObject` and an effect, and both halves of that are the
 * point.** The state is set from the observer's callback and from nothing else, so there is no
 * `setState` in an effect body — `react-hooks/set-state-in-effect`, which goes red only at
 * `pnpm verify` — and no measurement taken on a stale frame. And a callback ref hears about the
 * element arriving and leaving, which a `RefObject` never tells anybody: a box drawn only after
 * data lands is observed the moment it is drawn, the trap `useDeskWidth`'s doc warns its callers
 * about and `DeckEditor` needed `[hasRow]` to escape. React 19 calls the function the ref returns
 * as its cleanup, which is what disconnects the observer.
 *
 * **The content box**, `contentRect.width` — the width the element's children are laid out in,
 * which is the number a caller choosing a layout for those children is asking about.
 *
 * **Not a container query, and the caller that wanted this is why.** `container-type: inline-size`
 * makes its box the containing block for every `fixed` descendant, so a dialog or an anchored layer
 * opened from inside it is laid out against that box rather than the window. Observing the box from
 * script answers the same question and contains nothing.
 */
export function useElementWidth<T extends HTMLElement>(): [RefCallback<T>, number] {
  const [width, setWidth] = useState(0);
  // Stable for the component's life, so React attaches it once rather than detaching and
  // re-attaching (and re-observing) on every render.
  const ref = useCallback((el: T | null) => {
    if (el === null) return;
    const observer = new ResizeObserver((entries) => {
      // The last entry is the newest size of the one element this observer watches.
      const entry = entries[entries.length - 1];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}
