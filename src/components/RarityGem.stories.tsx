import type { Meta, StoryObj } from "@storybook/react-vite";
import { RarityGem } from "./RarityGem";

const meta = {
  title: "Primitives/RarityGem",
  component: RarityGem,
} satisfies Meta<typeof RarityGem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Rare: Story = { args: { rarity: "rare", withLabel: true } };
