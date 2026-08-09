import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { finishPrice } from "@/lib/finish";
import type { DeckCard } from "@/lib/ipc";
import { CARDS, type FakeCard } from "../../../.storybook/fake/cards";
import { ZONE_LABEL, ZoneColumn } from "./ZoneColumn";

/**
 * A fixture printing, by the two columns that identify one — `CardImage.stories.tsx`'s helper,
 * for its reason: `CARDS` is generated and a regeneration may reorder it.
 */
function printing(setCode: string, collectorNumber: string): FakeCard {
  const card = CARDS.find((c) => c.setCode === setCode && c.collectorNumber === collectorNumber);
  if (!card) throw new Error(`No fixture printing ${setCode} ${collectorNumber}`);
  return card;
}

let nextId = 1;

/**
 * One `deck_cards` row joined to its card, as `deck::get_deck` answers it.
 *
 * Built here from `CARDS` rather than through `validation/fixtures`' `card()` builder, and the
 * difference is the id: that builder makes one up (`c-<name>`), which is right for the
 * validation engine — it never draws anything — and wrong here, because the row thumbnail is
 * `cardImageUrl(card.cardId, 0, "art")` and a made-up id has no art on either side of the **Art**
 * toolbar switch.
 *
 * `unitPriceUsd` goes through the app's own `finishPrice`, asked for **nonfoil** — which is the
 * `usd` key of this printing's `prices` blob and never the `cards.price_usd` column, since that
 * one is a nonfoil→foil→etched fallback chain built for sorting. A deck names a printing rather
 * than a finish, and nonfoil is the cheapest way to satisfy it.
 */
function deckCard(card: FakeCard, over: Partial<DeckCard> = {}): DeckCard {
  return {
    id: nextId++,
    cardId: card.id,
    zone: "main",
    quantity: 1,
    // Denormalised on the row, like the collection's — the one name an orphaned row still has.
    name: card.name,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    lang: card.lang,
    needsReview: null,
    oracleId: card.oracleId,
    manaCost: card.manaCost,
    cmc: card.cmc,
    typeLine: card.typeLine,
    oracleText: card.oracleText,
    colors: card.colors,
    colorIdentity: card.colorIdentity,
    legalities: card.legalities,
    power: card.power,
    toughness: card.toughness,
    layout: card.layout,
    rarity: card.rarity,
    faces: card.faces,
    gameChanger: card.gameChanger,
    everUncommon: card.everUncommon,
    unitPriceUsd: finishPrice(card.prices, "nonfoil"),
    // An **allocation**, never a decrement — how many copies this deck has reserved out of the
    // collection. Zero until a story says otherwise, which is also what an unbuilt deck with an
    // empty collection reads.
    ownedQuantity: 0,
    ...over,
  };
}

/**
 * Twelve rows and **40 copies**, spread over enough types that the buckets have something to
 * bucket, with quantities that read as a curve rather than one of everything.
 *
 * Forty rather than a legal sixty on purpose: the remaining twenty would be repeats of the two
 * land rows, and a story whose point is two screens up is a story nobody scrolls to. The count
 * beside the column's title says 40, and it is copies rather than rows — a deck is counted in
 * cards.
 */
const MAIN: DeckCard[] = [
  deckCard(printing("mh2", "138"), { quantity: 4, ownedQuantity: 4 }),
  deckCard(printing("fut", "153"), { quantity: 4, ownedQuantity: 1 }),
  deckCard(printing("dom", "168"), { quantity: 2, ownedQuantity: 2 }),
  deckCard(printing("isd", "51"), { quantity: 4, ownedQuantity: 4 }),
  deckCard(printing("lea", "161"), { quantity: 4, ownedQuantity: 4 }),
  deckCard(printing("gtc", "148"), { quantity: 3, ownedQuantity: 3 }),
  deckCard(printing("nph", "57"), { quantity: 2, ownedQuantity: 0 }),
  deckCard(printing("mh2", "267"), { quantity: 2, ownedQuantity: 2 }),
  deckCard(printing("wwk", "31"), { quantity: 1, ownedQuantity: 1 }),
  deckCard(printing("mh2", "259"), { quantity: 4, ownedQuantity: 4 }),
  deckCard(printing("tmp", "315"), { quantity: 2, ownedQuantity: 2 }),
  deckCard(printing("lea", "288"), { quantity: 8, ownedQuantity: 8 }),
];

/** `reconcile::sweep_orphans`' sentence, verbatim (`src-tauri/src/reconcile.rs:633-635`). */
const MISSING =
  "This printing is not in the card database. It may have been removed by the last " +
  "card-data sync, or it may return with the next one.";

/**
 * A row whose printing has left `cards` — every card-derived field `null`, the row's own four
 * intact, and a sentence saying so.
 *
 * `deck_cards` denormalises `name` as well as the printing (unlike `collection_entries`), so an
 * orphaned deck row still knows what it is called. What it has lost is its type line — which is
 * why it lands in the `Other` bucket — its mana cost, its rarity, its price and its art.
 */
const ORPHAN: DeckCard = {
  id: 900,
  cardId: "0f0c1b0e-8e0d-4a2f-9f4b-2f5c9a1d3e77",
  zone: "main",
  quantity: 1,
  name: "Sword of the Meek",
  setCode: "dst",
  collectorNumber: "132",
  lang: "en",
  needsReview: MISSING,
  oracleId: null,
  manaCost: null,
  cmc: null,
  typeLine: null,
  oracleText: null,
  colors: null,
  colorIdentity: null,
  legalities: null,
  power: null,
  toughness: null,
  layout: null,
  rarity: null,
  faces: null,
  gameChanger: null,
  // `false` for an orphan, because nothing is known about a card that is not there.
  everUncommon: false,
  unitPriceUsd: null,
  ownedQuantity: 0,
};

const meta = {
  title: "Decks/ZoneColumn",
  component: ZoneColumn,
  tags: ["autodocs"],
  args: {
    zone: "main",
    title: ZONE_LABEL.main,
    cards: MAIN,
    groupBy: "type",
    moveTargets: ["side", "maybe"],
    openMenuCardId: null,
    busy: false,
    onOpenMenu: fn(),
    onCloseMenu: fn(),
    onSetQuantity: fn(),
    onMove: fn(),
    onSetCover: fn(),
    onSelect: fn(),
    onDropCard: fn(),
  },
  // A height, because the column is `flex min-h-0 flex-col` and its scroller is `flex-1`: the
  // editor decides how tall a zone is, and in a canvas with no sized parent the column would
  // grow to hold every row and scroll nothing. The width is the editor's own — a zone column at
  // 1280px with the card pane docked — and {@link Narrow} is the story that changes it.
  decorators: [
    (Story) => (
      <div className="flex h-[30rem] w-[21rem] flex-col">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "One zone of a deck: what is in it, how many that is, and every edit that can be " +
          "made to a row without leaving the page. **There is no Save** — every control here " +
          "writes through an IPC command and the list redraws from what the database " +
          "answered, which is what autosave honestly means for a deck: the row *is* the " +
          "draft.\n\n" +
          "The deck is **rows, one view only**. The stacked-card mode and its toggle were " +
          "removed on 2026-08-06: full card faces at column width were huge, and the width " +
          "cap they needed was why zone columns would not take the editor's width. Each row " +
          "instead carries the printing's `art` crop (626×457) as an `aria-hidden`, " +
          '`alt=""`, `draggable={false}` thumbnail **sharing the stepper\'s grid cell** — a ' +
          "fourth grid column's gap made a squeezed column scroll sideways, and a hidden flex " +
          "child charges nothing.\n\n" +
          'Every row is a drag source carrying `{ kind: "deck-card" }`, and the whole ' +
          "scroller is a drop target — `canDrop` and the drop itself ask the same question a " +
          "second apart, because only the second one writes.",
      },
    },
  },
} satisfies Meta<typeof ZoneColumn>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A main deck grouped by type — the editor's default reading of a list.
 *
 * The buckets are the eight printed card types **in printed order**, which is the whole of the
 * rule for a card with two: an Artifact Creature is a creature to everyone who has ever built a
 * deck, and `Creature` comes first in that list. `Land` is last for the reason it is last in a
 * decklist — it is where the counting ends. Empty buckets are dropped rather than drawn.
 *
 * A heading's count is **copies, not rows**: four Bolts are four cards, and a deck is counted in
 * cards. So is the number beside the column's title, and it is in the column's accessible name
 * as well — a reader arriving here from a screen reader's region list is asking "which zone, and
 * how big".
 *
 * The double-faced row is Delver of Secrets, and it files under Creature because the **front**
 * face decides: `type_line` carries both sides separated by `//`, and the back of a modal DFC is
 * routinely a land while its front is a spell. A deck's curve is cast from the front.
 */
export const MainDeck: Story = {};

/**
 * The other question a deck list is read for: what does it *cost*.
 *
 * 0–7 exactly and 8 open-ended, the filter chips' own bucketing. `null` is **unknown** rather
 * than zero — `cards.cmc` is nullable and an orphaned row has no mana value at all — so it gets a
 * bucket of its own at the end rather than sitting at the head of the curve where a reader counts
 * their cheapest spells.
 */
export const GroupedByManaValue: Story = { args: { groupBy: "manaValue" } };

/**
 * A zone with nothing in it. The column still draws its heading and its count, because it is
 * still a drop target — this is what the reader drags the first card onto.
 */
export const Empty: Story = {
  args: { cards: [], title: ZONE_LABEL.side, zone: "side" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Nothing here yet.")).toBeInTheDocument();
    // Zero cards, and the plural is right: the count is in the accessible name so a reader who
    // cannot see the column's corner still gets both halves of "which zone, and how big".
    await expect(canvas.getByRole("region", { name: "Sideboard, 0 cards" })).toBeInTheDocument();
  },
};

/**
 * The commander zone: one card, and **no headings**.
 *
 * `groupBy` is `null` here because a heading over a single row is a heading that says nothing —
 * the commander and companion zones hold one or two cards. `moveTargets` is what the format
 * decides, and the editor derives it from the format's spec, so a Modern deck is never offered a
 * commander zone at all.
 */
export const Commander: Story = {
  args: {
    zone: "commander",
    title: ZONE_LABEL.commander,
    groupBy: null,
    cards: [deckCard(printing("eld", "303"), { zone: "commander", ownedQuantity: 1 })],
    moveTargets: ["main", "maybe"],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // The exact name, which is what makes this an assertion about the **singular**: "1 cards"
    // is the kind of thing only a screen reader ever meets, and nothing else in this file — or
    // in `ZoneColumn.test.tsx` — would notice it.
    await expect(canvas.getByRole("region", { name: "Commander, 1 card" })).toBeInTheDocument();
  },
};

/**
 * The scratchpad, which **counts toward nothing at all** — not size, not copies, not legality —
 * and whose rows therefore always read `ownedQuantity: 0`.
 *
 * That zero is **by design and not for want of copies**. `deck::allocate_deck` skips the `maybe`
 * zone outright (`ZONE_PRIORITY` puts it last and the walk filters it out), so the allocator
 * never claims a copy for it however many the collection holds. `CardRow` knows this: `short` is
 * `zone !== "maybe" && ownedQuantity < quantity`, so a `maybe` row draws no shortage mark. A mark
 * there would report a shortage the reader does not have.
 *
 * The rows below want four copies each and read zero owned. That is the exact shape that would
 * print `0/4` in the main deck, and here it prints nothing — which is what the `play` pins.
 */
export const Maybe: Story = {
  args: {
    zone: "maybe",
    title: ZONE_LABEL.maybe,
    groupBy: null,
    moveTargets: ["main", "side"],
    cards: [
      deckCard(printing("nph", "9"), { zone: "maybe", quantity: 4 }),
      deckCard(printing("roe", "4"), { zone: "maybe", quantity: 4 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByRole("listitem")).toHaveLength(2);
    // Neither the visible `0/4` nor the sentence behind it. The sr-only half is checked with a
    // pattern rather than a literal, because the claim is that *no* shortage is reported here —
    // not that one particular shortage is missing.
    await expect(canvas.queryByText(/You own \d+ of \d+/)).toBeNull();
    await expect(canvas.queryByText("0/4")).toBeNull();
  },
};

/**
 * The same shortage in a zone that counts it: two rows the collection cannot cover.
 *
 * Drawn **only where it says something** — a fully covered row prints nothing at all, because
 * sixty green ticks are sixty things to read past on the way to the three that matter.
 *
 * Three wordings of one fact, and they are deliberately not identical: a dim `1/4` for the eye
 * (`aria-hidden`, because a bare pair of digits after a price is not a sentence), "You own 1 of
 * 4" `sr-only` for anything that reads text, and "You own 1 of the 4 this deck wants" as the
 * `title`, which is the one with room to say what the second number *is*.
 */
export const ShortOfCopies: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Tarmogoyf: 4 wanted, 1 owned. Dismember: 2 wanted, 0 owned. Named rather than counted,
    // because a count would still pass if the wrong rows drew the mark.
    await expect(canvas.getByText("You own 1 of 4")).toBeInTheDocument();
    await expect(canvas.getByText("You own 0 of 2")).toBeInTheDocument();
    // Ragavan is 4 of 4 and says nothing — the whole point of the mark being conditional.
    await expect(canvas.queryByText("You own 4 of 4")).toBeNull();
  },
};

/**
 * A row whose printing has left the card database.
 *
 * It is **listed and counted exactly as before** — the sentence is a sentence, not a hiding
 * place — and it lands in the `Other` bucket because a row with no type line has no printed type
 * to file under. `Other` sorts last because it is a remainder rather than a kind.
 *
 * The art is fed `null` and **nothing tries to fetch a picture of a card that is not there**:
 * `CardRow` passes `card.needsReview === null ? cardImageUrl(…) : null` to `useImageRetry`, whose
 * null story is "no state machine at all". That is what the `play` pins, and it is invisible in
 * a screenshot — a blank thumbnail frame looks the same whether it is waiting for bytes or was
 * never asked for any.
 */
export const OrphanRow: Story = {
  args: { cards: [ORPHAN, ...MAIN.slice(0, 3)] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const rows = canvas.getAllByRole("listitem");
    const orphanRow = rows.find((li) => within(li).queryByText("Sword of the Meek"));
    await expect(orphanRow).toBeDefined();
    // No `<img>` in the row at all. The frame that would hold one is still drawn — it is what
    // keeps the row's geometry — but it stays a quiet blank.
    await expect(orphanRow?.querySelector("img")).toBeNull();
    // Every other row in this story does ask for its art, which is what makes the assertion
    // above about the orphan rather than about the story rendering nothing.
    await expect(canvasElement.querySelectorAll("img").length).toBeGreaterThan(0);
    await expect(canvas.getByText(MISSING)).toBeInTheDocument();
  },
};

/**
 * A row's actions menu, open.
 *
 * Which card it is open in is the **editor's** state rather than the row's, and that is
 * structural: `useDismissOnEscape` orders exactly two rungs, so two `"inner"` layers open at once
 * are not ordered at all and would both close on one press. One piece of state for the whole
 * editor is what makes "never two" a fact instead of a thing to remember.
 *
 * The menu is anchored to the row rather than portalled — the shipped CSP is `style-src 'self'`
 * and every overlay primitive in reach injects a runtime `<style>` the moment it opens. It flips
 * to open *upwards* on rows near the foot of the column, measured against the column's own
 * scroller; that measurement needs a browser, so this story opens the menu on the first row where
 * the answer is the same either way.
 *
 * Only the zones the format allows are offered, and the row's **own** zone is filtered out of
 * them.
 */
export const MenuOpen: Story = {
  args: { openMenuCardId: MAIN[0].cardId },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const menu = canvas.getByRole("dialog", { name: "Actions for Ragavan, Nimble Pilferer" });
    await expect(within(menu).getByRole("button", { name: "Move to Sideboard" })).toBeEnabled();
    await expect(within(menu).getByRole("button", { name: "Move to Maybe" })).toBeEnabled();
    // The row's own zone is not on the list — "Move to Main deck" from the main deck is a
    // no-op wearing a verb.
    await expect(within(menu).queryByRole("button", { name: "Move to Main deck" })).toBeNull();
    await expect(within(menu).getByRole("button", { name: "Set as cover" })).toBeInTheDocument();
    // Not `aria-modal`: the editor behind it stays live, and a menu that trapped the caret
    // would be a dialog pretending to be a menu.
    await expect(menu).not.toHaveAttribute("aria-modal");
  },
};

/**
 * The same menu on an orphaned row, which is **one item shorter**.
 *
 * A cover is art, and an orphan has none — `cards` has no row for this printing, so the gallery
 * would draw an empty frame with no illustrator to credit. Not offered rather than offered and
 * refused, which is the difference between a menu that knows what it is looking at and one that
 * apologises afterwards.
 *
 * Invisible unless the two menus are compared side by side, which is what this story and
 * {@link MenuOpen} are for, and what the `play` pins without needing eyes.
 */
export const MenuOpenOnAnOrphan: Story = {
  args: { cards: [ORPHAN, ...MAIN.slice(0, 3)], openMenuCardId: ORPHAN.cardId },
  play: async ({ canvasElement }) => {
    const menu = within(canvasElement).getByRole("dialog", {
      name: "Actions for Sword of the Meek",
    });
    await expect(
      within(menu).getByRole("button", { name: "Move to Sideboard" }),
    ).toBeInTheDocument();
    await expect(within(menu).queryByRole("button", { name: "Set as cover" })).toBeNull();
  },
};

/**
 * A write the open menu started is in flight: every control in it disables itself.
 *
 * `busy` is true **only** while a write *this* menu began is running — never while some other
 * row's stepper or a rename is, or one row's edit would grey out another's menu. And the menu
 * reads it twice over: it disables its controls, and it guards its own blur-away. That second
 * half is the load-bearing one — a browser blurs a disabled control with no `relatedTarget` at
 * all, and without the guard the menu would read that as the reader leaving and take itself
 * down *as if the write had worked*, before the answer arrived.
 */
export const MenuBusy: Story = {
  args: { openMenuCardId: MAIN[0].cardId, busy: true },
  play: async ({ canvasElement }) => {
    const menu = within(canvasElement).getByRole("dialog");
    for (const button of within(menu).getAllByRole("button")) {
      await expect(button).toBeDisabled();
    }
  },
};

/**
 * Below 17rem of **column**, where the art thumbnail yields and the row is the dense text row it
 * always was.
 *
 * A container query rather than a media query, because it is a fact about the column's width and
 * not the window's: `ZoneColumn` puts `@container` on its own scroller and the thumbnail is
 * `hidden … @[17rem]:block`. So a story does **not** have to supply the scroller — the component
 * brings its own — it only has to be narrow. The box here is 16rem (256px), and the scroller's
 * content box inside it is 256 less the column's 1px borders and the scroller's `p-1`, so ~246px:
 * comfortably under the 272px threshold.
 *
 * The threshold itself was measured live at 1280px with the card pane docked: a stepper, a
 * picture and a name did not fit, and the column grew the sideways scrollbar nothing in this app
 * is allowed.
 *
 * **No `play`, deliberately.** jsdom applies no CSS and evaluates no container query, so the
 * thumbnail's `<span>` is in the DOM with the same two classes at every width — an assertion here
 * would pass identically in {@link MainDeck} and would be a test of the class attribute rather
 * than of the layout. Task 17 is where this is looked at.
 */
export const Narrow: Story = {
  args: { cards: MAIN.slice(0, 6) },
  decorators: [
    (Story) => (
      <div className="flex min-h-0 w-[16rem] flex-1 flex-col">
        <Story />
      </div>
    ),
  ],
};
