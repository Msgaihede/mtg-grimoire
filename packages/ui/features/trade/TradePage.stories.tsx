import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
import { TradePage } from "./TradePage";

/**
 * The page over a world a story changed first, **through the commands** — `WishlistPage.stories`'
 * `Staged`, for its reasons: it runs once, it is cached in the story's own client, and
 * `staleTime: Infinity` keeps a window refocus from staging it a second time.
 */
function Staged({ stageKey, stage }: { stageKey: string; stage: () => Promise<unknown> }) {
  const staged = useQuery({
    queryKey: ["story", stageKey],
    queryFn: async () => {
      await stage();
      return true;
    },
    staleTime: Infinity,
  });
  return staged.isSuccess ? <TradePage /> : null;
}

const meta = {
  title: "Trade/Page",
  component: TradePage,
  tags: ["autodocs"],
  decorators: [
    // **This box stands in for `AppShell`'s `main`**: the page is `h-full`, so it needs a parent
    // with a height, and `main` is where its 20px of padding comes from. 1232px is the content
    // column of the window the design is drawn at — 1440 less the rail's 208 — and the height is
    // that window's 900 less the title bar and the ribbon.
    (Story) => (
      <div className="relative h-[760px] w-[1232px] overflow-auto bg-bg p-5">
        <Story />
      </div>
    ),
  ],
  parameters: {
    fake: { seed: "trades" },
    docs: {
      // A frame each: the page opens dialogs, which are `fixed` and would otherwise cover the
      // whole docs page rather than the story that opened them.
      story: { inline: false, height: "780px" },
      description: {
        component:
          "The Trade view: every trade the reader keeps on the left, and one of them beside " +
          "it — two sides, a percentage of market price for each, and the balance between " +
          "them.\n\n" +
          "Driven end to end by `packages/fake/`'s `trades` seed, which is `starter` plus five " +
          "trades in every state the page has to draw. **Trade 5 is the design's own**: four " +
          "lines a side, $64.39 against $87.09, so the reader owes $22.70 — and every figure " +
          "on screen is arithmetic `trade.ts` does on the prices the fake's corpus quotes, " +
          "never a number written into a fixture.\n\n" +
          "**There is no Save.** Every control writes as it is pressed, and each refusal is " +
          "drawn where it was earned: on the line, under the add field, under the trade's " +
          "name.\n\n" +
          "**Open and closed are one page.** {@link Finished} and {@link ArchivedUnfinished} " +
          "are the same three bands with the controls taken out and a sentence saying why, " +
          "which is what keeps *Finish trade* from being a navigation.",
      },
    },
  },
} satisfies Meta<typeof TradePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The page as a reader arrives at it: the newest open trade selected, both groups listed, each
 * entry stating its own balance. Stepping a quantity moves the line, the side's total, the
 * balance and the list entry together — one write, four figures.
 */
export const OpenTrade: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByRole("region", { name: "Trade 5" });
    const balance = within(section).getByRole("region", { name: "Balance" });

    await expect(balance).toHaveTextContent("You give$64.39");
    await expect(balance).toHaveTextContent("They give$87.09");
    await expect(within(balance).getByText("You owe them")).toBeVisible();
    await expect(within(balance).getByText("$22.70")).toBeVisible();

    const pane = canvas.getByRole("complementary", { name: "Trades" });
    await expect(within(pane).getByText("Open · 2")).toBeVisible();
    await expect(within(pane).getByText("Archived · 3")).toBeVisible();
    const entry = (name: RegExp) => within(pane).getByRole("button", { name });
    await expect(entry(/^Trade 5/)).toHaveAttribute("aria-current", "true");
    await expect(entry(/^Trade 5/)).toHaveTextContent("Opened 2 Oct · 6 for 5 cards");
    await expect(entry(/^Trade 5/)).toHaveTextContent("You owe $22.70");
    await expect(entry(/^Trade 4/)).toHaveTextContent("They owe you $6.10");
    await expect(entry(/^Store night swaps/)).toHaveTextContent("Even trade");
    await expect(entry(/^Trade 2/)).toHaveTextContent("They owed you $2.35");
    await expect(entry(/^Trade 1/)).toHaveTextContent("Archived 23 Aug · not finished");
    await expect(entry(/^Trade 1/)).toHaveTextContent("You owe $3.75");

    // A third Boros Charm at $5.84: the side is that much heavier, and the debt that much less.
    await userEvent.click(
      within(section).getByRole("button", { name: "Increase Quantity of Boros Charm" }),
    );
    await waitFor(() => expect(balance).toHaveTextContent("You give$70.23"));
    await expect(within(balance).getByText("$16.86")).toBeVisible();
    await waitFor(() => expect(entry(/^Trade 5/)).toHaveTextContent("You owe $16.86"));
    await expect(within(section).getByRole("region", { name: "You give" })).toHaveTextContent(
      "7 cards",
    );
  },
};

/**
 * Their side at 80% of market. The button is gold, every line on that side carries its full
 * price beside the adjusted one, and so does the side's total — a percentage never replaces a
 * figure, it stands beside it. The reader's side is untouched.
 */
export const TheirSideRated: Story = {
  render: () => <Staged stageKey="rate-theirs" stage={() => ipc.tradeSetRate(5, "theirs", 80)} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByRole("region", { name: "Trade 5" });
    const theirs = within(section).getByRole("region", { name: "They give" });
    const rate = within(theirs).getByRole("button", { name: "Price for their cards: 80%" });

    await expect(rate).toHaveTextContent("80% of market");
    await expect(
      within(section).getByRole("button", { name: "Price for your cards: 100%" }),
    ).toHaveTextContent("100% of market");

    // Each card is rounded at 80% on its own, and the side is the sum of those.
    const balance = within(section).getByRole("region", { name: "Balance" });
    await expect(balance).toHaveTextContent("$87.09 at 100%");
    await expect(within(theirs).getAllByText(/at 100%$/)).toHaveLength(4);
    await expect(
      within(within(section).getByRole("region", { name: "You give" })).queryByText(/at 100%$/),
    ).not.toBeInTheDocument();

    // The popover says the same two totals the panel does.
    await userEvent.click(rate);
    const popover = await within(theirs).findByRole("dialog", { name: "Price for their cards" });
    await expect(within(popover).getByRole("slider")).toHaveValue("80");
    await expect(popover).toHaveTextContent("At 100%$87.09");
    await expect(popover).toHaveTextContent("At 80%");
  },
};

/**
 * A finished trade, opened from the Archived group. The headings and the balance are in the past
 * tense, the banner says what the finish did, and there is nothing left to press but Duplicate,
 * Reopen and More.
 */
export const Finished: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Trade 5" });
    await userEvent.click(canvas.getByRole("button", { name: /^Trade 2/ }));

    const section = await canvas.findByRole("region", { name: "Trade 2" });
    await expect(section).toHaveTextContent(
      "Finished and archived, so nothing here can be edited. Finishing it took 3 cards out of " +
        "your collection, added 3 cards to your collection and took 1 card off your wishlist.",
    );
    await expect(within(section).getByRole("region", { name: "You gave" })).toBeVisible();
    await expect(within(section).getByRole("region", { name: "They gave" })).toBeVisible();
    // The prices it closed with: 7.18 against 4.83.
    await expect(within(section).getByText("They owed you")).toBeVisible();
    await expect(within(section).getByText("$2.35")).toBeVisible();

    await expect(within(section).queryByRole("combobox")).not.toBeInTheDocument();
    await expect(within(section).queryByRole("spinbutton")).not.toBeInTheDocument();
    await expect(
      within(section).queryByRole("button", { name: "Finish trade" }),
    ).not.toBeInTheDocument();
    await expect(within(section).getByRole("button", { name: "Duplicate" })).toBeVisible();
    await expect(within(section).getByRole("button", { name: "Reopen" })).toBeVisible();
  },
};

/**
 * A trade put away without finishing. Nothing changed hands, so nothing is in the past tense:
 * the sides still read *You give* and *They give*, and the balance is still owed.
 */
export const ArchivedUnfinished: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole("region", { name: "Trade 5" });
    await userEvent.click(canvas.getByRole("button", { name: /^Trade 1/ }));

    const section = await canvas.findByRole("region", { name: "Trade 1" });
    await expect(section).toHaveTextContent(
      "Archived without finishing, so nothing here can be edited.",
    );
    await expect(within(section).getByRole("region", { name: "You give" })).toBeVisible();
    await expect(within(section).getByText("You owe them")).toBeVisible();
    await expect(within(section).getByText("$3.75")).toBeVisible();
  },
};

/**
 * The Finish dialog over the design's trade. Three steps on and one off, and under each the
 * sentence that says what it will actually move here: all six given cards are in the collection,
 * and two of the five received are on the wishlist, by name.
 */
export const FinishDialog: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByRole("region", { name: "Trade 5" });
    await userEvent.click(within(section).getByRole("button", { name: "Finish trade" }));

    const dialog = await canvas.findByRole("dialog", { name: "Finish trade" });
    const box = (name: string) => within(dialog).getByRole("checkbox", { name });
    await expect(box("Take the cards you gave out of your collection")).toBeChecked();
    await expect(box("Add the cards you received to your collection")).toBeChecked();
    await expect(box("Take the cards you received off your wishlist")).toBeChecked();
    await expect(box("Put the cards you gave on your wishlist")).not.toBeChecked();

    await expect(
      box("Take the cards you gave out of your collection"),
    ).toHaveAccessibleDescription("6 cards. All of them are in your collection.");
    await expect(
      box("Add the cards you received to your collection"),
    ).toHaveAccessibleDescription("5 cards, in the printing and finish shown in the trade.");
    await expect(
      box("Take the cards you received off your wishlist"),
    ).toHaveAccessibleDescription("2 of them are on it: Urza's Saga, Tarmogoyf.");
    await expect(dialog).toHaveTextContent("You give$64.396 cards");
    await expect(dialog).toHaveTextContent("They give$87.095 cards");
  },
};

/**
 * Finishing, end to end over the fake: the dialog closes on the same page gone read-only, the
 * banner says what moved, and the trade is in the Archived group.
 */
export const FinishingATrade: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const section = await canvas.findByRole("region", { name: "Trade 5" });
    await userEvent.click(within(section).getByRole("button", { name: "Finish trade" }));
    const dialog = await canvas.findByRole("dialog", { name: "Finish trade" });
    await userEvent.click(within(dialog).getByRole("button", { name: "Finish trade" }));

    await waitFor(() =>
      expect(canvas.queryByRole("dialog", { name: "Finish trade" })).not.toBeInTheDocument(),
    );
    await expect(await within(section).findByRole("button", { name: "Reopen" })).toBeVisible();
    // Six out, five in, and the two that were wished for are no longer wished for.
    await expect(section).toHaveTextContent(
      "Finishing it took 6 cards out of your collection, added 5 cards to your collection " +
        "and took 2 cards off your wishlist.",
    );
    const pane = canvas.getByRole("complementary", { name: "Trades" });
    await waitFor(() => expect(within(pane).getByText("Open · 1")).toBeVisible());
    await expect(within(pane).getByText("Archived · 4")).toBeVisible();
    await expect(within(pane).getByRole("button", { name: /^Trade 5/ })).toHaveTextContent(
      "You owed $22.70",
    );
  },
};

/**
 * Nothing yet: the `starter` world, which has no trades. The page says what a trade is in one
 * sentence and offers the one control that starts one — and the trade it creates is selected.
 */
export const Empty: Story = {
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("No trades yet")).toBeVisible();
    await expect(canvas.queryByRole("complementary", { name: "Trades" })).not.toBeInTheDocument();

    await userEvent.click(canvas.getByRole("button", { name: "New trade" }));
    const dialog = await canvas.findByRole("dialog", { name: "New trade" });
    await expect(within(dialog).getByRole("button", { name: "Prices from" })).toHaveTextContent(
      "TCGplayer",
    );
    await userEvent.click(within(dialog).getByRole("button", { name: "Create trade" }));

    const section = await canvas.findByRole("region", { name: "Trade 1" });
    // The balance's, not the list's: the trade's region is the page since its bar spans the
    // trade list too, and the list's row for this trade says "Even trade" as well.
    const balance = within(section).getByRole("region", { name: "Balance" });
    await expect(within(balance).getByText("Even trade")).toBeVisible();
    await expect(within(section).getAllByText(/^Nothing on this side yet\./)).toHaveLength(2);
  },
};
