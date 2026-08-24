import { describe, expect, it } from "vitest";
import type { CollectionRow } from "@/lib/ipc";
import { foldCopies, pickCopy, tileName, UNKNOWN_CARD } from "./collectionTiles";
import type { CopySource } from "./useCollectionSearch";

const DESK: CopySource = { kind: "desk", deckName: null };
const HERE: CopySource = { kind: "here", deckName: null };
const other = (deckName: string): CopySource => ({ kind: "otherDeck", deckName });

function row(over: Partial<CollectionRow> = {}): CollectionRow {
  return {
    id: 1,
    cardId: "bolt",
    folderId: null,
    folderName: null,
    name: "Lightning Bolt",
    oracleId: "o-bolt",
    setCode: "lea",
    setName: "Limited Edition Alpha",
    collectorNumber: "161",
    lang: "en",
    rarity: "common",
    manaCost: "{R}",
    typeLine: "Instant",
    layout: "normal",
    finish: "nonfoil",
    condition: "NM",
    quantity: 1,
    tradelistQuantity: 0,
    unitPrice: null,
    purchasePrice: null,
    purchaseCurrency: null,
    acquiredAt: null,
    acquisitionSource: null,
    serialNumber: null,
    altered: false,
    signed: false,
    proxy: false,
    misprint: false,
    grading: null,
    tags: "[]",
    notes: null,
    needsReview: null,
    updatedAt: 0,
    promoTypes: null,
    legalities: null,
    ...over,
  };
}

/** A `sourceOf` built from a map of row id → answer, so a case reads as a table. */
const sourceFrom =
  (byId: Record<number, CopySource>) =>
  (r: CollectionRow): CopySource =>
    byId[r.id] ?? DESK;

describe("pickCopy", () => {
  /**
   * **The whole reason the wall is allowed to fold.** A reader holding a loose copy and one in
   * another deck adds the loose one, silently — so the confirmation the tab exists for is raised
   * only when it is genuinely needed, and a deck they are not looking at keeps its card.
   *
   * The desk key is this file's own; the two below it are `chooseFreeCopy`'s, so a copy picked
   * here is the copy the card-search tab's own add would have picked.
   */
  it("prefers a copy on the desk to one another deck is holding", () => {
    const spoken = { row: row({ id: 1 }), source: other("Mono-Red Aggro") };
    const loose = { row: row({ id: 2 }), source: DESK };

    expect(pickCopy([spoken, loose])?.row.id).toBe(2);
    // Order in is not the answer: the ranking is the answer.
    expect(pickCopy([loose, spoken])?.row.id).toBe(2);
  });

  /** A proxy is a slot rather than a card, so a real copy outranks it. */
  it("prefers a real copy to a proxy", () => {
    const proxy = { row: row({ id: 1, proxy: true }), source: DESK };
    const real = { row: row({ id: 2 }), source: DESK };

    expect(pickCopy([proxy, real])?.row.id).toBe(2);
  });

  /**
   * With nothing else to separate two copies, the one recorded first is the one they have had
   * longest — **compared as numbers**, which is the trap `chooseFreeCopy` documents: an array or
   * string comparison ranks entry 10 above entry 9.
   */
  it("falls back to the oldest entry, compared as a number", () => {
    const later = { row: row({ id: 10 }), source: DESK };
    const older = { row: row({ id: 9 }), source: DESK };

    expect(pickCopy([later, older])?.row.id).toBe(9);
  });

  /**
   * **A copy this deck already holds is not a candidate at any key**, because
   * `collection_alloc::ALREADY_HERE` refuses it in words — offering it would be offering a press
   * that cannot land. `null` is what makes the tile say so instead of pressing and finding out.
   */
  it("never offers a copy this deck already holds", () => {
    expect(pickCopy([{ row: row(), source: HERE }])).toBeNull();
    // And it is filtered rather than ranked last: a deck copy beside it still wins.
    const spoken = { row: row({ id: 2 }), source: other("Mono-Red Aggro") };
    expect(pickCopy([{ row: row({ id: 1 }), source: HERE }, spoken])?.row.id).toBe(2);
  });

  it("answers null for nothing at all", () => {
    expect(pickCopy([])).toBeNull();
  });
});

describe("tileName", () => {
  it("uses the card's name", () => {
    expect(tileName(row())).toBe("Lightning Bolt");
  });

  /** A printing `cards` has forgotten still has the set and the number the entry recorded, and on
   *  a wall of art that is the whole of what identifies it. */
  it("falls back to the printing an orphan recorded", () => {
    expect(tileName(row({ name: null }))).toBe("LEA 161");
  });

  /**
   * **The row that used to take the whole editor down.** `CollectionRow` types `setCode` as
   * present and a type is a claim about the wire, not a guarantee about the object in hand —
   * `row.setCode.toUpperCase()` threw during render until 2026-08-23, on the tab the panel opens
   * on. Each field is read on its own, so half a printing still names half a printing.
   */
  it("survives a row carrying none of the facts, and says what it has", () => {
    expect(tileName({} as CollectionRow)).toBe(UNKNOWN_CARD);
    expect(tileName({ setCode: "lea" } as CollectionRow)).toBe("LEA");
    expect(tileName({ collectorNumber: "161" } as CollectionRow)).toBe("161");
  });
});

describe("foldCopies", () => {
  /**
   * One tile per printing, with the copies of every row behind it summed — the fold itself.
   *
   * Three rows of one card, in three places and two finishes, is one piece of art. The badge over
   * it counts all of them, because they are all copies the reader owns.
   */
  it("folds the rows of one printing into a single tile", () => {
    const rows = [
      row({ id: 1, quantity: 3 }),
      row({ id: 2, quantity: 1, folderId: 12, folderName: "Trade binder" }),
      row({ id: 3, quantity: 1, finish: "foil", folderId: 11, folderName: "Mono-Red Aggro" }),
    ];

    const tiles = foldCopies(rows, sourceFrom({ 3: other("Mono-Red Aggro") }));

    expect(tiles).toHaveLength(1);
    expect(tiles[0].id).toBe("bolt");
    expect(tiles[0].copies).toBe(5);
    expect(tiles[0].add?.id).toBe(1);
    expect(tiles[0].from).toEqual(DESK);
  });

  /** Two printings are two tiles, and the backend's order is kept — so the sort the reader picked
   *  in the filter row survives the fold. */
  it("keeps one tile per printing, in the order the rows arrived", () => {
    const rows = [
      row({ id: 1, cardId: "sol", name: "Sol Ring" }),
      row({ id: 2, cardId: "bolt" }),
      row({ id: 3, cardId: "sol", name: "Sol Ring" }),
    ];

    expect(foldCopies(rows, sourceFrom({})).map((t) => t.id)).toEqual(["sol", "bolt"]);
  });

  /**
   * **The finish is marked only when the copies agree**, because the mark is a claim about the
   * cardboard in the picture: a reader holding one foil and one nonfoil owns neither "a foil" nor
   * "a nonfoil", and the honest wall for that is an unmarked one.
   */
  it("marks a finish only when every copy is in it", () => {
    const one = foldCopies([row({ finish: "foil" })], sourceFrom({}));
    expect(one[0].finish).toBe("foil");

    const mixed = foldCopies(
      [row({ id: 1, finish: "foil" }), row({ id: 2, finish: "nonfoil" })],
      sourceFrom({}),
    );
    expect(mixed[0].finish).toBeNull();
  });

  /** A word this build cannot name marks nothing rather than marking the art with a sheen no
   *  stylesheet has — `finish` is TEXT with a CHECK, not an enum this side knows. */
  it("marks nothing for a finish it does not recognise", () => {
    expect(foldCopies([row({ finish: "galaxy" })], sourceFrom({}))[0].finish).toBeNull();
  });

  /** Every copy in this deck is a tile with nothing to add, which is what the button greys on. */
  it("hands over no copy when the deck already holds them all", () => {
    const tiles = foldCopies([row({ id: 1 }), row({ id: 2 })], () => HERE);

    expect(tiles[0].add).toBeNull();
    expect(tiles[0].from).toBeNull();
    expect(tiles[0].here).toBe(2);
  });

  /**
   * **A partial row is drawn rather than fatal**, which is the same defensiveness {@link tileName}
   * carries reached through the whole fold: no field of `GridCard` comes out `undefined`, and a
   * quantity that is not a number counts as none rather than as `NaN` over a card's art.
   */
  it("survives a row missing everything the wire says is there", () => {
    const bare = { id: 7, cardId: "ghost" } as unknown as CollectionRow;

    const tiles = foldCopies([bare], sourceFrom({}));

    expect(tiles[0]).toMatchObject({
      id: "ghost",
      name: UNKNOWN_CARD,
      setCode: "",
      collectorNumber: "",
      rarity: null,
      copies: 0,
      finish: null,
    });
    // It is still addable — the entry exists, it is simply not describable.
    expect(tiles[0].add).toBe(bare);
  });
});
