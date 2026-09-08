import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import {
  deckGroups,
  deckTheoryMatches,
  deckViolations,
} from "../../../../.storybook/fake/fixtures";
import { THEORY_MATCH_ATTR, THEORY_MATCH_LABEL } from "../CardMarks";
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
    // **The frame is a scroller because the *page* is, and it stopped being a height because the
    // table stopped being one** (2026-09-08). It was `flex h-[36rem]` — a bounded box for a view
    // that scrolled inside itself — and `TableView` passes `VirtualTable`'s `grow` now: it draws
    // every row in normal flow and is not a scroll container, so a fixed frame would simply be
    // spilled out of and the workbench would show a clipped deck rather than the shipped one. In
    // the app the box this view is drawn in is given no height at all and `AppShell`'s `main`
    // takes the scroll; `max-h` plus `overflow-y-auto` is that arrangement at a story's scale —
    // the table is as tall as its own rows, and this stands in for the page.
    (Story) => (
      <div className="flex max-h-[36rem] overflow-y-auto">
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
 * is not owned, what is labelled. Its headers deliberately do **not** sort — the deck's order is
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
 * The **Live** list of a deck that keeps a plan — the mark, and the one surface that says it in
 * words as well.
 *
 * A row is not an `aria-label`-ed button, so a cell's text is really read: this view draws
 * `TheoryMatchBadge` beside the name **and** an `sr-only` twin, exactly as it already does for
 * the `GC` badge. The other three views fold the same word into `deckCardName` instead, because
 * a label replaces everything inside the control it names. `CardMarks.tsx` has the rule.
 *
 * **Since 2026-09-08 every row carries a badge**: four are the plan and the other six wear the
 * red X, which says the plan does not ask for that card at all. The twin follows it — a glyph
 * that means "not this one" is exactly the mark a spoken list cannot infer from silence.
 */
export const TheoryMatches: Story = {
  args: { theoryPlan: deckTheoryMatches() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    // Every row carries the badge, and each one says the words beside it — the pairing this view
    // exists to keep. Virtualised, so these are the rows currently mounted. The badge itself is
    // `aria-hidden` and bound `describes: false` (no `title` any more); `THEORY_MATCH_ATTR` is
    // its own handle, and the `sr-only` twin beside it is what makes the words in `getAllByText`
    // honest — this view is the one place `TheoryMatchBadge` gets one at all.
    expect(canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}]`)).toHaveLength(10);

    // Six of the ten are the third tier's X: a glyph and never a count, because a card the plan
    // has no row for has no difference to state.
    const unplanned = [...canvasElement.querySelectorAll(`[${THEORY_MATCH_ATTR}="unplanned"]`)];
    expect(unplanned).toHaveLength(6);
    for (const mark of unplanned) {
      expect(mark.textContent).toBe("");
      expect(mark.querySelector("svg")).not.toBeNull();
    }
    // …and the twin says it in words, once per row. This view's own arrangement: the other three
    // fold the sentence into the control's name, so six of anything is a claim only here. Written
    // out rather than taken off `THEORY_UNPLANNED_LABEL`, because a constant on both sides of an
    // assertion agrees with a reword by construction, and this is the one place the third tier's
    // sentence is in the tree as text rather than folded into a control's name.
    expect(canvas.getAllByText("Not in the theory list")).toHaveLength(6);

    // **Two of the four planned rows are counts rather than ticks** (issue #212), and the twin is
    // where this view earns its keep: `+2` and `-1` are two characters that mean nothing spoken,
    // so the sentence beside them has to carry the number too. Two rows match exactly and say the
    // bare sentence; the other two say it with the press it is asking for on the end.
    expect(canvas.getAllByText(THEORY_MATCH_LABEL)).toHaveLength(2);
    expect(canvas.getByText(`${THEORY_MATCH_LABEL} · 2 to add`)).toBeInTheDocument();
    expect(canvas.getByText(`${THEORY_MATCH_LABEL} · 1 to remove`)).toBeInTheDocument();
  },
};
