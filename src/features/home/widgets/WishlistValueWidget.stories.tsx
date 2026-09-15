import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ReactElement } from "react";
import { expect, fn, within } from "storybook/test";
import type { HomeWidget } from "@/lib/ipc";
import { makeFit, spanPx } from "../fit";
import { WidgetCard } from "../WidgetCard";
import type { WidgetBodyProps } from "../widgetProps";
import { widgetDensity } from "../widgetSettings";
import { WishlistValueWidget } from "./WishlistValueWidget";

/** The body and its fit for one footprint on a grid of `cell`-pixel cells, through `fit.ts`. */
function sized(
  config: unknown,
  w: number,
  h: number,
  cell = 104,
): Pick<WidgetBodyProps, "widget" | "fit"> {
  const widget: HomeWidget = {
    id: "wishlistValue",
    kind: "wishlistValue",
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

/** The body inside the card the page draws it in, at the card's own pixel size. */
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
        <WishlistValueWidget {...props} />
      </WidgetCard>
    </div>
  );
}

/** The card a story drew, found by its title — `WidgetCard` makes it a `region`. */
async function cardIn(canvasElement: HTMLElement) {
  return within(await within(canvasElement).findByRole("region", { name: "Wishlist value" }));
}

const meta = {
  title: "Home/WishlistValueWidget",
  component: WishlistValueWidget,
  tags: ["autodocs"],
  args: {
    // Three cells wide rather than the default two: `WidgetFigures` drops a figure's note on a
    // two-cell tile, and the note is half of what the wishlist's figure says.
    ...sized(null, 3, 3),
    editing: false,
    still: false,
    onConfig: fn(),
  },
  render: (args) => <InCard {...args} />,
  parameters: {
    docs: {
      description: {
        component:
          "What the wishlist would cost, and how that cost is spread across one dimension.\n\n" +
          "**This is not `CollectionValueWidget` with a prop flipped.** An empty *collection* is " +
          "*you own nothing yet* where an empty *wishlist* is *you want nothing yet*; an unpriced " +
          "collection row is a card whose worth is unknown where an unpriced **wish** is a card " +
          "nobody will quote a price to *buy*; and the `finish` dimension has a fifth bucket " +
          "here — `Any finish`.\n\n" +
          "**A body, fitted to its box**: figures first, then as many whole rows of bars — or " +
          "list rows — as are left, with the tail folded into one `Other`. **Each bar is one " +
          "`sr-only` sentence over an `aria-hidden` drawing**, and every play below reads those.",
      },
    },
  },
} satisfies Meta<typeof WishlistValueWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The seeded wishlist, sliced by rarity — eight wishes over fourteen copies costing `$246.53`.
 *
 * `Common` is the money (`$140.48` over two copies), and `Rare` is the **hole**: one copy the
 * marketplace will not quote a price to buy at, which draws an em dash and says so in words.
 */
export const ByRarity: Story = {
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(
      await card.findByText("Common: 2 copies, $140.48, 57% of the total."),
    ).toBeInTheDocument();
    await expect(card.getByText("Rare: 1 copy, no price to buy at TCGplayer.")).toBeInTheDocument();
    await expect(card.getByText("1 copy nobody quotes a price for")).toBeInTheDocument();
  },
};

/** A two-cell tile drawing its buckets as a list: no width for a name and a figure side by side,
 *  so each row's money sits under its name. */
export const AsAListOnATile: Story = {
  args: sized({ chart: "list" }, 2, 3),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(await card.findByText("$140.48")).toBeInTheDocument();
    await expect(card.queryByText(/of the total\.$/)).not.toBeInTheDocument();
  },
};

/** A band: the chip beside the title, and a footer naming whose prices these are. */
export const ABand: Story = {
  args: sized({ dimension: "finish" }, 4, 4),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(
      await card.findByText("TCGplayer prices as of the last card-data sync · split by finish"),
    ).toBeInTheDocument();
  },
};

/** A stored `dimension` this build has never heard of, read as Rarity — on screen this is
 *  {@link ByRarity}, and that is the claim. */
export const AConfigThisBuildCannotRead: Story = {
  args: sized({ dimension: "bogus" }, 3, 3),
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(
      await card.findByText("Common: 2 copies, $140.48, 57% of the total."),
    ).toBeInTheDocument();
  },
};

/** A wishlist nobody has put anything on — the wishlist's sentence, and no `$0.00` over it. */
export const NothingWishedFor: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const card = await cardIn(canvasElement);
    await expect(
      await card.findByText("You want nothing yet — wish for a card and its cost lands here."),
    ).toBeInTheDocument();
    await expect(card.queryByText(/of the total\./)).not.toBeInTheDocument();
  },
};
