import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { DEFAULT_SECTION_ZOOMS, DEFAULT_ZOOM, ZOOM_SECTIONS } from "@/lib/cardZoom";
import { ipc, type HomeLayout, type HomeWidget } from "@/lib/ipc";
import { useAppStore } from "@/lib/store";
import type { WidgetFit } from "./fit";
import { CUSTOMIZE_HINT, HOME_CANVAS_ATTR, HOME_WIDGET_ATTR, HomePage } from "./HomePage";
import { HOME_LAYOUT_KEY } from "./useHomeLayout";
import { DEFAULT_LAYOUT, widgetMeta, type WidgetKind } from "./widgets";

/**
 * The page, over the real hook, the real layout functions and the real `WidgetCard` — **with every
 * widget body stubbed**, so this file is about the page.
 *
 * What a body draws, what it reads and what it does with the box it is given is each body's own
 * suite's; nine of them fetching through `ipc` here would make every assertion below wait on nine
 * queries it is not about. The stub records what the page *handed* each body — the fit, `editing`,
 * `still` — which is the page's half of that contract and the half only this file can see.
 *
 * **The arrangement is seeded into the query cache rather than mocked into `ipc`**, `HOME_LAYOUT_KEY`
 * being exported for exactly this: replacing `ipc` with a bag of `vi.fn()`s erases the type mirror.
 * The write is a spy on the one real method this page calls.
 */

/** What the page handed each body on its latest render, by widget id. */
const handed = vi.hoisted(() => new Map<string, { fit: unknown; editing: boolean; still: boolean }>());

/**
 * One body and one settings stub for every kind. A component may return a string, which keeps these
 * free of JSX — a `vi.mock` factory is hoisted above the file's imports, `react/jsx-runtime`'s among
 * them.
 */
const stubs = vi.hoisted(() => ({
  body: ({ widget, fit, editing, still }: { widget: { id: string }; fit: unknown; editing: boolean; still: boolean }) => {
    handed.set(widget.id, { fit, editing, still });
    return `Body of ${widget.id}`;
  },
  settings: () => null,
}));

vi.mock("./widgets/SummaryWidget", () => ({
  SummaryWidget: stubs.body,
  SummaryWidgetSettings: stubs.settings,
}));
vi.mock("./widgets/DecksWidget", () => ({
  DecksWidget: stubs.body,
  DecksWidgetSettings: stubs.settings,
}));
vi.mock("./widgets/FoldersWidget", () => ({
  FoldersWidget: stubs.body,
  FoldersWidgetSettings: stubs.settings,
}));
vi.mock("./widgets/ActivityWidget", () => ({ ActivityWidget: stubs.body }));
vi.mock("./widgets/CollectionValueWidget", () => ({ CollectionValueWidget: stubs.body }));
vi.mock("./widgets/WishlistValueWidget", () => ({ WishlistValueWidget: stubs.body }));
vi.mock("./widgets/RecentCardsWidget", () => ({ RecentCardsWidget: stubs.body }));
vi.mock("./widgets/SetCompletionWidget", () => ({ SetCompletionWidget: stubs.body }));
vi.mock("./widgets/PriceMoversWidget", () => ({ PriceMoversWidget: stubs.body }));

/* ------------------------------------------------------------ the measured canvas ------- */

/**
 * The canvas's width. **jsdom lays nothing out**, so `clientWidth` answers `0` on every element —
 * which the page reads as *unmeasured* and draws as a stack. A getter on the prototype answering for
 * the canvas alone is how a test gives the page a grid; every other element keeps answering `0`,
 * which is what the catalogue's list reads as "use the nominal preview width".
 */
let canvasWidth = 1032;

/** Every observer the page constructs — `useDeskWidth.test.ts`'s recorder, one callback list. */
let observers: ResizeObserverCallback[] = [];

beforeEach(() => {
  handed.clear();
  canvasWidth = 1032;
  observers = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        observers.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute(HOME_CANVAS_ATTR) ? canvasWidth : 0;
    },
  });
  write = spyOnWrite();
  // A **copy** of `DEFAULT_SECTION_ZOOMS`, never the constant itself — `store.ts` says why: a case
  // that wrote through it would hand every later suite a dashboard somebody else had zoomed.
  useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS }, zoomPulse: 0, zoomSection: null });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  // An own property over jsdom's `Element.prototype` getter; deleting it puts back the `0` every
  // other suite assumes.
  delete (HTMLElement.prototype as unknown as { clientWidth?: number }).clientWidth;
});

/** The window narrowed or widened: a new width, and every observer told. */
function resizeCanvas(width: number): void {
  canvasWidth = width;
  act(() => {
    for (const callback of observers) callback([], {} as ResizeObserver);
  });
}

/* --------------------------------------------------------------------- fixtures ------- */

function spyOnWrite() {
  return vi.spyOn(ipc, "setHomeLayout").mockResolvedValue(undefined);
}
let write: ReturnType<typeof spyOnWrite>;

/** One placed entry. No config unless a test says otherwise. */
function widget(over: Partial<HomeWidget> & { id: string; kind: string }): HomeWidget {
  return { x: 0, y: 0, w: 2, h: 2, config: null, ...over };
}

function layoutOf(...widgets: HomeWidget[]): HomeLayout {
  return { version: 2, widgets };
}

/**
 * Two widgets of kinds this build has never heard of, side by side.
 *
 * **Most of what this page does has nothing to do with which kind a card is**, and an unknown kind's
 * bounds (`UNKNOWN_BOUNDS`, one cell to eight) are loose enough that no clamp interferes with the
 * gesture under test. Its body is the page's own placeholder rather than a stub.
 */
const A = widget({ id: "a", kind: "future-a", x: 0, y: 0 });
const B = widget({ id: "b", kind: "future-b", x: 2, y: 0 });

const titleOf = (kind: string) => `Unknown widget (${kind})`;

let client: QueryClient;

/** The page, with one arrangement already in the cache and the canvas at `width`. */
function mount(layout: HomeLayout, width = 1032) {
  canvasWidth = width;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(HOME_LAYOUT_KEY, layout);
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <HomePage />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function stored(): HomeLayout | undefined {
  return client.getQueryData<HomeLayout>(HOME_LAYOUT_KEY);
}

function storedWidget(id: string): HomeWidget | undefined {
  return stored()?.widgets.find((entry) => entry.id === id);
}

function boxFor(container: HTMLElement, id: string): HTMLElement {
  const box = container.querySelector<HTMLElement>(`[${HOME_WIDGET_ATTR}="${id}"]`);
  if (box === null) throw new Error(`no box for widget ${id}`);
  return box;
}

async function customize(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole("button", { name: "Customize" }));
}

/* ------------------------------------------------------------------------ tests ------- */

describe("HomePage", () => {
  it("draws one region per widget, named by its title", () => {
    mount({ ...DEFAULT_LAYOUT, widgets: DEFAULT_LAYOUT.widgets.map((entry) => ({ ...entry })) });

    // By name rather than by position: a widget's place is the one thing the reader is free to
    // change, so it is the one thing nothing may address it by.
    for (const entry of DEFAULT_LAYOUT.widgets) {
      expect(
        screen.getByRole("region", { name: widgetMeta(entry.kind as WidgetKind).label }),
      ).toBeInTheDocument();
    }
    expect(screen.getAllByRole("region")).toHaveLength(DEFAULT_LAYOUT.widgets.length);
  });

  it("places each box on its own cells and hands its body the footprint in pixels", () => {
    const { container } = mount(layoutOf(widget({ id: "decks", kind: "decks", x: 3, y: 2, w: 3, h: 3 })));

    // 1032px at `TARGET_CELL` is nine columns of 104px — the app's narrow rung.
    const box = boxFor(container, "decks");
    expect(box.style.gridColumn).toBe("4 / span 3");
    expect(box.style.gridRow).toBe("3 / span 3");
    // No z-index at rest, so a card's own popover is never capped by the box around it.
    expect(box.style.zIndex).toBe("");
    const fit = handed.get("decks")?.fit as WidgetFit;
    expect(fit.widthPx).toBe(3 * 104 + 2 * 12);
    expect(fit.heightPx).toBe(3 * 104 + 2 * 12);
  });

  /**
   * **The page draws the arrangement brought inside the grid it has, and writes nothing for it.**
   *
   * A stored arrangement outlives the window it was made in. A reader who narrows the window for a
   * moment and widens it again must get their page back exactly — which only holds if a measurement
   * never reaches the document.
   */
  it("pulls a widget inside a narrower grid on screen without rewriting the stored arrangement", () => {
    const { container } = mount(layoutOf(widget({ id: "a", kind: "future-a", x: 10, w: 2 })), 1400);
    // 1400px is twelve columns, so x: 10 fits as stored.
    expect(boxFor(container, "a").style.gridColumn).toBe("11 / span 2");

    resizeCanvas(1032); // nine columns

    expect(boxFor(container, "a").style.gridColumn).toBe("8 / span 2");
    expect(storedWidget("a")?.x).toBe(10);
    expect(write).not.toHaveBeenCalled();

    resizeCanvas(1400);
    expect(boxFor(container, "a").style.gridColumn).toBe("11 / span 2");
  });

  it("reveals the hint, Add widget and Reset on Customize, and says Done while it is on", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A, widget({ id: "summary", kind: "summary", x: 2, w: 4 })));

    expect(handed.get("summary")?.editing).toBe(false);
    expect(screen.queryByText(CUSTOMIZE_HINT)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add widget" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.queryByRole("button", { name: `Move ${titleOf("future-a")}` })).toBeNull();

    await customize(user);

    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(CUSTOMIZE_HINT)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add widget" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: `Move ${titleOf("future-a")}` })).toBeInTheDocument();
    // The body is told, so it can stop anything it would otherwise start.
    expect(handed.get("summary")?.editing).toBe(true);

    await user.click(done);

    expect(screen.getByRole("button", { name: "Customize" })).toHaveAttribute("aria-pressed", "false");
    expect(handed.get("summary")?.editing).toBe(false);
    expect(screen.queryByText(CUSTOMIZE_HINT)).toBeNull();
    expect(screen.queryByRole("button", { name: "Add widget" })).toBeNull();
  });

  it("adds a widget from the catalogue at its own footprint, in the first free cell", async () => {
    const user = userEvent.setup();
    mount(layoutOf(widget({ id: "summary", kind: "summary", x: 0, y: 0, w: 4, h: 2 })));

    await customize(user);
    await user.click(screen.getByRole("button", { name: "Add widget" }));

    const dialog = await screen.findByRole("dialog", { name: "Widget catalogue" });
    // Each entry says whether that kind is already on the page.
    const status = (label: string) =>
      within(dialog).getByRole("heading", { name: label }).closest("li");
    expect(within(status("Summary")!).getByText("On the page")).toBeInTheDocument();
    expect(within(status("Activity")!).getByText("Not on the page")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Add Activity" }));

    // Activity arrives at 3×3; the first free corner reading rows left to right is beside Summary.
    await waitFor(() => {
      expect(storedWidget("activity")).toEqual(
        expect.objectContaining({ kind: "activity", x: 4, y: 0, w: 3, h: 3, config: null }),
      );
    });
    // Written once, through `toStored` — every widget carries the span an older build reads.
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][0].widgets).toEqual([
      expect.objectContaining({ id: "summary", span: 1 }),
      expect.objectContaining({ id: "activity", span: 1 }),
    ]);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The caret goes back to the control that opened the catalogue.
    expect(screen.getByRole("button", { name: "Add widget" })).toHaveFocus();
  });

  /**
   * **A preview is the real body, told it is still.** Still is the body's promise to write nothing
   * and open nothing, and the preview box is out of the accessibility tree — so nine pictures of
   * widgets are not nine more regions with nine sets of controls.
   */
  it("draws each catalogue preview as a still body outside the accessibility tree", async () => {
    const user = userEvent.setup();
    mount(layoutOf());

    await user.click(screen.getByRole("button", { name: "Add widget" }));
    const dialog = await screen.findByRole("dialog", { name: "Widget catalogue" });

    expect(within(dialog).getByText("Body of preview-priceMovers")).toBeInTheDocument();
    expect(handed.get("preview-priceMovers")).toEqual(
      expect.objectContaining({ still: true, editing: false }),
    );
    expect(within(dialog).queryAllByRole("region")).toHaveLength(0);
    // At the kind's own default footprint, whatever the page's grid is.
    const fit = handed.get("preview-summary")?.fit as WidgetFit;
    expect([fit.w, fit.h]).toEqual([4, 2]);
    expect(fit.heightPx).toBeLessThanOrEqual(212);
  });

  it("puts the seeded arrangement back on Reset", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A));

    await customize(user);
    await user.click(screen.getByRole("button", { name: "Reset" }));

    await waitFor(() => {
      expect(stored()).toEqual(DEFAULT_LAYOUT);
    });
  });

  it("moves a widget one cell with the grip's arrow keys, and refuses a cell that is taken", async () => {
    const user = userEvent.setup();
    const { container } = mount(layoutOf(A, B));
    await customize(user);

    // Focused rather than clicked: a press on the grip is a press on the card, which starts a drag.
    screen.getByRole("button", { name: `Move ${titleOf("future-a")}` }).focus();
    await user.keyboard("{ArrowRight}");

    // One step right puts A's second column on B's first — refused, and nothing written.
    expect(boxFor(container, "a").style.gridColumn).toBe("1 / span 2");
    expect(write).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}");

    await waitFor(() => expect(storedWidget("a")).toEqual(expect.objectContaining({ x: 0, y: 1 })));
    expect(write).toHaveBeenCalledTimes(1);
    expect(boxFor(container, "a").style.gridRow).toBe("2 / span 2");
  });

  it("drops a dragged widget on free cells and refuses a drop on a taken one", async () => {
    const user = userEvent.setup();
    const { container } = mount(layoutOf(A, B));
    await customize(user);

    const card = screen.getByRole("region", { name: titleOf("future-a") });
    // A cell is 104px and a gap 12px, so one cell of travel is 116px.
    const drag = (to: { x: number; y: number }) => {
      fireEvent(card, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 50, clientY: 50 }));
      fireEvent(window, new MouseEvent("pointermove", { clientX: 50 + to.x * 116, clientY: 50 + to.y * 116 }));
    };
    const ghost = () =>
      container.querySelector<HTMLElement>('[aria-hidden="true"].rounded-lg.border-2');

    drag({ x: 2, y: 0 });
    // Onto B: the ghost says no before the pointer is let go, and the card follows the pointer.
    expect(ghost()?.classList.contains("border-destructive")).toBe(true);
    expect(boxFor(container, "a").style.transform).toBe("translate(232px, 0px)");
    fireEvent(window, new MouseEvent("pointerup"));
    expect(ghost()).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(boxFor(container, "a").style.transform).toBe("");

    drag({ x: 1, y: 2 });
    expect(ghost()?.classList.contains("border-accent")).toBe(true);
    fireEvent(window, new MouseEvent("pointerup"));

    await waitFor(() => expect(storedWidget("a")).toEqual(expect.objectContaining({ x: 1, y: 2 })));
    expect(write).toHaveBeenCalledTimes(1);

    // The listeners went with the release: a stray move afterwards draws no ghost.
    fireEvent(window, new MouseEvent("pointermove", { clientX: 400, clientY: 400 }));
    expect(ghost()).toBeNull();
  });

  it("resizes from the corner onto free cells", async () => {
    const user = userEvent.setup();
    mount(layoutOf(A, B));
    await customize(user);

    const corner = screen.getByRole("button", { name: `Resize ${titleOf("future-a")}` });
    fireEvent(corner, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
    fireEvent(window, new MouseEvent("pointermove", { clientX: 0, clientY: 116 }));
    fireEvent(window, new MouseEvent("pointerup"));

    await waitFor(() => expect(storedWidget("a")).toEqual(expect.objectContaining({ w: 2, h: 3 })));
  });

  /**
   * **Below a readable cell the page stacks**: one card per row, in reading order, at the canvas's
   * width — and with no grid to drop on, nothing on it offers a drag.
   */
  it("stacks the widgets in reading order on a canvas too narrow for the grid", async () => {
    const user = userEvent.setup();
    const { container } = mount(
      layoutOf(widget({ id: "late", kind: "future-a", x: 0, y: 2 }), widget({ id: "right", kind: "future-b", x: 4, y: 0 }), widget({ id: "left", kind: "future-c", x: 0, y: 0 })),
      480,
    );

    const order = [...container.querySelectorAll(`[${HOME_WIDGET_ATTR}]`)].map((box) =>
      box.getAttribute(HOME_WIDGET_ATTR),
    );
    expect(order).toEqual(["left", "right", "late"]);
    expect(boxFor(container, "left").style.gridColumn).toBe("");

    await customize(user);
    expect(screen.queryByRole("button", { name: `Move ${titleOf("future-c")}` })).toBeNull();
    expect(screen.queryByRole("button", { name: `Resize ${titleOf("future-c")}` })).toBeNull();
  });

  it("draws a stack rather than a guessed grid before the canvas has been measured", () => {
    const { container } = mount(layoutOf(A, B), 0);

    expect(boxFor(container, "a").style.gridColumn).toBe("");
    expect(screen.getByRole("region", { name: titleOf("future-a") })).toBeInTheDocument();

    resizeCanvas(1032);
    expect(boxFor(container, "b").style.gridColumn).toBe("3 / span 2");
  });

  it("offers a way back when the reader has cleared the page, and adds from there", async () => {
    const user = userEvent.setup();
    mount(layoutOf());

    // An empty document is a layout and not a missing one, so the page says so — and carries the two
    // controls that can put something on it without a Customize press.
    expect(screen.getByText(/^Your home page is empty\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add widget" }));
    const dialog = await screen.findByRole("dialog", { name: "Widget catalogue" });
    await user.click(within(dialog).getByRole("button", { name: "Add Folders" }));

    await waitFor(() =>
      expect(storedWidget("folders")).toEqual(expect.objectContaining({ x: 0, y: 0, w: 4, h: 2 })),
    );
    expect(screen.queryByText(/^Your home page is empty\./)).toBeNull();
    // The tray went with the emptiness, so the caret lands on the control that is still there.
    await waitFor(() => expect(screen.getByRole("button", { name: "Customize" })).toHaveFocus());
  });

  it("draws a placeholder for a kind it has never heard of, and does not throw", async () => {
    const user = userEvent.setup();
    expect(() => mount(layoutOf(widget({ id: "x", kind: "timeMachine" })))).not.toThrow();

    const card = screen.getByRole("region", { name: titleOf("timeMachine") });
    expect(within(card).getByText(/came from a newer version of MTG Grimoire/)).toBeInTheDocument();

    // And it keeps its tray, because a widget this build cannot draw is the one a reader is most
    // likely to want off the page.
    await customize(user);
    expect(screen.getByRole("button", { name: `Remove ${titleOf("timeMachine")}` })).toBeInTheDocument();
  });

  /* ----------------------------------------------------------------------- the zoom ------- */

  /**
   * Ctrl+wheel on the dashboard, and the two coordinate spaces it puts the page in.
   *
   * **1374px is chosen so both readings of the canvas are whole numbers**, which is the only reason
   * a width this specific appears here: at 100% it is eleven columns of exactly 114px, and at 150%
   * its local canvas is 916px — eight columns of exactly 104px, the grid's own `TARGET_CELL`. Every
   * figure below is one of those four, so a failure names which of them moved rather than landing
   * three decimals from an expectation nobody can read.
   *
   * **jsdom implements no `zoom` at all** — it parses the property into the style object and lays
   * nothing out with it. So these cases are about the half of the mechanism that is arithmetic: the
   * division that turns a measured canvas into a local one, and the multiplication that turns
   * pointer travel back. What the property itself does to a painted box was measured in a browser
   * (see `HomePage.tsx`'s module doc) and cannot be asserted here.
   */
  describe("the zoom", () => {
    /** The box carrying the CSS `zoom` — the canvas's only child. */
    function gridBox(container: HTMLElement): HTMLElement {
      const canvas = container.querySelector<HTMLElement>(`[${HOME_CANVAS_ATTR}]`);
      if (canvas === null) throw new Error("no canvas");
      const box = canvas.firstElementChild;
      if (!(box instanceof HTMLElement)) throw new Error("the canvas has no zoom box");
      return box;
    }

    /** A ctrl+wheel over the page — the gesture, not a store write. Returns the event, so a case
     *  can ask whether the page took it off WebView2. */
    function ctrlWheel(container: HTMLElement, deltaY: number): WheelEvent {
      const section = container.querySelector("section");
      if (section === null) throw new Error("no page section");
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY });
      act(() => {
        section.dispatchEvent(event);
      });
      return event;
    }

    function zoomTo(zoom: number): void {
      act(() => useAppStore.setState({ cardZoom: { ...DEFAULT_SECTION_ZOOMS, home: zoom } }));
    }

    /**
     * **The gesture is caught on the whole page, and it steps this section alone.**
     *
     * `preventDefault` is the load-bearing half: without it WebView2 applies its own page zoom on
     * top, scaling the sidebar and the ribbon out from under a reader who was pointing here.
     */
    it("steps the home zoom on a ctrl+wheel anywhere on the page, and takes the gesture off the window", () => {
      const { container } = mount(layoutOf(A, B), 1374);

      const event = ctrlWheel(container, -100);

      expect(event.defaultPrevented).toBe(true);
      expect(useAppStore.getState().cardZoom.home).toBe(1.1);

      ctrlWheel(container, 100);
      ctrlWheel(container, 100);
      expect(useAppStore.getState().cardZoom.home).toBe(0.9);

      // The other walls are swept out of `ZOOM_SECTIONS` rather than named, so a section added
      // after this was written is covered by it rather than quietly left out.
      for (const section of ZOOM_SECTIONS.filter((s) => s !== "home")) {
        expect(useAppStore.getState().cardZoom[section]).toBe(DEFAULT_ZOOM);
      }
    });

    /** A wheel with no modifier is the page scrolling, and must reach the scroller untouched. */
    it("leaves a wheel without ctrl alone", () => {
      const { container } = mount(layoutOf(A), 1374);
      const section = container.querySelector("section");
      const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -100 });
      act(() => void section?.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(false);
      expect(useAppStore.getState().cardZoom.home).toBe(DEFAULT_ZOOM);
    });

    /**
     * **The zoom goes on the grid box and never on the canvas**, which is what keeps the measured
     * width in true pixels — the division below has nothing to divide if the ruler is scaled too.
     */
    it("carries the zoom on the grid box, leaving the measured canvas unscaled", () => {
      const { container } = mount(layoutOf(A), 1374);
      const canvas = container.querySelector<HTMLElement>(`[${HOME_CANVAS_ATTR}]`);

      expect(canvas?.style.zoom).toBe("");
      expect(gridBox(container).style.zoom).toBe("1");

      zoomTo(1.5);
      expect(canvas?.style.zoom).toBe("");
      expect(gridBox(container).style.zoom).toBe("1.5");
    });

    /**
     * **The whole of what a zoom does to the arrangement**: the canvas is asked about in local
     * pixels, so the columns fall and the cells hold their size — and the stored document is not
     * touched, exactly as a narrowed window does not touch it.
     */
    it("takes columns away as the zoom goes up, and writes nothing doing it", () => {
      const { container } = mount(layoutOf(widget({ id: "a", kind: "decks", x: 9, w: 2 })), 1374);

      // 1374px is eleven columns of 114px, so x: 9 is the last pair that fits and sits as stored.
      expect(boxFor(container, "a").style.gridColumn).toBe("10 / span 2");
      expect((handed.get("a")?.fit as WidgetFit).widthPx).toBe(2 * 114 + 12);

      zoomTo(1.5);

      // 916 local px is eight columns of 104 — `normalise` pulls x: 9 in to the last free pair.
      expect(boxFor(container, "a").style.gridColumn).toBe("7 / span 2");
      expect((handed.get("a")?.fit as WidgetFit).widthPx).toBe(2 * 104 + 12);
      expect(storedWidget("a")?.x).toBe(9);
      expect(write).not.toHaveBeenCalled();

      // And back: a zoom is a way of looking at the page, not a change to it.
      zoomTo(1);
      expect(boxFor(container, "a").style.gridColumn).toBe("10 / span 2");
    });

    /**
     * **The correction, and the one thing here that would fail silently without a case.**
     *
     * A pointer's `clientX` is viewport pixels and a cell is the grid's own, so one cell of travel
     * at 150% is 174px on screen against 116 in the grid. Divided by the bare step, this drag would
     * read as one and a half cells and round to two.
     */
    it("reads a drag in painted pixels and lands it on the cell the pointer is over", async () => {
      const user = userEvent.setup();
      const { container } = mount(layoutOf(widget({ id: "a", kind: "future-a", x: 0, w: 2 })), 1374);
      zoomTo(1.5);
      await customize(user);

      const card = screen.getByRole("region", { name: titleOf("future-a") });
      fireEvent(card, new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 0, clientY: 0 }));
      // One cell: 104 local px and a 12px gap, painted at 150%.
      fireEvent(window, new MouseEvent("pointermove", { clientX: 116 * 1.5, clientY: 0 }));

      // The card follows the pointer, and follows it by the *local* offset — the transform is
      // applied inside the zoom, so an undivided one would carry it half a cell too far.
      expect(boxFor(container, "a").style.transform).toBe("translate(116px, 0px)");
      fireEvent(window, new MouseEvent("pointerup"));

      await waitFor(() => expect(storedWidget("a")).toEqual(expect.objectContaining({ x: 1, y: 0 })));
    });

    /**
     * **The stack is reachable from both directions**, which is `HomePage.tsx`'s reading of
     * `CELL_MIN`: the floor is about whether the grid has room to be a grid in its own units, and
     * the zoom is what changes how many of those units there are.
     */
    it("stacks a grid zoomed past its column floor, and lays a stacked page back out on a zoom out", () => {
      // 1032px is nine columns of 104px — a grid.
      const { container } = mount(layoutOf(A, B), 1032);
      expect(boxFor(container, "a").style.gridColumn).toBe("1 / span 2");

      // 516 local px cannot go under eight columns, so it goes under a readable cell instead: 54px.
      zoomTo(2);
      expect(boxFor(container, "a").style.gridColumn).toBe("");

      // The other way. 600px stacks at life size — eight columns of 64.5px — and zooming out buys
      // the local canvas the width the window never had.
      zoomTo(1);
      resizeCanvas(600);
      expect(boxFor(container, "a").style.gridColumn).toBe("");

      zoomTo(0.5);
      expect(boxFor(container, "a").style.gridColumn).toBe("1 / span 2");
    });
  });
});
