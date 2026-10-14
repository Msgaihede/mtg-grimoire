import { describe, expect, it } from "vitest";
import type { DeckCard, DeckQuickAddWish } from "@/lib/ipc";
import {
  chooseWish,
  missingPicks,
  quickAddBlock,
  quickAddShort,
} from "./quickCollection";

/**
 * A live row of the Main deck: four copies wanted, two of them in the deck's group.
 *
 * The whole `DeckCard` rather than a `Pick<>`, because the functions under test take one and a
 * narrowed fixture would let a field they start reading arrive as `undefined`.
 */
const BOLT: DeckCard = {
  id: 9,
  cardId: "p1",
  categoryId: 1,
  categoryName: "Main deck",
  categoryKind: "main",
  categoryActive: true,
  variant: "live",
  labelId: null,
  labelName: null,
  labelColor: null,
  quantity: 4,
  name: "Lightning Bolt",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  lang: "en",
  finish: null,
  needsReview: null,
  oracleId: "o1",
  manaCost: "{R}",
  cmc: 1,
  typeLine: "Instant",
  oracleText: "Lightning Bolt deals 3 damage to any target.",
  colors: "R",
  colorIdentity: "R",
  producedMana: "",
  legalities: '{"modern":"legal"}',
  power: null,
  toughness: null,
  layout: "normal",
  rarity: "common",
  faces: null,
  gameChanger: false,
  finishes: null,
  promoTypes: null,
  everUncommon: false,
  unitPrice: 4.5,
  ownedQuantity: 2,
};

const card = (over: Partial<DeckCard> = {}): DeckCard => ({ ...BOLT, ...over });

/**
 * A printing Scryfall sells only in foil — issue #563's Palantír of Orthanc, HOC 85 — and one sold
 * in both. The plan is folded on the finish a row *plays*, so what `finishes` says decides whether
 * a row that stored no finish is the foil (the first) or the regular copy (the second).
 */
const FOIL_ONLY = '["foil"]';
const FOILABLE = '["nonfoil","foil"]';

const wish = (over: Partial<DeckQuickAddWish> = {}): DeckQuickAddWish => ({
  id: 7,
  quantity: 3,
  folderId: null,
  folderName: null,
  cardId: "bolt",
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  preferredFinish: null,
  ...over,
});

describe("quickAddShort", () => {
  /** The number the menu label quotes, and the number the chin draws — one arithmetic, and the
   *  literals here are what stop a sign error passing as a rewrite. */
  it("is the copies the row wants over the copies the group holds", () => {
    expect(quickAddShort(card({ quantity: 4, ownedQuantity: 0 }))).toBe(4);
    expect(quickAddShort(card({ quantity: 4, ownedQuantity: 3 }))).toBe(1);
    expect(quickAddShort(card({ quantity: 1, ownedQuantity: 0 }))).toBe(1);
  });

  /**
   * **A group holding more than the list asks for is an ordinary state, not a bad one** — a
   * reader who cut a 4-copy line to 2 without taking the cardboard out of the deck's box. The
   * floor is what keeps that from reading as a negative shortfall, and `-1` on a menu row would
   * be a label offering to record a copy backwards.
   */
  it("floors at zero when the deck holds more than it lists", () => {
    expect(quickAddShort(card({ quantity: 2, ownedQuantity: 5 }))).toBe(0);
  });
});

describe("quickAddBlock", () => {
  /**
   * **A deck that reads the collection**, which every case below but one is about — spelled out
   * as a named constant rather than repeated as a bare `true`, so the one case that passes
   * `false` is visibly the case it is about rather than a typo in a column of booleans.
   */
  const TRACKS = true;

  /** The live case, which is the only one that presses anything. */
  it("blocks nothing on a live row that is short", () => {
    expect(quickAddBlock(card({ quantity: 4, ownedQuantity: 1 }), TRACKS)).toBeNull();
  });

  /**
   * **A plan holds no cardboard** (`deck.rs`'s rule 2), so there is nowhere for a quick add to
   * file copies and nothing for a pull to move. The backend refuses all three; this is the
   * surface saying so in advance, where a reader can read the reason.
   *
   * **The argument changed on 2026-09-09 and the arm did not**
   * ([issue #435](https://github.com/Msgaihede/mtg-grimoire/issues/435)). It used to be that a
   * theory row's `ownedQuantity` was *zeroed explicitly*, so the shortfall arithmetic would have
   * answered the row's whole quantity; a plan's rows carry a truthful count now, so
   * `quickAddShort` would answer a real number here. It is still blocked, because a count of what
   * a plan *could* use is not a place to put cardboard.
   *
   * Asserted on a row that is short **and** on one that is not, because `theory` has to win: a
   * theory row's own numbers can say anything, and since #435 they usually say something.
   */
  it("blocks a theory row whatever its numbers say", () => {
    expect(quickAddBlock(card({ variant: "theory", quantity: 4, ownedQuantity: 0 }), TRACKS)).toBe(
      "theory",
    );
    expect(quickAddBlock(card({ variant: "theory", quantity: 4, ownedQuantity: 4 }), TRACKS)).toBe(
      "theory",
    );
  });

  it("blocks a row the group already fills", () => {
    expect(quickAddBlock(card({ quantity: 4, ownedQuantity: 4 }), TRACKS)).toBe("nothing-missing");
    expect(quickAddBlock(card({ quantity: 2, ownedQuantity: 9 }), TRACKS)).toBe("nothing-missing");
  });

  /**
   * **The third deck kind** (issue #401), and the arm is asserted on the row that looks most
   * pressable: an ordinary `live` row of an active pile, short by three, which every other test in
   * this file would call `null`. Nothing about the *row* says the deck holds no cardboard — a
   * virtual deck's rows are ordinary `live` rows on purpose, because `DeckRow.cardCount` and the
   * gallery's colour bar both count `variant = 'live'` — so the flag is the only thing that can
   * answer, and passing it is what this case is about.
   *
   * **A shortfall of 0 is asserted too**, for the theory case's reason: `virtual` has to win over
   * `nothing-missing` as well as over `null`, or the arm would be reachable only for the rows the
   * reader could not press anyway.
   */
  it("blocks every row of a deck that tracks no cardboard", () => {
    expect(quickAddBlock(card({ quantity: 4, ownedQuantity: 1 }), false)).toBe("virtual");
    expect(quickAddBlock(card({ quantity: 4, ownedQuantity: 4 }), false)).toBe("virtual");
  });

  /**
   * **The arm is ahead of both tests below it**, which is `inactive`'s own ordering argument one
   * kind out: a virtual deck has no `collection_folders` group, so `owned_by_printing` joins
   * nothing and *every* row reads `0` owned — the shortfall is `quantity` for all of them. An arm
   * placed after `nothing-missing` would still answer `virtual` here (the row is short), so the
   * case that proves the order is the **switched-off pile**, where `inactive` would otherwise take
   * the row first and name a pile switch as the cure for a deck that has no binder to fill.
   */
  it("says virtual rather than inactive for a switched-off pile of a virtual deck", () => {
    expect(quickAddBlock(card({ categoryActive: false, quantity: 4 }), false)).toBe("virtual");
  });

  /**
   * **The defect a live pass found, and the reason it could not be found here first.**
   * `attribute_owned` hands a switched-off pile nothing out of the deck's group, so a row in one
   * reads `0` owned however many copies the folder holds — every fixture in this file uses an
   * active category, which is why `0/4` looked like a shortfall for the length of one fan-out.
   * The press was legal and the copies were recorded, and the row still read `0/4` afterwards: a
   * control whose number never moves is one a reader presses again. Driving the shipped window
   * put two copies into one folder from two presses on a Maybeboard line.
   */
  it("blocks a row in a switched-off pile, whose owned count can never move", () => {
    expect(
      quickAddBlock(card({ categoryActive: false, quantity: 4, ownedQuantity: 0 }), TRACKS),
    ).toBe("inactive");
  });

  /**
   * **The arm is ahead of the shortfall test**, and this is what says so. On an inactive row the
   * shortfall is `quantity` for *every* such row — `ownedQuantity` is zeroed by the read — so an
   * `inactive` arm placed after `nothing-missing` would be reachable only for a zero-quantity row,
   * which `deck_cards` has none of. Ordering it the other way passes the case above and still
   * offers the press on every real Maybeboard line.
   */
  it("says inactive rather than nothing-missing for a switched-off pile the group fills", () => {
    expect(
      quickAddBlock(card({ categoryActive: false, quantity: 4, ownedQuantity: 4 }), TRACKS),
    ).toBe("inactive");
  });

  /** A theory row in a switched-off pile is still answered as the plan it is: `theory` is the
   *  stronger statement, and the backend refuses it for that reason rather than for this one. */
  it("prefers theory over inactive when a row is both", () => {
    expect(
      quickAddBlock(card({ variant: "theory", categoryActive: false, quantity: 4 }), TRACKS),
    ).toBe("theory");
  });
});

describe("chooseWish", () => {
  /** Most cards a reader records are on no shopping list, and the add still happens — the press
   *  is "record these, and clear a wish if there is one". */
  it("asks nothing when no wish matches", () => {
    expect(chooseWish([])).toEqual({ kind: "none" });
  });

  /**
   * **One still asks** (issue #511): the read answers every printing and finish of the card, so a
   * lone line may be for another printing than the one recorded, and only the reader knows
   * whether this purchase settles it. This case used to take the lone wish without a dialog.
   */
  it("asks about a lone wish too", () => {
    const only = wish({ id: 7 });

    expect(chooseWish([only])).toEqual({ kind: "ask", wishes: [only] });
  });

  /** The array is handed back **as it arrived** — the backend's order is the pre-pick and a sort
   *  here would be a second opinion about it. */
  it("hands the order back untouched", () => {
    const root = wish({ id: 7, folderId: null, folderName: null });
    const filed = wish({ id: 9, folderId: 3, folderName: "Christmas list" });

    expect(chooseWish([root, filed])).toEqual({ kind: "ask", wishes: [root, filed] });
    // The reverse order comes back reversed: nothing here re-ranks.
    expect(chooseWish([filed, root])).toEqual({ kind: "ask", wishes: [filed, root] });
  });
});

/** Issue #510: a picked set's quick add goes out as the deck-wide record's picks. */
describe("missingPicks", () => {
  /** A printing short in two piles is two deck rows and one address, so one pick of the sum. */
  it("folds two rows of one printing and finish into one pick", () => {
    const main = card({ id: 1, categoryId: 1 });
    const side = card({ id: 2, categoryId: 2 });
    const bear = card({ id: 3, cardId: "p2" });

    expect(
      missingPicks([
        { card: main, copies: 2 },
        { card: bear, copies: 1 },
        { card: side, copies: 3 },
      ]),
    ).toEqual([
      { cardId: "p1", finish: null, quantity: 5 },
      { cardId: "p2", finish: null, quantity: 1 },
    ]);
  });

  it("keeps the foil and the regular copy apart, and drops a zero", () => {
    expect(
      missingPicks([
        { card: card(), copies: 1 },
        { card: card({ finish: "foil" }), copies: 2 },
        { card: card({ cardId: "p3" }), copies: 0 },
      ]),
    ).toEqual([
      { cardId: "p1", finish: null, quantity: 1 },
      { cardId: "p1", finish: "foil", quantity: 2 },
    ]);
  });

  /**
   * **Folded on the finish a row plays, and that finish is what is sent** (issue #563's
   * follow-up). A foil-only printing added once from the search (no finish stored) and once out of
   * the binder (`"foil"`) is one address to `deck_missing_to_collection` — the plan folds the two
   * into one row — so it is one pick, and it names the foil even though the first row said
   * nothing. A printing sold in both finishes keeps its two picks: its unsaid row is the regular
   * copy, which is a different piece of cardboard from the foil.
   */
  it("folds a foil-only printing's two spellings into one foil pick", () => {
    expect(
      missingPicks([
        { card: card({ cardId: "palantir", finish: null, finishes: FOIL_ONLY }), copies: 1 },
        { card: card({ cardId: "m10", finish: null, finishes: FOILABLE }), copies: 1 },
        { card: card({ cardId: "palantir", finish: "foil", finishes: FOIL_ONLY }), copies: 2 },
        { card: card({ cardId: "m10", finish: "foil", finishes: FOILABLE }), copies: 3 },
      ]),
    ).toEqual([
      { cardId: "palantir", finish: "foil", quantity: 3 },
      { cardId: "m10", finish: null, quantity: 1 },
      { cardId: "m10", finish: "foil", quantity: 3 },
    ]);
  });
});
