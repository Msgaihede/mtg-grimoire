import { useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, waitFor, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import type { MarketplaceId } from "@/lib/marketplace";
import { MARKETPLACE_KEY } from "@/lib/useMarketplace";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { ValueHistoryWidget } from "./ValueHistoryWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `valueHistory` widget at a footprint, with a config. */
function graph(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "valueHistory", kind: "valueHistory", x: 0, y: 0, w, h, config };
}

/**
 * The body inside the real card, at the footprint's size on the target cell —
 * `PriceMoversWidget.stories.tsx`'s frame.
 *
 * `marketplace` writes the setting into the world's cache before the first render, which is
 * `HomePage.stories.tsx`'s idiom and its reason: a lazy `useState` initializer rather than an
 * effect, so the story does not draw one frame in TCGplayer's dollars first. `null` leaves the
 * fake's own setting alone.
 */
function Framed({
  widget,
  marketplace = null,
}: {
  widget: HomeWidget;
  marketplace?: MarketplaceId | null;
}): ReactElement {
  const client = useQueryClient();
  useState(() => {
    if (marketplace !== null) client.setQueryData(MARKETPLACE_KEY, marketplace);
  });
  const widthPx = spanPx(widget.w, CELL);
  const heightPx = spanPx(widget.h, CELL);
  const fit = makeFit({
    w: widget.w,
    h: widget.h,
    widthPx,
    heightPx,
    density: widgetDensity(widget),
  });
  const onConfig = fn();
  return (
    <div className="p-2">
      <div style={{ width: widthPx, height: heightPx }}>
        <WidgetCard widget={widget} fit={fit} editing={false} onConfig={onConfig} onRemove={fn()}>
          <ValueHistoryWidget
            widget={widget}
            fit={fit}
            editing={false}
            still={false}
            onConfig={onConfig}
          />
        </WidgetCard>
      </div>
    </div>
  );
}

/** The card, by its accessible name — the kind's label, since no story renames it. */
async function cardIn(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole("region", { name: "Collection value graph" }));
}

const meta = {
  title: "Home/ValueHistoryWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The registry's default footprint and settings: six by three, by card type, 90 days, Change.
    widget: graph(6, 3),
  },
  parameters: {
    docs: {
      description: {
        component:
          "What the collection has been worth over time — in total, or one line per card type, " +
          "colour or set. **One line is lit** (2px, its colour, a 10% wash) and the rest are " +
          "context at 30%; hovering a list row previews a line and pressing it pins it.\n\n" +
          "The plot is a `role=\"slider\"`: the pointer and the arrow keys walk the days, and a " +
          "**readout** of every figure the day holds opens beside the crosshair — mounted at the " +
          "app root through the tooltip's machinery, so the card never clips it and the home " +
          "grid's CSS `zoom` never moves it off the pointer.\n\n" +
          "**The in-card chips write the same config keys** the settings popover writes (`split`, " +
          "`window`, `measure`). What fits is `layoutFor`'s fit table: a tile is the figure line " +
          "and the chart, a panel adds a strip of names, a band the chips and a list, a row a rail. " +
          "The fake derives a history from the collection, so `starter` has lines both ways.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default: chips across the top, the chart on the left, the rail on the right. **Hovering the
 * chart opens the readout**, dated for the day under the pointer — the same day the slider speaks.
 */
export const CardType: Story = {
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    const slider = await card.findByRole("slider");
    // jsdom lays nothing out; state the box the pointer is measured against where it has none.
    if (slider.getBoundingClientRect().width === 0) {
      slider.getBoundingClientRect = () =>
        ({ left: 0, top: 0, x: 0, y: 0, width: 400, height: 200, right: 400, bottom: 200 }) as DOMRect;
    }
    const box = slider.getBoundingClientRect();
    slider.dispatchEvent(
      new MouseEvent("pointermove", {
        bubbles: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    );
    // The panel is root-mounted, so it is looked for in the document rather than in the canvas.
    const readout = await waitFor(
      () => {
        const el = document.querySelector<HTMLElement>("[data-value-readout]");
        if (el === null) throw new Error("no readout yet");
        return el;
      },
      { timeout: 2000 },
    );
    const spoken = slider.getAttribute("aria-valuetext") ?? "";
    const day = spoken.slice(0, spoken.indexOf(":"));
    await expect(day).not.toBe("");
    await expect(within(readout).getByText(day)).toBeInTheDocument();
  },
};

/** Total over a year, in money: one gold line, and the rail's figures — the change, the part
 *  prices moved and the part the reader did, the high and the low. */
export const TotalOneYearValue: Story = {
  args: { widget: graph(6, 3, { split: "total", window: "1y", measure: "value" }) },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    const figures = await card.findByRole("group", { name: "Figures" });
    await expect(within(figures).getByText("Price moves")).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Value in USD" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};

/** Colour on the widest row: WUBRG, colourless and multicolour, each in the identity palette and
 *  each named in the rail, because three of the seven cannot be told apart by colour alone. */
export const Colour8x4: Story = {
  args: { widget: graph(8, 4, { split: "color" }) },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByRole("group", { name: "Line to follow" })).toBeInTheDocument();
  },
};

/** A band by set: the figure line with the followed set beside the total, the chips with their
 *  ranges, and a two-column list of sets under the chart. */
export const Set4x4: Story = {
  args: { widget: graph(4, 4, { split: "set" }) },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByRole("group", { name: "Range" })).toBeInTheDocument();
  },
};

/** A tile: the figure line and the chart, no scale. The figure line *is* the readout here — it
 *  takes the hovered date and values, so no panel opens over a card this small. */
export const Tile2x2: Story = {
  args: { widget: graph(2, 2) },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByText(/^Value \(USD\)/)).toBeInTheDocument();
    await expect(card.queryByRole("group", { name: "Split by" })).toBeNull();
  },
};

/** Compact density: the same row, packed tighter. */
export const Compact: Story = {
  args: { widget: graph(6, 3, { density: "compact" }) },
};

/** At Cardmarket: euros, and the `N unpriced` note counted at that marketplace. */
export const Cardmarket: Story = {
  args: { widget: graph(6, 3), marketplace: "cardmarket" },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByText(/^Value \(EUR\)/)).toBeInTheDocument();
  },
};

/** Nothing owned: one sentence, and no chart of nothing. */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByText("Nothing in your collection yet.")).toBeInTheDocument();
  },
};
