import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IMAGE_STALL_LIMIT, imageStallDeadlineMs } from "@/lib/images";
import { CardImage } from "./CardImage";

const BOLT = "http://mtgimg.localhost/grid/aaa/0";
const RECALL = "http://mtgimg.localhost/grid/bbb/0";

/**
 * Give every `<img>` in the test a box, because jsdom gives none and the watchdog below is
 * deliberately gated on having one.
 *
 * jsdom reports `width: 0` for every element — measured — so a card frame there looks exactly
 * like a frame nobody can see, and {@link CardImage}'s watchdog leaves those alone on purpose.
 * That is what keeps the whole suite quiet: without the gate every mounted card in every test
 * would arm a timer that fires against a permanently `complete: false` image. A suite that wants
 * to watch the watchdog therefore has to say the frame is on screen, which is this.
 */
function onScreen(): void {
  vi.spyOn(HTMLImageElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 170,
    height: 238,
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 170,
    bottom: 238,
    toJSON: () => ({}),
  });
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
      onScreen();
      render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      const first = screen.getByAltText("Lightning Bolt");

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
      onScreen();
      render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      const first = screen.getByAltText("Lightning Bolt") as HTMLImageElement;
      pretendItLoaded(first);

      waitOutTheDeadline(1);

      expect(screen.getByAltText("Lightning Bolt")).toBe(first);
      expect(first.getAttribute("src")).toBe(BOLT);
    });

    /**
     * A frame with no box is a frame nobody is looking at — a card in a closed dialog, a
     * hidden tab, and every `<img>` in jsdom. There is nothing to heal, so nothing is asked
     * twice; this is what keeps the watchdog out of the way of the rest of the suite.
     */
    it("leaves a frame nobody can see alone", () => {
      vi.useFakeTimers();
      // No `onScreen()`: jsdom's own zero box is the case being pinned.
      render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      const first = screen.getByAltText("Lightning Bolt");

      waitOutTheDeadline(1);

      expect(screen.getByAltText("Lightning Bolt")).toBe(first);
      expect(first.getAttribute("src")).toBe(BOLT);
    });

    /**
     * Bounded, and the boundary hands the frame back to the caller's own failure handling —
     * `useImageRetry`'s `onError`, which is what draws "No image" and schedules the long
     * backoff. A picture that has not arrived after this many asks is not a lost message.
     */
    it("hands a picture that never arrives to the caller's error handling", () => {
      vi.useFakeTimers();
      onScreen();
      const onError = vi.fn();
      render(<CardImage src={BOLT} alt="Lightning Bolt" onError={onError} />);

      for (let attempt = 1; attempt <= IMAGE_STALL_LIMIT; attempt++) waitOutTheDeadline(attempt);
      expect(onError).not.toHaveBeenCalled();

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
      onScreen();
      const { rerender } = render(<CardImage src={BOLT} alt="Lightning Bolt" />);
      waitOutTheDeadline(1);
      expect(screen.getByAltText("Lightning Bolt").getAttribute("src")).toBe(`${BOLT}?stall=1`);

      rerender(<CardImage src={RECALL} alt="Ancestral Recall" />);

      expect(screen.getByAltText("Ancestral Recall").getAttribute("src")).toBe(RECALL);
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
      onScreen();
      render(<CardImage src={`${BOLT}?retry=1`} alt="Lightning Bolt" />);

      waitOutTheDeadline(1);

      expect(screen.getByAltText("Lightning Bolt").getAttribute("src")).toBe(
        `${BOLT}?retry=1&stall=1`,
      );
    });
  });
});
