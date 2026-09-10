import { useEffect, useRef, useState, type RefObject } from "react";
import { Droppable, type DragEndEvent } from "@dnd-kit/dom";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { dndDraggable } from "@/lib/dndTarget";

/**
 * The gesture that rearranges the home page: a widget picked up and let go beside another one,
 * which lands it before or after that widget in the layout document.
 *
 * **`lib/folderDrag.ts` with one scope instead of three and no third landing.** That module is
 * the same shape — a mark under its own key, a source that registers an element, a hook that
 * answers `armed` and `edge` — and everything it does that this does not is something the home
 * page has no version of. There is no {@link FolderScope} because there is one home page and it
 * is never on screen beside a second one; there is no `inside` because **a widget cannot contain
 * a widget**, so a drop is always an insertion point and never a container taking the drag; and
 * there is no `axis`, because the widget grid is a wrapping flex row and the only question a
 * pointer can answer in it is which side of a card it is on.
 *
 * **Its own mark under its own key, read field by field.** `folderDrag.ts`'s rule for
 * `folderDrag.ts`'s reason: this is an edge with the drag library's untyped store, which every
 * draggable in the window writes into, and "it type-checked" means nothing at that edge. The key
 * is deliberately not `dnd.ts`'s `dragSource` and not `folderDrag.ts`'s `folderSource`, which
 * buys the refusal in both directions for free — the sidebar's folder tree is mounted beside this
 * page all day, so a folder carried over a widget finds no widget mark and a widget carried over
 * a folder card finds no folder mark, with neither target teaching the other a lesson.
 *
 * **The edge follows the pointer within one target, off `dragmove`.** `dragover` fires only when
 * the operation's *target changes*, so a mark driven by it is a mark that is right once per
 * widget — stuck on whichever half the pointer happened to enter through, for as long as the
 * pointer stays on that card. That is `useFolderDropTarget`'s note and it is the whole reason
 * both hooks listen to a per-move event they would otherwise not need.
 */

/**
 * Where a drop would land relative to the widget under the pointer.
 *
 * Two words rather than {@link FolderEdge}'s three: `inside` is a folder taking a folder, and
 * nothing on this page contains anything.
 */
export type WidgetEdge = "before" | "after";

/**
 * The mark that says a payload carries a home widget, and the two keys it travels under.
 *
 * A widget id is a string the layout document owns (`w1`, and whatever a future build writes),
 * so the payload is that one field beside the mark — there is no name, no parent and no scope,
 * because a reorder is decided entirely by *which* card was picked up and *where* it was let go.
 */
const WIDGET_MARK = "mtg-grimoire/home-widget-drag";
const MARK_KEY = "widgetSource";
const ID_KEY = "widgetId";

/** What a widget hands the adapter. Flat, so a reader gets what it needs without unwrapping
 *  anything — `folderDragData`'s shape, and `dragData`'s. */
export function widgetDragData(widgetId: string): Record<string, unknown> {
  return { [MARK_KEY]: WIDGET_MARK, [ID_KEY]: widgetId };
}

/**
 * The id a widget target may act on, or `null` for anything that is not a widget drag.
 *
 * **It takes `unknown` and refuses rather than throws**, which is where it parts from
 * {@link readFolderDrag}: that one is handed the library's own `data` record and can assume an
 * object, while this is also the function a page test and a story reach for with whatever they
 * happen to have. A `null`, an array, a number, a string and a function are each a payload that
 * is not a widget drag, and the honest answer to all five is the same one an unmarked record
 * gets.
 *
 * An empty id is refused with the malformed ones: `home.rs` will not store a blank `id`, so a
 * payload carrying one did not come from a layout this build wrote.
 */
export function readWidgetDrag(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  if (record[MARK_KEY] !== WIDGET_MARK) return null;
  const id = record[ID_KEY];
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * A widget card that can be picked up.
 *
 * **The whole body is {@link dndDraggable}**, which is `folderDraggable` with the folder taken
 * out and is exactly what is wanted here: the press guard is the library's
 * (`dndManager.ts` configures `PointerSensor.preventActivation` with the app's own `NOT_A_DRAG`
 * once, for every draggable in the window, which matters on a card carrying a `⋯` menu and a
 * remove button), the registration is `registerNow`'s rather than the microtask dnd-kit would
 * have queued, and the element wears `DND_SOURCE_ATTR` so a test can tell a live source from an
 * element somebody once registered.
 *
 * The record is still a callback because that is the contract — read as the drag begins — even
 * though a widget's id is the one thing about it that never changes while it is mounted.
 */
export function widgetDraggable({
  element,
  widgetId,
}: {
  element: HTMLElement;
  widgetId: string;
}): () => void {
  return dndDraggable({ element, data: () => widgetDragData(widgetId) });
}

/**
 * Which side of a widget a point is on. Pure arithmetic over a rect the caller passes in.
 *
 * **The axis is horizontal because the grid is a wrapping flex row.** Widgets are laid out
 * left to right and wrap onto the next line, so "before this card" and "after this card" are its
 * leading and trailing *sides* — the vertical question a sidebar tree asks has no meaning here,
 * and `y` is therefore not read at all. A pointer above or below a card is still on one side of
 * it.
 *
 * **The midpoint belongs to `after`, and that is written down because both answers are
 * plausible.** A `<` and a `<=` are the same code to read and a different promise to keep, so the
 * comparison is stated here and pinned in `homeDrag.test.ts` rather than left to whichever one
 * somebody types next. There is no third landing to fall back on, so a **zero-width box answers
 * `after` by the same rule** — jsdom measures every rect as four zeroes, which is why
 * `folderEdge` special-cases a box with no length and why the page test supplies a rect on every
 * element the hit-test touches instead of relying on one.
 *
 * A point outside the box answers by the side it is past, which is what a sticky drop target and
 * the library's honey-pot element both need: the pointer is legitimately a pixel or two outside
 * the element the drop is still being counted against.
 *
 * **Pure over a rect rather than folded into the hook**, for `folderEdge`'s reason: jsdom has no
 * layout engine, so a component test of a rendered widget would pass over any arithmetic at all.
 * This is tested as arithmetic; the hook below is exercised by the page's own drag test.
 */
export function widgetEdge(rect: DOMRect, at: { x: number; y: number }): WidgetEdge {
  return at.x < rect.left + rect.width / 2 ? "before" : "after";
}

/** The manager's view of a drag in flight, named once so the handlers below share a signature.
 *  dnd-kit spells it as the shape hanging off every drag event rather than as an exported type,
 *  so it is read off the one event that carries every field — `useFolderDropTarget`'s note. */
type DragOperation = DragEndEvent["operation"];

/**
 * Where a dragged widget would land on this one, and whether this one is armed to take it.
 *
 * **`useFolderDropTarget`'s shape with the policy folded in.** That hook takes a `canDrop`
 * because three cabinets, two axes and a nesting rule mean no two folders answer the same
 * question about the folder in the air. Every widget on this page answers the same one, and it
 * has a single clause: **a widget refuses itself**. Dropping a card before or after where it
 * already is is a write that moves nothing, and a mark promising it is a mark leading nowhere —
 * so the dragged card draws none, which is also what stops it winning the pointer against the
 * card underneath it.
 *
 * `armed` is computed per target off the manager's own `dragstart`, so **every** other widget
 * raises its mark the moment the drag begins rather than only the one under the pointer — the
 * affordance the gesture would otherwise not have until it was nearly over. `onDrop` is read
 * through a ref rather than through the effect's deps, so a target does not tear itself down and
 * re-register every time the layout answers.
 *
 * `edge` is where the filtering happens: it is the side a drop **would land on**, and it is
 * `null` both when the pointer is not over this widget and when the widget would refuse the drag.
 * A card draws its line straight from it, so no mark means no drop.
 *
 * Where the pointer is comes from `operation.position.current`, read at the moment of the event
 * rather than from `edge`: `setEdge` is a render behind, and where the pointer was when the
 * reader let go is the only honest answer to where the drop lands. Both marks stand down in the
 * end handler, which fires for a cancelled drag as well as a completed one — so Escape clears
 * them without this hearing a keypress.
 */
export function useWidgetDropTarget({
  ref,
  widgetId,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  /** This target's own id — the one payload it refuses. */
  widgetId: string;
  onDrop: (dragged: string, edge: WidgetEdge) => void;
}): { armed: boolean; edge: WidgetEdge | null } {
  const [armed, setArmed] = useState(false);
  const [edge, setEdge] = useState<WidgetEdge | null>(null);
  const latest = useRef(onDrop);
  useEffect(() => {
    latest.current = onDrop;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    /** The id this target may act on, or `null` for anything it is blind to — a payload that is
     *  not a widget drag, and this widget's own. */
    const read = (source: { data: Record<string, unknown> } | null | undefined): string | null => {
      const dragged = source ? readWidgetDrag(source.data) : null;
      return dragged !== null && dragged !== widgetId ? dragged : null;
    };

    const droppable = new Droppable(
      {
        id: dndId("home-widget-target"),
        element,
        // `register: false` and a registration of our own — see {@link registerNow}.
        register: false,
        // Asked once per collision pass rather than at registration, which is what lets it read
        // the live `widgetId` through the effect it was created in.
        accept: (source) => read(source) !== null,
      },
      dndManager,
    );
    registerNow(droppable);

    const track = (operation: DragOperation) => {
      if (read(operation.source) === null || operation.target !== droppable) {
        setEdge(null);
        return;
      }
      setEdge(widgetEdge(element.getBoundingClientRect(), operation.position.current));
    };

    const off = [
      dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
        setArmed(read(operation.source) !== null);
      }),
      // The edge follows the pointer *within* one card, which `dragover` alone cannot do: it
      // fires when the operation's target changes, so the mark would stick on whichever half the
      // pointer first crossed. Both are listened to — `dragover` is what answers the moment a
      // card becomes the target, `dragmove` every moment after.
      dndManager.monitor.addEventListener("dragmove", ({ operation }) => track(operation)),
      dndManager.monitor.addEventListener("dragover", ({ operation }) => track(operation)),
      dndManager.monitor.addEventListener("dragend", ({ operation, canceled }) => {
        setArmed(false);
        setEdge(null);
        if (canceled || operation.target !== droppable) return;
        const dragged = read(operation.source);
        if (dragged === null) return;
        latest.current(
          dragged,
          widgetEdge(element.getBoundingClientRect(), operation.position.current),
        );
      }),
    ];

    return () => {
      for (const stop of off) stop();
      droppable.destroy();
    };
  }, [ref, widgetId]);

  return { armed, edge };
}
