import { useEffect, type RefObject } from "react";
import type { ZoomSection } from "./cardZoom";
import { useAppStore } from "./store";

/**
 * The element each section's gesture is currently attached to.
 *
 * Written by the effect below and read by the zoom badge, which draws itself over the top-right
 * corner of the section that was just zoomed and therefore needs that section's box. A module-level
 * map rather than a ref in the store because it is a DOM node, not state: nothing re-renders when
 * it changes, and putting a live element in zustand would make every zoom gesture a subscription
 * update carrying a pointer into the document.
 *
 * At most one element per section — each section is a distinct surface, and two `CardGrid`s
 * claiming `search` at once would be a bug in the call sites rather than a case to model here.
 */
const sectionElements = new Map<ZoomSection, HTMLElement>();

/**
 * The element a section's gesture is attached to, or `null` when that section is not mounted.
 *
 * `null` is an ordinary answer and not a failure: a section the reader has not opened has no box,
 * and so does a store driven directly by a Storybook story with no grid on screen. The badge falls
 * back to the window's own corner rather than refusing to draw.
 */
export function zoomSectionElement(section: ZoomSection): HTMLElement | null {
  return sectionElements.get(section) ?? null;
}

/**
 * Ctrl+wheel over a scroll container steps that section's card zoom. Hand it a ref to the element
 * that scrolls the tiles, and the section it is drawing.
 *
 * The `section` is required rather than defaulted: a wall of cards that has not decided which
 * section it belongs to must not silently share another wall's number, which is the defect this
 * argument exists to fix — the deck editor's docked search column used to resize the deck beside
 * it, because both wrote the same one.
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
 * (`getState()`), so the effect's dependencies are just the ref and the section — the listener is
 * attached once and outlives every zoom. Selecting `zoomCards` through `useAppStore(...)` would
 * re-run the effect, tearing the listener down and rebuilding it, on each event it handled.
 *
 * ## Why the cleanup checks before it deletes
 *
 * The effect registers its element in {@link sectionElements} so the badge can find the box it has
 * to draw itself over. The teardown deletes that entry **only if the map still holds this
 * element** — React is free to mount a replacement before it unmounts the one it replaced (a
 * remount from a changed key, a `StrictMode` double-invoke), so the order is set-new then
 * delete-old, and an unconditional `delete` would drop a registration that is live. The symptom
 * would be a badge that falls back to the window's corner for a section that is plainly on screen.
 */
export function useCardZoomGesture(ref: RefObject<HTMLElement | null>, section: ZoomSection): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      // Negative `deltaY` is a scroll *up*, which everything with a zoom reads as zooming in.
      useAppStore.getState().zoomCards(section, e.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    sectionElements.set(section, el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      // Only if it is still *ours* — see the doc above.
      if (sectionElements.get(section) === el) sectionElements.delete(section);
    };
  }, [ref, section]);
}
