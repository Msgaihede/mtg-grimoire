import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import type { MarketplaceState } from "@/lib/useMarketplace";
import { MarketplacePanel } from "./MarketplacePanel";

/**
 * What `useMarketplace` would have answered.
 *
 * The panel takes its state as a prop, so every story here is an argument — `ErrorLogPanel`'s
 * shape, and for its reason. `Settings/Page` is where the same panel is driven by a **seeded
 * world** through the real hook, which is where pressing a row actually writes `app_meta`.
 */
function state(over: Partial<MarketplaceState> = {}): MarketplaceState {
  return {
    marketplace: MARKETPLACES.tcgplayer,
    currency: "usd",
    select: fn(),
    selecting: false,
    error: null,
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
          "**All five are listed and two can be picked.** Scryfall's `prices` blob has six " +
          "keys — `usd`, `usd_foil`, `usd_etched`, `eur`, `eur_foil`, `tix` — so TCGplayer and " +
          "Cardmarket are the two this build can quote. Card Kingdom, Mana Pool and Card " +
          "trader each need their own feed, their own sync and their own way back to a " +
          "`scryfall_id`, and they are listed because a reader looking for one deserves to be " +
          "told the app knows it exists rather than left wondering.\n\n" +
          "**The three are `aria-disabled` and never `disabled`.** A `disabled` button leaves " +
          "the tab order, so a keyboard reader would find two rows where a sighted one sees " +
          "five — and would never meet the sentence saying why the other three are out. Each " +
          "row keeps its place, keeps saying whether it is the chosen one, carries its reason " +
          "as its accessible *description*, and ignores the press.\n\n" +
          "**A marketplace is a label; the currency is the axis.** Nothing downstream branches " +
          "on the id — every price function takes a `Currency` — which is why switching is a " +
          "re-render and not a refetch: Rust already returns both currencies on every priced " +
          "row.",
      },
    },
  },
} satisfies Meta<typeof MarketplacePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The panel as every install starts: TCGplayer, which is what every price in this app was
 * before the setting existed.
 *
 * The three without a feed sit in the same list rather than under a "coming later" heading —
 * they are answers to the question the reader came here with, and each one says what it is
 * waiting on.
 */
export const TCGplayerToday: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const chosen = canvas.getByRole("button", { name: "TCGplayer USD" });
    await expect(chosen).toHaveAttribute("aria-pressed", "true");

    // Out of reach, in the tab order, and explaining itself — the three halves of the rule.
    const kingdom = canvas.getByRole("button", { name: "Card Kingdom USD" });
    await expect(kingdom).toHaveAttribute("aria-disabled", "true");
    await expect(kingdom).not.toBeDisabled();
    await expect(kingdom).toHaveAccessibleDescription(/No price feed yet/);
    await userEvent.click(kingdom);
    await expect(args.marketplace.select).not.toHaveBeenCalled();

    await userEvent.click(canvas.getByRole("button", { name: "Cardmarket EUR" }));
    await expect(args.marketplace.select).toHaveBeenCalledWith("cardmarket");
  },
};

/**
 * The same panel with the other feed chosen — the whole visible difference the setting makes
 * *here*, and the reason it is worth storying beside {@link TCGplayerToday}.
 *
 * Everywhere else in the window the difference is a euro sign and a different number; on this
 * page it is which row is gold. Nothing else moves.
 */
export const CardmarketChosen: Story = {
  args: { marketplace: state({ marketplace: MARKETPLACES.cardmarket, currency: "eur" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Cardmarket EUR" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
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
