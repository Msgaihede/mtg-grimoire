import { useEffect, useRef, useState, type RefObject } from "react";
import { Draggable, Droppable, type DragEndEvent } from "@dnd-kit/dom";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";

/**
 * The gesture that rearranges a filing cabinet: a folder dropped on another folder's **middle**
 * goes inside it, and one dropped near an **edge** lands beside it.
 *
 * **One mechanism for three cabinets and two shapes of surface.** Deck folders, collection
 * folders and wishlist folders are the same rows with the same `sortOrder`
 * (`lib/folderTree.ts`'s `FolderLike` is that shared shape, and it is why the tree arithmetic was
 * only ever written once), and each of them is drawn twice — as a **card** in the grid the three
 * pages lay out, and, for decks, as a **row** in the sidebar's vertical tree. What differs
 * between a card and a row is one axis, so that is what {@link useFolderDropTarget} takes; what
 * differs between the three cabinets is one word, so that is what {@link FolderScope} is. Nothing
 * else in here is per-page, and no page wires a copy of any of it.
 *
 * **Its own mark under its own key, read field by field.**
 * `features/collection/collectionDrag.ts`'s rule, for that module's reason: this is the app's
 * edge with the drag library's untyped store, which every draggable in the window writes into,
 * and "it type-checked" means nothing at that edge. The key is deliberately not `dnd.ts`'s
 * `dragSource` — which buys one thing immediately, with no change anywhere else: `readDragData`
 * finds no card mark on a folder payload, so every card target already in the window (a deck
 * category, the sidebar's Decks entry, a quick zone) refuses a dragged folder outright rather
 * than trying to add it as a printing.
 *
 * **The scope is in the payload because two cabinets can be on screen at once.** The three pages
 * are never mounted together, but the **sidebar is always mounted**, and its deck-folder tree
 * sits beside the collection page and the wishlist page all day. A folder picked up in that tree
 * and carried over a collection folder card is a real gesture a reader can make, and the three
 * cabinets are separate tables with separate ids — folder `3` exists in all of them. Refusing it
 * by *where the pointer is* would mean every page teaching every target the same lesson; refusing
 * it in {@link readFolderDrag} means a target that asked for its own cabinet's payload gets
 * `null` and cannot be tempted. That is the check the drop depends on, so it is the one that is
 * tested hardest.
 */

/**
 * Which cabinet a payload belongs to. A deck folder must never land on a collection folder.
 *
 * The three words are the three folder tables, and they are what a surface passes to
 * {@link readFolderDrag} and {@link useFolderDropTarget}.
 */
export type FolderScope = "deck" | "collection" | "wishlist";

/** What a folder drag carries. */
export interface FolderDrag {
  folderId: number;
  name: string;
  /** Where it sits now — `null` is the root. Read at dragstart. */
  parentId: number | null;
  scope: FolderScope;
}

/**
 * The mark that says a payload carries a folder, and its key.
 *
 * **Deliberately not `dnd.ts`'s `dragSource`**, which is `collectionDrag.ts`'s decision made
 * again for a different reason. There the two marks had to coexist on one row, because a
 * collection entry genuinely is both a card and an entry; here nothing about a folder is a card,
 * and the separate key is what makes that refusal free — see the module comment.
 */
const FOLDER_MARK = "mtg-grimoire/folder-reorder-drag";
const MARK_KEY = "folderSource";

/** What a folder hands the adapter. Flat, so a `canDrop` reads what it needs without unwrapping
 *  anything — `dragData`'s shape, and `collectionDragData`'s. */
export function folderDragData(drag: FolderDrag): Record<string, unknown> {
  return { [MARK_KEY]: FOLDER_MARK, ...drag };
}

/**
 * The payload a folder target may act on, or `null` for anything that is not a folder drag **or
 * belongs to another cabinet**.
 *
 * Field by field rather than a cast, and `scope` is checked by **equality with the caller's own**
 * rather than by membership of the three words: a target does not want "a folder", it wants "a
 * folder out of *my* cabinet", and asking the narrower question is what makes the answer usable
 * without a second check at every call site. The returned `scope` is therefore the caller's
 * argument, which is a {@link FolderScope} by construction.
 *
 * A folder id addresses a row in one of the three `*_folders` tables, every one of them an
 * `INTEGER PRIMARY KEY`, so `0`, a negative and a fraction are as malformed here as a string is —
 * for `parentId` too, whose only other legal value is the `null` that means the root.
 */
export function readFolderDrag(
  data: Record<string, unknown>,
  scope: FolderScope,
): FolderDrag | null {
  if (data[MARK_KEY] !== FOLDER_MARK) return null;
  if (data.scope !== scope) return null;
  const { folderId, name, parentId } = data;
  if (!isFolderId(folderId)) return null;
  if (typeof name !== "string") return null;
  if (parentId !== null && !isFolderId(parentId)) return null;
  return { folderId, name, parentId, scope };
}

function isFolderId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * A folder that can be picked up — a card in a grid or a row in the tree, the same either way.
 *
 * **The press guard is the library's now, and it is the same rule.** It used to be
 * `dnd.ts`'s `composedDraggable`: a capture-phase `mousedown` listener on the element, testing
 * `NOT_A_DRAG` against what was pressed. `@dnd-kit/dom`'s `PointerSensor` asks that question
 * itself, through `preventActivation`, and `lib/dndManager.ts` configures it with the very same
 * selector — once, for every draggable in the app, rather than once per registration. The reason
 * it matters has not changed: a folder is never just a folder on screen — a card carries a `⋯`
 * menu and a tree row carries one plus a rename field — and a drag starts from the nearest
 * draggable *ancestor* of whatever was pressed, so without the guard a press on the menu plus
 * five pixels of travel files the folder somewhere. Fields are refused by `NOT_A_DRAG` outright,
 * which is why a rename in progress is a text selection rather than a drag.
 *
 * `folder` is read **at the press**, so a folder renamed or moved since it mounted carries what
 * it is now — which is the whole reason it is a callback, and what lets its current parent refuse
 * a nest that would move it nowhere. dnd-kit's `data` is a settable accessor rather than a
 * callback the library calls, so the refresh is hung off a capture-phase `pointerdown` on the
 * element: a press always precedes a drag, and the capture phase is what a control that stops the
 * press from propagating cannot hide from. That is the guard's own arrangement, kept for the
 * guard's own reason.
 */
export function folderDraggable({
  element,
  folder,
}: {
  element: HTMLElement;
  folder: () => FolderDrag;
}): () => void {
  const draggable = new Draggable(
    // `register: false` and a registration of our own — see {@link registerNow}.
    { id: dndId("folder-source"), element, data: folderDragData(folder()), register: false },
    dndManager,
  );
  registerNow(draggable);
  const refresh = () => {
    draggable.data = folderDragData(folder());
  };
  element.addEventListener("pointerdown", refresh, true);
  return () => {
    element.removeEventListener("pointerdown", refresh, true);
    draggable.destroy();
  };
}

/** Where a drop would land relative to the target. */
export type FolderEdge = "before" | "after" | "inside";

/** The three, in the order a box lays them out along its axis — for the "any of them" question
 *  {@link useFolderDropTarget} has to ask before a pointer has picked one. */
const FOLDER_EDGES: readonly FolderEdge[] = ["before", "inside", "after"];

/**
 * How much of each end of the box means "beside" rather than "inside" — **a quarter**.
 *
 * A nest zone too small makes nesting a lottery and one too large makes reordering one, so the
 * threshold wants to be the number where neither is favoured — and that number is not a taste.
 * **A quarter is the only split at which a reorder and a nest are the same size of target.**
 * Take folders of length `l` along the axis. The nest zone is one contiguous band of `(1 − 2t)·l`
 * in the middle. The reorder zone is *not* `t·l`: "after this folder" and "before the next one"
 * are the same drop, so the two adjacent end zones fuse into a single band of `2t·l` straddling
 * every boundary. Setting `2t = 1 − 2t` gives `t = ¼` and no other value. At a third, the
 * boundary band is twice the nest zone; at a fifth, the nest zone is one and a half times the
 * boundary band.
 *
 * In pixels on the surface with the least room — the sidebar's tree row, `py-1.5` around
 * `text-sm`, so 32px — that is an 8px end zone, a 16px middle, and a 16px band at each boundary
 * between two rows. It is a fraction rather than a pixel count on purpose: a folder card in the
 * grid is an order of magnitude wider than a tree row is tall, and a fixed 8px would be a
 * hairline on one and half the target on the other.
 */
const EDGE_ZONE = 0.25;

/**
 * Which of the three a point in a box means. Pure arithmetic, hand-rolled.
 *
 * **Why the closest edge is computed here rather than taken from a package.**
 * `@atlaskit/pragmatic-drag-and-drop-hitbox` is the obvious source of it and is deliberately not
 * installed in this repo. `features/decks/DropIndicator.tsx` refused it with an argument whose
 * first half is spent here and whose second half is not, and the two are worth separating because
 * the conclusion survives on the smaller one. **The spent half:** "a closest edge nobody may act
 * on is not worth an Apache-2.0 NOTICE line" — true of a deck list, whose `deck_cards` has no
 * order column, and **false here**, because folders have `sortOrder` and an insertion between two
 * of them is a position the data model can keep. That inversion is stated again at
 * `components/FolderDropLine.tsx`, which is where it becomes visible. **The half that stands:**
 * this is one subtraction, one division and two comparisons over a rect the drop target already
 * has in hand, and {@link EDGE_ZONE} is a decision this app wants to state and justify at its own
 * site rather than inherit as somebody else's default. A dependency, a NOTICE line and a version
 * to keep in step, for a dozen lines that would still not draw the mark — the palette and the
 * shipped CSP keep that hand-rolled either way, which is `DropIndicator`'s other reason and is
 * untouched by any of this.
 *
 * **Pure over a rect you pass in, and that is why it is not folded into the hook.** jsdom has no
 * layout engine, so every `getBoundingClientRect` in the suite is four zeroes — a component test
 * of a rendered folder would pass over any arithmetic at all. `lib/tooltip.ts` says the same
 * thing about placement, for the same reason. This is tested as arithmetic; the hook below is
 * tested for its wiring.
 *
 * A point outside the box answers by the end it is past, which is what a sticky drop target and
 * the library's honey-pot element both need: the pointer is legitimately a pixel or two outside
 * the element the drop is still being counted against.
 *
 * A box with no length answers `"inside"`. That is jsdom's every box, and it is the only answer
 * that does not invent a measurement: dividing by zero makes `Infinity` read as `"after"` and
 * puts a suite-wide fiction — every folder in the tree is being reordered past the end — where
 * "nothing was measured" belongs. In a real window a drawn target always has a positive box.
 */
export function folderEdge(
  rect: DOMRect,
  point: { x: number; y: number },
  axis: "vertical" | "horizontal",
): FolderEdge {
  const vertical = axis === "vertical";
  const length = vertical ? rect.height : rect.width;
  if (!(length > 0)) return "inside";
  const along = (vertical ? point.y - rect.top : point.x - rect.left) / length;
  if (along < EDGE_ZONE) return "before";
  if (along > 1 - EDGE_ZONE) return "after";
  return "inside";
}

/** Where the pointer is, in the two names dnd-kit reports it under. The library's own
 *  `Coordinates`, restated so the handlers below share one signature without importing a type
 *  from `@dnd-kit/geometry` for two numbers. */
/** The manager's view of a drag in flight, named once so the three handlers below share a
 *  signature. dnd-kit spells it as the shape hanging off every drag event rather than as an
 *  exported type, so this is read off the one event that carries every field. */
type DragOperation = DragEndEvent["operation"];

interface PointerAt {
  x: number;
  y: number;
}

/**
 * Where a folder can be let go on this target, and whether it is armed to be — one hook answering
 * both, gated by one `canDrop`.
 *
 * **`useCollectionDropTarget`'s shape, and every one of its decisions holds here.** `armed` is
 * computed **per target**, off the manager's own `dragstart` gated by this target's own
 * `canDrop`, because no two folders answer the same yes/no about the folder in the air — the one
 * being dragged refuses itself, its own parent refuses a nest that would move nothing, and a
 * descendant refuses one that would make a cycle. That is what raises the mark on **every**
 * eligible folder at once rather than only on the one under the pointer. `canDrop` and `onDrop`
 * are read through a ref rather than through the effect's deps, so a target does not tear itself
 * down and re-register every time the folder list changes under it. And `canDrop` is asked
 * **again** on the drop, because the two questions can be a second apart and only the second one
 * writes.
 *
 * **What is new here is that the question has two arguments.** A folder does not simply take or
 * refuse a payload; it takes some of the three landings and refuses others, so:
 *
 * - the **`dragstart` listener** asks the "any of the three" question, since at `dragstart` there
 *   is no pointer position yet and `armed` means "this folder could take it somehow";
 * - the **droppable's own `accept`** asks the same "any of the three" question, deliberately, and
 *   not the edge-sensitive one. An `accept` that answered `false` over the middle of a folder
 *   which only accepts a reorder would take the whole element out of collision detection at that
 *   moment: it would stop being the operation's target, and the reported edge would freeze at
 *   whatever it last was instead of following the pointer out of the nest zone. dnd-kit asks
 *   `accepts()` once per collision pass rather than at registration, so this is the same shape the
 *   pragmatic-dnd `canDrop` had and for the same reason;
 * - `edge` is where the filtering happens instead. It is the edge a drop **would land on**, and
 *   it is `null` both when the pointer is not over this target and when it is over a part of it
 *   that would refuse. A surface draws its mark straight from it — no mark means no drop, which
 *   is the honest thing to show and the opposite of a line leading to a write that never happens.
 *
 * `edge` follows the pointer **within** one target, off `dragmove` rather than `dragover` alone:
 * the whole gesture is that one folder means three different things at three heights, and
 * `dragover` fires only when the operation's *target changes*, so a mark driven by it would be a
 * mark that is right once per folder.
 *
 * **Two things changed shape with the library and neither changed meaning.** Where the pointer is
 * comes from `operation.position.current` — the manager's own coordinate — rather than from a
 * `location.current.input`, and it is read at the moment of the event for the reason it always
 * was: `setEdge` is a render behind, and where the pointer was when the reader let go is the only
 * honest answer to where a drop lands. And `edge` now **does** stand down in the end handler
 * alongside `armed`, where under pragmatic-dnd that would have been an unreachable line: that
 * library cleared its drop-target hierarchy before publishing the end of a drag, so the target's
 * own `onDragLeave` had already fired. dnd-kit publishes `dragend` with the operation's target
 * still set — that is how a drop knows where it landed — so clearing here is the only thing that
 * clears it, on the cancel path as much as on the drop.
 */
export function useFolderDropTarget({
  ref,
  scope,
  axis,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  scope: FolderScope;
  /** "vertical" for the sidebar tree (before/after are top/bottom); "horizontal" for a card
   *  grid. */
  axis: "vertical" | "horizontal";
  canDrop: (drag: FolderDrag, edge: FolderEdge) => boolean;
  onDrop: (drag: FolderDrag, edge: FolderEdge) => void;
}): { armed: boolean; edge: FolderEdge | null } {
  const [armed, setArmed] = useState(false);
  const [edge, setEdge] = useState<FolderEdge | null>(null);
  const latest = useRef({ canDrop, onDrop });
  useEffect(() => {
    latest.current = { canDrop, onDrop };
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    /** The payload this target may act on, or `null` for anything it is blind to. */
    const read = (source: { data: Record<string, unknown> } | null | undefined) =>
      source ? readFolderDrag(source.data, scope) : null;
    /** "Could this folder land here at all?" — the question `armed` and `accept` both ask. */
    const somehow = (drag: FolderDrag) =>
      FOLDER_EDGES.some((at) => latest.current.canDrop(drag, at));
    /** The landing the pointer is currently asking for, or `null` if this target refuses it. */
    const landing = (drag: FolderDrag, at: PointerAt): FolderEdge | null => {
      const which = folderEdge(element.getBoundingClientRect(), at, axis);
      return latest.current.canDrop(drag, which) ? which : null;
    };

    const droppable = new Droppable(
      {
        id: dndId("folder-target"),
        element,
        // `register: false` and a registration of our own — see {@link registerNow}.
        register: false,
        accept: (source) => {
          const drag = read(source);
          return drag !== null && somehow(drag);
        },
      },
      dndManager,
    );
    registerNow(droppable);

    const track = (operation: DragOperation) => {
      const drag = read(operation.source);
      if (drag === null || operation.target !== droppable) {
        setEdge(null);
        return;
      }
      setEdge(landing(drag, operation.position.current));
    };

    const off = [
      dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
        const drag = read(operation.source);
        setArmed(drag !== null && somehow(drag));
      }),
      dndManager.monitor.addEventListener("dragmove", ({ operation }) => track(operation)),
      dndManager.monitor.addEventListener("dragover", ({ operation }) => track(operation)),
      // Fires for a cancelled drag as well as a completed one — the library ends both the same
      // way — so both marks stand down on Escape without this hearing a keypress.
      dndManager.monitor.addEventListener("dragend", ({ operation, canceled }) => {
        setArmed(false);
        setEdge(null);
        if (canceled || operation.target !== droppable) return;
        const drag = read(operation.source);
        if (drag === null) return;
        const at = landing(drag, operation.position.current);
        if (at !== null) latest.current.onDrop(drag, at);
      }),
    ];

    return () => {
      for (const stop of off) stop();
      droppable.destroy();
    };
  }, [ref, scope, axis]);

  return { armed, edge };
}
