import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { UPDATE_READY } from "@/lib/core/web/update";
import { UpdateNoticeBar } from "./UpdateNotice";

/**
 * The bar that says a newer build of the app is waiting, drawn from an answer.
 *
 * **The words are the web host's own** — `update.ts` in `src/lib/core/web/`, the one host that
 * holds a build back — and the bar draws whatever it is handed. `UpdateNotice`, which `LightApp`
 * mounts, is this bar behind a question only that host answers; over the Storybook fake the
 * question is refused and nothing is drawn, so the story stands on the bar.
 *
 * **Boxed, and the box is a containing block**, for `StorageNotice.stories.tsx`'s reason: the bar
 * is `fixed` to the bottom of the window, and a transformed ancestor keeps each story's inside
 * its own frame.
 */
const meta = {
  title: "Light/UpdateNotice",
  component: UpdateNoticeBar,
  tags: ["autodocs"],
  args: { update: UPDATE_READY, busy: false, onApply: fn() },
  decorators: [
    (Story, { parameters }) => (
      <div
        className="h-[30rem] max-w-full overflow-hidden bg-bg"
        style={{
          width: (parameters.frameWidth as number | undefined) ?? 360,
          transform: "translateZ(0)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "Shown when a newer build of the app has been fetched and is waiting. Not a modal: a " +
          "bar along the bottom of the window, clear of the phone face's tab bar, that a reader " +
          "may leave for the rest of the session. Only its button takes the newer build, and " +
          "the app then starts again on it.",
      },
    },
  },
} satisfies Meta<typeof UpdateNoticeBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A narrow phone: the sentence wraps beside the control rather than pushing it off the frame. */
export const Phone: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "A new version of MTG Grimoire is ready.",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Reload to update" }));
    await expect(args.onApply).toHaveBeenCalledOnce();
  },
};

/** After the press, while the host starts the app again: greyed, and takes no second press. */
export const Updating: Story = {
  args: { busy: true },
  play: async ({ canvasElement, args }) => {
    const button = within(canvasElement).getByRole("button", { name: "Reload to update" });
    await expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);
    await expect(args.onApply).not.toHaveBeenCalled();
  },
};

/** Past the desktop floor: the bar keeps its own width, centred. */
export const Wide: Story = {
  parameters: { frameWidth: 1024 },
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("button", { name: "Reload to update" }),
    ).toBeVisible();
  },
};

/** Nothing waiting: the live region is there, empty, and nothing is drawn. */
export const Nothing: Story = {
  args: { update: null },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("button")).toBeNull();
    await expect(canvas.getByRole("status")).toBeEmptyDOMElement();
  },
};
