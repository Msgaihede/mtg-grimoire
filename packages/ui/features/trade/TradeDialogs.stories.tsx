import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { ipc } from "@/lib/ipc";
import { FinishTradeDialog } from "./FinishTradeDialog";
import { NewTradeDialog } from "./NewTradeDialog";
import { useTrade } from "./useTrades";

/**
 * Finish trade, open over one of the seed's trades and nothing else.
 *
 * The dialog is closed by its host, so the story is one: `finished` is what the page would do
 * with a finish that went through, said in a line the play can read.
 */
function Finish({ tradeId, stage }: { tradeId: number; stage?: () => Promise<unknown> }) {
  const staged = useQuery({
    queryKey: ["story", "finish", tradeId, stage === undefined ? "plain" : "staged"],
    queryFn: async () => {
      await stage?.();
      return true;
    },
    staleTime: Infinity,
  });
  const trade = useTrade(staged.isSuccess ? tradeId : null);
  const [open, setOpen] = useState(true);
  const [finished, setFinished] = useState(false);
  if (!trade.data) return null;
  return (
    <>
      <p role="status" className="p-4 text-sm text-dim">
        {finished ? "Finished." : open ? "" : "Closed without finishing."}
      </p>
      <FinishTradeDialog
        open={open}
        trade={trade.data}
        onFinished={() => {
          setFinished(true);
          setOpen(false);
        }}
        onDismiss={() => setOpen(false)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

const meta = {
  title: "Trade/Dialogs",
  component: Finish,
  tags: ["autodocs"],
  args: { tradeId: 5 },
  argTypes: { stage: { control: false } },
  parameters: {
    fake: { seed: "trades" },
    docs: {
      // A dialog is `fixed` to the window, so each story is a window of its own.
      story: { inline: false, height: "720px" },
      description: {
        component:
          "The two questions the Trade page asks in a dialog: what a finished trade should do " +
          "to the collection and the wishlist, and what a new trade is called and priced in.\n\n" +
          "**Finish trade says what each step will actually move.** A checkbox reading *Take " +
          "the cards you gave out of your collection* is a promise about six cards, and the " +
          "collection may hold four — so each of the four questions carries a sentence " +
          "computed from the same facts the backend acts on. Three are on by default and one " +
          "is off; a trade that was finished once and reopened opens with all four off " +
          "({@link FinishedBefore}). Where a given card would come out of a deck, the first " +
          "question says so under its count, in the destructive colour and with the deck's " +
          "name ({@link FinishFromADeck}).\n\n" +
          "**New trade asks for a name it does not need and a marketplace it does**: the " +
          "name is optional, and the marketplace opens on the reader's own.",
      },
    },
  },
} satisfies Meta<typeof Finish>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The design's trade. All six given cards are in the collection, the five received go in the
 * printing and finish the trade shows, and two of them are on the wishlist by name.
 */
export const FinishDefaults: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Finish trade" });
    const box = (name: string) => within(dialog).getByRole("checkbox", { name });

    await expect(dialog).toHaveTextContent("Trade 5 · opened 2 Oct 2026");
    await expect(box("Take the cards you gave out of your collection")).toBeChecked();
    await expect(box("Put the cards you gave on your wishlist")).not.toBeChecked();
    await expect(
      box("Take the cards you received off your wishlist"),
    ).toHaveAccessibleDescription("2 of them are on it: Urza's Saga, Tarmogoyf.");

    // The folder list is the reader's own drawers under the collection's root, and unticking
    // the step puts the picker out of reach: a folder for cards not being added asks nothing.
    const folder = within(dialog).getByRole("button", {
      name: "Folder for the cards you received",
    });
    await expect(folder).toHaveTextContent("Collection");
    await userEvent.click(box("Add the cards you received to your collection"));
    await expect(folder).toBeDisabled();
  },
};

/**
 * A trade whose reader holds none of what they are giving. The first step is still offered and
 * says, before it is pressed, that it will take nothing.
 */
export const NothingToTake: Story = {
  args: { tradeId: 4 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Finish trade" });

    await expect(
      within(dialog).getByRole("checkbox", {
        name: "Take the cards you gave out of your collection",
      }),
    ).toHaveAccessibleDescription(
      "2 cards. None of them are in your collection, so nothing is taken.",
    );
    await expect(
      within(dialog).getByRole("checkbox", {
        name: "Take the cards you received off your wishlist",
      }),
    ).toHaveAccessibleDescription("None of them are on your wishlist.");
  },
};

/**
 * A trade that gives two Ragavans where the reader holds one outside their decks. The first
 * question says all seven cards are in the collection — and, under that and in the destructive
 * colour, that one of them comes out of a deck, by name. It is part of the box's description, so
 * it is read with the box it is confirmed against.
 */
export const FinishFromADeck: Story = {
  args: {
    stage: async () => {
      const trade = await ipc.tradeGet(5);
      const ragavan = trade?.lines.find((line) => line.name === "Ragavan, Nimble Pilferer");
      if (ragavan !== undefined) await ipc.tradeUpdateLine(ragavan.id, { quantity: 2 });
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Finish trade" });
    const note = "1 of them comes out of a deck: Modern Goodstuff. That deck will be short of it.";

    await expect(
      within(dialog).getByRole("checkbox", {
        name: "Take the cards you gave out of your collection",
      }),
    ).toHaveAccessibleDescription(`7 cards. All of them are in your collection. ${note}`);
    await expect(within(dialog).getByText(note)).toBeVisible();
  },
};

/**
 * Finished once, reopened, and being finished again. Every step starts off and the dialog says
 * why — the first finish already moved those cards, and nothing on the trade says which.
 */
export const FinishedBefore: Story = {
  args: {
    tradeId: 4,
    stage: async () => {
      await ipc.tradeFinish(4, {
        removeGiven: false,
        addReceived: false,
        folderId: null,
        unwishReceived: false,
        wishGiven: false,
      });
      await ipc.tradeReopen(4);
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "Finish trade" });

    for (const box of within(dialog).getAllByRole("checkbox")) await expect(box).not.toBeChecked();
    await expect(dialog).toHaveTextContent("This trade was finished once before");

    await userEvent.click(within(dialog).getByRole("button", { name: "Finish trade" }));
    await waitFor(() => expect(canvas.getByRole("status")).toHaveTextContent("Finished."));
  },
};

/** New trade, as the page opens it: a name nobody has to type, and the reader's marketplace. */
export const NewTrade: Story = {
  render: () => <New />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const dialog = await canvas.findByRole("dialog", { name: "New trade" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });

    // The caret starts in the one field that takes typing.
    await expect(name).toHaveFocus();
    await expect(name).toHaveAttribute("placeholder", "Trade 6");
    await expect(within(dialog).getByRole("button", { name: "Prices from" })).toHaveTextContent(
      "TCGplayer",
    );

    await userEvent.type(name, "Friday swaps{Enter}");
    await waitFor(() =>
      expect(canvas.getByRole("status")).toHaveTextContent("Created “Friday swaps”."),
    );
  },
};

/** The dialog's host for one story: it says what was created, by reading it back. */
function New() {
  const [open, setOpen] = useState(true);
  const [created, setCreated] = useState<number | null>(null);
  const trade = useTrade(created);
  return (
    <>
      <p role="status" className="p-4 text-sm text-dim">
        {trade.data ? `Created “${trade.data.name}”.` : ""}
      </p>
      <NewTradeDialog
        open={open}
        placeholder="Trade 6"
        onCreated={(id) => {
          setCreated(id);
          setOpen(false);
        }}
        onDismiss={() => setOpen(false)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
