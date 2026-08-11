import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { CategoriesPanel } from "./CategoriesPanel";

/**
 * The piles and the labels of one deck — **driven end to end by `.storybook/fake/`.**
 *
 * All eleven of this panel's commands are the fake's now (`deck_category_*`, `deck_tag_*` and
 * `deck_tag_suggestions`), so a rename here is a row changing in a table and a delete really
 * moves cards. `deck_get` comes with them, and only because one control needs it: "Auto-categorise
 * from card types" reads **type lines**, so `useDeckMeta` is handed cards rather than ids.
 *
 * **Two seeded decks are two shapes of deck**, and which one a story opens is the story's whole
 * setup:
 *
 * * **Deck 4, `Rhystic Testbed`** — the shape a deck the app makes *today* has: the four
 *   predefined piles, then three the reader named, one of which they switched off. Two labels,
 *   one of them worn by a card. This is the panel with something in it.
 * * **Deck 2, `Kenrith Two-Drops`** — the five rows schema v8's migration leaves an older deck,
 *   and no tags at all. This is the panel on the day it was opened for the first time.
 */
const meta = {
  title: "Decks/CategoriesPanel",
  component: CategoriesPanel,
  args: { deckId: 4, variant: "live", open: true, onDismiss: fn(), onClose: fn() },
  decorators: [
    (Story) => (
      // The drawer is `position: fixed`, so it covers whatever it is rendered into — including
      // the docs page. A `relative` frame with its own height is what a docs page needs in
      // order to show ten of these at once and still scroll.
      <div className="relative h-[42rem] overflow-hidden border border-border bg-surface">
        <Story />
      </div>
    ),
  ],
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof CategoriesPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A deck a few evenings into being built: three piles the reader made, the four every deck
 *  starts with, and two labels — one of them on a card, one waiting to be used. */
export const Default: Story = {
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Ramp")).toBeVisible();
    await expect(canvas.getByText("Card advantage")).toBeVisible();
    await expect(canvas.getByText("Cut candidate")).toBeVisible();
  },
};

/**
 * A deck nobody has filed yet — the migration's five piles and not one tag.
 *
 * The empty state is the one that has to invite: "No tags yet." over a field, and the names
 * other decks have used right under it.
 */
export const FirstOpen: Story = {
  args: { deckId: 2 },
  play: async ({ canvas }) => {
    await expect(await canvas.findByText("Main deck")).toBeVisible();
    await expect(canvas.getByText("No tags yet.")).toBeVisible();
    // The palette is global, so a deck with no tags of its own is still offered every name the
    // reader has typed into another one.
    await expect(canvas.getByRole("button", { name: "Add tag Cut candidate" })).toBeVisible();
  },
};

/** Closed. The contract is `null` — no drawer, no scrim, and not one query fired. */
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
 * The one destructive control on the drawer, open on its safe answer.
 *
 * `deck_category_delete` takes `moveToCategoryId`, and `null` is the half that takes the cards
 * with the category by cascade — so the dialog defaults to a move, spells the outcome out in a
 * sentence, and changes the confirm button's own words with the answer.
 *
 * **The numbers here are the bug this dialog was fixed for, drawn on the deck that had it.**
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

/** The same dialog after the reader has chosen the other outcome: red, and saying so — over the
 *  same seven copies, which is the arm where undercounting would have cost the most. */
export const DeletingACategoryAndItsCards: Story = {
  play: async ({ canvas }) => {
    const ramp = (await canvas.findByText("Ramp")).closest("li") as HTMLElement;
    await userEvent.click(within(ramp).getByRole("button", { name: "Delete" }));

    const dialog = await canvas.findByRole("group", { name: "Delete Ramp" });
    await userEvent.selectOptions(within(dialog).getByLabelText("Its 7 cards"), "delete");
    await expect(within(dialog).getByText(/This cannot be undone/)).toHaveTextContent(
      "The 7 cards in it are deleted too",
    );
    await expect(within(dialog).getByRole("button", { name: "Delete “Ramp”" })).toBeInTheDocument();
  },
};

/**
 * "Auto-categorise from card types", pressed — the real `autoCategoryFor` over real type lines,
 * through the real orchestration in `useDeckMeta` and into the real backend.
 *
 * **Deck 1, and it has to be**: the button only empties the loose piles (`Main deck` and
 * `Uncategorised`), and deck 4 has no `Main deck` at all — a deck made today files its first add
 * under that name and every pile after it is the reader's. Deck 1 is the deck the migration left
 * with sixty cards in one, which is exactly the pile this button exists for.
 *
 * The categories the reader made are left as they were, which is the rule that keeps this from
 * being a way to lose an evening's filing.
 */
export const AutoCategorised: Story = {
  args: { deckId: 1 },
  play: async ({ canvas }) => {
    await canvas.findByText("Main deck");
    await userEvent.click(canvas.getByRole("button", { name: "Auto-categorise from card types" }));

    await waitFor(async () => {
      await expect(canvas.getByText("Creature")).toBeInTheDocument();
    });
    await expect(canvas.getByText("Land")).toBeInTheDocument();
  },
};

/** A tag renamed and recoloured in one press — `deck_tag_update` has no patch shape, so the
 *  field sends both whichever one the reader touched. */
export const RenamingATag: Story = {
  play: async ({ canvas }) => {
    const tag = (await canvas.findByText("Cut candidate")).closest("li") as HTMLElement;
    await userEvent.click(within(tag).getByRole("button", { name: "Rename" }));

    const field = await within(tag).findByLabelText("Rename Cut candidate");
    await userEvent.clear(field);
    await userEvent.type(field, "On the block");
    await userEvent.click(within(tag).getByRole("button", { name: "Slate" }));
    await userEvent.click(within(tag).getByRole("button", { name: "Save" }));

    await waitFor(async () => {
      await expect(canvas.getByText("On the block")).toBeInTheDocument();
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
 * The categories and the tags refused, in the backend's own words.
 *
 * `deckMeta` is the fault for the reads a deck screen makes *beside* the deck. Two lists fail
 * independently here and the panel says so twice rather than blanking: which pile a card is in
 * and which label it wears are different facts, and a screen that reported one failure for both
 * would be claiming they came from one read.
 */
export const Refused: Story = {
  parameters: { fake: { fault: "deckMeta" } },
  play: async ({ canvas }) => {
    await expect(
      await canvas.findByText(/the deck's categories could not be read/),
    ).toBeInTheDocument();
    await expect(canvas.getByText(/the deck's tags could not be read/)).toBeInTheDocument();
  },
};
