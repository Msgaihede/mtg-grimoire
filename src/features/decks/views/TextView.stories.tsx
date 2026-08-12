import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckGroups, deckViolations, printing } from "../../../../.storybook/fake/fixtures";
import { TextView } from "./TextView";

/** The one card the fixture's finding is about, named off the corpus rather than pasted. */
const BROKEN = printing("lea", "288").name;

const meta = {
  title: "Decks/Views/TextView",
  component: TextView,
  tags: ["autodocs"],
  args: {
    groups: deckGroups(),
    // The default, and what every dollar figure in this file is a claim about. The setting
    // itself is `Settings/MarketplacePanel`; what a view owes it is one currency for the whole
    // screen, so a heading and the cards under it cannot name two.
    marketplace: MARKETPLACES.tcgplayer,
    violations: deckViolations(),
    onSelect: fn(),
  },
  decorators: [
    (Story) => (
      <div className="flex h-[32rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TextView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The deck written down: one line per card, in 300px columns, the way a decklist is printed.
 *
 * The densest of the four and the one to reach for when the question is "what is in this deck"
 * rather than "what does this card do". No art at all — a line is a quantity, a name, its
 * marks and its cost.
 *
 * The `RULE BREAK` chip has no room on a 22px row, so the mark here is the **stripe** down the
 * left of the name — destructive for a break, gold for a game changer. The sentence is not
 * lost: it is the row's `title` and it is in the control's own name.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The Commander and the Sideboard; a category the reader named has no rules role.
    expect(canvas.getAllByText("RULE")).toHaveLength(2);
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
    const broken = canvas.getByRole("button", { name: new RegExp(`^${BROKEN}`) });
    expect(broken.getAttribute("aria-label")).toContain("rule break");
  },
};

/** A short column, so the packer has to start a second one — in order, never splitting a
 *  pile. */
export const NarrowColumns: Story = { args: { columnHeight: 200 } };

/** Grouped by mana value: the curve from the active cards, with the switched-off pile
 *  appended as itself. */
export const ByManaValue: Story = { args: { groups: deckGroups("manaValue", "manaCost") } };
