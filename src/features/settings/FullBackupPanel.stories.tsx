import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { FullBackupPanel } from "./FullBackupPanel";

const meta = {
  title: "Settings/FullBackupPanel",
  component: FullBackupPanel,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="max-w-2xl p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A complete ZIP backup and restore. The native host owns file selection and destructive confirmation. The workbench has no file picker and shows the host refusal.",
      },
    },
  },
} satisfies Meta<typeof FullBackupPanel>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const PickerUnavailable: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Import ZIP…" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent(
      "The file picker could not be opened",
    );
    await expect(canvas.getByRole("button", { name: "Import ZIP…" })).toBeEnabled();
  },
};
