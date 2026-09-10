import type { ComponentProps } from "react";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { DeckCard } from "@/lib/ipc";
import { MARKETPLACES } from "@/lib/marketplace";
import { pickOption } from "@/test-dropdown";
import { card, islands } from "./validation/fixtures";
import {
  COLLECTION_HEADING,
  DeckStats,
  deckStats,
  STATS_HEADING,
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
 * A land that taps for the colours `produced` names — the fixture the Sources half is measured
 * over.
 *
 * **`producedMana` is concatenated letters and never JSON**, which is `colors`' encoding one
 * field over: `["W","U"]` is `"WU"` and `JSON.parse` throws on it.
 *
 * It sets `manaCost: null` and `colors: null` on purpose, so a row here contributes to the
 * Sources half and to nothing else: a land that also printed a coloured cost would make every
 * `sources` assertion below readable as a `pips` one.
 */
function dual(name: string, produced: string, quantity = 1): DeckCard {
  return card({
    name,
    typeLine: "Land",
    manaCost: null,
    cmc: 0,
    colors: null,
    producedMana: produced,
    quantity,
  });
}

/**
 * `deckStats`, under the name the assertions below were written against.
 *
 * It took a currency while every row carried two prices; the rows carry one now, priced by the
 * backend at the marketplace the deck was read at, so there is nothing to pass. The alias
 * stays because it reads as "the ordinary case" at forty call sites that are about curves,
 * pips and sizes rather than about money.
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

  /**
   * **Pips as a card prints them, which is what this field stopped meaning something else on
   * 2026-09-10.** It counted *copies of cards of that colour*, read off `colors`, so
   * `{1}{B}{B}` on four copies was 4; it is the demand a manabase has to meet now, so it is 8.
   *
   * The fixture is deliberately the shape the two readings disagree about most: one card asking
   * twice, four copies of it, beside a one-pip card at the same count. Under the old definition
   * both rows read 4 and the assertion below fails on the black half alone — which is what makes
   * this a claim about the change rather than about arithmetic that never moved.
   *
   * `C` is here for the second half of the same change: the old count was WUBRG and this one is
   * all six keys, so a Sol Ring's `{1}` — generic, and **not** a pip — has to be told apart from
   * an Eldrazi's `{C}`.
   */
  it("counts the pips a cost prints, twice over for a card that asks twice", () => {
    const stats = usdStats([
      card({ name: "Bolas's Citadel", manaCost: "{1}{B}{B}", colors: "B", quantity: 4 }),
      card({ name: "Bolt", manaCost: "{R}", colors: "R", quantity: 4 }),
      card({ name: "Kozilek's Predator", manaCost: "{3}{C}{G}", colors: "G" }),
      card({ name: "Sol Ring", manaCost: "{1}", colors: null, typeLine: "Artifact" }),
    ]);

    expect(stats.pips).toEqual({ W: 0, U: 0, B: 8, R: 4, G: 1, C: 1 });
  });

  /**
   * The `· N cards` half of a pip readout: copies **asking** for the colour, however many pips
   * each asks for.
   *
   * It is the one number that separates *a deck of four double-black cards* from *a deck of
   * eight single-black ones*, which read identically in {@link DeckStatsSummary.pips}. Both rows
   * of the fixture are four copies, so a `pipCards` that had been left as a second alias for
   * `pips` reads `8` on the black half.
   */
  it("counts the copies asking for a colour beside the pips they ask for", () => {
    const stats = usdStats([
      card({ name: "Bolas's Citadel", manaCost: "{1}{B}{B}", colors: "B", quantity: 4 }),
      card({ name: "Bolt", manaCost: "{R}", colors: "R", quantity: 4 }),
    ]);

    expect(stats.pips).toEqual({ W: 0, U: 0, B: 8, R: 4, G: 0, C: 0 });
    expect(stats.pipCards).toEqual({ W: 0, U: 0, B: 4, R: 4, G: 0, C: 0 });
  });

  /**
   * **The cost and never `colors`**, which is where the two nearly always agree and the whole
   * reason this field reads the printed string.
   *
   * A card whose colour comes from something other than its cost — a colour indicator, a back
   * face, a land type — is a coloured card that makes no demand on a manabase at all, and this
   * readout is entirely about demand. Ancestral Vision is the printing that says so: `{U}` in
   * `colors`, no coloured symbol in its cost.
   *
   * `colorIdentity` is the second thing it is not, and for the older reason: a Kenrith in the
   * command zone does not make the deck's spells five-coloured.
   */
  it("takes the pips from the printed cost and not from the card's colours", () => {
    const stats = usdStats([
      card({ name: "Ancestral Vision", manaCost: "{U}", colors: "U", colorIdentity: "WUBRG" }),
      card({ name: "Suspended Vision", manaCost: "{0}", colors: "U", colorIdentity: "U" }),
    ]);

    expect(stats.pips).toEqual({ W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 });
    expect(stats.pipCards).toEqual({ W: 0, U: 1, B: 0, R: 0, G: 0, C: 0 });
  });

  /**
   * A hybrid is one pip of each half and a twobrid is one pip of its colour — `addPips`' own
   * vocabulary over the one tokeniser this app parses every cost with, reached from here rather
   * than respelled.
   *
   * It is in this file because a second spelling of that vocabulary is exactly how two counters
   * come to disagree about a Phyrexian hybrid, and `deckStats` is the counter the manabase
   * readout is drawn from.
   */
  it("reads a hybrid as one pip of each half and a twobrid as one of its colour", () => {
    const stats = usdStats([
      card({ name: "Boros Charm", manaCost: "{R}{W}", colors: "RW" }),
      card({ name: "Figure of Destiny", manaCost: "{R/W}", colors: "RW" }),
      card({ name: "Beseech the Queen", manaCost: "{2/B}{2/B}{2/B}", colors: "B" }),
    ]);

    expect(stats.pips).toEqual({ W: 2, U: 0, B: 3, R: 2, G: 0, C: 0 });
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

  /**
   * **A source is counted once in _every_ colour it makes**, which is what makes the six numbers
   * an honest denominator for "what share of my mana can pay for black" and what stops them
   * being a partition.
   *
   * The dual is the whole fixture: four copies, two colours, so the six keys sum to more copies
   * than the deck holds sources. An implementation that filed a card under one colour — its
   * first letter, say — reads `W 4, U 0` here and passes any test built out of monocoloured
   * lands.
   *
   * **Copies and not mana.** Scryfall says *which* colours a card produces and never *how much*,
   * so the Sol Ring below counts once for colourless exactly as a one-mana rock would.
   */
  it("counts a source once in every colour it makes", () => {
    const stats = usdStats([
      dual("Hallowed Fountain", "WU", 4),
      card({
        name: "Sol Ring",
        typeLine: "Artifact",
        manaCost: "{1}",
        cmc: 1,
        colors: null,
        producedMana: "C",
      }),
    ]);

    expect(stats.sources).toEqual({ W: 4, U: 4, B: 0, R: 0, G: 0, C: 1 });
    expect(stats.sourcesKnown).toBe(true);
    // Five copies of cardboard against nine counted colours — said out loud, because it is the
    // property that would look like a bug to anyone auditing the numbers against the deck.
    expect(Object.values(stats.sources).reduce((n, count) => n + count, 0)).toBe(9);
  });

  /**
   * **The question has three answers and this is the third one.**
   *
   * `sourcesKnown` is `false` only when *every* counted row came back `null` — a database that
   * has not re-ingested since the corpus grew `produced_mana`, which is the state every existing
   * install is in for up to a day. A deck of sixty spells and no lands is a real row of zeroes
   * and must not read the same way, because the failure mode is a chart that is *confidently
   * wrong* rather than one that is honestly absent.
   *
   * Both halves are asserted against the same six zeroes, which is the point: the arithmetic
   * cannot tell them apart and this flag is the only thing that can.
   */
  it("says the sources question is unanswered when every row predates the column", () => {
    const unsynced = usdStats([
      card({ name: "Bolt", manaCost: "{R}", producedMana: null, quantity: 4 }),
      card({
        name: "Mountain",
        typeLine: "Basic Land — Mountain",
        manaCost: null,
        cmc: 0,
        colors: null,
        producedMana: null,
        quantity: 20,
      }),
    ]);

    expect(unsynced.sourcesKnown).toBe(false);
    expect(unsynced.sources).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });

    // The same six zeroes, answered rather than unknown: sixty spells and no lands really do
    // produce nothing, and a deck in that state is owed the chart rather than the apology.
    const spellsOnly = usdStats([
      card({ name: "Bolt", manaCost: "{R}", producedMana: "", quantity: 4 }),
    ]);
    expect(spellsOnly.sourcesKnown).toBe(true);
    expect(spellsOnly.sources).toEqual({ W: 0, U: 0, B: 0, R: 0, G: 0, C: 0 });
  });

  /**
   * One row answering is enough, because one answer means the **column** is populated and what
   * is left `null` after that is an orphan — a row whose printing has left the corpus, which has
   * no answer to give and never will.
   *
   * Written as a pair with the row order reversed, so an implementation that latched on the
   * *last* row it saw rather than on any of them fails one half of it.
   */
  it("counts the question answered as soon as one row answers", () => {
    const orphan = card({ name: "Ghost", manaCost: null, typeLine: null, producedMana: null });
    const island = dual("Island", "U", 1);

    expect(usdStats([orphan, island]).sourcesKnown).toBe(true);
    expect(usdStats([island, orphan]).sourcesKnown).toBe(true);
    // …and the orphan contributes nothing to the counts either way.
    expect(usdStats([orphan, island]).sources.U).toBe(1);
  });

  /**
   * Six curves over the nonlands, and **a card is in every colour it is** — so a gold spell
   * stands in two of them and the six sum to more than the nonland count.
   *
   * The `C` curve is the one key that partitions rather than overlaps: it is the cards with no
   * colours at all, which is why it is an emptiness test rather than a membership one. Boros
   * Charm is what separates the two readings — under a "file each card once" implementation the
   * white curve reads 0 at mana value 2.
   *
   * **`colors` is letters and never JSON** (`"WU"`, on which `JSON.parse` throws), which this
   * fixture would catch by drawing an empty curve for every coloured card.
   */
  it("draws a curve per colour, counting a gold spell in each of its own", () => {
    const stats = usdStats([
      card({ name: "Bolt", manaCost: "{R}", colors: "R", cmc: 1, quantity: 4 }),
      card({ name: "Boros Charm", manaCost: "{R}{W}", colors: "RW", cmc: 2, quantity: 2 }),
      card({
        name: "Wastes Walker",
        typeLine: "Creature — Eldrazi",
        manaCost: "{3}",
        colors: null,
        cmc: 3,
      }),
      islands(10),
    ]);

    expect(stats.curveByColor.R[1]).toBe(4);
    expect(stats.curveByColor.R[2]).toBe(2);
    expect(stats.curveByColor.W[2]).toBe(2);
    expect(stats.curveByColor.W[1]).toBe(0);
    // Colourless is the partition: the Eldrazi is in `C` and in nothing else.
    expect(stats.curveByColor.C[3]).toBe(1);
    expect(stats.curveByColor.G).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // The caption over each curve, and the sum of that colour's own nine buckets.
    expect(stats.spellsByColor).toEqual({ W: 2, U: 0, B: 0, R: 6, G: 0, C: 1 });
    // Seven copies of nonland cardboard against nine counted spells — said out loud, because
    // the overlap is exactly what a reader auditing these numbers against their deck would
    // query. Boros Charm's two copies are in both the white curve and the red one.
    expect(stats.nonlands).toBe(7);
    expect(
      Object.values(stats.spellsByColor).reduce((n, spells) => n + spells, 0),
    ).toBeGreaterThan(stats.nonlands);
  });

  /**
   * **`separateXGroup` deliberately does not reach the six colour curves**, which is the one
   * place the flag stops. They are small charts read for their shape, and a tenth bar on each
   * that six decks in a hundred would use is a column of white space on the other ninety-four.
   *
   * The deck's own curve is asserted beside it, so this is a claim about the two disagreeing on
   * purpose rather than about the flag doing nothing at all.
   */
  it("leaves the colour curves alone when the deck splits its {X} spells out", () => {
    const deck = [xSpell("Awakening", { colors: "B", quantity: 4 })];

    expect(deckStats(deck, true).curve[3]).toBe(0);
    expect(deckStats(deck, true).variableCost).toBe(4);
    // Drawn at what it costs with X at zero, in both modes, in the black curve.
    expect(deckStats(deck, true).curveByColor.B[3]).toBe(4);
    expect(deckStats(deck).curveByColor.B[3]).toBe(4);
  });

  /**
   * The copies in the piles the reader switched **off** — the second note under the Cards
   * figure, and deliberately **not derivable** from the numbers beside it.
   *
   * `byCategory` carries every pile including the switched-off ones, so a caller subtracting to
   * find this would be applying the switch a second time. The fixture holds all three classes at
   * once — sized, elsewhere, switched off — so an implementation that counted `copies − sized`
   * reads 12 rather than 9.
   */
  it("counts the copies in switched-off piles, apart from every other figure", () => {
    const stats = usdStats([
      spell("Bolt", 1, { quantity: 4 }),
      spell("Pyroblast", 1, { categoryKind: "side", quantity: 3 }),
      spell("Ghost", 5, { categoryKind: "maybe", quantity: 9 }),
    ]);

    expect(stats.inactive).toBe(9);
    // In no other number: the headline counts 4, the copies counted anywhere count 7.
    expect(stats.sized).toBe(4);
    expect(stats.copies).toBe(7);
  });

  /**
   * The total split the way the copies are: what the copies in hand are worth, and what the ones
   * still to find would cost.
   *
   * **They sum to {@link DeckStatsSummary.price} over the priced rows exactly**, which is what
   * lets the Figures card write them as two lines under the total with no third line accounting
   * for the difference. The unpriced row is outside all three and is `unpriced`'s to declare.
   *
   * The fixture is short of copies of a row it is *partly* holding, because a split computed per
   * **row** rather than per copy — all of a row's money on whichever side its first copy fell —
   * reads `$20 / $0` here.
   */
  it("splits the price the way it splits the copies", () => {
    const stats = usdStats([
      spell("Bolt", 1, { quantity: 4, ownedQuantity: 1, unitPrice: 5 }),
      spell("Bear", 2, { quantity: 2, ownedQuantity: 2, unitPrice: 3 }),
      spell("Ghost", 3, { quantity: 2, ownedQuantity: 0, unitPrice: null }),
    ]);

    expect(stats.price).toBe(26);
    expect(stats.ownedPrice).toBe(11);
    expect(stats.missingPrice).toBe(15);
    expect(stats.unpriced).toBe(2);
    expect((stats.ownedPrice ?? 0) + (stats.missingPrice ?? 0)).toBe(stats.price);
  });

  /**
   * **All three are `null` together, and never `0` in the total's place.** A deck this
   * marketplace quotes nothing for has no money to divide, and `$0.00 owned` under an em dash
   * reads as *you own none of it* rather than as *nothing here is priced*.
   */
  it("gives no owned or missing money for a deck nothing is priced at", () => {
    const stats = usdStats([spell("Bolt", 1, { quantity: 4, ownedQuantity: 2, unitPrice: null })]);

    expect(stats.price).toBeNull();
    expect(stats.ownedPrice).toBeNull();
    expect(stats.missingPrice).toBeNull();
  });

  /**
   * The one card class where the two readings of "land" part company, and the reason `deckStats`
   * reads the one it reads.
   *
   * A deckbuilder counts Urza's Saga among their lands, and it costs nothing to put onto the
   * battlefield — so the curve would file all three of these under 0, which is the very flood
   * the curve excludes lands to avoid. `isLand` reads the whole type line for that reason.
   *
   * **The other reading is the Card distribution's, and it is deliberately not asserted here any
   * more**: its `by Types` cut files a card under the *first* type printed on it, so Urza's Saga
   * heads up the Enchantment bar. That derivation moved to `deckBuckets.ts` with the chart in
   * the 2026-09-10 redesign and is its module's to pin; what survives here is `deckStats`' own
   * answer and the disagreement being on purpose.
   */
  it("keeps a land that is not filed under Land a land to the curve", () => {
    const stats = usdStats([
      card({ name: "Urza's Saga", typeLine: "Legendary Enchantment Land", cmc: 0, manaCost: null }),
      card({ name: "Tree of Tales", typeLine: "Artifact Land", cmc: 0, manaCost: null }),
      card({ name: "Dryad Arbor", typeLine: "Land Creature — Dryad", cmc: 0, manaCost: null }),
      spell("Bolt", 1),
    ]);

    expect(stats.lands).toBe(3);
    expect(stats.nonlands).toBe(1);
    expect(stats.curve[0]).toBe(0);
    // Nor in any colour's curve, which is the same rule read one field over: those six are over
    // the nonlands, so a land drawn into one of them would be the flood in six charts instead.
    expect(stats.curveByColor.C[0]).toBe(0);
    expect(stats.spellsByColor.R).toBe(1);
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
   * Everything the band needs that a given case is not about.
   *
   * **A builder rather than JSX repeated at every `rerender`**, which is what the 2026-09-10
   * redesign forced: the band grew four required props (`marketplace`, `theory`, `open`,
   * `onToggle`) and half the cases below re-render it two or three times. Spelled out at each
   * site, a prop added later would be four edits per case and a case that quietly disagreed with
   * its own first render.
   *
   * **`onPull` and `onAddMissing` both default to `null`**, which is the theory list's answer
   * rather than the ordinary one — deliberately, because most cases below are about the wishlist
   * half, and either live callback would put another button into each of their queries for
   * nothing. The cases that are about one of the other two presses pass it and say so.
   *
   * **`tracksCollection` defaults to `true`**, the ordinary deck; **`open` defaults to `true`**,
   * which is `decks.stats_open`'s own `DEFAULT 1` and therefore what every deck in the database
   * is. Both `false` arms are passed explicitly, and only where they are the subject.
   */
  type BandProps = ComponentProps<typeof DeckStats>;
  const props = (over: Partial<BandProps> = {}): BandProps => ({
    cards: [],
    send: sender(),
    onPull: null,
    onAddMissing: null,
    tracksCollection: true,
    marketplace: MARKETPLACES.tcgplayer,
    theory: null,
    open: true,
    onToggle: vi.fn(),
    ...over,
  });

  /** The band, rendered. The positional arguments are the ones forty cases below already pass. */
  const strip = (
    cards: DeckCard[],
    send = sender(),
    onPull: (() => void) | null = null,
    onAddMissing: (() => void) | null = null,
    tracksCollection = true,
  ) =>
    render(
      <TooltipProvider>
        <DeckStats {...props({ cards, send, onPull, onAddMissing, tracksCollection })} />
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
    const view = render(<DeckStats {...props({ cards })} />);
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
    view.rerender(<DeckStats {...props({ cards, send: settled })} />);
    return view;
  }

  /**
   * A 24-land Boros deck: every readout is checkable by hand, and every one of them shows its
   * numbers as text rather than only as a shape.
   *
   * **Every row names its own `manaCost` and every land its own `producedMana`**, which the
   * fixture did not have to do before 2026-09-10 and now must. `card()` defaults a cost of
   * `{R}`, so a fixture that left it alone would count twenty-four *lands* as twenty-four red
   * pips — and a `producedMana` left at the fixture's `""` would leave the Sources half reading
   * a real, answered row of zeroes over a deck with a full manabase.
   */
  const boros = (): DeckCard[] => [
    card({
      name: "Bolt",
      typeLine: "Instant",
      manaCost: "{R}",
      colors: "R",
      cmc: 1,
      quantity: 4,
    }),
    card({
      name: "Lion",
      typeLine: "Creature — Cat",
      manaCost: "{W}",
      colors: "W",
      cmc: 1,
      quantity: 4,
    }),
    card({
      name: "Helix",
      typeLine: "Instant",
      manaCost: "{R}{W}",
      colors: "WR",
      cmc: 2,
      quantity: 4,
    }),
    card({
      name: "Mountain",
      typeLine: "Basic Land — Mountain",
      manaCost: null,
      cmc: 0,
      colors: null,
      producedMana: "R",
      quantity: 12,
    }),
    card({
      name: "Plains",
      typeLine: "Basic Land — Plains",
      manaCost: null,
      cmc: 0,
      colors: null,
      producedMana: "W",
      quantity: 12,
    }),
  ];

  /**
   * One readout of the band, by the heading `StatsCard` gives it.
   *
   * Every one is a `<section aria-labelledby>`, so it is a `region` with the heading as its
   * accessible name — and addressing them this way rather than by a class or a test id is what
   * makes an absence below (`queryCard`) a claim about the accessible tree rather than about
   * the DOM.
   */
  const statsCard = (title: string) => screen.getByRole("region", { name: title });
  const queryCard = (title: string) => screen.queryByRole("region", { name: title });

  /** One colour's census tile in the Mana pips card, found by the `sr-only` word that names it —
   *  the mana glyph beside it is a wire token ("W") and names nothing. */
  const pipTile = (colour: string) =>
    within(statsCard("Mana pips")).getByText(colour).closest("li");

  /**
   * The band's own disclosure — the one control it draws that is not in the Collection card.
   *
   * Asserted through `toHaveAccessibleName` wherever the name is the subject: the button holds a
   * chevron beside its word, and a `gap` between two runs is what computes to `Missing2` one card
   * over. Here the chevron is `aria-hidden`, so the name is the word alone — which is the claim.
   */
  const disclosure = () => screen.getByRole("button", { name: STATS_HEADING });

  /**
   * **The whole band is behind a disclosure since 2026-09-10**, which reverses the rule that
   * stood from 2026-08-14: *there is no control that hides them*. That rule was written when the
   * band was four charts on one line; seven readouts is two screens, and a finished deck is one
   * a reader scrolls past every time they open it.
   *
   * The state is the deck's (`decks.stats_open`) rather than the component's, so the press
   * **asks** for the other one and never sets it — a band that toggled itself would be a second
   * answer to a question the deck row already holds, and the two would disagree for the length
   * of the write.
   */
  it("tracks the deck's open flag and asks for the other one when pressed", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<DeckStats {...props({ cards: boros(), open: true, onToggle })} />);

    expect(disclosure()).toHaveAccessibleName(STATS_HEADING);
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(disclosure());
    expect(onToggle).toHaveBeenLastCalledWith(false);

    // Shut. The negation is asserted from both ends, so a press wired to a constant passes
    // neither half — which is exactly what an `onToggle(false)` hard-coded to the commoner case
    // would be.
    rerender(<DeckStats {...props({ cards: boros(), open: false, onToggle })} />);
    expect(disclosure()).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(disclosure());
    expect(onToggle).toHaveBeenLastCalledWith(true);
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  /**
   * **Shut, the body is empty and still in the tree** — `DeckTokensPanel`'s arrangement, copied
   * character for character, and the reason is `aria-controls`: an attribute pointing at an id
   * nothing carries is a promise the accessibility tree cannot keep, and a reader's screen
   * reader is told about a region that is not there.
   *
   * Both halves are asserted because either alone passes over the wrong thing. An unmounted body
   * satisfies "no readouts" while breaking the reference; a body that merely hid its contents
   * with CSS satisfies "the id resolves" while leaving seven regions in the accessible tree for
   * a screen reader to walk.
   */
  it("empties the disclosure's body while it is shut, and still resolves aria-controls", () => {
    render(<DeckStats {...props({ cards: boros(), open: false })} />);

    // Nothing of the band's own is in the accessible tree…
    for (const title of ["Mana pips", "Card distribution", "Mana curve", "Curve by color"]) {
      expect(queryCard(title)).not.toBeInTheDocument();
    }
    expect(screen.queryByText(/at mana value/)).not.toBeInTheDocument();

    // …and the element the disclosure names is still there to be named.
    const id = disclosure().getAttribute("aria-controls");
    expect(id).toBeTruthy();
    const body = document.getElementById(id ?? "");
    expect(body).not.toBeNull();
    expect(body).toBeEmptyDOMElement();
  });

  /**
   * The pips card is a census of all six keys — a grid whose row count changed with the deck
   * would be one the reader has to read from scratch after every edit — and each tile says what
   * the costs **ask** of that colour in pips and in cards.
   *
   * A `{R}{W}` card feeds both halves, so white is 4 + 4 and red is 4 + 4: **pips, not copies**,
   * which is what this field stopped meaning on 2026-09-10.
   *
   * The caption is asserted whole rather than as two numbers, because it is exactly the shape
   * that concatenates: `8 pips` and `8 cards` are two runs with a separator between them, and a
   * matcher that only looked for `8` would pass over both of them being the same number by
   * accident.
   */
  it("draws a census tile per colour, with the pips and the copies asking for them", () => {
    strip(boros());

    expect(pipTile("White")).toHaveTextContent("8 pips · 8 cards");
    expect(pipTile("Red")).toHaveTextContent("8 pips · 8 cards");
    // Drawn and empty rather than dropped — the grid is a shape the reader learns the positions
    // of, and "this deck casts nothing blue" is a real answer no absent tile can state.
    expect(pipTile("Blue")).toHaveTextContent("no pips");
    expect(pipTile("Colorless")).toHaveTextContent("no pips");
  });

  /**
   * **The two halves of that caption are two different numbers, and the Boros deck above cannot
   * say so** — no card in it asks twice, so `8 pips · 8 cards` reads the same under either of the
   * two things `pips` has meant. Four copies of a `{1}{B}{B}` card is the smallest fixture where
   * the demand and the copies making it come apart.
   */
  it("counts a double pip twice and the copy asking for it once", () => {
    strip([card({ name: "Bolas's Citadel", manaCost: "{1}{B}{B}", colors: "B", quantity: 4 })]);

    expect(pipTile("Black")).toHaveTextContent("8 pips · 4 cards");
  });

  /**
   * The other half of the same card: what the deck's cards can **make**, set against what its
   * costs ask for.
   *
   * A source is counted once in every colour it makes, and copies rather than mana — Scryfall
   * says *which* colours a card produces and never *how much*.
   */
  it("draws the sources beside the pips, once per colour a card makes", () => {
    strip([
      card({
        name: "Bolt",
        typeLine: "Instant",
        manaCost: "{R}",
        colors: "R",
        cmc: 1,
        quantity: 4,
      }),
      dual("Hallowed Fountain", "WU", 4),
      dual("Command Tower", "WUBRG", 1),
    ]);

    // Four duals and a Command Tower, so white and blue read 5 of the 9 counted colours.
    expect(pipTile("White")).toHaveTextContent("5 sources");
    expect(pipTile("Blue")).toHaveTextContent("5 sources");
    expect(pipTile("Red")).toHaveTextContent("1 source");
    // Singular, which nothing else in this suite would notice.
    expect(pipTile("Green")).toHaveTextContent("1 source");
    // The mix, said once as a phrase — the band's `sr-only` sentence, which is the only place a
    // reader hears *which colours are in this deck at all* rather than six tiles one at a time.
    expect(within(statsCard("Mana pips")).getByText(/^Sources:/)).toHaveTextContent(
      "Sources: White 38%, Blue 38%, Black 8%, Red 8%, Green 8%.",
    );
  });

  /**
   * **The state every existing install is in for up to a day, and the one this readout must not
   * draw as zeroes.**
   *
   * `sourcesKnown` is `false` only when every counted row came back `null` — a database that has
   * not re-ingested since the corpus grew `produced_mana`. A row of zeroes is a real and
   * different answer (sixty spells and no lands), and the two are indistinguishable in the
   * arithmetic, so what tells them apart on screen is the whole of this case. The failure mode
   * is a chart that is *confidently wrong* rather than one that is honestly absent.
   *
   * The Cost half is asserted present in the same breath: a band that drew neither would pass a
   * bare "no sources chart" check while being broken for the question that *is* answered.
   */
  it("says the sources are unanswered rather than drawing a row of zeroes", () => {
    strip([
      card({
        name: "Bolt",
        typeLine: "Instant",
        manaCost: "{R}",
        colors: "R",
        cmc: 1,
        producedMana: null,
        quantity: 4,
      }),
      card({
        name: "Mountain",
        typeLine: "Basic Land — Mountain",
        manaCost: null,
        cmc: 0,
        colors: null,
        producedMana: null,
        quantity: 20,
      }),
    ]);

    const pips = statsCard("Mana pips");
    expect(
      within(pips).getByText("Mana sources arrive with the next card sync"),
    ).toBeInTheDocument();
    // No `Sources:` band at all — an empty track beside a filled Cost one is the row of zeroes
    // this state exists to refuse.
    expect(within(pips).queryByText(/^Sources:/)).not.toBeInTheDocument();
    // And the tile says so too, rather than `no sources`, which is the answered version of the
    // same six zeroes.
    expect(pipTile("Red")).toHaveTextContent("awaiting card sync");
    expect(pipTile("Red")).not.toHaveTextContent("no sources");
    // The half that says this is not simply a band that failed to draw.
    expect(within(pips).getByText(/^Cost:/)).toBeInTheDocument();
    expect(pipTile("Red")).toHaveTextContent("4 pips · 4 cards");
  });

  it("draws the mana curve with a count over every bucket", () => {
    strip(boros());

    const curve = statsCard("Mana curve");
    expect(within(curve).getByText("8 cards at mana value 1")).toBeInTheDocument();
    expect(within(curve).getByText("4 cards at mana value 2")).toBeInTheDocument();
    // The axis is drawn whole: an empty bucket is a fact about the curve.
    expect(within(curve).getByText("0 cards at mana value 4")).toBeInTheDocument();
    // Nine bars, because this deck is not splitting its X spells out. The tenth is the next
    // test's, and its absence here is what makes that one a claim about the toggle.
    expect(within(curve).getAllByRole("listitem")).toHaveLength(9);
  });

  /**
   * The average belongs to this curve and to nothing else on the band, which is why it is drawn
   * on the card's own heading line rather than among the Figures.
   *
   * Two elements rather than one string, so the figure and the word stay two runs to read —
   * `3.24average` is what one element's contents would compute to. The 1.33 is `(1×8 + 2×4)/12`.
   */
  it("prints the average mana value on the curve's own heading line", () => {
    strip(boros());

    const curve = statsCard("Mana curve");
    expect(within(curve).getByText("1.33")).toBeInTheDocument();
    expect(within(curve).getByText("average")).toBeInTheDocument();
  });

  /**
   * Six curves, each read against **its own** tallest bucket, with the colour said as a heading
   * over the panel rather than as a clause in each of its nine bars — nine sentences each ending
   * "of white" is one fact repeated nine times.
   *
   * A `{R}{W}` card stands in two of them, which is the property that makes these six overlap
   * rather than partition; the caption is the sum of that colour's own nine buckets.
   */
  it("draws a curve per colour, captioned with that colour's own spell count", () => {
    strip(boros());

    const curves = statsCard("Curve by color");
    expect(within(curves).getByText("White — 8 spells")).toBeInTheDocument();
    expect(within(curves).getByText("Red — 8 spells")).toBeInTheDocument();
    // Drawn and empty rather than dropped, for the pips grid's reason.
    expect(within(curves).getByText("Blue — 0 spells")).toBeInTheDocument();
    // Singular, which nothing else here would notice.
    expect(within(curves).getByText("Colorless — 0 spells")).toBeInTheDocument();
  });

  /**
   * The bars a pie used to be: the deck cut four ways by one control, with the bucket named in
   * each bar's own spoken sentence.
   *
   * **The select drives both halves of its card** — the bars above and the opening-hand odds
   * below — which is a deliberate departure from the design it was built from, where it moved
   * only the table. A control in a card's header that changes half of that card reads as broken.
   */
  it("cuts the distribution the way the reader asks, bars and odds together", async () => {
    const user = userEvent.setup();
    strip(boros());

    const distribution = statsCard("Card distribution");
    expect(within(distribution).getByText("8 cards of type Instant")).toBeInTheDocument();
    expect(within(distribution).getByText("24 cards of type Land")).toBeInTheDocument();
    expect(within(distribution).getByRole("columnheader", { name: "Type" })).toBeInTheDocument();

    await pickOption(user, "Card distribution by", "Mana value");

    // The bars followed the control…
    expect(within(distribution).getByText("8 cards at mana value 1")).toBeInTheDocument();
    expect(within(distribution).queryByText("8 cards of type Instant")).not.toBeInTheDocument();
    // …and so did the table under them, which is the half the design got wrong.
    expect(
      within(distribution).getByRole("columnheader", { name: "Mana value" }),
    ).toBeInTheDocument();
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

    const curve = () => statsCard("Mana curve");
    expect(within(curve()).queryByText(/with X in their cost/)).not.toBeInTheDocument();
    expect(within(curve()).getByText("4 cards at mana value 3")).toBeInTheDocument();

    rerender(<DeckStats {...props({ cards: deck, separateXGroup: true })} />);

    expect(within(curve()).getAllByRole("listitem")).toHaveLength(10);
    expect(within(curve()).getByText("4 cards with X in their cost")).toBeInTheDocument();
    // And they left the bucket they were in, so the two bars are not the same four cards
    // counted twice.
    expect(within(curve()).getByText("0 cards at mana value 3")).toBeInTheDocument();
  });

  /**
   * **The two pies are gone (2026-09-10) and this is what says so.**
   *
   * `Colors` answered *what is this deck made of* with a circle whose legend was the only
   * readable part; the six colour curves answer the same question with the mana **value**
   * attached, and the distribution's `by Types` bars carry the land count in a bar a reader can
   * compare against the others. Nothing was lost that a bar did not say better.
   *
   * It is asserted as an absence beside the presences that replaced it, because a band that drew
   * neither would pass a bare "no pies" check while being broken for every question they used to
   * answer.
   */
  it("draws no pies, and answers their two questions in bars instead", () => {
    strip(boros());

    for (const gone of ["Colors", "Lands", "Card types"]) {
      expect(screen.queryByRole("region", { name: gone })).not.toBeInTheDocument();
      expect(screen.queryByRole("list", { name: gone })).not.toBeInTheDocument();
    }
    // Composition, with the mana value attached…
    expect(within(statsCard("Curve by color")).getByText("Red — 8 spells")).toBeInTheDocument();
    // …and the land count as a bar beside the others rather than as its own circle.
    expect(
      within(statsCard("Card distribution")).getByText("24 cards of type Land"),
    ).toBeInTheDocument();
  });

  /**
   * A deck with nothing in it draws **no readouts at all**, and one sentence instead.
   *
   * Every chart in the band would be honest about an empty deck and useless — nine empty tracks,
   * six empty tracks six times, an odds table of noughts — so the band says what it has rather
   * than drawing a shape that reads as a rendering fault.
   *
   * The disclosure stays, which is the half worth pinning: it is what a reader presses to put an
   * empty band away, and a control that disappeared with its own contents would leave the header
   * of a band nothing can close.
   */
  it("draws no readout at all for an empty deck, and says why", () => {
    strip([]);

    expect(screen.getByText(/Nothing to measure yet/)).toBeInTheDocument();
    const readouts = ["Mana pips", "Card distribution", "Mana curve", "Curve by color", "Figures"];
    for (const title of readouts) {
      expect(queryCard(title)).not.toBeInTheDocument();
    }
    expect(disclosure()).toHaveAttribute("aria-expanded", "true");
  });

  /**
   * **Every chart carries its numbers as text and the drawing is `aria-hidden`**, which is the
   * band's standing rule and the reason it never needed a chart library. A screen reader that
   * heard both would hear the deck twice.
   *
   * Swept over the bars a reader would actually be told about: each `<li>` of the curve holds one
   * `sr-only` sentence, and everything else inside it is hidden. Asserted as *"every bar has a
   * sentence and every drawn element is hidden"* rather than by counting elements, because a
   * count is a fact about today's markup.
   */
  it("says every bar's numbers in words and hides the drawing", () => {
    strip(boros());

    const bars = within(statsCard("Mana curve")).getAllByRole("listitem");
    expect(bars).toHaveLength(9);
    for (const bar of bars) {
      const spoken = bar.querySelector(".sr-only");
      expect(spoken).not.toBeNull();
      expect(spoken?.textContent).toMatch(/^\d+ cards? at mana value/);
      // Everything the eye reads is hidden from the tree — the track, the fill, the count
      // printed on it and the glyph under it.
      for (const drawn of bar.querySelectorAll(":scope > span:not(.sr-only)")) {
        expect(drawn).toHaveAttribute("aria-hidden", "true");
      }
    }
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
        <DeckStats {...props({ cards: short(), send: sender() })} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
    view.rerender(
      <TooltipProvider>
        <DeckStats {...props({ cards: short(), send: settled })} />
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
        {...props({
          cards: [card({ name: "Bolt", quantity: 4, ownedQuantity: 1 }), card({ name: "Bear" })],
          send: sender({ isSuccess: true, data: 1 }),
        })}
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
        {...props({
          cards: [card({ name: "Bolt", quantity: 5, ownedQuantity: 1 })],
          send: settled,
        })}
      />,
    );
    // …and back to exactly the number that was sent.
    rerender(
      <DeckStats {...props({ cards: deck, send: settled })} />,
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

  /**
   * A control that offers to do nothing is a control that teaches the reader to stop looking at
   * the row it is in — so the press goes, and **the whole Collection card goes with it**
   * (2026-09-10).
   *
   * Every control in that card is already gated on `missing > 0`, so without the card's own gate
   * it would be a heading over an empty box on every finished deck. The `All N owned.` fallback
   * that used to stand in the press's place was deleted rather than moved: it is the same fact
   * said by the readout whose job is facts, one card up, and an arm that can no longer be
   * reached is worse than none.
   */
  it("draws no Collection card at all when the deck is fully owned", () => {
    strip([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })]);

    expect(
      screen.queryByRole("button", { name: "Send missing to wishlist" }),
    ).not.toBeInTheDocument();
    expect(queryCard(COLLECTION_HEADING)).not.toBeInTheDocument();
    // The deleted sentence, asserted gone rather than merely unasserted: it read from the other
    // end of the same count and is the worse of the two to leave standing.
    expect(screen.queryByText(/all 4 owned/i)).not.toBeInTheDocument();
    // What says it instead — the Figures card's own note under the Owned count.
    const figures = statsCard("Figures");
    expect(within(figures).getByText("Owned").closest("div")).toHaveTextContent("every copy");
  });

  /**
   * The other side of the same gate: a deck that *is* short of something draws the card, and the
   * Owned figure's note says how short rather than `every copy`.
   *
   * Both halves in one case, because an implementation that drew the card unconditionally passes
   * the presence half of the case above's opposite and nothing else.
   */
  it("draws the Collection card and a shortfall note once the deck is short", () => {
    strip(short());

    expect(statsCard(COLLECTION_HEADING)).toBeInTheDocument();
    const figures = statsCard("Figures");
    expect(within(figures).getByText("Owned").closest("div")).toHaveTextContent("3 missing");
    expect(within(figures).getByText("Owned").closest("div")).not.toHaveTextContent("every copy");
  });

  /**
   * **How far the live list has got toward the plan, and `null` is absence rather than zero.**
   *
   * `theory` is answered by the host off the `theorySlots` query the editor already makes for the
   * per-card marks — a second read of the plan here would be a second answer to *what does this
   * deck need* that could disagree with the ticks on the cards.
   *
   * A deck with no plan draws **no entry at all**: `0 of 0` reads as failure where the honest
   * statement is absence, and a dash already means *no number to give* elsewhere in this app.
   */
  it("draws the theory figure only for a deck that has a plan", () => {
    const { rerender } = render(
      <DeckStats {...props({ cards: short(), theory: { have: 62, want: 100 } })} />,
    );

    const figure = () => screen.queryByText("Matches theory")?.closest("div");
    expect(figure()).toHaveTextContent("62 of 100");
    // The percentage under it, which is the note rather than the figure.
    expect(figure()).toHaveTextContent("62%");

    rerender(<DeckStats {...props({ cards: short(), theory: null })} />);
    expect(screen.queryByText("Matches theory")).not.toBeInTheDocument();
  });

  /**
   * **A plan of nothing gets the figure and no percentage** — `0 of 0` is the honest statement
   * and one the reader can act on by putting a card in the plan, where a percentage of an empty
   * plan does not exist. `percent(null)`'s em dash is what this must not print: a dash in this
   * app means *a number exists and is unknown*.
   */
  it("gives an empty plan its figure and no percentage", () => {
    render(<DeckStats {...props({ cards: short(), theory: { have: 0, want: 0 } })} />);

    const figure = screen.getByText("Matches theory").closest("div");
    expect(figure).toHaveTextContent("0 of 0");
    // **Any percentage at all**, not just the em dash: `0 / 0` is `NaN`, so a `theoryNotes` that
    // dropped the guard prints `NaN%` rather than `—` and an assertion naming the dash alone
    // would pass over exactly the defect it was written for.
    expect(within(figure as HTMLElement).queryByText(/%/)).not.toBeInTheDocument();
    expect(within(figure as HTMLElement).queryByText("—")).not.toBeInTheDocument();
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
        <DeckStats {...props({ cards: short(), send: sender({ isPending: true }), onPull })} />
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
          {...props({ cards: short(), send: sender({ isPending: true }), onAddMissing })} />
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
        <DeckStats {...props({ cards: deck, send: sender(), onAddMissing })} />
      </TooltipProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
    view.rerender(
      <TooltipProvider>
        <DeckStats {...props({ cards: deck, send: settled, onAddMissing })} />
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
      <DeckStats {...props({ cards: deck, send: sender() })} />,
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
      <DeckStats {...props({ cards: deck, send: sender({ isPending: true }) })} />,
    );
    expect(document.body).toHaveFocus();

    rerender(
      <DeckStats {...props({ cards: deck, send: sender({ isSuccess: true, data: 3 }) })} />,
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
        <DeckStats {...props({ cards, send: idle })} />,
      );
      await userEvent.click(screen.getByRole("button", { name: pick }));
      await userEvent.click(screen.getByRole("button", { name: "Send missing to wishlist" }));
      view.rerender(
        <DeckStats {...props({ cards, send: settled })} />,
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
   * regression these are really guarding: this change touches the one line of the band a hundred
   * existing decks read every time they are opened, and a fix that emptied it for everybody
   * would pass a bare "the virtual deck draws nothing" check.
   *
   * **Two absences rather than one**, since the 2026-09-10 redesign moved the second: the whole
   * `Collection` card, which is the count and its three presses, and the Figures card's own
   * `Owned` entry. The `All N owned.` fallback this block used to name was the third and is
   * **deleted outright** — the band gates the Collection card on `missing > 0`, so the arm it
   * lived in became unreachable for every deck rather than for a virtual one.
   *
   * The default fixture is short of three copies and owns one; the `Owned` case owns the lot,
   * which is the state its figure would be at its most plausible in.
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

      expect(screen.queryByText("3 of 4 missing")).not.toBeInTheDocument();
      expect(queryCard(COLLECTION_HEADING)).not.toBeInTheDocument();
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
     * **The Figures card's `Owned` entry goes with the block, and it is the same argument one
     * card up.** A count of the copies a reader owns, over a deck they have said they own none
     * of, is arithmetic about a binder that is not there — and it would be the more believable
     * of the two, because it is drawn among figures that are all true.
     *
     * The three figures beside it are asserted present, which is the half that makes this a
     * claim about the prop: a band that drew no Figures card at all would pass a bare absence
     * check while being broken for every deck.
     *
     * The fixture owns every copy, so under `tracksCollection` this deck would read `4` with
     * `every copy` under it — the state the entry is at its most plausible in.
     */
    it("draws no Owned figure either, and keeps the three beside it", () => {
      virtualStrip([card({ name: "Bolt", quantity: 4, ownedQuantity: 4 })]);

      const figures = statsCard("Figures");
      expect(within(figures).queryByText("Owned")).not.toBeInTheDocument();
      expect(within(figures).queryByText("every copy")).not.toBeInTheDocument();
      expect(within(figures).getByText("Cards")).toBeInTheDocument();
      expect(within(figures).getByText("Price")).toBeInTheDocument();
    });

    /** The live region and the refusal line are inside the same block, so a write that somehow
     *  answered would have nowhere to say so — asserted rather than assumed, because a stray
     *  `role="status"` left behind is an empty announcement on every render of the band. */
    it("keeps no live region or refusal line for a write it never makes", () => {
      strip(short(), sender({ isError: true, error: "nope" }), vi.fn(), vi.fn(), false);

      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });

    /** What a deck wants and what a deck costs are facts about the *list*, so the pips and every
     *  chart are untouched. Half of this test is the point of the other half: an implementation
     *  that hid the whole band would satisfy every absence above it. */
    it("keeps the pips and every chart", () => {
      strip(boros(), sender(), vi.fn(), vi.fn(), false);

      expect(pipTile("White")).toHaveTextContent("8 pips · 8 cards");
      for (const title of ["Mana pips", "Card distribution", "Mana curve", "Curve by color"]) {
        expect(statsCard(title)).toBeInTheDocument();
      }
    });
  });
});
