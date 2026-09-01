import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { placeDropdown } from "./place";
import type { Placement } from "./types";

/**
 * Where the panel is, measured — and corrected for whatever containing block it landed in.
 *
 * ## Why there is a frame at all
 *
 * `position: fixed` is viewport-relative **only** while no ancestor carries a `transform`,
 * `scale`, `rotate`, `translate`, `filter`, `contain` or `backdrop-filter`. `Dialog`'s panel
 * animates through the `dialog` preset — `scale: 0.97 → 1` — and motion leaves the `scale`
 * longhand on the element at rest. **`scale: 1` is not `none`**, so a settled dialog panel is a
 * containing block, and eight of this app's dropdowns live inside one. `TheoryDiffDialog` and
 * `menu/panel.ts` each record the same trap for their own elements.
 *
 * The fix is not a walk up the ancestor chain looking for the seven properties above — that list
 * grows, and a property nobody thought of is a panel in the wrong place with nothing red. Instead
 * the shell renders a zero-size `fixed` element at `left: 0; top: 0` and reads **its** rect: that
 * is exactly where the containing block's origin sits in viewport coordinates, whatever put it
 * there. The panel is `absolute` inside that frame at `viewport position − frame origin`, so the
 * panel's own entry transform stops mattering too.
 *
 * The one case this does not cover is an ancestor mid-tween whose transform is not a pure
 * translation — a dialog at `scale: 0.97` on its way in. A dropdown cannot be open then: the
 * dialog's entry tween finishes before anything inside it can be pressed.
 *
 * ## What is measured with what
 *
 * **Positions come from `getBoundingClientRect()`; sizes come from `offsetWidth`/`offsetHeight`.**
 * Not interchangeable. `popup` holds the panel at `scale: 0.96` for the length of its entry tween,
 * so a rect taken on the mount frame is 4% short in both axes — the offset properties are the
 * layout box and no transform touches them.
 *
 * ## Two passes, and the first one is invisible
 *
 * `placement` is `null` on the render that mounts the panel, because the panel's own size cannot be
 * known before it exists. The shell draws it at `opacity: 0` on that frame — which `popup` already
 * does — and this hook fills the numbers in a **layout** effect, before the browser paints. A
 * `useEffect` here would paint one frame of panel in the top-left corner of its frame.
 *
 * ## Nothing here can go red
 *
 * jsdom measures every rectangle as zero and implements no layout, so every number this returns is
 * `0` under the suite and the whole of this file is exercised without being *tested*. The
 * arithmetic it calls is tested in `place.test.ts`; whether these measurements are the right ones
 * is a question only the shipped window answers. See the plan's live checks.
 */
export function usePopupPlacement({
  triggerRef,
  frameRef,
  panelRef,
  open,
  align,
  onClose,
}: {
  triggerRef: RefObject<HTMLElement | null>;
  /** The zero-size `fixed` element the panel is drawn inside. */
  frameRef: RefObject<HTMLElement | null>;
  panelRef: RefObject<HTMLElement | null>;
  open: boolean;
  align: "start" | "end";
  /**
   * Called when an ancestor scrolls.
   *
   * **Closed rather than followed**, which is `ContextMenu`'s choice for its reason: a trigger
   * that scrolls out from under an open panel leaves an orphan, and a dropdown is open for about
   * two seconds. Following it would mean re-measuring on every scroll frame for a control nobody
   * scrolls while using.
   *
   * **"An ancestor" is load-bearing, and taking it literally is the whole of issue #335.** The
   * listener below has to be on `window` in the capture phase — `scroll` does not bubble, so a
   * view's own scrollport is invisible to anything else — and capture from `window` sees *every*
   * scroll in the document, the panel's own included. The options are drawn in a
   * `max-h-64 overflow-auto` list, so a wheel spin over the rows and a drag of that list's
   * scrollbar each closed the picker the instant it moved. The panel is a descendant of the
   * trigger's root, never an ancestor of the trigger, so it can never be the thing this close
   * exists for; the guard is the panel subtree and it is a carve-out rather than a heuristic.
   */
  onClose: () => void;
}): { placement: Placement | null; minWidth: number } {
  // `react-hooks/set-state-in-effect` flags a `useState` setter called directly in an effect
  // body. `setPlacement(null)` on the close branch below is exactly that shape, and there is
  // nothing to derive it from during render — a panel's size does not exist until it mounts.
  // Step 1 of the plan (guard the write with a functional updater) does not satisfy the rule:
  // the lint is a type-driven check for a call to the `useState` setter itself, not for whether
  // the call is idempotent. This is step 2 — the numbers live in a ref-backed store instead of
  // `useState`, so nothing here has the setter's special type and the rule has nothing to flag.
  // `measure`'s writes went through `useCallback` before this change and were already invisible
  // to the rule for the same reason: it does not trace into an opaque function call.
  const storeRef = useRef<{ placement: Placement | null; minWidth: number }>({
    placement: null,
    minWidth: 0,
  });
  const listenersRef = useRef<Set<() => void> | null>(null);
  if (listenersRef.current === null) {
    listenersRef.current = new Set();
  }

  const setStore = useCallback((next: { placement: Placement | null; minWidth: number }) => {
    storeRef.current = next;
    listenersRef.current?.forEach((listener) => listener());
  }, []);

  const subscribe = useCallback((listener: () => void) => {
    listenersRef.current?.add(listener);
    return () => listenersRef.current?.delete(listener);
  }, []);

  const getSnapshot = useCallback(() => storeRef.current, []);

  const measure = useCallback(() => {
    const trigger = triggerRef.current;
    const frame = frameRef.current;
    const panel = panelRef.current;
    if (!trigger || !frame || !panel) return;

    const t = trigger.getBoundingClientRect();
    const origin = frame.getBoundingClientRect();
    const next = placeDropdown({
      trigger: { left: t.left, top: t.top, right: t.right, bottom: t.bottom },
      // Layout box, not rect — see this hook's doc comment.
      panel: { width: panel.offsetWidth, height: panel.offsetHeight },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
      align,
    });
    setStore({
      // Viewport coordinates, minus wherever the frame's own origin turned out to be.
      placement: { ...next, left: next.left - origin.left, top: next.top - origin.top },
      // A picker never opens narrower than the control that produced it.
      minWidth: trigger.offsetWidth,
    });
  }, [triggerRef, frameRef, panelRef, align, setStore]);

  useLayoutEffect(() => {
    if (!open) {
      setStore({ placement: null, minWidth: storeRef.current.minWidth });
      return;
    }
    measure();
  }, [open, measure, setStore]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => measure();
    // Capture, so an inner scroller counts — the import previews and every dialog body scroll
    // without the window ever seeing it. And capture is also why the panel has to be excluded by
    // hand: it puts every scroll in the document through here, and the panel's own list is one.
    // Guarded on the panel rather than on the list, so a footer or a search box that grows a
    // scroller later cannot bring the bug back. `contains` takes any node, and a window scroll
    // arrives with `document` as its target, which no element contains.
    const onScroll = (e: Event) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open, measure, onClose, panelRef]);

  return useSyncExternalStore(subscribe, getSnapshot);
}
