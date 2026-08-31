import { renderHook } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_SECTION_ZOOMS, MAX_ZOOM, ZOOM_SECTIONS, type ZoomSection } from "@/lib/cardZoom";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture, zoomSectionElement } from "@/lib/useCardZoomGesture";

/**
 * The element registry is module state, so a hook left mounted at the end of a test would still be
 * registered in the next one. Every mount goes on this list and the whole list is torn down after
 * each test, which is what keeps `zoomSectionElement` answering about the test that is running.
 */
const mounted: Array<() => void> = [];

beforeEach(() => useAppStore.setState(useAppStore.getInitialState()));
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
  document.body.replaceChildren();
});

/** The hook as a surface uses it: a real element in the document, held by a real ref object. */
function mountOn(section: ZoomSection) {
  const el = document.createElement("div");
  document.body.append(el);
  const ref: RefObject<HTMLElement | null> = { current: el };
  const { unmount } = renderHook(() => useCardZoomGesture(ref, section));
  // Unmounted once, whether the test asks for it or the afterEach sweeps it up — the tests below
  // do both, and a root only unmounts the first time.
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    unmount();
  };
  mounted.push(once);
  return { el, unmount: once };
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
    const { el } = mountOn("search");

    const e = wheel(el, -100, false);

    expect(useAppStore.getState().cardZoom.search).toBe(1);
    expect(useAppStore.getState().zoomPulse).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it("zooms in on ctrl and a scroll up, out on a scroll down", () => {
    const { el } = mountOn("search");

    wheel(el, -100, true);
    expect(useAppStore.getState().cardZoom.search).toBe(1.1);

    wheel(el, 100, true);
    wheel(el, 100, true);
    expect(useAppStore.getState().cardZoom.search).toBe(0.9);
    expect(useAppStore.getState().zoomPulse).toBe(3);
  });

  /** The section is the hook's argument, not a guess from where the event landed. */
  it("writes to the section it was given", () => {
    const { el } = mountOn("deck");

    wheel(el, -100, true);

    expect(useAppStore.getState().cardZoom.deck).toBe(1.1);
    expect(useAppStore.getState().cardZoom.search).toBe(1);
    expect(useAppStore.getState().zoomSection).toBe("deck");
  });

  /**
   * The deck editor as it is actually laid out: the docked card search column and the deck's own
   * desk, both mounted, both listening. A gesture over one of them used to move both, because both
   * listeners wrote the same number — that is the defect the section argument exists to fix, and
   * two live hooks is the only place it can be seen.
   */
  it("keeps two mounted sections out of each other's zoom", () => {
    const search = mountOn("deckSearch");
    const deck = mountOn("deck");

    wheel(search.el, -100, true);
    wheel(deck.el, 100, true);
    wheel(deck.el, 100, true);

    expect(useAppStore.getState().cardZoom.deckSearch).toBe(1.1);
    expect(useAppStore.getState().cardZoom.deck).toBe(0.8);
    expect(useAppStore.getState().cardZoom.search).toBe(1);
    expect(useAppStore.getState().cardZoom.collection).toBe(1);
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
    const { el } = mountOn("search");

    expect(wheel(el, -100, true).defaultPrevented).toBe(true);
  });

  /** A gesture the ladder cannot answer is still a gesture — the HUD's timer keys off this. */
  it("pulses even when the zoom is already clamped", () => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, search: MAX_ZOOM } });
    const { el } = mountOn("search");

    wheel(el, -100, true);
    wheel(el, -100, true);

    expect(useAppStore.getState().cardZoom.search).toBe(MAX_ZOOM);
    expect(useAppStore.getState().zoomPulse).toBe(2);
  });

  /** A container that outlives the hook must stop zooming when the hook is gone. */
  it("stops listening when the surface unmounts", () => {
    const { el, unmount } = mountOn("search");

    unmount();
    const e = wheel(el, -100, true);

    expect(useAppStore.getState().cardZoom.search).toBe(1);
    expect(useAppStore.getState().zoomPulse).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  /** No element yet — a ref that has not been attached is not an error, it is the first render. */
  it("does nothing with an empty ref", () => {
    const ref: RefObject<HTMLElement | null> = { current: null };

    expect(() => renderHook(() => useCardZoomGesture(ref, "search")).unmount()).not.toThrow();
  });
});

/**
 * The registry the zoom badge reads to find the box it draws itself over. It is module state
 * rather than store state — a live DOM node, written by the same effect that attaches the
 * listener — so what is worth testing is that its lifetime matches the hook's exactly.
 */
describe("zoomSectionElement", () => {
  it("answers nothing for a section that is not mounted", () => {
    for (const section of ZOOM_SECTIONS) expect(zoomSectionElement(section)).toBeNull();
  });

  it("answers the element the section's gesture is attached to", () => {
    const { el } = mountOn("collection");

    expect(zoomSectionElement("collection")).toBe(el);
    expect(zoomSectionElement("search")).toBeNull();
  });

  it("forgets the element when the surface unmounts", () => {
    const { unmount } = mountOn("deck");

    unmount();

    expect(zoomSectionElement("deck")).toBeNull();
  });

  /**
   * The reason the cleanup is conditional. React is free to mount a replacement *before* it
   * unmounts the one it replaced — a remount from a changed key does exactly this — so the order
   * of operations is set-new, then delete-old. An unconditional `delete` in the teardown would
   * drop the live registration and leave the badge falling back to the window's corner for a
   * section that is plainly on screen.
   */
  it("keeps a replacement registered when the old element unmounts after it", () => {
    const first = mountOn("search");
    const second = mountOn("search");

    first.unmount();

    expect(zoomSectionElement("search")).toBe(second.el);
  });
});
