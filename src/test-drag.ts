import { act, fireEvent } from "@testing-library/react";
import { dndManager } from "@/lib/dndManager";
import { afterEach } from "vitest";

/**
 * A native HTML5 drag, driven from a test.
 *
 * **Nothing calls any of this any more, and it is kept for exactly one more plan.** Every drag in
 * the app is `@dnd-kit/dom`'s since 3b, so `startDrag`, `dragOnto` and `fireDragEvent` have zero
 * call sites — `grep` says so — and the two `package.json` lines that keep
 * `@atlaskit/pragmatic-drag-and-drop` installed are what still make this file compile. 3c takes
 * the dependency and this half of the harness out together; taking it out here would be a
 * `package.json` change inside a commit about drag payloads. What is live below is
 * {@link startPointerDrag}, {@link pointerDrag}, {@link boxed} and {@link recordDrags}.
 *
 * **Why this was possible at all.** jsdom implements no drag-and-drop: there is no
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
  // The same care for the other library, which keeps the same kind of global: dnd-kit's manager
  // has one drag operation, and a test that walks away mid-gesture leaves the next one unable to
  // start (`handlePointerDown` returns early unless the operation is idle). Escape at the body is
  // where its `PointerSensor` listens for a cancel, and it is inert when nothing is in flight.
  if (!dndManager.dragOperation.status.idle) {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  }
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
 * A pointer-driven drag, for `@dnd-kit/dom`.
 *
 * **Why this exists beside the HTML5 helpers above.** Those work because pragmatic-dnd
 * hit-tests with `event.target` and `Element.closest`. dnd-kit is pointer-based and hit-tests
 * by **coordinate** — and jsdom measures every rectangle as zero, so a test that needs a pointer
 * to be *over* something has to give the elements it cares about a real
 * `getBoundingClientRect`. These helpers read the rects they are given; supplying them is the
 * caller's job, and a test that forgets will see a drag that lands nowhere.
 *
 * **Giving the two elements rects is necessary and not sufficient.** dnd-kit clamps an element's
 * visible rectangle against every ancestor whose overflow is not `visible`, and jsdom's computed
 * `overflow` on `<body>` is the empty string — so the document itself used to erase every
 * measurement. `test-setup.ts` gives `<body>` the viewport for that reason; **a scrolling box
 * between a target and the body still needs a rect of its own**, or the target inside it has zero
 * area, never gets a shape, and can never be collided with. That failure is silent: registration
 * is correct, the droppable accepts the payload, and the operation's target is `null` on every
 * frame.
 *
 * The whole reading — the four jsdom globals, the ancestor clamp, and the collision pass no shim
 * can schedule — is in `docs/reference/frontend-design.md`.
 */

/**
 * Every record a drag puts in the air, for a test that is about what a source **carries** rather
 * than about where it lands.
 *
 * The replacement for `monitorForElements({ onDragStart })`, which nine suites used for exactly
 * this. `dndManager` is a module singleton with one monitor, so a test that leaves this up leaks
 * a listener into the rest of the file — hence the `stop`, which every caller must run.
 */
export function recordDrags(): { records: Record<string, unknown>[]; stop: () => void } {
  const records: Record<string, unknown>[] = [];
  const stop = dndManager.monitor.addEventListener("dragstart", ({ operation }) => {
    if (operation.source) records.push(operation.source.data);
  });
  return { records, stop };
}

/**
 * Give an element a box.
 *
 * **jsdom has no layout engine, so every `getBoundingClientRect` in the suite is four zeroes** —
 * and dnd-kit hit-tests by coordinate. A source with no box has nowhere to be pressed and a target
 * with no box can never be collided with, and both failures are silent: the registration is
 * correct, the droppable accepts the payload, and `operation.target` is `null` on every frame.
 *
 * The x axis is fixed at 0–200 because no gesture in this app's tests is about horizontal
 * position; `top` and `height` are what a caller varies, so two boxes can be made to overlap or to
 * sit clear of each other.
 */
export function boxed<T extends Element>(element: T, top: number, height = 40): T {
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

/** A pointer drag in flight: what a test can do while it is holding the folder. */
export interface PointerHeld {
  /** Whether the gesture actually became a drag. `false` after a press the sensor refused —
   *  which is what a press on a `data-no-drag` control is meant to be. */
  readonly started: boolean;
  /** Move the pointer to a point in the viewport. */
  moveTo(x: number, y: number): Promise<void>;
  /**
   * Move the pointer over an element, at a fraction along each of its axes — `0.5, 0.5` is the
   * centre, `{ y: 0.1 }` is the top tenth of it.
   *
   * A fraction rather than a pixel because that is what the thing under test is a function of:
   * `folderEdge` splits a box into quarters whatever its size, so a test says *which zone* and
   * stays readable when the box changes.
   */
  over(element: Element, at?: { x?: number; y?: number }): Promise<void>;
  /** Carry the folder off every target without letting go. */
  leave(): Promise<void>;
  /** Let go where the pointer is. */
  drop(): Promise<void>;
  /** Escape — the same key a reader presses, delivered where the sensor listens for it. */
  cancel(): Promise<void>;
}

/** Somewhere no target is. Far enough out that the dragged element's own translated box cannot
 *  intersect anything either, which is the second half of dnd-kit's default collision test. */
const NOWHERE = { x: 10_000, y: 10_000 };

function centre(element: Element, at: { x?: number; y?: number } = {}) {
  const box = element.getBoundingClientRect();
  return {
    x: box.left + box.width * (at.x ?? 0.5),
    y: box.top + box.height * (at.y ?? 0.5),
  };
}

function fire(type: string, at: { x: number; y: number }, target: EventTarget): void {
  target.dispatchEvent(
    new PointerEvent(type, {
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
    }),
  );
}

/**
 * Let the manager see where the pointer is.
 *
 * **The collision pass jsdom cannot schedule.** dnd-kit recomputes collisions from a reactive
 * effect its `Feedback` plugin drives as it moves the drag preview — and `Feedback` is exactly
 * the WAAPI machinery jsdom does not have, so the effect never re-runs. Measured 2026-08-27: the
 * droppable has a correct shape and `shape.containsPoint(position.current)` is true at the
 * release point, while `operation.target` stays `null` on every frame and `collision` fires only
 * twice — at the start of the drag and at the end. Without this a pointer drag proves the gesture
 * and never the drop.
 */
async function settle(): Promise<void> {
  // **Twice, because the operation's target follows the collisions one hop behind.** The
  // observer's own reaction disables it, calls `setDropTarget`, and re-enables it on the promise
  // that resolves — so the pass that *changes* which droppable is first is not the pass that
  // moves the target onto it. Measured on the quick-zone-over-a-pile case: after one pass the
  // collisions were `[zone, pile]` and `operation.target` was still the pile.
  for (let pass = 0; pass < 2; pass++) {
    await frame();
    // **Re-measure every target before the collision pass**, because jsdom cannot.
    // `Droppable`'s shape comes from a `PositionObserver` the library creates the moment a drag
    // starts and that element accepts the payload; the observer measures once and then waits for
    // a callback jsdom never delivers. That is fine for a target boxed before the gesture — the
    // one measurement is right — and silently wrong for one that appears **during** it: the
    // quick-zone bar and the remove tray are both drawn on `dragstart`, so their first and only
    // measurement is taken while their rect is still four zeroes, and they could never be
    // collided with afterwards.
    for (const droppable of dndManager.registry.droppables) droppable.refreshShape();
    dndManager.collisionObserver.forceUpdate();
    await frame();
  }
}

/**
 * Press a folder and hold it.
 *
 * **The press and the drag can land on two different elements**, which is the case that bites:
 * pressing a control inside a draggable row is a press on the control, and `NOT_A_DRAG` is what
 * says so. `pressOn` is where the press landed; `from` is what would be dragged.
 *
 * **dnd-kit registers on a microtask, not in its constructor.** `Entity`'s constructor ends with
 * `queueMicrotask(this.register)`, so a test that mounts a source and presses it in the same tick
 * presses an element the manager has never heard of — and the gesture then reads as a draggable
 * that does not drag. In the running window an effect registers a folder long before anybody
 * grabs it; only a test can be this fast. The frame below is what closes that gap.
 *
 * The gesture crosses dnd-kit's 5px distance constraint on the first move, which is why no test
 * here has to run a timer: the *other* default constraint is a 200ms delay, and either one alone
 * activates the drag.
 *
 * **`move: false` presses and does not move**, for the one kind of test that is about the
 * *threshold* rather than about a drag that has already started — a source that declares a handle
 * has to put dnd-kit's activation constraints back by hand, and the only way to see that it did is
 * to press and look before travelling. Every other caller wants a gesture that is under way, which
 * is why the two moves are the default and are made by omission.
 */
export async function startPointerDrag(
  from: HTMLElement,
  { pressOn = from, move: travel = true }: { pressOn?: Element; move?: boolean } = {},
): Promise<PointerHeld> {
  await frame();
  const start = centre(from);
  let at = start;

  fire("pointerdown", start, pressOn);
  // Two moves before anything is asserted: the first crosses the activation threshold, and
  // `dragOperation.position.current` lags one move behind because the sensor batches through its
  // own scheduler — so a gesture read after a single move is read one move early.
  if (travel) {
    await move(start.x, start.y + 8);
    await move(start.x, start.y + 16);
  }

  async function move(x: number, y: number): Promise<void> {
    at = { x, y };
    // **Twice, and the repeat is the point.** `dragOperation.position.current` lags one
    // `pointermove` behind, because `handlePointerMove` only records the coordinates and hands
    // the actual move to the sensor's own scheduler. Measured 2026-08-27: with a single dispatch
    // per move, a second landing within one folder reports the *first* landing — a test asserting
    // that the mark follows the pointer then reads as a mark that is right once per folder, which
    // is the exact bug it exists to catch.
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        fire("pointermove", at, document);
      });
      await frame();
    }
    await settle();
  }

  const held: PointerHeld = {
    get started() {
      return dndManager.dragOperation.status.initialized;
    },
    moveTo: move,
    over: (element, where) => {
      const point = centre(element, where);
      return move(point.x, point.y);
    },
    leave: () => move(NOWHERE.x, NOWHERE.y),
    drop: async () => {
      await act(async () => {
        fire("pointerup", at, document);
      });
      await frame();
    },
    cancel: async () => {
      await act(async () => {
        document.body.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
        );
      });
      await frame();
    },
  };
  return held;
}

/**
 * The whole gesture, for a test that is about where a folder landed rather than about what
 * happened on the way — `dragOnto`'s counterpart on the pointer side.
 *
 * The intermediate points are the point: a library watching for a distance threshold or a
 * direction has to see a real gesture rather than a teleport.
 */
export async function pointerDrag(
  from: HTMLElement,
  to: HTMLElement,
  opts: { steps?: number } = {},
): Promise<void> {
  const steps = Math.max(2, opts.steps ?? 8);
  const start = centre(from);
  const end = centre(to);

  const held = await startPointerDrag(from);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    await held.moveTo(start.x + (end.x - start.x) * t, start.y + (end.y - start.y) * t);
  }
  // The settle. `dragOperation.position.current` lags one move behind, so a drag that stops the
  // instant it arrives has never been over the target as far as dnd-kit is concerned.
  await held.moveTo(end.x, end.y);
  await held.drop();
}
