import { act, fireEvent } from "@testing-library/react";
import { afterEach } from "vitest";

/**
 * A native HTML5 drag, driven from a test.
 *
 * **Why this is possible at all.** jsdom implements no drag-and-drop: there is no
 * `DragEvent`, no `DataTransfer`, and every rectangle it measures is zero. The usual
 * conclusion — that a drag can only be verified in a real window — is wrong for the library
 * this app drags with. `@atlaskit/pragmatic-drag-and-drop` hit-tests with `event.target` and
 * `Element.closest`, never with `elementFromPoint`, and it listens for the platform's own
 * `dragstart`/`dragenter`/`dragover`/`drop`/`dragend` on `document` and `window`. All three
 * of those jsdom has. What it is missing is one object — the `DataTransfer` the platform
 * hangs on a drag event — and the drag events themselves, which are `MouseEvent`s with that
 * object attached. Both are below.
 *
 * So a drop target's `canDrop`, its `getData`, the payload a `draggable` put in and the
 * handler the drop runs are all reachable from the suite, over the library's real code path.
 * What is **not** reachable, and is therefore still the live CDP pass's to prove: the
 * platform's own drag preview, the pointer-driven hit-testing that decides which element a
 * `dragover` lands on, auto-scrolling (it measures rectangles), and Escape — the browser
 * cancels a drag itself and jsdom has no drag to cancel.
 *
 * Every drag started here must be finished (`drop` or `cancel`): the library keeps one
 * global "a drag is active" flag, and a test that walks away holding a card would leave the
 * next one unable to pick one up.
 */

/**
 * Whatever is still in the air, let go of.
 *
 * The library keeps one global "a drag is active" flag, so a test that fails half way through
 * a drag would leave every later test in the file unable to pick anything up — one broken
 * assertion reading as five, in tests that never mention dragging. `dragend` at the `window`
 * is how the platform ends a drag that was not dropped, and it is inert when there is nothing
 * to end. Registered on import, so a file that drags is a file that cleans up after itself.
 */
afterEach(() => {
  fireEvent(window, new MouseEvent("dragend", { bubbles: true }));
});

/**
 * The platform's drag clipboard, in the only shape this app's drags need: the library writes
 * a media type into it so that other windows see *something*, and reads nothing back.
 *
 * The app's own payload never travels in here — it lives in the library's own store, keyed
 * off the `draggable`'s `getInitialData`, which is why `dnd.ts`'s contract is a JS object and
 * not a serialized string.
 */
class TestDataTransfer {
  private store = new Map<string, string>();
  effectAllowed = "uninitialized";
  dropEffect = "none";
  get types(): string[] {
    return [...this.store.keys()];
  }
  setData(format: string, data: string): void {
    this.store.set(format, data);
  }
  getData(format: string): string {
    return this.store.get(format) ?? "";
  }
  clearData(): void {
    this.store.clear();
  }
  /** The native drag preview, which is a screenshot in a real browser and nothing here. */
  setDragImage(): void {}
  items = { add: () => {} };
}

/** One frame, so the library's `requestAnimationFrame`-scheduled `onDragStart` lands inside
 *  `act` rather than after the test has moved on. */
async function frame(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

/**
 * A drag event: a `MouseEvent` with a `dataTransfer`, which is what the platform's really is.
 * `fireEvent` rather than `dispatchEvent` so React's updates are flushed in `act`.
 *
 * Answers whether the event was cancelled, which is how a refused `dragstart` is told from
 * one that started a drag.
 */
function send(target: Element | Window, type: string, dataTransfer: TestDataTransfer): boolean {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 8, clientY: 8 });
  // `dataTransfer` is not a `MouseEvent` field, and it is read-only where it does exist.
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  return fireEvent(target, event);
}

/**
 * One drag event, for a test that is not driving a whole gesture — a component that listens
 * for `dragstart` and has a single assertion about what it did.
 *
 * Worth having rather than a bare `fireEvent.dragStart`: the library listens for that event on
 * `document` too, finds no `dataTransfer` on it, and prints *"It appears as though you have are
 * not testing DragEvents correctly"* to stderr — a warning about the test rather than about the
 * app, in a suite whose console is meant to stay quiet. This sends the same object the gestures
 * above send, so the library takes the event as the platform's.
 *
 * A test using this still ends whatever it started: the `afterEach` at the top of this module
 * lets go at `window`, which is why it lives here rather than in the one test that wants it.
 */
export function fireDragEvent(target: Element, type: string): boolean {
  return send(target, type, new TestDataTransfer());
}

/** A drag in flight: what a test can do while it is holding the card. */
export interface Drag {
  /**
   * Whether a drag actually began.
   *
   * `false` when something refused it — which in this app means the press landed on one of
   * the card's own controls (`cardDraggable`). The library refuses by calling
   * `preventDefault()` on the `dragstart`, which is what this reads, and everything below is
   * then inert.
   */
  started: boolean;
  /** Move over an element — a drop target, or something that is not one. */
  over(target: Element): Promise<void>;
  /** Off every drop target, without letting go. */
  leave(): Promise<void>;
  /** Let go, where the drag last was. */
  drop(): Promise<void>;
  /** The way a real drag ends when the reader presses Escape or drops on nothing: the
   *  platform fires `dragend` at the source and no `drop` anywhere. */
  cancel(): Promise<void>;
}

/**
 * Pick an element up.
 *
 * The element must be the one a `draggable()` was registered on — the platform fires
 * `dragstart` at the nearest draggable ancestor, and the library looks the element up
 * directly rather than searching upwards, so a test that starts a drag on a child of a row is
 * testing nothing.
 *
 * `pressOn` is where the press landed, which is **not** the same thing and is exactly the
 * case that bites: pressing a control inside a draggable row gets a `mousedown` at the
 * control and a `dragstart` at the row, because Chromium starts the drag from the nearest
 * draggable *ancestor* of what was pressed. Verified in the running window, 2026-08-05:
 * `mousedown` on a stepper's `−`, `dragstart` on the `<li>`, no click ever delivered.
 */
export async function startDrag(
  source: Element,
  { pressOn = source }: { pressOn?: Element } = {},
): Promise<Drag> {
  const data = new TestDataTransfer();
  let at: Element = source;
  send(pressOn, "mousedown", data);
  const started = send(source, "dragstart", data);
  // `onDragStart` is dispatched a frame later — the library batches it with the drag preview.
  await frame();

  const over = async (target: Element) => {
    at = target;
    send(target, "dragenter", data);
    send(target, "dragover", data);
    await frame();
  };
  return {
    started,
    over,
    leave: () => over(document.body),
    drop: async () => {
      send(at, "drop", data);
      send(source, "dragend", data);
      await frame();
    },
    cancel: async () => {
      send(source, "dragend", data);
      await frame();
    },
  };
}

/** The whole gesture, for a test that is about where a card landed rather than about what
 *  happened on the way. */
export async function dragOnto(source: Element, target: Element): Promise<void> {
  const held = await startDrag(source);
  await held.over(target);
  await held.drop();
}

/**
 * A pointer-driven drag, for `@dnd-kit/react`.
 *
 * **Why this exists beside the HTML5 helpers above.** Those work because pragmatic-dnd
 * hit-tests with `event.target` and `Element.closest`. dnd-kit is pointer-based and hit-tests
 * by **coordinate** — and jsdom measures every rectangle as zero, so a test that needs a
 * pointer to be *over* something has to give both elements a real `getBoundingClientRect`.
 * This helper reads the rects it is given; supplying them is the caller's job, and a test that
 * forgets will see a drag that lands nowhere.
 *
 * **Giving the two elements rects is necessary and not sufficient**, which is the part that
 * costs a session. `getVisibleBoundingRectangle` clamps an element against every ancestor whose
 * `isOverflowVisible` is false, and that predicate reads
 * `overflow === "visible" && overflowX === "visible" && overflowY === "visible"` while jsdom's
 * computed `overflow` on `<body>` is the **empty string** — so `<body>` counts as a clipping
 * ancestor, its own rect is `0×0`, and a target measured at `y 200–240` comes back with zero
 * area. A zero-area element is invisible, an invisible droppable never gets a shape, and a
 * droppable with no shape can never be collided with: registration is correct, `accepts()`
 * answers true, and `operation.target` is `null` on every frame. Every ancestor between a target
 * and the document therefore needs a rect too. The full reading, including the four jsdom
 * globals dnd-kit needs and the `collisionObserver.forceUpdate()` a drop needs, is in
 * `docs/reference/frontend-design.md`.
 *
 * **The gesture ends with the destination repeated.** `dragOperation.position.current` lags one
 * `pointermove` behind, because the sensor batches its moves through its own scheduler — so a
 * drag that stops the instant it arrives has never been over the target as far as dnd-kit is
 * concerned. Measured 2026-08-27: with a single move to the destination the pointer's last
 * reported position was the *previous* step's, and the drop landed nowhere.
 */
export async function pointerDrag(
  from: HTMLElement,
  to: HTMLElement,
  opts: { steps?: number } = {},
): Promise<void> {
  const steps = Math.max(2, opts.steps ?? 8);
  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const start = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
  const end = { x: b.left + b.width / 2, y: b.top + b.height / 2 };

  const fire = (type: string, at: { x: number; y: number }, target: EventTarget) => {
    const e = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: at.x,
      clientY: at.y,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    });
    target.dispatchEvent(e);
  };

  await act(async () => {
    fire("pointerdown", start, from);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      fire(
        "pointermove",
        { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t },
        document,
      );
      // A frame between moves: dnd-kit schedules its collision work, and a burst of moves in
      // one tick is not the gesture a person makes.
      await frame();
    }
    // The settle. See the paragraph above — one repeat is what the sensor's one-move lag costs,
    // and the second is what makes the reading stable rather than exactly on the edge.
    fire("pointermove", end, document);
    await frame();
    fire("pointermove", end, document);
    await frame();
    fire("pointerup", end, document);
  });
}
