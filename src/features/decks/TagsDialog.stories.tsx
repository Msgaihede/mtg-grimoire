import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { TagsDialog } from "./TagsDialog";

/** How long a `waitFor` will wait for `Dialog`'s first frame — the shell's panel carries its
 *  `initial` on it, so nothing inside is visible yet. `Decks/Dialog shell` has the whole reason
 *  and why the number is seconds; each file keeps its own copy because CSF would index an
 *  exported one as a story. */
const FRAME_WAIT = 5_000;

/**
 * The labels of one deck — **driven end to end by `.storybook/fake/`.**
 *
 * All four of this dialog's commands are the fake's (`deck_tag_list`, `deck_tag_create`,
 * `deck_tag_update`, `deck_tag_delete`, plus `deck_tag_suggestions`), so a rename here is a row
 * changing in a table and a delete really takes the label off cards. There is no `deck_get` and
 * no marketplace in this file at all: a tag carries a name, a colour and a count, and none of
 * those is a fact about a card row or about money.
 *
 * The deck's *piles* are `Decks/CategoriesDialog`, which is the other half of the drawer these
 * two were split out of.
 *
 * **Two seeded decks are two shapes of deck**, and which one a story opens is the story's whole
 * setup:
 *
 * * **Deck 4, `Rhystic Testbed`** — two labels, one of them worn by a card. This is the dialog
 *   with something in it.
 * * **Deck 2, `Kenrith Two-Drops`** — an older deck with no tags at all. This is the dialog on
 *   the day it was opened for the first time, which is the state that has to invite.
 */
const meta = {
  title: "Decks/TagsDialog",
  component: TagsDialog,
  args: { deckId: 4, variant: "live", open: true, onDismiss: fn(), onClose: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof TagsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Two labels — one on a card, one waiting to be used. */
export const Default: Story = {
  play: async ({ canvas }) => {
    // `findByText` alone is not enough here: it waits for the row to **exist**, and the shell's
    // panel is still on its `initial` frame when it does — see {@link FRAME_WAIT}.
    await waitFor(async () => await expect(await canvas.findByText("Cut candidate")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
  },
};

/**
 * A deck with not one tag.
 *
 * The empty state is the one that has to invite, and since the redesign it says what to do rather
 * than only what is absent — the field it points at is now the first thing in the dialog rather
 * than the last.
 */
export const FirstOpen: Story = {
  args: { deckId: 2 },
  play: async ({ canvas }) => {
    // The panel's arrival, waited out once — everything under it is visible in the same tick,
    // which is why the suggestion below needs no wait of its own. See {@link FRAME_WAIT}.
    await waitFor(
      async () => await expect(await canvas.findByText(/No tags yet/)).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    // The palette is global, so a deck with no tags of its own is still offered every name the
    // reader has typed into another one.
    await expect(await canvas.findByRole("button", { name: "Add tag Cut candidate" })).toBeVisible();
  },
};

/** Closed. The contract is `null` — no panel, no scrim, and not one query fired. */
export const Closed: Story = {
  args: { open: false },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[role=dialog]")).toBeNull();
  },
};

/**
 * A tag renamed — the word only, since the redesign.
 *
 * `deck_tag_update` still renames **and** recolours in one command with no patch shape, so this
 * field sends the row's existing colour back untouched. The other half is `RecolouringATag`
 * below, which sends the name back the same way.
 */
export const RenamingATag: Story = {
  play: async ({ canvas }) => {
    const tag = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await userEvent.click(within(tag).getByRole("button", { name: "Rename" }));

    const field = await within(tag).findByLabelText("Rename Cut candidate");
    await userEvent.clear(field);
    await userEvent.type(field, "On the block");
    await userEvent.click(within(tag).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      await expect(canvas.getByText("On the block")).toBeInTheDocument();
    });
  },
};

/**
 * The colour, reached from the swatch that is already showing it.
 *
 * **This is what the redesign moved.** Recolouring used to be reachable only by pressing Rename,
 * which asked a reader who wanted a different red to open the control for changing the word. The
 * swatch is a button now: it opens the picker under the row, and Done is the write.
 */
export const RecolouringATag: Story = {
  play: async ({ canvas }) => {
    const tag = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await userEvent.click(
      within(tag).getByRole("button", { name: "Change colour of Cut candidate" }),
    );

    // The six the app sanctions, one press each — the wheel and the hex field beside them are
    // what a colour outside the six arrives through.
    await userEvent.click(within(tag).getByRole("button", { name: "Slate" }));
    await userEvent.click(within(tag).getByRole("button", { name: "Done" }));

    await waitFor(async () => {
      await expect(
        within(tag).getByRole("button", { name: "Change colour of Cut candidate" }),
      ).toHaveAttribute("title", "#C8C4BF");
    });
  },
};

/**
 * A name typed into another deck, offered in this one.
 *
 * The palette is a property of the app's whole history rather than of the deck that happens to be
 * open — `deck_tag_suggestions` takes no deck id at all. Picking one makes a tag *of this deck*;
 * a suggestion this deck already has is not an offer, which is why "Cut candidate" is absent and
 * "Budget swap" is not.
 */
export const TagFromASuggestion: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText("Cut candidate");
    await expect(canvas.queryByRole("button", { name: "Add tag Cut candidate" })).toBeNull();

    await userEvent.click(canvas.getByRole("button", { name: "Add tag Budget swap" }));
    await waitFor(async () => {
      await expect(canvas.queryByRole("button", { name: "Add tag Budget swap" })).toBeNull();
    });
  },
};

/**
 * The tags refused, in the backend's own words.
 *
 * `deckMeta` is the fault for the reads a deck screen makes *beside* the deck, and it refuses
 * the tag list and the category list **independently**. This dialog says so about its own read
 * and only its own — which is what splitting the drawer bought: which label a card wears and
 * which pile it is in are different facts, and a screen reporting one failure for both would be
 * claiming they came from one read. `Decks/CategoriesDialog`'s `Refused` is the other sentence.
 */
export const Refused: Story = {
  parameters: { fake: { fault: "deckMeta" } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/the deck's tags could not be read/)).toBeInTheDocument();
  },
};
