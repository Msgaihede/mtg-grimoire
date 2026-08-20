import { describe, expect, it } from "vitest";
import { listWalkStops, type WalkRow } from "./cardWalk";

/**
 * The walk a card list publishes: the drawn order, minus the rows the printings modal could not
 * survive landing on.
 *
 * The order itself is nobody's claim here — it is whatever the page handed over, and each page's
 * own tests are where "this is the order the reader is looking at" is checked. What this file is
 * about is the three rules that are the same on all three of them.
 */

/** A row as any of the three lists would hand one over. */
const row = (cardId: string | null, oracleId: string | null, name: string): WalkRow => ({
  cardId,
  oracleId,
  name,
});

const ids = (rows: readonly WalkRow[]) => listWalkStops(rows, (r) => r).map((s) => s.cardId);

describe("listWalkStops", () => {
  /** The order is the surface's, verbatim: the next card is the next tile on the wall, whatever
   *  the filter bar and the sorted header have made that. */
  it("keeps the order it was handed", () => {
    expect(
      ids([row("c1", "o1", "Sol Ring"), row("c2", "o2", "Bolt"), row("c3", "o3", "Forest")]),
    ).toEqual(["c1", "c2", "c3"]);
  });

  /** Every stop is a plain one. `deck` is the field the modal branches on — a step onto a deck row
   *  re-anchors the card pane to it — and no row of a search result, a collection or a wishlist is
   *  one. */
  it("marks every stop as belonging to no deck row", () => {
    expect(listWalkStops([row("c1", "o1", "Sol Ring")], (r) => r)).toEqual([
      { cardId: "c1", oracleId: "o1", name: "Sol Ring", deck: null },
    ]);
  });

  /**
   * An orphan: the printing has left the card database, so `oracleId` is null on a LEFT JOIN.
   * There are no printings to list for one, so it is not a stop on a walk *through printings* —
   * stepping there would open a modal with nothing in it and no sentence saying why.
   *
   * The neighbours are what make this a test about skipping rather than about filtering: the row
   * comes out of the middle and the two either side stay adjacent.
   */
  it("steps over a row whose printing has left the corpus", () => {
    expect(
      ids([row("c1", "o1", "Sol Ring"), row("c2", null, "Ghost"), row("c3", "o3", "Forest")]),
    ).toEqual(["c1", "c3"]);
  });

  /** An any-printing wish names a card but no cardboard: nothing for the pane to open and nothing
   *  for the wall to ring. The wishlist offers it no card menu either, so it could never have been
   *  a walk's first stop. */
  it("steps over a row that names no printing", () => {
    expect(
      ids([row("c1", "o1", "Sol Ring"), row(null, "o2", "Bolt"), row("c3", "o3", "Forest")]),
    ).toEqual(["c1", "c3"]);
  });

  /**
   * **Two rows naming one printing are one stop, and the first drawing of it wins.**
   *
   * A collection holds one printing as a foil entry and a played nonfoil entry: two rows of the
   * table, one tile of the wall, and the same wall with the same ring from the modal either way.
   * A stop for each would be a press that moved nothing on screen, which reads as a dead key
   * rather than as the end of a list.
   *
   * This is deliberately **not** the deck's rule — `deckWalkStops` keeps one card filed in two
   * piles as two stops, because there a press writes to the row that was stepped onto.
   */
  it("collapses two rows that name the same printing", () => {
    expect(
      ids([row("c1", "o1", "Sol Ring"), row("c1", "o1", "Sol Ring"), row("c2", "o2", "Bolt")]),
    ).toEqual(["c1", "c2"]);
  });

  /**
   * Two *different* printings of one card stay two stops. The wall does not change between them —
   * it is the same oracle card — but the ring does, and so does the card selected on the page
   * behind the scrim, which is the list the reader is stepping through.
   */
  it("keeps two printings of one card as two stops", () => {
    expect(ids([row("c1", "o1", "Sol Ring"), row("c2", "o1", "Sol Ring")])).toEqual(["c1", "c2"]);
  });

  /** A list nobody has put anything on yet, and a list of nothing but orphans: both are a walk of
   *  no length, which is what the store collapses to its one empty walk. */
  it("answers nothing for a list with no stops on it", () => {
    expect(listWalkStops([], (r: WalkRow) => r)).toEqual([]);
    expect(listWalkStops([row(null, null, "Ghost")], (r) => r)).toEqual([]);
  });
});
