import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { TOOLTIP_OPEN_MS } from "@/components/tooltip/TooltipProvider";
import { LabelsDialog } from "./LabelsDialog";

/** How long a `waitFor` will wait for `Dialog`'s first frame — the shell's panel carries its
 *  `initial` on it, so nothing inside is visible yet. `Decks/Dialog shell` has the whole reason
 *  and why the number is seconds; each file keeps its own copy because CSF would index an
 *  exported one as a story. */
const FRAME_WAIT = 5_000;

/**
 * The reader's labels — **driven end to end by `.storybook/fake/`.**
 *
 * All six of this dialog's commands are the fake's (`deck_label_list`, `deck_label_all`,
 * `deck_label_create`, `deck_label_update`, `deck_label_remove_from_deck`, `deck_label_delete`), so a
 * rename here is a row changing in a table and a delete really takes the label off cards — in
 * every deck. There is no `deck_get` and no marketplace in this file at all: a label carries a
 * name, a colour and a count, and none of those is a fact about a card row or about money.
 *
 * The deck's *piles* are `Decks/CategoriesDialog`, which is the other half of the drawer these
 * two were split out of.
 *
 * **The seed is three app-wide labels and the two sections split them by what a deck wears**:
 * `Cut candidate` is on two of `Rhystic Testbed`'s live cards, `Budget swap` is worn only in
 * another deck, and `Combo piece` is worn by nothing at all. Which deck a story opens is
 * therefore the story's whole setup:
 *
 * * **Deck 4, `Rhystic Testbed`** — one label in use here, two below it. This is the dialog with
 *   something in both of its sections.
 * * **Deck 2, `Kenrith Two-Drops`** — a deck with no labelled cards. Its first section is empty and
 *   its second holds every label the reader owns, which is the state that has to invite.
 */
const meta = {
  title: "Decks/LabelsDialog",
  component: LabelsDialog,
  args: { deckId: 4, variant: "live", open: true, onDismiss: fn(), onClose: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof LabelsDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One label on this list's cards, and the reader's other two under it. */
export const Default: Story = {
  play: async ({ canvas }) => {
    // `findByText` alone is not enough here: it waits for the row to **exist**, and the shell's
    // panel is still on its `initial` frame when it does — see {@link FRAME_WAIT}.
    await waitFor(async () => await expect(await canvas.findByText("Cut candidate")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
    await expect(canvas.getByText("On cards in this actual list")).toBeVisible();
    await expect(canvas.getByText("Your other labels")).toBeVisible();
    // Worn by nothing anywhere: the row `deck_label_list` could never answer, and the reason the
    // app-wide read exists.
    await expect(canvas.getByText("Combo piece")).toBeVisible();
  },
};

/**
 * A deck with nothing labelled.
 *
 * The empty state is the one that has to invite, and it says what to do rather than only what is
 * absent. **Every label the reader owns is still here**, one section down — which is the whole
 * difference the app-wide list makes: a deck they have not labelled yet is not a deck with no labels
 * available to it.
 */
export const FirstOpen: Story = {
  args: { deckId: 2 },
  play: async ({ canvas }) => {
    // The panel's arrival, waited out once — everything under it is visible in the same tick,
    // which is why the rows below need no wait of their own. See {@link FRAME_WAIT}.
    await waitFor(
      async () => await expect(await canvas.findByText(/Nothing in this list is labelled yet/)).toBeVisible(),
      { timeout: FRAME_WAIT },
    );
    await expect(await canvas.findByText("Cut candidate")).toBeVisible();
    await expect(await canvas.findByText("Budget swap")).toBeVisible();
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
 * A label renamed — the word only, and **in every deck at once**.
 *
 * `deck_label_update` renames **and** recolours in one command with no patch shape, so this field
 * sends the row's existing colour back untouched. The other half is `RecolouringALabel` below,
 * which sends the name back the same way.
 */
export const RenamingALabel: Story = {
  play: async ({ canvas }) => {
    const label = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await userEvent.click(within(label).getByRole("button", { name: "Rename" }));

    const field = await within(label).findByLabelText("Rename Cut candidate");
    await userEvent.clear(field);
    await userEvent.type(field, "On the block");
    await userEvent.click(within(label).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      await expect(canvas.getByText("On the block")).toBeInTheDocument();
    });
  },
};

/**
 * The colour, reached from the swatch that is already showing it — and changed for every deck.
 *
 * The swatch is a button: it opens the picker under the row, and Done is the write. That is
 * the issue's headline made pressable, since one row means one colour and there is no longer a
 * way for the same word to be red here and blue there.
 */
export const RecolouringALabel: Story = {
  play: async ({ canvas }) => {
    const label = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await userEvent.click(
      within(label).getByRole("button", { name: "Change colour of Cut candidate" }),
    );

    // The six the app sanctions, one press each — the wheel and the hex field beside them are
    // what a colour outside the six arrives through.
    await userEvent.click(within(label).getByRole("button", { name: "Slate" }));
    await userEvent.click(within(label).getByRole("button", { name: "Done" }));

    // The colour is a tooltip on the swatch now, not a `title` — hover it and read the panel.
    // It describes the button (default `describes: true`) and mounts as a sibling of the whole
    // story, not inside `label`, so it is read off `canvas` rather than `within(label)`.
    const swatch = await waitFor(() =>
      within(label).getByRole("button", { name: "Change colour of Cut candidate" }),
    );
    await userEvent.hover(swatch);
    const swatchTooltip = await canvas.findByRole("tooltip", undefined, {
      timeout: TOOLTIP_OPEN_MS + 1000,
    });
    await expect(swatchTooltip).toHaveTextContent("#C8C4BF");
  },
};

/**
 * **The two destructive acts, and the one this story is about is the gentler one.**
 *
 * They used to be one press. While a label belonged to a deck, "I am done with this label here"
 * and "this label should stop existing" were the same thing; conflating them now would mean a
 * reader tidying one deck stripping a label off nine others. So a row in the deck's own section
 * offers **Remove**, which unlabels this list's cards and leaves the label standing — and the row
 * then reappears under "Your other labels", which is the visible proof that nothing was destroyed.
 */
export const RemovingALabelFromTheDeck: Story = {
  play: async ({ canvas }) => {
    const label = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await userEvent.click(within(label).getByRole("button", { name: "Remove" }));

    const confirm = await canvas.findByRole("group", {
      name: "Remove Cut candidate from this deck",
    });
    await expect(confirm).toHaveTextContent("The label itself stays in your list");
    await userEvent.click(within(confirm).getByRole("button", { name: "Remove from deck" }));

    // Nothing in this list wears it any more...
    await waitFor(async () => {
      await expect(await canvas.findByText(/Nothing in this list is labelled yet/)).toBeVisible();
    });
    // ...and the label is still the reader's, one section down, offering the app-wide delete.
    const moved = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await expect(within(moved).getByRole("button", { name: "Delete" })).toBeVisible();
  },
};

/**
 * The app-wide delete, and the sentence that has to precede it.
 *
 * `deck_cards.label_id` is `ON DELETE SET NULL`, so no card is destroyed — but the label comes off
 * every deck wearing it, which is a reach nothing on screen could otherwise show.
 * {@link GlobalLabel.deckCount} is on the row so the confirmation can say the number before the
 * press rather than after it.
 */
export const DeletingALabelEverywhere: Story = {
  play: async ({ canvas }) => {
    const label = (await canvas.findByText("Budget swap")).closest("li") as HTMLElement;
    await userEvent.click(within(label).getByRole("button", { name: "Delete" }));

    const confirm = await canvas.findByRole("group", { name: "Delete Budget swap" });
    await expect(confirm).toHaveTextContent("Delete “Budget swap” everywhere?");
    await userEvent.click(within(confirm).getByRole("button", { name: "Delete label" }));

    await waitFor(async () => {
      await expect(canvas.queryByText("Budget swap")).toBeNull();
    });
  },
};

/**
 * **A name is a name, whatever capitals it is typed in.**
 *
 * One row per name is a table property and the backend is the authority, but a reader who types
 * one that exists has not made a mistake — they have found the label they wanted. So the field
 * disables Add and points at the row rather than spending a round trip on a refusal.
 */
export const RefusingADuplicateName: Story = {
  play: async ({ canvas }) => {
    await waitFor(async () => await expect(await canvas.findByText("Cut candidate")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });

    await userEvent.type(canvas.getByLabelText("New label name"), "budget SWAP");

    await expect(await canvas.findByRole("status")).toHaveTextContent("already exists");
    await expect(canvas.getByRole("button", { name: "Add label" })).toBeDisabled();
  },
};

/**
 * The labels refused, in the backend's own words.
 *
 * `deckMeta` is the fault for the reads a deck screen makes *beside* the deck, and it refuses
 * the label list and the category list **independently**. This dialog says so about its own read
 * and only its own — which is what splitting the drawer bought: which label a card wears and
 * which pile it is in are different facts, and a screen reporting one failure for both would be
 * claiming they came from one read. `Decks/CategoriesDialog`'s `Refused` is the other sentence.
 */
export const Refused: Story = {
  parameters: { fake: { fault: "deckMeta" } },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText(/the deck's labels could not be read/)).toBeInTheDocument();
  },
};
