import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { EMPTY_SHELF_COPY, EmptyShelf } from "./EmptyShelf";

const meta = {
  title: "Shelves/Empty shelf",
  component: EmptyShelf,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="w-[48rem] max-w-full">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "An empty folder's shelf: a dashed box — the container vocabulary the folder cards use — " +
          "that says what to do, and takes a card dropped on it.",
      },
    },
  },
} satisfies Meta<typeof EmptyShelf>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByText(EMPTY_SHELF_COPY)).toBeInTheDocument();
  },
};

export const Armed: Story = {
  args: { dropMark: "armed" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-shelf-empty]")).toHaveClass("border-accent/45");
  },
};

export const Over: Story = {
  args: { dropMark: "over" },
  play: async ({ canvasElement }) => {
    await expect(canvasElement.querySelector("[data-shelf-empty]")).toHaveClass("bg-accent/15");
  },
};
