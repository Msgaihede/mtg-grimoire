import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import {
  QueryClient,
  QueryClientProvider,
  type QueryKey,
  type QueryState,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { CollectionSummary, HomeWidget, ValueHistory, ValueSplit } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { MARKETPLACE_FEEDS_KEY, MARKETPLACE_KEY } from "@/lib/useMarketplace";

import { makeFit, spanPx, type WidgetFit } from "../fit";
import { collectionTotalKey, valueHistoryKey } from "../keys";
import { DAY_SECONDS } from "../priceHistory/priceAnalytics";
import { WidgetCard } from "../WidgetCard";
import type { WidgetBodyProps } from "../widgetProps";
import { ValueHistoryWidget } from "./ValueHistoryWidget";

/**
 * Nothing here mocks `@/lib/ipc` — `CollectionValueWidget.test.tsx`'s reason: a bare `vi.fn()`
 * types nothing, so a field added to `ValueHistory` would fail inside a render rather than at
 * `tsc`. Both reads are seeded under the exact keys the body asks for, which is also the
 * assertion that the split and the marketplace are in them and the range and measure are not.
 */
const MARKETPLACE: MarketplaceId = "tcgplayer";

/** Saturday 26 September 2026, 00:00 UTC — the fixtures' today. */
const TODAY = Date.UTC(2026, 8, 26) / 1000;
const ago = (n: number) => TODAY - n * DAY_SECONDS;

let client: QueryClient;

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryOnMount: false, staleTime: Infinity } },
  });
  client.setQueryData(MARKETPLACE_KEY, MARKETPLACE);
  client.setQueryData(MARKETPLACE_FEEDS_KEY, []);
});

function summary(over: Partial<CollectionSummary> = {}): CollectionSummary {
  return {
    totalCards: 40,
    uniqueCards: 30,
    entries: 30,
    tradelistCards: 0,
    value: 150,
    unpriced: 0,
    needsReview: 0,
    ...over,
  };
}

/**
 * Creature and land over three days — `model.test.ts`'s fixture: the reader adds $74.60 of cards
 * on the 25th while prices move $5.40, then removes $20.00 today while prices fall $10.00.
 */
const THREE_DAYS: ValueHistory = {
  buckets: [
    { key: "creature", name: null },
    { key: "land", name: null },
  ],
  points: [
    { day: ago(2), total: 100, values: [60, 40], moved: null, live: false },
    { day: ago(1), total: 180, values: [130, 50], moved: 5.4, live: false },
    { day: ago(0), total: 150, values: [110, 40], moved: -10, live: true },
  ],
  today: TODAY,
};

/** The same collection with no split — what `split: "total"` answers. */
const THREE_DAYS_TOTAL: ValueHistory = {
  ...THREE_DAYS,
  buckets: [],
  points: THREE_DAYS.points.map((p) => ({ ...p, values: [] })),
};

/** The same three days split by colour — what `split: "color"` answers. */
const THREE_DAYS_COLOR: ValueHistory = {
  ...THREE_DAYS,
  buckets: [
    { key: "R", name: null },
    { key: "G", name: null },
  ],
};

/** Twelve days of one line — enough for a page key to move a whole page, and to be clamped. */
const TWELVE_DAYS: ValueHistory = {
  buckets: [{ key: "creature", name: null }],
  points: Array.from({ length: 12 }, (_, i) => ({
    day: ago(11 - i),
    total: 100 + i,
    values: [100 + i],
    moved: i === 0 ? null : 1,
    live: i === 11,
  })),
  today: TODAY,
};

/** A database with one day in it — a first launch, or one upgraded from before v50, whose
 *  snapshots have prices and no copies and are never read. */
const FIRST_DAY: ValueHistory = {
  buckets: [
    { key: "creature", name: null },
    { key: "land", name: null },
  ],
  points: [{ day: TODAY, total: 150, values: [110, 40], moved: null, live: true }],
  today: TODAY,
};

function widget(config: unknown = null, w = 6, h = 3): HomeWidget {
  return { id: "valueHistory", kind: "valueHistory", x: 0, y: 0, w, h, config };
}

function fitOf(w: number, h: number, cell = 104): WidgetFit {
  return makeFit({
    w,
    h,
    widthPx: spanPx(w, cell),
    heightPx: spanPx(h, cell),
    density: "comfortable",
  });
}

function props(over: Partial<WidgetBodyProps> = {}): WidgetBodyProps {
  const drawn = over.widget ?? widget();
  return {
    widget: drawn,
    fit: fitOf(drawn.w, drawn.h),
    editing: false,
    still: false,
    onConfig: vi.fn(),
    ...over,
  };
}

function seed(history: ValueHistory = THREE_DAYS, split: ValueSplit = "type", total = summary()) {
  client.setQueryData(collectionTotalKey(MARKETPLACE), total);
  client.setQueryData(valueHistoryKey(split, MARKETPLACE), history);
}

/** `CollectionValueWidget.test.tsx`'s way of putting a query into the one state `setQueryData`
 *  cannot: refused. */
function seedRefusal(key: QueryKey, message: string): void {
  const state: Partial<QueryState<unknown, Error>> = {
    status: "error",
    fetchStatus: "idle",
    error: new Error(message),
    errorUpdatedAt: Date.now(),
  };
  client.getQueryCache().build(client, { queryKey: key }).setState(state);
}

/**
 * Drawn with the app's `TooltipProvider` above it, because the readout is **its** panel: with
 * nothing above it `useTooltip`'s context is a no-op, and a hover test would pass by never being
 * asked.
 */
function draw(over: Partial<WidgetBodyProps> = {}) {
  const p = props(over);
  const tree = (again: Partial<WidgetBodyProps> = {}): ReactElement => (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <ValueHistoryWidget {...p} {...again} />
      </TooltipProvider>
    </QueryClientProvider>
  );
  const drawn = render(tree());
  /** The same body drawn again with some props changed — a config the settings popover wrote,
   *  which reaches the body as a new `widget` and runs none of its handlers. */
  const redraw = (again: Partial<WidgetBodyProps>) => drawn.rerender(tree(again));
  return { ...drawn, redraw };
}

/**
 * One pointer event with a real `clientX` — `PriceChart.test.tsx`'s helper: jsdom ships no
 * `PointerEvent`, so Testing Library's helpers drop the coordinate, and the pointer's kind with
 * it. **A leave is dispatched as `pointerout`**, because React builds `onPointerLeave` from
 * `pointerout` and never listens for the native `pointerleave`.
 */
function pointer(target: Element, type: string, clientX: number, pointerType = "mouse") {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  fireEvent(target, event);
}

/** The readout panel, once the tooltip has drawn it. */
async function findReadout(): Promise<HTMLElement> {
  return waitFor(
    () => {
      const el = document.querySelector<HTMLElement>("[data-value-readout]");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    },
    { timeout: 2000 },
  );
}

/** Long enough for a panel that was put down to finish leaving — motion's exit is skipped in
 *  this suite, but its removal still waits on a frame. */
async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
}

/** The slider, drawn 1000px wide from x = 0 — jsdom lays nothing out, so the box is stated. */
function slider(): HTMLElement {
  const el = screen.getByRole("slider");
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, x: 0, y: 0, width: 1000, height: 200, right: 1000, bottom: 200 }) as DOMRect;
  return el;
}

describe("ValueHistoryWidget", () => {
  it("draws inside its card: the region, the figure, and a slider over the chart", () => {
    seed();
    const p = props();
    render(
      <QueryClientProvider client={client}>
        <WidgetCard widget={p.widget} fit={p.fit} editing={false} onConfig={vi.fn()} onRemove={vi.fn()}>
          <ValueHistoryWidget {...p} />
        </WidgetCard>
      </QueryClientProvider>,
    );
    const card = within(screen.getByRole("region", { name: "Collection value graph" }));
    expect(card.getByText("Value (USD)")).toBeInTheDocument();
    // Today's live point is the figure, and its change is measured from the range's first point.
    expect(card.getByText("$150.00")).toBeInTheDocument();
    expect(card.getByText("+50.0%")).toBeInTheDocument();
    expect(card.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Today: Creature $110.00, total $150.00",
    );
  });

  it("says it is reading before either read answers", () => {
    draw();
    expect(screen.getByText("Reading your price history…")).toBeInTheDocument();
  });

  it("says the history could not be read, with the reason", () => {
    client.setQueryData(collectionTotalKey(MARKETPLACE), summary());
    seedRefusal(valueHistoryKey("type", MARKETPLACE), "database is locked");
    draw();
    expect(
      screen.getByText("Your price history could not be read. database is locked"),
    ).toBeInTheDocument();
  });

  it("says nothing is owned when the collection is empty", () => {
    seed({ buckets: [], points: [], today: TODAY }, "type", summary({ totalCards: 0, value: 0 }));
    draw();
    expect(screen.getByText("Nothing in your collection yet.")).toBeInTheDocument();
    expect(screen.queryByRole("slider")).toBeNull();
  });

  it("draws today's figure and says when the line starts on the first day", () => {
    seed(FIRST_DAY);
    draw();
    expect(screen.getByText("$150.00")).toBeInTheDocument();
    expect(
      screen.getByText("Prices are kept once a day, so the line starts tomorrow."),
    ).toBeInTheDocument();
    // No line, so nothing to walk — and no change figure measured against itself.
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByText("0.0%")).toBeNull();
  });

  it("writes the split, the range and the measure through onConfig, the keys the registry names", async () => {
    seed();
    const onConfig = vi.fn();
    const user = userEvent.setup();
    draw({ onConfig });
    const split = within(screen.getByRole("group", { name: "Split by" }));
    expect(split.getByRole("button", { name: "Card type" })).toHaveAttribute("aria-pressed", "true");
    await user.click(split.getByRole("button", { name: "Set" }));
    expect(onConfig).toHaveBeenLastCalledWith({ split: "set" });

    await user.click(within(screen.getByRole("group", { name: "Range" })).getByRole("button", { name: "1Y" }));
    expect(onConfig).toHaveBeenLastCalledWith({ window: "1y" });

    await user.click(screen.getByRole("button", { name: "Value in USD" }));
    expect(onConfig).toHaveBeenLastCalledWith({ measure: "value" });
  });

  it("moves the lit line to the row a reader presses", async () => {
    seed();
    const user = userEvent.setup();
    const { container } = draw();
    const lines = within(screen.getByRole("group", { name: "Line to follow" }));
    const creature = lines.getByRole("button", { name: /^Creature/ });
    const land = lines.getByRole("button", { name: /^Land/ });
    expect(creature).toHaveAttribute("aria-pressed", "true");
    expect(container.querySelector('[data-mark="line"]')).toHaveAttribute("data-key", "creature");

    await user.click(land);
    expect(land).toHaveAttribute("aria-pressed", "true");
    expect(creature).toHaveAttribute("aria-pressed", "false");
    expect(container.querySelector('[data-mark="line"]')).toHaveAttribute("data-key", "land");
    // The followed line is spoken on the slider too.
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Today: Land $40.00, total $150.00",
    );
  });

  it("walks the days with the arrow keys and lets go on Escape", () => {
    seed();
    draw();
    const s = screen.getByRole("slider");
    expect(s).toHaveAttribute("aria-valuetext", "Today: Creature $110.00, total $150.00");

    fireEvent.keyDown(s, { key: "ArrowLeft" });
    expect(s).toHaveAttribute("aria-valuetext", "25 Sept 2026: Creature $130.00, total $180.00");
    expect(s).toHaveAttribute("aria-valuenow", "1");

    fireEvent.keyDown(s, { key: "Home" });
    expect(s).toHaveAttribute("aria-valuetext", "24 Sept 2026: Creature $60.00, total $100.00");
    // Past the end is the end.
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    expect(s).toHaveAttribute("aria-valuenow", "0");

    fireEvent.keyDown(s, { key: "End" });
    expect(s).toHaveAttribute("aria-valuenow", "2");
    fireEvent.keyDown(s, { key: "ArrowLeft" });
    fireEvent.keyDown(s, { key: "Escape" });
    expect(s).toHaveAttribute("aria-valuetext", "Today: Creature $110.00, total $150.00");
  });

  it("opens a readout of every line's value for the hovered day, and closes it on leave", async () => {
    seed();
    const { container } = draw();
    const s = slider();

    // The middle of the plot is the middle day.
    pointer(s, "pointermove", 500);
    expect(container.querySelector('[data-mark="crosshair"]')).not.toBeNull();
    expect(container.querySelector("[data-readout-anchor]")).not.toBeNull();

    const panel = await waitFor(
      () => {
        const el = document.querySelector<HTMLElement>("[data-value-readout]");
        expect(el).not.toBeNull();
        return el as HTMLElement;
      },
      { timeout: 2000 },
    );
    const readout = within(panel);
    expect(readout.getByText("25 Sept 2026")).toBeInTheDocument();
    expect(readout.getByText("change since 24 Sept")).toBeInTheDocument();
    expect(readout.getByText("$180.00")).toBeInTheDocument();
    expect(readout.getByText("$130.00")).toBeInTheDocument();
    expect(readout.getByText("$50.00")).toBeInTheDocument();
    expect(readout.getByText("+$74.60 of cards added that day")).toBeInTheDocument();
    // The figure line follows the hovered day as well.
    expect(screen.getByText("Value (USD) · 25 Sept 2026")).toBeInTheDocument();

    fireEvent.pointerLeave(s);
    expect(container.querySelector('[data-mark="crosshair"]')).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-value-readout]")).toBeNull());
  });

  /** `aria-valuenow` is the index, so up is later — for the page keys exactly as for the arrows. */
  it("pages seven points, PageUp later and PageDown earlier, clamped at the ends", () => {
    seed(TWELVE_DAYS);
    draw();
    const s = screen.getByRole("slider");
    expect(s).toHaveAttribute("aria-valuemax", "11");

    fireEvent.keyDown(s, { key: "Home" });
    fireEvent.keyDown(s, { key: "PageUp" });
    expect(s).toHaveAttribute("aria-valuenow", "7");
    fireEvent.keyDown(s, { key: "ArrowUp" });
    expect(s).toHaveAttribute("aria-valuenow", "8");
    fireEvent.keyDown(s, { key: "PageUp" });
    expect(s).toHaveAttribute("aria-valuenow", "11");
    fireEvent.keyDown(s, { key: "PageDown" });
    expect(s).toHaveAttribute("aria-valuenow", "4");
    fireEvent.keyDown(s, { key: "PageDown" });
    expect(s).toHaveAttribute("aria-valuenow", "0");
  });

  /**
   * The tooltip puts its panel down on any press outside it, from a capture-phase listener on the
   * window that runs before the slider hears the press — and a press on the day already read
   * changes no readout, so without the slider putting it back it stayed down until the pointer
   * crossed into another day.
   */
  it("keeps the readout up when the plot is pressed on the day it shows", async () => {
    seed();
    const { container } = draw();
    const s = slider();
    pointer(s, "pointermove", 500);
    await findReadout();

    pointer(s, "pointerdown", 500);
    await settle();
    expect(document.querySelector("[data-value-readout]")).not.toBeNull();
    expect(within(await findReadout()).getByText("25 Sept 2026")).toBeInTheDocument();
    expect(container.querySelector('[data-mark="crosshair"]')).not.toBeNull();
  });

  /** A touch pointer stops existing when it lifts, so the browser sends a leave straight after
   *  the up — and on a phone the tap is the reading. A mouse moving off still lets go. */
  it("keeps a tapped day's readout after the finger lifts, and lets go when a mouse leaves", async () => {
    seed();
    const { container } = draw();
    const s = slider();
    pointer(s, "pointerdown", 500, "touch");
    pointer(s, "pointerup", 500, "touch");
    pointer(s, "pointerout", 500, "touch");
    await settle();
    expect(s).toHaveAttribute("aria-valuenow", "1");
    expect(container.querySelector('[data-mark="crosshair"]')).not.toBeNull();
    expect(within(await findReadout()).getByText("25 Sept 2026")).toBeInTheDocument();

    pointer(s, "pointermove", 900);
    pointer(s, "pointerout", 900);
    expect(container.querySelector('[data-mark="crosshair"]')).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-value-readout]")).toBeNull());
  });

  /**
   * **The settings popover writes the same keys the chips do and runs none of the body's
   * handlers**, so what a new split or range puts down has to follow the config rather than the
   * press: the hovered day's index, its readout, and a pin made under another split — which,
   * pinned on *type* and back from *colour*, must not come back.
   */
  it("puts the hovered day down, and the pin with its split, when the popover changes either", async () => {
    seed();
    client.setQueryData(valueHistoryKey("color", MARKETPLACE), THREE_DAYS_COLOR);
    const user = userEvent.setup();
    const { container, redraw } = draw({ widget: widget({ split: "type" }) });
    const lines = () => within(screen.getByRole("group", { name: "Line to follow" }));

    await user.click(lines().getByRole("button", { name: /^Land/ }));
    pointer(slider(), "pointermove", 500);
    await findReadout();

    redraw({ widget: widget({ split: "color" }) });
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "2");
    expect(container.querySelector('[data-mark="crosshair"]')).toBeNull();
    await waitFor(() => expect(document.querySelector("[data-value-readout]")).toBeNull());

    redraw({ widget: widget({ split: "type" }) });
    expect(lines().getByRole("button", { name: /^Creature/ })).toHaveAttribute("aria-pressed", "true");
    expect(lines().getByRole("button", { name: /^Land/ })).toHaveAttribute("aria-pressed", "false");

    // A range draws the same lines, so the pin stays and only the day goes.
    await user.click(lines().getByRole("button", { name: /^Land/ }));
    pointer(slider(), "pointermove", 500);
    await findReadout();
    redraw({ widget: widget({ split: "type", window: "30d" }) });
    expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "2");
    expect(container.querySelector('[data-mark="crosshair"]')).toBeNull();
    expect(lines().getByRole("button", { name: /^Land/ })).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(document.querySelector("[data-value-readout]")).toBeNull());
  });

  it("marks the days a reader added or removed cards, and not when the switch is off", () => {
    seed();
    const { container, unmount } = draw();
    expect(container.querySelectorAll('[data-mark="change"]')).toHaveLength(2);
    unmount();
    const { container: off } = draw({ widget: widget({ markers: false }) });
    expect(off.querySelectorAll('[data-mark="change"]')).toHaveLength(0);
  });

  it("gives Total's rail the range's figures instead of lines to follow", () => {
    seed(THREE_DAYS_TOTAL, "total");
    draw({ widget: widget({ split: "total" }) });
    const figures = within(screen.getByRole("group", { name: "Figures" }));
    // +$50.00 over the range: the reader added $54.60 net, and prices took $4.60 of it back.
    expect(figures.getByText("Change").parentElement).toHaveTextContent("+$50.00");
    expect(figures.getByText("Collection changes").parentElement).toHaveTextContent("+$54.60");
    expect(figures.getByText("Price moves").parentElement).toHaveTextContent("−$4.60");
    expect(figures.getByText("High").parentElement).toHaveTextContent("$180.00");
    expect(screen.queryByRole("group", { name: "Line to follow" })).toBeNull();
  });

  it("takes no pointer, key or press in a still body, and writes nothing", async () => {
    seed();
    const onConfig = vi.fn();
    const user = userEvent.setup();
    draw({ still: true, onConfig });
    // The picture is whole — the chips and the rows are drawn…
    const set = screen.getByRole("button", { name: "Set" });
    const land = screen.getByRole("button", { name: /^Land/ });
    // …and there is no slider to focus, so no readout either.
    expect(screen.queryByRole("slider")).toBeNull();

    await user.click(set);
    await user.click(land);
    expect(onConfig).not.toHaveBeenCalled();
    expect(land).toHaveAttribute("aria-pressed", "false");
  });

  it("draws the same picture, inert, while the page is being customised", () => {
    seed();
    draw({ editing: true });
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.getByText("$150.00")).toBeInTheDocument();
  });
});
