import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ZOOM, MAX_ZOOM } from "@/lib/cardZoom";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { CardZoomIndicator, ZOOM_QUIET_MS } from "./CardZoomIndicator";

/**
 * The clock is fake and **only `setTimeout` is faked** — `requestAnimationFrame` is left real,
 * so `motion` is never mid-anything these assertions can trip over. `CardStack.test.tsx` runs on
 * the same pair for the same reason. Nothing here reads an opacity or a transform: what is
 * asserted is whether the figure is in the document, which React commits synchronously and which
 * `MotionGlobalConfig.skipAnimations` (`src/test-setup.ts`) makes true of the exit too.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // The store is a module singleton, so a zoom left behind by one test would be another one's
  // starting state — and `zoomPulse` in particular decides whether the badge is up at all.
  useAppStore.setState({ cardZoom: DEFAULT_ZOOM, zoomPulse: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * One ctrl+wheel notch, through the store's own action.
 *
 * Not a hand-written `setState` pair: `zoomCards` is the single writer of both fields, so
 * driving the badge through it means no test here can invent a `cardZoom`/`zoomPulse`
 * combination the app is incapable of producing — which is exactly the combination the clamped
 * case below turns on.
 */
const notch = async (direction: 1 | -1 = 1) => {
  await act(async () => {
    useAppStore.getState().zoomCards(direction);
  });
};

/** Advance the fake clock and let React commit whatever that woke. */
const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

/** The figure, however it reads, or `null` when the badge is not up. */
const badge = () => screen.queryByText(/%$/);

describe("CardZoomIndicator", () => {
  /**
   * The app opens with `zoomPulse` at 0 and must open silently: a percentage flashing over the
   * wall on every launch would be the interface reporting something nobody did.
   */
  it("says nothing until the reader zooms", () => {
    render(<CardZoomIndicator />);

    expect(badge()).toBeNull();
    // …and has armed nothing, so there is no clock running behind the silence either.
    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * The same silence half an hour in. This is mounted beside views that come and go, so it can
   * remount at any pulse count — and one that reacted to the count it *found* would put a badge
   * up for a gesture made long ago.
   */
  it("says nothing on a mount into a session that has already been zoomed", () => {
    useAppStore.setState({ cardZoom: 1.5, zoomPulse: 40 });

    render(<CardZoomIndicator />);

    expect(badge()).toBeNull();
  });

  /** 110% is the first stop up from life size (`ZOOM_STEPS`), and the badge reads the size the
   *  store now holds rather than the one it was mounted with. */
  it("shows the new size on a gesture", async () => {
    render(<CardZoomIndicator />);

    await notch();

    expect(screen.getByText("110%")).toBeInTheDocument();
  });

  /**
   * **The case `zoomPulse` exists for.** A gesture at the top of the ladder changes no size, and
   * that is the moment the reader most needs an answer — they are rolling the wheel and nothing
   * is happening. A badge driven off `cardZoom` alone would be silent exactly there.
   */
  it("shows a gesture that changed nothing, because the size is clamped", async () => {
    useAppStore.setState({ cardZoom: MAX_ZOOM });
    render(<CardZoomIndicator />);

    await notch(1);

    // The guard is what makes this a test about the clamp rather than about a coincidence: the
    // gesture really did leave the size where it was.
    expect(useAppStore.getState().cardZoom).toBe(MAX_ZOOM);
    expect(screen.getByText("200%")).toBeInTheDocument();
  });

  /**
   * A wheel roll is a stream of notches a few tens of milliseconds apart, so the badge has to
   * live off the **last** one. Two notches nearly a quiet period apart, and the total elapsed
   * here is well past {@link ZOOM_QUIET_MS} — a clock that was not restarted would have taken
   * the figure down mid-gesture. 100 → 110 → 125 is the ladder's two stops up.
   */
  it("stays up while the notches keep coming", async () => {
    render(<CardZoomIndicator />);

    await notch();
    await tick(ZOOM_QUIET_MS - 100);
    await notch();
    await tick(ZOOM_QUIET_MS - 100);

    expect(screen.getByText("125%")).toBeInTheDocument();
  });

  it("goes away once the reader stops", async () => {
    render(<CardZoomIndicator />);
    await notch();

    await tick(ZOOM_QUIET_MS - 1);
    expect(badge()).toBeInTheDocument();

    await tick(1);
    expect(badge()).toBeNull();
  });

  /** …and comes back for the next gesture, rather than having spent its one appearance. */
  it("comes back for the gesture after that", async () => {
    render(<CardZoomIndicator />);
    await notch();
    await tick(ZOOM_QUIET_MS);

    await notch(-1);

    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  /** A timer outliving the tree it belongs to would set state on a component that is gone. */
  it("takes its clock with it when it unmounts", async () => {
    const { unmount } = render(<CardZoomIndicator />);
    await notch();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  /**
   * Transient feedback for a gesture only a mouse or a trackpad can make. A live region here
   * would announce "60%… 75%… 90%…" once per wheel notch — a burst of noise a screen-reader
   * reader cannot act on and did not ask for.
   */
  it("is decoration, not an announcement", async () => {
    render(<CardZoomIndicator />);
    await notch();

    expect(screen.getByText("110%").closest("[aria-hidden='true']")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  /**
   * Two classes, asserted because neither is visible to any behavioural claim jsdom can settle
   * and both fail **silently**. Without `pointer-events-none` the badge sits over the grid and
   * swallows the very ctrl+wheel events that put it there; without a rung off `LAYER` it is
   * painted under a table's sticky header.
   */
  it("floats over the page without taking the pointer", async () => {
    render(<CardZoomIndicator />);
    await notch();

    const layer = screen.getByText("110%").parentElement;
    expect(layer).toHaveClass("pointer-events-none", "fixed", LAYER.popup);
  });
});
