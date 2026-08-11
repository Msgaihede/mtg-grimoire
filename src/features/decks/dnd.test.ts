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
 * The wiring is tested too, over the library's own code path, in `DeckEditor.test.tsx`:
 * `src/test-drag.ts` drives real `dragstart`/`dragenter`/`dragover`/
 * `drop` events at the real registrations, which works because
 * `@atlaskit/pragmatic-drag-and-drop` hit-tests with `event.target` and `Element.closest`
 * rather than with `elementFromPoint`. That file records exactly what jsdom still cannot
 * reach — the platform's drag preview, pointer hit-testing, auto-scroll, and Escape, which
 * the browser handles without telling the page — and those are the live CDP pass's to prove.
 */

/**
 * Two of the deck's categories, as ids.
 *
 * Any two positive integers would do — schema v8 made a category a row the user owns, so there
 * is no fixed vocabulary left to name one by — but these are `schema::PREDEFINED_CATEGORIES`'
 * own order applied to a deck's seeded rows, which is what a reader will picture.
 */
const MAIN = 1;
const SIDE = 2;

const SEARCH: DragPayload = { kind: "search-card", cardId: "c-bolt", name: "Lightning Bolt" };
const ROW: DragPayload = {
  kind: "deck-card",
  cardId: "c-bolt",
  name: "Lightning Bolt",
  fromCategoryId: MAIN,
};
/** The printing every other surface in the app carries: a search tile, a collection row, a
 *  wish, a printings row. No category, because none of them is inside a deck. */
const CARD: DragPayload = { kind: "card", cardId: "c-bolt", name: "Lightning Bolt" };

describe("dragData / readDragData", () => {
  /** The round trip, every way a drag can start. */
  it("reads back exactly what was put in", () => {
    expect(readDragData(dragData(SEARCH))).toEqual(SEARCH);
    expect(readDragData(dragData(ROW))).toEqual(ROW);
    expect(readDragData(dragData(CARD))).toEqual(CARD);
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
    expect(
      readDragData({ kind: "deck-card", cardId: "c-bolt", name: "Bolt", fromCategoryId: MAIN }),
    ).toBeNull();
    // The plainest of the three, and therefore the likeliest thing another feature's drag
    // would happen to carry: a card id and a name.
    expect(readDragData({ kind: "card", cardId: "c-bolt", name: "Bolt" })).toBeNull();
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
   * The category is the half of a deck-card payload that decides a write: `deck_move_card`
   * takes a `from` and a `to`, and a `from` that is not a usable category id is a move the
   * backend refuses in words after the row has already left the screen.
   *
   * **This is the fence that replaced an exhaustive check.** Before schema v8 the field was
   * one of five words and `readDragData` could hold the whole vocabulary; a category id has no
   * closed list to check against, so what is left is `isCategoryId`'s shape check — and every
   * case below is a value that would address *every* row or *no* row rather than one. `"1"` is
   * the one worth naming twice: it is what a `<select>` or a `dataset` round trip produces, it
   * reads as the right id, and `deck_move_card` would be handed a `from` it cannot mean.
   */
  it("refuses a deck-card payload whose category id is not one", () => {
    for (const fromCategoryId of ["1", 1.5, 0, -1, NaN, undefined, null, "main"]) {
      expect(readDragData({ ...dragData(ROW), fromCategoryId })).toBeNull();
    }
  });

  /** A search payload carries no category, and one that arrives with a `fromCategoryId` is
   *  still a search payload — the kind decides what is read, so a stray field cannot change a
   *  write. */
  it("reads a search payload by its kind rather than by its fields", () => {
    expect(readDragData({ ...dragData(SEARCH), fromCategoryId: SIDE })).toEqual(SEARCH);
  });
});

describe("dropWrite", () => {
  /** The panel's drag: a printing the deck does not have yet, into the category it was dropped
   *  on. One copy, exactly as the panel's Add button sends. */
  it("adds one copy when a search result lands in a category", () => {
    expect(dropWrite(SEARCH, { kind: "category", categoryId: SIDE })).toEqual({
      write: "add",
      cardId: "c-bolt",
      categoryId: SIDE,
    });
  });

  /**
   * A card from anywhere else in the app lands exactly as a panel tile does.
   *
   * The category columns are the editor's, and the four surfaces that carry a `"card"` — the
   * search wall, the collection table, the wishlist, the pane's printings list — are not; but
   * a printing is a printing, and "one copy into the category it was dropped on" is the same
   * write whichever wall it was picked up from. Two kinds and one rule, because the *source*
   * is what differs and the meaning is not.
   */
  it("adds one copy when a card from any other surface lands in a category", () => {
    expect(dropWrite(CARD, { kind: "category", categoryId: MAIN })).toEqual({
      write: "add",
      cardId: "c-bolt",
      categoryId: MAIN,
    });
  });

  /** And the tray refuses it for the reason it refuses a search result: there is no row in
   *  this deck to take out. */
  it("refuses a card from another surface dropped on the tray", () => {
    expect(dropWrite(CARD, { kind: "remove" })).toBeNull();
  });

  /** The row's drag: every copy moves, which is what `deck_move_card` does and what the row
   *  menu's "Move to" already means. */
  it("moves a deck row into the category it was dropped on", () => {
    expect(dropWrite(ROW, { kind: "category", categoryId: SIDE })).toEqual({
      write: "move",
      cardId: "c-bolt",
      from: MAIN,
      to: SIDE,
    });
  });

  /**
   * A row dropped back where it came from is not a write.
   *
   * `deck_move_card` from a category to itself would touch the deck, bump `updated_at` and
   * reallocate for nothing — and, more to the point, the column has to be able to say so
   * *before* the drop: this is the same rule `canDrop` asks, so the source column never lights
   * up and the reader is told the drop means nothing while they can still change their mind.
   */
  it("refuses a row dropped on the category it is already in", () => {
    expect(dropWrite(ROW, { kind: "category", categoryId: MAIN })).toBeNull();
  });

  /** The tray takes a card out of the deck, and zero is how a deck card leaves — the
   *  wishlist's asymmetry, for the wishlist's reason. */
  it("removes a deck row dropped on the tray, from the category it was in", () => {
    expect(dropWrite({ ...ROW, fromCategoryId: SIDE }, { kind: "remove" })).toEqual({
      write: "remove",
      cardId: "c-bolt",
      categoryId: SIDE,
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
