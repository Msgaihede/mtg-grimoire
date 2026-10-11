import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { TradePage } from "./TradePage";

/**
 * Trade on the phone face, in a box as tall as the page between a phone's two bars — the title
 * row above it and the tab bar under it are `Phone/Shell`'s.
 *
 * **Over the `trades` seed**: five trades, two of them open. `Trade 5` is the design's own — four
 * lines against four, 64.39 against 87.09 — so every figure a story draws is one the canvas draws.
 *
 * **Rows and the way back are real links**, so a press in the canvas would move the workbench's
 * own frame to `/trade/5`. The decorator swallows a press on a link in the capture phase —
 * `Phone/TabBar`'s arrangement, narrowed to links: a checkbox's default is its tick, and the
 * Finish sheet has four.
 *
 * **Each docs story has a frame of its own**: the page opens sheets, which cover the window they
 * are in.
 */
const meta = {
  title: "Phone/Trade",
  component: TradePage,
  tags: ["autodocs"],
  args: { tradeId: 5 },
  decorators: [
    (Story) => (
      <div
        className="flex h-[40rem] w-full flex-col overflow-hidden bg-bg text-text"
        onClickCapture={(event) => {
          if ((event.target as Element).closest("a") !== null) event.preventDefault();
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    fake: { seed: "trades" },
    docs: {
      story: { inline: false, height: "660px" },
      description: {
        component:
          "The desktop Trade page's parts in the phone's idioms: a list of trades, then one " +
          "trade as two columns with both totals, the balance and Finish trade above the tab " +
          "bar. Adding, editing a line, a side's percentage, finishing and New trade are bottom " +
          "sheets. Every figure is `trade.ts`'s and every write `useTradeWrites`'.",
      },
    },
  },
} satisfies Meta<typeof TradePage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Every trade the reader keeps: the open ones, then the ones put away — finished or archived
 * without finishing, which the second line of each row tells apart. Each row states its balance,
 * in the past tense only where the cards actually changed hands.
 */
export const List: Story = {
  args: { tradeId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const open = await canvas.findByRole("region", { name: "Open · 2" });
    await expect(within(open).getAllByRole("link")).toHaveLength(2);
    await expect(
      within(open).getByRole("link", {
        name: "Trade 5. Opened 2 Oct · 6 for 5 cards. You owe $22.70",
      }),
    ).toHaveAttribute("href", "/trade/5");
    const archived = canvas.getByRole("region", { name: "Archived · 3" });
    await expect(
      within(archived).getByRole("link", {
        name: "Trade 1. Archived 23 Aug · not finished. You owe $3.75",
      }),
    ).toBeInTheDocument();
  },
};

/** No trades yet: one sentence, and the press that makes the first. */
export const NoTrades: Story = {
  args: { tradeId: null },
  parameters: { fake: { seed: "starter" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("No trades yet.")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "New trade" })).toBeInTheDocument();
  },
};

/**
 * New trade, from the list: an optional name — its placeholder is the likeliest default — and
 * whose prices the trade uses, opening on the reader's own marketplace. The two marketplaces whose
 * prices are downloads are offered only while the app is set to one of them, and the sheet says
 * so in words under the picker.
 */
export const NewTrade: Story = {
  args: { tradeId: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "New trade" }));
    const sheet = await canvas.findByRole("dialog", { name: "New trade" });
    await expect(within(sheet).getByRole("textbox", { name: "Name" })).toHaveAttribute(
      "placeholder",
      "Trade 6",
    );
    await expect(within(sheet).getByRole("button", { name: "Prices from" })).toHaveTextContent(
      "TCGplayer",
    );
    await expect(within(sheet).getByRole("list", { name: "Not offered" })).toHaveTextContent(
      "Switch the app to Card Kingdom in Settings to trade in its prices.",
    );
    await expect(within(sheet).getByRole("button", { name: "Create trade" })).toBeInTheDocument();
  },
};

/**
 * An open trade: the reader's side and theirs, each line a press that opens its sheet, `Add cards`
 * under each column, and the foot — both totals, who owes whom, the bar, and `Finish trade`.
 */
export const OpenTrade: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const mine = await canvas.findByRole("region", { name: "You give" });
    await expect(within(mine).getAllByRole("listitem")).toHaveLength(4);
    await expect(
      within(mine).getByRole("button", { name: "Edit Counterspell, MH2 267 · Etched" }),
    ).toHaveTextContent("2 × $3.25");
    const foot = canvas.getByRole("region", { name: "Balance" });
    await expect(foot).toHaveTextContent("$64.39");
    await expect(foot).toHaveTextContent("$87.09");
    await expect(foot).toHaveTextContent("You owe them");
    await expect(foot).toHaveTextContent("$22.70");
  },
};

/**
 * A side's percentage: one slider, 50 to 150 in fives, with the side at 100% and at the value
 * under the thumb. The figures follow the drag; the trade is written when the reader lets go.
 */
export const Percentage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Price for their cards: 100%" }),
    );
    const sheet = await canvas.findByRole("dialog", { name: "Price their cards at" });
    const slider = within(sheet).getByRole("slider", { name: "Percent of market price" });
    await fireEvent.change(slider, { target: { value: "80" } });
    await expect(within(sheet).getByText("Their side at 80%")).toBeInTheDocument();
    await expect(sheet).toHaveTextContent("$69.67");
  },
};

/**
 * Their side at 80%: every line and the side's total show the adjusted figure with the full one
 * beside it, dimmed, and the chip that opens the slider turns gold.
 */
export const RatedSide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Price for their cards: 100%" }),
    );
    const sheet = await canvas.findByRole("dialog", { name: "Price their cards at" });
    await fireEvent.change(within(sheet).getByRole("slider"), { target: { value: "80" } });
    await userEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(canvas.queryByRole("dialog")).toBeNull());
    const bolt = await canvas.findByRole("button", {
      name: "Edit Lightning Bolt, STA 105 · Foil",
    });
    await waitFor(() => expect(bolt).toHaveTextContent("$23.85 at 100%"));
    await expect(canvas.getByRole("region", { name: "Balance" })).toHaveTextContent(
      "$87.09 at 100%",
    );
  },
};

/**
 * A line, opened: the copies, a chip for each finish the printing comes in with that finish's
 * price, the printing, the move to the other side, and the removal.
 */
export const EditLine: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Edit Lightning Bolt, STA 105 · Foil" }),
    );
    const sheet = await canvas.findByRole("dialog", { name: "Lightning Bolt" });
    await expect(within(sheet).getByLabelText("Copies")).toHaveTextContent("1");
    const finishes = within(sheet).getByRole("group", { name: "Finish of Lightning Bolt" });
    await expect(within(finishes).getByRole("button", { name: "Foil $23.85" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(within(sheet).getByRole("button", { name: "Move to your side" })).toBeInTheDocument();
    await expect(within(sheet).getByRole("button", { name: "Remove from trade" })).toBeInTheDocument();
  },
};

/** The line's printings, as a page of its sheet: the card sheet's rows, at the trade's prices. */
export const EditPrinting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole("button", { name: "Edit Lightning Bolt, STA 105 · Foil" }),
    );
    const sheet = await canvas.findByRole("dialog", { name: "Lightning Bolt" });
    await userEvent.click(within(sheet).getByRole("button", { name: /^Printing/ }));
    const printings = await within(sheet).findByRole("list", { name: "Printings" });
    await expect(
      within(printings)
        .getAllByRole("button")
        .filter((row) => row.getAttribute("aria-current") === "true"),
    ).toHaveLength(1);
  },
};

/**
 * Add cards to the reader's own side: the collection first, each row a printing in the finish
 * they hold it in, with how many they own and how many this trade already has.
 */
export const AddCards: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add cards to your side" }));
    const sheet = await canvas.findByRole("dialog", { name: "Add cards" });
    await expect(within(sheet).getByRole("button", { name: "Collection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await userEvent.type(
      within(sheet).getByRole("searchbox", { name: "Search your collection" }),
      "boros charm",
    );
    const add = await within(sheet).findByRole(
      "button",
      { name: "Add Boros Charm, GTC 148 · Nonfoil" },
      { timeout: 3000 },
    );
    await expect(add.closest("li")).toHaveTextContent("3 owned · 2 in this trade");
  },
};

/**
 * A card the reader also holds in a deck. The seed's Ragavan is one loose copy and one in
 * `Modern Goodstuff`, so the sheet lists it twice: with the others, and again under *In your
 * decks* — a section of its own, in the destructive colour, each row naming its deck.
 */
export const AddFromADeck: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Add cards to your side" }));
    const sheet = await canvas.findByRole("dialog", { name: "Add cards" });
    await userEvent.type(
      within(sheet).getByRole("searchbox", { name: "Search your collection" }),
      "ragavan",
    );
    const decks = await within(sheet).findByRole(
      "list",
      { name: "In your decks" },
      { timeout: 3000 },
    );
    await expect(
      within(decks).getByRole("button", {
        name: "Add Ragavan, Nimble Pilferer, MH2 138 · Nonfoil, from your deck Modern Goodstuff",
      }),
    ).toBeInTheDocument();
    await expect(within(decks).getByRole("listitem")).toHaveTextContent("1 in Modern Goodstuff");
    // The loose copy is in the list above, and not in this one.
    const ordinary = within(sheet).getByRole("list", { name: "Cards in your collection" });
    await expect(ordinary).toHaveTextContent("1 owned · 1 in this trade");
    await expect(ordinary).not.toHaveTextContent("Modern Goodstuff");
  },
};

/**
 * A line stepped past what the reader holds outside their decks. One Ragavan is loose and one is
 * sleeved, so the second copy can only come out of the deck: the sheet says so under the stepper,
 * in the destructive colour, and the line on the page behind it says the same.
 */
export const LineFromADeck: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const name = "Edit Ragavan, Nimble Pilferer, MH2 138 · Nonfoil";
    await userEvent.click(await canvas.findByRole("button", { name }));
    const sheet = await canvas.findByRole("dialog", { name: "Ragavan, Nimble Pilferer" });
    await expect(sheet).toHaveTextContent("Your side · from your collection");

    await userEvent.click(
      within(sheet).getByRole("button", { name: "One more Ragavan, Nimble Pilferer" }),
    );

    await expect(
      await within(sheet).findByText("1 from your deck Modern Goodstuff"),
    ).toBeVisible();
    await expect(sheet).not.toHaveTextContent("from your collection");
    await waitFor(() =>
      expect(canvas.getByRole("button", { name, hidden: true })).toHaveTextContent(
        "1 from your deck Modern Goodstuff",
      ),
    );
  },
};

/**
 * Finish trade: what the trade comes to, then the four questions, each with what it would move.
 * Three are on and one is off — a trade that was finished before opens with all four off.
 */
export const FinishTrade: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Finish trade" }));
    const sheet = await canvas.findByRole("dialog", { name: "Finish trade" });
    await expect(
      within(sheet)
        .getAllByRole("checkbox")
        .map((box) => (box as HTMLInputElement).checked),
    ).toEqual([true, true, true, false]);
    await expect(
      within(sheet).getByRole("checkbox", {
        name: "Take the cards you received off your wishlist",
      }),
    ).toHaveAccessibleDescription("2 of them are on it: Urza's Saga, Tarmogoyf.");
  },
};

/**
 * A finished trade: a record. The columns are headed in the past tense, the lines are not
 * presses, the note says what finishing did, and `Reopen` and `Duplicate` stand where `Archive`
 * and `Finish trade` did. Its prices are the ones it closed with.
 */
export const Finished: Story = {
  args: { tradeId: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "You gave" })).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /^Edit / })).toBeNull();
    await expect(canvas.queryByRole("button", { name: /^Add cards/ })).toBeNull();
    await expect(canvas.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Duplicate" })).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Balance" })).toHaveTextContent(
      "They owed you",
    );
  },
};

/**
 * Archived without finishing: read-only too, but nothing changed hands — so the columns keep the
 * present tense, and whoever owed still does.
 */
export const ArchivedUnfinished: Story = {
  args: { tradeId: 1 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole("region", { name: "You give" })).toBeInTheDocument();
    await expect(
      canvas.getByText(/^Archived without finishing, so nothing here can be edited\./),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("region", { name: "Balance" })).toHaveTextContent("You owe them");
  },
};

/** A trade the URL names that is not there: one sentence, and the way back to the list. */
export const Gone: Story = {
  args: { tradeId: 99 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText("That trade is gone.")).toBeInTheDocument();
    await expect(canvas.getByRole("link", { name: "All trades" })).toHaveAttribute("href", "/trade");
  },
};
