import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, within } from "storybook/test";
import { PRICES_AS_OF } from "@/lib/prices";
import { deckGroups, deckViolations } from "../../../../.storybook/fake/fixtures";
import { TableView } from "./TableView";

const meta = {
  title: "Decks/Views/TableView",
  component: TableView,
  tags: ["autodocs"],
  args: { groups: deckGroups(), violations: deckViolations(), onSelect: fn() },
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
      canvas.getByRole("columnheader", { name: `Price. ${PRICES_AS_OF}` }),
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
  args: { selectedCardId: deckGroups()[1].cards[0]?.cardId ?? null },
};

/** Grouped by type: the bands change, the columns do not. */
export const ByType: Story = { args: { groups: deckGroups("type", "type") } };
