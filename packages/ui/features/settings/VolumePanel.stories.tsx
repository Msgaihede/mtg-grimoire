import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, within } from "storybook/test";
import { useAppVolume } from "@/lib/volume";
import { VolumePanel } from "./VolumePanel";

const meta = {
  title: "Settings/VolumePanel",
  component: VolumePanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window.
    (Story) => (
      <div className="max-w-2xl p-2">
        <Story />
      </div>
    ),
  ],
  // Each story starts at full, whatever the last one left in the store.
  beforeEach: () => {
    useAppVolume.getState().setVolume(100);
  },
  parameters: {
    docs: {
      description: {
        component:
          "How loud the app is: one slider over every sound the page makes — the scanner's " +
          "beeps and jingles and the playtest board — each multiplied by it (issue #1703).\n\n" +
          "**Kept on this device**, in `localStorage`, and never synced; every window of the app " +
          "reads the one level. **Steps of 5**, the playtest board's slider's, with the figure " +
          "beside it and the board's speaker icon, crossed out at 0. **Play** sounds the " +
          "scanner's *Scanned* beep at the level, with the scanner's switch off too.",
      },
    },
  },
} satisfies Meta<typeof VolumePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A reader who has never touched the setting: full volume. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("slider", { name: "App volume" })).toHaveValue("100");
    await expect(canvas.getByText("100%")).toBeInTheDocument();
  },
};

/** Turned all the way down: the speaker is crossed out and the figure dims. */
export const Silent: Story = {
  beforeEach: () => {
    useAppVolume.getState().setVolume(0);
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("slider", { name: "App volume" })).toHaveAttribute(
      "aria-valuetext",
      "0%",
    );
  },
};

/** The slider sets the level the moment it moves. */
export const Moved: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const slider = canvas.getByRole("slider", { name: "App volume" });
    fireEvent.change(slider, { target: { value: "40" } });
    await expect(slider).toHaveAttribute("aria-valuetext", "40%");
    await expect(useAppVolume.getState().volume).toBe(40);
  },
};
