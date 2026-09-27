import type { Meta, StoryObj } from "@storybook/react-vite";
import type { JSX } from "react";
import { expect, within } from "storybook/test";
import { useAppStore } from "@/lib/store";
import { THEORY_MATCH_ATTR } from "../CardMarks";
import { tokenCountWords } from "../CountPill";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import { pileTokens, type DeckTokenView } from "../deckTokens";
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
   * Hand the pile a plan's marks — the first entry the plan makes exactly, every other one an
   * entry the plan does not make — so the two marks a token can wear are on one screen. The
   * editor's real answer is `tokenTheory.ts`' over the deck's theory list; this story is about
   * the drawing, so it answers by position, and by **entry** rather than by token, since one
   * token can be two cards here.
   */
  planMarks?: boolean;
}

const EXACT: TheoryMark = { tier: "exact", delta: 0, anyPrinting: false };
const UNPLANNED: TheoryMark = { tier: "unplanned", delta: 0, anyPrinting: false };

/**
 * The pile as a view is handed it: **one `useDeckTokens` answer**, the same one the band draws,
 * driven end to end by `.storybook/fake/` rather than by a hand-built list — so every token
 * carries the fake's own set code, number, rarity, finishes and price for its printing, and the
 * chin and the heading's total are the fake's figures rather than a story's. One card per
 * **entry** — the fake's per-entry rows, so a token held in two printings or two finishes is two
 * cards — and **only the counted ones**: `pileTokens`, the filter `DeckEditor` applies to the
 * pile and nowhere else (managed tokens spec §3.2). The press logs nothing here — the printing
 * picker is the editor's, mounted once beside the band — while the steppers and Remove printing
 * write through the fake like the band's.
 */
function PileHost({ drawing, deckId, planMarks = false }: PileHostProps): JSX.Element {
  const tokens = useDeckTokens(deckId, "live");
  const zoom = useAppStore((s) => s.cardZoom.deck);
  const counted = pileTokens(tokens.tokens);
  const first = counted[0]?.entryKey;
  const pile: TokenPile = {
    tokens: counted,
    setQuantity: tokens.setQuantity,
    remove: tokens.remove,
    pickArt: () => {},
    // Last in the rail, every existing deck's position — where the pile is drawn is the view's.
    railIndex: -1,
    theoryMark: planMarks
      ? (view: DeckTokenView) => (view.entryKey === first ? EXACT : UNPLANNED)
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
 * **The pile draws the counted tokens only** (managed tokens spec §3.2): deck 1 makes five tokens
 * and the reader has counted one, the Treasure — so one card, where the band beside it lists all
 * five at their counts.
 */
export const CountedOnly: Story = {
  play: async ({ canvasElement }) => {
    const pile = await isThePile(canvasElement);
    await expect(
      within(pile).getAllByRole("button", { name: /^Change the art for / }).map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual([expect.stringMatching(/^Change the art for Treasure/)]);
  },
};

/**
 * **A token nothing in the deck makes, marked as a rule-break card is** (managed tokens spec §3.5)
 * — deck 2 keeps Oko's emblem by hand: the card's own edge and its chin in the destructive colour,
 * and `NOT MADE BY DECK` in the rule-break mark's bottom-left corner. **Remove printing** stands in
 * the controls column under the stepper, the one way to take it off the deck.
 */
export const HandAdded: Story = {
  args: { deckId: 2 },
  play: async ({ canvasElement }) => {
    const pile = await isThePile(canvasElement);
    const art = within(pile).getByRole("button", { name: /^Change the art for Oko.*, not made by deck$/ });
    const card = art.closest("li") as HTMLElement;
    await expect(card.classList.contains("border-destructive")).toBe(true);
    await expect(within(card).getByText("NOT MADE BY DECK")).toHaveAttribute("aria-hidden", "true");
    await expect(within(card).getByRole("button", { name: /^Remove Oko/ })).toBeInTheDocument();
  },
};

/** The same token on the compact drawings: the words as a small destructive tag after the name. */
export const HandAddedTable: Story = {
  args: { deckId: 2, drawing: "table" },
  play: async ({ canvasElement }) => {
    const pile = await isThePile(canvasElement);
    await expect(within(pile).getByText("NOT MADE BY DECK")).toBeInTheDocument();
  },
};

/**
 * The plan's two answers for a token, side by side: the tick the deck card wears where the plan
 * makes this token in this printing, and the X where it does not — the same `TheoryMatchMark`, in
 * the same top-right corner, as on every deck card beside the pile. On the `tokenPlan` seed, where
 * deck 1 counts two tokens — two cards are what the two marks need.
 */
export const WithPlanMarks: Story = {
  args: { planMarks: true },
  parameters: { fake: { seed: "tokenPlan" } },
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
