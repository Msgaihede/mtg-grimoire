import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import {
  deckGroups,
  deckTheoryMatches,
  deckViolations,
} from "../../../../.storybook/fake/fixtures";
import { THEORY_MATCH_LABEL } from "../CardMarks";
import { deckCardSlot } from "../dnd";
import { TableView } from "./TableView";

const meta = {
  title: "Decks/Views/TableView",
  component: TableView,
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
} satisfies Meta<typeof TableView>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The deck as the app's one `VirtualTable`, with a band per group.
 *
 * Nine columns, and the comparative questions are the ones it is for: what is dearest, what
 * is not owned, what is tagged. Its headers deliberately do **not** sort — the deck's order is
 * the toolbar's one Group by and one Sort, and a header that re-sorted would give one list two
 * orders with no way to see which was in force.
 */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    expect(
      canvas.getByRole("columnheader", { name: `Price. ${pricesAsOf(MARKETPLACES.tcgplayer)}` }),
    ).toBeInTheDocument();
    // Named rather than counted: the story runner's viewport is a number and not this app's
    // window, so how many rows a virtualiser mounts is not a fact worth asserting.
    expect(canvas.getByText("Ramp")).toBeInTheDocument();
    // No sortable header anywhere — asked as "no button in the header row", because a sortable
    // header is named for its **column** and a name-matched query would find nothing however
    // many of them there were. `views.test.tsx` carries the same assertion and the same note.
    const header = canvas
      .getAllByRole("row")
      .find((r) => r.getAttribute("aria-rowindex") === "1") as HTMLElement;
    expect(within(header).queryAllByRole("button")).toHaveLength(0);
  },
};

/** The row the open card pane is about, marked as it is in the collection and the search
 *  results — a quiet surface rather than gold, because the card being read is already beside
 *  the pane. */
export const WithSelectedRow: Story = {
  args: {
    // The **slot**, not the printing: a card filed in two piles is marked in the one the reader
    // clicked. See `CardStack`'s `selectedSlot`.
    selectedSlot: (() => {
      const row = deckGroups()[1].cards[0];
      return row ? deckCardSlot(row.categoryId, row.cardId, row.finish) : null;
    })(),
  },
};

/** Grouped by type: the bands change, the columns do not. */
export const ByType: Story = { args: { groups: deckGroups("type", "type") } };

/**
 * The **Live** list of a deck that keeps a plan — the tick, and the one surface that says it in
 * words as well.
 *
 * A row is not an `aria-label`-ed button, so a cell's text is really read: this view draws
 * `TheoryMatchBadge` beside the name **and** an `sr-only` twin, exactly as it already does for
 * the `GC` badge. The other three views fold the same word into `deckCardName` instead, because
 * a label replaces everything inside the control it names. `CardMarks.tsx` has the rule.
 */
export const TheoryMatches: Story = {
  args: { theoryMatches: deckTheoryMatches() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Four rows carry the badge, and each one says the words beside it — the pairing this view
    // exists to keep. Virtualised, so these are the rows currently mounted.
    expect(canvas.getAllByText(THEORY_MATCH_LABEL)).toHaveLength(4);
    expect(canvas.getAllByTitle(THEORY_MATCH_LABEL)).toHaveLength(4);
  },
};
