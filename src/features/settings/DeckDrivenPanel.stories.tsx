import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { useDeckDrivenCollection } from "@/lib/useDeckDrivenCollection";
import { DeckDrivenPanel } from "./DeckDrivenPanel";

type DeckDriven = ReturnType<typeof useDeckDrivenCollection>;

/**
 * What `useDeckDrivenCollection` would have answered.
 *
 * Arguments rather than a seeded world, which is `Settings/HiddenTagsPanel`'s shape: the panel
 * holds no state of its own — the hook owns the optimistic write, the rollback and the sentence
 * — so every state worth looking at here is one object, and a fake would only be a slower way to
 * reach the same four. `Settings/Page` is where this is driven through the real hook.
 */
function deckDriven(over: Partial<DeckDriven> = {}): DeckDriven {
  return { deckDriven: false, setDeckDriven: fn(), error: null, ...over };
}

const meta = {
  title: "Settings/DeckDrivenPanel",
  component: DeckDrivenPanel,
  tags: ["autodocs"],
  args: { deckDriven: deckDriven() },
  decorators: [
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
          "Whether the reader's decks *are* their collection — and the only place the feature " +
          "is ever explained.\n\n" +
          "**The copy has three jobs and they are all load-bearing.** What the collection " +
          "becomes (the sum of the live deck lists), what it leaves out and why (a deck's " +
          "*Theory* list is what the deck is being built toward, not what is sleeved up), and " +
          "that **nothing is deleted** — which is the sentence that makes the switch safe to " +
          "press. The last one is not reassurance: a reader who suspects this might throw " +
          "their collection away never finds out that it does not.\n\n" +
          "**Every clause of it is `collection_source::LIVE` in words**, and that predicate is " +
          "deliberately broader than the deck allocator's. No `is_active` term — an inactive " +
          "Maybeboard is a statement about how the *deck* is read, not about whose hands the " +
          "cards are in. No `decks.archived` term — archiving is filing, not disassembling. " +
          "And no `theory_enabled` term, because none is needed: a deck with no plan keeps " +
          "every row as `live`, so *a deck without one counts in full* falls out of the rule " +
          "rather than being a special case.\n\n" +
          "**The switch is `aria-labelledby` of two ids, not `aria-label`** — the heading " +
          "beside it and its own word, in that order. It is `DeckSettingsForm`'s " +
          "`TheorySwitch` pattern, and it is there because a label would replace the visible " +
          "*Disabled* with a name that does not contain it, which is the WCAG 2.5.3 failure " +
          "the shape exists to avoid.\n\n" +
          "The box comes from `controls.ts`'s `SWITCH`, which is this page's `BUTTON` at a " +
          "switch's size. It deliberately does **not** carry a tween of its own the way " +
          "`TheorySwitch` does: folded onto `BUTTON`, a colours-only tween and a 150ms " +
          "duration win the `tailwind-merge` groups `PRESS` uses, the list naming `scale` is " +
          "the one they replace, and the press snaps in a way nothing but the built CSS can " +
          "show. `PRESS` already tweens `color` and `border-color`, which is the whole of " +
          "what a switch's tone change is.",
      },
    },
  },
} satisfies Meta<typeof DeckDrivenPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The install default and the state a reader decides in: hand-kept, with the whole explanation
 * already on screen. It is said *here* rather than once the switch is on, because this is the
 * copy someone reads to make the choice — an explanation that is the reward for having already
 * chosen is an explanation nobody needed.
 */
export const Disabled: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const sw = canvas.getByRole("switch", { name: /deck driven collection.*disabled/i });
    await expect(sw).toHaveAttribute("aria-checked", "false");

    // The three jobs, in order.
    await expect(canvas.getByText(/sum of the cards in your decks/i)).toBeInTheDocument();
    await expect(canvas.getByText(/nothing is deleted/i)).toBeInTheDocument();

    await userEvent.click(sw);
    await expect(args.deckDriven.setDeckDriven).toHaveBeenCalledWith(true);
  },
};

/**
 * Switched on. The word on the control moves with the state and the accessible name moves with
 * it — that is the whole reason the name is composed from the heading *and* the visible word
 * rather than written out once as a label.
 *
 * The prose is unchanged, deliberately: a reader who is already deck-driven and is wondering
 * what happened to the cards they added by hand needs the third sentence more than anyone.
 */
export const Enabled: Story = {
  args: { deckDriven: deckDriven({ deckDriven: true }) },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const sw = canvas.getByRole("switch", { name: /deck driven collection.*enabled/i });
    await expect(sw).toHaveAttribute("aria-checked", "true");

    await userEvent.click(sw);
    await expect(args.deckDriven.setDeckDriven).toHaveBeenCalledWith(false);
  },
};

/**
 * A refused write, in the destructive red.
 *
 * `useDeckDrivenCollection` rolls its optimistic write back — which is where it parts company
 * with `useNavCollapsed`, whose refusal costs one launch's starting state and is not worth
 * snapping the rail shut under a reader's hand for. This switch decides what the Collection page
 * is a *list of*, so a switch left reading "Enabled" over a hand-kept collection would be the
 * page and the control disagreeing until the next restart. The rollback is what stops that, and
 * this sentence is the only thing left distinguishing a refusal from a press that did nothing.
 */
export const Refused: Story = {
  args: { deckDriven: deckDriven({ error: "The database is busy." }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("alert")).toHaveTextContent("The database is busy.");
    // Rolled back, so the switch reads exactly as it did before the press.
    await expect(canvas.getByRole("switch")).toHaveAttribute("aria-checked", "false");
  },
};
