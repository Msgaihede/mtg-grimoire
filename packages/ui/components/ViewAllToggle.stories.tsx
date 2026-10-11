import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ViewAllToggle } from "./ViewAllToggle";

const meta = {
  title: "Primitives/ViewAllToggle",
  component: ViewAllToggle,
  tags: ["autodocs"],
  args: { pressed: false, onToggle: fn(), name: "View all cards" },
  parameters: {
    docs: {
      description: {
        component:
          "Every item of a filed page on one wall, with the folders left out — the deck gallery's, " +
          "the collection's and the wishlist's (issues #750 and #907). A toggle: pressing it again " +
          "goes back to the folder the reader was standing in.",
      },
    },
  },
} satisfies Meta<typeof ViewAllToggle>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Off: Story = {
  play: async ({ args, canvasElement }) => {
    const button = within(canvasElement).getByRole("button", { name: "View all cards" });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(button);
    await expect(args.onToggle).toHaveBeenCalledTimes(1);
  },
};

/** On: the accent edge and the gold word, the filter chips' pressed mark. */
export const On: Story = {
  args: { pressed: true },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "View all cards" }),
    ).toHaveAttribute("aria-pressed", "true");
  },
};
