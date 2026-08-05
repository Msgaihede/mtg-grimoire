import { describe, expect, it } from "vitest";
import { dragData, dropWrite, readDragData, type DragPayload } from "./dnd";

/**
 * **What is tested here, and what is left to the running app.**
 *
 * A drop is three things: a payload that survives the trip, a rule that says which drops mean
 * something, and the wiring that carries one to the other. The first two are pure and are
 * tested here, exhaustively — every payload a target can be handed, and every answer the rule
 * gives, without a DOM in sight.
 *
 * The wiring is tested too, over the library's own code path, in `ZoneColumn.test.tsx` and
 * `DeckEditor.test.tsx`: `src/test-drag.ts` drives real `dragstart`/`dragenter`/`dragover`/
 * `drop` events at the real registrations, which works because
 * `@atlaskit/pragmatic-drag-and-drop` hit-tests with `event.target` and `Element.closest`
 * rather than with `elementFromPoint`. That file records exactly what jsdom still cannot
 * reach — the platform's drag preview, pointer hit-testing, auto-scroll, and Escape, which
 * the browser handles without telling the page — and those are the live CDP pass's to prove.
 */

const SEARCH: DragPayload = { kind: "search-card", cardId: "c-bolt", name: "Lightning Bolt" };
const ROW: DragPayload = {
  kind: "deck-card",
  cardId: "c-bolt",
  name: "Lightning Bolt",
  fromZone: "main",
};

describe("dragData / readDragData", () => {
  /** The round trip, both ways a drag can start. */
  it("reads back exactly what was put in", () => {
    expect(readDragData(dragData(SEARCH))).toEqual(SEARCH);
    expect(readDragData(dragData(ROW))).toEqual(ROW);
  });

  /**
   * The reason this is a function and not a cast: a drop target is handed whatever the drag
   * is carrying, out of a store every `draggable` in the window writes into. A payload that
   * is not a deck drag's has to be inert rather than half-read — including one whose fields
   * happen to line up, which is exactly what the app's *next* draggable would produce.
   */
  it("refuses anything that is not marked as a deck drag", () => {
    expect(readDragData({})).toBeNull();
    // The shape is right and the mark is missing, which is exactly what a payload that was
    // built by something else looks like.
    expect(readDragData({ kind: "search-card", cardId: "c-bolt", name: "Bolt" })).toBeNull();
    expect(readDragData({ kind: "deck-card", cardId: "c-bolt", name: "Bolt", fromZone: "main" }))
      .toBeNull();
  });

  /** A marked payload whose fields are wrong is still refused: the mark says where a drag came
   *  from, and the fields are what a write is built out of. */
  it("refuses a marked payload with a field it cannot use", () => {
    const marked = (fields: Record<string, unknown>) => ({ ...dragData(SEARCH), ...fields });

    expect(readDragData(marked({ kind: "elsewhere" }))).toBeNull();
    expect(readDragData(marked({ cardId: "" }))).toBeNull();
    expect(readDragData(marked({ cardId: 7 }))).toBeNull();
    expect(readDragData(marked({ name: null }))).toBeNull();
  });

  /**
   * The zone is the half of a deck-card payload that decides a write: `deck_move_card` takes
   * a `from` and a `to`, and a `from` that is not a zone is a move the backend refuses in
   * words after the row has already left the screen.
   */
  it("refuses a deck-card payload whose zone is not a zone", () => {
    expect(readDragData({ ...dragData(ROW), fromZone: "graveyard" })).toBeNull();
    expect(readDragData({ ...dragData(ROW), fromZone: undefined })).toBeNull();
    // Not a zone, and not a way to smuggle one in either: `"toString" in ZONES` is true, so
    // the *value* is what is asked for and nothing on `Object.prototype` answers `true`.
    expect(readDragData({ ...dragData(ROW), fromZone: "toString" })).toBeNull();
  });

  /** A search payload carries no zone, and one that arrives with a `fromZone` is still a
   *  search payload — the kind decides what is read, so a stray field cannot change a write. */
  it("reads a search payload by its kind rather than by its fields", () => {
    expect(readDragData({ ...dragData(SEARCH), fromZone: "side" })).toEqual(SEARCH);
  });
});

describe("dropWrite", () => {
  /** The panel's drag: a printing the deck does not have yet, into the zone it was dropped
   *  on. One copy, exactly as the panel's Add button sends. */
  it("adds one copy when a search result lands in a zone", () => {
    expect(dropWrite(SEARCH, { kind: "zone", zone: "side" })).toEqual({
      write: "add",
      cardId: "c-bolt",
      zone: "side",
    });
  });

  /** The row's drag: every copy moves, which is what `deck_move_card` does and what the row
   *  menu's "Move to" already means. */
  it("moves a deck row into the zone it was dropped on", () => {
    expect(dropWrite(ROW, { kind: "zone", zone: "maybe" })).toEqual({
      write: "move",
      cardId: "c-bolt",
      from: "main",
      to: "maybe",
    });
  });

  /**
   * A row dropped back where it came from is not a write.
   *
   * `deck_move_card` from a zone to itself would touch the deck, bump `updated_at` and
   * reallocate for nothing — and, more to the point, the column has to be able to say so
   * *before* the drop: this is the same rule `canDrop` asks, so the source zone never lights
   * up and the reader is told the drop means nothing while they can still change their mind.
   */
  it("refuses a row dropped on the zone it is already in", () => {
    expect(dropWrite(ROW, { kind: "zone", zone: "main" })).toBeNull();
  });

  /** The tray takes a card out of the deck, and zero is how a deck card leaves — the
   *  wishlist's asymmetry, for the wishlist's reason. */
  it("removes a deck row dropped on the tray, from the zone it was in", () => {
    expect(dropWrite({ ...ROW, fromZone: "side" }, { kind: "remove" })).toEqual({
      write: "remove",
      cardId: "c-bolt",
      zone: "side",
    });
  });

  /**
   * The tray refuses a search result, and refuses it here rather than in the tray: there is
   * no row to remove, and a tray that lit up for a card the deck does not hold would be
   * offering to undo something that never happened. It is also why the tray is only *drawn*
   * for a deck-card drag.
   */
  it("refuses a search result dropped on the tray", () => {
    expect(dropWrite(SEARCH, { kind: "remove" })).toBeNull();
  });
});
