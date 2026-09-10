import { describe, expect, it } from "vitest";
import { folderDragData, readFolderDrag } from "@/lib/folderDrag";
import { readWidgetDrag, widgetDragData, widgetEdge } from "./homeDrag";

/**
 * The pure halves only. The hook is exercised by `HomePage.test.tsx`, which drives a real drag
 * through `src/test-drag.ts` and supplies a rect on every element the hit-test touches — dnd-kit
 * hit-tests by coordinate and jsdom measures every rect as four zeroes, so a unit test of the
 * hook here would be a test of nothing.
 */

describe("widgetDragData / readWidgetDrag", () => {
  it("round-trips a widget id", () => {
    expect(readWidgetDrag(widgetDragData("w1"))).toBe("w1");
    expect(readWidgetDrag(widgetDragData("somethingFromTheFuture"))).toBe(
      "somethingFromTheFuture",
    );
  });

  /**
   * **The mark is what is checked first, and it has to be checked on its own account.** A
   * payload carrying the id field and nothing else would satisfy every other check in this file,
   * so this is the record that gets through a reader that had lost its mark check. Nothing in
   * the app writes one, which is exactly why the guard needs a test rather than a witness.
   */
  it("refuses a well-formed widget record carrying no mark", () => {
    expect(readWidgetDrag({ widgetId: "w1" })).toBeNull();
  });

  /** A blank id is one `home.rs` will not store, so a payload carrying one did not come from a
   *  layout this build wrote — and neither did one carrying a number. */
  it("refuses a malformed id", () => {
    for (const widgetId of ["", 1, 1.5, null, undefined, {}, ["w1"]]) {
      expect(readWidgetDrag({ ...widgetDragData("w1"), widgetId })).toBeNull();
    }
  });

  /**
   * **It takes `unknown` and answers rather than throws**, which is where it parts from
   * `readFolderDrag`: that one is handed the library's own `data` record and can assume an
   * object, and this one is also what a page test and a story reach for with whatever they have.
   */
  it("refuses anything that is not a record at all", () => {
    for (const junk of [null, undefined, 7, "w1", true, [], () => "w1", new Date()]) {
      expect(readWidgetDrag(junk)).toBeNull();
    }
  });

  /** The separate key, in both directions: the sidebar's folder tree is mounted beside this page
   *  all day, so a folder carried over a widget and a widget carried over a folder card each
   *  find no mark of their own — with neither target having to be taught anything. */
  it("is invisible to the folder reader, and the folder payload is invisible to this one", () => {
    const folder = folderDragData({ folderId: 4, name: "Standard", parentId: null, scope: "deck" });
    expect(readWidgetDrag(folder)).toBeNull();
    expect(readFolderDrag(widgetDragData("w1"), "deck")).toBeNull();
  });
});

describe("widgetEdge", () => {
  /**
   * Arithmetic, not a rendering: jsdom has no layout engine, so every `getBoundingClientRect` in
   * the suite is four zeroes and a test that mounted a widget would pass over any threshold at
   * all. That is why this function takes the rect rather than reading it.
   */
  const CARD = new DOMRect(100, 40, 240, 120);
  const at = (x: number) => widgetEdge(CARD, { x, y: 100 });

  it("splits a widget at its horizontal midpoint", () => {
    expect(at(100)).toBe("before");
    expect(at(180)).toBe("before");
    expect(at(219.9)).toBe("before");
    expect(at(260)).toBe("after");
    expect(at(340)).toBe("after");
  });

  /**
   * **The boundary, written down because both answers are plausible.** A `<` and a `<=` read the
   * same and promise different things, so which of them is written is the fact under test — not
   * a pixel that happens to fall out of the arithmetic.
   */
  it("gives the midpoint itself to after", () => {
    expect(at(220)).toBe("after");
  });

  /** The grid is a wrapping flex row, so the vertical question a folder tree asks has no meaning
   *  here — a pointer above or below a card is still on one side of it. */
  it("ignores the axis it was not asked about", () => {
    expect(widgetEdge(CARD, { x: 180, y: -1000 })).toBe("before");
    expect(widgetEdge(CARD, { x: 180, y: 5000 })).toBe("before");
    expect(widgetEdge(CARD, { x: 300, y: -1000 })).toBe("after");
    expect(widgetEdge(CARD, { x: 300, y: 5000 })).toBe("after");
  });

  /** A sticky drop target and the library's honey-pot element both put the pointer legitimately
   *  outside the element the drop is still counted against, so "past the end" is an answer rather
   *  than an error. */
  it("answers by the side a point outside the box is past", () => {
    expect(at(-1000)).toBe("before");
    expect(at(5000)).toBe("after");
  });
});
