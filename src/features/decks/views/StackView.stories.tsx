import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { DeckCard, DeckCategory } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import {
  deckCard,
  deckCategory,
  deckGroups,
  deckTheoryMatches,
  deckViolations,
  printing,
} from "../../../../.storybook/fake/fixtures";
import { THEORY_MATCH_ATTR } from "../CardMarks";
import { DECK_CARD_ATTR } from "../dnd";
import { buildGroups } from "../grouping";
import { RAIL_ATTR } from "./columns";
import { COMMAND_ATTR, StackView, STACK_ATTR } from "./StackView";

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
/**
 * @param switchedOff the name of one pile of the reader's own to switch **off** — `is_active = 0`,
 *   the pile that counts toward nothing. Absent, every category here is on and this is the fixture
 *   the four wide-deck stories have always drawn. It is a name rather than an id because the only
 *   caller is a story naming a heading a reader would recognise, and it is one pile rather than a
 *   list because the story it serves is about *where* a switched-off pile is drawn, which one of
 *   them answers as well as five.
 */
function wideGroups(switchedOff?: string) {
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
    isActive: name !== switchedOff,
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
 * **Two of the five flow now, and the deck is drawn in three boxes rather than two.** The
 * Commander is the head of the desk — its own box, one column wide, holding the piles the deck was
 * built *around* rather than the piles it is made of ({@link CommandZone} is the story about that
 * box, and the one that shows it holding two piles). Ramp and Removal flow. The Sideboard and the
 * Maybeboard are the rail, in the reader's own `sortOrder` — the Sideboard at 3 above the
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
 * Eight piles in a canvas capped at 768px, in **six** items of the flowing grid: the command zone,
 * which is the Commander alone here, and then five piles each in its own 224px box. 768 less the
 * rail's 224 and the 16px between them leaves **528px** for the flow, which holds two boxes and
 * their gutter (456) and not three (688), so the six wrap onto three lines beside the rail. Every
 * item is one column wide, the command zone included, so the arithmetic is what it was when the
 * Commander was the first of six flowing piles rather than the first item of six. Neither the
 * Sideboard nor the Maybeboard is in any of it — `splitRail` pins both kinds, so both are taken out
 * of the list before the flow is drawn, and drawn in the rail after.
 *
 * **The flowing box is 528 again, and the 72px remainder is inside it** (changed 2026-08-18; the
 * remainder was 64 until the deck's own gutter was halved on 2026-08-22, and every number in this
 * paragraph moved 8px with it). It was capped at 464 — two whole boxes and the 16px gutter of the
 * day — for a day, which freed the remainder to sit past the rail at the far right of the canvas
 * and brought the Sideboard to 16px from the deck. The reader's call reverses it: the rail belongs
 * at the **right edge**, so it is back there and the remainder is blank desk between the deck's
 * last box and it — the Sideboard 88px from the deck rather than 16. This story is the one to look at for that gap: the remainder is whatever
 * the desk's width leaves over, so it is a different number at every canvas width and at every
 * zoom stop, and it is the price of the rail being findable in one place.
 *
 * **Six items at any desk height, which is what changed on 2026-08-14.** The flow used to be
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
    // by a guess at the header's shape. One box is one pile, so the five read in the reader's own
    // order with the Sideboard and the Maybeboard simply absent from them — and the Commander too,
    // which is drawn in the command zone rather than in the flow and so carries no `STACK_ATTR`.
    expect(stacks.map((stack) => stack.querySelector('[id^="group-"]')?.textContent)).toEqual([
      "Ramp",
      "Removal",
      "Card draw",
      "Threats",
      "Lands",
    ]);
    // It is still an item of this grid, and the first one — six items on the three lines the doc's
    // arithmetic counts, five of which are piles. `STACK_ATTR` means "a pile drawn in the flow",
    // and this is a box drawn in the flow that *holds* piles, which is why it answers to a name of
    // its own. {@link CommandZone} is the story about what that box is for.
    const [command] = canvasElement.querySelectorAll<HTMLElement>(`[${COMMAND_ATTR}]`);
    expect([...command.querySelectorAll('[id^="group-"]')].map((h) => h.textContent)).toEqual([
      "Commander",
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
 * **What to look at**: six items — the command zone and five stacks — filling the width of the
 * canvas before any of them uses its height, and no gap at the right-hand end that a pile would
 * have fitted in.
 */
export const TallDesk: Story = {
  args: { groups: wideGroups() },
  decorators: [
    // Wide enough that the flow fills a line and wraps once rather than twice. **The line is
    // three boxes and the arithmetic written here said four**, which is worth leaving written
    // down: 74rem less the rail's 224 and the root's 16 is 944, four boxes' worth when the
    // deck's gutter was 16 (4 × 224 + 3 × 16), and the flow measured **917** — because the
    // meta's decorator hands this view a fixed 42rem, the deck is taller, and the 15px vertical
    // scrollbar the root then draws comes out of the width before `auto-fill` counts anything.
    // That is `UnevenPiles`' trap two decorators down, unpaid for here. Measured in Storybook
    // over CDP on 2026-08-22, backing the gutter out to 16px in the same pass: **three tracks at
    // both 8 and 16**, so halving it moved nothing in this story and the count it draws is the
    // count it drew. `shrink-0` for the reason {@link WrappedPiles}' decorator carries it.
    (Story) => (
      <div className="flex w-[74rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const stacks = [...canvasElement.querySelectorAll<HTMLElement>(`[${STACK_ATTR}]`)];
    // Five flowing piles, five boxes, plus the command zone at the head of them — six items, which
    // is the assertion the packed layout failed at this desk height, where it answered three. The
    // command zone is counted separately because it is not a pile: it is a box holding one, and the
    // point of the count is that nothing is packing anything. jsdom lays nothing out, so this is
    // the count and not the wrap; the wrap's arithmetic is {@link WrappedPiles}'.
    expect(stacks).toHaveLength(5);
    expect(canvasElement.querySelectorAll(`[${COMMAND_ATTR}]`)).toHaveLength(1);
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
 * asked whether the piles were drawn. The wide deck fills six items — the command zone and five
 * piles — and the play below now asserts the wrap itself.
 */
export const WrappedPiles: Story = {
  args: { groups: wideGroups() },
  decorators: [
    // Width only, and 1024px on purpose: the narrowest window this app promises to be usable in,
    // which is the width the sideways run was forbidden at. A story's own decorators run
    // *inside* the meta's, so this box takes its 42rem of height from the column above rather
    // than declaring a second one — two boxes each setting a height would leave the inner one
    // deciding and the outer one lying. 1024 less the rail's 224 and the root's 16px gap leaves
    // 784px, which is three boxes to a line (688) and not four (920), so the last three take a
    // second line. `shrink-0` because that box is a flex item: without it a docs canvas narrower than
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
    const [command] = canvasElement.querySelectorAll<HTMLElement>(`[${COMMAND_ATTR}]`);
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
    // **Two numbers since 2026-08-22, and one before it.** The root's `gap-4` is what stands
    // between the flow and the rail and is still 16; the flowing box's own gutter was halved to
    // `gap-x-2`. Reading them as one number would count the wrong capacity the moment either
    // moves again, which is exactly what a story asserting a wrap is here to notice.
    const railGap = 16;
    const flowGap = 8;
    const columnWidth = Number.parseFloat(stacks[0].style.width);
    const flowWidth = desk - Number.parseFloat(rail.style.width) - railGap;
    const perLine = Math.floor((flowWidth + flowGap) / (columnWidth + flowGap));
    // **What wraps is the grid's *items*, and the command zone is one of them** — five piles and
    // the box the Commander is drawn in, which claims a track of exactly the same width. Reading
    // that width off the box rather than assuming it is what keeps this honest at every zoom stop:
    // a command zone drawn at some other width would be a second geometry in a grid whose whole
    // arithmetic is one column, and it would fail here rather than in a screenshot nobody took.
    expect(stacks).toHaveLength(5);
    expect(Number.parseFloat(command.style.width)).toBe(columnWidth);
    expect(stacks.length + 1).toBeGreaterThan(perLine);
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
 * No Sideboard and no Maybeboard, so there is no rail: the desk is the command zone and the flow,
 * and the piles are the only thing in the picture.
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
 * Three columns, six items — the command zone holding the Commander, and five piles. The command
 * zone, Creatures and Ramp take the first line; the Creatures pile is eight cards deep and the two
 * beside it are one card each. Removal then starts directly under the command zone, Card draw under
 * Ramp, and Lands under Removal — all of it while the Creatures stack is still running down the
 * middle of the desk.
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
    // 736px, which is three boxes and their two gutters (3 × 224 + 2 × 8 = 688) **plus room for
    // a scrollbar**, and the 48 is not slack. There is no rail to leave room for here, so 688
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
    // The whole deck is on the desk — no `side` and no `maybe` pile, so no rail — and the order is
    // the reader's, with the Commander at the head in a box of its own. **Where** each one is drawn
    // is not a question jsdom can be asked: it lays nothing out, so every pile here measures 0 and
    // every span is the gutter alone. The picture is the thing to look at, and the arithmetic
    // behind it is `flowRowSpan`'s own test.
    expect(canvasElement.querySelectorAll(`[${RAIL_ATTR}]`)).toHaveLength(0);
    expect(canvasElement.querySelectorAll(`[${COMMAND_ATTR}]`)).toHaveLength(1);
    expect(stacks.map((stack) => stack.querySelector('[id^="group-"]')?.textContent)).toEqual([
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
 * A pile the reader switched off, drawn in the rail **under** the Sideboard and the Maybeboard —
 * the change of 2026-08-17, and the story to look at for it.
 *
 * `is_active = 0` is the whole of what `maybe` ever meant: the pile counts toward nothing — not
 * size, not copy limits, not legality, and the allocator claims no copy for it. So it is not part
 * of the deck being laid out, and a column of desk spent on it was a column spent on cards the
 * reader had already said were out. `Threats` here is the pile they switched off; the desk is the
 * command zone at its head and the four piles that are still in the deck.
 *
 * **What to look at, in this order:**
 *
 * * **The rail has three piles and its head has not moved.** Sideboard, Maybeboard, then Threats —
 *   even though `Threats` is `sortOrder` 5 and the Maybeboard is 7. `splitRail` tests the pile's
 *   kind *before* its switch, so the two played beside the deck head the rail whatever their own
 *   switches say. Test it the other way round and the Maybeboard — which is seeded switched off —
 *   would sink under whatever the reader turned off most recently, which is the rail's fixed head
 *   moving in the ordinary case rather than a corner.
 * * **Two dimmed piles in one column, and neither cost this view any code.** The Maybeboard and
 *   Threats carry the same four marks — the section's wash, the dim heading, the `INACTIVE` chip
 *   and the stack at `opacity-60` — because a group in the rail is the same `StackGroup` as a group
 *   in the flow. That is also why there is **no divider** above the switched-off run: an inactive
 *   pile already says so four times over, and the pile heading the rail is switched off too, so a
 *   rule drawn under it would mark a boundary that is not the one it looks like.
 * * **The cards are still there.** Seeing what is in a pile is the whole affordance for deciding to
 *   switch it back on, and switching it on returns it to the flow between Card draw and Lands —
 *   `splitRail` is derived per render, so nothing anywhere remembers that it was ever railed.
 */
export const SwitchedOffPile: Story = {
  args: { groups: wideGroups("Threats") },
  decorators: [
    // {@link PinnedSideboard}'s desk, for its reason: narrow enough that the flow has to wrap, so
    // the rail is holding its side of a line rather than sitting in slack.
    (Story) => (
      <div className="flex w-full max-w-3xl">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const stacks = [...canvasElement.querySelectorAll<HTMLElement>(`[${STACK_ATTR}]`)];
    // Four flowing piles: the five of {@link PinnedSideboard} less the one the reader switched off,
    // and the gap it left closed up rather than held open. The Commander is not among them here for
    // the reason it is not there either — it is drawn in the command zone at the head of the desk.
    expect(stacks.map((stack) => stack.querySelector('[id^="group-"]')?.textContent)).toEqual([
      "Ramp",
      "Removal",
      "Card draw",
      "Lands",
    ]);
    // The order is the assertion that can fail: `Threats` is third, behind two piles whose
    // `sortOrder` is *after* it, because the kind is tested before the switch.
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    expect([...rail.querySelectorAll('[id^="group-"]')].map((h) => h.textContent)).toEqual([
      "Sideboard",
      "Maybeboard",
      "Threats",
    ]);
    // Both switched-off piles are marked, and both marks are inside the rail — the chip travels
    // with the group, so a rail that had grown a lighter definition of a pile would lose them.
    expect(within(rail).getAllByText("INACTIVE")).toHaveLength(2);
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
 * **The Commander is not in the curve either, and it is not appended — it heads the desk.** A
 * commander is the card the curve was built *around*, played from a zone of its own, so
 * `buildGroups` leaves that pile out of the buckets and puts it first, and `splitRail` draws it in
 * the command zone rather than in the flow. This deck's Commander is a one-mana creature, so what
 * that changed here is visible in one heading: the `Mana value 1` bucket used to hold it beside the
 * deck's own one-drops. {@link CommandZone} is the story about the box, and about the companion
 * that stacks under the commander in it.
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

/** Grouped by type, which is the same vocabulary the add path files an uncategorized card by
 *  — one list, so a sort and a grouping cannot disagree about what a type is. */
export const ByType: Story = { args: { groups: deckGroups("type", "type") } };

/**
 * A Commander deck with **both** command zones filled — Kenrith in the Commander pile, Lurrus in
 * the Companion — and a main deck spread across the curve, so that grouping it by mana value
 * leaves those two as the only real categories on the desk.
 *
 * **Local to this file for {@link wideGroups}' reason**, and built through the app's own
 * `buildGroups` for it too: what heads the desk under a derived grouping is then `grouping.ts`'s
 * answer rather than a hand-written agreement about what it ought to be.
 *
 * **Lurrus is the corpus's real companion** — the printing whose oracle text `companions.ts`
 * re-derives its rule from — so the pile this story is about is a companion rather than a `kind`
 * pinned onto whatever creature came to hand. Kenrith is the same choice at the other end: a
 * five-mana legend, which is a mana value the deck's own curve does not otherwise reach, so a
 * commander that had been left in the buckets would show up as a column of its own rather than
 * hiding inside one.
 */
function commandZoneGroups() {
  const commander = deckCategory("commander");
  const companion = deckCategory("companion");
  // "Main deck" — schema v8's own pile, and the only category this deck has that a derived
  // grouping dissolves. Everything below is filed into it, because under `manaValue` where a card
  // *sits* stops being visible: the curve is the whole layout apart from the head.
  const main = deckCategory("main");

  const pile = (category: DeckCategory): Partial<DeckCard> => ({
    categoryId: category.id,
    categoryName: category.name,
    categoryKind: category.kind,
    categoryActive: category.isActive,
  });

  // Six mana values with something at each — 0, 1, 2, 3, 4 and 6 — which is six curve columns
  // beside the one box at the head. The gap at 5 is the useful part rather than an oversight: that
  // is Kenrith's mana value, so the day a commander is bucketed again this story grows a seventh
  // column instead of quietly re-labelling one it already had.
  const cards = [
    deckCard(printing("eld", "303"), pile(commander)),
    deckCard(printing("iko", "226"), pile(companion)),
    deckCard(printing("lea", "288"), { ...pile(main), quantity: 4 }),
    deckCard(printing("tmp", "315"), pile(main)),
    deckCard(printing("c21", "263"), pile(main)),
    deckCard(printing("ema", "32"), pile(main)),
    deckCard(printing("dom", "168"), pile(main)),
    deckCard(printing("mh2", "267"), { ...pile(main), quantity: 2 }),
    deckCard(printing("fut", "153"), pile(main)),
    deckCard(printing("pcy", "45"), pile(main)),
    deckCard(printing("nph", "57"), pile(main)),
    deckCard(printing("wwk", "31"), pile(main)),
    deckCard(printing("mp2", "8"), pile(main)),
  ].map((card) => ({ ...card, ownedQuantity: card.quantity }));

  return buildGroups(cards, [commander, main, companion], "manaValue", "manaCost");
}

/**
 * **The command zone**: the commander, and under it the companion, in one box at the head of the
 * desk — with the curve running out to the right of them.
 *
 * A commander is not a card in the curve. It is the card the curve was built *around*, played from
 * a zone of its own, and a companion is the same claim about the fifteenth card of a sideboard that
 * is never in the deck either. So `buildGroups` leaves both piles out of the buckets it derives and
 * puts them first — commander, then companion, in every grouping mode — and `splitRail` answers for
 * them as a run of their own, the way it already answers for the piles played beside the deck.
 *
 * **The two share a single grid item, and that is the whole of what this story is here to show.**
 * The flow is a masonry: it fills the first free cell at or after the cursor, so two short piles at
 * the head of it are dealt into columns 1 and 2 **side by side** — the companion *beside* the
 * commander, with the curve pushed a column to the right for as long as the deck has both. The
 * reader asked for the rail's arrangement instead, one on top of the other, and one grid cell
 * holding a `flex-col` is how a grid is told that without moving either pile in the DOM. Reading
 * order, tab order, what a screen reader hears and where the arrow keys go are therefore exactly
 * what they would have been.
 *
 * **What to look at, in this order:**
 *
 * * **Companion under Commander, one column wide, at the top-left of the desk.** The gutter between
 *   them is 20px — the same `gap-5` the rail stacks its piles by, and the same number a flowing
 *   pile carries inside its own row span — so the pair reads as one box rather than two that
 *   happen to be near each other. Side by side is the failure this story makes obvious.
 * * **The curve beside them starts at 0 and skips 5.** Neither Kenrith (five mana) nor Lurrus
 *   (three) is in a bucket, which is the other half of the change: a commander counted into the
 *   curve is a card the deck cannot cast being drawn as part of its mana base's job.
 * * **Neither pile has a grip.** A zone pinned to the head of every grouping has no position a
 *   reorder could move it to, and the box hands its piles no `flowWidth` — `StackGroup`'s one off
 *   switch for the grip, the row span and the reorder drop at once. **The card drop is untouched**:
 *   `useCategoryDrop` reads a `categoryId` and has never read that prop, so a card dragged onto the
 *   commander still lands in it, which is the affordance this box could not afford to cost.
 * * **The box is one item, so the pile beside it is not dragged down by it.** It claims its own
 *   height in the masonry — the two piles and one gutter — and the `Mana value 0` column next to it
 *   is as tall as its own two cards and no taller.
 */
export const CommandZone: Story = {
  args: { groups: commandZoneGroups() },
  decorators: [
    // 1024px, the narrowest window this app promises to be usable in, and no rail in this deck to
    // take a column of it — so the line holds four items (4 × 224 + 3 × 8 = 920, against 1152 for
    // five) and the seven here wrap onto two. Width only and `shrink-0`, for {@link WrappedPiles}'
    // reasons.
    (Story) => (
      <div className="flex w-[64rem] shrink-0">
        <Story />
      </div>
    ),
  ],
};

/**
 * **The reader arranging their own columns** — a grip in every flowing heading, and none in the
 * rail.
 *
 * The gesture is a drag from the grip onto another pile, and the arrow keys on that same grip
 * are the whole of the keyboard's way to make the same move: a handle a mouse can drag and a
 * keyboard cannot is a reorder half the readers do not have.
 *
 * **Where a pile is drawn and where a pile *sits* are two questions, and only the second is the
 * reader's to answer here.** The Sideboard and the Maybeboard are held against the right edge by
 * their `kind`, so their position is not an arrangement anybody made — which is why they carry no
 * grip even though they carry a `sortOrder` like every other pile. The Commander is the same
 * answer from the head of the desk: a command zone is pinned first in all three grouping modes, so
 * there is no position a drag could move it to, and the box it is drawn in hands its piles no
 * `flowWidth` — which is `StackGroup`'s one off switch for the grip, the row span and the reorder
 * drop together. The Categories dialog is where *those* three are reordered relative to each
 * other, and it draws every row of the deck.
 *
 * `moveCategory` is what the editor hands down only while the deck is grouped by category; a view
 * given none draws no grip at all, which is every other story in this file.
 */
export const Reorderable: Story = {
  args: { groups: wideGroups(), actions: { moveCategory: fn() } },
  decorators: [
    (Story) => (
      <div className="flex w-[52rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const [rail] = canvasElement.querySelectorAll<HTMLElement>(`[${RAIL_ATTR}]`);
    const [command] = canvasElement.querySelectorAll<HTMLElement>(`[${COMMAND_ATTR}]`);

    // Five flowing piles, five grips — and the count in each name is the flow's rather than the
    // deck's eight, because neither the two railed piles nor the Commander is part of the order
    // this moves things in. Both boxes are asserted, because the two absences have different
    // causes and a regression would take one at a time: the rail's piles are a `kind` the split
    // pins to the right, the command zone's is a `kind` it pins to the head, and only the second
    // one has ever been in the flow.
    const grips = canvas.getAllByRole("button", { name: /^Move / });
    expect(grips).toHaveLength(5);
    expect(within(rail).queryByRole("button", { name: /^Move / })).toBeNull();
    expect(within(command).queryByRole("button", { name: /^Move / })).toBeNull();
    expect(grips[0]).toHaveAccessibleName("Move Ramp, 1 of 5");

    // The keyboard's own move, and the assertion is the **pair of ids**: `deck_category_reorder`
    // is sent every id in a new order, so a view that answered with a position in its own flow
    // would have to be resolved by something that could not see the rail.
    const ramp = canvas.getByRole("button", { name: "Move Ramp, 1 of 5" });
    ramp.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(args.actions?.moveCategory).toHaveBeenCalledWith(10, 11);
  },
};

/**
 * **The caret walking the deck**: left and right across the piles, up and down through the pile
 * it is in.
 *
 * The two axes mean different things and the asymmetry is the point. **Up and down** run through
 * one pile and stop at its ends — the flow is a masonry, so a pile that wraps starts at the foot
 * of the pile *above* it, and "the pile above this one" is a fact about how wide the window
 * happens to be rather than about the deck. **Left and right** change pile, and land on the
 * **top card**: the reader was offered "the same depth" and chose this, because the top of a pile
 * is a place that always exists where the same depth is a card a shorter neighbour may not have.
 *
 * Two more decisions are visible here rather than merely written down. A pile holding no cards is
 * **stepped over**, because there is no card in it for the caret to be on. And the rail's piles —
 * the Sideboard and the Maybeboard, drawn beside the deck rather than in it — are the **end of the
 * walk** rather than outside it: where a pile is drawn is a layout, and a caret that stopped at
 * the deck's last flowing pile would make the two piles a reader consults most mouse-only.
 *
 * **What to look at**: the card the caret is on stands out of its pile, exactly as a hovered one
 * does — `StackedCard`'s own `onFocus` opens it — so a walk across the desk reads as a card being
 * lifted out of each pile in turn. The gold ring follows with it, because in this view the picked
 * card is also the pile's resting state.
 *
 * The play addresses the cards **by position** rather than by name: the flow is drawn first and
 * the rail after it, and each pile draws its cards in the order it holds them, so the document
 * order of the marked controls *is* the order the arrows walk. That is a property worth leaning
 * on — a layout that reordered the piles in the DOM to draw them somewhere else would break the
 * reading order and the tab order along with this.
 */
export const KeyboardWalk: Story = {
  args: { groups: wideGroups(), onSelect: fn() },
  decorators: [
    (Story) => (
      <div className="flex w-[52rem] shrink-0">
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement, args }) => {
    // Commander(1) · Ramp(3) · Removal(3) · … in the flow, then the rail — so index 1 is the top
    // of Ramp and index 4 the top of Removal.
    const cards = [...canvasElement.querySelectorAll<HTMLElement>(`[${DECK_CARD_ATTR}]`)];

    cards[1].focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(cards[2]).toHaveFocus();
    expect(args.onSelect).toHaveBeenCalledTimes(1);

    // Out of the *second* card of Ramp and onto the **first** of Removal, which is the whole of
    // the "top card, not the same depth" call.
    await userEvent.keyboard("{ArrowRight}");
    expect(cards[4]).toHaveFocus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(cards[1]).toHaveFocus();

    // And the clamp: there is no card above the top of a pile, so the press moves nothing.
    await userEvent.keyboard("{ArrowUp}");
    expect(cards[1]).toHaveFocus();
    expect(args.onSelect).toHaveBeenCalledTimes(3);
  },
};

/**
 * The **Live** list of a deck that keeps a plan, where four of the ten cards are the plan and six
 * are not.
 *
 * This is the whole point of the mark: a live list is what the reader has actually sleeved up, and
 * the one thing it cannot say about itself is which of its cards are the deck they designed and
 * which are the proxies and stand-ins waiting to be replaced. The tick says it, in the corner
 * opposite the `RULE BREAK` mark — see `CardMarks.tsx` for why those two are never allowed to
 * share one.
 *
 * `theoryMatches` is `undefined` in every other story in this file, which is what a deck with the
 * theory list switched off looks like and what the **Theory** tab itself looks like: no plan to
 * compare against, so no ticks.
 */
export const TheoryMatches: Story = {
  args: { theoryMatches: deckTheoryMatches() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Four ticked cards. The mark is `aria-hidden` and carries no `title` any more — it is
    // bound `describes: false`, so `THEORY_MATCH_ATTR` is CardMarks.tsx's own handle for
    // finding it after the fact. The words below are read off the button instead.
    expect(canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)).toHaveLength(4);

    // The card carrying both marks: in the plan **and** breaking a rule. The two facts are in
    // one sentence because a button's `aria-label` replaces everything inside it.
    const both = canvas.getByRole("button", { name: /^Island/ });
    expect(both).toHaveAccessibleName(expect.stringContaining("in the theory list"));
    expect(both).toHaveAccessibleName(expect.stringContaining("rule break:"));

    // And a card the plan does not ask for says neither.
    expect(canvas.getByRole("button", { name: /^Dismember/ })).toHaveAccessibleName(
      expect.not.stringContaining("theory"),
    );
  },
};
