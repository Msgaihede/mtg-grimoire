/**
 * The **multi-card** half of the drag contract — issue #214.
 *
 * A file of its own beside `dnd.test.ts` rather than more `describe`s inside it, because what is
 * being pinned here is a different claim. That file asks "does one payload survive the trip, and
 * what does one drop mean"; this one asks "does adding a group leave both of those answers
 * untouched", which is the whole design: `dragData`, `readDragData` and `dropWrite` did not move,
 * so a drop target that has not learned about groups goes on acting on the primary alone.
 *
 * Everything here is pure. The wiring — a real `dragstart` carrying a real group into a real drop
 * target — is `DeckEditor.test.tsx`'s, over `src/test-drag.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  dragData,
  dropWrite,
  dropWrites,
  readDragData,
  readDragGroup,
  withDragGroup,
  type DragPayload,
} from "./dnd";

const MAIN = 1;
const RAMP = 2;
const LANDS = 3;

const BOLT: DragPayload = {
  kind: "deck-card",
  cardId: "c-bolt",
  name: "Lightning Bolt",
  fromCategoryId: MAIN,
  finish: null,
};
const SOL: DragPayload = {
  kind: "deck-card",
  cardId: "c-sol",
  name: "Sol Ring",
  fromCategoryId: RAMP,
  finish: "foil",
};
const WASTES: DragPayload = {
  kind: "deck-card",
  cardId: "c-wastes",
  name: "Wastes",
  fromCategoryId: MAIN,
  finish: null,
};
/** A printing off a wall — no category, so the remove tray can do nothing with it. */
const TILE: DragPayload = {
  kind: "card",
  cardId: "c-tile",
  name: "Ponder",
  typeLine: "Sorcery",
};

describe("dragData with a group", () => {
  /** The property the whole design rests on: an unconverted target reads the primary and is
   *  unaffected by the group travelling beside it. */
  it("leaves the primary payload readable exactly as before", () => {
    expect(readDragData(dragData(BOLT, [SOL, WASTES]))).toEqual(BOLT);
  });

  it("writes byte-identical data for an ordinary one-card drag", () => {
    expect(dragData(BOLT, [])).toEqual(dragData(BOLT));
  });

  it("puts the picked-up card at the head of the group", () => {
    expect(readDragGroup(dragData(SOL, [BOLT, WASTES]))).toEqual([SOL, BOLT, WASTES]);
  });
});

describe("readDragGroup", () => {
  it("answers with one payload for an ordinary drag", () => {
    expect(readDragGroup(dragData(BOLT))).toEqual([BOLT]);
  });

  /** Not this app's card drag at all — a category reorder, a wish that names no printing, or
   *  anything a third feature puts in the air later. */
  it("answers with nothing for a record carrying no card mark", () => {
    expect(readDragGroup({ some: "other-drag" })).toEqual([]);
  });

  /**
   * A `dragGroup` key without a valid primary is not a group this module wrote. Trusting it would
   * be trusting an array for having the right key name.
   */
  it("refuses a group whose primary is unreadable", () => {
    expect(readDragGroup({ dragGroup: [BOLT, SOL] })).toEqual([]);
  });

  /**
   * A bad **member** is dropped where a bad **primary** is fatal, and the asymmetry is the point:
   * one card of five being unreadable must not fail the other four for a reason nothing on screen
   * names.
   */
  it("drops a member that does not survive the field check", () => {
    const data = dragData(BOLT, [SOL]);
    expect(
      readDragGroup({ ...data, dragGroup: [BOLT, { kind: "deck-card", cardId: "" }, SOL] }),
    ).toEqual([BOLT, SOL]);
  });

  it("falls back to the primary when every member is unreadable", () => {
    const data = dragData(BOLT, [SOL]);
    expect(readDragGroup({ ...data, dragGroup: [7, null, "x"] })).toEqual([BOLT]);
  });

  it("ignores a group that is not an array", () => {
    expect(readDragGroup({ ...dragData(BOLT), dragGroup: "three cards" })).toEqual([BOLT]);
  });
});

describe("withDragGroup", () => {
  /** The `dragRecord` seam — the wishlist's tile, whose record carries a second feature's mark
   *  beside this one's. Everything already in the record survives. */
  it("adds a group to an already-composed record without disturbing it", () => {
    const composed = { ...dragData(BOLT), wishSource: "mtg-grimoire/wish-drag", wishId: 4 };
    const out = withDragGroup(composed, BOLT, [SOL]);
    expect(out.wishSource).toBe("mtg-grimoire/wish-drag");
    expect(out.wishId).toBe(4);
    expect(readDragGroup(out)).toEqual([BOLT, SOL]);
  });

  it("returns the record untouched, by identity, when there is nothing to add", () => {
    const composed = dragData(BOLT);
    expect(withDragGroup(composed, BOLT, [])).toBe(composed);
  });
});

describe("dropWrites", () => {
  it("writes one move per member", () => {
    expect(dropWrites([BOLT, SOL], { kind: "category", categoryId: LANDS })).toEqual([
      { write: "move", cardId: "c-bolt", from: MAIN, to: LANDS, finish: null },
      { write: "move", cardId: "c-sol", from: RAMP, to: LANDS, finish: "foil" },
    ]);
  });

  /**
   * **A mixed set is not refused whole.** Four deck rows and one search tile dropped on the remove
   * tray take the four out and pass over the fifth — the alternative is a gesture that fails for a
   * reason nothing on screen names, since nothing marks which member is the odd one.
   */
  it("passes over the members a target cannot take", () => {
    expect(dropWrites([BOLT, TILE, SOL], { kind: "remove" })).toEqual([
      { write: "remove", cardId: "c-bolt", categoryId: MAIN, finish: null },
      { write: "remove", cardId: "c-sol", categoryId: RAMP, finish: "foil" },
    ]);
  });

  /** `dropWrite`'s own rule — a card dropped back in its own pile writes nothing — reached one
   *  member at a time, so a set straddling two piles still moves the half that is elsewhere. */
  it("drops the member that is already in the target pile", () => {
    expect(dropWrites([BOLT, WASTES, SOL], { kind: "category", categoryId: MAIN })).toEqual([
      { write: "move", cardId: "c-sol", from: RAMP, to: MAIN, finish: "foil" },
    ]);
  });

  /** What every `canDrop` in the app now asks. Empty is the drop that would do nothing, which is
   *  exactly what `dropWrite`'s `null` refuses for one card. */
  it("is empty when no member writes anything", () => {
    expect(dropWrites([TILE], { kind: "remove" })).toEqual([]);
  });

  it("agrees with dropWrite for a single card", () => {
    const target = { kind: "category", categoryId: LANDS } as const;
    expect(dropWrites([BOLT], target)).toEqual([dropWrite(BOLT, target)]);
  });
});
