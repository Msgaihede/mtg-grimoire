import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import { chinHeight, DEFAULT_ZOOM } from "@/lib/cardZoom";
import { tileKeyOf } from "@/lib/tileKey";

// `useMarketplace` is the real hook — the pile reads it for the heading's total and every chin's
// price — so its two queries need answers or they sit rejected for the life of the file.
const getMarketplace = vi.hoisted(() => vi.fn());
const marketplaceFeedStatus = vi.hoisted(() => vi.fn());
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { getMarketplace, marketplaceFeedStatus },
}));

import { THEORY_MATCH_ATTR, theoryMatchLabel, WordMark } from "../CardMarks";
import { deckCardScale, STACK_OPEN_ATTR, stackHeight } from "../CardStack";
import { CARD_BODY_ATTR, DECK_GROUP_ATTR } from "../cardControl";
import { tokenCountWords } from "../CountPill";
import { TOKENS_HEADING } from "../DeckTokensPanel";
import {
  entryRef,
  pileTokens,
  tokenArtName,
  tokenCardName,
  tokenEntryName,
  type DeckTokenView,
} from "../deckTokens";
import { DECK_CARD_ATTR } from "../dnd";
import {
  TOKEN_PILE_ATTR,
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

/**
 * One **entry** — a printing in one finish of one token (token stacks, spec §4). The `entryKey`
 * follows the printing and the finish unless a case names one, exactly as `deckTokens.ts` derives
 * it, so two entries of one token built here are two keys by construction.
 */
function token(over: Partial<DeckTokenView> = {}): DeckTokenView {
  const base: DeckTokenView = {
    oracleId: "o-treasure",
    name: "Treasure",
    typeLine: "Token Artifact — Treasure",
    layout: "token",
    printingId: "p-treasure",
    finish: "nonfoil",
    implicit: false,
    entryKey: "",
    quantity: 1,
    sources: [{ cardId: "c-smothering-tithe", name: "Smothering Tithe" }],
    derived: true,
    state: "auto",
    subtitle: "Colorless · {T}, Sacrifice this token: Add one mana of any color.",
    setCode: "tclb",
    collectorNumber: "5",
    setName: "Commander Legends",
    rarity: "common",
    finishes: '["nonfoil"]',
    unitPrice: 0.25,
    ...over,
  };
  return { ...base, entryKey: over.entryKey ?? tileKeyOf(base.printingId, base.finish) };
}

/** `Wurmcoil Engine`'s pair — one name, one size, one colour, told apart only by the text. Each
 *  has a printing of its own, as two tokens always do. */
const WURMS: DeckTokenView[] = [
  token({
    oracleId: "o-wurm-deathtouch",
    name: "Wurm",
    printingId: "p-wurm-deathtouch",
    subtitle: "Colorless 3/3 · Deathtouch",
    sources: [{ cardId: "c-wurmcoil", name: "Wurmcoil Engine" }],
  }),
  token({
    oracleId: "o-wurm-lifelink",
    name: "Wurm",
    printingId: "p-wurm-lifelink",
    subtitle: "Colorless 3/3 · Lifelink",
    sources: [{ cardId: "c-wurmcoil", name: "Wurmcoil Engine" }],
  }),
];

/**
 * **One token, two entries** — the regular copy of a printing sold in both finishes and the foil
 * one (spec §4.1: *a foil and a nonfoil copy of one printing are two entries*). One oracle id, one
 * name, one subtitle and one printing: the finish is all that tells them apart, so it is all that
 * can keep their keys and their names apart.
 */
const TWO_ENTRIES: DeckTokenView[] = [
  token({ finishes: '["nonfoil","foil"]', quantity: 2 }),
  token({ finishes: '["nonfoil","foil"]', finish: "foil", quantity: 1 }),
];

function pileOf(tokens: readonly DeckTokenView[]): TokenPile {
  return {
    tokens,
    setQuantity: vi.fn(),
    pickArt: vi.fn(),
    openCard: vi.fn(),
    remove: vi.fn(),
    railIndex: -1,
  };
}

/**
 * **A token nothing in the deck makes** — added by hand, so `derived: false` and no sources. The
 * mark is read off `derived` and never off `state` (managed tokens spec §3.5), so the state here
 * is the one a hand-added token has, and a derived `manual` one elsewhere must wear nothing.
 */
const HAND_ADDED = token({
  oracleId: "o-construct",
  name: "Construct",
  printingId: "p-construct",
  subtitle: "Colorless 4/4 · Flying, haste",
  sources: [],
  derived: false,
  state: "manual",
  quantity: 2,
});

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

describe("tokenEntryName", () => {
  it("folds the subtitle in, so two same-named tokens are two names", () => {
    const [a, b] = WURMS;
    expect(tokenEntryName("Change the art for", a)).toBe(
      "Change the art for Wurm, Colorless 3/3 · Deathtouch, TCLB · 5, Nonfoil",
    );
    expect(tokenEntryName("Change the art for", a)).not.toBe(
      tokenEntryName("Change the art for", b),
    );
  });

  /**
   * **And the entry, so two entries of one token are two names** (spec §4) — the printing and the
   * finish. Everything else about the pair is one token's, so without these two terms both
   * steppers would announce one name: the collection wall's shipped duplicate-name bug, reached
   * through a token.
   *
   * **One spelling for the band and the pile** — `<verb> <name>, <subtitle>, <SET · number>,
   * <Finish>`, `deckTokens.ts`' `tokenEntryName`, which both surfaces call — because one entry is
   * drawn on the band and in the pile at once and must not answer to two names on one screen. The
   * whole string is written out here rather than compared against the helper, so a change to the
   * shape is a change a test has to be told about.
   */
  it("names each entry by its printing and finish, exactly as the band's tile does", () => {
    const subtitle = "Colorless · {T}, Sacrifice this token: Add one mana of any color.";
    const secretLair = token({
      printingId: "p-sld",
      setCode: "sld",
      collectorNumber: "2820",
      finish: "foil",
      finishes: '["foil"]',
    });
    const commanderLegends = token({ printingId: "p-tclb", finish: "nonfoil" });
    const names = [secretLair, commanderLegends].map((view) =>
      tokenEntryName("Quantity of", view),
    );
    expect(names).toEqual([
      `Quantity of Treasure, ${subtitle}, SLD · 2820, Foil`,
      `Quantity of Treasure, ${subtitle}, TCLB · 5, Nonfoil`,
    ]);
    // And one printing in its two finishes — the pair `TWO_ENTRIES` draws — is two names too.
    const [regular, foil] = TWO_ENTRIES;
    expect(tokenEntryName("Quantity of", regular)).toBe(
      `Quantity of Treasure, ${subtitle}, TCLB · 5, Nonfoil`,
    );
    expect(tokenEntryName("Quantity of", foil)).toBe(
      `Quantity of Treasure, ${subtitle}, TCLB · 5, Foil`,
    );
  });

  it("leaves out the subtitle an emblem does not have, and a printing gone from the corpus", () => {
    expect(tokenEntryName("Quantity of", token({ name: "Emblem", subtitle: null }))).toBe(
      "Quantity of Emblem, TCLB · 5, Nonfoil",
    );
    // All six chin facts are `null` together for a printing the corpus no longer holds; the
    // finish is the entry's own and is still said.
    expect(
      tokenEntryName(
        "Quantity of",
        token({ name: "Emblem", subtitle: null, setCode: null, collectorNumber: null }),
      ),
    ).toBe("Quantity of Emblem, Nonfoil");
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

  /** The entry's own finish, as a deck row spells one — so the foil entry sheens and the regular
   *  copy of the same printing does not, however many finishes the printing is sold in. */
  it("is the entry's finish, the regular copy spelt null as a deck row's is", () => {
    const [regular, foil] = TWO_ENTRIES;
    expect(tokenFaceFacts(regular).finish).toBeNull();
    expect(tokenFaceFacts(foil).finish).toBe("foil");
    expect(tokenFaceFacts(token({ finish: "etched", finishes: '["etched"]' })).finish).toBe(
      "etched",
    );
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

  it("opens the printing picker on the entry that was pressed", () => {
    const { pile } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: tokenEntryName("Change the art for", WURMS[1]) }),
    );
    // The whole view, so the editor can hold its `entryKey` — never a frozen copy of it.
    expect(pile.pickArt).toHaveBeenCalledWith(WURMS[1]);
    expect(pile.openCard).not.toHaveBeenCalled();
  });

  // Issue #619: a press on the token itself — the card, the line, the name — opens the card
  // details, exactly as a press on a deck card does, and never the picker.
  it("opens the card details on the entry whose card was pressed", () => {
    const { pile } = setup();
    fireEvent.click(screen.getByRole("button", { name: tokenCardName(WURMS[1]) }));
    expect(pile.openCard).toHaveBeenCalledWith(WURMS[1]);
    expect(pile.pickArt).not.toHaveBeenCalled();
    // One details press per entry, and the two Wurms answer to two names.
    const names = screen
      .getAllByRole("button", { name: /^Show details for / })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toHaveLength(3);
    expect(new Set(names).size).toBe(3);
  });

  it("steps an entry's copies, down to zero, addressed by the entry", () => {
    const { pile } = setup([token({ quantity: 1 })]);
    const name = tokenEntryName("Quantity of", token());
    // Spelled out rather than built with `entryRef`, so the address is checked against the
    // entry's facts rather than against the helper the pile calls.
    const entry = { oracleId: "o-treasure", cardId: "p-treasure", finish: "nonfoil", implicit: false };
    fireEvent.click(screen.getByRole("button", { name: `Increase ${name}` }));
    expect(pile.setQuantity).toHaveBeenLastCalledWith(entry, 2);
    fireEvent.click(screen.getByRole("button", { name: `Decrease ${name}` }));
    expect(pile.setQuantity).toHaveBeenLastCalledWith(entry, 0);
  });

  /**
   * **Two entries of one token are two cards** — keyed apart (a key on the oracle id would be one
   * key twice, which React reports and then draws the second card's updates onto the first) and
   * named apart, and each control addresses its own entry.
   */
  it("draws two entries of one token as two cards, keyed apart and named apart", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { pile } = setup(TWO_ENTRIES);
      expect(error.mock.calls.some(([message]) => /same key/.test(String(message)))).toBe(false);

      const names = screen
        .getAllByRole("button", { name: /^Change the art for Treasure/ })
        .map((button) => button.getAttribute("aria-label"));
      expect(names).toEqual(TWO_ENTRIES.map((view) => tokenEntryName("Change the art for", view)));
      expect(new Set(names).size).toBe(2);

      const foil = TWO_ENTRIES[1];
      fireEvent.click(
        screen.getByRole("button", { name: `Increase ${tokenEntryName("Quantity of", foil)}` }),
      );
      expect(pile.setQuantity).toHaveBeenLastCalledWith(
        { oracleId: "o-treasure", cardId: "p-treasure", finish: "foil", implicit: false },
        2,
      );
      fireEvent.click(screen.getByRole("button", { name: tokenEntryName("Change the art for", foil) }));
      expect(pile.pickArt).toHaveBeenLastCalledWith(foil);
    } finally {
      error.mockRestore();
    }
  });

  /** Every drawing says which entry is the foil one where a reader can see it — the chin on the
   *  two card drawings, the finish mark a deck line and a deck row draw on the two compact ones. */
  it("marks the foil entry's finish, and only that entry's", () => {
    const { view } = setup(TWO_ENTRIES);
    expect(view.container.querySelectorAll('[aria-label="Foil"]')).toHaveLength(1);
  });

  it("gives two same-named tokens two different names", () => {
    setup();
    const names = screen
      .getAllByRole("button", { name: /^Change the art for Wurm/ })
      .map((button) => button.getAttribute("aria-label"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
  });

  /**
   * **The stacks draw what the reader has counted** (managed tokens spec §3.2): the editor hands
   * each view `pileTokens` of the band's list, so a token at 0 is not a card in any drawing and a
   * token at 1 is. The heading's copies are the drawn cards' own, so the zero adds nothing to it
   * either way.
   */
  it("draws a token at one copy and leaves out one at zero", () => {
    const zero = token({ oracleId: "o-zero", name: "Soldier", printingId: "p-soldier", quantity: 0 });
    setup(pileTokens([zero, token({ quantity: 1 })]));

    expect(screen.getAllByRole("button", { name: /^Change the art for / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Change the art for Treasure/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Change the art for Soldier/ })).toBeNull();
  });

  /**
   * **The mark's words are in every drawing's name for the art press** — the badge on the two
   * card drawings and the tag on the two compact ones are both `aria-hidden` or inside a named
   * button, so the name is the one place a screen reader hears them — and in no derived token's.
   */
  it("names a hand-added token's press with the mark's words, and a derived one's without", () => {
    setup([token(), HAND_ADDED]);

    expect(screen.getByRole("button", { name: tokenArtName(HAND_ADDED) })).toHaveAccessibleName(
      `${tokenEntryName("Change the art for", HAND_ADDED)}, not made by deck`,
    );
    expect(
      screen.getByRole("button", { name: tokenEntryName("Change the art for", token()) }),
    ).not.toHaveAccessibleName(/not made by deck/);
    expect(screen.getAllByText("NOT MADE BY DECK")).toHaveLength(1);
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

  /**
   * **The chin says the entry's finish** — the foil entry's foot carries the foil mark and the
   * regular copy's carries none, although both are one printing sold in both finishes. Before PR 2
   * a token stated no finish, so both chins fell to the printing's sole finish, which a printing
   * sold in two does not have.
   */
  it("names each entry's own finish in its chin", () => {
    renderStack(pileOf(TWO_ENTRIES));
    const [regular, foil] = TWO_ENTRIES.map(
      (view) =>
        screen
          .getByRole("button", { name: tokenEntryName("Change the art for", view) })
          .closest("li")!,
    );
    expect(within(foil).getByRole("img", { name: "Foil" })).toBeInTheDocument();
    expect(within(regular).queryByRole("img", { name: "Foil" })).toBeNull();
  });

  it("wears the plan's mark when the pile is given one", () => {
    renderStack({
      ...pileOf([token()]),
      theoryMark: () => ({ tier: "exact", delta: 0, anyPrinting: false }),
    });
    expect(document.querySelector(`[${THEORY_MATCH_ATTR}]`)).not.toBeNull();
  });

  it("says the plan's mark in the card press's own name, since the mark itself is aria-hidden", () => {
    const mark = { tier: "exact", delta: 0, anyPrinting: false } as const;
    renderStack({ ...pileOf([token()]), theoryMark: () => mark });
    const press = screen.getByRole("button", { name: /^Show details for Treasure/ });
    expect(press).toHaveAccessibleName(
      `${tokenCardName(token())}, ${theoryMatchLabel(mark).toLowerCase()}`,
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
      screen.getByRole("button", { name: tokenEntryName("Change the art for", WURMS[0]) }),
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

/**
 * **The two card drawings mark a hand-added token as a rule-break card is marked** — the card's
 * own edge in the destructive colour, the chin under it in the same tone so the red runs down to
 * the foot, and the `NOT MADE BY DECK` badge in the rule-break badge's corner (managed tokens spec
 * §3.5). A derived token keeps the neutral edge. And each card carries **Remove printing** in its
 * controls column, named for its entry — the one way to take a hand-added token off the deck.
 */
describe.each([
  { name: "stack", draw: (pile: TokenPile) => <TokenStackPile pile={pile} zoom={DEFAULT_ZOOM} /> },
  {
    name: "grid",
    draw: (pile: TokenPile) => (
      <TokenGridPile pile={pile} zoom={DEFAULT_ZOOM} tileWidth={150} gap={10} />
    ),
  },
] as const)("the $name drawing's card", ({ draw }) => {
  const cardOf = (view: DeckTokenView) =>
    screen.getByRole("button", { name: tokenArtName(view) }).closest("li")!;

  it("outlines a hand-added token and badges it, and leaves a derived one alone", () => {
    renderWith(draw(pileOf([token(), HAND_ADDED])));

    const byHand = cardOf(HAND_ADDED);
    expect(byHand.classList.contains("border-destructive")).toBe(true);
    expect(byHand.classList.contains("border-border")).toBe(false);
    expect(within(byHand).getByText("NOT MADE BY DECK")).toHaveAttribute("aria-hidden", "true");
    // The chin: the foot whose printing line reads `TCLB · 5` — the bar that holds it.
    expect(within(byHand).getByText("TCLB · 5").parentElement!.classList.contains("border-destructive")).toBe(true);

    const made = cardOf(token());
    expect(made.classList.contains("border-destructive")).toBe(false);
    expect(within(made).queryByText("NOT MADE BY DECK")).toBeNull();
    expect(within(made).getByText("TCLB · 5").parentElement!.classList.contains("border-destructive")).toBe(false);
  });

  it("removes the entry its Remove printing is drawn on", () => {
    const pile = pileOf([token(), HAND_ADDED]);
    renderWith(draw(pile));

    fireEvent.click(screen.getByRole("button", { name: tokenEntryName("Remove", HAND_ADDED) }));
    expect(pile.remove).toHaveBeenCalledTimes(1);
    expect(pile.remove).toHaveBeenCalledWith({
      oracleId: "o-construct",
      cardId: "p-construct",
      finish: "nonfoil",
      implicit: false,
    });
  });

  /** No Remove on an implicit entry — nothing is stored to delete — and none where the host
   *  wired no remove at all. */
  it("draws no Remove on an implicit entry, nor without a remove to call", () => {
    const implicit = token({ implicit: true, quantity: 3 });
    renderWith(draw(pileOf([implicit])));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    cleanup();

    renderWith(draw({ ...pileOf([token()]), remove: undefined }));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
  });
});

/**
 * **The two compact drawings say it in words** — `NOT MADE BY DECK` as a small destructive tag
 * after the name (managed tokens spec §3.5), since a 22px line and a table row have no corner to
 * put a badge in and no card edge to colour.
 */
describe.each([
  { name: "text", draw: (pile: TokenPile) => <TokenTextPile pile={pile} /> },
  { name: "table", draw: (pile: TokenPile) => <TokenTablePile pile={pile} /> },
] as const)("the $name drawing's line", ({ draw }) => {
  it("tags a hand-added token after its name, in the destructive colour", () => {
    renderWith(draw(pileOf([token(), HAND_ADDED])));

    const tag = screen.getByText("NOT MADE BY DECK");
    expect(tag.classList.contains("text-destructive")).toBe(true);
    const line = tag.closest("li")!;
    expect(within(line).getByText("Construct")).toBeInTheDocument();
    // After the name, in document order.
    expect(
      within(line).getByText("Construct").compareDocumentPosition(tag) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByText("NOT MADE BY DECK")).toHaveLength(1);
  });

  /**
   * **The tag is `WordMark`'s line recipe, not a copy of it** — so a change to the rule-break
   * box's shared half reaches this tag too. Compared against the recipe drawn on its own, class
   * for class, with the two a line's tag adds to stay whole beside a name that truncates.
   */
  it("draws the tag through WordMark's line surface", () => {
    renderWith(draw(pileOf([HAND_ADDED])));
    const tag = screen.getByText("NOT MADE BY DECK");

    const { container } = renderWith(<WordMark surface="line" word="THE RECIPE" hint="x" />);
    const recipe = [...within(container).getByText("THE RECIPE").classList];
    expect([...tag.classList].filter((c) => c !== "shrink-0" && c !== "whitespace-nowrap")).toEqual(
      recipe,
    );
  });

  /**
   * **Remove printing on every line, as on every card** (managed tokens spec §3.4: every tile, band
   * and pile — the final review's M3). The same write and the same name as the band's tile and the
   * two card drawings, so one entry answers to one name on every surface: a token's foil and plain
   * entries are two presses, each reaching its own entry.
   */
  it("removes the entry its Remove printing is drawn on", () => {
    const [plain, foil] = TWO_ENTRIES;
    const pile = pileOf([plain, foil, HAND_ADDED]);
    renderWith(draw(pile));

    fireEvent.click(screen.getByRole("button", { name: tokenEntryName("Remove", foil) }));
    expect(pile.remove).toHaveBeenCalledTimes(1);
    expect(pile.remove).toHaveBeenCalledWith(entryRef(foil));
    fireEvent.click(screen.getByRole("button", { name: tokenEntryName("Remove", HAND_ADDED) }));
    expect(pile.remove).toHaveBeenLastCalledWith(entryRef(HAND_ADDED));
    // One name per entry: three entries, three distinct Remove buttons.
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(3);
  });

  it("draws no Remove on an implicit entry, nor without a remove to call", () => {
    renderWith(draw(pileOf([token({ implicit: true, quantity: 3 })])));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    cleanup();

    renderWith(draw({ ...pileOf([token()]), remove: undefined }));
    expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
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

  /**
   * **A token tile's marks are the deck tile's — scaled to its width, not to the wall's zoom**
   * (issue #567). The zoom is handed in at 2× against a 150px tile on purpose: the two disagree,
   * and a tile that published the zoom would draw a 420px card's tag and chin on a 150px card.
   */
  it("scales its marks and chin to the tile's width against a stacked card's", () => {
    renderWith(<TokenGridPile pile={pileOf([token()])} zoom={2} tileWidth={150} gap={10} />);
    const tile = screen.getByRole("button", { name: /^Change the art for Treasure/ }).closest("li")!;
    expect(tile.style.getPropertyValue("--mark-scale")).toBe(String(deckCardScale(150)));
    const chin = within(tile).getByText("TCLB · 5").parentElement as HTMLElement;
    expect(chin.style.height).toBe(`${chinHeight(deckCardScale(150))}px`);
  });
});
