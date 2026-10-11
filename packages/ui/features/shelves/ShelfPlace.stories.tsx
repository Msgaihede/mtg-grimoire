import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ShelfPlace } from "./ShelfPlace";

const meta = {
  title: "Shelves/Place",
  component: ShelfPlace,
  tags: ["autodocs"],
  args: {
    shelf: { kind: "folder", name: "Fetchlands", path: ["Binder", "Staples", "Fetchlands"] },
    children: "MH2 · 254",
  },
  // A chin's width at 100%, in the chin's own type: the place keeps its room and the printing
  // gives way first.
  decorators: [
    (Story) => (
      <div className="w-44 font-mono text-[0.625rem] text-dim">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Which shelf a card is on, said on the card itself — the `View all` wall's chin and the " +
          "flat table's Folder column (issue #907). The whole path rides as the tooltip.",
      },
    },
  },
} satisfies Meta<typeof ShelfPlace>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Folder: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText("Fetchlands")).toBeInTheDocument();
  },
};

/** A deck's group wears the heading's `Layers` glyph, so it still reads as a deck. */
export const DeckGroup: Story = {
  args: { shelf: { kind: "deck", name: "Mono-Red Aggro", path: ["Mono-Red Aggro"] } },
};

/** Recently removed, the inbox. */
export const RecentlyRemoved: Story = {
  args: { shelf: { kind: "removed", name: "Recently removed", path: ["Recently removed"] } },
};

/** Cards filed nowhere — the root's Not sorted, under the app's own cards glyph. */
export const NotSorted: Story = {
  args: { shelf: { kind: "unfiled", name: "Not sorted", path: ["Not sorted"] } },
};

/** A long name on a narrow tile: the printing goes first, then the name truncates. */
export const Narrow: Story = {
  args: {
    shelf: {
      kind: "folder",
      name: "Commander staples to trade",
      path: ["Commander staples to trade"],
    },
  },
  decorators: [
    (Story) => (
      <div className="w-24">
        <Story />
      </div>
    ),
  ],
};
