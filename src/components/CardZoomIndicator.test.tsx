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
/** What a classic vertical scrollbar costs, and what the shipped window measured on the pass that
 *  found the bug {@link VIEWPORT_WIDTH} exists for: `innerWidth` 1280 against `clientWidth` 1265,
 *  2026-08-14, debug build. */
const SCROLLBAR = 15;

/**
 * The viewport a `fixed` badge is actually laid out against, stated for the whole file.
 *
 * **jsdom hard-returns 0 from every `clientWidth`** — `Element-impl.js`, no layout engine and no
 * special case for the document element — so left alone this file would anchor the badge against
 * a zero-width viewport and every expectation in it would be a negative number no browser could
 * produce. Stating a width is the same move {@link mountSection} makes for each section's rect:
 * this file fakes layout, and this is the last piece of layout it needs.
 *
 * **It is stated a scrollbar narrower than `window.innerWidth`, and that gap is load-bearing.**
 * `innerWidth` counts the scrollbar; the initial containing block a `fixed` element is laid out
 * against does not, and `anchorFor` must read the narrower one or the badge sits that far left of
 * the corner it is anchored to — which is exactly what the live pass caught. Keeping the two
 * numbers apart for the whole file makes every anchor assertion here *also* an assertion about
 * which width the component reads. The first version of this file used `window.innerWidth` in
 * {@link expectedAnchor}, which is to say it pinned the bug as the expected answer and passed.
 */
const VIEWPORT_WIDTH = window.innerWidth - SCROLLBAR;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // An own data property on the element, shadowing the prototype getter jsdom answers 0 from.
  // `configurable` is what lets the teardown below hand the real one back rather than leaving a
  // width behind for the next file that shares this jsdom.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: VIEWPORT_WIDTH,
    configurable: true,
  });
  // The store is a module singleton, so a zoom left behind by one test would be another one's
  // starting state — and `zoomPulse` in particular decides whether the badge is up at all.
  // `zoomSection` has to go back to null with them: it is what the badge reads to know which of
  // the four sizes it is about, and a leftover section would point the next test at the wrong one.
  //
  // A **copy** of `DEFAULT_SECTION_ZOOMS`, never the constant itself, for the reason `store.ts`
  // gives at its own initialiser: `Readonly<>` is a compile-time fence and nothing more, so any
  // in-place write to `state.cardZoom` would go straight through into the exported object and
  // hand every later file in this process a corrupted default. Harmless while `zoomCards` is the
  // only writer and spreads — and this is the reset every one of these files runs, so it is the
  // last place to spell the rule a second way.
  useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS }, zoomPulse: 0, zoomSection: null });
});

/** Sections mounted by {@link mountSection}, which are outside any Testing Library container and
 *  so are not swept up by `cleanup`. */
const sections: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(document.documentElement, "clientWidth");
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
 * **jsdom lays nothing out and answers every `getBoundingClientRect` with zeroes**, so the box has
 * to be stated — the same reason {@link VIEWPORT_WIDTH} states the viewport it sits in. Every
 * expectation below is derived from those numbers through {@link expectedAnchor} rather than typed
 * out, so neither the inset nor the viewport can drift away from what this file claims. Keep each
 * `right` below {@link VIEWPORT_WIDTH}: a section wider than the window it is in would put the
 * badge's own offset off the left of the corner and prove nothing.
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
 * top-right corner, in the coordinates `position: fixed` measures in.
 *
 * The `right` sum is the one worth spelling out — a rect's `right` counts from the left edge of
 * the viewport and CSS's `right` counts from its right, so the two are not the same number and a
 * test that asserted the rect's own value would pass only for a section flush against the window.
 *
 * The width is {@link VIEWPORT_WIDTH} and **not `window.innerWidth`**, which is the difference
 * between a helper that checks this arithmetic and one that pins a scrollbar-wide error into it.
 */
const expectedAnchor = (box: { top: number; right: number }) => ({
  top: box.top + ZOOM_BADGE_INSET,
  right: VIEWPORT_WIDTH - box.right + ZOOM_BADGE_INSET,
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
   * The classes, asserted because not one of them is visible to a behavioural claim jsdom can
   * settle and every one of them fails **silently**. Without `pointer-events-none` the badge sits
   * over the very scroller that carries the ctrl+wheel listener — it is drawn inside that section
   * now, so this is a certainty rather than a likelihood — and swallows the notches that put it
   * there; without a rung off `LAYER` it is painted under a table's sticky header.
   *
   * **`origin-top-right` is in that same category and is guarded here for the same reason.** The
   * badge is held by its `top` and `right` offsets and arrives from `popup`'s `scale: 0.96`, so a
   * pill scaled about its *middle* would travel on the way in — sliding up and in from outside the
   * corner it belongs to, which reads as an object flying in rather than as a figure appearing
   * where the reader is already looking. Dropping the class breaks nothing a test asserts, changes
   * nothing in the DOM, and costs two frames of animation nobody will screenshot; asserting the
   * string is the only thing between it and a silent deletion. Note it is the pill's own corner
   * rather than a wrapper's — the badge is one box now, so this class has to be on the same
   * element as the offsets, which is exactly what a single `toHaveClass` here says.
   */
  it("floats over the page without taking the pointer, and grows from its own corner", async () => {
    render(<CardZoomIndicator />);
    await notch();

    expect(screen.getByText("110%")).toHaveClass(
      "pointer-events-none",
      "fixed",
      "origin-top-right",
      LAYER.popup,
    );
  });
});

describe("anchorFor", () => {
  /**
   * The measurement the whole per-section badge rests on. The section's box is stated by the
   * stub, and the expectation is built from those same numbers — the claim being made is about
   * the *arithmetic* (inset down from `top`, and CSS's `right` counted from the other edge of
   * the viewport than the rect's), not about any figure jsdom happens to invent.
   *
   * It is a check on *which* width that subtraction starts from too, because {@link VIEWPORT_WIDTH}
   * keeps the two candidates a scrollbar apart for the whole file — but only implicitly, which is
   * why the test after it names the failure it is guarding against out loud.
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

  /**
   * **The scrollbar. A regression test for a bug no test in this repo could have found unaided,
   * and the stated viewport is the whole of what makes it possible.**
   *
   * `window.innerWidth` includes the classic vertical scrollbar; the initial containing block a
   * `fixed` element is positioned against excludes it. Measuring from the wider one drew the
   * badge a scrollbar-width left of its corner — found by driving the shipped window at
   * 1280×800, where the deck editor really does scroll: `innerWidth` 1280 against `clientWidth`
   * 1265, and a desk ending at 830 whose badge landed at 807 where 822 was wanted. The search
   * wall, on a page with no scrollbar, was exact, which is how it stayed hidden.
   *
   * **A test can only ask this question if it states a viewport**, because jsdom's own answer to
   * `clientWidth` is a hard-coded 0 — there being no layout — while `innerWidth` is a real width
   * off its configured viewport. A file measuring against `innerWidth` does not fail to cover
   * this line; it
   * pins the wrong answer, which is worse, and is what this file did before the live pass.
   * {@link VIEWPORT_WIDTH} is stated a scrollbar below `innerWidth` for that reason, and the
   * second assertion below names the bug's own answer so it cannot come back quietly.
   */
  it("measures from the initial containing block and not from the scrollbar-inclusive window", () => {
    const box = { top: 120, right: 900 };
    mountSection("collection", box);

    // The premise, asserted rather than assumed: the two widths this test discriminates between
    // really are apart, and by a scrollbar.
    expect(document.documentElement.clientWidth).toBe(window.innerWidth - SCROLLBAR);

    expect(anchorFor("collection").right).toBe(VIEWPORT_WIDTH - box.right + ZOOM_BADGE_INSET);
    expect(anchorFor("collection").right).not.toBe(
      window.innerWidth - box.right + ZOOM_BADGE_INSET,
    );
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
