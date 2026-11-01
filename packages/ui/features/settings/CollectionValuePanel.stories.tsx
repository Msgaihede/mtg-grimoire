import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { CollectionValuePanel } from "./CollectionValuePanel";

const meta = {
  title: "Settings/CollectionValuePanel",
  component: CollectionValuePanel,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "What the reader expects to get for their cards: a sell percentage and a minimum card " +
          "value, which together make the one reduced price drawn in brackets beside the " +
          "collection's value, its folders and the home widgets.\n\n" +
          "**The minimum goes first**, on each card's market price, and the percentage is taken " +
          "of what is left. A box is stored when it is left or Enter is pressed. An empty box is " +
          "that setting's default.",
      },
    },
  },
} satisfies Meta<typeof CollectionValuePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A reader who has never touched the setting: no reduced price anywhere. */
export const NotSet: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText(/only full values are shown/)).toBeInTheDocument();
  },
};

/** Setting a percentage opens the breakdown of the reader's own collection. */
export const SetAPercentage: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/only full values are shown/);
    await userEvent.type(canvas.getByRole("textbox", { name: /Sell percentage/ }), "70{Enter}");
    await expect(await canvas.findByText("Sell at 70%")).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  },
};

/** A percentage out of bounds is refused in words, and nothing is stored. */
export const OutOfBounds: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/only full values are shown/);
    await userEvent.type(canvas.getByRole("textbox", { name: /Sell percentage/ }), "120{Enter}");
    await expect(await canvas.findByRole("alert")).toHaveTextContent(/at most 100/);
  },
};
