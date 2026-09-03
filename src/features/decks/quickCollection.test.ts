import { describe, expect, it } from "vitest";
import type { DeckCard, DeckPullCandidate, DeckPullRow, DeckQuickAddWish } from "@/lib/ipc";
import { chooseWish, choosePull, quickAddBlock, quickAddShort } from "./quickCollection";

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

const candidate = (over: Partial<DeckPullCandidate> = {}): DeckPullCandidate => ({
  entryId: 21,
  quantity: 1,
  folderId: null,
  folderName: null,
  folderKind: null,
  condition: "NM",
  lang: "en",
  altered: false,
  signed: false,
  proxy: false,
  misprint: false,
  grading: null,
  serialNumber: null,
  ...over,
});

const row = (over: Partial<DeckPullRow> = {}): DeckPullRow => ({
  cardId: "p1",
  name: "Lightning Bolt",
  setCode: "lea",
  collectorNumber: "161",
  finish: null,
  short: 2,
  categories: ["Main deck"],
  candidates: [candidate()],
  ...over,
});

const wish = (over: Partial<DeckQuickAddWish> = {}): DeckQuickAddWish => ({
  id: 7,
  quantity: 3,
  folderId: null,
  folderName: null,
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
  /** The live case, which is the only one that presses anything. */
  it("blocks nothing on a live row that is short", () => {
    expect(quickAddBlock(card({ quantity: 4, ownedQuantity: 1 }))).toBeNull();
  });

  /**
   * **A plan holds no cards** (`deck.rs`'s rule 2), so a theory row's `ownedQuantity` is zeroed
   * explicitly however full the shelf is — which means the shortfall arithmetic would answer the
   * row's whole quantity and offer to record cardboard for a list that holds none. The backend
   * refuses it too; this is the surface saying so in advance, where a reader can read the reason.
   *
   * Asserted on a row that is short **and** on one that is not, because `theory` has to win: a
   * theory row's own numbers can say anything.
   */
  it("blocks a theory row whatever its numbers say", () => {
    expect(quickAddBlock(card({ variant: "theory", quantity: 4, ownedQuantity: 0 }))).toBe(
      "theory",
    );
    expect(quickAddBlock(card({ variant: "theory", quantity: 4, ownedQuantity: 4 }))).toBe(
      "theory",
    );
  });

  it("blocks a row the group already fills", () => {
    expect(quickAddBlock(card({ quantity: 4, ownedQuantity: 4 }))).toBe("nothing-missing");
    expect(quickAddBlock(card({ quantity: 2, ownedQuantity: 9 }))).toBe("nothing-missing");
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
    expect(quickAddBlock(card({ categoryActive: false, quantity: 4, ownedQuantity: 0 }))).toBe(
      "inactive",
    );
  });

  /**
   * **The arm is ahead of the shortfall test**, and this is what says so. On an inactive row the
   * shortfall is `quantity` for *every* such row — `ownedQuantity` is zeroed by the read — so an
   * `inactive` arm placed after `nothing-missing` would be reachable only for a zero-quantity row,
   * which `deck_cards` has none of. Ordering it the other way passes the case above and still
   * offers the press on every real Maybeboard line.
   */
  it("says inactive rather than nothing-missing for a switched-off pile the group fills", () => {
    expect(quickAddBlock(card({ categoryActive: false, quantity: 4, ownedQuantity: 4 }))).toBe(
      "inactive",
    );
  });

  /** A theory row in a switched-off pile is still answered as the plan it is: `theory` is the
   *  stronger statement, and the backend refuses it for that reason rather than for this one. */
  it("prefers theory over inactive when a row is both", () => {
    expect(quickAddBlock(card({ variant: "theory", categoryActive: false, quantity: 4 }))).toBe(
      "theory",
    );
  });
});

describe("chooseWish", () => {
  /** Most cards a reader records are on no shopping list, and the add still happens — the press
   *  is "record these, and clear a wish if there is one". */
  it("asks nothing when no wish matches", () => {
    expect(chooseWish([])).toEqual({ kind: "none" });
  });

  /** **One is removed with no dialog.** A picker offering a single row asks the reader to
   *  confirm the only thing it could have done. */
  it("takes a lone wish without asking", () => {
    const only = wish({ id: 7 });

    expect(chooseWish([only])).toEqual({ kind: "one", wish: only });
  });

  /**
   * **Two is the fork**, and the boundary is what this pins: which shopping list a copy comes off
   * is a filing decision the reader made on purpose, so the app must not pick one. The array is
   * handed back **as it arrived** — the backend's order is the pre-pick and a sort here would be
   * a second opinion about it.
   */
  it("asks once there are two, and hands the order back untouched", () => {
    const root = wish({ id: 7, folderId: null, folderName: null });
    const filed = wish({ id: 9, folderId: 3, folderName: "Christmas list" });

    expect(chooseWish([root, filed])).toEqual({ kind: "many", wishes: [root, filed] });
    // The reverse order comes back reversed: nothing here re-ranks.
    expect(chooseWish([filed, root])).toEqual({ kind: "many", wishes: [filed, root] });
  });
});

describe("choosePull", () => {
  /**
   * **A lone candidate is unambiguous, and the picks are the plan's own arithmetic.** One pile to
   * take from is the only thing a dialog could have offered, so the press goes straight through.
   */
  it("takes a lone candidate without asking", () => {
    const plan = [row({ short: 2, candidates: [candidate({ entryId: 21, quantity: 4 })] })];

    expect(choosePull(plan, card())).toEqual({ kind: "take", picks: [{ entryId: 21, quantity: 2 }] });
  });

  /**
   * **Taking too little is a normal answer, and it is still not a fork.** The rule is
   * `candidates.length >= 2` and nothing else — a single pile holding one copy against a
   * shortfall of two is one pile, and filling one of two holes is worth doing.
   */
  it("takes what a lone short candidate has rather than asking", () => {
    const plan = [row({ short: 2, candidates: [candidate({ entryId: 21, quantity: 1 })] })];

    expect(choosePull(plan, card())).toEqual({ kind: "take", picks: [{ entryId: 21, quantity: 1 }] });
  });

  /** **Two candidates is the one fork.** Which binder a copy leaves is the reader's filing. */
  it("asks once two piles could supply the card", () => {
    const plan = [
      row({
        short: 2,
        candidates: [candidate({ entryId: 21, quantity: 1 }), candidate({ entryId: 22, quantity: 4 })],
      }),
    ];

    expect(choosePull(plan, card())).toEqual({ kind: "ask" });
  });

  /**
   * **No row is `ask`, deliberately**: a card with no unallocated copy anywhere is the commonest
   * way to press this and be told nothing can happen, and the dialog already words that case. A
   * second sentence here would be the same fact said twice from two files.
   */
  it("asks when the plan has no row for this card at all", () => {
    expect(choosePull([], card())).toEqual({ kind: "ask" });
    expect(choosePull([row({ cardId: "other" })], card())).toEqual({ kind: "ask" });
  });

  /**
   * **The finish is half the key.** A deck holding the foil beside the regular copy is two rows
   * on `deck_cards`' own grain, two shortfalls, and two piles of cardboard — so a press on the
   * foil row must not be answered by the regular row's candidates.
   */
  it("matches on the printing and the finish together", () => {
    const regular = row({ finish: null, candidates: [candidate({ entryId: 21, quantity: 4 })] });
    const foil = row({ finish: "foil", candidates: [candidate({ entryId: 22, quantity: 4 })] });
    const plan = [regular, foil];

    expect(choosePull(plan, card({ finish: "foil" }))).toEqual({
      kind: "take",
      picks: [{ entryId: 22, quantity: 2 }],
    });
    expect(choosePull(plan, card({ finish: null }))).toEqual({
      kind: "take",
      picks: [{ entryId: 21, quantity: 2 }],
    });
    // A finish the plan has no row for is no row, not the nearest one.
    expect(choosePull(plan, card({ finish: "etched" }))).toEqual({ kind: "ask" });
  });

  /**
   * A lone candidate holding nothing yields no pick at all, and an empty batch is not something
   * to send: the dialog explains, this does not. Not reachable through the backend's own contract
   * — a candidate is a row that holds copies — which is exactly why it is pinned rather than
   * assumed away.
   */
  it("asks rather than sending an empty batch", () => {
    const plan = [row({ short: 2, candidates: [candidate({ entryId: 21, quantity: 0 })] })];

    expect(choosePull(plan, card())).toEqual({ kind: "ask" });
  });

  /**
   * The picks are a **copy** of the plan's array, not the array itself: `deckPullFromCollection`
   * takes a mutable payload and the plan belongs to a query cache a dialog may still be drawing
   * from. Mutating what comes back must not reach back into it.
   */
  it("hands back picks the caller may mutate", () => {
    const plan = [row({ short: 2, candidates: [candidate({ entryId: 21, quantity: 4 })] })];
    const choice = choosePull(plan, card());

    if (choice.kind !== "take") throw new Error("expected a take");
    choice.picks.push({ entryId: 99, quantity: 1 });

    expect(plan[0].candidates).toHaveLength(1);
    expect(plan[0].candidates[0]).toEqual(candidate({ entryId: 21, quantity: 4 }));
  });
});
