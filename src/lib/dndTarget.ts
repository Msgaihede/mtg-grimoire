import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { CollisionPriority } from "@dnd-kit/abstract";
import { pointerIntersection } from "@dnd-kit/collision";
import { Draggable, Droppable } from "@dnd-kit/dom";
import { carryAtDragStart, dndId, dndManager, registerNow } from "@/lib/dndManager";

/**
 * The drop-target effect this app writes eight times, written once.
 *
 * **Every registration in the app answers the same two questions and one of them is not about
 * the pointer.** `armed` is "a payload this target could take is in the air", raised on **every**
 * eligible target the moment the drag starts rather than only on the one under the pointer —
 * without it a card picked up in a fifteen-pile deck lights nothing until the reader happens to
 * cross a target, so the gesture has no affordance until it is nearly over. `over` is the second,
 * narrower fact, and only the target the pointer is actually on can answer it.
 *
 * **`read` and `canDrop` are two arguments rather than one predicate**, because they are two
 * different kinds of thing and the split is what keeps this generic. `read` is the app's boundary
 * with an untyped store every draggable in the window writes into — `readDragData`,
 * `readCollectionDrop`, `readDeckDrag`, `readCategoryDrag` are each a field-by-field check that
 * this payload is *this feature's* — and `canDrop` is policy the surface supplies, which is a
 * question about the target rather than about the drag.
 *
 * **Read through a ref rather than through the effect's deps.** A target that listed `canDrop` and
 * `onDrop` as dependencies would tear itself down and register again every time the folder list,
 * the deck list or the collection list answered — including in the middle of the drag those
 * answers are arriving because of. `pdnd`'s hooks did the same and for the same reason.
 *
 * **`canDrop` is asked again on the drop.** The two askings can be a second apart and only the
 * second one is in front of a write.
 *
 * **`armed` is computed at `dragstart` and not recomputed.** dnd-kit publishes no event for "the
 * answer to a question you asked at the start has changed", and neither did pragmatic-dnd — so
 * this is the behaviour the app has shipped since folders landed, stated rather than inherited.
 * `canDrop`'s second asking on the drop is what stops a stale `armed` from reaching a write.
 */
export function useDndDropTarget<T>({
  ref,
  read,
  canDrop,
  onDrop,
  overlay,
}: {
  ref: RefObject<HTMLElement | null>;
  /** This feature's payload out of the library's untyped store, or `null` for everything else. */
  read: (data: Record<string, unknown>) => T | null;
  canDrop: (drop: T) => boolean;
  onDrop: (drop: T) => void;
  /**
   * An overlay: this target wins the pointer against whatever it is drawn over, **and only when
   * the pointer is actually inside it**.
   *
   * **dnd-kit resolves overlap by geometry, not by paint order**, which is the one habit
   * pragmatic-dnd left behind: that library hit-tested with `event.target`, so a bar painted over
   * a pile won by being on top. Here `z-index` is not consulted at all, and a small bar over a
   * tall pile does not reliably win on `1 / distance-to-centre`. So an overlay needs
   * `CollisionPriority.Highest`, which `computeCollisions` puts on the collision and
   * `sortCollisions` sorts by first.
   *
   * **Priority alone is a defect, and it took the shipped window to find it.** The default
   * detector is `pointerIntersection(args) ?? shapeIntersection(args)`, and the fallback compares
   * the **dragged element's whole rectangle** against the droppable's. A deck card is 293px tall
   * and the quick-zone bar is 74px at the top of the editor, so a card dropped anywhere in the
   * top third of the desk overlaps the bar by *shape* while the pointer is nowhere near it —
   * and the priority then makes the bar beat the pile the pointer is genuinely inside. Measured
   * 2026-08-28 in a `tauri dev` window at 1920×1080: a card released at `(810, 246)`, 51px below
   * a bar occupying `y 121–195` and squarely inside the Removal pile, opened the **New category**
   * dialog.
   *
   * `pointerIntersection` as the detector is the fix and it is the narrower statement of what was
   * meant all along: an overlay produces **no collision at all** unless the pointer is inside it,
   * and wins outright when it is. Nothing else in the app passes this, so nothing else changes.
   */
  overlay?: boolean;
}): { armed: boolean; over: boolean } {
  const [armed, setArmed] = useState(false);
  const [over, setOver] = useState(false);
  const latest = useRef({ read, canDrop, onDrop });
  useEffect(() => {
    latest.current = { read, canDrop, onDrop };
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    /** The payload this target would act on, or `null` — both questions at once, because every
     *  caller below asks them together and asking them apart is how they drift. */
    const taken = (source: { data: Record<string, unknown> } | null | undefined): T | null => {
      if (!source) return null;
      const drop = latest.current.read(source.data);
      return drop !== null && latest.current.canDrop(drop) ? drop : null;
    };

    const droppable = new Droppable(
      {
        id: dndId("drop"),
        element,
        // `register: false` and a registration of our own — see {@link registerNow}.
        register: false,
        // Asked once per collision pass rather than at registration, which is what lets it read
        // live state through the ref above.
        accept: (source) => taken(source) !== null,
        ...(overlay
          ? { collisionDetector: pointerIntersection, collisionPriority: CollisionPriority.Highest }
          : {}),
      },
      dndManager,
    );
    registerNow(droppable);

    const off = [
      dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
        setArmed(taken(operation.source) !== null);
      }),
      // `dragover` fires whenever the operation's **target changes**, including to `null` —
      // `DragActions.setDropTarget` dispatches it on every change while the status is `dragging`.
      // That is the whole of what `over` is, so this hook does not listen to `dragmove` and does
      // not re-render on every pointer move the way `useFolderDropTarget` has to.
      dndManager.monitor.addEventListener("dragover", ({ operation }) => {
        setOver(operation.target === droppable && taken(operation.source) !== null);
      }),
      // Fires for a cancelled drag as well as a completed one — the library ends both the same
      // way — so both marks stand down on Escape without this hearing a keypress.
      dndManager.monitor.addEventListener("dragend", ({ operation, canceled }) => {
        setArmed(false);
        setOver(false);
        if (canceled || operation.target !== droppable) return;
        const drop = taken(operation.source);
        if (drop !== null) latest.current.onDrop(drop);
      }),
    ];

    return () => {
      for (const stop of off) stop();
      droppable.destroy();
    };
  }, [ref, overlay]);

  return { armed, over };
}

/**
 * An element that arrives through a **callback ref**, in the shape {@link useDndDropTarget} reads.
 *
 * **Why a target cannot always just hand over a `useRef`.** That hook reads `ref.current` once, in
 * an effect keyed on the ref *object* — which is right for a target whose element is rendered by
 * the same component, because React attaches refs during the commit and effects run after it. It
 * is wrong for the three targets whose element does not exist at mount: a hook that hands its
 * caller an `attach` callback (`useCategoryDrop`, `useCategoryReorderDrop`), a box drawn only for
 * the length of a drag (the remove tray), and any element React swaps out under a live
 * registration. In all three the effect would have run against `null` and never run again.
 *
 * So the element is **state**: a new object identity when it arrives, which is what re-runs the
 * effect. It costs one extra render at mount, which is when there is nothing to re-render.
 *
 * `attach` returns a cleanup, which React 19 calls **instead of** invoking the callback with
 * `null` — so a caller chaining it with another registration chains the cleanups too.
 */
export function useDndTargetRef(): {
  ref: RefObject<HTMLElement | null>;
  attach: (element: HTMLElement | null) => () => void;
} {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const ref = useMemo(() => ({ current: element }), [element]);
  const attach = useCallback((next: HTMLElement | null) => {
    setElement(next);
    return () => setElement(null);
  }, []);
  return { ref, attach };
}

/**
 * What is in the air anywhere in the window, as this feature reads it — or `null`.
 *
 * The **payload** rather than a bare boolean, because every caller needs it: the sidebar draws a
 * ring only for a card it could take, the quick-zone bar is drawn *from* the card it is offering
 * destinations for, and a folder the deck is already in must not light up. A boolean would light
 * everything and then refuse the one the reader aimed at.
 *
 * No `canDrop` here on purpose: this is a window-wide fact, and a hook that mixed it with a
 * target's own policy would be {@link useDndDropTarget} with the target left out.
 */
export function useDndDragging<T>(read: (data: Record<string, unknown>) => T | null): T | null {
  const [drag, setDrag] = useState<T | null>(null);
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });

  useEffect(() => {
    const off = [
      dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
        setDrag(operation.source ? latest.current(operation.source.data) : null);
      }),
      dndManager.monitor.addEventListener("dragend", () => setDrag(null)),
    ];
    return () => {
      for (const stop of off) stop();
    };
  }, []);

  return drag;
}

/**
 * The mark a registered drag source carries, so a test, a story or a live probe can find one.
 *
 * **It replaces `draggable="true"`, which is what pragmatic-dnd set and what a dozen selectors in
 * this repo read — and it may not be spelled that way.** `PointerSensor.handlePointerDown`
 * computes `isNativeDraggable` from exactly that attribute and **stands down** for a press on one,
 * leaving the gesture to the platform's own HTML5 drag; writing it back would turn every drag in
 * the app off while every one of those selectors went on passing.
 *
 * It is set on registration and removed on teardown, so it says "this element is a live drag
 * source" rather than "somebody once registered here" — which is the whole of what the old
 * attribute meant and the reason a test can tell a wall that drags from one that does not.
 */
export const DND_SOURCE_ATTR = "data-dnd-source";

/**
 * An element that can be picked up, carrying whatever record its caller writes.
 *
 * **`folderDraggable`'s body with the folder taken out**, and one decision changed: the record is
 * read **as the drag begins**, not at registration and not at the press. A row renumbered,
 * renamed or re-filed since it mounted therefore carries what it is now — which is the whole
 * reason `data` is a callback — and dnd-kit's `data` is a settable accessor rather than something
 * the library asks for, so `dndManager.ts`'s `carryAtDragStart` sets it from one `beforedragstart`
 * listener for the whole window.
 *
 * **`beforedragstart` and not `pointerdown`, and the difference is a measured bug.** `data` is not
 * always a pure read: a card wall's is `dragData(payload(), rest())`, and `rest` goes through
 * `useCardSelection.dragsAll`, which **throws the picked set away** when the drag starts outside
 * it. Refreshed on every press, a plain click on an unpicked tile cleared the reader's selection
 * *before* the click that was meant to extend it — measured in `CardGrid.test.tsx`, where a
 * Ctrl-click after a plain one came back holding one card instead of two. Refreshed at
 * registration it was worse: a re-render of the wall did it. `pdnd` asked for the record at
 * `dragstart` and nowhere else, and this is that timing, kept.
 *
 * **There is no `canDrag` and no `mousedown` guard here, and that is a removal rather than an
 * omission.** `lib/dndManager.ts` configures `PointerSensor.preventActivation` with the app's own
 * `NOT_A_DRAG` selector, once, for every draggable in the window — which is what
 * `composedDraggable`'s capture-phase guard was, said to the library instead of per registration.
 *
 * `handle` is for the two sources where a press may only start in one place — a category's grip.
 * dnd-kit binds its pointer listener to `source.handle ?? source.element`, so a handle is a
 * narrower *listener* rather than a check run after the fact. **A handle also switches the default
 * activation constraints off** — `PointerSensor.defaults.activationConstraints` returns
 * `undefined` for a mouse press inside a declared handle, so the drag would begin on
 * `pointerdown` and a plain click on the grip would be a zero-pixel drag. A `handle` caller
 * therefore passes its own `sensors`.
 */
export function dndDraggable({
  element,
  data,
  handle,
  sensors,
}: {
  element: HTMLElement;
  /** Read at the press, not at registration. */
  data: () => Record<string, unknown>;
  /** The only place a press may start a drag, when the whole element is not it. */
  handle?: Element;
  /** Per-source sensor configuration, for a caller that needs to say what a handle press costs. */
  sensors?: ConstructorParameters<typeof Draggable>[0]["sensors"];
}): () => void {
  const draggable = new Draggable(
    {
      id: dndId("drag"),
      element,
      // Empty until the drag begins — see above. Never the record a drag carries.
      data: {},
      // `register: false` and a registration of our own — see {@link registerNow}.
      register: false,
      ...(handle === undefined ? {} : { handle }),
      ...(sensors === undefined ? {} : { sensors }),
    },
    dndManager,
  );
  registerNow(draggable);
  const forget = carryAtDragStart(draggable, data);
  element.setAttribute(DND_SOURCE_ATTR, "");
  return () => {
    forget();
    element.removeAttribute(DND_SOURCE_ATTR);
    draggable.destroy();
  };
}
