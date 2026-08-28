import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { UpdateReadyBar } from "./UpdateReadyBar";

const meta = {
  title: "PWA/UpdateReadyBar",
  component: UpdateReadyBar,
  tags: ["autodocs"],
  args: { ready: true, onApply: fn() },
  decorators: [
    (Story) => (
      <div className="relative h-48">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The web target's update flow, made visible.\n\n" +
          "A browser installs a new build as the **waiting** worker and leaves it there until " +
          "every page under the old one is gone — so 'just reload' hands the reader the old " +
          "build back with no explanation. Spec §5.4 fixes the shape instead: the new build " +
          "waits, this bar says so, the reader presses it, and the page reloads once.\n\n" +
          "**Non-modal is the requirement rather than a preference.** A reader halfway through " +
          "a deck must be able to ignore this for the rest of the session and go on working on " +
          "the build they started with. So there is no scrim, no focus trap and no Escape rung " +
          "— it is a control that appeared, not a question that has to be answered.\n\n" +
          "Desktop never draws it: `useServiceWorker` returns without registering when " +
          "`isWebTarget()` is false, so `ready` is permanently `false` in the shipped window.",
      },
    },
  },
} satisfies Meta<typeof UpdateReadyBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A build has installed and is waiting. The press is the only thing that lets it take over. */
export const Ready: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(/A new version is ready/);
    await userEvent.click(canvas.getByRole("button", { name: /Reload to update/ }));
    await expect(args.onApply).toHaveBeenCalledTimes(1);
  },
};

/**
 * The state the app is in for all but a few seconds of its life: no waiting worker, nothing on
 * screen at all. Worth a story because "nothing" is the behaviour — a bar that greyed itself
 * out instead would be a permanent strip of chrome over the view.
 */
export const Quiet: Story = {
  args: { ready: false },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("status")).not.toBeInTheDocument();
  },
};
