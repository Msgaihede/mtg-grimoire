import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { CollectionValueWidget } from "./CollectionValueWidget";

/** How long a play waits on a freshly opened `Dropdown` panel. Seconds-scale, because the panel
 *  mounts on the press and its rows arrive a commit or two later; a plain `const`, because CSF
 *  indexes every non-default export as a story. */
const POPOVER_TIMEOUT = { timeout: 5_000 };

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
  title: "Home/CollectionValueWidget",
  component: CollectionValueWidget,
  tags: ["autodocs"],
  args: {
    // The default layout's entry: one column, no config — which is what opens on Rarity.
    widget: { id: "collectionValue", kind: "collectionValue", span: 1, config: null },
    ...CHROME,
  },
  decorators: [
    // One column of the wrapping row, at `WIDGET_CARD_BOX`'s 22rem floor plus a little. Eight
    // bars is what a card this wide holds without the labels truncating, which is what
    // `MAX_BARS` is sized for.
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
          "What the collection is worth, and **where the money is** — one total, and one bar " +
          "per bucket of whichever dimension the reader picked.\n\n" +
          "**A `Track` chart and deliberately not a `BarChart`**, which is the one place this " +
          "widget departs from the deck stats band it borrows everything else from. " +
          "`BarChart` prints `bar.count` on the fill verbatim, so money would appear as " +
          "`412.37` — unformatted, in no currency, beside a total saying `$412.37` — and its " +
          "bars are vertical, which puts a set name under a 40px column in a card whose floor " +
          "is 22rem. So the bars run across.\n\n" +
          "**The whole drawing is `aria-hidden` and each bar carries one `sr-only` sentence.** " +
          "That is the band's standing rule and the reason there is no `role=\"img\"` and no " +
          "chart library: the picture is decoration over numbers that are already text. It is " +
          "also why nothing here is a control — a bar is a `<span>`. Every play below reads " +
          "those sentences rather than the drawing.\n\n" +
          "**Ranked by value, biggest first, with the unpriced buckets last**, which is one " +
          "rule for four dimensions rather than four orderings: this widget answers *where is " +
          "the money*, so the order **is** the information — and it is what makes the fold " +
          "into `Other` honest, since what it folds away is always the smallest.\n\n" +
          "**`WishlistValueWidget` is this widget against the other list and is a separate " +
          "component on purpose.** The two lists' empty states and price notes are different " +
          "sentences about different things, and the day one of them grows a third figure is " +
          "the day a shared component grows a flag.",
      },
    },
  },
} satisfies Meta<typeof CollectionValueWidget>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The seeded collection, sliced by rarity — the dimension a widget that has never been
 * configured opens on.
 *
 * Rarity rather than set, because it is the one cut whose buckets are the same handful for every
 * reader: a first launch showing five bars says what the widget is, where a first launch showing
 * eight set codes out of six hundred says what one collection happens to hold.
 *
 * Measured off the seed (`collection_breakdown` at TCGplayer): common $620.00 over one card,
 * rare $256.50 over eleven, special $164.95, mythic $42.19, uncommon $17.64 over seven —
 * summing to the `$1,101.28` in the figure above them, which is the property the ranking and
 * the fold both have to preserve.
 *
 * The `play` reads two sentences, and the pair is deliberate: `1 card` against `11 cards` is the
 * singular nothing else in this repository would notice, because `1 cards` is the kind of wrong
 * only a screen reader ever meets.
 */
export const ByRarity: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Collection value" }));

    // The bar the money is in, and the one the cards are in — the largest bucket by value is a
    // single card, which is exactly the reading this widget exists to give.
    await expect(
      await card.findByText("1 card of Common rarity, worth $620.00, 56% of the total"),
    ).toBeInTheDocument();
    await expect(
      card.getByText("11 cards of Rare rarity, worth $256.50, 23% of the total"),
    ).toBeInTheDocument();
  },
};

/**
 * A `config` this build cannot read — `dimension: "bogus"`, which is a **string** and therefore
 * passes `widgetConfig`'s shape check untouched.
 *
 * ⚠️ **`widgetConfig` checks shapes and cannot check a vocabulary**, so the narrowing is the
 * widget's own and happens once, at the edge. Sent on, `bogus` would reach
 * `collection_breakdown`'s four `match` arms and come back as a refusal — a card that reads as
 * broken because of a word nobody can see. Falling back to Rarity instead draws a chart that is
 * merely not the one somebody's other build chose, which is why this story is byte-for-byte
 * {@link ByRarity} on screen and is worth having anyway.
 */
export const AConfigThisBuildCannotRead: Story = {
  args: {
    widget: {
      id: "collectionValue",
      kind: "collectionValue",
      span: 1,
      config: { dimension: "bogus" },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Collection value" }));
    // The picker fell back rather than showing a word it cannot offer.
    await expect(card.getByRole("button", { name: "Collection value by" })).toHaveTextContent(
      "Rarity",
    );
    await expect(
      await card.findByText("1 card of Common rarity, worth $620.00, 56% of the total"),
    ).toBeInTheDocument();
  },
};

/**
 * The picker, opened — four dimensions in `sortOptions`' order rather than the record's.
 *
 * The control is named `Collection value by` and never a bare `Dimension`: the wishlist's twin
 * is drawn on the same page, and two controls sharing one accessible name is a name that
 * identifies neither.
 */
export const ChoosingTheCut: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Collection value" }));

    await userEvent.click(card.getByRole("button", { name: "Collection value by" }));
    await waitFor(async () => {
      await expect(card.getAllByRole("option").map((row) => row.textContent)).toEqual([
        "Color",
        "Finish",
        "Rarity",
        "Set",
      ]);
    }, POPOVER_TIMEOUT);
  },
};

/**
 * A database with nothing in it — and the figures still draw.
 *
 * **The figures are not the bars**, which is what this story is about: `Value` and `Cards` are
 * the whole collection's answer and are honest at zero, so the empty state replaces the chart
 * and nothing else. The sentence is the *collection's* — you own nothing yet — and the
 * wishlist's twin says something different about the same hole.
 */
export const NothingOwnedYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = within(await canvas.findByRole("region", { name: "Collection value" }));
    await expect(await card.findByText("Nothing in your collection yet.")).toBeInTheDocument();
    // No bar says "0 cards of Common rarity": a bucket with nothing in it is a bucket the
    // backend never answered with, and inventing one would be a chart about nothing.
    await expect(card.queryByText(/of Common rarity/)).not.toBeInTheDocument();
  },
};
