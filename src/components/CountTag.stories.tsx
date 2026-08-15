import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { CountTag } from "./CountTag";

const meta = {
  title: "Primitives/CountTag",
  component: CountTag,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "A number laid on a card, as a filled banner cut off at a slant — the deck stack's " +
          "drawing of “there are N of these in this pile”.\n\n" +
          "**It had two callers for a day and has one again** (2026-08-15). The search wall's " +
          "printing count was the second, so that a mark the eye finds before it reads the card " +
          "would be one object on both surfaces — and what the shared shape cost was the *word*: " +
          "a bare `132` on a search tile is a quantity of nothing in particular. The wall says " +
          "`132 printings` in its tile's own corner chip now, and this is the deck stack's " +
          "shape again, where a bare number is honest because the tag it is printed on says " +
          "what is being counted.\n\n" +
          "**The number alone, never `×N`.** A banner in a card's corner already says “this " +
          "many”; the sign is a second glyph in a 22px box spending the room the digits need. " +
          "`OwnedBadge` keeps its `×`, because that one is inline text in a caption where the " +
          "sign is what tells a count from a set number.\n\n" +
          "It is `aria-hidden`, so the `title` is the whole of what a pointer user gets and the " +
          "words belong to whatever names the card.",
      },
    },
  },
} satisfies Meta<typeof CountTag>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default fill, and the one an **untagged** deck card draws: it has no tag to take a colour
 * from. Grey is the point — a filled mark has to be *some* colour, and if the neutral one were
 * gold then gold would stop meaning "there is a tag here".
 */
export const Neutral: Story = {
  args: { count: 132, title: "132 in this pile" },
  play: async ({ canvasElement }) => {
    const tag = canvasElement.querySelector<HTMLElement>("[title]");
    await expect(tag).toHaveAttribute("aria-hidden", "true");
    await expect(tag).toHaveTextContent("132");
    await expect(tag).not.toHaveTextContent("×");
    // The declaration rather than the computed value: this play also runs under jsdom
    // (`src/stories.test.tsx`), which has no stylesheet to resolve a custom property against.
    await expect(tag?.style.backgroundColor).toBe("var(--color-pie-c)");
  },
};

/**
 * The deck stack's shape, where the fill is the card's tag colour and the count is printed on
 * it — one object saying "three of these, and they are my ramp" in the 34px strip a collapsed
 * card reveals. `QuantityTag` in `features/decks/CardMarks.tsx` is what passes this.
 */
export const Painted: Story = {
  args: {
    count: 3,
    title: "Ramp · 3 in this pile",
    paint: { css: "var(--color-pie-g)", fg: "var(--color-text)" },
  },
};

/** `tabular-nums` and the slant's fixed 10px are why this is worth a story: three figures widen
 *  the banner without changing the angle of the cut, and nothing shifts under it. */
export const LargeCount: Story = {
  args: { count: 428, title: "428 in this pile" },
};
