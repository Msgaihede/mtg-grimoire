import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_ZOOM } from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";

beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));
afterEach(() => document.body.replaceChildren());

/** The hook as a surface uses it: a real element in the document, held by a real ref object. */
function mountOn() {
  const el = document.createElement("div");
  document.body.append(el);
  const ref: RefObject<HTMLElement | null> = { current: el };
  const { unmount } = renderHook(() => useCardZoomGesture(ref));
  return { el, unmount };
}

/**
 * A real `WheelEvent`, dispatched at the element, and handed back so the test can read what the
 * handler did to it.
 *
 * `cancelable: true` is not decoration: jsdom leaves `defaultPrevented` false forever on an event
 * that was never cancelable, so without it the `preventDefault` assertion below passes and fails
 * for reasons that have nothing to do with this hook.
 */
function wheel(el: HTMLElement, deltaY: number, ctrlKey: boolean): WheelEvent {
  const e = new WheelEvent("wheel", { deltaY, ctrlKey, cancelable: true, bubbles: true });
  el.dispatchEvent(e);
  return e;
}

describe("useCardZoomGesture", () => {
  /**
   * Scrolling a hundred thousand rows is the primary use of these containers. A plain wheel has
   * to travel through this listener untouched — and, in particular, uncancelled.
   */
  it("leaves an ordinary wheel alone", () => {
    const { el } = mountOn();

    const e = wheel(el, -100, false);

    expect(useAppStore.getState().cardZoom).toBe(1);
    expect(useAppStore.getState().zoomPulse).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("zooms in on ctrl and a scroll up, out on a scroll down", () => {
    const { el } = mountOn();

    wheel(el, -100, true);
    expect(useAppStore.getState().cardZoom).toBe(1.1);

    wheel(el, 100, true);
    wheel(el, 100, true);
    expect(useAppStore.getState().cardZoom).toBe(0.9);
    expect(useAppStore.getState().zoomPulse).toBe(3);
  });

  /**
   * The assertion the whole hook exists for. Without a cancelled event WebView2 applies its own
   * ctrl+wheel page zoom on top of ours — the sidebar, the ribbon and every dialog scaling out
   * from under a reader who asked one grid of cards to get bigger. The same call is what stops a
   * trackpad pinch, which reaches the page as exactly this event with nobody touching ctrl.
   *
   * It is also why the listener is native and `{ passive: false }`: React registers `wheel`
   * passively at the root, where this call would be a no-op the browser only mentions in a
   * console line.
   */
  it("cancels the event so the window does not zoom as well", () => {
    const { el } = mountOn();

    expect(wheel(el, -100, true).defaultPrevented).toBe(true);
  });

  /** A gesture the ladder cannot answer is still a gesture — the HUD's timer keys off this. */
  it("pulses even when the zoom is already clamped", () => {
    useAppStore.setState({ cardZoom: MAX_ZOOM });
    const { el } = mountOn();

    wheel(el, -100, true);
    wheel(el, -100, true);

    expect(useAppStore.getState().cardZoom).toBe(MAX_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(2);
  });

  /** A container that outlives the hook must stop zooming when the hook is gone. */
  it("stops listening when the surface unmounts", () => {
    const { el, unmount } = mountOn();

    unmount();
    const e = wheel(el, -100, true);

    expect(useAppStore.getState().cardZoom).toBe(1);
    expect(useAppStore.getState().zoomPulse).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  /** No element yet — a ref that has not been attached is not an error, it is the first render. */
  it("does nothing with an empty ref", () => {
    const ref: RefObject<HTMLElement | null> = { current: null };

    expect(() => renderHook(() => useCardZoomGesture(ref)).unmount()).not.toThrow();
  });
});
