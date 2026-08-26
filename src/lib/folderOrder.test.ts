import { describe, expect, it } from "vitest";
import { reorderedLevel } from "./folderOrder";

/** One level, in order. Named so a test reads as positions rather than as numbers. */
const A = 1;
const B = 2;
const C = 3;
const D = 4;
const LEVEL = [A, B, C] as const;

describe("reorderedLevel", () => {
  it("puts a folder from elsewhere before the one it was dropped on", () => {
    expect(reorderedLevel({ siblings: LEVEL, dragged: D, target: B, edge: "before" })).toEqual([
      A,
      D,
      B,
      C,
    ]);
  });

  it("puts it after, which is a different position and not a rounding of the same one", () => {
    expect(reorderedLevel({ siblings: LEVEL, dragged: D, target: B, edge: "after" })).toEqual([
      A,
      B,
      D,
      C,
    ]);
  });

  /**
   * The move that is a **re-insertion**, and the one a naive splice gets wrong: the dragged
   * folder is already in this level, so it has to leave before the index is read or it displaces
   * itself and lands one position off.
   */
  it("re-inserts a folder that was already in the level", () => {
    expect(reorderedLevel({ siblings: LEVEL, dragged: A, target: C, edge: "after" })).toEqual([
      B,
      C,
      A,
    ]);
  });

  it("files a folder inside another, last, because inside names no position", () => {
    expect(reorderedLevel({ siblings: [A, B], dragged: D, target: C, edge: "inside" })).toEqual([
      A,
      B,
      D,
    ]);
  });

  /**
   * **The gesture every reader makes by accident.** The pointer is on the folder being dragged
   * for the first few pixels of every drag, so this is the commonest drop of all — and the
   * backend refuses it in words (`FOLDER_CYCLE`). A red banner for thinking better of a drag is
   * a worse answer than doing nothing.
   */
  it("answers nothing for a folder dropped on itself, at every edge", () => {
    for (const edge of ["before", "after", "inside"] as const) {
      expect(reorderedLevel({ siblings: LEVEL, dragged: B, target: B, edge })).toBeNull();
    }
  });

  /**
   * A distinct no-op from the one above, and the reason the function compares the whole array:
   * dropping a folder on the near side of the neighbour it already precedes lands it exactly
   * where it was. Without this it would be a write that bumps `updated_at` and re-reads three
   * queries to arrive at the list already on screen.
   */
  it("answers nothing when the order would not actually change", () => {
    expect(reorderedLevel({ siblings: LEVEL, dragged: A, target: B, edge: "before" })).toBeNull();
    expect(reorderedLevel({ siblings: LEVEL, dragged: B, target: A, edge: "after" })).toBeNull();
  });

  /** …while the mirror of that pair really does move, so the check above cannot be a blanket. */
  it("still moves when the same pair is dropped the other way round", () => {
    expect(reorderedLevel({ siblings: LEVEL, dragged: A, target: B, edge: "after" })).toEqual([
      B,
      A,
      C,
    ]);
  });

  /** Another surface deleted or re-filed the target mid-drag. Answered as "nothing to do"
   *  rather than appended at a position nobody pointed at. */
  it("answers nothing when the target has left the level", () => {
    expect(reorderedLevel({ siblings: LEVEL, dragged: A, target: D, edge: "before" })).toBeNull();
  });

  it("takes a folder into an empty drawer", () => {
    expect(reorderedLevel({ siblings: [], dragged: A, target: C, edge: "inside" })).toEqual([A]);
  });
});
