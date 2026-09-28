import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_STALL_LIMIT, imageStallDeadlineMs } from "@/lib/images";
import { CardImage } from "./CardImage";

const BOLT = "http://mtgimg.localhost/grid/aaa/0";
const RECALL = "http://mtgimg.localhost/grid/bbb/0";

/**
 * **A viewport the test drives**: an `IntersectionObserver` that reports only when told to.
 *
 * {@link CardImage}'s watchdog arms its clock only while its frame is on screen, and the one way
 * it asks is an observer. jsdom has none, and the setup file's shim never reports — so a frame in
 * the suite is a frame nobody can see, and the watchdog leaves it alone on purpose: that is what
 * keeps the whole suite quiet, where every mounted card would otherwise arm a timer against a
 * picture jsdom never loads. A test that wants to watch the watchdog therefore says, per frame,
 * when it is on screen and when it is not. A real observer reports every frame once on `observe`;
 * this one reports nothing until {@link Viewport.enter}, which is the lazy frame below the fold.
 */
interface Viewport {
  /** The frame scrolled into view, with a box. */
  enter(el: Element): void;
  /** The frame scrolled out of view. */
  leave(el: Element): void;
  /** Whether the frame is being watched at all. */
  watched(el: Element): boolean;
}

function viewport(): Viewport {
  const watching = new Map<Element, IntersectionObserverCallback>();
  class DrivenObserver {
    readonly callback: IntersectionObserverCallback;
    constructor(callback: IntersectionObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      watching.set(target, this.callback);
    }
    unobserve(target: Element) {
      watching.delete(target);
    }
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", DrivenObserver);
  const report = (el: Element, onScreen: boolean) => {
    const entry = {
      target: el,
      isIntersecting: onScreen,
      boundingClientRect: { width: onScreen ? 170 : 0 },
    } as unknown as IntersectionObserverEntry;
    act(() => watching.get(el)?.([entry], {} as IntersectionObserver));
  };
  return {
    enter: (el) => report(el, true),
    leave: (el) => report(el, false),
    watched: (el) => watching.has(el),
  };
}

/**
 * Give every `<img>` a layout box, as a tile below the fold has one: jsdom reports `width: 0`
 * for everything. **A box is not being on screen**, and that difference is the bug the lazy
 * cases below pin — the watchdog used to take one for the other.
 */
function hasABox(): void {
  vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 170,
    height: 238,
    x: 0,
    y: 4_000,
    top: 4_000,
    left: 0,
    right: 170,
    bottom: 4_238,
    toJSON: () => ({}),
  });
}

/** The frame on screen: enter the viewport. The alt text names the only image rendered. */
function onScreen(view: Viewport, alt = "Lightning Bolt"): HTMLElement {
  const el = screen.getByAltText(alt);
  view.enter(el);
  return el;
}

/** What the browser reports for an image whose bytes arrived. jsdom never says this by itself. */
function pretendItLoaded(img: HTMLImageElement): void {
  Object.defineProperty(img, "complete", { value: true, configurable: true });
  Object.defineProperty(img, "naturalWidth", { value: 672, configurable: true });
}

/** Past the `attempt`-th deadline, dither included. */
function waitOutTheDeadline(attempt: number): void {
  act(() => void vi.advanceTimersByTime(imageStallDeadlineMs(attempt, 1) + 1));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CardImage", () => {
  /**
   * The whole reason this component exists. A browser keeps painting an `<img>`'s last
   * decoded frame until the new `src` decodes, and every card frame in this app belongs to
   * a *slot* rather than to a card — a tile in a virtualised wall, a deck's cover, the open
   * card in the pane. So the caption, the badge and the price flip the instant the data
   * lands while the picture stays on the card before it, which reads as the app showing the
   * wrong card's art.
   */
  it("draws a new element for a new card rather than repainting the one before it", () => {
    const { rerender } = render(<CardImage src={BOLT} alt="Lightning Bolt" />);
    const first = screen.getByAltText("Lightning Bolt");

    rerender(<CardImage src={RECALL} alt="Ancestral Recall" />);

    // A *different* element, not the same one wearing a new `src`: the old one is what was
    // holding the old card's pixels, so it has to leave with the card it belonged to.
    expect(screen.getByAltText("Ancestral Recall")).not.toBe(first);
    expect(first).not.toBeInTheDocument();
  });

  /**
   * The other half, and the one that would make this component a bug: the wall re-renders
   * on every scrolled row, and an element replaced on every render is an image re-requested
   * and re-decoded on every render — a flicker where there used to be a picture.
   */
  it("keeps the element it has for as long as the card is the same", () => {
    const { rerender } = render(<CardImage src={BOLT} alt="Lightning Bolt" />);
    const first = screen.getByAltText("Lightning Bolt");

    rerender(<CardImage src={BOLT} alt="Lightning Bolt" className="changed" />);

    expect(screen.getByAltText("Lightning Bolt")).toBe(first);
  });

  /**
   * Whatever the caller hangs on it — this stands in for a bare `<img>`, not beside one.
   *
   * **`draggable` is deliberately not the example any more.** It was, and the assertion went
   * vacuous the day this component started defaulting it off: the test would have passed with
   * the prop deleted from the call, which is a check that can no longer fail.
   */
  it("passes the caller's own attributes through to the image", () => {
    render(<CardImage src={BOLT} alt="Lightning Bolt" loading="lazy" className="size-full" />);

    const img = screen.getByAltText("Lightning Bolt");
    expect(img).toHaveAttribute("loading", "lazy");
    expect(img).toHaveClass("size-full");
  });

  /**
   * An `<img>` is draggable by default and the browser starts a drag from the *nearest*
   * draggable ancestor, so a frame inside a draggable tile steals the gesture and the tile's
   * own drag never begins. That is the bug a reader meets as "the picture will not drag but
   * the name will" — found live on the deck gallery's tiles, whose cover never passed the prop
   * two of its sibling frames did.
   */
  it("refuses to be dragged itself, so the tile around it can be", () => {
    render(<CardImage src={BOLT} alt="Lightning Bolt" />);

    expect(screen.getByAltText("Lightning Bolt")).toHaveAttribute("draggable", "false");
  });

  /**
   * A default rather than a rule: it is written *before* the spread, so a frame that really is
   * the drag source — nothing today — can still say so. The ordering is the whole difference
   * between the two, and it is invisible in the rendered output of every other test here.
   */
  it("lets a caller take the drag back", () => {
    render(<CardImage src={BOLT} alt="Lightning Bolt" draggable />);

    expect(screen.getByAltText("Lightning Bolt")).toHaveAttribute("draggable", "true");
  });

  /**
   * **The one attribute whose wrong value is invisible to every other check in this repo.**
   *
   * `decoding="async"` tells the browser it may present the frame before the picture is
   * decoded and paint it when the decode lands — and measured in the shipped window, that
   * second paint is sometimes never made: the `<img>` reports `complete` and a real
   * `naturalWidth` while the frame on screen stays the empty surface colour, for the rest of
   * the session. Nothing in the DOM says so, which is why this is asserted rather than left to
   * the eye: jsdom decodes nothing, the watchdog below is *by design* satisfied by
   * `complete && naturalWidth > 0`, and a screenshot taken through CDP forces a frame. Every
   * instrument this repo owns reads a blank tile as a drawn one.
   *
   * So the value is pinned here, at the one element every card picture in the app goes
   * through. Ten call sites used to pass `decoding="async"` by hand; deleting this line puts
   * the browser back on the path the bug lives on, and no other test in the suite would move.
   */
  it("decodes a card picture before the frame is shown, never after", () => {
    render(<CardImage src={BOLT} alt="Lightning Bolt" />);

    expect(screen.getByAltText("Lightning Bolt")).toHaveAttribute("decoding", "sync");
  });

  /** A default, like `draggable` above: written before the spread, so a caller can still choose. */
  it("lets a caller choose a different decode", () => {
    render(<CardImage src={BOLT} alt="Lightning Bolt" decoding="async" />);

    expect(screen.getByAltText("Lightning Bolt")).toHaveAttribute("decoding", "async");
  });

  /**
   * The watchdog — an image that never answers at all.
   *
   * `useImageRetry` heals a picture the protocol *refused*: a 502 or a 503 arrives as an
   * `error` event and the frame comes back on a backoff. It cannot heal a request that is
   * simply never answered, because nothing fires — no `load`, no `error`, no console line —
   * and the frame sits empty for the rest of the session. That state is reachable: on Windows
   * every `mtgimg:` response is handed to the UI thread with `PostMessageW`, and a post that
   * does not arrive means the request's deferral is never completed. A reader sees two black
   * cards in a wall where the other thirty-four drew.
   */
  describe("the watchdog", () => {
    it("asks again for a picture that never arrived and never failed", () => {
      vi.useFakeTimers();
      const view = viewport();
      render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      const first = onScreen(view);

      waitOutTheDeadline(1);

      // A new element, because that is what re-issues the request: the same element wearing
      // the same `src` asks the browser for nothing at all.
      const second = screen.getByAltText("Lightning Bolt");
      expect(second).not.toBe(first);
      // Marked, so nothing between the renderer and the protocol handler can answer the second
      // ask out of whatever it made of the first. The path is untouched, which is all the
      // protocol parses.
      expect(second.getAttribute("src")).toBe(`${BOLT}?stall=1`);
    });

    /**
     * The other half, and the one that would make this a bug rather than a fix: a wall of
     * forty tiles must not re-request forty pictures it already has because a `load` event
     * was missed. The element itself is asked, and the element is the honest answer.
     */
    it("leaves a picture alone when the bytes did arrive", () => {
      vi.useFakeTimers();
      const view = viewport();
      render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      const first = screen.getByAltText("Lightning Bolt") as HTMLImageElement;
      pretendItLoaded(first);
      view.enter(first);

      waitOutTheDeadline(1);

      expect(screen.getByAltText("Lightning Bolt")).toBe(first);
      expect(first.getAttribute("src")).toBe(BOLT);
      expect(vi.getTimerCount()).toBe(0);
    });

    /**
     * A frame nobody can see is left alone — a card in a closed dialog, a hidden tab, and every
     * `<img>` in jsdom, whose setup-file observer never reports. There is nothing to heal, so no
     * timer is even armed; this is what keeps the watchdog out of the way of the rest of the
     * suite.
     */
    it("leaves a frame nobody can see alone, with no timer armed", () => {
      vi.useFakeTimers();
      // No `viewport()`: the setup file's inert observer is the case being pinned.
      render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      const first = screen.getByAltText("Lightning Bolt");

      expect(vi.getTimerCount()).toBe(0);
      waitOutTheDeadline(1);

      expect(screen.getByAltText("Lightning Bolt")).toBe(first);
      expect(first.getAttribute("src")).toBe(BOLT);
    });

    /**
     * **A lazy frame below the fold is never waited on** (2026-09-28). The walls draw their
     * pictures `loading="lazy"`, so the browser asks for nothing until a frame nears the
     * viewport — and a clock started at mount read that silence as a dropped answer, asked twice
     * more and put "No image" on 1 691 of the All tokens wall's 4 357 frames for good. Watched and
     * never on screen, this frame arms nothing and fails nothing, however long it waits.
     */
    it("never arms for a lazy frame that never comes into view", () => {
      vi.useFakeTimers();
      const view = viewport();
      // Laid out, as a tile further down the wall is — and still never on screen.
      hasABox();
      const onError = vi.fn();
      render(<CardImage src={BOLT} alt="Lightning Bolt" loading="lazy" onError={onError} />);
      const first = screen.getByAltText("Lightning Bolt");
      expect(view.watched(first)).toBe(true);

      for (let attempt = 1; attempt <= IMAGE_STALL_LIMIT + 1; attempt++) {
        waitOutTheDeadline(attempt);
      }

      expect(vi.getTimerCount()).toBe(0);
      expect(screen.getByAltText("Lightning Bolt")).toBe(first);
      expect(first.getAttribute("src")).toBe(BOLT);
      expect(onError).not.toHaveBeenCalled();
    });

    /**
     * The other half: the same lazy frame, **scrolled into view long after it mounted**, is
     * watched from then — silent for the deadline, it is asked for again exactly as a frame on
     * screen at mount is.
     */
    it("arms when a lazy frame comes into view, and asks again after a silent deadline", () => {
      vi.useFakeTimers();
      const view = viewport();
      hasABox();
      render(<CardImage src={BOLT} alt="Lightning Bolt" loading="lazy" />);
      waitOutTheDeadline(3);
      const first = onScreen(view);
      expect(vi.getTimerCount()).toBe(1);

      waitOutTheDeadline(1);

      const second = screen.getByAltText("Lightning Bolt");
      expect(second).not.toBe(first);
      expect(second.getAttribute("src")).toBe(`${BOLT}?stall=1`);
    });

    /**
     * **Leaving the viewport stops the clock, and coming back starts a whole one.** A picture
     * scrolled past was never being waited for: 4 s on screen, then away, then back, is 4 s of
     * waiting and not the deadline — the frame is asked for only once it has been on screen and
     * silent for the full deadline in one stretch.
     */
    it("stops the clock when the frame leaves the viewport, and starts it over on return", () => {
      vi.useFakeTimers();
      const view = viewport();
      render(<CardImage src={BOLT} alt="Lightning Bolt" loading="lazy" />);
      const first = onScreen(view);
      act(() => void vi.advanceTimersByTime(imageStallDeadlineMs(1, 0) - 1_000));

      view.leave(first);
      expect(vi.getTimerCount()).toBe(0);
      waitOutTheDeadline(2);
      expect(screen.getByAltText("Lightning Bolt")).toBe(first);

      view.enter(first);
      act(() => void vi.advanceTimersByTime(imageStallDeadlineMs(1, 0) - 1_000));
      expect(screen.getByAltText("Lightning Bolt")).toBe(first);
      waitOutTheDeadline(1);
      expect(screen.getByAltText("Lightning Bolt").getAttribute("src")).toBe(`${BOLT}?stall=1`);
    });

    /**
     * A picture the protocol **refused** is the backoff's, not the watchdog's — and scrolling
     * its frame out and back must not make it the watchdog's again, or a refused picture would
     * be asked for on a clock beside the backoff's own.
     */
    it("stands down for a picture the protocol refused, however it scrolls", () => {
      vi.useFakeTimers();
      const view = viewport();
      const onError = vi.fn();
      render(<CardImage src={BOLT} alt="Lightning Bolt" onError={onError} />);
      const first = onScreen(view);

      act(() => void first.dispatchEvent(new Event("error")));
      expect(onError).toHaveBeenCalledTimes(1);
      view.leave(first);
      view.enter(first);

      expect(vi.getTimerCount()).toBe(0);
      waitOutTheDeadline(1);
      expect(screen.getByAltText("Lightning Bolt")).toBe(first);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    /**
     * Bounded, and the boundary hands the frame back to the caller's own failure handling —
     * `useImageRetry`'s `onError`, which is what draws "No image" and schedules the long
     * backoff. A picture that has not arrived after this many asks is not a lost message. Each
     * ask is a new element, watched afresh, and still on screen.
     */
    it("hands a picture that never arrives to the caller's error handling", () => {
      vi.useFakeTimers();
      const view = viewport();
      const onError = vi.fn();
      render(<CardImage src={BOLT} alt="Lightning Bolt" onError={onError} />);

      for (let attempt = 1; attempt <= IMAGE_STALL_LIMIT; attempt++) {
        onScreen(view);
        waitOutTheDeadline(attempt);
      }
      expect(onError).not.toHaveBeenCalled();

      onScreen(view);
      waitOutTheDeadline(IMAGE_STALL_LIMIT + 1);

      expect(onError).toHaveBeenCalledTimes(1);
    });

    /**
     * The count belongs to the picture, not to the frame. These frames belong to a *slot* —
     * a tile in a virtualised wall, a deck's cover — so a new card arrives without a remount,
     * and a slot that spent its asks on the card before it would give the new one none.
     */
    it("starts over when the slot is handed a different card", () => {
      vi.useFakeTimers();
      const view = viewport();
      const { rerender } = render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      onScreen(view);
      waitOutTheDeadline(1);
      expect(screen.getByAltText("Lightning Bolt").getAttribute("src")).toBe(`${BOLT}?stall=1`);

      rerender(<CardImage src={RECALL} alt="Ancestral Recall" />);

      expect(screen.getByAltText("Ancestral Recall").getAttribute("src")).toBe(RECALL);
      onScreen(view, "Ancestral Recall");
      waitOutTheDeadline(1);
      expect(screen.getByAltText("Ancestral Recall").getAttribute("src")).toBe(`${RECALL}?stall=1`);
    });

    /**
     * A `src` that already carries `useImageRetry`'s own marker keeps it: the two markers are
     * different questions — "the protocol refused this" and "the protocol never answered" —
     * and a URL with two query strings in it is not a URL.
     */
    it("adds its mark to a URL that already has one", () => {
      vi.useFakeTimers();
      const view = viewport();
      render(<CardImage src={`${BOLT}?retry=1`} alt="Lightning Bolt" />);
      onScreen(view);

      waitOutTheDeadline(1);

      expect(screen.getByAltText("Lightning Bolt").getAttribute("src")).toBe(
        `${BOLT}?retry=1&stall=1`,
      );
    });
  });
});
