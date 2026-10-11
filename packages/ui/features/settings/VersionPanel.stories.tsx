import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { APP_VERSION } from "@/lib/appVersion";
import { VersionPanel } from "./VersionPanel";

const meta = {
  title: "Settings/VersionPanel",
  component: VersionPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width, as every panel here is drawn.
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
          "The light edition's **Updates**: the version running and every release's notes, " +
          "`UpdatePanel` without the updater. A light install is updated by its store or a " +
          "deploy, so nothing here checks, downloads or restarts.\n\n" +
          "**Both answers ship with the build** — the version from the root manifest, the notes " +
          "from `changelog/<version>.md` (each release's GitHub body), the days from " +
          "`CHANGELOG.md` — so the story draws this repository's real history, and the panel " +
          "asks no host anything.",
      },
    },
  },
} satisfies Meta<typeof VersionPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** This build's version over its history, every row closed until it is pressed. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const panel = within(canvasElement);
    await expect(panel.getByText(APP_VERSION)).toBeInTheDocument();
    await expect(panel.queryByRole("button", { name: "Check now" })).toBeNull();

    const [newest] = await panel.findAllByRole("button", { expanded: false });
    await userEvent.click(newest as HTMLElement);
    await expect(newest).toHaveAttribute("aria-expanded", "true");
  },
};
