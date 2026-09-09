import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { DeckCard } from "@/lib/ipc";
import { card, islands } from "./validation/fixtures";
import {
  DeckStats,
  deckStats,
  typeCounts,
  type DeckStatsSummary,
  type MissingWrite,
} from "./DeckStats";

/**
 * The two folders this file's stand-in offers.
 *
 * **A `path` and a `name`, because the real component answers with both and they are not the
 * same string.** `WishDestination` draws its rows — and therefore its trigger — by full path, so
 * two drawers called `Someday` can be told apart; `useWishDestinationName` answers the folder's
 * **own** name, which is what a sentence says. A stand-in that returned one string for both
 * would encode a state the real seam cannot produce and would pass over a live region that read
 * the trigger's words instead of asking the hook. The second folder is nested and its own name
 * carries spaces, so neither half is a single word that could pass by accident.
 *
 * `vi.hoisted` because a `vi.mock` factory runs at import time, before a plain module-level
 * `const` has been initialised — a `FOLDERS` declared normally is a temporal-dead-zone throw
 * from inside the factory rather than a working mock.
 */
const FOLDERS = vi.hoisted(() => [
  { id: 1, name: "Ordered", path: "Ordered" },
  { id: 2, name: "Buy at the LGS", path: "Ordered / Buy at the LGS" },
]);

/**
 * The destination control, stood in for — **the seam this file is testing across, not the
 * control itself**.
 *
 * `WishDestination` is the wishlist's own component and owns its own suite; what these cases are
 * about is the wiring on this side of it — which folder id a press carries, when the spent latch
 * lets go, and what the live region says. Mocking it is also what keeps `DeckStats.test.tsx`'s
 * standing property true: the strip renders with **no query client**, which is the reason
 * {@link MissingWrite} is narrowed in the first place, and the real control reads the folder
 * list.
 *
 * Two deliberate simplifications, and neither can flatter the code under test. The rows are
 * always in the DOM rather than behind an opened dropdown, so a test picks a destination in one
 * press; and only two folders and the root are offered. What is faithful is the contract this
 * file depends on: `folderId`/`onChange` as the value pair, `label` as the trigger's whole
 * accessible name, `disabled` reaching the trigger, and `useWishDestinationName` answering
 * `null` at the root **and** for an id that names no folder.
 */
vi.mock("@/features/wishlist/WishDestination", () => ({
  WishDestination: ({
    folderId,
    onChange,
    label,
    disabled,
  }: {
    folderId: number | null;
    onChange: (folderId: number | null) => void;
    label: string;
    size?: "sm" | "md";
    disabled?: boolean;
  }) => (
    <span>
      <button type="button" aria-label={label} disabled={disabled}>
        {FOLDERS.find((folder) => folder.id === folderId)?.path ?? "Wishlist"}
      </button>
      <button type="button" disabled={disabled} onClick={() => onChange(1)}>
        Pick Ordered
      </button>
      <button type="button" disabled={disabled} onClick={() => onChange(2)}>
        Pick the nested folder
      </button>
      <button type="button" disabled={disabled} onClick={() => onChange(null)}>
        Pick the root
      </button>
    </span>
  ),
  useWishDestinationName: (folderId: number | null) =>
    folderId === null
      ? null
      : (FOLDERS.find((folder) => folder.id === folderId)?.name ?? null),
}));

/** The trigger's whole accessible name — one spelling, so a reword is one edit here. */
const DESTINATION = "Which wishlist folder this deck's shortfall goes to";

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

/**
 * A nonland whose printed cost names `{X}` — Agadeem's Awakening's shape, which is the one real
 * `{X}` printing the Storybook corpus carries and a cost this app has to get right twice.
 *
 * **Its mana value is 3, not 4 and not unknown**: X is zero everywhere but on the stack
 * (CR 202.3b), so `{X}{B}{B}{B}` is three black pips. That is what makes it the interesting
 * fixture — the card has a perfectly good numeric bucket, and the toggle is a decision to draw
 * it somewhere else anyway.
 */
function xSpell(name: string, overrides: Partial<DeckCard> = {}): DeckCard {
  return card({ name, cmc: 3, typeLine: "Sorcery", manaCost: "{X}{B}{B}{B}", ...overrides });
}

/**
 * The type bars' own bucketing.
 *
 * These cases came here from `ZoneColumn.test.tsx` with the function they test. While the deck
 * list was a column of type headings, one derivation served both the headings and the bars —
 * "a bar and the heading over the rows it counts must never be two derivations of one thing".
 * Schema v8's rebuild draws headings from `grouping.ts` (whose type vocabulary checks `Land`
 * first, so that a card is *filed* where a decklist would put it), so this is now one surface's
 * arithmetic and belongs with the surface.
 */
describe("typeCounts", () => {
  /**
   * The eight printed types in the order they are printed on a card, and the ninth bucket that
   * is not a type: `Other` is where a token, a scheme or a row whose printing has left the card
   * database lands, and it sorts last because it is a remainder rather than a kind.
   */
  it("buckets by the printed types, in printed order, dropping the empty ones", () => {
    const bars = typeCounts([
      card({ name: "Wastes", typeLine: "Basic Land" }),
      card({ name: "Bolt", typeLine: "Instant" }),
      card({ name: "Bear", typeLine: "Creature — Bear" }),
      card({ name: "Relic", typeLine: "Artifact" }),
    ]);

    expect(bars.map((b) => b.label)).toEqual(["Creature", "Instant", "Artifact", "Land"]);
  });

  /** A card with two types is filed under the first one printed order names — an Artifact
   *  Creature is a creature to everyone who has ever built a deck. */
  it("files a card with two types under the earlier of them", () => {
    expect(
      typeCounts([card({ name: "Golem", typeLine: "Artifact Creature — Golem" })]).map(
        (b) => b.label,
      ),
    ).toEqual(["Creature"]);
  });

  /** A double-faced card is what its front says it is: the back of a werewolf is still a
   *  creature, but the back of an adventure or a modal DFC often is not. */
  it("reads the front face's type line and nothing after the slashes", () => {
    expect(
      typeCounts([card({ name: "Trap", typeLine: "Land // Instant — Adventure" })]).map(
        (b) => b.label,
      ),
    ).toEqual(["Land"]);
  });

  /** The orphan case: `deck_cards LEFT JOIN cards` answers a row with nulls, and it is still a
   *  card in the deck. It is counted rather than dropped. */
  it("puts a row with no type line in Other, last", () => {
    expect(
      typeCounts([
        card({ name: "Ghost", typeLine: null }),
        card({ name: "Bolt", typeLine: "Instant" }),
      ]).map((b) => b.label),
    ).toEqual(["Instant", "Other"]);
  });

  /** A count on a deck is copies, never rows — four Bolts are four cards. */
  it("counts copies rather than rows", () => {
    const bars = typeCounts([
      card({ name: "Bolt", typeLine: "Instant", quantity: 4 }),
      card({ name: "Bolt2", typeLine: "Instant", quantity: 2 }),
    ]);

    expect(bars).toHaveLength(1);
    expect(bars[0].count).toBe(6);
  });
});

/**
 * `deckStats`, under the name the assertions below were written against.
 *
 * It took a currency while every row carried two prices; the rows carry one now, priced by the
 * backend at the marketplace the deck was read at, so there is nothing to pass. The alias
 * stays because it reads as "the ordinary case" at forty call sites that are about curves,
 * pies and sizes rather than about money.
 */
const usdStats = (cards: readonly DeckCard[]) => deckStats(cards);

describe("deckStats", () => {
  /** The curve is the deck's casting costs: nine buckets, and the last one is open-ended —
   *  a 12-drop is still a card you have to reach. */
  it("buckets the curve over nonlands, with the last bucket open-ended", () => {
    const stats = usdStats([
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
    const stats = usdStats([spell("Counterspell", 0, { cmc: null, manaCost: "{U}{U}" })]);

    expect(stats.curve[2]).toBe(1);
    expect(stats.unknownManaValue).toBe(0);
  });

  /** An orphaned row has no cost at all, and 0 is a number this app would be making up. */
  it("leaves a card with no mana value out of the curve and the average", () => {
    const stats = usdStats([
      spell("Bolt", 1),
      card({ name: "Ghost", cmc: null, manaCost: null, typeLine: null }),
    ]);

    expect(stats.curve[0]).toBe(0);
    expect(stats.unknownManaValue).toBe(1);
    expect(stats.averageManaValue).toBe(1);
  });

  /**
   * The deck the four `{X}` cases below are all measured over: 4 X spells at mana value 3, 4
   * one-drops, an orphan with no mana value at all, and lands that reach none of it.
   *
   * One fixture rather than four, because the whole claim about this toggle is that it moves a
   * card between two bars and changes nothing else — which is only checkable if the two modes
   * are read off the same rows.
   */
  const withX = (): DeckCard[] => [
    xSpell("Awakening", { quantity: 4 }),
    spell("Bolt", 1, { quantity: 4 }),
    card({ name: "Ghost", cmc: null, manaCost: null, typeLine: null }),
    islands(20),
  ];

  /** Off is the column's default and the reading every curve in this app had before: an X spell
   *  sits in the bucket its mana value names, and there is no tenth bar at all. */
  it("counts an {X} spell in its numeric bucket until the deck asks for the split", () => {
    const stats = usdStats(withX());

    expect(stats.curve[3]).toBe(4);
    // `null`, never `0` — the difference between "no X bar" and "an X bar with nothing in it".
    expect(stats.variableCost).toBeNull();
  });

  /** On, it leaves that bucket — **one home, never two**, which is the whole of what keeps the
   *  bars addable. */
  it("moves an {X} spell out of its numeric bucket and into the X bar", () => {
    const stats = deckStats(withX(), true);

    expect(stats.curve[3]).toBe(0);
    expect(stats.variableCost).toBe(4);
  });

  /**
   * The property the two tests above are two halves of: every nonland is in exactly one of the
   * ten bars or in the "no mana value" line, so the chart still adds up to the number printed
   * beside it.
   *
   * Asserted as a sum rather than bucket by bucket, because a card counted twice and a card
   * dropped are both invisible to an assertion that names one bucket.
   */
  it("keeps the bars summing to the nonland count in both modes", () => {
    const drawn = (stats: DeckStatsSummary) =>
      stats.curve.reduce((n, count) => n + count, 0) +
      (stats.variableCost ?? 0) +
      stats.unknownManaValue;

    expect(drawn(usdStats(withX()))).toBe(9);
    expect(drawn(deckStats(withX(), true))).toBe(9);
    expect(usdStats(withX()).nonlands).toBe(9);
  });

  /**
   * **The one number the toggle must not move.**
   *
   * An `{X}` spell costs what it costs with X at zero (CR 202.3b), and this switch is a display
   * choice about which pile a card is drawn in — not a claim that Agadeem's Awakening has
   * stopped costing three. A reader who split their X spells out to see the rest of the curve
   * more clearly has not changed their deck, and an average that moved under them would be this
   * strip inventing a fact about it. 8 nonlands with a mana value, `(3 × 4 + 1 × 4) / 8`.
   */
  it("counts an {X} spell at its printed mana value in the average, in both modes", () => {
    expect(usdStats(withX()).averageManaValue).toBe(2);
    expect(deckStats(withX(), true).averageManaValue).toBe(2);
  });

  /**
   * The X bar is decided by the **printed cost** and the numeric bucket by `cmc`, so a row that
   * has one and not the other still lands in the right place.
   *
   * `cards.cmc` is nullable and `manaValue` falls back to `manaValueOf` — which reads
   * `{X}{B}{B}{B}` as 3, X being zero — so this row is not an unknown mana value and must not be
   * counted as one. It is the case where reading the split off `cmc` instead of the cost would
   * have quietly filed a real X spell under "no mana value, not counted".
   */
  it("reaches the X bar off the printed cost when the row has no cmc", () => {
    const stats = deckStats([xSpell("Awakening", { cmc: null })], true);

    expect(stats.variableCost).toBe(1);
    expect(stats.unknownManaValue).toBe(0);
    expect(stats.averageManaValue).toBe(3);
  });

  /** `{Y}` and `{Z}` are not X, which is `hasVariableCost`'s own ruling rather than this file's:
   *  they appear on a handful of Un-cards, and a heading reading X over a card printing no X
   *  would be a label telling the reader a lie about the cardboard in front of them. */
  it("leaves a {Y} cost in its numeric bucket even with the split on", () => {
    const stats = deckStats([card({ name: "Ashnod's Coupon", cmc: 0, manaCost: "{Y}" })], true);

    expect(stats.curve[0]).toBe(1);
    expect(stats.variableCost).toBe(0);
  });

  /** Pips, not cards: a WU card is white *and* blue, which is what makes this the "what can
   *  this deck cast" measure rather than a second colour pie. */
  it("counts pips per colour, so a two-colour card feeds both", () => {
    const stats = usdStats([
      card({ name: "Fractured Identity", colors: "WU", quantity: 2 }),
      card({ name: "Bolt", colors: "R", quantity: 4 }),
    ]);

    expect(stats.pips).toEqual({ W: 2, U: 2, B: 0, R: 4, G: 0 });
  });

  /** `colors`, never `colorIdentity`: the curve strip describes what a card costs, and a
   *  Kenrith in the command zone does not make the deck's spells five-coloured. */
  it("takes the pips from a card's colours and not from its identity", () => {
    const stats = usdStats([card({ name: "Ancestral", colors: "U", colorIdentity: "WUBRG" })]);

    expect(stats.pips).toEqual({ W: 0, U: 1, B: 0, R: 0, G: 0 });
  });

  it("averages mana value over nonlands only", () => {
    const stats = usdStats([spell("A", 1), spell("B", 3), islands(10)]);

    expect(stats.averageManaValue).toBe(2);
  });

  it("has no average to give for a deck of nothing but lands", () => {
    expect(usdStats([islands(10)]).averageManaValue).toBeNull();
  });

  /** `unitPriceUsd` is the row's own finish-correct `usd`. `cards.price_usd` is a display
   *  fallback chain and must never be summed. */
  it("sums the row price by copies and counts what it could not price", () => {
    const stats = usdStats([
      spell("Bolt", 1, { quantity: 4, unitPrice: 2.5 }),
      spell("Bear", 2, { quantity: 2, unitPrice: null }),
    ]);

    expect(stats.price).toBe(10);
    expect(stats.unpriced).toBe(2);
  });

  it("has no price at all when nothing in the deck is priced", () => {
    expect(usdStats([spell("Bolt", 1, { unitPrice: null })]).price).toBeNull();
  });

  /**
   * **The `unpriced` count belongs to the figure beside it**, which is the half worth pinning
   * now that the marketplace is a query parameter: no two marketplaces have the same holes, so
   * the same deck is fully priced at one and partly unpriced at another, and the count has to
   * arrive with the total rather than be carried across a switch.
   *
   * Nothing falls back — a row this marketplace does not quote arrives as a `null` `unitPrice`
   * and is *counted*, never charged at anything, because a price nobody quoted is worse than an
   * em dash beside "2 unpriced". There is no second field on the row to borrow from any more,
   * which is the mistake this shape retires rather than guards against.
   */
  it("counts the copies it could not price beside the total that omits them", () => {
    const wholePriced = [
      spell("Bolt", 1, { quantity: 4, unitPrice: 2.5 }),
      spell("Rare Bomb", 2, { quantity: 2, unitPrice: 50 }),
    ];
    const priced = deckStats(wholePriced);
    expect(priced.price).toBe(110);
    expect(priced.unpriced).toBe(0);

    // The same deck read at a marketplace that does not list the second card.
    const partly = [
      spell("Bolt", 1, { quantity: 4, unitPrice: 2 }),
      spell("Rare Bomb", 2, { quantity: 2, unitPrice: null }),
    ];
    const gappy = deckStats(partly);
    expect(gappy.price).toBe(8);
    expect(gappy.unpriced).toBe(2);
  });

  it("has no price at all for a deck this marketplace lists none of", () => {
    const unlisted = [spell("Rare Bomb", 2, { quantity: 2, unitPrice: null })];

    expect(deckStats(unlisted).price).toBeNull();
    expect(deckStats(unlisted).unpriced).toBe(2);
  });

  /** The same arithmetic every row's own badge does, added up once. */
  it("agrees with the rows about owned and missing", () => {
    const stats = usdStats([
      spell("Bolt", 1, { quantity: 4, ownedQuantity: 1 }),
      spell("Bear", 2, { quantity: 2, ownedQuantity: 2 }),
    ]);

    expect(stats.copies).toBe(6);
    expect(stats.owned).toBe(3);
    expect(stats.missing).toBe(3);
  });

  /** Every nonland lands in exactly one bucket, so the buckets can be a pie. */
  it("buckets nonlands into mono, multicolour and colourless", () => {
    const stats = usdStats([
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
    const stats = usdStats([
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
   * `typeCounts` files a card under the **first** type printed on it, so Urza's Saga heads up
   * the Enchantment bar — which is right for the bars, because the question a bar answers is
   * what a card *does*. Everywhere else the type line decides: a deckbuilder counts
   * Urza's Saga among their lands, and it costs nothing to put onto the battlefield, so the
   * curve would file it under 0 — the very flood the curve excludes lands to avoid.
   */
  it("keeps a land that is not filed under Land a land to every chart but the type bars", () => {
    const stats = usdStats([
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
    const stats = usdStats([
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
    const stats = usdStats([
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
    const stats = usdStats([
      spell("Bolt", 1, { quantity: 4, unitPrice: 1 }),
      spell("Ghost", 5, { categoryKind: "maybe", quantity: 9, unitPrice: 100 }),
    ]);

    expect(stats.copies).toBe(4);
    expect(stats.curve[5]).toBe(0);
    expect(stats.price).toBe(4);
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
    const stats = usdStats([
      spell("Bolt", 1, { quantity: 4, unitPrice: 1 }),
      spell("Ghost", 5, {
        categoryId: 7,
        categoryName: "Cuts",
        categoryKind: "main",
        categoryActive: false,
        quantity: 9,
        unitPrice: 100,
      }),
    ]);

    expect(stats.sized).toBe(4);
    expect(stats.copies).toBe(4);
    expect(stats.curve[5]).toBe(0);
    expect(stats.price).toBe(4);
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

    expect(usdStats([spell("Bolt", 1, { quantity: 4 }), parked]).sized).toBe(4);

    const on = usdStats([spell("Bolt", 1, { quantity: 4 }), played]);
    expect(on.sized).toBe(13);
    expect(on.curve[5]).toBe(9);
    // In the size, so *not* in the note that accounts for what the size left out.
    expect(on.elsewhere).toEqual([]);
  });

  /** The sideboard is part of what a deck costs and what it is short of: it is cards you
   *  own, sleeve and pay for. */
  it("counts every active category", () => {
    const stats = usdStats([
      spell("Bolt", 1, { quantity: 4 }),
      spell("Pyroblast", 1, { categoryKind: "side", quantity: 2 }),
    ]);

    expect(stats.copies).toBe(6);
  });
});

describe("DeckStats", () => {
  /**
   * The strip, rendered.
   *
   * **`onPull` and `onAddMissing` both default to `null`**, which is the theory list's answer
   * rather than the ordinary one — deliberately, because every case below this line is about the
   * wishlist half, and either live callback would put another button into each of their queries
   * for nothing. The cases that are about one of the other two presses pass it and say so.
   *
   * **`tracksCollection` defaults to `true`**, which is the ordinary deck and what every case
   * above the virtual-deck block is a claim about — so those cases go on asserting the shortfall
   * exactly as they did before the prop existed, which is the regression this change most needs
   * to keep. The `false` arm is passed explicitly, and only there.
   */
  const strip = (
    cards: DeckCard[],
    send = sender(),
    onPull: (() => void) | null = null,
    onAddMissing: (() => void) | null = null,
    tracksCollection = true,
  ) =>
    render(
      <TooltipProvider>
        <DeckStats
          tracksCollection={tracksCollection}
          cards={cards}
          send={send}
          onPull={onPull}
          onAddMissing={onAddMissing}
        />
      </TooltipProvider>,
    );

  /** A deck short of three copies of one card. */
  const short = (): DeckCard[] => [card({ name: "Bolt", quantity: 4, ownedQuantity: 1 })];

  /**
   * Press the button, then let the write settle — the flow the strip actually has, and the one
   * the answer is scoped to: the sentence and the spent button both hang off the shortfall the
   * *press* was made against, not off a mutation flag that stays true forever.
   */
  async function press(cards: DeckCard[], settled: MissingWrite) {
    const view = render(
      <DeckStats
        tracksCollection
        cards={cards}
        send={sender()}
        onPull={null}
        onAddMissing={null}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
    view.rerender(
      <DeckStats tracksCollection cards={cards} send={settled} onPull={null} onAddMissing={null} />,
    );
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
    // Nine bars, because this deck is not splitting its X spells out. The tenth is the next
    // test's, and its absence here is what makes that one a claim about the toggle.
    expect(within(curve).getAllByRole("listitem")).toHaveLength(9);
  });

  /**
   * The tenth bar, and it is drawn **only** when the deck asks for it.
   *
   * The chart is `aria-hidden` but for one `sr-only` sentence per bar, so that sentence is both
   * the whole accessible story and the only thing a test can address — which is why the X bar
   * gets exactly the treatment the numbered nine get rather than a `title` of its own. The
   * sentence says "with X in their cost" rather than `{X}`: braces are not something a screen
   * reader says.
   */
  it("draws the X bar only for a deck that is splitting its {X} spells out", () => {
    const deck = [xSpell("Awakening", { quantity: 4 }), spell("Bolt", 1, { quantity: 4 })];
    const { rerender } = strip(deck);

    const curve = () => screen.getByRole("list", { name: "Mana curve" });
    expect(within(curve()).queryByText(/with X in their cost/)).not.toBeInTheDocument();
    expect(within(curve()).getByText("4 cards at mana value 3")).toBeInTheDocument();

    rerender(
      <DeckStats
        tracksCollection
        cards={deck}
        send={sender()}
        onPull={null}
        onAddMissing={null}
        separateXGroup
      />,
    );

    expect(within(curve()).getAllByRole("listitem")).toHaveLength(10);
    expect(within(curve()).getByText("4 cards with X in their cost")).toBeInTheDocument();
    // And they left the bucket they were in, so the two bars are not the same four cards
    // counted twice.
    expect(within(curve()).getByText("0 cards at mana value 3")).toBeInTheDocument();
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

  /** The figures moved to the header's ledger on 2026-08-24, so an empty deck draws the pips
   *  row and nothing else at all — see `DeckLedger.test.tsx` for the numbers. */
  it("draws no chart at all for an empty deck", () => {
    strip([]);

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

  /** Spec §5: a price never appears without saying how old it is — and, now that a reader can
   *  pick, whose it is. */
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

    // **`null` and never a bare `toHaveBeenCalled()`**: the press carries a destination since
    // issue #437, and the root is what it carries until the reader says otherwise — which is
    // exactly the behaviour this line has always been about, now stated in the argument as well
    // as in the absence of one. Asserted here rather than only in the destination block below,
    // because this is the case every deck meets.
    expect(send.mutate).toHaveBeenCalledWith(null);
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

  /**
   * The final-review fix, evidenced: `useTooltip.ts`'s `onFocus` used to hand the wrapping
   * `<span>` to `TooltipProvider.focus()`, which tests `:focus-visible` on it — and a `<span>`
   * with no `tabIndex` is never itself focused, so Tab landing on this button opened nothing at
   * all. Unwrapped now, with the binder testing `e.target` (the button, which really was
   * focused) rather than `e.currentTarget`, Tab opens the hint exactly like every other
   * converted control's — and `aria-describedby` lands on the button holding the caret.
   */
  it("opens the shortfall hint on Tab once the button is spent", async () => {
    const settled = sender({ isSuccess: true, data: 1 });
    const view = render(
      <TooltipProvider>
        <DeckStats
          tracksCollection
          cards={short()}
          send={sender()}
          onPull={null}
          onAddMissing={null}
        />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
    view.rerender(
      <TooltipProvider>
        <DeckStats
          tracksCollection
          cards={short()}
          send={settled}
          onPull={null}
          onAddMissing={null}
        />
      </TooltipProvider>,
    );

    const button = screen.getByRole("button", { name: "Send missing to wishlist" });
    expect(button).toHaveAttribute("aria-disabled", "true");

    // The click above already focused this button (a real browser focuses whatever it presses),
    // so it is already `document.activeElement` — a second `.focus()` on an element that is
    // already focused fires no event at all, jsdom included, and would prove nothing. Blur it
    // first, the way the caret-restore test below this one does for the same reason.
    act(() => button.blur());
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => button.focus());

    const panel = screen.getByRole("tooltip");
    expect(panel).toHaveTextContent("This shortfall is already on your wishlist.");
    expect(button).toHaveAttribute("aria-describedby", panel.id);
  });

  it("offers it again once the shortfall is a different one", async () => {
    const deck = short();
    const { rerender } = await press(deck, sender({ isSuccess: true, data: 1 }));

    rerender(
      <DeckStats
        tracksCollection
        cards={[card({ name: "Bolt", quantity: 4, ownedQuantity: 1 }), card({ name: "Bear" })]}
        send={sender({ isSuccess: true, data: 1 })}
        onPull={null}
        onAddMissing={null}
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
      <DeckStats
        tracksCollection
        cards={[card({ name: "Bolt", quantity: 5, ownedQuantity: 1 })]}
        send={settled}
        onPull={null}
        onAddMissing={null}
      />,
    );
    // …and back to exactly the number that was sent.
    rerender(
      <DeckStats tracksCollection cards={deck} send={settled} onPull={null} onAddMissing={null} />,
    );

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
   * **The shortfall has two answers and this line offers both**, in the order they should be
   * tried: what you already own is the cheaper one and comes first, and the shopping list is
   * what is left over.
   *
   * The order is asserted through the DOM rather than trusted, because both buttons are in one
   * wrapping flex row: swapping them changes nothing about either query and everything about
   * which one a reader reaches for.
   */
  it("offers the pull beside the wishlist, and offers it first", () => {
    strip(short(), sender(), vi.fn());

    const pull = screen.getByRole("button", { name: "Pull from collection" });
    const send = screen.getByRole("button", { name: "Send missing to wishlist" });
    expect(pull.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("presses the callback it was handed", async () => {
    const onPull = vi.fn();
    strip(short(), sender(), onPull);

    await userEvent.click(screen.getByRole("button", { name: "Pull from collection" }));

    expect(onPull).toHaveBeenCalledTimes(1);
  });

  /**
   * `null` is the **theory** list, which holds no cardboard — so there is nothing on that tab to
   * pull copies *into*, and the button is absent rather than greyed. Not because the plan is
   * short of nothing: since 2026-09-09 the band beside this button says exactly what it is short
   * of (issue #435), and `deck_pull_plan` still takes no variant.
   *
   * The wishlist button is asserted *present* in the same breath, which is the half that makes
   * this a claim about the prop: a strip drawing neither would pass a bare absence check while
   * being broken for both.
   */
  it("draws no pull button where there is nothing to pull into", () => {
    strip(short(), sender(), null);

    expect(screen.queryByRole("button", { name: "Pull from collection" })).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Send missing to wishlist" }),
    ).toBeInTheDocument();
  });

  /**
   * The second absence, and it is a different one: a deck short of nothing has no hole for a
   * pull to fill, so the pair goes together even with a live callback in hand.
   */
  it("draws no pull button when the deck is fully owned", () => {
    strip([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })], sender(), vi.fn());

    expect(screen.queryByRole("button", { name: "Pull from collection" })).not.toBeInTheDocument();
  });

  /**
   * **The two writes are independent and the controls have to say so.**
   *
   * `send` spends about half a second genuinely `disabled` while its command is in flight, and
   * stays `aria-disabled` for as long as the shortfall it was pressed against is the one on
   * screen. Neither is a reason the reader cannot go and look at what they already own — the
   * pull reads a different question and writes a different table — and a control greyed by its
   * neighbour's state is a control whose refusal nothing on screen explains.
   */
  it("leaves the pull pressable while the wishlist write is in flight and after it is spent", async () => {
    const onPull = vi.fn();
    const { rerender } = strip(short(), sender(), onPull);

    // In flight: `send` is really `disabled`, which is the browser's own "no".
    rerender(
      <TooltipProvider>
        <DeckStats
          tracksCollection
          cards={short()}
          send={sender({ isPending: true })}
          onPull={onPull}
          onAddMissing={null}
        />
      </TooltipProvider>,
    );
    expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toBeDisabled();
    const pull = screen.getByRole("button", { name: "Pull from collection" });
    expect(pull).toBeEnabled();
    expect(pull).not.toHaveAttribute("aria-disabled");

    await userEvent.click(pull);
    expect(onPull).toHaveBeenCalledTimes(1);
  });

  /**
   * And the traffic does not run the other way either: pressing the pull must not spend the
   * wishlist button. The two share a number and nothing else — the spent flag is scoped to the
   * shortfall a `send` press was made against, and a pull writes no wish at all.
   */
  it("does not spend the wishlist button when the pull is pressed", async () => {
    const send = sender();
    strip(short(), send, vi.fn());

    await userEvent.click(screen.getByRole("button", { name: "Pull from collection" }));

    const button = screen.getByRole("button", { name: "Send missing to wishlist" });
    expect(button).not.toHaveAttribute("aria-disabled");
    await userEvent.click(button);
    expect(send.mutate).toHaveBeenCalledTimes(1);
  });

  /**
   * **The shortfall has three answers and this line offers all three**, in the order they should
   * be tried: what you already own is the cheapest, what you have just bought is cardboard the
   * database has never heard of, and the shopping list is what is left over.
   *
   * The order is asserted through the DOM rather than trusted, because all three sit in one
   * wrapping flex row: reordering them changes nothing about any of their queries and everything
   * about which one a reader reaches for. Moving the add press after the wishlist would offer a
   * shopping list before "record what you bought", which is two states of one purchase the wrong
   * way round.
   */
  it("offers the add press between the pull and the wishlist", () => {
    strip(short(), sender(), vi.fn(), vi.fn());

    const pull = screen.getByRole("button", { name: "Pull from collection" });
    const add = screen.getByRole("button", { name: "Add missing to collection" });
    const send = screen.getByRole("button", { name: "Send missing to wishlist" });
    expect(pull.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(add.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  /**
   * **The three are peers, and the shared class list is the whole of what says so** — copied
   * character for character rather than trimmed, including the two state variants nothing here
   * can currently reach, so the row cannot drift into reading as a primary and two secondaries.
   *
   * Compared as sorted `classList` tokens and never with `className.includes`: this list carries
   * `hover:text-text` and `aria-disabled:opacity-50` as *variants*, so a substring check for
   * either finds the variant and passes before any state has changed.
   */
  it("draws the three presses on one class list, character for character", () => {
    strip(short(), sender(), vi.fn(), vi.fn());

    const tokens = (name: string) => [...screen.getByRole("button", { name }).classList].sort();

    expect(tokens("Add missing to collection")).toEqual(tokens("Pull from collection"));
    expect(tokens("Add missing to collection")).toEqual(tokens("Send missing to wishlist"));
  });

  /**
   * The shortfall gate takes all three together, and both callbacks are live here — so what is
   * absent below is the `missing > 0` arm rather than a prop. A deck short of nothing has no hole
   * for any of them to act on, and a control that spends its life offering to do nothing teaches
   * the reader to stop looking at the line it is in.
   */
  it("draws none of the three presses when the deck is fully owned", () => {
    strip([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })], sender(), vi.fn(), vi.fn());

    expect(screen.queryByRole("button", { name: "Pull from collection" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add missing to collection" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Send missing to wishlist" }),
    ).not.toBeInTheDocument();
  });

  /**
   * `null` is the **theory** list, which holds no cardboard — so there is nowhere there to record
   * copies *to*, and the press is absent rather than greyed exactly as the pull is. The shortfall
   * beside it is real on that tab since 2026-09-09 (issue #435); what is absent is the place to
   * put the answer, not the question.
   *
   * The other two are asserted *present* in the same breath, which is the half that makes this a
   * claim about the prop: a strip drawing none of the three would pass a bare absence check while
   * being broken for all of them.
   */
  it("draws no add press where there is nothing to add to, and keeps the other two", () => {
    strip(short(), sender(), vi.fn(), null);

    expect(
      screen.queryByRole("button", { name: "Add missing to collection" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pull from collection" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toBeInTheDocument();
  });

  it("presses the add callback it was handed", async () => {
    const onAddMissing = vi.fn();
    strip(short(), sender(), null, onAddMissing);

    await userEvent.click(screen.getByRole("button", { name: "Add missing to collection" }));

    expect(onAddMissing).toHaveBeenCalledTimes(1);
  });

  /**
   * **The first of the two claims that make this press not its right-hand neighbour.**
   *
   * `send` spends about half a second genuinely `disabled` while its command is in flight. These
   * are three independent writes about one number — the wishlist writes a list, this one creates
   * collection rows — so a control greyed by a sibling's state is a control whose refusal nothing
   * on screen explains.
   */
  it("leaves the add press pressable while the wishlist write is in flight", async () => {
    const onAddMissing = vi.fn();
    render(
      <TooltipProvider>
        <DeckStats
          tracksCollection
          cards={short()}
          send={sender({ isPending: true })}
          onPull={null}
          onAddMissing={onAddMissing}
        />
      </TooltipProvider>,
    );

    // The neighbour really is refusing, so the liveness below is a fact about this control
    // rather than about a state the strip never entered.
    expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toBeDisabled();
    const add = screen.getByRole("button", { name: "Add missing to collection" });
    expect(add).toBeEnabled();
    expect(add).not.toHaveAttribute("aria-disabled");

    await userEvent.click(add);
    expect(onAddMissing).toHaveBeenCalledTimes(1);
  });

  /**
   * **The second claim, and it is the one with a rule behind it: this press has no `spent` state
   * at all.**
   *
   * The wishlist button is spent after a press because `missing_to_wishlist` *folds* quantities
   * rather than replacing them, so pressing again wishes for the same copies a second time. This
   * one cannot go wrong that way: it re-plans inside its own transaction against a shortfall the
   * first press just closed, so a second press finds nothing left to offer. It therefore stays
   * live beside a spent neighbour — and stays live for a second press, which is the half a
   * `spent` flag copied across from the wishlist would break.
   */
  it("keeps the add press live after the wishlist press is spent", async () => {
    const deck = short();
    const onAddMissing = vi.fn();
    const settled = sender({ isSuccess: true, data: 1 });
    const view = render(
      <TooltipProvider>
        <DeckStats
          tracksCollection
          cards={deck}
          send={sender()}
          onPull={null}
          onAddMissing={onAddMissing}
        />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
    view.rerender(
      <TooltipProvider>
        <DeckStats
          tracksCollection
          cards={deck}
          send={settled}
          onPull={null}
          onAddMissing={onAddMissing}
        />
      </TooltipProvider>,
    );

    // Spent, so the add's own liveness below is measured against a neighbour that really did
    // enter the state this test is about.
    expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );

    const add = screen.getByRole("button", { name: "Add missing to collection" });
    expect(add).toBeEnabled();
    expect(add).not.toHaveAttribute("aria-disabled");

    await userEvent.click(add);
    await userEvent.click(add);
    expect(onAddMissing).toHaveBeenCalledTimes(2);
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
    const { rerender } = render(
      <DeckStats tracksCollection cards={deck} send={sender()} onPull={null} onAddMissing={null} />,
    );
    const button = screen.getByRole("button", { name: "Send missing to wishlist" });
    await userEvent.click(button);
    button.focus();

    // What a browser does to a focused control that becomes disabled, and jsdom does not:
    // blurs it with no `relatedTarget` at all, so the caret lands on `<body>`. Blurred before
    // the disabling render because jsdom refuses to blur an element that is already disabled
    // (a disabled control is not focusable, so `blur()` returns early) — the state under test
    // is the same one either way.
    button.blur();
    rerender(
      <DeckStats
        tracksCollection
        cards={deck}
        send={sender({ isPending: true })}
        onPull={null}
        onAddMissing={null}
      />,
    );
    expect(document.body).toHaveFocus();

    rerender(
      <DeckStats
        tracksCollection
        cards={deck}
        send={sender({ isSuccess: true, data: 3 })}
        onPull={null}
        onAddMissing={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toHaveFocus();
  });

  /**
   * **The destination beside the wishlist press (issue #437).**
   *
   * The press filed at the wishlist root and offered no choice; it now carries a picker for the
   * root, an existing folder, or a new one. Every case here is about the **wiring** — which
   * folder id a press carries, when the spent latch lets go, and what the live region says —
   * because the control itself is the wishlist's and has its own suite. See the `vi.mock` at the
   * top of this file for what is faithful about the stand-in and what is simplified.
   */
  describe("the wishlist destination", () => {
    /**
     * Pick a destination, press, then let the write settle — {@link press} with the one extra
     * act a folder adds, so the two flows differ by exactly the thing under test.
     *
     * The idle `send` is returned rather than kept private, because half of these cases are
     * about the **argument** the press carried and the other half about the sentence that
     * followed it.
     */
    async function pressAt(cards: DeckCard[], pick: string, settled: MissingWrite) {
      const idle = sender();
      const view = render(
        <DeckStats
          tracksCollection
          cards={cards}
          send={idle}
          onPull={null}
          onAddMissing={null}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: pick }));
      await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
      view.rerender(
        <DeckStats
          tracksCollection
          cards={cards}
          send={settled}
          onPull={null}
          onAddMissing={null}
        />,
      );
      return { ...view, idle };
    }

    /**
     * The whole of what the picker is for: the id reaches the write.
     *
     * Both halves in one case on purpose — a press before any pick and a press after one — so
     * that an implementation which hard-coded `null` fails on the second half rather than
     * passing a test that only ever checked the default. The root half is the same claim
     * `counts what the deck is short of, and offers to wish for it` makes above; it is repeated
     * here against the *same* mounted strip, which is what makes the pair a before/after rather
     * than two decks.
     */
    it("sends the folder the reader picked, and the root until they pick one", async () => {
      const send = sender();
      strip(short(), send);

      await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
      expect(send.mutate).toHaveBeenLastCalledWith(null);

      await userEvent.click(screen.getByRole("button", { name: "Pick Ordered" }));
      await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));

      expect(send.mutate).toHaveBeenLastCalledWith(1);
      expect(send.mutate).toHaveBeenCalledTimes(2);
    });

    /**
     * **The spent latch keys on the destination as well as on the shortfall, and this is the
     * case that says why.** `add_wish` folds on the wishlist's own grain, whose fourth term is
     * `coalesce(folder_id, 0)` — so the same shortfall sent to the root and then to `Ordered` is
     * a genuinely new line rather than a fold, and a button still greyed with *This shortfall is
     * already on your wishlist.* would be refusing a press that has not happened.
     *
     * The `aria-disabled` before the pick is the half that makes the release a claim: without
     * it, a strip that never latched at all would pass the second half.
     */
    it("releases the spent button when the destination changes", async () => {
      const settled = sender({ isSuccess: true, data: 1 });
      await press(short(), settled);
      expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );

      await userEvent.click(screen.getByRole("button", { name: "Pick Ordered" }));

      const button = screen.getByRole("button", { name: "Send missing to wishlist" });
      expect(button).not.toHaveAttribute("aria-disabled");
      await userEvent.click(button);
      expect(settled.mutate).toHaveBeenCalledWith(1);
    });

    /**
     * And it stays spent for the destination it was actually sent to, which is the other
     * direction of the same rule: a latch that released on *any* render of the picker would
     * make a second press at one folder legal, and that press really does fold — six wished for
     * a shortfall of three, answering the same cheerful number both times.
     */
    it("keeps the button spent while the destination is the one it was sent to", async () => {
      const settled = sender({ isSuccess: true, data: 1 });
      const { idle } = await pressAt(short(), "Pick Ordered", settled);
      // The press that armed the latch really did carry the folder, so what is refused below is
      // a *second* press at `Ordered` rather than a strip that never sent anything.
      expect(idle.mutate).toHaveBeenCalledWith(1);

      const button = screen.getByRole("button", { name: "Send missing to wishlist" });
      expect(button).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(button);

      expect(settled.mutate).not.toHaveBeenCalled();
    });

    /**
     * **The answer goes with the question here too.** The live region's sentence is gated on the
     * same latch, so changing the destination clears it — a *"Added 1 wish to Ordered"* left
     * standing over a picker now reading `Someday` is a sentence about a write the reader is no
     * longer looking at.
     */
    it("clears the last answer when the destination changes", async () => {
      await press(short(), sender({ isSuccess: true, data: 1 }));
      expect(screen.getByRole("status")).not.toHaveTextContent("");

      await userEvent.click(screen.getByRole("button", { name: "Pick Ordered" }));

      expect(screen.getByRole("status")).toHaveTextContent("");
    });

    /**
     * The sentence names where the wishes went — and it names the folder's **own** name, which
     * is what `useWishDestinationName` answers and deliberately not the full path the picker's
     * trigger beside it is drawing. A path disambiguates a row in a list of rows; a sentence
     * about a press has the drawer's name in it, the way a reader would say it. The fixture's
     * two strings differ, so an implementation that read the trigger's words rather than asking
     * the hook fails here rather than passing on a one-word folder.
     */
    it("names the folder in the live region", async () => {
      await pressAt(short(), "Pick the nested folder", sender({ isSuccess: true, data: 2 }));

      // `textContent` against the whole string rather than `toHaveTextContent`, which normalises
      // whitespace before it compares and would therefore pass over the failure the case below
      // this one is guarding — a clause appended empty, leaving `wishes  —` with two spaces in
      // it. One matcher for the pair, so neither half can be right for the wrong reason.
      expect(screen.getByRole("status").textContent).toBe(
        "Added 2 wishes to Buy at the LGS — one per card, for every copy you are short.",
      );
    });

    /**
     * **And invents no clause at the root**, which is the half a destination-shaped change is
     * most likely to break: `to Wishlist` would be this app naming a place the reader was never
     * asked to think about, on every press made by everyone who never opened the picker.
     *
     * Asserted on `textContent` rather than through `toHaveTextContent`, which normalises
     * whitespace before it compares: a strip that appended the clause **empty** would read
     * `Added 2 wishes  — one per…` with two spaces in it and pass the normalising matcher, which
     * is the one failure a `?? ""` fallback actually produces.
     */
    it("invents no destination clause at the wishlist root", async () => {
      await press(short(), sender({ isSuccess: true, data: 2 }));

      expect(screen.getByRole("status").textContent).toBe(
        "Added 2 wishes — one per card, for every copy you are short.",
      );
    });

    /**
     * **Zero names no folder either.** Nothing was written, so there is no place anything went —
     * naming the drawer the picker happened to be pointing at would say it received something,
     * which is the exact opposite of what the sentence is for.
     */
    it("names no folder on the nothing-added sentence", async () => {
      await pressAt(short(), "Pick Ordered", sender({ isSuccess: true, data: 0 }));

      expect(screen.getByRole("status")).toHaveTextContent(
        "Nothing to add — a recount covered the shortfall, or what is short has left the card database.",
      );
      expect(screen.getByRole("status")).not.toHaveTextContent(/Ordered/);
    });

    /**
     * **A folder that has gone reaches the failure line**, which is the one refusal a
     * destination can cause and the reason the backend checks the id up front rather than
     * answering 0 — a deck short of nothing already answers 0, and the two would be
     * indistinguishable.
     */
    it("says so when the folder is not there any more", async () => {
      await pressAt(
        short(),
        "Pick Ordered",
        sender({ isError: true, error: "That folder is not there any more." }),
      );

      expect(screen.getByRole("alert")).toHaveTextContent(
        "Could not add to the wishlist — That folder is not there any more.",
      );
      // And the press is available again: a refusal spends nothing, so the reader can pick
      // another drawer and try. `spent` is `!send.isError`'s own arm, which the destination
      // term did not touch.
      const button = screen.getByRole("button", { name: "Send missing to wishlist" });
      expect(button).toBeEnabled();
      expect(button).not.toHaveAttribute("aria-disabled");
    });

    /**
     * **Drawn beside the press it modifies, and inside the same box** — which is what keeps the
     * three peers three peers. Asserted as containment rather than as document order: an
     * implementation that put the picker fourth in the row would still satisfy "it comes after
     * the send button", and that is exactly the arrangement this design refuses.
     */
    it("draws the destination in the send button's own cluster, not as a fourth peer", () => {
      strip(short(), sender(), vi.fn(), vi.fn());

      const send = screen.getByRole("button", { name: "Send missing to wishlist" });
      const destination = screen.getByRole("button", { name: DESTINATION });
      const cluster = send.parentElement;
      expect(cluster).not.toBeNull();
      expect(cluster).toContainElement(destination);
      // …and the three answers are outside it, so none of them shares a box with a setting.
      for (const name of ["Pull from collection", "Add missing to collection"]) {
        expect(cluster).not.toContainElement(screen.getByRole("button", { name }));
      }
    });

    /**
     * **It rides with the whole `missing > 0` arm.** A deck short of nothing draws no press for
     * a destination to modify, so a picker left standing would be a control about a press that
     * is not there.
     */
    it("draws no destination when the deck is fully owned", () => {
      strip([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })], sender(), vi.fn(), vi.fn());

      expect(screen.queryByRole("button", { name: DESTINATION })).not.toBeInTheDocument();
    });

    /**
     * **But it stays on the theory list**, where the pull and the add are absent and the
     * wishlist press is not: wanting a card you do not own is exactly what a plan is for, and a
     * plan's shopping list is as filable as any other. The two absences beside it are what make
     * this a claim about the destination rather than about the arm.
     */
    it("keeps the destination on the theory list, beside the press that survives there", () => {
      strip(short(), sender(), null, null);

      expect(screen.queryByRole("button", { name: "Pull from collection" })).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Add missing to collection" }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Send missing to wishlist" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: DESTINATION })).toBeInTheDocument();
    });

    /**
     * **Refused for the half-second the write is in flight, where the two sibling presses
     * deliberately are not.** They are independent writes about one number; this one *is* the
     * argument the write in flight is carrying, and moving it mid-flight releases the latch — so
     * the answer to a press that really happened would never be said.
     */
    it("refuses the destination while the write it is carrying is in flight", () => {
      strip(short(), sender({ isPending: true }), vi.fn(), vi.fn());

      expect(screen.getByRole("button", { name: DESTINATION })).toBeDisabled();
      // The other two are untouched, which is the row's own standing rule.
      expect(screen.getByRole("button", { name: "Pull from collection" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Add missing to collection" })).toBeEnabled();
    });
  });

  /**
   * **A Virtual deck (issue #401) — the whole shortfall half absent, and the charts untouched.**
   *
   * Every case above this block is a claim about `tracksCollection: true`, which is the
   * regression these three are really guarding: this change touches the one line of the band a
   * hundred existing decks read every time they are opened, and a fix that emptied it for
   * everybody would pass a bare "the virtual deck draws nothing" check.
   *
   * The deck is short of three copies **and owns one**, so both of the block's two arms are
   * reachable from these rows: the `N of M missing` sentence with its three presses, and — by
   * owning the lot — the `All N owned.` fallback that replaces it. A fixture short of nothing
   * would leave half of what has to disappear untested.
   */
  describe("a deck that does not track a collection", () => {
    /** The `false` arm, at the ordinary shortfall. */
    const virtualStrip = (cards: DeckCard[] = short()) =>
      strip(cards, sender(), vi.fn(), vi.fn(), false);

    /**
     * The count, all three presses, and the two lines that answer them.
     *
     * `onPull` and `onAddMissing` are live `vi.fn()`s here rather than `null`, deliberately: with
     * both `null` the two buttons are already absent for the theory list's own reason, and the
     * test would pass over a `tracksCollection` that reached neither. Only the wishlist press,
     * which has no `null` of its own, would be a real claim.
     */
    it("draws no shortfall line and none of the three presses", () => {
      virtualStrip();

      expect(screen.queryByText(/missing/i)).not.toBeInTheDocument();
      for (const name of [
        "Pull from collection",
        "Add missing to collection",
        "Send missing to wishlist",
        // The destination goes with the press it modifies (issue #437). A deck with no binder
        // behind it is short of nothing, so there is no shopping list for a folder to be about —
        // and a picker left standing would be the one control on the line still claiming there
        // is something to file.
        DESTINATION,
      ]) {
        expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
      }
    });

    /**
     * **The fallback goes too, and it is the sentence this rule exists for.** `All 4 owned.` over
     * a deck the reader has said they own none of is the worst of the two things this line can
     * say, so a fix that only hid the shortfall arm would have made the virtual deck read as
     * fully owned. The fixture owns every copy, which is the one state that draws it.
     */
    it("draws no all-owned fallback either", () => {
      virtualStrip([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })]);

      expect(screen.queryByText(/owned/i)).not.toBeInTheDocument();
    });

    /** The live region and the refusal line are inside the same block, so a write that somehow
     *  answered would have nowhere to say so — asserted rather than assumed, because a stray
     *  `role="status"` left behind is an empty announcement on every render of the band. */
    it("keeps no live region or refusal line for a write it never makes", () => {
      strip(short(), sender({ isError: true, error: "nope" }), vi.fn(), vi.fn(), false);

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    /** What a deck wants and what a deck costs are facts about the *list*, so the pips and the
     *  four charts are untouched. Half of this test is the point of the other half: an
     *  implementation that hid the whole band would satisfy every absence above it. */
    it("keeps the pips row and every chart", () => {
      strip(boros(), sender(), vi.fn(), vi.fn(), false);

      const pips = screen.getByRole("group", { name: /pips/i });
      expect(within(pips).getByText("White").parentElement).toHaveTextContent("8");
      for (const name of ["Mana curve", "Colors", "Lands", "Card types"]) {
        expect(screen.getByRole("list", { name })).toBeInTheDocument();
      }
    });
  });
});
