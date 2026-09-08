import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DeckFolder } from "@/lib/ipc";
import { deckDragData, readDeckDrag } from "./deckDrag";
import { dragData, readDragData } from "./dnd";
import { FOLDER_GUIDE_ATTR, FolderTree, type FolderTreeProps } from "./FolderTree";
import { buildFolderTree, flattenFolders, folderDescendants } from "./folders";

const folder = (id: number, parentId: number | null, name: string, sortOrder = 0): DeckFolder => ({
  id,
  parentId,
  name,
  sortOrder,
});

/** Only the two fields the tree counts by. */
const deck = (folderId: number | null, archived = false) => ({ folderId, archived });

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
   * over a sub-folder holding twelve decks is a lie a reader can only catch by clicking.
   */
  it("counts the decks under a folder as well as the ones in it", () => {
    const tree = buildFolderTree(
      [folder(1, null, "Commander"), folder(2, 1, "Legends")],
      [deck(1), deck(2), deck(2), deck(null)],
    );

    expect(tree[0].count).toBe(3);
    expect(tree[0].children[0].count).toBe(2);
  });

  /** Archived decks are behind their own disclosure with their own count. A row saying 5 over
   *  a grid showing 4 is the same lie wearing the other hat. */
  it("leaves archived decks out of the counts", () => {
    const tree = buildFolderTree([folder(1, null, "Commander")], [deck(1), deck(1, true)]);

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
   * decks in it with no number anywhere pointing at them.
   */
  it("draws a folder whose parent is missing at the root", () => {
    const tree = buildFolderTree([folder(2, 99, "Legends")], [deck(2)]);

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

  /** A deck filed in a folder this list does not carry counts nowhere in the tree — the page
   *  draws it at the top level, which the tree has no node for. */
  it("counts nothing for a deck filed in a folder that is not there", () => {
    const tree = buildFolderTree([folder(1, null, "Commander")], [deck(99)]);

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

/**
 * **The two-way fence.** A deck drag and a card drag share the mark's key and carry different
 * values, so each reader refuses the other's payload — which is what keeps a deck let go over a
 * category column, or over the sidebar's Decks entry, from lighting anything up.
 */
describe("readDeckDrag", () => {
  it("reads back what a deck tile put in", () => {
    expect(readDeckDrag(deckDragData({ deckId: 4, name: "Burn" }))).toEqual({
      deckId: 4,
      name: "Burn",
    });
  });

  it("refuses a card drag, and a card drop target refuses a deck drag", () => {
    const card = dragData({
      kind: "card",
      cardId: "abc",
      name: "Black Lotus",
      typeLine: "Artifact",
    });
    const deckDrag = deckDragData({ deckId: 4, name: "Burn" });

    expect(readDeckDrag(card)).toBeNull();
    expect(readDragData(deckDrag)).toBeNull();
  });

  it("refuses an id that would address every deck or no deck", () => {
    expect(readDeckDrag({ ...deckDragData({ deckId: 4, name: "Burn" }), deckId: 0 })).toBeNull();
    expect(readDeckDrag({ ...deckDragData({ deckId: 4, name: "Burn" }), deckId: -1 })).toBeNull();
    expect(readDeckDrag({ ...deckDragData({ deckId: 4, name: "Burn" }), deckId: 1.5 })).toBeNull();
    expect(readDeckDrag({ ...deckDragData({ deckId: 4, name: "Burn" }), deckId: "4" })).toBeNull();
  });

  it("refuses an unmarked payload from anything else in the window", () => {
    expect(readDeckDrag({ deckId: 4, name: "Burn" })).toBeNull();
  });
});

/**
 * The tree, rendered with every prop the page supplies stubbed out.
 *
 * No gesture is driven anywhere below — the two drags are `DecksPage.test.tsx`'s, over these same
 * rows — so both `canDrop`s refuse everything and every callback is a no-op. What is under test
 * is what a row **draws**, and a drop mark laid over the guides would only make the reading
 * harder.
 */
function drawTree(folders: DeckFolder[], props: Partial<FolderTreeProps> = {}) {
  return render(
    <FolderTree
      nodes={buildFolderTree(folders, [])}
      totalDecks={0}
      selectedId={null}
      onSelect={() => {}}
      drag={null}
      canDropIn={() => false}
      onDropIn={() => {}}
      canDropFolder={() => false}
      onDropFolder={() => {}}
      naming={null}
      onOpenNew={() => {}}
      onOpenRename={() => {}}
      onCloseNaming={() => {}}
      onName={() => {}}
      busy={false}
      failure={null}
      pending={false}
      rowMenu={() => ({ onContextMenu: () => {}, onKeyDown: () => {} })}
      menuOpenerRef={{ current: null }}
      {...props}
    />,
  );
}

/**
 * One row's `<li>`, found the way a reader names it — the row's button is labelled
 * `"<name>, N decks"`.
 *
 * The `<li>` rather than the button, because two of the marks under test are outside it: the
 * gutter is the button's **sibling** (guides live beside the button, never under it) and the
 * root's trunk is drawn in the `<li>` itself.
 */
function row(name: string): HTMLElement {
  const button = screen.getByRole("button", { name: new RegExp(`^${name}, `) });
  const li = button.closest("li");
  if (li === null) throw new Error(`no row for ${name}`);
  return li;
}

/** Every mark of one kind this row drew, in document order. */
function guides(scope: HTMLElement, kind: string): HTMLElement[] {
  return [...scope.querySelectorAll<HTMLElement>(`[${FOLDER_GUIDE_ATTR}="${kind}"]`)];
}

/** The one mark of a kind a row must have drawn exactly once — so a case reading an offset off
 *  "the trunk" cannot quietly be reading the first of two. */
function guide(scope: HTMLElement, kind: string): HTMLElement {
  const found = guides(scope, kind);
  if (found.length !== 1) throw new Error(`drew ${found.length} ${kind} guides, wanted 1`);
  return found[0];
}

/**
 * What the rows draw for the nesting, and it is all of it: none of this is reachable through the
 * accessibility tree, on purpose — the shape of the tree is something a screen reader already
 * hears as the order of the rows.
 *
 * **Every offset below is written as a literal computed by hand**, never as the expression the
 * component uses. An assertion that reads its own constant passes for whatever value that
 * constant takes, including a wrong one — so 15.5 is written 15.5, and if the step ever moves,
 * every number here has to be re-derived by whoever moves it. That is the point.
 *
 * The arithmetic being checked: the step is 16, the row's glyph is 16px wide at 8px of padding,
 * so level L's trunk is centred on `x = 16·L` and a 1px line starts at `16·L − 0.5`; the gutter
 * is `16·depth + 10` wide, the extra 10 being the run the tick takes before the button starts.
 */
describe("the nesting guides", () => {
  /**
   * The one number in the gutter that is easy to write backwards, and the reason this case is
   * first: a trunk running on past the last child of a branch promises a sibling that is not
   * there, and a trunk that stops at every child leaves the branch looking finished at its first.
   */
  it("stops a last child's trunk at the elbow and runs a middle one's through", () => {
    // Commander is followed by Modern, so the top level carries on under it; Modern is the last
    // row of that level, so below it there is nothing for a line to lead to.
    drawTree([folder(1, null, "Commander", 0), folder(2, null, "Modern", 1)]);

    expect(guide(row("Commander"), "trunk").style.bottom).toBe("-2px");
    expect(guide(row("Modern"), "trunk").style.bottom).toBe("50%");
    // 50% is the tick's own height, which is where the elbow is.
    expect(guide(row("Modern"), "tick").style.top).toBe("50%");
  });

  /**
   * The 2px at each end is the list's own `gap-0.5`, closed so that a trunk reads as one line
   * down the tree rather than as a dash per row.
   */
  it("overhangs each row by the gap between rows", () => {
    drawTree([folder(1, null, "Commander", 0), folder(2, null, "Modern", 1)]);

    expect(guide(row("Commander"), "trunk").style.top).toBe("-2px");
    expect(guide(row("Modern"), "trunk").style.top).toBe("-2px");
  });

  /**
   * The fact an indent alone can never carry: two rows at the same depth look identical, and what
   * tells them apart is whether the branch above them continues.
   */
  it("draws a guide for an ancestor that still has siblings under it", () => {
    // Commander holds Legends and is followed by Modern, so at Legends' row the top level's own
    // trunk is still running past it.
    drawTree([
      folder(1, null, "Commander", 0),
      folder(2, 1, "Legends", 0),
      folder(3, null, "Modern", 1),
    ]);

    const ancestors = guides(row("Legends"), "ancestor");
    expect(ancestors).toHaveLength(1);
    // Level 1's trunk, standing exactly where the Commander row above draws its own.
    expect(ancestors[0].style.left).toBe("15.5px");
    expect(guide(row("Commander"), "trunk").style.left).toBe("15.5px");
    // It runs the whole height of the row: an ancestor's branch is not this row's to end.
    expect(ancestors[0].style.top).toBe("-2px");
    expect(ancestors[0].style.bottom).toBe("-2px");
  });

  it("draws none for an ancestor whose branch is already finished", () => {
    // The same three folders, with Commander now the *last* of the top level: nothing at that
    // level continues past its child, so the column beside Legends is blank.
    drawTree([
      folder(3, null, "Aggro", 0),
      folder(1, null, "Commander", 1),
      folder(2, 1, "Legends", 0),
    ]);

    expect(guides(row("Legends"), "ancestor")).toHaveLength(0);
    // And the row still draws its own two marks — an absent ancestor is a blank column, not a
    // row that gave up on drawing.
    expect(guide(row("Legends"), "trunk").style.left).toBe("31.5px");
  });

  it("widens the gutter by one step a level", () => {
    drawTree([
      folder(1, null, "Commander", 0),
      folder(2, 1, "Legends", 0),
      folder(3, 2, "Partners", 0),
    ]);

    expect(guide(row("Commander"), "gutter").style.width).toBe("26px");
    expect(guide(row("Legends"), "gutter").style.width).toBe("42px");
    expect(guide(row("Partners"), "gutter").style.width).toBe("58px");
  });

  it("steps the trunk and its tick along with it", () => {
    drawTree([
      folder(1, null, "Commander", 0),
      folder(2, 1, "Legends", 0),
      folder(3, 2, "Partners", 0),
    ]);

    expect(guide(row("Commander"), "trunk").style.left).toBe("15.5px");
    expect(guide(row("Legends"), "trunk").style.left).toBe("31.5px");
    expect(guide(row("Partners"), "trunk").style.left).toBe("47.5px");

    // The tick leaves from the far side of its own trunk and runs to the end of the gutter.
    expect(guide(row("Commander"), "tick").style.left).toBe("16.5px");
    expect(guide(row("Legends"), "tick").style.left).toBe("32.5px");
    expect(guide(row("Partners"), "tick").style.left).toBe("48.5px");
  });

  /**
   * **Where the gutter sits is a decision about the two drags, not only about the drawing.**
   * `folderEdge` divides the folder target's box into the three landings and that box is also
   * what the folder is picked up by, so it has to stay the whole row — which is why the gutter
   * went *inside* it, as the button's sibling, rather than in a flex box wrapped around the pair.
   * `DecksPage.test.tsx` addresses that same box as `button.parentElement`.
   */
  it("draws the guides beside the button, inside the box the folder drag measures", () => {
    drawTree([folder(1, null, "Commander", 0)]);

    const button = screen.getByRole("button", { name: /^Commander, / });
    const gutter = guide(row("Commander"), "gutter");

    expect(button.contains(gutter)).toBe(false);
    expect(gutter.parentElement).toBe(button.parentElement);
  });

  /**
   * "All decks" is the top rather than a row of the tree, so it has no level and no gutter — but
   * the folders under it need somewhere to hang from, and that line is drawn in its `<li>`.
   */
  it("hangs the top level from a trunk under the root row", () => {
    drawTree([folder(1, null, "Commander", 0)]);

    expect(guides(row("All decks"), "root")).toHaveLength(1);
    expect(guides(row("All decks"), "gutter")).toHaveLength(0);
    // That trunk is `absolute` against this `<li>`, so the `<li>` has to be its containing block
    // — without the class the line positions itself against whatever ancestor happens to be
    // positioned, which is the sidebar. A class assertion, deliberately, and the one in this file:
    // jsdom lays nothing out, so the *effect* is unreachable and the structure is all there is to
    // pin. `AppShell.test.tsx` pins `relative` on `main` for exactly this reason.
    expect(row("All decks").classList.contains("relative")).toBe(true);
  });

  /**
   * The one place this arithmetic reaches outside the tree's own rows. A "New folder in …" field
   * stands in the column the row it is about to become will stand in — `treeIndent` is the offset
   * a row's **button** starts at, which is the gutter's own width, so the field's leading edge and
   * a sibling row's are the same line.
   */
  it("puts a new folder's field where its own row's button would begin", () => {
    drawTree([folder(1, null, "Commander", 0), folder(2, 1, "Legends", 0)], {
      naming: { kind: "new", parentId: 1 },
    });

    expect(screen.getByLabelText("New folder name").closest("div")?.style.paddingLeft).toBe("42px");
    // Which is a depth-2 row's gutter, and Legends is one — the two are the same number by
    // construction and would be two different ones if either moved alone.
    expect(guide(row("Legends"), "gutter").style.width).toBe("42px");
  });

  it("draws no root trunk over an empty cabinet", () => {
    drawTree([]);

    expect(guides(row("All decks"), "root")).toHaveLength(0);
  });
});

/**
 * The rail down a selected row's leading edge — the mark that makes the current row findable in a
 * rail of twenty without reading the names.
 *
 * By attribute for the guides' reason, and it is the same reason twice over here: the row already
 * says it is current in `aria-current`, so nothing a query could ask the accessibility tree would
 * be a question about the *drawing*.
 */
describe("the selected row's rail", () => {
  it("draws on the selected row and on no other", () => {
    drawTree([folder(1, null, "Commander", 0), folder(2, null, "Modern", 1)], { selectedId: 1 });

    expect(guides(row("Commander"), "rail")).toHaveLength(1);
    expect(guides(row("Modern"), "rail")).toHaveLength(0);
    expect(guides(row("All decks"), "rail")).toHaveLength(0);
  });

  it("follows the wall to the top level", () => {
    drawTree([folder(1, null, "Commander", 0)], { selectedId: null });

    expect(guides(row("All decks"), "rail")).toHaveLength(1);
    expect(guides(row("Commander"), "rail")).toHaveLength(0);
  });
});
