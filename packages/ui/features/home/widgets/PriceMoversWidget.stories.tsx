import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import { WidgetSettingsPanel } from "../WidgetSettingsPanel";
import { widgetDensity } from "../widgetSettings";
import { NOTHING_CHOSEN, PriceMoversWidget, PriceMoversWidgetSettings } from "./PriceMoversWidget";

/** The grid's target cell — the size the page aims its columns at. Not exported, for CSF. */
const CELL = 104;

/** A `priceMovers` widget at a footprint, with a config. */
function movers(w: number, h: number, config: unknown = null): HomeWidget {
  return { id: "priceMovers", kind: "priceMovers", x: 0, y: 0, w, h, config };
}

/** The body inside the real card, at the footprint's size on the target cell. */
function Framed({ widget }: { widget: HomeWidget }) {
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
          <PriceMoversWidget
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

/** A signed move as the rows write it — a plus, or a real minus sign, then the money. */
const SIGNED = /^[+−]\$\d/;

const meta = {
  title: "Home/PriceMoversWidget",
  component: Framed,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: two cells by two, the last seven days, both directions.
    widget: movers(2, 2),
  },
  parameters: {
    docs: {
      description: {
        component:
          "The owned printings whose price moved most over a window, measured against the " +
          "snapshot `price_history` kept at the window's start. Every figure is quoted at the " +
          "marketplace the reader picked, with its id in the key.\n\n" +
          "**Two empty sentences, never one.** *No price history yet* is a database that has only " +
          "just started remembering prices; *nothing moved* is history with no change in it. " +
          "`PriceMovers.days` and `since` are what tell them apart.\n\n" +
          "**Colour is a fill, never ink**: a move is body ink on a tinted chip, and the green or " +
          "red goes on the chip and on the glyph beside the name. The fake derives a history " +
          "from the collection, so `starter` has movers both ways.",
      },
    },
  },
} satisfies Meta<typeof Framed>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The default tile: the move under each name, and the glyph saying which way. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Price movers" }));
    const list = await card.findByRole("list", { name: "Price movers" });
    await expect(within(list).getAllByText(SIGNED).length).toBeGreaterThan(0);
  },
};

/** A band: where each printing is from, the move on its chip, and the footer naming the window
 *  and the marketplace. */
export const Band: Story = {
  args: { widget: movers(4, 4) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Price movers" }));
    await expect(
      await card.findByText("TCGplayer prices over the last seven days."),
    ).toBeInTheDocument();
  },
};

/** Gainers only, over the oldest price kept: every figure carries a plus. */
export const GainersSinceTheOldestPrice: Story = {
  args: { widget: movers(4, 4, { window: "all", direction: "up" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("list", { name: "Price movers" });
    const moves = within(list).getAllByText(SIGNED).map((el) => el.textContent ?? "");
    await expect(moves.every((text) => text.startsWith("+"))).toBe(true);
    await expect(
      canvas.getByText("TCGplayer prices since the oldest price kept."),
    ).toBeInTheDocument();
  },
};

/** A first launch: nothing has been remembered yet, which is its own sentence and not *nothing
 *  moved*. */
export const NoHistoryYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/^No price history yet\./)).toBeInTheDocument();
  },
};

/**
 * Narrowed to what the reader chose (issue #906) — here the copies filed in no collection folder,
 * which is where the fake's collection lies. The footer says the list is the chosen cards'.
 */
export const ChosenFolders: Story = {
  args: { widget: movers(4, 4, { scope: "chosen", collectionFolderIds: [0] }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = await canvas.findByRole("list", { name: "Price movers" });
    await expect(within(list).getAllByText(SIGNED).length).toBeGreaterThan(0);
    await expect(
      canvas.getByText("TCGplayer prices of what you chose over the last seven days."),
    ).toBeInTheDocument();
  },
};

/** `Chosen` with nothing chosen: a sentence pointing at the settings, and no read at all. */
export const NothingChosen: Story = {
  args: { widget: movers(2, 2, { scope: "chosen" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(NOTHING_CHOSEN)).toBeInTheDocument();
  },
};

/**
 * The settings panel under `Chosen`: the two folder checklists, the chosen cards with a way to
 * take each off, and a search over every card in the data, owned or not.
 */
export const ChosenSettings: Story = {
  args: {
    widget: movers(2, 3, {
      scope: "chosen",
      collectionFolderIds: [0],
      cards: [{ id: "sol-ring", name: "Sol Ring", setCode: "lea", collectorNumber: "270" }],
    }),
  },
  render: ({ widget }) => (
    <div className="w-72 rounded-md border border-border bg-surface p-3">
      <WidgetSettingsPanel
        widget={widget}
        onConfig={fn()}
        extraSettings={<PriceMoversWidgetSettings widget={widget} onConfig={fn()} />}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByLabelText("Collection folders")).toBeInTheDocument();
    await expect(canvas.getByLabelText("Wishlist folders")).toBeInTheDocument();
    await expect(
      canvas.getByRole("button", { name: "Remove Sol Ring · LEA #270" }),
    ).toBeInTheDocument();
    await expect(canvas.getByLabelText("Cards")).toBeInTheDocument();
  },
};
