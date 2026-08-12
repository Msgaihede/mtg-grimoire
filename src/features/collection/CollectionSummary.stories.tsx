import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import type { CollectionSummary } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { formatPrice } from "@/lib/prices";
import { CollectionSummaryHeader } from "./CollectionSummary";

/**
 * A complete answer, which every story below varies one field of.
 *
 * The numbers are illustrative, not measured: this component takes a DTO and formats it, and
 * nothing about what it draws depends on the figures being a real collection's. What each
 * story is about is which *shape* of answer it is holding.
 */
const SUMMARY: CollectionSummary = {
  totalCards: 1284,
  uniqueCards: 742,
  entries: 806,
  tradelistCards: 0,
  valueUsd: 4182.55,
  valueEur: 3640.18,
  unpricedUsd: 0,
  unpricedEur: 0,
  needsReview: 0,
};

const meta = {
  title: "Collection/SummaryHeader",
  component: CollectionSummaryHeader,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "What the collection adds up to: three figures in the data face, with no colour " +
          "and no chrome, plus a fourth when there is a tradelist. **One Value figure, in " +
          "the marketplace the reader picked** — it drew `Value (USD)` and `Value (EUR)` " +
          "side by side while there was no way to *say* which one you wanted, and two totals " +
          "for one collection is two answers to the question this row exists to answer. It " +
          "reads **six of the nine fields** of a `CollectionSummary`, and the pair it does " +
          "not read is the other currency's: `entries` is read by no component in the app at " +
          "all, and `needsReview` belongs to `CollectionPage`, which draws the " +
          "flagged-entries banner *below* this row. The value carries the as-of sentence as " +
          "a `title` because spec §5 requires every price on screen to say how old it is — " +
          "and, with five marketplaces in the picker, whose it is.",
      },
    },
  },
} satisfies Meta<typeof CollectionSummaryHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * `summary` is `undefined` while the first answer is in flight, and every figure is an em dash.
 *
 * **Never a zero**, and the two are a sentence apart: a collection that briefly claims to be
 * worth nothing is a worse thing to say than one that has not said yet, and a reader who
 * glances once cannot tell them apart. The `play` is what pins it — three dashes, no zero
 * anywhere, and no "For trade" figure, because a tradelist count nobody has yet is not a
 * count of none.
 */
export const Loading: Story = {
  args: { summary: undefined, marketplace: MARKETPLACES.tcgplayer },
  play: async ({ canvasElement }) => {
    const values = [...canvasElement.querySelectorAll("dd")].map((dd) => dd.textContent);
    await expect(values).toEqual(["—", "—", "—"]);
    await expect(within(canvasElement).queryByText("For trade")).toBeNull();
  },
};

/**
 * The ordinary answer: everything priced, nothing for trade.
 *
 * The `play` covers the figure that is *not* drawn. "For trade — 0" is a permanent column of
 * chrome that has never once been the answer to anything, so the fourth figure is present only
 * when there is a tradelist; absence is not something a screenshot can be read for.
 */
export const Full: Story = {
  args: { summary: SUMMARY, marketplace: MARKETPLACES.tcgplayer },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("dd")).toHaveLength(3);
    await expect(within(canvasElement).queryByText("For trade")).toBeNull();
  },
};

/**
 * The same collection, quoted on Cardmarket.
 *
 * The whole of what the marketplace setting does to this row, and the reason `valueEur` is on
 * the DTO at all: **the same query answer, a different field read**. Switching is a re-render
 * off the cache the page already has — no refetch, no spinner, no gap — and the label moves
 * with the figure, because a bare "Value" over a number that changes denomination in Settings
 * is a number with no units.
 */
export const InEuros: Story = {
  args: { summary: SUMMARY, marketplace: MARKETPLACES.cardmarket },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Value (EUR)")).toBeInTheDocument();
    await expect(canvas.getByText(formatPrice(SUMMARY.valueEur, "eur"))).toBeInTheDocument();
    // The dollar total is not on screen at all — one answer, not two.
    await expect(canvas.queryByText(formatPrice(SUMMARY.valueUsd, "usd"))).toBeNull();
  },
};

/**
 * An empty collection, which is **not** the same state as `Loading` and must not look like it.
 *
 * Every field is genuinely zero, so every figure says zero — `$0.00` is a price nobody quoted
 * only when it is standing in for an unknown, and here it is the answer. This story exists
 * beside `Loading` precisely because those two are the pair a reader could confuse, and the
 * `play` asserts the thing that separates them: no em dash survives anywhere in this row.
 */
export const Empty: Story = {
  args: {
    summary: {
      totalCards: 0,
      uniqueCards: 0,
      entries: 0,
      tradelistCards: 0,
      valueUsd: 0,
      valueEur: 0,
      unpricedUsd: 0,
      unpricedEur: 0,
      needsReview: 0,
    },
    marketplace: MARKETPLACES.tcgplayer,
  },
  play: async ({ canvasElement }) => {
    const values = [...canvasElement.querySelectorAll("dd")].map((dd) => dd.textContent);
    await expect(values).not.toContain("—");
    // Through `usdPrice` rather than a literal, so the assertion cannot drift the day the
    // formatter's locale data does — the claim is "a zero, drawn as a price", not a string.
    await expect(values).toContain(formatPrice(0, "usd"));
  },
};

/**
 * The copies the sum could not price, beside the sum.
 *
 * A total that silently omits 200 cards is a number that lies by rounding down, so the count
 * travels with the value — **and it is the count for the currency on screen**, which is why
 * Rust answers `unpricedUsd` and `unpricedEur` separately rather than one number.
 *
 * The two genuinely disagree, in both directions: **etched printings have no EUR price in
 * Scryfall's data at all** — `eur_etched` is documented and absent — so an etched copy can be
 * priced in USD and unpriced in EUR; and the reverse is just as real, with Black Lotus's Alpha
 * printing carrying `"eur": "38719.86"` against `usd`, `usd_foil` and `usd_etched` all null
 * (`.storybook/fake/cards.ts`, `lea 232`). A shared count would have to be wrong about
 * whichever figure it was not describing.
 */
export const WithUnpriced: Story = {
  args: {
    summary: { ...SUMMARY, unpricedUsd: 412, unpricedEur: 486 },
    marketplace: MARKETPLACES.tcgplayer,
  },
  play: async ({ canvasElement }) => {
    // The dollar count, because the dollar figure is the one beside it.
    await expect(within(canvasElement).getByText("412 unpriced")).toBeInTheDocument();
    await expect(within(canvasElement).queryByText("486 unpriced")).toBeNull();
  },
};

/** The same answer on Cardmarket, where the *other* count is the one that belongs. */
export const WithUnpricedInEuros: Story = {
  args: {
    summary: { ...SUMMARY, unpricedUsd: 412, unpricedEur: 486 },
    marketplace: MARKETPLACES.cardmarket,
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("486 unpriced")).toBeInTheDocument();
    await expect(within(canvasElement).queryByText("412 unpriced")).toBeNull();
  },
};

/**
 * The fourth figure, which only exists when there is something in it.
 *
 * Copies, like `Cards` — the tradelist is a count of what is spare, not of how many rows say
 * so.
 */
export const WithTradelist: Story = {
  args: {
    summary: { ...SUMMARY, tradelistCards: 63 },
    marketplace: MARKETPLACES.tcgplayer,
  },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelectorAll("dd")).toHaveLength(4);
    await expect(within(canvasElement).getByText("For trade")).toBeInTheDocument();
  },
};
