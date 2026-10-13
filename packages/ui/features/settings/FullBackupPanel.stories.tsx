import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useNotifications } from "@/lib/notifications";
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
    // A refusal is a toast now (2026-10-12), not the panel's alert line: the restore it was
    // about never started, and the Toaster is the shell's, so the story reads the store.
    await waitFor(() =>
      expect(useNotifications.getState().notices[0]).toMatchObject({
        tone: "error",
        title: "Couldn't restore the backup",
        body: expect.stringContaining("The file picker could not be opened"),
      }),
    );
    await expect(canvas.getByRole("button", { name: "Import ZIP…" })).toBeEnabled();
  },
};
