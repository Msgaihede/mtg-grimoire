import { useEffect, type RefObject } from "react";
import { useAppStore } from "./store";

/**
 * Ctrl+wheel over a scroll container steps the card zoom. Hand it a ref to the element that
 * scrolls the tiles.
 *
 * ## Why this is not an `onWheel` prop
 *
 * **React registers `wheel` as a `passive` listener on the root container**, and a passive
 * listener's `preventDefault()` is defined to do nothing — the browser logs an "Unable to
 * preventDefault inside passive event listener" line if you are watching a console, and
 * otherwise says nothing at all. The handler would run, the zoom would step, and WebView2 would
 * *also* apply its own ctrl+wheel page zoom on top: the whole window — sidebar, ribbon, dialogs —
 * scaling out from under a reader who asked one grid of cards to get bigger. That is the entire
 * reason this is a hook with a native `addEventListener` and `{ passive: false }` rather than
 * three characters of JSX, and it is the one detail here that cannot be recovered by reading the
 * component that calls it.
 *
 * The same `preventDefault` covers a second gesture that does not look like this one: a precision
 * trackpad's **pinch** is delivered to the page as wheel events with `ctrlKey` set and no key
 * held. Nothing distinguishes it from the real modifier, which is fine — pinch-to-zoom is what a
 * reader means by that gesture too — but it means the suppression is load-bearing on hardware
 * where nobody is touching ctrl.
 *
 * ## The two things it does not do
 *
 * A wheel without `ctrlKey` returns before anything else happens: ordinary scrolling through a
 * hundred thousand rows is the primary use of these containers, and a listener that so much as
 * measured every one of those events would be paying for zoom on the frames that need the budget
 * most.
 *
 * And it never subscribes to the store. The action is read imperatively inside the handler
 * (`getState()`), so the effect's dependencies are just the ref — the listener is attached once
 * and outlives every zoom. Selecting `zoomCards` through `useAppStore(...)` would re-run the
 * effect, tearing the listener down and rebuilding it, on each event it handled.
 */
export function useCardZoomGesture(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Negative `deltaY` is a scroll *up*, which everything with a zoom reads as zooming in.
      useAppStore.getState().zoomCards(e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ref]);
}
