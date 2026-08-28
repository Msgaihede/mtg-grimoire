import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ReviewPanel } from "./ReviewPanel";

const meta = {
  title: "Settings/ReviewPanel",
  component: ReviewPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window. The layout risk
    // here is a two-line sentence meeting a fixed button on the row above it, and this is the
    // width at which the two either share the row or do not.
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
          "Spec §7.4's other half: the rows the app wants a person to look at.\n\n" +
          "**`needs_review` holds a sentence rather than a flag**, and everything about this " +
          "panel follows from that. Two devices that changed the same thing are reconciled by " +
          "§7.3's five rules, silently, wherever a rule can decide. Where one cannot, the " +
          "engine keeps the reader's data and writes down what it did — a row another device " +
          "deleted while this one was still editing it is *kept*, and a folder move that would " +
          "have put a folder inside itself lands the folder at the top level. The sentence is " +
          "drawn **verbatim**: Rust wrote it, and the page does not reword it, shorten it or " +
          "turn it into an icon.\n\n" +
          "**It is not only sync's.** `reconcile.rs` has been writing into this column since " +
          "long before a relay existed, for a printing that left Scryfall's database, and " +
          "those rows are listed here beside the rest. One column, one queue, one press — a " +
          "reader does not care which subsystem wanted their attention.\n\n" +
          "The `needsReview` world is where these stories live. It is `starter` plus one " +
          "flagged row in each of the three user card tables, carrying `reconcile.rs`' three " +
          "sentences, and — since the relay landed — a fourth on `deck_folders` carrying " +
          "`apply::CYCLE_BROKEN`, which is the outcome user schema v29 added the column to the " +
          "three folder tables for.",
      },
    },
  },
} satisfies Meta<typeof ReviewPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * An empty queue — **the good state, and where every install starts.**
 *
 * The default world has nothing flagged, which is what makes this the story a reader meets
 * first. "No rows found" would read as a search that came back empty; the app has simply
 * nothing to ask.
 */
export const NothingToLookAt: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/nothing needs a look/i)).toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: /looks fine/i })).not.toBeInTheDocument();
  },
};

/**
 * Four rows across four tables, each with a different sentence and each filed under a name a
 * person would recognise.
 *
 * **Never the raw table name.** A reader has a collection, decks and deck folders; nobody has a
 * `deck_folders`. The grouping is also what tells a `Commander` that is a deck folder from a
 * `Commander` that is anything else, and both can be in this list at once.
 */
export const FourSentences: Story = {
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByRole("heading", { name: "The collection" }),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Decks" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "The wishlist" })).toBeInTheDocument();
    await expect(canvas.getByRole("heading", { name: "Deck folders" })).toBeInTheDocument();

    // The collection orphan has no card left to name it, so the row falls back to what is
    // printed on the cardboard — the `coalesce` the crate writes, and the reason those columns
    // are denormalised in the first place.
    await expect(canvas.getByText("mh3 108")).toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: /looks fine/i })).toHaveLength(4);
  },
};

/**
 * §7.4's second surfaced outcome, in the engine's own words.
 *
 * A folder move on another device that would have made `A → B → A` is undone by returning the
 * later-moved folder to the top level — and *the folder is told*, which is the whole reason
 * user schema v29 put `needs_review` on the three folder tables. The sentence names what
 * happened and where the folder went, so there is nothing here for the page to explain.
 */
export const AFolderThatLostACycle: Story = {
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(
      await canvas.findByText(/would have put this folder inside itself/i),
    ).toBeInTheDocument();
    await expect(canvas.getByText(/moved to the top level/i)).toBeInTheDocument();
  },
};

/**
 * *Looks fine*, all the way down.
 *
 * The press clears the sentence in the fake, the command answers what is left, and the list is
 * redrawn from that answer — so the row goes, and its heading goes with it rather than standing
 * empty. **It is a write like any other**, which is why it travels: a row one device has looked
 * at stops asking on the others too.
 */
export const ClearingARow: Story = {
  parameters: { fake: { seed: "needsReview" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await userEvent.click(
      await canvas.findByRole("button", { name: /looks fine, commander/i }),
    );

    await expect(
      await canvas.findByRole("heading", { name: "The collection" }),
    ).toBeInTheDocument();
    await expect(canvas.queryByRole("heading", { name: "Deck folders" })).not.toBeInTheDocument();
    await expect(canvas.getAllByRole("button", { name: /looks fine/i })).toHaveLength(3);
  },
};

/**
 * The read refused — a sync holding the write connection is the way it happens.
 *
 * The panel says the queue could not be read rather than drawing it empty, because those two
 * are opposite news and an empty list is the one that reads as reassuring.
 */
export const CouldNotBeRead: Story = {
  parameters: { fake: { seed: "needsReview", fault: "busy" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/could not be read/i)).toBeInTheDocument();
    await expect(canvas.queryByText(/nothing needs a look/i)).not.toBeInTheDocument();
  },
};
