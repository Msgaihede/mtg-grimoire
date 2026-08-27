import { afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode, useEffect } from "react";
import { act, renderHook } from "@testing-library/react";
import { dragData, readDragData } from "@/features/decks/dnd";
import { startPointerDrag } from "@/test-drag";
import { dndManager } from "@/lib/dndManager";
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
 *  about what Testing Library rendered, and a `Draggable` left in the manager's registry outlives
 *  the test that made it. */
const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/**
 * A box, because dnd-kit hit-tests by coordinate and jsdom measures everything as zero.
 *
 * This is the whole difference between these tests and the ones they replaced. Under
 * pragmatic-dnd the harness sent one fixed coordinate and a test slid the *element* under a
 * stationary pointer; here the pointer really travels, so a folder is placed where it can be
 * arrived at and a test says which part of it to let go over.
 */
function boxed(element: HTMLElement, top: number, height = 40): HTMLElement {
  element.getBoundingClientRect = () =>
    ({
      x: 0,
      y: top,
      top,
      left: 0,
      right: 200,
      bottom: top + height,
      width: 200,
      height,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

/** Far enough from the source that the gesture is unambiguous, and the same box for every test
 *  so the three landings below are always the same three coordinates. */
const TARGET_TOP = 200;
/** A second target, for the tests that need two folders answering differently at once. */
const OTHER_TOP = 400;

/** The three landings, as fractions of a folder's own box — the vocabulary `folderEdge` is a
 *  function of. `EDGE_ZONE` is a quarter, so a tenth in from either end is unambiguously beside
 *  and the middle is unambiguously inside. */
const BEFORE = { y: 0.1 };
const INSIDE = { y: 0.5 };
const AFTER = { y: 0.9 };

function mountSource(folder: () => FolderDrag): HTMLElement {
  const element = boxed(document.createElement("div"), 0);
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
  it("carries the folder as it is at the press, not as it was at mount", async () => {
    let folder: FolderDrag = { ...FOLDER };
    const source = mountSource(() => folder);
    folder = { ...FOLDER, name: "Standard decks", parentId: 2 };

    const carried: Record<string, unknown>[] = [];
    const stop = dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
      if (operation.source) carried.push(operation.source.data);
    });
    const held = await startPointerDrag(source);
    await held.cancel();
    stop();

    expect(carried.map((data) => readFolderDrag(data, "deck"))).toEqual([
      { folderId: 4, name: "Standard decks", parentId: 2, scope: "deck" },
    ]);
  });

  /**
   * **A press on the folder's own menu is a press on the menu.** The guard is dnd-kit's
   * `preventActivation` now rather than a capture-phase `mousedown` listener, configured once in
   * `lib/dndManager.ts` with this app's own `NOT_A_DRAG` — but the failure it prevents is
   * unchanged: a drag starts from the nearest draggable *ancestor* of whatever was pressed, so
   * without it a press on the `⋯` that travels five pixels files the folder somewhere instead of
   * opening the menu. The press and the drag land on two different elements here, exactly as the
   * platform sends them.
   *
   * **It is also the one behaviour where the library's default is wrong for this app**, which is
   * why the configuration exists at all: dnd-kit refuses *every* `button`, and a folder card's
   * own name is a button.
   */
  it("does not start a drag from a press on the folder's own control", async () => {
    const source = mountSource(() => FOLDER);
    const menu = document.createElement("button");
    menu.setAttribute("data-no-drag", "");
    source.append(menu);

    const refused = await startPointerDrag(source, { pressOn: menu });
    expect(refused.started).toBe(false);
    await refused.cancel();

    // And the folder itself still is draggable: the guard is about a control's press, not about
    // the folder.
    const again = await startPointerDrag(source);
    expect(again.started).toBe(true);
    await again.cancel();
  });

  /** The name a folder card's own button carries is how a reader picks the card up, so the
   *  library's own default — refuse every `button` — would have made every folder in the app
   *  undraggable. This is the assertion that would go red if `dndManager` ever stopped
   *  overriding it. */
  it("still starts from a press on a button the folder has not marked", async () => {
    const source = mountSource(() => FOLDER);
    const name = document.createElement("button");
    name.textContent = "Standard";
    source.append(name);

    const held = await startPointerDrag(source, { pressOn: name });
    expect(held.started).toBe(true);
    await held.cancel();
  });
});

interface TargetProps {
  scope: FolderScope;
  axis: "vertical" | "horizontal";
  canDrop: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDrop: (drag: FolderDrag, edge: FolderEdge) => void;
}

function mountTarget({ top = TARGET_TOP, ...props }: Partial<TargetProps> & { top?: number } = {}) {
  const element = boxed(document.createElement("div"), top);
  document.body.append(element);
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
    const refuses = mountTarget({ top: OTHER_TOP, canDrop: () => false });
    const held = await startPointerDrag(mountSource(() => FOLDER));

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
    const held = await startPointerDrag(mountSource(() => FOLDER));

    expect(target.state.armed).toBe(true);
    await held.cancel();
  });

  it("reports the landing the pointer is over, and nothing before it arrives", async () => {
    const target = mountTarget();
    const held = await startPointerDrag(mountSource(() => FOLDER));
    expect(target.state.edge).toBeNull();

    await held.over(target.element, BEFORE);
    expect(target.state.edge).toBe("before");
    await held.cancel();
  });

  /**
   * **The whole gesture is that one folder means three things at three heights**, so a mark that
   * only answered on entry would be a mark that is right once per folder. `dragover` fires only
   * when the operation's *target* changes — three moves within one folder change nothing about
   * which folder it is — so only `dragmove` can see the second and third of these.
   */
  it("follows the pointer within one folder rather than answering once on entry", async () => {
    const target = mountTarget();
    const held = await startPointerDrag(mountSource(() => FOLDER));

    await held.over(target.element, BEFORE);
    expect(target.state.edge).toBe("before");

    await held.over(target.element, INSIDE);
    expect(target.state.edge).toBe("inside");

    await held.over(target.element, AFTER);
    expect(target.state.edge).toBe("after");
    await held.cancel();
  });

  /**
   * A target stays a collision candidate over the part of itself it refuses — deliberately,
   * because an `accept` that answered `false` there would take the element out of the drag
   * altogether and freeze the reported edge at whatever it last was. `edge` is where the refusal
   * shows instead, as `null`: no mark, and therefore no promise of a write that will not happen.
   */
  it("reports no landing over a part of the folder that would refuse", async () => {
    const target = mountTarget({ canDrop: (_drag, edge) => edge !== "inside" });
    const held = await startPointerDrag(mountSource(() => FOLDER));
    expect(target.state.armed).toBe(true);

    await held.over(target.element, INSIDE);
    expect(target.state.edge).toBeNull();

    await held.over(target.element, BEFORE);
    expect(target.state.edge).toBe("before");
    await held.cancel();
  });

  it("hands the page the folder and where it landed", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(() => FOLDER));

    await held.over(target.element, AFTER);
    await held.drop();

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith(FOLDER, "after");
  });

  /**
   * **`canDrop` is asked again on the drop**, which is what the hook's comment claims and what
   * nothing else here can see: a target that refused while the pointer was over it is not the
   * operation's target by the time the reader lets go, so every other refusal test in this file
   * passes whether the second question is asked or not. A policy that changes its mind mid-drag
   * is the only way to reach the line — and it is not a contrivance, because the two questions
   * can be a second apart with a refetch between them, and only the second one writes.
   */
  it("asks again at the drop, and refuses a folder it has stopped taking", async () => {
    let takes = true;
    const onDrop = vi.fn();
    const target = mountTarget({ canDrop: () => takes, onDrop });
    const held = await startPointerDrag(mountSource(() => FOLDER));

    await held.over(target.element, BEFORE);
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
    const target = mountTarget({ onDrop: registered });
    const held = await startPointerDrag(mountSource(() => FOLDER));

    await held.over(target.element, BEFORE);
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
    const target = mountTarget({ scope: "collection", onDrop });
    const held = await startPointerDrag(mountSource(() => FOLDER));

    expect(target.state.armed).toBe(false);
    await held.over(target.element, BEFORE);
    expect(target.state.edge).toBeNull();

    await held.drop();
    expect(onDrop).not.toHaveBeenCalled();
  });

  /** Escape, or a drop on nothing: the library ends both the same way, so both marks stand down
   *  without this hearing a keypress of its own. */
  it("stands both marks down when the drag is cancelled", async () => {
    const target = mountTarget();
    const held = await startPointerDrag(mountSource(() => FOLDER));

    await held.over(target.element, BEFORE);
    expect(target.state).toEqual({ armed: true, edge: "before" });

    await held.cancel();
    expect(target.state).toEqual({ armed: false, edge: null });
  });

  /** A cancelled drag writes nothing. Escape while the pointer is squarely over a folder that
   *  would have taken it is the one gesture that can tell "stood the mark down" apart from
   *  "stood the mark down and filed the folder anyway". */
  it("files nothing when the drag is cancelled over a willing target", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(() => FOLDER));

    await held.over(target.element, BEFORE);
    await held.cancel();

    expect(onDrop).not.toHaveBeenCalled();
  });

  /** Leaving a folder without letting go clears its mark and leaves it armed: the folder is still
   *  in the air and every eligible target still says so. */
  it("clears the landing when the pointer leaves, and stays armed", async () => {
    const target = mountTarget();
    const held = await startPointerDrag(mountSource(() => FOLDER));

    await held.over(target.element, BEFORE);
    expect(target.state.edge).toBe("before");

    await held.leave();
    expect(target.state).toEqual({ armed: true, edge: null });
    await held.cancel();
  });
});

/**
 * **The registry leak `React.StrictMode` causes, and the reason it needs a test of its own.**
 *
 * dnd-kit's `Entity` constructor ends with `queueMicrotask(this.register)` while `destroy()`
 * unregisters synchronously — so an entity built and destroyed in the same tick unregisters
 * *first* and is registered afterwards by the microtask, with nothing holding a reference to
 * undo it. StrictMode does exactly that on every mount in development: run the effect, clean it
 * up, run it again. The orphan is the one from the **first** run, whose listeners are gone, and
 * collision detection is perfectly happy to pick it as the operation's target — at which point
 * the live hook compares it against its own droppable, sees a different object, and returns.
 * The row rings, the mark comes up, and the drop silently writes nothing.
 *
 * Found in the running window and not by any of the tests above, because neither `render` nor
 * `renderHook` wraps anything in StrictMode by default: every test mounts each effect once, so
 * every registration is the live one. These two ask for it explicitly, and they are the only
 * things in the suite that would go red if `register: false` were dropped from either call site.
 */
describe("registering with the manager", () => {
  /**
   * **The count has to be taken a tick late, and that is the whole trap.** The orphan is
   * registered by a *microtask* queued in a constructor, so immediately after the render both of
   * these read 1 whether the leak is there or not — a pair of assertions that would pass against
   * the very bug they exist for. Measured: 1 straight after `renderHook`, 2 after a macrotask.
   */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

  const mine = (element: Element, kind: "draggables" | "droppables") =>
    [...dndManager.registry[kind]].filter((entity) => entity.element === element);

  it("leaves one drop target per element, through StrictMode's double mount", async () => {
    const element = boxed(document.createElement("div"), TARGET_TOP);
    document.body.append(element);
    undo.push(() => element.remove());
    const ref = { current: element as HTMLElement | null };

    renderHook(
      () =>
        useFolderDropTarget({
          ref,
          scope: "deck",
          axis: "vertical",
          canDrop: () => true,
          onDrop: () => {},
        }),
      { wrapper: StrictMode },
    );

    await settled();
    expect(mine(element, "droppables")).toHaveLength(1);
  });

  it("leaves one drag source per element, through StrictMode's double mount", async () => {
    const element = boxed(document.createElement("div"), 0);
    document.body.append(element);
    undo.push(() => element.remove());

    renderHook(() => useEffect(() => folderDraggable({ element, folder: () => FOLDER }), []), {
      wrapper: StrictMode,
    });

    await settled();
    expect(mine(element, "draggables")).toHaveLength(1);
  });
});
