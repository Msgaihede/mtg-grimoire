import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ShelfToolbar } from "./ShelfToolbar";

const meta = {
  title: "Shelves/Toolbar",
  component: ShelfToolbar,
  tags: ["autodocs"],
  args: { onAddFolder: fn(), onExpandAll: fn(), onCollapseAll: fn() },
  parameters: {
    docs: {
      description: {
        component:
          "The path row's right-hand end: Add folder at the level the reader stands on, and Expand " +
          "all / Collapse all for every shelf below it.",
      },
    },
  },
} satisfies Meta<typeof ShelfToolbar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Add folder" }));
    await userEvent.click(canvas.getByRole("button", { name: "Expand all" }));
    await userEvent.click(canvas.getByRole("button", { name: "Collapse all" }));
    await expect(args.onAddFolder).toHaveBeenCalledTimes(1);
    await expect(args.onExpandAll).toHaveBeenCalledTimes(1);
    await expect(args.onCollapseAll).toHaveBeenCalledTimes(1);
  },
};

/** Inside a deck group, Recently removed or a managed folder: `canMakeFolder` is false. */
export const WithoutAddFolder: Story = {
  args: { onAddFolder: undefined },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole("button", { name: "Add folder" })).toBeNull();
  },
};
