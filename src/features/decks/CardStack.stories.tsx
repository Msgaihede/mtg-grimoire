import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import type { DeckCard } from "@/lib/ipc";
import { deckCard, orphanDeckCard, printing } from "../../../.storybook/fake/fixtures";
import { CardStack, STACK_OPEN_ATTR, stackHeight } from "./CardStack";
import type { ValidationIssue } from "./validation/types";

/**
 * A Ramp column's worth of cards — enough of them that the stack is a stack, with the
 * quantities, prices and colours spread far enough apart that every part of a card face has
 * something to draw.
 */
const RAMP: DeckCard[] = [
  deckCard(printing("lea", "288"), { quantity: 2, ownedQuantity: 1 }),
  deckCard(printing("mh2", "138"), { quantity: 1, ownedQuantity: 1 }),
  deckCard(printing("dom", "168"), { quantity: 1, ownedQuantity: 0 }),
  deckCard(printing("lea", "161"), { quantity: 1, ownedQuantity: 1 }),
  deckCard(printing("isd", "51"), { quantity: 1, ownedQuantity: 1 }),
  deckCard(printing("gtc", "148"), { quantity: 1, ownedQuantity: 1 }),
];

const meta = {
  title: "Decks/CardStack",
  component: CardStack,
  tags: ["autodocs"],
  args: {
    cards: RAMP,
    label: "Ramp",
    // The default marketplace, and what every dollar figure in this file is a claim about. A
    // stack takes the currency rather than reading it, so it cannot disagree with the heading
    // the view draws above it.
    currency: "usd",
    onSelect: fn(),
  },
  // The editor's own column width, straight off the design canvas: 224px, which is what a
  // 1280px window fits seven of with the stats panel docked. The stack sizes its own height,
  // so nothing here constrains it — that is the whole point of the fixed height inside.
  decorators: [
    (Story) => (
      <div className="w-56">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CardStack>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The collapsed stack: every card but the last shows only its 30px title bar, and the last is
 * drawn in full because nothing covers it.
 *
 * Run the pointer down it. Each card opens where it stands and pushes the ones after it out of
 * the bottom of the group — **the group itself never resizes**, which is what lets a reader
 * walk a whole column without the page moving under them. Rest on a card for a moment before
 * it opens: that dwell is the whole point, and moving straight past a card opens nothing.
 */
export const Default: Story = {};

/**
 * The flip-through itself: dwell on a card and it opens, cross to the next and the stack hands
 * over without closing, leave and it collapses after a beat.
 *
 * **This story could not exist before, and the reason it could not is worth keeping.** The lift
 * used to be CSS `:hover`, and `userEvent.hover` dispatches pointer events without ever
 * engaging the `:hover` state — in either runner. So the earlier version of the docblock in
 * this slot recorded that *no story could assert the lift at all*, and the play here asserted
 * the derived height instead, because a hover assertion would have been vacuous: nothing moved,
 * so nothing could fail. That was honest and it was also a hole, on the headline interaction of
 * the redesign.
 *
 * The trigger is `pointerenter` now, driven from state, and `userEvent.hover` fires exactly
 * that. So the claim is checkable — here, in `CardStack.test.tsx` against a fake clock, and in
 * the shipped WebView2 over CDP, which is still the only one of the three that can see the
 * paint.
 *
 * What is asserted: the open card is the one dwelt on, there is only ever one of them, the
 * hand-over to the next card leaves exactly one open, and **the list's height does not move
 * through any of it** — the property the whole component exists for. The *close delay* is the
 * one rule left to `CardStack.test.tsx`, because proving it means catching a frame at a named
 * millisecond, and only a fake clock can be at a named millisecond.
 */
export const FlipThrough: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Ramp" });
    const cards = canvas.getAllByRole("listitem");
    const open = () => list.querySelectorAll(`[${STACK_OPEN_ATTR}]`);
    const height = list.style.height;

    // At rest the stack is closed and is the arithmetic's own height.
    expect(open()).toHaveLength(0);
    expect(height).toBe(`${stackHeight(RAMP.length)}px`);

    await userEvent.hover(cards[1]);
    await waitFor(() => expect(cards[1]).toHaveAttribute(STACK_OPEN_ATTR));
    expect(open()).toHaveLength(1);
    expect(list.style.height).toBe(height);

    // Crossing to the next card is a hand-over rather than a close and an open: moving between
    // two cards never leaves the list, so nothing schedules a collapse in the first place, and
    // exactly one card is up once the second commits.
    await userEvent.hover(cards[2]);
    await waitFor(() => expect(cards[2]).toHaveAttribute(STACK_OPEN_ATTR));
    expect(cards[1]).not.toHaveAttribute(STACK_OPEN_ATTR);
    expect(open()).toHaveLength(1);
    expect(list.style.height).toBe(height);

    // And leaving collapses it — after the close delay, not on the way out.
    await userEvent.unhover(cards[2]);
    await waitFor(() => expect(open()).toHaveLength(0));
    expect(list.style.height).toBe(height);
  },
};

/**
 * The list's height is **a function of the card count and nothing else** — which is the whole
 * of why the group cannot reflow, and it is a property that can be checked without touching
 * anything.
 *
 * Kept as its own story beside {@link FlipThrough} because the two check it from opposite
 * ends: this one against the arithmetic, at three counts, with nothing hovered; that one
 * through a real gesture, where the height is read back across an open, a hand-over and a
 * close. The measured third leg is a real Chromium over CDP, three-step pointer approach,
 * which reported the list at 796px before, during and after opening a card in a 15-card stack
 * while that card's margin went −278px → 8px and the next card's top went 50 → 336.
 */
export const FixedHeightFromTheCardCount: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Ramp" });

    expect(list.style.height).toBe(`${stackHeight(RAMP.length)}px`);
    // The canvas's own formula, and the slack that lets an open card overflow rather than
    // resize its group.
    expect(stackHeight(RAMP.length)).toBe(34 * RAMP.length + 269);
    expect(stackHeight(RAMP.length) - stackHeight(RAMP.length - 1)).toBe(34);
  },
};

/**
 * A card that breaks a rule and a card that is a game changer, side by side — because the spec
 * requires the two never be confusable, and the only honest way to check that is to draw them
 * together.
 *
 * `RULE BREAK` is red, spelled out, over the art, and it is the one mark that changes the
 * card's own edge. `GC` is gold, two letters, in the title bar, and says nothing is wrong.
 */
export const RuleBreakAndGameChanger: Story = {
  args: {
    cards: [
      deckCard(printing("lea", "288"), { quantity: 2 }),
      deckCard(printing("mh2", "138"), { gameChanger: true }),
      deckCard(printing("lea", "161"), { gameChanger: true }),
    ],
    violations: new Map<string, ValidationIssue[]>([
      [
        printing("lea", "288").id,
        [
          {
            severity: "error",
            code: "singleton",
            message: `Commander decks are singleton: max 1 copy of ${printing("lea", "288").name}; you have 2.`,
            cardIds: [printing("lea", "288").id],
          },
        ],
      ],
    ]),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("RULE BREAK")).toBeInTheDocument();
    expect(canvas.getAllByText("GC")).toHaveLength(2);
    // Only the card that breaks a rule carries the destructive edge.
    const items = canvas.getAllByRole("listitem");
    expect(items[0].className).toContain("border-destructive");
    expect(items[1].className).not.toContain("border-destructive");
  },
};

/**
 * Tags, as 8px chips in their own colour with the name one hover away, and a card the deck
 * wants more copies of than the collection could give it.
 *
 * A dot rather than a word: a tag is a mark the reader put there and already knows, and a
 * 224px column has no room for a second label beside a card's name.
 */
export const TaggedAndShortOfCopies: Story = {
  args: {
    cards: [
      deckCard(printing("lea", "288"), {
        quantity: 3,
        ownedQuantity: 1,
        tagId: 1,
        tagName: "Wincon",
        tagColor: "gold",
      }),
      deckCard(printing("mh2", "138"), { tagId: 2, tagName: "Cut candidate", tagColor: "ember" }),
      deckCard(printing("lea", "161"), { tagId: 3, tagName: "Keeper", tagColor: "moss" }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Both marks are decoration with a `title`; the words are in the card's own name, which
    // is the only text inside an `aria-label`-ed button that anyone hears.
    expect(canvas.getByTitle("Wincon")).toHaveAttribute("aria-hidden", "true");
    expect(canvas.getByRole("button", { name: /Wincon.*/ }).getAttribute("aria-label")).toContain(
      "you own 1 of 3",
    );
  },
};

/**
 * The Maybeboard, or any pile the reader switched off.
 *
 * The cards look exactly like the ones that count — that is deliberate, and it is the whole
 * of the category model: what changes is the group's own header, which the view above draws,
 * and the fact that **no card here is ever called short of copies**. The allocator claims
 * nothing for an inactive category, so every row in one reads 0 owned by construction, and a
 * shortage mark would report one the reader does not have.
 */
export const InactiveCategory: Story = {
  args: {
    label: "Maybeboard",
    cards: [
      deckCard(printing("lea", "288"), {
        quantity: 2,
        categoryActive: false,
        categoryKind: "maybe",
      }),
      deckCard(printing("nph", "57"), {
        quantity: 1,
        categoryActive: false,
        categoryKind: "maybe",
      }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.queryByText("0/2")).not.toBeInTheDocument();
  },
};

/**
 * A row whose printing has left the card database.
 *
 * It is listed and counted exactly as before — that is the reconciler's rule, and it is why
 * `deck_cards` denormalises a name. Nothing fetches a picture for it, because there is no
 * card to fetch one of.
 */
export const Orphan: Story = {
  args: { cards: [orphanDeckCard({ quantity: 1 }), deckCard(printing("mh2", "138"))] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(canvas.getByText("No card")).toBeInTheDocument();
  },
};

/**
 * One card, which is what the Commander and Companion piles usually hold. It is drawn in full,
 * because nothing covers it.
 */
export const OneCard: Story = {
  args: { label: "Commander", cards: [deckCard(printing("dom", "168"))] },
};

/**
 * Fifteen cards, which is where the arithmetic earns itself: the collapsed stack is 510px of
 * title bars plus one full card, and opening the first of them pushes 286px of cards out of
 * the bottom without the group growing by a pixel.
 *
 * It is also where the dwell earns itself. Fifteen strips are 510px of travel and a sweep down
 * them crosses one every ~15ms, so under the CSS lift this replaced, a reader aiming for card
 * four landed on card eight or nine.
 */
export const LongStack: Story = {
  args: {
    cards: [
      ...RAMP,
      deckCard(printing("mh2", "267")),
      deckCard(printing("wwk", "31")),
      deckCard(printing("mh2", "259")),
      deckCard(printing("tmp", "315")),
      deckCard(printing("fut", "153")),
      deckCard(printing("nph", "57")),
      deckCard(printing("lea", "288"), { quantity: 4 }),
      deckCard(printing("dom", "168"), { quantity: 2 }),
      deckCard(printing("isd", "51"), { quantity: 3 }),
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Ramp" });
    expect(list.style.height).toBe(`${stackHeight(15)}px`);
    // Every card is reachable, and the last one is a card rather than a scrollbar: a stack is
    // a list, and a list is what a screen reader counts.
    expect(canvas.getAllByRole("listitem")).toHaveLength(15);
  },
};
