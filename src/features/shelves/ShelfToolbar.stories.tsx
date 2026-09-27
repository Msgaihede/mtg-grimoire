import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { FOLD_PAUSED_REASON, ShelfToolbar } from "./ShelfToolbar";

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

/**
 * While a filter is on, collapse is suspended (spec §3.4): Expand all and Collapse all are refused
 * in the open — dimmed, still in the tab order, the reason on hover and as their description — and
 * a press writes nothing. Add folder is not about folding and works as ever.
 */
export const FoldPaused: Story = {
  args: { foldPaused: FOLD_PAUSED_REASON },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    for (const name of ["Expand all", "Collapse all"]) {
      const button = canvas.getByRole("button", { name });
      await expect(button).toHaveAttribute("aria-disabled", "true");
      await expect(button).toHaveAccessibleDescription(FOLD_PAUSED_REASON);
      await userEvent.click(button);
    }
    await expect(args.onExpandAll).not.toHaveBeenCalled();
    await expect(args.onCollapseAll).not.toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Add folder" }));
    await expect(args.onAddFolder).toHaveBeenCalledTimes(1);
  },
};
