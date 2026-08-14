import { describe, expect, it } from "vitest";
import { card } from "./validation/fixtures";
import { asSortBy, DEFAULT_SORT_BY, SORT_OPTIONS, sortCards } from "./sorting";

const names = (cards: readonly { name: string }[]) => cards.map((c) => c.name);

describe("sortCards", () => {
  it("orders by name, and leaves the input alone", () => {
    const cards = [card({ name: "Sol Ring" }), card({ name: "Arcane Signet" })];
    const sorted = sortCards(cards, "alphabetical");

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
        card({ name: "Arcane Signet", unitPrice: 0.99 }),
        card({ name: "Orphan", unitPrice: null }),
        card({ name: "Mana Crypt", unitPrice: 168 }),
        card({ name: "Sol Ring", unitPrice: 1.99 }),
      ],
      "price",
    );

    expect(names(sorted)).toEqual(["Mana Crypt", "Sol Ring", "Arcane Signet", "Orphan"]);
  });

  /**
   * **The order follows the rows, which is now the only thing it could follow.**
   *
   * `sortCards` took a `Currency` while every row carried two prices, so it needed a test that
   * it ranked by the right one. Rust answers a single `unitPrice` per row at the marketplace
   * the deck was read at, so two marketplaces are two sets of rows rather than two fields — and
   * the order changing with them is the whole behaviour, stated here as two lists that rank
   * genuinely differently rather than as two scalings of one.
   */
  it("ranks by whatever price the rows arrived with", () => {
    const here = [
      card({ name: "Cheap Here", unitPrice: 1 }),
      card({ name: "Dear Here", unitPrice: 100 }),
    ];
    const elsewhere = [
      card({ name: "Cheap Here", unitPrice: 100 }),
      card({ name: "Dear Here", unitPrice: 1 }),
    ];

    expect(names(sortCards(here, "price"))).toEqual(["Dear Here", "Cheap Here"]);
    expect(names(sortCards(elsewhere, "price"))).toEqual(["Cheap Here", "Dear Here"]);
  });

  /**
   * A card the selected marketplace does not quote arrives with a `null` price — an etched
   * printing on Cardmarket (`eur_etched` does not exist), or a printing a bulk feed has never
   * listed. It sorts **last**, exactly as an orphan does, and there is no other number on the
   * row it could be ranked by instead.
   */
  it("sorts a row this marketplace does not price last, however dear it is elsewhere", () => {
    const sorted = sortCards(
      [
        card({ name: "Never listed", unitPrice: null }),
        card({ name: "Sol Ring", unitPrice: 1.99 }),
      ],
      "price",
    );

    expect(names(sorted)).toEqual(["Sol Ring", "Never listed"]);
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

    expect(sortCards(cards, "manaCost").map((c) => c.setCode)).toEqual([
      "cmm",
      "3ed",
      "lea",
    ]);
    expect(sortCards(cards, "alphabetical").map((c) => c.setCode)).toEqual([
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
      card({ name: "Sword of the Meek", typeLine: null, cmc: null, unitPrice: null }),
      card({ name: "Aether Vial", typeLine: null, cmc: null, unitPrice: null }),
    ];

    for (const option of SORT_OPTIONS) {
      expect(() => sortCards(orphans, option.value)).not.toThrow();
      expect(sortCards(orphans, option.value)).toHaveLength(2);
    }
  });

  /**
   * The toolbar's select is built from this list, so the four are named once — membership and
   * the label each order is offered by, which is what this pins.
   *
   * **Not the order the reader sees.** `DeckEditor` puts this array through `sortOptions`
   * before drawing it, so a fifth order appended here lands under its own letter rather than
   * at the end of the dropdown; the picker's own sequence is pinned in `DeckEditor.test.tsx`.
   */
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

/**
 * `DeckRow.lastSortBy` arrives as a `string`, and an order this build does not have has to
 * become one it does — the toolbar's select cannot draw a value that is in none of its options,
 * and a reader stuck in one cannot press their way out.
 */
describe("asSortBy", () => {
  it("keeps every order the toolbar offers", () => {
    for (const option of SORT_OPTIONS) {
      expect(asSortBy(option.value)).toBe(option.value);
    }
  });

  it("falls back to the default for a word this build does not offer", () => {
    expect(asSortBy("rarity")).toBe(DEFAULT_SORT_BY);
    expect(asSortBy("")).toBe(DEFAULT_SORT_BY);
    // The stored word is the union's own spelling — `manacost` is a word, not a near miss.
    expect(asSortBy("manacost")).toBe(DEFAULT_SORT_BY);
    expect(DEFAULT_SORT_BY).toBe("alphabetical");
  });

  /** Derived from {@link SORT_OPTIONS} rather than a second list, so a fifth order appended
   *  there is accepted here in the same edit. */
  it("accepts exactly what the toolbar offers and nothing else", () => {
    const offered = SORT_OPTIONS.map((o) => o.value as string);
    for (const word of [...offered, "name", "added", "category"]) {
      expect(asSortBy(word) === word).toBe(offered.includes(word));
    }
  });
});
