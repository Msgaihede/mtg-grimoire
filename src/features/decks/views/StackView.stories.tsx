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
import { RAIL_ATTR } from "./columns";
import { StackView, STACK_ATTR } from "./StackView";

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
 * A deck wide enough that it has to be scrolled: eight piles — six that flow, and the two the
 * rail takes, a Sideboard with cards in it and a Maybeboard.
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
  // The two piles the rail takes, at the sort orders the reader's own arrangement gives them:
  // the seeded Sideboard at the **2** schema v8's migration gave it, third of the eight and
  // squarely inside that order, and the Maybeboard at **7**, last of them. **Four flowing piles
  // sit between the two** — Removal, Card draw, Threats and Lands, at 3 through 6 — which is what
  // makes this fixture worth reading twice: the rail draws
  // them adjacent and in that order, because nothing sorts the rail and the order is the
  // reader's. Where these two are *drawn* is the whole story below; where they sit is untouched
  // by it.
  const side = deckCategory("side");
  const maybe = deckCategory("maybe", { sortOrder: 7 });
  // Five piles the reader named. Ids of their own rather than a second `main` row out of
  // `DECK_CATEGORIES`, which holds one of each kind: a user may own any number of `main`
  // categories, and this deck's shape is the ordinary one.
  //
  // **They inherit `origin: "user"`, and four of these five names are words `autoCategoryFor`
  // also answers with** — which is the point rather than an oversight: who made a pile is a
  // column (`deck_categories.origin`), never a guess from what it is called, so `Ramp` here is
  // the reader's and draws the day they empty it.
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
 * The default view: the deck as stacks of cards, each in a 224px box, running left to right in
 * the reader's own category order — with the Sideboard *and the Maybeboard* lifted out of that
 * flow and held against the right edge.
 *
 * Five piles, and each one shows a different part of a header — the Commander's `RULE`, the
 * Maybeboard's `INACTIVE`, an empty Sideboard that still draws because it is where the next
 * sideboard card goes, and two categories the reader named.
 *
 * **Three of the five flow**, where four did while the rail held the Sideboard alone. The
 * other two are the rail, in the reader's own `sortOrder` — the Sideboard at 3 above the
 * Maybeboard at 4 — because both are piles played *beside* the deck rather than in it, and
 * nothing in the view sorts them. {@link Rail} is the story about the rail itself, and
 * {@link PinnedSideboard} the one about what taking those piles out of the flow is *for*.
 *
 * **No pile is drawn as a box.** The hairline is still there — `border-transparent`, stopped from
 * painting rather than removed, because `stackColumnWidth` counts it alongside the section's
 * padding and a border that ceased to exist would shift every card in the view by a pixel. What
 * is gone is the line: a pile is told from its neighbour by its heading and by the shape of its
 * stack, which is what a pile of cards on a desk looks like.
 *
 * Removal and the Maybeboard are still the pair to read across, and they are no longer two
 * columns of one pack: Removal ends the flow, and the Maybeboard is the lower of the two piles in
 * the rail. (Nothing packs here at all any more — see {@link WrappedPiles}.) The active pile is its cards and its heading and nothing else. The switched-off one
 * is found by the three quieter signals `StackGroup` spends on it instead of an edge: the wash
 * under the section, the stack drawn at `opacity-60` so the cards themselves recede, and the
 * header's own pair — the name in the dim face and the `INACTIVE` chip beside it. A line around
 * either pile, or a Maybeboard as bright as Removal, is the failure this story is here to make
 * obvious.
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
 * A deck with more piles than the desk is wide, which is the case the rail exists for: six
 * stacks wrapping down the page, and the two railed piles beside them rather than somewhere
 * inside them.
 *
 * Eight piles in a canvas capped at 768px. **Six** of them flow, each in its own 224px box. 768
 * less the rail's 224 and the 16px between them leaves **528px** for the flow, which holds two
 * boxes and their gutter (464) and not three (704), so the six wrap onto three lines beside the
 * rail. Neither the Sideboard nor the Maybeboard is in any of it — `splitRail` pins both kinds, so
 * both are taken out of the list before the flow is drawn, and drawn in the rail after.
 *
 * **Six of six, at any desk height, which is what changed on 2026-08-14.** The flow used to be
 * `packColumns`' answer, and this story's count was arithmetic about the *height* the meta's
 * decorator declares: two piles never shared a 640px column, so six piles were six columns by
 * coincidence of the fixture rather than by rule. Give that pack a taller desk and it answered
 * three columns with half the width empty beside them, which is the bug this replaced. There is no
 * height in the count now.
 *
 * **What to look at.** The rail is on the right, level with the top of the flow, and it holds
 * still while the flow grows *downward* past it. The failure it replaces is the one this fixture
 * is shaped for: a Sideboard or a Maybeboard packed like any other category lands at the far end
 * of a long run, which on the old sideways layout was off the right edge of the window and is now
 * several screens below the fold — the same pile out of reach, by the other axis. The Maybeboard
 * here is the literal worst case, at the last `sortOrder` of the eight.
 *
 * **The two railed piles sit at `sortOrder` 2 and 7** — the Sideboard third of the eight, where
 * schema v8's migration puts it, and the Maybeboard last — and the rail draws them adjacent, in
 * that order, with the four piles that sat between them flowing to the left. That is the whole of
 * the change, and the distinction worth keeping: the order the reader arranged is the order the
 * categories are *in*, and this one view now draws two of them somewhere else. Sideboard above
 * Maybeboard is that same order showing through and not a rule of the rail's — swap the two
 * `sortOrder`s and the rail swaps with them.
 */
export const PinnedSideboard: Story = {
  args: { groups: wideGroups() },
  decorators: [
    // Narrower than the flow on purpose — the meta's decorator sizes the desk's height and this
    // one caps its width, so the flow has to wrap and the rail has to hold its side of the line.
    (Story) => (
      <div className="flex w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const stacks = [...canvasElement.querySelectorAll<HTMLElement>(`[${STACK_ATTR}]`)];
    // The heading each box carries, found by the id its section is `aria-labelledby` rather than
    // by a guess at the header's shape. One box is one pile, so the six read in the reader's own
    // order with the Sideboard and the Maybeboard simply absent from them.
    expect(stacks.map((stack) => stack.querySelector('[id^="group-"]')?.textContent)).toEqual([
      "Commander",
      "Ramp",
      "Removal",
      "Card draw",
      "Threats",
      "Lands",
    ]);
    // And both are in the rail, which is **not** one of the boxes above: `STACK_ATTR` marks a pile
    // in the flow, and the rail's two are lifted out before the flow is drawn. One rail holding
    // both, in the reader's own order — which is what the two `sortOrder`s with four flowing piles
    // between them are for: nothing here sorted them, and nothing put them in a box each.
    const rails = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    expect(rails).toHaveLength(1);
    expect([...rails[0].querySelectorAll('[id^="group-"]')].map((h) => h.textContent)).toEqual([
      "Sideboard",
      "Maybeboard",
    ]);
  },
};

/**
 * A tall desk with a wide deck in it, which is the shape that broke and the reason this view stopped
 * packing.
 *
 * **This is the reader's screenshot, reproduced.** The meta's desk is 42rem and this story leaves
 * it there, widening the canvas instead. Under `packColumns` that height was the pack's ceiling:
 * six piles came to three tall columns, and every pixel of desk to the right of the third was
 * blank — the same deck in a *shorter* window spread across all six and looked correct, which is
 * how the bug read as a zoom problem. The count here now answers to nothing but how many piles the
 * deck has, and where they *sit* is CSS's answer to the width.
 *
 * **What to look at**: six stacks filling the width of the canvas before any of them uses its
 * height, and no gap at the right-hand end that a pile would have fitted in.
 */
export const TallDesk: Story = {
  args: { groups: wideGroups() },
  decorators: [
    // Wide enough for four boxes and their gutters beside the rail (4 × 224 + 3 × 16 = 944; plus
    // the rail's 224 and the 16 before it, 1184), so the flow fills a line and wraps once rather
    // than twice. `shrink-0` for the reason {@link WrappedPiles}' decorator carries it.
    (Story) => (
      <div className="flex w-[74rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const stacks = [...canvasElement.querySelectorAll<HTMLElement>(`[${STACK_ATTR}]`)];
    // Six flowing piles, six boxes — the assertion the packed layout failed at this desk height,
    // where it answered three. jsdom lays nothing out, so this is the count and not the wrap; the
    // wrap's arithmetic is {@link WrappedPiles}'.
    expect(stacks).toHaveLength(6);
  },
};

/**
 * Six stacks in a 1024px desk: they wrap **down** rather than running off the right edge.
 *
 * The flow used to open each new column to the right, so a deck with more categories than a window
 * is wide grew sideways and handed the reader an X scrollbar across the whole desk — at exactly
 * the 1024px this decorator is, which is the app's own floor. The box the piles sit in wraps now,
 * and the reader scrolls down, which this view already did for the card a stack lifts out of the
 * bottom of a pile.
 *
 * **It takes {@link wideGroups} to say that now, and that is a correction rather than a
 * flourish.** This story ran on the meta's five-pile deck, which flowed four piles while the rail
 * held the Sideboard alone — one more than a 1024px desk fits on a line, so the fourth wrapped
 * and the story was about something. With the Maybeboard railed as well that deck flows three,
 * three fit, and the story went on passing while demonstrating nothing at all: its play only ever
 * asked whether the piles were drawn. The wide deck flows six, and the play below now asserts the
 * wrap itself.
 */
export const WrappedPiles: Story = {
  args: { groups: wideGroups() },
  decorators: [
    // Width only, and 1024px on purpose: the narrowest window this app promises to be usable in,
    // which is the width the sideways run was forbidden at. A story's own decorators run
    // *inside* the meta's, so this box takes its 42rem of height from the column above rather
    // than declaring a second one — two boxes each setting a height would leave the inner one
    // deciding and the outer one lying. 1024 less the rail's 224 and the 16px gap leaves 784px,
    // which is three boxes to a line (704) and not four (944), so the last three take a second
    // line. `shrink-0` because that box is a flex item: without it a docs canvas narrower than
    // 1024px would shrink the decorator instead of scrolling, and the story would be a picture of
    // a width nobody asked for.
    (Story) => (
      <div className="flex w-[64rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const stacks = [...canvasElement.querySelectorAll<HTMLElement>(`[${STACK_ATTR}]`)];
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    // **The wrap, asserted as the arithmetic that causes it.** jsdom lays nothing out, so every
    // rectangle here is 0×0 and no play in this file can see a second line. What it *can* read is
    // what the layout is given: the widths this view writes inline — the same
    // `stackColumnWidth(zoom)` for a pile and for the rail, so this holds at whatever zoom the
    // **deck section** is left on rather than at 1× only — against the desk the decorator
    // declares. (`cardZoom.deck`: the desk's own number, shared with `GridView` because the two
    // are one deck drawn two ways, and not the docked search column's.) More
    // piles than fit on a line is a wrap, and pinning the count against that capacity is what
    // stops the story going quiet the way it just did: rail one more pile, or widen the rail
    // until a box no longer fits beside it, and this fails instead of silently drawing a
    // single line under a name that promises two.
    const desk = 1024; // the decorator's own `w-[64rem]`
    const gap = 16; // `gap-4`/`gap-x-4`, on the root and on the flowing box alike
    const columnWidth = Number.parseFloat(stacks[0].style.width);
    const flowWidth = desk - Number.parseFloat(rail.style.width) - gap;
    const perLine = Math.floor((flowWidth + gap) / (columnWidth + gap));
    expect(stacks).toHaveLength(6);
    expect(stacks.length).toBeGreaterThan(perLine);
    // Every pile is still drawn, and that is the other half: wrapping moves a pile, it never
    // costs one. A pile that had run off the right edge was drawn too — just nowhere the reader
    // was going to look.
    for (const pile of [
      "Commander",
      "Ramp",
      "Removal",
      "Card draw",
      "Threats",
      "Lands",
      "Sideboard",
      "Maybeboard",
    ]) {
      expect(canvas.getByText(pile)).toBeInTheDocument();
    }
  },
};

/**
 * Six piles, one of them eight cards deep and the rest one card each — the deck shape the flow
 * stopped being a row of flex lines for.
 *
 * **Local, and built to be lopsided.** {@link wideGroups} is a reasonable deck and every pile in
 * it is within a card or two of its neighbours, which is exactly the deck a layout bug of this kind
 * hides in. A real one is not like that: the creature pile is the deck and the rest are two or
 * three cards apiece.
 *
 * No Sideboard and no Maybeboard, so there is no rail and the whole desk is flow — the piles are
 * the only thing in the picture.
 */
function unevenGroups() {
  const commander = deckCategory("commander");
  const named = (id: number, name: string, sortOrder: number): DeckCategory => ({
    ...deckCategory("main"),
    id,
    name,
    sortOrder,
  });
  const creatures = named(20, "Creatures", 1);
  const ramp = named(21, "Ramp", 2);
  const removal = named(22, "Removal", 3);
  const draw = named(23, "Card draw", 4);
  const lands = named(24, "Lands", 5);

  const pile = (category: DeckCategory): Partial<DeckCard> => ({
    categoryId: category.id,
    categoryName: category.name,
    categoryKind: category.kind,
    categoryActive: category.isActive,
  });

  // Eight printings none of this file's other fixtures draw, so no two stories here are the same
  // deck with a different decorator.
  const creatureArt = [
    ["2x2", "117"],
    ["sld", "1638"],
    ["sta", "105"],
    ["vma", "4"],
    ["lea", "47"],
    ["2ed", "48"],
    ["eld", "115"],
    ["znr", "90"],
  ] as const;

  const cards = [
    deckCard(printing("eld", "303"), pile(commander)),
    ...creatureArt.map(([set, number]) => deckCard(printing(set, number), pile(creatures))),
    deckCard(printing("c21", "263"), pile(ramp)),
    deckCard(printing("gtc", "148"), pile(removal)),
    deckCard(printing("pcy", "45"), pile(draw)),
    deckCard(printing("mh2", "259"), pile(lands)),
  ].map((card) => ({ ...card, ownedQuantity: card.quantity }));

  return buildGroups(
    cards,
    [commander, creatures, ramp, removal, draw, lands],
    "category",
    "alphabetical",
  );
}

/**
 * **The story the masonry exists for**: one pile far taller than the rest, and the piles that wrap
 * under it starting at the foot of the pile *above* them rather than under the tall one.
 *
 * Three columns, six piles. Commander, Creatures and Ramp take the first line; the Creatures pile
 * is eight cards deep and the two beside it are one card each. Removal then starts directly under
 * the Commander, Card draw under Ramp, and Lands under Removal — all of it while the Creatures
 * stack is still running down the middle of the desk.
 *
 * **What this replaced, and what the reader saw.** The flow was a wrapping flex box until
 * 2026-08-15, and a flex line is as tall as the tallest item in it: Removal, Card draw and Lands
 * all began *below* the eight-card stack, so the desk carried a band of blank space under every
 * short pile the height of the long one — three cards' worth here, and far worse in a deck with a
 * forty-card creature pile in it, which is the ordinary case. Wrapping had already fixed the same
 * bug on the other axis (see {@link WrappedPiles}); this is the half it left standing.
 *
 * **What has not changed is the order.** The piles are the reader's own `sortOrder` in the DOM and
 * grid placement never walks back up the page, so reading order, tab order and what a screen reader
 * hears are exactly what they were — which is the reason this is a grid of one-pixel rows and not
 * six hand-assigned columns. A column-per-box layout would draw the same picture and read it out
 * in the wrong order.
 */
export const UnevenPiles: Story = {
  args: { groups: unevenGroups() },
  decorators: [
    // 736px, which is three boxes and their two gutters (3 × 224 + 2 × 16 = 704) **plus room for
    // a scrollbar**, and the 32 is not slack. There is no rail to leave room for here, so 704
    // would be the exact fit — and it draws two columns, because the meta's decorator hands this
    // view a fixed 42rem of height, the deck is taller than that, and the 15px vertical scrollbar
    // the root then draws comes out of the flow's width before `auto-fill` counts anything. The
    // editor gives this view no height at all and never has that scrollbar; a story that declares
    // one has to pay for it. Width only and `shrink-0`, for {@link WrappedPiles}' reasons.
    (Story) => (
      <div className="flex w-[46rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const stacks = [...canvasElement.querySelectorAll<HTMLElement>(`[${STACK_ATTR}]`)];
    // The whole deck flows — no `side` and no `maybe` pile, so no rail — and the order is the
    // reader's. **Where** each one is drawn is not a question jsdom can be asked: it lays nothing
    // out, so every pile here measures 0 and every span is the gutter alone. The picture is the
    // thing to look at, and the arithmetic behind it is `flowRowSpan`'s own test.
    expect(canvasElement.querySelectorAll(`[${RAIL_ATTR}]`)).toHaveLength(0);
    expect(stacks.map((stack) => stack.querySelector('[id^="group-"]')?.textContent)).toEqual([
      "Commander",
      "Creatures",
      "Ramp",
      "Removal",
      "Card draw",
      "Lands",
    ]);
  },
};

/**
 * The rail: the two piles played *beside* the deck, in one column pinned to the right of the
 * flowing ones. It was the Sideboard alone, and it is the Sideboard and the Maybeboard now.
 *
 * Each was a category like any other to the run that drew them, landing wherever it fell — usually
 * the far end of a long sideways run, which is a poor place for the two piles a reader looks for
 * by position. Both are lifted out before the flow is drawn instead, so nothing reorders anything
 * to make room for them. Where the flow wraps to is not their business either: the rail is right
 * of it at every width that has room for the two.
 *
 * **Nothing here sorts the rail.** Sideboard above Maybeboard is the fixture's own `sortOrder`,
 * 3 and 4, showing through; a reader who arranged them the other way round gets them the other
 * way round.
 *
 * The two piles are deliberately unalike, because the rail is a *place* and never a state. The
 * fixture's Sideboard is **empty** and the rail is drawn anyway: an empty pile is where the next
 * sideboard card goes, and a rail that only appeared with the first card would shove the layout
 * sideways under the hand that was dropping it. The Maybeboard under it is switched off and holds
 * cards, so it arrives carrying the wash, the dimmed name, the `INACTIVE` chip and its stack's
 * `opacity-60` — none of which the rail knows anything about, because a group in it is the same
 * `StackGroup` as a group in the flow.
 */
export const Rail: Story = {
  decorators: [
    // 832px, which leaves two of the three piles to a line beside the rail. Width only and
    // `shrink-0`, for {@link WrappedPiles}' reasons.
    (Story) => (
      <div className="flex w-[52rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    expect(rail).toBeInTheDocument();
    // Which side of the desk they are drawn on is not a question jsdom can be asked — it lays
    // nothing out — but which box a pile is in is, and that is the claim: both headings are in
    // the rail, in the reader's own order, and in none of the flow's boxes. A pile the flow had
    // seen would be one of them, wherever the run happened to put it.
    expect([...rail.querySelectorAll('[id^="group-"]')].map((h) => h.textContent)).toEqual([
      "Sideboard",
      "Maybeboard",
    ]);
    const stacks = [...canvasElement.querySelectorAll(`[${STACK_ATTR}]`)];
    for (const pile of ["Sideboard", "Maybeboard"]) {
      expect(stacks.some((stack) => stack.textContent?.includes(pile))).toBe(false);
    }
    // And it is still a drop target, because a group in the rail is the same `StackGroup` as a
    // group in the flow — the empty Sideboard says so in its own words, and it is the only pile
    // here saying it.
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
 * **There is a rail here, holding one pile — and there used to be none.** The rail is whatever
 * `side` and `maybe` groups there are, and this grouping keeps only the buckets and the
 * switched-off piles: a derived bucket carries `kind: null`, so the curve flows, while the
 * Maybeboard is appended as *itself*, `kind: "maybe"` and all, and is therefore railed. That is
 * the ordinary case rather than a corner — the Maybeboard is seeded switched off, so under a
 * derived grouping it reaches the rail by this route almost every time. This deck's Sideboard is
 * empty *and* switched on, so `buildGroups` keeps it out of a derived grouping altogether and the
 * rail is one pile rather than two; switch that one boolean off and it would join the Maybeboard
 * here, exactly as it sits above it under `Categories`.
 */
export const ByManaValue: Story = {
  args: { groups: deckGroups("manaValue", "manaCost") },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("INACTIVE")).toBeInTheDocument();
    // The Maybeboard is in the rail rather than at the tail of the curve, and it is there alone.
    // Read off the headings the sections are `aria-labelledby` rather than by looking for the
    // word in a box, so a card whose name contained it could not answer for the pile.
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    expect([...rail.querySelectorAll('[id^="group-"]')].map((h) => h.textContent)).toEqual([
      "Maybeboard",
    ]);
  },
};

/** Grouped by type, which is the same vocabulary the add path files an uncategorised card by
 *  — one list, so a sort and a grouping cannot disagree about what a type is. */
export const ByType: Story = { args: { groups: deckGroups("type", "type") } };
