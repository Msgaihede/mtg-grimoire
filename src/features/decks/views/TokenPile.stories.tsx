import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JSX } from "react";
import { expect, within } from "storybook/test";
import { useAppStore } from "@/lib/store";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import { tokenCountWords } from "../TokenCountPill";
import { useDeckTokens } from "../useDeckTokens";
import {
  TOKEN_PILE_ATTR,
  TokenGridPile,
  TokenStackPile,
  TokenTablePile,
  TokenTextPile,
  type TokenPile,
} from "./TokenPile";

type Drawing = "stack" | "grid" | "text" | "table";

interface PileHostProps {
  /** Which view's drawing of the pile — the four views each place one of these. */
  drawing: Drawing;
  deckId: number;
}

/**
 * The pile as a view is handed it: **one `useDeckTokens` answer**, the same one the band draws,
 * driven end to end by `.storybook/fake/` rather than by a hand-built list. The art press logs
 * nothing here — the picker is the editor's, mounted once beside the band.
 */
function PileHost({ drawing, deckId }: PileHostProps): JSX.Element {
  const tokens = useDeckTokens(deckId, "live");
  const zoom = useAppStore((s) => s.cardZoom.deck);
  const pile: TokenPile = {
    tokens: tokens.tokens,
    setQuantity: tokens.setQuantity,
    pickArt: () => {},
  };
  if (pile.tokens.length === 0) return <p className="text-xs text-dim">Loading tokens…</p>;
  switch (drawing) {
    case "stack":
      // The rail's own width, which is the box the pile is drawn in on the desk.
      return (
        <div style={{ width: 224 }}>
          <TokenStackPile pile={pile} zoom={zoom} />
        </div>
      );
    case "grid":
      return <TokenGridPile pile={pile} zoom={zoom} tileWidth={Math.round(150 * zoom)} gap={10} />;
    case "text":
      return (
        <div style={{ width: "18.75rem" }}>
          <TokenTextPile pile={pile} />
        </div>
      );
    case "table":
      return <TokenTablePile pile={pile} />;
  }
}

const meta = {
  title: "Decks/Views/TokenPile",
  component: PileHost,
  tags: ["autodocs"],
  args: { drawing: "stack", deckId: 1 },
  argTypes: { drawing: { control: "inline-radio", options: ["stack", "grid", "text", "table"] } },
  parameters: {
    docs: {
      description: {
        component:
          "The deck's tokens and emblems drawn as a pile inside the four deck views (issue #507) — " +
          "the same answer the band draws, never a deck row and never counted.",
      },
    },
  },
} satisfies Meta<typeof PileHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Shared by every drawing: a group named by the heading, with the distinct-token pill. */
async function isThePile(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const pile = await canvas.findByRole("group", { name: TOKENS_HEADING });
  await expect(pile).toHaveAttribute(TOKEN_PILE_ATTR);
  const buttons = within(pile).getAllByRole("button", { name: /^Change the art for / });
  await expect(within(pile).getByText(tokenCountWords(buttons.length))).toBeInTheDocument();
}

export const Stacks: Story = {
  play: async ({ canvasElement }) => isThePile(canvasElement),
};

export const Grid: Story = {
  args: { drawing: "grid" },
  play: async ({ canvasElement }) => isThePile(canvasElement),
};

export const Text: Story = {
  args: { drawing: "text" },
  play: async ({ canvasElement }) => isThePile(canvasElement),
};

export const Table: Story = {
  args: { drawing: "table" },
  play: async ({ canvasElement }) => isThePile(canvasElement),
};
