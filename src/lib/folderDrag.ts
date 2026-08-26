import { useEffect, useRef, useState, type RefObject } from "react";
import {
  dropTargetForElements,
  monitorForElements,
} from "@atlaskit/pragmatic-drag-and-drop/element/adapter";
import { composedDraggable } from "@/features/decks/dnd";

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
 * **`dnd.ts`'s `composedDraggable`, and this module contributes only the record.** The
 * capture-phase `mousedown` guard is that function's alone and there is exactly one copy of it in
 * the app. It matters here for the reason it was written for: a folder is never just a folder on
 * screen — a card carries a `⋯` menu and a tree row carries one plus a rename field — and
 * Chromium starts a drag from the nearest draggable *ancestor* of whatever was pressed, so
 * without the guard a press on the menu plus five pixels of travel files the folder somewhere.
 * Fields are refused outright by `NOT_A_DRAG`, which is why a rename in progress is a text
 * selection rather than a drag.
 *
 * `folder` is read at `dragstart`, so a folder renamed or moved since it mounted carries what it
 * is now — which is the whole reason it is a callback, and what lets its current parent refuse a
 * nest that would move it nowhere.
 */
export function folderDraggable({
  element,
  folder,
}: {
  element: HTMLElement;
  folder: () => FolderDrag;
}): () => void {
  return composedDraggable({ element, data: () => folderDragData(folder()) });
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

/** The two fields of the library's `input` this module reads, named so the handlers below share
 *  one signature without either of them restating the adapter's whole payload type. */
interface PointerAt {
  clientX: number;
  clientY: number;
}

/**
 * Where a folder can be let go on this target, and whether it is armed to be — one hook answering
 * both, gated by one `canDrop`.
 *
 * **`useCollectionDropTarget`'s shape, and every one of its decisions holds here.** `armed` is
 * computed **per target**, through its own `monitorForElements` gated by its own `canDrop`,
 * because no two folders answer the same yes/no about the folder in the air — the one being
 * dragged refuses itself, its own parent refuses a nest that would move nothing, and a descendant
 * refuses one that would make a cycle. That is what raises the mark on **every** eligible folder
 * at once rather than only on the one under the pointer. `canDrop` and `onDrop` are read through
 * a ref rather than through either effect's deps, so a target does not tear itself down and
 * re-register every time the folder list changes under it. And `canDrop` is asked **again** on
 * the drop, because the two questions can be a second apart and only the second one writes.
 *
 * **What is new here is that the question has two arguments.** A folder does not simply take or
 * refuse a payload; it takes some of the three landings and refuses others, so:
 *
 * - the **monitor** asks the "any of the three" question, since at `dragstart` there is no
 *   pointer position yet and `armed` means "this folder could take it somehow";
 * - the **drop target's own `canDrop`** asks the same "any of the three" question, deliberately,
 *   and not the edge-sensitive one. A `canDrop` that answered `false` over the middle of a folder
 *   which only accepts a reorder would take the whole element out of the library's drop-target
 *   hierarchy at that moment: `onDrag` would stop firing at it, and the reported edge would
 *   freeze at whatever it last was instead of following the pointer out of the nest zone;
 * - `edge` is where the filtering happens instead. It is the edge a drop **would land on**, and
 *   it is `null` both when the pointer is not over this target and when it is over a part of it
 *   that would refuse. A surface draws its mark straight from it — no mark means no drop, which
 *   is the honest thing to show and the opposite of a line leading to a write that never happens.
 *
 * `edge` follows the pointer **within** one target, off `onDrag` rather than `onDragEnter` alone:
 * the whole gesture is that one folder means three different things at three heights, and a mark
 * that only updated on entry would be a mark that is right once per folder.
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

  useEffect(
    () =>
      monitorForElements({
        canMonitor: ({ source }) => {
          const drag = readFolderDrag(source.data, scope);
          return drag !== null && FOLDER_EDGES.some((at) => latest.current.canDrop(drag, at));
        },
        onDragStart: () => setArmed(true),
        // Fires for a cancelled drag as well as a completed one — the platform ends both the
        // same way — so the mark stands down on Escape without this hearing a keypress.
        //
        // `edge` deliberately does **not** stand down here as well, though the belt and braces
        // would be one line: the library clears its drop-target hierarchy *before* it publishes
        // the end of a drag, on the cancel path as much as on the drop, so the target's own
        // `onDragLeave` has already run by the time this fires. A second clear here would be a
        // line no test could ever reach — and an unreachable safety net is a claim about the
        // library that nothing checks.
        onDrop: () => setArmed(false),
      }),
    [scope],
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    /** The landing the pointer is currently asking for, or `null` if this target refuses it. */
    const landing = (drag: FolderDrag, input: PointerAt): FolderEdge | null => {
      const at = folderEdge(
        element.getBoundingClientRect(),
        { x: input.clientX, y: input.clientY },
        axis,
      );
      return latest.current.canDrop(drag, at) ? at : null;
    };
    const track = ({
      source,
      location,
    }: {
      source: { data: Record<string, unknown> };
      location: { current: { input: PointerAt } };
    }) => {
      const drag = readFolderDrag(source.data, scope);
      setEdge(drag === null ? null : landing(drag, location.current.input));
    };
    return dropTargetForElements({
      element,
      canDrop: ({ source }) => {
        const drag = readFolderDrag(source.data, scope);
        return drag !== null && FOLDER_EDGES.some((at) => latest.current.canDrop(drag, at));
      },
      onDragEnter: track,
      onDrag: track,
      onDragLeave: () => setEdge(null),
      onDrop: ({ source, location }) => {
        setEdge(null);
        const drag = readFolderDrag(source.data, scope);
        if (drag === null) return;
        // Measured from the drop's own input rather than read out of state: `setEdge` is a
        // render behind, and where the pointer was when the reader let go is the only honest
        // answer to where this lands.
        const at = landing(drag, location.current.input);
        if (at !== null) latest.current.onDrop(drag, at);
      },
    });
  }, [ref, scope, axis]);

  return { armed, edge };
}
