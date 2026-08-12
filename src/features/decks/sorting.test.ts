import { describe, expect, it } from "vitest";
import { card } from "./validation/fixtures";
import { SORT_OPTIONS, sortCards } from "./sorting";

const names = (cards: readonly { name: string }[]) => cards.map((c) => c.name);

describe("sortCards", () => {
  it("orders by name, and leaves the input alone", () => {
    const cards = [card({ name: "Sol Ring" }), card({ name: "Arcane Signet" })];
    const sorted = sortCards(cards, "alphabetical", "usd");

    expect(names(sorted)).toEqual(["Arcane Signet", "Sol Ring"]);
    expect(names(cards)).toEqual(["Sol Ring", "Arcane Signet"]);
  });

  /**
   * The curve, cheapest first — and `null` is *unknown*, never zero. An orphaned row has no
   * mana value at all, and sorting it to the head would put it where a reader counts their
   * one-drops.
   */
  it("orders by mana value with unknowns last, then by name", () => {
    const sorted = sortCards(
      [
        card({ name: "Orphan", cmc: null }),
        card({ name: "Bear", cmc: 2 }),
        card({ name: "Ancestral Recall", cmc: 1 }),
        card({ name: "Arcane Signet", cmc: 2 }),
      ],
      "manaCost",
      "usd",
    );

    expect(names(sorted)).toEqual(["Ancestral Recall", "Arcane Signet", "Bear", "Orphan"]);
  });

  /**
   * Descending, because that is what pressing "price" means everywhere else in this app
   * (`firstDir` is descending on money) — and unpriced is still last, which is the one thing
   * a direction must not flip: `null` means "nobody quoted this", not "free".
   */
  it("orders by price, dearest first, with unpriced last", () => {
    const sorted = sortCards(
      [
        card({ name: "Arcane Signet", unitPriceUsd: 0.99 }),
        card({ name: "Orphan", unitPriceUsd: null }),
        card({ name: "Mana Crypt", unitPriceUsd: 168 }),
        card({ name: "Sol Ring", unitPriceUsd: 1.99 }),
      ],
      "price",
      "usd",
    );

    expect(names(sorted)).toEqual(["Mana Crypt", "Sol Ring", "Arcane Signet", "Orphan"]);
  });

  /**
   * **The order follows the currency**, which is the whole reason `sortCards` takes one: the
   * two markets do not rank the same cards the same way, and a deck sorted by dollars while
   * every cell prints euros is a list disagreeing with itself.
   *
   * The fixture is built so the two orders are genuinely reversed rather than incidentally
   * different — nothing here would catch a `currency` argument that was accepted and ignored
   * if the euro prices merely scaled the dollar ones.
   */
  it("ranks by the currency it is given, not always by dollars", () => {
    const cards = [
      card({ name: "Cheap Abroad", unitPriceUsd: 100, unitPriceEur: 1 }),
      card({ name: "Dear Abroad", unitPriceUsd: 1, unitPriceEur: 100 }),
    ];

    expect(names(sortCards(cards, "price", "usd"))).toEqual(["Cheap Abroad", "Dear Abroad"]);
    expect(names(sortCards(cards, "price", "eur"))).toEqual(["Dear Abroad", "Cheap Abroad"]);
  });

  /**
   * An etched printing has no `eur_etched` key to be priced by, so on a euro marketplace it is
   * unpriced — and unpriced sorts last, exactly as an orphan does. It must **not** fall back
   * to the dollar figure and sort to the head of the list as the dearest card in the deck.
   */
  it("sorts a row unpriced in this currency last, however dear it is in the other", () => {
    const sorted = sortCards(
      [
        card({ name: "Etched Bomb", unitPriceUsd: 168, unitPriceEur: null }),
        card({ name: "Sol Ring", unitPriceUsd: 1.99, unitPriceEur: 1.5 }),
      ],
      "price",
      "eur",
    );

    expect(names(sorted)).toEqual(["Sol Ring", "Etched Bomb"]);
  });

  /**
   * One vocabulary with the add path and the type grouping, and the **reading** order of it:
   * Land last, as in every decklist ever written down. What a card *is* comes from
   * `autoCategoryFor`'s matching order (which checks Land first, for Dryad Arbor's sake);
   * where that answer *sits* comes from `AUTO_CATEGORY_DISPLAY_ORDER`.
   */
  it("orders by type in the reading order, lands last, then by name", () => {
    const sorted = sortCards(
      [
        card({ name: "Lightning Bolt", typeLine: "Instant" }),
        card({ name: "Forest", typeLine: "Basic Land — Forest" }),
        card({ name: "Grizzly Bears", typeLine: "Creature — Bear" }),
        card({ name: "Ancient Tomb", typeLine: "Land" }),
        card({ name: "Dryad Arbor", typeLine: "Land Creature — Forest Dryad" }),
        card({ name: "Orphan", typeLine: null }),
      ],
      "type",
      "usd",
    );

    expect(names(sorted)).toEqual([
      "Grizzly Bears",
      "Lightning Bolt",
      // The three lands together at the foot — Dryad Arbor among them, not up with the bear.
      "Ancient Tomb",
      "Dryad Arbor",
      "Forest",
      "Orphan",
    ]);
  });

  /**
   * Stable and total, which is the property every view leans on: two rows the sort cannot
   * tell apart keep the order the read returned them in, so a redraw never shuffles a list
   * under the reader's eyes.
   */
  it("is stable across rows it cannot tell apart", () => {
    const cards = [
      card({ name: "Sol Ring", setCode: "cmm", cmc: 1 }),
      card({ name: "Sol Ring", setCode: "3ed", cmc: 1 }),
      card({ name: "Sol Ring", setCode: "lea", cmc: 1 }),
    ];

    expect(sortCards(cards, "manaCost", "usd").map((c) => c.setCode)).toEqual([
      "cmm",
      "3ed",
      "lea",
    ]);
    expect(sortCards(cards, "alphabetical", "usd").map((c) => c.setCode)).toEqual([
      "cmm",
      "3ed",
      "lea",
    ]);
  });

  /**
   * Total: an orphan is null in every field a sort could read, and a deck full of them is
   * still a deck. A comparator that threw here would take the whole editor down over a card
   * the last sync could not keep.
   */
  it("never throws on a row whose printing has left the card database", () => {
    const orphans = [
      card({ name: "Sword of the Meek", typeLine: null, cmc: null, unitPriceUsd: null }),
      card({ name: "Aether Vial", typeLine: null, cmc: null, unitPriceUsd: null }),
    ];

    for (const option of SORT_OPTIONS) {
      expect(() => sortCards(orphans, option.value, "usd")).not.toThrow();
      expect(sortCards(orphans, option.value, "usd")).toHaveLength(2);
    }
  });

  /** The toolbar's select is built from this list, so the four are named once. */
  it("offers exactly the four orders the toolbar shows", () => {
    expect(SORT_OPTIONS.map((o) => o.value)).toEqual(["alphabetical", "manaCost", "price", "type"]);
    expect(SORT_OPTIONS.map((o) => o.label)).toEqual([
      "Alphabetical",
      "Mana cost",
      "Price",
      "Type",
    ]);
  });
});
