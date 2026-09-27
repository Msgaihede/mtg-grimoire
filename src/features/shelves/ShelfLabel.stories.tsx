import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { ShelfLabel } from "./ShelfLabel";

const meta = {
  title: "Shelves/Label",
  component: ShelfLabel,
  tags: ["autodocs"],
  args: { group: "decks" },
  decorators: [
    (Story) => (
      <div className="w-[48rem] max-w-full">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ShelfLabel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Decks: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("heading", { level: 3 })).toHaveAccessibleName(
      "Decks",
    );
  },
};

export const ManagedByDecks: Story = {
  args: { group: "managed" },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole("heading", { level: 3 })).toHaveAccessibleName(
      "Managed by decks",
    );
  },
};
