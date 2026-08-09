import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { ManaText } from "./ManaText";

const meta = {
  title: "Primitives/ManaText",
  component: ManaText,
  // Autodocs, on every meta in this project rather than globally in `preview.tsx`: the
  // `docs.description` blocks below are the component's documentation, and without this tag
  // Storybook builds no page to put them on. Per-meta because turning it on in the preview
  // would also turn it on for every story file written after this one, sight unseen.
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component:
          "Scryfall mana notation as glyphs from the bundled `mana-font`. The trailing " +
          "space after each symbol is load-bearing: without it `{2}{U}` reaches a screen " +
          'reader as "2U", one word it will try to pronounce.',
      },
    },
  },
} satisfies Meta<typeof ManaText>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Generic: Story = { args: { source: "{2}{U}" } };

/** A hybrid half is one glyph and not two — `{R/W}{R/W}` is Boros Guildmage's printed cost. */
export const Hybrid: Story = { args: { source: "{R/W}{R/W}" } };

/** Gitaxian Probe's whole cost. Phyrexian mana is a colour with a life payment attached, and
 *  the font draws the pair as the single symbol the card prints. */
export const Phyrexian: Story = { args: { source: "{U/P}" } };

export const VariableCost: Story = { args: { source: "{X}{B}{B}" } };

export const Colourless: Story = { args: { source: "{C}{C}" } };

/** Snow is a restriction on the *source*, not a colour, and it is one symbol: Arcum's
 *  Astrolabe and Icehide Golem both cost exactly `{S}`. */
export const Snow: Story = { args: { source: "{S}" } };

/**
 * A token this version of the font has no glyph for stays visible in braces — at worst a
 * cost the reader has to decode, never a symbol that silently vanishes.
 *
 * This is Kozilek, Compleated's real cost, and `{C/P}` is the most common of the **six**
 * tokens in the entire corpus that `mana-font@1.18` cannot draw: `{C/P}` (5 printings),
 * `{D}` (4), `{HR}` (2), `{L}`, `{HW}` and `{H}` — measured 2026-08-09 over
 * `mana_cost` **and** `oracle_text` on all 116,694 rows of the live `cards` table, of which
 * 74 distinct tokens appear in total. `{W/U/P}` is *not* one of them, so a story built on
 * that would draw a perfectly good glyph while claiming to show the fallback.
 */
export const UnknownToken: Story = {
  args: { source: "{8}{C/P}{C/P}" },
  play: async ({ canvasElement }) => {
    // Drawn and undrawn side by side, which is the whole point of the cost being mixed: one
    // `<i>` for the `{8}`, and the two the font cannot draw left as their own text.
    await expect(canvasElement.querySelectorAll("i")).toHaveLength(1);
    await expect(canvasElement).toHaveTextContent("{C/P}{C/P}");
  },
};

/**
 * `null` renders nothing at all — not an empty wrapper — so callers may place this
 * unconditionally beside a card that has no printed cost.
 *
 * A story with no visible output needs its claim asserted or it is indistinguishable from a
 * story that failed to render, which is what the `play` is for.
 */
export const Nothing: Story = {
  args: { source: null },
  play: async ({ canvasElement }) => {
    await expect(canvasElement).toBeEmptyDOMElement();
  },
};

/** One parse serves costs and rules text alike, because Magic makes no distinction: the prose
 *  between the symbols survives, and so does a symbol the parser did not recognise. */
export const InOracleText: Story = {
  args: { source: "Add {G}. Spend this mana only to cast creature spells." },
};
