import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CONFIRM_WORD } from "./ConfirmDialog";
import { DangerZonePanel } from "./DangerZonePanel";
import type { DangerZone } from "./useDataReset";

/**
 * The hook's answer, built by hand.
 *
 * The panel takes its whole state as a prop — `ErrorLogPanel`'s shape — so every story here is
 * an argument rather than a seeded world. `Settings/Page`'s stories are where these buttons
 * write to the fake for real.
 */
function danger(over: Partial<DangerZone> = {}): DangerZone {
  return {
    collection: { run: fn(), pending: false },
    wishlist: { run: fn(), pending: false },
    decks: { run: fn(), pending: false },
    status: null,
    ...over,
  };
}

const meta = {
  title: "Settings/DangerZonePanel",
  component: DangerZonePanel,
  tags: ["autodocs"],
  args: { danger: danger() },
  decorators: [
    // The settings column's own width, because the three rows wrap their button under the
    // summary at narrow sizes and that is the layout worth looking at.
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
          "The three clears that cannot be taken back.\n\n" +
          "**The confirmation is the only line of defence, not the first.** `deck_audit` is " +
          "per-deck and cascades away with the decks it describes, so a wipe has nowhere to be " +
          "recorded and Undo has nothing to read. That is why every one of these asks the " +
          "reader to type `Confirm` before the button arms, and why the panel sits last on the " +
          "page in a region of its own.\n\n" +
          "**Each dialog names the consequence a reader did not ask for**, which is a different " +
          "job from the summary on the row. Clearing the collection keeps every deck and " +
          "un-owns every card in them; clearing the decks takes the folders too, because " +
          "`decks.folder_id` is `ON DELETE SET NULL` and a wipe that stopped at the cascade " +
          "would leave an empty tree to delete by hand.\n\n" +
          "One status line for three buttons: `useDangerZone` applies `@/lib/writes`' rule — " +
          "the most recently *started* write owns the banner — so the panel renders one " +
          "sentence and decides nothing.",
      },
    },
  },
} satisfies Meta<typeof DangerZonePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The panel as it is found: three questions, none of them asked yet. */
export const Resting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("listitem")).toHaveLength(3);
    await expect(canvas.getByRole("button", { name: "Clear collection" })).toBeEnabled();
  },
};

/**
 * The gate itself, walked end to end.
 *
 * The assertion in the middle is the one that matters: the button is **disabled** with the
 * dialog open and the word not yet written, so a reader who reaches for Enter out of habit
 * gets nothing. Only the exact word arms it — `confirm` does not, and that is deliberate.
 *
 * The dialog is a modal over the whole window, so this story reaches it through `document.body`
 * rather than through the canvas: it is not rendered inside the decorator's box.
 */
export const TypingTheWord: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const page = within(document.body);

    await userEvent.click(canvas.getByRole("button", { name: "Clear collection" }));
    const dialog = await page.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Clear collection" });

    await expect(dialog).toHaveTextContent("This cannot be undone.");
    await expect(confirm).toBeDisabled();

    await userEvent.type(within(dialog).getByRole("textbox"), "confirm");
    await expect(confirm).toBeDisabled();

    await userEvent.clear(within(dialog).getByRole("textbox"));
    await userEvent.type(within(dialog).getByRole("textbox"), CONFIRM_WORD);
    await expect(confirm).toBeEnabled();

    await userEvent.click(confirm);
    await expect(args.danger.collection.run).toHaveBeenCalled();
  },
};

/**
 * What the panel says after a clear, and the tone it says it in.
 *
 * Plain rather than the destructive red: "cleared 1,284 collection entries" is the thing the
 * reader just asked for, and a panel that shouted about it would be shouting about a success.
 * The second clause is the one they did not ask for — every deck in the app has stopped
 * holding a claim on an owned copy.
 */
export const AfterAClear: Story = {
  args: {
    danger: danger({
      status: {
        tone: "plain",
        text: "Cleared 1,284 collection entries and released 37 deck reservations.",
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("released 37 deck reservations");
  },
};

/** The write connection held by a sync, in `db.rs`' own words. Red, because it did not happen. */
export const Refused: Story = {
  args: {
    danger: danger({
      status: {
        tone: "problem",
        text: "The card database is busy finishing a sync. Try that again in a moment.",
      },
    }),
  },
};

/** One row working. Its siblings stay live — they are separate tables and separate writes. */
export const Working: Story = {
  args: { danger: danger({ decks: { run: fn(), pending: true } }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Clear decks" })).toBeDisabled();
    await expect(canvas.getByRole("button", { name: "Clear wishlist" })).toBeEnabled();
  },
};
