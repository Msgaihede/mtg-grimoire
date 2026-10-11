import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { WorkInProgress } from "./WorkInProgress";

const meta = {
  title: "Primitives/WorkInProgress",
  component: WorkInProgress,
  tags: ["autodocs"],
  args: { view: "Playtesting" },
  decorators: [
    // The shell's content area is a filled box the page stretches inside, and the whole of what
    // this component decides is where its one line sits in that box. A story with no height would
    // draw the sentence at the top and show nothing about that.
    (Story) => (
      <div className="h-96 bg-bg p-4">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        component:
          "A destination that is in the rail before it is a page — **Playtesting** as it " +
          "ships today, and **Trade** until it grew a page of its own.\n\n" +
          "**One component rather than one per placeholder.** Two views drawing one sentence " +
          "two ways is a drift nothing goes red for, and the sentence is the whole of what " +
          "a placeholder says. What each caller supplies is its own word, because that word " +
          "is the heading a screen reader lands on.\n\n" +
          "**The `<h2>` is `sr-only`, exactly as every real page's is.** The ribbon draws the " +
          "view's name as the window's `<h1>`, so a visible second copy would be the name twice " +
          "on one screen — and a page with no heading at all leaves the region unnamed for " +
          "anyone reading by landmark.",
      },
    },
  },
} satisfies Meta<typeof WorkInProgress>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Playtesting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { level: 2, name: "Playtesting" })).toHaveClass(
      "sr-only",
    );
    await expect(canvas.getByText("Work in progress")).toBeVisible();
  },
};
