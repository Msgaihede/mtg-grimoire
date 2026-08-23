import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { CategoriesDialog } from "./CategoriesDialog";

/** How long a `waitFor` will wait for `Dialog`'s first frame — the shell's panel carries its
 *  `initial` on it, so nothing inside is visible yet. `Decks/Dialog shell` has the whole reason
 *  and why the number is seconds; each file keeps its own copy because CSF would index an
 *  exported one as a story. */
const FRAME_WAIT = 5_000;

/**
 * The piles of one deck — **driven end to end by `.storybook/fake/`.**
 *
 * Every one of this dialog's commands is the fake's (`deck_category_*`), so a rename here is a
 * row changing in a table and a delete really moves cards. `deck_get` comes with them, and only
 * because one control needs it: "File cards by what they do" reads a row's **type line** and its
 * **card id**, so `useDeckMeta` is handed cards rather than ids. `oracle_tags_for_printings` is
 * the read it makes with those ids — one call for the whole press, and the fake answers it like
 * any other command.
 *
 * The deck's *labels* are `Decks/TagsDialog`, which is the other half of the drawer these two
 * were split out of. Nothing is shared between them but a `useDeckMeta` and `metaRows.tsx`.
 *
 * **Two seeded decks are two shapes of deck**, and which one a story opens is the story's whole
 * setup:
 *
 * * **Deck 4, `Rhystic Testbed`** — the shape a deck the app makes *today* has: the four
 *   predefined piles, then three the reader named, one of which they switched off. This is the
 *   dialog with something in it.
 * * **Deck 2, `Kenrith Two-Drops`** — the five rows schema v8's migration leaves an older deck.
 *   This is the dialog on the day it was opened for the first time.
 */
const meta = {
  title: "Decks/CategoriesDialog",
  component: CategoriesDialog,
  args: { deckId: 4, variant: "live", open: true, onDismiss: fn(), onClose: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CategoriesDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A deck a few evenings into being built: three piles the reader made and the four every deck
 *  starts with. */
export const Default: Story = {
  play: async ({ canvas }) => {
    // The panel's arrival, waited out once — everything under it is visible in the same tick,
    // which is why the second row needs no wait of its own. See {@link FRAME_WAIT}.
    await waitFor(async () => await expect(await canvas.findByText("Ramp")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
    await expect(canvas.getByText("Card advantage")).toBeVisible();
  },
};

/** A deck nobody has filed yet — the migration's five piles, and the loose one they all sit
 *  beside. */
export const FirstOpen: Story = {
  args: { deckId: 2 },
  play: async ({ canvas }) => {
    // The panel's arrival, waited out once — see {@link FRAME_WAIT}.
    await waitFor(async () => await expect(await canvas.findByText("Main deck")).toBeVisible(), {
      timeout: FRAME_WAIT,
    });
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
 * The two markers, side by side, and the reading they exist to refuse.
 *
 * `RULE` is **not** "predefined and undeletable": it is about the ruleset, and the three kinds
 * the rules read a pile by are `commander`, `side` and `companion`. The Maybeboard is predefined
 * and carries `INACTIVE` alone; the reader's own "Cut list" carries exactly the same marker for
 * exactly the same reason, which is the whole of what makes a switched-off user pile behave like
 * the Maybeboard. Switch the Sideboard off and it carries **both** — the two answer different
 * questions and a pile can be both things at once.
 */
export const RuleAndInactive: Story = {
  play: async ({ canvas }) => {
    const row = async (name: string) =>
      (await canvas.findByText(name)).closest("li") as HTMLElement;

    const commander = await row("Commander");
    await expect(within(commander).getByText("RULE")).toBeInTheDocument();
    await expect(within(commander).queryByText("INACTIVE")).toBeNull();

    // Predefined, and carrying no RULE: the rules have no role for a maybeboard.
    const maybe = await row("Maybeboard");
    await expect(within(maybe).queryByText("RULE")).toBeNull();
    await expect(within(maybe).getByText("INACTIVE")).toBeInTheDocument();

    // The reader's own switched-off pile, marked identically.
    const cuts = await row("Cut list");
    await expect(within(cuts).queryByText("RULE")).toBeNull();
    await expect(within(cuts).getByText("INACTIVE")).toBeInTheDocument();

    const sideboard = await row("Sideboard");
    await userEvent.click(within(sideboard).getByRole("button", { name: /^Active/ }));
    await waitFor(async () => {
      await expect(within(sideboard).getByText("INACTIVE")).toBeInTheDocument();
    });
    await expect(within(sideboard).getByText("RULE")).toBeInTheDocument();
  },
};

/**
 * A predefined pile can be switched off and cannot be renamed or deleted — the Commander
 * included, which is the half that reads wrong until you have seen it. There is no format branch
 * behind any of this: the backend's only kind check guards the rename and the delete, and it
 * never reaches `is_active`.
 */
export const PredefinedIsSwitchableOnly: Story = {
  play: async ({ canvas }) => {
    const commander = (await canvas.findByText("Commander")).closest("li") as HTMLElement;

    await expect(within(commander).queryByRole("button", { name: "Rename" })).toBeNull();
    await expect(within(commander).queryByRole("button", { name: "Delete" })).toBeNull();

    await userEvent.click(within(commander).getByRole("button", { name: /^Active/ }));
    await waitFor(async () => {
      await expect(within(commander).getByText("INACTIVE")).toBeInTheDocument();
    });
  },
};

/** The reorder a keyboard can do. The handle's own name carries the position, because looking at
 *  the list is the only other way to know where a row landed. */
export const ReorderedFromTheKeyboard: Story = {
  play: async ({ canvas }) => {
    const handle = await canvas.findByRole("button", { name: "Move Ramp, 5 of 7" });
    handle.focus();
    await userEvent.keyboard("{ArrowUp}");

    await waitFor(async () => {
      await expect(canvas.getByRole("button", { name: "Move Ramp, 4 of 7" })).toBeInTheDocument();
    });
  },
};

/**
 * The one destructive control on this dialog, open on its safe answer.
 *
 * `deck_category_delete` takes `moveToCategoryId`, and `null` is the half that takes the cards
 * with the category by cascade — so the question defaults to a move, spells the outcome out in a
 * sentence, and changes the confirm button's own words with the answer.
 *
 * **The numbers here are the bug this question was fixed for, drawn on the deck that had it.**
 * Deck 4's "Ramp" holds **2** copies in the live list and **5** in the theory list, and the row
 * above the dialog says 2 because 2 is what the reader is editing. The delete takes all **7** —
 * `deck_cards.category_id` is `ON DELETE CASCADE` and a category is not per-variant — so the
 * confirmation quotes 7 and says in words that both lists are in scope. It said 2 before.
 */
export const DeletingACategory: Story = {
  play: async ({ canvas }) => {
    const ramp = (await canvas.findByText("Ramp")).closest("li") as HTMLElement;
    // The row is the list being edited, and stays that way.
    await expect(within(ramp).getByText("2 cards")).toBeInTheDocument();
    await userEvent.click(within(ramp).getByRole("button", { name: "Delete" }));

    const dialog = await canvas.findByRole("group", { name: "Delete Ramp" });
    await expect(within(dialog).getByText(/Nothing is lost/)).toHaveTextContent(
      "both the live and theory lists",
    );
    await expect(
      within(dialog).getByRole("button", { name: "Move 7 cards and delete" }),
    ).toBeInTheDocument();
  },
};

/** The same question after the reader has chosen the other outcome: red, and saying so — over the
 *  same seven copies, which is the arm where undercounting would have cost the most. */
export const DeletingACategoryAndItsCards: Story = {
  play: async ({ canvas }) => {
    const ramp = (await canvas.findByText("Ramp")).closest("li") as HTMLElement;
    await userEvent.click(within(ramp).getByRole("button", { name: "Delete" }));

    const dialog = await canvas.findByRole("group", { name: "Delete Ramp" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Its 7 cards"), "delete");
    await expect(
      within(dialog).getByText(/Any copies you own go back to Recently removed/),
    ).toHaveTextContent("The 7 cards in it go with it");
    await expect(within(dialog).getByRole("button", { name: "Delete “Ramp”" })).toBeInTheDocument();
  },
};

/**
 * "File cards by what they do", pressed — the real `autoCategoryFor` over real type lines and
 * the fake's real Oracle tags, through the real orchestration in `useDeckMeta` and into the real
 * backend.
 *
 * **Deck 1, and it has to be**: the button only empties the loose piles (`Main deck` and
 * `Uncategorized`), and deck 4 has no `Main deck` at all — a deck made today files its first add
 * under that name and every pile after it is the reader's. Deck 1 is the deck the migration left
 * with sixty cards in one, which is exactly the pile this button exists for.
 *
 * **`Land` is the pile asserted, and it is the one that holds whatever the taxonomy says.** A
 * land is pinned by its type line before a tag is consulted, so deck 1's twenty lands land there
 * whether or not the fake has a slug for any of them — while which functional column the other
 * forty end up in is the tag data's answer rather than this story's. The count is the other
 * assertion for the same reason: it says the press did something without naming a bucket.
 *
 * The categories the reader made are left as they were, which is the rule that keeps this from
 * being a way to lose an evening's filing.
 */
export const AutoCategorised: Story = {
  args: { deckId: 1 },
  play: async ({ canvas }) => {
    await canvas.findByText("Main deck");
    await userEvent.click(canvas.getByRole("button", { name: "File cards by what they do" }));

    await waitFor(async () => {
      await expect(canvas.getByText(/^Filed \d+ cards\.$/)).toBeInTheDocument();
    });
    await expect(canvas.getByText("Land")).toBeInTheDocument();
  },
};

/** A refusal, in the backend's own words: the grain is `(deckId, name)`, so a second "Ramp" is
 *  not a second pile. */
export const RefusedByName: Story = {
  play: async ({ canvas }) => {
    await canvas.findByText("Ramp");
    await userEvent.type(canvas.getByLabelText("New category name"), "Ramp");
    await userEvent.click(canvas.getByRole("button", { name: "Add" }));

    await waitFor(async () => {
      await expect(await canvas.findByRole("alert")).toHaveTextContent(
        "This deck already has a category with that name.",
      );
    });
  },
};

/**
 * The categories refused, in the backend's own words.
 *
 * `deckMeta` is the fault for the reads a deck screen makes *beside* the deck, and it refuses
 * the category list and the tag list **independently**. This dialog says so about its own read
 * and only its own — which is what splitting the drawer bought: which pile a card is in and
 * which label it wears are different facts, and a screen reporting one failure for both would be
 * claiming they came from one read. `Decks/TagsDialog`'s `Refused` is the other sentence.
 */
export const Refused: Story = {
  parameters: { fake: { fault: "deckMeta" } },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText(/the deck's categories could not be read/),
    ).toBeInTheDocument();
  },
};
