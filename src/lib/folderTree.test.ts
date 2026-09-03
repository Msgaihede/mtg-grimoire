import { describe, expect, it } from "vitest";
import {
  buildFolderTree,
  flattenFolders,
  folderDescendants,
  folderLevel,
  lockedFolderIds,
  type FolderLike,
} from "./folderTree";
import type { CollectionFolder } from "./ipc";

const folder = (id: number, parentId: number | null, name: string, sortOrder = 0): FolderLike => ({
  id,
  parentId,
  name,
  sortOrder,
});

/** Only the two fields the tree counts by. */
const member = (folderId: number | null, archived = false) => ({ folderId, archived });

describe("buildFolderTree", () => {
  it("nests by parentId and indents by depth", () => {
    const tree = buildFolderTree([folder(1, null, "Commander"), folder(2, 1, "Legends")], []);

    expect(tree).toHaveLength(1);
    expect(tree[0].folder.name).toBe("Commander");
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children[0].folder.name).toBe("Legends");
    expect(tree[0].children[0].depth).toBe(1);
  });

  /**
   * A row counts everything under it, not what is filed in it directly. A folder reading 0
   * over a sub-folder holding twelve members is a lie a reader can only catch by clicking.
   */
  it("counts the members under a folder as well as the ones in it", () => {
    const tree = buildFolderTree(
      [folder(1, null, "Commander"), folder(2, 1, "Legends")],
      [member(1), member(2), member(2), member(null)],
    );

    expect(tree[0].count).toBe(3);
    expect(tree[0].children[0].count).toBe(2);
  });

  /** Archived members are behind their own disclosure with their own count. A row saying 5 over
   *  a grid showing 4 is the same lie wearing the other hat. */
  it("leaves archived members out of the counts", () => {
    const tree = buildFolderTree([folder(1, null, "Commander")], [member(1), member(1, true)]);

    expect(tree[0].count).toBe(1);
  });

  /** A wish cannot be archived, so `archived` is optional and an absent flag counts. */
  it("counts a member with no archived flag", () => {
    const tree = buildFolderTree(
      [{ id: 1, parentId: null, name: "Ordered", sortOrder: 0 }],
      [{ folderId: 1 }, { folderId: 1 }],
    );
    expect(tree[0].count).toBe(2);
  });

  it("still skips an archived member", () => {
    const tree = buildFolderTree(
      [{ id: 1, parentId: null, name: "Standard", sortOrder: 0 }],
      [
        { folderId: 1, archived: true },
        { folderId: 1, archived: false },
      ],
    );
    expect(tree[0].count).toBe(1);
  });

  it("orders siblings by sortOrder, then by name", () => {
    const tree = buildFolderTree(
      [folder(1, null, "Zoo", 1), folder(2, null, "Burn", 1), folder(3, null, "Aggro", 0)],
      [],
    );

    expect(tree.map((n) => n.folder.name)).toEqual(["Aggro", "Burn", "Zoo"]);
  });

  /**
   * A parent this list does not carry — another surface deleted it between the two reads — puts
   * its child at the root. Towards the root, never towards nothing: a dropped folder hides the
   * members in it with no number anywhere pointing at them.
   */
  it("draws a folder whose parent is missing at the root", () => {
    const tree = buildFolderTree([folder(2, 99, "Legends")], [member(2)]);

    expect(tree.map((n) => n.folder.name)).toEqual(["Legends"]);
    expect(tree[0].count).toBe(1);
  });

  /**
   * A cycle is refused by the backend and could only arrive through corruption — but a tree
   * builder that recursed into one would hang the window. It terminates, and it still draws
   * every folder, flat.
   */
  it("terminates on a cycle and still draws every folder", () => {
    const tree = buildFolderTree([folder(1, 2, "A"), folder(2, 1, "B")], []);

    expect(tree.map((n) => n.folder.name).sort()).toEqual(["A", "B"]);
    expect(tree.every((n) => n.depth === 0)).toBe(true);
  });

  /** A member filed in a folder this list does not carry counts nowhere in the tree — the page
   *  draws it at the top level, which the tree has no node for. */
  it("counts nothing for a member filed in a folder that is not there", () => {
    const tree = buildFolderTree([folder(1, null, "Commander")], [member(99)]);

    expect(tree[0].count).toBe(0);
  });
});

describe("flattenFolders", () => {
  it("reads the tree top to bottom, each node keeping its depth", () => {
    const tree = buildFolderTree(
      [folder(1, null, "Commander"), folder(2, 1, "Legends"), folder(3, null, "Modern", 1)],
      [],
    );

    expect(flattenFolders(tree).map((n) => [n.folder.name, n.depth])).toEqual([
      ["Commander", 0],
      ["Legends", 1],
      ["Modern", 0],
    ]);
  });
});

describe("folderDescendants", () => {
  it("answers everything under a folder and not the folder itself", () => {
    const folders = [
      folder(1, null, "Commander"),
      folder(2, 1, "Legends"),
      folder(3, 2, "Partners"),
      folder(4, null, "Modern"),
    ];

    expect([...folderDescendants(folders, 1)].sort()).toEqual([2, 3]);
    expect(folderDescendants(folders, 4).size).toBe(0);
  });

  it("terminates on a cycle", () => {
    expect([...folderDescendants([folder(1, 2, "A"), folder(2, 1, "B")], 1)]).toEqual([2]);
  });
});

describe("lockedFolderIds", () => {
  /** One collection folder, the reader's own — `locked` last because it is the field under test
   *  and every other one here is scenery. */
  const drawer = (
    id: number,
    parentId: number | null,
    name: string,
    locked = false,
  ): CollectionFolder => ({ id, parentId, name, kind: "user", deckId: null, sortOrder: 0, locked });

  /**
   * **The whole of the inheritance, in one tree.** `Trade binder` is locked; `Foils` sits inside
   * it and `Signed` inside that, so both are locked without a flag of their own. `Modern` is a
   * second root and is not — an ancestry walk that answered "every folder once one is locked"
   * would pass every other assertion in this block and fail only this one.
   */
  const cabinet = () => [
    drawer(1, null, "Trade binder", true),
    drawer(2, 1, "Foils"),
    drawer(3, 2, "Signed"),
    drawer(4, null, "Modern"),
  ];

  it("locks a child of a locked folder", () => {
    expect(lockedFolderIds(cabinet()).has(2)).toBe(true);
  });

  /** Two levels down, which is what separates the walk from a single `parentId` lookup. */
  it("locks a grandchild of a locked folder", () => {
    expect(lockedFolderIds(cabinet()).has(3)).toBe(true);
  });

  it("leaves a sibling of the locked folder alone", () => {
    const locked = lockedFolderIds(cabinet());

    expect(locked.has(4)).toBe(false);
    expect([...locked].sort()).toEqual([1, 2, 3]);
  });

  /**
   * **The inheritance runs downward only.** A reader who locks one drawer inside a binder has
   * set aside that drawer, not the binder — the opposite reading would take a whole cabinet out
   * of the collection's lists on one press.
   */
  it("does not lock a folder just because something inside it is", () => {
    const locked = lockedFolderIds([drawer(1, null, "Trade binder"), drawer(2, 1, "Foils", true)]);

    expect(locked.has(1)).toBe(false);
    expect([...locked]).toEqual([2]);
  });

  /** Nothing set aside is the ordinary case, and it is an empty set rather than a miss. */
  it("answers nothing when no folder is locked", () => {
    expect(lockedFolderIds(cabinet().map((f) => ({ ...f, locked: false }))).size).toBe(0);
  });

  /** `folderDescendants`' rule: the backend refuses a cycle and only a hand-edited database could
   *  hold one, but a walk that hung the window over it would be worse than the corruption. */
  it("terminates on a cycle", () => {
    const locked = lockedFolderIds([drawer(1, 2, "A", true), drawer(2, 1, "B")]);

    expect([...locked].sort()).toEqual([1, 2]);
  });
});

describe("folderLevel", () => {
  /** `Commander` holds `Legends`, which holds `Partners`; `Modern` is a second root. */
  const tree = () =>
    buildFolderTree(
      [
        folder(1, null, "Commander"),
        folder(2, 1, "Legends"),
        folder(3, 2, "Partners"),
        folder(4, null, "Modern", 1),
      ],
      [],
    );

  it("answers the root level for null, in the order the tree draws it", () => {
    expect(folderLevel(tree(), null).map((n) => n.folder.name)).toEqual(["Commander", "Modern"]);
  });

  it("answers a level nested two deep", () => {
    expect(folderLevel(tree(), 1).map((n) => n.folder.name)).toEqual(["Legends"]);
    expect(folderLevel(tree(), 2).map((n) => n.folder.name)).toEqual(["Partners"]);
  });

  /** The two empties are deliberately one answer: both mean "there are no cards to draw here". */
  it("answers empty for a leaf and for an id the tree does not carry", () => {
    expect(folderLevel(tree(), 3)).toEqual([]);
    expect(folderLevel(tree(), 99)).toEqual([]);
  });

  /**
   * **The level a folder is _drawn_ in, not the one its row names.** `buildFolderTree` resolves a
   * folder whose parent is missing to the root, so a `.filter(f => f.parentId === null)` over the
   * flat rows would leave the orphan out of the root level it is standing in — which is the level
   * a reorder has to be written against.
   */
  it("puts an orphan in the root level, where the tree drew it", () => {
    const tree = buildFolderTree([folder(1, null, "Commander"), folder(5, 99, "Odds")], []);

    expect(folderLevel(tree, null).map((n) => n.folder.name)).toEqual(["Commander", "Odds"]);
  });
});
