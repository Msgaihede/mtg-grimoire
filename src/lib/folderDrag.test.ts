import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { monitorForElements } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { dragData, readDragData } from "@/features/decks/dnd";
import { startDrag } from "@/test-drag";
import {
  folderDragData,
  folderDraggable,
  folderEdge,
  readFolderDrag,
  useFolderDropTarget,
  type FolderDrag,
  type FolderEdge,
  type FolderScope,
} from "./folderDrag";

const FOLDER: FolderDrag = { folderId: 4, name: "Standard", parentId: null, scope: "deck" };

/** The card half of `dnd.ts`'s vocabulary, for the two tests about the two marks not being one
 *  mark. Built through `dragData` rather than from a hand-written literal, so a change to that
 *  module's own key cannot leave this passing about a string nothing writes any more. */
const CARD = { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" } as const;

describe("folderDragData / readFolderDrag", () => {
  it("round-trips a folder in each of the three cabinets", () => {
    for (const scope of ["deck", "collection", "wishlist"] as const) {
      const folder = { ...FOLDER, scope };
      expect(readFolderDrag(folderDragData(folder), scope)).toEqual(folder);
    }
  });

  /**
   * **The check the whole scope exists for.** The sidebar's deck-folder tree is mounted beside
   * the collection page and the wishlist page all day, so carrying a deck folder over a
   * collection folder card is a gesture a reader can actually make — and folder `4` exists in all
   * three tables, so a target that took it would file a real row in the wrong cabinet.
   */
  it("refuses a folder belonging to another cabinet", () => {
    const deckFolder = folderDragData(FOLDER);
    expect(readFolderDrag(deckFolder, "deck")).toEqual(FOLDER);
    expect(readFolderDrag(deckFolder, "collection")).toBeNull();
    expect(readFolderDrag(deckFolder, "wishlist")).toBeNull();
  });

  it("refuses a payload that is not a folder at all", () => {
    expect(readFolderDrag(dragData(CARD), "deck")).toBeNull();
    expect(readFolderDrag({}, "deck")).toBeNull();
  });

  /**
   * **The mark is what is checked first, and it has to be checked on its own account.** Every
   * other refusal in this file would also be caught by one of the field checks — a card payload
   * has no `scope`, an empty record has no id — so a reader that had lost its mark check would
   * pass all of them. This is the record that gets through: the folder's own four fields, flat,
   * with nothing saying they came from a folder. Nothing in the app writes one today, which is
   * exactly why the guard needs a test rather than a witness.
   */
  it("refuses a well-formed folder record carrying no mark", () => {
    expect(readFolderDrag({ ...FOLDER }, "deck")).toBeNull();
  });

  /** The other direction, and it is what makes the separate key worth having: every card target
   *  already in the window — a deck category, the sidebar's Decks entry, a quick zone — refuses a
   *  dragged folder with no change of its own, because there is no card mark on it to find. */
  it("is invisible to the card reader, and the card payload is invisible to this one", () => {
    expect(readDragData(folderDragData(FOLDER))).toBeNull();
    expect(readFolderDrag(dragData(CARD), "deck")).toBeNull();
  });

  it("refuses a malformed folder id", () => {
    for (const folderId of [0, -1, 1.5, "4", null, undefined]) {
      expect(readFolderDrag({ ...folderDragData(FOLDER), folderId }, "deck")).toBeNull();
    }
  });

  it("refuses a parent that is neither the root nor a real folder", () => {
    for (const parentId of [0, -1, 1.5, "2", undefined]) {
      expect(readFolderDrag({ ...folderDragData(FOLDER), parentId }, "deck")).toBeNull();
    }
  });

  it("refuses a name that is not a string, and takes an empty one", () => {
    expect(readFolderDrag({ ...folderDragData(FOLDER), name: 4 }, "deck")).toBeNull();
    expect(readFolderDrag({ ...folderDragData(FOLDER), name: "" }, "deck")?.name).toBe("");
  });

  /** `parentId` travels so a target can refuse **before** the drop: the folder this one already
   *  sits in draws no nest mark at all, rather than a mark leading to a write that moves nothing. */
  it("carries where the folder sits now, so its own parent can refuse it", () => {
    expect(readFolderDrag(folderDragData({ ...FOLDER, parentId: 2 }), "deck")?.parentId).toBe(2);
    expect(readFolderDrag(folderDragData(FOLDER), "deck")?.parentId).toBeNull();
  });
});

/** A sidebar tree row: `py-1.5` around `text-sm`, so 32px tall — the shortest surface the
 *  threshold has to work on, and the one the pixel figures in `EDGE_ZONE`'s comment are about. */
const ROW = new DOMRect(0, 0, 200, 32);
/** A folder card in a grid, laid out along the other axis and nowhere near the origin. */
const CARD_BOX = new DOMRect(100, 40, 240, 120);

describe("folderEdge", () => {
  /**
   * Arithmetic, not a rendering: jsdom has no layout engine, so every `getBoundingClientRect` in
   * the suite is four zeroes and a test that mounted a folder would pass over any threshold at
   * all. That is why this function takes the rect rather than reading it.
   */
  it("gives the outer quarter of a row to before and after, and the middle half to inside", () => {
    const at = (y: number) => folderEdge(ROW, { x: 100, y }, "vertical");
    expect(at(0)).toBe("before");
    expect(at(7.9)).toBe("before");
    // Exactly a quarter, and exactly three quarters, belong to the nest zone — one rule for both
    // boundaries, so the two ends cannot drift apart.
    expect(at(8)).toBe("inside");
    expect(at(16)).toBe("inside");
    expect(at(24)).toBe("inside");
    expect(at(24.1)).toBe("after");
    expect(at(32)).toBe("after");
  });

  it("reads a card grid along the other axis, from wherever the box happens to be", () => {
    const at = (x: number) => folderEdge(CARD_BOX, { x, y: 100 }, "horizontal");
    expect(at(100)).toBe("before");
    expect(at(159.9)).toBe("before");
    expect(at(160)).toBe("inside");
    expect(at(280)).toBe("inside");
    expect(at(280.1)).toBe("after");
    expect(at(340)).toBe("after");
  });

  /** The axis is the whole of what the two surfaces differ by, so the other one must not reach
   *  the answer — a tree row is 200px wide and a card is 120px tall, and neither says anything
   *  about where the drop lands. */
  it("ignores the axis it was not asked about", () => {
    expect(folderEdge(ROW, { x: -1000, y: 16 }, "vertical")).toBe("inside");
    expect(folderEdge(ROW, { x: 5000, y: 16 }, "vertical")).toBe("inside");
    expect(folderEdge(CARD_BOX, { x: 220, y: -1000 }, "horizontal")).toBe("inside");
    expect(folderEdge(CARD_BOX, { x: 220, y: 5000 }, "horizontal")).toBe("inside");
  });

  /** A sticky drop target and the library's honey-pot element both put the pointer legitimately
   *  outside the element the drop is still counted against, so "past the end" is an answer rather
   *  than an error. */
  it("answers by the end a point outside the box is past", () => {
    expect(folderEdge(ROW, { x: 100, y: -40 }, "vertical")).toBe("before");
    expect(folderEdge(ROW, { x: 100, y: 400 }, "vertical")).toBe("after");
    expect(folderEdge(CARD_BOX, { x: -60, y: 100 }, "horizontal")).toBe("before");
    expect(folderEdge(CARD_BOX, { x: 900, y: 100 }, "horizontal")).toBe("after");
  });

  /**
   * **jsdom's every box, and the reason the degenerate case is stated rather than left to
   * arithmetic.** Dividing by zero makes `Infinity` read as `"after"`, which would put a
   * suite-wide fiction — every folder in the window is being reordered past the end — where
   * "nothing was measured" belongs.
   */
  it("calls a box with no length inside, rather than dividing by zero", () => {
    const nothing = new DOMRect(0, 0, 0, 0);
    expect(folderEdge(nothing, { x: 8, y: 8 }, "vertical")).toBe("inside");
    expect(folderEdge(nothing, { x: 8, y: 8 }, "horizontal")).toBe("inside");
  });

  /**
   * **The property the quarter was chosen for, swept rather than asserted as a number.**
   * "After this folder" and "before the next one" are the same drop, so the two adjacent end
   * zones fuse into one band straddling every boundary — and a quarter is the only threshold at
   * which that fused band and the nest zone are the same size of target. A third would make the
   * boundary band twice the nest zone, a fifth would make the nest zone one and a half times the
   * band; both go red here, which is what stops `EDGE_ZONE` from being nudged on taste alone.
   */
  it("gives a reorder and a nest the same size of target", () => {
    const first = new DOMRect(0, 0, 100, 100);
    const second = new DOMRect(100, 0, 100, 100);
    const of = (box: DOMRect, x: number) => folderEdge(box, { x, y: 50 }, "horizontal");
    // Half-pixel samples, so no sample sits exactly on a boundary and is counted by fiat.
    const xs = Array.from({ length: 200 }, (_, i) => i + 0.5);

    const nest = xs.filter((x) => x < 100 && of(first, x) === "inside").length;
    const boundary = xs.filter((x) =>
      x < 100 ? of(first, x) === "after" : of(second, x) === "before",
    ).length;

    expect(nest).toBe(50);
    expect(boundary).toBe(nest);
  });
});

/** Everything hand-built into `document.body` for a test, undone after it — `cleanup` only knows
 *  about what Testing Library rendered, and a `draggable` left in the library's registry outlives
 *  the test that made it. */
const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function mountSource(folder: () => FolderDrag): HTMLElement {
  const element = document.createElement("div");
  element.textContent = "a folder";
  document.body.append(element);
  const stop = folderDraggable({ element, folder });
  undo.push(() => {
    stop();
    element.remove();
  });
  return element;
}

describe("folderDraggable", () => {
  /** A callback rather than a value, so a folder renamed or re-filed since it mounted carries
   *  what it is now — which is what lets its current parent refuse a nest that moves nothing. */
  it("carries the folder as it is at dragstart, not as it was at mount", async () => {
    let folder: FolderDrag = { ...FOLDER };
    const source = mountSource(() => folder);
    folder = { ...FOLDER, name: "Standard decks", parentId: 2 };

    const carried: Record<string, unknown>[] = [];
    const stop = monitorForElements({ onDragStart: ({ source: from }) => carried.push(from.data) });
    const held = await startDrag(source);
    await held.cancel();
    stop();

    expect(carried.map((data) => readFolderDrag(data, "deck"))).toEqual([
      { folderId: 4, name: "Standard decks", parentId: 2, scope: "deck" },
    ]);
  });

  /**
   * **A press on the folder's own menu is a press on the menu.** `composedDraggable`'s
   * capture-phase guard, reached from this module rather than copied into it: Chromium starts a
   * drag from the nearest draggable *ancestor* of whatever was pressed, so without it a press on
   * the `⋯` that travels five pixels files the folder somewhere instead of opening the menu. The
   * press and the drag land on two different elements here, exactly as the platform sends them.
   */
  it("does not start a drag from a press on the folder's own control", async () => {
    const source = mountSource(() => FOLDER);
    const menu = document.createElement("button");
    menu.setAttribute("data-no-drag", "");
    source.append(menu);

    const refused = await startDrag(source, { pressOn: menu });
    expect(refused.started).toBe(false);
    await refused.cancel();

    // And the folder itself still is draggable: the guard is about a control's press, not about
    // the folder.
    const again = await startDrag(source);
    expect(again.started).toBe(true);
    await again.cancel();
  });
});

/**
 * Three boxes, each placed so that the one coordinate `test-drag` sends — `clientX`/`clientY` 8 —
 * falls in a different zone of it. Moving the box under a stationary pointer is the same relative
 * move as moving the pointer over a still box, and it is the only one a jsdom drag can make.
 */
const AT_START = new DOMRect(0, 0, 100, 100);
const AT_MIDDLE = new DOMRect(-50, -50, 100, 100);
const AT_END = new DOMRect(-85, -85, 100, 100);

interface TargetProps {
  scope: FolderScope;
  axis: "vertical" | "horizontal";
  canDrop: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDrop: (drag: FolderDrag, edge: FolderEdge) => void;
}

function mountTarget({
  rect = AT_START,
  ...props
}: Partial<TargetProps> & { rect?: DOMRect } = {}) {
  const element = document.createElement("div");
  document.body.append(element);
  let box = rect;
  element.getBoundingClientRect = () => box;
  undo.push(() => element.remove());

  const initialProps: TargetProps = {
    scope: "deck",
    axis: "vertical",
    canDrop: () => true,
    onDrop: () => {},
    ...props,
  };
  const ref = { current: element as HTMLElement | null };
  const view = renderHook((current: TargetProps) => useFolderDropTarget({ ref, ...current }), {
    initialProps,
  });
  let current = initialProps;
  return {
    element,
    get state() {
      return view.result.current;
    },
    /** Slide the folder under the pointer — see the three boxes above. */
    moveTo(next: DOMRect) {
      box = next;
    },
    /** A refetch re-rendering the page in the middle of a drag. */
    rerender(next: Partial<TargetProps>) {
      current = { ...current, ...next };
      act(() => view.rerender(current));
    },
  };
}

describe("useFolderDropTarget", () => {
  it("arms every target that would take the folder, and no others", async () => {
    const takes = mountTarget();
    const refuses = mountTarget({ canDrop: () => false });
    const held = await startDrag(mountSource(() => FOLDER));

    expect(takes.state.armed).toBe(true);
    expect(refuses.state.armed).toBe(false);

    await held.cancel();
    expect(takes.state.armed).toBe(false);
  });

  /**
   * **`armed` is the "any of the three" question, and it has to be.** At `dragstart` there is no
   * pointer position yet, so a target asked about one landing would go dark for a folder it would
   * happily take beside — which is the ordinary case, not a corner: a folder's own parent refuses
   * the nest and accepts both reorders.
   */
  it("arms on the strength of one landing, with the other two refused", async () => {
    const target = mountTarget({ canDrop: (_drag, edge) => edge === "before" });
    const held = await startDrag(mountSource(() => FOLDER));

    expect(target.state.armed).toBe(true);
    await held.cancel();
  });

  it("reports the landing the pointer is over, and nothing before it arrives", async () => {
    const target = mountTarget({ rect: AT_START });
    const held = await startDrag(mountSource(() => FOLDER));
    expect(target.state.edge).toBeNull();

    await held.over(target.element);
    expect(target.state.edge).toBe("before");
    await held.cancel();
  });

  /**
   * **The whole gesture is that one folder means three things at three heights**, so a mark that
   * only answered on entry would be a mark that is right once per folder. Only `onDrag` can see
   * the second move: the library fires `onDragEnter` from `onDropTargetChange`, and that is
   * dispatched *only when the drop-target hierarchy changes* — a second `dragover` on the same
   * element changes nothing, which is exactly what makes this test able to tell the two apart.
   */
  it("follows the pointer within one folder rather than answering once on entry", async () => {
    const target = mountTarget({ rect: AT_START });
    const held = await startDrag(mountSource(() => FOLDER));

    await held.over(target.element);
    expect(target.state.edge).toBe("before");

    target.moveTo(AT_MIDDLE);
    await held.over(target.element);
    expect(target.state.edge).toBe("inside");

    target.moveTo(AT_END);
    await held.over(target.element);
    expect(target.state.edge).toBe("after");
    await held.cancel();
  });

  /**
   * A target stays in the library's hierarchy over the part of itself it refuses — deliberately,
   * because a `canDrop` that answered `false` there would take the element out of the drag
   * altogether and freeze the reported edge at whatever it last was. `edge` is where the refusal
   * shows instead, as `null`: no mark, and therefore no promise of a write that will not happen.
   */
  it("reports no landing over a part of the folder that would refuse", async () => {
    const target = mountTarget({ rect: AT_MIDDLE, canDrop: (_drag, edge) => edge !== "inside" });
    const held = await startDrag(mountSource(() => FOLDER));
    expect(target.state.armed).toBe(true);

    await held.over(target.element);
    expect(target.state.edge).toBeNull();

    target.moveTo(AT_START);
    await held.over(target.element);
    expect(target.state.edge).toBe("before");
    await held.cancel();
  });

  it("hands the page the folder and where it landed", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ rect: AT_END, onDrop });
    const held = await startDrag(mountSource(() => FOLDER));

    await held.over(target.element);
    await held.drop();

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(FOLDER, "after");
  });

  /**
   * **`canDrop` is asked again on the drop**, which is what the hook's comment claims and what
   * nothing else here can see: the library never delivers a drop to a target that refused at
   * `dragover`, so every other refusal test in this file passes whether the second question is
   * asked or not. A policy that changes its mind mid-drag is the only way to reach the line — and
   * it is not a contrivance, because the two questions can be a second apart with a refetch
   * between them, and only the second one writes.
   */
  it("asks again at the drop, and refuses a folder it has stopped taking", async () => {
    let takes = true;
    const onDrop = vi.fn();
    const target = mountTarget({ rect: AT_START, canDrop: () => takes, onDrop });
    const held = await startDrag(mountSource(() => FOLDER));

    await held.over(target.element);
    expect(target.state.edge).toBe("before");

    takes = false;
    await held.drop();
    expect(onDrop).not.toHaveBeenCalled();
  });

  /**
   * The reason both callbacks are read through a ref: a folder list refetching mid-drag re-renders
   * every target on screen, and a target that registered its handlers into the library would go on
   * calling the render they were made in. The observable is the *newest* one being called; that a
   * target does not tear itself down to get there is the deps array, `[ref, scope, axis]`.
   */
  it("acts on the newest onDrop, not the one it registered with", async () => {
    const registered = vi.fn();
    const newest = vi.fn();
    const target = mountTarget({ rect: AT_START, onDrop: registered });
    const held = await startDrag(mountSource(() => FOLDER));

    await held.over(target.element);
    target.rerender({ onDrop: newest });
    await held.drop();

    expect(registered).not.toHaveBeenCalled();
    expect(newest).toHaveBeenCalledWith(FOLDER, "before");
  });

  /**
   * A collection folder card is on screen while the sidebar's deck tree is, so this is the drag a
   * reader can make by accident — and every one of the three answers has to be no, not merely the
   * last one.
   */
  it("is blind to a folder from another cabinet", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ scope: "collection", rect: AT_START, onDrop });
    const held = await startDrag(mountSource(() => FOLDER));

    expect(target.state.armed).toBe(false);
    await held.over(target.element);
    expect(target.state.edge).toBeNull();

    await held.drop();
    expect(onDrop).not.toHaveBeenCalled();
  });

  /** Escape, or a drop on nothing: the platform ends both the same way, so both marks stand down
   *  without this hearing a keypress. */
  it("stands both marks down when the drag is cancelled", async () => {
    const target = mountTarget({ rect: AT_START });
    const held = await startDrag(mountSource(() => FOLDER));

    await held.over(target.element);
    expect(target.state).toEqual({ armed: true, edge: "before" });

    await held.cancel();
    expect(target.state).toEqual({ armed: false, edge: null });
  });

  /** Leaving a folder without letting go clears its mark and leaves it armed: the folder is still
   *  in the air and every eligible target still says so. */
  it("clears the landing when the pointer leaves, and stays armed", async () => {
    const target = mountTarget({ rect: AT_START });
    const held = await startDrag(mountSource(() => FOLDER));

    await held.over(target.element);
    expect(target.state.edge).toBe("before");

    await held.leave();
    expect(target.state).toEqual({ armed: true, edge: null });
    await held.cancel();
  });
});
