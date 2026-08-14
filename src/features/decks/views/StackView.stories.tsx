import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import { deckGroups, deckViolations } from "../../../../.storybook/fake/fixtures";
import { SIDEBOARD_ATTR } from "./columns";
import { StackView, STACK_COLUMN_ATTR } from "./StackView";

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
 *
 * Four of the five are packed. The fifth is the Sideboard, and it is in the rail on the right —
 * see {@link SideboardRail}.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Two piles the rules read by name — the Commander and the Sideboard. A category the
    // reader made has no rules role and carries no marker.
    expect(canvas.getAllByText("RULE")).toHaveLength(2);
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
    expect(canvas.getByText("Nothing here yet.")).toBeInTheDocument();
    // The rule break and the game changer, side by side and unmistakable. This view has room
    // for the words, so the game changer is the banner rather than the grid tile's `GC`.
    expect(canvas.getByText("RULE BREAK")).toBeInTheDocument();
    expect(canvas.getByText("Game Changer")).toBeInTheDocument();
  },
};

/**
 * A short column: the packer starts a new one as soon as the next group would not fit, in
 * order and without splitting a pile. Order is the whole constraint — a balanced packer fits
 * more in and puts the Sideboard between Ramp and Removal.
 */
export const NarrowColumns: Story = { args: { columnHeight: 420 } };

/**
 * Four columns in a 1024px desk: they wrap **down** rather than running off the right edge.
 *
 * `packColumns` opens each new column to the right, so a deck with more categories than a window
 * is wide used to grow sideways and hand the reader an X scrollbar across the whole desk — at
 * exactly the 1024px this decorator is, which is the app's own floor. Nothing about the packing
 * changed; the row it lays its columns into wraps now, and the reader scrolls down, which this
 * view already did for the card a stack lifts out of the bottom of a column.
 *
 * Four columns out of four flowing piles, at the **default** column height and with no argument
 * saying so: a three-card pile costs the packer **461px** — a 46px header block, the 395px stack
 * itself (`stackHeight(3, 1×)`) and the 20px gap to the next group — so two piles have never
 * fitted in one 640px column. That is the ordinary state of this view rather than a state a
 * story arranged.
 */
export const WrappedColumns: Story = {
  decorators: [
    // Width only, and 1024px on purpose: the narrowest window this app promises to be usable in,
    // which is the width the sideways run was forbidden at. A story's own decorators run
    // *inside* the meta's, so this box takes its 42rem of height from the column above rather
    // than declaring a second one — two boxes each setting a height would leave the inner one
    // deciding and the outer one lying. 1024 less the rail and the gap leaves three columns to a
    // line, so the fourth is a second line. `shrink-0` because that box is a flex item: without
    // it a docs canvas narrower than 1024px would shrink the decorator instead of scrolling, and
    // the story would be a picture of a width nobody asked for.
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
 * It is a category like any other to the greedy in-order pack, which dropped it wherever it
 * landed — usually the far end of a long sideways run, which is a poor place for the one pile a
 * reader looks for by position. It is lifted out before the pack runs instead, so `packColumns`
 * never sees it and never reorders anything to make room for it. Where the flow wraps to is not
 * its business either: the rail is right of it at every width that has room for the two.
 *
 * The fixture's Sideboard is **empty** and the rail is drawn anyway: an empty pile is where the
 * next sideboard card goes, and a rail that only appeared with the first card would shove the
 * layout sideways under the hand that was dropping it.
 */
export const SideboardRail: Story = {
  decorators: [
    // 832px, which leaves two of the four columns to a line beside the rail. Width only and
    // `shrink-0`, for {@link WrappedColumns}' reasons.
    (Story) => (
      <div className="flex w-[52rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${SIDEBOARD_ATTR}]`);
    expect(rail).toBeInTheDocument();
    // Which side of the desk it is drawn on is not a question jsdom can be asked — it lays
    // nothing out — but which box it is in is, and that is the claim: the heading is in the rail
    // and in none of the packed columns. A Sideboard the pack had seen would be inside one of
    // them, wherever the run happened to put it.
    expect(within(rail).getByText("Sideboard")).toBeInTheDocument();
    const columns = [...canvasElement.querySelectorAll(`[${STACK_COLUMN_ATTR}]`)];
    expect(columns.some((column) => column.textContent?.includes("Sideboard"))).toBe(false);
    // And it is still a drop target, because a group in the rail is the same `StackGroup` as a
    // group in the flow — the empty pile says so in its own words.
    expect(within(rail).getByText("Nothing here yet.")).toBeInTheDocument();
  },
};

/**
 * Grouped by mana value instead of by category.
 *
 * The curve is built from the **active** cards only, and the Maybeboard is then appended as
 * itself — switched off, unchanged, and still reachable. Bucketing its cards into the curve
 * would count a scratchpad into the deck; dropping the pile would make it vanish the moment
 * the reader changed a select.
 *
 * No rail in this one, and **the fixture is why, not the mode**. A derived bucket carries no
 * `kind`, so the curve flows; the fixture's Sideboard is empty and switched **on**, and an
 * active category is only its cards here, so it has nothing to contribute and disappears. Switch
 * that one boolean off and `buildGroups` would append the pile as itself, `kind: "side"` and
 * all — exactly as it appends the Maybeboard below — and this layout would draw a rail beside
 * the curve.
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
