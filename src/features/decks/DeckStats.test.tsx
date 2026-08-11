import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DeckCard } from "@/lib/ipc";
import { PRICES_AS_OF } from "@/lib/prices";
import { card, islands } from "./validation/fixtures";
import { DeckStats, deckStats, type MissingWrite } from "./DeckStats";

/** The write the strip's one button makes, in whatever state a test needs it. */
function sender(overrides: Partial<MissingWrite> = {}): MissingWrite {
  return {
    mutate: vi.fn(),
    isPending: false,
    isSuccess: false,
    isError: false,
    error: null,
    data: undefined,
    ...overrides,
  };
}

/** A nonland at a given cost, so a curve test reads as a curve. */
function spell(name: string, cmc: number, overrides: Partial<DeckCard> = {}): DeckCard {
  return card({ name, cmc, typeLine: "Sorcery", manaCost: `{${cmc}}`, ...overrides });
}

describe("deckStats", () => {
  /** The curve is the deck's casting costs: nine buckets, and the last one is open-ended —
   *  a 12-drop is still a card you have to reach. */
  it("buckets the curve over nonlands, with the last bucket open-ended", () => {
    const stats = deckStats([
      spell("Ritual", 1, { quantity: 4 }),
      spell("Gift", 3, { quantity: 2 }),
      spell("Emrakul", 15),
      spell("Kozilek", 8),
      islands(24),
    ]);

    expect(stats.curve).toEqual([0, 4, 0, 2, 0, 0, 0, 0, 2]);
    // Lands have their own chart: 24 basics in the first bucket would swamp every spell.
    expect(stats.lands).toBe(24);
    expect(stats.nonlands).toBe(8);
  });

  /** A cost with no column behind it is still a cost — `cmc` is nullable, and the printed
   *  string is what the engine falls back to for the same reason. */
  it("reads a mana value off the printed cost when the column has none", () => {
    const stats = deckStats([spell("Counterspell", 0, { cmc: null, manaCost: "{U}{U}" })]);

    expect(stats.curve[2]).toBe(1);
    expect(stats.unknownManaValue).toBe(0);
  });

  /** An orphaned row has no cost at all, and 0 is a number this app would be making up. */
  it("leaves a card with no mana value out of the curve and the average", () => {
    const stats = deckStats([
      spell("Bolt", 1),
      card({ name: "Ghost", cmc: null, manaCost: null, typeLine: null }),
    ]);

    expect(stats.curve[0]).toBe(0);
    expect(stats.unknownManaValue).toBe(1);
    expect(stats.averageManaValue).toBe(1);
  });

  /** Pips, not cards: a WU card is white *and* blue, which is what makes this the "what can
   *  this deck cast" measure rather than a second colour pie. */
  it("counts pips per colour, so a two-colour card feeds both", () => {
    const stats = deckStats([
      card({ name: "Fractured Identity", colors: "WU", quantity: 2 }),
      card({ name: "Bolt", colors: "R", quantity: 4 }),
    ]);

    expect(stats.pips).toEqual({ W: 2, U: 2, B: 0, R: 4, G: 0 });
  });

  /** `colors`, never `colorIdentity`: the curve strip describes what a card costs, and a
   *  Kenrith in the command zone does not make the deck's spells five-coloured. */
  it("takes the pips from a card's colours and not from its identity", () => {
    const stats = deckStats([card({ name: "Ancestral", colors: "U", colorIdentity: "WUBRG" })]);

    expect(stats.pips).toEqual({ W: 0, U: 1, B: 0, R: 0, G: 0 });
  });

  it("averages mana value over nonlands only", () => {
    const stats = deckStats([spell("A", 1), spell("B", 3), islands(10)]);

    expect(stats.averageManaValue).toBe(2);
  });

  it("has no average to give for a deck of nothing but lands", () => {
    expect(deckStats([islands(10)]).averageManaValue).toBeNull();
  });

  /** `unitPriceUsd` is the row's own finish-correct `usd`. `cards.price_usd` is a display
   *  fallback chain and must never be summed. */
  it("sums the row price by copies and counts what it could not price", () => {
    const stats = deckStats([
      spell("Bolt", 1, { quantity: 4, unitPriceUsd: 2.5 }),
      spell("Bear", 2, { quantity: 2, unitPriceUsd: null }),
    ]);

    expect(stats.priceUsd).toBe(10);
    expect(stats.unpriced).toBe(2);
  });

  it("has no price at all when nothing in the deck is priced", () => {
    expect(deckStats([spell("Bolt", 1, { unitPriceUsd: null })]).priceUsd).toBeNull();
  });

  /** The same arithmetic every row's own badge does, added up once. */
  it("agrees with the rows about owned and missing", () => {
    const stats = deckStats([
      spell("Bolt", 1, { quantity: 4, ownedQuantity: 1 }),
      spell("Bear", 2, { quantity: 2, ownedQuantity: 2 }),
    ]);

    expect(stats.copies).toBe(6);
    expect(stats.owned).toBe(3);
    expect(stats.missing).toBe(3);
  });

  /** Every nonland lands in exactly one bucket, so the buckets can be a pie. */
  it("buckets nonlands into mono, multicolour and colourless", () => {
    const stats = deckStats([
      card({ name: "Bolt", colors: "R", quantity: 4 }),
      card({ name: "Duo", colors: "WU", quantity: 2 }),
      card({ name: "Sol Ring", colors: null, typeLine: "Artifact" }),
      islands(3),
    ]);

    const counts = Object.fromEntries(stats.colorDist.map((s) => [s.label, s.count]));
    expect(counts).toEqual({ Red: 4, Multicolor: 2, Colorless: 1 });
    expect(stats.colorDist.reduce((n, s) => n + s.count, 0)).toBe(stats.nonlands);
  });

  /** And every land, by the basic types printed on its front face. */
  it("buckets lands by their basic land types", () => {
    const stats = deckStats([
      islands(4),
      card({ name: "Sacred Foundry", typeLine: "Land — Mountain Plains", quantity: 2 }),
      card({ name: "Command Tower", typeLine: "Land", quantity: 1 }),
      card({ name: "Mountain", typeLine: "Basic Land — Mountain", quantity: 3 }),
    ]);

    const counts = Object.fromEntries(stats.landDist.map((s) => [s.label, s.count]));
    expect(counts).toEqual({ Island: 4, Mountain: 3, "Multi-type": 2, "Other lands": 1 });
    expect(stats.landDist.reduce((n, s) => n + s.count, 0)).toBe(stats.lands);
  });

  /**
   * The one card class where the two readings of "land" part company, and the reason each
   * side is read the way it is.
   *
   * `groupCards` files a card under the **first** type printed on it, so Urza's Saga heads up
   * the Enchantment bar — which is right for the bars, because that is the heading the reader
   * already sees over the rows. Everywhere else the type line decides: a deckbuilder counts
   * Urza's Saga among their lands, and it costs nothing to put onto the battlefield, so the
   * curve would file it under 0 — the very flood the curve excludes lands to avoid.
   */
  it("keeps a land that is not filed under Land a land to every chart but the type bars", () => {
    const stats = deckStats([
      card({ name: "Urza's Saga", typeLine: "Legendary Enchantment Land", cmc: 0, manaCost: null }),
      card({ name: "Tree of Tales", typeLine: "Artifact Land", cmc: 0, manaCost: null }),
      card({ name: "Dryad Arbor", typeLine: "Land Creature — Dryad", cmc: 0, manaCost: null }),
      spell("Bolt", 1),
    ]);

    expect(stats.lands).toBe(3);
    expect(stats.nonlands).toBe(1);
    expect(stats.curve[0]).toBe(0);
    expect(Object.fromEntries(stats.landDist.map((s) => [s.label, s.count]))).toEqual({
      "Other lands": 3,
    });
    // The bars keep the deck list's answer, and the disagreement is deliberate.
    expect(stats.typeDist.map((t) => t.label)).toEqual([
      "Creature",
      "Sorcery",
      "Artifact",
      "Enchantment",
    ]);
  });

  /** The headline figure is the engine's `SIZE_KINDS` over the active categories, so the strip
   *  and the format check count the same cards; everything else is counted over every active
   *  pile. */
  it("sizes the deck by the kinds the format's size rule counts", () => {
    const stats = deckStats([
      spell("Bolt", 1, { quantity: 4 }),
      card({ name: "Kenrith", categoryKind: "commander" }),
      spell("Pyroblast", 1, { categoryKind: "side", quantity: 3 }),
      spell("Lurrus", 3, { categoryKind: "companion" }),
      spell("Ghost", 5, { categoryKind: "maybe", quantity: 9 }),
    ]);

    expect(stats.sized).toBe(5);
    expect(stats.copies).toBe(9);
    // Every pile that holds a card, in the order the rows arrived, by the name it carries —
    // the ids are the fixture's own and mean nothing, so they are not what this asserts.
    expect(stats.byCategory.map((c) => [c.name, c.quantity])).toEqual([
      ["Main deck", 4],
      ["Commander", 1],
      ["Sideboard", 3],
      ["Companion", 1],
      // Listed like any other pile and counted in nothing else: the scratchpad's old bargain,
      // made by the switch now rather than by the word `maybe`.
      ["Maybeboard", 9],
    ]);
    // Where the rest of the deck is — the active piles the size rule does not count, which is
    // the note under the headline figure and is not the switched-off Maybeboard.
    expect(stats.elsewhere.map((c) => c.name)).toEqual(["Sideboard", "Companion"]);
  });

  /** The type bars come from the deck list's own grouping, so a heading in a column and a
   *  bar in the strip can never disagree. */
  it("counts types in the deck list's own buckets", () => {
    const stats = deckStats([
      card({ name: "Bear", typeLine: "Creature — Bear", quantity: 2 }),
      card({ name: "Bolt", typeLine: "Instant", quantity: 4 }),
      islands(1),
    ]);

    expect(stats.typeDist).toEqual([
      { key: "creature", label: "Creature", count: 2 },
      { key: "instant", label: "Instant", count: 4 },
      { key: "land", label: "Land", count: 1 },
    ]);
  });

  /** The Maybeboard is the one predefined category seeded switched off, so it counts toward
   *  nothing — the same rule the engine applies before it judges anything, and the allocator
   *  never claims a copy for it either. */
  it("leaves the seeded Maybeboard out of every number", () => {
    const stats = deckStats([
      spell("Bolt", 1, { quantity: 4, unitPriceUsd: 1 }),
      spell("Ghost", 5, { categoryKind: "maybe", quantity: 9, unitPriceUsd: 100 }),
    ]);

    expect(stats.copies).toBe(4);
    expect(stats.curve[5]).toBe(0);
    expect(stats.priceUsd).toBe(4);
  });

  /**
   * And it is the **switch** that does that, never the word `maybe`: a `main` pile of the
   * reader's own, switched off, is left out of exactly the same numbers.
   *
   * This is the case that separates the two readings. Its kind is the kind the size rule
   * counts and its name is not one this app chose, so anything still asking whether a
   * category is the Maybeboard sizes this deck at 13 and puts nine copies in the curve.
   */
  it("leaves a category the reader switched off out of the size and the curve", () => {
    const stats = deckStats([
      spell("Bolt", 1, { quantity: 4, unitPriceUsd: 1 }),
      spell("Ghost", 5, {
        categoryId: 7,
        categoryName: "Cuts",
        categoryKind: "main",
        categoryActive: false,
        quantity: 9,
        unitPriceUsd: 100,
      }),
    ]);

    expect(stats.sized).toBe(4);
    expect(stats.copies).toBe(4);
    expect(stats.curve[5]).toBe(0);
    expect(stats.priceUsd).toBe(4);
    // Listed, though, like the Maybeboard above it: "counts toward nothing" is not "hidden".
    expect(stats.byCategory).toContainEqual({ id: 7, name: "Cuts", quantity: 9 });
    // And not in the headline's note, which accounts for the copies the figure left out.
    expect(stats.elsewhere).toEqual([]);
  });

  /**
   * The other direction, and the third reader of one definition.
   *
   * `SIZE_KINDS` is `main`, `commander` **and `maybe`** — the switch decides whether a pile
   * counts at all, the kind decides only whether it is played *beside* the deck or *in* it,
   * and only `side` and `companion` are beside it. So a Maybeboard the reader switched on is a
   * pile of the deck and this strip sizes it, exactly as `validateDeck` and `DeckRow.cardCount`
   * do. Three surfaces, one rule; a strip that disagreed would print a headline the panel
   * beside it contradicts.
   */
  it("sizes a Maybeboard the reader switched on, like any other pile of the deck", () => {
    const parked = spell("Ghost", 5, {
      categoryKind: "maybe",
      categoryActive: false,
      quantity: 9,
    });
    const played = { ...parked, categoryActive: true };

    expect(deckStats([spell("Bolt", 1, { quantity: 4 }), parked]).sized).toBe(4);

    const on = deckStats([spell("Bolt", 1, { quantity: 4 }), played]);
    expect(on.sized).toBe(13);
    expect(on.curve[5]).toBe(9);
    // In the size, so *not* in the note that accounts for what the size left out.
    expect(on.elsewhere).toEqual([]);
  });

  /** The sideboard is part of what a deck costs and what it is short of: it is cards you
   *  own, sleeve and pay for. */
  it("counts every active category", () => {
    const stats = deckStats([
      spell("Bolt", 1, { quantity: 4 }),
      spell("Pyroblast", 1, { categoryKind: "side", quantity: 2 }),
    ]);

    expect(stats.copies).toBe(6);
  });
});

describe("DeckStats", () => {
  const strip = (cards: DeckCard[], send = sender()) =>
    render(<DeckStats cards={cards} send={send} />);

  /** A deck short of three copies of one card. */
  const short = (): DeckCard[] => [card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })];

  /**
   * Press the button, then let the write settle — the flow the strip actually has, and the one
   * the answer is scoped to: the sentence and the spent button both hang off the shortfall the
   * *press* was made against, not off a mutation flag that stays true forever.
   */
  async function press(cards: DeckCard[], settled: MissingWrite) {
    const view = render(<DeckStats cards={cards} send={sender()} />);
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
    view.rerender(<DeckStats cards={cards} send={settled} />);
    return view;
  }

  /** A 24-land Boros deck: every chart is checkable by hand, and every one of them shows
   *  its numbers as text rather than only as a shape. */
  const boros = (): DeckCard[] => [
    card({ name: "Bolt", typeLine: "Instant", colors: "R", cmc: 1, quantity: 4 }),
    card({ name: "Lion", typeLine: "Creature — Cat", colors: "W", cmc: 1, quantity: 4 }),
    card({ name: "Helix", typeLine: "Instant", colors: "WR", cmc: 2, quantity: 4 }),
    card({
      name: "Mountain",
      typeLine: "Basic Land — Mountain",
      cmc: 0,
      colors: null,
      quantity: 12,
    }),
    card({ name: "Plains", typeLine: "Basic Land — Plains", cmc: 0, colors: null, quantity: 12 }),
  ];

  it("draws the pips row with a count for every colour", () => {
    strip(boros());

    const pips = screen.getByRole("group", { name: /pips/i });
    // A WR card feeds both, so white is 4 + 4 and red is 4 + 4 — pips, not cards.
    expect(within(pips).getByText("White").parentElement).toHaveTextContent("8");
    expect(within(pips).getByText("Red").parentElement).toHaveTextContent("8");
    expect(within(pips).getByText("Blue").parentElement).toHaveTextContent("0");
  });

  it("draws the mana curve with a count over every bucket", () => {
    strip(boros());

    const curve = screen.getByRole("list", { name: "Mana curve" });
    expect(within(curve).getByText("8 cards at mana value 1")).toBeInTheDocument();
    expect(within(curve).getByText("4 cards at mana value 2")).toBeInTheDocument();
    // The axis is drawn whole: an empty bucket is a fact about the curve.
    expect(within(curve).getByText("0 cards at mana value 4")).toBeInTheDocument();
  });

  it("draws the colour pie with a legend that counts each segment", () => {
    strip(boros());

    const legend = screen.getByRole("list", { name: "Colors" });
    expect(within(legend).getByText("White").closest("li")).toHaveTextContent("4");
    expect(within(legend).getByText("Red").closest("li")).toHaveTextContent("4");
    expect(within(legend).getByText("Multicolor").closest("li")).toHaveTextContent("4");
  });

  it("draws the land pie with a legend that counts each segment", () => {
    strip(boros());

    const legend = screen.getByRole("list", { name: "Lands" });
    expect(within(legend).getByText("Mountain").closest("li")).toHaveTextContent("12");
    expect(within(legend).getByText("Plains").closest("li")).toHaveTextContent("12");
  });

  it("draws a bar per card type with the count at its end", () => {
    strip(boros());

    const types = screen.getByRole("list", { name: "Card types" });
    expect(within(types).getByText("Instant").closest("li")).toHaveTextContent("8");
    expect(within(types).getByText("Creature").closest("li")).toHaveTextContent("4");
    expect(within(types).getByText("Land").closest("li")).toHaveTextContent("24");
  });

  /**
   * A pie with one slice is a **circle**, not an arc: a wedge whose start and end meet sweeps
   * nothing at all, so the mono-coloured deck — the commonest deck there is — would draw a
   * legend beside an empty frame.
   */
  it("draws a whole circle for a distribution with one bucket in it", () => {
    const { container } = strip([
      card({ name: "Bolt", typeLine: "Instant", colors: "R", quantity: 4 }),
      card({ name: "Mountain", typeLine: "Basic Land — Mountain", colors: null, quantity: 24 }),
    ]);

    const [colors, lands] = [...container.querySelectorAll("svg")];
    expect(colors.querySelector("circle")).toBeInTheDocument();
    expect(colors.querySelector("path")).not.toBeInTheDocument();
    expect(lands.querySelector("circle")).toBeInTheDocument();
  });

  /** And two buckets are two wedges, so the branch above is a special case rather than the
   *  only case. */
  it("draws a wedge per bucket once there are two", () => {
    const { container } = strip(boros());

    const [colors] = [...container.querySelectorAll("svg")];
    expect(colors.querySelectorAll("path")).toHaveLength(3);
    expect(colors.querySelector("circle")).not.toBeInTheDocument();
  });

  /** A pie of a mono-red deck is a red circle: five legend rows saying 0 would be four
   *  lines of nothing. */
  it("draws no legend row for a bucket nothing is in", () => {
    strip([card({ name: "Bolt", typeLine: "Instant", colors: "R", quantity: 4 })]);

    const legend = screen.getByRole("list", { name: "Colors" });
    expect(within(legend).getByText("Red")).toBeInTheDocument();
    expect(within(legend).queryByText("Blue")).not.toBeInTheDocument();
    expect(within(legend).queryByText("Colorless")).not.toBeInTheDocument();
  });

  /** A deck with no lands has no land pie — an empty circle answers nothing. */
  it("leaves out a chart with nothing to draw", () => {
    strip([card({ name: "Bolt", typeLine: "Instant", colors: "R", quantity: 4 })]);

    expect(screen.queryByRole("list", { name: "Lands" })).not.toBeInTheDocument();
  });

  it("renders the figures and no charts at all for an empty deck", () => {
    strip([]);

    expect(screen.getByText("Cards")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Mana curve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Colors" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Card types" })).not.toBeInTheDocument();
  });

  /** The chart is a shape; the words beside it are the story. A screen reader that read
   *  both would hear the deck twice. */
  it("hides every chart's drawing from the accessibility tree", () => {
    const { container } = strip(boros());

    const svgs = [...container.querySelectorAll("svg")];
    expect(svgs.length).toBeGreaterThan(0);
    for (const svg of svgs) expect(svg).toHaveAttribute("aria-hidden", "true");
  });

  /** Spec §5: a price never appears without saying how old it is. */
  it("says how old the deck's price is", () => {
    strip([card({ name: "Bolt", unitPriceUsd: 4.5, quantity: 2 })]);

    expect(screen.getByText("Price (USD)").closest("div")).toHaveAttribute("title", PRICES_AS_OF);
    expect(screen.getByText("$9.00")).toBeInTheDocument();
  });

  /**
   * The headline figure is the number the format check beside it is talking about — the
   * engine's own `SIZE_KINDS`. The sideboard and the companion are counted by the price, the
   * shortfall and every chart, and named here — in the reader's own words for those piles —
   * rather than folded in: "Cards 9" over a chip reading "you have 5" is two numbers for one
   * question.
   */
  it("heads the strip with the cards a format's size rule counts", () => {
    strip([
      card({ name: "Bolt", quantity: 4 }),
      card({ name: "Kenrith", categoryKind: "commander", quantity: 1 }),
      card({ name: "Pyroblast", categoryKind: "side", quantity: 3 }),
      card({ name: "Lurrus", categoryKind: "companion", quantity: 1 }),
      card({ name: "Ghost", categoryKind: "maybe", quantity: 9 }),
    ]);

    const figure = screen.getByText("Cards").closest("div");
    expect(figure?.querySelector("dd")?.textContent).toBe("5+ 3 sideboard + 1 companion");
    expect(figure).toHaveAttribute("title", expect.stringMatching(/size rule counts/i));
  });

  it("says nothing about other piles when the deck is only a main deck", () => {
    strip([card({ name: "Bolt", quantity: 4 })]);

    expect(screen.getByText("Cards").closest("div")?.querySelector("dd")?.textContent).toBe("4");
  });

  it("counts what the deck is short of, and offers to wish for it", async () => {
    const send = sender();
    strip(
      [
        card({ name: "Bolt", quantity: 4, ownedQuantity: 1 }),
        card({ name: "Bear", quantity: 2, ownedQuantity: 2 }),
      ],
      send,
    );

    expect(screen.getByText("3 of 6 missing")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));

    expect(send.mutate).toHaveBeenCalled();
  });

  /**
   * In words, in a region that was already on screen — and in the unit it is counting. A wish
   * is a card and the shortfall beside it is copies (one wish for three missing Bolts), so the
   * sentence says which rather than leaving two numbers on one line to be read as one unit.
   */
  it("reports what the wishlist write did, in wishes rather than copies", async () => {
    await press(short(), sender({ isSuccess: true, data: 2 }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Added 2 wishes — one per card, for every copy you are short.",
    );
  });

  /**
   * Zero is **not** "they were already wished for", and the backend is why: it counts the
   * shortfall from a freshly reallocated deck *before* it writes anything, and skips a row
   * whose printing has no `oracle_id`. So zero means the recount found nothing short, or that
   * what is short is an orphan nothing can wish for — and the reassuring sentence would be the
   * one thing that certainly did not happen.
   */
  it("says what nothing-added actually means", async () => {
    await press(short(), sender({ isSuccess: true, data: 0 }));

    expect(screen.getByRole("status")).toHaveTextContent(
      "Nothing to add — a recount covered the shortfall, or what is short has left the card database.",
    );
    expect(screen.getByRole("status")).not.toHaveTextContent(/already on your wishlist/i);
  });

  /**
   * `add_wish` **folds** — a second press on the same shortfall raises the wished quantity
   * rather than replacing it, so three missing Bolts become six wished ones and both presses
   * answer the same cheerful number. The button is spent until the deck says something new.
   */
  it("spends the button on the shortfall it sent", async () => {
    const settled = sender({ isSuccess: true, data: 1 });
    await press(short(), settled);

    const button = screen.getByRole("button", { name: "Send missing to wishlist" });
    // `aria-disabled`, not `disabled`: the caret has to be able to come back to it, and a
    // keyboard reader has to be able to reach the control and hear why it will not act.
    expect(button).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(button);

    expect(settled.mutate).not.toHaveBeenCalled();
  });

  it("offers it again once the shortfall is a different one", async () => {
    const deck = short();
    const { rerender } = await press(deck, sender({ isSuccess: true, data: 1 }));

    rerender(
      <DeckStats
        cards={[card({ name: "Bolt", quantity: 4, ownedQuantity: 1 }), card({ name: "Bear" })]}
        send={sender({ isSuccess: true, data: 1 })}
      />,
    );

    expect(screen.getByRole("button", { name: "Send missing to wishlist" })).not.toHaveAttribute(
      "aria-disabled",
    );
    // And the old answer goes with the old question: a sentence that outlives what it was
    // about is a sentence the reader takes for news about the deck they have now.
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  /**
   * And it does not come back when the number does. A shortfall stepped to 4 and back to 3 is
   * three *different* copies as far as anything here knows — so an answer re-derived from the
   * count alone would put "Added 1 wish" back in the live region for a write that did not just
   * happen, under a button claiming those cards were already wished for.
   */
  it("does not put the old answer back when the shortfall comes round again", async () => {
    const deck = short();
    const { rerender } = await press(deck, sender({ isSuccess: true, data: 1 }));
    expect(screen.getByRole("status")).not.toHaveTextContent("");

    const settled = sender({ isSuccess: true, data: 1 });
    // Away…
    rerender(
      <DeckStats cards={[card({ name: "Bolt", quantity: 5, ownedQuantity: 1 })]} send={settled} />,
    );
    // …and back to exactly the number that was sent.
    rerender(<DeckStats cards={deck} send={settled} />);

    expect(screen.getByRole("status")).toHaveTextContent("");
    const button = screen.getByRole("button", { name: "Send missing to wishlist" });
    expect(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(settled.mutate).toHaveBeenCalledTimes(1);
  });

  it("says so when the wishlist write is refused, and lets it be tried again", async () => {
    await press(
      short(),
      sender({ isError: true, error: "The database is busy with a sync — try again in a moment." }),
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The database is busy with a sync");
    const button = screen.getByRole("button", { name: "Send missing to wishlist" });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute("aria-disabled");
  });

  /** A control that offers to do nothing is a control that teaches the reader to stop
   *  looking at the row it is in. */
  it("does not offer the wishlist when the deck is fully owned", () => {
    strip([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })]);

    expect(
      screen.queryByRole("button", { name: "Send missing to wishlist" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/all 4 owned/i)).toBeInTheDocument();
  });

  /**
   * The disabled-on-press hazard, in the one shape it takes outside a dismissible layer: the
   * browser blurs a control that disables itself, so the caret lands on `<body>` and the next
   * Tab restarts from the top of the app. The button is still here — and still *focusable*,
   * because spent is `aria-disabled` rather than `disabled` — when the write settles, so it
   * takes the caret back.
   */
  it("takes the caret back after the write it disabled itself for", async () => {
    const deck = short();
    const { rerender } = render(<DeckStats cards={deck} send={sender()} />);
    const button = screen.getByRole("button", { name: "Send missing to wishlist" });
    await userEvent.click(button);
    button.focus();

    // What a browser does to a focused control that becomes disabled, and jsdom does not:
    // blurs it with no `relatedTarget` at all, so the caret lands on `<body>`. Blurred before
    // the disabling render because jsdom refuses to blur an element that is already disabled
    // (a disabled control is not focusable, so `blur()` returns early) — the state under test
    // is the same one either way.
    button.blur();
    rerender(<DeckStats cards={deck} send={sender({ isPending: true })} />);
    expect(document.body).toHaveFocus();

    rerender(<DeckStats cards={deck} send={sender({ isSuccess: true, data: 3 })} />);

    expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toHaveFocus();
  });
});
