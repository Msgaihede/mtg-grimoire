import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { RarityGem } from "./RarityGem";

const meta = {
  title: "Primitives/RarityGem",
  component: RarityGem,
  tags: ["autodocs"],
  // On the meta because every story below wants it: `withLabel` is the table's shape, and
  // `GemOnly` is the one story that exists to turn it off.
  args: { withLabel: true },
  parameters: {
    docs: {
      description: {
        component:
          "A rarity, as a 6px gem — and, for anyone who cannot see it, as a word. Never a " +
          "filled badge: the direction's colour budget is spent on mana and card art, and a " +
          "mythic-orange pill would out-shout the art it annotates. Only the four rarities " +
          "with tokens of their own are tinted; `special`, `bonus` and a null rarity fall " +
          "back to the hairline colour, which is fine under 6px of dot and about 1.9:1 as a " +
          "word — so those keep dim text.",
      },
    },
  },
} satisfies Meta<typeof RarityGem>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Common: Story = { args: { rarity: "common" } };
export const Uncommon: Story = { args: { rarity: "uncommon" } };
export const Rare: Story = { args: { rarity: "rare" } };
export const Mythic: Story = { args: { rarity: "mythic" } };

/** `special` and `bonus` are real Scryfall values with no colour token of their own — the gem
 *  wears the fallback and the word deliberately does not. */
export const Special: Story = { args: { rarity: "special" } };
export const Bonus: Story = { args: { rarity: "bonus" } };

/** `cards.rarity` is nullable, so the component has to answer for a printing that states
 *  none. It prints the word "unknown" rather than an empty space beside a grey dot. */
export const Unknown: Story = { args: { rarity: null } };

/**
 * The tiles' shape: the gem alone, with the word still present as the accessible name.
 *
 * This is the story that made the component — three of its four call sites had grown their
 * own `sr-only` label or their own `title`, because a 6px dot is colour-only information and
 * a colour is not information anyone can be required to see. Nothing visible is drawn but the
 * dot, which is why the claim is asserted rather than left to a reader looking at a canvas
 * with one grey pixel-cluster on it.
 */
export const GemOnly: Story = {
  args: { rarity: "mythic", withLabel: false },
  play: async ({ canvasElement }) => {
    const word = within(canvasElement).getByText("mythic");
    await expect(word).toHaveClass("sr-only");
    // "Rarity: mythic", not a bare "mythic" dropped into the middle of a row of card facts.
    await expect(canvasElement).toHaveTextContent("Rarity: mythic");
  },
};
