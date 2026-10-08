import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { printing } from "../../fake/fixtures";
import { CardTile } from "@/components/CardTile";
import { CountTag } from "@/components/CountTag";

// By set and number rather than by index: `CARDS` is generated, and a regeneration may reorder it.
const card = printing("lea", "161");
/** `mp2 8` — Consecrated Sphinx, one of the corpus's foil-only printings, so the foil story draws
 *  a copy that exists rather than a finish laid on cardboard that was never printed in it. */
const foil = printing("mp2", "8");

const meta = {
  title: "Cards/CardTile",
  component: CardTile,
  tags: ["autodocs"],
  args: {
    cardId: card.id,
    name: card.name,
    rarity: card.rarity,
    chin: { setCode: card.setCode, collectorNumber: card.collectorNumber },
  },
  decorators: [
    (Story) => (
      <div style={{ width: 170 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof CardTile>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A tile that is not a control — the shared binder's. */
export const Plain: Story = {};

/** A tile whose art is a button — a wall's. */
export const Pressable: Story = {
  args: { onPress: fn(), money: "$1.25" },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByRole("button", { name: card.name }));
    await expect(args.onPress).toHaveBeenCalledTimes(1);
  },
};

/** A count laid on the art, and a foil copy. */
export const FoilWithCount: Story = {
  args: {
    cardId: foil.id,
    name: foil.name,
    rarity: foil.rarity,
    chin: { setCode: foil.setCode, collectorNumber: foil.collectorNumber },
    finish: "foil",
    overlay: (
      <span className="absolute bottom-1 left-1 rounded bg-bg/85 px-1.5 py-0.5">
        <CountTag count={4} title="4 copies" />
      </span>
    ),
  },
};
