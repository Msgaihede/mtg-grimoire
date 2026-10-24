import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { TIERS_MUST_CLIMB } from "@/features/scanner/sounds/scanSounds";
import { ScanSoundsPanel } from "./ScanSoundsPanel";

const meta = {
  title: "Settings/ScanSoundsPanel",
  component: ScanSoundsPanel,
  tags: ["autodocs"],
  decorators: [
    // The settings column's own width — `max-w-2xl` inside the 1280×800 window.
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
          "Whether the scanner plays a sound as a card lands, and the prices its louder " +
          "jingles start at.\n\n" +
          "**Six sounds.** *Scanned* for a card below the first tier or with no price; *Needs a " +
          "choice* for a card waiting on a printing or a finish; then Tier 1, Tier 2, Tier 3 and " +
          "the Jackpot, each from the figure in its box — out of the box $1, $10, $100 and " +
          "$1,000. A card the reader settles in the tray plays its tier then.\n\n" +
          "**Each row has a Play**, so a reader hears which jingle a figure buys before a card is " +
          "under the camera. **The figures are the reader's marketplace currency**, and the " +
          "panel names it. A box is stored when it is left or Enter is pressed, and only as a " +
          "ladder that climbs — otherwise the crate's sentence is shown and nothing is written.",
      },
    },
  },
} satisfies Meta<typeof ScanSoundsPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A reader who has never touched the setting: on, at 1, 10, 100 and 1000. */
export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const jackpot = canvas.getByRole("textbox", { name: "Jackpot starts at" });
    await waitFor(async () => {
      await expect(jackpot).toHaveValue("1000");
    });
    await expect(canvas.getByRole("switch", { name: /Play a sound/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  },
};

/** A tier set above the one after it is refused in the crate's words, and nothing is stored. */
export const LadderThatDoesNotClimb: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const tier1 = canvas.getByRole("textbox", { name: "Tier 1 starts at" });
    await waitFor(async () => {
      await expect(tier1).toHaveValue("1");
    });
    await userEvent.clear(tier1);
    await userEvent.type(tier1, "50{Enter}");
    await expect(await canvas.findByRole("alert")).toHaveTextContent(TIERS_MUST_CLIMB);
  },
};
