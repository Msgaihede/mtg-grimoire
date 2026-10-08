import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import type { Shelf } from "@/lib/shelves";
import { ShelfStickyBar } from "./ShelfStickyBar";

function shelfOf(over: Partial<Shelf> & { id: number; name: string }): Shelf {
  return {
    kind: "folder",
    group: "own",
    pathIds: [over.id],
    path: [over.name],
    depth: 0,
    indent: 0,
    lead: [],
    leadIds: [],
    headless: false,
    collapsed: false,
    locked: false,
    ...over,
  };
}

const FETCHLANDS = shelfOf({
  id: 12,
  name: "Fetchlands",
  depth: 2,
  indent: 2,
  pathIds: [3, 8, 12],
  path: ["Binder", "Staples", "Fetchlands"],
});

const meta = {
  title: "Shelves/Sticky bar",
  component: ShelfStickyBar,
  tags: ["autodocs"],
  args: { shelf: FETCHLANDS, onOpen: fn(), onTop: fn() },
  decorators: [
    // The host draws this over the top of the wall at `LAYER.header`; the workbench only needs
    // the width.
    (Story) => (
      <div className="relative w-[48rem] max-w-full">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The bar naming the shelf the reader is scrolled inside, as path buttons, with **Top**. " +
          "An overlay rather than CSS `sticky`, because the wall's rows are absolutely positioned; " +
          "and a permanent drop target for cards, because the headings come and go as the wall " +
          "scrolls and this does not.",
      },
    },
  },
} satisfies Meta<typeof ShelfStickyBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Staples" }));
    await expect(args.onOpen).toHaveBeenCalledWith(8);
    await userEvent.click(canvas.getByRole("button", { name: "Top" }));
    await expect(args.onTop).toHaveBeenCalledTimes(1);
  },
};

export const NotSorted: Story = {
  args: { shelf: shelfOf({ id: 0, name: "Not sorted", kind: "unfiled" }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button", { name: "Not sorted" })).toBeNull();
    await expect(canvas.getByText("Not sorted")).toBeInTheDocument();
  },
};

export const Armed: Story = {
  args: { dropMark: "armed" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-shelf-sticky]")).toHaveClass("ring-accent/45");
  },
};

export const Over: Story = {
  args: { dropMark: "over" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-shelf-sticky]")).toHaveClass("bg-accent/15");
  },
};
