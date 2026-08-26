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
   * One tile per printing **and finish**, with the copies of every row behind it summed — the
   * fold itself.
   *
   * Three rows of one card here, in three places: a loose nonfoil, a nonfoil in a drawer and a
   * foil another deck is holding. The two nonfoils are one piece of art whatever drawer they are
   * in; the foil is a different object at a different price, so it is a tile of its own.
   *
   * **This case asserted one tile until 2026-08-26**, when the finish joined the key — see
   * "draws a foil and a nonfoil of one printing as two tiles" for the reasoning.
   */
  it("folds the rows of one printing in one finish into a single tile", () => {
    const rows = [
      row({ id: 1, quantity: 3 }),
      row({ id: 2, quantity: 1, folderId: 12, folderName: "Trade binder" }),
      row({ id: 3, quantity: 1, finish: "foil", folderId: 11, folderName: "Mono-Red Aggro" }),
    ];

    const tiles = foldCopies(rows, sourceFrom({ 3: other("Mono-Red Aggro") }));

    expect(tiles).toHaveLength(2);
    expect(tiles[0].id).toBe("bolt");
    expect(tiles[0].copies).toBe(4);
    expect(tiles[0].add?.id).toBe(1);
    expect(tiles[0].from).toEqual(DESK);
    // The foil stands alone, and its own press names the deck the copy would come out of.
    expect(tiles[1].copies).toBe(1);
    expect(tiles[1].add?.id).toBe(3);
    expect(tiles[1].from).toEqual(other("Mono-Red Aggro"));
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

  /* **"marks a finish only when every copy is in it" stood here** and is deleted rather than
     repaired. It asserted that a tile holding a foil and a nonfoil marked neither, which was the
     honest answer while such a tile existed; the finish is part of the key now, so it does not.
     What is left of it — a tile marks the finish its rows are in — is asserted by "draws a foil
     and a nonfoil of one printing as two tiles" below, on both of the tiles that case produces. */

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

  /**
   * **A foil and a played nonfoil of one printing are two objects**: two prices, two pictures,
   * sharing only a set and a number. The wall drew them as one tile and had to ask whether the
   * entries agreed about their finish; splitting the key removes the question.
   *
   * The two tiles carry one `id` — the printing is what a press opens — and are told apart by
   * `key`, which is what the ring, the arrow walk and the picked set are about.
   */
  it("draws a foil and a nonfoil of one printing as two tiles", () => {
    const tiles = foldCopies(
      [
        row({ id: 1, cardId: "bolt", finish: "foil", quantity: 1, unitPrice: 9 }),
        row({ id: 2, cardId: "bolt", finish: "nonfoil", quantity: 2, unitPrice: 1 }),
      ],
      sourceFrom({}),
    );

    expect(tiles).toHaveLength(2);
    expect(tiles.map((t) => t.finish)).toEqual(["foil", "nonfoil"]);
    expect(tiles.map((t) => t.unitPrice)).toEqual([9, 1]);
    expect(tiles.map((t) => t.copies)).toEqual([1, 2]);
    expect(tiles.map((t) => t.key)).toEqual(["bolt:foil", "bolt:nonfoil"]);
    expect(tiles.map((t) => t.id)).toEqual(["bolt", "bolt"]);
  });

  /**
   * Condition, folder and language do **not** split it. Those are one object at one price, and
   * the table below is where a reader gets them apart — so a printing filed in two places is
   * still one piece of art with both folders' copies counted behind it.
   */
  it("keeps two folders' worth of one finish as one tile", () => {
    const tiles = foldCopies(
      [
        row({ id: 1, cardId: "bolt", finish: "nonfoil", folderId: null, quantity: 1 }),
        row({
          id: 2,
          cardId: "bolt",
          finish: "nonfoil",
          folderId: 7,
          folderName: "Trade binder",
          quantity: 3,
        }),
      ],
      sourceFrom({}),
    );

    expect(tiles).toHaveLength(1);
    expect(tiles[0].copies).toBe(4);
  });

  /**
   * Every tile is one finish, so the art can always be marked — **and the mark is true of every
   * copy the tile counts**, which is the claim it actually makes.
   *
   * This is the case the deleted "marks a finish only when every copy is in it" used to guard from
   * the other side, restated in the new grain: three rows and two tiles, each tile summing only
   * its own finish. Under a fold keyed on the card alone it is one tile marked `nonfoil` — its
   * first row's — counting all six copies, which is the mark claiming cardboard that is not there.
   *
   * **It is written over a tile with more than one row behind it on purpose.** "Two finishes are
   * two tiles" is asserted above, and one row per tile makes containment true by arithmetic; this
   * is the one case where a tile could hold a copy its own mark denies.
   */
  it("marks each tile with the finish of every copy behind it", () => {
    const tiles = foldCopies(
      [
        row({ id: 1, finish: "nonfoil", quantity: 2 }),
        row({ id: 2, finish: "foil", quantity: 1 }),
        row({ id: 3, finish: "nonfoil", quantity: 3, folderId: 12, folderName: "Trade binder" }),
      ],
      sourceFrom({}),
    );

    expect(tiles.map((t) => [t.finish, t.copies])).toEqual([
      ["nonfoil", 5],
      ["foil", 1],
    ]);
  });

  /**
   * {@link pickCopy} now ranks **within one finish**, which is strictly more correct: a foil
   * tile's "add" can no longer reach for a nonfoil copy the reader did not point at.
   *
   * The nonfoil is the **older** entry here, which is the third of `pickCopy`'s keys — so under
   * the old fold, where both copies stood behind one tile, that tile's press would have handed
   * over the nonfoil row. That is what makes this a case rather than a restatement.
   */
  it("never offers a nonfoil copy to add from a foil tile", () => {
    const tiles = foldCopies(
      [row({ id: 2, finish: "foil" }), row({ id: 1, finish: "nonfoil" })],
      sourceFrom({}),
    );

    const foil = tiles.find((t) => t.finish === "foil")!;
    expect(foil.add?.finish).toBe("foil");
    expect(foil.add?.id).toBe(2);
  });
});
