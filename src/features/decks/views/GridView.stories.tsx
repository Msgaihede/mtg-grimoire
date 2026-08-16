import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { GAME_CHANGER_LABEL } from "@/components/GameChangerMark";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckGroups, deckViolations } from "../../../../.storybook/fake/fixtures";
import { GridView } from "./GridView";

const meta = {
  title: "Decks/Views/GridView",
  component: GridView,
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
      <div className="flex h-[36rem]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GridView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The stack's opposite: every card drawn, none of them covering another.
 *
 * A stack is for reading *down* a category; this is for seeing a whole deck at once — which is
 * what you want the moment before you cut something. A tile is the search wall's tile — the same
 * `CardArt` frame, the same corner marks — so a reader looking at the docked search column and
 * the deck laid out beside it is looking at one object rather than two.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The Commander and the Sideboard; a category the reader named has no rules role.
    expect(canvas.getAllByText("RULE")).toHaveLength(2);
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
    // The two marks, in the two corners they never share.
    expect(canvas.getByText("RULE BREAK")).toBeInTheDocument();
    // **The crown, not `GC`** (changed 2026-08-16). This wall draws whole card faces and has the
    // room for the glyph, so it says the fact the way `CardArt` says it everywhere else — which
    // is what the deck editor's own search column beside it has always drawn. `GameChangerBadge`'s
    // two letters are still the table's and the text columns', where there is no art to lay a
    // chip on. `hidden: true` because the whole overlay is `aria-hidden`; the words are in the
    // button's own label.
    const crowned = canvas.getByRole("button", { name: /^Lightning Bolt/ });
    expect(
      within(crowned).getByRole("img", { name: GAME_CHANGER_LABEL, hidden: true }),
    ).toBeInTheDocument();
    expect(crowned).toHaveAccessibleName(expect.stringContaining("game changer"));
  },
};

/** Grouped by type — the wall a reader scans before deciding the creature count is wrong. */
export const ByType: Story = { args: { groups: deckGroups("type", "type") } };

/** No findings at all: a legal deck draws no red anywhere, which is what makes the red mean
 *  something on the deck that is not. */
export const NothingWrong: Story = { args: { violations: undefined } };
