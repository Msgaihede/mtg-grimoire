import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import type { DeckCard } from "@/lib/ipc";
import { deckCard, orphanDeckCard, printing } from "../../../.storybook/fake/fixtures";
import { CardStack, stackHeight } from "./CardStack";
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
  args: { cards: RAMP, label: "Ramp", onSelect: fn() },
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
 * Run the pointer down it. Each card lifts clear and pushes the ones after it out of the
 * bottom of the group — **the group itself never resizes**, which is what lets a reader walk a
 * whole column without the page moving under them.
 */
export const Default: Story = {};

/**
 * The list's height is **a function of the card count and nothing else** — which is the whole
 * of why the group cannot reflow, and it is a property that can be checked without hovering
 * anything.
 *
 * **This play does not prove the no-reflow claim, and it is named so it does not pretend to.**
 * The earlier version hovered each card and asserted `getBoundingClientRect().height` was
 * unchanged; that assertion is **vacuous in both runners**, because `userEvent.hover`
 * dispatches pointer events and never engages the CSS `:hover` state — so nothing moved in
 * the first place and the assertion could not have failed. Leaving it green would have been a
 * test standing in for a claim it cannot make, on the headline interaction of the redesign.
 *
 * What actually holds the property up is two things, both recorded rather than implied:
 *
 * * **structurally** — the lift is `hover:` / `focus-within:` in CSS and there is no hover
 *   state in JavaScript, so no height can depend on one. `CardStack.test.tsx`'s
 *   `hovering_a_card_does_not_change_the_group_height` drives both gestures and reads the
 *   height back, which is what fails the day someone reaches for `useState`.
 * * **by measurement** — a real Chromium over CDP, three-step pointer approach, reported the
 *   list at 796px before, during and after a hover on a 15-card stack while the first card's
 *   margin went −278px → 8px and the second card's top went 50 → 336. That run is in the lane
 *   report.
 *
 * So what is asserted here is the derived height, at three counts, against the arithmetic.
 */
export const FixedHeightFromTheCardCount: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const list = canvas.getByRole("list", { name: "Ramp" });

    expect(list.style.height).toBe(`${stackHeight(RAMP.length)}px`);
    // The canvas's own formula, and the slack that lets a lifted card overflow rather than
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
 * title bars plus one full card, and lifting the first of them pushes 286px of cards out of
 * the bottom without the group growing by a pixel.
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
