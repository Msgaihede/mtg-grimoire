import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { DraftPage } from "./DraftPage";

/**
 * The Draft & Packs page over the fake: its `packs_booster_set` answers a small booster made of the
 * fake corpus, its draft passes boosters round bots that take the first card (the first two, in a
 * Commander draft), and its Winston table's bot always takes the first pile.
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

/** The hub: the seven ways to start, and nothing in progress. */
export const Hub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const mode of [
      "Quick Draft",
      "Sealed",
      "Cube Draft",
      "Pod Draft",
      "Commander Draft",
      "Winston Draft",
      "Open Packs",
    ]) {
      await expect(
        await canvas.findByRole("button", { name: new RegExp(`^${mode}`) }),
      ).toBeVisible();
    }
  },
};

/** Choose a mode from the hub, one set for every pack, and start. */
async function startFromHub(canvasElement: HTMLElement, mode: RegExp): Promise<void> {
  const canvas = within(canvasElement);
  await userEvent.click(await canvas.findByRole("button", { name: mode }));
  const wall = await canvas.findByRole("list", { name: "Sets" });
  await userEvent.click(within(wall).getAllByRole("button")[0]);
  await userEvent.click(await canvas.findByRole("button", { name: / for the rest$/ }));
  await userEvent.click(canvas.getByRole("button", { name: /Start draft/ }));
}

/** A quick draft dealt from one set and started: the first pack on the table, and one pick made. */
export const Drafting: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await startFromHub(canvasElement, /^Quick Draft/);
    const pack = await canvas.findByRole("list", { name: "Pack" }, { timeout: 5000 });
    const before = within(pack).getAllByRole("button").length;
    const card = within(pack).getAllByRole("button")[0];
    // A click chooses; the Pick button picks (a second click on the card no longer does).
    await userEvent.click(card);
    await userEvent.click(
      canvas.getByRole("button", { name: `Pick ${card.getAttribute("aria-label")}` }),
    );
    // The bots have passed: the next pack is one card smaller.
    await waitFor(async () => {
      const next = await canvas.findByRole("list", { name: "Pack" });
      await expect(within(next).getAllByRole("button")).toHaveLength(before - 1);
    });
  },
};

/** A Commander draft round you and three bots: two cards chosen, and picked together. */
export const CommanderDraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await startFromHub(canvasElement, /^Commander Draft/);
    const pack = await canvas.findByRole("list", { name: "Pack" }, { timeout: 5000 });
    await expect(canvas.getByText("Choose 2")).toBeVisible();
    const before = within(pack).getAllByRole("button").length;
    const [a, b] = within(pack).getAllByRole("button");
    await userEvent.click(a);
    await userEvent.click(b);
    await userEvent.click(canvas.getByRole("button", { name: /^Pick .+ and / }));
    await waitFor(async () => {
      const next = await canvas.findByRole("list", { name: "Pack" });
      await expect(within(next).getAllByRole("button")).toHaveLength(before - 2);
    });
  },
};

/** A Winston draft against a bot: the stack, three piles, the first face up — and a pile taken. */
export const WinstonDraft: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await startFromHub(canvasElement, /^Winston Draft/);
    const table = await canvas.findByRole("list", { name: "Stack and piles" }, { timeout: 5000 });
    const stack = within(table).getByRole("img", { name: /^The stack, \d+ cards$/ });
    const count = Number(/(\d+)/.exec(stack.getAttribute("aria-label") ?? "")?.[1]);
    await expect(canvas.getByRole("list", { name: "Pile 1" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Take pile" }));
    // The pile is refilled from the stack, and the bot takes pile 1 and its refill too.
    await waitFor(() =>
      expect(
        within(table).getByRole("img", { name: `The stack, ${count - 2} cards` }),
      ).toBeVisible(),
    );
  },
};
