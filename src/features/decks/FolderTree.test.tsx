import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TOOLTIP_OPEN_MS, TooltipProvider } from "@/components/tooltip/TooltipProvider";
import type { DeckFolder } from "@/lib/ipc";
import { deckDragData, readDeckDrag } from "./deckDrag";
import { dragData, readDragData } from "./dnd";
import {
  DEFAULT_FOLDER_TREE_WIDTH_PX,
  FOLDER_GUIDE_ATTR,
  FolderTree,
  type FolderTreeProps,
} from "./FolderTree";
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
      width={DEFAULT_FOLDER_TREE_WIDTH_PX}
      collapsed={false}
      maxWidth={600}
      onResize={() => {}}
      onCollapse={() => {}}
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

/**
 * The column as something with a **width** — dragged from its right edge, folded to a 36px rail,
 * and both of those remembered by the page above it.
 *
 * **The two facts are kept apart in every case below, and that is most of what they are about.**
 * `collapsed` is what the reader *pressed*; `roomy` is a measurement of the row they are standing
 * in. Fold the two together and the first reader who narrows their window loses the tree for good:
 * the measurement writes itself back as a choice, and widening the window again gives nothing. So
 * every case that rails the tree says which of the two did it.
 *
 * **The splitter's own contract is `src/components/ResizeHandle.test.tsx`'s** — the arithmetic,
 * the guards and the key map on both edges — and none of it is repeated here. What this file adds
 * is the wiring: that this tree is the **left**-docked one, that the range it announces is this
 * column's own, and what the width and the fold do to the rows.
 *
 * jsdom lays nothing out, so nothing below measures a box: the width is an inline style the
 * component writes, and the rail is a class.
 */

/** One folder, which is all the rows any case below needs — what is under test here is the
 *  column, not the tree in it. */
const COMMANDER = folder(1, null, "Commander", 0);

/**
 * The tree with the page's half of the pair held for it — a width and a fold that a drag or a
 * press really changes, the way `DecksPage` holds them through `useFolderPane`.
 *
 * **Nothing in here clamps.** The number goes back in exactly as it came out, so a clamp asserted
 * below is the component's own and cannot be this harness agreeing with it.
 */
function liveTree({
  collapsed = false,
  roomy,
  width = DEFAULT_FOLDER_TREE_WIDTH_PX,
  maxWidth = 600,
}: { collapsed?: boolean; roomy?: boolean; width?: number; maxWidth?: number } = {}) {
  const onResize = vi.fn();
  const onCollapse = vi.fn();
  function Live({ room, max }: { room?: boolean; max: number }) {
    const [drawnWidth, setDrawnWidth] = useState(width);
    const [folded, setFolded] = useState(collapsed);
    return (
      <FolderTree
        width={drawnWidth}
        collapsed={folded}
        maxWidth={max}
        roomy={room}
        onResize={(next) => {
          onResize(next);
          setDrawnWidth(next);
        }}
        onCollapse={(next) => {
          onCollapse(next);
          setFolded(next);
        }}
        nodes={buildFolderTree([COMMANDER], [])}
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
      />
    );
  }
  const view = render(<Live room={roomy} max={maxWidth} />);
  return {
    onResize,
    onCollapse,
    /** Re-render with the room the page measured changed — what a window resize does. Same
     *  component in the same position, so the reader's own answers survive it, which is exactly
     *  the property the room cases are about. */
    setRoom: (room: boolean) => view.rerender(<Live room={room} max={maxWidth} />),
    /** Re-render with the page's cap changed — a window widened, or a deck tile that has stopped
     *  needing so much of the row. */
    setMax: (max: number) => view.rerender(<Live room={roomy} max={max} />),
  };
}

const tree = () => screen.getByRole("navigation", { name: "Folders" });
const handle = () => screen.getByRole("separator", { name: "Resize folders" });
const noHandle = () => screen.queryByRole("separator", { name: "Resize folders" });
const chevron = () => screen.getByRole("button", { name: /^(Expand|Collapse) folders$/ });

/**
 * One pointer event with a real `clientX` on it.
 *
 * `CardSearchPanel.test.tsx`'s helper, for its reason: **jsdom ships no `PointerEvent`**, so
 * Testing Library's pointer helpers fall back to a plain `Event` and the coordinate never
 * arrives — every assertion below would be about `NaN`. React dispatches on the event's *type*.
 */
function pointer(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX, button: 0 });
  Object.defineProperty(event, "pointerId", { value: 1 });
  fireEvent(handle(), event);
}

/** A whole drag: press at `from`, move to `to`, let go. This column is docked **left**, so
 *  rightward is wider. */
function drag(from: number, to: number) {
  pointer("pointerdown", from);
  pointer("pointermove", to);
  pointer("pointerup", to);
}

describe("the column's width", () => {
  it("draws the tree at the width it is given, and announces this column's own range", () => {
    drawTree([COMMANDER], { width: 260, maxWidth: 500 });

    expect(tree()).toHaveStyle({ width: "260px" });
    expect(handle()).toHaveAttribute("aria-valuenow", "260");
    // 160 written out: this floor is counted off the tree's own markup — a row's guides, glyph,
    // count and the reserved `+` column — and is deliberately not the card wall's 206.
    expect(handle()).toHaveAttribute("aria-valuemin", "160");
    expect(handle()).toHaveAttribute("aria-valuemax", "500");
    // It points at the column it sizes, which is how a screen reader ties the two together.
    expect(handle()).toHaveAttribute("aria-controls", tree().id);
  });

  /**
   * **Docked left, so pulling the edge _right_ widens it** — the mirror image of the deck
   * editor's card search column, and the one thing about this tree the shared splitter could get
   * exactly backwards while every one of its own right-docked cases stayed green.
   */
  it("widens as its right edge is pulled right, and narrows going left", () => {
    const { onResize } = liveTree();

    drag(400, 500);
    expect(onResize).toHaveBeenLastCalledWith(308);
    expect(tree()).toHaveStyle({ width: "308px" });

    drag(500, 450);
    expect(onResize).toHaveBeenLastCalledWith(258);
  });

  /** The keyboard turns over with it: Right widens, Left narrows. A caret cannot perform a drag,
   *  and there is no other control anywhere that sets this width. */
  it("steps wider with Right and narrower with Left", async () => {
    const { onResize } = liveTree();
    handle().focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(onResize).toHaveBeenLastCalledWith(232);

    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(onResize).toHaveBeenLastCalledWith(184);
  });

  /**
   * **The floor and the ceiling are the drag's, not merely the announcement's.**
   *
   * `aria-valuemin`/`aria-valuemax` say what the range is; this is the range being *enforced*. A
   * reader who overshoots sees the column stop, which is what an edge is — and the number that
   * stops is the number that reaches storage, so an unclamped drag is a tree remembered at 12px,
   * or at the whole width of the wall, for every session after this one.
   *
   * Driven past both ends by a long way, and the harness feeds back whatever it is handed, so
   * nothing outside the component can be the thing doing the clamping.
   */
  it("stops at either end of its range however far the edge is pulled", () => {
    const { onResize } = liveTree();

    // 208 + (10 − 400) = −182 unclamped, which is not a width at all.
    drag(400, 10);
    expect(onResize).toHaveBeenLastCalledWith(160);
    expect(tree()).toHaveStyle({ width: "160px" });

    // 160 + (2000 − 400) = 1760 unclamped, against a page that has said 600.
    drag(400, 2000);
    expect(onResize).toHaveBeenLastCalledWith(600);
    expect(tree()).toHaveStyle({ width: "600px" });
  });

  /**
   * **The clamp split, which is the whole of "reopens at the width the reader chose".**
   *
   * The environment clamps what is *drawn*; a drag clamps what is *stored*. A window narrowing,
   * or a deck tile that will not give any more of the row, is not the reader changing their
   * mind — so when the room comes back, so does their column. Clamp the stored number instead
   * and every momentary squeeze is permanent, and the failure is invisible until somebody widens
   * a window.
   *
   * The two halves are asserted together on purpose: that the cap is honoured on screen, and
   * that honouring it wrote **nothing** back through `onResize`.
   */
  it("draws inside the page's cap and gives the reader's width back when it lifts", () => {
    const { onResize, setMax } = liveTree({ width: 400, maxWidth: 300 });

    expect(tree()).toHaveStyle({ width: "300px" });
    expect(handle()).toHaveAttribute("aria-valuenow", "300");

    setMax(600);

    expect(tree()).toHaveStyle({ width: "400px" });
    expect(onResize).not.toHaveBeenCalled();
  });

  /** The same clamp at the other end — a stored width under the floor is *drawn* at the floor,
   *  which is what a row a newer build has narrowed, or a hand-edited row, arrives as. */
  it("draws no narrower than its floor whatever width it is handed", () => {
    liveTree({ width: 40 });

    expect(tree()).toHaveStyle({ width: "160px" });
    expect(handle()).toHaveAttribute("aria-valuenow", "160");
  });
});

describe("the rail", () => {
  /**
   * **One root in both states.** React reconciles by position, so two shapes either side of a
   * fold would make the chevron a *different* button — and a caret handed back to it would be
   * dropped one commit later around a freshly mounted copy. The identity check is what would fail
   * a "tidy" that split the two arms into separate roots.
   */
  it("keeps one nav and one chevron across a fold", async () => {
    liveTree();
    const before = tree();
    const button = chevron();

    await userEvent.click(chevron());

    expect(tree()).toBe(before);
    expect(chevron()).toBe(button);
  });

  it("folds to a 36px rail and drops the inline width", async () => {
    liveTree();
    await userEvent.click(chevron());

    expect(tree().classList.contains("w-9")).toBe(true);
    // Read off the property rather than the attribute: React empties the declaration and leaves a
    // bare `style=""` behind. The rail's width is the class and never an inline number, so the
    // reader's dragged width cannot leak into a state that has no edge to drag.
    expect(tree().style.width).toBe("");
    // The hairline is on the column in *both* states — a fold changes what is in this column,
    // not what it is.
    expect(tree().classList.contains("border-r")).toBe(true);
    // Nothing to pull on: there is no edge in a rail, and a strip down it would be an affordance
    // for a width the column has given up.
    expect(noHandle()).toBeNull();
  });

  /**
   * **The rows are not in the tree at all** — unmounted, not hidden. The rail exists to give the
   * wall this column's width back, and a folder list that was merely invisible would still be a
   * tab stop per row and a drop target per row for a deck that can no longer be seen landing.
   */
  it("takes every row out of the tree, the root row included", async () => {
    liveTree();
    expect(screen.getByRole("button", { name: /^Commander, / })).toBeInTheDocument();

    await userEvent.click(chevron());

    expect(screen.queryByRole("button", { name: /^Commander, / })).toBeNull();
    expect(screen.queryByRole("button", { name: /^All decks, / })).toBeNull();
    // The one control that makes a folder goes with them: a `+` over no list is a button whose
    // result the reader cannot see.
    expect(screen.queryByRole("button", { name: "New folder at the top level" })).toBeNull();
  });

  /** **It names the result, not the state.** `aria-expanded` already says which way round it is,
   *  and a reader who has just heard "collapsed" wants to know what pressing it would do. */
  it("names what pressing it would do, and flips aria-expanded", async () => {
    liveTree();
    expect(chevron()).toHaveAccessibleName("Collapse folders");
    expect(chevron()).toHaveAttribute("aria-expanded", "true");

    await userEvent.click(chevron());

    expect(chevron()).toHaveAccessibleName("Expand folders");
    expect(chevron()).toHaveAttribute("aria-expanded", "false");
  });

  /** The press hands the page the negation of what the **reader** chose — never of what happens
   *  to be drawn, which is the same distinction `roomy` is kept apart for below. */
  it("hands the page the opposite of the reader's own answer", async () => {
    const { onCollapse } = liveTree({ collapsed: true });

    await userEvent.click(chevron());

    expect(onCollapse).toHaveBeenCalledWith(false);
  });

  /** And the reader's width is still theirs on the way back out: it lives in the page beside the
   *  fold, so somebody who sized this column for a job, shut it and opened it again is not asking
   *  to start from 208. */
  it("reopens at the width the reader left it at", async () => {
    liveTree();
    drag(400, 500);
    expect(tree()).toHaveStyle({ width: "308px" });

    await userEvent.click(chevron());
    await userEvent.click(chevron());

    expect(tree()).toHaveStyle({ width: "308px" });
  });
});

/**
 * **A narrow row is a measurement, and a measurement is not a press.**
 *
 * This is the half that cannot be got back once it is lost: a railing written through
 * `onCollapse` would be recorded as the reader's own choice, and widening the window again would
 * give them nothing at all. So `roomy === false` draws the rail and touches the stored answer
 * never.
 */
describe("a row with no room for it", () => {
  it("rails the tree whatever the reader chose, and writes nothing back", async () => {
    const { onCollapse } = liveTree({ roomy: false });

    expect(tree().classList.contains("w-9")).toBe(true);
    expect(tree().style.width).toBe("");
    expect(noHandle()).toBeNull();
    expect(screen.queryByRole("button", { name: /^Commander, / })).toBeNull();

    // The press is refused rather than recorded — a control that quietly stored a choice it then
    // did nothing about is the reader being answered by something they never operated.
    await userEvent.click(chevron());
    expect(onCollapse).not.toHaveBeenCalled();
  });

  /**
   * **The one state where the name and the stored answer disagree, and the name follows the
   * drawing.**
   *
   * Everywhere else `collapsed` and what is on screen are the same fact, so this is the only case
   * that can tell the two wirings apart — which is exactly why it is pinned. The reader left the
   * tree open and the row then took the room away, so their stored answer is still "open" while
   * the column is a rail. Naming the *press* against that answer announces "Collapse folders,
   * collapsed": a control at odds with the state word beside it. Naming the *drawing* agrees with
   * `aria-expanded`, and what the control cannot do is left to `aria-disabled` and the tooltip,
   * which is where a refusal belongs.
   *
   * Both halves are asserted together on purpose — the label alone would stay green if
   * `aria-expanded` were flipped to match the wrong one.
   */
  it("names the rail it is drawn as, not the answer the reader still has stored", () => {
    liveTree({ roomy: false, collapsed: false });

    expect(chevron()).toHaveAccessibleName("Expand folders");
    expect(chevron()).toHaveAttribute("aria-expanded", "false");
  });

  /**
   * **`aria-disabled` and a press that does nothing, never the `disabled` attribute.** A disabled
   * button leaves the tab order, which would hang the reason on a hover a keyboard reader cannot
   * perform — a rail that cannot be opened and never says why.
   */
  it("stays reachable while it refuses", () => {
    liveTree({ roomy: false });

    expect(chevron()).toHaveAttribute("aria-disabled", "true");
    expect(chevron()).toBeEnabled();
    chevron().focus();
    expect(chevron()).toHaveFocus();
  });

  /** And the reader's own answer is what is drawn the moment the room comes back: the railing
   *  went through no state at all while the row was narrow. */
  it("draws the tree again, at the reader's own width, the moment the room returns", () => {
    // Seeded at a width that is not the default, so "the tree came back" and "it came back at
    // the width the reader had dragged it to" are two claims rather than one number that would
    // be right either way.
    const { setRoom } = liveTree({ roomy: false, width: 240 });

    expect(noHandle()).toBeNull();

    setRoom(true);

    expect(tree()).toHaveStyle({ width: "240px" });
    expect(screen.getByRole("button", { name: /^Commander, / })).toBeInTheDocument();
  });

  /** Refused in words, on the app's one tooltip — the docked search columns' refusal with this
   *  page's own remedies in it, because there is no card pane here to close. */
  it("says why, where it is refusing", async () => {
    render(
      <TooltipProvider>
        <FolderTree
          width={DEFAULT_FOLDER_TREE_WIDTH_PX}
          collapsed={false}
          maxWidth={600}
          roomy={false}
          onResize={() => {}}
          onCollapse={() => {}}
          nodes={buildFolderTree([COMMANDER], [])}
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
        />
      </TooltipProvider>,
    );

    fireEvent.pointerEnter(chevron());

    const tooltip = await screen.findByRole("tooltip", {}, { timeout: TOOLTIP_OPEN_MS + 1000 });
    expect(tooltip).toHaveTextContent(/not enough room/i);
    fireEvent.pointerLeave(chevron());
  });
});
