import { act, render, renderHook, screen } from "@testing-library/react";
import type { RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SECTION_ZOOMS, MAX_ZOOM, type ZoomSection } from "@/lib/cardZoom";
import { LAYER } from "@/lib/layers";
import { useAppStore } from "@/lib/store";
import { useCardZoomGesture } from "@/lib/useCardZoomGesture";
import { CardZoomIndicator, ZOOM_BADGE_INSET, ZOOM_QUIET_MS, anchorFor } from "./CardZoomIndicator";

/**
 * The clock is fake and **only `setTimeout` is faked** — `requestAnimationFrame` is left real,
 * so `motion` is never mid-anything these assertions can trip over. `CardStack.test.tsx` runs on
 * the same pair for the same reason. Nothing here reads an opacity or a transform: what is
 * asserted is whether the figure is in the document, which React commits synchronously and which
 * `MotionGlobalConfig.skipAnimations` (`src/test-setup.ts`) makes true of the exit too. The two
 * inline offsets asserted below are the `style` prop's own and not animated values, so they are
 * on the element from its first frame whatever the animation is doing.
 */
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // The store is a module singleton, so a zoom left behind by one test would be another one's
  // starting state — and `zoomPulse` in particular decides whether the badge is up at all.
  // `zoomSection` has to go back to null with them: it is what the badge reads to know which of
  // the four sizes it is about, and a leftover section would point the next test at the wrong one.
  useAppStore.setState({ cardZoom: DEFAULT_SECTION_ZOOMS, zoomPulse: 0, zoomSection: null });
});

/** Sections mounted by {@link mountSection}, which are outside any Testing Library container and
 *  so are not swept up by `cleanup`. */
const sections: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const el of sections.splice(0)) el.remove();
});

/**
 * A card section, registered the way a real one registers itself.
 *
 * `anchorFor` reads the map `useCardZoomGesture` fills as it attaches its listener, so a helper
 * that merely appended a `<div>` would be asking about a registry nothing had written to — and
 * would pass on the fallback, which is the one answer these tests must be able to tell apart
 * from a real measurement.
 *
 * **jsdom lays nothing out and answers every `getBoundingClientRect` with zeroes**, so the box
 * has to be stated. Every expectation below is derived from the same numbers through
 * {@link expectedAnchor} rather than typed out, so neither {@link ZOOM_BADGE_INSET} nor jsdom's
 * window width can drift away from what this file claims.
 */
function mountSection(section: ZoomSection, box: { top: number; right: number }) {
  const el = document.createElement("div");
  const rect: DOMRect = {
    x: 0,
    y: box.top,
    left: 0,
    top: box.top,
    right: box.right,
    bottom: box.top + 400,
    width: box.right,
    height: 400,
    toJSON: () => ({}),
  };
  el.getBoundingClientRect = () => rect;
  document.body.append(el);
  sections.push(el);
  const ref: RefObject<HTMLElement | null> = { current: el };
  renderHook(() => useCardZoomGesture(ref, section));
  return el;
}

/**
 * Where the badge belongs for a section with that box: {@link ZOOM_BADGE_INSET} in from its
 * top-right corner, in the viewport coordinates `position: fixed` measures in.
 *
 * The `right` sum is the one worth spelling out — a rect's `right` counts from the window's left
 * edge and CSS's `right` counts from its right, so the two are not the same number and a test
 * that asserted the rect's own value would pass only for a section flush against the window.
 */
const expectedAnchor = (box: { top: number; right: number }) => ({
  top: box.top + ZOOM_BADGE_INSET,
  right: window.innerWidth - box.right + ZOOM_BADGE_INSET,
});

/** The window's own corner — what {@link anchorFor} answers with no section to measure. */
const WINDOW_CORNER = { top: ZOOM_BADGE_INSET, right: ZOOM_BADGE_INSET };

/**
 * One ctrl+wheel notch over a section, through the store's own action.
 *
 * Not a hand-written `setState` triple: `zoomCards` is the single writer of all three fields, so
 * driving the badge through it means no test here can invent a
 * `cardZoom`/`zoomPulse`/`zoomSection` combination the app is incapable of producing — which is
 * exactly the combination the clamped case below turns on. The arguments are in the store's own
 * order, section first, so a call here reads as the call the wheel handler makes.
 */
const notch = async (section: ZoomSection = "search", direction: 1 | -1 = 1) => {
  await act(async () => {
    useAppStore.getState().zoomCards(section, direction);
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
    useAppStore.setState({
      cardZoom: { ...DEFAULT_SECTION_ZOOMS, search: 1.5 },
      zoomPulse: 40,
      zoomSection: "search",
    });

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
   * **The reason `zoomSection` is in the store.** Every section keeps its own size, and two of
   * them are on screen together in the deck editor — the docked search column beside the desk.
   * A badge that read any single number would answer the reader's gesture with the *other*
   * column's size half the time, and it would be a plausible percentage rather than an obvious
   * bug. The 150% left on `collection` here is what such a badge would draw.
   */
  it("shows the size of the section that was zoomed, and not another section's", async () => {
    useAppStore.setState({
      cardZoom: { ...DEFAULT_SECTION_ZOOMS, collection: 1.5, deckSearch: 0.5 },
    });
    render(<CardZoomIndicator />);

    await notch("deckSearch");

    // 0.5 → 0.67 is the ladder's first stop up from the bottom, rounded for display.
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.queryByText("150%")).toBeNull();
  });

  /**
   * **The case `zoomPulse` exists for.** A gesture at the top of the ladder changes no size, and
   * that is the moment the reader most needs an answer — they are rolling the wheel and nothing
   * is happening. A badge driven off `cardZoom` alone would be silent exactly there.
   */
  it("shows a gesture that changed nothing, because the size is clamped", async () => {
    useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, search: MAX_ZOOM } });
    render(<CardZoomIndicator />);

    await notch("search", 1);

    // The guard is what makes this a test about the clamp rather than about a coincidence: the
    // gesture really did leave the size where it was.
    expect(useAppStore.getState().cardZoom.search).toBe(MAX_ZOOM);
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

    await notch("search", -1);

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
   * and both fail **silently**. Without `pointer-events-none` the badge sits over the very
   * scroller that carries the ctrl+wheel listener — it is drawn inside that section now, so this
   * is a certainty rather than a likelihood — and swallows the notches that put it there;
   * without a rung off `LAYER` it is painted under a table's sticky header.
   */
  it("floats over the page without taking the pointer", async () => {
    render(<CardZoomIndicator />);
    await notch();

    expect(screen.getByText("110%")).toHaveClass("pointer-events-none", "fixed", LAYER.popup);
  });
});

describe("anchorFor", () => {
  /**
   * The measurement the whole per-section badge rests on. The section's box is stated by the
   * stub, and the expectation is built from those same numbers — the claim being made is about
   * the *arithmetic* (inset down from `top`, and CSS's `right` counted from the other edge of
   * the window than the rect's), not about any figure jsdom happens to invent.
   */
  it("answers a mounted section's top-right corner, inset", () => {
    const box = { top: 120, right: 900 };
    mountSection("collection", box);

    expect(anchorFor("collection")).toEqual(expectedAnchor(box));
    // …and is a real measurement rather than the fallback wearing its clothes. A registry that
    // never received the element would answer the window's corner here and every assertion
    // above about the section's own corner would still be checking the arithmetic of a constant.
    expect(anchorFor("collection")).not.toEqual(WINDOW_CORNER);
  });

  /** Before the first gesture of a session there is no section to be about. Not an error: the
   *  window's own corner is where the badge used to live, and it is still a true place to say a
   *  percentage. */
  it("falls back to the window's corner with no section", () => {
    expect(anchorFor(null)).toEqual(WINDOW_CORNER);
  });

  /**
   * The case that is not a bug either: a reader zooms the deck editor's desk, leaves for
   * Settings, and something puts the badge up while `deck` is unmounted. The registry has no
   * element, so there is no box — and a thrown exception or a hidden badge would both be worse
   * answers than the corner of the window.
   */
  it("falls back to the window's corner for a section that is not mounted", () => {
    mountSection("collection", { top: 120, right: 900 });

    expect(anchorFor("deck")).toEqual(WINDOW_CORNER);
  });
});

describe("the badge's corner", () => {
  /**
   * The two inline offsets, asserted because they are the whole of "over *that* section" and a
   * class sweep cannot see them: they are a measurement, so they cannot be Tailwind classes at
   * all (`layers.ts` has the paragraph about what Tailwind does with a class name it never saw).
   */
  it("is the zoomed section's, in inline top and right offsets", async () => {
    const box = { top: 64, right: 640 };
    mountSection("deckSearch", box);
    render(<CardZoomIndicator />);

    await notch("deckSearch");

    const { top, right } = expectedAnchor(box);
    expect(screen.getByText("110%")).toHaveStyle({ top: `${top}px`, right: `${right}px` });
  });

  /**
   * And it follows the reader across the deck editor, which is the surface this feature is
   * about: the docked search column and the desk are side by side, so a badge that stayed where
   * the previous gesture put it would be pointing at the column the reader had just stopped
   * zooming. Both sections start at 100% and both read "110%" after a notch — the figure is
   * deliberately not what distinguishes them here, the corner is.
   */
  it("moves to the section the next gesture lands in", async () => {
    const column = { top: 64, right: 400 };
    const desk = { top: 64, right: 1000 };
    mountSection("deckSearch", column);
    mountSection("deck", desk);
    render(<CardZoomIndicator />);

    await notch("deckSearch");
    expect(screen.getByText("110%")).toHaveStyle({ right: `${expectedAnchor(column).right}px` });

    await notch("deck");
    expect(screen.getByText("110%")).toHaveStyle({ right: `${expectedAnchor(desk).right}px` });
  });
});
