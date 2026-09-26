import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HOLD_IN_VIEW_MS, holdInView } from "./holdInView";

/**
 * **jsdom lays nothing out**, so none of this can see a panel pushed below the fold — the live
 * re-check did (2026-09-26, 1920×1080, debug build): landed while the page was still too short to
 * scroll, the Sync panel above Needs review grew 437 → 824px and pushed its heading to y=976. What
 * can be pinned here is the mechanism: the observer is attached to what it has to watch, a resize
 * re-aligns, a reader's own gesture ends the hold for good, and so does the bounded window.
 *
 * `ResizeObserver` is a stand-in that records what it observes and lets a test fire it — the
 * setup's global one is a no-op, which would make every re-align case pass by never being asked.
 */
class FakeResizeObserver {
  static all: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.all.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  /** The browser noticing a size change. */
  fire() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

let target: HTMLElement;
let above: HTMLElement;
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  FakeResizeObserver.all = [];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  above = document.createElement("div");
  target = document.createElement("section");
  above.append(target);
  document.body.append(above);
  scroll = vi.fn();
  target.scrollIntoView = scroll as unknown as Element["scrollIntoView"];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  above.remove();
});

const observer = () => FakeResizeObserver.all[0];

describe("holdInView", () => {
  it("aligns the element to the top at once, and watches it and the box around it", () => {
    holdInView(target, [above]);

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(observer().observed).toEqual([target, above]);
  });

  /** The failure it exists for: the layout above grows after the first scroll, and the element is
   *  put back at the top each time it does. */
  it("aligns again every time the watched layout changes size", () => {
    holdInView(target, [above]);

    observer().fire();
    observer().fire();

    expect(scroll).toHaveBeenCalledTimes(3);
  });

  /** **Never fight the reader.** A wheel, a touch, a press or a key is the reader taking the page
   *  back — each ends the hold for good, so the next resize moves nothing. */
  it.each(["wheel", "touchstart", "pointerdown", "keydown"])(
    "lets go for good on the reader's first %s",
    (type) => {
      holdInView(target, [above]);

      window.dispatchEvent(new Event(type));
      observer().fire();

      expect(scroll).toHaveBeenCalledTimes(1);
      expect(observer().disconnected).toBe(true);
    },
  );

  /** A press anywhere in the page reaches the window too — the listener is on the capture phase,
   *  so a handler that stops the event on its way up cannot keep the hold alive. */
  it("hears a press inside the page even when the page stops it", () => {
    holdInView(target, [above]);
    target.addEventListener("pointerdown", (e) => e.stopPropagation());

    target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    observer().fire();

    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it("lets go by itself once the bounded window is over", () => {
    holdInView(target, [above]);

    vi.advanceTimersByTime(HOLD_IN_VIEW_MS - 1);
    observer().fire();
    expect(scroll).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1);
    observer().fire();
    expect(scroll).toHaveBeenCalledTimes(2);
    expect(observer().disconnected).toBe(true);
  });

  /** The page unmounting, or a second hand-off, lets go through the returned function — and a
   *  release twice over, or a reader's event after it, changes nothing. */
  it("lets go when its caller does, and only once", () => {
    const release = holdInView(target, [above]);

    release();
    release();
    window.dispatchEvent(new Event("keydown"));
    observer().fire();

    expect(scroll).toHaveBeenCalledTimes(1);
    expect(observer().disconnected).toBe(true);
  });
});
