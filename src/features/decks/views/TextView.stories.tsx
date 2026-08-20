import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  deckGroups,
  deckTheoryMatches,
  deckViolations,
  printing,
} from "../../../../.storybook/fake/fixtures";
import { THEORY_MATCH_ATTR } from "../CardMarks";
import { RAIL_ATTR } from "./columns";
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
 * Three columns in a 1024px desk: they wrap **down** rather than running off the right edge.
 *
 * `packColumns` opens each new column to the right, so a deck with more categories than a window
 * is wide used to grow sideways and hand the reader an X scrollbar across the whole desk — at
 * exactly the 1024px this decorator is, which is the narrowest window the app opens in. Nothing
 * about the packing changed; the row it lays its columns into wraps now, and the reader scrolls
 * down, which the desk already did for other reasons.
 *
 * **It was four columns until the Maybeboard joined the rail**, and three is still one more than
 * a line here holds, so what this story shows is unchanged. `columnHeight: 120` is what buys
 * them: the three flowing piles cost 64, 130 and 108px, so at the default 640 they would be a
 * single column and there would be nothing to wrap.
 *
 * Neither the Sideboard nor the Maybeboard is one of the three. Both are in the rail on the
 * right, whatever the flow does.
 */
export const WrappedColumns: Story = {
  args: { columnHeight: 120 },
  decorators: [
    // Width only, and 1024px on purpose: `tauri.conf.json`'s `minWidth`, the narrowest window
    // this app can be dragged to. A story's own decorators run *inside* the meta's, so
    // this box takes its 32rem of height from the column above rather than declaring a second
    // one — two boxes each setting a height would leave the inner one deciding and the outer one
    // lying. 1024 less the rail's 300 and the 24px gap leaves 700px, which holds two columns and
    // their gutter (624) and not three (948), so the three columns are two lines. It said "four
    // columns are two lines" while the rail held the Sideboard alone and the Maybeboard was the
    // fourth to flow; the per-line arithmetic is the half that did not change.
    // `shrink-0` because that box is a flex item: without it a docs canvas narrower
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
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    // **The wrap itself, asserted as the arithmetic that causes it**, because jsdom lays nothing
    // out: every rectangle here is 0×0 and no play in this file can see a second line. It was
    // asserted as nothing at all until now — the loop below passes on one line as happily as on
    // two, which is how the stack view's twin of this story quietly stopped demonstrating its own
    // subject when the Maybeboard was railed. More columns than fit on a line is a wrap.
    //
    // A packed column carries no attribute of its own, so they are reached through the rail's
    // sibling — the one structural assumption here, and one that fails loudly rather than quietly
    // if the view's two halves are ever rearranged. Everything else is read off what the view
    // writes: `COLUMN_WIDTH` in rem, on every column and on the rail alike, against this
    // decorator's own `w-[64rem]` and the root's `gap-6`.
    const flow = rail.previousElementSibling;
    expect(flow).not.toBeNull();
    const columns = [...(flow?.children ?? [])] as HTMLElement[];
    const desk = 64; // `w-[64rem]`
    const gap = 1.5; // `gap-6`, on the root and on the flowing box alike
    const flowWidth = desk - Number.parseFloat(rail.style.width) - gap;
    const perLine = Math.floor(
      (flowWidth + gap) / (Number.parseFloat(columns[0].style.width) + gap),
    );
    expect(columns).toHaveLength(3);
    expect(columns.length).toBeGreaterThan(perLine);
    // Every pile is still drawn, and that is the other half: wrapping moves a column, it never
    // costs one. A pile that had run off the right edge was drawn too — just nowhere the reader
    // was going to look.
    for (const pile of ["Commander", "Ramp", "Removal", "Maybeboard", "Sideboard"]) {
      expect(canvas.getByText(pile)).toBeInTheDocument();
    }
  },
};

/**
 * The rail: the two piles played *beside* the deck, in one column pinned to the right of the
 * flowing ones. It was the Sideboard alone, and it is the Sideboard and the Maybeboard now.
 *
 * Each is a category like any other to the greedy in-order pack, which dropped it wherever it
 * landed — usually the far end of a long sideways run, which is a poor place for the two piles a
 * reader looks for by position. Both are lifted out before the pack runs instead, so
 * `packColumns` never sees them and never reorders anything to make room for them.
 *
 * **Sideboard above Maybeboard is the reader's own `sortOrder`, 3 and 4, and not a rule of the
 * rail's** — nothing in the view sorts these two, so a reader who arranged them the other way
 * round gets them the other way round.
 *
 * The fixture's Sideboard is **empty** and the rail is drawn anyway: an empty pile is where the
 * next sideboard card goes, and a rail that only appeared with the first card would shove the
 * layout sideways under the hand that was dropping it. The Maybeboard under it is the other case
 * in the same story — switched off and holding cards, dimmed by the group rather than by the
 * rail, because a group in here is the same `TextGroup` as one in the flow.
 */
export const Rail: Story = {
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
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    expect(rail).toBeInTheDocument();
    // Both piles are in the rail, in that order — read off the headings their sections are
    // `aria-labelledby` rather than by looking for the words in a box. This said "the Sideboard
    // is in the rail, and it is the only thing that is", which stopped being true the day the
    // Maybeboard was railed beside it. **The reasoning under it survives**: the rail is the two
    // kinds `splitRail` pins and never a second column the packer may spill into, which is what
    // the absent `Removal` — a flowing pile, and the one that ends the flow — still says.
    expect([...rail.querySelectorAll('[id^="text-group-"]')].map((h) => h.textContent)).toEqual([
      "Sideboard",
      "Maybeboard",
    ]);
    expect(within(rail).queryByText("Removal")).not.toBeInTheDocument();
    // And it is still a drop target, because a group in the rail is the same `TextGroup` as a
    // group in the flow — the empty pile says so in its own words.
    expect(within(rail).getByText("Nothing here yet.")).toBeInTheDocument();
  },
};

/**
 * A pile the reader switched off, drawn in the rail **under** the Sideboard and the Maybeboard —
 * `StackView`'s change of 2026-08-17 arriving here, because both views split their groups through
 * the same `splitRail`.
 *
 * `is_active = 0` is the whole of what `maybe` ever meant: the pile counts toward nothing — not
 * size, not copy limits, not legality — so it is not part of the deck being written down, and a
 * packed column spent on it was a column spent on cards the reader had already said were out.
 * `Removal` here is the pile they switched off, and the pack is handed the two that are left.
 *
 * **The order is what to read.** Sideboard, Maybeboard, then Removal — even though Removal's
 * `sortOrder` is 2 and the Maybeboard's is 4. The kind is tested before the switch, so the two
 * piles played beside the deck head the rail whatever their own switches say; test it the other way
 * round and the Maybeboard, which is seeded off, would sink under whatever the reader turned off
 * most recently.
 *
 * **Two dimmed piles, and neither costs this view a line.** The Maybeboard and Removal are dimmed
 * by the group rather than by the rail — a group in here is the same `TextGroup` as one in the
 * flow — which is also why there is no divider above the switched-off run: the pile heading the
 * rail is switched off too, so a rule under it would mark a boundary that is not the one it looks
 * like.
 */
export const SwitchedOffPile: Story = {
  args: { groups: deckGroups("category", "alphabetical", false, "Removal") },
  decorators: [
    // {@link Rail}'s desk, for its reason.
    (Story) => (
      <div className="flex w-[52rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    expect([...rail.querySelectorAll('[id^="text-group-"]')].map((h) => h.textContent)).toEqual([
      "Sideboard",
      "Maybeboard",
      "Removal",
    ]);
    // The flow is what is left, and the gap Removal left closed up rather than being held open.
    const flow = rail.previousElementSibling as HTMLElement;
    expect([...flow.querySelectorAll('[id^="text-group-"]')].map((h) => h.textContent)).toEqual([
      "Commander",
      "Ramp",
    ]);
    // Both switched-off piles wear the chip, and both are in the rail: it travels with the group,
    // so a rail holding a lighter definition of a pile would lose them.
    expect(within(rail).getAllByText("INACTIVE")).toHaveLength(2);
  },
};

/** Grouped by mana value: the curve from the active cards, with the switched-off pile appended
 *  as itself — and, being `kind: "maybe"`, drawn in the rail rather than at the tail of the
 *  curve. The Sideboard is not here at all: it is empty *and* switched on, so a derived grouping
 *  keeps neither a bucket nor a pile for it, and the rail holds one pile instead of two. */
export const ByManaValue: Story = { args: { groups: deckGroups("manaValue", "manaCost") } };

/**
 * The **Live** list of a deck that keeps a plan.
 *
 * A decklist line is a quantity, a name and its marks, so the tick joins the finish glyph and the
 * `GC` badge at the end of the line rather than taking a corner it has not got. Decoration here:
 * the line is a button with an explicit `aria-label`, so the word is `deckCardName`'s — which is
 * why the assertion below reads the button's name rather than looking for text.
 */
export const TheoryMatches: Story = {
  args: { theoryMatches: deckTheoryMatches() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Four ticked cards. The mark is `aria-hidden` and carries no `title` any more — it is
    // bound `describes: false`, so `THEORY_MATCH_ATTR` is CardMarks.tsx's own handle for
    // finding it after the fact. The words below are read off the button instead.
    expect(canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)).toHaveLength(4);

    // The card that is both in the plan and breaking a rule, in one sentence.
    const both = canvas.getByRole("button", { name: new RegExp(`^${BROKEN}`) });
    expect(both).toHaveAccessibleName(expect.stringContaining("in the theory list"));
    expect(both).toHaveAccessibleName(expect.stringContaining("rule break:"));
  },
};
