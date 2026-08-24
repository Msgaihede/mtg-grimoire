import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TOOLTIP_OPEN_MS, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { DeckCard } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pricesAsOf } from "@/lib/prices";
import { card } from "./validation/fixtures";
import { DeckLedger } from "./DeckLedger";

/**
 * Hover a tooltip anchor open and hand back its panel — a term's hint describes an already-named
 * pair (the label and the value beside it), so it binds `describes: true` (the default) and the
 * panel carries `role="tooltip"`.
 */
async function openTooltip(anchor: Element): Promise<HTMLElement> {
  fireEvent.pointerEnter(anchor);
  return await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
}

/** An `{X}` spell, for the one figure the deck's split flag must not reach. */
function xSpell(name: string, overrides: Partial<DeckCard> = {}): DeckCard {
  return card({ name, typeLine: "Sorcery", manaCost: "{X}{B}{B}{B}", cmc: 3, ...overrides });
}

describe("DeckLedger", () => {
  const ledger = (cards: DeckCard[], props: Partial<Parameters<typeof DeckLedger>[0]> = {}) =>
    render(
      <TooltipProvider>
        <DeckLedger
          cards={cards}
          marketplace={MARKETPLACES.tcgplayer}
          formatName="Commander"
          gameChangers={0}
          tight={false}
          check={null}
          bracket={null}
          {...props}
        />
      </TooltipProvider>,
    );

  /** The pair a term is: the label, and the number it names. */
  const term = (label: string) =>
    screen.getByText(label, { selector: "dt" }).closest("div") as HTMLElement;

  /**
   * The headline figure is the number the format check beside it is talking about — the engine's
   * own `SIZE_KINDS`. The sideboard and the companion are counted by the price, the shortfall and
   * every chart, and named in the tooltip — in the reader's own words for those piles — rather
   * than folded in: "Cards 9" over a button reading "you have 5" is two numbers for one question.
   */
  it("heads the line with the cards a format's size rule counts", async () => {
    ledger([
      card({ name: "Bolt", quantity: 4 }),
      card({ name: "Kenrith", categoryKind: "commander", quantity: 1 }),
      card({ name: "Pyroblast", categoryKind: "side", quantity: 3 }),
      card({ name: "Lurrus", categoryKind: "companion", quantity: 1 }),
      card({ name: "Ghost", categoryKind: "maybe", quantity: 9 }),
    ]);

    // 5 sized, and the +4 is everything switched on that the size rule does not count.
    expect(term("Cards").querySelector("dd")?.textContent).toBe("5+4");
    expect(await openTooltip(term("Cards"))).toHaveTextContent(
      "plus 3 sideboard + 1 companion it does not",
    );
  });

  it("draws no spare count for a deck that is only a main deck", () => {
    ledger([card({ name: "Bolt", quantity: 4 })]);

    expect(term("Cards").querySelector("dd")?.textContent).toBe("4");
  });

  /**
   * The one figure the deck's `separateXGroup` must leave alone, and here it cannot reach at all:
   * the ledger calls `deckStats` without the flag, because the flag moves cards between *curve
   * buckets* and this line draws no curve. `(3 x 4 + 1 x 4) / 8 = 2.00` with X at zero
   * (CR 202.3b), whichever bar those spells would be drawn in.
   */
  it("averages mana value over nonlands, with X at zero", () => {
    ledger([xSpell("Awakening", { quantity: 4 }), card({ name: "Bolt", cmc: 1, quantity: 4 })]);

    expect(term("Avg. mana")).toHaveTextContent("2.00");
  });

  /** An average of no numbers is not zero — a deck of nothing but lands has none to give. */
  it("shows an em dash rather than a zero average for a deck of nothing but lands", () => {
    ledger([
      card({ name: "Island", typeLine: "Basic Land — Island", cmc: 0, quantity: 20 }),
    ]);

    expect(within(term("Avg. mana")).getByText("—")).toBeInTheDocument();
  });

  /** Spec §5: a price never appears without saying how old it is — and, now that a reader can
   *  pick, whose it is. The row has no room to write it, so it is the term's tooltip. */
  it("says how old the deck's price is, and whose", async () => {
    ledger([card({ name: "Bolt", unitPrice: 4.5, quantity: 2 })]);

    expect(term("Price")).toHaveTextContent("$9.00");
    expect(await openTooltip(term("Price"))).toHaveTextContent(pricesAsOf(MARKETPLACES.tcgplayer));
  });

  /**
   * The figure and its as-of sentence move together with the marketplace. A figure still quoting
   * dollars beside a euro sentence would be the one failure a reader cannot detect from the
   * number alone.
   */
  it("draws the selected marketplace's currency and its own as-of sentence", async () => {
    // The row as a Cardmarket read answers it: €3.00 a copy, where TCGplayer's read of the same
    // card answers $4.50. A switch changes the rows, not which field a figure reads.
    ledger([card({ name: "Bolt", unitPrice: 3, quantity: 2 })], {
      marketplace: MARKETPLACES.cardmarket,
    });

    expect(term("Price")).toHaveTextContent("€6.00");
    expect(screen.queryByText("$9.00")).not.toBeInTheDocument();
    expect(await openTooltip(term("Price"))).toHaveTextContent(pricesAsOf(MARKETPLACES.cardmarket));
  });

  /**
   * An etched printing has no euro price at all, so on Cardmarket the figure is an em dash with
   * the copies counted in the tooltip — never the dollar figure re-badged.
   */
  it("shows an em dash and counts the unpriced copies for a deck with no euro prices", async () => {
    ledger([card({ name: "Etched Bomb", unitPrice: null, quantity: 2 })], {
      marketplace: MARKETPLACES.cardmarket,
    });

    expect(within(term("Price")).getByText("—")).toBeInTheDocument();
    expect(await openTooltip(term("Price"))).toHaveTextContent("2 unpriced");
  });

  /** What the deck secured from the collection, and what it could not. */
  it("counts what the deck owns and what it is short of", () => {
    ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })]);

    expect(term("Owned")).toHaveTextContent("1");
    expect(screen.getByText("3 missing")).toBeInTheDocument();
  });

  it("says nothing about a shortfall for a deck it holds every copy of", () => {
    ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })]);

    expect(screen.queryByText(/missing/)).not.toBeInTheDocument();
  });

  /**
   * The narrow column shortens the shortfall to a sign, and the words stay for a screen reader:
   * `−3` is only legible beside the number it is short of, which is exactly what a reader hearing
   * this line one term at a time does not have.
   */
  it("shortens the shortfall to a sign when the column is tight, keeping the words", () => {
    ledger([card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })], { tight: true });

    expect(screen.getByText("−3")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("3 missing")).toHaveClass("sr-only");
  });

  /**
   * **The ruleset every number is judged against, because the header's format select is gone.**
   * Changing it is a Deck settings trip now; saying which one it is has to stay on screen, or the
   * check beside these figures is a count with no scope.
   */
  it("names the format the deck is judged by", () => {
    ledger([card({ name: "Bolt" })]);

    expect(term("Format")).toHaveTextContent("Commander");
  });

  /** It is the first thing to go when the column is narrow: the check button's own accessible
   *  name still carries the ruleset at every width. */
  it("drops the format term when the column is tight", () => {
    ledger([card({ name: "Bolt" })], { tight: true });

    expect(screen.queryByText("Format")).not.toBeInTheDocument();
  });

  /**
   * Beside the check rather than inside it: the check counts what is *wrong* and this counts what
   * is *powerful*. A game changer is legal by definition, so folding the number into a button that
   * reads "4 issues" would invent four problems.
   */
  it("counts the game changers", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 2 });

    expect(screen.getByText("2 game changers")).toBeInTheDocument();
  });

  it("counts one game changer in the singular", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 1 });

    expect(screen.getByText("1 game changer")).toBeInTheDocument();
  });

  /** A chip reading `0 game changers` is a control saying there is something to look at. */
  it("draws no game-changer chip at all for a deck that plays none", () => {
    ledger([card({ name: "Bolt" })]);

    expect(screen.queryByText(/game changer/)).not.toBeInTheDocument();
  });

  /** Abbreviated on a narrow column, with the words kept for a screen reader. */
  it("abbreviates the game-changer count when the column is tight", () => {
    ledger([card({ name: "Bolt" })], { gameChangers: 6, tight: true });

    expect(screen.getByText("6 GC")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("6 game changers")).toHaveClass("sr-only");
  });

  /**
   * The three controls at the right end are the caller's, in the order the design draws them:
   * what is wrong, what is powerful, and the bracket the two add up to.
   */
  it("slots the check and the bracket around the game-changer count", () => {
    ledger([card({ name: "Bolt" })], {
      gameChangers: 2,
      check: <button type="button">2 issues</button>,
      bracket: <button type="button">Bracket ~4</button>,
    });

    const wanted = ["2 issues", "2 game changers", "Bracket ~4"];
    const drawn = [...document.querySelectorAll("dl button, dl span")]
      .map((el) => el.textContent ?? "")
      .filter((text) => wanted.includes(text));
    expect(drawn).toEqual(wanted);
  });

  /** A `<dl>` whose children are all `div`s is a valid description list; the design's `span`
   *  separators are not, which is why the hairlines are `div`s and `aria-hidden`. */
  it("keeps every child of the list a div", () => {
    const { container } = ledger([card({ name: "Bolt" })]);
    const list = container.querySelector("dl")!;

    expect([...list.children].every((child) => child.tagName === "DIV")).toBe(true);
  });
});
