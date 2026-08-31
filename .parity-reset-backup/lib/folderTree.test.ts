import { describe, expect, it } from "vitest";
import { buildFolderTree, flattenFolders, folderDescendants, type FolderLike } from "./folderTree";

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
