import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckGroups, deckViolations } from "../../../../.storybook/fake/fixtures";
import { StackView } from "./StackView";

const meta = {
  title: "Decks/Views/StackView",
  component: StackView,
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
      <div className="flex h-[42rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof StackView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default view: the deck as stacks of cards, packed into 224px columns in the reader's own
 * category order.
 *
 * Five piles, and each one shows a different part of a header — the Commander's `RULE`, the
 * Maybeboard's `INACTIVE`, an empty Sideboard that still draws because it is where the next
 * sideboard card goes, and two categories the reader named.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Two piles the rules read by name — the Commander and the Sideboard. A category the
    // reader made has no rules role and carries no marker.
    expect(canvas.getAllByText("RULE")).toHaveLength(2);
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
    expect(canvas.getByText("Nothing here yet.")).toBeInTheDocument();
    // The rule break and the game changer, side by side and unmistakable.
    expect(canvas.getByText("RULE BREAK")).toBeInTheDocument();
    expect(canvas.getByText("GC")).toBeInTheDocument();
  },
};

/**
 * A short column: the packer starts a new one as soon as the next group would not fit, in
 * order and without splitting a pile. Order is the whole constraint — a balanced packer fits
 * more in and puts the Sideboard between Ramp and Removal.
 */
export const NarrowColumns: Story = { args: { columnHeight: 420 } };

/**
 * Grouped by mana value instead of by category.
 *
 * The curve is built from the **active** cards only, and the Maybeboard is then appended as
 * itself — switched off, unchanged, and still reachable. Bucketing its cards into the curve
 * would count a scratchpad into the deck; dropping the pile would make it vanish the moment
 * the reader changed a select.
 */
export const ByManaValue: Story = {
  args: { groups: deckGroups("manaValue", "manaCost") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("Maybeboard")).toBeInTheDocument();
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
  },
};

/** Grouped by type, which is the same vocabulary the add path files an uncategorised card by
 *  — one list, so a sort and a grouping cannot disagree about what a type is. */
export const ByType: Story = { args: { groups: deckGroups("type", "type") } };
