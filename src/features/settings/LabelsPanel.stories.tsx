import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { LabelsPanel } from "./LabelsPanel";

const meta = {
  title: "Settings/LabelsPanel",
  component: LabelsPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window — because the
    // layout risk here is a row that carries a swatch, a name, a reach and two words on one line,
    // and the name is the only part of it allowed to truncate.
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
          "The reader's **labels**, as things in themselves, with no deck open.\n\n" +
          "A label is the deckbuilder's coloured per-card mark — `deck_labels`, " +
          "`deck_cards.label_id` — and it is neither of the two other things this app calls " +
          "something similar: a *tag* is one of Scryfall's tagger datasets, and the " +
          "collection's free-text `tags` column is a third thing again. That vocabulary rule is " +
          "why this panel is filed under **Appearance** and not under Tags.\n\n" +
          "**It is the deck dialog's second section and nothing else.** `LabelsDialog` draws " +
          "two: the labels *this deck's list is wearing*, whose destructive control is **Remove** " +
          "(take it off these cards, leave the label standing), and every other label, whose " +
          "destructive control is **Delete** (app-wide). Settings has no deck, so there is no " +
          "list on screen to take a label off and only the second act is available here.\n\n" +
          "**The reach is drawn at rest**, not only inside the delete question, because it is " +
          "the fact a reader with no deck open cannot get any other way — `unused` for a label " +
          "nothing wears, which this list can answer and `deck_label_list` never can.\n\n" +
          "**A label edited from here writes no deck history and no undo step.** Both of those " +
          "hang off a `deck_id`, and a rename that reaches every deck wearing the label belongs " +
          "to none of them. The delete question is where the reader is told, because a rename " +
          "is recoverable by renaming it back and a delete is not.\n\n" +
          "**This panel reaches the backend itself**, so both stories here are **seeded worlds** " +
          "rather than arguments: the list is `deck_label_all` over the world's own rows, and " +
          "every press below really writes.",
      },
    },
  },
} satisfies Meta<typeof LabelsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The reader's labels, most-used first — and the row that says how far each one goes.
 *
 * **Two of the three are worn by nothing**, which is the state this panel exists for: a label
 * nothing wears is invisible from inside a deck, because the dialog there lists what *that* list
 * is wearing. `unused` rather than `0 in 0 decks`, which is arithmetic about nothing, and it is
 * the one row a reader can delete without reading any further.
 *
 * **The assertions are shapes rather than numbers.** The counts belong to
 * `.storybook/fake/seeds.ts`, and a story that pinned them would go red the day somebody put a
 * label on one more card.
 */
export const Populated: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    // The add row comes first and this panel opens on it — `LabelsDialog`'s own rule, kept for
    // its own reason: a reader with no labels is who this screen is hardest for, and the control
    // that fixes that must not sit under the list they have not got.
    await expect(canvas.getByPlaceholderText("New label name…")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Add label" })).toBeDisabled();

    await waitFor(async () => {
      await expect(canvas.getAllByRole("listitem").length).toBeGreaterThan(1);
    });
    // The list is read, so there is no sentence claiming the reader has nothing.
    await expect(canvas.queryByText(/Labels are yours to invent/)).not.toBeInTheDocument();

    // One label worn by cards, and the rest worn by none. The reach is a shape rather than a
    // figure — `N in M deck(s)` — for the reason in this story's note.
    const worn = canvas.getByRole("button", { name: "Change colour of Cut candidate" });
    const row = worn.closest("li");
    await expect(row).not.toBeNull();
    await expect(within(row as HTMLElement).getByText(/^\d+ in \d+ decks?$/)).toBeInTheDocument();
    await expect(canvas.getAllByText("unused").length).toBeGreaterThan(0);

    // Delete says the two things a reader standing here cannot see: how far it reaches, and that
    // it cannot be taken back. The second is its own paragraph rather than a clause, because it
    // is a fact about **where the press was made** and not about this label.
    await userEvent.click(within(row as HTMLElement).getByRole("button", { name: "Delete" }));
    const question = await canvas.findByRole("group", { name: "Delete Cut candidate" });
    await expect(within(question).getByText(/stay where they are and lose the label/))
      .toBeInTheDocument();
    await expect(within(question).getByText(/cannot be undone/)).toHaveTextContent(/Ctrl\+Z/);

    // Cancelling destroys nothing and puts the list back as it was — the row is still there,
    // still wearing its label, and the question is gone.
    await userEvent.click(within(question).getByRole("button", { name: "Keep it" }));
    await waitFor(async () => {
      await expect(canvas.queryByRole("group", { name: "Delete Cut candidate" })).not.toBeInTheDocument();
    });
    await expect(canvas.getByRole("button", { name: "Change colour of Cut candidate" })).toBeInTheDocument();
  },
};

/**
 * **No labels at all** — the case this screen is hardest for, and the one most worth a story.
 *
 * A panel that merely reported an absence would leave a reader who has never made one with no
 * idea what a label is *for*: the word belongs to them rather than to the game, and nothing on a
 * card suggests it. So the empty state names two labels a person might actually want and says
 * where the press is — right-click a card in any deck — because the add row here makes the label
 * and does not put it on anything.
 *
 * **Three states and three answers, never two.** A read still in flight and a read that failed
 * both leave an empty array behind, and neither of them is a reader with no labels; this sentence
 * is a claim about a *table*, so it is drawn only once something has actually answered. The
 * pending state says so in its own words above, and a failure goes to the alert at the foot.
 */
export const NoLabelsYet: Story = {
  parameters: { fake: { seed: "empty" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);

    await expect(await canvas.findByText(/Labels are yours to invent/)).toHaveTextContent(
      /right-click a card in any deck/,
    );
    await expect(canvas.queryAllByRole("listitem")).toHaveLength(0);
    // Not the failed read and not the read in flight, which is the whole of why that sentence is
    // fenced on `isSuccess`.
    await expect(canvas.queryByRole("alert")).not.toBeInTheDocument();
    await expect(canvas.queryByText(/Reading your labels/)).not.toBeInTheDocument();

    // The way out is on screen and above the space where the list is not — a reader with nothing
    // must not have to scroll past an empty list to find the control that fills it.
    await expect(canvas.getByPlaceholderText("New label name…")).toBeInTheDocument();
  },
};
