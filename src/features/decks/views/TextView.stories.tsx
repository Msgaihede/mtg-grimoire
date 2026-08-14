import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckGroups, deckViolations, printing } from "../../../../.storybook/fake/fixtures";
import { SIDEBOARD_ATTR } from "./columns";
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

/**
 * Four columns in a 1024px desk: they wrap **down** rather than running off the right edge.
 *
 * `packColumns` opens each new column to the right, so a deck with more categories than a window
 * is wide used to grow sideways and hand the reader an X scrollbar across the whole desk — at
 * exactly the 1024px this decorator is, which is the narrowest window the app opens in. Nothing
 * about the packing changed; the row it lays its columns into wraps now, and the reader scrolls
 * down, which the desk already did for other reasons.
 *
 * The Sideboard is not one of the four. It is in the rail on the right, whatever the flow does.
 */
export const WrappedColumns: Story = {
  args: { columnHeight: 120 },
  decorators: [
    // Width only, and 1024px on purpose: `tauri.conf.json`'s `minWidth`, the narrowest window
    // this app can be dragged to. A story's own decorators run *inside* the meta's, so
    // this box takes its 32rem of height from the column above rather than declaring a second
    // one — two boxes each setting a height would leave the inner one deciding and the outer one
    // lying. 1024 less the rail and the gap leaves two columns to a line, so four columns are
    // two lines. `shrink-0` because that box is a flex item: without it a docs canvas narrower
    // than 1024px would shrink the decorator instead of scrolling, and the story would be a
    // picture of a width nobody asked for.
    (Story) => (
      <div className="flex w-[64rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Every pile is still drawn, and that is the whole claim: wrapping moves a column, it never
    // costs one. A pile that had run off the right edge was drawn too — just nowhere the reader
    // was going to look.
    for (const pile of ["Commander", "Ramp", "Removal", "Maybeboard", "Sideboard"]) {
      expect(canvas.getByText(pile)).toBeInTheDocument();
    }
  },
};

/**
 * The Sideboard as its own column, pinned to the right of the flowing ones.
 *
 * It is a category like any other to the greedy in-order pack, which dropped it wherever it landed
 * — usually the far end of a long sideways run, which is a poor place for the one pile a reader
 * looks for by position. It is lifted out before the pack runs instead, so `packColumns` never
 * sees it and never reorders anything to make room for it.
 *
 * The fixture's Sideboard is **empty** and the rail is drawn anyway: an empty pile is where the
 * next sideboard card goes, and a rail that only appeared with the first card would shove the
 * layout sideways under the hand that was dropping it.
 */
export const SideboardRail: Story = {
  decorators: [
    // 832px, which at the default column height is one packed column and the rail: wide enough
    // that the gap between them is the layout speaking rather than an accident of the canvas.
    // Width only and `shrink-0`, for {@link WrappedColumns}' reasons.
    (Story) => (
      <div className="flex w-[52rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${SIDEBOARD_ATTR}]`);
    expect(rail).toBeInTheDocument();
    // The Sideboard is in the rail, and it is the only thing that is — the rail is a place for
    // one kind of pile, not a second column the packer may spill into.
    expect(within(rail).getByText("Sideboard")).toBeInTheDocument();
    expect(within(rail).queryByText("Removal")).not.toBeInTheDocument();
    // And it is still a drop target, because a group in the rail is the same `TextGroup` as a
    // group in the flow — the empty pile says so in its own words.
    expect(within(rail).getByText("Nothing here yet.")).toBeInTheDocument();
  },
};

/** Grouped by mana value: the curve from the active cards, with the switched-off pile
 *  appended as itself. */
export const ByManaValue: Story = { args: { groups: deckGroups("manaValue", "manaCost") } };
