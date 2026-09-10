import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { WishlistValueWidget } from "./WishlistValueWidget";

/** The page's half of every widget's props — see `widgetProps.ts`. */
const CHROME = {
  editing: false,
  onRemove: fn(),
  onSpan: fn(),
  onConfig: fn(),
  onNudge: fn(),
  dragHandleRef: fn(),
};

const meta = {
  title: "Home/WishlistValueWidget",
  component: WishlistValueWidget,
  tags: ["autodocs"],
  args: {
    widget: { id: "wishlistValue", kind: "wishlistValue", span: 1, config: null },
    ...CHROME,
  },
  decorators: [
    (Story) => (
      <div className="w-[26rem] max-w-full p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "What the wishlist would cost, and how that cost is spread across one dimension.\n\n" +
          "**This is not `CollectionValueWidget` with a prop flipped, and the plan refuses the " +
          "merge in words.** The two read two commands that answer the same `BreakdownRow` " +
          "shape and the drawing is the same drawing — but an empty *collection* is *you own " +
          "nothing yet* where an empty *wishlist* is *you want nothing yet*: one is a record of " +
          "what happened, the other a plan that has not been made. An unpriced collection row " +
          "is a card whose worth is unknown; an unpriced **wish** is a card nobody will quote a " +
          "price to *buy*. And the `finish` dimension has a fifth bucket here — `Any finish`, a " +
          "wish that names no finish, which a collection row can never be.\n\n" +
          "**Each bar is one `sr-only` sentence over an `aria-hidden` drawing**, which is the " +
          "deck stats band's standing rule and the reason there is no `role=\"img\"` and no " +
          "chart library. Every play below reads those sentences.\n\n" +
          "**The denominator is the caller's** — the list's own total, so a bar means the same " +
          "thing whichever slice is on screen. A max taken across the drawn rows would silently " +
          "rescale every bar when the reader switched dimension.\n\n" +
          "**A stored dimension is narrowed against the four words that exist** (`readDimension`), " +
          "because `widgetConfig` compares by `typeof` and a stored `dimension: \"bogus\"` is a " +
          "string that passes. Sent on, it would reach `wishlist_breakdown`'s `match` arms and " +
          "come back as a refusal — a card that reads as broken because of a word nobody can see.",
      },
    },
  },
} satisfies Meta<typeof WishlistValueWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The seeded wishlist, sliced by rarity — eight wishes over fourteen copies costing `$246.53`.
 *
 * Two of the four buckets are worth reading together. `Common` is the money (`$140.48` over two
 * copies), and `Rare` is the **hole**: one copy the marketplace will not quote a price to buy
 * at, which draws an em dash and says so in words rather than reading as `$0.00`. That is the
 * sentence this widget exists as its own file for — a collection row with the same hole is a
 * card whose *worth* is unknown, which is a different thing to say.
 *
 * The plurals are the other half of the pair: `2 copies` against `1 copy`, which is the kind of
 * wrong only a screen reader ever meets.
 */
export const ByRarity: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist value" }));

    await expect(
      await card.findByText("Common: 2 copies, $140.48, 57% of the total."),
    ).toBeInTheDocument();
    // The unpriced arm — the wishlist's own sentence, naming the marketplace it could not be
    // quoted at, and never a percentage of a total it contributes nothing to.
    await expect(
      card.getByText("Rare: 1 copy, no price to buy at TCGplayer."),
    ).toBeInTheDocument();
    // The figure's note is about the copies rather than the wishes: a sum that quietly omitted
    // them would read as a shorter list rather than as an incomplete price.
    await expect(card.getByText("1 copy nobody quotes a price for")).toBeInTheDocument();
  },
};

/**
 * A stored `dimension` this build has never heard of, narrowed at the edge.
 *
 * `readDimension` falls back to Rarity, so the chart is merely not the one somebody's other
 * build chose — which is the whole difference between a widget that draws and one that hands
 * the reader a refusal about a word they cannot see. On screen this is {@link ByRarity}, and
 * that is the claim.
 */
export const AConfigThisBuildCannotRead: Story = {
  args: {
    widget: {
      id: "wishlistValue",
      kind: "wishlistValue",
      span: 1,
      config: { dimension: "bogus" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist value" }));
    await expect(
      card.getByRole("button", { name: "Break down wishlist value by" }),
    ).toHaveTextContent("Rarity");
    await expect(
      await card.findByText("Common: 2 copies, $140.48, 57% of the total."),
    ).toBeInTheDocument();
  },
};

/**
 * A wishlist nobody has put anything on.
 *
 * **The wishlist's sentence, not the collection's**: nothing is owned or unowned here, and an
 * empty wishlist is a plan nobody has made yet. The figure goes with the bars rather than
 * standing over them at `$0.00`, because a total cost of nothing is a number nobody quoted.
 */
export const NothingWishedFor: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist value" }));
    await expect(
      await card.findByText("You want nothing yet — wish for a card and its cost lands here."),
    ).toBeInTheDocument();
    await expect(card.queryByText(/of the total\./)).not.toBeInTheDocument();
  },
};

/**
 * Customize on: the tray, and the dimension picker that stays drawn in **both** modes.
 *
 * `WidgetCardProps.actions` is the widget's own control and is what the card is *about*, so it
 * is not an affordance for rearranging the page and does not come and go with edit mode. The
 * tray beside it is the page's.
 */
export const Customizing: Story = {
  args: { editing: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Wishlist value" }));
    await expect(
      card.getByRole("button", { name: "Break down wishlist value by" }),
    ).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Move Wishlist value" })).toBeInTheDocument();
    await expect(card.getByRole("button", { name: "Full width, Wishlist value" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(card.getByRole("button", { name: "Remove Wishlist value" })).toBeInTheDocument();
  },
};
