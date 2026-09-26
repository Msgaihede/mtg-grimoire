import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JSX } from "react";
import { expect, within } from "storybook/test";
import { useAppStore } from "@/lib/store";
import { THEORY_MATCH_ATTR } from "../CardMarks";
import { tokenCountWords } from "../CountPill";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import type { DeckTokenView } from "../deckTokens";
import type { TheoryMark } from "../theoryMatch";
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
  /**
   * Hand the pile a plan's marks — the first token the plan makes exactly, every other one a
   * token the plan does not make — so the two marks a token can wear are on one screen. The
   * editor's real answer is `tokenTheory.ts`' over the deck's theory list; this story is about
   * the drawing, so it answers by position.
   */
  planMarks?: boolean;
}

const EXACT: TheoryMark = { tier: "exact", delta: 0 };
const UNPLANNED: TheoryMark = { tier: "unplanned", delta: 0 };

/**
 * The pile as a view is handed it: **one `useDeckTokens` answer**, the same one the band draws,
 * driven end to end by `.storybook/fake/` rather than by a hand-built list — so every token
 * carries the fake's own set code, number, rarity, finishes and price for its printing, and the
 * chin and the heading's total are the fake's figures rather than a story's. The art press logs
 * nothing here — the picker is the editor's, mounted once beside the band.
 */
function PileHost({ drawing, deckId, planMarks = false }: PileHostProps): JSX.Element {
  const tokens = useDeckTokens(deckId, "live");
  const zoom = useAppStore((s) => s.cardZoom.deck);
  const first = tokens.tokens[0]?.oracleId;
  const pile: TokenPile = {
    tokens: tokens.tokens,
    setQuantity: tokens.setQuantity,
    pickArt: () => {},
    // Last in the rail, every existing deck's position — where the pile is drawn is the view's.
    railIndex: -1,
    theoryMark: planMarks
      ? (view: DeckTokenView) => (view.oracleId === first ? EXACT : UNPLANNED)
      : undefined,
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
          "The deck's tokens and emblems drawn as a pile inside the four deck views (issue #507), " +
          "on the deck's own parts — `GroupHeader` over it, `DeckCardFace` and `CardChin` for each " +
          "card — and still never a deck row: its copies and price are its own heading's alone.",
      },
    },
  },
} satisfies Meta<typeof PileHost>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Shared by every drawing: a group named by the heading, with the **copies** in the pill — read
 * back off the steppers, so the play asks the same question the heading answers rather than
 * re-deriving the fake's quantities.
 */
async function isThePile(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  const pile = await canvas.findByRole("group", { name: TOKENS_HEADING });
  await expect(pile).toHaveAttribute(TOKEN_PILE_ATTR);
  const copies = within(pile)
    .getAllByRole("spinbutton", { name: /^Quantity of / })
    .reduce((sum, box) => sum + Number((box as HTMLInputElement).value), 0);
  await expect(within(pile).getByText(tokenCountWords(copies))).toBeInTheDocument();
  return pile;
}

export const Stacks: Story = {
  play: async ({ canvasElement }) => {
    const pile = await isThePile(canvasElement);
    // No plan was handed over, so no token wears a mark — never a wall of ✗.
    await expect(pile.querySelector(`[${THEORY_MATCH_ATTR}]`)).toBeNull();
  },
};

export const Grid: Story = {
  args: { drawing: "grid" },
  play: async ({ canvasElement }) => {
    await isThePile(canvasElement);
  },
};

export const Text: Story = {
  args: { drawing: "text" },
  play: async ({ canvasElement }) => {
    await isThePile(canvasElement);
  },
};

export const Table: Story = {
  args: { drawing: "table" },
  play: async ({ canvasElement }) => {
    await isThePile(canvasElement);
  },
};

/**
 * The plan's two answers for a token, side by side: the tick the deck card wears where the plan
 * makes this token in this printing, and the X where it does not — the same `TheoryMatchMark`, in
 * the same top-right corner, as on every deck card beside the pile.
 */
export const WithPlanMarks: Story = {
  args: { planMarks: true },
  play: async ({ canvasElement }) => {
    const pile = await isThePile(canvasElement);
    const presses = within(pile).getAllByRole("button", { name: /^Change the art for / });
    // Two marks need two tokens; fewer would make the unplanned half vacuous.
    await expect(presses.length).toBeGreaterThan(1);
    await expect(pile.querySelectorAll(`[${THEORY_MATCH_ATTR}="exact"]`)).toHaveLength(1);
    await expect(pile.querySelectorAll(`[${THEORY_MATCH_ATTR}="unplanned"]`)).toHaveLength(
      presses.length - 1,
    );
  },
};
