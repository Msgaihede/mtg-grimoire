import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  deckCard,
  deckCategory,
  deckGroups,
  deckViolations,
  printing,
} from "../../../../.storybook/fake/fixtures";
import { buildGroups } from "../grouping";
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
 * A deck wide enough that it has to be scrolled: eight piles, one of them a Sideboard with
 * cards in it.
 *
 * **Local to this file on purpose.** `.storybook/fake/fixtures.ts` is where a fixture goes when
 * a *second* story file needs it — the constraint being that a CSF module cannot own one, since
 * every non-default export of one is indexed as a story. A plain function exported to nobody is
 * indexed as nothing, and one file's fixture belongs in that file.
 *
 * Built through the app's own `buildGroups`, for the reason `deckGroups` is: the columns this
 * story makes a claim about are then the ones `grouping.ts` really answers, in the `sortOrder` a
 * reader arranged, rather than eight hand-written agreements about what it ought to answer.
 *
 * Every row owns as many copies as the deck wants, and that is the one convenience here rather
 * than a fact: a shortage chip on twenty cards would draw a wall of red across a story whose
 * subject is the columns.
 */
function wideGroups() {
  const commander = deckCategory("commander");
  // The seeded Sideboard at the `sortOrder` schema v8's migration gave it — **2**, third of the
  // eight and squarely inside the reader's own order. Where this pile is *drawn* is the whole
  // story below; where it sits is untouched by it.
  const side = deckCategory("side");
  const maybe = deckCategory("maybe", { sortOrder: 7 });
  // Five piles the reader named. Ids of their own rather than a second `main` row out of
  // `DECK_CATEGORIES`, which holds one of each kind: a user may own any number of `main`
  // categories, and this deck's shape is the ordinary one.
  const named = (id: number, name: string, sortOrder: number): DeckCategory => ({
    ...deckCategory("main"),
    id,
    name,
    sortOrder,
  });
  const ramp = named(10, "Ramp", 1);
  const removal = named(11, "Removal", 3);
  const draw = named(12, "Card draw", 4);
  const threats = named(13, "Threats", 5);
  const lands = named(14, "Lands", 6);

  // The four fields a row carries about the pile it is in, so a card and its heading cannot
  // disagree about which column it is in or whether it counts.
  const pile = (category: DeckCategory): Partial<DeckCard> => ({
    categoryId: category.id,
    categoryName: category.name,
    categoryKind: category.kind,
    categoryActive: category.isActive,
  });

  const cards = [
    deckCard(printing("eld", "303"), pile(commander)),
    deckCard(printing("c21", "263"), pile(ramp)),
    deckCard(printing("lea", "232"), pile(ramp)),
    deckCard(printing("tmp", "315"), pile(ramp)),
    deckCard(printing("mh2", "267"), { ...pile(side), quantity: 2 }),
    deckCard(printing("ema", "32"), pile(side)),
    deckCard(printing("nph", "57"), pile(side)),
    deckCard(printing("gtc", "148"), pile(removal)),
    deckCard(printing("lea", "161"), pile(removal)),
    deckCard(printing("apc", "128"), pile(removal)),
    deckCard(printing("pcy", "45"), pile(draw)),
    deckCard(printing("mp2", "8"), pile(draw)),
    deckCard(printing("mh2", "138"), pile(threats)),
    deckCard(printing("fut", "153"), pile(threats)),
    deckCard(printing("roe", "4"), pile(threats)),
    deckCard(printing("lea", "288"), { ...pile(lands), quantity: 4 }),
    deckCard(printing("unf", "239"), { ...pile(lands), quantity: 3 }),
    deckCard(printing("mh2", "259"), pile(lands)),
    deckCard(printing("wwk", "31"), pile(maybe)),
    deckCard(printing("isd", "51"), pile(maybe)),
  ].map((card) => ({ ...card, ownedQuantity: card.quantity }));

  return buildGroups(
    cards,
    [commander, ramp, side, removal, draw, threats, lands, maybe],
    "category",
    "alphabetical",
  );
}

/**
 * The default view: the deck as stacks of cards, packed into 224px columns in the reader's own
 * category order — with the Sideboard lifted out of that pack and held against the right edge.
 *
 * Five piles, and each one shows a different part of a header — the Commander's `RULE`, the
 * Maybeboard's `INACTIVE`, an empty Sideboard that still draws because it is where the next
 * sideboard card goes, and two categories the reader named.
 *
 * Four of the five are packed. The fifth is the Sideboard, and it is in the rail on the right —
 * {@link SideboardRail} is the story about the rail itself, and {@link PinnedSideboard} the one
 * about what taking that pile out of the pack is *for*.
 *
 * **No pile is drawn as a box.** The hairline is still there — `border-transparent`, stopped from
 * painting rather than removed, because `stackColumnWidth` counts it alongside the section's
 * padding and a border that ceased to exist would shift every card in the view by a pixel. What
 * is gone is the line: a pile is told from its neighbour by its heading and by the shape of its
 * stack, which is what a pile of cards on a desk looks like.
 *
 * Removal and the Maybeboard are the pair to read across, in the two columns that end the pack.
 * The active pile is its cards and its heading and nothing else. The switched-off one is found
 * by the three quieter signals `StackGroup` spends on it instead of an edge: the wash under the
 * section, the stack drawn at `opacity-60` so the cards themselves recede, and the header's own
 * pair — the name in the dim face and the `INACTIVE` chip beside it. A line around either pile,
 * or a Maybeboard as bright as Removal, is the failure this story is here to make obvious.
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
 * A deck with more piles than the desk is wide, which is the case the rail exists for: seven
 * columns wrapping down the page, and the Sideboard beside them rather than somewhere inside
 * them.
 *
 * Eight piles in a canvas capped at 768px. Seven of them pack, one to a column — at 1× no two
 * of these groups share a 640px desk, since the smallest pair is 393 + 427 = 820px — so the pack
 * is 7 × 224px with 16px gutters, laid into a box that holds one column beside the rail and
 * wraps the rest onto the lines below. The Sideboard is in none of it: it is `kind: "side"`, so
 * it is taken out of the list before `packColumns` is given one, and drawn in the rail after.
 *
 * **What to look at.** The rail is on the right, level with the top of the flow, and it holds
 * still while the pack grows *downward* past it. The failure it replaces is the one this fixture
 * is shaped for: a Sideboard packed like any other category lands at the far end of a long run,
 * which on the old sideways layout was off the right edge of the window and is now several
 * screens below the fold — the same pile out of reach, by the other axis.
 *
 * **The Sideboard's `sortOrder` is 2 here** — the seeded one's, third of the eight, between Ramp
 * and Removal — and it is still drawn last. That is the whole of the change, and the distinction
 * worth keeping: the order the reader arranged is the order the categories are *in*, and this
 * one view now draws one of them somewhere else.
 */
export const PinnedSideboard: Story = {
  args: { groups: wideGroups() },
  decorators: [
    // Narrower than the pack on purpose — the meta's decorator sizes the desk's height and this
    // one caps its width, so the flow has to wrap and the rail has to hold its side of the line.
    (Story) => (
      <div className="flex w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const columns = [...canvasElement.querySelectorAll<HTMLElement>(`[${STACK_COLUMN_ATTR}]`)];
    // The heading each column opens with, found by the id its section is `aria-labelledby`
    // rather than by a guess at the header's shape. No column here holds a second group, so one
    // heading names a whole column — and the seven read in the reader's own order with the
    // Sideboard simply absent from them.
    expect(columns.map((column) => column.querySelector('[id^="group-"]')?.textContent)).toEqual([
      "Commander",
      "Ramp",
      "Removal",
      "Card draw",
      "Threats",
      "Lands",
      "Maybeboard",
    ]);
    // And it is in the rail, which is **not** one of the boxes above: `STACK_COLUMN_ATTR` marks
    // what `packColumns` produced, and the rail is the one box it never saw.
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${SIDEBOARD_ATTR}]`);
    expect(within(rail).getByText("Sideboard")).toBeInTheDocument();
    expect(canvasElement.querySelectorAll(`[${SIDEBOARD_ATTR}]`)).toHaveLength(1);
  },
};

/**
 * A short column: the packer starts a new one as soon as the next group would not fit, in
 * order and without splitting a pile. Order is the whole constraint — a balanced packer fits
 * more in and puts the Maybeboard between Ramp and Removal.
 *
 * **The Sideboard is no longer an example of that and cannot be one again**: it leaves the list
 * before `packColumns` sees it, so at every `columnHeight` it is in the rail on the right rather
 * than in a packed column somewhere in the middle. Four columns pack here — Commander, Ramp,
 * Removal, Maybeboard — where five did before the split.
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
 * **And no rail here, which is not a special case: the fixture is why, not the mode.** The rail
 * is whatever `side` groups there are, and this grouping keeps only the buckets and the
 * switched-off piles — a derived bucket carries `kind: null`, so the curve flows, and this deck's
 * Sideboard is empty *and* switched on, so it is neither and is not drawn at all. Switch that one
 * boolean off and `buildGroups` would append the pile as itself, `kind: "side"` and all — exactly
 * as it appends the Maybeboard below — and this layout would draw a rail beside the curve, as it
 * does under `Categories`.
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
