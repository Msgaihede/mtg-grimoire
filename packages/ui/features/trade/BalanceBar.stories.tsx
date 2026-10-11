import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { BalanceBar } from "./BalanceBar";

/** A stretch's grow factor — the share of the track it is given. */
const share = (canvasElement: HTMLElement, name: string): number =>
  Number(canvasElement.querySelector<HTMLElement>(`[data-share=${name}]`)?.style.flexGrow);

const meta = {
  title: "Trade/BalanceBar",
  component: BalanceBar,
  tags: ["autodocs"],
  decorators: [
    (Story) => (
      <div className="bg-surface p-6">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "The balance of a trade, drawn: the reader's share, the gap, their share, and a tick " +
          "at the middle.\n\n" +
          "**Three stretches and not two.** Two meeting off-centre say “64 against 87” and " +
          "leave the reader to subtract; the gold stretch between where they meet and the tick " +
          "*is* the subtraction. It sits on the half of whoever owes and is as wide as what " +
          "would bring that side level, so an even trade draws no gold at all.\n\n" +
          "Totals are in **cents**, at each side's own percentage — the same two figures the " +
          "sentence beside the bar is made from. The bar is `aria-hidden` on both faces: that " +
          "sentence is the fact, and this is a picture of it.",
      },
    },
  },
} satisfies Meta<typeof BalanceBar>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The design's trade: $64.39 against $87.09. The reader owes, so the gold is on their half. */
export const YouOwe: Story = {
  args: { mineTotal: 6439, theirsTotal: 8709 },
  play: async ({ canvasElement }) => {
    // 64.39 of 151.48 is 42.5%: the reader's stretch stops 7.5 short of the tick.
    await expect(share(canvasElement, "mine")).toBeCloseTo(42.507, 2);
    await expect(share(canvasElement, "gap")).toBeCloseTo(7.493, 2);
    await expect(share(canvasElement, "theirs")).toBe(50);
  },
};

/** The other way round: their stretch stops short, and the gold is on their half. */
export const TheyOwe: Story = {
  args: { mineTotal: 643, theirsTotal: 33 },
  play: async ({ canvasElement }) => {
    await expect(share(canvasElement, "mine")).toBe(50);
    await expect(share(canvasElement, "theirs")).toBeCloseTo(4.882, 2);
    // What is left of their half is the gap.
    await expect(share(canvasElement, "gap") + share(canvasElement, "theirs")).toBeCloseTo(50, 6);
  },
};

/** Even to the cent: two halves and no gold. An empty trade draws the same bar. */
export const Even: Story = {
  args: { mineTotal: 1460, theirsTotal: 1460 },
  play: async ({ canvasElement }) => {
    await expect(share(canvasElement, "gap")).toBe(0);
    await expect(share(canvasElement, "mine")).toBe(50);
    await expect(share(canvasElement, "theirs")).toBe(50);
  },
};

/** A caller with a narrower box passes its own width, and it replaces the default. */
export const Narrow: Story = {
  args: { mineTotal: 6439, theirsTotal: 8709, className: "w-40" },
};
