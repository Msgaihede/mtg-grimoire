import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DraftPage } from "./DraftPage";

/**
 * The Draft & Packs page over the fake: its `packs_booster_set` answers a small booster made of the
 * fake corpus, and its draft passes boosters round seven bots that take the first card.
 */
const meta = {
  title: "Draft/Draft & Packs",
  component: DraftPage,
  decorators: [
    (Story) => (
      <div className="h-[860px] w-[1280px] overflow-auto bg-bg p-6">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DraftPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The hub: the ways to start, and nothing in progress. */
export const Hub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const mode of ["Quick Draft", "Sealed", "Cube Draft", "Pod Draft", "Open Packs"]) {
      await expect(await canvas.findByRole("button", { name: new RegExp(mode) })).toBeVisible();
    }
  },
};

/** A quick draft dealt from one set and started: the first pack on the table, and one pick made. */
export const Drafting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: /Quick Draft/ }));
    const wall = await canvas.findByRole("list", { name: "Sets" });
    const first = within(wall).getAllByRole("button")[0];
    await userEvent.click(first);
    await userEvent.click(await canvas.findByRole("button", { name: / for the rest$/ }));
    await userEvent.click(canvas.getByRole("button", { name: /Start draft/ }));
    const pack = await canvas.findByRole("list", { name: "Pack" }, { timeout: 5000 });
    const before = within(pack).getAllByRole("button").length;
    const card = within(pack).getAllByRole("button")[0];
    await userEvent.click(card);
    await userEvent.click(card);
    // The bots have passed: the next pack is one card smaller.
    await waitFor(async () => {
      const next = await canvas.findByRole("list", { name: "Pack" });
      await expect(within(next).getAllByRole("button")).toHaveLength(before - 1);
    });
  },
};
