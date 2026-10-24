import type { ReactElement } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { widgetDensity } from "../widgetSettings";
import { WishlistValueHistoryWidget } from "./ValueHistoryWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `wishlistValueHistory` widget at a footprint, with a config. */
function graph(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "wishlistValueHistory", kind: "wishlistValueHistory", x: 0, y: 0, w, h, config };
}

/** The body inside the real card, at the footprint's size on the target cell —
 *  `ValueHistoryWidget.stories.tsx`'s frame. */
function Framed({ widget }: { widget: HomeWidget }): ReactElement {
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
          <WishlistValueHistoryWidget
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
  return within(await within(canvasElement).findByRole("region", { name: "Wishlist value graph" }));
}

const meta = {
  title: "Home/WishlistValueHistoryWidget",
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
          "What the wishlist would have cost over time (issue #1378) — the Collection value " +
          "graph's body over `wishlist_value_history`, in total or one line per card type, colour " +
          "or set. The last point is the Wishlist value widget's figure, and a step's non-price " +
          "part is **wishes added, bought or removed**, marked with a diamond when *Mark wishlist " +
          "changes* is on. The fake derives a history from the wishlist, so `starter` has lines.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default: chips across the top, the chart on the left, the rail of lines on the right. */
export const CardType: Story = {
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByRole("slider")).toBeInTheDocument();
    await expect(card.getByRole("group", { name: "Series" })).toBeInTheDocument();
  },
};

/** Total in money: one gold line, and the rail's figures — the part prices moved and the part the
 *  reader's wishes did. */
export const TotalValue: Story = {
  args: { widget: graph(6, 3, { split: "total", measure: "value" }) },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    const figures = await card.findByRole("group", { name: "Figures" });
    await expect(within(figures).getByText("Wishlist changes")).toBeInTheDocument();
    await expect(within(figures).getByText("Price moves")).toBeInTheDocument();
  },
};

/** A tile: the figure line and the chart, no scale. */
export const Tile2x2: Story = {
  args: { widget: graph(2, 2) },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByText(/^Value \(USD\)/)).toBeInTheDocument();
  },
};

/** Nothing wished for: one sentence, and no chart of nothing. */
export const Empty: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByText("Nothing on your wishlist yet.")).toBeInTheDocument();
  },
};
