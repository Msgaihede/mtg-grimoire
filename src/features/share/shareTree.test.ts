/**
 * The drawer walk, over documents the format calls ordinary and two it calls impossible.
 *
 * The golden is the happy path and is asserted first, so this file and the Rust writer agree
 * about a real snapshot before anything hand-built is trusted.
 */
import { describe, expect, it } from "vitest";
import golden from "../../../src-tauri/src/share/__golden__/snapshot.json?raw";
import { parseSnapshot, type ShareCard, type ShareSnapshot } from "@/lib/shareSnapshot";
import { drawers, subtreeOf } from "./shareTree";

const card = (over: Partial<ShareCard> = {}): ShareCard => ({
  id: "card-1",
  n: "Fury Sliver",
  s: "tsp",
  cn: "157",
  f: "nonfoil",
  q: 1,
  fo: null,
  ...over,
});

const snapshot = (over: Partial<ShareSnapshot> = {}): ShareSnapshot => ({
  v: 1,
  id: "share-1",
  title: "Trade binder",
  owner: "Giradeli",
  updatedAt: 1757308800,
  marketplace: "tcgplayer",
  currency: "USD",
  fields: [],
  folders: [],
  cards: [],
  ...over,
});

describe("the shared drawers", () => {
  it("walks the golden depth-first and counts copies down the tree", () => {
    const flat = drawers(parseSnapshot(golden));

    expect(flat.map((f) => [f.name, f.depth, f.count])).toEqual([
      // Two copies of Fury Sliver in the root drawer, plus the one Tundra beneath it.
      ["Trade binder", 0, 3],
      ["Duals", 1, 1],
    ]);
  });

  it("has nothing to draw for a whole-collection share", () => {
    expect(drawers(snapshot({ cards: [card()] }))).toEqual([]);
  });

  /**
   * The format's third documented absence: a folder shared out of the middle of a cabinet
   * carries `parent: null`, and so does one whose parent was not published. Both are roots, and
   * the second is the one a naive walk drops — it recurses from `null` and never reaches a
   * drawer whose parent is a uid nothing in the document defines.
   */
  it("treats a parent outside the snapshot as a root rather than losing the drawer", () => {
    const flat = drawers(
      snapshot({
        folders: [{ uid: "orphan", name: "Duals", parent: "uid-nobody-published" }],
        cards: [card({ fo: "orphan", q: 4 })],
      }),
    );

    expect(flat.map((f) => [f.name, f.depth, f.count])).toEqual([["Duals", 0, 4]]);
  });

  /** A cycle is not a shape the writer can produce, and a page that hung on one would be worse. */
  it("draws each drawer once when the edges make a cycle", () => {
    const flat = drawers(
      snapshot({
        folders: [
          { uid: "a", name: "A", parent: "b" },
          { uid: "b", name: "B", parent: "a" },
        ],
      }),
    );

    expect(flat.map((f) => f.uid).sort()).toEqual(["a", "b"]);
  });

  it("takes a drawer's whole subtree and stops at its first sibling", () => {
    const flat = drawers(
      snapshot({
        folders: [
          { uid: "binder", name: "Binder", parent: null },
          { uid: "duals", name: "Duals", parent: "binder" },
          { uid: "abur", name: "ABUR", parent: "duals" },
          { uid: "spare", name: "Spare", parent: null },
        ],
      }),
    );

    expect([...subtreeOf(flat, "binder")].sort()).toEqual(["abur", "binder", "duals"]);
    expect([...subtreeOf(flat, "duals")].sort()).toEqual(["abur", "duals"]);
    expect([...subtreeOf(flat, "spare")]).toEqual(["spare"]);
    // A uid the list does not carry answers itself and nothing else, so a stale pick from a
    // previous snapshot narrows to an empty drawer rather than to the whole binder.
    expect([...subtreeOf(flat, "gone")]).toEqual(["gone"]);
  });
});
