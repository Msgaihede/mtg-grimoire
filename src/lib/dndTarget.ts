import { useEffect, useRef, useState, type RefObject } from "react";
import { Draggable, Droppable } from "@dnd-kit/dom";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";

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
  collisionPriority,
}: {
  ref: RefObject<HTMLElement | null>;
  /** This feature's payload out of the library's untyped store, or `null` for everything else. */
  read: (data: Record<string, unknown>) => T | null;
  canDrop: (drop: T) => boolean;
  onDrop: (drop: T) => void;
  /**
   * Higher wins a tie with an overlapping target — and an overlay needs one.
   *
   * **dnd-kit resolves overlap by geometry, not by paint order**, which is the one habit
   * pragmatic-dnd left behind. `defaultCollisionDetection` is `pointerIntersection` falling back
   * to `shapeIntersection`, and `pointerIntersection` scores a hit as `1 / distance` from the
   * droppable's **centre** — so a small bar sitting on top of a tall pile does not reliably win,
   * and `z-index` is not consulted at all. `computeCollisions` overrides the detector's own
   * priority with this when it is set, and `sortCollisions` sorts by priority first. The quick
   * zones and the remove tray pass `CollisionPriority.Highest`; nothing else passes anything.
   */
  collisionPriority?: number;
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
        ...(collisionPriority === undefined ? {} : { collisionPriority }),
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
  }, [ref, collisionPriority]);

  return { armed, over };
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
 * An element that can be picked up, carrying whatever record its caller writes.
 *
 * **`folderDraggable`'s body with the folder taken out**, and every decision in it is that
 * function's, kept: the record is read at the **press** rather than at registration, so a row
 * renumbered, renamed or re-filed since it mounted carries what it is now; dnd-kit's `data` is a
 * settable accessor rather than a callback the library calls, so the refresh hangs off a
 * capture-phase `pointerdown` on the element, which is the phase a control that stops the press
 * from propagating cannot hide from; and a press always precedes a drag, so there is no gesture
 * this can miss.
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
      data: data(),
      // `register: false` and a registration of our own — see {@link registerNow}.
      register: false,
      ...(handle === undefined ? {} : { handle }),
      ...(sensors === undefined ? {} : { sensors }),
    },
    dndManager,
  );
  registerNow(draggable);
  const refresh = () => {
    draggable.data = data();
  };
  element.addEventListener("pointerdown", refresh, true);
  return () => {
    element.removeEventListener("pointerdown", refresh, true);
    draggable.destroy();
  };
}
