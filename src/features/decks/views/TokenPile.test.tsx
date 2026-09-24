import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { DEFAULT_ZOOM } from "@/lib/cardZoom";
import { STACK_LIFTED_MARGIN, STACK_OPEN_ATTR, stackAdvance } from "../CardStack";
import { CARD_BODY_ATTR, DECK_GROUP_ATTR } from "../cardControl";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import type { DeckTokenView } from "../deckTokens";
import { DECK_CARD_ATTR } from "../dnd";
import { TokenCountPill, tokenCountWords } from "../TokenCountPill";
import {
  TOKEN_PILE_ATTR,
  tokenControlName,
  tokenMadeBy,
  TokenGridPile,
  TokenStackPile,
  tokenStackCardHeight,
  tokenStackHeight,
  TokenTablePile,
  TokenTextPile,
  type TokenPile,
} from "./TokenPile";

afterEach(cleanup);

function token(over: Partial<DeckTokenView> = {}): DeckTokenView {
  return {
    oracleId: "o-treasure",
    name: "Treasure",
    typeLine: "Token Artifact — Treasure",
    layout: "token",
    printingId: "p-treasure",
    quantity: 1,
    sources: [{ cardId: "c-smothering-tithe", name: "Smothering Tithe" }],
    derived: true,
    state: "auto",
    overridden: false,
    subtitle: "Colorless · {T}, Sacrifice this token: Add one mana of any color.",
    imageUrl: null,
    ...over,
  };
}

/** `Wurmcoil Engine`'s pair — one name, one size, one colour, told apart only by the text. */
const WURMS: DeckTokenView[] = [
  token({
    oracleId: "o-wurm-deathtouch",
    name: "Wurm",
    subtitle: "Colorless 3/3 · Deathtouch",
    sources: [{ cardId: "c-wurmcoil", name: "Wurmcoil Engine" }],
  }),
  token({
    oracleId: "o-wurm-lifelink",
    name: "Wurm",
    subtitle: "Colorless 3/3 · Lifelink",
    sources: [{ cardId: "c-wurmcoil", name: "Wurmcoil Engine" }],
  }),
];

function pileOf(tokens: readonly DeckTokenView[]): TokenPile {
  return { tokens, setQuantity: vi.fn(), pickArt: vi.fn() };
}

const DRAWINGS = [
  { name: "stack", draw: (pile: TokenPile) => <TokenStackPile pile={pile} zoom={DEFAULT_ZOOM} /> },
  {
    name: "grid",
    draw: (pile: TokenPile) => (
      <TokenGridPile pile={pile} zoom={DEFAULT_ZOOM} tileWidth={150} gap={10} />
    ),
  },
  { name: "text", draw: (pile: TokenPile) => <TokenTextPile pile={pile} /> },
  { name: "table", draw: (pile: TokenPile) => <TokenTablePile pile={pile} /> },
] as const;

describe("tokenControlName", () => {
  it("folds the subtitle in, so two same-named tokens are two names", () => {
    const [a, b] = WURMS;
    expect(tokenControlName("Change the art for", a)).toBe(
      "Change the art for Wurm, Colorless 3/3 · Deathtouch",
    );
    expect(tokenControlName("Change the art for", a)).not.toBe(
      tokenControlName("Change the art for", b),
    );
  });

  it("says the bare name where there is no subtitle, an emblem's case", () => {
    expect(tokenControlName("Quantity of", token({ name: "Emblem", subtitle: null }))).toBe(
      "Quantity of Emblem",
    );
  });
});

describe("tokenMadeBy", () => {
  it("names the deck cards that make it, or the reader's own press", () => {
    expect(tokenMadeBy(token())).toBe("From Smothering Tithe");
    expect(tokenMadeBy(token({ sources: [] }))).toBe("Added by hand");
  });
});

describe("TokenCountPill", () => {
  it("draws the bare number and says the phrase to a screen reader", () => {
    const { container } = render(<TokenCountPill count={3} />);
    const pill = container.firstElementChild as HTMLElement;
    expect(pill).toHaveTextContent("3");
    // The digits are hidden, and the words are one element — never assembled from two.
    expect(within(pill).getByText("3", { exact: true })).toHaveAttribute("aria-hidden", "true");
    expect(within(pill).getByText("3 tokens and emblems to bring")).toHaveClass("sr-only");
  });

  it("says the singular properly", () => {
    expect(tokenCountWords(1)).toBe("1 token or emblem to bring");
    expect(tokenCountWords(2)).toBe("2 tokens and emblems to bring");
  });
});

describe("the stack's geometry", () => {
  it("is a function of the count and the zoom, and a token card is its 5:7 picture", () => {
    expect(tokenStackCardHeight(1)).toBe(294);
    expect(tokenStackHeight(0, 1)).toBe(0);
    expect(tokenStackHeight(3, 1)).toBe(stackAdvance(1) * 2 + 294 + STACK_LIFTED_MARGIN);
  });
});

describe.each(DRAWINGS)("the $name drawing", ({ draw }) => {
  const setup = (tokens: readonly DeckTokenView[] = [token(), ...WURMS]) => {
    const pile = pileOf(tokens);
    const view = render(<TooltipProvider>{draw(pile)}</TooltipProvider>);
    return { pile, view };
  };

  it("is a group named by the heading, marked as the pile, with the pill beside it", () => {
    const { view } = setup();
    const root = screen.getByRole("group", { name: TOKENS_HEADING });
    expect(root).toHaveAttribute(TOKEN_PILE_ATTR);
    expect(view.container.querySelectorAll(`[${TOKEN_PILE_ATTR}]`)).toHaveLength(1);
    expect(within(root).getByText("3 tokens and emblems to bring")).toBeInTheDocument();
  });

  it("opens the art picker on the token that was pressed", () => {
    const { pile } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: tokenControlName("Change the art for", WURMS[1]) }),
    );
    expect(pile.pickArt).toHaveBeenCalledWith("o-wurm-lifelink");
  });

  it("steps a token's copies, down to zero", () => {
    const { pile } = setup([token({ quantity: 1 })]);
    const name = tokenControlName("Quantity of", token());
    fireEvent.click(screen.getByRole("button", { name: `Increase ${name}` }));
    expect(pile.setQuantity).toHaveBeenLastCalledWith("o-treasure", 2);
    fireEvent.click(screen.getByRole("button", { name: `Decrease ${name}` }));
    expect(pile.setQuantity).toHaveBeenLastCalledWith("o-treasure", 0);
  });

  it("gives two same-named tokens two different names", () => {
    setup();
    const names = screen
      .getAllByRole("button", { name: /^Change the art for Wurm/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  it("is no deck card: no slot, no body, no pile a card can be filed into", () => {
    const { view } = setup();
    for (const attr of [DECK_CARD_ATTR, CARD_BODY_ATTR, DECK_GROUP_ATTR]) {
      expect(view.container.querySelector(`[${attr}]`)).toBeNull();
    }
    // No card is counted here: the only figure is the pill's.
    expect(within(view.container).queryByText(/\bcards?\b/)).toBeNull();
  });
});

describe("TokenStackPile", () => {
  it("opens the card the caret lands on, and only that one", () => {
    const { container } = render(
      <TooltipProvider>
        <TokenStackPile pile={pileOf([token(), ...WURMS])} zoom={DEFAULT_ZOOM} />
      </TooltipProvider>,
    );
    expect(container.querySelectorAll(`[${STACK_OPEN_ATTR}]`)).toHaveLength(0);
    fireEvent.focus(
      screen.getByRole("button", { name: tokenControlName("Change the art for", WURMS[0]) }),
    );
    const open = container.querySelectorAll(`[${STACK_OPEN_ATTR}]`);
    expect(open).toHaveLength(1);
  });

  it("sizes its list from the count alone", () => {
    render(
      <TooltipProvider>
        <TokenStackPile pile={pileOf([token(), ...WURMS])} zoom={DEFAULT_ZOOM} />
      </TooltipProvider>,
    );
    const list = screen.getByRole("list", { name: TOKENS_HEADING });
    expect(list.style.height).toBe(`${tokenStackHeight(3, DEFAULT_ZOOM)}px`);
  });
});
