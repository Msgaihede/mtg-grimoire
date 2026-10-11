import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
import type { TradeSide } from "@/lib/ipc";
import { TradeSidePanel } from "./TradeSidePanel";
import { useTrade } from "./useTrades";

/**
 * One side of one of the seed's trades, read through the page's own hook — so a press in the
 * story writes to the fake and the panel redraws from the answer, as it does on the page.
 *
 * `stage` runs first when a story needs the world changed before it is drawn; see
 * `TradePage.stories`' `Staged` for why that is a query and not an effect.
 */
function Side({
  tradeId,
  side,
  onScan,
  onImport,
  onExport,
  stage,
}: {
  tradeId: number;
  side: TradeSide;
  onScan: (side: TradeSide, opener: HTMLElement) => void;
  onImport: (side: TradeSide, opener: HTMLElement) => void;
  onExport: (side: TradeSide, opener: HTMLElement) => void;
  stage?: () => Promise<unknown>;
}) {
  const staged = useQuery({
    queryKey: ["story", "side", tradeId, side, stage === undefined ? "plain" : "staged"],
    queryFn: async () => {
      await stage?.();
      return true;
    },
    staleTime: Infinity,
  });
  const trade = useTrade(staged.isSuccess ? tradeId : null);
  return trade.data ? (
    <TradeSidePanel
      trade={trade.data}
      side={side}
      onScan={onScan}
      onImport={onImport}
      onExport={onExport}
    />
  ) : null;
}

const meta = {
  title: "Trade/SidePanel",
  component: Side,
  tags: ["autodocs"],
  args: { tradeId: 5, side: "mine", onScan: fn(), onImport: fn(), onExport: fn() },
  argTypes: { stage: { control: false } },
  decorators: [
    // Half of the page's two-column grid at the design's width, and a height that makes the
    // list scroll on its own — which is the thing the panel's column is built to do.
    (Story) => (
      <div className="flex h-[560px] w-[560px] flex-col bg-bg p-5">
        <Story />
      </div>
    ),
  ],
  parameters: {
    fake: { seed: "trades" },
    docs: {
      story: { inline: false, height: "620px" },
      description: {
        component:
          "One side of a trade: its heading with a card count and a percentage, the row that " +
          "adds to it, and its lines.\n\n" +
          "**The two sides are not the same panel.** The reader's own has a scope on its add " +
          "field — *Collection*, which answers the printing and finish of the copies they hold, " +
          "or *All cards* — and marks the lines that came out of the collection. Their side " +
          "searches every card and marks the ones on the reader's wishlist.\n\n" +
          "**A copy that sits in a deck is offered apart and in red** ({@link CopiesInADeck}): " +
          "the add field lists it in a section of its own under the deck's name, and a line " +
          "that would take one out of a deck says how many and which deck.\n\n" +
          "**A line edits in place** — printing, finish, quantity, remove — and each control " +
          "writes at once. Closed ({@link Closed}) the same panel has two bands instead of " +
          "three and no controls at all.",
      },
    },
  },
} satisfies Meta<typeof Side>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The reader's side of the design's trade: four lines, all from the collection. The field opens
 * on *Collection*, and what it finds is counted — three Boros Charms held, two already here.
 */
export const YourSide: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "You give" });
    await expect(panel).toHaveTextContent("6 cards");
    // Each with the collection's count of its printing and finish (issue #935).
    await expect(within(panel).getAllByText(/^from your collection · \d+ owned$/)).toHaveLength(4);
    await expect(within(panel).getByRole("button", { name: "Collection" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await userEvent.type(within(panel).getByRole("combobox"), "boros charm");
    const row = await within(panel).findByRole("option", { name: /Boros Charm/ });
    await expect(row).toHaveTextContent("GTC 148 · Nonfoil · 3 owned · 2 in this trade");

    // Enter takes the first row: the line that was two copies is three, and the field is ready
    // for the next name.
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(panel).toHaveTextContent("7 cards"));
    await expect(within(panel).getByRole("combobox")).toHaveValue("");
    await expect(
      within(panel).getByRole("spinbutton", { name: "Quantity of Boros Charm" }),
    ).toHaveValue(3);
  },
};

/**
 * A card the reader also holds in a deck. The seed's Ragavan is one loose copy and one in
 * `Modern Goodstuff`, so the field answers it twice — once as any other card, and once under *In
 * your decks*, in the destructive colour, with the deck's name. The line gives one and wears the
 * gold mark; stepped to two, the second can only come out of the deck, and the mark turns red
 * and says which.
 */
export const CopiesInADeck: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "You give" });

    await userEvent.type(within(panel).getByRole("combobox"), "ragavan");
    const decks = await within(panel).findByRole("group", { name: "In your decks" });
    const inDeck = within(decks).getByRole("option", { name: /1 in Modern Goodstuff/ });
    await expect(inDeck).toHaveAttribute("data-place", "deck");
    // Under the copy outside every deck, never beside it: that one is first and is not in the
    // group.
    const [first] = within(panel).getAllByRole("option");
    await expect(first).toHaveTextContent("1 owned · 1 in this trade");
    await expect(decks).not.toContainElement(first);
    await expect(first).toHaveAttribute("aria-selected", "true");

    // Away from the field, so the list is put down and the line under it can be pressed.
    await userEvent.keyboard("{Escape}{Escape}");
    const line = within(panel)
      .getAllByRole("listitem")
      .find((item) => within(item).queryByText("Ragavan, Nimble Pilferer") !== null) as HTMLElement;
    await expect(line).toHaveTextContent("from your collection");
    await userEvent.click(
      within(line).getByRole("button", { name: "Increase Quantity of Ragavan, Nimble Pilferer" }),
    );
    await waitFor(() => expect(line).toHaveTextContent("1 from your deck Modern Goodstuff"));
    await expect(line).not.toHaveTextContent("from your collection");
  },
};

/**
 * Their side: no scope to choose, a placeholder that says so, and the two cards the reader has
 * been wanting marked in gold.
 */
export const TheirSide: Story = {
  args: { side: "theirs" },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "They give" });
    await expect(panel).toHaveTextContent("5 cards");
    await expect(within(panel).getAllByText("on your wishlist")).toHaveLength(2);
    await expect(within(panel).queryByText(/from your collection/)).not.toBeInTheDocument();
    await expect(within(panel).getByRole("combobox")).toHaveAttribute(
      "placeholder",
      "Add any card…",
    );
    await expect(
      within(panel).queryByRole("button", { name: "All cards" }),
    ).not.toBeInTheDocument();

    // The camera hands the page the side it belongs to and the button to give the caret back to.
    const camera = within(panel).getByRole("button", { name: "Scan cards onto their side" });
    await userEvent.click(camera);
    await expect(args.onScan).toHaveBeenCalledWith("theirs", camera);

    // Its own transfer pair (issue #903), which hands the page the side and the button the same way.
    const importButton = within(panel).getByRole("button", { name: "Import cards to their side" });
    await userEvent.click(importButton);
    await expect(args.onImport).toHaveBeenCalledWith("theirs", importButton);
    const exportButton = within(panel).getByRole("button", { name: "Export their side" });
    await userEvent.click(exportButton);
    await expect(args.onExport).toHaveBeenCalledWith("theirs", exportButton);
  },
};

/**
 * A line's own controls. The finish offers what the printing comes in, each with today's price;
 * picking one reprices the line before the backend has answered.
 */
export const EditingALine: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "You give" });

    await userEvent.click(within(panel).getByRole("button", { name: "Finish of Counterspell" }));
    const options = await canvas.findAllByRole("option");
    await expect(options.map((option) => option.textContent)).toEqual([
      "Nonfoil$2.95",
      "Foil$3.19",
      "Etched$3.25",
    ]);
    await userEvent.click(canvas.getByRole("option", { name: /^Foil/ }));

    // Two copies at the foil's $3.19.
    const line = within(panel)
      .getAllByRole("listitem")
      .find((item) => within(item).queryByText("Counterspell") !== null) as HTMLElement;
    await waitFor(() => expect(line).toHaveTextContent("$6.38"));
    await expect(line).toHaveTextContent("2 × $3.19");

    await userEvent.click(
      within(panel).getByRole("button", { name: "Remove Counterspell from the trade" }),
    );
    await waitFor(() => expect(panel).toHaveTextContent("4 cards"));
    await expect(within(panel).queryByText("Counterspell")).not.toBeInTheDocument();
  },
};

/**
 * A side priced at 80%. The button is gold, and each line says three things: what it is worth
 * here, what one copy is worth here, and what the line would be at full price.
 */
export const Rated: Story = {
  args: { side: "theirs", stage: () => ipc.tradeSetRate(5, "theirs", 80) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "They give" });
    await expect(
      within(panel).getByRole("button", { name: "Price for their cards: 80%" }),
    ).toHaveTextContent("80% of market");
    await expect(within(panel).getAllByText(/at 100%$/)).toHaveLength(4);
  },
};

/**
 * A side of a finished trade: no add row, no controls on the lines, and the percentage as plain
 * text. **Export is the one button left** — a closed trade is still a list somebody may want in a
 * file, and nothing may be put on it, so its pair has no Import.
 */
export const Closed: Story = {
  args: { tradeId: 2 },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const panel = await canvas.findByRole("region", { name: "You gave" });
    await expect(panel).toHaveTextContent("3 cards");
    await expect(panel).toHaveTextContent("100% of market");
    await expect(within(panel).queryByRole("combobox")).not.toBeInTheDocument();
    const exportButton = within(panel).getByRole("button", { name: "Export your side" });
    await expect(within(panel).getAllByRole("button")).toEqual([exportButton]);
    await userEvent.click(exportButton);
    await expect(args.onExport).toHaveBeenCalledWith("mine", exportButton);
  },
};
