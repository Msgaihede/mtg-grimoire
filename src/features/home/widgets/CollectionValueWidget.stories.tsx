import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import type { WidgetBodyProps } from "../widgetProps";
import { widgetDensity } from "../widgetSettings";
import { CollectionValueWidget } from "./CollectionValueWidget";

/**
 * The body and the fit it is drawn to, for one footprint on a grid of `cell`-pixel cells — the
 * page's own arithmetic, so each story names a size the way a reader makes one and the whole-row
 * count falls out of `fit.ts`. 104px is the grid's target cell; 68px its floor.
 */
function sized(
  config: unknown,
  w: number,
  h: number,
  cell = 104,
): Pick<WidgetBodyProps, "widget" | "fit"> {
  const widget: HomeWidget = {
    id: "collectionValue",
    kind: "collectionValue",
    x: 0,
    y: 0,
    w,
    h,
    config,
  };
  return {
    widget,
    fit: makeFit({
      w,
      h,
      widthPx: spanPx(w, cell),
      heightPx: spanPx(h, cell),
      density: widgetDensity(widget),
    }),
  };
}

/** The body inside the card the page draws it in, at the card's own pixel size — so the title,
 *  the chip and the clip are the real ones and a story shows what a reader sees. */
function InCard(props: WidgetBodyProps): ReactElement {
  return (
    <div style={{ width: props.fit.widthPx, height: props.fit.heightPx }}>
      <WidgetCard
        widget={props.widget}
        fit={props.fit}
        editing={false}
        onConfig={fn()}
        onRemove={fn()}
      >
        <CollectionValueWidget {...props} />
      </WidgetCard>
    </div>
  );
}

/** The card a story drew, found by its title — `WidgetCard` makes it a `region`. */
async function cardIn(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole("region", { name: "Collection value" }));
}

const meta = {
  title: "Home/CollectionValueWidget",
  component: CollectionValueWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: two cells by three, no config — which opens on Rarity, bars and
    // totals.
    ...sized(null, 2, 3),
    editing: false,
    still: false,
    onConfig: fn(),
  },
  render: (args) => <InCard {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "What the collection is worth, and **where the money is** — one total, and one bar " +
          "per bucket of whichever dimension the reader picked in the card's settings.\n\n" +
          "**A body, fitted to its box.** The figure line and the footer are reserved first and " +
          "the chart gets the whole rows that are left; what does not fit is folded into one " +
          "`Other`, so the bars still sum to the total. A tile with no room for a bar draws the " +
          "two figures and nothing else.\n\n" +
          "**The whole drawing is `aria-hidden` and each bar carries one `sr-only` sentence.** " +
          "Every play below reads those sentences rather than the drawing.\n\n" +
          "**`WishlistValueWidget` is this widget against the other list and is a separate " +
          "component on purpose.** The two lists' empty states and price notes are different " +
          "sentences about different things.",
      },
    },
  },
} satisfies Meta<typeof CollectionValueWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The seeded collection, sliced by rarity, at the default footprint.
 *
 * Measured off the seed (`collection_breakdown` at TCGplayer): common $620.00 over one card, rare
 * $256.50 over eleven — and the shares are of the whole `$1,101.28`, whatever the card had room
 * to draw. `1 card` against `11 cards` is the singular only a screen reader ever meets.
 */
export const ByRarity: Story = {
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(
      await card.findByText("1 card of Common rarity, worth $620.00, 56% of the total"),
    ).toBeInTheDocument();
    await expect(
      card.getByText("11 cards of Rare rarity, worth $256.50, 23% of the total"),
    ).toBeInTheDocument();
  },
};

/** Four cells by four: a band, so the chip reads *Rarity* beside the title and the footer names
 *  whose prices these are and how they were cut. */
export const ABand: Story = {
  args: sized(null, 4, 4),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(
      await card.findByText("TCGplayer prices as of the last card-data sync · split by rarity"),
    ).toBeInTheDocument();
  },
};

/** The same buckets as rows — a name and its money — on a three-cell panel. */
export const AsAList: Story = {
  args: sized({ chart: "list", dimension: "color" }, 3, 4),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await card.findByText("Value (USD)");
    // Rows speak their own visible text; there is no sentence behind a bar that is not drawn.
    await expect(card.queryByText(/of the total$/)).not.toBeInTheDocument();
  },
};

/** Totals switched off: the figure line's pixels go to the chart. */
export const TotalsOff: Story = {
  args: sized({ figures: false }, 2, 3),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await card.findByText("1 card of Common rarity, worth $620.00, 56% of the total");
    await expect(card.queryByText("Cards")).not.toBeInTheDocument();
  },
};

/** A two-by-two tile on the grid's narrowest cells: room for the two figures and no bar — never a
 *  bar the card's edge cuts through. */
export const TooSmallForBars: Story = {
  args: sized(null, 2, 2, 68),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await card.findByText("Value (USD)");
    await expect(card.queryByText(/of Common rarity/)).not.toBeInTheDocument();
  },
};

/**
 * A `config` this build cannot read — `dimension: "bogus"`. The registry pick reads it as Rarity,
 * so the chart is merely not the one somebody's other build chose rather than a refusal about a
 * word nobody can see. On screen this is {@link ByRarity}, and that is the claim.
 */
export const AConfigThisBuildCannotRead: Story = {
  args: sized({ dimension: "bogus" }, 2, 3),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(
      await card.findByText("1 card of Common rarity, worth $620.00, 56% of the total"),
    ).toBeInTheDocument();
  },
};

/**
 * A database with nothing in it — and the figures still draw. `Value` and `Cards` are the whole
 * collection's answer and are honest at zero, so the sentence replaces the chart and nothing else.
 */
export const NothingOwnedYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByText("Nothing in your collection yet.")).toBeInTheDocument();
    await expect(card.queryByText(/of Common rarity/)).not.toBeInTheDocument();
  },
};
