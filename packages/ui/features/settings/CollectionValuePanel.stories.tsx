import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
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
          "What the reader expects to get for their cards: a sell percentage, a minimum card " +
          "value and a bulk price, which together make the one reduced price drawn in brackets " +
          "beside the collection's value, its folders and the home widgets.\n\n" +
          "**The minimum goes first**, on each card's market price, and the percentage is taken " +
          "of what is left; each card under the minimum is then counted at the bulk price, which " +
          "waits greyed until a minimum is set. A box is stored when it is left or Enter is " +
          "pressed. An empty box is that setting's default.",
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

/** Issue #1477: a minimum, then a bulk price — each card under $1.00 counted at $0.01, a line of
 *  its own in the breakdown. */
export const SetABulkPrice: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText(/only full values are shown/);
    const bulk = canvas.getByRole("textbox", { name: /Bulk price/ });
    await expect(bulk).toHaveAttribute("aria-disabled", "true");
    await userEvent.type(canvas.getByRole("textbox", { name: /Minimum card value/ }), "1{Enter}");
    await waitFor(() => expect(bulk).not.toHaveAttribute("aria-disabled"));
    await userEvent.type(bulk, "0.01{Enter}");
    await expect(await canvas.findByText(/^Bulk at \$0\.01 · /)).toBeInTheDocument();
  },
};
