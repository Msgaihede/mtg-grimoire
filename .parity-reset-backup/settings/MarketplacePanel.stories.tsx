import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { MARKETPLACES, type MarketplaceId } from "@/lib/marketplace";
import type { FeedInfo, FeedState, MarketplaceState } from "@/lib/useMarketplace";
import { MarketplacePanel } from "./MarketplacePanel";

/** A fixed instant every feed note below is read against — two hours ago, so a fresh feed
 *  reads "2 hours ago" rather than whatever the clock says when the catalogue is opened. */
const NOW = Math.floor(Date.now() / 1000);
const TWO_HOURS = 7_200;

/** One feed-backed marketplace's state, in the shape `useMarketplace` answers it. */
function feed(id: MarketplaceId, state: FeedState, over: Partial<FeedInfo> = {}): FeedInfo {
  return {
    marketplace: MARKETPLACES[id],
    state,
    status: {
      marketplace: id,
      fetchedAt: state === "never" ? null : NOW - TWO_HOURS,
      // Card Kingdom publishes `meta.created_at`; Mana Pool publishes nothing of the kind, and
      // `null` there is an absence rather than a value to invent.
      feedBuiltAt: id === "cardkingdom" ? "2026-08-11 21:07:02" : null,
      // `null` for a feed never fetched, and never `0`: "nothing downloaded" and "a fetch that
      // landed nothing" are two states, and only the first is one a first selection acts on.
      rowCount: state === "never" ? null : id === "cardkingdom" ? 149_989 : 102_321,
      // The backend's own two flags. `stale` is `REFRESH_INTERVAL_SECS`'s answer rather than
      // arithmetic on this side, and a never-fetched feed is stale by definition there.
      stale: state === "never" || state === "stale",
      refreshing: state === "fetching",
    },
    error: null,
    ...over,
  };
}

const BOTH_FRESH = [feed("cardkingdom", "fresh"), feed("manapool", "fresh")];

/**
 * What `useMarketplace` would have answered.
 *
 * The panel takes its state as a prop, so every story here is an argument — `ErrorLogPanel`'s
 * shape, and for its reason. `Settings/Page` is where the same panel is driven by a **seeded
 * world** through the real hook, which is where pressing a row actually writes `app_meta` and
 * a refresh actually rewrites `marketplace_prices`.
 */
function state(over: Partial<MarketplaceState> = {}): MarketplaceState {
  return {
    marketplace: MARKETPLACES.tcgplayer,
    currency: "usd",
    select: fn(),
    selecting: false,
    error: null,
    feeds: BOTH_FRESH,
    feed: null,
    refresh: fn(),
    refreshing: null,
    progress: null,
    ...over,
  };
}

const meta = {
  title: "Settings/MarketplacePanel",
  component: MarketplacePanel,
  tags: ["autodocs"],
  args: { marketplace: state() },
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window — because the
    // one layout risk here is a row whose reason wraps to a second line.
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Where every price in the window comes from.\n\n" +
          "**All five are listed and four can be picked.** TCGplayer and Cardmarket come out " +
          "of Scryfall's `prices` blob and arrive with the card data; Card Kingdom and Mana " +
          "Pool are public bulk feeds this app downloads and stores in `marketplace_prices`, " +
          "keyed by `scryfall_id` so the join is exact. Card trader is the one left out — its " +
          "API needs a per-user JWT and publishes no bulk list, so there is nothing to sync.\n\n" +
          "**The fifth is `aria-disabled` and never `disabled`.** A `disabled` button leaves " +
          "the tab order, so a keyboard reader would find four rows where a sighted one sees " +
          "five — and would never meet the sentence saying why the fifth is out. The row keeps " +
          "its place, keeps saying whether it is the chosen one, carries its reason as its " +
          "accessible *description*, and ignores the press.\n\n" +
          "**A feed-backed row says when its prices were pulled and offers a refresh**, and " +
          "Card Kingdom shows the marketplace's own build stamp beside it — two dates " +
          "answering two questions. Selecting a feed with no rows fetches it; a fetch that " +
          "fails leaves the previous prices in place, which is what its note says rather than " +
          "claiming the table is now empty.",
      },
    },
  },
} satisfies Meta<typeof MarketplacePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The panel as every install starts: TCGplayer, which is what every price in this app was
 * before the setting existed, with both downloaded feeds current.
 *
 * The one without a feed sits in the same list rather than under a "coming later" heading — it
 * is an answer to the question the reader came here with, and it says what it is waiting on.
 */
export const TCGplayerToday: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chosen = canvas.getByRole("button", { name: "TCGplayer USD" });
    await expect(chosen).toHaveAttribute("aria-pressed", "true");

    // Out of reach, in the tab order, and explaining itself — the three halves of the rule.
    const trader = canvas.getByRole("button", { name: "Card trader EUR" });
    await expect(trader).toHaveAttribute("aria-disabled", "true");
    await expect(trader).not.toBeDisabled();
    await expect(trader).toHaveAccessibleDescription(/No price feed yet/);
    await userEvent.click(trader);
    await expect(args.marketplace.select).not.toHaveBeenCalled();

    // A downloaded feed is selectable and dated; a synced one is selectable and says nothing.
    await expect(canvas.getByRole("button", { name: "Card Kingdom USD" })).toHaveAccessibleDescription(
      /Prices from 2 hours ago/,
    );
    await userEvent.click(canvas.getByRole("button", { name: "Card Kingdom USD" }));
    await expect(args.marketplace.select).toHaveBeenCalledWith("cardkingdom");
  },
};

/**
 * A downloaded marketplace chosen — the row that did not exist before this feature.
 *
 * Everywhere else in the window the difference is a different number under the same heading; on
 * this page it is which row is gold, plus the two dates only a feed has.
 */
export const CardKingdomChosen: Story = {
  args: {
    marketplace: state({ marketplace: MARKETPLACES.cardkingdom, feed: BOTH_FRESH[0] }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const row = canvas.getByRole("button", { name: "Card Kingdom USD" });
    await expect(row).toHaveAttribute("aria-pressed", "true");
    // Two dates, answering two questions: when this app asked, and when the feed was built.
    await expect(row).toHaveAccessibleDescription(/Prices from 2 hours ago/);
    await expect(row).toHaveAccessibleDescription(/built this list 2026-08-11 21:07:02/);
  },
};

/** The other Scryfall-backed feed, which has no download of its own and therefore no date. */
export const CardmarketChosen: Story = {
  args: { marketplace: state({ marketplace: MARKETPLACES.cardmarket, currency: "eur" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Cardmarket EUR" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(
      canvas.getByRole("button", { name: "Cardmarket EUR" }),
    ).not.toHaveAccessibleDescription();
  },
};

/**
 * Nothing downloaded yet — the state a fresh install is in, and the one selecting the row acts
 * on: choosing a feed with no rows fetches it rather than filling the window with em dashes.
 */
export const NeverFetched: Story = {
  args: {
    marketplace: state({
      feeds: [feed("cardkingdom", "never"), feed("manapool", "never")],
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Card Kingdom USD" })).toHaveAccessibleDescription(
      /No prices downloaded yet\. Choosing this marketplace fetches them\./,
    );
  },
};

/** 63.7 MiB coming down. The refresh control is out of reach while it runs — `aria-disabled`,
 *  so it keeps its place in the tab order like every other greyed control here. */
export const Fetching: Story = {
  args: {
    marketplace: state({
      feeds: [feed("cardkingdom", "fetching"), feed("manapool", "fresh")],
      refreshing: "cardkingdom",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Card Kingdom USD" })).toHaveAccessibleDescription(
      /Downloading the price list/,
    );
    await expect(
      canvas.getByRole("button", { name: "Refresh Card Kingdom prices" }),
    ).toHaveAttribute("aria-disabled", "true");
  },
};

/** A day old, which is Card Kingdom's own regeneration cadence — so this is the shortest
 *  interval at which asking again could tell the reader anything new. */
export const Stale: Story = {
  args: {
    marketplace: state({ feeds: [feed("cardkingdom", "stale"), feed("manapool", "fresh")] }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Card Kingdom USD" })).toHaveAccessibleDescription(
      /A refresh is due\./,
    );
  },
};

/**
 * The download failed — **and the prices from the last one are still on screen everywhere
 * else**, which is what the note has to say.
 *
 * A failed fetch never empties `marketplace_prices`: the backend refuses a feed that parses to
 * zero rows for exactly this reason, so an error page cannot wipe a working table. Stale prices
 * under an honest line beat no prices at all.
 */
export const Failed: Story = {
  args: {
    marketplace: state({
      feeds: [
        feed("cardkingdom", "failed", {
          error: "Card Kingdom's price feed could not be downloaded. It timed out after 30s.",
        }),
        feed("manapool", "fresh"),
      ],
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Card Kingdom USD" })).toHaveAccessibleDescription(
      /The last download failed\. Showing the prices from 2 hours ago\./,
    );
    await expect(canvas.getByRole("alert")).toHaveTextContent(/timed out/);
  },
};

/**
 * The write refused — a sync holding the database's write lock when the press landed.
 *
 * `role="alert"` because it arrives *after* the reader is looking at the panel, unlike every
 * row above it. The choice does not move: nothing was written, so nothing here pretends it
 * was.
 */
export const Refused: Story = {
  args: {
    marketplace: state({
      error: "The card database is busy finishing a sync. Try that again in a moment.",
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent(/busy finishing a sync/);
    await expect(canvas.getByRole("button", { name: "TCGplayer USD" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  },
};
