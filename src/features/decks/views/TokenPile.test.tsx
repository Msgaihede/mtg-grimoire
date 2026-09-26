import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { DEFAULT_ZOOM } from "@/lib/cardZoom";

// `useMarketplace` is the real hook — the pile reads it for the heading's total and every chin's
// price — so its two queries need answers or they sit rejected for the life of the file.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { getMarketplace, marketplaceFeedStatus },
}));

import { THEORY_MATCH_ATTR, theoryMatchLabel } from "../CardMarks";
import { STACK_OPEN_ATTR, stackHeight } from "../CardStack";
import { CARD_BODY_ATTR, DECK_GROUP_ATTR } from "../cardControl";
import { tokenCountWords } from "../CountPill";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import type { DeckTokenView } from "../deckTokens";
import { DECK_CARD_ATTR } from "../dnd";
import {
  TOKEN_PILE_ATTR,
  tokenControlName,
  tokenFaceFacts,
  tokenMadeBy,
  TokenGridPile,
  tokenPileHeading,
  TokenStackPile,
  TokenTablePile,
  TokenTextPile,
  type TokenPile,
} from "./TokenPile";

afterEach(cleanup);

beforeEach(() => {
  getMarketplace.mockReset().mockResolvedValue("tcgplayer");
  marketplaceFeedStatus.mockReset().mockResolvedValue([]);
});

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
    imageUris: null,
    setCode: "tclb",
    collectorNumber: "5",
    setName: "Commander Legends",
    rarity: "common",
    finishes: '["nonfoil"]',
    unitPrice: 0.25,
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
  return { tokens, setQuantity: vi.fn(), pickArt: vi.fn(), railIndex: -1 };
}

/** The two providers every drawing needs: the query client `useMarketplace` reads through, and
 *  the tooltip root the chin's set name and the heading's as-of sentence bind to. */
function renderWith(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>,
  );
}

/**
 * The heading `GroupHeader` draws over a pile — the nearest box holding both the pile's name and
 * its count pill, which is the box the price is drawn in — and never the cards under it, so a
 * figure asserted here cannot be a chin's.
 *
 * Climbed to rather than addressed by position or by class, so it survives `GroupHeader`
 * rearranging its own rows.
 */
function headingOf(group: HTMLElement): HTMLElement {
  const name = within(group).getByText(TOKENS_HEADING);
  const pill = within(group).getByText(/^\d+ tokens? (?:or|and) emblems?$/);
  let heading = name.parentElement;
  while (heading !== null && !heading.contains(pill)) heading = heading.parentElement;
  if (heading === null) throw new Error("no heading holds both the name and the pill");
  expect(heading).not.toContainElement(within(group).getByRole("list", { name: TOKENS_HEADING }));
  return heading;
}

function renderStack(pile: TokenPile) {
  return renderWith(<TokenStackPile pile={pile} zoom={DEFAULT_ZOOM} />);
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

describe("tokenFaceFacts", () => {
  it("is the token as the deck card face reads one — no cost, no label, no crown, no review", () => {
    expect(tokenFaceFacts(token({ quantity: 3, printingId: "p-gold" }))).toEqual({
      cardId: "p-gold",
      needsReview: null,
      imageUris: null,
      // "Not said": `playedFinish` then falls to the printing's sole finish, as for a deck card.
      finish: null,
      finishes: '["nonfoil"]',
      name: "Treasure",
      manaCost: null,
      typeLine: "Token Artifact — Treasure",
      quantity: 3,
      labelName: null,
      labelColor: null,
      gameChanger: false,
    });
  });
});

describe("tokenPileHeading", () => {
  it("counts copies and sums only the priced tokens — grouping.ts' totals rule", () => {
    const heading = tokenPileHeading([
      token({ quantity: 3 }),
      token({ oracleId: "o-soldier", quantity: 2, unitPrice: null }),
    ]);
    expect(heading).toEqual({
      name: TOKENS_HEADING,
      count: 5,
      totalPrice: 0.75,
      isActive: true,
      kind: null,
    });
  });

  it("is null — not zero — when no token is priced", () => {
    expect(tokenPileHeading([token({ unitPrice: null })]).totalPrice).toBeNull();
  });

  it("counts a zeroed token's price as priced, the way a zero-copy deck row is", () => {
    // A reader who stepped a token to 0 kept it on the wall; its printing is still priced, so the
    // pile is priced at 0 rather than unpriced — exactly `totals`' answer for the same row.
    expect(tokenPileHeading([token({ quantity: 0 })]).totalPrice).toBe(0);
  });
});

describe.each(DRAWINGS)("the $name drawing", ({ draw }) => {
  const setup = (tokens: readonly DeckTokenView[] = [token(), ...WURMS]) => {
    const pile = pileOf(tokens);
    const view = renderWith(draw(pile));
    return { pile, view };
  };

  it("is a group named by the heading, marked as the pile, with the copies and the total", () => {
    const { view } = setup();
    const root = screen.getByRole("group", { name: TOKENS_HEADING });
    expect(root).toHaveAttribute(TOKEN_PILE_ATTR);
    expect(view.container.querySelectorAll(`[${TOKEN_PILE_ATTR}]`)).toHaveLength(1);
    expect(within(root).getByText(tokenCountWords(3))).toHaveClass("sr-only");
    // Three tokens at $0.25 each — summed in the pile's own heading and nowhere else.
    expect(within(root).getByText("$0.75")).toBeInTheDocument();
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
    // No card is counted here: the heading's words are tokens and emblems, never cards.
    expect(within(view.container).queryByText(/\bcards?\b/)).toBeNull();
  });
});

describe("TokenStackPile", () => {
  it("heads the pile with GroupHeader: the name, the copies and the priced total", () => {
    renderStack(
      pileOf([
        token({ quantity: 3 }),
        token({ oracleId: "o-soldier", name: "Soldier", quantity: 2, unitPrice: null }),
      ]),
    );
    const group = screen.getByRole("group", { name: TOKENS_HEADING });
    expect(within(group).getByText("5 tokens and emblems")).toHaveClass("sr-only");
    expect(within(group).getByText("$0.75")).toBeInTheDocument(); // 3 × 0.25; the unpriced Soldier adds nothing
  });

  it("shows an em dash for a pile no printing of which is priced", () => {
    renderStack(pileOf([token({ unitPrice: null })]));
    // **In the heading, and only there.** The unpriced token's own chin draws an em dash too, so a
    // query over the whole pile passes over a heading that says `$0.00` — which is the bug this
    // test is named for.
    const heading = headingOf(screen.getByRole("group", { name: TOKENS_HEADING }));
    expect(within(heading).getByText("—")).toBeInTheDocument();
  });

  it("draws each token as a deck card face with the quantity tag and a chin", () => {
    renderStack(pileOf([token({ quantity: 4 })]));
    const card = screen.getByRole("button", { name: /^Change the art for Treasure/ }).closest("li")!;
    expect(within(card).getByText("TCLB · 5")).toBeInTheDocument(); // the chin
    // `QuantityTag` forwards to `CountTag`, which is `aria-hidden` and carries its number as text —
    // `CardStack.test.tsx`'s own way of finding it (~L1144).
    const tag = within(card).getByText("4");
    expect(tag).toHaveAttribute("aria-hidden", "true");
  });

  it("wears the plan's mark when the pile is given one", () => {
    renderStack({ ...pileOf([token()]), theoryMark: () => ({ tier: "exact", delta: 0 }) });
    expect(document.querySelector(`[${THEORY_MATCH_ATTR}]`)).not.toBeNull();
  });

  it("says the plan's mark in the art press's own name, since the mark itself is aria-hidden", () => {
    renderStack({ ...pileOf([token()]), theoryMark: () => ({ tier: "exact", delta: 0 }) });
    const press = screen.getByRole("button", { name: /^Change the art for Treasure/ });
    expect(press).toHaveAccessibleName(
      `${tokenControlName("Change the art for", token())}, ${theoryMatchLabel("exact", 0).toLowerCase()}`,
    );
  });

  it("wears no mark at all when the pile is given none", () => {
    renderStack(pileOf([token()]));
    expect(document.querySelector(`[${THEORY_MATCH_ATTR}]`)).toBeNull();
  });

  it("is exactly the deck stack's height for the same count", () => {
    renderStack(pileOf([token(), token({ oracleId: "o2" }), token({ oracleId: "o3" })]));
    const list = screen.getByRole("list", { name: TOKENS_HEADING });
    expect(list).toHaveStyle({ height: `${stackHeight(3, DEFAULT_ZOOM)}px` });
  });

  it("opens the card the caret lands on, and only that one", () => {
    const { container } = renderStack(pileOf([token(), ...WURMS]));
    expect(container.querySelectorAll(`[${STACK_OPEN_ATTR}]`)).toHaveLength(0);
    fireEvent.focus(
      screen.getByRole("button", { name: tokenControlName("Change the art for", WURMS[0]) }),
    );
    const open = container.querySelectorAll(`[${STACK_OPEN_ATTR}]`);
    expect(open).toHaveLength(1);
  });

  it("draws the caller's grip in the heading, and hands the heading's wrapper to sourceRef", () => {
    const sourceRef = vi.fn();
    renderWith(
      <TokenStackPile
        pile={pileOf([token()])}
        zoom={DEFAULT_ZOOM}
        handle={<button type="button">Move {TOKENS_HEADING}</button>}
        sourceRef={sourceRef}
      />,
    );
    const group = screen.getByRole("group", { name: TOKENS_HEADING });
    const grip = within(group).getByRole("button", { name: `Move ${TOKENS_HEADING}` });
    // The element a category's `attachSource` goes on: the heading's wrapper, which holds the grip
    // and the name — and not the card list, which is no drag source.
    const source = sourceRef.mock.calls.find(([node]) => node !== null)?.[0] as HTMLElement;
    expect(source).toBeInstanceOf(HTMLElement);
    expect(source).toContainElement(grip);
    expect(source).toContainElement(within(group).getByText(TOKENS_HEADING));
    expect(source).not.toContainElement(screen.getByRole("list", { name: TOKENS_HEADING }));
  });
});

describe("TokenGridPile", () => {
  it("draws each token as the deck's face with its chin, at the wall's own tile width", () => {
    renderWith(
      <TokenGridPile pile={pileOf([token({ quantity: 2 })])} zoom={DEFAULT_ZOOM} tileWidth={150} gap={10} />,
    );
    const tile = screen.getByRole("button", { name: /^Change the art for Treasure/ }).closest("li")!;
    expect(tile).toHaveStyle({ width: "150px" });
    expect(within(tile).getByText("TCLB · 5")).toBeInTheDocument();
    expect(within(tile).getByText("$0.25")).toBeInTheDocument();
    expect(within(tile).getByText("2")).toHaveAttribute("aria-hidden", "true");
  });
});
